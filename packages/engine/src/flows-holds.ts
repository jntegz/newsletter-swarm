/**
 * Inbox rules in the database: the facts decideInboxRules needs for a real run, the ledger of
 * automated email that the limits count, the holds shown in run history and stats, and the check
 * that stops a new version resending an email someone already got.
 *
 * A hold parks the run the way any deferred send does (flow_run_steps.result_json has `until` and
 * `deferred: 'inbox_rules'`). When it comes due the step runs again from the top, so the Member is
 * rechecked before anything else: someone who left while held exits and gets nothing.
 */
import type {
  FlowExitReason,
  InboxHoldReason,
  InboxRules,
  UpdateInboxRuleSettings,
} from '@swarm/domain';
import {
  AudienceError,
  compileAudience,
  loadAudienceRules,
  parseAudience,
  type FrozenAudience,
} from './circles';
import { all, first, run as exec } from './db';
import { WEEK_MS, type InboxRuleFacts } from './flows-inbox-rules';
import type { FlowRunRow } from './flows';

const DAY_MS = 86_400_000;
/** How far back and ahead posts can matter: the widest "hours around", plus the rest of a day. */
const POST_WINDOW_MS = 4 * DAY_MS;
const POST_SCAN_LIMIT = 30;

// ---- Facts -----------------------------------------------------------------------------------

/** Whether this Member is in an audience right now. One that can't be read matches nobody. */
async function inAudience(
  db: D1Database,
  channelId: string,
  memberId: string,
  audience: FrozenAudience,
  now: number,
): Promise<boolean> {
  let compiled;
  try {
    compiled = await compileAudience(db, channelId, audience, now);
  } catch (error) {
    if (error instanceof AudienceError) return false;
    throw error;
  }
  const row = await first(
    db,
    `SELECT 1 AS ok FROM members m WHERE m.id = ?2 AND m.channel_id = ?3 AND (${compiled.where})`,
    ...compiled.params,
    memberId,
    channelId,
  );
  return row !== null;
}

/**
 * When this Member got or will get a post, around `now`: Broadcasts that hold a recipient row for
 * them, Broadcasts still working out who gets them, and Dispatches scheduled to send.
 */
export async function postTimesForMember(
  db: D1Database,
  channelId: string,
  memberId: string,
  now: number,
): Promise<number[]> {
  const times: number[] = [];
  const broadcasts = await all<{
    status: string;
    snapshot_done: number;
    audience_json: string;
    created_at: number;
    recipient: string | null;
    sent_at: number | null;
  }>(
    db,
    `SELECT b.status, b.snapshot_done, b.audience_json, b.created_at,
            (SELECT r.status FROM broadcast_recipients r
              WHERE r.broadcast_id = b.id AND r.member_id = ?2 AND r.held = 0) AS recipient,
            (SELECT d.sent_at FROM deliveries d
              WHERE d.broadcast_id = b.id AND d.member_id = ?2) AS sent_at
       FROM broadcasts b
      WHERE b.channel_id = ?1 AND b.kind = 'broadcast' AND b.created_at > ?3
        AND b.status <> 'canceled'
      ORDER BY b.created_at DESC LIMIT ?4`,
    channelId,
    memberId,
    now - POST_WINDOW_MS,
    POST_SCAN_LIMIT,
  );
  for (const b of broadcasts) {
    if (b.recipient === 'pending' || b.recipient === 'sending' || b.recipient === 'sent') {
      times.push(b.sent_at ?? b.created_at);
    } else if (
      b.recipient === null &&
      b.snapshot_done === 0 &&
      (b.status === 'queued' || b.status === 'sending') &&
      (await inAudience(db, channelId, memberId, parseAudience(b.audience_json), now))
    ) {
      times.push(b.created_at);
    }
  }
  const scheduled = await all<{ publish_at: number; audience_json: string }>(
    db,
    `SELECT publish_at, audience_json FROM dispatches
      WHERE channel_id = ?1 AND kind = 'broadcast' AND status = 'scheduled'
        AND publish_at BETWEEN ?2 AND ?3
      ORDER BY publish_at LIMIT ?4`,
    channelId,
    now - POST_WINDOW_MS,
    now + POST_WINDOW_MS,
    POST_SCAN_LIMIT,
  );
  for (const dispatch of scheduled) {
    let audience: FrozenAudience;
    try {
      audience = await loadAudienceRules(db, channelId, parseAudience(dispatch.audience_json));
    } catch (error) {
      if (error instanceof AudienceError) continue;
      throw error;
    }
    if (await inAudience(db, channelId, memberId, audience, now)) times.push(dispatch.publish_at);
  }
  return times;
}

