// Email checks (docs/email-verification.md): planning a check of a list (dedupe across
// publications, free checks, results that still count), running it in parts through the fake
// DeBounce, stopping, running out of credits and resuming, an import that checks its addresses,
// background checks of added subscribers, and the call leases.
import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import {
  EMAIL_CHECK_MONTHLY_LIST_CHECKS,
  EmailCheckBudgetError,
  activeRun,
  createRun,
  emailCheckListBudget,
  emailCheckFile,
  fakeDebounceFetch,
  loadRun,
  releaseLease,
  startRun,
  stopRun,
  resumeRun,
  takeLease,
  useDebounceFetchForTests,
  type JobMessage,
} from '@swarm/engine';
import { afterEach, describe, expect, it } from 'vitest';
import {
  advanceEmailCheck,
  checkAddedAddresses,
  emailCheckDeps,
  planEmailCheck,
  runEmailChecksMinute,
} from '../src/handlers/email-checks';
import { runImport } from '../src/handlers/imports';
import { addMember, count, jobsEnv, one, seedChannel, seedImport } from './helpers';

afterEach(() => useDebounceFetchForTests(undefined));

function checksEnv() {
  const made = jobsEnv();
  return { ...made, env: { ...made.env, DEBOUNCE_API_KEY: 'dev' } };
}

/** A workspace that may use DeBounce, with the feature on. */
async function allowedChannel() {
  const seed = await seedChannel();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
       VALUES (?1, 'email_verification', 'workspace', ?2, 1, 0)`,
    ).bind(newId('featureFlag'), seed.workspaceId),
    env.DB.prepare(
      'INSERT INTO email_check_workspaces (workspace_id, created_at) VALUES (?1, ?2)',
    ).bind(seed.workspaceId, now),
  ]);
  return seed;
}

/** The fake with its own credits, reading the files Swarm serves. */
function fakeWith(
  e: ReturnType<typeof checksEnv>['env'],
  options: { credits?: { left: number }; processingPolls?: number },
) {
  useDebounceFetchForTests(
    fakeDebounceFetch({
      ...options,
      readList: async (url) => {
        const token = /\/([A-Za-z0-9_-]{43})\.csv$/.exec(url)?.[1];
        return token ? emailCheckFile(e.DB, e.IMPORTS, token) : null;
      },
    }),
  );
}

async function addMany(channelId: string, prefix: string, n: number) {
  const now = Date.now();
  const statements = Array.from({ length: n }, (_, i) =>
    env.DB.prepare(
      `INSERT INTO members (id, channel_id, email, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'active', ?4, ?4)`,
    ).bind(newId('member', now + i), channelId, `${prefix}-${i}@example.org`, now),
  );
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
}

/** Runs messages of these kinds from the queue until it is empty of them. */
async function drain(e: ReturnType<typeof checksEnv>['env'], items: JobMessage[], rounds = 20) {
  for (let n = 0; n < rounds; n++) {
    const next = items.findIndex(
      (m) => m.type === 'email_check_plan' || m.type === 'email_check_run',
    );
    if (next < 0) return;
    const [message] = items.splice(next, 1);
    if (message?.type === 'email_check_plan') await planEmailCheck(e, message.runId);
    if (message?.type === 'email_check_run') await advanceEmailCheck(e, message.runId);
  }
}

describe('planning', () => {
  it('counts each address once, skips recent results and settles what Swarm can tell', async () => {
    const seed = await allowedChannel();
    const second = newId('channel');
    await env.DB.prepare(
      `INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, 'Two', ?4, ?4)`,
    )
      .bind(second, seed.workspaceId, `two-${crypto.randomUUID().slice(0, 8)}`, Date.now())
      .run();
    await addMember(seed.channelId, 'jan@example.org');
    await addMember(second, 'jan@example.org');
    await addMember(seed.channelId, 'info@example.org');
    await addMember(seed.channelId, 'fresh@example.org');
    await addMember(seed.channelId, 'old@example.org');
    await addMember(seed.channelId, 'gone@example.org', { status: 'unsubscribed' });
    const day = 86_400_000;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO email_checks (workspace_id, email, state, code, source, checked_at)
         VALUES (?1, 'fresh@example.org', 'green', 5, 'debounce', ?2), (?1, 'old@example.org', 'green', 5, 'debounce', ?3)`,
      ).bind(seed.workspaceId, Date.now() - day, Date.now() - 400 * day),
    ]);
    const { env: e, queue } = checksEnv();
    const runId = await createRun(e.DB, {
      workspaceId: seed.workspaceId,
      scope: 'workspace',
      createdBy: null,
    });
    await planEmailCheck(e, runId);
    const run = await loadRun(e.DB, runId);
    expect(run).toMatchObject({
      status: 'planned',
      addresses: 4,
      fresh: 1,
      local_results: 1,
      to_check: 2,
      method: 'single',
      parts: 1,
      balance: 1_000_000,
    });
    expect(queue.items).toEqual([]);

    // Only never-checked: the old result is skipped too.
    await stopRun(e.DB, runId);
    const second2 = await createRun(e.DB, {
      workspaceId: seed.workspaceId,
      scope: 'channel',
      channelId: seed.channelId,
      onlyNeverChecked: true,
      createdBy: null,
    });
    await planEmailCheck(e, second2);
    expect(await loadRun(e.DB, second2)).toMatchObject({ addresses: 4, fresh: 2, to_check: 1 });
  });
});

