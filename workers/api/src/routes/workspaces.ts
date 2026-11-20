import { createRoute, z } from '@hono/zod-openapi';
import {
  all,
  batch,
  first,
  isUniqueViolation,
  roleAtLeast,
  run,
  toIso,
  verifyAuditChainStep,
} from '@swarm/db';
import {
  AUDIT_EXPORT_MAX_ROWS,
  AcceptInviteSchema,
  AuditEventSchema,
  AuditExportSchema,
  AuditVerificationSchema,
  CHAIN_VERIFY_MAX,
  ChainVerifyQuerySchema,
  CreateInviteSchema,
  CursorQuerySchema,
  InviteSchema,
  SeatAccessSchema,
  SeatSchema,
  UpdateSeatSchema,
  UpdateWorkspaceSchema,
  WorkspaceSchema,
  idPattern,
  newId,
  page,
  type SeatRole,
} from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import { requireAuth, requireWorkspace } from '../lib/access';
import { appendAudit, publicAuditEvent, readAuditEvents } from '../lib/audit';
import { verifyChainPage } from '../lib/chain-verify';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix, randomToken, sha256Hex } from '../lib/crypto';
import { isInstanceAdmin } from '../lib/instance';
import { inviteMail, mailer } from '../lib/mail';
import {
  toInvite,
  toOperator,
  toWorkspace,
  type InviteRow,
  type OperatorRow,
  type WorkspaceRow,
} from '../lib/mappers';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { seatRoleChangedMail } from '../lib/security-mail';
import { rotateSessionsForRoleChange } from '../lib/session';
import { noticeTeam } from '../lib/team-notice';
import { revokeGrantStatements } from '../v2/oauth';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const workspaces = createRouter();

const workspaceParam = idParam('workspaceId', idPattern('workspace'));
const seatParams = workspaceParam.extend(idParam('seatId', idPattern('seat')).shape);
const inviteParams = workspaceParam.extend(idParam('inviteId', idPattern('invite')).shape);

workspaces.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces',
    tags: ['Workspaces'],
    summary: 'Workspaces you have a seat in',
    responses: { 200: ok(z.array(WorkspaceSchema), 'Workspaces'), ...errors('unauthorized') },
  }),
  async (c) => {
    const auth = requireAuth(c);
    const rows = await all<WorkspaceRow>(
      env(c).DB,
      `SELECT w.id, w.name, w.plan, s.role, w.created_at FROM seats s
         JOIN workspaces w ON w.id = s.workspace_id WHERE s.operator_id = ?1 ORDER BY w.created_at`,
      auth.operatorId,
    );
    return c.json({ data: rows.map(toWorkspace) }, 200);
  },
);

workspaces.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/workspaces/{workspaceId}',
    tags: ['Workspaces'],
    summary: 'Rename a workspace',
    request: { params: workspaceParam, body: jsonBody(UpdateWorkspaceSchema) },
    responses: {
      200: ok(WorkspaceSchema, 'Updated'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const { auth, role } = await requireWorkspace(c, workspaceId, 'admin');
    const { name } = c.req.valid('json');
    const e = env(c);
    const row = await first<Omit<WorkspaceRow, 'role'>>(
      e.DB,
      'UPDATE workspaces SET name = ?1, updated_at = ?2 WHERE id = ?3 RETURNING id, name, plan, created_at',
      name,
      Date.now(),
      workspaceId,
    );
    await appendAudit(e.DB, {
      workspaceId,
      actorId: auth.operatorId,
      action: 'workspace.renamed',
      targetType: 'workspace',
      targetId: workspaceId,
      metadata: { name },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: toWorkspace({ ...(row as Omit<WorkspaceRow, 'role'>), role }) }, 200);
  },
);