/** What decideInboxRules needs for this run's send step, read from the database. */
export async function loadInboxRuleFacts(
  db: D1Database,
  input: {
    run: Pick<FlowRunRow, 'id' | 'member_id' | 'channel_id'>;
    nodeId: string;
    rules: InboxRules;
    zone: string;
    sendRegardless: boolean;
    now: number;
  },
): Promise<InboxRuleFacts> {
  const { run, nodeId, rules, zone, sendRegardless, now } = input;
  const base = { now, rules, zone, sendRegardless };
  if (sendRegardless) return { ...base, recentSends: [], posts: [], heldSince: null, ahead: null };
  const hold = await first<{ held_at: number }>(
    db,
    'SELECT held_at FROM flow_holds WHERE run_id = ?1 AND node_id = ?2 AND released_at IS NULL',
    run.id,
    nodeId,
  );
  const sends = await all<{ sent_at: number }>(
    db,
    'SELECT sent_at FROM flow_email_ledger WHERE member_id = ?1 AND sent_at > ?2',
    run.member_id,
    now - WEEK_MS,
  );
  const heldSince = hold?.held_at ?? null;
  // Held emails of this Member that came first and can still go (a paused run can't, so it holds
  // nobody up). A run that is mid-step has only the time it was held for.
  const ahead = await first<{ until: number | null }>(
    db,
    `SELECT max(max(h.until, CASE WHEN r.status = 'waiting' THEN coalesce(r.next_at, 0) ELSE 0 END)) AS until
       FROM flow_holds h JOIN flow_runs r ON r.id = h.run_id
      WHERE h.member_id = ?1 AND h.released_at IS NULL AND h.node_id = r.current_node_id
        AND r.status IN ('running', 'waiting') AND h.run_id <> ?2 AND (h.held_at < ?3 OR (h.held_at = ?3 AND h.run_id < ?2))`,
    run.member_id,
    run.id,
    heldSince ?? now,
  );
  return {
    ...base,
    recentSends: sends.map((s) => s.sent_at),
    posts: rules.newsletterDay
      ? await postTimesForMember(db, run.channel_id, run.member_id, now)
      : [],
    heldSince,
    ahead: ahead?.until ?? null,
  };
}

// ---- The ledger ------------------------------------------------------------------------------

/**
 * Takes this email's place in the ledger. With a limit in force the INSERT only happens while there
 * is room, as one statement, so concurrent runs can't both take the last place. False when there
 * is none left; an existing row (a retried step) keeps its place.
 */
export async function takeLedgerSlot(
  db: D1Database,
  input: {
    run: Pick<FlowRunRow, 'member_id' | 'channel_id'>;
    broadcastId: string;
    rules: InboxRules;
    sendRegardless: boolean;
    now: number;
  },
): Promise<boolean> {
  const { run, broadcastId, rules, sendRegardless, now } = input;
  const inserted = await exec(
    db,
    `INSERT INTO flow_email_ledger (member_id, broadcast_id, channel_id, send_regardless, sent_at)
     SELECT ?1, ?2, ?3, ?4, ?5
      WHERE ?4 = 1 OR (
        (?6 IS NULL OR (SELECT count(*) FROM flow_email_ledger
                         WHERE member_id = ?1 AND sent_at > ?5 - ?8) < ?6)
        AND (?7 IS NULL OR (SELECT count(*) FROM flow_email_ledger
                             WHERE member_id = ?1 AND sent_at > ?5 - ?9) < ?7))
     ON CONFLICT DO NOTHING`,
    run.member_id,
    broadcastId,
    run.channel_id,
    sendRegardless ? 1 : 0,
    now,
    rules.perDay,
    rules.perWeek,
    DAY_MS,
    WEEK_MS,
  );
  if (inserted.meta.changes) return true;
  const existing = await first(
    db,
    'SELECT 1 AS ok FROM flow_email_ledger WHERE member_id = ?1 AND broadcast_id = ?2',
    run.member_id,
    broadcastId,
  );
  return existing !== null;
}

/** Gives a place back when the email didn't go, unless another run of this Member did send it. */
export const dropLedgerSlot = (db: D1Database, memberId: string, broadcastId: string) =>
  exec(
    db,
    `DELETE FROM flow_email_ledger WHERE member_id = ?1 AND broadcast_id = ?2
        AND NOT EXISTS (SELECT 1 FROM broadcast_recipients r
                         WHERE r.broadcast_id = ?2 AND r.member_id = ?1)`,
    memberId,
    broadcastId,
  );

/** Forgets ledger rows older than the longest limit window. Run daily. */
export const pruneFlowEmailLedger = (db: D1Database, now: number) =>
  exec(db, 'DELETE FROM flow_email_ledger WHERE sent_at < ?1', now - WEEK_MS - DAY_MS);

// ---- Holds -----------------------------------------------------------------------------------

