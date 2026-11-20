/**
 * Engagement retention (docs/privacy-controls.md): after a workspace's
 * engagement_retention_months, sends stop naming the people they went to. Table changes:
 * migrations/0063_tracking_choices.sql.
 *
 * CONTRACT
 * - Send reports count from delivery rows, their opens and clicks, so nothing is deleted that a
 *   count reads. A delivery past the limit keeps its send, status and times and loses the Member
 *   reference, the address, the provider's message id and any error text; its opens and clicks
 *   lose the network prefix, network (ASN) and browser family. Every number on a send report stays
 *   as it was.
 * - Per-send copies of addresses: a finished post's copies (broadcast_recipients) are deleted. An
 *   automation email's copies keep their Member reference, because that row is what stops the
 *   automation sending the same email twice, and lose the address and names.
 * - Bounce history (bounce_events) is read by the bounce rules for at most 90 days
 *   (BOUNCE_LIMITS.historyDays) and deleted after that; an address's counters (bounce_states)
 *   go once nothing has bounced for that long, unless an admin still has to decide on them.
 *   soft_bounces is no longer written (0067); what is left in it goes after SOFT_BOUNCE_DAYS.
 * - Suppressions are never touched: they are how Swarm keeps not mailing someone.
 * - It runs from the jobs worker's five-minute cron in bounded batches (RETENTION_BATCHES per run),
 *   so a large backlog, such as the first run on an old install, is spread over many runs.
 * - A month is MONTH_MS (an average month, 30.44 days).
 * - Unsubscribe links in emails past the limit keep working: just before a delivery to someone
 *   who can still be mailed (pending, active, paused) loses its Member, the Member is written to
 *   unsubscribe_refs (0106), which holds only the delivery and Member ids and is read only by the
 *   unsubscribe page. Those rows go with the Member and after UNSUBSCRIBE_REF_MONTHS; after that
 *   the link says it is too old and how to unsubscribe instead. Links to content keep working.
 */
import { BOUNCE_LIMITS } from '@swarm/domain';
import { all } from './db';

export const MONTH_MS = 2_629_746_000;
const DAY_MS = 86_400_000;
/** Rows left in the old soft_bounces table (no longer written) go after this many days. */
export const SOFT_BOUNCE_DAYS = 30;
/**
 * How long, past the engagement limit, an old email's unsubscribe link still finds its person
 * (unsubscribe_refs). Owner-reviewable: long enough for people acting on old mail, bounded so the
 * reference does not live forever.
 */
export const UNSUBSCRIBE_REF_MONTHS = 24;
/** What erasure and this job write in place of an address. */
const ANONYMOUS = 'erased';
const BATCH = 500;
export const RETENTION_BATCHES = 20;

export interface RetentionResult {
  deliveries: number;
  copiesDeleted: number;
  copiesCleared: number;
  softBounces: number;
  bounces: number;
  /** Expired unsubscribe references deleted. */
  unsubscribeRefs: number;
}

const FINISHED = "('sent', 'partially_failed', 'canceled', 'failed')";
/** A recipient row nothing will send to again. */
const DONE = "('sent', 'failed', 'skipped')";

/** One page of a Channel's deliveries past the cutoff. Returns how many it anonymised. */
async function anonymiseDeliveries(
  db: D1Database,
  channelId: string,
  cutoff: number,
  now: number,
): Promise<number> {
  const rows = await all<{ id: string }>(
    db,
    `SELECT id FROM deliveries WHERE channel_id = ?1 AND sent_at < ?2 AND email <> '${ANONYMOUS}'
      LIMIT ${BATCH}`,
    channelId,
    cutoff,
  );
  if (!rows.length) return 0;
  const ids = JSON.stringify(rows.map((row) => row.id));
  const these = 'SELECT value FROM json_each(?1)';
  await db.batch([
    // The withdrawal-only reference, before the Member reference goes.
    db
      .prepare(
        `INSERT INTO unsubscribe_refs (delivery_id, member_id, expires_at)
         SELECT d.id, d.member_id, ?2 FROM deliveries d JOIN members m ON m.id = d.member_id
          WHERE d.id IN (${these}) AND m.status IN ('pending', 'active', 'paused')
         ON CONFLICT (delivery_id) DO NOTHING`,
      )
      .bind(ids, now + UNSUBSCRIBE_REF_MONTHS * MONTH_MS),
    db
      .prepare(
        `UPDATE opens SET ip_prefix = NULL, asn = NULL, ua_family = NULL WHERE delivery_id IN (${these})`,
      )
      .bind(ids),
    db
      .prepare(
        `UPDATE clicks SET ip_prefix = NULL, asn = NULL, ua_family = NULL WHERE delivery_id IN (${these})`,
      )
      .bind(ids),
    db
      .prepare(
        `UPDATE deliveries SET member_id = NULL, email = '${ANONYMOUS}', provider_message_id = NULL,
                error = NULL
          WHERE id IN (${these})`,
      )
      .bind(ids),
  ]);
  return rows.length;
}

/**
 * Moves the retention work along within a budget of batches. Safe to run twice: each batch picks
 * only rows that still name someone.
 */