workspaces.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/seats',
    tags: ['Team'],
    summary: 'Teammates and their roles',
    request: { params: workspaceParam },
    responses: { 200: ok(z.array(SeatSchema), 'Seats'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await requireWorkspace(c, workspaceId, 'viewer');
    const rows = await all<
      OperatorRow & { seat_id: string; role: SeatRole; seat_created_at: number }
    >(
      env(c).DB,
      `SELECT s.id AS seat_id, s.role, s.created_at AS seat_created_at, o.id, o.email, o.name, o.created_at
         FROM seats s JOIN operators o ON o.id = s.operator_id
        WHERE s.workspace_id = ?1 ORDER BY s.created_at`,
      workspaceId,
    );
    return c.json(
      {
        data: rows.map((row) => ({
          id: row.seat_id,
          operator: toOperator(row),
          role: row.role,
          createdAt: toIso(row.seat_created_at),
        })),
      },
      200,
    );
  },
);

async function ownerCount(db: D1Database, workspaceId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM seats WHERE workspace_id = ?1 AND role = 'owner'",
    workspaceId,
  );
  return row?.n ?? 0;
}

/** How many times a day a seat's role may change before raising it is refused. Owner-tunable. */
const SEAT_ROLE_CHANGES_PER_DAY = 4;
const DAY_MS = 86_400_000;
const ROLE_RANK: Record<SeatRole, number> = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 };

/**
 * An admin's authority here ended (demoted below admin, or removed). Invites they sent and that
 * are still pending are withdrawn, and the remaining owners and admins are told which API keys
 * and feeds stood on that authority: those are now suspended until an admin adopts them (changes
 * the key, confirms the feed) or removes them (docs/security.md "Standing feeds").
 */
async function authorityEnded(
  c: AppContext,
  workspaceId: string,
  operatorId: string,
  actorId: string,
  how: 'demoted' | 'removed',
): Promise<void> {
  const e = env(c);
  const now = Date.now();
  const invites = await all<{ id: string; email: string }>(
    e.DB,
    `UPDATE invites SET revoked_at = ?1
      WHERE workspace_id = ?2 AND invited_by = ?3 AND accepted_at IS NULL AND revoked_at IS NULL
     RETURNING id, email`,
    now,
    workspaceId,
    operatorId,
  );
  for (const invite of invites) {
    await appendAudit(e.DB, {
      workspaceId,
      actorId,
      action: 'invite.revoked',
      targetType: 'invite',
      targetId: invite.id,
      metadata: { email: invite.email, reason: `inviter_${how}` },
      ipPrefix: ipPrefix(clientIp(c)),
    });
  }
  const standing = await first<{ keys: number; endpoints: number; destinations: number }>(
    e.DB,
    `SELECT
       (SELECT COUNT(*) FROM api_keys WHERE workspace_id = ?1 AND created_by = ?2
          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?3)) AS keys,
       (SELECT COUNT(*) FROM webhook_endpoints WHERE workspace_id = ?1 AND confirmed_by = ?2) AS endpoints,
       (SELECT COUNT(*) FROM export_destinations WHERE workspace_id = ?1 AND confirmed_by = ?2) AS destinations`,
    workspaceId,
    operatorId,
    now,
  );
  const parts = [
    standing?.keys ? `${standing.keys} API key${standing.keys === 1 ? '' : 's'}` : null,
    standing?.endpoints
      ? `${standing.endpoints} webhook endpoint${standing.endpoints === 1 ? '' : 's'}`
      : null,
    standing?.destinations
      ? `${standing.destinations} export destination${standing.destinations === 1 ? '' : 's'}`
      : null,
  ].filter((part): part is string => part !== null);
  if (!parts.length) return;
  const who = await first<{ email: string }>(
    e.DB,
    'SELECT email FROM operators WHERE id = ?1',
    operatorId,
  );
  await noticeTeam(
    e,
    c.get('log'),
    workspaceId,
    ['owner', 'admin'],
    {
      category: 'standing_feed_suspended',
      subject: 'API keys and feeds need an admin',
      heading: 'Suspended until an admin decides',
      lines: [
        `${who?.email ?? 'A teammate'} ${how === 'demoted' ? 'no longer has the admin role' : 'was removed from the workspace'}. What they stood behind is suspended: ${parts.join(', ')}.`,
        'Keep each one by changing the key or confirming the feed (you then stand behind it), or remove it. Until then it sends nothing and the keys are refused.',
      ],
      path: '/settings/developers',
      label: 'Review keys and feeds',
    },
    actorId,
  );
}

