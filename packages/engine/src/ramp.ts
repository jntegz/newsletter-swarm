/**
 * Reputation Ramp: a daily sending cap per sending domain (or per Channel on the shared
 * platform domain) that grows while the domain stays healthy.
 *
 * - Each UTC day the cap grows by `growth` if yesterday was healthy and at least half used.
 * - Bounce or complaint rates over the thresholds pause the ramp. A paused ramp sends nothing
 *   until an operator resumes it; Broadcasts wait instead of failing.
 * - Once the cap reaches `max_cap` the ramp is complete and no longer limits sending.
 */
import { RAMP_PACES, SHARED_RAMP_MAX_CAP, type RampKind } from '@swarm/domain';
import { all, first, newIdFor, run } from './db';

export interface RampRow {
  id: string;
  channel_id: string;
  sending_domain_id: string | null;
  status: 'warming' | 'paused' | 'complete';
  day: string;
  cap_today: number;
  sent_today: number;
  start_cap: number;
  growth: number;
  max_cap: number;
  bounce_threshold: number;
  complaint_threshold: number;
  paused_reason: string | null;
  /**
   * Who paused it (0069): 'system' when it paused itself over bounces or complaints, 'person'
   * when someone pressed Pause sending; null while it is not paused. The reason is free text and
   * never decides who may resume.
   */
  paused_by: RampPausedBy | null;
  /** 'due' after an anomaly pause until the notice is sent (0026). */
  pause_notice: 'due' | 'sent' | null;
  created_at: number;
  /** When an admin skipped warm-up (0062); null on a ramp that warmed up or is warming. */
  skipped_at: number | null;
  /** The UTC day this warm-up started or started again (0062); null on older ramps. */
  started_day: string | null;
}

/** A new ramp starts at the Standard pace of its kind (RAMP_PACES in @swarm/domain). */

export const RAMP_DEFAULTS = {
  /** A verified custom domain. */
  custom: { ...RAMP_PACES.custom.standard, maxCap: 1_000_000 },
  /** The shared platform domain: slower and lower, because Channels share its reputation. */
  platform: { ...RAMP_PACES.shared.standard, maxCap: SHARED_RAMP_MAX_CAP },
  bounceThreshold: 0.02,
  complaintThreshold: 0.0008,
};

export type RampPausedBy = 'system' | 'person';

/** The reason a person's pause shows. */
export const PERSON_PAUSE_REASON = 'Paused by a teammate.';

/** Rates are only judged once there is enough volume to mean something. */
const MIN_SAMPLE = 100;

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function ensureRamp(
  db: D1Database,
  channelId: string,
  sendingDomainId: string | null,
  now = Date.now(),
): Promise<RampRow> {
  const defaults = sendingDomainId ? RAMP_DEFAULTS.custom : RAMP_DEFAULTS.platform;
  await run(
    db,
    `INSERT INTO reputation_ramps (id, channel_id, sending_domain_id, status, day, cap_today, start_cap,
       growth, max_cap, bounce_threshold, complaint_threshold, created_at, updated_at, started_day)
     VALUES (?1, ?2, ?3, 'warming', ?4, ?5, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?4)
     ON CONFLICT DO NOTHING`,
    newIdFor('reputationRamp', now),
    channelId,
    sendingDomainId,
    utcDay(now),
    defaults.startCap,
    defaults.growth,
    defaults.maxCap,
    RAMP_DEFAULTS.bounceThreshold,
    RAMP_DEFAULTS.complaintThreshold,
    now,
  );
  const row = await first<RampRow>(
    db,
    `SELECT * FROM reputation_ramps WHERE channel_id = ?1 AND ifnull(sending_domain_id, '') = ?2`,
    channelId,
    sendingDomainId ?? '',
  );
  if (!row) throw new Error('ramp was not created');
  return row;
}

interface Health {
  sent: number;
  bounces: number;
  complaints: number;
}

