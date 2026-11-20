/**
 * Broadcast statistics, computed from deliveries and clicks.
 *
 * Tracking choices (tracking-choices.ts) keep these true:
 * - Opens and clicks deleted because someone asked not to be tracked are added back from the
 *   carried_* columns of the send and its links.
 * - Emails sent without tracking because the person asked (deliveries.tracked = 0) are left out of
 *   the open rate's denominator: nobody could have seen them opened.
 * - Deliveries the retention job anonymised keep their status and times, so they count as before.
 */
import type { BroadcastStats } from '@swarm/domain';
import { COST_MICROS_PER_MESSAGE } from './config';
import { all, first } from './db';

/**
 * SQL: the Members of test runs that sent from this Broadcast (?1). Test runs have their own copy of
 * an email now, so only sends from before that are found here, and they don't count. A Broadcast of
 * a post has no flow_id, so it finds nobody.
 */
export const OLD_TEST_SENDS_SQL = `(SELECT r.member_id FROM flow_run_steps s JOIN flow_runs r ON r.id = s.run_id
      WHERE s.flow_id = (SELECT flow_id FROM broadcasts WHERE id = ?1) AND r.test = 1 AND s.status = 'done'
        AND json_extract(s.result_json, '$.broadcastId') = ?1)`;

const rate = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0;

export async function broadcastStats(db: D1Database, broadcastId: string): Promise<BroadcastStats> {
  const totals = await first<{
    sent: number;
    delivered: number;
    bounced: number;
    complained: number;
    failed: number;
    unsubscribed: number;
    opened: number;
    human_opened: number;
    clicked: number;
    human_clicked: number;
    untracked: number;
    untracked_bounced: number;
  }>(
    db,
    `SELECT coalesce(sum(status <> 'failed'), 0) AS sent,
            coalesce(sum(status <> 'failed' AND tracked = 0), 0) AS untracked,
            coalesce(sum(status = 'bounced' AND tracked = 0), 0) AS untracked_bounced,
            coalesce(sum(status = 'delivered' OR (status = 'complained')), 0) AS delivered,
            coalesce(sum(status = 'bounced'), 0) AS bounced,
            coalesce(sum(status = 'complained'), 0) AS complained,
            coalesce(sum(status = 'failed'), 0) AS failed,
            coalesce(sum(unsubscribed_at IS NOT NULL), 0) AS unsubscribed,
            coalesce(sum(opened_at IS NOT NULL), 0) AS opened,
            coalesce(sum(human_opened_at IS NOT NULL), 0) AS human_opened,
            coalesce(sum(clicked_at IS NOT NULL), 0) AS clicked,
            coalesce(sum(human_clicked_at IS NOT NULL), 0) AS human_clicked
       FROM deliveries WHERE broadcast_id = ?1 AND ifnull(member_id, '') NOT IN ${OLD_TEST_SENDS_SQL}`,
    broadcastId,
  );
  const t = totals ?? {
    sent: 0,
    delivered: 0,
    bounced: 0,
    complained: 0,
    failed: 0,
    unsubscribed: 0,
    opened: 0,
    human_opened: 0,
    clicked: 0,
    human_clicked: 0,
    untracked: 0,
    untracked_bounced: 0,
  };
  const send = (await first<{
    track_opens: number;
    track_clicks: number;
    carried_opened: number;
    carried_human_opened: number;
    carried_clicked: number;
    carried_human_clicked: number;
  }>(
    db,
    `SELECT track_opens, track_clicks, carried_opened, carried_human_opened, carried_clicked,
            carried_human_clicked
       FROM broadcasts WHERE id = ?1`,
    broadcastId,
  )) ?? {
    track_opens: 1,
    track_clicks: 1,
    carried_opened: 0,
    carried_human_opened: 0,
    carried_clicked: 0,
    carried_human_clicked: 0,
  };
  const opened = t.opened + send.carried_opened;
  const humanOpened = t.human_opened + send.carried_human_opened;
  const clicked = t.clicked + send.carried_clicked;
  const humanClicked = t.human_clicked + send.carried_human_clicked;
  const links = await all<{
    url: string;
    destination: string | null;
    position: number;
    clicks: number;
    human_clicks: number;
    human_people: number;
  }>(
    db,
    `SELECT l.url, (SELECT s.url FROM app_short_links s WHERE s.short_url = l.url LIMIT 1) AS destination,
            l.position, count(c.id) + l.carried_clicks AS clicks,
            coalesce(sum(c.classification = 'human'), 0) + l.carried_human_clicks AS human_clicks,
            count(DISTINCT CASE WHEN c.classification = 'human' THEN c.delivery_id END)
              + l.carried_human_people AS human_people
       FROM link_targets l LEFT JOIN clicks c ON c.link_target_id = l.id
            AND c.delivery_id NOT IN (SELECT id FROM deliveries WHERE broadcast_id = ?1 AND member_id IN ${OLD_TEST_SENDS_SQL})
      WHERE l.broadcast_id = ?1 GROUP BY l.id ORDER BY human_clicks DESC, l.position`,
    broadcastId,
  );
  // Until the provider reports delivery, a sent message that hasn't bounced counts as delivered.
  const delivered = Math.max(t.delivered, t.sent - t.bounced);
  // Delivered emails that could show an open: not the ones sent untracked at the person's request.
  const trackedDelivered = Math.max(0, delivered - (t.untracked - t.untracked_bounced));
  return {
    sent: t.sent,
    delivered,
    bounced: t.bounced,
    complained: t.complained,
    failed: t.failed,
    unsubscribed: t.unsubscribed,
    uniqueOpens: opened,
    humanOpens: humanOpened,
    machineOpens: Math.max(0, opened - humanOpened),
    uniqueClicks: clicked,
    humanClicks: humanClicked,
    bounceRate: rate(t.bounced, t.sent),
    complaintRate: rate(t.complained, t.sent),
    openRate: rate(humanOpened, trackedDelivered),
    clickToOpenRate: rate(humanClicked, humanOpened),
    tracking: {
      opens: send.track_opens === 1,
      clicks: send.track_clicks === 1,
      untracked: t.untracked,
    },
    cost: { amountMicros: t.sent * COST_MICROS_PER_MESSAGE, currency: 'USD' },
    links: links.map((link) => ({
      url: link.url,
      destination: link.destination,
      position: link.position,
      clicks: link.clicks,
      humanClicks: link.human_clicks,
      humanPeople: link.human_people,
    })),
  };
}
