/**
 * The engagement score (flag `engagement_scores`): a daily 0 to 100 per active or paused Member,
 * from the deliveries of the last 90 days.
 *
 * - Only people count. Machine opens and link scanners never set human_opened_at or
 *   human_clicked_at. Someone whose opens are all machine opens and who has never clicked gets no
 *   score (`opens_hidden`), so a "cold" Segment doesn't drop everyone on Apple Mail.
 * - A post sent in the last day is left out, because nobody has had time to read it. Failed and
 *   bounced deliveries are left out too, since they never reached the person.
 * - The pass runs from the minute cron in small batches with a cursor per Channel, so a large list
 *   is spread over several minutes, and re-running is harmless.
 * - A row older than ENGAGEMENT_FRESH_MS counts as missing everywhere it is read.
 * - Only for a publication that profiles its readers (profileReaders, which needs open tracking;
 *   tracking-choices.ts), and never for someone who asked not to be tracked. Emails sent without an
 *   open pixel (open tracking off for that send, or the person had asked) don't count.
 */
import {
  ENGAGEMENT_BANDS,
  type EngagementSummary,
  type EngagementBand,
  type MemberEngagement,
} from '@swarm/domain';
import { D1FlagStore, FlagService } from '@swarm/flags';
import { all, first, toIso } from './db';
import { utcDay } from './ramp';
import { channelProfilesReaders, channelSettings } from './tracking-choices';

const DAY_MS = 86_400_000;
export const ENGAGEMENT_WINDOW_DAYS = 90;
export const ENGAGEMENT_SETTLE_MS = DAY_MS;
export const ENGAGEMENT_MIN_SENT = 3;
export const ENGAGEMENT_FRESH_MS = 7 * DAY_MS;
/** A click on one post in four earns all of the click points. */
const FULL_CLICK_RATE = 0.25;
const BATCH = 500;
const BATCHES_PER_RUN = 20;
const CHANNELS_PER_RUN = 50;

export interface EngagementCounts {
  sent: number;
  humanOpened: number;
  humanClicked: number;
  /** Opened by a machine only: no human open or click on that delivery. */
  machineOnly: number;
  lastEngagedAt: number | null;
}

export function scoreEngagement(
  counts: EngagementCounts,
  now: number,
): { score: number | null; band: EngagementBand } {
  const { sent, humanOpened, humanClicked, machineOnly, lastEngagedAt } = counts;
  if (sent < ENGAGEMENT_MIN_SENT) return { score: null, band: 'too_few_posts' };
  if (humanOpened === 0 && humanClicked === 0 && machineOnly * 2 >= sent) {
    return { score: null, band: 'opens_hidden' };
  }
  const days = lastEngagedAt === null ? Infinity : Math.max(0, now - lastEngagedAt) / DAY_MS;
  const recency = Math.max(0, 1 - days / ENGAGEMENT_WINDOW_DAYS);
  // A machine-only delivery can't show whether they read it, so it isn't held against them.
  const openRate = Math.min(1, humanOpened / Math.max(1, sent - machineOnly));
  const clickRate = Math.min(1, humanClicked / sent / FULL_CLICK_RATE);
  const score = Math.round(40 * recency + 35 * openRate + 25 * clickRate);
  const band =
    score >= 60 ? 'very_engaged' : score >= 30 ? 'engaged' : score >= 10 ? 'slipping' : 'cold';
  return { score, band };
}

export async function engagementEnabled(db: D1Database, channelId: string): Promise<boolean> {
  const channel = await first<{ workspace_id: string; settings_json: string }>(
    db,
    'SELECT workspace_id, settings_json FROM channels WHERE id = ?1',
    channelId,
  );
  if (!channel || !channelSettings(channel.settings_json).profileReaders) return false;
  return new FlagService(new D1FlagStore(db)).enabled('engagement_scores', {
    workspaceId: channel.workspace_id,
    channelId,
  });
}

interface CountRow {
  id: string;
  sent: number;
  human_opened: number | null;
  human_clicked: number | null;
  machine_only: number | null;
  last_engaged_at: number | null;
}