describe('a small check, one address at a time', () => {
  it('stores Swarm’s and DeBounce’s results and refreshes segments', async () => {
    const seed = await allowedChannel();
    await addMember(seed.channelId, 'jan@example.org');
    await addMember(seed.channelId, 'bad@example.org');
    await addMember(seed.channelId, 'support@example.org');
    const { env: e, queue } = checksEnv();
    const runId = await createRun(e.DB, {
      workspaceId: seed.workspaceId,
      scope: 'channel',
      channelId: seed.channelId,
      createdBy: null,
    });
    await planEmailCheck(e, runId);
    await startRun(emailCheckDeps(e), runId);
    await drain(e, queue.items);
    const run = await loadRun(e.DB, runId);
    expect(run).toMatchObject({
      status: 'completed',
      green: 1,
      orange: 1,
      red: 1,
      credits_used: 2,
    });
    const rows = await env.DB.prepare(
      'SELECT email, state, code, source FROM email_checks WHERE workspace_id = ?1 ORDER BY email',
    )
      .bind(seed.workspaceId)
      .all();
    expect(rows.results).toEqual([
      { email: 'bad@example.org', state: 'red', code: 6, source: 'debounce' },
      { email: 'jan@example.org', state: 'green', code: 5, source: 'debounce' },
      { email: 'support@example.org', state: 'orange', code: 8, source: 'swarm' },
    ]);
    // The run's list of addresses is gone once it ends.
    expect(
      await count('SELECT count(*) AS n FROM email_check_items WHERE run_id = ?1', runId),
    ).toBe(0);
  });

  it('gives up on an address DeBounce keeps failing, so the run still finishes', async () => {
    const seed = await allowedChannel();
    await addMember(seed.channelId, 'jan@example.org');
    await addMember(seed.channelId, 'stuck@example.org');
    const { env: e, queue } = checksEnv();
    // DeBounce answers for everyone but one address, which always gets a 503.
    const fake = fakeDebounceFetch();
    const calls: string[] = [];
    useDebounceFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const asked = url.searchParams.get('email');
      if (asked) calls.push(asked);
      if (asked === 'stuck@example.org') {
        return new Response(JSON.stringify({ success: '0' }), { status: 503 });
      }
      return fake(input, init);
    }) as typeof fetch);
    const runId = await createRun(e.DB, {
      workspaceId: seed.workspaceId,
      scope: 'channel',
      channelId: seed.channelId,
      createdBy: null,
    });
    await planEmailCheck(e, runId);
    await startRun(emailCheckDeps(e), runId);
    await drain(e, queue.items);
    // The minute cron looks at it again; each look is one more try for the stuck address.
    for (let i = 0; i < 5 && (await loadRun(e.DB, runId))?.status === 'running'; i++) {
      await advanceEmailCheck(e, runId);
      await drain(e, queue.items);
    }
    const run = await loadRun(e.DB, runId);
    expect(run).toMatchObject({ status: 'completed', checked: 1, green: 1, credits_used: 1 });
    expect(run?.error).toMatch(/couldn’t check 1 address after 3 tries/);
    expect(calls.filter((email) => email === 'stuck@example.org')).toHaveLength(3);
    // It stays "not checked": no result is stored for it.
    expect(
      await count(
        "SELECT count(*) AS n FROM email_checks WHERE workspace_id = ?1 AND email = 'stuck@example.org'",
        seed.workspaceId,
      ),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS n FROM email_check_items WHERE run_id = ?1', runId),
    ).toBe(0);
  });
});

