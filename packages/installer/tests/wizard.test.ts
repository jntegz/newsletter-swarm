import { readFileSync } from 'node:fs';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, templatePath, WORKERS } from '../src/paths';
import { FakeTransport } from '../src/fake';
import { MemoryStateStore } from '../src/state';
import {
  openRelease,
  releaseKeyId,
  withdrawnList,
  wizardContext,
  wizardSteps,
  type Answers,
  type Release,
  type Report,
} from '../src/wizard/index';
import { bindingsFrom, pendingObjectMigrations, withOwnSiteSources } from '../src/wizard/deploy';

const sha = (content: string | Uint8Array) => createHash('sha256').update(content).digest('hex');

/** A release in memory, with the real Worker configs and a real signature. */
function releaseFiles(version = '0.1.0', manifestFields: Record<string, unknown> = {}) {
  const contents = new Map<string, string>();
  for (const worker of WORKERS) {
    contents.set(
      `workers/${worker}/wrangler.jsonc`,
      readFileSync(templatePath(REPO_ROOT, worker), 'utf8'),
    );
    contents.set(`workers/${worker}/index.js`, `export default { fetch() {} }; // ${worker}`);
  }
  contents.set('dashboard/index.html', '<!doctype html><title>Swarm</title>');
  contents.set('dashboard/assets/app.js', 'console.log(1)');
  contents.set('dashboard/_headers', '/*\n  X-Frame-Options: DENY\n');
  contents.set('migrations/0001_first.sql', 'CREATE TABLE a (b TEXT);');
  contents.set('migrations/0002_second.sql', 'CREATE TABLE c (d TEXT);');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  // As `pnpm release:sign` writes it: format 2, a clean build of a commit, naming its key.
  const manifest = JSON.stringify({
    format: 2,
    version,
    commit: 'c'.repeat(40),
    build: 'clean',
    keyId: sha(publicKey.export({ type: 'spki', format: 'der' })),
    ...manifestFields,
    files: [...contents].map(([path, text]) => ({ path, size: text.length, sha256: sha(text) })),
  });
  contents.set('manifest.json', manifest);
  contents.set('manifest.sig', sign(null, Buffer.from(manifest), privateKey).toString('base64'));
  return {
    contents,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

const served =
  (contents: Map<string, string>): typeof fetch =>
  async (input) => {
    const path = new URL(String(input)).pathname.slice(1);
    const text = contents.get(path);
    return text === undefined ? new Response('', { status: 404 }) : new Response(text);
  };

const open = (files: ReturnType<typeof releaseFiles>) =>
  openRelease({
    baseUrl: 'https://release.test/',
    publicKeyPem: files.publicKeyPem,
    fetcher: served(files.contents),
  });

const answers: Answers = {
  zone: 'example.com',
  owner: { name: 'Ada Example', email: 'ada@example.com' },
  publication: { name: 'The Example Letter', slug: 'letter' },
  mail: { provider: 'resend', region: 'eu-west-1', resendApiKey: 're_dry_run_0000000000000000' },
  excludeHosts: [],
};

/** One context per step, as the Setup Worker builds one per request. */
async function install(
  release: Release,
  transport: FakeTransport,
  store: MemoryStateStore,
  given: Answers = answers,
  awsAdmin?: { accessKeyId: string; secretAccessKey: string },
) {
  const log: string[] = [];
  let accountId: string | undefined;
  const report: Report = { unhealthy: [] };
  for (const step of wizardSteps(release)) {
    const { state, secrets } = await store.load('production');
    const ctx = wizardContext({
      transport,
      store,
      state,
      secrets,
      answers: given,
      token: 'test-only-cloudflare-token',
      ...(accountId ? { accountId } : {}),
      ...(awsAdmin ? { awsAdmin } : {}),
      report,
      release,
      log: (line) => log.push(line),
    });
    await step.run(ctx);
    await ctx.store.save(ctx.state);
    await ctx.store.saveSecrets('production', ctx.secrets);
    accountId = ctx.session.accountId;
  }
  return { log, report, ...(await store.load('production')) };
}

describe('the install in the browser setup', () => {
  it('runs every step from a fresh start, each in its own context', async () => {
    const files = releaseFiles();
    const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
    const { state, report, log } = await install(
      await open(files),
      transport,
      new MemoryStateStore(),
    );

    expect([...transport.scripts.keys()].sort()).toEqual(WORKERS.map((w) => `swarm-${w}`).sort());
    expect(transport.schedules.get('swarm-jobs')).toEqual([
      '* * * * *',
      '*/5 * * * *',
      '30 3 * * *',
    ]);
    expect(state?.deployedAt && Object.keys(state.deployedAt).sort()).toEqual([...WORKERS].sort());
    expect(transport.workerRoutes.map((r) => r.pattern)).toContain('app.example.com/*');
    // No Worker answers on a default workers.dev hostname or a preview URL: only on its routes.
    expect([...transport.subdomains.keys()].sort()).toEqual([...transport.scripts.keys()].sort());
    for (const setting of transport.subdomains.values()) {
      expect(setting).toEqual({ enabled: false, previews_enabled: false });
    }
    expect(transport.uploadedAssets).toBe(2);
    expect(report.signInLink).toMatch(/^https:\/\/app\.example\.com\//);
    // Nothing went through wrangler or a local file.
    expect(transport.actions.filter((a) => a.startsWith('wrangler'))).toEqual([]);
    expect(log.join('\n')).not.toContain('test-only-cloudflare-token');
    expect(log.join('\n')).not.toContain('re_dry_run_0000000000000000');
  });

  it('gives each Worker its real bindings, ids and secrets', async () => {
    const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
    const { state, secrets } = await install(
      await open(releaseFiles()),
      transport,
      new MemoryStateStore(),
    );
    const bindings = (name: string) =>
      transport.scripts.get(name)?.metadata.bindings as {
        type: string;
        name: string;
        [k: string]: unknown;
      }[];
    const api = bindings('swarm-api');
    expect(api.find((b) => b.name === 'DB')).toMatchObject({
      type: 'd1',
      id: state?.resources.d1?.id,
    });
    expect(api.find((b) => b.name === 'AUTH_KEYS')).toMatchObject({
      type: 'secret_text',
      text: secrets?.keys.AUTH_KEYS,
    });
    expect(api.find((b) => b.name === 'MAIL_ADAPTER')).toMatchObject({ text: 'resend' });
    expect(api.find((b) => b.name === 'SEND_MONITOR')).toMatchObject({
      class_name: 'SendMonitor',
      script_name: 'swarm-realtime',
    });
    expect(api.find((b) => b.type === 'ratelimit')).toBeTruthy();
    // No Worker is left with a placeholder.
    expect(JSON.stringify([...transport.scripts.values()])).not.toContain('unprovisioned');
    const metadata = transport.scripts.get('swarm-api')?.metadata as {
      assets?: { jwt: string; config: object };
    };
    expect(metadata.assets?.jwt).toBe('completion-jwt');
    expect(metadata.assets?.config).toMatchObject({
      not_found_handling: 'single-page-application',
    });
    // The security headers travel as config. Uploaded as a file, they'd be served and not applied.
    expect(metadata.assets?.config).toMatchObject({
      _headers: expect.stringContaining('X-Frame-Options'),
    });
    expect(transport.scripts.get('swarm-realtime')?.tag).toBe('v4');
  });

  it('signs links the way the release it installs does, not the way this build would', async () => {
    const bindings = (transport: FakeTransport, name: string) =>
      transport.scripts.get(name)?.metadata.bindings as { name: string; text?: string }[];
    // An older release's manifest has no linkSigning: it signs v1, so it gets MEMBER_KEYS.
    const old = new FakeTransport({ zone: 'example.com', environment: 'production' });
    const before = await install(await open(releaseFiles()), old, new MemoryStateStore());
    expect(before.state?.linkKeys).toEqual({ mode: 'verify-v2' });
    expect(before.secrets?.keys.MEMBER_KEYS).toBeTruthy();
    const oldApi = bindings(old, 'swarm-api');
    expect(oldApi.find((b) => b.name === 'LINK_SIGNING_MODE')?.text).toBe('v1');
    expect(oldApi.find((b) => b.name === 'MEMBER_KEYS')).toBeTruthy();
    // A release that signs per family starts on v2, with no MEMBER_KEYS at all.
    const fresh = new FakeTransport({ zone: 'example.com', environment: 'production' });
    const after = await install(
      await open(releaseFiles('0.1.0', { linkSigning: 'v2' })),
      fresh,
      new MemoryStateStore(),
    );
    expect(after.state?.linkKeys?.mode).toBe('v2');
    expect(after.secrets?.keys.MEMBER_KEYS).toBeUndefined();
    const api = bindings(fresh, 'swarm-api');
    expect(api.find((b) => b.name === 'LINK_SIGNING_MODE')?.text).toBe('v2');
    expect(api.find((b) => b.name === 'LINK_LEGACY_CUTOFF')?.text).toBe(
      String(after.state?.linkKeys?.cutoffAt),
    );
    expect(api.find((b) => b.name === 'MEMBER_KEYS')).toBeUndefined();
  });

  it('reads anything but linkSigning v2 in the manifest as v1', async () => {
    expect((await open(releaseFiles())).linkSigning).toBe('v1');
    expect((await open(releaseFiles('0.1.0', { linkSigning: 'v2' }))).linkSigning).toBe('v2');
    expect((await open(releaseFiles('0.1.0', { linkSigning: true }))).linkSigning).toBe('v1');
  });

  it("writes Resend's records where Resend looks for them", async () => {
    const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
    const { state } = await install(await open(releaseFiles()), transport, new MemoryStateStore());
    expect(state?.mailRecords?.map((r) => r.name).sort()).toEqual([
      'bounce.mail.example.com',
      'bounce.mail.example.com',
      'rbounce.mail.example.com',
      'resend._domainkey.mail.example.com',
    ]);
  });

  it('applies each migration once, and records it the way wrangler does', async () => {
    const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
    const release = await open(releaseFiles());
    await install(release, transport, new MemoryStateStore());
    const queries = transport.actions.filter((a) => a.includes('INSERT INTO d1_migrations'));
    expect(queries).toHaveLength(2);
  });

  it('deploys the vault before its callers, each caller pinned to its own entrypoint', async () => {
    const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
    await install(await open(releaseFiles()), transport, new MemoryStateStore());
    const uploads = transport.actions.filter((a) => /^upload swarm-\w+$/.test(a));
    const at = (worker: string) => uploads.indexOf(`upload swarm-${worker}`);
    for (const caller of ['api', 'capture', 'site', 'jobs']) {
      expect(at('vault'), caller).toBeLessThan(at(caller));
    }
    const entrypoints = {
      api: 'ApiVault',
      capture: 'CaptureVault',
      site: 'SiteVault',
      jobs: 'JobsVault',
    };
    for (const [caller, entrypoint] of Object.entries(entrypoints)) {
      const bindings = transport.scripts.get(`swarm-${caller}`)?.metadata.bindings as Record<
        string,
        unknown
      >[];
      expect(
        bindings.filter((b) => b.type === 'service'),
        caller,
      ).toEqual([{ type: 'service', name: 'VAULT', service: 'swarm-vault', entrypoint }]);
    }
    // Nobody else binds to it, and it answers on no route and no workers.dev name.
    for (const worker of ['send', 'track', 'events', 'realtime', 'vault']) {
      const bindings = transport.scripts.get(`swarm-${worker}`)?.metadata.bindings as Record<
        string,
        unknown
      >[];
      expect(
        bindings.some((b) => b.type === 'service'),
        worker,
      ).toBe(false);
    }
    expect(transport.workerRoutes.some((r) => r.script === 'swarm-vault')).toBe(false);
    expect(transport.subdomains.get('swarm-vault')).toEqual({
      enabled: false,
      previews_enabled: false,
    });
    expect(transport.schedules.get('swarm-vault')).toEqual(['*/5 * * * *']);
    const vault = transport.scripts.get('swarm-vault')?.metadata.bindings as Record<
      string,
      unknown
    >[];
    expect(
      vault
        .filter((b) => b.type === 'secret_text')
        .map((b) => b.name)
        .sort(),
    ).toEqual(
      [
        'FIELD_KEYS',
        'GOODS_SIGNING_KEYS',
        'MEMBER_KEYS',
        'MEMBER_SIGNING_KEYS',
        'MEMBER_VERIFY_KEYS',
        'SIGNUP_KEYS',
      ].sort(),
    );
    expect(vault.filter((b) => b.type === 'plain_text').map((b) => [b.name, b.text])).toEqual(
      expect.arrayContaining([
        ['VAULT_WRITE_FORMAT', 'legacy'],
        ['VAULT_LEGACY_OPEN', 'on'],
        ['LINK_SIGNING_MODE', 'v1'],
      ]),
    );
  });

  it('refuses to deploy a caller of the vault before the vault exists', async () => {
    const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
    const release = await open(releaseFiles());
    const store = new MemoryStateStore();
    await install(release, transport, store);
    transport.scripts.delete('swarm-vault');
    const { state, secrets } = await store.load('production');
    const ctx = wizardContext({
      transport,
      store,
      state,
      secrets,
      answers,
      token: 'test-only-cloudflare-token',
      accountId: state?.account?.id ?? '',
      release,
      log: () => undefined,
    });
    const step = (id: string) =>
      wizardSteps(release)
        .find((s) => s.id === id)!
        .run(ctx);
    await expect(step('deploy-site')).rejects.toThrow(/Service swarm-vault does not exist/);
    await step('deploy-vault');
    await step('deploy-site');
    expect(transport.scripts.has('swarm-site')).toBe(true);
  });

  it('connects each queue to its consumer', async () => {
    const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
    await install(await open(releaseFiles()), transport, new MemoryStateStore());
    const send = transport.queues.find((q) => q.queue_name === 'swarm-production-send');
    expect(transport.consumers.get(send?.queue_id ?? '')).toEqual([
      expect.objectContaining({
        script_name: 'swarm-send',
        dead_letter_queue: 'swarm-production-send-dlq',
        settings: expect.objectContaining({
          batch_size: 10,
          max_retries: 8,
          max_wait_time_ms: 1000,
        }),
      }),
    ]);
  });

  it('gives an install from before the public queue that queue, its consumer and the producers', async () => {
    const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
    const release = await open(releaseFiles());
    const store = new MemoryStateStore();
    await install(release, transport, store);
    // As an install from before it: jobs consumes jobs and webhooks, there is no public queue.
    transport.queues = transport.queues.filter((q) => !q.queue_name.includes('-public'));
    const step = async (id: string) => {
      const { state, secrets } = await store.load('production');
      const ctx = wizardContext({
        transport,
        store,
        state,
        secrets,
        answers,
        token: 'test-only-cloudflare-token',
        accountId: state?.account?.id ?? '',
        release,
        log: () => undefined,
      });
      await wizardSteps(release)
        .find((s) => s.id === id)!
        .run(ctx);
      await ctx.store.save(ctx.state);
    };
    // A public Worker can't be deployed onto a queue that doesn't exist yet.
    await expect(step('deploy-capture')).rejects.toThrow(/swarm-production-public does not exist/);

    await step('resources');
    for (const worker of ['events', 'capture', 'jobs']) await step(`deploy-${worker}`);
    const queue = (name: string) => transport.queues.find((q) => q.queue_name === name);
    const consumersOf = (name: string) => transport.consumers.get(queue(name)?.queue_id ?? '');
    expect(queue('swarm-production-public-dlq')).toBeTruthy();
    expect(consumersOf('swarm-production-public')).toEqual([
      expect.objectContaining({
        script_name: 'swarm-jobs',
        dead_letter_queue: 'swarm-production-public-dlq',
        settings: expect.objectContaining({ batch_size: 10, max_retries: 8 }),
      }),
    ]);
    // The consumers jobs already had are left as they were, not attached twice.
    expect(consumersOf('swarm-production-jobs')).toHaveLength(1);
    expect(consumersOf('swarm-production-webhooks')).toHaveLength(1);
    for (const script of ['swarm-capture', 'swarm-events']) {
      const bindings = transport.scripts.get(script)?.metadata.bindings as {
        type: string;
        name: string;
        queue_name?: string;
      }[];
      expect(bindings.filter((b) => b.type === 'queue')).toEqual([
        { type: 'queue', name: 'PUBLIC_QUEUE', queue_name: 'swarm-production-public' },
      ]);
    }
  });

  it("keeps a person's existing subdomains away from the publication websites", async () => {
    const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
    transport.dns.push({
      id: 'shop',
      type: 'A',
      name: 'shop.example.com',
      content: '192.0.2.1',
      proxied: true,
    } as (typeof transport.dns)[number]);
    const { excludeHosts: _none, ...withoutChoice } = answers;
    const { state, log } = await install(
      await open(releaseFiles()),
      transport,
      new MemoryStateStore(),
      withoutChoice,
    );
    expect(state?.choices?.excludeHosts).toEqual(['shop.example.com']);
    expect(transport.actions.join('\n')).toContain('shop.example.com');
    expect(log.join('\n')).toContain('Adding an exclusion route');
  });

  describe('choosing addresses', () => {
    const run = (addresses: Answers['addresses'], setup?: (t: FakeTransport) => void) => {
      const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
      setup?.(transport);
      return open(releaseFiles()).then(async (release) => ({
        transport,
        ...(await install(release, transport, new MemoryStateStore(), { ...answers, addresses })),
      }));
    };
    const varsOf = (t: FakeTransport, name: string, key: string) =>
      (t.scripts.get(name)?.metadata.bindings as { name: string; text?: string }[]).find(
        (b) => b.name === key,
      )?.text;

    it('puts the dashboard on the chosen subdomain', async () => {
      const { transport, report } = await run({ dashboard: 'write' });
      expect(transport.workerRoutes.map((r) => r.pattern)).toContain('write.example.com/*');
      expect(transport.workerRoutes.map((r) => r.pattern)).not.toContain('app.example.com/*');
      expect(varsOf(transport, 'swarm-api', 'APP_ORIGIN')).toBe('https://write.example.com');
      expect(report.signInLink).toMatch(/^https:\/\/write\.example\.com\//);
      expect(transport.dns.map((r) => r.name)).toContain('write.example.com');
    });

    it('serves the publication at the main domain, with its own record and route', async () => {
      const { transport } = await run({ publicationAtRoot: true });
      expect(transport.workerRoutes).toContainEqual(
        expect.objectContaining({ pattern: 'example.com/*', script: 'swarm-site' }),
      );
      expect(transport.dns).toContainEqual(
        expect.objectContaining({ type: 'AAAA', name: 'example.com', proxied: true }),
      );
      expect(transport.actions.join('\n')).toContain('INSERT INTO custom_hostnames');
    });

    it("leaves the main domain alone unless it's chosen", async () => {
      const { transport } = await run({ publicationAtRoot: false });
      expect(transport.workerRoutes.map((r) => r.pattern)).not.toContain('example.com/*');
      expect(transport.dns.map((r) => r.name)).not.toContain('example.com');
      expect(transport.actions.join('\n')).not.toContain('INSERT INTO custom_hostnames');
    });

    it("keeps a proxied record of the person's own, because the route takes over", async () => {
      const own = {
        id: 'own',
        type: 'A',
        name: 'example.com',
        content: '192.0.2.1',
        proxied: true,
      };
      const { transport } = await run({ publicationAtRoot: true }, (t) =>
        t.dns.push(own as (typeof t.dns)[number]),
      );
      expect(transport.dns.filter((r) => r.name === 'example.com')).toHaveLength(1);
    });

    it('stops before going public when the main domain points straight at another server', async () => {
      const own = {
        id: 'own',
        type: 'A',
        name: 'example.com',
        content: '192.0.2.1',
        proxied: false,
      };
      await expect(
        run({ publicationAtRoot: true }, (t) => t.dns.push(own as (typeof t.dns)[number])),
      ).rejects.toThrow(/points directly at another server/);
    });

    it('refuses a dashboard address Swarm needs, or one the publication has', async () => {
      await expect(run({ dashboard: 'mail' })).rejects.toThrow(/used by Swarm itself/);
      await expect(run({ dashboard: 'a.b' })).rejects.toThrow(/no dots/);
      await expect(run({ dashboard: 'letter' })).rejects.toThrow(/can't both use/);
    });
  });

  describe('checking email before calling it finished', () => {
    const stopsAt = async (answer: (t: FakeTransport) => void) => {
      const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
      answer(transport);
      return install(await open(releaseFiles()), transport, new MemoryStateStore());
    };

    it('sends a real test email to the owner', async () => {
      const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
      const { report } = await install(
        await open(releaseFiles()),
        transport,
        new MemoryStateStore(),
      );
      expect(transport.actions.join('\n')).toContain('POST api.resend.com/emails');
      expect(report.testEmailTo).toBe('ada@example.com');
    });

    it('stops, and says why, when the domain never verifies', async () => {
      await expect(
        stopsAt((t) => {
          const real = t.http.bind(t);
          t.http = async (request) => {
            const answer = await real(request);
            return /api\.resend\.com\/domains\/[^/]+$/.test(request.url)
              ? { ...answer, text: answer.text.replace(/"status":"\w+"/, '"status":"pending"') }
              : answer;
          };
        }),
      ).rejects.toThrow(/hasn't verified mail\.example\.com yet/);
    });

    it('stops when the service refuses the email, with its reason', async () => {
      await expect(
        stopsAt((t) => {
          const real = t.http.bind(t);
          t.http = async (request) =>
            request.url.endsWith('api.resend.com/emails')
              ? { status: 403, text: '{"message":"This domain is not verified"}' }
              : real(request);
        }),
      ).rejects.toThrow(/refused a test email.*not verified/);
    });
  });

  it('creates nothing twice when the whole install runs again', async () => {
    const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
    const store = new MemoryStateStore();
    const release = await open(releaseFiles());
    await install(release, transport, store);
    const routes = transport.workerRoutes.length;
    const consumers = [...transport.consumers.values()].flat().length;
    await install(release, transport, store);
    expect(transport.workerRoutes).toHaveLength(routes);
    expect([...transport.consumers.values()].flat()).toHaveLength(consumers);
    expect(transport.scripts.get('swarm-realtime')?.metadata.migrations).toBeUndefined();
  });

  it('can stop at any step and carry on from there', async () => {
    const files = releaseFiles();
    const release = await open(files);
    const count = wizardSteps(release).length;
    for (const failAt of [0, 3, 8, 12, count - 2]) {
      const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
      const store = new MemoryStateStore();
      const steps = wizardSteps(release);
      let accountId: string | undefined;
      const context = async () => {
        const { state, secrets } = await store.load('production');
        return wizardContext({
          transport,
          store,
          state,
          secrets,
          answers,
          token: 't',
          ...(accountId ? { accountId } : {}),
          release,
          log: () => {},
        });
      };
      for (const [index, step] of steps.entries()) {
        const ctx = await context();
        if (index === failAt) {
          // The step starts, then the request dies before it can finish.
          const failing = { ...ctx, t: Object.create(transport) as FakeTransport };
          failing.t.http = async () => {
            throw new Error('network');
          };
          await step.run(failing).catch(() => {});
        }
        const again = await context();
        await step.run(again);
        await store.save(again.state);
        await store.saveSecrets('production', again.secrets);
        accountId = again.session.accountId;
      }
      expect(transport.scripts.size).toBe(WORKERS.length);
    }
  });

  describe('with Amazon SES', () => {
    const ses: Answers = { ...answers, mail: { provider: 'ses', region: 'eu-west-1' } };
    const awsAdmin = {
      accessKeyId: 'AKIAADMINTEST0000000',
      secretAccessKey: 'test-only-aws-admin-secret-0000000000000',
    };
    const world = () => {
      const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
      transport.awsState.verifiedIdentities.add('mail.example.com');
      transport.awsState.verifiedIdentities.add('ada@example.com');
      return transport;
    };

    it('installs, connects reports, and sends a real test email', async () => {
      const transport = world();
      const { state, secrets, report } = await install(
        await open(releaseFiles()),
        transport,
        new MemoryStateStore(),
        ses,
        awsAdmin,
      );
      expect(state?.ses?.subscriptionConfirmed).toBe(true);
      expect(transport.awsState.sentEmails).toHaveLength(1);
      expect(transport.awsState.sentEmails[0]).toMatchObject({
        FromEmailAddress: 'signin@mail.example.com',
        Destination: { ToAddresses: ['ada@example.com'] },
      });
      expect(report.testEmailTo).toBe('ada@example.com');
      // The Workers get their own key, and the setup key is kept nowhere the kit reads from.
      expect(secrets?.aws?.accessKeyId).toBe('AKIADRYRUN0000000001');
      expect(JSON.stringify({ state, secrets })).not.toContain(awsAdmin.secretAccessKey);
    });

    it('sends the deployed Workers what SES needs', async () => {
      const transport = world();
      await install(await open(releaseFiles()), transport, new MemoryStateStore(), ses, awsAdmin);
      const send = transport.scripts.get('swarm-send');
      expect(JSON.stringify(send)).toContain('AWS_SECRET_ACCESS_KEY');
      expect(JSON.stringify(send)).not.toContain(awsAdmin.secretAccessKey);
    });

    it('says the sandbox limits email, and still finishes once the owner is verified', async () => {
      const { report } = await install(
        await open(releaseFiles()),
        world(),
        new MemoryStateStore(),
        ses,
        awsAdmin,
      );
      expect(report.mailNote).toMatch(/sandbox.*production access/);
    });

    it('has nothing to say about the sandbox once AWS has approved the account', async () => {
      const transport = world();
      transport.awsState.productionAccess = true;
      transport.awsState.verifiedIdentities.delete('ada@example.com');
      const { report } = await install(
        await open(releaseFiles()),
        transport,
        new MemoryStateStore(),
        ses,
        awsAdmin,
      );
      expect(report.mailNote).toBeUndefined();
      expect(report.testEmailTo).toBe('ada@example.com');
    });

    it("stops until the owner clicks AWS's link, while in the sandbox", async () => {
      const transport = world();
      transport.awsState.verifiedIdentities.delete('ada@example.com');
      await expect(
        install(await open(releaseFiles()), transport, new MemoryStateStore(), ses, awsAdmin),
      ).rejects.toThrow(/until you click the link/);
      expect(transport.awsState.sentEmails).toEqual([]);
    });

    it('stops until the sending domain is verified', async () => {
      const transport = world();
      transport.awsState.verifiedIdentities.delete('mail.example.com');
      await expect(
        install(await open(releaseFiles()), transport, new MemoryStateStore(), ses, awsAdmin),
      ).rejects.toThrow(/hasn't verified mail\.example\.com yet/);
    });

    it('stops on a subscription that never confirms, rather than warning past it', async () => {
      const transport = world();
      const real = transport.aws.bind(transport);
      // The events worker refusing every confirmation looks the same from here.
      transport.aws = (async (request: Parameters<typeof real>[0]) =>
        request.operation === 'SetTopicAttributes' &&
        request.input.AttributeName === 'SignatureVersion'
          ? {}
          : real(request)) as typeof transport.aws;
      await expect(
        install(await open(releaseFiles()), transport, new MemoryStateStore(), ses, awsAdmin),
      ).rejects.toThrow(/hasn't confirmed that it can reach your Swarm/);
    });

    it('asks for the key again when it was forgotten before the reports connected', async () => {
      const release = await open(releaseFiles());
      const transport = world();
      const store = new MemoryStateStore();
      const steps = wizardSteps(release);
      const until = steps.findIndex((step) => step.id === 'ses-events');
      let accountId: string | undefined;
      const context = async (withKey: boolean) => {
        const { state, secrets } = await store.load('production');
        return wizardContext({
          transport,
          store,
          state,
          secrets,
          answers: ses,
          token: 'test-only-cloudflare-token',
          ...(accountId ? { accountId } : {}),
          ...(withKey ? { awsAdmin } : {}),
          release,
          log: () => {},
        });
      };
      for (const step of steps.slice(0, until)) {
        const ctx = await context(true);
        await step.run(ctx);
        await store.save(ctx.state);
        await store.saveSecrets('production', ctx.secrets);
        accountId = ctx.session.accountId;
      }
      const { state } = await store.load('production');
      if (state?.ses) state.ses.subscriptionConfirmed = false;
      if (state) await store.save(state);

      const sesEvents = steps[until]!;
      await expect(sesEvents.run(await context(false))).rejects.toThrow(/AWS key again/);
      const ctx = await context(true);
      await sesEvents.run(ctx);
      expect(ctx.state.ses?.subscriptionConfirmed).toBe(true);
    });
  });

  it('refuses to install over an account already running Swarm', async () => {
    const release = await open(releaseFiles());
    const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
    await install(release, transport, new MemoryStateStore());
    // A redeployed setup page with no state of its own: new keyrings would destroy the old ones.
    await expect(install(release, transport, new MemoryStateStore())).rejects.toThrow(
      /already runs Swarm/,
    );
  });

  it('never calls an install finished for a service it could not check', async () => {
    const release = await open(releaseFiles());
    const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
    const store = new MemoryStateStore();
    await install(release, transport, store);
    const { state, secrets } = await store.load('production');
    if (state?.choices) state.choices.mail.provider = 'unknown' as never;
    const ctx = wizardContext({
      transport,
      store,
      state,
      secrets,
      answers,
      token: 'test-only-cloudflare-token',
      release,
      log: () => {},
    });
    const step = wizardSteps(release).find((s) => s.id === 'email-check');
    await expect(step?.run(ctx)).rejects.toThrow(/can't check email/);
  });
});

describe('the release', () => {
  it('opens when the signature matches', async () => {
    const release = await open(releaseFiles());
    expect(release.version).toBe('0.1.0');
    expect(await release.text('migrations/0001_first.sql')).toContain('CREATE TABLE a');
  });

  it('refuses a changed manifest, and another signing key', async () => {
    const files = releaseFiles();
    const changed = new Map(files.contents);
    changed.set('manifest.json', files.contents.get('manifest.json')!.replace('0.1.0', '0.1.1'));
    await expect(
      openRelease({
        baseUrl: 'https://r.test',
        publicKeyPem: files.publicKeyPem,
        fetcher: served(changed),
      }),
    ).rejects.toThrow(/signature check/);
    await expect(
      openRelease({
        baseUrl: 'https://r.test',
        publicKeyPem: releaseFiles().publicKeyPem,
        fetcher: served(files.contents),
      }),
    ).rejects.toThrow(/signature check/);
  });

  it('refuses a file that was changed after signing, and one it does not list', async () => {
    const files = releaseFiles();
    const release = await openRelease({
      baseUrl: 'https://r.test',
      publicKeyPem: files.publicKeyPem,
      fetcher: served(new Map(files.contents).set('workers/api/index.js', 'evil()')),
    });
    await expect(release.text('workers/api/index.js')).rejects.toThrow(/does not match/);
    await expect(release.text('workers/api/other.js')).rejects.toThrow(/no file/);
  });

  it('names the manifest it opened, and refuses another one when told which to expect', async () => {
    const first = releaseFiles();
    const second = releaseFiles('0.0.1');
    const opened = await open(first);
    expect(opened.digest).toBe(sha(first.contents.get('manifest.json')!));
    expect((await open(first)).digest).toBe(opened.digest);
    // Validly signed, but not the release this install started with.
    await expect(
      openRelease({
        baseUrl: 'https://r.test',
        publicKeyPem: second.publicKeyPem,
        fetcher: served(second.contents),
        expected: { digest: opened.digest, version: opened.version },
      }),
    ).rejects.toThrow(/different release/);
    await expect(
      openRelease({
        baseUrl: 'https://r.test',
        publicKeyPem: first.publicKeyPem,
        fetcher: served(first.contents),
        expected: { digest: opened.digest, version: opened.version },
      }),
    ).resolves.toMatchObject({ version: '0.1.0' });
  });

  it('refuses a release older than the minimum version, and takes any without one', async () => {
    const at = (version: string, minimumVersion?: string) => {
      const files = releaseFiles(version);
      return openRelease({
        baseUrl: 'https://r.test',
        publicKeyPem: files.publicKeyPem,
        fetcher: served(files.contents),
        ...(minimumVersion === undefined ? {} : { minimumVersion }),
      });
    };
    // Without a minimum, every signed release opens, the oldest too.
    await expect(at('0.0.1')).resolves.toMatchObject({ version: '0.0.1' });
    await expect(at('0.0.1', '0.1.0')).rejects.toThrow(/older than 0\.1\.0/);
    await expect(at('0.9.9', '0.10.0')).rejects.toThrow(/older than 0\.10\.0/);
    await expect(at('0.2.0-rc.1', '0.2.0')).rejects.toThrow(/older than 0\.2\.0/);
    await expect(at('0.1.0', '0.1.0')).resolves.toMatchObject({ version: '0.1.0' });
    await expect(at('0.10.0', '0.9.9')).resolves.toMatchObject({ version: '0.10.0' });
    await expect(at('0.2.0-rc.2', '0.2.0-rc.10')).rejects.toThrow(/older than/);
    await expect(at('0.2.0', '0.2.0-rc.1')).resolves.toMatchObject({ version: '0.2.0' });
    await expect(at('1.0.0', '0.2.0-rc.1')).resolves.toMatchObject({ version: '1.0.0' });
    // A minimum that isn't a version opens nothing, rather than nothing being checked.
    await expect(at('0.1.0', 'latest')).rejects.toThrow(/RELEASE_MIN_VERSION/);
    await expect(at('nightly', '0.1.0')).rejects.toThrow(/older than 0\.1\.0/);
  });

  it('names the key that signed it, and refuses a manifest naming another', async () => {
    const files = releaseFiles();
    const opened = await open(files);
    expect(opened.keyId).toBe(await releaseKeyId(files.publicKeyPem));
    expect(opened.keyId).toMatch(/^[0-9a-f]{64}$/);
    // Signed by the configured key, but claiming another key, an old format or a trial build.
    for (const fields of [{ keyId: 'f'.repeat(64) }, { format: 1 }, { keyId: undefined }]) {
      await expect(open(releaseFiles('0.1.0', fields))).rejects.toThrow(/does not name the key/);
    }
    for (const fields of [{ build: 'trial' }, { commit: `${'c'.repeat(40)}-dirty` }]) {
      await expect(open(releaseFiles('0.1.0', fields))).rejects.toThrow(/not a clean build/);
    }
  });

  it('refuses a withdrawn release by version, manifest digest or key, first time and later', async () => {
    const files = releaseFiles();
    const opened = await open(files);
    const at = (withdrawn: string, expected?: { digest: string; version: string }) =>
      openRelease({
        baseUrl: 'https://r.test',
        publicKeyPem: files.publicKeyPem,
        fetcher: served(files.contents),
        withdrawn: withdrawnList(withdrawn),
        ...(expected ? { expected } : {}),
      });
    for (const entry of ['0.1.0', opened.digest.toUpperCase(), opened.keyId]) {
      await expect(at(`0.0.9, ${entry}`)).rejects.toThrow(/withdrawn/);
      await expect(at(entry, opened)).rejects.toThrow(/withdrawn/);
    }
    await expect(at('0.0.9 0.2.0')).resolves.toMatchObject({ version: '0.1.0' });
    expect(withdrawnList(' a, B\nc ', ['d'], undefined)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('downloads over https, except from this computer', async () => {
    const files = releaseFiles();
    const at = (baseUrl: string) =>
      openRelease({ baseUrl, publicKeyPem: files.publicKeyPem, fetcher: served(files.contents) });
    await expect(at('http://release.example')).rejects.toThrow(/https/);
    await expect(at('ftp://release.example')).rejects.toThrow(/https/);
    await expect(at('not a url')).rejects.toThrow(/https/);
    await expect(at('http://localhost:8788')).resolves.toMatchObject({ version: '0.1.0' });
    await expect(at('http://127.0.0.1:8788/')).resolves.toMatchObject({ version: '0.1.0' });
  });

  it('explains a release it cannot download', async () => {
    await expect(
      openRelease({ baseUrl: 'https://r.test', publicKeyPem: 'x', fetcher: served(new Map()) }),
    ).rejects.toThrow(/Could not download manifest.json/);
  });
});

describe('deploy details', () => {
  it('runs only the Durable Object migrations a script has not had', () => {
    const all = [
      { tag: 'v1', new_sqlite_classes: ['A'] },
      { tag: 'v2', new_sqlite_classes: ['B'] },
    ];
    expect(pendingObjectMigrations(all, null)).toEqual({
      new_tag: 'v2',
      steps: [{ new_sqlite_classes: ['A'] }, { new_sqlite_classes: ['B'] }],
    });
    expect(pendingObjectMigrations(all, 'v1')).toEqual({
      old_tag: 'v1',
      new_tag: 'v2',
      steps: [{ new_sqlite_classes: ['B'] }],
    });
    expect(pendingObjectMigrations(all, 'v2')).toBeNull();
    expect(pendingObjectMigrations([], null)).toBeNull();
  });

  it('keeps secrets as secrets, and other values plain', () => {
    const bindings = bindingsFrom({ vars: { A: 'x', N: 3 } }, { S: 'hidden' });
    expect(bindings).toEqual([
      { type: 'plain_text', name: 'A', text: 'x' },
      { type: 'json', name: 'N', json: 3 },
      { type: 'secret_text', name: 'S', text: 'hidden' },
    ]);
  });
});

describe('withOwnSiteSources', () => {
  const csp = (frames: string, fonts: string) =>
    `/*\n  Content-Security-Policy: default-src 'self'; font-src ${fonts}; frame-src ${frames}; frame-ancestors 'none'\n`;
  const base = csp('https://challenges.cloudflare.com', "'self' data:");

  it('lets the dashboard frame, and load fonts from, only this install’s own sites', () => {
    const own = 'https://news.example.org https://*.news.example.org';
    expect(withOwnSiteSources(base, 'news.example.org')).toBe(
      csp(`https://challenges.cloudflare.com ${own}`, `'self' data: ${own}`),
    );
  });

  it('adds them once, and leaves the headers alone without a plain host name', () => {
    const once = withOwnSiteSources(base, 'example.com');
    expect(withOwnSiteSources(once, 'example.com')).toBe(once);
    for (const zone of [
      undefined,
      '',
      'example.com; script-src *',
      '*.example.com',
      'http://x.com',
      'EXAMPLE.com',
    ]) {
      expect(withOwnSiteSources(base, zone)).toBe(base);
    }
  });
});
