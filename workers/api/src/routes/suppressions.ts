// Suppressions of a Channel: the workspace-wide ones and the Channel's own. Reads are viewer and
// up; adding and removing are admin and up, and workspace-wide changes need a workspace admin
// seat. Contract: docs/deliverability.md "Suppressions".
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, toIso } from '@swarm/db';
import {
  CreateSuppressionSchema,
  SUPPRESSIONS_PAGE_LIMIT,
  SuppressionListQuerySchema,
  SuppressionSchema,
  idPattern,
  type Suppression,
} from '@swarm/domain';
import {
  SuppressionError,
  addManualSuppression,
  removeSuppression,
  type SuppressionRow,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel, requireWorkspace } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { refreshCircles } from '../lib/circles';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';

export const suppressions = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const suppressionParam = z.object({
  channelId: z.string().regex(idPattern('channel')),
  suppressionId: z.string().regex(idPattern('suppression')),
});

function toSuppression(row: SuppressionRow): Suppression {
  return {
    id: row.id,
    email: row.email_hash ? null : row.email,
    scope: row.channel_id ? 'channel' : 'workspace',
    reason: row.reason,
    detail: row.email_hash ? null : row.detail,
    bounce: row.bounce_rule
      ? {
          rule: row.bounce_rule,
          cause: row.bounce_cause,
          counted: row.bounce_counted,
          days: row.bounce_days,
        }
      : null,
    removable: !row.email_hash && row.reason !== 'complaint',
    createdAt: toIso(row.created_at),
  };
}

/** A workspace-wide change reaches every Channel, so it needs a workspace admin seat. */
async function requireScope(c: AppContext, channelId: string, workspaceWide: boolean) {
  const access = await requireChannel(c, channelId, 'admin');
  if (!workspaceWide) return access;
  await requireWorkspace(c, access.workspaceId, 'admin');
  return access;
}

suppressions.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/suppressions',
    tags: ['Deliverability'],
    summary: 'Suppressions that apply to a Channel',
    description: `Workspace-wide suppressions and the Channel’s own, newest first, ${SUPPRESSIONS_PAGE_LIMIT} per page. Pass the last row’s createdAt as \`before\` for the next page.`,
    request: { params: channelParam, query: SuppressionListQuerySchema },
    responses: {
      200: ok(z.array(SuppressionSchema), 'Suppressions'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const query = c.req.valid('query');
    const access = await requireChannel(c, channelId, 'viewer');
    const rows = await all<SuppressionRow>(
      env(c).DB,
      `SELECT * FROM suppressions
        WHERE workspace_id = ?1 AND (channel_id IS NULL OR channel_id = ?2)
          AND (?3 IS NULL OR email = ?3) AND (?4 IS NULL OR created_at < ?4)
        ORDER BY created_at DESC, id DESC LIMIT ${SUPPRESSIONS_PAGE_LIMIT}`,
      access.workspaceId,
      channelId,
      query.email ?? null,
      query.before ? Date.parse(query.before) : null,
    );
    return c.json({ data: rows.map(toSuppression) }, 200);
  },
);

suppressions.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/suppressions',
    tags: ['Deliverability'],
    summary: 'Suppress an address',
    description:
      'Scope `channel` (the default) stops this Channel from mailing the address; `workspace` stops every Channel of the workspace and needs a workspace admin. Member statuses do not change. Idempotent: an address already suppressed in that scope returns the existing suppression with 200.',
    request: { params: channelParam, body: jsonBody(CreateSuppressionSchema) },
    responses: {
      200: ok(SuppressionSchema, 'Already suppressed'),
      201: ok(SuppressionSchema, 'Suppressed'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const workspaceWide = input.scope === 'workspace';
    const access = await requireScope(c, channelId, workspaceWide);
    const db = env(c).DB;
    const { row, created } = await addManualSuppression(db, {
      workspaceId: access.workspaceId,
      channelId: workspaceWide ? null : channelId,
      email: input.email,
      detail: input.note ?? null,
    });
    if (created) {
      await appendAudit(db, {
        workspaceId: access.workspaceId,
        actorId: access.auth.operatorId,
        action: 'suppression.created',
        targetType: 'suppression',
        targetId: row.id,
        metadata: { channelId, scope: input.scope },
        ipPrefix: ipPrefix(clientIp(c)),
      });
    }
    return c.json({ data: toSuppression(row) }, created ? 201 : 200);
  },
);

suppressions.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}/suppressions/{suppressionId}',
    tags: ['Deliverability'],
    summary: 'Remove a suppression',
    description:
      'Removes a manual or bounce suppression; a workspace-wide one needs a workspace admin. Complaints and erased addresses stay (409). Removing a hard bounce also removes the address from the SES account-level suppression list, whatever other workspaces hold. Removing a bounce gives the workspace’s Members of the address back the status they had before it (a paused one comes back active) and starts the address’s bounce counts again from zero.',
    request: { params: suppressionParam },
    responses: {
      204: noContent,
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, suppressionId } = c.req.valid('param');
    const viewer = await requireChannel(c, channelId, 'viewer');
    const db = env(c).DB;
    const row = await first<SuppressionRow>(
      db,
      `SELECT * FROM suppressions
        WHERE id = ?1 AND workspace_id = ?2 AND (channel_id IS NULL OR channel_id = ?3)`,
      suppressionId,
      viewer.workspaceId,
      channelId,
    );
    if (!row) throw new ApiError('not_found', 'Suppression not found.');
    const access = await requireScope(c, channelId, row.channel_id === null);
    let restored = 0;
    try {
      ({ restored } = await removeSuppression(db, row));
    } catch (error) {
      if (error instanceof SuppressionError) throw new ApiError(error.code, error.message);
      throw error;
    }
    await appendAudit(db, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'suppression.removed',
      targetType: 'suppression',
      targetId: row.id,
      metadata: {
        channelId,
        reason: row.reason,
        scope: row.channel_id ? 'channel' : 'workspace',
        ...(restored ? { restored } : {}),
      },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    if (restored) {
      const channels = await all<{ channel_id: string }>(
        db,
        `SELECT DISTINCT channel_id FROM members WHERE email = ?1
            AND channel_id IN (SELECT id FROM channels WHERE workspace_id = ?2) LIMIT 50`,
        row.email,
        access.workspaceId,
      );
      for (const channel of channels) refreshCircles(c, channel.channel_id);
    }
    return c.body(null, 204);
  },
);
