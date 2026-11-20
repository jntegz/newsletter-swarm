// Circles: rule CRUD, live preview, refresh and members. Rules compile to parameterised SQL in
// @swarm/engine; the jobs worker materialises membership into circle_members.
import { createRoute } from '@hono/zod-openapi';
import { all, first, toIso } from '@swarm/db';
import {
  CirclePreviewRequestSchema,
  CirclePreviewSchema,
  CircleListItemSchema,
  CircleSchema,
  CreateCircleSchema,
  CursorQuerySchema,
  MemberSchema,
  UpdateCircleSchema,
  idPattern,
  newId,
  page,
  type Circle,
  type CircleRule,
  type SeatRole,
} from '@swarm/domain';
import {
  CIRCLE_STUCK_AFTER_MS,
  CircleRuleError,
  checkCircleRuleRefs,
  compileCircle,
  type CompiledCircle,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { circlePreviewQueries } from '../lib/circle-preview';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { MEMBER_COLUMNS, toMember, type MemberRow } from '../lib/send';

export const circles = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const circleParam = idParam('circleId', idPattern('circle'));

export interface CircleRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  name: string;
  description: string | null;
  rule_json: string;
  member_count: number;
  generation: number;
  status: Circle['status'];
  evaluated_at: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export const toCircle = (row: CircleRow): Circle => ({
  id: row.id,
  channelId: row.channel_id,
  name: row.name,
  description: row.description,
  rule: JSON.parse(row.rule_json) as CircleRule,
  memberCount: row.member_count,
  status: row.status,
  evaluatedAt: row.evaluated_at === null ? null : toIso(row.evaluated_at),
  error: row.error,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

/** A Circle the operator can reach with `minimum`; 404 for anything else, as with every row. */
async function requireCircle(c: AppContext, circleId: string, minimum: SeatRole) {
  const row = await first<CircleRow>(
    env(c).DB,
    'SELECT * FROM circles WHERE id = ?1 AND deleted_at IS NULL',
    circleId,
  );
  const notFound = new ApiError('not_found', 'Segment not found.');
  if (!row) throw notFound;
  try {
    return { row, access: await requireChannel(c, row.channel_id, minimum) };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not_found') throw notFound;
    throw error;
  }
}

/** Compiles a rule for the Channel; a rule that doesn't fit answers 400 with where it failed. */
export async function compile(
  c: AppContext,
  rule: unknown,
  channelId: string,
): Promise<CompiledCircle> {
  try {
    const compiled = await compileCircle(env(c).DB, rule, channelId);
    // Compiled alone, a level from another Channel would quietly match nobody.
    await checkCircleRuleRefs(env(c).DB, channelId, rule as CircleRule);
    return compiled;
  } catch (error) {
    if (error instanceof CircleRuleError) {
      const path = error.path ? `rule.${error.path}` : 'rule';
      throw new ApiError('invalid_input', error.message, [{ path, message: error.message }]);
    }
    throw error;
  }
}

async function enqueueRefresh(c: AppContext, circleId: string, generation: number) {
  await env(c).JOBS_QUEUE.send({ type: 'circle_refresh', circleId, generation });
}

circles.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/circles',
    tags: ['Circles'],
    summary: 'Circles in a Channel, newest first',
    description:
      '`memberCount` counts every status at the last evaluation; `activeCount` is how many of those Members are active now.',
    request: { params: channelParam, query: CursorQuerySchema },
    responses: {
      200: ok(page(CircleListItemSchema), 'Circles'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { cursor, limit } = c.req.valid('query');
    await requireChannel(c, channelId, 'viewer');
    if (cursor && !idPattern('circle').test(cursor)) {
      throw new ApiError('invalid_input', 'That page cursor is not valid.');
    }
    const rows = await all<CircleRow & { active_count: number }>(
      env(c).DB,
      `SELECT ci.*,
              (SELECT count(*) FROM circle_members cm JOIN members m ON m.id = cm.member_id
                WHERE cm.circle_id = ci.id AND m.status = 'active') AS active_count
         FROM circles ci
        WHERE ci.channel_id = ?1 AND ci.deleted_at IS NULL AND (?2 IS NULL OR ci.id < ?2)
        ORDER BY ci.id DESC LIMIT ?3`,
      channelId,
      cursor ?? null,
      limit + 1,
    );
    const items = rows
      .slice(0, limit)
      .map((row) => ({ ...toCircle(row), activeCount: row.active_count }));
    const nextCursor = rows.length > limit ? (items.at(-1)?.id ?? null) : null;
    return c.json({ data: { items, nextCursor } }, 200);
  },
);

circles.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/circles',
    tags: ['Circles'],
    summary: 'Create a Circle',
    description:
      'The Circle starts pending; the jobs worker evaluates it and fills in its Members. There is no limit on the number of Circles.',
    request: { params: channelParam, body: jsonBody(CreateCircleSchema) },
    responses: {
      201: ok(CircleSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'author');
    await compile(c, input.rule, channelId);
    const e = env(c);
    const now = Date.now();
    const id = newId('circle', now);
    const row = await first<CircleRow>(
      e.DB,
      `INSERT INTO circles (id, workspace_id, channel_id, name, description, rule_json, generation, status,
                            created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 'pending', ?7, ?8, ?8) RETURNING *`,
      id,
      access.workspaceId,
      channelId,
      input.name,
      input.description ?? null,
      JSON.stringify(input.rule),
      access.auth.operatorId,
      now,
    );
    await enqueueRefresh(c, id, 1);
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'circle.created',
      targetType: 'circle',
      targetId: id,
      metadata: { channelId },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: toCircle(row as CircleRow) }, 201);
  },
);

