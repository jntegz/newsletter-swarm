/**
 * Tracking choices (docs/privacy-controls.md): what a publication tracks, and a subscriber's own
 * "don't track my opens and clicks". Table changes: migrations/0063_tracking_choices.sql.
 *
 * CONTRACT
 * - A publication has three switches in channels.settings_json, each on unless set to false (a
 *   new publication is created with all three false: NEW_CHANNEL_SETTINGS in @swarm/domain):
 *   trackOpens (an open pixel per person), trackClicks (links through the tracker, tied to the
 *   person; off sends plain links, so nothing passes through Swarm) and profileReaders
 *   (engagement scores and best-time sending). Profiling reads opens: it is off whenever open
 *   tracking is.
 * - A send freezes track_opens and track_clicks when it starts. Each batch narrows them by the
 *   publication's switches at that moment (an automation email's send lives on) and by the
 *   recipient's own choice. deliveries.tracked = 0 marks an email sent without tracking because
 *   the person asked; the send report leaves those out of its open and click rates.
 * - The tracking worker records nothing for a delivery whose person asked not to be tracked, whose
 *   publication has that kind of tracking off now, or that no longer belongs to anyone.
 * - Asking not to be tracked deletes the person's opens, clicks, open and click events, engagement
 *   score and best sending hour. Their deliveries stay (unsubscribe links in their emails keep
 *   working), without opened or clicked times. What the send report counted moves to the carried_*
 *   columns of the send and its links, so totals and rates of past sends do not change.
 */
import { all, first } from './db';

export interface ChannelSettings {
  /** An open pixel in each email, tied to the person. */
  trackOpens: boolean;
  /** Links go through the tracker, tied to the person. Off: links go straight to their address. */
  trackClicks: boolean;
  /** Engagement scores and best-time sending for this publication. Needs open tracking. */
  profileReaders: boolean;
}

/** A publication's tracking choices. Each is on unless the publication turned it off. */
export function channelSettings(json: string): ChannelSettings {
  const parsed = JSON.parse(json) as {
    trackOpens?: unknown;
    trackClicks?: unknown;
    profileReaders?: unknown;
  };
  // IPs are truncated and no cookies are set either way.
  const trackOpens = parsed.trackOpens !== false;
  return {
    trackOpens,
    trackClicks: parsed.trackClicks !== false,
    profileReaders: trackOpens && parsed.profileReaders !== false,
  };
}

/**
 * SQL, true when the Channel aliased `alias` profiles readers: open tracking and profileReaders
 * not set to false (json_extract reads JSON false as 0).
 */
export const profilingSql = (alias: string) =>
  `(json_extract(${alias}.settings_json, '$.trackOpens') IS NOT 0
    AND json_extract(${alias}.settings_json, '$.profileReaders') IS NOT 0)`;

/** Whether the Channel profiles its readers now. False for an unknown Channel. */
export async function channelProfilesReaders(db: D1Database, channelId: string): Promise<boolean> {
  const row = await first<{ settings_json: string }>(
    db,
    'SELECT settings_json FROM channels WHERE id = ?1',
    channelId,
  );
  return row ? channelSettings(row.settings_json).profileReaders : false;
}

/** Whether an open or a click on this delivery may be recorded against its person. */
export async function mayRecord(
  db: D1Database,
  deliveryId: string,
  kind: 'open' | 'click',
): Promise<boolean> {
  const row = await first<{
    tracked: number;
    member_id: string | null;
    opted_out: number | null;
    settings_json: string;
  }>(
    db,
    `SELECT d.tracked, d.member_id, m.tracking_opt_out_at AS opted_out, c.settings_json
       FROM deliveries d JOIN channels c ON c.id = d.channel_id
       LEFT JOIN members m ON m.id = d.member_id
      WHERE d.id = ?1`,
    deliveryId,
  );
  if (!row || row.tracked === 0 || row.member_id === null || row.opted_out !== null) return false;
  const settings = channelSettings(row.settings_json);
  return kind === 'open' ? settings.trackOpens : settings.trackClicks;
}