/** One batch of a Channel. Returns the last Member id, or null when the Channel is done. */
export async function scoreEngagementBatch(
  db: D1Database,
  channelId: string,
  cursor: string | null,
  now: number,
  batch = BATCH,
): Promise<string | null> {
  const rows = await all<CountRow>(
    db,
    `SELECT m.id,
            count(d.id) AS sent,
            sum(d.human_opened_at IS NOT NULL) AS human_opened,
            sum(d.human_clicked_at IS NOT NULL) AS human_clicked,
            sum(d.opened_at IS NOT NULL AND d.human_opened_at IS NULL AND d.human_clicked_at IS NULL) AS machine_only,
            nullif(max(max(ifnull(d.human_opened_at, 0), ifnull(d.human_clicked_at, 0))), 0) AS last_engaged_at
       FROM (SELECT id FROM members
              WHERE channel_id = ?1 AND status IN ('active', 'paused') AND (?2 IS NULL OR id > ?2)
                AND tracking_opt_out_at IS NULL
              ORDER BY id LIMIT ?3) m
       LEFT JOIN deliveries d
         ON d.member_id = m.id AND d.sent_at >= ?4 AND d.sent_at < ?5
        AND d.status NOT IN ('failed', 'bounced') AND d.tracked = 1
        AND EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = d.broadcast_id AND b.track_opens = 1)
      GROUP BY m.id ORDER BY m.id`,
    channelId,
    cursor,
    batch,
    now - ENGAGEMENT_WINDOW_DAYS * DAY_MS,
    now - ENGAGEMENT_SETTLE_MS,
  );
  if (!rows.length) return null;
  const scored = rows.map((row) => {
    const counts: EngagementCounts = {
      sent: row.sent,
      humanOpened: row.human_opened ?? 0,
      humanClicked: row.human_clicked ?? 0,
      machineOnly: row.machine_only ?? 0,
      lastEngagedAt: row.last_engaged_at,
    };
    const { score, band } = scoreEngagement(counts, now);
    return [
      row.id,
      score,
      band,
      counts.sent,
      counts.humanOpened,
      counts.humanClicked,
      counts.lastEngagedAt,
    ];
  });
  // One JSON parameter: D1 allows 100 bound parameters. The join skips anyone erased meanwhile.
  await db
    .prepare(
      `INSERT INTO member_engagement
         (member_id, channel_id, score, band, sent_count, opened_count, clicked_count, last_engaged_at, computed_at)
       SELECT m.id, ?2, j.value ->> '$[1]', j.value ->> '$[2]', j.value ->> '$[3]', j.value ->> '$[4]',
              j.value ->> '$[5]', j.value ->> '$[6]', ?3
         FROM json_each(?1) j JOIN members m ON m.id = j.value ->> '$[0]'
        WHERE true
       ON CONFLICT (member_id) DO UPDATE SET
         score = excluded.score, band = excluded.band, sent_count = excluded.sent_count,
         opened_count = excluded.opened_count, clicked_count = excluded.clicked_count,
         last_engaged_at = excluded.last_engaged_at, computed_at = excluded.computed_at`,
    )
    .bind(JSON.stringify(scored), channelId, now)
    .run();
  return rows.length < batch ? null : (rows.at(-1)?.id ?? null);
}

