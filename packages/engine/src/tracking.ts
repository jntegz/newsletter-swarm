/**
 * Recording clicks and opens. Called from the track worker inside waitUntil. Nothing is recorded
 * for a delivery its person asked not to have tracked, whose publication has that kind of tracking
 * off now, or that no longer belongs to anyone (see tracking-choices.ts).
 */
import { ipPrefix } from '@swarm/db';
import { classifyClick, classifyOpen, uaFamily, type RequestSignals } from './classify';
import { first, newIdFor } from './db';
import { mayRecord } from './tracking-choices';

export interface TrackSignals extends RequestSignals {
  ip: string | null;
}

/** Looks up a click target. Null when the delivery and link don't belong to the same Broadcast. */
export async function linkFor(
  db: D1Database,
  deliveryId: string,
  linkTargetId: string,
): Promise<{ url: string; broadcastId: string; sentAt: number; channelId: string } | null> {
  return first<{ url: string; broadcastId: string; sentAt: number; channelId: string }>(
    db,
    `SELECT l.url, d.broadcast_id AS broadcastId, d.sent_at AS sentAt, d.channel_id AS channelId
       FROM deliveries d JOIN link_targets l ON l.broadcast_id = d.broadcast_id
      WHERE d.id = ?1 AND l.id = ?2`,
    deliveryId,
    linkTargetId,
  );
}

/**
 * Whether a tracked link may be followed on `host`. A publication's verified link domain only
 * serves its own Deliveries, so one workspace's token can't make another publication's branded
 * domain redirect to a site it chose. Any other host (the install's shared link host) serves
 * every Delivery, as before.
 */
export async function linkHostServes(
  db: D1Database,
  host: string,
  channelId: string,
): Promise<boolean> {
  const name = host.toLowerCase().split(':')[0] ?? '';
  const row = await first<{ claimed: number; own: number }>(
    db,
    `SELECT EXISTS (SELECT 1 FROM sending_domains WHERE domain = ?1 AND kind = 'link' AND status = 'verified') AS claimed,
            EXISTS (SELECT 1 FROM sending_domains WHERE domain = ?1 AND kind = 'link' AND status = 'verified'
                     AND channel_id = ?2) AS own`,
    name,
    channelId,
  );
  return !row?.claimed || row.own === 1;
}

/**
 * Stored hits per Delivery: a tracked link or pixel can be replayed for as long as its token is
 * valid, so what one token can write is bounded. After the cap a hit still redirects (or returns
 * the pixel) but stores nothing new; the Delivery's first-seen times are already set. Repeat-click
 * counts in reports therefore stop at the cap.
 */
export const MAX_CLICK_ROWS_PER_LINK = 20;
export const MAX_OPEN_ROWS_PER_DELIVERY = 20;

/**
 * Records a click. The classification's "another click on this Delivery in the last second" rule
 * is decided inside the insert, so concurrent hits can't all pass it, and the human flags and the
 * Flow event follow the stored row. A Delivery and link produce at most one link_clicked event, so
 * replaying a link can't wake a Flow wait again or inflate engagement. Returns the stored
 * classification, or null when nothing was stored.
 */
