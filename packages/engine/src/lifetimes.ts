/**
 * How long records outlive the relationship they were kept for (docs/privacy-controls.md "How
 * long other records are kept"). Every period here is a named constant or a workspace setting,
 * for the install owner to review; tables: migrations/0108_record_lifetimes.sql.
 *
 * CONTRACT
 * - Departed Members: someone unsubscribed, bounced or complained keeps their full profile for
 *   the workspace's left_member_retention_months (default LEFT_MEMBER_RETENTION_DEFAULT_MONTHS),
 *   counted from unsubscribed_at, or from the last change for a bounce or complaint. Then the row
 *   is reduced: names, profile field values, tags, source, referral and Champion code, the
 *   unsubscribe reason and their activity events go; the address, status, dates and consent
 *   records stay, so the departure keeps being honoured (no mail; a return goes through
 *   confirmation as before). reduced_at marks it; updated_at moves, so export destinations get
 *   the reduced line.
 * - Deleted Channels: restorable for CHANNEL_RESTORE_DAYS (routes/channels.ts). CHANNEL_PURGE_DAYS
 *   after the delete, the jobs worker deletes the Channel's Members (their rows cascade; delivery
 *   history keeps its counts without the address) and clears the addresses held without a Member
 *   in its checkouts, orders, Gift Passes, trial claims and sponsor bookings, which keep their
 *   amounts for the books; then marks it purged_at. After that, purgeDeletedChannelFiles deletes
 *   its stored files: every object under `ws/<workspace>/ch/<channel>/` in the media bucket
 *   (images, goods' files), the imports bucket and the exports bucket, FILE_PURGE_BATCH keys per
 *   bucket and run; then its media rows are marked deleted and files_purged_at is set.
 * - Payment references after erasure: an erasure (and a deleted Channel's purge) detaches payments
 *   and checkouts from the person and sets detached_at, keeping the provider's payment id and
 *   checkout session id for the publisher's books (privacy.ts RETAINED_PROVIDER_REFERENCES).
 *   The workspace's payment_record_years (PAYMENT_RECORD_YEARS, default 10) after the payment
 *   or the checkout, those ids are removed too: a payment's becomes `expired:<row id>`, a
 *   checkout's session id NULL. Amounts, currency and dates stay.
 * - Operator records: ended sign-in sessions, used or expired QuickPass codes, and invitations
 *   never accepted are deleted OPERATOR_RECORD_DAYS after they ended. An operator's own account
 *   events (account_events, 0110) go ACCOUNT_EVENT_DAYS after they were made.
 * - The audit log: kept for the workspace's audit_retention_months (AUDIT_RETENTION_DEFAULT_MONTHS)
 *   or the plan's auditRetentionDays, whichever is shorter (auditRetentionMs), on every plan;
 *   the jobs worker prunes it with pruneAuditEvents, which keeps the rest verifiable.
 * - Former teammates: an owner can redact someone with no seat or publication role left in the
 *   workspace (redactFormerTeammate). Their accepted invitations' address becomes the
 *   placeholder, and every workspace view that names who did something reads
 *   teammate_redactions (teammateEmailSql) and shows the placeholder. Audit entries are chained
 *   and stay as they are until retention prunes them; a teammate.redacted entry records it.
 */
import { appendAudit, sha256Hex } from '@swarm/db';
import { PLAN_LIMITS, type Plan } from '@swarm/domain';
import { all, first, run } from './db';
import { MONTH_MS } from './retention';

const DAY_MS = 86_400_000;
export const LEFT_MEMBER_RETENTION_DEFAULT_MONTHS = 24;
/** routes/channels.ts RESTORE_WINDOW_MS. */
export const CHANNEL_RESTORE_DAYS = 30;
/** A deleted Channel's subscribers' data goes this long after the delete: the window, then 30. */
export const CHANNEL_PURGE_DAYS = 60;
/** Ended sessions, spent sign-in codes and unaccepted invitations go this long after ending. */
export const OPERATOR_RECORD_DAYS = 30;
/** An operator's own account security events (sign-ins, factor changes) are kept this long. */
export const ACCOUNT_EVENT_DAYS = 400;
const BATCH = 500;
/** A year here is 365.25 days, as a month in retention.ts is a twelfth of one. */
const YEAR_MS = 12 * MONTH_MS;
/** What a payment's provider id becomes once its record period is over. */
export const EXPIRED_PAYMENT_PREFIX = 'expired:';

