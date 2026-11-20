/**
 * A send waiting for a sending limit (broadcasts.waiting_for, 0066_sending_limits.sql). Nothing
 * is lost while it waits: every unsent recipient stays 'pending'.
 *
 * - Short waits (hour, day, service_day): the batches come back as new delayed messages when the
 *   window resets, and the fan-out checks again then. They never count against max_retries.
 * - Pausing waits (month, service_month, service_stopped): nothing is in flight; batches that
 *   arrive give their warm-up capacity back. The minute cron resumes a month's pause whose
 *   resume_at has come (resumeDueSends), and a person can resume any send sooner
 *   (POST /api/v1/broadcasts/{broadcastId}/resume). The owners hear about a pause once.
 * - service_stopped: at resume_at the cron tries the email service with one email (pipeline.ts
 *   retryStoppedSends), the wait doubling up to SERVICE_STOPPED_RETRY.maxMs, and the whole send
 *   goes on once it answers. After SERVICE_STOPPED_RETRY.giveUpMs the send ends, and everyone
 *   still waiting is recorded as failed.
 *
 * Resuming walks the fan-out again from the start, like best-time releases do. The walk reserves
 * warm-up capacity only for recipients that hold none for today (broadcast_recipients.reserved_on,
 * 0070_limits_fixes.sql): one waiting in a delayed batch is handed out again without counting it
 * twice, and one whose reservation ended with its day is counted on the day it really goes.
 */
import {
  PAUSING_WAITS,
  SEND_WAIT_REASONS,
  SERVICE_STOPPED_RETRY,
  type SendWait,
  type SendWaitReason,
} from '@swarm/domain';
import { escapeHtml } from '@swarm/mail';
import { BATCH_SIZE, type SendMessage, type SendQueue } from './config';
import { all, first, run, toIso } from './db';
import { resumeTime } from './sending-limits';

export interface WaitColumns {
  status: string;
  waiting_for: SendWaitReason | null;
  waiting_since: number | null;
  wait_detail: string | null;
  resume_at: number | null;
  recipient_count: number;
  sent_count: number;
  failed_count: number;
  last_progress_at: number;
  share_wait_since?: number | null;
  share_wait_until?: number | null;
}

export const isPausing = (reason: SendWaitReason | null): boolean =>
  reason !== null && PAUSING_WAITS.includes(reason);

/**
 * The wait in force now, or null. A pause holds until it is resumed, even past resume_at (the
 * cron resumes it within a minute); a short wait is over once resume_at has passed.
 */
export function activeWait(row: WaitColumns, now: number): SendWaitReason | null {
  if (!row.waiting_for || !(SEND_WAIT_REASONS as readonly string[]).includes(row.waiting_for)) {
    return null;
  }
  if (row.status !== 'queued' && row.status !== 'sending') return null;
  if (isPausing(row.waiting_for)) return row.waiting_for;
  return row.resume_at !== null && row.resume_at > now ? row.waiting_for : null;
}

/** The send report's `waiting`: null when the send isn't waiting. */
export function toSendWait(row: WaitColumns, now = Date.now()): SendWait | null {
  const reason = activeWait(row, now);
  if (!reason) {
    // Held for its workspace's share of the install's capacity (0119): it asks again by itself.
    const until = row.share_wait_until ?? null;
    if (row.status === 'sending' && row.share_wait_since && until !== null && until > now) {
      return {
        reason: 'share',
        since: toIso(row.share_wait_since),
        until: toIso(until),
        left: Math.max(0, row.recipient_count - row.sent_count - row.failed_count),
        detail: null,
      };
    }
    return null;
  }
  return {
    reason,
    since: toIso(row.waiting_since ?? row.last_progress_at),
    until: row.resume_at === null ? null : toIso(row.resume_at),
    left: Math.max(0, row.recipient_count - row.sent_count - row.failed_count),
    detail: row.wait_detail,
  };
}

/** The columns toSendWait reads, for a SELECT. */
export const WAIT_COLUMNS =
  'status, waiting_for, waiting_since, wait_detail, resume_at, recipient_count, sent_count, failed_count, last_progress_at, share_wait_since, share_wait_until';

/**
 * Records a wait. A pause wins over a short wait and is never replaced by another wait; a short
 * wait is replaced only by one that lasts longer. Returns whether this call recorded it, so a
 * pause's notice goes out once however many batches find it.
 */
