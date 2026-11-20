// Comp access (Phase 5): an operator grants a Member a Membership level for free, with an optional
// end. Each grant is a comp_grants row (who, why) and a member_subscriptions row (source 'comp')
// that the entitlement is recomputed from. Grants and revocations are audited.
import { createRoute } from '@hono/zod-openapi';
import { all, first, toIso } from '@swarm/db';
import {
  CompGrantListQuerySchema,
  CompGrantListSchema,
  CompGrantSchema,
  CreateCompGrantSchema,
  idPattern,
  type CompGrant,
} from '@swarm/domain';
import { grantComp, recomputeEntitlement } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { createRouter, env } from '../lib/context';
import { requireChannelMember, requireLevel } from '../lib/levels';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { audit } from '../lib/site';

export const comp = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const memberParams = channelParam.extend(idParam('memberId', idPattern('member')).shape);
const grantParams = channelParam.extend(idParam('grantId', idPattern('compGrant')).shape);

interface GrantRow {
  id: string;
  channel_id: string;
  member_id: string;
  member_email: string | null;
  level_id: string | null;
  level_name: string | null;
  subscription_id: string | null;
  expires_at: number | null;
  note: string | null;
  granted_by: string | null;
  created_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
}

const SELECT_GRANTS = `SELECT g.*, m.email AS member_email, l.name AS level_name
  FROM comp_grants g LEFT JOIN members m ON m.id = g.member_id
  LEFT JOIN membership_levels l ON l.id = g.level_id`;

function toGrant(row: GrantRow, now: number): CompGrant {
  return {
    id: row.id,
    channelId: row.channel_id,
    memberId: row.member_id,
    memberEmail: row.member_email,
    levelId: row.level_id,
    levelName: row.level_name,
    subscriptionId: row.subscription_id,
    expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
    note: row.note,
    grantedBy: row.granted_by,
    createdAt: toIso(row.created_at),
    revokedAt: row.revoked_at === null ? null : toIso(row.revoked_at),
    revokedBy: row.revoked_by,
    active: row.revoked_at === null && (row.expires_at === null || row.expires_at > now),
  };
}

async function listGrants(
  db: D1Database,
  channelId: string,
  memberId: string | null,
  includeRevoked: boolean,
): Promise<CompGrant[]> {
  const rows = await all<GrantRow>(
    db,
    `${SELECT_GRANTS} WHERE g.channel_id = ?1 AND (?2 IS NULL OR g.member_id = ?2)
       AND (?3 = 1 OR g.revoked_at IS NULL)
     ORDER BY g.created_at DESC LIMIT 500`,
    channelId,
    memberId,
    includeRevoked ? 1 : 0,
  );
  const now = Date.now();
  return rows.map((row) => toGrant(row, now));
}

comp.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/members/{memberId}/comp',
    tags: ['Comp access'],
    summary: 'Give a Member a Membership level for free',
    description:
      'Admin role. Creates a comp grant and a member_subscriptions row (source comp, status active, ending at expiresAt or never) and recomputes the Member’s entitlement. Audited.',
    request: { params: memberParams, body: jsonBody(CreateCompGrantSchema) },
    responses: {
      201: ok(CompGrantSchema, 'Granted'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, memberId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const db = env(c).DB;
    await requireChannelMember(db, channelId, memberId);
    const level = await requireLevel(db, channelId, input.levelId).catch((error: unknown) => {
      if (error instanceof ApiError && error.code === 'not_found') {
        const message = 'Choose a paid plan of this publication.';
        throw new ApiError('invalid_input', message, [{ path: 'levelId', message }]);
      }
      throw error;
    });
    if (level.status !== 'active') {
      const message = 'Choose a paid plan that is not archived.';
      throw new ApiError('invalid_input', message, [{ path: 'levelId', message }]);
    }
    const now = Date.now();
    const expiresAt = input.expiresAt ? Date.parse(input.expiresAt) : null;
    if (expiresAt !== null && expiresAt <= now + 60_000) {
      const message = 'Pick an end in the future.';
      throw new ApiError('invalid_input', message, [{ path: 'expiresAt', message }]);
    }
    const { grantId } = await grantComp(
      db,
      {
        channelId,
        memberId,
        levelId: level.id,
        expiresAt,
        note: input.note ?? null,
        grantedBy: access.auth.operatorId,
      },
      now,
    );
    await audit(c, access, 'member.comp_granted', 'member', memberId, {
      grantId,
      levelId: level.id,
      expiresAt: input.expiresAt ?? null,
    });
    const row = await first<GrantRow>(db, `${SELECT_GRANTS} WHERE g.id = ?1`, grantId);
    return c.json({ data: toGrant(row as GrantRow, now) }, 201);
  },
);

comp.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/members/{memberId}/comp',
    tags: ['Comp access'],
    summary: 'Comp grants of a Member, revoked ones included',
    request: { params: memberParams },
    responses: {
      200: ok(CompGrantListSchema, 'Grants'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, memberId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const db = env(c).DB;
    await requireChannelMember(db, channelId, memberId);
    return c.json({ data: { items: await listGrants(db, channelId, memberId, true) } }, 200);
  },
);

comp.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/comp-grants',
    tags: ['Comp access'],
    summary: 'Comp grants of a Channel, newest first',
    description: 'Revoked grants only with includeRevoked=true. Filter by Member with memberId.',
    request: { params: channelParam, query: CompGrantListQuerySchema },
    responses: {
      200: ok(CompGrantListSchema, 'Grants'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { memberId, includeRevoked } = c.req.valid('query');
    await requireChannel(c, channelId, 'viewer');
    const items = await listGrants(
      env(c).DB,
      channelId,
      memberId ?? null,
      includeRevoked === 'true',
    );
    return c.json({ data: { items } }, 200);
  },
);

comp.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}/comp-grants/{grantId}',
    tags: ['Comp access'],
    summary: 'Revoke a comp grant',
    description:
      'Admin role. Ends the grant now (revoke reason "operator") and recomputes the Member’s entitlement. Audited. Revoking a revoked grant does nothing.',
    request: { params: grantParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { channelId, grantId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'admin');
    const db = env(c).DB;
    const grant = await first<GrantRow>(
      db,
      'SELECT * FROM comp_grants WHERE id = ?1 AND channel_id = ?2',
      grantId,
      channelId,
    );
    if (!grant) throw new ApiError('not_found', 'Comp grant not found.');
    if (grant.revoked_at !== null) return c.body(null, 204);
    const now = Date.now();
    await db.batch([
      db
        .prepare('UPDATE comp_grants SET revoked_at = ?1, revoked_by = ?2 WHERE id = ?3')
        .bind(now, access.auth.operatorId, grantId),
      db
        .prepare(
          `UPDATE member_subscriptions SET revoked_at = ?1, revoke_reason = 'operator', status = 'ended',
                  updated_at = ?1
            WHERE id = ?2 AND channel_id = ?3 AND source = 'comp'`,
        )
        .bind(now, grant.subscription_id, channelId),
    ]);
    await recomputeEntitlement(db, channelId, grant.member_id, now);
    await audit(c, access, 'member.comp_revoked', 'member', grant.member_id, { grantId });
    return c.body(null, 204);
  },
);
