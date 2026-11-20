/**
 * Email checks (flag email_verification; docs/email-verification.md). Every address gets one of
 * three colours from DeBounce's result code, kept once per workspace (email_checks), so the same
 * address in two publications costs one credit. Tables: migrations/0068_email_verification.sql.
 *
 * - Credits first: Swarm's own free checks (syntax, its disposable list, role addresses) run
 *   before DeBounce, and settle the address without a credit when they find something.
 * - Signup forms ask DeBounce while the person waits, for at most SIGNUP_BUDGET_MS. Anything that
 *   goes wrong (slow, down, out of credits, busy) lets them in, unchecked: a signup is never lost.
 * - Lists are checked by a run: planned first (how many addresses, how many credits), then sent in
 *   parts of EMAIL_CHECK_PART_SIZE through the bulk API, one part at a time, because DeBounce runs
 *   one bulk list per account. Stopping sends no further part; the part DeBounce has finishes and
 *   is applied, since DeBounce can't cancel one. Small runs ask one address at a time.
 * - At most DEBOUNCE_MAX_CONCURRENT single calls run at once across the install (DeBounce's own
 *   limit), through leases in D1. Background calls leave the last place to signup forms.
 */
import {
  DEBOUNCE_MAX_CONCURRENT,
  EMAIL_CHECK_CODES,
  EMAIL_CHECK_FILE_HOURS,
  EMAIL_CHECK_PART_SIZE,
  EMAIL_CHECK_RUN_FINAL,
  EMAIL_CHECK_SINGLE_MAX,
  EmailSchema,
  colourOfCode,
  emailCheckSettings,
  emailCheckTag,
  isEmailCheckCode,
  newId,
  windowEnd,
  windowStart,
  type EmailCheckAccess,
  type EmailCheckAction,
  type EmailCheckCode,
  type EmailCheckColour,
  type EmailCheckOrigin,
  type EmailCheckRun,
  type EmailCheckRunStatus,
  type EmailCheckScope,
  type EmailCheckSettings,
  type EmailCheckSource,
  type MemberEmailCheck,
} from '@swarm/domain';
import { sha256Hex } from '@swarm/db';
import { D1FlagStore, FlagService } from '@swarm/flags';
import { base64UrlEncode } from '@swarm/tokens';
import { isDisposableAddress, isRoleAddress } from './addresses';
import { enqueueChannelCircleRefresh } from './circles';
import { all, first, run, toIso } from './db';
import {
  DebounceError,
  debounceResultsLimit,
  parseBulkResults,
  type DebounceClient,
  type DebounceEnv,
  type DebounceResult,
} from './debounce';
import type { JobQueue } from './jobs';
import { ensureTags, tagStatements } from './members';
import { takeUsage, usageOf } from './usage';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A signup waits at most this long for DeBounce, lease included. */
export const SIGNUP_BUDGET_MS = 4000;
/** A lease ends by itself after this, so a worker that died can't hold a place. */
const LEASE_MS = 20_000;
/** Background single calls give up after this. */
const BACKGROUND_TIMEOUT_MS = 12_000;
/** A part DeBounce hasn't finished after this long is given up. */
const PART_GIVE_UP_MS = 7 * DAY_MS;
/** Addresses a small run asks about per step (about ten seconds at four at a time). */
const SINGLE_PER_STEP = 40;
/**
 * How long a worker holds a part it is sending (claimed_until, 0140): far longer than an upload or
 * a small run's step takes, so only a worker that died loses it.
 */
const PART_CLAIM_MS = 10 * 60_000;
/**
 * Tries a small run gives one address (a temporary refusal by DeBounce, an answer it can't read,
 * or no free place to ask in time) before it stays "not checked" and the run goes on.
 */
export const SINGLE_ATTEMPTS = 3;
/** Members read per planning query, and queries per invocation. */
const PLAN_BATCH = 500;
const PLAN_BATCHES = 20;
/** Statuses that may still be mailed: the ones worth a credit. */
export const CHECKED_STATUSES = "('pending', 'active', 'paused')";

/** A result counts for this long. Months are 30 days. */
export const validForMs = (months: number) => months * 30 * DAY_MS;

// ---- Access ---------------------------------------------------------------------------------

/**
 * Why a workspace may spend the install's DeBounce credits (the site_code_rules shape). Only rows
 * an instance admin wrote count, never an owner seat (see site-code-rules.ts).
 */
export async function emailCheckAccess(
  db: D1Database,
  workspaceId: string,
): Promise<EmailCheckAccess> {
  const row = await first<{ allowed: number; every: number }>(
    db,
    `SELECT
       EXISTS (SELECT 1 FROM email_check_workspaces WHERE workspace_id = ?1) AS allowed,
       EXISTS (SELECT 1 FROM email_check_rules WHERE id = 1 AND every_workspace = 1) AS every`,
    workspaceId,
  );
  if (row?.allowed) return 'allowed';
  if (row?.every) return 'every_workspace';
  return 'not_allowed';
}

export interface EmailCheckAvailability {
  enabled: boolean;
  keySet: boolean;
  access: EmailCheckAccess;
  available: boolean;
}

export async function emailCheckAvailability(
  db: D1Database,
  env: DebounceEnv,
  workspaceId: string,
  channelId?: string,
): Promise<EmailCheckAvailability> {
  const [enabled, access] = await Promise.all([
    new FlagService(new D1FlagStore(db)).enabled('email_verification', {
      workspaceId,
      ...(channelId ? { channelId } : {}),
    }),
    emailCheckAccess(db, workspaceId),
  ]);
  const keySet = !!env.DEBOUNCE_API_KEY;
  return { enabled, keySet, access, available: enabled && keySet && access !== 'not_allowed' };
}

// ---- Settings -------------------------------------------------------------------------------

export async function readEmailCheckSettings(
  db: D1Database,
  workspaceId: string,
): Promise<EmailCheckSettings> {
  const row = await first<{ settings_json: string }>(
    db,
    'SELECT settings_json FROM email_check_settings WHERE workspace_id = ?1',
    workspaceId,
  );
  return emailCheckSettings(row ? JSON.parse(row.settings_json) : null);
}

