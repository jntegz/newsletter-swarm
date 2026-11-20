/**
 * Bounce rules: how a workspace reacts when its email turns out undeliverable. Contract:
 * docs/deliverability.md "Bounces"; tables: migrations/0067_bounce_policy.sql; the policy shape
 * and defaults: @swarm/domain bounces.ts. bounce-classifier.ts decides hard, soft or blocked.
 *
 * - Every bounce is kept for 90 days (bounce_events), once per email and kind. An address that is
 *   still being mailed has counters (bounce_states): emails in a row that bounced softly, reset
 *   by a delivered one.
 * - Hard: stop at the first one, or at the second within 30 days. Soft: after N emails in a row,
 *   and/or N within D days; both off means never. Blocked: never stops anyone, it is about the
 *   sender; the delivery counts as bounced for the check-up and the warm-up pause.
 * - Stopping is what a bounce always did: a workspace-wide suppression (with the rule, the cause
 *   and the server's words), the workspace's Members of the address 'bounced' (remembering their
 *   status in bounced_from), and for a hard bounce the SES account-level list.
 * - With ask_for_paid, an address with a current paid plan in the workspace is not stopped: it
 *   is held for an admin (Needs your attention) and keeps being mailed; the jobs worker emails the
 *   owners and admins once (sendBounceHoldNotices).
 * - A new policy counts from the next bounce, using the stored counters, unless the admin applies
 *   it to past bounces too (applyBouncePolicy).
 */
import {
  BOUNCE_LIMITS,
  BOUNCE_CAUSE_KIND,
  BOUNCE_CAUSE_TEXT,
  DEFAULT_BOUNCE_POLICY,
  bounceRuleReason,
  type BounceCause,
  type BounceEvent,
  type BounceHold,
  type BounceKind,
  type BouncePolicy,
  type BouncePreview,
  type BounceStopRule,
  type MemberBounces,
} from '@swarm/domain';
import { appendAudit } from '@swarm/db';
import type { MailAdapter } from '@swarm/mail';
import type { BounceClassification } from './bounce-classifier';
import { all, first, newIdFor, run } from './db';
import { sendOperatorNotice } from './flows-notify';
import { providerSyncStatement } from './suppressions';

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

// ---- The policy ----------------------------------------------------------------------------

interface PolicyRow {
  hard_bounces: 1 | 2;
  soft_streak: number | null;
  soft_window_count: number | null;
  soft_window_days: 7 | 14 | 30 | 60 | 90 | null;
  ask_for_paid: number;
  updated_at: number;
}

const fromRow = (row: PolicyRow): BouncePolicy => ({
  hardBounces: row.hard_bounces,
  softStreak: row.soft_streak,
  softWindow:
    row.soft_window_count !== null && row.soft_window_days !== null
      ? { count: row.soft_window_count, days: row.soft_window_days }
      : null,
  askForPaid: row.ask_for_paid === 1,
});

/** The workspace's rules and when they were last saved (null: the defaults). */
export async function readBouncePolicy(
  db: D1Database,
  workspaceId: string,
): Promise<{ policy: BouncePolicy; updatedAt: number | null }> {
  const row = await first<PolicyRow>(
    db,
    'SELECT * FROM bounce_policies WHERE workspace_id = ?1',
    workspaceId,
  );
  return row
    ? { policy: fromRow(row), updatedAt: row.updated_at }
    : { policy: DEFAULT_BOUNCE_POLICY, updatedAt: null };
}