/** Reduces departed Members past their workspace's period, a bounded batch. Returns how many. */
export async function reduceDepartedMembers(db: D1Database, now: number): Promise<number> {
  const rows = await all<{ id: string }>(
    db,
    `SELECT m.id FROM members m JOIN channels c ON c.id = m.channel_id
       JOIN workspaces w ON w.id = c.workspace_id
      WHERE m.status IN ('unsubscribed', 'bounced', 'complained') AND m.reduced_at IS NULL
        AND coalesce(m.unsubscribed_at, m.updated_at) < ?1 - w.left_member_retention_months * ${MONTH_MS}
      LIMIT ${BATCH}`,
    now,
  );
  if (!rows.length) return 0;
  const ids = JSON.stringify(rows.map((r) => r.id));
  const these = 'SELECT value FROM json_each(?1)';
  await db.batch([
    db.prepare(`DELETE FROM member_field_values WHERE member_id IN (${these})`).bind(ids),
    db.prepare(`DELETE FROM member_tags WHERE member_id IN (${these})`).bind(ids),
    db.prepare(`DELETE FROM member_events WHERE member_id IN (${these})`).bind(ids),
    db
      .prepare(
        `UPDATE members SET first_name = NULL, last_name = NULL, source_json = '{}',
            champion_code = NULL, unsubscribe_reason = NULL, reduced_at = ?2, updated_at = ?2
          WHERE id IN (${these}) AND status IN ('unsubscribed', 'bounced', 'complained')`,
      )
      .bind(ids, now),
  ]);
  return rows.length;
}

/**
 * Disposes of one deleted Channel's subscribers' personal data past CHANNEL_PURGE_DAYS, a bounded
 * batch per call. Returns how many Members went and whether a Channel finished.
 */
export async function purgeDeletedChannels(
  db: D1Database,
  now: number,
): Promise<{ members: number; channels: number }> {
  const channel = await first<{ id: string }>(
    db,
    `SELECT id FROM channels WHERE deleted_at IS NOT NULL AND deleted_at < ?1 AND purged_at IS NULL
      ORDER BY deleted_at LIMIT 1`,
    now - CHANNEL_PURGE_DAYS * DAY_MS,
  );
  if (!channel) return { members: 0, channels: 0 };
  const rows = await all<{ id: string }>(
    db,
    'SELECT id FROM members WHERE channel_id = ?1 LIMIT ?2',
    channel.id,
    BATCH,
  );
  if (rows.length) {
    const ids = JSON.stringify(rows.map((r) => r.id));
    await db.batch([
      db
        .prepare(
          "UPDATE deliveries SET email = 'deleted' WHERE member_id IN (SELECT value FROM json_each(?1))",
        )
        .bind(ids),
      db
        .prepare(
          `UPDATE payments SET detached_at = coalesce(detached_at, ?2)
            WHERE member_id IN (SELECT value FROM json_each(?1))`,
        )
        .bind(ids, now),
      db
        .prepare(
          'DELETE FROM gate_meter_reads WHERE reader_key IN (SELECT value FROM json_each(?1))',
        )
        .bind(ids),
      db.prepare('DELETE FROM members WHERE id IN (SELECT value FROM json_each(?1))').bind(ids),
    ]);
    return { members: rows.length, channels: 0 };
  }
  // No Members left: the addresses held without one, then the mark.
  await db.batch([
    db.prepare('DELETE FROM gate_meter_reads WHERE channel_id = ?1').bind(channel.id),
    db.prepare('DELETE FROM left_addresses WHERE channel_id = ?1').bind(channel.id),
    db
      .prepare(
        `UPDATE checkout_sessions SET email = NULL, detached_at = coalesce(detached_at, ?2)
          WHERE channel_id = ?1`,
      )
      .bind(channel.id, now),
    db
      .prepare('UPDATE payments SET detached_at = coalesce(detached_at, ?2) WHERE channel_id = ?1')
      .bind(channel.id, now),
    db
      .prepare(
        "UPDATE good_orders SET email = 'erased' WHERE channel_id = ?1 AND email <> 'erased'",
      )
      .bind(channel.id),
    db
      .prepare(
        `UPDATE gift_passes SET purchaser_email = 'erased', recipient_email = NULL, message = NULL
          WHERE channel_id = ?1`,
      )
      .bind(channel.id),
    db.prepare('DELETE FROM trial_claims WHERE channel_id = ?1').bind(channel.id),
    db
      .prepare(
        "UPDATE sponsor_bookings SET sponsor_email = 'erased', sponsor_name = 'erased' WHERE channel_id = ?1",
      )
      .bind(channel.id),
    db.prepare('UPDATE channels SET purged_at = ?1 WHERE id = ?2').bind(now, channel.id),
  ]);
  return { members: 0, channels: 1 };
}

