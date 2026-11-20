// What a new install turns on, against the real schema (every migration, on SQLite), and the
// `pnpm swarm feature` command against the fake world.
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { DatabaseSync as Database } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { listPlatformFeatures, setPlatformFeature } from '@swarm/flags/platform';
import { FEATURES_OFF_AT_INSTALL, FLAG_KEYS, SWITCHABLE_FLAG_KEYS } from '@swarm/flags/registry';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseArgs, main } from '../src/cli';
import { parseFeatureArgs, runFeature } from '../src/commands/feature';
import { update } from '../src/commands/update';
import { asD1Database, type D1Executor, type Row, type Statement } from '../src/d1';
import { FakeTransport } from '../src/fake';
import { MemoryStateStore } from '../src/state';
import { INSTALL_STEPS, runSteps } from '../src/steps';
import { applyFeatureDefaults } from '../src/steps/bootstrap';
import { InstallError } from '../src/ui';
import { fakeRun } from './helpers';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof Database;
};
const MIGRATIONS = fileURLToPath(new URL('../../../migrations/', import.meta.url));
const DEPLOYMENT_DOC = fileURLToPath(new URL('../../../docs/deployment.md', import.meta.url));

function executor(sqlite: Database): D1Executor {
  return {
    run: async (statements: Statement[]) =>
      statements.map(({ sql, params }) => {
        const prepared = sqlite.prepare(sql);
        const values = params as (string | number | null)[];
        if (/^\s*SELECT|\bRETURNING\b/i.test(sql)) {
          return { results: prepared.all(...values) as Row[], changes: 0 };
        }
        return { results: [], changes: Number(prepared.run(...values).changes) };
      }),
  };
}

const COPILOT = ['copilot', 'copilot_byok', 'copilot_actions'];

describe('the features a new install starts with', () => {
  let sqlite: Database;
  let db: D1Executor;

  const rows = () =>
    sqlite
      .prepare('SELECT key, scope, scope_id, enabled, updated_by FROM feature_flags ORDER BY key')
      .all() as {
      key: string;
      scope: string;
      scope_id: string | null;
      enabled: number;
      updated_by: string | null;
    }[];
  const enabledOf = (key: string) => rows().find((row) => row.key === key)?.enabled;

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    for (const file of (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()) {
      sqlite.exec(await readFile(`${MIGRATIONS}${file}`, 'utf8'));
    }
    db = executor(sqlite);
  });

  it('has no rows until the installer writes them: no migration seeds any', () => {
    expect(rows()).toEqual([]);
  });

  it('turns on every "build" feature, as platform-scope rows', async () => {
    const { added } = await applyFeatureDefaults(db);
    expect(added).toEqual(SWITCHABLE_FLAG_KEYS);
    expect(
      rows()
        .map((row) => row.key)
        .sort(),
    ).toEqual([...SWITCHABLE_FLAG_KEYS].sort());
    for (const row of rows()) {
      expect(row).toMatchObject({ scope: 'platform', scope_id: null, updated_by: null });
      expect(row.enabled, row.key).toBe(FEATURES_OFF_AT_INSTALL.includes(row.key as never) ? 0 : 1);
    }
    expect(enabledOf('split_tests')).toBe(1);
  });

  it('leaves Copilot off', async () => {
    await applyFeatureDefaults(db);
    for (const key of COPILOT) expect(enabledOf(key), key).toBe(0);
  });

  it('writes nothing for flags not decided as "build"', async () => {
    await applyFeatureDefaults(db);
    const written = new Set(rows().map((row) => row.key));
    for (const key of FLAG_KEYS) {
      if (!SWITCHABLE_FLAG_KEYS.includes(key)) expect(written.has(key), key).toBe(false);
    }
  });

  it('changes nothing on a re-run', async () => {
    await applyFeatureDefaults(db);
    const before = rows();
    expect((await applyFeatureDefaults(db)).added).toEqual([]);
    expect(rows()).toEqual(before);
  });

  it('keeps a choice: off stays off, and Copilot turned on stays on', async () => {
    await applyFeatureDefaults(db);
    const d1 = asD1Database(db);
    for (const [key, enabled] of [
      ['split_tests', false],
      ['copilot', true],
    ] as const) {
      await setPlatformFeature(d1, { id: `ff_${key}`, key, enabled, updatedBy: null, now: 5 });
    }
    expect((await applyFeatureDefaults(db)).added).toEqual([]);
    expect(enabledOf('split_tests')).toBe(0);
    expect(enabledOf('copilot')).toBe(1);
    // The upsert found the row through the unique index: no second row for the key.
    expect(rows().filter((row) => row.key === 'split_tests')).toHaveLength(1);
  });

  it('fills in only a flag with no row', async () => {
    await applyFeatureDefaults(db);
    sqlite.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'link_hub'").run();
    sqlite.prepare("DELETE FROM feature_flags WHERE key = 'pledges'").run();
    expect((await applyFeatureDefaults(db)).added).toEqual(['pledges']);
    expect(enabledOf('pledges')).toBe(1);
    expect(enabledOf('link_hub')).toBe(0);
  });

  it('leaves a workspace or publication row alone', async () => {
    sqlite
      .prepare(
        `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
         VALUES ('ff_ws', 'split_tests', 'workspace', 'ws_1', 0, 1)`,
      )
      .run();
    await applyFeatureDefaults(db);
    const split = rows().filter((row) => row.key === 'split_tests');
    expect(split).toHaveLength(2);
    expect(split.find((row) => row.scope === 'workspace')?.enabled).toBe(0);
    expect(split.find((row) => row.scope === 'platform')?.enabled).toBe(1);
  });

  it('lists every switchable feature, with no row reading as off', async () => {
    const empty = await listPlatformFeatures(asD1Database(db));
    expect(empty.map((f) => f.key)).toEqual(SWITCHABLE_FLAG_KEYS);
    expect(empty.every((f) => !f.enabled && f.updatedAt === null)).toBe(true);
    await applyFeatureDefaults(db);
    const filled = await listPlatformFeatures(asD1Database(db));
    expect(filled.find((f) => f.key === 'split_tests')?.enabled).toBe(true);
    expect(filled.find((f) => f.key === 'copilot')?.enabled).toBe(false);
  });

  it("docs/deployment.md's SQL for a manual deploy does what the installer does", async () => {
    const doc = await readFile(DEPLOYMENT_DOC, 'utf8');
    const sql = /```sql\n(INSERT OR IGNORE INTO feature_flags[\s\S]*?)```/.exec(doc)?.[1];
    expect(sql, 'the block in "Features" in docs/deployment.md').toBeTruthy();

    sqlite.exec(sql as string);
    sqlite.exec(sql as string); // A second run keeps what is there.
    const on = rows()
      .filter((row) => row.enabled === 1)
      .map((row) => row.key);
    expect(on).toEqual(
      SWITCHABLE_FLAG_KEYS.filter((key) => !FEATURES_OFF_AT_INSTALL.includes(key)).sort(),
    );
    for (const id of sqlite.prepare('SELECT id FROM feature_flags').all() as { id: string }[]) {
      expect(id.id).toMatch(/^ff_[0-9a-f]{32}$/);
    }
  });
});