/** Members of this list who asked not to be tracked. */
export async function optedOutOfTracking(
  db: D1Database,
  memberIds: readonly string[],
): Promise<Set<string>> {
  if (!memberIds.length) return new Set();
  const rows = await all<{ id: string }>(
    db,
    `SELECT id FROM members WHERE id IN (SELECT value FROM json_each(?1))
        AND tracking_opt_out_at IS NOT NULL`,
    JSON.stringify(memberIds),
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * The statements that stop tracking a Member and delete what tracking already recorded about
 * them, keeping the send report's numbers in the carried_* columns. Each statement is guarded on
 * the Member not having asked yet, and the Member row changes last, so running it twice changes
 * nothing.
 */
function optOutStatements(db: D1Database, memberId: string, now: number): D1PreparedStatement[] {
  const fresh = 'EXISTS (SELECT 1 FROM members WHERE id = ?1 AND tracking_opt_out_at IS NULL)';
  const theirs = 'SELECT id FROM deliveries WHERE member_id = ?1';
  const count = (column: string) =>
    `(SELECT count(*) FROM deliveries d WHERE d.broadcast_id = broadcasts.id AND d.member_id = ?1
        AND d.${column} IS NOT NULL)`;
  const clicksOf = (extra: string) =>
    `(SELECT count(*) FROM clicks c WHERE c.link_target_id = link_targets.id
        AND c.delivery_id IN (${theirs})${extra})`;
  const statement = (sql: string, ...values: unknown[]) =>
    db.prepare(sql).bind(memberId, ...values);
  return [
    statement(
      `UPDATE broadcasts SET carried_opened = carried_opened + ${count('opened_at')},
              carried_human_opened = carried_human_opened + ${count('human_opened_at')},
              carried_clicked = carried_clicked + ${count('clicked_at')},
              carried_human_clicked = carried_human_clicked + ${count('human_clicked_at')}
        WHERE id IN (SELECT broadcast_id FROM deliveries WHERE member_id = ?1
                       AND (opened_at IS NOT NULL OR clicked_at IS NOT NULL))
          AND ${fresh}`,
    ),
    statement(
      `UPDATE link_targets SET carried_clicks = carried_clicks + ${clicksOf('')},
              carried_human_clicks = carried_human_clicks + ${clicksOf(" AND c.classification = 'human'")},
              carried_human_people = carried_human_people
                + (${clicksOf(" AND c.classification = 'human'")} > 0)
        WHERE id IN (SELECT link_target_id FROM clicks WHERE delivery_id IN (${theirs}))
          AND ${fresh}`,
    ),
    statement(`DELETE FROM opens WHERE delivery_id IN (${theirs}) AND ${fresh}`),
    statement(`DELETE FROM clicks WHERE delivery_id IN (${theirs}) AND ${fresh}`),
    statement(
      `UPDATE deliveries SET opened_at = NULL, human_opened_at = NULL, clicked_at = NULL,
              human_clicked_at = NULL
        WHERE member_id = ?1 AND (opened_at IS NOT NULL OR clicked_at IS NOT NULL) AND ${fresh}`,
    ),
    statement(
      `DELETE FROM member_events WHERE member_id = ?1 AND type IN ('email_opened', 'link_clicked')
          AND ${fresh}`,
    ),
    statement(`DELETE FROM member_engagement WHERE member_id = ?1 AND ${fresh}`),
    statement(`DELETE FROM member_send_hours WHERE member_id = ?1 AND ${fresh}`),
    statement(
      `UPDATE members SET tracking_opt_out_at = ?2, updated_at = ?2
        WHERE id = ?1 AND tracking_opt_out_at IS NULL`,
      now,
    ),
  ];
}

/**
 * A subscriber's own choice from subscriber settings. `track: false` stops tracking them and
 * deletes their recorded opens and clicks; `track: true` starts again from nothing. Returns whether
 * the Member exists.
 */
export async function setMemberTracking(
  db: D1Database,
  memberId: string,
  track: boolean,
  now = Date.now(),
): Promise<boolean> {
  const member = await first<{ id: string }>(db, 'SELECT id FROM members WHERE id = ?1', memberId);
  if (!member) return false;
  if (track) {
    await db
      .prepare(
        `UPDATE members SET tracking_opt_out_at = NULL, updated_at = ?2
          WHERE id = ?1 AND tracking_opt_out_at IS NOT NULL`,
      )
      .bind(memberId, now)
      .run();
  } else {
    await db.batch(optOutStatements(db, memberId, now));
  }
  return true;
}
