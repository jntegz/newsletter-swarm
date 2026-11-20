/**
 * Site readers (Phase 4): who a signed-in reader is entitled to be on a Channel's website, and the
 * retention rules for the site's reader and analytics tables.
 *
 * - A reader is a 'member' while their Member row is active or paused; any other status
 *   (pending, unsubscribed, bounced, complained) reads as anonymous.
 * - They are 'paid' when they also hold a current `member_entitlements` row of kind 'paid'
 *   (started, and not expired). Phase 5 writes entitlements; Phase 4 only reads them.
 */
import type { ReaderClass } from '@swarm/domain';

/** Member statuses that may sign in on the site and read Member-only Dispatches. */
export const READER_MEMBER_STATUSES = ['active', 'paused'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Signed-in Members' free-read meter rows (gate_meter_reads) are kept this long: the current
 * period and the one before, for the longest period (a month). Anonymous visitors have no rows.
 */
export const METER_READS_KEEP_MS = 62 * DAY_MS;

/** The reader class for one Member of one Channel at `now` (milliseconds). */
export async function readerClassFor(
  db: D1Database,
  channelId: string,
  memberId: string,
  now: number = Date.now(),
): Promise<ReaderClass> {
  const row = await db
    .prepare(
      `SELECT m.status AS status,
              EXISTS (SELECT 1 FROM member_entitlements e
                       WHERE e.member_id = m.id AND e.channel_id = m.channel_id AND e.kind = 'paid'
                         AND e.starts_at <= ?3 AND (e.expires_at IS NULL OR e.expires_at > ?3)) AS paid
         FROM members m
        WHERE m.id = ?1 AND m.channel_id = ?2`,
    )
    .bind(memberId, channelId, now)
    .first<{ status: string; paid: number }>();
  if (!row || !(READER_MEMBER_STATUSES as readonly string[]).includes(row.status)) {
    return 'anonymous';
  }
  return row.paid ? 'paid' : 'member';
}

/** UTC calendar day, as stored in the analytics tables. */
export function analyticsDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Housekeeping for the site edge, for the jobs worker's daily cron:
 * - visitor hashes are kept for today and yesterday only (the daily salt lives two days in KV,
 *   so older hashes could not be recomputed anyway);
 * - sign-in tokens a day past expiry, and expired reader sessions, are deleted;
 * - mail allowances (mail_allowances) whose window ended a day ago are deleted;
 * - free-read meter rows older than METER_READS_KEEP_MS are deleted, so no reading history
 *   outlives the meter's need for it.
 */
export async function pruneSiteEdge(
  db: D1Database,
  now: number = Date.now(),
): Promise<{
  visitors: number;
  tokens: number;
  sessions: number;
  allowances: number;
  meterReads: number;
}> {
  const results = await db.batch([
    db.prepare('DELETE FROM site_visitors WHERE day < ?1').bind(analyticsDay(now - DAY_MS)),
    db.prepare('DELETE FROM reader_tokens WHERE expires_at < ?1').bind(now - DAY_MS),
    db.prepare('DELETE FROM reader_sessions WHERE expires_at < ?1').bind(now),
    db.prepare('DELETE FROM mail_allowances WHERE window_start < ?1').bind(now - 2 * DAY_MS),
    db.prepare('DELETE FROM gate_meter_reads WHERE read_at < ?1').bind(now - METER_READS_KEEP_MS),
  ]);
  return {
    visitors: results[0]?.meta.changes ?? 0,
    tokens: results[1]?.meta.changes ?? 0,
    sessions: results[2]?.meta.changes ?? 0,
    allowances: results[3]?.meta.changes ?? 0,
    meterReads: results[4]?.meta.changes ?? 0,
  };
}
