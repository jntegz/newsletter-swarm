// `pnpm swarm rotate-keys`: a new signing key on every worker that holds the ring, the old one kept
// for verifying, the new keys saved before any worker gets them, a new sealed recovery kit, and
// retiring the old key only once nothing that still matters needs it. Fake world, synthetic keys.
import { parseKeyring } from '@swarm/tokens';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli';
import { retireKeys, rotateKeys } from '../src/commands/rotate-keys';
import { FakeTransport } from '../src/fake';
import { openKit, type SealedKit } from '../src/kit';
import { MemoryStateStore } from '../src/state';
import { INSTALL_STEPS, runSteps } from '../src/steps';
import type { HttpRequest } from '../src/transport';
import { fakeRun } from './helpers';

const KIT_PASSPHRASE = 'test-only kit passphrase';
const DAY = 86_400_000;
const NOW = Date.parse('2027-01-15T12:00:00Z');

interface Pushed {
  script: string;
  name: string;
  text: string;
}

/** A finished fake install, with every secret PUT and D1 query it sees recorded. */
async function installed() {
  const store = new MemoryStateStore();
  const transport = new FakeTransport({ zone: 'example.com' });
  await runSteps((await fakeRun({ store, transport })).ctx, INSTALL_STEPS);
  const pushed: Pushed[] = [];
  const queries: string[] = [];
  let answerD1: ((sql: string) => Record<string, unknown>[] | undefined) | undefined;
  let refusePuts = false;
  const http = transport.http.bind(transport);
  transport.http = async (request: HttpRequest) => {
    const secret = /\/workers\/scripts\/([^/]+)\/secrets$/.exec(request.url);
    if (secret && request.method === 'PUT') {
      if (refusePuts) return { status: 500, text: JSON.stringify({ success: false, errors: [] }) };
      const body = JSON.parse(request.body ?? '{}') as { name: string; text: string };
      pushed.push({ script: secret[1] as string, name: body.name, text: body.text });
    }
    if (answerD1 && request.url.endsWith('/query')) {
      const body = JSON.parse(request.body ?? '{}') as { sql?: string; batch?: { sql: string }[] };
      const statements = body.batch ?? [{ sql: body.sql ?? '' }];
      queries.push(...statements.map((s) => s.sql));
      const answers = statements.map((s) => answerD1?.(s.sql));
      if (answers.every((a) => a !== undefined)) {
        return {
          status: 200,
          text: JSON.stringify({
            success: true,
            errors: [],
            result: answers.map((results) => ({ results, success: true, meta: { changes: 0 } })),
          }),
        };
      }
    }
    return http(request);
  };
  return {
    store,
    transport,
    pushed,
    queries,
    answer(fn: typeof answerD1) {
      answerD1 = fn;
    },
    refuse(value: boolean) {
      refusePuts = value;
    },
  };
}

async function command(world: Awaited<ReturnType<typeof installed>>, argv: string[]) {
  const output: string[] = [];
  const { ctx } = await fakeRun({
    argv: [...argv, '--dry-run'],
    store: world.store,
    transport: world.transport,
    output,
  });
  return { ctx, output };
}

const ringOf = async (store: MemoryStateStore, name: string) =>
  (await store.load('production')).secrets?.keys[name] as string;

