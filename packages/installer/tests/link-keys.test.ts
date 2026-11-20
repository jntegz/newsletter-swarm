// The move from MEMBER_KEYS to per-family link keys, through `pnpm swarm update` in the fake
// world: new keyrings for an install from before, the two-pass deploy (every verifier before any
// signer switches), MEMBER_KEYS kept per worker for its window and then removed, and rotate-keys
// on an Ed25519 keyring. This code can't sign v2 yet (B2), so the tests say it can.
import { parseKeyring, publicKeyring } from '@swarm/tokens';
import type * as Tokens from '@swarm/tokens';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/cli';
import { doctor, linkKeysFinding } from '../src/commands/doctor';
import { rotateKeys, retireKeys } from '../src/commands/rotate-keys';
import { update } from '../src/commands/update';
import { FakeTransport } from '../src/fake';
import { KEYRING_NAMES, LINK_WORKERS, newKeyring } from '../src/keys';
import { DEPLOY_ORDER, scriptName, type Worker } from '../src/paths';
import { MemoryStateStore } from '../src/state';
import { INSTALL_STEPS, runSteps } from '../src/steps';
import type { HttpRequest } from '../src/transport';
import { fakeRun } from './helpers';

vi.mock('@swarm/tokens', async (original) => ({
  ...(await original<typeof Tokens>()),
  LINK_V2_SIGNING_READY: true,
}));

const DAY = 86_400_000;
const NOW = Date.parse('2027-01-15T12:00:00Z');
const OLD_KEYRINGS = [
  'AUTH_KEYS',
  'TRACK_KEYS',
  'UNSUBSCRIBE_KEYS',
  'FIELD_KEYS',
  'MEMBER_KEYS',
  'READER_KEYS',
];
/** What each worker held before per-family keys (the matrix this change replaces). */
const OLD_MATRIX: Record<Worker, string[]> = {
  api: [
    'AUTH_KEYS',
    'TRACK_KEYS',
    'UNSUBSCRIBE_KEYS',
    'FIELD_KEYS',
    'MEMBER_KEYS',
    'TURNSTILE_SECRET_KEY',
  ],
  send: ['TRACK_KEYS', 'UNSUBSCRIBE_KEYS', 'MEMBER_KEYS'],
  jobs: ['FIELD_KEYS', 'MEMBER_KEYS'],
  capture: ['FIELD_KEYS', 'MEMBER_KEYS', 'TURNSTILE_SECRET_KEY'],
  site: ['READER_KEYS', 'MEMBER_KEYS', 'FIELD_KEYS', 'TURNSTILE_SECRET_KEY'],
  track: ['TRACK_KEYS', 'UNSUBSCRIBE_KEYS'],
  events: ['UNSUBSCRIBE_KEYS'],
  realtime: [],
  vault: [],
};

const deploys = (actions: string[]) =>
  actions
    .filter((a) => a.startsWith('wrangler deploy'))
    .map((a) => /workers\/(\w+)\/wrangler/.exec(a)?.[1]);

/** An install made before per-family keys: the old keyrings, the old secrets on each script. */
async function oldInstall() {
  const store = new MemoryStateStore();
  const transport = new FakeTransport({ zone: 'example.com' });
  vi.setSystemTime(NOW - 30 * DAY);
  await runSteps((await fakeRun({ store, transport })).ctx, INSTALL_STEPS);
  const { state, secrets } = await store.load('production');
  if (!state || !secrets) throw new Error('no install');
  delete state.linkKeys;
  for (const name of Object.keys(secrets.keys)) {
    if (!OLD_KEYRINGS.includes(name)) delete secrets.keys[name];
  }
  secrets.keys.MEMBER_KEYS = newKeyring(new Date(NOW - 30 * DAY));
  await store.save(state);
  await store.saveSecrets('production', secrets);
  for (const worker of DEPLOY_ORDER) {
    const mail = ['api', 'send', 'jobs', 'capture', 'site'].includes(worker)
      ? ['RESEND_API_KEY']
      : [];
    transport.secrets.set(scriptName(worker, 'production'), [...OLD_MATRIX[worker], ...mail]);
  }
  vi.setSystemTime(NOW);
  return { store, transport };
}

async function runUpdate(
  world: { store: MemoryStateStore; transport: FakeTransport },
  argv: string[] = [],
) {
  const output: string[] = [];
  const before = world.transport.actions.length;
  const { ctx } = await fakeRun({
    argv: ['update', '--dry-run', '--skip-pull', ...argv],
    store: world.store,
    transport: world.transport,
    answers: {},
    output,
  });
  await update(ctx);
  return { ctx, output: output.join(''), actions: world.transport.actions.slice(before) };
}