export async function saveEmailCheckSettings(
  db: D1Database,
  workspaceId: string,
  settings: EmailCheckSettings,
  operatorId: string | null,
  now = Date.now(),
): Promise<void> {
  await run(
    db,
    `INSERT INTO email_check_settings (workspace_id, settings_json, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (workspace_id) DO UPDATE SET settings_json = excluded.settings_json,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    workspaceId,
    JSON.stringify(settings),
    operatorId,
    now,
  );
}

// ---- Swarm's own checks ---------------------------------------------------------------------

/**
 * What Swarm can tell for free: not an address (1), a disposable provider on its list (3), a role
 * address (8). Null when the address needs DeBounce.
 */
export function localCheck(email: string): EmailCheckCode | null {
  if (!EmailSchema.safeParse(email).success) return 1;
  if (isDisposableAddress(email)) return 3;
  if (isRoleAddress(email)) return 8;
  return null;
}

// ---- Results --------------------------------------------------------------------------------

export interface CheckResult {
  email: string;
  code: EmailCheckCode;
  reason: string | null;
  didYouMean: string | null;
  source: EmailCheckSource;
}

const fromDebounce = (r: DebounceResult): CheckResult => ({
  email: r.email.toLowerCase(),
  code: r.code,
  reason: r.reason,
  didYouMean: r.didYouMean,
  source: 'debounce',
});

const fromLocal = (email: string, code: EmailCheckCode): CheckResult => ({
  email: email.toLowerCase(),
  code,
  reason: null,
  didYouMean: null,
  source: 'swarm',
});

const UPSERT_CHECKS = `INSERT INTO email_checks (workspace_id, email, state, code, reason, did_you_mean, source, checked_at)
  SELECT ?1, json_extract(j.value, '$.e'), json_extract(j.value, '$.s'), json_extract(j.value, '$.c'),
         json_extract(j.value, '$.r'), json_extract(j.value, '$.d'), json_extract(j.value, '$.o'), ?3
    FROM json_each(?2) j WHERE length(json_extract(j.value, '$.e')) BETWEEN 3 AND 254
  ON CONFLICT (workspace_id, email) DO UPDATE SET state = excluded.state, code = excluded.code,
    reason = excluded.reason, did_you_mean = excluded.did_you_mean, source = excluded.source,
    checked_at = excluded.checked_at`;

const packed = (results: CheckResult[]) =>
  JSON.stringify(
    results.map((r) => ({
      e: r.email,
      s: colourOfCode(r.code),
      c: r.code,
      r: r.reason,
      d: r.didYouMean,
      o: r.source,
    })),
  );

/** Statements that store results, 400 addresses per statement. */
export function recordCheckStatements(
  db: D1Database,
  workspaceId: string,
  results: CheckResult[],
  now: number,
): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < results.length; i += 400) {
    out.push(db.prepare(UPSERT_CHECKS).bind(workspaceId, packed(results.slice(i, i + 400)), now));
  }
  return out;
}

export async function recordChecks(
  db: D1Database,
  workspaceId: string,
  results: CheckResult[],
  now = Date.now(),
): Promise<void> {
  const statements = recordCheckStatements(db, workspaceId, results, now);
  if (statements.length) await db.batch(statements);
}

export interface EmailCheckRow {
  email: string;
  state: EmailCheckColour;
  code: number;
  did_you_mean: string | null;
  source: EmailCheckSource;
  checked_at: number;
}

export function toMemberEmailCheck(
  row: EmailCheckRow,
  validMonths: number,
  now: number,
): MemberEmailCheck {
  const code = isEmailCheckCode(row.code) ? row.code : null;
  return {
    state: row.state,
    code,
    reason: code ? EMAIL_CHECK_CODES[code].label : 'Checked',
    didYouMean: row.did_you_mean,
    source: row.source,
    checkedAt: toIso(row.checked_at),
    stale: row.checked_at < now - validForMs(validMonths),
  };
}

/** The results of these addresses in a workspace, by address. */
export async function readChecks(
  db: D1Database,
  workspaceId: string,
  emails: string[],
  validMonths: number,
  now = Date.now(),
): Promise<Map<string, MemberEmailCheck>> {
  if (!emails.length) return new Map();
  const rows = await all<EmailCheckRow>(
    db,
    `SELECT email, state, code, did_you_mean, source, checked_at FROM email_checks
      WHERE workspace_id = ?1 AND email IN (SELECT value FROM json_each(?2))`,
    workspaceId,
    JSON.stringify([...new Set(emails.map((e) => e.toLowerCase()))]),
  );
  return new Map(rows.map((row) => [row.email, toMemberEmailCheck(row, validMonths, now)]));
}

// ---- One place in DeBounce's line -----------------------------------------------------------

export type LeasePriority = 'signup' | 'background';

/** A place among the DEBOUNCE_MAX_CONCURRENT calls, or null when they are all taken. */
export async function takeLease(
  db: D1Database,
  priority: LeasePriority,
  now = Date.now(),
): Promise<string | null> {
  const id = crypto.randomUUID();
  const limit = priority === 'signup' ? DEBOUNCE_MAX_CONCURRENT : DEBOUNCE_MAX_CONCURRENT - 1;
  // D1 runs one write at a time, so the count and the insert can't interleave with another's.
  const [, inserted] = await db.batch([
    db.prepare('DELETE FROM email_check_leases WHERE expires_at <= ?1').bind(now),
    db
      .prepare(
        `INSERT INTO email_check_leases (id, priority, expires_at) SELECT ?1, ?2, ?3
          WHERE (SELECT count(*) FROM email_check_leases WHERE expires_at > ?4) < ?5`,
      )
      .bind(id, priority, now + LEASE_MS, now, limit),
  ]);
  return inserted?.meta.changes ? id : null;
}

export async function releaseLease(db: D1Database, id: string): Promise<void> {
  await run(db, 'DELETE FROM email_check_leases WHERE id = ?1', id);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks DeBounce about one address within a lease. Null when no place came free before the
 * deadline. DebounceError for DeBounce's own refusals.
 */
async function verifyLeased(
  db: D1Database,
  debounce: DebounceClient,
  email: string,
  priority: LeasePriority,
  deadline: number,
): Promise<DebounceResult | null> {
  let lease: string | null = null;
  while (!lease) {
    lease = await takeLease(db, priority);
    if (lease) break;
    if (Date.now() + 250 >= deadline - 1000) return null;
    await sleep(250);
  }
  try {
    return await debounce.verify(email, { timeoutMs: Math.max(1000, deadline - Date.now()) });
  } finally {
    await releaseLease(db, lease).catch(() => undefined);
  }
}

// ---- A workspace's share ---------------------------------------------------------------------

/**
 * Single DeBounce checks (signups, additions by hand, "Check again") one workspace may spend per
 * UTC day unless an instance admin set its own number (email_check_budgets). The credits are the
 * install owner's and shared by every granted workspace, so one workspace's form traffic can't
 * use them all. Owner decision: the right default depends on the install's credits.
 */
export const EMAIL_CHECK_DAILY_CHECKS = 200;
/** "Check again" asks DeBounce only when the address's result is older than this. */
export const EMAIL_CHECK_RECHECK_AFTER_MS = 60 * 60 * 1000;
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const budgetScope = (workspaceId: string) => `email_check:${workspaceId}`;

/** A workspace's daily single checks. */
export async function emailCheckDailyChecks(db: D1Database, workspaceId: string): Promise<number> {
  const row = await first<{ daily_checks: number }>(
    db,
    'SELECT daily_checks FROM email_check_budgets WHERE workspace_id = ?1',
    workspaceId,
  );
  return row?.daily_checks ?? EMAIL_CHECK_DAILY_CHECKS;
}

/** What a workspace has spent of its single checks today. */
export async function emailCheckBudget(
  db: D1Database,
  workspaceId: string,
  now = Date.now(),
): Promise<{ dailyChecks: number; usedToday: number; exhausted: boolean }> {
  const [dailyChecks, used] = await Promise.all([
    emailCheckDailyChecks(db, workspaceId),
    usageOf(db, { scope: budgetScope(workspaceId), windowMs: DAY_WINDOW_MS, now }),
  ]);
  const usedToday = Math.min(used, dailyChecks);
  return { dailyChecks, usedToday, exhausted: used >= dailyChecks };
}

// ---- A workspace's share of checks of a list --------------------------------------------------

/**
 * Addresses one workspace's checks of a list (bulk runs, and imports that check their addresses)
 * may send to DeBounce per calendar month (UTC), unless an instance admin set its own number
 * (email_check_list_budgets). Counted like single checks, against the same install credits
 * (security review S04-P3-TR-list-check-tenant-budget). Owner decision: the right default depends
 * on the install's credits.
 */
export const EMAIL_CHECK_MONTHLY_LIST_CHECKS = 25_000;
const listScope = (workspaceId: string) => `email_check_list:${workspaceId}`;

/** A workspace's monthly list checks. */
export async function emailCheckListChecks(db: D1Database, workspaceId: string): Promise<number> {
  const row = await first<{ monthly_checks: number }>(
    db,
    'SELECT monthly_checks FROM email_check_list_budgets WHERE workspace_id = ?1',
    workspaceId,
  );
  return row?.monthly_checks ?? EMAIL_CHECK_MONTHLY_LIST_CHECKS;
}

export interface ListBudget {
  monthlyChecks: number;
  usedThisMonth: number;
  left: number;
  /** When the month ends and the count starts again, in ms. */
  resetsAt: number;
}

/** What a workspace has used of its list checks this month. */
export async function emailCheckListBudget(
  db: D1Database,
  workspaceId: string,
  now = Date.now(),
): Promise<ListBudget> {
  const month = windowStart('month', now);
  const [monthlyChecks, row] = await Promise.all([
    emailCheckListChecks(db, workspaceId),
    first<{ count: number }>(
      db,
      'SELECT count FROM usage_windows WHERE scope = ?1 AND window_start = ?2',
      listScope(workspaceId),
      month,
    ),
  ]);
  const usedThisMonth = row?.count ?? 0;
  return {
    monthlyChecks,
    usedThisMonth,
    left: Math.max(0, monthlyChecks - usedThisMonth),
    resetsAt: windowEnd('month', now),
  };
}

/** A check of a list needs more of the workspace's monthly list checks than are left. */
export class EmailCheckBudgetError extends Error {
  constructor(
    readonly needed: number,
    readonly budget: ListBudget,
  ) {
    super(
      `This check needs ${needed.toLocaleString('en')} DeBounce credits, and this workspace has ${budget.left.toLocaleString('en')} of its ${budget.monthlyChecks.toLocaleString('en')} list checks left this month (they start again on ${new Date(budget.resetsAt).toISOString().slice(0, 10)}, UTC). Check fewer addresses (a segment, or only those never checked), or ask the owner of this Swarm for more.`,
    );
    this.name = 'EmailCheckBudgetError';
  }
}

/**
 * Takes `amount` list checks for this month in one statement, only if they all fit; false (and
 * nothing taken) when they don't.
 */
async function takeListChecks(
  db: D1Database,
  workspaceId: string,
  amount: number,
  now: number,
): Promise<{ ok: boolean; month: number }> {
  const month = windowStart('month', now);
  const limit = await emailCheckListChecks(db, workspaceId);
  if (amount > limit) return { ok: false, month };
  const row = await first<{ count: number }>(
    db,
    `INSERT INTO usage_windows (scope, window_start, count) VALUES (?1, ?2, ?3)
     ON CONFLICT (scope) DO UPDATE SET
       count = CASE WHEN usage_windows.window_start = excluded.window_start
                    THEN usage_windows.count + excluded.count ELSE excluded.count END,
       window_start = excluded.window_start
     WHERE usage_windows.window_start <> excluded.window_start
        OR usage_windows.count + excluded.count <= ?4
     RETURNING count`,
    listScope(workspaceId),
    month,
    amount,
    limit,
  );
  return { ok: row !== null, month };
}

/** Gives `amount` list checks back to the month they were taken from. */
function listChecksBack(db: D1Database, workspaceId: string, amount: number, month: number) {
  return db
    .prepare(
      `UPDATE usage_windows SET count = max(0, count - ?1) WHERE scope = ?2 AND window_start = ?3`,
    )
    .bind(amount, listScope(workspaceId), month);
}

/**
 * Gives back what a stopped run took for addresses it never sent, to the month it took them from
 * (a month that has ended keeps its count), and only once: the run's budget_taken goes down too.
 */
async function giveBackUnsent(db: D1Database, runId: string): Promise<void> {
  const row = await first<{
    workspace_id: string;
    budget_taken: number;
    budget_month: number | null;
    unsent: number;
  }>(
    db,
    `SELECT r.workspace_id, r.budget_taken, r.budget_month,
            (SELECT count(*) FROM email_check_items i
              WHERE i.run_id = r.id
                AND (i.part = ${PART_WAITING}
                     OR i.part IN (SELECT p.part FROM email_check_parts p
                                    WHERE p.run_id = r.id AND p.status = 'waiting'))) AS unsent
       FROM email_check_runs r WHERE r.id = ?1`,
    runId,
  );
  if (!row || row.budget_month === null || row.budget_taken <= 0 || row.unsent <= 0) return;
  const back = Math.min(row.unsent, row.budget_taken);
  await db.batch([
    listChecksBack(db, row.workspace_id, back, row.budget_month),
    db
      .prepare('UPDATE email_check_runs SET budget_taken = budget_taken - ?1 WHERE id = ?2')
      .bind(back, runId),
  ]);
}

/** Takes one of the workspace's single checks for today; false when they are used up. */
async function takeCheck(db: D1Database, workspaceId: string, now: number): Promise<boolean> {
  const limit = await emailCheckDailyChecks(db, workspaceId);
  const take = await takeUsage(db, {
    scope: budgetScope(workspaceId),
    windowMs: DAY_WINDOW_MS,
    limit,
    now,
  });
  return take.ok;
}

// ---- Signup forms ---------------------------------------------------------------------------

export interface SignupCheck {
  result: CheckResult;
  colour: EmailCheckColour;
  action: EmailCheckAction;
  /**
   * Whether the form may tell the visitor what was found. Always for Swarm's own free checks
   * (anyone can tell an address is malformed); for DeBounce's verdict only when the publisher
   * chose to show it (showSignupVerdict). Otherwise a refusal is answered like any signup.
   */
  reveal: boolean;
}

export interface SignupCheckDeps {
  db: D1Database;
  env: DebounceEnv;
  debounce: DebounceClient | null;
  now?: () => number;
}

/**
 * The check a signup form makes before it answers, or null: off, unavailable, or DeBounce slow,
 * down, out of credits or busy. Null always means "let them in, not checked". Nothing is stored
 * here: the result is kept only for someone who joins (`afterJoin`).
 */
export async function checkSignup(
  deps: SignupCheckDeps,
  input: { workspaceId: string; channelId: string; email: string },
): Promise<SignupCheck | null> {
  if (!deps.debounce) return null;
  const availability = await emailCheckAvailability(
    deps.db,
    deps.env,
    input.workspaceId,
    input.channelId,
  );
  if (!availability.available) return null;
  const settings = await readEmailCheckSettings(deps.db, input.workspaceId);
  if (!settings.checkSignups) return null;
  const local = localCheck(input.email);
  let result: CheckResult;
  const started = deps.now ? deps.now() : Date.now();
  const known =
    local === null
      ? (
          await readChecks(deps.db, input.workspaceId, [input.email], settings.validMonths, started)
        ).get(input.email.toLowerCase())
      : undefined;
  if (local !== null) {
    result = fromLocal(input.email, local);
  } else if (known && !known.stale && known.code !== null && isEmailCheckCode(known.code)) {
    // A result that still counts is reused: the same address costs one credit, not one per post.
    result = {
      email: input.email,
      code: known.code,
      reason: known.reason,
      didYouMean: known.didYouMean,
      source: known.source,
    };
  } else {
    // Past the workspace's share for today the signup passes unchecked, as when DeBounce is down.
    if (!(await takeCheck(deps.db, input.workspaceId, started))) return null;
    try {
      const answer = await verifyLeased(
        deps.db,
        deps.debounce,
        input.email,
        'signup',
        started + SIGNUP_BUDGET_MS,
      );
      if (!answer) return null;
      result = fromDebounce(answer);
    } catch (error) {
      if (error instanceof DebounceError) return null;
      throw error;
    }
  }
  const colour = colourOfCode(result.code);
  return {
    result,
    colour,
    action: settings.signup[colour],
    reveal: result.source !== 'debounce' || settings.showSignupVerdict,
  };
}

/** Keeps a signup's result and tags them when the rule says so. */
export async function afterJoin(
  db: D1Database,
  input: { workspaceId: string; channelId: string; memberId: string | null; check: SignupCheck },
  now = Date.now(),
): Promise<void> {
  const statements = recordCheckStatements(db, input.workspaceId, [input.check.result], now);
  if (input.memberId && input.check.action === 'tag') {
    const tag = emailCheckTag(input.check.colour);
    const ids = await ensureTags(db, input.channelId, [tag], now);
    const tagId = ids.get(tag);
    if (tagId) statements.push(...tagStatements(db, input.memberId, [tagId], now));
  }
  await db.batch(statements);
}

// ---- In the background (added by hand or through the API) ------------------------------------

export interface BackgroundCheckDeps {
  db: D1Database;
  env: DebounceEnv;
  debounce: DebounceClient | null;
}

/**
 * Checks addresses someone just added (jobs worker, message `email_check`), and applies the
 * workspace's rules for additions by hand: accept, or accept and tag. Addresses with a result that
 * still counts are skipped unless `force` (the "Check again" button). Never throws for DeBounce.
 */
export async function runBackgroundChecks(
  deps: BackgroundCheckDeps,
  input: {
    workspaceId: string;
    channelId: string;
    memberIds: string[];
    /** "Check again": only from a stored email_check_requests row, never from a message. */
    force?: boolean;
    /** A signup they just confirmed: the signup rules apply (see confirmedAction). */
    confirmed?: boolean;
  },
  now = Date.now(),
): Promise<{ checked: number; skipped: number; failed: number }> {
  const out = { checked: 0, skipped: 0, failed: 0 };
  if (!deps.debounce) return out;
  // The Channel must be the workspace's own; the addresses come from its Members as they are now,
  // so a Member erased since the message was queued is simply not there.
  const members = await all<{ email: string }>(
    deps.db,
    `SELECT m.email FROM members m JOIN channels c ON c.id = m.channel_id
      WHERE m.channel_id = ?1 AND c.workspace_id = ?2 AND m.id IN (SELECT value FROM json_each(?3))
        -- Signup rules are for people who confirmed; a message can't claim it for anyone else.
        AND (?4 = 0 OR m.confirmed_at IS NOT NULL)`,
    input.channelId,
    input.workspaceId,
    JSON.stringify(input.memberIds.slice(0, 50)),
    input.confirmed ? 1 : 0,
  );
  if (!members.length) return out;
  const availability = await emailCheckAvailability(
    deps.db,
    deps.env,
    input.workspaceId,
    input.channelId,
  );
  if (!availability.available) return out;
  const settings = await readEmailCheckSettings(deps.db, input.workspaceId);
  if (input.confirmed ? !settings.checkConfirmed : !settings.checkManual && !input.force) {
    return out;
  }
  const emails = [...new Set(members.map((m) => m.email.trim().toLowerCase()))].slice(0, 50);
  const known = await readChecks(deps.db, input.workspaceId, emails, settings.validMonths, now);
  const results: CheckResult[] = [];
  for (const email of emails) {
    const existing = known.get(email);
    // "Check again" still waits a while after the last result, so it can't be pressed for credits.
    const recent = existing && Date.parse(existing.checkedAt) > now - EMAIL_CHECK_RECHECK_AFTER_MS;
    if (existing && ((!existing.stale && !input.force) || recent)) {
      out.skipped++;
      continue;
    }
    const local = localCheck(email);
    if (local !== null) {
      results.push(fromLocal(email, local));
      continue;
    }
    if (!(await takeCheck(deps.db, input.workspaceId, now))) {
      out.failed++;
      continue;
    }
    try {
      const answer = await verifyLeased(
        deps.db,
        deps.debounce,
        email,
        'background',
        Date.now() + BACKGROUND_TIMEOUT_MS,
      );
      if (answer) results.push(fromDebounce(answer));
      else out.failed++;
    } catch (error) {
      if (!(error instanceof DebounceError)) throw error;
      out.failed++;
    }
  }
  out.checked = results.length;
  if (!results.length) return out;
  const statements = recordCheckStatements(deps.db, input.workspaceId, results, now);
  const actionOf = (r: CheckResult): EmailCheckAction => {
    const colour = colourOfCode(r.code);
    return input.confirmed ? confirmedAction(settings.signup[colour]) : settings.manual[colour];
  };
  const tagged = results.filter((r) => actionOf(r) === 'tag');
  if (tagged.length) {
    const names = [...new Set(tagged.map((r) => emailCheckTag(colourOfCode(r.code))))];
    const ids = await ensureTags(deps.db, input.channelId, names, now);
    const members = await all<{ id: string; email: string }>(
      deps.db,
      'SELECT id, email FROM members WHERE channel_id = ?1 AND email IN (SELECT value FROM json_each(?2))',
      input.channelId,
      JSON.stringify(tagged.map((r) => r.email)),
    );
    const byEmail = new Map(members.map((m) => [m.email, m.id]));
    for (const r of tagged) {
      const memberId = byEmail.get(r.email);
      const tagId = ids.get(emailCheckTag(colourOfCode(r.code)));
      if (memberId && tagId) statements.push(...tagStatements(deps.db, memberId, [tagId], now));
    }
  }
  // Refused after confirming: no more mail for this publication, as "Stop mailing them" does for
  // red addresses, and never for someone with a paid subscription. Undone on the Sending page.
  for (const r of results.filter((r) => actionOf(r) === 'refuse')) {
    statements.push(
      deps.db
        .prepare(
          `INSERT INTO suppressions (id, workspace_id, channel_id, email, reason, detail, created_at)
           SELECT ?1, ?2, ?3, m.email, 'manual', ?4, ?5 FROM members m
            WHERE m.channel_id = ?3 AND m.email = ?6
              AND NOT EXISTS (SELECT 1 FROM member_entitlements me WHERE me.member_id = m.id
                                AND me.kind = 'paid' AND (me.expires_at IS NULL OR me.expires_at > ?5))
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          newId('suppression', now),
          input.workspaceId,
          input.channelId,
          `Email check: ${colourOfCode(r.code)}`,
          now,
          r.email,
        ),
    );
  }
  await deps.db.batch(statements);
  return out;
}