async function installed() {
  const store = new MemoryStateStore();
  const transport = new FakeTransport({ zone: 'example.com' });
  const { ctx } = await fakeRun({ argv: ['--dry-run'], store, transport });
  await runSteps(ctx, INSTALL_STEPS);
  return { store, transport };
}

describe('install and update on the fake world', () => {
  it('a dry-run install writes the defaults, after the owner exists', async () => {
    const { transport } = await installed();
    const at = (pattern: RegExp) => transport.actions.findIndex((a) => pattern.test(a));
    expect(at(/query\s+INSERT INTO feature_flags/)).toBeGreaterThan(
      at(/query\s+INSERT INTO operators/),
    );
    expect([...transport.db.features.keys()].sort()).toEqual([...SWITCHABLE_FLAG_KEYS].sort());
    for (const key of COPILOT) expect(transport.db.features.get(key)).toBe(0);
    expect(transport.db.features.get('split_tests')).toBe(1);
  });

  it('re-running the install keeps a choice', async () => {
    const { store, transport } = await installed();
    transport.db.features.set('split_tests', 0);
    transport.db.features.set('copilot', 1);
    const output: string[] = [];
    const { ctx } = await fakeRun({ argv: ['--dry-run'], store, transport, output });
    await runSteps(ctx, INSTALL_STEPS);
    expect(transport.db.features.get('split_tests')).toBe(0);
    expect(transport.db.features.get('copilot')).toBe(1);
    expect(output.join('')).toMatch(/Setting which features start on.*already there/);
  });

  it('update fills in only the flags with no row', async () => {
    const { store, transport } = await installed();
    transport.db.features.set('split_tests', 0);
    transport.db.features.delete('pledges');
    transport.db.features.delete('copilot');
    const { ctx } = await fakeRun({
      argv: ['update', '--dry-run', '--skip-pull'],
      store,
      transport,
      answers: {},
    });
    await update(ctx);
    expect(transport.db.features.get('split_tests')).toBe(0);
    expect(transport.db.features.get('pledges')).toBe(1);
    expect(transport.db.features.get('copilot')).toBe(0);
  });
});