const held = (transport: FakeTransport, worker: Worker) =>
  transport.secrets.get(scriptName(worker, 'production')) ?? [];

describe('updating an install from before per-family link keys', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds the new keyrings, deploys every worker, then switches the signers', async () => {
    const world = await oldInstall();
    const kept = { ...(await world.store.load('production')).secrets?.keys };
    const { ctx, output, actions } = await runUpdate(world);

    // The old keyrings stay as they were; every new one is made.
    for (const name of OLD_KEYRINGS) expect(ctx.secrets.keys[name]).toBe(kept[name]);
    expect(Object.keys(ctx.secrets.keys).sort()).toEqual([...KEYRING_NAMES].sort());

    // Pass one deploys every worker, pass two only those whose links change, after all of them.
    const order = deploys(actions);
    expect(order).toEqual([...DEPLOY_ORDER, ...LINK_WORKERS]);
    expect(LINK_WORKERS).toEqual(['vault', 'events', 'site', 'capture', 'send', 'jobs', 'api']);
    const firstPassEnd = actions.findIndex((a) => /^wrangler deploy .*workers\/api\//.test(a));
    const secondRender = actions.findIndex(
      (a, i) => i > firstPassEnd && a.startsWith('write workers/api/wrangler.production'),
    );
    expect(secondRender).toBeGreaterThan(firstPassEnd);

    const linkKeys = ctx.state.linkKeys;
    expect(linkKeys?.mode).toBe('v2');
    expect(linkKeys?.cutoffAt).toBe(NOW);
    expect(linkKeys?.legacyUntil).toEqual({
      vault: NOW + 30 * DAY,
      api: NOW + 30 * DAY,
      capture: NOW + 90 * DAY,
      site: NOW + 90 * DAY,
    });
    const api = [...world.transport.files].find(([f]) =>
      f.endsWith('workers/api/wrangler.production.generated.jsonc'),
    )?.[1];
    expect(api).toContain('"LINK_SIGNING_MODE": "v2"');
    expect(api).toContain(`"LINK_LEGACY_CUTOFF": "${NOW}"`);

    // Each worker has its own keyrings; send and jobs, which only signed, lose MEMBER_KEYS now.
    expect(held(world.transport, 'send')).not.toContain('MEMBER_KEYS');
    expect(held(world.transport, 'jobs')).not.toContain('MEMBER_KEYS');
    for (const worker of ['api', 'capture', 'site'] as const)
      expect(held(world.transport, worker)).toContain('MEMBER_KEYS');
    expect(held(world.transport, 'capture')).toEqual(
      expect.arrayContaining(['MEMBER_VERIFY_KEYS', 'ASK_VERIFY_KEYS', 'CAPTURE_KEYS']),
    );
    expect(held(world.transport, 'site')).toEqual(
      expect.arrayContaining([
        'GOODS_VERIFY_KEYS',
        'SITE_LINK_VERIFY_KEYS',
        'CHECKOUT_SIGNING_KEYS',
      ]),
    );
    expect(held(world.transport, 'events').filter((n) => n.endsWith('_KEYS'))).toEqual([
      'UNSUBSCRIBE_KEYS',
      'BOUNCE_KEYS',
    ]);
    expect(
      actions.some((a) => /^DELETE \S+\/scripts\/swarm-send\/secrets\/MEMBER_KEYS$/.test(a)),
    ).toBe(true);
    expect(output).toContain('Back up .swarm/ again');
    expect(output).toContain('MEMBER_SIGNING_KEYS');
  });

  it('stops after the first pass with --link-keys=verify-only, and finishes on the next update', async () => {
    const world = await oldInstall();
    const held1 = await runUpdate(world, ['--link-keys=verify-only']);
    expect(deploys(held1.actions)).toEqual([...DEPLOY_ORDER]);
    expect(held1.ctx.state.linkKeys).toEqual({ mode: 'verify-v2' });
    expect(held(world.transport, 'send')).toContain('MEMBER_KEYS');
    expect(held(world.transport, 'send')).toContain('MEMBER_SIGNING_KEYS');

    const later = await runUpdate(world);
    expect(deploys(later.actions)).toEqual([...DEPLOY_ORDER, ...LINK_WORKERS]);
    expect(later.ctx.state.linkKeys?.mode).toBe('v2');
  });

  it('keeps signing the old way while a worker does not answer after the first pass', async () => {
    const world = await oldInstall();
    const http = world.transport.http.bind(world.transport);
    world.transport.http = async (request: HttpRequest) =>
      request.url === 'https://forms.example.com/healthz'
        ? { status: 503, text: '' }
        : http(request);
    const { ctx, actions, output } = await runUpdate(world);
    expect(deploys(actions)).toEqual([...DEPLOY_ORDER]);
    expect(ctx.state.linkKeys).toEqual({ mode: 'verify-v2' });
    expect(held(world.transport, 'send')).toContain('MEMBER_KEYS');
    expect(output).toContain('Links stay signed the old way for now: forms.example.com');
  });

  it('removes MEMBER_KEYS from each worker once its window has passed, then forgets it', async () => {
    const world = await oldInstall();
    await runUpdate(world);

    vi.setSystemTime(NOW + 31 * DAY);
    const doctorOutput: string[] = [];
    const doctorRun = await fakeRun({
      argv: ['doctor', '--dry-run'],
      store: world.store,
      transport: world.transport,
      output: doctorOutput,
    });
    expect(await doctor(doctorRun.ctx)).toBe(false);
    expect(doctorOutput.join('')).toMatch(
      /Secrets of swarm-api.*still holds MEMBER_KEYS, which it no longer needs/,
    );

    const month = await runUpdate(world);
    expect(held(world.transport, 'api')).not.toContain('MEMBER_KEYS');
    expect(held(world.transport, 'capture')).toContain('MEMBER_KEYS');
    expect(month.ctx.secrets.keys.MEMBER_KEYS).toBeTruthy();
    // Nothing to switch twice.
    expect(deploys(month.actions)).toEqual([...DEPLOY_ORDER]);

    vi.setSystemTime(NOW + 90 * DAY);
    const done = await runUpdate(world);
    for (const worker of DEPLOY_ORDER)
      expect(held(world.transport, worker)).not.toContain('MEMBER_KEYS');
    expect(done.ctx.secrets.keys.MEMBER_KEYS).toBeUndefined();
    expect((await world.store.load('production')).secrets?.keys.MEMBER_KEYS).toBeUndefined();
    expect(done.output).toContain('MEMBER_KEYS (retired)');
    expect(linkKeysFinding(done.ctx.state.linkKeys, Date.now()).detail).toContain('retired');
  });

  it('removes only keyrings the registry manages, from the scripts that should not hold them', async () => {
    const world = await oldInstall();
    await runUpdate(world);
    world.transport.secrets.set('swarm-track', [
      ...held(world.transport, 'track'),
      'FIELD_KEYS',
      'MEMBER_SIGNING_KEYS',
      'SOMETHING_ELSE',
    ]);
    const { actions } = await runUpdate(world);
    expect(held(world.transport, 'track').sort()).toEqual(
      ['SOMETHING_ELSE', 'TRACK_KEYS', 'UNSUBSCRIBE_KEYS'].sort(),
    );
    const deletes = actions.filter((a) => a.startsWith('DELETE ') && a.includes('/secrets/'));
    expect(deletes.map((a) => a.split('/scripts/')[1])).toEqual([
      'swarm-track/secrets/FIELD_KEYS',
      'swarm-track/secrets/MEMBER_SIGNING_KEYS',
    ]);
  });
});