export async function saveBouncePolicy(
  db: D1Database,
  workspaceId: string,
  policy: BouncePolicy,
  operatorId: string | null,
  now: number,
): Promise<void> {
  await run(
    db,
    `INSERT INTO bounce_policies (workspace_id, hard_bounces, soft_streak, soft_window_count,
                                  soft_window_days, ask_for_paid, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (workspace_id) DO UPDATE SET hard_bounces = excluded.hard_bounces,
            soft_streak = excluded.soft_streak, soft_window_count = excluded.soft_window_count,
            soft_window_days = excluded.soft_window_days, ask_for_paid = excluded.ask_for_paid,
            updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    workspaceId,
    policy.hardBounces,
    policy.softStreak,
    policy.softWindow?.count ?? null,
    policy.softWindow?.days ?? null,
    policy.askForPaid ? 1 : 0,
    operatorId,
    now,
  );
}

// ---- Shared SQL ----------------------------------------------------------------------------

/** The workspace's Channels; the address is ?2. */
const WS_MEMBERS = 'channel_id IN (SELECT id FROM channels WHERE workspace_id = ?1) AND email = ?2';

/** A current paid plan on any of the workspace's Members of the address (?1 ws, ?2 email, ?3 now). */
const PAID_SQL = `EXISTS (SELECT 1 FROM members pm JOIN member_entitlements pe ON pe.member_id = pm.id
                   WHERE pm.channel_id IN (SELECT id FROM channels WHERE workspace_id = ?1)
                     AND pm.email = ?2 AND pe.kind = 'paid' AND pe.starts_at <= ?3
                     AND (pe.expires_at IS NULL OR pe.expires_at > ?3))`;

const isSuppressedWide = (db: D1Database, workspaceId: string, email: string) =>
  first(
    db,
    'SELECT 1 FROM suppressions WHERE workspace_id = ?1 AND email = ?2 AND channel_id IS NULL',
    workspaceId,
    email,
  );

interface StateRow {
  id: string;
  workspace_id: string;
  email: string;
  soft_streak: number;
  streak_sent_at: number | null;
  counts_from: number;
  last_kind: BounceKind;
  last_cause: BounceCause;
  last_code: string | null;
  last_detail: string | null;
  last_bounced_at: number;
  held_at: number | null;
  held_rule: BounceStopRule | null;
  held_counted: number | null;
  held_days: number | null;
  hold_notice: 'due' | 'sent' | null;
}

const stateOf = (db: D1Database, workspaceId: string, email: string) =>
  first<StateRow>(
    db,
    'SELECT * FROM bounce_states WHERE workspace_id = ?1 AND email = ?2',
    workspaceId,
    email,
  );

async function countSince(
  db: D1Database,
  workspaceId: string,
  email: string,
  kind: BounceKind,
  since: number,
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM bounce_events
      WHERE workspace_id = ?1 AND email = ?2 AND kind = ?3 AND created_at > ?4`,
    workspaceId,
    email,
    kind,
    since,
  );
  return row?.n ?? 0;
}

// ---- Stopping and holding ------------------------------------------------------------------

export interface StopDecision {
  rule: BounceStopRule;
  counted: number;
  days: number | null;
}

/**
 * The cause a suppression may record: a hard or soft one. A block is about the sender, so it is
 * never why an address stops (suppressions.bounce_cause refuses it, 0067); null then.
 */
const stopCause = (cause: BounceCause | null): BounceCause | null =>
  cause !== null && BOUNCE_CAUSE_KIND[cause] !== 'blocked' ? cause : null;

/**
 * The statements that stop mailing `email` in the workspace: the suppression (with why), the
 * Members to 'bounced', the counters gone, and for a hard bounce the SES account-level list
 * (unless the provider reported it from that list). Suppression and Members as feedback.ts
 * `suppress` always did; this adds the rule and what it counted.
 */
export function stopStatements(
  db: D1Database,
  input: {
    workspaceId: string;
    email: string;
    decision: StopDecision;
    cause: BounceCause | null;
    detail: string | null;
    fromProvider: boolean;
  },
  now: number,
): D1PreparedStatement[] {
  const hard = input.decision.rule === 'hard' || input.decision.rule === 'hard_repeat';
  return [
    db
      .prepare(
        `INSERT INTO suppressions (id, workspace_id, email, reason, detail, bounce_rule, bounce_cause,
                                   bounce_counted, bounce_days, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (workspace_id, email) WHERE channel_id IS NULL DO NOTHING`,
      )
      .bind(
        newIdFor('suppression', now),
        input.workspaceId,
        input.email,
        hard ? 'hard_bounce' : 'soft_bounce',
        input.detail?.slice(0, 500) ?? null,
        input.decision.rule,
        stopCause(input.cause),
        input.decision.counted,
        input.decision.days,
        now,
      ),
    ...(hard && !input.fromProvider
      ? [providerSyncStatement(db, input.email, { action: 'put', reason: 'BOUNCE' }, now)]
      : []),
    membersBouncedStatement(db, input.workspaceId, input.email, now),
    db
      .prepare('DELETE FROM bounce_states WHERE workspace_id = ?1 AND email = ?2')
      .bind(input.workspaceId, input.email),
  ];
}

/** Statuses a bounce moves to 'bounced' (the system transitions in @swarm/domain audience.ts). */
const BOUNCEABLE = "('pending', 'active', 'paused', 'unsubscribed')";