circles.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/circles/preview',
    tags: ['Circles'],
    summary: 'Count and sample the Members a rule matches, without saving it',
    description:
      'Evaluated live against current data, for the builder’s count as you edit. Debounce calls from the client.',
    request: { params: channelParam, body: jsonBody(CirclePreviewRequestSchema) },
    responses: {
      200: ok(CirclePreviewSchema, 'Preview'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { rule } = c.req.valid('json');
    await requireChannel(c, channelId, 'viewer');
    const compiled = await compile(c, rule, channelId);
    const db = env(c).DB;
    const queries = circlePreviewQueries(compiled, channelId);
    const [counts, sample] = await Promise.all([
      first<{ n: number; active: number }>(db, queries.count.sql, ...queries.count.params),
      all<MemberRow>(db, queries.sample.sql, ...queries.sample.params),
    ]);
    return c.json(
      {
        data: {
          count: counts?.n ?? 0,
          activeCount: counts?.active ?? 0,
          sample: sample.map(toMember),
        },
      },
      200,
    );
  },
);

circles.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/circles/{circleId}',
    tags: ['Circles'],
    summary: 'One Circle',
    request: { params: circleParam },
    responses: { 200: ok(CircleSchema, 'Circle'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { circleId } = c.req.valid('param');
    const { row } = await requireCircle(c, circleId, 'viewer');
    return c.json({ data: toCircle(row) }, 200);
  },
);

circles.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/circles/{circleId}',
    tags: ['Circles'],
    summary: 'Rename a Circle or change its rule',
    description: 'A new rule sets the Circle back to pending until it has been evaluated again.',
    request: { params: circleParam, body: jsonBody(UpdateCircleSchema) },
    responses: {
      200: ok(CircleSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { circleId } = c.req.valid('param');
    const input = c.req.valid('json');
    const { row: current, access } = await requireCircle(c, circleId, 'author');
    if (input.rule) await compile(c, input.rule, current.channel_id);
    const e = env(c);
    // A new rule bumps the generation, so a refresh still running for the old rule can't swap
    // its result in.
    const row = await first<CircleRow>(
      e.DB,
      `UPDATE circles
          SET name = ?1, description = ?2, updated_at = ?3,
              rule_json = coalesce(?4, rule_json),
              generation = generation + (?4 IS NOT NULL),
              status = CASE WHEN ?4 IS NOT NULL THEN 'pending' ELSE status END
        WHERE id = ?5 AND deleted_at IS NULL RETURNING *`,
      input.name ?? current.name,
      input.description === undefined ? current.description : input.description,
      Date.now(),
      input.rule ? JSON.stringify(input.rule) : null,
      circleId,
    );
    if (!row) throw new ApiError('not_found', 'Segment not found.');
    if (input.rule) await enqueueRefresh(c, circleId, row.generation);
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'circle.updated',
      targetType: 'circle',
      targetId: circleId,
      metadata: { fields: Object.keys(input) },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: toCircle(row) }, 200);
  },
);