/** Minute cron: moves each Channel's pass for today along, within a budget. */
export async function runEngagementRollup(
  db: D1Database,
  now: number,
  options: { budget?: number; batch?: number } = {},
): Promise<{ batches: number; finished: number }> {
  const budget = options.budget ?? BATCHES_PER_RUN;
  const day = utcDay(now);
  const due = await all<{ id: string; day: string | null; cursor: string | null }>(
    db,
    `SELECT c.id, r.day, r.cursor FROM channels c
       LEFT JOIN engagement_rollups r ON r.channel_id = c.id
      WHERE c.deleted_at IS NULL AND (r.day IS NULL OR r.day < ?1 OR r.finished = 0)
      LIMIT ?2`,
    day,
    CHANNELS_PER_RUN,
  );
  const save = (channelId: string, cursor: string | null, finished: boolean) =>
    db
      .prepare(
        `INSERT INTO engagement_rollups (channel_id, day, cursor, finished) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (channel_id) DO UPDATE SET day = ?2, cursor = ?3, finished = ?4`,
      )
      .bind(channelId, day, cursor, finished ? 1 : 0)
      .run();
  let batches = 0;
  let finished = 0;
  for (const channel of due) {
    if (batches >= budget) break;
    if (!(await engagementEnabled(db, channel.id))) {
      // Off means no scores are kept. Checked again tomorrow.
      await db
        .prepare('DELETE FROM member_engagement WHERE channel_id = ?1')
        .bind(channel.id)
        .run();
      // A publication that stopped profiling its readers keeps no best sending hours either.
      if (!(await channelProfilesReaders(db, channel.id))) {
        await db
          .prepare('DELETE FROM member_send_hours WHERE channel_id = ?1')
          .bind(channel.id)
          .run();
      }
      await save(channel.id, null, true);
      continue;
    }
    let cursor = channel.day === day ? channel.cursor : null;
    let done = false;
    while (batches < budget && !done) {
      cursor = await scoreEngagementBatch(db, channel.id, cursor, now, options.batch);
      batches++;
      done = cursor === null;
    }
    if (done) {
      // Anyone who left since their last score, and so wasn't scored again.
      await db
        .prepare('DELETE FROM member_engagement WHERE channel_id = ?1 AND computed_at < ?2')
        .bind(channel.id, now - ENGAGEMENT_FRESH_MS)
        .run();
      finished++;
    }
    await save(channel.id, cursor, done);
  }
  return { batches, finished };
}

interface EngagementRow {
  member_id: string;
  score: number | null;
  band: EngagementBand;
  sent_count: number;
  opened_count: number;
  clicked_count: number;
  last_engaged_at: number | null;
  computed_at: number;
}

/** Current scores for these Members of a Channel, by Member id. */
export async function readMemberEngagement(
  db: D1Database,
  channelId: string,
  memberIds: readonly string[],
  now = Date.now(),
): Promise<Map<string, MemberEngagement>> {
  if (!memberIds.length) return new Map();
  const rows = await all<EngagementRow>(
    db,
    `SELECT member_id, score, band, sent_count, opened_count, clicked_count, last_engaged_at, computed_at
       FROM member_engagement
      WHERE channel_id = ?1 AND computed_at >= ?2 AND member_id IN (SELECT value FROM json_each(?3))`,
    channelId,
    now - ENGAGEMENT_FRESH_MS,
    JSON.stringify(memberIds),
  );
  return new Map(
    rows.map((row) => [
      row.member_id,
      {
        score: row.score,
        band: row.band,
        sentCount: row.sent_count,
        openedCount: row.opened_count,
        clickedCount: row.clicked_count,
        lastEngagedAt: row.last_engaged_at === null ? null : toIso(row.last_engaged_at),
        computedAt: toIso(row.computed_at),
      },
    ]),
  );
}

/** How many Members are in each band now. */
export async function engagementSummary(
  db: D1Database,
  channelId: string,
  now = Date.now(),
): Promise<EngagementSummary> {
  const rows = await all<{ band: EngagementBand; n: number; computed_at: number }>(
    db,
    `SELECT band, count(*) AS n, max(computed_at) AS computed_at FROM member_engagement
      WHERE channel_id = ?1 AND computed_at >= ?2 GROUP BY band`,
    channelId,
    now - ENGAGEMENT_FRESH_MS,
  );
  const bands = Object.fromEntries(ENGAGEMENT_BANDS.map((t) => [t, 0])) as Record<
    EngagementBand,
    number
  >;
  for (const row of rows) bands[row.band] = row.n;
  const latest = rows.length ? Math.max(...rows.map((r) => r.computed_at)) : null;
  return { bands, computedAt: latest === null ? null : toIso(latest) };
}