/** Every Member of the address in the workspace to 'bounced', remembering where they were. */
export function membersBouncedStatement(
  db: D1Database,
  workspaceId: string,
  email: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE members SET bounced_from = status, status = 'bounced', updated_at = ?3, paused_until = NULL
        WHERE ${WS_MEMBERS} AND status IN ${BOUNCEABLE}`,
    )
    .bind(workspaceId, email, now);
}

/**
 * Removing a bounce suppression gives the address's bounced Members back the status they had.
 * A paused Member comes back active (the pause date was cleared). Members bounced before 0067 have
 * no bounced_from: unsubscribed if they had left, active if they had agreed, otherwise pending.
 */
export function membersRestoredStatement(
  db: D1Database,
  workspaceId: string,
  email: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE members SET status = CASE
              WHEN bounced_from IN ('active', 'paused') THEN 'active'
              WHEN bounced_from IS NOT NULL THEN bounced_from
              WHEN unsubscribed_at IS NOT NULL THEN 'unsubscribed'
              WHEN consent_at IS NOT NULL OR confirmed_at IS NOT NULL THEN 'active'
              ELSE 'pending' END,
            bounced_from = NULL, updated_at = ?3
        WHERE ${WS_MEMBERS} AND status = 'bounced'`,
    )
    .bind(workspaceId, email, now);
}

/** The counters and history of an address go: the counts start again from zero. */
export function bounceResetStatements(
  db: D1Database,
  workspaceId: string,
  email: string,
): D1PreparedStatement[] {
  return [
    db
      .prepare('DELETE FROM bounce_states WHERE workspace_id = ?1 AND email = ?2')
      .bind(workspaceId, email),
    db
      .prepare('DELETE FROM bounce_events WHERE workspace_id = ?1 AND email = ?2')
      .bind(workspaceId, email),
    db
      .prepare('DELETE FROM soft_bounces WHERE workspace_id = ?1 AND email = ?2')
      .bind(workspaceId, email),
  ];
}

const holdStatement = (db: D1Database, stateId: string, decision: StopDecision, now: number) =>
  db
    .prepare(
      `UPDATE bounce_states SET held_rule = ?2, held_counted = ?3, held_days = ?4,
              hold_notice = CASE WHEN held_at IS NULL THEN 'due' ELSE hold_notice END,
              held_at = coalesce(held_at, ?5), updated_at = ?5
        WHERE id = ?1`,
    )
    .bind(stateId, decision.rule, decision.counted, decision.days, now);

/** Which rule, if any, stops the address now, from its counters and history. */
function decide(
  policy: BouncePolicy,
  kind: BounceKind,
  facts: { softStreak: number; hardRecent: number; softRecent: number },
): StopDecision | null {
  if (kind === 'hard') {
    if (policy.hardBounces === 1) return { rule: 'hard', counted: 1, days: null };
    if (facts.hardRecent >= 2) {
      return { rule: 'hard_repeat', counted: facts.hardRecent, days: BOUNCE_LIMITS.hardRepeatDays };
    }
    return null;
  }
  if (kind !== 'soft') return null;
  if (policy.softStreak !== null && facts.softStreak >= policy.softStreak) {
    return { rule: 'soft_streak', counted: facts.softStreak, days: null };
  }
  if (policy.softWindow && facts.softRecent >= policy.softWindow.count) {
    return { rule: 'soft_window', counted: facts.softRecent, days: policy.softWindow.days };
  }
  return null;
}

// ---- A bounce ------------------------------------------------------------------------------

export interface BounceInput {
  workspaceId: string;
  /** Lowercased. */
  email: string;
  /** The delivery (dl_) or Direct Send (dn_) the report is about. */
  sendId: string | null;
  /** When that email was sent; null for a Direct Send. */
  sentAt: number | null;
  /** The provider refused because of its own list: nothing to put back on it. */
  fromProvider: boolean;
  /** What the receiving server said. */
  detail: string | null;
}

export interface BounceOutcome {
  kind: BounceKind;
  cause: BounceCause;
  /** The rule that stopped mailing the address. */
  stopped: BounceStopRule | null;
  /** Held for an admin instead (a paid plan, with ask_for_paid). */
  held: boolean;
  /** The same email was already counted (a retry or a second report). */
  duplicate: boolean;
}

/**
 * Was any email to the address delivered (or opened or clicked, which proves it) between two
 * bounced sends? For mail servers that report no deliveries, and events that arrive out of order.
 */
async function deliveredBetween(
  db: D1Database,
  workspaceId: string,
  email: string,
  after: number,
  before: number,
): Promise<boolean> {
  return !!(await first(
    db,
    `SELECT 1 FROM deliveries d
      WHERE d.member_id IN (SELECT id FROM members WHERE ${WS_MEMBERS})
        AND d.sent_at > ?3 AND d.sent_at < ?4
        AND (d.delivered_at IS NOT NULL OR d.opened_at IS NOT NULL OR d.clicked_at IS NOT NULL
             OR d.status IN ('delivered', 'complained'))
      LIMIT 1`,
    workspaceId,
    email,
    after,
    before,
  ));
}