describe('rotating a keyring', () => {
  beforeEach(() => {
    process.env.SWARM_KIT_PASSPHRASE = KIT_PASSPHRASE;
  });
  afterEach(() => {
    delete process.env.SWARM_KIT_PASSPHRASE;
  });

  it('adds a new signing key, keeps the old one for verifying, on every worker that holds it', async () => {
    const world = await installed();
    const before = await ringOf(world.store, 'TRACK_KEYS');
    const old = parseKeyring(before);
    const { ctx, output } = await command(world, ['rotate-keys', 'TRACK_KEYS']);
    await rotateKeys(ctx, 'TRACK_KEYS', { now: NOW });

    const after = await ringOf(world.store, 'TRACK_KEYS');
    const ring = parseKeyring(after);
    expect(ring.current).toBe('k20270115');
    expect(ring.keys[old.current]).toBe(old.keys[old.current]);
    expect(after.endsWith(`,${before}`)).toBe(true);
    expect(ring.keys.k20270115).toMatch(/^[A-Za-z0-9_-]{64}$/);

    // Only the workers that hold TRACK_KEYS (not the api, which signs no click or open), first as
    // a verify-only key everywhere, then signing.
    const scripts = ['swarm-track', 'swarm-send'];
    expect(world.pushed.every((p) => p.name === 'TRACK_KEYS')).toBe(true);
    expect(world.pushed.map((p) => p.script)).toEqual([...scripts, ...scripts]);
    for (const p of world.pushed.slice(0, 2)) {
      expect(parseKeyring(p.text).current).toBe(old.current);
      expect(parseKeyring(p.text).keys.k20270115).toBe(ring.keys.k20270115);
    }
    for (const p of world.pushed.slice(2)) expect(p.text).toBe(after);

    // A new kit, sealed, that holds the new ring.
    const [path, text] = [...world.transport.files].find(([file]) =>
      file.endsWith('swarm-recovery-kit-production-2027-01-15.json'),
    ) as [string, string];
    expect(path).toBeTruthy();
    expect(text).not.toContain(ring.keys.k20270115);
    const kit = await openKit(JSON.parse(text) as SealedKit, KIT_PASSPHRASE);
    expect((kit.secrets as { keys: Record<string, string> }).keys.TRACK_KEYS).toBe(after);

    const said = output.join('');
    expect(said).toContain('From 2028-02-19 nothing it signed is still valid');
    expect(said).toContain('pnpm swarm rotate-keys TRACK_KEYS --retire');
    expect(said).not.toContain(ring.keys.k20270115);
    expect((await world.store.load('production')).state?.keyRotations?.TRACK_KEYS).toEqual({
      kid: 'k20270115',
      at: NOW,
      pushed: true,
    });
  });

  it('saves the new key before any worker gets it, and finishes an interrupted rotation', async () => {
    const world = await installed();
    world.refuse(true);
    const first = await command(world, ['rotate-keys', 'CAPTURE_KEYS']);
    await expect(rotateKeys(first.ctx, 'CAPTURE_KEYS', { now: NOW })).rejects.toThrow();
    const saved = await world.store.load('production');
    expect(parseKeyring(saved.secrets?.keys.CAPTURE_KEYS as string).current).toBe('k20270115');
    expect(saved.state?.keyRotations?.CAPTURE_KEYS?.pushed).toBe(false);

    world.refuse(false);
    const again = await command(world, ['rotate-keys', 'CAPTURE_KEYS']);
    await rotateKeys(again.ctx, 'CAPTURE_KEYS', { now: NOW + 60_000 });
    // The same key, not another one.
    expect(await ringOf(world.store, 'CAPTURE_KEYS')).toBe(saved.secrets?.keys.CAPTURE_KEYS);
    expect(again.output.join('')).toContain('Finishing the rotation of CAPTURE_KEYS');
    expect(again.output.join('')).toContain('swarm_member reference');
    expect((await world.store.load('production')).state?.keyRotations?.CAPTURE_KEYS?.pushed).toBe(
      true,
    );
  });

  it('pushes nothing when it cannot write the new recovery kit', async () => {
    const world = await installed();
    delete process.env.SWARM_KIT_PASSPHRASE;
    const { ctx } = await command(world, ['rotate-keys', 'AUTH_KEYS']);
    await expect(rotateKeys(ctx, 'AUTH_KEYS', { now: NOW })).rejects.toThrow(
      /cannot ask for its passphrase/,
    );
    expect(world.pushed).toEqual([]);
  });

  it('gives a second rotation on the same day a key id of its own', async () => {
    const world = await installed();
    for (const now of [NOW, NOW + 1000]) {
      const { ctx } = await command(world, ['rotate-keys', 'READER_KEYS']);
      await rotateKeys(ctx, 'READER_KEYS', { now });
    }
    const ring = parseKeyring(await ringOf(world.store, 'READER_KEYS'));
    expect(ring.current).toBe('k20270115b');
    expect(Object.keys(ring.keys)).toHaveLength(3);
  });
});

