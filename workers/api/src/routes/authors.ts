// Author pages (flag author_pages): teammates' public profiles on a Channel's website. A teammate
// with the author role or higher edits their own; admins edit anyone's in the Channel. Every write
// bumps the site cache version, so bylines and author pages change at once.
import { createRoute, z } from '@hono/zod-openapi';
import { all, channelAccess, first, isUniqueViolation, roleAtLeast, toIso } from '@swarm/db';
import {
  AuthorProfileSchema,
  UpsertAuthorProfileSchema,
  idPattern,
  isReservedSitePath,
  slugify,
  type AuthorProfile,
} from '@swarm/domain';
import { bumpCacheStatement } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { createRouter, env, type AppContext } from '../lib/context';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { audit, requireFlag, siteOrigin } from '../lib/site';

export const authors = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const authorParams = channelParam.extend(idParam('operatorId', idPattern('operator')).shape);

interface AuthorRow {
  channel_id: string;
  operator_id: string;
  slug: string;
  name: string;
  bio: string | null;
  avatar_media_id: string | null;
  avatar_key: string | null;
  dispatch_count: number;
  created_at: number;
  updated_at: number;
}

const AUTHOR_SELECT = `SELECT a.*, m.r2_key AS avatar_key,
    (SELECT count(*) FROM dispatches d
      WHERE d.channel_id = a.channel_id AND d.created_by = a.operator_id
        AND d.web_published_at IS NOT NULL AND d.web_visibility <> 'hidden') AS dispatch_count
  FROM author_profiles a
  LEFT JOIN media m ON m.id = a.avatar_media_id AND m.visibility = 'public' AND m.deleted_at IS NULL`;

const toAuthor = (row: AuthorRow, mediaOrigin: string, siteUrl: string): AuthorProfile => ({
  operatorId: row.operator_id,
  channelId: row.channel_id,
  slug: row.slug,
  name: row.name,
  bio: row.bio,
  avatarMediaId: row.avatar_media_id,
  avatarUrl: row.avatar_key ? `${mediaOrigin}/media/${row.avatar_key}` : null,
  url: `${siteUrl}/authors/${row.slug}`,
  dispatchCount: row.dispatch_count,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

async function authorsAccess(c: AppContext, channelId: string, minimum: 'viewer' | 'author') {
  const access = await requireChannel(c, channelId, minimum);
  await requireFlag(
    c,
    access,
    'author_pages',
    'Author pages are not available for this publication.',
  );
  return access;
}

/** Your own profile needs the author role; someone else's needs admin, and them on the Channel. */
async function writeAccess(c: AppContext, channelId: string, operatorId: string) {
  const access = await authorsAccess(c, channelId, 'author');
  if (operatorId !== access.auth.operatorId) {
    if (!roleAtLeast(access.role, 'admin')) {
      throw new ApiError('forbidden', 'Only admins can change another teammate’s author page.');
    }
    const theirs = await channelAccess(env(c).DB, operatorId, channelId);
    if (!theirs || !roleAtLeast(theirs.role, 'author')) {
      throw new ApiError('not_found', 'Teammate not found.');
    }
  }
  return access;
}

async function readAuthor(c: AppContext, channelId: string, operatorId: string) {
  const row = await first<AuthorRow>(
    env(c).DB,
    `${AUTHOR_SELECT} WHERE a.channel_id = ?1 AND a.operator_id = ?2`,
    channelId,
    operatorId,
  );
  if (!row) throw new ApiError('not_found', 'Author page not found.');
  return toAuthor(row, env(c).MEDIA_ORIGIN, (await siteOrigin(c, channelId)).origin);
}

const slugTaken = () =>
  new ApiError('conflict', 'Another author page uses that address.', [
    { path: 'slug', message: 'Another author page uses that address.' },
  ]);

authors.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/authors',
    tags: ['Site Studio'],
    summary: 'Author pages, by name',
    description: 'Needs the author_pages flag.',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(AuthorProfileSchema), 'Author pages'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await authorsAccess(c, channelId, 'viewer');
    const e = env(c);
    const [rows, origin] = await Promise.all([
      all<AuthorRow>(e.DB, `${AUTHOR_SELECT} WHERE a.channel_id = ?1 ORDER BY a.name`, channelId),
      siteOrigin(c, channelId),
    ]);
    return c.json({ data: rows.map((r) => toAuthor(r, e.MEDIA_ORIGIN, origin.origin)) }, 200);
  },
);

