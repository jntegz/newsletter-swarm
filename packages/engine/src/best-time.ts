/**
 * Send at each reader's best time (flag best_time_send): opt-in per send, within 24 hours of the
 * chosen time.
 *
 *   start      startBroadcast marks the Broadcast. A Split Test or Cohort Sample refuses it, because
 *              their results compare readers who must be sent at the same time. While warming up,
 *              it applies only if today's limit reaches the whole audience: the limit goes to the
 *              likeliest readers first, and personal times would hand it to whoever's hour is
 *              earliest. Otherwise everyone goes at the chosen time, in warm-up order.
 *   snapshot   works out each Member's best hour from human opens and clicks, stores it, and places
 *              the recipient: `send_after` is their slot, and `held` stays 1 until it comes round.
 *              Too little history: no slot, so they go at the chosen time.
 *   minute     the send worker's cron (releaseBestTimeSlots) releases the rows that are due and
 *              restarts the fan-out. From there they are ordinary recipients: the fan-out reserves
 *              warm-up capacity when they really go, which keeps the daily limit true, and batches
 *              re-check that they can still be mailed.
 *
 * `held` already stops fan-out, batches and the reaper, and leaves the Broadcast open, so this adds
 * no new state to any of them. Hours are UTC.
 *
 * Only for a publication that profiles its readers (profileReaders; tracking-choices.ts): starting a
 * send drops the choice otherwise. Someone who asked not to be tracked gets no best hour, so they
 * go at the chosen time.
 */
import { CHANNEL_DELETED_REASON, cancelBroadcast } from './cancel';
import type { PipelineContext } from './pipeline';
import { all, first, run } from './db';
import { utcDay, type RampRow } from './ramp';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** How far back opens and clicks count. */
export const BEST_TIME_HISTORY_DAYS = 90;
/** Fewer engaged posts than this says too little about a reader's habits. */
export const BEST_TIME_MIN_SAMPLES = 3;
/** Stored best hours nothing has used for this long are dropped. */
export const BEST_TIME_RETENTION_DAYS = 90;
/** Broadcasts looked at per cron run. */
const OPEN_SENDS_PER_RUN = 100;

export const BEST_TIME_WITH_TEST_PROBLEM =
  'Sending at each reader’s best time can’t run with a split test or cohort sample, because their results compare readers sent at the same time. Remove the test, or send to everyone at one time.';

export const BEST_TIME_WARM_UP_NOTE =
  'Today’s warm-up limit can’t reach everyone, so everyone would get it at the chosen time, most engaged first.';

/** The hour most of these engaged posts fall in; the earliest hour wins a tie. */
export function bestHour(byHour: ReadonlyMap<number, number>): { hour: number; samples: number } {
  let hour = 0;
  let top = 0;
  let samples = 0;
  for (const [candidate, n] of byHour) {
    samples += n;
    if (n > top || (n === top && candidate < hour)) {
      hour = candidate;
      top = n;
    }
  }
  return { hour, samples };
}

/**
 * The reader's hour within the 24 hours from `start`. Already in that hour means now. Later is the
 * top of the hour, which always falls inside the window.
 */
export function slotFor(start: number, hourUtc: number): number {
  const thisHour = start - (start % HOUR_MS);
  const ahead = (hourUtc - new Date(thisHour).getUTCHours() + 24) % 24;
  return ahead === 0 ? start : thisHour + ahead * HOUR_MS;
}

/** Whether a warming ramp's limit reaches this audience today. A finished ramp limits nothing. */
export function fitsWarmUp(
  ramp: Pick<RampRow, 'status' | 'day' | 'cap_today' | 'sent_today'>,
  recipients: number,
  now: number,
): boolean {
  if (ramp.status === 'complete') return true;
  const used = ramp.day === utcDay(now) ? ramp.sent_today : 0;
  return recipients <= Math.max(0, ramp.cap_today - used);
}

/**
 * Works out and stores the best hour of a page of Members, and returns the slot of each one with
 * enough history. Someone whose history has fallen below the minimum loses their stored hour.
 */
