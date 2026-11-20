// Link Hub (Phase 8, flag link_hub): the settings and links of a Channel's /links page, and its
// click report. Every write bumps the site cache version, so the edge serves the new page; the
// page itself is served by the site worker (routes/hub.ts). Contract: docs/link-hub.md.
import { createRoute } from '@hono/zod-openapi';
import { all, first, toIso, type ChannelAccess } from '@swarm/db';
import {
  CreateHubLinkSchema,
  HUB_ANALYTICS_DEFAULT_DAYS,
  HUB_ANALYTICS_MAX_DAYS,
  HUB_PATH,
  HubLinkSchema,
  LinkHubAnalyticsQuerySchema,
  LinkHubAnalyticsSchema,
  LinkHubSchema,
  MAX_HUB_LINKS,
  ReorderHubLinksSchema,
  UpdateHubLinkSchema,
  UpdateLinkHubSchema,
  hubLinkLive,
  idPattern,
  newId,
  type HubLink,
  type HubSocial,
  type LinkHub,
} from '@swarm/domain';
import { bumpCacheStatement, linkHubReport } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { createRouter, env, type AppContext } from '../lib/context';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { audit, requireFlag, siteOrigin } from '../lib/site';

export const linkHub = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const linkParams = channelParam.extend(idParam('linkId', idPattern('hubLink')).shape);
const TAG = ['Link Hub'];
const FLAG_MESSAGE = 'Link Hub is not turned on for this publication.';
const DAY_MS = 86_400_000;

async function access(c: AppContext, channelId: string, role: 'viewer' | 'editor') {
  const result = await requireChannel(c, channelId, role);
  await requireFlag(c, result, 'link_hub', FLAG_MESSAGE);
  return result;
}

interface SettingsRow {
  enabled: number;
  title: string | null;
  bio: string | null;
  socials_json: string;
  latest_dispatches: number;
  show_form: number;
  capture_form_id: string | null;
  updated_at: number;
}

interface LinkRow {
  id: string;
  channel_id: string;
  title: string;
  url: string;
  thumbnail_media_id: string | null;
  thumbnail_key: string | null;
  starts_at: number | null;
  ends_at: number | null;
  position: number;
  created_at: number;
  updated_at: number;
}

/** Links with their thumbnail's storage key while the image is public and not deleted. */
const LINK_SELECT = `SELECT l.*, m.r2_key AS thumbnail_key FROM hub_links l
  LEFT JOIN media m ON m.id = l.thumbnail_media_id AND m.deleted_at IS NULL AND m.visibility = 'public'`;