/**
 * A signup rule applied once the person has confirmed: there is nothing left to confirm, and a
 * refusal can no longer turn them away at the form, so it stops mailing them instead.
 */
export const confirmedAction = (action: EmailCheckAction): EmailCheckAction =>
  action === 'confirm' ? 'accept' : action;

/** The action a workspace's rules take for an address of this colour from this origin. */
export const ruleFor = (
  settings: EmailCheckSettings,
  origin: EmailCheckOrigin,
  colour: EmailCheckColour,
): EmailCheckAction => settings[origin][colour];

// ---- Runs -----------------------------------------------------------------------------------

export interface RunRow {
  id: string;
  workspace_id: string;
  scope: EmailCheckScope;
  channel_id: string | null;
  circle_id: string | null;
  import_id: string | null;
  only_never_checked: number;
  status: EmailCheckRunStatus;
  paused_reason: 'credits' | 'key' | null;
  error: string | null;
  method: 'bulk' | 'single';
  plan_cursor: string | null;
  addresses: number;
  fresh: number;
  local_results: number;
  to_check: number;
  parts: number;
  balance: number | null;
  current_part: number;
  checked: number;
  credits_used: number;
  green: number;
  orange: number;
  red: number;
  created_at: number;
  started_at: number | null;
  updated_at: number;
  completed_at: number | null;
  budget_taken: number;
  budget_month: number | null;
}

