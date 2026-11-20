// `pnpm swarm vault`: row-bound writes only after a week on the vault with every worker healthy
// (--force overrides, with a warning), legacy opening closed only once the re-seal has finished
// with nothing left unread, and doctor saying where the vault stands. Fake world.
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli';
import { doctor } from '../src/commands/doctor';
import { vault, VAULT_V3_AFTER_DAYS } from '../src/commands/vault';
import { FakeTransport } from '../src/fake';
import { MemoryStateStore } from '../src/state';
import { INSTALL_STEPS, runSteps } from '../src/steps';
import type { HttpRequest } from '../src/transport';
import { fakeRun } from './helpers';

const DAY = 86_400_000;

/** A fake install whose field_key_reseal row is `progress` (null: none yet). */
async function installed() {
  const store = new MemoryStateStore();
  const transport = new FakeTransport({ zone: 'example.com' });
  await runSteps((await fakeRun({ store, transport })).ctx, INSTALL_STEPS);
  const world = {
    store,
    transport,
    progress: null as null | { resealed: number; unreadable: number; finished_at: number | null },
  };
  const http = transport.http.bind(transport);
  transport.http = async (request: HttpRequest) => {
    if (request.url.endsWith('/query')) {
      const body = JSON.parse(request.body ?? '{}') as { sql?: string; batch?: { sql: string }[] };
      const statements = body.batch ?? [{ sql: body.sql ?? '' }];
      if (statements.every((s) => s.sql.includes('FROM field_key_reseal'))) {
        const results = world.progress ? [world.progress] : [];
        return {
          status: 200,
          text: JSON.stringify({
            success: true,
            errors: [],
            result: statements.map(() => ({ results, success: true, meta: { changes: 0 } })),
          }),
        };
      }
    }
    return http(request);
  };
  return world;
}

async function run(world: Awaited<ReturnType<typeof installed>>, argv: string[], now: number) {
  const output: string[] = [];
  const options = parseArgs(['vault', ...argv, '--dry-run']);
  const { ctx } = await fakeRun({
    argv: ['vault', ...argv, '--dry-run'],
    store: world.store,
    transport: world.transport,
    output,
  });
  const before = world.transport.actions.length;
  await vault(ctx, options.vaultCommand ?? { force: false }, now);
  return {
    ctx,
    output: output.join(''),
    deploys: world.transport.actions.slice(before).filter((a) => a.startsWith('wrangler deploy')),
  };
}

describe('pnpm swarm vault', () => {
  it('records when the vault first went out, and starts on legacy writes', async () => {
    const world = await installed();
    const { state } = await world.store.load('production');
    expect(state?.vault).toMatchObject({ writeFormat: 'legacy', legacyOpen: true });
    expect(state?.vault?.since).toBeGreaterThan(0);
  });

  it('waits a week on the vault before row-bound writes, unless forced', async () => {
    const world = await installed();
    const since = (await world.store.load('production')).state?.vault?.since as number;
    await expect(run(world, ['--write-format', 'v3'], since + DAY)).rejects.toThrow(
      /has run here for 1 of 7 days/,
    );
    expect((await world.store.load('production')).state?.vault?.writeFormat).toBe('legacy');

    const forced = await run(world, ['--write-format', 'v3', '--force'], since + DAY);
    expect(forced.output).toContain('anyway (--force)');
    expect(forced.ctx.state.vault?.writeFormat).toBe('v3');
    // Only the vault reads it, so only the vault deploys again.
    expect(forced.deploys).toHaveLength(1);
    expect(forced.deploys[0]).toContain('workers/vault/');
  });

  it('refuses while a worker bound to the vault is unhealthy', async () => {
    const world = await installed();
    const since = (await world.store.load('production')).state?.vault?.since as number;
    world.transport.vaultDown = true;
    await expect(
      run(world, ['--write-format', 'v3'], since + VAULT_V3_AFTER_DAYS * DAY + 1),
    ).rejects.toThrow(/not healthy/);
    world.transport.vaultDown = false;
    const done = await run(world, ['--write-format', 'v3'], since + VAULT_V3_AFTER_DAYS * DAY + 1);
    expect(done.ctx.state.vault?.writeFormat).toBe('v3');
  });

  it('closes legacy opening only after v3 writes and a finished re-seal with nothing unread', async () => {
    const world = await installed();
    const since = (await world.store.load('production')).state?.vault?.since as number;
    const later = since + 30 * DAY;
    await expect(run(world, ['--legacy-open', 'off'], later)).rejects.toThrow(
      /still writes the legacy formats/,
    );
    await run(world, ['--write-format', 'v3'], later);
    world.progress = { resealed: 10, unreadable: 0, finished_at: null };
    await expect(run(world, ['--legacy-open', 'off'], later)).rejects.toThrow(/hasn't finished/);
    world.progress = { resealed: 10, unreadable: 2, finished_at: later };
    await expect(run(world, ['--legacy-open', 'off', '--force'], later)).rejects.toThrow(
      /2 values no key opens/,
    );
    world.progress = { resealed: 12, unreadable: 0, finished_at: later };
    const closed = await run(world, ['--legacy-open', 'off'], later);
    expect(closed.ctx.state.vault).toMatchObject({ writeFormat: 'v3', legacyOpen: false });
    expect(closed.deploys).toHaveLength(1);
  });

  it('reports the write format, legacy opening and re-seal progress in doctor', async () => {
    const world = await installed();
    world.progress = { resealed: 3, unreadable: 0, finished_at: null };
    const output: string[] = [];
    const { ctx } = await fakeRun({
      argv: ['doctor', '--dry-run'],
      store: world.store,
      transport: world.transport,
      output,
    });
    await doctor(ctx);
    const text = output.join('');
    expect(text).toMatch(/The vault.*writes the legacy formats; legacy opening on/);
    expect(text).toContain('3 sealed again, 0 unreadable, running');
    world.progress = { resealed: 3, unreadable: 1, finished_at: Date.now() };
    const again: string[] = [];
    const second = await fakeRun({
      argv: ['doctor', '--dry-run'],
      store: world.store,
      transport: world.transport,
      output: again,
    });
    expect(await doctor(second.ctx)).toBe(false);
    expect(again.join('')).toContain('open with no key in FIELD_KEYS');
  });

  it('takes its options only on the vault command', () => {
    expect(parseArgs(['vault', '--write-format', 'v3']).vaultCommand).toEqual({
      force: false,
      writeFormat: 'v3',
    });
    expect(() => parseArgs(['update', '--force'])).toThrow(/are for vault/);
    expect(() => parseArgs(['vault', '--write-format', 'v4'])).toThrow(/v3 or legacy/);
  });
});
