// Changing the email service on a running install. What matters most is what it must never do.
import { describe, expect, it } from 'vitest';
import { doctor } from '../src/commands/doctor';
import {
  applyMailBindings,
  cancelSwitch,
  cutOver,
  cutOverWarnings,
  finishSwitch,
  prepareSwitch,
  rollBack,
  switchStatus,
} from '../src/commands/mail-switch';
import { update } from '../src/commands/update';
import { runChange } from '../src/wizard/change';
import { FakeTransport } from '../src/fake';
import { secretContext, secretNames } from '../src/keys';
import { MemoryStateStore } from '../src/state';
import { INSTALL_STEPS, runSteps } from '../src/steps';
import { answers, fakeRun } from './helpers';

const SES = {
  provider: 'ses' as const,
  region: 'eu-west-1',
  awsAccessKeyId: 'AKIAADMINDRYRUN00000',
  awsSecretAccessKey: 'admin-secret-dry-run-000000000000000000',
};
const RESEND = {
  provider: 'resend' as const,
  region: 'eu-west-1',
  resendApiKey: 're_dry_run_0000000000000000',
};

/** A finished install with two publication domains, on the given service. */
async function installed(mail: typeof SES | typeof RESEND = RESEND) {
  const store = new MemoryStateStore();
  const transport = new FakeTransport({ zone: 'example.com' });
  const first = await fakeRun({
    argv: ['--dry-run'],
    store,
    transport,
    answers: { ...(await answers()), mail },
  });
  await runSteps(first.ctx, INSTALL_STEPS);
  transport.sendingDomains = ['news.acme.test', 'hello.acme.test'].map((domain, i) => ({
    id: `sd_${i}`,
    domain,
    channel_id: 'ch_1',
    mail_from_domain: `bounce.${domain}`,
    records_json: JSON.stringify([
      { purpose: 'dkim', type: 'TXT', name: `old._domainkey.${domain}`, value: 'p=old' },
      { purpose: 'dmarc', type: 'TXT', name: `_dmarc.${domain}`, value: 'v=DMARC1; p=quarantine' },
    ]),
    pending_provider: null,
    pending_records_json: null,
  }));
  return { store, transport };
}

async function run(
  world: { store: MemoryStateStore; transport: FakeTransport },
  mail?: typeof SES | typeof RESEND,
) {
  const output: string[] = [];
  const { ctx } = await fakeRun({
    argv: ['--dry-run'],
    store: world.store,
    transport: world.transport,
    output,
    answers: { ...(await answers()), ...(mail ? { mail } : {}) },
  });
  ctx.session.oauthToken = 'test-only-token';
  ctx.session.dnsToken = 'test-only-token';
  return { ctx, output };
}

const sql = (transport: FakeTransport, pattern: RegExp) =>
  transport.sqlLog.filter((statement) => pattern.test(statement.sql));