workspaces.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/workspaces/{workspaceId}/seats/{seatId}',
    tags: ['Team'],
    summary: "Change a teammate's role",
    description: `Admins manage the editor, author and viewer roles. Only owners grant or take away the admin role (as with invites and SSO seats) and ownership, and a workspace always keeps one owner. A raise is refused (429) once a seat has changed role ${SEAT_ROLE_CHANGES_PER_DAY} times in a day; lowering a role is never held back. The teammate is emailed, and a demotion below admin suspends the API keys and feeds they stand behind and withdraws invites they sent.`,
    request: { params: seatParams, body: jsonBody(UpdateSeatSchema) },
    responses: {
      200: ok(SeatSchema, 'Updated'),
      ...errors(
        'invalid_input',
        'unauthorized',
        'forbidden',
        'not_found',
        'conflict',
        'rate_limited',
      ),
    },
  }),
  async (c) => {
    const { workspaceId, seatId } = c.req.valid('param');
    const { auth, role: actorRole } = await requireWorkspace(c, workspaceId, 'admin');
    const { role } = c.req.valid('json');
    const e = env(c);
    const seat = await first<{ role: SeatRole; operator_id: string }>(
      e.DB,
      'SELECT role, operator_id FROM seats WHERE id = ?1 AND workspace_id = ?2',
      seatId,
      workspaceId,
    );
    if (!seat) throw new ApiError('not_found', 'Teammate not found.');
    if ((seat.role === 'owner' || role === 'owner') && actorRole !== 'owner') {
      throw new ApiError('forbidden', 'Only an owner can change ownership.');
    }
    // One rule on every path (invites, SSO seats, this route): owners decide who is an admin.
    // An admin may still step themselves down.
    const grantsAdmin = role === 'admin' && seat.role !== 'admin';
    const changesAnAdmin = seat.role === 'admin' && seat.operator_id !== auth.operatorId;
    if ((grantsAdmin || changesAnAdmin) && actorRole !== 'owner') {
      throw new ApiError('forbidden', 'Only an owner can give or take away the admin role.');
    }
    if (seat.role !== role && ROLE_RANK[role] > ROLE_RANK[seat.role]) {
      // Each change signs the teammate out everywhere, in every workspace: raises are bounded so
      // repeated changes can't keep someone signed out. Lowering a role is never held back.
      const recent = await first<{ n: number }>(
        e.DB,
        `SELECT COUNT(*) AS n FROM audit_events
          WHERE workspace_id = ?1 AND action = 'seat.role_changed' AND target_id = ?2
            AND created_at > ?3`,
        workspaceId,
        seatId,
        Date.now() - DAY_MS,
      );
      if ((recent?.n ?? 0) >= SEAT_ROLE_CHANGES_PER_DAY) {
        throw new ApiError(
          'rate_limited',
          `This teammate's role changed ${SEAT_ROLE_CHANGES_PER_DAY} times today. Try again tomorrow.`,
        );
      }
    }
    if (seat.role === 'owner' && role !== 'owner' && (await ownerCount(e.DB, workspaceId)) <= 1) {
      throw new ApiError('conflict', 'A workspace needs at least one owner.');
    }
    await run(
      e.DB,
      'UPDATE seats SET role = ?1, updated_at = ?2 WHERE id = ?3',
      role,
      Date.now(),
      seatId,
    );
    // Roles are read on every request, so the change applies at once; rotating the teammate's
    // sessions also leaves nothing for a token taken before it.
    const sessionsEnded =
      seat.role === role ? 0 : await rotateSessionsForRoleChange(c, seat.operator_id, auth);
    await appendAudit(e.DB, {
      workspaceId,
      actorId: auth.operatorId,
      action: 'seat.role_changed',
      targetType: 'seat',
      targetId: seatId,
      metadata: { from: seat.role, to: role, sessionsEnded },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    const operator = await first<OperatorRow>(
      e.DB,
      'SELECT id, email, name, created_at FROM operators WHERE id = ?1',
      seat.operator_id,
    );
    // The teammate hears about every change someone else makes, naming the workspace: it also
    // signed them out everywhere. An instance admin is reminded what a tenant's role does not
    // give them.
    if (seat.role !== role && seat.operator_id !== auth.operatorId && operator) {
      const workspace = await first<{ name: string }>(
        e.DB,
        'SELECT name FROM workspaces WHERE id = ?1',
        workspaceId,
      );
      try {
        await mailer(e).send(
          seatRoleChangedMail(e, operator.email, {
            workspaceName: workspace?.name ?? 'a workspace',
            from: seat.role,
            to: role,
            by: auth.email,
            at: Date.now(),
            instanceAdmin: await isInstanceAdmin(e, seat.operator_id),
          }),
        );
      } catch (error) {
        // A mail outage must not undo the change; it is in the workspace's audit log.
        c.get('log').warn('seat role mail failed', { error: (error as Error).message });
      }
    }
    if (roleAtLeast(seat.role, 'admin') && !roleAtLeast(role, 'admin')) {
      await authorityEnded(c, workspaceId, seat.operator_id, auth.operatorId, 'demoted');
    }
    const created = await first<{ created_at: number }>(
      e.DB,
      'SELECT created_at FROM seats WHERE id = ?1',
      seatId,
    );
    return c.json(
      {
        data: {
          id: seatId,
          operator: toOperator(operator as OperatorRow),
          role,
          createdAt: toIso(created?.created_at ?? Date.now()),
        },
      },
      200,
    );
  },
);

/**
 * The access a teammate holds in a workspace beyond their seat: API keys they created that are
 * not revoked, and apps they authorised (OAuth grants) that are not revoked. Removing the seat
 * revokes all of them, so nothing they set up keeps working after they leave.
 */
async function accessOf(db: D1Database, workspaceId: string, operatorId: string, now: number) {
  const keys = await all<{ id: string; expires_at: number | null }>(
    db,
    `SELECT id, expires_at FROM api_keys
      WHERE workspace_id = ?1 AND created_by = ?2 AND revoked_at IS NULL`,
    workspaceId,
    operatorId,
  );
  const grants = await all<{ id: string; app_id: string }>(
    db,
    `SELECT g.id, g.app_id FROM oauth_grants g JOIN oauth_apps a ON a.id = g.app_id
      WHERE g.workspace_id = ?1 AND g.operator_id = ?2 AND g.revoked_at IS NULL
        AND a.revoked_at IS NULL`,
    workspaceId,
    operatorId,
  );
  return {
    keys,
    grants,
    /** What still works today, for the confirmation ("This also revokes 2 API keys…"). */
    counts: {
      apiKeys: keys.filter((k) => k.expires_at === null || k.expires_at > now).length,
      apps: grants.length,
    },
  };
}

/** Who may see or remove a seat: its own teammate, or an admin (an owner for an owner's seat). */
async function removableSeat(
  c: Parameters<typeof requireWorkspace>[0],
  workspaceId: string,
  seatId: string,
) {
  const { auth, role: actorRole } = await requireWorkspace(c, workspaceId, 'viewer');
  const seat = await first<{ role: SeatRole; operator_id: string }>(
    env(c).DB,
    'SELECT role, operator_id FROM seats WHERE id = ?1 AND workspace_id = ?2',
    seatId,
    workspaceId,
  );
  if (!seat) throw new ApiError('not_found', 'Teammate not found.');
  const leaving = seat.operator_id === auth.operatorId;
  if (!leaving && !roleAtLeast(actorRole, 'admin')) {
    throw new ApiError('forbidden', 'This needs the admin role or higher.');
  }
  if (!leaving && seat.role === 'owner' && actorRole !== 'owner') {
    throw new ApiError('forbidden', 'Only an owner can remove an owner.');
  }
  // Owners decide who is an admin, so only an owner removes one (an admin may leave).
  if (!leaving && seat.role === 'admin' && actorRole !== 'owner') {
    throw new ApiError('forbidden', 'Only an owner can remove an admin.');
  }
  return { auth, seat, leaving };
}

workspaces.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/seats/{seatId}/access',
    tags: ['Team'],
    summary: 'What removing a teammate also revokes',
    description:
      'Counts the API keys the teammate created in this workspace and the apps they authorised for it that still work. Removing the seat revokes them. Their own seat, or admin (owner for an owner).',
    request: { params: seatParams },
    responses: {
      200: ok(SeatAccessSchema, 'Access'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, seatId } = c.req.valid('param');
    const { seat } = await removableSeat(c, workspaceId, seatId);
    const access = await accessOf(env(c).DB, workspaceId, seat.operator_id, Date.now());
    return c.json({ data: access.counts }, 200);
  },
);