export async function startWait(
  db: D1Database,
  broadcastId: string,
  wait: { reason: SendWaitReason; until: number | null; detail?: string | null },
  now: number,
): Promise<boolean> {
  const current = await first<{ waiting_for: SendWaitReason | null; resume_at: number | null }>(
    db,
    `SELECT waiting_for, resume_at FROM broadcasts WHERE id = ?1 AND status IN ('queued', 'sending')`,
    broadcastId,
  );
  if (!current || isPausing(current.waiting_for)) return false;
  const pausing = isPausing(wait.reason);
  if (!pausing && current.waiting_for && (current.resume_at ?? 0) > (wait.until ?? 0)) return false;
  // Compare-and-set on the wait read above: of two batches finding the same limit, one records it.
  const recorded = await first<{ id: string }>(
    db,
    `UPDATE broadcasts
        SET waiting_for = ?2, wait_detail = ?3,
            resume_at = CASE WHEN ?6 = 1 THEN ?4 ELSE max(ifnull(resume_at, 0), ?4) END,
            waiting_since = CASE WHEN ?6 = 1 OR waiting_for IS NULL THEN ?5 ELSE waiting_since END,
            last_progress_at = ?5
      WHERE id = ?1 AND status IN ('queued', 'sending') AND waiting_for IS ?7
      RETURNING id`,
    broadcastId,
    wait.reason,
    wait.detail ?? null,
    wait.until,
    now,
    pausing ? 1 : 0,
    current.waiting_for,
  );
  return !!recorded;
}

/** Ends a short wait that has run out, once the send is moving again. */
export async function clearFinishedWait(db: D1Database, broadcastId: string, now: number) {
  await run(
    db,
    `UPDATE broadcasts SET waiting_for = NULL, waiting_since = NULL, wait_detail = NULL
      WHERE id = ?1 AND waiting_for IN ('hour', 'day', 'service_day') AND ifnull(resume_at, 0) <= ?2`,
    broadcastId,
    now,
  );
}

/** Seconds a queue message may be delayed for a wait ending at `until` (Queues: 12 h at most). */
export const waitDelaySeconds = (until: number, now: number): number =>
  Math.max(1, Math.min(43_200, Math.ceil((until - now) / 1000) + 1));

/**
 * Resumes a waiting send now. A Broadcast walks its fan-out again from the start, so recipients
 * waiting in delayed batches go now too (reserving warm-up only for those that hold none for
 * today); a Flow email's Broadcast has no fan-out, so its pending recipients go back on the queue.
 * Returns false when the send isn't waiting (or has finished).
 */
export async function resumeSend(
  db: D1Database,
  queue: SendQueue,
  broadcastId: string,
  now: number,
): Promise<boolean> {
  const before = await first<{
    kind: 'broadcast' | 'flow';
    waiting_for: SendWaitReason | null;
    snapshot_done: number;
    fanout_done: number;
  }>(
    db,
    `SELECT kind, waiting_for, snapshot_done, fanout_done FROM broadcasts
      WHERE id = ?1 AND status IN ('queued', 'sending') AND waiting_for IS NOT NULL`,
    broadcastId,
  );
  if (!before) return false;
  const resumed = await first<{ id: string }>(
    db,
    `UPDATE broadcasts
        SET waiting_for = NULL, waiting_since = NULL, wait_detail = NULL, resume_at = NULL,
            last_progress_at = ?2,
            fanout_done = CASE WHEN kind = 'broadcast' AND snapshot_done = 1 THEN 0 ELSE fanout_done END,
            fanout_cursor = CASE WHEN kind = 'broadcast' THEN NULL ELSE fanout_cursor END,
            fanout_tier = CASE WHEN kind = 'broadcast' AND fanout_tier IS NOT NULL THEN 1 ELSE fanout_tier END
      WHERE id = ?1 AND status IN ('queued', 'sending') AND waiting_for = ?3
      RETURNING id`,
    broadcastId,
    now,
    before.waiting_for,
  );
  if (!resumed) return false;
  if (before.kind === 'flow') {
    await requeuePending(db, queue, broadcastId);
  } else if (!before.snapshot_done) {
    await queue.send({ type: 'snapshot', broadcastId });
  } else {
    // Now, even beside a short wait's delayed fan-out: two fan-outs at the same place become one
    // (the cursor moves first), so nothing is reserved or handed out twice.
    await queue.send({ type: 'fanout', broadcastId });
  }
  return true;
}