/**
 * Records a classified bounce and applies the workspace's rules to it. Complaints never come
 * here (feedback.ts suppresses them at once).
 */
export async function recordBounce(
  db: D1Database,
  input: BounceInput,
  classified: Exclude<BounceClassification, { kind: 'ignored' }>,
  now: number,
): Promise<BounceOutcome> {
  const { workspaceId, email } = input;
  const detail = input.detail?.slice(0, 500) ?? null;
  const inserted = await db
    .prepare(
      `INSERT INTO bounce_events (workspace_id, email, send_id, kind, cause, code, detail, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT DO NOTHING`,
    )
    .bind(
      workspaceId,
      email,
      input.sendId,
      classified.kind,
      classified.cause,
      classified.code?.slice(0, 12) ?? null,
      detail,
      now,
    )
    .run();
  const duplicate = (inserted.meta.changes ?? 0) === 0;
  const outcome: BounceOutcome = {
    kind: classified.kind,
    cause: classified.cause,
    stopped: null,
    held: false,
    duplicate,
  };
  if (duplicate) return outcome;

  const before = await stateOf(db, workspaceId, email);
  // A soft bounce adds one to the streak, or starts it again when an email in between got through.
  let restart = false;
  if (classified.kind === 'soft' && before?.streak_sent_at && input.sentAt) {
    restart =
      input.sentAt > before.streak_sent_at &&
      (await deliveredBetween(db, workspaceId, email, before.streak_sent_at, input.sentAt));
  }
  const soft = classified.kind === 'soft' ? 1 : 0;
  // The last bounce is the address's own: a block (about the sender, ?12 = 0) only takes its
  // place over another block, so the cause a hold or a later stop names is the one that counted.
  // Every SET reads the old row, so last_kind in each CASE is the one before this bounce.
  const own = `(?12 = 1 OR bounce_states.last_kind = 'blocked')`;
  const state = await first<StateRow>(
    db,
    `INSERT INTO bounce_states (id, workspace_id, email, soft_streak, streak_sent_at, last_kind,
                                last_cause, last_code, last_detail, last_bounced_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10)
     ON CONFLICT (workspace_id, email) DO UPDATE SET
       soft_streak = CASE WHEN ?4 = 0 THEN bounce_states.soft_streak
                          WHEN ?11 = 1 THEN 1 ELSE bounce_states.soft_streak + 1 END,
       streak_sent_at = CASE WHEN ?4 = 0 OR ?5 IS NULL THEN bounce_states.streak_sent_at
                             ELSE max(coalesce(bounce_states.streak_sent_at, ?5), ?5) END,
       last_kind = CASE WHEN ${own} THEN excluded.last_kind ELSE bounce_states.last_kind END,
       last_cause = CASE WHEN ${own} THEN excluded.last_cause ELSE bounce_states.last_cause END,
       last_code = CASE WHEN ${own} THEN excluded.last_code ELSE bounce_states.last_code END,
       last_detail = CASE WHEN ${own} THEN excluded.last_detail ELSE bounce_states.last_detail END,
       last_bounced_at = CASE WHEN ${own} THEN excluded.last_bounced_at
                              ELSE bounce_states.last_bounced_at END,
       updated_at = excluded.updated_at
     RETURNING *`,
    newIdFor('bounceState', now),
    workspaceId,
    email,
    soft,
    soft ? input.sentAt : null,
    classified.kind,
    classified.cause,
    classified.code?.slice(0, 12) ?? null,
    detail,
    now,
    restart ? 1 : 0,
    classified.kind === 'blocked' ? 0 : 1,
  );
  if (!state || classified.kind === 'blocked') return outcome;
  if (await isSuppressedWide(db, workspaceId, email)) return outcome;

  const { policy } = await readBouncePolicy(db, workspaceId);
  const counted = (kind: BounceKind, days: number) =>
    countSince(db, workspaceId, email, kind, Math.max(now - days * DAY_MS, state.counts_from - 1));
  const decision = decide(policy, classified.kind, {
    softStreak: state.soft_streak,
    hardRecent:
      classified.kind === 'hard' && policy.hardBounces === 2
        ? await counted('hard', BOUNCE_LIMITS.hardRepeatDays)
        : 0,
    softRecent:
      classified.kind === 'soft' && policy.softWindow
        ? await counted('soft', policy.softWindow.days)
        : 0,
  });
  if (!decision) return outcome;

  if (policy.askForPaid && (await isPaid(db, workspaceId, email, now))) {
    await holdStatement(db, state.id, decision, now).run();
    return { ...outcome, held: true };
  }
  await db.batch(
    stopStatements(
      db,
      {
        workspaceId,
        email,
        decision,
        cause: classified.cause,
        detail,
        fromProvider: input.fromProvider,
      },
      now,
    ),
  );
  return { ...outcome, stopped: decision.rule };
}

