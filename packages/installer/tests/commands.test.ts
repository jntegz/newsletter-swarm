import { describe, expect, it } from 'vitest';
import { doctor, linkKeysFinding } from '../src/commands/doctor';
import { KEYRING_NAMES, LINK_WORKERS, secretContext, secretNames } from '../src/keys';
import { DEPLOY_ORDER, scriptName } from '../src/paths';
import { enable } from '../src/commands/enable';
import { update } from '../src/commands/update';
import { FakeTransport } from '../src/fake';
import { MemoryStateStore } from '../src/state';
import { INSTALL_STEPS, runSteps } from '../src/steps';
import { answers, fakeRun } from './helpers';

async function installed(argv: string[] = ['--dry-run']) {
  const store = new MemoryStateStore();
  const transport = new FakeTransport({ zone: 'example.com' });
  const first = await fakeRun({ argv, store, transport });
  await runSteps(first.ctx, INSTALL_STEPS);
  return { store, transport };
}

describe('doctor', () => {
  it('passes right after a fake install', async () => {
    const { store, transport } = await installed();
    const output: string[] = [];
    const { ctx } = await fakeRun({ argv: ['doctor', '--dry-run'], store, transport, output });
    expect(await doctor(ctx)).toBe(true);
    expect(output.join('')).toContain('sign-up is invite-only');
  });

  it('reports a jobs worker that has not reached the vault lately', async () => {
    const { store, transport } = await installed();
    const now = Date.now();
    transport.jobsHeartbeat = { checked_at: now, ok: 0, ok_at: now - 30 * 60_000 };
    const output: string[] = [];
    const { ctx } = await fakeRun({ argv: ['doctor', '--dry-run'], store, transport, output });
    expect(await doctor(ctx)).toBe(false);
    const text = output.join('');
    expect(text).toMatch(
      /The jobs worker reaches the vault.*the vault last answered it 30 min ago/,
    );
    expect(text).toContain('VAULT binding and its cron triggers');

    transport.jobsHeartbeat = { checked_at: now, ok: 1, ok_at: now - 60_000 };
    const again: string[] = [];
    const rerun = await fakeRun({ argv: ['doctor', '--dry-run'], store, transport, output: again });
    expect(await doctor(rerun.ctx)).toBe(true);
    expect(again.join('')).toMatch(/The jobs worker reaches the vault.*last answered 1 min ago/);
  });

  it('reports a missing secret and a stale config, with fixes', async () => {
    const { store, transport } = await installed();
    transport.secrets.set('swarm-api', []);
    for (const key of transport.files.keys())
      if (key.includes('jobs')) transport.files.set(key, '{}');
    const output: string[] = [];
    const { ctx } = await fakeRun({ argv: ['doctor', '--dry-run'], store, transport, output });
    expect(await doctor(ctx)).toBe(false);
    const text = output.join('');
    expect(text).toContain('out of date: jobs');
    expect(text).toMatch(/Secrets of swarm-api.*problem: missing AUTH_KEYS/);
    expect(text).toContain('Fix: Run `pnpm swarm update`');
  });

  it('reports a binding to the vault through another entrypoint, or from a Worker with none', async () => {
    const { store, transport } = await installed();
    transport.settings.set('swarm-capture', [
      { type: 'service', name: 'VAULT', service: 'swarm-vault', entrypoint: 'JobsVault' } as never,
    ]);
    transport.settings.set('swarm-send', [
      { type: 'service', name: 'VAULT', service: 'swarm-vault', entrypoint: 'ApiVault' } as never,
    ]);
    transport.settings.set('swarm-site', [
      { type: 'service', name: 'VAULT', service: 'swarm-vault', entrypoint: 'SiteVault' } as never,
    ]);
    const output: string[] = [];
    const { ctx } = await fakeRun({ argv: ['doctor', '--dry-run'], store, transport, output });
    expect(await doctor(ctx)).toBe(false);
    const text = output.join('');
    expect(text).toMatch(
      /Bindings to the vault.*problem: swarm-capture binds to JobsVault, not CaptureVault; swarm-send binds to the vault/,
    );
    expect(text).not.toContain('swarm-site binds');
  });

  it('reports a public Worker that can still write to the jobs queue', async () => {
    const { store, transport } = await installed();
    transport.settings.set('swarm-capture', [
      { type: 'queue', name: 'JOBS_QUEUE', queue_name: 'swarm-production-jobs' },
    ]);
    transport.settings.set('swarm-events', [
      { type: 'queue', name: 'PUBLIC_QUEUE', queue_name: 'swarm-production-public' },
    ]);
    const output: string[] = [];
    const { ctx } = await fakeRun({ argv: ['doctor', '--dry-run'], store, transport, output });
    expect(await doctor(ctx)).toBe(false);
    const text = output.join('');
    expect(text).toMatch(
      /Queues of the public Workers.*problem: swarm-capture writes to swarm-production-jobs/,
    );
    expect(text).not.toContain('swarm-events writes to');
  });

  describe('SES bounce and complaint reports', () => {
    async function sesInstall() {
      const store = new MemoryStateStore();
      const transport = new FakeTransport({ zone: 'example.com' });
      const first = await fakeRun({
        argv: ['--dry-run'],
        store,
        transport,
        answers: {
          ...(await answers()),
          mail: {
            provider: 'ses',
            region: 'eu-west-1',
            awsAccessKeyId: 'AKIAADMINDRYRUN00000',
            awsSecretAccessKey: 'admin-secret-dry-run-000000000000000000',
          },
        },
      });
      await runSteps(first.ctx, INSTALL_STEPS);
      return { store, transport };
    }

    const report = async (store: MemoryStateStore, transport: FakeTransport) => {
      const output: string[] = [];
      const { ctx } = await fakeRun({ argv: ['doctor', '--dry-run'], store, transport, output });
      await doctor(ctx);
      return output.join('');
    };

    it('passes once the topic signs with version 2 and the subscription is confirmed', async () => {
      const { store, transport } = await sesInstall();
      expect(await report(store, transport)).toMatch(/bounce and complaint reports.*ok/);
    });

    it('reports a topic that still signs with version 1', async () => {
      const { store, transport } = await sesInstall();
      const { state } = await store.load('production');
      if (state?.ses) delete state.ses.topicSignatureVersion;
      if (state) await store.save(state);
      expect(await report(store, transport)).toContain('Swarm refuses the reports');
    });

    it('passes when the suppression list is bounces only, and reports complaints with the fix', async () => {
      const { store, transport } = await sesInstall();
      expect(await report(store, transport)).toMatch(/SES suppression list.*bounces only/);
      transport.awsState.suppressedReasons = ['BOUNCE', 'COMPLAINT'];
      const text = await report(store, transport);
      expect(text).toContain('adds addresses for complaints too');
      expect(text).toContain('put-account-suppression-attributes --suppressed-reasons BOUNCE');
    });

    it('reports a subscription that never confirmed', async () => {
      const { store, transport } = await sesInstall();
      const { state } = await store.load('production');
      if (state?.ses) state.ses.subscriptionConfirmed = false;
      if (state) await store.save(state);
      expect(await report(store, transport)).toContain('has not confirmed its subscription');
    });
  });
});