describe('pnpm swarm feature', () => {
  const failure = (args: string[]) => {
    try {
      parseFeatureArgs(args);
    } catch (error) {
      expect(error).toBeInstanceOf(InstallError);
      return (error as InstallError).message;
    }
    throw new Error(`parseFeatureArgs(${args.join(' ')}) did not refuse`);
  };

  it('parses list, on and off', () => {
    expect(parseArgs(['feature', 'list']).featureCommand).toEqual({ action: 'list' });
    expect(parseArgs(['feature', 'split_tests', 'off']).featureCommand).toEqual({
      action: 'set',
      key: 'split_tests',
      enabled: false,
    });
    expect(parseArgs(['feature', 'copilot', 'on', '--env', 'staging'])).toMatchObject({
      env: 'staging',
      featureCommand: { action: 'set', key: 'copilot', enabled: true },
    });
  });

  it('refuses unknown, deferred, undecided and dropped keys', () => {
    expect(failure(['nope', 'on'])).toContain('no feature called "nope"');
    expect(failure(['pulse', 'on'])).toContain('no feature called');
    expect(failure(['constructor', 'on'])).toContain('no feature called');
    expect(failure(['digest', 'on'])).toContain('not built yet');
    expect(failure(['site_comments', 'off'])).toContain('not built yet');
  });

  it('refuses a missing key, a missing state and extra words', () => {
    expect(failure([])).toContain('Say which feature');
    expect(failure(['split_tests'])).toContain('on or off');
    expect(failure(['split_tests', 'maybe'])).toContain('on or off');
    expect(failure(['split_tests', 'on', 'now'])).toContain('Unexpected');
    expect(failure(['list', 'now'])).toContain('Unexpected');
  });

  it('leaves the enable command as it was', () => {
    expect(parseArgs(['enable', 'payments'])).toMatchObject({
      command: 'enable',
      feature: 'payments',
    });
    expect(() => parseArgs(['enable', 'split_tests'])).toThrow(InstallError);
    expect(parseArgs(['enable', 'payments']).featureCommand).toBeUndefined();
  });

  it('is in the help', async () => {
    const lines: unknown[] = [];
    const log = console.log;
    console.log = (line: unknown) => lines.push(line);
    try {
      expect(await main(['--help'])).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines.join('\n')).toContain('feature <key> on|off');
    expect(lines.join('\n')).toContain('feature list');
  });

  it('lists what is on and off, and says Copilot is paid', async () => {
    const { store, transport } = await installed();
    const output: string[] = [];
    const { ctx } = await fakeRun({
      argv: ['feature', 'list', '--dry-run'],
      store,
      transport,
      output,
      answers: {},
    });
    await runFeature(ctx, { action: 'list' });
    const text = output.join('');
    expect(text).toContain('on   split_tests');
    expect(text).toMatch(/off {2}copilot {2}\(uses a paid AI service\)/);
    expect(text).toContain('up to a minute');
  });

  it('says when a feature has no row yet', async () => {
    const { store, transport } = await installed();
    transport.db.features.delete('pledges');
    const output: string[] = [];
    const { ctx } = await fakeRun({
      argv: ['feature', 'list', '--dry-run'],
      store,
      transport,
      output,
      answers: {},
    });
    await runFeature(ctx, { action: 'list' });
    expect(output.join('')).toMatch(/off {2}pledges {2}\(not set yet/);
  });

  it('stores off as a row, and a later update keeps it', async () => {
    const { store, transport } = await installed();
    const { ctx } = await fakeRun({
      argv: ['feature', 'split_tests', 'off', '--dry-run'],
      store,
      transport,
      answers: {},
    });
    await runFeature(ctx, { action: 'set', key: 'split_tests', enabled: false });
    expect(transport.db.features.get('split_tests')).toBe(0);

    const later = await fakeRun({
      argv: ['update', '--dry-run', '--skip-pull'],
      store,
      transport,
      answers: {},
    });
    await update(later.ctx);
    expect(transport.db.features.get('split_tests')).toBe(0);
  });

  it('says Copilot is paid when turning it on, and the delay either way', async () => {
    const { store, transport } = await installed();
    const output: string[] = [];
    const { ctx } = await fakeRun({
      argv: ['feature', 'copilot', 'on', '--dry-run'],
      store,
      transport,
      output,
      answers: {},
    });
    await runFeature(ctx, { action: 'set', key: 'copilot', enabled: true });
    const text = output.join('');
    expect(transport.db.features.get('copilot')).toBe(1);
    expect(text).toContain('copilot is on');
    expect(text).toContain('up to a minute');
    expect(text).toContain('paid AI service');
  });

  it('says so when there is no install to change', async () => {
    const { ctx } = await fakeRun({ argv: ['feature', 'list', '--dry-run'], answers: {} });
    await expect(runFeature(ctx, { action: 'list' })).rejects.toThrow(/no production install/);
  });
});