workspaces.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/workspaces/{workspaceId}/seats/{seatId}',
    tags: ['Team'],
    summary: 'Remove a teammate, or leave the workspace',
    description:
      'Also revokes the API keys the teammate created in this workspace and the apps they authorised for it, each with its own audit entry.',
    request: { params: seatParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found', 'conflict') },
  }),
  async (c) => {
    const { workspaceId, seatId } = c.req.valid('param');
    const { auth, seat, leaving } = await removableSeat(c, workspaceId, seatId);
    const e = env(c);
    if (seat.role === 'owner' && (await ownerCount(e.DB, workspaceId)) <= 1) {
      throw new ApiError('conflict', 'A workspace needs at least one owner.');
    }
    const now = Date.now();
    const access = await accessOf(e.DB, workspaceId, seat.operator_id, now);
    await batch(e.DB, [
      e.DB.prepare('DELETE FROM seats WHERE id = ?1').bind(seatId),
      e.DB.prepare(
        'DELETE FROM channel_roles WHERE operator_id = ?1 AND channel_id IN (SELECT id FROM channels WHERE workspace_id = ?2)',
      ).bind(seat.operator_id, workspaceId),
      // What they set up stops with them: their keys here, and the apps they let in here.
      e.DB.prepare(
        `UPDATE api_keys SET revoked_at = ?1
          WHERE workspace_id = ?2 AND created_by = ?3 AND revoked_at IS NULL`,
      ).bind(now, workspaceId, seat.operator_id),
      ...access.grants.flatMap((grant) => revokeGrantStatements(e.DB, grant.id, now)),
    ]);
    const ip = ipPrefix(clientIp(c));
    await appendAudit(e.DB, {
      workspaceId,
      actorId: auth.operatorId,
      action: leaving ? 'seat.left' : 'seat.removed',
      targetType: 'seat',
      targetId: seatId,
      metadata: { apiKeysRevoked: access.keys.length, appsRevoked: access.grants.length },
      ipPrefix: ip,
    });
    for (const key of access.keys) {
      await appendAudit(e.DB, {
        workspaceId,
        actorId: auth.operatorId,
        action: 'api_key.revoked',
        targetType: 'api_key',
        targetId: key.id,
        metadata: { reason: 'seat_removed', seatId },
        ipPrefix: ip,
      });
    }
    for (const grant of access.grants) {
      await appendAudit(e.DB, {
        workspaceId,
        actorId: auth.operatorId,
        action: 'oauth_grant.revoked',
        targetType: 'oauth_grant',
        targetId: grant.id,
        metadata: { appId: grant.app_id, reason: 'seat_removed', seatId },
        ipPrefix: ip,
      });
    }
    if (roleAtLeast(seat.role, 'admin')) {
      await authorityEnded(c, workspaceId, seat.operator_id, auth.operatorId, 'removed');
    }
    return c.body(null, 204);
  },
);