export async function recordClick(
  db: D1Database,
  target: { deliveryId: string; linkTargetId: string; broadcastId: string; sentAt: number },
  signals: TrackSignals,
  now = Date.now(),
): Promise<string | null> {
  if (!(await mayRecord(db, target.deliveryId, 'click'))) return null;
  // Everything except the rate rule, which the insert applies against the stored clicks.
  const candidate = classifyClick(signals, {
    sentAt: target.sentAt,
    now,
    clicksInLastSecond: 0,
  });
  const id = newIdFor('click', now);
  // Whether the row just inserted (its id is bound as `param`) is a human click.
  const storedHuman = (param: string) =>
    `EXISTS (SELECT 1 FROM clicks WHERE id = ${param} AND classification = 'human')`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO clicks (id, delivery_id, broadcast_id, link_target_id, classification, ua_family, ip_prefix, asn, created_at)
         SELECT ?1, ?2, ?3, ?4,
                CASE WHEN ?5 = 'human' AND EXISTS (
                       SELECT 1 FROM clicks WHERE delivery_id = ?2 AND created_at > ?9 - 1000)
                     THEN 'scanner' ELSE ?5 END,
                ?6, ?7, ?8, ?9
          WHERE (SELECT count(*) FROM clicks WHERE delivery_id = ?2 AND link_target_id = ?4) < ?10`,
      )
      .bind(
        id,
        target.deliveryId,
        target.broadcastId,
        target.linkTargetId,
        candidate,
        uaFamily(signals.userAgent),
        ipPrefix(signals.ip),
        signals.asn,
        now,
        MAX_CLICK_ROWS_PER_LINK,
      ),
    // Flow trigger link_clicked (Phase 6): the first human click on this Delivery and link only;
    // the Member comes from the Delivery.
    db
      .prepare(
        `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
         SELECT d.channel_id, d.member_id, 'link_clicked',
                json_object('url', l.url, 'dispatchId', b.dispatch_id, 'broadcastId', b.id,
                            'linkTargetId', l.id), ?3
           FROM deliveries d JOIN broadcasts b ON b.id = d.broadcast_id
           JOIN link_targets l ON l.id = ?2 AND l.broadcast_id = b.id
          WHERE d.id = ?1 AND d.member_id IS NOT NULL AND ${storedHuman('?4')}
            AND NOT EXISTS (SELECT 1 FROM clicks c WHERE c.delivery_id = ?1 AND c.link_target_id = ?2
                              AND c.classification = 'human' AND c.id <> ?4)`,
      )
      .bind(target.deliveryId, target.linkTargetId, now, id),
    db
      .prepare(
        `UPDATE deliveries SET clicked_at = coalesce(clicked_at, ?1),
                human_clicked_at = CASE WHEN ${storedHuman('?2')} THEN coalesce(human_clicked_at, ?1) ELSE human_clicked_at END,
                human_opened_at = CASE WHEN ${storedHuman('?2')} THEN coalesce(human_opened_at, ?1) ELSE human_opened_at END,
                opened_at = CASE WHEN ${storedHuman('?2')} THEN coalesce(opened_at, ?1) ELSE opened_at END
          WHERE id = ?3`,
      )
      // A human click implies the message was opened, even when images were blocked.
      .bind(now, id, target.deliveryId),
  ]);
  const stored = await first<{ classification: string }>(
    db,
    'SELECT classification FROM clicks WHERE id = ?1',
    id,
  );
  return stored?.classification ?? null;
}

export async function recordOpen(
  db: D1Database,
  deliveryId: string,
  signals: TrackSignals,
  now = Date.now(),
): Promise<string | null> {
  const delivery = await first<{ broadcast_id: string }>(
    db,
    'SELECT broadcast_id FROM deliveries WHERE id = ?1',
    deliveryId,
  );
  if (!delivery || !(await mayRecord(db, deliveryId, 'open'))) return null;
  const classification = classifyOpen(signals);
  const human = classification === 'human';
  await db.batch([
    // email_opened (Phase 6) wakes Flow waits: the first human open of a Flow email only. It runs
    // before the Delivery update below, which sets human_opened_at.
    ...(human
      ? [
          db
            .prepare(
              `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
               SELECT d.channel_id, d.member_id, 'email_opened',
                      json_object('dispatchId', b.dispatch_id, 'broadcastId', b.id), ?2
                 FROM deliveries d JOIN broadcasts b ON b.id = d.broadcast_id AND b.kind = 'flow'
                WHERE d.id = ?1 AND d.member_id IS NOT NULL AND d.human_opened_at IS NULL`,
            )
            .bind(deliveryId, now),
        ]
      : []),
    // At most MAX_OPEN_ROWS_PER_DELIVERY rows, whatever their classification.
    db
      .prepare(
        `INSERT INTO opens (id, delivery_id, broadcast_id, classification, ua_family, ip_prefix, asn, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
          WHERE (SELECT count(*) FROM opens WHERE delivery_id = ?2) < ?9`,
      )
      .bind(
        newIdFor('open', now),
        deliveryId,
        delivery.broadcast_id,
        classification,
        uaFamily(signals.userAgent),
        ipPrefix(signals.ip),
        signals.asn,
        now,
        MAX_OPEN_ROWS_PER_DELIVERY,
      ),
    db
      .prepare(
        `UPDATE deliveries SET opened_at = coalesce(opened_at, ?1),
                human_opened_at = CASE WHEN ?2 THEN coalesce(human_opened_at, ?1) ELSE human_opened_at END
          WHERE id = ?3`,
      )
      .bind(now, human ? 1 : 0, deliveryId),
  ]);
  return classification;
}