describe('preparing a change', () => {
  it('sets up the new service while the old one keeps sending', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    await prepareSwitch(ctx, 'ses');
    expect(ctx.state.choices?.mail.provider).toBe('resend');
    expect(ctx.state.mailChange).toMatchObject({ phase: 'prepared', from: { provider: 'resend' } });
    expect(ctx.state.mailChange?.to?.provider).toBe('ses');
    expect(ctx.state.mailRecords?.some((r) => r.name.startsWith('resend._domainkey'))).toBe(true);
    // Nothing about the Workers has changed yet.
    expect(world.transport.actions.filter((a) => a.startsWith('PATCH settings'))).toEqual([]);
    expect(sql(world.transport, /SWAP|records_json = pending_records_json/)).toEqual([]);
  });

  it('asks the new service for each domain’s records, keeping Swarm’s DMARC record', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    await prepareSwitch(ctx, 'ses');
    const [first] = world.transport.sendingDomains;
    expect(first?.pending_provider).toBe('ses');
    const records = JSON.parse(String(first?.pending_records_json)) as {
      purpose: string;
      type: string;
      name: string;
    }[];
    expect(records.filter((r) => r.purpose === 'dkim')).toHaveLength(3);
    expect(records.find((r) => r.type === 'MX')?.name).toBe('bounce.news.acme.test');
    expect(records.filter((r) => r.purpose === 'dmarc')).toHaveLength(1);
  });

  it('writes only records that can live beside the old service’s', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    const before = world.transport.dns.find(
      (r) => r.name === 'bounce.mail.example.com' && r.type === 'MX',
    )?.content;
    await prepareSwitch(ctx, 'ses');
    expect(world.transport.dns.some((r) => r.name.endsWith('.dkim.amazonses.com'))).toBe(false);
    expect(world.transport.dns.some((r) => r.content === 'dkimtokenone.dkim.amazonses.com')).toBe(
      true,
    );
    // Both services bounce to this name, so it waits for the cut-over.
    expect(
      world.transport.dns.find((r) => r.name === 'bounce.mail.example.com' && r.type === 'MX')
        ?.content,
    ).toBe(before);
  });

  it('refuses the service already in use', async () => {
    const world = await installed();
    const { ctx } = await run(world, RESEND);
    await expect(prepareSwitch(ctx, 'resend')).rejects.toThrow(/already sends through/);
  });

  it('can run again, without creating anything twice', async () => {
    const world = await installed();
    const first = await run(world, SES);
    await prepareSwitch(first.ctx, 'ses');
    const id = first.ctx.state.mailChange?.id;
    const creates = () =>
      world.transport.actions.filter((a) => a.startsWith('aws sesv2 CreateEmailIdentity')).length;
    const before = creates();
    const again = await run(world, SES);
    await prepareSwitch(again.ctx, 'ses');
    expect(again.ctx.state.mailChange?.id).toBe(id);
    expect(creates()).toBe(before);
  });

  it('stays on the old service when the new one refuses', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    const real = world.transport.aws.bind(world.transport);
    world.transport.aws = (async () => {
      throw Object.assign(new Error('nope'), { name: 'AccessDenied' });
    }) as unknown as typeof real;
    await expect(prepareSwitch(ctx, 'ses')).rejects.toThrow(/AWS refused/);
    world.transport.aws = real;
    expect(ctx.state.choices?.mail.provider).toBe('resend');
    expect(ctx.state.mailRecords?.some((r) => r.name.startsWith('resend._domainkey'))).toBe(true);
  });

  it('carries on past one domain the new service refuses, and says which', async () => {
    const world = await installed();
    const { ctx, output } = await run(world, SES);
    const real = world.transport.aws.bind(world.transport);
    world.transport.aws = (async (request: Parameters<typeof real>[0]) => {
      if (request.input.EmailIdentity === 'hello.acme.test') throw new Error('refused');
      return real(request);
    }) as typeof real;
    await prepareSwitch(ctx, 'ses');
    world.transport.aws = real;
    expect(output.join('')).toContain('hello.acme.test: refused');
    expect(world.transport.sendingDomains[0]?.pending_records_json).not.toBeNull();
    expect(world.transport.sendingDomains[1]?.pending_records_json).toBeNull();
  });
});

describe('what a change must never do', () => {
  it('never touches keyrings, migrations, code, accounts or resources', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    const keysBefore = JSON.stringify(ctx.secrets.keys);
    const actionsBefore = world.transport.actions.length;
    const scriptsBefore = JSON.stringify([...world.transport.scripts]);

    await prepareSwitch(ctx, 'ses');
    await cutOver(ctx, { acknowledged: true });
    const again = await run(world);
    await rollBack(again.ctx);

    expect(JSON.stringify(ctx.secrets.keys)).toBe(keysBefore);
    expect(JSON.stringify(again.ctx.secrets.keys)).toBe(keysBefore);
    expect(JSON.stringify([...world.transport.scripts])).toBe(scriptsBefore);
    const actions = world.transport.actions.slice(actionsBefore);
    for (const forbidden of [
      /wrangler deploy/,
      /wrangler d1 migrations/,
      /PUT .*\/workers\/scripts\/[^/]+$/,
      /\/storage\/kv\/namespaces$/,
      /\/r2\/buckets$/,
      /\/queues$/,
      /\/challenges\/widgets/,
    ]) {
      expect(
        actions.filter((a) => forbidden.test(a) && !a.startsWith('GET ')),
        String(forbidden),
      ).toEqual([]);
    }
    expect(world.transport.db.operators.size).toBe(1);
  });

  it('does not put the setup key anywhere it stays', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    await prepareSwitch(ctx, 'ses');
    await cutOver(ctx, { acknowledged: true });
    const { state, secrets } = await world.store.load('production');
    expect(JSON.stringify({ state, secrets })).not.toContain(SES.awsSecretAccessKey);
  });
});