workspaces.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/invites',
    tags: ['Team'],
    summary: 'Invites sent from this workspace',
    request: { params: workspaceParam },
    responses: {
      200: ok(z.array(InviteSchema), 'Invites'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await requireWorkspace(c, workspaceId, 'admin');
    const rows = await all<InviteRow>(
      env(c).DB,
      `SELECT id, email, role, created_at, expires_at, accepted_at, revoked_at FROM invites
        WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT 100`,
      workspaceId,
    );
    return c.json({ data: rows.map((row) => toInvite(row)) }, 200);
  },
);

workspaces.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/invites',
    tags: ['Team'],
    summary: 'Invite a teammate by email',
    request: { params: workspaceParam, body: jsonBody(CreateInviteSchema) },
    responses: {
      201: ok(InviteSchema, 'Invite sent'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const { auth, role: actorRole } = await requireWorkspace(c, workspaceId, 'admin');
    const { email, role } = c.req.valid('json');
    if (role === 'admin' && actorRole !== 'owner') {
      throw new ApiError('forbidden', 'Only an owner can invite admins.');
    }
    const e = env(c);
    const seated = await first(
      e.DB,
      'SELECT 1 FROM seats s JOIN operators o ON o.id = s.operator_id WHERE s.workspace_id = ?1 AND o.email = ?2',
      workspaceId,
      email,
    );
    if (seated) throw new ApiError('conflict', 'That person is already on the team.');

    const token = randomToken(32);
    const now = Date.now();
    const id = newId('invite');
    await batch(e.DB, [
      // A new invite to the same address replaces any pending one.
      e.DB.prepare(
        'UPDATE invites SET revoked_at = ?1 WHERE workspace_id = ?2 AND email = ?3 AND accepted_at IS NULL AND revoked_at IS NULL',
      ).bind(now, workspaceId, email),
      e.DB.prepare(
        `INSERT INTO invites (id, workspace_id, email, role, token_hash, invited_by, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(
        id,
        workspaceId,
        email,
        role,
        await sha256Hex(token),
        auth.operatorId,
        now,
        now + INVITE_TTL_MS,
      ),
    ]);

    const workspace = await first<{ name: string }>(
      e.DB,
      'SELECT name FROM workspaces WHERE id = ?1',
      workspaceId,
    );
    const link = new URL('/invite', e.APP_ORIGIN);
    link.hash = `token=${token}`;
    await mailer(e).send(
      inviteMail(e, email, link.toString(), workspace?.name ?? 'a workspace', auth.email, role),
    );
    await appendAudit(e.DB, {
      workspaceId,
      actorId: auth.operatorId,
      action: 'invite.sent',
      targetType: 'invite',
      targetId: id,
      // The audit chain is kept for years and can't be rewritten: the invite id and the address's
      // domain identify it, not the address (privacy: the invitee may never accept).
      metadata: { role, domain: email.slice(email.lastIndexOf('@') + 1) },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json(
      {
        data: toInvite({
          id,
          email,
          role,
          created_at: now,
          expires_at: now + INVITE_TTL_MS,
          accepted_at: null,
          revoked_at: null,
        }),
      },
      201,
    );
  },
);

workspaces.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/workspaces/{workspaceId}/invites/{inviteId}',
    tags: ['Team'],
    summary: 'Withdraw an invite',
    request: { params: inviteParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { workspaceId, inviteId } = c.req.valid('param');
    const { auth } = await requireWorkspace(c, workspaceId, 'admin');
    const e = env(c);
    const revoked = await first(
      e.DB,
      `UPDATE invites SET revoked_at = ?1 WHERE id = ?2 AND workspace_id = ?3
         AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`,
      Date.now(),
      inviteId,
      workspaceId,
    );
    if (!revoked) throw new ApiError('not_found', 'Invite not found.');
    await appendAudit(e.DB, {
      workspaceId,
      actorId: auth.operatorId,
      action: 'invite.revoked',
      targetType: 'invite',
      targetId: inviteId,
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.body(null, 204);
  },
);

workspaces.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/invites/accept',
    tags: ['Team'],
    summary: 'Accept an invite as the signed-in operator',
    description: 'The invite only works for the email address it was sent to.',
    request: { body: jsonBody(AcceptInviteSchema) },
    responses: {
      200: ok(WorkspaceSchema, 'Joined'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const auth = requireAuth(c);
    const { token } = c.req.valid('json');
    const e = env(c);
    const now = Date.now();
    const invite = await first<{
      id: string;
      workspace_id: string;
      email: string;
      role: SeatRole;
      inviter_role: SeatRole | null;
    }>(
      e.DB,
      `SELECT i.id, i.workspace_id, i.email, i.role,
              (SELECT s.role FROM seats s WHERE s.workspace_id = i.workspace_id
                  AND s.operator_id = i.invited_by) AS inviter_role
         FROM invites i
        WHERE i.token_hash = ?1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
          AND i.expires_at > ?2`,
      await sha256Hex(token),
      now,
    );
    if (!invite) throw new ApiError('not_found', 'This invite has expired or was withdrawn.');
    // An invite stands only while whoever sent it could still send it.
    const inviterMay =
      invite.inviter_role !== null &&
      roleAtLeast(invite.inviter_role, invite.role === 'admin' ? 'owner' : 'admin');
    if (!inviterMay) {
      throw new ApiError(
        'not_found',
        'This invite is no longer valid: whoever sent it can no longer invite. Ask an admin to send a new one.',
      );
    }
    if (invite.email.toLowerCase() !== auth.email.toLowerCase()) {
      throw new ApiError(
        'forbidden',
        `This invite is for ${invite.email}. Sign in with that address to accept it.`,
      );
    }
    try {
      await batch(e.DB, [
        e.DB.prepare(
          'UPDATE invites SET accepted_at = ?1 WHERE id = ?2 AND accepted_at IS NULL',
        ).bind(now, invite.id),
        e.DB.prepare(
          'INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)',
        ).bind(newId('seat'), invite.workspace_id, auth.operatorId, invite.role, now),
      ]);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Already a member: the invite is spent either way.
      await run(e.DB, 'UPDATE invites SET accepted_at = ?1 WHERE id = ?2', now, invite.id);
    }
    await appendAudit(e.DB, {
      workspaceId: invite.workspace_id,
      actorId: auth.operatorId,
      action: 'invite.accepted',
      targetType: 'invite',
      targetId: invite.id,
      metadata: { role: invite.role },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    const row = await first<WorkspaceRow>(
      e.DB,
      `SELECT w.id, w.name, w.plan, s.role, w.created_at FROM workspaces w
         JOIN seats s ON s.workspace_id = w.id AND s.operator_id = ?2 WHERE w.id = ?1`,
      invite.workspace_id,
      auth.operatorId,
    );
    return c.json({ data: toWorkspace(row as WorkspaceRow) }, 200);
  },
);

workspaces.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/audit',
    tags: ['Audit'],
    summary: 'Audit log, newest first',
    request: { params: workspaceParam, query: CursorQuerySchema },
    responses: {
      200: ok(page(AuditEventSchema), 'Events'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await requireWorkspace(c, workspaceId, 'admin');
    const { cursor, limit } = c.req.valid('query');
    const before = cursor ? Number.parseInt(cursor, 10) : Number.MAX_SAFE_INTEGER;
    if (!Number.isFinite(before)) throw new ApiError('invalid_input', 'Invalid cursor.');
    const rows = await readAuditEvents(env(c).DB, workspaceId, {
      beforeSeq: before,
      limit: limit + 1,
    });
    const items = rows.slice(0, limit).map(publicAuditEvent);
    const nextCursor = rows.length > limit ? String(items[items.length - 1]?.seq ?? '') : null;
    return c.json({ data: { items, nextCursor } }, 200);
  },
);

workspaces.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/audit/verify',
    tags: ['Audit'],
    summary: 'Check the audit log has not been altered',
    description: `Checks up to \`limit\` events per request (at most ${CHAIN_VERIFY_MAX.toLocaleString('en-US')}), oldest first. While \`complete\` is false, \`ok\` covers only the events checked so far: pass \`nextCursor\` as \`cursor\` to go on.`,
    request: { params: workspaceParam, query: ChainVerifyQuerySchema },
    responses: {
      200: ok(AuditVerificationSchema, 'Verification result'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await requireWorkspace(c, workspaceId, 'admin');
    const result = await verifyChainPage(
      env(c).DB,
      env(c).AUTH_KEYS,
      workspaceId,
      'audit_events',
      verifyAuditChainStep,
      c.req.valid('query'),
    );
    return c.json({ data: result }, 200);
  },
);

// ---- Audit export (Phase 7) --------------------------------------------------------------------

/** A cell that a spreadsheet would run as a formula is prefixed with an apostrophe. */
const csvCell = (value: string | number | null) => {
  let text = value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const AUDIT_CSV_COLUMNS = [
  'seq',
  'id',
  'created_at',
  'action',
  'actor_id',
  'actor_email',
  'target_type',
  'target_id',
  'ip_prefix',
  'metadata',
  'prev_hash',
  'hash',
];

workspaces.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/audit/export',
    tags: ['Audit'],
    summary: 'Download the audit log as CSV or JSONL',
    description: `Oldest first, with each event's prev_hash and hash so the copy can be verified outside Swarm (sha256 of the previous hash, a newline and the canonical event). Up to ${AUDIT_EXPORT_MAX_ROWS.toLocaleString('en-US')} events; narrow the time range for more. The export is itself audited.`,
    request: { params: workspaceParam, body: jsonBody(AuditExportSchema) },
    responses: {
      200: {
        description: 'The file',
        content: {
          'text/csv': { schema: z.string() },
          'application/x-ndjson': { schema: z.string() },
        },
      },
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const { format, from, to } = c.req.valid('json');
    const { auth } = await requireWorkspace(c, workspaceId, 'admin');
    const e = env(c);
    const range = {
      ...(from ? { from: Date.parse(from) } : {}),
      ...(to ? { to: Date.parse(to) } : {}),
    };
    const events = [];
    let before: number | undefined;
    while (events.length < AUDIT_EXPORT_MAX_ROWS) {
      const page = await readAuditEvents(e.DB, workspaceId, {
        ...range,
        ...(before === undefined ? {} : { beforeSeq: before }),
        limit: Math.min(1000, AUDIT_EXPORT_MAX_ROWS - events.length),
      });
      events.push(...page);
      if (page.length < 1000) break;
      before = page.at(-1)?.seq;
    }
    events.reverse();
    await appendAudit(e.DB, {
      workspaceId,
      actorId: auth.operatorId,
      action: 'audit.exported',
      metadata: { format, events: events.length, from: from ?? null, to: to ?? null },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const headers = {
      'content-disposition': `attachment; filename="audit-${stamp}.${format}"`,
      'cache-control': 'no-store',
    };
    if (format === 'jsonl') {
      const body = events.map((event) => JSON.stringify(event)).join('\n');
      return c.body(events.length ? `${body}\n` : '', 200, {
        ...headers,
        'content-type': 'application/x-ndjson; charset=utf-8',
      });
    }
    const lines = [AUDIT_CSV_COLUMNS.join(',')];
    for (const event of events) {
      lines.push(
        [
          event.seq,
          event.id,
          event.createdAt,
          event.action,
          event.actor?.id ?? null,
          event.actor?.email ?? null,
          event.targetType,
          event.targetId,
          event.ipPrefix,
          JSON.stringify(event.metadata),
          event.prevHash,
          event.hash,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return c.body(`${lines.join('\r\n')}\r\n`, 200, {
      ...headers,
      'content-type': 'text/csv; charset=utf-8',
    });
  },
);
