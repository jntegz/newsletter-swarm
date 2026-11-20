/**
 * Comp access (Phase 5): a Membership level for free, with an optional end. A grant is a
 * comp_grants row (who, why) plus a member_subscriptions row (source 'comp') that the entitlement
 * is recomputed from. Used by the api's comp routes and by Champions rewards (Phase 6).
 */
import { newIdFor } from './db';
import { recomputeEntitlement } from './entitlements';

export interface CompGrantInput {
  channelId: string;
  memberId: string;
  levelId: string;
  /** Epoch ms, or null for no end. */
  expiresAt: number | null;
  note?: string | null;
  /** The operator, or null when the platform grants it (a Champions reward). */
  grantedBy: string | null;
}

/** Inserts the grant and its subscription row, then recomputes the entitlement. */
export async function grantComp(
  db: D1Database,
  input: CompGrantInput,
  now = Date.now(),
): Promise<{ grantId: string; subscriptionId: string }> {
  const subscriptionId = newIdFor('memberSubscription', now);
  const grantId = newIdFor('compGrant', now);
  await db.batch([
    db
      .prepare(
        `INSERT INTO member_subscriptions (id, channel_id, member_id, level_id, source, status,
           current_period_end, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'comp', 'active', ?5, ?6, ?6)`,
      )
      .bind(subscriptionId, input.channelId, input.memberId, input.levelId, input.expiresAt, now),
    db
      .prepare(
        `INSERT INTO comp_grants (id, channel_id, member_id, level_id, subscription_id, expires_at,
           note, granted_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(
        grantId,
        input.channelId,
        input.memberId,
        input.levelId,
        subscriptionId,
        input.expiresAt,
        input.note ?? null,
        input.grantedBy,
        now,
      ),
  ]);
  await recomputeEntitlement(db, input.channelId, input.memberId, now);
  return { grantId, subscriptionId };
}