async function healthBetween(
  db: D1Database,
  rampId: string,
  from: number,
  to: number,
): Promise<Health> {
  const row = await first<Health>(
    db,
    `SELECT count(*) AS sent,
            coalesce(sum(d.status = 'bounced'), 0) AS bounces,
            coalesce(sum(d.status = 'complained'), 0) AS complaints
       FROM deliveries d JOIN broadcasts b ON b.id = d.broadcast_id
      WHERE b.ramp_id = ?1 AND d.sent_at >= ?2 AND d.sent_at < ?3`,
    rampId,
    from,
    to,
  );
  return row ?? { sent: 0, bounces: 0, complaints: 0 };
}

export function judge(
  ramp: Pick<RampRow, 'bounce_threshold' | 'complaint_threshold'>,
  health: Health,
): string | null {
  if (health.sent < MIN_SAMPLE) return null;
  const bounceRate = health.bounces / health.sent;
  const complaintRate = health.complaints / health.sent;
  if (bounceRate > ramp.bounce_threshold) {
    return `Bounce rate ${(bounceRate * 100).toFixed(1)}% is over the ${(ramp.bounce_threshold * 100).toFixed(1)}% limit.`;
  }
  if (complaintRate > ramp.complaint_threshold) {
    return `Complaint rate ${(complaintRate * 100).toFixed(2)}% is over the ${(ramp.complaint_threshold * 100).toFixed(2)}% limit.`;
  }
  return null;
}

/** What a new day makes of a ramp, from how its last day went. Writes nothing. */
async function nextDay(db: D1Database, ramp: RampRow) {
  const dayStart = Date.parse(`${ramp.day}T00:00:00Z`);
  const health = await healthBetween(db, ramp.id, dayStart, dayStart + 86_400_000);
  const problem = ramp.status === 'warming' ? judge(ramp, health) : null;

  let status = ramp.status;
  let cap = ramp.cap_today;
  let reason = ramp.paused_reason;
  let pausedBy = ramp.paused_by;
  if (problem) {
    status = 'paused';
    reason = problem;
    pausedBy = 'system';
  } else if (ramp.status === 'warming' && ramp.sent_today >= ramp.cap_today / 2) {
    cap = Math.min(ramp.max_cap, Math.ceil(ramp.cap_today * ramp.growth));
    if (cap >= ramp.max_cap) status = 'complete';
  }
  return { health, status, cap, reason, pausedBy };
}

/** Moves a ramp to today, growing or pausing it based on the day(s) since its last update. */
export async function rollover(db: D1Database, ramp: RampRow, now = Date.now()): Promise<RampRow> {
  const today = utcDay(now);
  if (ramp.day === today) return ramp;

  const { health, status, cap, reason } = await nextDay(db, ramp);

  await db.batch([
    db
      .prepare(
        `INSERT INTO reputation_ramp_days (ramp_id, day, cap, sent, bounces, complaints)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (ramp_id, day) DO UPDATE SET sent = excluded.sent, bounces = excluded.bounces, complaints = excluded.complaints`,
      )
      .bind(ramp.id, ramp.day, ramp.cap_today, ramp.sent_today, health.bounces, health.complaints),
    // Guarded on the old day, so two workers rolling over at once apply it only once. The status
    // and reason only change when the stored status is still the one judged (?8): a pause or a
    // resume made since the read stands. A pause here is the ramp's own and owes the owners and
    // admins a notice (ramp-notices.ts).
    db
      .prepare(
        `UPDATE reputation_ramps SET day = ?1, cap_today = ?2, sent_today = 0,
                status = CASE WHEN status = ?8 THEN ?3 ELSE status END,
                paused_reason = CASE WHEN status = ?8 THEN ?4 ELSE paused_reason END,
                paused_by = CASE WHEN status <> ?8 THEN paused_by
                                 WHEN ?3 = 'paused' AND status = 'warming' THEN 'system'
                                 WHEN ?3 = 'paused' THEN paused_by ELSE NULL END,
                updated_at = ?5,
                pause_notice = CASE WHEN status = ?8 AND ?3 = 'paused' AND status = 'warming' THEN 'due'
                                    ELSE pause_notice END
          WHERE id = ?6 AND day = ?7`,
      )
      .bind(today, cap, status, reason, now, ramp.id, ramp.day, ramp.status),
  ]);
  const fresh = await first<RampRow>(db, 'SELECT * FROM reputation_ramps WHERE id = ?1', ramp.id);
  return fresh ?? ramp;
}