/** Every pending recipient of a Flow email's Broadcast back on the queue, 50 to a batch. */
async function requeuePending(db: D1Database, queue: SendQueue, broadcastId: string) {
  let after = '';
  for (;;) {
    const page = await all<{ member_id: string }>(
      db,
      `SELECT member_id FROM broadcast_recipients
        WHERE broadcast_id = ?1 AND status = 'pending' AND held = 0 AND member_id > ?2
        ORDER BY member_id LIMIT 1000`,
      broadcastId,
      after,
    );
    if (!page.length) return;
    const batches: { body: SendMessage }[] = [];
    for (let i = 0; i < page.length; i += BATCH_SIZE) {
      batches.push({
        body: {
          type: 'batch',
          broadcastId,
          memberIds: page.slice(i, i + BATCH_SIZE).map((r) => r.member_id),
        },
      });
    }
    for (let i = 0; i < batches.length; i += 100) await queue.sendBatch(batches.slice(i, i + 100));
    after = page.at(-1)!.member_id;
    if (page.length < 1000) return;
  }
}

/**
 * Minute cron: resumes sends paused for a month whose resume_at has come (a new month). A send the
 * email service stopped is tried again instead (pipeline.ts retryStoppedSends).
 */
export async function resumeDueSends(
  db: D1Database,
  queue: SendQueue,
  now: number,
): Promise<string[]> {
  const due = await all<{ id: string }>(
    db,
    `SELECT id FROM broadcasts
      WHERE waiting_for IN ('month', 'service_month') AND status IN ('queued', 'sending')
        AND resume_at IS NOT NULL AND resume_at <= ?1
      ORDER BY resume_at LIMIT 20`,
    now,
  );
  const resumed: string[] = [];
  for (const { id } of due) if (await resumeSend(db, queue, id, now)) resumed.push(id);
  return resumed;
}

/** Resumes every send waiting for this Swarm's own limits, after an instance admin changed them. */
export async function resumeLimitWaits(
  db: D1Database,
  queue: SendQueue,
  now: number,
): Promise<number> {
  const waiting = await all<{ id: string }>(
    db,
    `SELECT id FROM broadcasts
      WHERE waiting_for IN ('hour', 'day', 'month') AND status IN ('queued', 'sending')
      ORDER BY waiting_since LIMIT 100`,
  );
  let resumed = 0;
  for (const { id } of waiting) if (await resumeSend(db, queue, id, now)) resumed++;
  return resumed;
}