describe('cutting over', () => {
  it('stops and explains when it would stop email, unless told to go on', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    await prepareSwitch(ctx, 'ses');
    await expect(cutOver(ctx, { acknowledged: false })).rejects.toThrow(/Moving now would stop/);
    expect(ctx.state.mailChange?.phase).toBe('prepared');
    expect(ctx.state.choices?.mail.provider).toBe('resend');
  });

  it('names each domain that isn’t ready', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    await prepareSwitch(ctx, 'ses');
    const warnings = cutOverWarnings(await switchStatus(ctx)).join('\n');
    expect(warnings).toContain('news.acme.test');
    expect(warnings).toContain('hello.acme.test');
  });

  it('moves the Workers, the domains and warm-up together', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    await prepareSwitch(ctx, 'ses');
    await cutOver(ctx, { acknowledged: true });
    expect(ctx.state.choices?.mail.provider).toBe('ses');
    expect(ctx.state.mailChange?.phase).toBe('cut_over');
    for (const worker of ['swarm-api', 'swarm-send', 'swarm-jobs', 'swarm-capture', 'swarm-site']) {
      const bindings = world.transport.settings.get(worker) ?? [];
      expect(bindings.find((b) => b.name === 'MAIL_ADAPTER')?.text, worker).toBe('ses');
      expect(world.transport.secrets.get(worker), worker).toContain('AWS_SECRET_ACCESS_KEY');
    }
    expect(sql(world.transport, /records_json = pending_records_json/)).toHaveLength(1);
    expect(sql(world.transport, /UPDATE reputation_ramps/)).toHaveLength(1);
  });

  it('connects the new service’s reports before anything can send through it', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    await prepareSwitch(ctx, 'ses');
    const from = world.transport.actions.length;
    await cutOver(ctx, { acknowledged: true });
    const actions = world.transport.actions.slice(from);
    const subscribed = actions.findIndex((a) => a.startsWith('aws sns Subscribe'));
    const sendWorker = actions.findIndex((a) => a === 'PATCH settings of swarm-send');
    expect(subscribed).toBeGreaterThan(-1);
    expect(subscribed).toBeLessThan(sendWorker);
    expect(ctx.state.ses?.subscriptionConfirmed).toBe(true);
  });

  it('replaces the records the two services share', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    await prepareSwitch(ctx, 'ses');
    await cutOver(ctx, { acknowledged: true });
    const mx = world.transport.dns.filter(
      (r) => r.name === 'bounce.mail.example.com' && r.type === 'MX',
    );
    expect(mx).toHaveLength(1);
    expect(mx[0]?.content).toBe('feedback-smtp.eu-west-1.amazonses.com');
  });

  it('swaps the database once only, even if run again after stopping partway', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    await prepareSwitch(ctx, 'ses');
    await cutOver(ctx, { acknowledged: true });
    // A run that stopped after the swap, before saving that it had finished.
    ctx.state.mailChange = { ...ctx.state.mailChange!, phase: 'cutting_over' };
    await cutOver(ctx, { acknowledged: true });
    expect(sql(world.transport, /records_json = pending_records_json/)).toHaveLength(1);
  });

  it('keeps the old service’s reports coming for 14 days', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    await prepareSwitch(ctx, 'ses');
    await cutOver(ctx, { acknowledged: true });
    const events = secretNames('events', secretContext(ctx.state, ctx.secrets));
    expect(events).toContain('RESEND_WEBHOOK_SECRET');
    expect(world.transport.secrets.get('swarm-events')).toContain('RESEND_WEBHOOK_SECRET');
    const left = (ctx.state.mailChange?.drainUntil ?? 0) - Date.now();
    expect(left).toBeGreaterThan(13.9 * 86_400_000);
    expect(left).toBeLessThanOrEqual(14 * 86_400_000);
  });

  it('accepts reports from both SNS topics when leaving SES', async () => {
    const world = await installed(SES);
    const { ctx } = await run(world, RESEND);
    await prepareSwitch(ctx, 'resend');
    await cutOver(ctx, { acknowledged: true });
    const events = world.transport.settings.get('swarm-events') ?? [];
    expect(events.find((b) => b.name === 'SNS_TOPIC_ARNS')?.text).toContain('swarm-production-ses');
  });

  it('keeps bindings it doesn’t own, and inherits secrets rather than resending them', async () => {
    const world = await installed();
    world.transport.settings.set('swarm-send', [
      { type: 'd1', name: 'DB' },
      { type: 'secret_text', name: 'FIELD_KEYS' },
      { type: 'plain_text', name: 'SOMETHING_ELSE', text: 'kept' },
    ]);
    const { ctx } = await run(world, SES);
    await prepareSwitch(ctx, 'ses');
    await applyMailBindings(ctx, 'send');
    const bindings = world.transport.settings.get('swarm-send') ?? [];
    expect(bindings).toContainEqual({ type: 'd1', name: 'DB' });
    expect(bindings).toContainEqual({ type: 'inherit', name: 'FIELD_KEYS' });
    expect(bindings).toContainEqual({ type: 'plain_text', name: 'SOMETHING_ELSE', text: 'kept' });
  });
});