describe('a new install when the code signs v2 links', () => {
  it('starts on them, with no MEMBER_KEYS anywhere, in one pass', async () => {
    const { ctx, transport } = await fakeRun({});
    await runSteps(ctx, INSTALL_STEPS);
    expect(ctx.state.linkKeys?.mode).toBe('v2');
    expect(ctx.state.linkKeys?.legacyUntil).toEqual({});
    expect(ctx.secrets.keys.MEMBER_KEYS).toBeUndefined();
    for (const worker of DEPLOY_ORDER) expect(held(transport, worker)).not.toContain('MEMBER_KEYS');
    expect(deploys(transport.actions).slice(0, DEPLOY_ORDER.length)).toEqual([...DEPLOY_ORDER]);
    // Only the Resend webhook's redeploy of events follows, no second pass.
    expect(deploys(transport.actions).slice(DEPLOY_ORDER.length)).toEqual(['events']);
  });
});

describe('rotating an Ed25519 keyring', () => {
  beforeEach(() => {
    process.env.SWARM_KIT_PASSPHRASE = 'test-only kit passphrase';
  });
  afterEach(() => {
    delete process.env.SWARM_KIT_PASSPHRASE;
  });

  it('gives the verifiers the new public key before the signers sign with it', async () => {
    const store = new MemoryStateStore();
    const transport = new FakeTransport({ zone: 'example.com' });
    await runSteps((await fakeRun({ store, transport })).ctx, INSTALL_STEPS);
    const pushed: { script: string; name: string; text: string }[] = [];
    const http = transport.http.bind(transport);
    transport.http = async (request: HttpRequest) => {
      const secret = /\/workers\/scripts\/([^/]+)\/secrets$/.exec(request.url);
      if (secret && request.method === 'PUT') {
        const body = JSON.parse(request.body ?? '{}') as { name: string; text: string };
        pushed.push({ script: secret[1] as string, name: body.name, text: body.text });
      }
      return http(request);
    };
    const { ctx } = await fakeRun({
      argv: ['rotate-keys', 'MEMBER_SIGNING_KEYS', '--dry-run'],
      store,
      transport,
    });
    await rotateKeys(ctx, 'MEMBER_SIGNING_KEYS', { now: NOW });
    const ring = ctx.secrets.keys.MEMBER_SIGNING_KEYS as string;
    expect(parseKeyring(ring).current).toBe('k20270115');
    const publicText = await publicKeyring('MEMBER_SIGNING_KEYS', ring);

    // The vault and capture verify; the vault, send and jobs sign.
    expect(pushed.map((p) => `${p.script} ${p.name}`)).toEqual([
      'swarm-vault MEMBER_VERIFY_KEYS',
      'swarm-capture MEMBER_VERIFY_KEYS',
      'swarm-vault MEMBER_SIGNING_KEYS',
      'swarm-send MEMBER_SIGNING_KEYS',
      'swarm-jobs MEMBER_SIGNING_KEYS',
      'swarm-vault MEMBER_SIGNING_KEYS',
      'swarm-send MEMBER_SIGNING_KEYS',
      'swarm-jobs MEMBER_SIGNING_KEYS',
    ]);
    expect(pushed[0]?.text).toBe(
      await publicKeyring('MEMBER_SIGNING_KEYS', pushed[2]?.text as string),
    );
    expect(pushed[0]?.text.split(',').sort()).toEqual(publicText.split(',').sort());
    // Phase one: the new key is there but not current; phase two: it signs.
    expect(parseKeyring(pushed[2]?.text as string).current).not.toBe('k20270115');
    expect(parseKeyring(pushed[7]?.text as string).current).toBe('k20270115');

    pushed.length = 0;
    const retire = await fakeRun({
      argv: ['rotate-keys', 'MEMBER_SIGNING_KEYS', '--retire', '--dry-run'],
      store,
      transport,
    });
    await retireKeys(retire.ctx, 'MEMBER_SIGNING_KEYS', { now: NOW + 31 * DAY });
    const kept = retire.ctx.secrets.keys.MEMBER_SIGNING_KEYS as string;
    expect(Object.keys(parseKeyring(kept).keys)).toEqual(['k20270115']);
    for (const script of ['swarm-vault', 'swarm-capture']) {
      expect(pushed).toContainEqual({
        script,
        name: 'MEMBER_VERIFY_KEYS',
        text: await publicKeyring('MEMBER_SIGNING_KEYS', kept),
      });
    }
  });

  it('refuses to rotate MEMBER_KEYS once nothing signs with it', async () => {
    const store = new MemoryStateStore();
    const transport = new FakeTransport({ zone: 'example.com' });
    await runSteps((await fakeRun({ store, transport })).ctx, INSTALL_STEPS);
    const { ctx } = await fakeRun({
      argv: ['rotate-keys', 'AUTH_KEYS', '--dry-run'],
      store,
      transport,
    });
    ctx.secrets.keys.MEMBER_KEYS = 'k1:' + 'm'.repeat(64);
    await expect(rotateKeys(ctx, 'MEMBER_KEYS', { now: NOW })).rejects.toThrow(
      /MEMBER_KEYS signs nothing any more/,
    );
  });
});

describe('the --link-keys option', () => {
  it('is for update only', () => {
    expect(parseArgs(['update', '--link-keys=verify-only'])).toMatchObject({
      command: 'update',
      holdLinkCutover: true,
    });
    expect(() => parseArgs(['doctor', '--link-keys=verify-only'])).toThrow(/for update/);
  });
});