const isPaid = async (db: D1Database, workspaceId: string, email: string, now: number) =>
  !!(await first(db, `SELECT 1 AS paid WHERE ${PAID_SQL}`, workspaceId, email, now));

/**
 * A delivered email starts the soft streak again, and lets go of a hold that only soft bounces
 * made: the mailbox works again.
 */
export async function recordDelivered(
  db: D1Database,
  workspaceId: string,
  email: string,
  now: number,
): Promise<void> {
  await run(
    db,
    `UPDATE bounce_states SET soft_streak = 0, streak_sent_at = NULL, updated_at = ?3,
            held_at = CASE WHEN held_rule IN ('soft_streak', 'soft_window') THEN NULL ELSE held_at END,
            hold_notice = CASE WHEN held_rule IN ('soft_streak', 'soft_window') THEN NULL ELSE hold_notice END,
            held_counted = CASE WHEN held_rule IN ('soft_streak', 'soft_window') THEN NULL ELSE held_counted END,
            held_days = CASE WHEN held_rule IN ('soft_streak', 'soft_window') THEN NULL ELSE held_days END,
            held_rule = CASE WHEN held_rule IN ('soft_streak', 'soft_window') THEN NULL ELSE held_rule END
      WHERE workspace_id = ?1 AND email = ?2
        AND (soft_streak > 0 OR held_rule IN ('soft_streak', 'soft_window'))`,
    workspaceId,
    email.toLowerCase(),
    now,
  );
}

// ---- Preview and applying to past bounces --------------------------------------------------

interface Candidate {
  id: string;
  email: string;
  soft_streak: number;
  counts_from: number;
  last_cause: BounceCause;
  last_detail: string | null;
  held_at: number | null;
  hard_30: number;
  hard_90: number;
  soft_window: number;
  paid: number;
}

const PAGE = 500;

/**
 * Addresses still being mailed whose stored counters and history match `policy` now, page by
 * page. Only addresses with a Member who still gets email (pending, active or paused) count, and
 * not those already held that the policy would hold again.
 */
async function* matches(
  db: D1Database,
  workspaceId: string,
  policy: BouncePolicy,
  now: number,
): AsyncGenerator<{ candidate: Candidate; decision: StopDecision; paid: boolean }> {
  const softSince = now - (policy.softWindow?.days ?? 0) * DAY_MS;
  let after = '';
  for (;;) {
    const page = await all<Candidate>(
      db,
      `SELECT s.id, s.email, s.soft_streak, s.counts_from, s.last_cause, s.last_detail, s.held_at,
              (SELECT count(*) FROM bounce_events e WHERE e.workspace_id = s.workspace_id
                  AND e.email = s.email AND e.kind = 'hard' AND e.created_at > max(?3, s.counts_from - 1)) AS hard_30,
              (SELECT count(*) FROM bounce_events e WHERE e.workspace_id = s.workspace_id
                  AND e.email = s.email AND e.kind = 'hard' AND e.created_at > max(?4, s.counts_from - 1)) AS hard_90,
              (SELECT count(*) FROM bounce_events e WHERE e.workspace_id = s.workspace_id
                  AND e.email = s.email AND e.kind = 'soft' AND e.created_at > max(?5, s.counts_from - 1)) AS soft_window,
              EXISTS (SELECT 1 FROM members pm JOIN member_entitlements pe ON pe.member_id = pm.id
                       WHERE pm.channel_id IN (SELECT id FROM channels WHERE workspace_id = ?1)
                         AND pm.email = s.email AND pe.kind = 'paid' AND pe.starts_at <= ?6
                         AND (pe.expires_at IS NULL OR pe.expires_at > ?6)) AS paid
         FROM bounce_states s
        WHERE s.workspace_id = ?1 AND s.id > ?2
          AND NOT EXISTS (SELECT 1 FROM suppressions x WHERE x.workspace_id = s.workspace_id
                             AND x.email = s.email AND x.channel_id IS NULL)
          AND EXISTS (SELECT 1 FROM members m
                       WHERE m.channel_id IN (SELECT id FROM channels WHERE workspace_id = ?1)
                         AND m.email = s.email AND m.status IN ('pending', 'active', 'paused'))
        ORDER BY s.id LIMIT ${PAGE}`,
      workspaceId,
      after,
      now - BOUNCE_LIMITS.hardRepeatDays * DAY_MS,
      now - BOUNCE_LIMITS.historyDays * DAY_MS,
      softSince,
      now,
    );
    for (const candidate of page) {
      // Already held and would be held again: nothing to do, so it neither counts in the preview
      // nor takes a place in applyBouncePolicy's batch (or the same first holds would fill every
      // batch). A held address the policy would now stop (no longer paid, or no longer "ask me
      // first") still counts.
      if (candidate.held_at !== null && candidate.paid === 1 && policy.askForPaid) continue;
      const hard = policy.hardBounces === 1 ? candidate.hard_90 : candidate.hard_30;
      const decision =
        (hard > 0
          ? decide(policy, 'hard', { softStreak: 0, hardRecent: hard, softRecent: 0 })
          : null) ??
        decide(policy, 'soft', {
          softStreak: candidate.soft_streak,
          hardRecent: 0,
          softRecent: policy.softWindow ? candidate.soft_window : 0,
        });
      if (decision) yield { candidate, decision, paid: candidate.paid === 1 };
    }
    if (page.length < PAGE) return;
    after = page[page.length - 1]!.id;
  }
}