/** Deletes operator records past OPERATOR_RECORD_DAYS after they ended. */
export async function pruneOperatorRecords(
  db: D1Database,
  now: number,
): Promise<{ sessions: number; codes: number; invites: number; accountEvents: number }> {
  const before = now - OPERATOR_RECORD_DAYS * DAY_MS;
  const sessions = await run(
    db,
    `DELETE FROM sessions WHERE id IN (SELECT id FROM sessions
        WHERE coalesce(revoked_at, expires_at) < ?1 AND (revoked_at IS NOT NULL OR expires_at < ?2)
        LIMIT ${BATCH * 4})`,
    before,
    now,
  );
  const codes = await run(
    db,
    `DELETE FROM quickpass_tokens WHERE id IN (SELECT id FROM quickpass_tokens
        WHERE coalesce(consumed_at, expires_at) < ?1 LIMIT ${BATCH * 4})`,
    before,
  );
  const invites = await run(
    db,
    `DELETE FROM invites WHERE id IN (SELECT id FROM invites
        WHERE accepted_at IS NULL AND coalesce(revoked_at, expires_at) < ?1 LIMIT ${BATCH * 4})`,
    before,
  );
  // "This wasn't me" links of first factors, once used or expired (0114).
  await run(
    db,
    `DELETE FROM factor_undo_tokens WHERE rowid IN (SELECT rowid FROM factor_undo_tokens
        WHERE coalesce(used_at, expires_at) < ?1 LIMIT ${BATCH * 4})`,
    before,
  );
  const accountEvents = await run(
    db,
    `DELETE FROM account_events WHERE id IN (SELECT id FROM account_events
        WHERE created_at < ?1 LIMIT ${BATCH * 4})`,
    now - ACCOUNT_EVENT_DAYS * DAY_MS,
  );
  return {
    sessions: sessions.meta.changes ?? 0,
    codes: codes.meta.changes ?? 0,
    invites: invites.meta.changes ?? 0,
    accountEvents: accountEvents.meta.changes ?? 0,
  };
}

/**
 * Removes the provider references of detached payments and checkouts whose record period
 * (workspaces.payment_record_years) has passed since the payment or the checkout, a bounded
 * batch per table. Returns how many of each.
 */
export async function expirePaymentReferences(
  db: D1Database,
  now: number,
): Promise<{ payments: number; checkouts: number }> {
  const payments = await run(
    db,
    `UPDATE payments SET stripe_object_id = '${EXPIRED_PAYMENT_PREFIX}' || id
      WHERE id IN (
        SELECT p.id FROM payments p JOIN channels c ON c.id = p.channel_id
          JOIN workspaces w ON w.id = c.workspace_id
         WHERE p.detached_at IS NOT NULL AND p.stripe_object_id NOT LIKE '${EXPIRED_PAYMENT_PREFIX}%'
           AND p.occurred_at < ?1 - w.payment_record_years * ${YEAR_MS}
         LIMIT ${BATCH})`,
    now,
  );
  const checkouts = await run(
    db,
    `UPDATE checkout_sessions SET stripe_session_id = NULL
      WHERE reference IN (
        SELECT s.reference FROM checkout_sessions s JOIN channels c ON c.id = s.channel_id
          JOIN workspaces w ON w.id = c.workspace_id
         WHERE s.detached_at IS NOT NULL AND s.stripe_session_id IS NOT NULL
           AND coalesce(s.completed_at, s.created_at) < ?1 - w.payment_record_years * ${YEAR_MS}
         LIMIT ${BATCH})`,
    now,
  );
  return { payments: payments.meta.changes ?? 0, checkouts: checkouts.meta.changes ?? 0 };
}

/** Keys deleted per bucket and run (R2 lists and deletes at most 1,000 at a time). */
export const FILE_PURGE_BATCH = 1000;

/** The buckets that hold a publication's files, under `ws/<workspace>/ch/<channel>/`. */
export interface ChannelFileBuckets {
  media: R2Bucket;
  imports: R2Bucket;
  exports: R2Bucket;
}

/**
 * Deletes the stored files of one Channel whose personal data was purged (purged_at), a bounded
 * batch per bucket and call. Returns how many objects went and whether a Channel finished.
 */
export async function purgeDeletedChannelFiles(
  db: D1Database,
  buckets: ChannelFileBuckets,
  now: number,
): Promise<{ objects: number; channels: number }> {
  const channel = await first<{ id: string; workspace_id: string }>(
    db,
    `SELECT id, workspace_id FROM channels
      WHERE purged_at IS NOT NULL AND files_purged_at IS NULL AND deleted_at IS NOT NULL
      ORDER BY purged_at LIMIT 1`,
  );
  if (!channel) return { objects: 0, channels: 0 };
  const prefix = `ws/${channel.workspace_id}/ch/${channel.id}/`;
  let objects = 0;
  let more = false;
  for (const bucket of [buckets.media, buckets.imports, buckets.exports]) {
    const listed = await bucket.list({ prefix, limit: FILE_PURGE_BATCH });
    if (listed.objects.length) {
      await bucket.delete(listed.objects.map((object) => object.key));
      objects += listed.objects.length;
    }
    if (listed.truncated || listed.objects.length) more = true;
  }
  // Another run lists again: done only once every bucket is empty under the prefix.
  if (more) return { objects, channels: 0 };
  await db.batch([
    db
      .prepare('UPDATE media SET deleted_at = ?2 WHERE channel_id = ?1 AND deleted_at IS NULL')
      .bind(channel.id, now),
    db.prepare('UPDATE channels SET files_purged_at = ?2 WHERE id = ?1').bind(channel.id, now),
  ]);
  return { objects, channels: 1 };
}