export async function anonymiseExpiredEngagement(
  db: D1Database,
  now: number,
  budget = RETENTION_BATCHES,
): Promise<RetentionResult> {
  const result: RetentionResult = {
    deliveries: 0,
    copiesDeleted: 0,
    copiesCleared: 0,
    softBounces: 0,
    bounces: 0,
    unsubscribeRefs: 0,
  };
  let batches = 0;

  // Deliveries, Channel by Channel (deleted ones too: their rows are still there).
  const channels = await all<{ id: string; months: number }>(
    db,
    `SELECT c.id, w.engagement_retention_months AS months
       FROM channels c JOIN workspaces w ON w.id = c.workspace_id ORDER BY c.id`,
  );
  // Only a batch that changed rows counts toward the budget: a Channel with nothing due costs one
  // index lookup, and must not keep the Channels after it waiting.
  for (const channel of channels) {
    if (batches >= budget) return result;
    const cutoff = now - channel.months * MONTH_MS;
    while (batches < budget) {
      const n = await anonymiseDeliveries(db, channel.id, cutoff, now);
      result.deliveries += n;
      if (n) batches++;
      if (n < BATCH) break;
    }
  }

  // A finished post's per-send copies of addresses and names.
  const posts = await all<{ id: string }>(
    db,
    `SELECT b.id FROM broadcasts b JOIN workspaces w ON w.id = b.workspace_id
      WHERE b.kind = 'broadcast' AND b.status IN ${FINISHED}
        AND coalesce(b.completed_at, b.canceled_at, b.last_progress_at) < ?1 - w.engagement_retention_months * ${MONTH_MS}
        AND EXISTS (SELECT 1 FROM broadcast_recipients r WHERE r.broadcast_id = b.id)
      LIMIT ?2`,
    now,
    Math.max(0, budget - batches),
  );
  for (const post of posts) {
    if (batches >= budget) return result;
    batches++;
    const deleted = await db
      .prepare(
        `DELETE FROM broadcast_recipients WHERE broadcast_id = ?1
            AND member_id IN (SELECT member_id FROM broadcast_recipients WHERE broadcast_id = ?1
                                LIMIT ${BATCH * 4})`,
      )
      .bind(post.id)
      .run();
    result.copiesDeleted += deleted.meta.changes ?? 0;
  }

  // An automation email's copies: the row stays (it stops a second send), the address goes. Only
  // emails with a copy still due, found through the identified-recipients index (0063), and no
  // more than the budget: once everything is anonymised this is one query that finds nothing.
  const flowEmails = await all<{ id: string; cutoff: number }>(
    db,
    `SELECT b.id, ?1 - w.engagement_retention_months * ${MONTH_MS} AS cutoff
       FROM broadcasts b JOIN workspaces w ON w.id = b.workspace_id
      WHERE b.kind = 'flow' AND b.created_at < ?1 - w.engagement_retention_months * ${MONTH_MS}
        AND EXISTS (SELECT 1 FROM broadcast_recipients r
                     WHERE r.broadcast_id = b.id
                       AND r.claimed_at < ?1 - w.engagement_retention_months * ${MONTH_MS}
                       AND r.email <> '${ANONYMOUS}' AND r.status IN ${DONE})
      LIMIT ?2`,
    now,
    Math.max(0, budget - batches),
  );
  for (const email of flowEmails) {
    if (batches >= budget) return result;
    batches++;
    const cleared = await db
      .prepare(
        `UPDATE broadcast_recipients SET email = '${ANONYMOUS}', first_name = NULL, last_name = NULL
          WHERE broadcast_id = ?1
            AND member_id IN (SELECT member_id FROM broadcast_recipients
                               WHERE broadcast_id = ?1 AND claimed_at < ?2 AND email <> '${ANONYMOUS}'
                                 AND status IN ${DONE}
                               LIMIT ${BATCH * 4})`,
      )
      .bind(email.id, email.cutoff)
      .run();
    result.copiesCleared += cleared.meta.changes ?? 0;
  }

  // Unsubscribe references past their own limit.
  if (batches < budget) {
    const deleted = await db
      .prepare(
        `DELETE FROM unsubscribe_refs WHERE delivery_id IN
           (SELECT delivery_id FROM unsubscribe_refs WHERE expires_at <= ?1 LIMIT ${BATCH * 4})`,
      )
      .bind(now)
      .run();
    result.unsubscribeRefs = deleted.meta.changes ?? 0;
  }

  // Soft bounces.
  if (batches < budget) {
    const deleted = await db
      .prepare(
        `DELETE FROM soft_bounces WHERE rowid IN
           (SELECT rowid FROM soft_bounces WHERE created_at < ?1 LIMIT ${BATCH * 4})`,
      )
      .bind(now - SOFT_BOUNCE_DAYS * DAY_MS)
      .run();
    result.softBounces = deleted.meta.changes ?? 0;
  }
  if (batches < budget) {
    const cutoff = now - BOUNCE_LIMITS.historyDays * DAY_MS;
    const [events, states] = await db.batch([
      db
        .prepare(
          `DELETE FROM bounce_events WHERE rowid IN
             (SELECT rowid FROM bounce_events WHERE created_at < ?1 LIMIT ${BATCH * 4})`,
        )
        .bind(cutoff),
      db
        .prepare(
          `DELETE FROM bounce_states WHERE id IN
             (SELECT id FROM bounce_states WHERE updated_at < ?1 AND held_at IS NULL LIMIT ${BATCH * 4})`,
        )
        .bind(cutoff),
    ]);
    result.bounces = (events?.meta.changes ?? 0) + (states?.meta.changes ?? 0);
  }
  return result;
}