function toLink(row: LinkRow, mediaOrigin: string, now: number): HubLink {
  return {
    id: row.id,
    channelId: row.channel_id,
    title: row.title,
    url: row.url,
    thumbnailMediaId: row.thumbnail_media_id,
    thumbnailUrl: row.thumbnail_key ? `${mediaOrigin}/media/${row.thumbnail_key}` : null,
    startsAt: row.starts_at === null ? null : toIso(row.starts_at),
    endsAt: row.ends_at === null ? null : toIso(row.ends_at),
    position: row.position,
    live: hubLinkLive({ startsAt: row.starts_at, endsAt: row.ends_at }, now),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

async function readLinks(c: AppContext, channelId: string): Promise<HubLink[]> {
  const e = env(c);
  const rows = await all<LinkRow>(
    e.DB,
    `${LINK_SELECT} WHERE l.channel_id = ?1 ORDER BY l.position, l.created_at`,
    channelId,
  );
  const now = Date.now();
  return rows.map((row) => toLink(row, e.MEDIA_ORIGIN, now));
}

async function readLink(c: AppContext, channelId: string, linkId: string): Promise<LinkRow> {
  const row = await first<LinkRow>(
    env(c).DB,
    `${LINK_SELECT} WHERE l.id = ?1 AND l.channel_id = ?2`,
    linkId,
    channelId,
  );
  if (!row) throw new ApiError('not_found', 'Link not found.');
  return row;
}

async function readHub(c: AppContext, channelId: string): Promise<LinkHub> {
  const [row, links, origin] = await Promise.all([
    first<SettingsRow>(env(c).DB, 'SELECT * FROM hub_settings WHERE channel_id = ?1', channelId),
    readLinks(c, channelId),
    siteOrigin(c, channelId),
  ]);
  return {
    channelId,
    enabled: row?.enabled === 1,
    title: row?.title ?? null,
    bio: row?.bio ?? null,
    socials: row ? (JSON.parse(row.socials_json) as HubSocial[]) : [],
    latestDispatches: row?.latest_dispatches ?? 3,
    showCaptureForm: row ? row.show_form === 1 : true,
    captureFormId: row?.capture_form_id ?? null,
    url: `${origin.origin}${HUB_PATH}`,
    links,
    updatedAt: row ? toIso(row.updated_at) : null,
  };
}

function invalid(path: string, message: string): ApiError {
  return new ApiError('invalid_input', message, [{ path, message }]);
}

/** A thumbnail must be a public image of this workspace's media library. */
async function checkThumbnail(c: AppContext, workspace: ChannelAccess, mediaId: string) {
  const media = await first(
    env(c).DB,
    `SELECT 1 FROM media WHERE id = ?1 AND workspace_id = ?2 AND deleted_at IS NULL
        AND visibility = 'public' AND content_type LIKE 'image/%'`,
    mediaId,
    workspace.workspaceId,
  );
  if (!media)
    throw invalid('thumbnailMediaId', 'Choose an image from this workspace’s media library.');
}

const ms = (iso: string | null | undefined): number | null =>
  iso === undefined || iso === null ? null : Date.parse(iso);

// ---- The page ------------------------------------------------------------------------------

linkHub.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/link-hub',
    tags: TAG,
    summary: 'The Link Hub page',
    description:
      'Settings and every link in page order, scheduled or not (`live` says whether it shows now). Defaults until the first save. Needs the link_hub flag.',
    request: { params: channelParam },
    responses: { 200: ok(LinkHubSchema, 'Link Hub'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await access(c, channelId, 'viewer');
    return c.json({ data: await readHub(c, channelId) }, 200);
  },
);

linkHub.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/channels/{channelId}/link-hub',
    tags: TAG,
    summary: 'Change the Link Hub page',
    description:
      'Editor role. `enabled` puts the page at /links on the website. The Capture Form must be a published form of this Channel.',
    request: { params: channelParam, body: jsonBody(UpdateLinkHubSchema) },
    responses: {
      200: ok(LinkHubSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const result = await access(c, channelId, 'editor');
    const e = env(c);
    if (input.captureFormId) {
      const form = await first(
        e.DB,
        `SELECT 1 FROM capture_forms WHERE id = ?1 AND channel_id = ?2 AND deleted_at IS NULL
            AND status = 'published' AND kind = 'form'`,
        input.captureFormId,
        channelId,
      );
      if (!form)
        throw invalid('captureFormId', 'Choose a published signup form of this publication.');
    }
    const bool = (value: boolean | undefined) => (value === undefined ? null : value ? 1 : 0);
    // Nullable text: undefined keeps, null clears (stored as '' then turned back into NULL).
    const text = (value: string | null | undefined) =>
      value === undefined ? null : value === null ? '' : value;
    const now = Date.now();
    await e.DB.batch([
      e.DB.prepare(
        'INSERT INTO hub_settings (channel_id, updated_at) VALUES (?1, ?2) ON CONFLICT (channel_id) DO NOTHING',
      ).bind(channelId, now),
      e.DB.prepare(
        `UPDATE hub_settings SET enabled = coalesce(?1, enabled),
                title = CASE WHEN ?2 IS NULL THEN title ELSE nullif(?2, '') END,
                bio = CASE WHEN ?3 IS NULL THEN bio ELSE nullif(?3, '') END,
                socials_json = coalesce(?4, socials_json),
                latest_dispatches = coalesce(?5, latest_dispatches),
                show_form = coalesce(?6, show_form),
                capture_form_id = CASE WHEN ?7 = 1 THEN ?8 ELSE capture_form_id END,
                updated_by = ?9, updated_at = ?10
          WHERE channel_id = ?11`,
      ).bind(
        bool(input.enabled),
        text(input.title),
        text(input.bio),
        input.socials === undefined ? null : JSON.stringify(input.socials),
        input.latestDispatches ?? null,
        bool(input.showCaptureForm),
        input.captureFormId === undefined ? 0 : 1,
        input.captureFormId ?? null,
        result.auth.operatorId,
        now,
        channelId,
      ),
      bumpCacheStatement(e.DB, channelId, now),
    ]);
    await audit(c, result, 'link_hub.updated', 'channel', channelId, {
      fields: Object.keys(input).sort(),
    });
    return c.json({ data: await readHub(c, channelId) }, 200);
  },
);

// ---- Links ---------------------------------------------------------------------------------

linkHub.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/link-hub/links',
    tags: TAG,
    summary: 'Add a link',
    description: `Editor role. At most ${MAX_HUB_LINKS} links. The target must be an http or https address; the thumbnail a public image of this workspace's media library. Added last unless \`position\` is given.`,
    request: { params: channelParam, body: jsonBody(CreateHubLinkSchema) },
    responses: {
      201: ok(HubLinkSchema, 'Added'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const result = await access(c, channelId, 'editor');
    const e = env(c);
    if (input.thumbnailMediaId) await checkThumbnail(c, result, input.thumbnailMediaId);
    const count = await first<{ n: number }>(
      e.DB,
      'SELECT count(*) AS n FROM hub_links WHERE channel_id = ?1',
      channelId,
    );
    const total = count?.n ?? 0;
    if (total >= MAX_HUB_LINKS) {
      throw new ApiError('conflict', `A Link Hub holds up to ${MAX_HUB_LINKS} links.`);
    }
    const position = Math.min(input.position ?? total, total);
    const id = newId('hubLink');
    const now = Date.now();
    await e.DB.batch([
      // Make room: everything at or after the new position moves down one.
      e.DB.prepare(
        'UPDATE hub_links SET position = position + 1 WHERE channel_id = ?1 AND position >= ?2',
      ).bind(channelId, position),
      e.DB.prepare(
        `INSERT INTO hub_links (id, channel_id, title, url, thumbnail_media_id, starts_at, ends_at, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
      ).bind(
        id,
        channelId,
        input.title,
        input.url,
        input.thumbnailMediaId ?? null,
        ms(input.startsAt),
        ms(input.endsAt),
        position,
        now,
      ),
      bumpCacheStatement(e.DB, channelId, now),
    ]);
    await audit(c, result, 'link_hub.link_created', 'hub_link', id, { url: input.url });
    const row = await readLink(c, channelId, id);
    return c.json({ data: toLink(row, e.MEDIA_ORIGIN, Date.now()) }, 201);
  },
);

linkHub.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/channels/{channelId}/link-hub/links/{linkId}',
    tags: TAG,
    summary: 'Change a link',
    description: 'Editor role. Null clears the thumbnail, start or end.',
    request: { params: linkParams, body: jsonBody(UpdateHubLinkSchema) },
    responses: {
      200: ok(HubLinkSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, linkId } = c.req.valid('param');
    const input = c.req.valid('json');
    const result = await access(c, channelId, 'editor');
    const e = env(c);
    const row = await readLink(c, channelId, linkId);
    if (input.thumbnailMediaId) await checkThumbnail(c, result, input.thumbnailMediaId);
    const startsAt = input.startsAt === undefined ? row.starts_at : ms(input.startsAt);
    const endsAt = input.endsAt === undefined ? row.ends_at : ms(input.endsAt);
    if (startsAt !== null && endsAt !== null && startsAt >= endsAt) {
      throw invalid('endsAt', 'End after the start.');
    }
    const now = Date.now();
    await e.DB.batch([
      e.DB.prepare(
        `UPDATE hub_links SET title = ?1, url = ?2, thumbnail_media_id = ?3, starts_at = ?4,
                ends_at = ?5, updated_at = ?6
          WHERE id = ?7 AND channel_id = ?8`,
      ).bind(
        input.title ?? row.title,
        input.url ?? row.url,
        input.thumbnailMediaId === undefined ? row.thumbnail_media_id : input.thumbnailMediaId,
        startsAt,
        endsAt,
        now,
        linkId,
        channelId,
      ),
      bumpCacheStatement(e.DB, channelId, now),
    ]);
    await audit(c, result, 'link_hub.link_updated', 'hub_link', linkId, {
      fields: Object.keys(input).sort(),
    });
    const updated = await readLink(c, channelId, linkId);
    return c.json({ data: toLink(updated, e.MEDIA_ORIGIN, Date.now()) }, 200);
  },
);

linkHub.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}/link-hub/links/{linkId}',
    tags: TAG,
    summary: 'Remove a link',
    description: 'Editor role. Its click history stays in the report as a deleted link.',
    request: { params: linkParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { channelId, linkId } = c.req.valid('param');
    const result = await access(c, channelId, 'editor');
    const e = env(c);
    const row = await readLink(c, channelId, linkId);
    await e.DB.batch([
      e.DB.prepare('DELETE FROM hub_links WHERE id = ?1 AND channel_id = ?2').bind(
        linkId,
        channelId,
      ),
      e.DB.prepare(
        'UPDATE hub_links SET position = position - 1 WHERE channel_id = ?1 AND position > ?2',
      ).bind(channelId, row.position),
      bumpCacheStatement(e.DB, channelId, Date.now()),
    ]);
    await audit(c, result, 'link_hub.link_deleted', 'hub_link', linkId, { url: row.url });
    return c.body(null, 204);
  },
);

linkHub.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/channels/{channelId}/link-hub/order',
    tags: TAG,
    summary: 'Reorder the links',
    description: 'Editor role. List every link of the page exactly once, in the new order.',
    request: { params: channelParam, body: jsonBody(ReorderHubLinksSchema) },
    responses: {
      200: ok(LinkHubSchema, 'Reordered'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { ids } = c.req.valid('json');
    const result = await access(c, channelId, 'editor');
    const e = env(c);
    const current = await all<{ id: string }>(
      e.DB,
      'SELECT id FROM hub_links WHERE channel_id = ?1',
      channelId,
    );
    const known = new Set(current.map((row) => row.id));
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== known.size ||
      ids.some((id) => !known.has(id))
    ) {
      throw invalid('ids', 'List every link of this page exactly once.');
    }
    const now = Date.now();
    await e.DB.batch([
      ...ids.map((id, position) =>
        e.DB.prepare('UPDATE hub_links SET position = ?1 WHERE id = ?2 AND channel_id = ?3').bind(
          position,
          id,
          channelId,
        ),
      ),
      bumpCacheStatement(e.DB, channelId, now),
    ]);
    await audit(c, result, 'link_hub.reordered', 'channel', channelId, { links: ids.length });
    return c.json({ data: await readHub(c, channelId) }, 200);
  },
);

// ---- Analytics -----------------------------------------------------------------------------

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

linkHub.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/link-hub/analytics',
    tags: TAG,
    summary: 'Link Hub clicks',
    description: `Cookieless click counts from daily rollups (UTC days), per link, per day, by source and country, with the page's views from the site analytics. Defaults to the last ${HUB_ANALYTICS_DEFAULT_DAYS} days; at most ${HUB_ANALYTICS_MAX_DAYS}. Filter by one link with linkId.`,
    request: { params: channelParam, query: LinkHubAnalyticsQuerySchema },
    responses: {
      200: ok(LinkHubAnalyticsSchema, 'Clicks'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const query = c.req.valid('query');
    await access(c, channelId, 'viewer');
    const to = query.to ?? dayOf(Date.now());
    const from =
      query.from ??
      dayOf(Date.parse(`${to}T00:00:00Z`) - (HUB_ANALYTICS_DEFAULT_DAYS - 1) * DAY_MS);
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    if (Number.isNaN(start) || Number.isNaN(end) || dayOf(start) !== from || dayOf(end) !== to) {
      throw new ApiError('invalid_input', 'Use real dates such as 2026-10-27.');
    }
    if (start > end) throw new ApiError('invalid_input', 'The start date is after the end date.');
    if ((end - start) / DAY_MS + 1 > HUB_ANALYTICS_MAX_DAYS) {
      throw new ApiError(
        'invalid_input',
        `Choose a range of up to ${HUB_ANALYTICS_MAX_DAYS} days.`,
      );
    }
    const data = await linkHubReport(env(c).DB, channelId, {
      from,
      to,
      linkId: query.linkId ?? null,
    });
    return c.json({ data }, 200);
  },
);