export const AUDIT_RETENTION_DEFAULT_MONTHS = 24;

/** How long a workspace keeps its audit log: its own setting, or less where the plan says. */
export function auditRetentionMs(plan: Plan, months: number): number {
  const days = PLAN_LIMITS[plan].auditRetentionDays;
  const own = months * MONTH_MS;
  return days === null ? own : Math.min(own, days * DAY_MS);
}

/** The placeholder a redacted teammate is shown as in one workspace. Stable, not reversible. */
export async function teammatePlaceholder(workspaceId: string, operatorId: string) {
  const hex = (await sha256Hex(`teammate:${workspaceId}:${operatorId}`)).slice(0, 12);
  return `former-teammate-${hex}@redacted.invalid`;
}

/**
 * SQL for a teammate's address as this workspace shows it: the placeholder once an owner redacted
 * them here, else their address. `operator` is the operators alias, `workspace` an expression
 * for the workspace id.
 */
export const teammateEmailSql = (operator: string, workspace: string) =>
  `coalesce((SELECT x.placeholder FROM teammate_redactions x
              WHERE x.workspace_id = ${workspace} AND x.operator_id = ${operator}.id), ${operator}.email)`;

/** The same for their name: no name once redacted. */
export const teammateNameSql = (operator: string, workspace: string) =>
  `CASE WHEN EXISTS (SELECT 1 FROM teammate_redactions x
          WHERE x.workspace_id = ${workspace} AND x.operator_id = ${operator}.id)
        THEN NULL ELSE ${operator}.name END`;

export type RedactOutcome = 'redacted' | 'already' | 'has_seat' | 'unknown';

/**
 * Redacts a former teammate's details in one workspace: someone who appears in its records (an
 * audit entry or an accepted invitation) and holds no seat or publication role there now. The
 * operator account itself, which other workspaces may use, is untouched.
 */
export async function redactFormerTeammate(
  db: D1Database,
  input: { workspaceId: string; operatorId: string; by: string; ipPrefix?: string | null },
  now: number = Date.now(),
): Promise<{ outcome: RedactOutcome; placeholder: string | null }> {
  const { workspaceId, operatorId } = input;
  const person = await first<{ email: string | null; seated: number; known: number }>(
    db,
    `SELECT (SELECT email FROM operators WHERE id = ?2) AS email,
            EXISTS (SELECT 1 FROM seats WHERE workspace_id = ?1 AND operator_id = ?2)
              OR EXISTS (SELECT 1 FROM channel_roles cr JOIN channels c ON c.id = cr.channel_id
                          WHERE c.workspace_id = ?1 AND cr.operator_id = ?2) AS seated,
            EXISTS (SELECT 1 FROM audit_events WHERE workspace_id = ?1 AND actor_operator_id = ?2)
              OR EXISTS (SELECT 1 FROM invites i JOIN operators o ON o.email = i.email
                          WHERE i.workspace_id = ?1 AND o.id = ?2) AS known`,
    workspaceId,
    operatorId,
  );
  if (!person?.known) return { outcome: 'unknown', placeholder: null };
  if (person.seated) return { outcome: 'has_seat', placeholder: null };
  const placeholder = await teammatePlaceholder(workspaceId, operatorId);
  const added = await run(
    db,
    `INSERT INTO teammate_redactions (workspace_id, operator_id, placeholder, redacted_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING`,
    workspaceId,
    operatorId,
    placeholder,
    input.by,
    now,
  );
  if (person.email) {
    await run(
      db,
      'UPDATE invites SET email = ?3 WHERE workspace_id = ?1 AND email = ?2',
      workspaceId,
      person.email,
      placeholder,
    );
  }
  if (!added.meta.changes) return { outcome: 'already', placeholder };
  // The chain is not rewritten: this entry says from when the log reads them as the placeholder.
  await appendAudit(db, {
    workspaceId,
    actorId: input.by,
    action: 'teammate.redacted',
    targetType: 'operator',
    targetId: operatorId,
    metadata: { placeholder },
    ipPrefix: input.ipPrefix ?? null,
  });
  return { outcome: 'redacted', placeholder };
}