describe('a check in parts through the bulk API', () => {
  it('serves the part at an unguessable address, applies the results and drops the file', async () => {
    const seed = await allowedChannel();
    await addMany(seed.channelId, 'reader', 120);
    await addMember(seed.channelId, 'bad-1@example.org');
    const { env: e, queue } = checksEnv();
    fakeWith(e, { processingPolls: 1 });
    const runId = await createRun(e.DB, {
      workspaceId: seed.workspaceId,
      scope: 'channel',
      channelId: seed.channelId,
      createdBy: null,
    });
    await planEmailCheck(e, runId);
    expect(await loadRun(e.DB, runId)).toMatchObject({ method: 'bulk', to_check: 121, parts: 1 });
    await startRun(emailCheckDeps(e), runId);
    await drain(e, queue.items);
    const part = await one<{
      status: string;
      file_key: string;
      token_hash: string;
      list_id: string;
    }>(
      'SELECT status, file_key, token_hash, list_id FROM email_check_parts WHERE run_id = ?1',
      runId,
    );
    expect(part).toMatchObject({ status: 'submitted' });
    expect(part?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const file = await e.IMPORTS.get(part!.file_key);
    const lines = (await file!.text()).trim().split('\n');
    expect(lines).toHaveLength(121);
    // Addresses only: no names, no ids.
    expect(lines.every((l) => /^[^,\s]+@[^,\s]+$/.test(l))).toBe(true);

    // DeBounce is still working: nothing yet. Then it finishes.
    await advanceEmailCheck(e, runId);
    expect((await loadRun(e.DB, runId))?.status).toBe('running');
    await advanceEmailCheck(e, runId);
    const run = await loadRun(e.DB, runId);
    expect(run).toMatchObject({ status: 'completed', green: 120, red: 1, credits_used: 121 });
    expect(await e.IMPORTS.get(part!.file_key)).toBeNull();
    expect(
      await one('SELECT file_key, token_hash FROM email_check_parts WHERE run_id = ?1', runId),
    ).toEqual({ file_key: null, token_hash: null });
  });

  it('refuses an oversized results file without applying anything, and tries again', async () => {
    const seed = await allowedChannel();
    await addMany(seed.channelId, 'sized', 120);
    const { env: e, queue } = checksEnv();
    fakeWith(e, { processingPolls: 0 });
    const real = fakeDebounceFetch({
      readList: async (url) => {
        const token = /\/([A-Za-z0-9_-]{43})\.csv$/.exec(url)?.[1];
        return token ? emailCheckFile(e.DB, e.IMPORTS, token) : null;
      },
    });
    let oversized = true;
    useDebounceFetchForTests(async (input, init) => {
      if (oversized && new URL(String(input)).hostname === 'cdn.debounce.io') {
        // Far more than 121 addresses' results could need, plus a verdict for an outsider.
        const rows = ['Email,Debounce Code', 'outsider@example.org,6'];
        const filler = 'x'.repeat(200);
        for (let i = 0; i < 2000; i++) rows.push(`sized-${i}@example.org,5,${filler}`);
        return new Response(rows.join('\n'));
      }
      const answer = await real(input, init);
      if (new URL(String(input)).hostname !== 'cdn.debounce.io') return answer;
      // The accepted file also names an address outside this part: it must be ignored.
      const lines = (await answer.text()).split('\n');
      const outsider = lines[1]!.replace(/^"[^"]*"/, '"outsider@example.org"');
      return new Response([...lines, outsider].join('\n'));
    });
    const runId = await createRun(e.DB, {
      workspaceId: seed.workspaceId,
      scope: 'channel',
      channelId: seed.channelId,
      createdBy: null,
    });
    await planEmailCheck(e, runId);
    await startRun(emailCheckDeps(e), runId);
    await drain(e, queue.items);
    await advanceEmailCheck(e, runId);
    const results = () =>
      count('SELECT count(*) AS n FROM email_checks WHERE workspace_id = ?1', seed.workspaceId);
    // Visible and retryable: still running with the error shown, the part still at DeBounce.
    expect(await loadRun(e.DB, runId)).toMatchObject({ status: 'running' });
    expect((await loadRun(e.DB, runId))?.error).toContain('larger than this part allows');
    expect(
      await one('SELECT status FROM email_check_parts WHERE run_id = ?1', runId),
    ).toMatchObject({ status: 'submitted' });
    expect(await results()).toBe(0);

    oversized = false;
    await advanceEmailCheck(e, runId);
    expect(await loadRun(e.DB, runId)).toMatchObject({ status: 'completed', green: 120 });
    expect(
      await count(
        `SELECT count(*) AS n FROM email_checks WHERE workspace_id = ?1 AND email = 'outsider@example.org'`,
        seed.workspaceId,
      ),
    ).toBe(0);
  });

  it('stop sends no further part, and the part at DeBounce still counts', async () => {
    const seed = await allowedChannel();
    await addMany(seed.channelId, 'stop', 110);
    const { env: e, queue } = checksEnv();
    fakeWith(e, { processingPolls: 1 });
    const runId = await createRun(e.DB, {
      workspaceId: seed.workspaceId,
      scope: 'channel',
      channelId: seed.channelId,
      createdBy: null,
    });
    await planEmailCheck(e, runId);
    await startRun(emailCheckDeps(e), runId);
    await drain(e, queue.items);
    await stopRun(e.DB, runId);
    expect((await loadRun(e.DB, runId))?.status).toBe('stopping');
    await advanceEmailCheck(e, runId);
    await advanceEmailCheck(e, runId);
    expect(await loadRun(e.DB, runId)).toMatchObject({ status: 'stopped', green: 110 });
  });

  it('pauses when credits run out and carries on after Resume', async () => {
    const seed = await allowedChannel();
    await addMany(seed.channelId, 'credit', 105);
    const { env: e, queue } = checksEnv();
    const credits = { left: 10 };
    fakeWith(e, { credits });
    const runId = await createRun(e.DB, {
      workspaceId: seed.workspaceId,
      scope: 'channel',
      channelId: seed.channelId,
      createdBy: null,
    });
    await planEmailCheck(e, runId);
    await startRun(emailCheckDeps(e), runId);
    await drain(e, queue.items);
    await advanceEmailCheck(e, runId);
    expect(await loadRun(e.DB, runId)).toMatchObject({
      status: 'paused',
      paused_reason: 'credits',
    });
    credits.left = 1000;
    await resumeRun(emailCheckDeps(e), runId);
    await drain(e, queue.items);
    expect(await loadRun(e.DB, runId)).toMatchObject({ status: 'completed', green: 105 });
  });

  it('allows one check at a time per workspace', async () => {
    const seed = await allowedChannel();
    const { env: e } = checksEnv();
    await createRun(e.DB, { workspaceId: seed.workspaceId, scope: 'workspace', createdBy: null });
    expect(await activeRun(e.DB, seed.workspaceId)).not.toBeNull();
  });
});

describe('a workspace’s list checks (S04-P3-TR-list-check-tenant-budget)', () => {
  async function withListBudget(monthly: number) {
    const seed = await allowedChannel();
    await env.DB.prepare(
      'INSERT INTO email_check_list_budgets (workspace_id, monthly_checks, updated_at) VALUES (?1, ?2, ?3)',
    )
      .bind(seed.workspaceId, monthly, Date.now())
      .run();
    return seed;
  }
  const planned = async (
    e: ReturnType<typeof checksEnv>['env'],
    channelId: string,
    workspaceId: string,
  ) => {
    const runId = await createRun(e.DB, {
      workspaceId,
      scope: 'channel',
      channelId,
      createdBy: null,
    });
    await planEmailCheck(e, runId);
    return runId;
  };

  it('defaults to a monthly number for every workspace', async () => {
    const seed = await allowedChannel();
    expect(await emailCheckListBudget(env.DB, seed.workspaceId)).toMatchObject({
      monthlyChecks: EMAIL_CHECK_MONTHLY_LIST_CHECKS,
      usedThisMonth: 0,
    });
  });

  it('refuses to start a check that needs more than is left, before anything reaches DeBounce', async () => {
    const seed = await withListBudget(100);
    await addMany(seed.channelId, 'over', 120);
    const { env: e, queue } = checksEnv();
    const asked: string[] = [];
    const fake = fakeDebounceFetch();
    useDebounceFetchForTests(async (input, init) => {
      asked.push(String(input));
      return fake(input, init);
    });
    const runId = await planned(e, seed.channelId, seed.workspaceId);
    asked.length = 0; // planning asks for the balance only
    await expect(startRun(emailCheckDeps(e), runId)).rejects.toBeInstanceOf(EmailCheckBudgetError);
    await expect(startRun(emailCheckDeps(e), runId)).rejects.toThrow(
      /needs 120 DeBounce credits, and this workspace has 100 of its 100 list checks left/,
    );
    expect(await loadRun(e.DB, runId)).toMatchObject({ status: 'planned', budget_taken: 0 });
    expect(await emailCheckListBudget(env.DB, seed.workspaceId)).toMatchObject({
      usedThisMonth: 0,
    });
    expect(asked).toEqual([]);
    expect(queue.items.filter((m) => m.type === 'email_check_run')).toEqual([]);
  });

  it('counts what a check sends, the same way for every check, and keeps the workspace within it', async () => {
    const seed = await withListBudget(200);
    await addMany(seed.channelId, 'fits', 120);
    const { env: e, queue } = checksEnv();
    fakeWith(e, { processingPolls: 1 });
    const first = await planned(e, seed.channelId, seed.workspaceId);
    await startRun(emailCheckDeps(e), first);
    await drain(e, queue.items);
    await advanceEmailCheck(e, first);
    expect(await emailCheckListBudget(env.DB, seed.workspaceId)).toMatchObject({
      usedThisMonth: 120,
      left: 80,
    });
    // A second check of the same 120, asking again about all of them, no longer fits.
    await env.DB.prepare('DELETE FROM email_checks WHERE workspace_id = ?1')
      .bind(seed.workspaceId)
      .run();
    const second = await planned(e, seed.channelId, seed.workspaceId);
    await expect(startRun(emailCheckDeps(e), second)).rejects.toBeInstanceOf(EmailCheckBudgetError);
    // Another workspace has its own.
    const other = await withListBudget(200);
    await addMany(other.channelId, 'other', 120);
    const third = await planned(e, other.channelId, other.workspaceId);
    await startRun(emailCheckDeps(e), third);
    expect(await emailCheckListBudget(env.DB, other.workspaceId)).toMatchObject({
      usedThisMonth: 120,
    });
  });

  it('gives back what a stopped check never sent, and keeps what DeBounce already has', async () => {
    const seed = await withListBudget(1000);
    await addMany(seed.channelId, 'back', 105);
    const { env: e, queue } = checksEnv();
    fakeWith(e, { processingPolls: 1 });
    // Stopped before its first part went: everything comes back.
    const early = await planned(e, seed.channelId, seed.workspaceId);
    await startRun(emailCheckDeps(e), early);
    expect(await emailCheckListBudget(env.DB, seed.workspaceId)).toMatchObject({
      usedThisMonth: 105,
    });
    await stopRun(e.DB, early, Date.now(), e.IMPORTS);
    expect(await loadRun(e.DB, early)).toMatchObject({ status: 'stopped', budget_taken: 0 });
    expect(await emailCheckListBudget(env.DB, seed.workspaceId)).toMatchObject({
      usedThisMonth: 0,
    });
    queue.items.length = 0;
    // Stopped once its part is at DeBounce: that part is spent and stays counted.
    const late = await planned(e, seed.channelId, seed.workspaceId);
    await startRun(emailCheckDeps(e), late);
    await drain(e, queue.items);
    await stopRun(e.DB, late, Date.now(), e.IMPORTS);
    await advanceEmailCheck(e, late);
    await advanceEmailCheck(e, late);
    expect(await loadRun(e.DB, late)).toMatchObject({ status: 'stopped', budget_taken: 105 });
    expect(await emailCheckListBudget(env.DB, seed.workspaceId)).toMatchObject({
      usedThisMonth: 105,
    });
  });

  it('lets an import go on unchecked when its check doesn’t fit, saying why', async () => {
    const seed = await withListBudget(1);
    const csv = 'email\njan@example.org\nbad@example.org\ncatchall-1@example.org\n';
    const jobId = await seedImport(
      seed,
      csv,
      ['email'],
      { email: 'email' },
      { status: 'importing', consent: true },
    );
    await env.DB.prepare('UPDATE import_jobs SET check_addresses = 1 WHERE id = ?1')
      .bind(jobId)
      .run();
    const { env: e, queue } = checksEnv();
    await runImport(e, jobId);
    await drain(e, queue.items);
    expect(queue.items).toContainEqual({ type: 'import_run', jobId });
    const job = await one<{ email_check_run_id: string }>(
      'SELECT email_check_run_id FROM import_jobs WHERE id = ?1',
      jobId,
    );
    expect(await loadRun(e.DB, job!.email_check_run_id)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/list checks left this month/),
    });
    await runImport(e, jobId);
    expect(
      await count('SELECT count(*) AS n FROM members WHERE channel_id = ?1', seed.channelId),
    ).toBe(3);
    expect(await emailCheckListBudget(env.DB, seed.workspaceId)).toMatchObject({
      usedThisMonth: 0,
    });
  });
});