describe('update and enable', () => {
  it('update re-renders and redeploys without asking anything', async () => {
    const { store, transport } = await installed();
    const before = transport.actions.length;
    const { ctx } = await fakeRun({
      argv: ['update', '--dry-run', '--skip-pull'],
      store,
      transport,
      answers: {},
    });
    await update(ctx);
    const again = transport.actions.slice(before);
    expect(again.filter((a) => a.startsWith('wrangler deploy'))).toHaveLength(9);
    // The DNS token was not kept, so DNS is skipped rather than asked for.
    expect(again.some((a) => a.includes('dns_records'))).toBe(false);
    // An older install with no sign-up row keeps its open sign-up through an update.
    expect(again.some((a) => a.includes('instance_settings'))).toBe(false);
  });

  it('update gives an install from before the public queue that queue, then deploys onto it', async () => {
    const { store, transport } = await installed();
    // As an install from before it: no public queue yet.
    transport.queues = transport.queues.filter((q) => !q.queue_name.includes('-public'));
    const before = transport.actions.length;
    const { ctx } = await fakeRun({
      argv: ['update', '--dry-run', '--skip-pull'],
      store,
      transport,
      answers: {},
    });
    await update(ctx);
    const again = transport.actions.slice(before);
    const created = again.findIndex((a) => /queues\s+swarm-production-public$/.test(a));
    const dlq = again.findIndex((a) => /queues\s+swarm-production-public-dlq$/.test(a));
    const firstDeploy = again.findIndex((a) => a.startsWith('wrangler deploy'));
    expect(created).toBeGreaterThanOrEqual(0);
    expect(dlq).toBeGreaterThanOrEqual(0);
    expect(created).toBeLessThan(firstDeploy);
    // What wrangler deploys: capture and events on the public queue only, jobs consuming it.
    const rendered = (worker: string) =>
      [...transport.files].find(([path]) =>
        path.endsWith(`workers/${worker}/wrangler.production.generated.jsonc`),
      )?.[1] ?? '';
    for (const worker of ['capture', 'events']) {
      expect(rendered(worker)).toContain('"queue": "swarm-production-public"');
      expect(rendered(worker)).not.toContain('JOBS_QUEUE');
    }
    expect(rendered('jobs')).toMatch(
      /"queue": "swarm-production-public",[\s\S]*?"dead_letter_queue": "swarm-production-public-dlq"/,
    );
  });

  it('gives an install from before per-link keys its new keyrings, then switches the signers', async () => {
    const { store, transport } = await installed();
    const { state, secrets } = await store.load('production');
    if (!state || !secrets) throw new Error('no install');
    delete state.linkKeys;
    const old = [
      'AUTH_KEYS',
      'TRACK_KEYS',
      'UNSUBSCRIBE_KEYS',
      'FIELD_KEYS',
      'MEMBER_KEYS',
      'READER_KEYS',
    ];
    for (const name of Object.keys(secrets.keys))
      if (!old.includes(name)) delete secrets.keys[name];
    const kept = { ...secrets.keys };
    await store.save(state);
    await store.saveSecrets('production', secrets);

    // doctor says what is due.
    const said: string[] = [];
    const check = await fakeRun({ argv: ['doctor', '--dry-run'], store, transport, output: said });
    expect(await doctor(check.ctx)).toBe(false);
    expect(said.join('')).toMatch(/Per-link keys.*has not been given its per-link keys yet/);

    const before = transport.actions.length;
    const output: string[] = [];
    const { ctx } = await fakeRun({
      argv: ['update', '--dry-run', '--skip-pull'],
      store,
      transport,
      answers: {},
      output,
    });
    await update(ctx);
    const again = transport.actions.slice(before);
    // Two passes: every worker first gets the new keyrings while links are still signed the old
    // way, then the workers that hold link keys deploy again signing per family.
    const deploys = again.filter((a) => a.startsWith('wrangler deploy'));
    expect(deploys).toHaveLength(DEPLOY_ORDER.length + LINK_WORKERS.length);
    expect(ctx.state.linkKeys?.mode).toBe('v2');
    const cutoff = ctx.state.linkKeys?.cutoffAt as number;
    expect(cutoff).toBeGreaterThan(0);
    expect(ctx.state.linkKeys?.legacyUntil).toEqual({
      api: cutoff + 30 * 86_400_000,
      capture: cutoff + 90 * 86_400_000,
      site: cutoff + 90 * 86_400_000,
      vault: cutoff + 30 * 86_400_000,
    });
    expect(Object.keys(ctx.secrets.keys).sort()).toEqual([...KEYRING_NAMES].sort());
    for (const [name, value] of Object.entries(kept)) expect(ctx.secrets.keys[name]).toBe(value);
    // Every worker holds exactly what the matrix says: MEMBER_KEYS only where a window is open.
    const context = secretContext(ctx.state, ctx.secrets);
    for (const worker of DEPLOY_ORDER) {
      expect([...(transport.secrets.get(scriptName(worker, 'production')) ?? [])].sort()).toEqual(
        [...secretNames(worker, context)].sort(),
      );
    }
    expect(transport.secrets.get('swarm-send')).not.toContain('MEMBER_KEYS');
    expect(transport.secrets.get('swarm-capture')).toContain('MEMBER_KEYS');
    const deleted = again.filter((a) => a.startsWith('DELETE ') && a.includes('/secrets/'));
    expect(deleted.filter((a) => a.includes('MEMBER_KEYS')).length).toBeGreaterThanOrEqual(2);
    expect(output.join('')).toContain('Back up .swarm/ again');
    expect(linkKeysFinding(ctx.state.linkKeys, Date.now()).ok).toBe(true);
  });

  it('enable first makes keyrings an install from before per-link keys lacks', async () => {
    const { store, transport } = await installed();
    const { state, secrets } = await store.load('production');
    if (!state || !secrets) throw new Error('no install');
    delete state.linkKeys;
    delete secrets.keys.MEMBER_SIGNING_KEYS;
    delete secrets.keys.CONFIRM_KEYS;
    await store.save(state);
    await store.saveSecrets('production', secrets);
    const base = await answers();
    const { ctx } = await fakeRun({
      argv: ['enable', 'payments', '--dry-run'],
      store,
      transport,
      answers: { ...base, stripe: { secretKey: 'sk_test_dryrun', connectClientId: 'ca_dryrun' } },
    });
    await enable(ctx, 'payments');
    expect(ctx.secrets.keys.MEMBER_SIGNING_KEYS).toBeTruthy();
    expect(ctx.secrets.keys.CONFIRM_KEYS).toBeTruthy();
    expect(ctx.state.linkKeys).toEqual({ mode: 'verify-v2' });
  });

  it('enable payments creates the Connect webhook and deploys the paying workers', async () => {
    const { store, transport } = await installed();
    const before = transport.actions.length;
    const base = await answers();
    const { ctx } = await fakeRun({
      argv: ['enable', 'payments', '--dry-run'],
      store,
      transport,
      answers: { ...base, stripe: { secretKey: 'sk_test_dryrun', connectClientId: 'ca_dryrun' } },
    });
    await enable(ctx, 'payments');
    const again = transport.actions.slice(before);
    expect(again).toContain('POST api.stripe.com/v1/webhook_endpoints');
    expect(
      again
        .filter((a) => a.startsWith('wrangler deploy'))
        .map((a) => /workers\/(\w+)\//.exec(a)?.[1]),
      // capture and site make their Stripe calls through the vault and hold no key.
    ).toEqual(['vault', 'jobs', 'api']);
    expect(ctx.state.features.payments).toBe(true);
    expect(ctx.secrets.stripe?.webhookSecrets).toBe('whsec_dryrunstripe000000');
    expect(transport.secrets.get('swarm-api')).toEqual(
      expect.arrayContaining(['STRIPE_WEBHOOK_SECRETS']),
    );
  });

  it('enable custom-domains sets the fallback origin and moves the site route to */*', async () => {
    const { store, transport } = await installed();
    const base = await answers();
    const { ctx } = await fakeRun({
      argv: ['enable', 'custom-domains', '--dry-run'],
      store,
      transport,
      answers: { ...base, cfApiToken: 'ssl-token-dry-run-000000000000' },
    });
    await enable(ctx, 'custom-domains');
    expect(transport.actions).toContain(
      'PUT api.cloudflare.com/client/v4/zones/zone-dry-run/custom_hostnames/fallback_origin  sites.example.com',
    );
    const site =
      [...transport.files.entries()].find(([k]) =>
        /workers[\\/]site[\\/]wrangler\.production\.generated\.jsonc$/.test(k),
      )?.[1] ?? '';
    expect(site).toContain('"pattern": "*/*"');
    expect(transport.secrets.get('swarm-api')).toEqual(
      expect.arrayContaining(['CF_ZONE_ID', 'CF_API_TOKEN']),
    );
  });
});

describe('update and the vault (B4)', () => {
  it('deploys the vault first, and removes FIELD_KEYS from its callers only once they are healthy', async () => {
    const { store, transport } = await installed();
    // An install from before the vault: the callers still hold FIELD_KEYS.
    for (const script of ['swarm-api', 'swarm-capture', 'swarm-site', 'swarm-jobs']) {
      transport.secrets.set(script, [...(transport.secrets.get(script) ?? []), 'FIELD_KEYS']);
    }
    const deletedFieldKeys = (actions: string[]) =>
      actions.filter((a) => /^DELETE \S+\/secrets\/FIELD_KEYS$/.test(a));

    // The vault doesn't answer through its callers: their /healthz is 503, and nothing is pruned,
    // so the previous release can still be rolled back to with its keys.
    transport.vaultDown = true;
    let before = transport.actions.length;
    const output: string[] = [];
    const down = await fakeRun({
      argv: ['update', '--dry-run', '--skip-pull'],
      store,
      transport,
      answers: {},
      output,
    });
    await update(down.ctx);
    let actions = transport.actions.slice(before);
    const deploys = actions
      .filter((a) => a.startsWith('wrangler deploy'))
      .map((a) => /workers\/(\w+)\//.exec(a)?.[1]);
    expect(deploys.indexOf('vault')).toBeLessThan(deploys.indexOf('capture'));
    expect(deploys.indexOf('vault')).toBeLessThan(deploys.indexOf('api'));
    expect(deletedFieldKeys(actions)).toEqual([]);
    expect(output.join('')).toContain('Keys the workers no longer need stay in place for now');
    expect(transport.secrets.get('swarm-api')).toContain('FIELD_KEYS');

    // Healthy again: the same update removes it from every caller, after the health step.
    transport.vaultDown = false;
    before = transport.actions.length;
    const up = await fakeRun({
      argv: ['update', '--dry-run', '--skip-pull'],
      store,
      transport,
      answers: {},
    });
    await update(up.ctx);
    actions = transport.actions.slice(before);
    expect(deletedFieldKeys(actions)).toHaveLength(4);
    const lastHealth = actions.map((a) => a.includes('/healthz')).lastIndexOf(true);
    const firstDelete = actions.findIndex((a) => /^DELETE \S+\/secrets\/FIELD_KEYS$/.test(a));
    expect(lastHealth).toBeLessThan(firstDelete);
    for (const script of ['swarm-api', 'swarm-capture', 'swarm-site', 'swarm-jobs']) {
      expect(transport.secrets.get(script), script).not.toContain('FIELD_KEYS');
    }
    expect(transport.secrets.get('swarm-vault')).toContain('FIELD_KEYS');
  });

  it('keeps the keys while jobs, which has no public host, has no heartbeat since the deploy', async () => {
    const { store, transport } = await installed();
    transport.secrets.set('swarm-jobs', [
      ...(transport.secrets.get('swarm-jobs') ?? []),
      'FIELD_KEYS',
    ]);
    const pruned = (actions: string[]) =>
      actions.filter((a) => /^DELETE \S+\/secrets\/FIELD_KEYS$/.test(a));
    const run = async () => {
      const before = transport.actions.length;
      const output: string[] = [];
      const { ctx } = await fakeRun({
        argv: ['update', '--dry-run', '--skip-pull'],
        store,
        transport,
        answers: {},
        output,
      });
      await update(ctx);
      return { actions: transport.actions.slice(before), text: output.join(''), ctx };
    };

    // Every public host is healthy, but jobs' last success is from before this deploy: the old
    // release's, or one the new jobs never matched because the vault does not answer it.
    const earlier = Date.now() - 60_000;
    transport.jobsHeartbeat = { checked_at: Date.now() + 60_000, ok: 0, ok_at: earlier };
    let result = await run();
    expect(pruned(result.actions)).toEqual([]);
    expect(result.ctx.report.unhealthy).toEqual(['the jobs worker (vault heartbeat)']);
    expect(result.text).toContain('the vault does not answer it since this deploy');
    expect(result.text).toContain('Keys the workers no longer need stay in place for now');
    expect(transport.secrets.get('swarm-jobs')).toContain('FIELD_KEYS');

    // No heartbeat at all (a jobs from before it was recorded): kept too.
    transport.jobsHeartbeat = null;
    result = await run();
    expect(pruned(result.actions)).toEqual([]);
    expect(result.text).toContain('it has not recorded a heartbeat yet');

    // Its cron has recorded a success since the deploy: pruned.
    transport.jobsHeartbeat = undefined;
    result = await run();
    expect(result.ctx.report.unhealthy).toEqual([]);
    expect(pruned(result.actions)).toEqual([expect.stringContaining('swarm-jobs')]);
  });
});

describe('the sponsor report keyring', () => {
  it('is made on update, given to the api and jobs, and takes the preview key away from jobs', async () => {
    const { store, transport } = await installed();
    const { state, secrets } = await store.load('production');
    if (!state || !secrets) throw new Error('no install');
    delete secrets.keys.SPONSOR_REPORT_SIGNING_KEYS;
    await store.saveSecrets('production', secrets);
    transport.secrets.set('swarm-jobs', [
      ...(transport.secrets.get('swarm-jobs') ?? []).filter(
        (n) => n !== 'SPONSOR_REPORT_SIGNING_KEYS',
      ),
      'SITE_LINK_SIGNING_KEYS',
    ]);
    const { ctx } = await fakeRun({
      argv: ['update', '--dry-run', '--skip-pull'],
      store,
      transport,
      answers: {},
    });
    await update(ctx);
    expect(ctx.secrets.keys.SPONSOR_REPORT_SIGNING_KEYS).toMatch(/^k\d{8}:/);
    expect(transport.secrets.get('swarm-api')).toContain('SPONSOR_REPORT_SIGNING_KEYS');
    expect(transport.secrets.get('swarm-jobs')).toContain('SPONSOR_REPORT_SIGNING_KEYS');
    expect(transport.secrets.get('swarm-jobs')).not.toContain('SITE_LINK_SIGNING_KEYS');
    expect(transport.secrets.get('swarm-site')).toContain('SPONSOR_REPORT_VERIFY_KEYS');
    expect(transport.secrets.get('swarm-site')).not.toContain('SPONSOR_REPORT_SIGNING_KEYS');
  });
});