/**
 * Atomically reserves up to `want` sends for today and returns how many were granted.
 * SQLite evaluates every SET expression against the old row, so `last_reserved` is exactly
 * the amount added to `sent_today` by this statement.
 */
export async function reserve(
  db: D1Database,
  rampId: string,
  want: number,
  now = Date.now(),
): Promise<{ granted: number; ramp: RampRow }> {
  let ramp = await first<RampRow>(db, 'SELECT * FROM reputation_ramps WHERE id = ?1', rampId);
  if (!ramp) throw new Error(`ramp ${rampId} not found`);
  ramp = await rollover(db, ramp, now);
  if (ramp.status === 'paused') return { granted: 0, ramp };
  if (ramp.status === 'complete') {
    await run(
      db,
      'UPDATE reputation_ramps SET sent_today = sent_today + ?1 WHERE id = ?2',
      want,
      rampId,
    );
    return { granted: want, ramp };
  }
  const row = await first<{ last_reserved: number }>(
    db,
    `UPDATE reputation_ramps
        SET last_reserved = min(?1, max(0, cap_today - sent_today)),
            sent_today = sent_today + min(?1, max(0, cap_today - sent_today)),
            updated_at = ?3
      WHERE id = ?2 AND status = 'warming'
      RETURNING last_reserved`,
    want,
    rampId,
    now,
  );
  return { granted: row?.last_reserved ?? 0, ramp };
}

/**
 * What `reserve` would make of a ramp at `now`, and the same row after it, with nothing written. A
 * rehearsal keeps the returned row to count its own would-be sends.
 */
export async function previewReserve(
  db: D1Database,
  ramp: RampRow,
  want: number,
  now: number,
): Promise<{ granted: number; ramp: RampRow }> {
  const today = utcDay(now);
  let current = ramp;
  if (ramp.day !== today) {
    const { status, cap, reason, pausedBy } = await nextDay(db, ramp);
    current = {
      ...ramp,
      day: today,
      cap_today: cap,
      sent_today: 0,
      status,
      paused_reason: reason,
      paused_by: status === 'paused' ? pausedBy : null,
    };
  }
  if (current.status === 'paused') return { granted: 0, ramp: current };
  const granted =
    current.status === 'complete'
      ? want
      : Math.min(want, Math.max(0, current.cap_today - current.sent_today));
  return { granted, ramp: { ...current, sent_today: current.sent_today + granted } };
}

/** How long a send the ramp refused waits before it tries again. */
export const rampRetrySeconds = (ramp: Pick<RampRow, 'status'>, now: number) =>
  ramp.status === 'paused' ? 3600 : secondsUntilTomorrow(now);

/** Returns unused reservations (for example when fewer recipients were left than reserved). */
export async function release(db: D1Database, rampId: string, count: number): Promise<void> {
  if (count <= 0) return;
  await run(
    db,
    'UPDATE reputation_ramps SET sent_today = max(0, sent_today - ?1) WHERE id = ?2',
    count,
    rampId,
  );
}

/** Seconds until the next UTC midnight, capped at the 12-hour Queues delay limit. */
export function secondsUntilTomorrow(now = Date.now()): number {
  const next = Date.parse(`${utcDay(now)}T00:00:00Z`) + 86_400_000;
  return Math.min(43_200, Math.max(60, Math.ceil((next - now) / 1000) + 5));
}

