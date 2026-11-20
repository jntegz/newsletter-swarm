/**
 * Comp grants: a Membership level given for free, as a comp_grants row (who, why) plus a
 * member_subscriptions row (source 'comp', status 'active', ending at expiresAt or never), then a
 * recomputed entitlement. Shared by everything that grants without an operator request, e.g. the
 * Flows engine's change_level node. (The API's comp routes write the same two rows.)
 */
import { grantComp, type CompGrantInput } from './comp';
import { all, first } from './db';
import { recomputeEntitlement } from './entitlements';

/** Whether the level is an active level of the Channel and the Member is in it. Reads only. */
export async function compGrantAllowed(
  db: D1Database,
  input: Pick<CompGrantInput, 'levelId' | 'channelId' | 'memberId'>,
): Promise<boolean> {
  const ok = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM membership_levels l JOIN members m ON m.channel_id = l.channel_id
      WHERE l.id = ?1 AND l.channel_id = ?2 AND l.status = 'active' AND m.id = ?3`,
    input.levelId,
    input.channelId,
    input.memberId,
  );
  return !!ok;
}

/**
 * Grants `levelId` to the Member through `grantComp`, but only when the level is an active level
 * of the Channel and the Member is in it; otherwise nothing is written and null is returned.
 * Returns the grant id.
 */
export async function grantCompChecked(
  db: D1Database,
  input: CompGrantInput,
  now: number = Date.now(),
): Promise<string | null> {
  if (!(await compGrantAllowed(db, input))) return null;
  return (await grantComp(db, input, now)).grantId;
}

interface RevokeInput {
  channelId: string;
  memberId: string;
  levelId: string;
  noteMarker: string;
}

/** The Member's live comp grants on `levelId` whose note contains `noteMarker`. Reads only. */
export function liveCompGrants(db: D1Database, input: RevokeInput) {
  return all<{ id: string; subscription_id: string | null }>(
    db,
    `SELECT id, subscription_id FROM comp_grants
      WHERE channel_id = ?1 AND member_id = ?2 AND level_id = ?3 AND revoked_at IS NULL
        AND instr(ifnull(note, ''), ?4) > 0`,
    input.channelId,
    input.memberId,
    input.levelId,
    input.noteMarker,
  );
}

/**
 * Revokes the Member's live comp grants on `levelId` whose note contains `noteMarker` (for
 * example the grants one Flow made), ends their subscriptions and recomputes the entitlement.
 * Returns how many were revoked.
 */
export async function revokeCompGrants(
  db: D1Database,
  input: RevokeInput,
  now: number = Date.now(),
): Promise<number> {
  const grants = await liveCompGrants(db, input);
  if (!grants.length) return 0;
  await db.batch(
    grants.flatMap((grant) => [
      db.prepare('UPDATE comp_grants SET revoked_at = ?1 WHERE id = ?2').bind(now, grant.id),
      db
        .prepare(
          `UPDATE member_subscriptions SET revoked_at = ?1, revoke_reason = 'operator', status = 'ended',
                  updated_at = ?1
            WHERE id = ?2 AND channel_id = ?3 AND source = 'comp'`,
        )
        .bind(now, grant.subscription_id, input.channelId),
    ]),
  );
  await recomputeEntitlement(db, input.channelId, input.memberId, now);
  return grants.length;
}