describe('removing records', () => {
  it('never removes a record it didn’t write, even at the same name', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    await prepareSwitch(ctx, 'ses');
    const dkim = world.transport.dns.find((r) => r.content === 'dkimtokenone.dkim.amazonses.com');
    if (!dkim) throw new Error('expected the new DKIM record');
    // The person replaced this record with their own, under the same name and type.
    Object.assign(dkim, { content: 'theirs.example.net' });
    await cancelSwitch(ctx);
    expect(world.transport.dns.some((r) => r.content === 'theirs.example.net')).toBe(true);
  });
});

describe('going back', () => {
  it('returns to the old service with the database swapped back', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    await prepareSwitch(ctx, 'ses');
    await cutOver(ctx, { acknowledged: true });
    const again = await run(world);
    await rollBack(again.ctx);
    expect(again.ctx.state.choices?.mail.provider).toBe('resend');
    expect(again.ctx.state.mailChange).toBeUndefined();
    expect(sql(world.transport, /records_json = pending_records_json/)).toHaveLength(2);
    const send = world.transport.settings.get('swarm-send') ?? [];
    expect(send.find((b) => b.name === 'MAIL_ADAPTER')?.text).toBe('resend');
  });

  it('points to cancel when nothing has moved', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    await prepareSwitch(ctx, 'ses');
    await expect(rollBack(ctx)).rejects.toThrow(/hasn’t moved/);
  });
});

describe('dropping a prepared change', () => {
  it('forgets the change, and leaves how email is sent alone', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    await prepareSwitch(ctx, 'ses');
    await cancelSwitch(ctx);
    expect(ctx.state.mailChange).toBeUndefined();
    expect(ctx.state.choices?.mail.provider).toBe('resend');
    expect(sql(world.transport, /pending_records_json = NULL/)).toHaveLength(1);
    expect(world.transport.actions.filter((a) => a.startsWith('PATCH settings'))).toEqual([]);
    expect(world.transport.dns.some((r) => r.content.endsWith('.dkim.amazonses.com'))).toBe(false);
  });

  it('refuses once email has moved', async () => {
    const world = await installed();
    const { ctx } = await run(world, SES);
    await prepareSwitch(ctx, 'ses');
    await cutOver(ctx, { acknowledged: true });
    await expect(cancelSwitch(ctx)).rejects.toThrow(/already moved/);
  });
});

describe('finishing', () => {
  async function moved() {
    const world = await installed();
    const { ctx } = await run(world, SES);
    await prepareSwitch(ctx, 'ses');
    await cutOver(ctx, { acknowledged: true });
    return { world, ctx };
  }

  it('waits out the 14 days, so no late complaint is lost', async () => {
    const { ctx } = await moved();
    await expect(finishSwitch(ctx, { force: false })).rejects.toThrow(/can still arrive until/);
    expect(ctx.secrets.resendApiKey).toBeTruthy();
  });

  it('then removes the old keys and records, and nothing else', async () => {
    const { world, ctx } = await moved();
    ctx.state.mailChange = { ...ctx.state.mailChange!, drainUntil: Date.now() - 1 };
    await finishSwitch(ctx, { force: false });
    expect(ctx.secrets.resendApiKey).toBeUndefined();
    expect(ctx.state.resend).toBeUndefined();
    expect(ctx.state.mailChange).toBeUndefined();
    expect(ctx.secrets.keys.FIELD_KEYS).toBeTruthy();
    expect(ctx.secrets.aws).toBeTruthy();
    for (const worker of ['swarm-send', 'swarm-events']) {
      const names = world.transport.secrets.get(worker) ?? [];
      expect(names, worker).not.toContain('RESEND_API_KEY');
      expect(names, worker).not.toContain('RESEND_WEBHOOK_SECRET');
    }
    expect(world.transport.secrets.get('swarm-send')).toContain('AWS_SECRET_ACCESS_KEY');
    expect(world.transport.secrets.get('swarm-send')).toContain('TRACK_KEYS');
    expect(world.transport.secrets.get('swarm-vault')).toContain('FIELD_KEYS');
    expect(world.transport.dns.some((r) => r.name.startsWith('resend._domainkey'))).toBe(false);
    expect(
      world.transport.dns.find((r) => r.name === 'bounce.mail.example.com' && r.type === 'MX')
        ?.content,
    ).toBe('feedback-smtp.eu-west-1.amazonses.com');
  });

  it('leaves a working install behind', async () => {
    const { world, ctx } = await moved();
    ctx.state.mailChange = { ...ctx.state.mailChange!, drainUntil: Date.now() - 1 };
    await finishSwitch(ctx, { force: false });
    world.transport.awsState.verifiedIdentities.add('mail.example.com');
    const output: string[] = [];
    const after = await fakeRun({
      argv: ['doctor', '--dry-run'],
      store: world.store,
      transport: world.transport,
      output,
    });
    expect(await doctor(after.ctx)).toBe(true);
  });
});

