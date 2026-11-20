// Partner Exchange (flag partner_exchange; docs/partner-exchange.md): publications this one
// recommends by hand, at signup and on its website. Editors change them; anyone can read.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, run } from '@swarm/db';
import {
  CreatePartnerPickSchema,
  MAX_PARTNER_PICKS,
  PartnerPickSchema,
  UpdatePartnerPickSchema,
  idPattern,
  newId,
  type PartnerPick,
} from '@swarm/domain';
import { bumpCacheStatement } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { createRouter, env, type AppContext } from '../lib/context';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { audit, requireFlag } from '../lib/site';

export const partners = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const pickParams = channelParam.extend(idParam('pickId', idPattern('partnerPick')).shape);
const TAGS = ['Partner Exchange'];

async function enter(c: AppContext, channelId: string, role: 'viewer' | 'editor') {
  const access = await requireChannel(c, channelId, role);
  await requireFlag(c, access, 'partner_exchange', 'Partner Exchange is not turned on.');
  return access;
}

interface PickRow {
  id: string;
  channel_id: string;
  name: string;
  description: string;
  url: string;
  on_site: number;
  on_signup: number;
  site_clicks: number;
  signup_clicks: number;
}

const toPick = (row: PickRow): PartnerPick => ({
  id: row.id,
  channelId: row.channel_id,
  name: row.name,
  description: row.description,
  url: row.url,
  onSite: row.on_site === 1,
  onSignup: row.on_signup === 1,
  siteClicks: row.site_clicks,
  signupClicks: row.signup_clicks,
});

partners.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/partner-picks',
    tags: TAGS,
    summary: 'Publications this one recommends, in order, with their click counts',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(PartnerPickSchema), 'Picks'),
      ...errors('unauthorized', 'not_found', 'feature_disabled'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await enter(c, channelId, 'viewer');
    const rows = await all<PickRow>(
      env(c).DB,
      'SELECT * FROM partner_picks WHERE channel_id = ?1 ORDER BY position, id',
      channelId,
    );
    return c.json({ data: rows.map(toPick) }, 200);
  },
);

partners.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/partner-picks',
    tags: TAGS,
    summary: 'Recommend a publication',
    request: { params: channelParam, body: jsonBody(CreatePartnerPickSchema) },
    responses: {
      201: ok(PartnerPickSchema, 'Added'),
      ...errors(
        'invalid_input',
        'unauthorized',
        'forbidden',
        'not_found',
        'conflict',
        'feature_disabled',
      ),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await enter(c, channelId, 'editor');
    const input = c.req.valid('json');
    const db = env(c).DB;
    const count = await first<{ n: number; next: number }>(
      db,
      'SELECT count(*) AS n, ifnull(max(position), -1) + 1 AS next FROM partner_picks WHERE channel_id = ?1',
      channelId,
    );
    if ((count?.n ?? 0) >= MAX_PARTNER_PICKS) {
      throw new ApiError('conflict', `You can recommend up to ${MAX_PARTNER_PICKS} publications.`);
    }
    const now = Date.now();
    const id = newId('partnerPick', now);
    await db.batch([
      db
        .prepare(
          `INSERT INTO partner_picks (id, channel_id, name, description, url, on_site, on_signup, position, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
        )
        .bind(
          id,
          channelId,
          input.name,
          input.description ?? '',
          input.url,
          input.onSite === false ? 0 : 1,
          input.onSignup === false ? 0 : 1,
          count?.next ?? 0,
          now,
        ),
      bumpCacheStatement(db, channelId, now),
    ]);
    await audit(c, access, 'partner_pick.created', 'partner_pick', id);
    const row = await first<PickRow>(db, 'SELECT * FROM partner_picks WHERE id = ?1', id);
    return c.json({ data: toPick(row!) }, 201);
  },
);

partners.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/channels/{channelId}/partner-picks/{pickId}',
    tags: TAGS,
    summary: 'Change a recommendation',
    request: { params: pickParams, body: jsonBody(UpdatePartnerPickSchema) },
    responses: {
      200: ok(PartnerPickSchema, 'Changed'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'feature_disabled'),
    },
  }),
  async (c) => {
    const { channelId, pickId } = c.req.valid('param');
    const access = await enter(c, channelId, 'editor');
    const input = c.req.valid('json');
    const db = env(c).DB;
    const now = Date.now();
    const bool = (value: boolean | undefined) => (value === undefined ? null : value ? 1 : 0);
    const [updated] = await db.batch<PickRow>([
      db
        .prepare(
          `UPDATE partner_picks SET name = coalesce(?1, name), description = coalesce(?2, description),
                  url = coalesce(?3, url), on_site = coalesce(?4, on_site),
                  on_signup = coalesce(?5, on_signup), updated_at = ?6
            WHERE id = ?7 AND channel_id = ?8 RETURNING *`,
        )
        .bind(
          input.name ?? null,
          input.description ?? null,
          input.url ?? null,
          bool(input.onSite),
          bool(input.onSignup),
          now,
          pickId,
          channelId,
        ),
      bumpCacheStatement(db, channelId, now),
    ]);
    const row = updated?.results[0];
    if (!row) throw new ApiError('not_found', 'Recommendation not found.');
    await audit(c, access, 'partner_pick.updated', 'partner_pick', pickId);
    return c.json({ data: toPick(row) }, 200);
  },
);

partners.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}/partner-picks/{pickId}',
    tags: TAGS,
    summary: 'Stop recommending a publication',
    request: { params: pickParams },
    responses: {
      204: noContent,
      ...errors('unauthorized', 'forbidden', 'not_found', 'feature_disabled'),
    },
  }),
  async (c) => {
    const { channelId, pickId } = c.req.valid('param');
    const access = await enter(c, channelId, 'editor');
    const db = env(c).DB;
    const gone = await run(
      db,
      'DELETE FROM partner_picks WHERE id = ?1 AND channel_id = ?2',
      pickId,
      channelId,
    );
    if (!gone.meta.changes) throw new ApiError('not_found', 'Recommendation not found.');
    await bumpCacheStatement(db, channelId, Date.now()).run();
    await audit(c, access, 'partner_pick.deleted', 'partner_pick', pickId);
    return c.body(null, 204);
  },
);