/**
 * Checks today's rates after a bounce or complaint and pauses the ramp on an anomaly.
 * Returns the reason when it paused; the owners and admins are then emailed once
 * (pause_notice, sent by ramp-notices.ts from the jobs worker).
 */
export async function checkRampHealth(
  db: D1Database,
  rampId: string,
  now = Date.now(),
): Promise<string | null> {
  const ramp = await first<RampRow>(db, 'SELECT * FROM reputation_ramps WHERE id = ?1', rampId);
  if (!ramp || ramp.status !== 'warming') return null;
  const health = await healthBetween(db, rampId, now - 86_400_000, now + 1);
  const problem = judge(ramp, health);
  if (!problem) return null;
  const paused = await first<{ id: string }>(
    db,
    `UPDATE reputation_ramps SET status = 'paused', paused_reason = ?1, paused_by = 'system',
            updated_at = ?2, pause_notice = 'due'
      WHERE id = ?3 AND status = 'warming' RETURNING id`,
    problem,
    now,
    rampId,
  );
  return paused ? problem : null;
}

export async function rampDays(db: D1Database, rampId: string) {
  return all<{ day: string; cap: number; sent: number; bounces: number; complaints: number }>(
    db,
    'SELECT day, cap, sent, bounces, complaints FROM reputation_ramp_days WHERE ramp_id = ?1 ORDER BY day DESC LIMIT 60',
    rampId,
  );
}

// ---- Pace, skip and restart (the guided warm-up) -------------------------------------------

export const rampKind = (ramp: Pick<RampRow, 'sending_domain_id'>): RampKind =>
  ramp.sending_domain_id ? 'custom' : 'shared';

export interface RampChanges {
  startCap?: number | undefined;
  growth?: number | undefined;
  maxCap?: number | undefined;
  bounceThreshold?: number | undefined;
  complaintThreshold?: number | undefined;
  /**
   * Resume ('warming') or pause by hand ('paused'). Ignored on a complete ramp, and when the ramp
   * already has that status: a pause of a paused ramp keeps its reason, who paused it and any
   * notice still owed.
   */
  status?: 'warming' | 'paused' | undefined;
}

export interface RampUpdateGuard {
  /**
   * Whether this change may resume a pause the ramp made itself. False for a publication admin on
   * the shared domain: the update then matches no row when the ramp is paused by the system, so a
   * pause that happens after the caller read the ramp is never lifted by them.
   */
  resumeSystemPause: boolean;
}

/**
 * Tunes a ramp, in one statement. A new start cap (a change of pace) moves today's cap like this:
 *
 * - A ramp that has not grown yet (today's cap is at or under its old start cap) takes the new
 *   start cap, but never less than what today already used.
 * - A ramp that has grown keeps today's cap, or is raised to the new start cap when that is
 *   higher. It is never lowered: the days already earned stay earned, and only the growth changes.
 * - A complete ramp only stores the numbers, for the next time it warms up.
 *
 * So `cap_today - sent_today` never goes below what reserve() has already handed out, and a
 * change of pace in the middle of a send cannot take back a reservation.
 *
 * A person's pause is recorded as theirs ('person'), only on a warming ramp. Null when the ramp is
 * gone, or when `guard` refused the change (see RampUpdateGuard).
 */
