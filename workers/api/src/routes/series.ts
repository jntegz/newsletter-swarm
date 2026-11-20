// Series (Phase 6, flag post_series): ordered groups of Dispatches. A Dispatch is in at most one
// Series (series_dispatches.dispatch_id is unique). The site shows /series/<slug>, "Part N of M"
// and a "Next in series" link on Dispatch pages, so every change bumps the site cache.
import { createRoute } from '@hono/zod-openapi';
import { all, first, isUniqueViolation, toIso } from '@swarm/db';
import {
  CreateSeriesSchema,
  SeriesListSchema,
  SeriesSchema,
  UpdateSeriesSchema,
  idPattern,
  newId,
  slugify,
  type Series,
} from '@swarm/domain';
import { bumpCacheStatement } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { createRouter, env, type AppContext } from '../lib/context';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { audit, requireFlag } from '../lib/site';

export const series = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const seriesParams = channelParam.extend(idParam('seriesId', idPattern('series')).shape);
const TAG = ['Series'];
const FLAG_MESSAGE = 'Series are not turned on for this publication.';

interface SeriesRow {
  id: string;
  channel_id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

async function loadSeries(db: D1Database, rows: SeriesRow[]): Promise<Series[]> {
  if (!rows.length) return [];
  const members = await all<{ series_id: string; dispatch_id: string }>(
    db,
    `SELECT series_id, dispatch_id FROM series_dispatches
      WHERE series_id IN (SELECT value FROM json_each(?1)) ORDER BY series_id, position`,
    JSON.stringify(rows.map((r) => r.id)),
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    dispatchIds: members.filter((m) => m.series_id === row.id).map((m) => m.dispatch_id),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }));
}

async function requireSeries(db: D1Database, channelId: string, seriesId: string) {
  const row = await first<SeriesRow>(
    db,
    'SELECT * FROM series WHERE id = ?1 AND channel_id = ?2 AND deleted_at IS NULL',
    seriesId,
    channelId,
  );
  if (!row) throw new ApiError('not_found', 'Series not found.');
  return row;
}

async function access(c: AppContext, channelId: string, role: 'viewer' | 'editor') {
  const result = await requireChannel(c, channelId, role);
  await requireFlag(c, result, 'post_series', FLAG_MESSAGE);
  return result;
}

/** Every id must be a Dispatch of this Channel and in no other Series. */
async function checkDispatches(
  db: D1Database,
  channelId: string,
  seriesId: string | null,
  dispatchIds: string[],
): Promise<void> {
  if (!dispatchIds.length) return;
  const rows = await all<{ id: string; series_id: string | null }>(
    db,
    `SELECT d.id, sd.series_id FROM dispatches d
       LEFT JOIN series_dispatches sd ON sd.dispatch_id = d.id
      WHERE d.channel_id = ?1 AND d.kind = 'broadcast' AND d.id IN (SELECT value FROM json_each(?2))`,
    channelId,
    JSON.stringify(dispatchIds),
  );
  if (rows.length !== dispatchIds.length) {
    const message = 'Choose posts of this publication.';
    throw new ApiError('invalid_input', message, [{ path: 'dispatchIds', message }]);
  }
  if (rows.some((r) => r.series_id !== null && r.series_id !== seriesId)) {
    throw new ApiError('conflict', 'A post can be in one Series only.');
  }
}

function orderStatements(db: D1Database, seriesId: string, dispatchIds: string[]) {
  return [
    db.prepare('DELETE FROM series_dispatches WHERE series_id = ?1').bind(seriesId),
    ...dispatchIds.map((dispatchId, position) =>
      db
        .prepare(
          'INSERT INTO series_dispatches (series_id, dispatch_id, position) VALUES (?1, ?2, ?3)',
        )
        .bind(seriesId, dispatchId, position),
    ),
  ];
}

const conflict = (error: unknown): never => {
  if (isUniqueViolation(error)) {
    const message = String((error as Error).message ?? '');
    throw new ApiError(
      'conflict',
      message.includes('dispatch_id')
        ? 'A post can be in one Series only.'
        : 'Another Series already uses this slug.',
    );
  }
  throw error;
};