describe('from the setup page', () => {
  async function kit(world: { store: MemoryStateStore }) {
    const { state, secrets } = await world.store.load('production');
    if (!state || !secrets) throw new Error('no install');
    return { state, secrets: { ...secrets, keys: {} } };
  }
  const request = {
    token: 'test-only-token',
    acknowledged: true,
    log: () => {},
  };

  it('goes through the whole change with no keyrings at all', async () => {
    const world = await installed();
    const { transport } = world;
    // The fake lists only Workers uploaded through the API, and this install used wrangler.
    transport.scripts.set('swarm-send', { name: 'swarm-send', metadata: {} });
    const mail = { provider: 'ses' as const, region: 'eu-west-1' };
    const awsAdmin = {
      accessKeyId: SES.awsAccessKeyId,
      secretAccessKey: SES.awsSecretAccessKey,
    };
    let { state, secrets } = await kit(world);
    ({ state, secrets } = await runChange({
      ...request,
      action: 'prepare',
      transport,
      state,
      secrets,
      provider: 'ses',
      mail,
      awsAdmin,
    }));
    expect(state.mailChange?.phase).toBe('prepared');
    expect(secrets.aws?.accessKeyId).toBeTruthy();
    ({ state, secrets } = await runChange({
      ...request,
      action: 'cutover',
      transport,
      state,
      secrets,
      awsAdmin,
    }));
    expect(state.choices?.mail.provider).toBe('ses');
    expect(state.ses?.subscriptionConfirmed).toBe(true);
    expect(transport.settings.get('swarm-send')?.find((b) => b.name === 'MAIL_ADAPTER')?.text).toBe(
      'ses',
    );
    // Nothing needed the keyrings, and the Workers kept theirs.
    expect(secrets.keys).toEqual({});
    expect(transport.secrets.get('swarm-vault')).toContain('FIELD_KEYS');
    expect(JSON.stringify({ state, secrets })).not.toContain(SES.awsSecretAccessKey);
  });

  it('refuses a kit from another account', async () => {
    const world = await installed();
    const { state, secrets } = await kit(world);
    world.transport.scripts.clear();
    const scripts = world.transport.http.bind(world.transport);
    world.transport.http = async (r) =>
      /\/workers\/scripts(\?|$)/.test(r.url) && r.method === 'GET'
        ? {
            status: 200,
            text: '{"success":true,"result":[],"result_info":{"page":1,"total_pages":1}}',
          }
        : scripts(r);
    await expect(
      runChange({ ...request, action: 'status', transport: world.transport, state, secrets }),
    ).rejects.toThrow(/can't see the Swarm/);
  });

  it('refuses a kit older than what’s running', async () => {
    const world = await installed();
    const { state, secrets } = await kit(world);
    const scripts = world.transport.http.bind(world.transport);
    world.transport.http = async (r) =>
      /\/workers\/scripts(\?|$)/.test(r.url) && r.method === 'GET'
        ? {
            status: 200,
            text: '{"success":true,"result":[{"id":"swarm-send"}],"result_info":{"page":1,"total_pages":1}}',
          }
        : scripts(r);
    world.transport.settings.set('swarm-api', [
      { type: 'plain_text', name: 'MAIL_ADAPTER', text: 'ses' },
    ]);
    await expect(
      runChange({ ...request, action: 'status', transport: world.transport, state, secrets }),
    ).rejects.toThrow(/would change it back/);
  });
});

describe('an update on a computer that missed the change', () => {
  it('refuses rather than putting the Workers back on the old service', async () => {
    const world = await installed();
    world.transport.settings.set('swarm-api', [
      { type: 'plain_text', name: 'MAIL_ADAPTER', text: 'ses' },
    ]);
    const { ctx } = await run(world);
    await expect(update(ctx)).rejects.toThrow(/updating would change it back/);
  });

  it('carries on when they agree', async () => {
    const world = await installed();
    world.transport.settings.set('swarm-api', [
      { type: 'plain_text', name: 'MAIL_ADAPTER', text: 'resend' },
    ]);
    const { ctx } = await run(world);
    await expect(update(ctx)).resolves.toBeUndefined();
  });
});
