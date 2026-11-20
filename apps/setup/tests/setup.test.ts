import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '@swarm/installer/fake';
import {
  isSealedKit,
  openKit,
  sealKit,
  type Answers,
  type SealedKit,
} from '@swarm/installer/wizard';
import api from '../../../workers/api/wrangler.jsonc?raw';
import capture from '../../../workers/capture/wrangler.jsonc?raw';
import events from '../../../workers/events/wrangler.jsonc?raw';
import jobs from '../../../workers/jobs/wrangler.jsonc?raw';
import realtime from '../../../workers/realtime/wrangler.jsonc?raw';
import send from '../../../workers/send/wrangler.jsonc?raw';
import site from '../../../workers/site/wrangler.jsonc?raw';
import track from '../../../workers/track/wrangler.jsonc?raw';
import vault from '../../../workers/vault/wrangler.jsonc?raw';
import { readAnswers } from '../src/index';
import { APP_JS, PAGE_HTML, STAGES, TOKEN_LINK } from '../src/page';
import { MAX_KIT_DOWNLOADS, SECRETS_IDLE_MS, scrub, secretValues, type SetupRun } from '../src/run';

const ORIGIN = 'https://setup.example.workers.dev';
const PASSWORD = 'test-only-setup-password';
const TOKEN = 'test-only-cloudflare-token';
const KEY = 're_test_only_0000000000000000';
const AWS_KEY_ID = 'AKIATESTONLY00000000';
const AWS_SECRET = 'test-only-aws-secret-key-0000000000000000';
const KIT_PASSPHRASE = 'test-only kit passphrase';

const CONFIGS: Record<string, string> = {
  api,
  capture,
  events,
  jobs,
  realtime,
  send,
  site,
  track,
  vault,
};
/** The key this Worker is tested with, kept before any test changes the shared env. */
const TEST_PUBLIC_KEY = env.RELEASE_PUBLIC_KEY;

const pemBytes = (pem: string) =>
  Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s+/g, '')), (c) => c.charCodeAt(0));
const hexOf = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
/** A key's id as `pnpm release:sign` prints it: the sha256 of its SPKI bytes. */
const keyIdOf = async (publicKeyPem: string) =>
  hexOf(await crypto.subtle.digest('SHA-256', pemBytes(publicKeyPem)));