/** Records that a step is held, keeping the time its wait began. */
export const recordHold = (
  db: D1Database,
  input: {
    run: Pick<FlowRunRow, 'id' | 'flow_id' | 'version' | 'channel_id' | 'member_id'>;
    nodeId: string;
    reason: InboxHoldReason;
    until: number;
    zone: string;
    now: number;
  },
) =>
  exec(
    db,
    `INSERT INTO flow_holds (run_id, node_id, flow_id, version, channel_id, member_id, reason, until, zone, held_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT (run_id, node_id) DO UPDATE SET reason = ?7, until = ?8, zone = ?9, version = ?4`,
    input.run.id,
    input.nodeId,
    input.run.flow_id,
    input.run.version,
    input.run.channel_id,
    input.run.member_id,
    input.reason,
    input.until,
    input.zone,
    input.now,
  );

/** Closes a step's hold, if it has one, saying how it ended. */
export const releaseHold = (
  db: D1Database,
  runId: string,
  nodeId: string,
  outcome: 'sent' | 'skipped' | 'expired' | 'left',
  now: number,
) =>
  exec(
    db,
    `UPDATE flow_holds SET released_at = ?1, outcome = ?2
      WHERE run_id = ?3 AND node_id = ?4 AND released_at IS NULL`,
    now,
    outcome,
    runId,
    nodeId,
  );

/** How a finished send step's hold ended, from how the step finished. */
export function holdOutcome(
  finished:
    { kind: 'next'; status?: 'done' | 'skipped' } | { kind: 'exit'; reason: FlowExitReason },
): 'sent' | 'skipped' | 'expired' | 'left' {
  if (finished.kind === 'next') return finished.status === 'skipped' ? 'skipped' : 'sent';
  return finished.reason === 'hold_expired' ? 'expired' : 'left';
}

/**
 * Saves a Channel's rules and time zone, then looks at its held emails again straight away: a rule
 * that was loosened shouldn't keep them waiting until the old time. Each one decides again under
 * the new rules when the sweep picks it up.
 */
export async function saveInboxRules(
  db: D1Database,
  channelId: string,
  input: UpdateInboxRuleSettings,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE channels
            SET settings_json = CASE WHEN ?3 IS NULL
                  THEN json_remove(json_set(settings_json, '$.inboxRules', json(?2)), '$.timezone')
                  ELSE json_set(settings_json, '$.inboxRules', json(?2), '$.timezone', ?3) END,
                updated_at = ?4
          WHERE id = ?1`,
      )
      .bind(channelId, JSON.stringify(input.rules), input.timezone, now),
    db
      .prepare(
        `UPDATE flow_run_steps SET result_json = json_set(result_json, '$.until', ?2)
          WHERE status = 'pending' AND json_extract(result_json, '$.deferred') = 'inbox_rules'
            AND EXISTS (SELECT 1 FROM flow_holds h
                         WHERE h.run_id = flow_run_steps.run_id AND h.node_id = flow_run_steps.node_id
                           AND h.channel_id = ?1 AND h.released_at IS NULL)`,
      )
      .bind(channelId, now),
    db
      .prepare(
        `UPDATE flow_runs SET next_at = ?2, updated_at = ?2
          WHERE status = 'waiting'
            AND EXISTS (SELECT 1 FROM flow_holds h
                         WHERE h.run_id = flow_runs.id AND h.node_id = flow_runs.current_node_id
                           AND h.channel_id = ?1 AND h.released_at IS NULL)`,
      )
      .bind(channelId, now),
  ]);
}

/** Emails of a Channel held right now. */
export async function heldNowInChannel(db: D1Database, channelId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM flow_holds h JOIN flow_runs r ON r.id = h.run_id
      WHERE h.channel_id = ?1 AND h.released_at IS NULL AND h.node_id = r.current_node_id
        AND r.status IN ('running', 'waiting', 'paused')`,
    channelId,
  );
  return row?.n ?? 0;
}

// ---- Repeat sends ----------------------------------------------------------------------------

/**
 * Whether the Member already has this email from another version of the Flow. An email is its
 * Dispatch, so editing it or moving its step changes nothing. Versions before the newest one where
 * the writer asked to resend it (flow_emails.resend) no longer count. A row stopped at the last
 * moment ('skipped') or that failed was never received.
 */
export async function alreadyReceived(
  db: D1Database,
  run: Pick<FlowRunRow, 'flow_id' | 'version' | 'member_id'>,
  dispatchId: string,
  broadcastId: string,
): Promise<boolean> {
  const row = await first(
    db,
    `SELECT 1 AS ok FROM flow_emails fe
       JOIN broadcast_recipients r ON r.broadcast_id = fe.broadcast_id AND r.member_id = ?3
      WHERE fe.flow_id = ?1 AND fe.dispatch_id = ?2 AND fe.broadcast_id <> ?4
        AND r.status IN ('pending', 'sending', 'sent')
        AND fe.version >= (SELECT coalesce(max(version), 0) FROM flow_emails
                            WHERE flow_id = ?1 AND dispatch_id = ?2 AND resend = 1 AND version <= ?5)
      LIMIT 1`,
    run.flow_id,
    dispatchId,
    run.member_id,
    broadcastId,
    run.version,
  );
  return row !== null;
}