export async function updateRamp(
  db: D1Database,
  rampId: string,
  changes: RampChanges,
  now = Date.now(),
  guard: RampUpdateGuard = { resumeSystemPause: true },
): Promise<RampRow | null> {
  return first<RampRow>(
    db,
    `UPDATE reputation_ramps SET
            cap_today = CASE
              WHEN ?1 IS NULL OR status = 'complete' THEN cap_today
              WHEN cap_today <= start_cap THEN max(min(?1, coalesce(?3, max_cap)), sent_today)
              ELSE max(cap_today, min(?1, coalesce(?3, max_cap))) END,
            start_cap = coalesce(?1, start_cap), growth = coalesce(?2, growth),
            max_cap = coalesce(?3, max_cap),
            bounce_threshold = coalesce(?4, bounce_threshold),
            complaint_threshold = coalesce(?5, complaint_threshold),
            status = CASE WHEN (?6 = 'paused' AND status = 'warming')
                            OR (?6 = 'warming' AND status = 'paused') THEN ?6 ELSE status END,
            paused_reason = CASE WHEN ?6 = 'paused' AND status = 'warming' THEN ?10
                                 WHEN ?6 = 'warming' AND status = 'paused' THEN NULL
                                 ELSE paused_reason END,
            paused_by = CASE WHEN ?6 = 'paused' AND status = 'warming' THEN 'person'
                             WHEN ?6 = 'warming' AND status = 'paused' THEN NULL
                             ELSE paused_by END,
            pause_notice = CASE WHEN (?6 = 'paused' AND status = 'warming')
                                  OR (?6 = 'warming' AND status = 'paused') THEN NULL
                                ELSE pause_notice END,
            updated_at = ?7
      WHERE id = ?8
        AND (?9 = 1 OR ?6 IS NOT 'warming' OR status <> 'paused' OR paused_by IS 'person')
      RETURNING *`,
    changes.startCap ?? null,
    changes.growth ?? null,
    changes.maxCap ?? null,
    changes.bounceThreshold ?? null,
    changes.complaintThreshold ?? null,
    changes.status ?? null,
    now,
    rampId,
    guard.resumeSystemPause ? 1 : 0,
    PERSON_PAUSE_REASON,
  );
}

/**
 * Skips warm-up: the ramp is complete from now on and no longer limits sending. For a domain that
 * already has a sending history with mailbox providers. Returns null when there was nothing to
 * skip (the ramp is already complete, or gone).
 */
export async function skipRamp(
  db: D1Database,
  rampId: string,
  now = Date.now(),
): Promise<RampRow | null> {
  return first<RampRow>(
    db,
    `UPDATE reputation_ramps
        SET status = 'complete', skipped_at = ?1, paused_reason = NULL, paused_by = NULL,
            pause_notice = NULL, updated_at = ?1
      WHERE id = ?2 AND status <> 'complete' RETURNING *`,
    now,
    rampId,
  );
}

/**
 * Starts warm-up again on a complete (or skipped) ramp, from its start cap or from a new pace.
 * What was already sent today still counts against today's cap, so sends that are going out keep
 * their reservations and the rest wait for tomorrow. The ceiling is raised to cover everyone
 * active, so the ramp cannot complete before the cap covers the list. Returns null when the ramp
 * is not complete.
 */
export async function restartRamp(
  db: D1Database,
  rampId: string,
  pace: { startCap: number; growth: number } | null,
  now = Date.now(),
): Promise<RampRow | null> {
  return first<RampRow>(
    db,
    `UPDATE reputation_ramps
        SET status = 'warming', start_cap = coalesce(?1, start_cap), growth = coalesce(?2, growth),
            max_cap = max(max_cap, coalesce(?1, start_cap) + 1,
                          (SELECT count(*) FROM members m
                            WHERE m.channel_id = reputation_ramps.channel_id AND m.status = 'active')),
            cap_today = coalesce(?1, start_cap),
            sent_today = CASE WHEN day = ?3 THEN sent_today ELSE 0 END,
            day = ?3, started_day = ?3, skipped_at = NULL, paused_reason = NULL, paused_by = NULL,
            pause_notice = NULL, updated_at = ?4
      WHERE id = ?5 AND status = 'complete' RETURNING *`,
    pace?.startCap ?? null,
    pace?.growth ?? null,
    utcDay(now),
    now,
    rampId,
  );
}