authors.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/channels/{channelId}/authors/{operatorId}',
    tags: ['Site Studio'],
    summary: 'Create or change an author page',
    description:
      'Your own needs the author role; another teammate’s needs admin. Served at /authors/<slug>, and the bylines of the teammate’s Dispatches link to it.',
    request: { params: authorParams, body: jsonBody(UpsertAuthorProfileSchema) },
    responses: {
      200: ok(AuthorProfileSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, operatorId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await writeAccess(c, channelId, operatorId);
    const e = env(c);
    const existing = await first<{ slug: string }>(
      e.DB,
      'SELECT slug FROM author_profiles WHERE channel_id = ?1 AND operator_id = ?2',
      channelId,
      operatorId,
    );
    const slug = input.slug ?? existing?.slug ?? slugify(input.name, 60);
    if (!slug) {
      const message = 'Choose an address with letters or digits.';
      throw new ApiError('invalid_input', message, [{ path: 'slug', message }]);
    }
    if (isReservedSitePath(slug)) {
      const message = 'That address is reserved.';
      throw new ApiError('invalid_input', message, [{ path: 'slug', message }]);
    }
    if (input.avatarMediaId) {
      const media = await first(
        e.DB,
        `SELECT 1 FROM media WHERE id = ?1 AND workspace_id = ?2 AND visibility = 'public'
            AND deleted_at IS NULL AND content_type LIKE 'image/%'`,
        input.avatarMediaId,
        access.workspaceId,
      );
      if (!media) {
        const message = 'Choose an image from this workspace’s media library.';
        throw new ApiError('invalid_input', message, [{ path: 'avatarMediaId', message }]);
      }
    }
    const now = Date.now();
    const keep = (value: unknown) => (value === undefined ? 0 : 1);
    try {
      await e.DB.batch([
        e.DB.prepare(
          `INSERT INTO author_profiles (channel_id, operator_id, slug, name, bio, avatar_media_id, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?6, ?8, ?9, ?9)
           ON CONFLICT (channel_id, operator_id) DO UPDATE SET
             slug = excluded.slug, name = excluded.name,
             bio = CASE WHEN ?5 = 1 THEN excluded.bio ELSE bio END,
             avatar_media_id = CASE WHEN ?7 = 1 THEN excluded.avatar_media_id ELSE avatar_media_id END,
             updated_at = excluded.updated_at`,
        ).bind(
          channelId,
          operatorId,
          slug,
          input.name,
          keep(input.bio),
          input.bio || null,
          keep(input.avatarMediaId),
          input.avatarMediaId ?? null,
          now,
        ),
        bumpCacheStatement(e.DB, channelId, now),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw slugTaken();
      throw error;
    }
    await audit(c, access, 'site.author_saved', 'author_profile', operatorId, { slug });
    return c.json({ data: await readAuthor(c, channelId, operatorId) }, 200);
  },
);

authors.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}/authors/{operatorId}',
    tags: ['Site Studio'],
    summary: 'Remove an author page',
    description: 'The teammate’s Dispatches stay on the website, without a byline.',
    request: { params: authorParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { channelId, operatorId } = c.req.valid('param');
    const access = await writeAccess(c, channelId, operatorId);
    const e = env(c);
    await readAuthor(c, channelId, operatorId);
    const now = Date.now();
    await e.DB.batch([
      e.DB.prepare('DELETE FROM author_profiles WHERE channel_id = ?1 AND operator_id = ?2').bind(
        channelId,
        operatorId,
      ),
      bumpCacheStatement(e.DB, channelId, now),
    ]);
    await audit(c, access, 'site.author_deleted', 'author_profile', operatorId);
    return c.body(null, 204);
  },
);