/** How many addresses `policy` would stop now, and hold for an admin, from stored history. */
export async function previewBouncePolicy(
  db: D1Database,
  workspaceId: string,
  policy: BouncePolicy,
  now: number,
): Promise<BouncePreview> {
  const preview: BouncePreview = {
    stopped: 0,
    held: 0,
    byRule: { hard: 0, hard_repeat: 0, soft_streak: 0, soft_window: 0 },
  };
  for await (const { decision, paid } of matches(db, workspaceId, policy, now)) {
    preview.byRule[decision.rule] += 1;
    if (paid && policy.askForPaid) preview.held += 1;
    else preview.stopped += 1;
  }
  return preview;
}

/**
 * "Apply to past bounces too": stops (or holds) what previewBouncePolicy counts, at most
 * BOUNCE_LIMITS.applyBatch addresses per call. The rest are `remaining`; saving again continues.
 */
export async function applyBouncePolicy(
  db: D1Database,
  workspaceId: string,
  policy: BouncePolicy,
  now: number,
): Promise<{ stopped: number; held: number; remaining: number }> {
  const result = { stopped: 0, held: 0, remaining: 0 };
  const statements: D1PreparedStatement[] = [];
  for await (const { candidate, decision, paid } of matches(db, workspaceId, policy, now)) {
    if (result.stopped + result.held >= BOUNCE_LIMITS.applyBatch) {
      result.remaining += 1;
      continue;
    }
    if (paid && policy.askForPaid) {
      result.held += 1;
      statements.push(holdStatement(db, candidate.id, decision, now));
      continue;
    }
    result.stopped += 1;
    statements.push(
      ...stopStatements(
        db,
        {
          workspaceId,
          email: candidate.email,
          decision,
          cause: candidate.last_cause,
          detail: candidate.last_detail,
          fromProvider: candidate.last_cause === 'provider_list',
        },
        now,
      ),
    );
  }
  for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));
  return result;
}

// ---- Holds ---------------------------------------------------------------------------------

const eventOf = (row: {
  last_kind: BounceKind;
  last_cause: BounceCause;
  last_code: string | null;
  last_detail: string | null;
  last_bounced_at: number;
}): BounceEvent => ({
  kind: row.last_kind,
  cause: row.last_cause,
  code: row.last_code,
  detail: row.last_detail,
  at: iso(row.last_bounced_at),
});

/** Held addresses with a Member in the Channel, oldest first. */
export async function listBounceHolds(
  db: D1Database,
  workspaceId: string,
  channelId: string,
): Promise<BounceHold[]> {
  const rows = await all<StateRow & { member_id: string | null }>(
    db,
    `SELECT s.*, (SELECT m.id FROM members m WHERE m.channel_id = ?2 AND m.email = s.email) AS member_id
       FROM bounce_states s
      WHERE s.workspace_id = ?1 AND s.held_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM members m WHERE m.channel_id = ?2 AND m.email = s.email)
      ORDER BY s.held_at, s.id LIMIT 200`,
    workspaceId,
    channelId,
  );
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    memberId: row.member_id,
    rule: row.held_rule!,
    counted: row.held_counted,
    days: row.held_days,
    last: eventOf(row),
    heldAt: iso(row.held_at!),
  }));
}