series.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/series',
    tags: TAG,
    summary: 'Series of a Channel, by name',
    description: 'Needs the post_series flag.',
    request: { params: channelParam },
    responses: { 200: ok(SeriesListSchema, 'Series'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await access(c, channelId, 'viewer');
    const db = env(c).DB;
    const rows = await all<SeriesRow>(
      db,
      'SELECT * FROM series WHERE channel_id = ?1 AND deleted_at IS NULL ORDER BY name LIMIT 500',
      channelId,
    );
    return c.json({ data: { items: await loadSeries(db, rows) } }, 200);
  },
);

series.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/series',
    tags: TAG,
    summary: 'Create a Series',
    description:
      'Editor role; needs the post_series flag. dispatchIds is the reading order. The slug comes from the name when absent.',
    request: { params: channelParam, body: jsonBody(CreateSeriesSchema) },
    responses: {
      201: ok(SeriesSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const result = await access(c, channelId, 'editor');
    const db = env(c).DB;
    const dispatchIds = input.dispatchIds ?? [];
    await checkDispatches(db, channelId, null, dispatchIds);
    const id = newId('series');
    const now = Date.now();
    const slug = input.slug ?? slugify(input.name, 80);
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO series (id, channel_id, name, slug, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
          )
          .bind(id, channelId, input.name, slug, input.description ?? null, now),
        ...orderStatements(db, id, dispatchIds),
        bumpCacheStatement(db, channelId, now),
      ]);
    } catch (error) {
      conflict(error);
    }
    await audit(c, result, 'series.created', 'series', id, { name: input.name, slug });
    const [created] = await loadSeries(db, [await requireSeries(db, channelId, id)]);
    return c.json({ data: created as Series }, 201);
  },
);

series.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/series/{seriesId}',
    tags: TAG,
    summary: 'A Series with its Dispatches in order',
    request: { params: seriesParams },
    responses: { 200: ok(SeriesSchema, 'Series'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId, seriesId } = c.req.valid('param');
    await access(c, channelId, 'viewer');
    const db = env(c).DB;
    const [found] = await loadSeries(db, [await requireSeries(db, channelId, seriesId)]);
    return c.json({ data: found as Series }, 200);
  },
);

series.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/channels/{channelId}/series/{seriesId}',
    tags: TAG,
    summary: 'Rename, re-slug or reorder a Series',
    description:
      'Editor role. dispatchIds replaces the whole order; Dispatches left out leave the Series.',
    request: { params: seriesParams, body: jsonBody(UpdateSeriesSchema) },
    responses: {
      200: ok(SeriesSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, seriesId } = c.req.valid('param');
    const input = c.req.valid('json');
    const result = await access(c, channelId, 'editor');
    const db = env(c).DB;
    const row = await requireSeries(db, channelId, seriesId);
    if (input.dispatchIds) await checkDispatches(db, channelId, seriesId, input.dispatchIds);
    const now = Date.now();
    try {
      await db.batch([
        db
          .prepare(
            'UPDATE series SET name = ?1, slug = ?2, description = ?3, updated_at = ?4 WHERE id = ?5',
          )
          .bind(
            input.name ?? row.name,
            input.slug ?? row.slug,
            input.description === undefined ? row.description : input.description,
            now,
            seriesId,
          ),
        ...(input.dispatchIds ? orderStatements(db, seriesId, input.dispatchIds) : []),
        bumpCacheStatement(db, channelId, now),
      ]);
    } catch (error) {
      conflict(error);
    }
    await audit(c, result, 'series.changed', 'series', seriesId, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.slug ? { slug: input.slug } : {}),
      ...(input.dispatchIds ? { dispatches: input.dispatchIds.length } : {}),
    });
    const [saved] = await loadSeries(db, [await requireSeries(db, channelId, seriesId)]);
    return c.json({ data: saved as Series }, 200);
  },
);

series.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}/series/{seriesId}',
    tags: TAG,
    summary: 'Delete a Series',
    description: 'Editor role. Its Dispatches stay; they can join another Series.',
    request: { params: seriesParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { channelId, seriesId } = c.req.valid('param');
    const result = await access(c, channelId, 'editor');
    const db = env(c).DB;
    await requireSeries(db, channelId, seriesId);
    const now = Date.now();
    await db.batch([
      db.prepare('DELETE FROM series_dispatches WHERE series_id = ?1').bind(seriesId),
      db
        .prepare('UPDATE series SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2')
        .bind(now, seriesId),
      bumpCacheStatement(db, channelId, now),
    ]);
    await audit(c, result, 'series.deleted', 'series', seriesId);
    return c.body(null, 204);
  },
);