circles.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/circles/{circleId}',
    tags: ['Circles'],
    summary: 'Delete a Circle',
    description: 'Refused while a scheduled Dispatch is addressed to it.',
    request: { params: circleParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found', 'conflict') },
  }),
  async (c) => {
    const { circleId } = c.req.valid('param');
    const { row, access } = await requireCircle(c, circleId, 'author');
    const e = env(c);
    const scheduled = await first(
      e.DB,
      `SELECT 1 FROM dispatches d
        WHERE d.channel_id = ?1 AND d.status = 'scheduled'
          AND (EXISTS (SELECT 1 FROM json_each(d.audience_json, '$.include') WHERE value = ?2)
            OR EXISTS (SELECT 1 FROM json_each(d.audience_json, '$.exclude') WHERE value = ?2))
        LIMIT 1`,
      row.channel_id,
      circleId,
    );
    if (scheduled) {
      throw new ApiError(
        'conflict',
        'A scheduled post is addressed to this segment. Change its audience first.',
      );
    }
    const now = Date.now();
    // The row stays (soft delete) for the audit trail; its membership goes.
    await e.DB.batch([
      e.DB.prepare(
        'UPDATE circles SET deleted_at = ?1, updated_at = ?1, generation = generation + 1 WHERE id = ?2',
      ).bind(now, circleId),
      e.DB.prepare('DELETE FROM circle_members WHERE circle_id = ?1').bind(circleId),
    ]);
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'circle.deleted',
      targetType: 'circle',
      targetId: circleId,
      metadata: { name: row.name },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.body(null, 204);
  },
);

circles.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/circles/{circleId}/refresh',
    tags: ['Circles'],
    summary: 'Evaluate a Circle again now',
    description: 'Queues a re-evaluation against current data. Circles also refresh on a schedule.',
    request: { params: circleParam },
    responses: {
      202: ok(CircleSchema, 'Queued'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { circleId } = c.req.valid('param');
    await requireCircle(c, circleId, 'author');
    // Already pending means a refresh is queued; another would only repeat it. Pending past the
    // stuck window means its message was lost: queue it again now, and clear the lost-refresh
    // count, whose backoff would keep the cron waiting for hours after the cause was fixed.
    const now = Date.now();
    const row = await first<CircleRow>(
      env(c).DB,
      `UPDATE circles SET status = 'pending', updated_at = ?1, refresh_failures = 0
        WHERE id = ?2 AND deleted_at IS NULL AND (status <> 'pending' OR updated_at < ?1 - ?3)
        RETURNING *`,
      now,
      circleId,
      CIRCLE_STUCK_AFTER_MS,
    );
    if (row) {
      await enqueueRefresh(c, circleId, row.generation);
      return c.json({ data: toCircle(row) }, 202);
    }
    const pending = await first<CircleRow>(
      env(c).DB,
      'SELECT * FROM circles WHERE id = ?1 AND deleted_at IS NULL',
      circleId,
    );
    if (!pending) throw new ApiError('not_found', 'Segment not found.');
    return c.json({ data: toCircle(pending) }, 202);
  },
);

circles.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/circles/{circleId}/members',
    tags: ['Circles'],
    summary: 'Members in a Circle as of its last evaluation, newest first',
    request: { params: circleParam, query: CursorQuerySchema },
    responses: {
      200: ok(page(MemberSchema), 'Members'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { circleId } = c.req.valid('param');
    const { cursor, limit } = c.req.valid('query');
    await requireCircle(c, circleId, 'viewer');
    if (cursor && !idPattern('member').test(cursor)) {
      throw new ApiError('invalid_input', 'That page cursor is not valid.');
    }
    const rows = await all<MemberRow>(
      env(c).DB,
      `SELECT ${MEMBER_COLUMNS} FROM circle_members cm JOIN members m ON m.id = cm.member_id
        WHERE cm.circle_id = ?1 AND (?2 IS NULL OR cm.member_id < ?2)
        ORDER BY cm.member_id DESC LIMIT ?3`,
      circleId,
      cursor ?? null,
      limit + 1,
    );
    const items = rows.slice(0, limit).map(toMember);
    const nextCursor = rows.length > limit ? (items.at(-1)?.id ?? null) : null;
    return c.json({ data: { items, nextCursor } }, 200);
  },
);