describe('a duplicated or replayed message: one submission, one charge', () => {
  /** The fake DeBounce, counting what reaches it; an upload can be held until `release`. */
  function countingFake(e: ReturnType<typeof checksEnv>['env'], options: { holdUpload?: boolean }) {
    const fake = fakeDebounceFetch({
      processingPolls: 1,
      readList: async (url) => {
        const token = /\/([A-Za-z0-9_-]{43})\.csv$/.exec(url)?.[1];
        return token ? emailCheckFile(e.DB, e.IMPORTS, token) : null;
      },
    });
    const seen = { uploads: 0, verified: [] as string[] };
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let uploading = () => {};
    const inUpload = new Promise<void>((resolve) => (uploading = resolve));
    useDebounceFetchForTests(async (input, init) => {
      const url = new URL(String(input));
      if (url.host === 'bulk.debounce.io' && url.pathname === '/v1/upload/') {
        seen.uploads++;
        uploading();
        // Only the first upload is held, so a second one shows up in the count instead of hanging.
        if (options.holdUpload && seen.uploads === 1) await held;
      }
      const email = url.host === 'api.debounce.io' ? url.searchParams.get('email') : null;
      if (email) seen.verified.push(email);
      return fake(input, init);
    });
    return { seen, release, inUpload };
  }

  async function startedRun(e: ReturnType<typeof checksEnv>['env'], n: number, prefix: string) {
    const seed = await allowedChannel();
    await addMany(seed.channelId, prefix, n);
    const runId = await createRun(e.DB, {
      workspaceId: seed.workspaceId,
      scope: 'channel',
      channelId: seed.channelId,
      createdBy: null,
    });
    await planEmailCheck(e, runId);
    await startRun(emailCheckDeps(e), runId);
    return { seed, runId };
  }

  it('sends a part to DeBounce once when its message arrives again while it is being sent', async () => {
    const { env: e, queue } = checksEnv();
    const { seen, release, inUpload } = countingFake(e, { holdUpload: true });
    const { seed, runId } = await startedRun(e, 120, 'twice');
    const first = advanceEmailCheck(e, runId);
    await inUpload;
    // The same email_check_run message again, and the minute cron, while the upload is under way.
    await advanceEmailCheck(e, runId);
    await runEmailChecksMinute(e, Date.now());
    release();
    await first;
    expect(seen.uploads).toBe(1);
    // Delivered again once the part is at DeBounce: still nothing sent twice.
    await drain(e, queue.items);
    await advanceEmailCheck(e, runId);
    await advanceEmailCheck(e, runId);
    expect(seen.uploads).toBe(1);
    expect(await loadRun(e.DB, runId)).toMatchObject({
      status: 'completed',
      green: 120,
      credits_used: 120,
      budget_taken: 120,
    });
    expect(await emailCheckListBudget(env.DB, seed.workspaceId)).toMatchObject({
      usedThisMonth: 120,
    });
  });

  it('asks about each address of a small check once when two steps arrive together', async () => {
    const { env: e, queue } = checksEnv();
    const { seen } = countingFake(e, {});
    const { runId } = await startedRun(e, 5, 'pair');
    await Promise.all([advanceEmailCheck(e, runId), advanceEmailCheck(e, runId)]);
    await drain(e, queue.items);
    expect(seen.verified).toHaveLength(5);
    expect(new Set(seen.verified).size).toBe(5);
    expect(await loadRun(e.DB, runId)).toMatchObject({ status: 'completed', credits_used: 5 });
  });

  it('writes the file again for a part whose worker died before writing it', async () => {
    const { env: e, queue } = checksEnv();
    const { seen } = countingFake(e, {});
    const { runId } = await startedRun(e, 120, 'nofile');
    const now = Date.now();
    // The part's row was made, then the worker died: no addresses given to it, no file, claim over.
    await env.DB.prepare(
      `INSERT INTO email_check_parts (run_id, part, status, claimed_until) VALUES (?1, 1, 'waiting', ?2)`,
    )
      .bind(runId, now - 1)
      .run();
    await advanceEmailCheck(e, runId, now);
    expect(seen.uploads).toBe(1);
    // Polls until DeBounce has the results, as the queued messages would.
    for (let n = 0; n < 10 && (await loadRun(e.DB, runId))?.status !== 'completed'; n++) {
      await drain(e, queue.items);
      await advanceEmailCheck(e, runId);
    }
    expect(seen.uploads).toBe(1);
    expect(await loadRun(e.DB, runId)).toMatchObject({ status: 'completed', green: 120 });
  });

  it('writes the file again for a part whose file expired while uploads kept failing', async () => {
    const { env: e, queue } = checksEnv();
    const { seen } = countingFake(e, {});
    const { runId } = await startedRun(e, 120, 'expired');
    // Part 1 has its addresses, but its file was dropped after 24 hours and nothing holds it.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO email_check_parts (run_id, part, status) VALUES (?1, 1, 'waiting')`,
      ).bind(runId),
      env.DB.prepare('UPDATE email_check_items SET part = 1 WHERE run_id = ?1').bind(runId),
    ]);
    await advanceEmailCheck(e, runId);
    expect(seen.uploads).toBe(1);
    // Polls until DeBounce has the results, as the queued messages would.
    for (let n = 0; n < 10 && (await loadRun(e.DB, runId))?.status !== 'completed'; n++) {
      await drain(e, queue.items);
      await advanceEmailCheck(e, runId);
    }
    expect(seen.uploads).toBe(1);
    expect(await loadRun(e.DB, runId)).toMatchObject({ status: 'completed', green: 120 });
  });

  it('takes over a step whose worker died once its claim runs out', async () => {
    const { env: e } = checksEnv();
    const { seen } = countingFake(e, {});
    const { runId } = await startedRun(e, 3, 'died');
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO email_check_parts (run_id, part, status, submitted_at, claimed_until)
       VALUES (?1, 1, 'submitted', ?2, ?3)`,
    )
      .bind(runId, now, now + 60_000)
      .run();
    await advanceEmailCheck(e, runId, now);
    expect(seen.verified).toEqual([]);
    await advanceEmailCheck(e, runId, now + 60_000);
    expect(seen.verified).toHaveLength(3);
  });

  it('charges the workspace once when the same run is started twice at once', async () => {
    const seed = await allowedChannel();
    await addMany(seed.channelId, 'start', 120);
    const { env: e, queue } = checksEnv();
    countingFake(e, {});
    const runId = await createRun(e.DB, {
      workspaceId: seed.workspaceId,
      scope: 'channel',
      channelId: seed.channelId,
      createdBy: null,
    });
    await planEmailCheck(e, runId);
    const [a, b] = await Promise.all([
      startRun(emailCheckDeps(e), runId),
      startRun(emailCheckDeps(e), runId),
    ]);
    expect(a?.status).toBe('running');
    expect(b?.status).toBe('running');
    expect(await loadRun(e.DB, runId)).toMatchObject({ budget_taken: 120 });
    expect(await emailCheckListBudget(env.DB, seed.workspaceId)).toMatchObject({
      usedThisMonth: 120,
    });
    expect(queue.items.filter((m) => m.type === 'email_check_run')).toHaveLength(1);
  });

  it('charges an import’s check once when its plan message arrives twice', async () => {
    const seed = await allowedChannel();
    const csv = 'email\njan@example.org\nbad@example.org\ncatchall-1@example.org\n';
    const jobId = await seedImport(
      seed,
      csv,
      ['email'],
      { email: 'email' },
      { status: 'importing', consent: true },
    );
    await env.DB.prepare('UPDATE import_jobs SET check_addresses = 1 WHERE id = ?1')
      .bind(jobId)
      .run();
    const { env: e, queue } = checksEnv();
    const { seen } = countingFake(e, {});
    await runImport(e, jobId);
    const plan = queue.items.find((m) => m.type === 'email_check_plan');
    expect(plan).toBeDefined();
    const runId = (plan as { runId: string }).runId;
    queue.items.length = 0;
    await Promise.all([planEmailCheck(e, runId), planEmailCheck(e, runId)]);
    await planEmailCheck(e, runId);
    expect(queue.items.filter((m) => m.type === 'email_check_run')).toHaveLength(1);
    await drain(e, queue.items);
    expect(await loadRun(e.DB, runId)).toMatchObject({ status: 'completed', budget_taken: 3 });
    expect(await emailCheckListBudget(env.DB, seed.workspaceId)).toMatchObject({
      usedThisMonth: 3,
    });
    expect(seen.verified.sort()).toEqual([
      'bad@example.org',
      'catchall-1@example.org',
      'jan@example.org',
    ]);
  });
});

describe('files', () => {
  it('never outlive a day, whatever the run is doing, and go when a paused run is stopped', async () => {
    const seed = await allowedChannel();
    await addMany(seed.channelId, 'expire', 102);
    const { env: e, queue } = checksEnv();
    const credits = { left: 0 };
    fakeWith(e, { credits });
    const runId = await createRun(e.DB, {
      workspaceId: seed.workspaceId,
      scope: 'channel',
      channelId: seed.channelId,
      createdBy: null,
    });
    await planEmailCheck(e, runId);
    await startRun(emailCheckDeps(e), runId);
    await drain(e, queue.items);
    await advanceEmailCheck(e, runId);
    expect((await loadRun(e.DB, runId))?.status).toBe('paused');
    const part = await one<{ file_key: string }>(
      'SELECT file_key FROM email_check_parts WHERE run_id = ?1',
      runId,
    );
    expect(await e.IMPORTS.get(part!.file_key)).not.toBeNull();

    // A day later the minute cron deletes it, though the run is paused.
    await runEmailChecksMinute(e, Date.now() + 25 * 3_600_000);
    expect(await e.IMPORTS.get(part!.file_key)).toBeNull();
    expect(
      await one('SELECT file_key, token_hash FROM email_check_parts WHERE run_id = ?1', runId),
    ).toEqual({ file_key: null, token_hash: null });

    await stopRun(e.DB, runId, Date.now(), e.IMPORTS);
    expect((await loadRun(e.DB, runId))?.status).toBe('stopped');
    expect(
      await count('SELECT count(*) AS n FROM email_check_items WHERE run_id = ?1', runId),
    ).toBe(0);
  });
});

describe('an import that checks its addresses', () => {
  it('waits for the check, then skips red ones and lists them in the report', async () => {
    const seed = await allowedChannel();
    const csv = 'email\njan@example.org\nbad@example.org\ncatchall-1@example.org\n';
    const jobId = await seedImport(
      seed,
      csv,
      ['email'],
      { email: 'email' },
      { status: 'importing', consent: true },
    );
    await env.DB.prepare('UPDATE import_jobs SET check_addresses = 1 WHERE id = ?1')
      .bind(jobId)
      .run();
    const { env: e, queue } = checksEnv();

    await runImport(e, jobId);
    expect(
      await count('SELECT count(*) AS n FROM members WHERE channel_id = ?1', seed.channelId),
    ).toBe(0);
    const job = await one<{ email_check_run_id: string }>(
      'SELECT email_check_run_id FROM import_jobs WHERE id = ?1',
      jobId,
    );
    expect(job?.email_check_run_id).toMatch(/^vr_/);
    await drain(e, queue.items);
    expect(queue.items).toContainEqual({ type: 'import_run', jobId });
    await runImport(e, jobId);

    const members = await env.DB.prepare(
      'SELECT email, status FROM members WHERE channel_id = ?1 ORDER BY email',
    )
      .bind(seed.channelId)
      .all();
    expect(members.results).toEqual([
      { email: 'catchall-1@example.org', status: 'active' },
      { email: 'jan@example.org', status: 'active' },
    ]);
    const report = await one<{ r: string }>(
      'SELECT report_json AS r FROM import_jobs WHERE id = ?1',
      jobId,
    );
    expect(JSON.parse(report!.r).emailCheck).toMatchObject({
      skipped: 1,
      samples: [{ email: 'bad@example.org', reason: 'Email check: Will bounce.' }],
    });
  });
});

describe('background checks', () => {
  it('checks an added address and tags it per the rules for additions by hand', async () => {
    const seed = await allowedChannel();
    const memberId = await addMember(seed.channelId, 'bad-added@example.org');
    const { env: e } = checksEnv();
    await checkAddedAddresses(e, {
      workspaceId: seed.workspaceId,
      channelId: seed.channelId,
      memberIds: [memberId],
    });
    expect(
      await one('SELECT state, code FROM email_checks WHERE workspace_id = ?1', seed.workspaceId),
    ).toEqual({ state: 'red', code: 6 });
    expect(
      await count(
        `SELECT count(*) AS n FROM member_tags mt JOIN tags t ON t.id = mt.tag_id
          WHERE mt.member_id = ?1 AND t.name = 'email-red'`,
        memberId,
      ),
    ).toBe(1);
  });

  it('does nothing for a workspace the owner hasn’t allowed', async () => {
    const seed = await seedChannel();
    const memberId = await addMember(seed.channelId, 'x@example.org');
    const { env: e } = checksEnv();
    await checkAddedAddresses(e, {
      workspaceId: seed.workspaceId,
      channelId: seed.channelId,
      memberIds: [memberId],
    });
    expect(
      await count(
        'SELECT count(*) AS n FROM email_checks WHERE workspace_id = ?1',
        seed.workspaceId,
      ),
    ).toBe(0);
  });
});

describe('a signup checked once it is confirmed (S04-P3-TR-signup-check-after-confirmation)', () => {
  // Members who confirmed their signup, as the confirm route leaves them.
  const confirmedMember = async (channelId: string, email: string) => {
    const id = await addMember(channelId, email);
    await env.DB.prepare('UPDATE members SET confirmed_at = ?1 WHERE id = ?2')
      .bind(Date.now(), id)
      .run();
    return id;
  };

  async function withRules(signup: object, extra: object = {}) {
    const seed = await allowedChannel();
    await env.DB.prepare(
      'INSERT INTO email_check_settings (workspace_id, settings_json, updated_at) VALUES (?1, ?2, ?3)',
    )
      .bind(seed.workspaceId, JSON.stringify({ signup, ...extra }), Date.now())
      .run();
    return seed;
  }
  const suppressed = (channelId: string, email: string) =>
    count(
      'SELECT count(*) AS n FROM suppressions WHERE channel_id = ?1 AND email = ?2',
      channelId,
      email,
    );

  it('follows the signup rules: a refusal stops mailing them, a tag tags them', async () => {
    const seed = await withRules({ green: 'accept', orange: 'tag', red: 'refuse' });
    const red = await confirmedMember(seed.channelId, 'bad-confirmed@example.org');
    const orange = await confirmedMember(seed.channelId, 'catchall-confirmed@example.org');
    const green = await confirmedMember(seed.channelId, 'fine-confirmed@example.org');
    const { env: e } = checksEnv();
    await checkAddedAddresses(e, {
      workspaceId: seed.workspaceId,
      channelId: seed.channelId,
      memberIds: [red, orange, green],
      confirmed: true,
    });
    expect(await suppressed(seed.channelId, 'bad-confirmed@example.org')).toBe(1);
    expect(await suppressed(seed.channelId, 'fine-confirmed@example.org')).toBe(0);
    expect(
      await count(
        `SELECT count(*) AS n FROM member_tags mt JOIN tags t ON t.id = mt.tag_id
          WHERE mt.member_id = ?1 AND t.name = 'email-orange'`,
        orange,
      ),
    ).toBe(1);
    // The rules for additions by hand (red: tag) are not the ones applied.
    expect(
      await count(
        `SELECT count(*) AS n FROM member_tags mt JOIN tags t ON t.id = mt.tag_id
          WHERE mt.member_id = ?1 AND t.name = 'email-red'`,
        red,
      ),
    ).toBe(0);
  });

  it('never stops mailing someone with a paid subscription', async () => {
    const seed = await withRules({ green: 'accept', orange: 'accept', red: 'refuse' });
    const red = await confirmedMember(seed.channelId, 'bad-paying@example.org');
    await env.DB.prepare(
      `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at)
       VALUES (?1, ?2, 'paid', 'comp', ?3)`,
    )
      .bind(red, seed.channelId, Date.now())
      .run();
    const { env: e } = checksEnv();
    await checkAddedAddresses(e, {
      workspaceId: seed.workspaceId,
      channelId: seed.channelId,
      memberIds: [red],
      confirmed: true,
    });
    expect(await suppressed(seed.channelId, 'bad-paying@example.org')).toBe(0);
  });

  it('runs even with checks for additions by hand off, and not when the publisher turned it off', async () => {
    const on = await withRules(
      { green: 'accept', orange: 'accept', red: 'refuse' },
      { checkManual: false },
    );
    const a = await confirmedMember(on.channelId, 'bad-on@example.org');
    const { env: e } = checksEnv();
    await checkAddedAddresses(e, {
      workspaceId: on.workspaceId,
      channelId: on.channelId,
      memberIds: [a],
      confirmed: true,
    });
    expect(await suppressed(on.channelId, 'bad-on@example.org')).toBe(1);

    const off = await withRules(
      { green: 'accept', orange: 'accept', red: 'refuse' },
      { checkConfirmed: false },
    );
    const b = await confirmedMember(off.channelId, 'bad-off@example.org');
    await checkAddedAddresses(e, {
      workspaceId: off.workspaceId,
      channelId: off.channelId,
      memberIds: [b],
      confirmed: true,
    });
    expect(
      await count(
        'SELECT count(*) AS n FROM email_checks WHERE workspace_id = ?1',
        off.workspaceId,
      ),
    ).toBe(0);
  });

  it('ignores the confirmed claim for someone who never confirmed', async () => {
    const seed = await allowedChannel();
    const unconfirmed = await addMember(seed.channelId, 'bad-never-confirmed@example.org');
    const { env: e } = checksEnv();
    await checkAddedAddresses(e, {
      workspaceId: seed.workspaceId,
      channelId: seed.channelId,
      memberIds: [unconfirmed],
      confirmed: true,
    });
    expect(
      await count(
        'SELECT count(*) AS n FROM email_checks WHERE workspace_id = ?1',
        seed.workspaceId,
      ),
    ).toBe(0);
  });
});

describe('a forged or corrupted email_check message (S04-P1-V-forged-email-check)', () => {
  it('a Channel of another workspace gets no check, no tag and no stored result', async () => {
    const allowed = await allowedChannel();
    const other = await seedChannel();
    const victim = await addMember(other.channelId, 'bad-victim@example.org');
    const { env: e } = checksEnv();
    await checkAddedAddresses(e, {
      workspaceId: allowed.workspaceId,
      channelId: other.channelId,
      memberIds: [victim],
    });
    expect(
      await count(
        'SELECT count(*) AS n FROM email_checks WHERE workspace_id = ?1',
        allowed.workspaceId,
      ),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS n FROM tags WHERE channel_id = ?1', other.channelId),
    ).toBe(0);
    expect(await count('SELECT count(*) AS n FROM member_tags WHERE member_id = ?1', victim)).toBe(
      0,
    );
  });

  it('only addresses of the Channel’s own Members are checked', async () => {
    const seed = await allowedChannel();
    const other = await allowedChannel();
    const mine = await addMember(seed.channelId, 'bad-mine@example.org');
    const stranger = await addMember(other.channelId, 'bad-stranger@example.org');
    const { env: e } = checksEnv();
    await checkAddedAddresses(e, {
      workspaceId: seed.workspaceId,
      channelId: seed.channelId,
      memberIds: [mine, stranger],
    });
    const checked = await env.DB.prepare(
      'SELECT email FROM email_checks WHERE workspace_id = ?1 ORDER BY email',
    )
      .bind(seed.workspaceId)
      .all<{ email: string }>();
    expect(checked.results.map((r) => r.email)).toEqual(['bad-mine@example.org']);
  });
});

describe('background check messages', () => {
  it('name Members, never addresses, and end cleanly for an erased Member', async () => {
    const seed = await allowedChannel();
    const memberId = await addMember(seed.channelId, 'bad-msg@example.org');
    const { env: e } = checksEnv();
    const message: JobMessage = {
      type: 'email_check',
      workspaceId: seed.workspaceId,
      channelId: seed.channelId,
      memberIds: [memberId],
    };
    expect(JSON.stringify(message)).not.toContain('@');
    await env.DB.prepare('DELETE FROM members WHERE id = ?1').bind(memberId).run();
    await checkAddedAddresses(e, message);
    expect(
      await count(
        'SELECT count(*) AS n FROM email_checks WHERE workspace_id = ?1',
        seed.workspaceId,
      ),
    ).toBe(0);
  });

  it("never checks another workspace's Channel", async () => {
    const seed = await allowedChannel();
    const other = await allowedChannel();
    const memberId = await addMember(other.channelId, 'bad-other@example.org');
    const { env: e } = checksEnv();
    await checkAddedAddresses(e, {
      workspaceId: seed.workspaceId,
      channelId: other.channelId,
      memberIds: [memberId],
    });
    for (const workspaceId of [seed.workspaceId, other.workspaceId]) {
      expect(
        await count('SELECT count(*) AS n FROM email_checks WHERE workspace_id = ?1', workspaceId),
      ).toBe(0);
    }
  });

  it('ignores addresses in a message: only Member ids are read', async () => {
    const seed = await allowedChannel();
    await addMember(seed.channelId, 'bad-legacy@example.org');
    const { env: e } = checksEnv();
    await checkAddedAddresses(e, {
      workspaceId: seed.workspaceId,
      channelId: seed.channelId,
      emails: ['bad-legacy@example.org'],
    } as Parameters<typeof checkAddedAddresses>[1]);
    expect(
      await count(
        'SELECT count(*) AS n FROM email_checks WHERE workspace_id = ?1',
        seed.workspaceId,
      ),
    ).toBe(0);
  });

  it('"Check again" needs a stored request; a forged force flag is not honoured', async () => {
    const seed = await allowedChannel();
    const memberId = await addMember(seed.channelId, 'bad-again@example.org');
    // The workspace checks no additions by hand.
    await env.DB.prepare(
      `INSERT INTO email_check_settings (workspace_id, settings_json, updated_at)
       VALUES (?1, '{"checkManual":false}', 0)
       ON CONFLICT (workspace_id) DO UPDATE SET settings_json = '{"checkManual":false}'`,
    )
      .bind(seed.workspaceId)
      .run();
    const { env: e } = checksEnv();
    const results = () =>
      count('SELECT count(*) AS n FROM email_checks WHERE workspace_id = ?1', seed.workspaceId);
    await checkAddedAddresses(e, {
      workspaceId: seed.workspaceId,
      channelId: seed.channelId,
      memberIds: [memberId],
      force: true,
    } as Parameters<typeof checkAddedAddresses>[1]);
    expect(await results()).toBe(0);
    // A request id that names no stored row does nothing either.
    await checkAddedAddresses(e, {
      workspaceId: seed.workspaceId,
      channelId: seed.channelId,
      requestId: 'eq_forged',
    });
    expect(await results()).toBe(0);

    // The stored request, as the api writes it, is checked once and used up.
    const requestId = newId('emailCheckRequest');
    await env.DB.prepare(
      `INSERT INTO email_check_requests (id, workspace_id, channel_id, member_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(requestId, seed.workspaceId, seed.channelId, memberId, Date.now())
      .run();
    // The message's own ids are not what counts: the row's are.
    await checkAddedAddresses(e, { workspaceId: 'ws_x', channelId: 'ch_x', requestId });
    expect(await results()).toBe(1);
    expect(
      await count('SELECT count(*) AS n FROM email_check_requests WHERE id = ?1', requestId),
    ).toBe(0);
  });
});

describe('leases', () => {
  it('holds five calls at once, and background work leaves the last place to signups', async () => {
    await env.DB.prepare('DELETE FROM email_check_leases').run();
    const now = Date.now();
    const background = [];
    for (let i = 0; i < 5; i++) background.push(await takeLease(env.DB, 'background', now));
    expect(background.filter(Boolean)).toHaveLength(4);
    const signup = await takeLease(env.DB, 'signup', now);
    expect(signup).not.toBeNull();
    expect(await takeLease(env.DB, 'signup', now)).toBeNull();
    await releaseLease(env.DB, signup as string);
    expect(await takeLease(env.DB, 'signup', now)).not.toBeNull();
    // Leases end on their own.
    expect(await takeLease(env.DB, 'background', now + 60_000)).not.toBeNull();
  });
});