/** Another signing key, made for one test: what a substituted or replacement key would be. */
async function otherKey() {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer,
  );
  const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...spki))}\n-----END PUBLIC KEY-----\n`;
  return { privateKey: pair.privateKey, publicKeyPem };
}

/** Serves a small signed release, with the real Worker configs, as release:sign writes one. */
async function makeRelease({
  version = '0.1.0',
  code = 'export default {};',
  migrations = true,
  signer,
}: {
  version?: string;
  code?: string;
  migrations?: boolean;
  signer?: { privateKey: CryptoKey; publicKeyPem: string };
} = {}) {
  const key =
    signer?.privateKey ??
    (await crypto.subtle.importKey('pkcs8', pemBytes(env.TEST_RELEASE_KEY), 'Ed25519', false, [
      'sign',
    ]));
  const keyId = await keyIdOf(signer?.publicKeyPem ?? TEST_PUBLIC_KEY);
  const contents = new Map<string, string>();
  for (const [worker, config] of Object.entries(CONFIGS)) {
    contents.set(`workers/${worker}/wrangler.jsonc`, config);
    contents.set(`workers/${worker}/index.js`, code);
  }
  contents.set('dashboard/index.html', '<!doctype html><title>Swarm</title>');
  if (migrations) contents.set('migrations/0001_first.sql', 'CREATE TABLE a (b TEXT);');
  const files = [];
  for (const [path, text] of contents) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    files.push({
      path,
      size: text.length,
      sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
    });
  }
  const manifest = JSON.stringify({
    format: 2,
    version,
    commit: 'c'.repeat(40),
    build: 'clean',
    keyId,
    files,
  });
  const signature = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(manifest));
  contents.set('manifest.json', manifest);
  contents.set('manifest.sig', btoa(String.fromCharCode(...new Uint8Array(signature))));
  return { contents };
}

let world: FakeTransport;
let cookie = '';
/** What release.test serves right now. */
let served = new Map<string, string>();

const call = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json', origin: ORIGIN }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const logIn = async () => {
  const res = await call('/api/login', { password: PASSWORD });
  expect(res.status).toBe(200);
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
};

const details = {
  token: TOKEN,
  zone: 'example.com',
  ownerName: 'Ada Example',
  ownerEmail: 'ada@example.com',
  publicationName: 'The Example Letter',
  publicationSlug: 'letter',
  mail: { provider: 'resend', region: 'eu-west-1', apiKey: KEY },
};

beforeEach(async () => {
  cookie = '';
  world = new FakeTransport({ zone: 'example.com', environment: 'production' });
  served = (await releaseOnce).contents;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.host === 'release.test') {
      const text = served.get(url.pathname.slice(1));
      return text === undefined ? new Response('', { status: 404 }) : new Response(text);
    }
    const body = request.method === 'GET' ? undefined : await request.text();
    const answer = await world.http({
      method: request.method as 'GET',
      url: request.url,
      headers: Object.fromEntries(request.headers),
      ...(body === undefined ? {} : { body }),
    });
    return new Response(answer.text, { status: answer.status });
  });
});

const releaseOnce = makeRelease();

describe('the setup password', () => {
  it('guards everything but the page itself', async () => {
    expect((await call('/')).status).toBe(200);
    for (const path of ['/api/status', '/api/recovery-kit']) {
      expect((await call(path)).status).toBe(401);
    }
    for (const path of ['/api/connect', '/api/begin', '/api/step', '/api/finish']) {
      expect((await call(path, {})).status).toBe(401);
    }
  });

  it('refuses a forged or expired session', async () => {
    const past = Date.now() - 1000;
    for (const value of ['nonsense', `${Date.now() + 1e6}.abcd`, `${past}.abcd`]) {
      expect(
        (await call('/api/status', undefined, { cookie: `swarm_setup=${value}` })).status,
      ).toBe(401);
    }
  });

  it('sets a cookie scripts and other sites can not use', async () => {
    const res = await call('/api/login', { password: PASSWORD });
    const header = res.headers.get('set-cookie') ?? '';
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict']) expect(header).toContain(part);
    expect(header).not.toContain(PASSWORD);
  });

  it('refuses requests from another site, even with the cookie', async () => {
    await logIn();
    const res = await call('/api/finish', {}, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(
      (await call('/api/login', { password: PASSWORD }, { origin: 'https://evil.example' })).status,
    ).toBe(403);
  });
});

describe('the page', () => {
  it('blocks inline scripts and framing', async () => {
    const res = await call('/');
    const policy = res.headers.get('content-security-policy') ?? '';
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(await res.text()).not.toMatch(/<script>|onclick=/);
  });

  it('puts server text in the page only as text', () => {
    expect(APP_JS).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
  });

  it('sorts every install step into exactly one stage, in the page too', async () => {
    await logIn();
    const { steps } = (await (await call('/api/status')).json()) as { steps: { id: string }[] };
    const stageOf = new Function(
      `${/function stageOf[\s\S]*?\n}/.exec(APP_JS)?.[0]}; return stageOf;`,
    )() as (id: string) => number;
    for (const { id } of steps) {
      const matching = STAGES.map((stage, index) => (stage.steps(id) ? index : -1)).filter(
        (i) => i >= 0,
      );
      expect(matching, id).toHaveLength(1);
      expect(stageOf(id), id).toBe(matching[0]);
    }
  });

  it('allows fonts only from itself', async () => {
    const policy = (await call('/')).headers.get('content-security-policy') ?? '';
    expect(policy).toContain("font-src 'self'");
  });

  it('asks for every permission group in the token link', () => {
    const keys = JSON.parse(
      new URL(TOKEN_LINK).searchParams.get('permissionGroupKeys') ?? '[]',
    ) as {
      key: string;
    }[];
    for (const key of ['workers_scripts', 'd1', 'queues', 'dns', 'workers_routes']) {
      expect(keys.map((k) => k.key)).toContain(key);
    }
  });
});

describe('the answers', () => {
  it('names what is missing, and starts nothing', async () => {
    await logIn();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ zone: '' }, /domain/i],
      [{ ownerEmail: 'nope' }, /email address/i],
      [{ publicationAt: 'subdomain', publicationSlug: '' }, /Enter a subdomain/],
      [{ mail: { provider: 'resend' } }, /Resend API key/],
      [{ mail: { provider: 'nope' } }, /Choose an email service/],
      [{ mail: { provider: 'ses' } }, /AWS access key ID/],
      [
        { mail: { provider: 'ses', accessKeyId: 'not-a-key', secretAccessKey: AWS_SECRET } },
        /AWS access key ID/,
      ],
      [{ mail: { provider: 'ses', accessKeyId: AWS_KEY_ID, secretAccessKey: 'x' } }, /secret/],
      [
        { mail: { provider: 'ses', accessKeyId: AWS_KEY_ID, secretAccessKey: AWS_SECRET } },
        /AWS region/,
      ],
      [{ mail: { provider: 'smtp', host: 'mail.example.net' } }, /mail server/],
      [{ token: '' }, /Cloudflare token/],
    ];
    for (const [change, message] of cases) {
      const res = await call('/api/begin', { ...details, ...change });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    }
    expect(((await (await call('/api/status')).json()) as { phase: string }).phase).toBe('answers');
  });

  it('leaves existing subdomains for the installer to protect', () => {
    const answers = readAnswers(details);
    expect(typeof answers).toBe('object');
    expect(answers).not.toHaveProperty('excludeHosts');
  });

  it('puts the publication at the main domain unless a subdomain is chosen', () => {
    const answers = readAnswers({ ...details, publicationSlug: '' }) as Answers;
    expect(answers.addresses).toEqual({ dashboard: 'app', publicationAtRoot: true });
    expect(answers.publication?.slug).toBe('the-example-letter');
    expect(readAnswers({ ...details, publicationAt: 'subdomain', publicationSlug: '' })).toMatch(
      /Enter a subdomain/,
    );
    const chosen = readAnswers({
      ...details,
      publicationAt: 'subdomain',
      publicationSlug: 'letter',
      dashboard: 'write',
    }) as Answers;
    expect(chosen.addresses).toEqual({ dashboard: 'write', publicationAtRoot: false });
    expect(chosen.publication?.slug).toBe('letter');
  });

  it('still installs when a publication name makes no usable address', () => {
    const answers = readAnswers({ ...details, publicationName: 'App' }) as Answers;
    expect(answers.publication?.slug).toBe('my-publication');
  });

  it('refuses addresses that would clash', () => {
    expect(readAnswers({ ...details, dashboard: 'mail' })).toMatch(/used by Swarm itself/);
    expect(
      readAnswers({
        ...details,
        publicationAt: 'subdomain',
        publicationSlug: 'letter',
        dashboard: 'letter',
      }),
    ).toMatch(/different subdomains/);
    expect(
      readAnswers({ ...details, publicationAt: 'subdomain', publicationSlug: 'forms' }),
    ).toMatch(/subdomain/);
  });

  it('explains a token Cloudflare refuses', async () => {
    await logIn();
    world.http = async () => ({
      status: 403,
      text: '{"success":false,"errors":[{"message":"no"}]}',
    });
    const res = await call('/api/connect', { token: 'bad-token' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/did not accept/);
  });

  it('names the permissions a token is missing, before anything is created', async () => {
    await logIn();
    const real = world.http.bind(world);
    world.http = async (request) =>
      /challenges\/widgets|email\/routing/.test(request.url)
        ? { status: 403, text: '{"success":false,"errors":[{"code":10000}]}' }
        : real(request);
    const res = await call('/api/connect', { token: TOKEN });
    expect(((await res.json()) as { missing: string[] }).missing).toEqual([
      'Account > Turnstile > Edit',
      'Zone > Email Routing Rules > Edit',
    ]);
    expect(world.actions.filter((a) => a.startsWith('POST'))).toEqual([]);
  });

  it('lists the accounts and domains a good token can reach', async () => {
    await logIn();
    const res = await call('/api/connect', { token: TOKEN });
    const found = (await res.json()) as {
      accounts: unknown[];
      zones: { name: string }[];
      missing: string[];
    };
    expect(found.missing).toEqual([]);
    expect(found.accounts).toHaveLength(1);
    expect(found.zones.map((z) => z.name)).toEqual(['example.com']);
  });
});

interface Progress {
  phase: string;
  steps: { id: string; done: boolean }[];
  failed: { message: string; hint?: string } | null;
  log: string[];
  signInLink: string | null;
  release: string | null;
  offer: { version: string; digest: string; keyId: string; projectKey: boolean } | null;
  approved: boolean;
}
const step = async () => (await (await call('/api/step', {})).json()) as Progress;
/** Approves what the page shows, as the person does after comparing it. */
const approveOffer = async () => {
  const { offer } = (await (await call('/api/status')).json()) as Progress;
  expect(offer).toBeTruthy();
  const res = await call('/api/approve', { version: offer?.version, digest: offer?.digest });
  expect(res.status).toBe(200);
  return (await res.json()) as Progress;
};

// These run in order, on the one install this Worker has.
describe('Amazon SES on the page', () => {
  const sesAnswers = (extra: Record<string, unknown> = {}) =>
    readAnswers({
      ...details,
      mail: {
        provider: 'ses',
        region: 'eu-west-1',
        accessKeyId: AWS_KEY_ID,
        secretAccessKey: AWS_SECRET,
        ...extra,
      },
    }) as Answers;
  /** A Durable Object of its own, so these don't disturb the whole install below. */
  const run = (name: string) => env.SETUP.get(env.SETUP.idFromName(`ses-${name}`));

  it('offers it, with the permissions the key needs', () => {
    expect(PAGE_HTML).toContain('value="ses"');
    expect(PAGE_HTML).toContain('sns:SetTopicAttributes');
    expect(PAGE_HTML).not.toContain('terminal installer');
    expect(APP_JS).toContain('/api/aws-key');
  });

  it('asks AWS for production access only when told to', () => {
    expect(sesAnswers().mail?.requestProductionAccess).toBe(false);
    expect(sesAnswers({ requestProductionAccess: true }).mail?.requestProductionAccess).toBe(true);
    expect(sesAnswers({ requestProductionAccess: 'yes' }).mail?.requestProductionAccess).toBe(
      false,
    );
  });

  it('keeps the key apart from the answers, and sets a time to forget it', async () => {
    const stub = run('apart');
    const progress = await stub.begin(TOKEN, sesAnswers());
    expect(JSON.stringify(progress)).not.toContain(AWS_SECRET);
    await runInDurableObject(stub, async (_run, state) => {
      const answers = await state.storage.get<Answers>('answers');
      expect(answers?.mail?.provider).toBe('ses');
      expect(JSON.stringify(answers)).not.toContain(AWS_SECRET);
      expect(JSON.stringify(answers)).not.toContain(AWS_KEY_ID);
      expect(await state.storage.get('awsKey')).toEqual({
        accessKeyId: AWS_KEY_ID,
        secretAccessKey: AWS_SECRET,
      });
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBeGreaterThan(Date.now() + 110 * 60 * 1000);
      expect(alarm).toBeLessThanOrEqual(Date.now() + 120 * 60 * 1000);
    });
  });

  it('forgets the key when its time is up, and asks for it again', async () => {
    const stub = run('alarm');
    await stub.begin(TOKEN, sesAnswers());
    await runInDurableObject(stub, async (instance, state) => {
      await instance.alarm();
      expect(await state.storage.get('awsKey')).toBeUndefined();
      expect((await instance.progress()).needsAwsKey).toBe(false); // Not stopped, so nothing to ask.
      await state.storage.put('failed', { step: 'x', message: 'y' });
      expect((await instance.progress()).needsAwsKey).toBe(true);

      const replaced = await instance.replaceAwsKey({
        accessKeyId: AWS_KEY_ID,
        secretAccessKey: AWS_SECRET,
      });
      expect(replaced.failed).toBeNull();
      expect(replaced.needsAwsKey).toBe(false);
      expect(JSON.stringify(replaced)).not.toContain(AWS_SECRET);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it('does not ask for the key once the reports are connected', async () => {
    const stub = run('connected');
    await stub.begin(TOKEN, sesAnswers());
    await runInDurableObject(stub, async (instance, state) => {
      await instance.alarm();
      await state.storage.put('failed', { step: 'x', message: 'y' });
      await state.storage.put('state', { ses: { subscriptionConfirmed: true } });
      expect((await instance.progress()).needsAwsKey).toBe(false);
    });
  });

  it('forgets the key at the finish, along with its timer', async () => {
    const stub = run('finish');
    await stub.begin(TOKEN, sesAnswers());
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put('phase', 'save-kit');
      await instance.finish();
      expect(await state.storage.get('awsKey')).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('refuses a bad replacement key before storing it', async () => {
    await logIn();
    const res = await call('/api/aws-key', { accessKeyId: 'nope', secretAccessKey: AWS_SECRET });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/AWS access key ID/);
  });

  it('hides the key from anything it might be quoted in', () => {
    expect(scrub(`refused ${AWS_KEY_ID} and ${AWS_SECRET}`, [AWS_KEY_ID, AWS_SECRET])).toBe(
      'refused [hidden] and [hidden]',
    );
    expect(scrub('nothing here', [undefined, TOKEN])).toBe('nothing here');
  });
});

describe('the page’s script', () => {
  it('parses, because one syntax error takes the whole page down', () => {
    expect(() => new Function(APP_JS)).not.toThrow();
  });
});

describe('changing the email service from the page', () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    action: 'status',
    token: TOKEN,
    state: { version: 1 },
    secrets: {},
    ...extra,
  });

  it('offers it from the first screen', () => {
    expect(PAGE_HTML).toContain('id="welcome-change"');
    expect(PAGE_HTML).toContain('id="change-kit"');
    expect(APP_JS).toContain('/api/change');
  });

  it('needs the setup password, like everything else', async () => {
    expect((await call('/api/change', body())).status).toBe(401);
  });

  it('refuses what isn’t a recovery kit, an unknown action, and a missing token', async () => {
    await logIn();
    const rejects = async (extra: Record<string, unknown>, message: RegExp) => {
      const res = await call('/api/change', body(extra));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    };
    await rejects({ state: { not: 'a kit' } }, /recovery kit/);
    await rejects({ action: 'destroy' }, /Unknown action/);
    await rejects({ token: '' }, /Cloudflare token/);
  });

  it('opens and seals kits in the browser the same way the installer does', async () => {
    const code = /function kitBytes[\s\S]*?\n(?=function saveFile)/.exec(APP_JS)?.[0];
    expect(code).toBeTruthy();
    const page = new Function(`${code}; return { openSealedKit, sealOpenKit };`)() as {
      openSealedKit: (kit: unknown, passphrase: string) => Promise<{ secrets: unknown }>;
      sealOpenKit: (contents: unknown, passphrase: string, meta: unknown) => Promise<SealedKit>;
    };
    const contents = {
      state: { zone: { name: 'example.com' } },
      secrets: { keys: { FIELD_KEYS: 'f' } },
    };
    const meta = { what: 'kit', createdAt: '2026-11-19T00:00:00.000Z', domain: 'example.com' };
    const fromInstaller = await sealKit(contents, KIT_PASSPHRASE, meta);
    expect(await page.openSealedKit(fromInstaller, KIT_PASSPHRASE)).toEqual(contents);
    await expect(page.openSealedKit(fromInstaller, 'another passphrase!')).rejects.toThrow();
    const fromPage = await page.sealOpenKit(contents, KIT_PASSPHRASE, meta);
    expect(isSealedKit(fromPage)).toBe(true);
    expect(JSON.stringify(fromPage)).not.toContain('FIELD_KEYS');
    expect(await openKit(fromPage, KIT_PASSPHRASE)).toEqual(contents);
  });

  it('never sends the encryption keys, because the page takes them out first', () => {
    const kitToSend = new Function(
      'kit',
      `${/function kitToSend[\s\S]*?\n}/.exec(APP_JS)?.[0]}; return kitToSend();`,
    ) as (kit: unknown) => { secrets: Record<string, unknown> };
    const sent = kitToSend({
      state: {},
      secrets: { keys: { FIELD_KEYS: 'x' }, resendApiKey: 'y' },
    });
    expect(sent.secrets.keys).toBeUndefined();
    expect(sent.secrets.resendApiKey).toBe('y');
  });
});

describe('a whole install through the page', () => {
  it('starts, keeps a failed step next, and carries on when asked again', async () => {
    await logIn();
    const begun = await call('/api/begin', details);
    expect(((await begun.json()) as Progress).phase).toBe('installing');
    expect((await approveOffer()).approved).toBe(true);

    const real = world.http.bind(world);
    world.http = async () => ({
      status: 500,
      text: `{"success":false,"errors":[{"message":"${TOKEN} down"}]}`,
    });
    const failed = await step();
    expect(failed.failed?.message).toBeTruthy();
    // An error from Cloudflare can't put the token on the page.
    expect(JSON.stringify(failed)).not.toContain(TOKEN);
    expect(failed.steps.filter((s) => s.done)).toHaveLength(0);

    // A refused permission is explained in plain words.
    world.http = async () => ({
      status: 403,
      text: '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}',
    });
    expect((await step()).failed?.hint).toMatch(/missing a permission/);
    world.http = real;
    // A new token takes over, and clears the failure.
    const replaced = (await (
      await call('/api/token', { token: 'a-new-token-value' })
    ).json()) as Progress;
    expect(replaced.failed).toBeNull();
    expect(JSON.stringify(replaced)).not.toContain('a-new-token-value');
    await call('/api/token', { token: TOKEN });
    const retried = await step();
    expect(retried.failed).toBeNull();
    expect(retried.steps[0]).toMatchObject({ id: 'account', done: true });
  });

  it('runs to the end, one request per step, across a fresh world of requests', async () => {
    await logIn();
    let progress = (await (await call('/api/status')).json()) as Progress;
    for (let i = 0; i < 40 && progress.phase === 'installing'; i++) {
      progress = await step();
      expect(progress.failed).toBeNull();
    }
    expect(progress.phase).toBe('save-kit');
    expect(progress.steps.every((s) => s.done)).toBe(true);
    expect(progress.signInLink).toMatch(/^https:\/\/app\.example\.com\//);
    const text = JSON.stringify(progress);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('FIELD_KEYS":"');
  });

  it('hands over the recovery kit, sealed under a passphrase the person chooses', async () => {
    await logIn();
    // Only with a passphrase, and never as a plain download.
    expect((await call('/api/recovery-kit')).status).toBe(404);
    expect((await call('/api/recovery-kit', { passphrase: 'short' })).status).toBe(400);
    const res = await call('/api/recovery-kit', { passphrase: KIT_PASSPHRASE });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('swarm-recovery-kit.json');
    const sealed = (await res.json()) as SealedKit;
    expect(isSealedKit(sealed)).toBe(true);
    expect(sealed.domain).toBe('example.com');
    // The file alone holds no key.
    const text = JSON.stringify(sealed);
    expect(text).not.toContain('FIELD_KEYS');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(KEY);
    await expect(openKit(sealed, 'not the passphrase at all')).rejects.toThrow(/does not open/);
    const kit = (await openKit(sealed, KIT_PASSPHRASE)) as {
      secrets: { keys: Record<string, string> };
      state: { zone?: { name: string }; linkKeys?: { mode: string } };
    };
    // With the state too, `pnpm swarm restore` can rebuild .swarm/ from it.
    expect(kit.state.zone?.name).toBe('example.com');
    expect(kit.secrets.keys.FIELD_KEYS).toBeTruthy();
    // Every keyring, the Ed25519 ones made here with WebCrypto (base64url PKCS#8). Only private
    // keys are kept: the public ones are derived at each deploy.
    expect(kit.secrets.keys.MEMBER_SIGNING_KEYS).toMatch(/^k\d{8}:MC4CAQAwBQYDK2VwBCIEI[\w-]{43}$/);
    expect(kit.secrets.keys.CONFIRM_KEYS).toMatch(/^k\d{8}:[\w-]{64}$/);
    expect(kit.secrets.keys.MEMBER_VERIFY_KEYS).toBeUndefined();
    expect(kit.state.linkKeys?.mode).toBe('verify-v2');
    expect(PAGE_HTML).not.toContain('href="/api/recovery-kit"');
  });

  it('forgets the token and every key when the person finishes', async () => {
    await logIn();
    const finished = (await (await call('/api/finish', {})).json()) as Progress;
    expect(finished.phase).toBe('finished');
    expect(finished.signInLink).toBeTruthy();
    expect((await call('/api/recovery-kit', { passphrase: KIT_PASSPHRASE })).status).toBe(404);
    const stub = env.SETUP.get(env.SETUP.idFromName('install'));
    await runInDurableObject(stub, async (_run, state) => {
      for (const key of ['token', 'secrets', 'answers']) {
        expect(await state.storage.get(key)).toBeUndefined();
      }
      const everything = JSON.stringify([...(await state.storage.list()).entries()]);
      expect(everything).not.toContain(TOKEN);
      expect(everything).not.toContain(KEY);
    });
  });

  it('does nothing more once finished', async () => {
    await logIn();
    const done = world.actions.length;
    expect((await step()).phase).toBe('finished');
    expect(world.actions).toHaveLength(done);
  });
});

describe('the release an install uses', () => {
  const configured: DurableObjectStub<SetupRun>[] = [];
  /**
   * Changes the release settings, as a deploy would. Every object of the class shares one env, so
   * a test configures, uses and moves on, and afterEach puts the tested settings back.
   */
  const configure = (stub: DurableObjectStub<SetupRun>, vars: Record<string, string>) => {
    configured.push(stub);
    return runInDurableObject(stub, (run) => {
      Object.assign((run as unknown as { env: Record<string, string> }).env, vars);
    });
  };
  const withMinimum = (stub: DurableObjectStub<SetupRun>, minimum: string) =>
    configure(stub, { RELEASE_MIN_VERSION: minimum });
  // The settings this Worker is tested with (vitest.config.ts), back for the next test.
  afterEach(async () => {
    for (const stub of configured.splice(0)) {
      await configure(stub, {
        RELEASE_MIN_VERSION: '0.1.0',
        RELEASE_ACCEPT_ANY_VERSION: '',
        RELEASE_WITHDRAWN: '',
        RELEASE_PUBLIC_KEY: TEST_PUBLIC_KEY,
      });
      configured.length = 0;
    }
  });
  const approve = async (stub: DurableObjectStub<SetupRun>) => {
    const { offer } = await stub.progress();
    expect(offer).toBeTruthy();
    return stub.approve(offer!.version, offer!.digest);
  };
  const done = (progress: { steps: { done: boolean }[] }) =>
    progress.steps.filter((s) => s.done).length;

  it('shows its version, key and manifest digest, and runs nothing until approved', async () => {
    const stub = env.SETUP.get(env.SETUP.idFromName('shown-release'));
    const begun = await stub.begin(TOKEN, readAnswers(details) as Answers);
    expect(done(begun)).toBe(0);
    expect(begun.approved).toBe(false);
    expect(begun.release).toBeNull();
    expect(begun.offer).toMatchObject({
      version: '0.1.0',
      keyId: await keyIdOf(TEST_PUBLIC_KEY),
      // No project key is published yet, and the page says so.
      projectKey: false,
    });
    expect(begun.offer?.digest).toMatch(/^[0-9a-f]{64}$/);

    // Asking for a step without an approval changes nothing on the account.
    const actions = world.actions.length;
    const waiting = await stub.runNext();
    expect(done(waiting)).toBe(0);
    expect(waiting.approved).toBe(false);
    expect(world.actions).toHaveLength(actions);
    await runInDurableObject(stub, async (_run, state) => {
      expect(await state.storage.get('release')).toBeUndefined();
    });

    // An approval of anything but what was shown is refused.
    const wrong = await stub.approve('0.1.0', 'f'.repeat(64));
    expect(wrong).toMatchObject({ refused: expect.stringMatching(/changed/) });
    expect(done(await stub.runNext())).toBe(0);
    expect(world.actions).toHaveLength(actions);

    const approved = await approve(stub);
    expect(approved).toMatchObject({ approved: true, release: '0.1.0' });
    expect(done(await stub.runNext())).toBe(1);
    // The page draws the offer from begin's answer and waits for the person.
    expect(PAGE_HTML).toContain('id="approve-form"');
    expect(APP_JS).toContain("$('offer-key').textContent = offer.keyId");
    expect(APP_JS).toContain("api('POST', '/api/approve'");
    expect(APP_JS).toMatch(/function running\(progress\)[\s\S]*progress\.approved/);
  });

  it('needs the setup password to approve, and names what it refuses', async () => {
    expect((await call('/api/approve', { version: '0.1.0', digest: 'x' })).status).toBe(401);
    await logIn();
    expect((await call('/api/approve', {})).status).toBe(400);
  });

  it('does not carry an approval over to another release', async () => {
    const stub = env.SETUP.get(env.SETUP.idFromName('approval-is-exact'));
    await withMinimum(stub, '0.0.1');
    const first = await stub.begin(TOKEN, readAnswers(details) as Answers);
    const shown = first.offer!;
    // RELEASE_URL changes what it serves before the person approves.
    const original = served;
    served = (await makeRelease({ version: '0.1.1', code: 'export default {}; // B' })).contents;
    const refreshed = await stub.runNext();
    expect(refreshed.offer?.version).toBe('0.1.1');
    expect(await stub.approve(shown.version, shown.digest)).toMatchObject({
      refused: expect.stringMatching(/changed/),
    });
    expect(done(await stub.runNext())).toBe(0);

    // Approved 0.1.1; then RELEASE_URL goes back to serving 0.1.0, which is refused.
    await approve(stub);
    served = original;
    const refused = await stub.runNext();
    expect(done(refused)).toBe(0);
    expect(refused.failed?.message).toMatch(/different release/);
  });

  it('refuses a release older than RELEASE_MIN_VERSION, at the first step too', async () => {
    const stub = env.SETUP.get(env.SETUP.idFromName('first-open-old'));
    await withMinimum(stub, '0.1.0');
    const original = served;
    served = (await makeRelease({ version: '0.0.1' })).contents;
    const begun = await stub.begin(TOKEN, readAnswers(details) as Answers);
    expect(begun.offer).toBeNull();
    expect(begun.failed?.message).toMatch(/older than 0\.1\.0/);
    const refused = await stub.runNext();
    expect(done(refused)).toBe(0);
    expect(refused.offer).toBeNull();
    expect(refused.failed?.message).toMatch(/older than 0\.1\.0/);

    served = original;
    const offered = await stub.runNext();
    expect(offered.failed).toBeNull();
    expect(offered.offer?.version).toBe('0.1.0');
    expect(done(offered)).toBe(0);
    await approve(stub);
    const resumed = await stub.runNext();
    expect(resumed.release).toBe('0.1.0');
    expect(done(resumed)).toBe(1);
  });

  it('opens no release at all without RELEASE_MIN_VERSION, unless told to take any', async () => {
    const stub = env.SETUP.get(env.SETUP.idFromName('first-open-any'));
    // Empty, as wrangler.jsonc has it.
    await withMinimum(stub, '');
    const original = served;
    served = (await makeRelease({ version: '0.0.1' })).contents;
    const actions = world.actions.length;
    const begun = await stub.begin(TOKEN, readAnswers(details) as Answers);
    expect(begun.failed?.message).toMatch(/RELEASE_MIN_VERSION is not set/);
    expect(begun.offer).toBeNull();
    const first = await stub.runNext();
    expect(first.offer).toBeNull();
    expect(first.release).toBeNull();
    expect(done(first)).toBe(0);
    expect(world.actions).toHaveLength(actions);

    // The explicit override behaves as configured: the release is offered, still for approval.
    await configure(stub, { RELEASE_ACCEPT_ANY_VERSION: 'true' });
    const offered = await stub.runNext();
    served = original;
    expect(offered.failed).toBeNull();
    expect(offered.offer?.version).toBe('0.0.1');
    expect(offered.approved).toBe(false);
  });

  it('stays the one approved, whatever RELEASE_URL serves later', async () => {
    const stub = env.SETUP.get(env.SETUP.idFromName('pinned-release'));
    await stub.begin(TOKEN, readAnswers(details) as Answers);
    await approve(stub);
    const first = await stub.runNext();
    expect(first.failed).toBeNull();
    expect(done(first)).toBe(1);

    // Also validly signed and above the floor, with other Worker code and no migrations.
    const original = served;
    served = (
      await makeRelease({ version: '0.2.0', code: 'export default {}; // B', migrations: false })
    ).contents;
    const refused = await stub.runNext();
    expect(done(refused)).toBe(1);
    expect(refused.failed?.message).toMatch(/different release/);
    // Retrying doesn't get past it either.
    expect((await stub.runNext()).failed?.message).toMatch(/different release/);

    served = original;
    const resumed = await stub.runNext();
    expect(resumed.failed).toBeNull();
    expect(done(resumed)).toBe(2);
  });

  it('shows a substituted key as a different key, and refuses a malformed one', async () => {
    const regular = env.SETUP.get(env.SETUP.idFromName('regular-key'));
    const theirs = env.SETUP.get(env.SETUP.idFromName('substituted-key'));
    const other = await otherKey();
    const original = served;
    const actions = world.actions.length;
    const mine = (await regular.begin(TOKEN, readAnswers(details) as Answers)).offer;
    // An attacker's pair: their own key, with a release they signed with it.
    await configure(theirs, { RELEASE_PUBLIC_KEY: other.publicKeyPem });
    served = (await makeRelease({ signer: other })).contents;
    const substituted = (await theirs.begin(TOKEN, readAnswers(details) as Answers)).offer;
    served = original;
    expect(substituted?.version).toBe(mine?.version);
    expect(substituted?.keyId).toBe(await keyIdOf(other.publicKeyPem));
    expect(substituted?.keyId).not.toBe(mine?.keyId);
    expect(substituted?.projectKey).toBe(false);
    expect(world.actions).toHaveLength(actions);

    const broken = env.SETUP.get(env.SETUP.idFromName('malformed-key'));
    await configure(broken, { RELEASE_PUBLIC_KEY: 'not a key' });
    const refused = await broken.begin(TOKEN, readAnswers(details) as Answers);
    expect(refused.offer).toBeNull();
    expect(refused.failed?.message).toMatch(/signature check/);
  });

  it('refuses a withdrawn key, installs from its replacement, and moves a pinned install over', async () => {
    const first = env.SETUP.get(env.SETUP.idFromName('withdrawn-new'));
    const regularKeyId = await keyIdOf(TEST_PUBLIC_KEY);
    await configure(first, { RELEASE_WITHDRAWN: `0.0.9, ${regularKeyId}` });
    const actions = world.actions.length;
    const refused = await first.begin(TOKEN, readAnswers(details) as Answers);
    expect(refused.offer).toBeNull();
    expect(refused.failed?.message).toMatch(/withdrawn/);
    expect(done(await first.runNext())).toBe(0);
    expect(world.actions).toHaveLength(actions);

    // The replacement key, with a release signed by it, installs.
    const replacement = await otherKey();
    const original = served;
    served = (await makeRelease({ version: '0.1.1', signer: replacement })).contents;
    await configure(first, { RELEASE_PUBLIC_KEY: replacement.publicKeyPem });
    expect((await first.runNext()).offer?.keyId).toBe(await keyIdOf(replacement.publicKeyPem));
    await approve(first);
    expect(done(await first.runNext())).toBe(1);

    // An install already part way through on a release that is then withdrawn.
    served = original;
    const pinned = env.SETUP.get(env.SETUP.idFromName('withdrawn-pinned'));
    await configure(pinned, { RELEASE_PUBLIC_KEY: TEST_PUBLIC_KEY, RELEASE_WITHDRAWN: '' });
    await pinned.begin(TOKEN, readAnswers(details) as Answers);
    await approve(pinned);
    for (let i = 0; i < 9; i++) await pinned.runNext();
    const before = await pinned.progress();
    expect(before.steps.find((s) => s.id === 'migrations')?.done).toBe(true);
    await configure(pinned, { RELEASE_WITHDRAWN: '0.1.0' });
    const stopped = await pinned.runNext();
    expect(stopped.failed?.message).toMatch(/withdrawn/);
    expect(stopped.withdrawn).toBe(true);
    expect(done(stopped)).toBe(done(before));

    served = (await makeRelease({ version: '0.1.2', code: 'export default {}; // fixed' }))
      .contents;
    await configure(pinned, { RELEASE_MIN_VERSION: '0.1.2' });
    const moved = await pinned.replaceRelease();
    expect(moved.approved).toBe(false);
    expect(moved.offer?.version).toBe('0.1.2');
    // The database and the Workers run again from the replacement; nothing from 0.1.0 stays.
    expect(moved.steps.find((s) => s.id === 'migrations')?.done).toBe(false);
    expect(moved.steps.filter((s) => s.id.startsWith('deploy-') && s.done)).toHaveLength(0);
    expect(moved.steps.find((s) => s.id === 'account')?.done).toBe(true);
    await approve(pinned);
    const resumed = await pinned.runNext();
    served = original;
    expect(resumed.failed).toBeNull();
    expect(resumed.release).toBe('0.1.2');
    expect(resumed.steps.find((s) => s.id === 'migrations')?.done).toBe(true);
  });
});

describe('guessing the password', () => {
  it('locks out the address that guessed, not the person setting up', async () => {
    const from = (ip: string, password: string) =>
      call('/api/login', { password }, { 'cf-connecting-ip': ip });
    for (let i = 0; i < 5; i++) {
      expect((await from('203.0.113.7', 'wrong-password-here')).status).toBe(401);
    }
    expect((await from('203.0.113.7', PASSWORD)).status).toBe(429);
    expect((await from('198.51.100.20', PASSWORD)).status).toBe(200);
  });

  it('holds back many addresses guessing together, but still lets the person setting up in', async () => {
    const stub = env.SETUP.get(env.SETUP.idFromName('lock-ceiling'));
    // Each address stays under its own limit of five.
    for (let i = 0; i < 50; i++)
      expect(await stub.attempt(false, `192.0.2.${i % 25}`)).toBe('wrong');
    // Every address that guessed now waits, even with the right password.
    expect(await stub.attempt(true, '192.0.2.3')).toBe('locked');
    // The person setting up, who hasn't guessed wrong, gets in.
    expect(await stub.attempt(true, '198.51.100.20')).toBe('ok');
    // A new address gets one guess, not five, while the ceiling holds.
    expect(await stub.attempt(false, '198.51.100.30')).toBe('wrong');
    expect(await stub.attempt(true, '198.51.100.30')).toBe('locked');
  });

  /** Old tallies, as many addresses that guessed once and then went away leave behind. */
  const leaveOldTallies = (stub: DurableObjectStub<SetupRun>, count: number) =>
    runInDurableObject(stub, async (_run, state) => {
      const old = { count: 1, since: Date.now() - 2 * 3600_000, until: 0 };
      for (let from = 0; from < count; from += 100) {
        const batch: Record<string, unknown> = {};
        for (let i = from; i < Math.min(count, from + 100); i++) {
          batch[`attempts:2001:db8:${i.toString(16)}:0::/64`] = old;
        }
        await state.storage.put(batch);
      }
    });

  /** Makes the object's storage refuse some deletes, as Cloudflare may refuse one. */
  const refuseDeletes = (stub: DurableObjectStub<SetupRun>, refuse: (keys: string[]) => boolean) =>
    runInDurableObject(stub, (_run, state) => {
      const real = state.storage.delete.bind(state.storage);
      state.storage.delete = ((keys: string | string[]) =>
        Array.isArray(keys) && refuse(keys)
          ? Promise.reject(new RangeError('Maximum number of keys is 128'))
          : real(keys as string)) as typeof state.storage.delete;
    });

  const tallies = (stub: DurableObjectStub<SetupRun>) =>
    runInDurableObject(
      stub,
      async (_run, state) => (await state.storage.list({ prefix: 'attempts:' })).size,
    );

  /** Moves every tally back in time, as if `ms` had passed. */
  const later = (stub: DurableObjectStub<SetupRun>, ms: number) =>
    runInDurableObject(stub, async (_run, state) => {
      const all = await state.storage.list<{ count: number; since: number; until: number }>({
        prefix: 'attempts',
      });
      const moved: Record<string, unknown> = {};
      for (const [key, tally] of all) {
        moved[key] = { ...tally, since: tally.since - ms, until: tally.until && tally.until - ms };
      }
      for (let i = 0; i < Object.keys(moved).length; i += 100) {
        await state.storage.put(Object.fromEntries(Object.entries(moved).slice(i, i + 100)));
      }
    });

  it('caps what all new addresses together may guess while the total holds', async () => {
    const stub = env.SETUP.get(env.SETUP.idFromName('lock-ceiling-cap'));
    for (let i = 0; i < 50; i++)
      expect(await stub.attempt(false, `192.0.2.${i % 25}`)).toBe('wrong');
    // Each new /48 gets one guess, but only until 50 more have been made in all.
    const verdicts = [];
    for (let i = 0; i < 200; i++)
      verdicts.push(await stub.attempt(false, `2001:db8:${i.toString(16)}::1`));
    expect(verdicts.filter((v) => v === 'wrong')).toHaveLength(50);
    expect(verdicts.slice(50).every((v) => v === 'locked')).toBe(true);
    // So the tallies kept stay few, however many addresses guess.
    expect(await tallies(stub)).toBe(75);
    // That shuts the person setting up out too, but only until the window is over.
    expect(await stub.attempt(true, '198.51.100.20')).toBe('locked');
    await later(stub, 16 * 60 * 1000);
    expect(await stub.attempt(true, '198.51.100.20')).toBe('ok');
  });

  it('lets the person setting up in during the total, until the cap', async () => {
    const stub = env.SETUP.get(env.SETUP.idFromName('lock-ceiling-operator'));
    for (let i = 0; i < 50; i++)
      expect(await stub.attempt(false, `192.0.2.${i % 25}`)).toBe('wrong');
    for (let i = 0; i < 49; i++)
      expect(await stub.attempt(false, `2001:db8:${i.toString(16)}::1`)).toBe('wrong');
    expect(await stub.attempt(true, '198.51.100.20')).toBe('ok');
  });

  it('lets the person setting up in while the total holds, whatever one /48 or /24 guesses', async () => {
    const stub = env.SETUP.get(env.SETUP.idFromName('lock-ceiling-one-block'));
    // Raises the total from ten /64s of one /48, five guesses each.
    for (let i = 0; i < 50; i++)
      expect(await stub.attempt(false, `2001:db8:1:${Math.floor(i / 5)}::1`)).toBe('wrong');
    // Then one guess from each of many more /64s and addresses in that /48 and one /24.
    const verdicts = [];
    for (let i = 0; i < 200; i++) {
      verdicts.push(await stub.attempt(false, `2001:db8:1:${(100 + i).toString(16)}::1`));
      verdicts.push(await stub.attempt(false, `203.0.113.${i}`));
    }
    // Each wide block gets one guess while the total holds, so they can't use up the cap.
    expect(verdicts.filter((v) => v === 'wrong')).toHaveLength(2);
    expect(await stub.attempt(true, '2001:db8:2::5')).toBe('ok');
    expect(await stub.attempt(true, '198.51.100.20')).toBe('ok');
  });

  it('clears old tallies 128 at a time, as Cloudflare allows, and still counts the guess', async () => {
    const stub = env.SETUP.get(env.SETUP.idFromName('lock-cleanup-many'));
    await leaveOldTallies(stub, 300);
    await refuseDeletes(stub, (keys) => keys.length > 128);
    for (let i = 0; i < 5; i++) expect(await stub.attempt(false, '198.51.100.40')).toBe('wrong');
    expect(await stub.attempt(true, '198.51.100.40')).toBe('locked');
    // Only the tally of the address guessing now is left.
    expect(await tallies(stub)).toBe(1);
  });

  it('counts every wrong guess even when clearing old tallies fails', async () => {
    const stub = env.SETUP.get(env.SETUP.idFromName('lock-cleanup-fails'));
    await leaveOldTallies(stub, 10);
    await refuseDeletes(stub, () => true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 5; i++) expect(await stub.attempt(false, '198.51.100.41')).toBe('wrong');
    expect(await stub.attempt(true, '198.51.100.41')).toBe('locked');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('counts an IPv6 address by its /64, since one machine can have any number of them', async () => {
    const stub = env.SETUP.get(env.SETUP.idFromName('lock-ipv6'));
    for (let i = 1; i <= 5; i++)
      expect(await stub.attempt(false, `2001:db8:1:2::${i}`)).toBe('wrong');
    expect(await stub.attempt(true, '2001:db8:1:2:abcd::1')).toBe('locked');
    expect(await stub.attempt(true, '2001:0db8:0001:0002:0000:0000:0000:0099')).toBe('locked');
    expect(await stub.attempt(true, '2001:db8:1:3::1')).toBe('ok');
  });

  it('locks after five wrong passwords, even for the right one', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await call('/api/login', { password: 'wrong-password-here' })).status).toBe(401);
    }
    expect((await call('/api/login', { password: 'wrong-password-here' })).status).toBe(429);
    expect((await call('/api/login', { password: PASSWORD })).status).toBe(429);
  });
});

describe('how long the setup page keeps secrets', () => {
  const own = (name: string) => env.SETUP.get(env.SETUP.idFromName(`lifetime-${name}`));
  const answers = () => readAnswers(details) as Answers;

  it('forgets the token, the answers and the keys of an install left alone too long', async () => {
    const stub = own('idle');
    await stub.begin(TOKEN, answers());
    await runInDurableObject(stub, async (instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBeGreaterThan(Date.now() + SECRETS_IDLE_MS - 60_000);
      await state.storage.put('secrets', {
        version: 1,
        keys: { FIELD_KEYS: 'generated-field-key' },
      });
      // Not yet: a ring before the bound leaves the install alone.
      await instance.alarm();
      expect(await state.storage.get('token')).toBe(TOKEN);
      await state.storage.put('touched', Date.now() - SECRETS_IDLE_MS - 1);
      await instance.alarm();
      for (const key of ['token', 'answers', 'secrets']) {
        expect(await state.storage.get(key), key).toBeUndefined();
      }
      const everything = JSON.stringify([...(await state.storage.list()).entries()]);
      expect(everything).not.toContain(TOKEN);
      expect(everything).not.toContain(KEY);
      expect(everything).not.toContain('generated-field-key');
      // No step had run, so it can start again from the answers.
      expect((await instance.progress()).phase).toBe('answers');
    });
  });

  it('stays expired, with nothing to run, when steps had already run', async () => {
    const stub = own('expired');
    await stub.begin(TOKEN, answers());
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put('done', ['account']);
      await state.storage.put('report', { unhealthy: [], signInLink: 'https://app.example.com/x' });
      await state.storage.put('touched', Date.now() - SECRETS_IDLE_MS - 1);
      await instance.alarm();
      const progress = await instance.progress();
      expect(progress.phase).toBe('expired');
      expect(progress.signInLink).toBeNull();
      expect(await state.storage.get('token')).toBeUndefined();
      const done = world.actions.length;
      expect((await instance.runNext()).phase).toBe('expired');
      expect(world.actions).toHaveLength(done);
      // And it can't be begun again over what it made.
      await instance.begin('another-token-value', answers());
      expect(await state.storage.get('token')).toBeUndefined();
    });
  });

  it('won’t begin again over a running install', async () => {
    const stub = own('twice');
    await stub.begin(TOKEN, answers());
    await stub.begin('someone-elses-token', { ...answers(), zone: 'evil.example' });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get('token')).toBe(TOKEN);
      expect((await state.storage.get<Answers>('answers'))?.zone).toBe('example.com');
    });
  });

  it('hands the recovery kit over a limited number of times', async () => {
    const stub = own('kit');
    await stub.begin(TOKEN, answers());
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put('phase', 'save-kit');
      for (let i = 0; i < MAX_KIT_DOWNLOADS; i++)
        expect(await instance.recoveryKit('a long kit passphrase')).not.toBeNull();
      expect(await instance.recoveryKit('a long kit passphrase')).toBeNull();
      expect((await instance.progress()).kitDownloadsLeft).toBe(0);
    });
  });

  it('gives the sign-in link once, at the finish, and keeps no log or failure', async () => {
    const stub = own('link');
    await stub.begin(TOKEN, answers());
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put({
        phase: 'save-kit',
        report: { unhealthy: [], signInLink: 'https://app.example.com/sign-in' },
        log: ['a step'],
        failed: { step: 'x', message: 'y' },
      });
      expect((await instance.finish()).signInLink).toBe('https://app.example.com/sign-in');
      const after = await instance.progress();
      expect(after.signInLink).toBeNull();
      expect(after.log).toEqual([]);
      expect(after.failed).toBeNull();
    });
  });

  it('hides the mail key and generated keys from a step’s error, whatever it quotes', async () => {
    const stub = own('scrub');
    await stub.begin(TOKEN, answers());
    // Steps run only after the person approves the release on offer.
    const { offer } = await stub.progress();
    expect(offer).toBeTruthy();
    await stub.approve(offer!.version, offer!.digest);
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put('secrets', {
        version: 1,
        keys: { FIELD_KEYS: 'generated-field-key' },
      });
      world.http = async () => ({
        status: 500,
        text: `{"success":false,"errors":[{"message":"bad ${KEY} and generated-field-key"}]}`,
      });
      const failed = await instance.runNext();
      expect(failed.failed?.message).toContain('[hidden]');
      const everything = JSON.stringify(
        [...(await state.storage.list()).entries()].filter(([k]) => k === 'failed' || k === 'log'),
      );
      expect(everything).not.toContain(KEY);
      expect(everything).not.toContain('generated-field-key');
    });
    expect(
      secretValues({
        answers: {
          mail: {
            provider: 'smtp',
            smtp: {
              host: 'smtp.example.com',
              port: '587',
              username: 'mailer-user',
              password: 'smtp-pass-123',
              dkimSelector: 's1',
            },
          },
        } as unknown as Answers,
      }),
    ).toEqual(['smtp-pass-123', 'mailer-user']);
  });

  it('ends every setup session without changing the password', async () => {
    // From an address of its own: the guessing tests above locked out the default one.
    const signIn = async () => {
      const res = await call(
        '/api/login',
        { password: PASSWORD },
        { 'cf-connecting-ip': '198.51.100.77' },
      );
      expect(res.status).toBe(200);
      return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
    };
    cookie = await signIn();
    const other = cookie;
    expect((await call('/api/status')).status).toBe(200);
    const ended = await call('/api/sessions/end', {});
    expect(ended.status).toBe(200);
    cookie = other;
    expect((await call('/api/status')).status).toBe(401);
    cookie = await signIn();
    expect((await call('/api/status')).status).toBe(200);
  });
});