export const loadRun = (db: D1Database, runId: string) =>
  first<RunRow>(db, 'SELECT * FROM email_check_runs WHERE id = ?1', runId);

export async function toEmailCheckRun(db: D1Database, row: RunRow): Promise<EmailCheckRun> {
  const part =
    row.current_part > 0
      ? await first<{ percent: number }>(
          db,
          'SELECT percent FROM email_check_parts WHERE run_id = ?1 AND part = ?2',
          row.id,
          row.current_part,
        )
      : null;
  return {
    id: row.id,
    scope: row.scope,
    channelId: row.channel_id,
    circleId: row.circle_id,
    importId: row.import_id,
    onlyNeverChecked: row.only_never_checked === 1,
    status: row.status,
    pausedReason: row.paused_reason,
    error: row.error,
    plan: {
      addresses: row.addresses,
      fresh: row.fresh,
      local: row.local_results,
      toCheck: row.to_check,
      parts: row.parts,
      method: row.method,
    },
    balance: row.balance,
    progress: {
      part: row.current_part,
      parts: row.parts,
      checked: row.checked,
      creditsUsed: row.credits_used,
      partPercent: part?.percent ?? 0,
    },
    results: { green: row.green, orange: row.orange, red: row.red },
    createdAt: toIso(row.created_at),
    startedAt: row.started_at === null ? null : toIso(row.started_at),
    completedAt: row.completed_at === null ? null : toIso(row.completed_at),
  };
}

/** The workspace's run that isn't finished, if any: one at a time, as DeBounce runs one list. */
export const activeRun = (db: D1Database, workspaceId: string) =>
  first<RunRow>(
    db,
    `SELECT * FROM email_check_runs WHERE workspace_id = ?1
        AND status NOT IN ('completed', 'stopped', 'canceled', 'failed')
      ORDER BY created_at DESC LIMIT 1`,
    workspaceId,
  );

export const latestRun = (db: D1Database, workspaceId: string) =>
  first<RunRow>(
    db,
    `SELECT * FROM email_check_runs WHERE workspace_id = ?1 AND scope <> 'import'
      ORDER BY created_at DESC LIMIT 1`,
    workspaceId,
  );

export interface NewRun {
  workspaceId: string;
  scope: EmailCheckScope;
  channelId?: string | null;
  circleId?: string | null;
  importId?: string | null;
  onlyNeverChecked?: boolean;
  createdBy: string | null;
}