export async function bestTimeSlots(
  db: D1Database,
  broadcast: { channel_id: string; created_at: number },
  memberIds: readonly string[],
  now: number,
): Promise<Map<string, number>> {
  const ids = JSON.stringify(memberIds);
  // One sample per post: when the person first engaged with it. A machine open or a link scanner
  // never sets the human columns.
  const rows = await all<{ member_id: string; hour: number; n: number }>(
    db,
    `SELECT member_id, hour, count(*) AS n FROM (
       SELECT d.member_id,
              (min(coalesce(d.human_opened_at, d.human_clicked_at), coalesce(d.human_clicked_at, d.human_opened_at)) / ${HOUR_MS}) % 24 AS hour
         FROM deliveries d
        WHERE d.member_id IN (SELECT id FROM members WHERE id IN (SELECT value FROM json_each(?1))
                                 AND tracking_opt_out_at IS NULL)
          AND d.channel_id = ?2 AND d.sent_at >= ?3
          AND (d.human_opened_at IS NOT NULL OR d.human_clicked_at IS NOT NULL))
      GROUP BY member_id, hour`,
    ids,
    broadcast.channel_id,
    now - BEST_TIME_HISTORY_DAYS * DAY_MS,
  );
  const byMember = new Map<string, Map<number, number>>();
  for (const row of rows) {
    const hours = byMember.get(row.member_id) ?? new Map<number, number>();
    hours.set(row.hour, row.n);
    byMember.set(row.member_id, hours);
  }
  const slots = new Map<string, number>();
  const stored: [string, number, number][] = [];
  for (const [memberId, hours] of byMember) {
    const { hour, samples } = bestHour(hours);
    if (samples < BEST_TIME_MIN_SAMPLES) continue;
    slots.set(memberId, slotFor(broadcast.created_at, hour));
    stored.push([memberId, hour, samples]);
  }
  await db.batch([
    db
      .prepare('DELETE FROM member_send_hours WHERE member_id IN (SELECT value FROM json_each(?1))')
      .bind(ids),
    db
      .prepare(
        `INSERT INTO member_send_hours (member_id, channel_id, best_hour_utc, samples, computed_at)
         SELECT j.value ->> '$[0]', ?1, j.value ->> '$[1]', j.value ->> '$[2]', ?2 FROM json_each(?3) j`,
      )
      .bind(broadcast.channel_id, now, JSON.stringify(stored)),
  ]);
  return slots;
}

/**
 * Minute cron: hands out the readers whose time has come. Safe to run twice: a released row is no
 * longer held, and the fan-out and batches it restarts are idempotent. Returns the Broadcasts it
 * touched.
 */
export async function releaseBestTimeSlots(
  ctx: Pick<PipelineContext, 'db' | 'queue' | 'log' | 'now'>,
): Promise<string[]> {
  const { db } = ctx;
  const now = ctx.now ? ctx.now() : Date.now();
  const open = await all<{
    id: string;
    fanout_done: number;
    resume_at: number | null;
    channel_deleted: number;
  }>(
    db,
    `SELECT b.id, b.fanout_done, b.resume_at,
            EXISTS (SELECT 1 FROM channels c WHERE c.id = b.channel_id AND c.deleted_at IS NOT NULL) AS channel_deleted
       FROM broadcasts b
      WHERE b.best_time = 1 AND b.status = 'sending' AND b.snapshot_done = 1
      ORDER BY b.last_progress_at LIMIT ?1`,
    OPEN_SENDS_PER_RUN,
  );
  const released: string[] = [];
  for (const broadcast of open) {
    // A deleted Channel mails nobody again: its waiting readers are skipped, not released.
    if (broadcast.channel_deleted) {
      await cancelBroadcast(db, broadcast.id, now, CHANNEL_DELETED_REASON);
      continue;
    }
    const due = await first(
      db,
      `SELECT 1 FROM broadcast_recipients
        WHERE broadcast_id = ?1 AND held = 1 AND send_after <= ?2 AND status = 'pending' LIMIT 1`,
      broadcast.id,
      now,
    );
    if (!due) continue;
    await db.batch([
      db
        .prepare(
          `UPDATE broadcast_recipients SET held = 0
            WHERE broadcast_id = ?1 AND held = 1 AND send_after <= ?2 AND status = 'pending'`,
        )
        .bind(broadcast.id, now),
      db
        .prepare(
          `UPDATE broadcasts SET fanout_done = 0, fanout_cursor = NULL, last_progress_at = ?2,
                  fanout_tier = CASE WHEN fanout_tier IS NULL THEN NULL ELSE 1 END
            WHERE id = ?1 AND status = 'sending'`,
        )
        .bind(broadcast.id, now),
    ]);
    // A fan-out still running or waiting for the warm-up limit walks them from the reset cursor. A
    // second one alongside it would reserve the same capacity twice.
    if (broadcast.fanout_done) await ctx.queue.send({ type: 'fanout', broadcastId: broadcast.id });
    released.push(broadcast.id);
  }
  if (released.length) ctx.log?.('best-time readers released', { broadcasts: released.length });
  return released;
}

/** Drops best hours that no send has used lately. Daily. */
export const pruneMemberSendHours = (db: D1Database, now: number) =>
  run(
    db,
    'DELETE FROM member_send_hours WHERE computed_at < ?1',
    now - BEST_TIME_RETENTION_DAYS * DAY_MS,
  );

/** The send report's counts; null for a send that didn't ask for personal times. */
export const bestTimeReport = (row: {
  best_time?: number;
  personal_time_count?: number;
  default_time_count?: number;
}) =>
  row.best_time
    ? {
        personal: row.personal_time_count ?? 0,
        chosenTime: row.default_time_count ?? 0,
        limitedByWarmUp: row.best_time === 2,
      }
    : null;
