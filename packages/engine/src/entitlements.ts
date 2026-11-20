/**
 * Entitlements (Phase 5). `member_subscriptions` is the source of truth; `member_entitlements`
 * (one 'paid' row per Member) is a cache of what it grants right now, read on every gated page.
 * Anything that changes a Member's subscriptions calls `recomputeEntitlement` afterwards.
 *
 * A subscription grants access when it isn't revoked and:
 * - source 'lifetime': always;
 * - source 'stripe': status trialing or active, or past_due while grace_until is in the future;
 *   canceled-at-period-end subscriptions stay active (Stripe keeps the status) until they end;
 * - source 'comp' or 'gift': status active, until current_period_end (null = no end).
 * The best grant wins: lifetime first, then the one that lasts longest; a Founding Level beats a
 * regular one that lasts as long.
 *
 * expires_at on the cache row is a backstop for missed webhooks: for Stripe subscriptions it is
 * the period end plus STRIPE_EXPIRY_SLACK (renewals push it forward through webhooks).
 */
import { first, run } from './db';
import { recordMemberEvents, type MemberEventInput } from './events';

export const STRIPE_EXPIRY_SLACK_MS = 3 * 24 * 60 * 60 * 1000;

interface GrantRow {
  id: string;
  level_id: string | null;
  source: 'stripe' | 'lifetime' | 'gift' | 'comp';
  status: string;
  current_period_end: number | null;
  grace_until: number | null;
  created_at: number;
  founding: number | null;
}

export interface Entitlement {
  levelId: string | null;
  source: GrantRow['source'];
  subscriptionId: string;
  startsAt: number;
  /** Null for no end. */
  expiresAt: number | null;
}

function grantEnd(row: GrantRow, now: number): number | null | undefined {
  switch (row.source) {
    case 'lifetime':
      return row.status === 'lifetime' ? null : undefined;
    case 'comp':
    case 'gift':
      if (row.status !== 'active') return undefined;
      if (row.current_period_end !== null && row.current_period_end <= now) return undefined;
      return row.current_period_end;
    case 'stripe':
      if (row.status === 'trialing' || row.status === 'active') {
        return row.current_period_end === null
          ? null
          : row.current_period_end + STRIPE_EXPIRY_SLACK_MS;
      }
      if (row.status === 'past_due' && row.grace_until !== null && row.grace_until > now) {
        return row.grace_until;
      }
      return undefined;
  }
}

/** What a Member is entitled to now, from their subscriptions, without writing anything. */
export async function currentEntitlement(
  db: D1Database,
  channelId: string,
  memberId: string,
  now: number = Date.now(),
): Promise<Entitlement | null> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.level_id, s.source, s.status, s.current_period_end, s.grace_until, s.created_at,
              l.founding
         FROM member_subscriptions s LEFT JOIN membership_levels l ON l.id = s.level_id
        WHERE s.member_id = ?1 AND s.channel_id = ?2 AND s.revoked_at IS NULL`,
    )
    .bind(memberId, channelId)
    .all<GrantRow>();
  let best: { row: GrantRow; end: number | null } | null = null;
  for (const row of results) {
    const end = grantEnd(row, now);
    if (end === undefined) continue;
    if (!best) {
      best = { row, end };
      continue;
    }
    const longer = end === null ? best.end !== null : best.end !== null && end > best.end;
    const tie = end === best.end && (row.founding ?? 0) > (best.row.founding ?? 0);
    if (longer || tie) best = { row, end };
  }
  if (!best) return null;
  return {
    levelId: best.row.level_id,
    source: best.row.source,
    subscriptionId: best.row.id,
    startsAt: best.row.created_at,
    expiresAt: best.end,
  };
}

/** Rewrites the Member's member_entitlements row from their subscriptions. */
export async function recomputeEntitlement(
  db: D1Database,
  channelId: string,
  memberId: string,
  now: number = Date.now(),
): Promise<Entitlement | null> {
  const entitlement = await currentEntitlement(db, channelId, memberId, now);
  // The cached row before this change, for the level_purchased / level_canceled Flow triggers.
  const before = await first<{ level_id: string | null }>(
    db,
    `SELECT level_id FROM member_entitlements WHERE member_id = ?1 AND kind = 'paid'`,
    memberId,
  );
  const events: MemberEventInput[] = [];
  if (before && (!entitlement || entitlement.levelId !== before.level_id)) {
    events.push({
      type: 'level_canceled',
      memberId,
      channelId,
      payload: { levelId: before.level_id },
    });
  }
  if (entitlement && (!before || entitlement.levelId !== before.level_id)) {
    events.push({
      type: 'level_purchased',
      memberId,
      channelId,
      payload: { levelId: entitlement.levelId, source: entitlement.source },
    });
  }
  if (!entitlement) {
    await run(
      db,
      `DELETE FROM member_entitlements WHERE member_id = ?1 AND kind = 'paid'`,
      memberId,
    );
    await recordMemberEvents(db, events, now);
    return null;
  }
  await run(
    db,
    `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at, expires_at, level_id)
     VALUES (?1, ?2, 'paid', ?3, ?4, ?5, ?6)
     ON CONFLICT (member_id, kind) DO UPDATE SET
       channel_id = excluded.channel_id, source = excluded.source, starts_at = excluded.starts_at,
       expires_at = excluded.expires_at, level_id = excluded.level_id`,
    memberId,
    channelId,
    entitlement.source,
    entitlement.startsAt,
    entitlement.expiresAt,
    entitlement.levelId,
  );
  await recordMemberEvents(db, events, now);
  return entitlement;
}

/** The level a Member holds now according to the cache, or null (free). */
export async function entitledLevel(
  db: D1Database,
  channelId: string,
  memberId: string,
  now: number = Date.now(),
): Promise<string | null | undefined> {
  const row = await first<{ level_id: string | null }>(
    db,
    `SELECT level_id FROM member_entitlements
      WHERE member_id = ?1 AND channel_id = ?2 AND kind = 'paid'
        AND starts_at <= ?3 AND (expires_at IS NULL OR expires_at > ?3)`,
    memberId,
    channelId,
    now,
  );
  // undefined: not entitled; null: entitled with no specific level (Phase 4 rows).
  return row ? row.level_id : undefined;
}