/** Sends on this Swarm waiting now, for Settings > Instance. */
export async function waitingSendCount(db: D1Database, now: number): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM broadcasts
      WHERE waiting_for IS NOT NULL AND status IN ('queued', 'sending')
        AND (waiting_for IN ('month', 'service_month', 'service_stopped') OR resume_at > ?1)`,
    now,
  );
  return row?.n ?? 0;
}

// ---- The owners' notice ---------------------------------------------------------------------

const NOTICE_LEAD: Record<SendWaitReason, string> = {
  hour: 'reached this Swarm’s hourly sending limit',
  day: 'reached this Swarm’s daily sending limit',
  month: 'reached this Swarm’s monthly sending limit',
  service_day: 'stopped because the email service’s daily quota is used up',
  service_month: 'stopped because the email service’s monthly quota is used up',
  service_stopped: 'stopped because the email service stopped accepting mail',
};

/** The email to a send's owners, admins and creator about a pause; null when there is nobody. */
export async function waitNotice(
  db: D1Database,
  broadcastId: string,
  now = Date.now(),
): Promise<{ to: string[]; subject: string; html: string; text: string } | null> {
  const row = await first<
    WaitColumns & {
      workspace_id: string;
      subject: string;
      created_by: string | null;
      channel_name: string;
    }
  >(
    db,
    `SELECT b.workspace_id, b.subject, b.created_by, c.name AS channel_name,
            ${WAIT_COLUMNS.split(', ')
              .map((column) => `b.${column}`)
              .join(', ')}
       FROM broadcasts b JOIN channels c ON c.id = b.channel_id WHERE b.id = ?1`,
    broadcastId,
  );
  const wait = row ? toSendWait(row, now) : null;
  // Only pauses are mailed; waiting for its share of capacity goes on by itself.
  if (!row || !wait || wait.reason === 'share') return null;
  const operators = await all<{ email: string }>(
    db,
    `SELECT DISTINCT o.email FROM operators o JOIN seats s ON s.operator_id = o.id
      WHERE s.workspace_id = ?1 AND (s.role IN ('owner', 'admin') OR o.id = ?2)`,
    row.workspace_id,
    row.created_by,
  );
  if (!operators.length) return null;
  const left = new Intl.NumberFormat('en-US').format(wait.left);
  const lead = `The send of “${row.subject}” in ${row.channel_name} ${NOTICE_LEAD[wait.reason]}${
    wait.detail ? ` (${wait.detail})` : ''
  }. Nobody was dropped: ${left} ${wait.left === 1 ? 'subscriber is' : 'subscribers are'} still waiting.`;
  const next =
    wait.reason === 'service_stopped'
      ? `Swarm tries the email service again by itself, less often as time goes on, until ${giveUpTime(Date.parse(wait.since))}, and sends the rest once it takes mail. To send sooner, fix the email service (its account, keys or domain), then open the send report in Swarm and choose Resume sending. If it still refuses mail by then, the send ends and the subscribers still waiting are recorded as not sent.`
      : wait.until !== null
        ? `Sending continues by itself at ${resumeTime(Date.parse(wait.until), now)}. To send sooner, raise the limit or the plan, then open the send report in Swarm and choose Resume sending.`
        : 'Once the email service is fixed, open the send report in Swarm and choose Resume sending.';
  return {
    to: operators.map((o) => o.email),
    subject: `Sending paused: ${row.subject}`.slice(0, 200),
    text: `${lead}\n\n${next}\n`,
    html: `<p>${escapeHtml(lead)}</p><p>${escapeHtml(next)}</p>`,
  };
}

const giveUpDay = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

/** "24 November, 10:00 UTC": when a send the email service stopped at `since` ends. */
export const giveUpTime = (since: number): string =>
  `${giveUpDay.format(since + SERVICE_STOPPED_RETRY.giveUpMs).replace(' at ', ', ')} UTC`;

/**
 * The email to a send's owners, admins and creator when the email service refused mail for
 * SERVICE_STOPPED_RETRY.giveUpMs and the send ended (pipeline.ts endStoppedSend). Null when there
 * is nobody, or nobody was left.
 */
export async function endedNotice(
  db: D1Database,
  broadcastId: string,
  notSent: number,
): Promise<{ to: string[]; subject: string; html: string; text: string } | null> {
  if (notSent <= 0) return null;
  const row = await first<{
    workspace_id: string;
    subject: string;
    created_by: string | null;
    channel_name: string;
    kind: 'broadcast' | 'flow';
    sent_count: number;
    failure_reason: string | null;
  }>(
    db,
    `SELECT b.workspace_id, b.subject, b.created_by, b.kind, b.sent_count, b.failure_reason,
            c.name AS channel_name
       FROM broadcasts b JOIN channels c ON c.id = b.channel_id WHERE b.id = ?1`,
    broadcastId,
  );
  if (!row) return null;
  const operators = await all<{ email: string }>(
    db,
    `SELECT DISTINCT o.email FROM operators o JOIN seats s ON s.operator_id = o.id
      WHERE s.workspace_id = ?1 AND (s.role IN ('owner', 'admin') OR o.id = ?2)`,
    row.workspace_id,
    row.created_by,
  );
  if (!operators.length) return null;
  const count = new Intl.NumberFormat('en-US').format(notSent);
  const people = notSent === 1 ? 'subscriber was' : 'subscribers were';
  const days = SERVICE_STOPPED_RETRY.giveUpMs / 86_400_000;
  const lead = `The email service still refused mail ${days} days after it stopped accepting it, so the send of “${row.subject}” in ${row.channel_name} ended: ${count} ${people} not sent it.`;
  const next =
    row.kind === 'flow'
      ? 'This automation email goes on with the next subscribers who reach it. Fix the email service (its account, keys or domain) so they get it.'
      : row.sent_count > 0
        ? 'Fix the email service (its account, keys or domain). The post went to everyone else; Swarm will not send it to these subscribers by itself.'
        : 'Fix the email service (its account, keys or domain), then send the post again: it is back in your drafts.';
  return {
    to: operators.map((o) => o.email),
    subject: `Send ended: ${row.subject}`.slice(0, 200),
    text: `${lead}\n\n${next}\n`,
    html: `<p>${escapeHtml(lead)}</p><p>${escapeHtml(next)}</p>`,
  };
}