export class BounceHoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BounceHoldError';
  }
}

/**
 * An admin's answer to a hold. stop: as the rule would have. keep: mailing goes on and the counts
 * start again from now; for a hard bounce the address also leaves the SES account-level list, as
 * when a hard-bounce suppression is removed, or the next send would only be refused again.
 */
export async function decideBounceHold(
  db: D1Database,
  workspaceId: string,
  holdId: string,
  decision: 'stop' | 'keep',
  now: number,
): Promise<{ email: string; rule: BounceStopRule }> {
  const state = await first<StateRow>(
    db,
    'SELECT * FROM bounce_states WHERE id = ?1 AND workspace_id = ?2 AND held_at IS NOT NULL',
    holdId,
    workspaceId,
  );
  if (!state?.held_rule) throw new BounceHoldError('That subscriber is no longer waiting for you.');
  const rule = state.held_rule;
  const hard = rule === 'hard' || rule === 'hard_repeat';
  if (decision === 'stop') {
    await db.batch(
      stopStatements(
        db,
        {
          workspaceId,
          email: state.email,
          decision: { rule, counted: state.held_counted ?? 1, days: state.held_days },
          cause: state.last_cause,
          detail: state.last_detail,
          fromProvider: state.last_cause === 'provider_list',
        },
        now,
      ),
    );
  } else {
    await db.batch([
      db
        .prepare(
          `UPDATE bounce_states SET soft_streak = 0, streak_sent_at = NULL, counts_from = ?2,
                  held_at = NULL, held_rule = NULL, held_counted = NULL, held_days = NULL,
                  hold_notice = NULL, updated_at = ?2
            WHERE id = ?1`,
        )
        .bind(state.id, now),
      ...(hard ? [providerSyncStatement(db, state.email, { action: 'delete' }, now)] : []),
    ]);
  }
  return { email: state.email, rule };
}

// ---- One subscriber ------------------------------------------------------------------------

interface SuppressionBounceRow {
  id: string;
  reason: 'hard_bounce' | 'soft_bounce';
  detail: string | null;
  bounce_rule: BounceStopRule | null;
  bounce_cause: BounceCause | null;
  bounce_counted: number | null;
  bounce_days: number | null;
  created_at: number;
}

/** The address of one Member as the bounce rules see it, in the Member's workspace. */
export async function memberBounces(
  db: D1Database,
  workspaceId: string,
  email: string,
  now: number,
): Promise<MemberBounces> {
  const address = email.toLowerCase();
  const [state, suppression, events] = await Promise.all([
    stateOf(db, workspaceId, address),
    first<SuppressionBounceRow>(
      db,
      `SELECT id, reason, detail, bounce_rule, bounce_cause, bounce_counted, bounce_days, created_at
         FROM suppressions
        WHERE workspace_id = ?1 AND email = ?2 AND channel_id IS NULL
          AND reason IN ('hard_bounce', 'soft_bounce') AND email_hash IS NULL`,
      workspaceId,
      address,
    ),
    all<{
      kind: BounceKind;
      cause: BounceCause;
      code: string | null;
      detail: string | null;
      created_at: number;
    }>(
      db,
      `SELECT kind, cause, code, detail, created_at FROM bounce_events
        WHERE workspace_id = ?1 AND email = ?2 AND created_at > ?3
        ORDER BY created_at DESC LIMIT ${BOUNCE_LIMITS.memberEvents}`,
      workspaceId,
      address,
      now - BOUNCE_LIMITS.historyDays * DAY_MS,
    ),
  ]);
  return {
    softStreak: state?.soft_streak ?? 0,
    held:
      state?.held_at && state.held_rule
        ? {
            rule: state.held_rule,
            counted: state.held_counted,
            days: state.held_days,
            heldAt: iso(state.held_at),
          }
        : null,
    stopped: suppression
      ? {
          suppressionId: suppression.id,
          reason: suppression.reason,
          bounce: suppression.bounce_rule
            ? {
                rule: suppression.bounce_rule,
                cause: suppression.bounce_cause,
                counted: suppression.bounce_counted,
                days: suppression.bounce_days,
              }
            : null,
          detail: suppression.detail,
          createdAt: iso(suppression.created_at),
        }
      : null,
    events: events.map((e) => ({
      kind: e.kind,
      cause: e.cause,
      code: e.code,
      detail: e.detail,
      at: iso(e.created_at),
    })),
  };
}

// ---- Notices to owners and admins ----------------------------------------------------------