/** A new run, planning. The caller queues `email_check_plan`. */
export async function createRun(db: D1Database, input: NewRun, now = Date.now()): Promise<string> {
  const id = newId('emailCheckRun', now);
  await run(
    db,
    `INSERT INTO email_check_runs (id, workspace_id, scope, channel_id, circle_id, import_id,
       only_never_checked, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
    id,
    input.workspaceId,
    input.scope,
    input.channelId ?? null,
    input.circleId ?? null,
    input.importId ?? null,
    input.onlyNeverChecked ? 1 : 0,
    input.createdBy,
    now,
  );
  return id;
}

/** Addresses to plan from, a batch at a time; cursor null when there are no more. */
export type CandidateSource = (
  row: RunRow,
  cursor: string | null,
) => Promise<{ emails: string[]; cursor: string | null }>;

/** Subscribers who may be mailed, in the run's scope, by member id. */
export const memberCandidates: (db: D1Database) => CandidateSource =
  (db) => async (row, cursor) => {
    const rows = await all<{ id: string; email: string }>(
      db,
      `SELECT m.id, m.email FROM members m JOIN channels c ON c.id = m.channel_id
      WHERE c.workspace_id = ?1 AND m.status IN ${CHECKED_STATUSES} AND m.id > ?2
        AND (?3 IS NULL OR m.channel_id = ?3)
        AND (?4 IS NULL OR m.id IN (SELECT member_id FROM circle_members WHERE circle_id = ?4))
      ORDER BY m.id LIMIT ?5`,
      row.workspace_id,
      cursor ?? '',
      row.scope === 'workspace' ? null : row.channel_id,
      row.scope === 'segment' ? row.circle_id : null,
      PLAN_BATCH,
    );
    return {
      emails: rows.map((r) => r.email),
      cursor: rows.length === PLAN_BATCH ? (rows.at(-1)?.id ?? null) : null,
    };
  };

/** Item parts: waiting for DeBounce, settled by Swarm, skipped because still valid. */
const PART_WAITING = -1;
const PART_LOCAL = 0;
const PART_FRESH = -2;

export interface RunDeps {
  db: D1Database;
  debounce: DebounceClient | null;
  queue: JobQueue;
  /** Private bucket for the parts' files (IMPORTS). */
  files: R2Bucket;
  /** Where the api worker serves the files: APP_ORIGIN. */
  fileOrigin: string;
}

/**
 * One planning step: up to PLAN_BATCHES batches of addresses, sorted into still valid, settled by
 * Swarm and for DeBounce, then hands over to a fresh message. Finished planning counts the
 * credits, asks for the balance, and waits for the go-ahead (an import's check starts at once).
 */
export async function planRun(
  deps: RunDeps,
  runId: string,
  source: CandidateSource,
  now = Date.now(),
): Promise<'more' | 'done' | 'gone'> {
  const row = await loadRun(deps.db, runId);
  if (!row || row.status !== 'planning') return 'gone';
  const settings = await readEmailCheckSettings(deps.db, row.workspace_id);
  const freshAfter = row.only_never_checked ? 0 : now - validForMs(settings.validMonths);
  let cursor = row.plan_cursor;
  for (let n = 0; n < PLAN_BATCHES; n++) {
    const batch = await source(row, cursor);
    const emails = [...new Set(batch.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    if (emails.length) {
      const known = new Map(
        (
          await all<{ email: string; checked_at: number }>(
            deps.db,
            `SELECT email, checked_at FROM email_checks
              WHERE workspace_id = ?1 AND email IN (SELECT value FROM json_each(?2))`,
            row.workspace_id,
            JSON.stringify(emails),
          )
        ).map((r) => [r.email, r.checked_at]),
      );
      const items = emails.map((email) => {
        const at = known.get(email);
        if (at !== undefined && at >= freshAfter) return [email, PART_FRESH, null];
        const local = localCheck(email);
        return local === null ? [email, PART_WAITING, null] : [email, PART_LOCAL, local];
      });
      await run(
        deps.db,
        `INSERT INTO email_check_items (run_id, email, part, local_code)
         SELECT ?1, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]')
           FROM json_each(?2) j WHERE true
         ON CONFLICT (run_id, email) DO NOTHING`,
        runId,
        JSON.stringify(items),
      );
    }
    cursor = batch.cursor;
    if (cursor === null) break;
  }
  if (cursor !== null) {
    await run(
      deps.db,
      `UPDATE email_check_runs SET plan_cursor = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'planning'`,
      cursor,
      now,
      runId,
    );
    await deps.queue.send({ type: 'email_check_plan', runId });
    return 'more';
  }
  const counts = await all<{ part: number; n: number }>(
    deps.db,
    `SELECT CASE WHEN part > 0 THEN -1 ELSE part END AS part, count(*) AS n
       FROM email_check_items WHERE run_id = ?1 GROUP BY 1`,
    runId,
  );
  const n = (part: number) => counts.find((c) => c.part === part)?.n ?? 0;
  const toCheck = n(PART_WAITING);
  const method = toCheck <= EMAIL_CHECK_SINGLE_MAX ? 'single' : 'bulk';
  const parts =
    toCheck === 0 ? 0 : method === 'single' ? 1 : Math.ceil(toCheck / EMAIL_CHECK_PART_SIZE);
  let balance: number | null = null;
  if (deps.debounce && toCheck > 0) balance = await deps.debounce.balance().catch(() => null);
  // A duplicated plan message that finished at the same time changes nothing, and starts nothing.
  const planned = await first(
    deps.db,
    `UPDATE email_check_runs SET status = 'planned', plan_cursor = NULL, addresses = ?1, fresh = ?2,
            local_results = ?3, to_check = ?4, parts = ?5, method = ?6, balance = ?7, updated_at = ?8
      WHERE id = ?9 AND status = 'planning' RETURNING id`,
    n(PART_WAITING) + n(PART_LOCAL) + n(PART_FRESH),
    n(PART_FRESH),
    n(PART_LOCAL),
    toCheck,
    parts,
    method,
    balance,
    now,
    runId,
  );
  if (!planned) return 'gone';
  if (row.scope === 'import') {
    try {
      await startRun(deps, runId, now);
    } catch (error) {
      if (!(error instanceof EmailCheckBudgetError)) throw error;
      // Past the workspace's list checks: the import goes on without the check, as a signup does
      // past its share, and the import screen shows why.
      await run(
        deps.db,
        `UPDATE email_check_runs SET status = 'failed', error = ?1, updated_at = ?2
          WHERE id = ?3 AND status = 'planned'`,
        error.message,
        now,
        runId,
      );
      await finishRun(deps, runId, now);
    }
  }
  return 'done';
}

/** The go-ahead: Swarm's own results are stored, then the parts start. */
export async function startRun(
  deps: RunDeps,
  runId: string,
  now = Date.now(),
): Promise<RunRow | null> {
  const row = await loadRun(deps.db, runId);
  if (!row || row.status !== 'planned') return row;
  const locals = await all<{ email: string; local_code: number }>(
    deps.db,
    `SELECT email, local_code FROM email_check_items WHERE run_id = ?1 AND part = ${PART_LOCAL}`,
    runId,
  );
  const results = locals
    .filter((l) => isEmailCheckCode(l.local_code))
    .map((l) => fromLocal(l.email, l.local_code as EmailCheckCode));
  const tally = countColours(results);
  const finished = row.to_check === 0;
  // Every address it will send to DeBounce counts against the workspace's list checks this month,
  // taken in one go before anything is sent, so a run that doesn't fit never starts.
  let budgetMonth: number | null = null;
  if (!finished) {
    const take = await takeListChecks(deps.db, row.workspace_id, row.to_check, now);
    if (!take.ok) {
      // A second start of the same run (a duplicated plan message, a double click) that lost to
      // the first: the run is going, and what it needed was taken once.
      const latest = await loadRun(deps.db, runId);
      if (latest && latest.status !== 'planned') return latest;
      throw new EmailCheckBudgetError(
        row.to_check,
        await emailCheckListBudget(deps.db, row.workspace_id, now),
      );
    }
    budgetMonth = take.month;
  }
  const started = await deps.db.batch([
    ...recordCheckStatements(deps.db, row.workspace_id, results, now),
    deps.db
      .prepare(
        `UPDATE email_check_runs SET status = ?1, started_at = ?2, updated_at = ?2,
                completed_at = ?3, checked = checked + ?4, green = green + ?5,
                orange = orange + ?6, red = red + ?7, budget_taken = ?9, budget_month = ?10
          WHERE id = ?8 AND status = 'planned'`,
      )
      .bind(
        finished ? 'completed' : 'running',
        now,
        finished ? now : null,
        results.length,
        tally.green,
        tally.orange,
        tally.red,
        runId,
        finished ? 0 : row.to_check,
        budgetMonth,
      ),
  ]);
  if (!started.at(-1)?.meta.changes) {
    // Another start got there first and took the run's checks: ours go back, nothing more is sent.
    if (budgetMonth !== null) {
      await listChecksBack(deps.db, row.workspace_id, row.to_check, budgetMonth).run();
    }
    return loadRun(deps.db, runId);
  }
  if (finished) await finishRun(deps, runId, now);
  else await deps.queue.send({ type: 'email_check_run', runId });
  return loadRun(deps.db, runId);
}

function countColours(results: { code: EmailCheckCode }[]) {
  const tally = { green: 0, orange: 0, red: 0 };
  for (const r of results) tally[colourOfCode(r.code)]++;
  return tally;
}

/** Stops sending parts. A part at DeBounce still finishes and is applied. */
export async function stopRun(
  db: D1Database,
  runId: string,
  now = Date.now(),
  /** The parts' bucket, so a run that ends here drops its files at once (else the sweep does). */
  files?: R2Bucket,
): Promise<void> {
  const row = await loadRun(db, runId);
  if (!row) return;
  const forget = async () => {
    if (files) {
      const held = await all<{ file_key: string }>(
        db,
        'SELECT file_key FROM email_check_parts WHERE run_id = ?1 AND file_key IS NOT NULL',
        runId,
      );
      if (held.length) await files.delete(held.map((p) => p.file_key));
    }
    await giveBackUnsent(db, runId);
    await db.batch([
      db
        .prepare(
          `UPDATE email_check_parts SET file_key = NULL, token_hash = NULL, file_expires_at = NULL
            WHERE run_id = ?1 AND file_key IS NOT NULL`,
        )
        .bind(runId),
      db.prepare('DELETE FROM email_check_items WHERE run_id = ?1').bind(runId),
    ]);
  };
  if (row.status === 'planning' || row.status === 'planned') {
    await run(
      db,
      `UPDATE email_check_runs SET status = 'canceled', updated_at = ?1, completed_at = ?1 WHERE id = ?2`,
      now,
      runId,
    );
    await forget();
    return;
  }
  const atDebounce = await first(
    db,
    "SELECT 1 FROM email_check_parts WHERE run_id = ?1 AND status IN ('waiting', 'submitted')",
    runId,
  );
  if (row.status === 'running' && atDebounce) {
    await run(
      db,
      "UPDATE email_check_runs SET status = 'stopping', updated_at = ?1 WHERE id = ?2 AND status = 'running'",
      now,
      runId,
    );
  } else if (row.status === 'running' || row.status === 'paused' || row.status === 'stopping') {
    // Paused, or nothing at DeBounce: it ends now. A paused part's results are not waited for.
    await run(
      db,
      `UPDATE email_check_runs SET status = 'stopped', paused_reason = NULL, updated_at = ?1,
              completed_at = ?1 WHERE id = ?2`,
      now,
      runId,
    );
    await forget();
  }
}

/**
 * Files past their day, whatever their run is doing (paused, stopped, failed): deleted, and their
 * address stops working. The minute cron calls it, so no file outlives EMAIL_CHECK_FILE_HOURS.
 */
export async function dropExpiredFiles(
  db: D1Database,
  files: R2Bucket,
  now = Date.now(),
): Promise<number> {
  const due = await all<{ run_id: string; part: number; file_key: string }>(
    db,
    `SELECT run_id, part, file_key FROM email_check_parts
      WHERE file_key IS NOT NULL AND file_expires_at <= ?1 LIMIT 100`,
    now,
  );
  if (!due.length) return 0;
  await files.delete(due.map((d) => d.file_key));
  await db.batch(
    due.map((d) =>
      db
        .prepare(
          `UPDATE email_check_parts SET file_key = NULL, token_hash = NULL, file_expires_at = NULL
            WHERE run_id = ?1 AND part = ?2`,
        )
        .bind(d.run_id, d.part),
    ),
  );
  return due.length;
}

/** After credits were added (or the key fixed): carry on where it paused. */
export async function resumeRun(deps: RunDeps, runId: string, now = Date.now()): Promise<void> {
  const changed = await first(
    deps.db,
    `UPDATE email_check_runs SET status = 'running', paused_reason = NULL, error = NULL, updated_at = ?1
      WHERE id = ?2 AND status = 'paused' RETURNING id`,
    now,
    runId,
  );
  if (changed) await deps.queue.send({ type: 'email_check_run', runId });
}

const fileUrl = (origin: string, token: string) =>
  `${origin.replace(/\/$/, '')}/api/v1/public/email-check-lists/${token}.csv`;

/** The served file for a token from its URL, or null: wrong, used up or expired. */
export async function emailCheckFile(
  db: D1Database,
  files: R2Bucket,
  token: string,
  now = Date.now(),
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const part = await first<{ file_key: string | null; file_expires_at: number | null }>(
    db,
    `SELECT file_key, file_expires_at FROM email_check_parts
      WHERE token_hash = ?1 AND status IN ('waiting', 'submitted')`,
    await sha256Hex(token),
  );
  if (!part?.file_key || (part.file_expires_at ?? 0) <= now) return null;
  const object = await files.get(part.file_key);
  return object ? object.text() : null;
}

interface PartRow {
  part: number;
  status: 'waiting' | 'submitted' | 'done' | 'failed';
  list_id: string | null;
  file_key: string | null;
  submitted_at: number | null;
  file_expires_at: number | null;
}

/** Deletes a part's file and forgets its token, so the URL stops working. */
async function dropFile(deps: RunDeps, runId: string, part: PartRow): Promise<void> {
  if (part.file_key) await deps.files.delete(part.file_key);
  await run(
    deps.db,
    `UPDATE email_check_parts SET file_key = NULL, token_hash = NULL, file_expires_at = NULL
      WHERE run_id = ?1 AND part = ?2`,
    runId,
    part.part,
  );
}

async function pause(
  deps: RunDeps,
  runId: string,
  reason: 'credits' | 'key',
  now: number,
): Promise<void> {
  await run(
    deps.db,
    `UPDATE email_check_runs SET status = 'paused', paused_reason = ?1, updated_at = ?2
      WHERE id = ?3 AND status IN ('running', 'stopping')`,
    reason,
    now,
    runId,
  );
}

/** Stores results for a part's addresses (only those, whatever the file holds). */
async function applyResults(
  deps: RunDeps,
  row: RunRow,
  part: number,
  results: CheckResult[],
  creditsUsed: number,
  now: number,
): Promise<void> {
  const mine = new Set(
    (
      await all<{ email: string }>(
        deps.db,
        'SELECT email FROM email_check_items WHERE run_id = ?1 AND part = ?2',
        row.id,
        part,
      )
    ).map((r) => r.email),
  );
  const kept = results.filter((r) => mine.has(r.email));
  const tally = countColours(kept);
  await deps.db.batch([
    ...recordCheckStatements(deps.db, row.workspace_id, kept, now),
    deps.db
      .prepare(
        `UPDATE email_check_items SET done = 1 WHERE run_id = ?1 AND part = ?2
            AND email IN (SELECT value FROM json_each(?3))`,
      )
      .bind(row.id, part, JSON.stringify(kept.map((r) => r.email))),
    deps.db
      .prepare(
        `UPDATE email_check_runs SET checked = checked + ?1, credits_used = credits_used + ?2,
                green = green + ?3, orange = orange + ?4, red = red + ?5, updated_at = ?6
          WHERE id = ?7`,
      )
      .bind(kept.length, creditsUsed, tally.green, tally.orange, tally.red, now, row.id),
  ]);
}

/**
 * Claims a part that already exists for one worker until PART_CLAIM_MS from now, or false when
 * another worker holds it (a duplicated message, or the minute cron at the same time).
 */
async function claimPart(
  deps: RunDeps,
  runId: string,
  part: number,
  status: PartRow['status'],
  now: number,
): Promise<boolean> {
  const claimed = await first(
    deps.db,
    `UPDATE email_check_parts SET claimed_until = ?1
      WHERE run_id = ?2 AND part = ?3 AND status = ?4
        AND (claimed_until IS NULL OR claimed_until <= ?5)
      RETURNING part`,
    now + PART_CLAIM_MS,
    runId,
    part,
    status,
    now,
  );
  return claimed !== null;
}

async function releasePart(deps: RunDeps, runId: string, part: number): Promise<void> {
  await run(
    deps.db,
    'UPDATE email_check_parts SET claimed_until = NULL WHERE run_id = ?1 AND part = ?2',
    runId,
    part,
  );
}

/**
 * The next part: claimed by its row first (so two workers can't both make it, or both send it),
 * its addresses numbered, its file written, a fresh token made, then sent to DeBounce. A part whose
 * upload failed earlier is claimed again and sent with a new token: the old one was never kept.
 */
async function submitNextPart(
  deps: RunDeps,
  row: RunRow,
  debounce: DebounceClient,
  now: number,
): Promise<'submitted' | 'none' | 'paused' | 'wait'> {
  const number = row.current_part + 1;
  const expires = now + EMAIL_CHECK_FILE_HOURS * HOUR_MS;
  const existing = await first<PartRow>(
    deps.db,
    'SELECT part, status, list_id, file_key, submitted_at, file_expires_at FROM email_check_parts WHERE run_id = ?1 AND part = ?2',
    row.id,
    number,
  );
  if (existing && existing.status !== 'waiting') return 'wait';
  if (existing) {
    // Sent already, or being sent by another worker right now: nothing more to send.
    if (!(await claimPart(deps, row.id, number, 'waiting', now))) return 'wait';
    // No file: a worker died before writing it, or it expired while uploads kept failing. Write it
    // again from the addresses stored for the part, so the part doesn't wait forever.
    if (!existing.file_key && !(await writePartFile(deps, row, number))) {
      await releasePart(deps, row.id, number);
      return 'none';
    }
  } else {
    const left = await first(
      deps.db,
      `SELECT 1 FROM email_check_items WHERE run_id = ?1 AND part = ${PART_WAITING} LIMIT 1`,
      row.id,
    );
    if (!left) return 'none';
    const claimed = await first(
      deps.db,
      `INSERT INTO email_check_parts (run_id, part, status, claimed_until) VALUES (?1, ?2, 'waiting', ?3)
       ON CONFLICT DO NOTHING RETURNING part`,
      row.id,
      number,
      now + PART_CLAIM_MS,
    );
    if (!claimed) return 'wait';
    if (!(await writePartFile(deps, row, number))) {
      await releasePart(deps, row.id, number);
      return 'none';
    }
  }
  const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  await run(
    deps.db,
    `UPDATE email_check_parts SET token_hash = ?1, file_expires_at = ?2 WHERE run_id = ?3 AND part = ?4`,
    await sha256Hex(token),
    expires,
    row.id,
    number,
  );
  try {
    return await upload(deps, row, debounce, number, fileUrl(deps.fileOrigin, token), now);
  } catch (error) {
    // Not sent: the next message or the minute cron may claim it and try again.
    await releasePart(deps, row.id, number);
    return handleError(deps, row, error, now);
  }
}

/**
 * Writes a part's file: its addresses, one per line, as DeBounce asks. The part gets its addresses
 * once; writing again (after a worker died, or the file expired) reuses the same ones. False when
 * the part has no address to send.
 */
async function writePartFile(deps: RunDeps, row: RunRow, number: number): Promise<boolean> {
  const assigned = await first(
    deps.db,
    'SELECT 1 FROM email_check_items WHERE run_id = ?1 AND part = ?2 LIMIT 1',
    row.id,
    number,
  );
  if (!assigned) {
    await run(
      deps.db,
      `UPDATE email_check_items SET part = ?1 WHERE run_id = ?2 AND email IN (
         SELECT email FROM email_check_items WHERE run_id = ?2 AND part = ${PART_WAITING}
          ORDER BY email LIMIT ?3)`,
      number,
      row.id,
      EMAIL_CHECK_PART_SIZE,
    );
  }
  const emails = await all<{ email: string }>(
    deps.db,
    'SELECT email FROM email_check_items WHERE run_id = ?1 AND part = ?2 ORDER BY email',
    row.id,
    number,
  );
  if (!emails.length) return false;
  const key = `email-checks/${row.workspace_id}/${row.id}/${number}-${crypto.randomUUID()}.csv`;
  await deps.files.put(key, `${emails.map((e) => e.email).join('\n')}\n`, {
    httpMetadata: { contentType: 'text/csv' },
  });
  await run(
    deps.db,
    'UPDATE email_check_parts SET file_key = ?1 WHERE run_id = ?2 AND part = ?3',
    key,
    row.id,
    number,
  );
  return true;
}

async function upload(
  deps: RunDeps,
  row: RunRow,
  debounce: DebounceClient,
  number: number,
  url: string,
  now: number,
): Promise<'submitted'> {
  const listId = await debounce.upload(url);
  await deps.db.batch([
    deps.db
      .prepare(
        `UPDATE email_check_parts SET status = 'submitted', list_id = ?1, submitted_at = ?2,
                claimed_until = NULL
          WHERE run_id = ?3 AND part = ?4`,
      )
      .bind(listId, now, row.id, number),
    deps.db
      .prepare('UPDATE email_check_runs SET current_part = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(number, now, row.id),
  ]);
  return 'submitted';
}

async function handleError(
  deps: RunDeps,
  row: RunRow,
  error: unknown,
  now: number,
): Promise<'paused' | 'wait'> {
  if (!(error instanceof DebounceError)) throw error;
  if (error.kind === 'credits') {
    await pause(deps, row.id, 'credits', now);
    return 'paused';
  }
  if (error.kind === 'key' || error.kind === 'forbidden') {
    await pause(deps, row.id, 'key', now);
    return 'paused';
  }
  if (error.kind === 'invalid') {
    await run(
      deps.db,
      'UPDATE email_check_runs SET error = ?1, updated_at = ?2 WHERE id = ?3',
      error.message.slice(0, 500),
      now,
      row.id,
    );
  }
  return 'wait';
}

/**
 * A small run's addresses are all its part 1, made on its first step. Each step claims the part,
 * so a duplicated message (or the minute cron) can't ask DeBounce about the same addresses at the
 * same time: false when another worker is on a step.
 */
async function claimSingleStep(deps: RunDeps, row: RunRow, now: number): Promise<boolean> {
  if (row.current_part === 0) {
    await deps.db.batch([
      deps.db
        .prepare(
          `UPDATE email_check_items SET part = 1 WHERE run_id = ?1 AND part = ${PART_WAITING}`,
        )
        .bind(row.id),
      deps.db
        .prepare(
          `INSERT INTO email_check_parts (run_id, part, status, submitted_at) VALUES (?1, 1, 'submitted', ?2)
           ON CONFLICT DO NOTHING`,
        )
        .bind(row.id, now),
      deps.db.prepare('UPDATE email_check_runs SET current_part = 1 WHERE id = ?1').bind(row.id),
    ]);
  }
  return claimPart(deps, row.id, 1, 'submitted', now);
}

/**
 * The small run: one address at a time, up to four at once, within leases. An address that fails
 * SINGLE_ATTEMPTS steps in a row is done without a result, so a run whose last addresses DeBounce
 * never answers still finishes (and carries an import on) instead of asking again every minute.
 */
async function runSingle(
  deps: RunDeps,
  row: RunRow,
  debounce: DebounceClient,
  now: number,
): Promise<'more' | 'done' | 'paused' | 'wait'> {
  const pending = await all<{ email: string }>(
    deps.db,
    'SELECT email FROM email_check_items WHERE run_id = ?1 AND part = 1 AND done = 0 LIMIT ?2',
    row.id,
    SINGLE_PER_STEP,
  );
  if (!pending.length) return 'done';
  const results: CheckResult[] = [];
  /** Addresses this step tried and got nothing for, with the last temporary error. */
  const failed: string[] = [];
  let lastError: DebounceError | null = null;
  let stop: DebounceError | null = null;
  const queue = pending.map((p) => p.email);
  const worker = async () => {
    for (;;) {
      const email = queue.shift();
      if (!email || stop) return;
      try {
        const answer = await verifyLeased(
          deps.db,
          debounce,
          email,
          'background',
          Date.now() + BACKGROUND_TIMEOUT_MS,
        );
        if (answer) results.push(fromDebounce(answer));
        else failed.push(email);
      } catch (error) {
        if (!(error instanceof DebounceError)) throw error;
        if (error.kind === 'credits' || error.kind === 'key' || error.kind === 'forbidden') {
          stop = error;
        } else {
          failed.push(email);
          lastError = error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: DEBOUNCE_MAX_CONCURRENT - 1 }, worker));
  await applyResults(deps, row, 1, results, results.length, now);
  const givenUp = await countFailedAttempts(deps, row, failed, lastError, now);
  if (stop) return handleError(deps, row, stop, now);
  const left = await first<{ n: number }>(
    deps.db,
    'SELECT count(*) AS n FROM email_check_items WHERE run_id = ?1 AND part = 1 AND done = 0',
    row.id,
  );
  return (left?.n ?? 0) === 0 ? 'done' : results.length || givenUp ? 'more' : 'wait';
}

/**
 * One more failed try for each address; those at SINGLE_ATTEMPTS are done without a result (no
 * email_checks row: "not checked") and the run says how many. Returns how many were given up.
 */
async function countFailedAttempts(
  deps: RunDeps,
  row: RunRow,
  failed: string[],
  lastError: DebounceError | null,
  now: number,
): Promise<number> {
  if (!failed.length) return 0;
  const emails = JSON.stringify(failed);
  const [, given] = await deps.db.batch([
    deps.db
      .prepare(
        `UPDATE email_check_items SET attempts = attempts + 1
          WHERE run_id = ?1 AND part = 1 AND done = 0 AND email IN (SELECT value FROM json_each(?2))`,
      )
      .bind(row.id, emails),
    deps.db
      .prepare(
        `UPDATE email_check_items SET done = 1
          WHERE run_id = ?1 AND part = 1 AND done = 0 AND attempts >= ?2
            AND email IN (SELECT value FROM json_each(?3))`,
      )
      .bind(row.id, SINGLE_ATTEMPTS, emails),
  ]);
  const n = given?.meta.changes ?? 0;
  if (n) {
    const total = await first<{ n: number }>(
      deps.db,
      `SELECT count(*) AS n FROM email_check_items
        WHERE run_id = ?1 AND part = 1 AND done = 1 AND attempts >= ?2`,
      row.id,
      SINGLE_ATTEMPTS,
    );
    const count = total?.n ?? n;
    const why = lastError ? ` ${lastError.message}` : '';
    await run(
      deps.db,
      'UPDATE email_check_runs SET error = ?1, updated_at = ?2 WHERE id = ?3',
      `DeBounce couldn’t check ${count} ${count === 1 ? 'address' : 'addresses'} after ${SINGLE_ATTEMPTS} tries, so ${count === 1 ? 'it stays' : 'they stay'} not checked.${why}`.slice(
        0,
        500,
      ),
      now,
      row.id,
    );
  }
  return n;
}

/**
 * Moves a running run along: checks the part at DeBounce, applies it when finished, and sends the
 * next one. Called by its message and by the minute cron. Safe to run twice.
 */
export async function advanceRun(
  deps: RunDeps,
  runId: string,
  now = Date.now(),
): Promise<'wait' | 'more' | 'done' | 'paused' | 'gone'> {
  const row = await loadRun(deps.db, runId);
  if (!row || (row.status !== 'running' && row.status !== 'stopping')) return 'gone';
  const debounce = deps.debounce;
  if (!debounce) {
    await pause(deps, runId, 'key', now);
    return 'paused';
  }

  if (row.method === 'single') {
    // Another worker is on this run's step (or it has finished): nothing to ask DeBounce here.
    if (!(await claimSingleStep(deps, row, now))) return 'wait';
    let step;
    try {
      step = await runSingle(deps, row, debounce, now);
      if (step === 'done' || row.status === 'stopping') {
        await run(
          deps.db,
          "UPDATE email_check_parts SET status = 'done', completed_at = ?1, percent = 100 WHERE run_id = ?2 AND part = 1",
          now,
          runId,
        );
        await finishRun(deps, runId, now, step === 'done' ? 'completed' : 'stopped');
        return 'done';
      }
    } finally {
      await releasePart(deps, runId, 1);
    }
    // Let go first, so the next step's message finds the part free.
    if (step === 'more') await deps.queue.send({ type: 'email_check_run', runId });
    return step;
  }

  const current = row.current_part
    ? await first<PartRow>(
        deps.db,
        'SELECT part, status, list_id, file_key, submitted_at, file_expires_at FROM email_check_parts WHERE run_id = ?1 AND part = ?2',
        runId,
        row.current_part,
      )
    : null;

  if (current?.status === 'submitted' && current.list_id) {
    // The file is only for DeBounce to fetch once: it goes after a day whatever happens.
    if (current.file_key && (current.file_expires_at ?? 0) <= now) {
      await dropFile(deps, runId, current);
    }
    let status;
    try {
      status = await debounce.status(current.list_id);
    } catch (error) {
      return handleError(deps, row, error, now);
    }
    if (status.status !== 'completed' || !status.downloadLink) {
      await run(
        deps.db,
        'UPDATE email_check_parts SET percent = ?1 WHERE run_id = ?2 AND part = ?3',
        status.percent,
        runId,
        current.part,
      );
      if ((current.submitted_at ?? now) < now - PART_GIVE_UP_MS) {
        await deps.db.batch([
          deps.db
            .prepare(
              `UPDATE email_check_parts SET status = 'failed', error = 'DeBounce did not finish this part in 7 days.'
                WHERE run_id = ?1 AND part = ?2`,
            )
            .bind(runId, current.part),
        ]);
        await dropFile(deps, runId, current);
        return 'more';
      }
      return 'wait';
    }
    const sent = await first<{ n: number }>(
      deps.db,
      'SELECT count(*) AS n FROM email_check_items WHERE run_id = ?1 AND part = ?2',
      runId,
      current.part,
    );
    let results: CheckResult[];
    try {
      // Bounded by the part's size: a file far larger than its addresses need is refused before
      // anything is applied, and the run shows the error and tries again.
      const csv = await debounce.download(status.downloadLink, {
        maxBytes: debounceResultsLimit(sent?.n ?? 0),
      });
      results = parseBulkResults(csv).map((r) => ({ ...r, source: 'debounce' as const }));
    } catch (error) {
      return handleError(deps, row, error, now);
    }
    // Claimed before it is applied, so a second worker polling the same part applies nothing.
    const claimed = await first(
      deps.db,
      `UPDATE email_check_parts SET status = 'done', percent = 100, completed_at = ?1
        WHERE run_id = ?2 AND part = ?3 AND status = 'submitted' RETURNING part`,
      now,
      runId,
      current.part,
    );
    if (!claimed) return 'wait';
    try {
      await applyResults(deps, row, current.part, results, sent?.n ?? 0, now);
    } catch (error) {
      await run(
        deps.db,
        "UPDATE email_check_parts SET status = 'submitted', completed_at = NULL WHERE run_id = ?1 AND part = ?2",
        runId,
        current.part,
      );
      throw error;
    }
    await dropFile(deps, runId, current);
  }

  const fresh = (await loadRun(deps.db, runId)) as RunRow;
  if (fresh.status === 'stopping') {
    await finishRun(deps, runId, now, 'stopped');
    return 'done';
  }
  if (fresh.status !== 'running') return 'gone';
  const next = await submitNextPart(deps, fresh, debounce, now);
  if (next === 'none') {
    await finishRun(deps, runId, now, 'completed');
    return 'done';
  }
  return next === 'paused' ? 'paused' : 'wait';
}

/** The run's end: its addresses are forgotten, segments refresh, an import carries on. */
async function finishRun(
  deps: RunDeps,
  runId: string,
  now: number,
  status: 'completed' | 'stopped' = 'completed',
): Promise<void> {
  const row = await loadRun(deps.db, runId);
  if (!row) return;
  const parts = await all<PartRow>(
    deps.db,
    'SELECT part, status, list_id, file_key, submitted_at, file_expires_at FROM email_check_parts WHERE run_id = ?1 AND file_key IS NOT NULL',
    runId,
  );
  for (const part of parts) await dropFile(deps, runId, part);
  await giveBackUnsent(deps.db, runId);
  await deps.db.batch([
    deps.db
      .prepare(
        `UPDATE email_check_runs SET status = CASE WHEN status IN ('completed', 'stopped', 'canceled', 'failed')
                  THEN status ELSE ?1 END,
                paused_reason = NULL, updated_at = ?2, completed_at = coalesce(completed_at, ?2)
          WHERE id = ?3`,
      )
      .bind(status, now, runId),
    // The list of addresses was only needed while the run ran.
    deps.db.prepare('DELETE FROM email_check_items WHERE run_id = ?1').bind(runId),
  ]);
  const channels = row.channel_id
    ? [row.channel_id]
    : (
        await all<{ id: string }>(
          deps.db,
          'SELECT id FROM channels WHERE workspace_id = ?1',
          row.workspace_id,
        )
      ).map((c) => c.id);
  for (const channelId of channels) {
    await enqueueChannelCircleRefresh(deps.db, deps.queue, channelId, { now });
  }
  if (row.import_id) await deps.queue.send({ type: 'import_run', jobId: row.import_id });
}

/** Runs that need a look this minute: parts at DeBounce, files past their day, lost messages. */
export async function dueRuns(db: D1Database, now = Date.now()): Promise<RunRow[]> {
  return all<RunRow>(
    db,
    `SELECT * FROM email_check_runs WHERE status IN ('planning', 'running', 'stopping')
        AND updated_at < ?1 ORDER BY updated_at LIMIT 20`,
    now - 2 * 60_000,
  );
}

/** Whether a run is over. */
export const runFinal = (status: EmailCheckRunStatus) => EMAIL_CHECK_RUN_FINAL.includes(status);

// ---- Summaries -------------------------------------------------------

export interface ChannelCheckCounts {
  subscribers: number;
  green: number;
  orange: number;
  red: number;
  unchecked: number;
  stale: number;
  reasons: { code: number; n: number }[];
}

/** How a publication's subscribers who may be mailed stand. */
export async function channelCheckCounts(
  db: D1Database,
  channelId: string,
  validMonths: number,
  now = Date.now(),
): Promise<ChannelCheckCounts> {
  const [total, rows] = await Promise.all([
    first<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM members WHERE channel_id = ?1 AND status IN ${CHECKED_STATUSES}`,
      channelId,
    ),
    all<{ state: EmailCheckColour; code: number; n: number; stale: number }>(
      db,
      `SELECT ec.state, ec.code, count(*) AS n, sum(ec.checked_at < ?2) AS stale
         FROM members m JOIN email_checks ec
           ON ec.workspace_id = (SELECT workspace_id FROM channels WHERE id = ?1) AND ec.email = m.email
        WHERE m.channel_id = ?1 AND m.status IN ${CHECKED_STATUSES}
        GROUP BY ec.state, ec.code`,
      channelId,
      now - validForMs(validMonths),
    ),
  ]);
  const out: ChannelCheckCounts = {
    subscribers: total?.n ?? 0,
    green: 0,
    orange: 0,
    red: 0,
    unchecked: 0,
    stale: 0,
    reasons: [],
  };
  let checked = 0;
  for (const row of rows) {
    out[row.state] += row.n;
    out.stale += row.stale ?? 0;
    checked += row.n;
    out.reasons.push({ code: row.code, n: row.n });
  }
  out.unchecked = Math.max(0, out.subscribers - checked);
  return out;
}

export interface EmailCheckFacts extends EmailCheckAvailability {
  subscribers: number;
  unchecked: number;
  checked: number;
  red: number;
}

/** What the deliverability check-up says about a publication's email checks. */
export async function emailCheckFacts(
  db: D1Database,
  env: DebounceEnv,
  channelId: string,
  now = Date.now(),
): Promise<EmailCheckFacts> {
  const channel = await first<{ workspace_id: string }>(
    db,
    'SELECT workspace_id FROM channels WHERE id = ?1',
    channelId,
  );
  if (!channel) throw new Error('channel not found');
  const availability = await emailCheckAvailability(db, env, channel.workspace_id, channelId);
  const settings = await readEmailCheckSettings(db, channel.workspace_id);
  const counts = await channelCheckCounts(db, channelId, settings.validMonths, now);
  return {
    ...availability,
    subscribers: counts.subscribers,
    unchecked: counts.unchecked,
    checked: counts.green + counts.orange + counts.red,
    red: counts.red,
  };
}