describe('retiring the old key', () => {
  beforeEach(() => {
    process.env.SWARM_KIT_PASSPHRASE = KIT_PASSPHRASE;
  });
  afterEach(() => {
    delete process.env.SWARM_KIT_PASSPHRASE;
  });

  async function rotated(name: 'AUTH_KEYS' | 'UNSUBSCRIBE_KEYS' | 'FIELD_KEYS') {
    const world = await installed();
    const { ctx } = await command(world, ['rotate-keys', name]);
    await rotateKeys(ctx, name, { now: NOW });
    world.pushed.length = 0;
    return world;
  }

  it('waits for the longest link lifetime, then leaves only the new key everywhere', async () => {
    const world = await rotated('AUTH_KEYS');
    const early = await command(world, ['rotate-keys', 'AUTH_KEYS', '--retire']);
    await expect(retireKeys(early.ctx, 'AUTH_KEYS', { now: NOW + 60_000 })).rejects.toThrow(
      /may still be needed until 2027-01-16/,
    );
    expect(world.pushed).toEqual([]);

    const later = await command(world, ['rotate-keys', 'AUTH_KEYS', '--retire']);
    await retireKeys(later.ctx, 'AUTH_KEYS', { now: NOW + DAY + 1 });
    const ring = parseKeyring(await ringOf(world.store, 'AUTH_KEYS'));
    expect(Object.keys(ring.keys)).toEqual(['k20270115']);
    expect(world.pushed.map((p) => p.script)).toEqual(['swarm-api']);
    expect(world.pushed[0]?.text).toBe(await ringOf(world.store, 'AUTH_KEYS'));
    expect((await world.store.load('production')).state?.keyRotations?.AUTH_KEYS).toBeUndefined();
  });

  it('keeps an unsubscribe key unless told to break the links it made', async () => {
    const world = await rotated('UNSUBSCRIBE_KEYS');
    const { ctx } = await command(world, ['rotate-keys', 'UNSUBSCRIBE_KEYS', '--retire']);
    await expect(retireKeys(ctx, 'UNSUBSCRIBE_KEYS', { now: NOW + 3650 * DAY })).rejects.toThrow(
      /breaks the unsubscribe links/,
    );
    const forced = await command(world, ['rotate-keys', 'UNSUBSCRIBE_KEYS', '--retire', '--yes']);
    await retireKeys(forced.ctx, 'UNSUBSCRIBE_KEYS', { now: NOW + DAY });
    expect(Object.keys(parseKeyring(await ringOf(world.store, 'UNSUBSCRIBE_KEYS')).keys)).toEqual([
      'k20270115',
    ]);
  });

  it('removes an old FIELD_KEYS key only when no stored value still needs it', async () => {
    const world = await rotated('FIELD_KEYS');
    let remaining = 3;
    let finished: number | null = null;
    world.answer((sql) => {
      if (/^SELECT COUNT\(\*\)/.test(sql))
        return [{ n: sql.includes('member_field_values') ? remaining : 0 }];
      if (/FROM field_key_reseal/.test(sql))
        return finished ? [{ finished_at: finished, unreadable: 0 }] : [];
      if (/DELETE FROM field_key_reseal/.test(sql)) return [];
      return undefined;
    });

    const busy = await command(world, ['rotate-keys', 'FIELD_KEYS', '--retire']);
    await expect(retireKeys(busy.ctx, 'FIELD_KEYS', { now: NOW + 2 * DAY })).rejects.toThrow(
      /3 stored values are still encrypted with an older FIELD_KEYS key/,
    );
    // Every sealed column is counted, against the new key id.
    expect(world.queries.filter((q) => q.startsWith('SELECT COUNT(*)'))).toHaveLength(14);
    // --yes does not override a pass that is still running.
    const forced = await command(world, ['rotate-keys', 'FIELD_KEYS', '--retire', '--yes']);
    await expect(
      retireKeys(forced.ctx, 'FIELD_KEYS', { now: NOW + 2 * DAY }),
    ).rejects.toMatchObject({ fix: expect.stringMatching(/still encrypting them again/) });

    // A finished pass with values left over is started again.
    finished = NOW + DAY;
    const again = await command(world, ['rotate-keys', 'FIELD_KEYS', '--retire']);
    await expect(retireKeys(again.ctx, 'FIELD_KEYS', { now: NOW + 2 * DAY })).rejects.toMatchObject(
      { fix: expect.stringMatching(/going over them again/) },
    );
    expect(world.queries.some((q) => q.startsWith('DELETE FROM field_key_reseal'))).toBe(true);
    expect(world.pushed).toEqual([]);

    remaining = 0;
    const done = await command(world, ['rotate-keys', 'FIELD_KEYS', '--retire']);
    await retireKeys(done.ctx, 'FIELD_KEYS', { now: NOW + 2 * DAY });
    expect(Object.keys(parseKeyring(await ringOf(world.store, 'FIELD_KEYS')).keys)).toEqual([
      'k20270115',
    ]);
    // Only the vault holds FIELD_KEYS.
    expect(world.pushed.map((p) => p.script)).toEqual(['swarm-vault']);
  });
});

describe('the command line', () => {
  it('names a keyring, and takes --retire and --kit', () => {
    expect(parseArgs(['rotate-keys', 'FIELD_KEYS', '--retire', '--kit', 'kit.json'])).toMatchObject(
      { command: 'rotate-keys', keyring: 'FIELD_KEYS', retire: true, kitPath: 'kit.json' },
    );
    expect(() => parseArgs(['rotate-keys'])).toThrow(/Say which keyring/);
    expect(() => parseArgs(['rotate-keys', 'SOME_KEYS'])).toThrow(/Say which keyring/);
    expect(() => parseArgs(['doctor', '--retire'])).toThrow(/for rotate-keys/);
  });

  it('takes the kit file for restore', () => {
    expect(parseArgs(['restore', 'kit.json'])).toMatchObject({
      command: 'restore',
      kitPath: 'kit.json',
    });
  });
});