export interface BounceNoticeEnv {
  DB: D1Database;
  mail: MailAdapter;
  /** notifications@<PLATFORM_MAIL_DOMAIN>. */
  from: string;
  /** The dashboard origin, for the link to Sending. */
  appOrigin: string;
}

interface DueHold extends StateRow {
  channel_id: string | null;
  channel_name: string | null;
}

/** The workspace's owners and admins (seats), who can decide a hold. */
async function workspaceAdminEmails(db: D1Database, workspaceId: string): Promise<string[]> {
  const rows = await all<{ email: string }>(
    db,
    `SELECT DISTINCT o.email FROM operators o JOIN seats s ON s.operator_id = o.id
      WHERE s.workspace_id = ?1 AND s.role IN ('owner', 'admin') ORDER BY o.email LIMIT 50`,
    workspaceId,
  );
  return rows.map((r) => r.email);
}

/** Holds per run; the rest wait a minute. */
const NOTICE_BATCH = 20;

/**
 * One email to the workspace's owners and admins for each new hold, from the jobs worker's
 * minute cron. Claimed ('sent') before mailing, so a hold is announced at most once; if every
 * send failed the claim is undone and the next run tries again (as ramp-notices.ts does).
 */
export async function sendBounceHoldNotices(
  env: BounceNoticeEnv,
): Promise<{ notified: number; emails: number }> {
  const due = await all<DueHold>(
    env.DB,
    `SELECT s.*, c.id AS channel_id, c.name AS channel_name
       FROM bounce_states s
       LEFT JOIN channels c ON c.id = (
         SELECT m.channel_id FROM members m JOIN channels mc ON mc.id = m.channel_id
          WHERE mc.workspace_id = s.workspace_id AND mc.deleted_at IS NULL AND m.email = s.email
          ORDER BY EXISTS (SELECT 1 FROM member_entitlements e WHERE e.member_id = m.id AND e.kind = 'paid') DESC,
                   m.created_at
          LIMIT 1)
      WHERE s.hold_notice = 'due' AND s.held_at IS NOT NULL
      LIMIT ${NOTICE_BATCH}`,
  );
  let notified = 0;
  let emails = 0;
  for (const hold of due) {
    const claimed = await first<{ id: string }>(
      env.DB,
      `UPDATE bounce_states SET hold_notice = 'sent' WHERE id = ?1 AND hold_notice = 'due' RETURNING id`,
      hold.id,
    );
    if (!claimed) continue;
    const origin = env.appOrigin.replace(/\/$/, '');
    const link = hold.channel_id ? `${origin}/channels/${hold.channel_id}/sending#bounces` : origin;
    const publication = hold.channel_name ? ` in “${hold.channel_name}”` : '';
    const reason = bounceRuleReason(hold.held_rule!, hold.held_counted, hold.held_days);
    const notice = {
      subject: 'Emails to a subscriber on a paid plan are bouncing',
      lines: [
        `Emails to ${hold.email}, who has a paid plan${publication}, are bouncing. Your bounce rules stop mailing an address after ${reason}, and you asked to decide yourself for subscribers on a paid plan.`,
        `What happened: ${BOUNCE_CAUSE_TEXT[hold.last_cause]}.${hold.last_detail ? ` The receiving server said: “${hold.last_detail.slice(0, 300)}”` : ''}`,
        'Swarm keeps mailing them until you decide. Check the address with them (a typo, a full mailbox, a changed job), then choose Stop mailing or Keep mailing under Needs your attention in Sending.',
        link,
      ],
      category: 'bounce_hold',
      tags: { bounce_hold: hold.id, ...(hold.channel_id ? { channel: hold.channel_id } : {}) },
    };
    const to = await workspaceAdminEmails(env.DB, hold.workspace_id);
    let sent = 0;
    for (const address of to) {
      try {
        sent += await sendOperatorNotice(
          { mail: env.mail, from: env.from },
          { ...notice, to: [address] },
        );
      } catch {
        // One bad address must not stop the others; the hold itself is on the dashboard.
      }
    }
    if (to.length && !sent) {
      await run(
        env.DB,
        `UPDATE bounce_states SET hold_notice = 'due' WHERE id = ?1 AND hold_notice = 'sent'`,
        hold.id,
      );
      continue;
    }
    await appendAudit(env.DB, {
      workspaceId: hold.workspace_id,
      actorId: null,
      action: 'bounce.hold_notified',
      targetType: 'bounce_state',
      targetId: hold.id,
      metadata: { recipients: sent, rule: hold.held_rule },
    });
    notified++;
    emails += sent;
  }
  return { notified, emails };
}
