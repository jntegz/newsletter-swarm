// Saved views of the Member list: a name and a set of list filters (status, search, tag, Circle,
// columns), kept per Channel and shared with everyone on it. Anyone who can see the Channel's
// Members can use them; editors and up save, rename and delete them.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, isUniqueViolation, toIso } from '@swarm/db';
import {
  CreateMemberViewSchema,
  MAX_MEMBER_VIEWS,
  MemberViewFiltersSchema,
  MemberViewSchema,
  UpdateMemberViewSchema,
  idPattern,
  newId,
  type MemberView,
  type MemberViewFilters,
} from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, jsonBody, noContent, ok } from '../lib/openapi';

export const memberViews = createRouter();

const channelParam = z.object({
  channelId: z
    .string()
    .regex(idPattern('channel'))
    .openapi({ param: { name: 'channelId', in: 'path' } }),
});
const viewParam = channelParam.extend({
  viewId: z
    .string()
    .regex(idPattern('memberView'))
    .openapi({ param: { name: 'viewId', in: 'path' } }),
});

interface Row {
  id: string;
  channel_id: string;
  name: string;
  filters_json: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}
const COLUMNS = 'id, channel_id, name, filters_json, created_by, created_at, updated_at';

/** A stored view. Filters that no longer parse (an older shape) read as no filters. */
function toView(row: Row): MemberView {
  const parsed = MemberViewFiltersSchema.safeParse(JSON.parse(row.filters_json));
  return {
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    filters: parsed.success ? parsed.data : {},
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const duplicate = () =>
  new ApiError('conflict', 'A view with this name already exists.', [
    { path: 'name', message: 'A view with this name already exists.' },
  ]);

/** A view can only name a Circle of its own Channel. */
async function checkFilters(c: AppContext, channelId: string, filters: MemberViewFilters) {
  if (!filters.circleId) return;
  const circle = await first<{ id: string }>(
    env(c).DB,
    'SELECT id FROM circles WHERE id = ?1 AND channel_id = ?2 AND deleted_at IS NULL',
    filters.circleId,
    channelId,
  );
  if (!circle) {
    const message = 'That segment is not in this publication.';
    throw new ApiError('invalid_input', message, [{ path: 'filters.circleId', message }]);
  }
}

memberViews.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/members/views',
    tags: ['Members'],
    summary: 'Saved views of the Member list, by name',
    description: 'Shared by everyone on the Channel.',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(MemberViewSchema), 'Saved views'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const rows = await all<Row>(
      env(c).DB,
      `SELECT ${COLUMNS} FROM member_views WHERE channel_id = ?1 ORDER BY name LIMIT ?2`,
      channelId,
      MAX_MEMBER_VIEWS,
    );
    return c.json({ data: rows.map(toView) }, 200);
  },
);

memberViews.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/members/views',
    tags: ['Members'],
    summary: 'Save a view of the Member list',
    description: `Names must be unique in the Channel, ignoring case (409). A Channel keeps up to ${MAX_MEMBER_VIEWS} views (409).`,
    request: { params: channelParam, body: jsonBody(CreateMemberViewSchema) },
    responses: {
      201: ok(MemberViewSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { name, filters } = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    await checkFilters(c, channelId, filters);
    const db = env(c).DB;
    const count = await first<{ n: number }>(
      db,
      'SELECT count(*) AS n FROM member_views WHERE channel_id = ?1',
      channelId,
    );
    if ((count?.n ?? 0) >= MAX_MEMBER_VIEWS) {
      throw new ApiError(
        'conflict',
        `A publication keeps up to ${MAX_MEMBER_VIEWS} saved views. Delete one to save another.`,
      );
    }
    const now = Date.now();
    let row: Row | null;
    try {
      row = await first<Row>(
        db,
        `INSERT INTO member_views (id, channel_id, name, filters_json, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) RETURNING ${COLUMNS}`,
        newId('memberView', now),
        channelId,
        name,
        JSON.stringify(filters),
        access.auth.operatorId,
        now,
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicate();
      throw error;
    }
    await appendAudit(db, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'member_view.saved',
      targetType: 'member_view',
      targetId: row!.id,
      metadata: { channelId, name },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: toView(row!) }, 201);
  },
);

memberViews.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/channels/{channelId}/members/views/{viewId}',
    tags: ['Members'],
    summary: 'Rename a saved view, or change its filters',
    request: { params: viewParam, body: jsonBody(UpdateMemberViewSchema) },
    responses: {
      200: ok(MemberViewSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, viewId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    if (input.filters) await checkFilters(c, channelId, input.filters);
    const db = env(c).DB;
    const before = await first<Row>(
      db,
      `SELECT ${COLUMNS} FROM member_views WHERE id = ?1 AND channel_id = ?2`,
      viewId,
      channelId,
    );
    if (!before) throw new ApiError('not_found', 'View not found.');
    let row: Row | null;
    try {
      row = await first<Row>(
        db,
        `UPDATE member_views SET name = ?1, filters_json = ?2, updated_at = ?3
          WHERE id = ?4 AND channel_id = ?5 RETURNING ${COLUMNS}`,
        input.name ?? before.name,
        input.filters ? JSON.stringify(input.filters) : before.filters_json,
        Date.now(),
        viewId,
        channelId,
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicate();
      throw error;
    }
    if (!row) throw new ApiError('not_found', 'View not found.');
    await appendAudit(db, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action:
        input.name && input.name !== before.name ? 'member_view.renamed' : 'member_view.changed',
      targetType: 'member_view',
      targetId: viewId,
      metadata: { channelId, from: before.name, to: row.name },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: toView(row) }, 200);
  },
);

memberViews.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}/members/views/{viewId}',
    tags: ['Members'],
    summary: 'Delete a saved view',
    description: 'For everyone on the Channel. The Members it showed are not touched.',
    request: { params: viewParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { channelId, viewId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'editor');
    const db = env(c).DB;
    const row = await first<{ name: string }>(
      db,
      'DELETE FROM member_views WHERE id = ?1 AND channel_id = ?2 RETURNING name',
      viewId,
      channelId,
    );
    if (!row) throw new ApiError('not_found', 'View not found.');
    await appendAudit(db, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'member_view.deleted',
      targetType: 'member_view',
      targetId: viewId,
      metadata: { channelId, name: row.name },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.body(null, 204);
  },
);
