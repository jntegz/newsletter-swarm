// Saved blocks to reuse in posts (flag snippets). A post links to a snippet with a `snippet` block
// (see ./snippets in @swarm/mail), so changing the snippet changes every post that uses it: on the
// website straight away, and in every email that starts sending afterwards. An email that has gone
// out keeps the version it started with, because a send freezes its render.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, toIso } from '@swarm/db';
import {
  bumpCacheStatement,
  refreshSnippetUsers,
  renderForWorkspace,
  snippetUsage,
} from '@swarm/engine';
import { DispatchDocumentSchema, newId } from '@swarm/domain';
import { MAX_SNIPPET_BYTES, RenderError, snippetContentProblem } from '@swarm/mail';
import { ApiError } from '@swarm/runtime';
import type { ChannelAccess } from '@swarm/db';
import { requireChannel } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { createRouter, env, type AppContext } from '../lib/context';
import { errors, jsonBody, ok } from '../lib/openapi';
import { checkBlockVisibility, engine, rawHtmlAllowed } from '../lib/send';
import { requireFlag } from '../lib/site';

export const snippets = createRouter();

const OFF = 'Snippets are not available for this publication.';
const channelParam = z.object({ channelId: z.string() });
const snippetParam = channelParam.extend({ snippetId: z.string() });

const SnippetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    content: DispatchDocumentSchema,
    updatedAt: z.string(),
  })
  .openapi('Snippet');
const SnippetDetailSchema = SnippetSchema.extend({
  usage: z.object({
    posts: z.number().int().openapi({ description: 'Posts that link to it' }),
    sentPosts: z.number().int().openapi({
      description:
        'Of those, how many are sent or sending: their emails keep the version they used',
    }),
    flowEmails: z.number().int().openapi({
      description: 'Flow emails that link to it: they change when the Flow is next published',
    }),
    pages: z.number().int().openapi({ description: 'Website pages that link to it' }),
    templates: z.number().int().openapi({ description: 'Templates that link to it' }),
  }),
}).openapi('SnippetDetail');
const SaveSnippetSchema = z
  .object({
    name: z.string().trim().min(1, 'Name it.').max(80),
    content: DispatchDocumentSchema,
  })
  .openapi('SaveSnippet');

interface Row {
  id: string;
  name: string;
  content_json: string;
  updated_at: number;
}

const toSnippet = (row: Row) => ({
  id: row.id,
  name: row.name,
  content: JSON.parse(row.content_json) as z.infer<typeof DispatchDocumentSchema>,
  updatedAt: toIso(row.updated_at),
});

async function guard(c: AppContext, channelId: string, role: 'viewer' | 'author' | 'editor') {
  const access = await requireChannel(c, channelId, role);
  await requireFlag(c, access, 'snippets', OFF);
  return access;
}

const invalidContent = (message: string) =>
  new ApiError('invalid_input', message, [{ path: 'content', message }]);

/**
 * The same checks a post's document gets, since a snippet ends up in posts: the email renderer
 * refuses unknown blocks and unsafe attributes, and raw HTML unless raw_html_mode is on.
 */
async function checkContent(
  c: AppContext,
  access: ChannelAccess,
  content: z.infer<typeof DispatchDocumentSchema>,
): Promise<string> {
  const problem = snippetContentProblem(content);
  if (problem) throw invalidContent(problem);
  const json = JSON.stringify(content);
  if (new TextEncoder().encode(json).length > MAX_SNIPPET_BYTES) {
    throw invalidContent('This snippet is too large. Move part of it into the post.');
  }
  await checkBlockVisibility(c, access, content);
  const db = env(c).DB;
  const channel = await first<{ name: string }>(
    db,
    'SELECT name FROM channels WHERE id = ?1',
    access.channelId,
  );
  try {
    await renderForWorkspace({
      db,
      workspaceId: access.workspaceId,
      channelId: access.channelId,
      channelName: channel?.name ?? '',
      accentColor: null,
      preheader: '',
      content,
      mediaOrigin: engine(c).mediaOrigin,
      allowHtmlBlocks: await rawHtmlAllowed(c, access),
    });
  } catch (error) {
    if (error instanceof RenderError) throw invalidContent(error.message);
    throw error;
  }
  return json;
}

snippets.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/snippets',
    tags: ['Dispatches'],
    summary: 'Saved blocks to reuse in posts',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(SnippetSchema), 'Snippets'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await guard(c, channelId, 'viewer');
    const rows = await all<Row>(
      env(c).DB,
      'SELECT id, name, content_json, updated_at FROM snippets WHERE channel_id = ?1 ORDER BY name LIMIT 200',
      channelId,
    );
    return c.json({ data: rows.map(toSnippet) }, 200);
  },
);

snippets.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/snippets',
    tags: ['Dispatches'],
    summary: 'Save a block to reuse',
    request: { params: channelParam, body: jsonBody(SaveSnippetSchema) },
    responses: {
      201: ok(SnippetSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await guard(c, channelId, 'author');
    const json = await checkContent(c, access, input.content);
    const now = Date.now();
    const row = await first<Row>(
      env(c).DB,
      `INSERT INTO snippets (id, channel_id, name, content_json, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) RETURNING id, name, content_json, updated_at`,
      newId('snippet', now),
      channelId,
      input.name,
      json,
      access.auth.operatorId,
      now,
    );
    await appendAudit(env(c).DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'snippet.saved',
      targetType: 'channel',
      targetId: channelId,
    });
    return c.json({ data: toSnippet(row!) }, 201);
  },
);

snippets.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/snippets/{snippetId}',
    tags: ['Dispatches'],
    summary: 'A saved block, and where it is used',
    description:
      'Readable while the snippets flag is off, so a post that links to one can still show it and detach it.',
    request: { params: snippetParam },
    responses: {
      200: ok(SnippetDetailSchema, 'The snippet'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, snippetId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const db = env(c).DB;
    const row = await first<Row>(
      db,
      'SELECT id, name, content_json, updated_at FROM snippets WHERE id = ?1 AND channel_id = ?2',
      snippetId,
      channelId,
    );
    if (!row) throw new ApiError('not_found', 'Snippet not found.');
    const usage = await snippetUsage(db, channelId, snippetId);
    return c.json({ data: { ...toSnippet(row), usage } }, 200);
  },
);

snippets.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/channels/{channelId}/snippets/{snippetId}',
    tags: ['Dispatches'],
    summary: 'Change a saved block',
    description:
      'Every post that links to it changes on the website, past posts included, and in emails that start sending from now on. Emails already sent stay as they were.',
    request: { params: snippetParam, body: jsonBody(SaveSnippetSchema) },
    responses: {
      200: ok(SnippetSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, snippetId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await guard(c, channelId, 'editor');
    const json = await checkContent(c, access, input.content);
    const db = env(c).DB;
    const now = Date.now();
    // In one batch, so the site never keeps serving pages cached from the old version.
    const [updated] = await db.batch<Row>([
      db
        .prepare(
          `UPDATE snippets SET name = ?1, content_json = ?2, updated_at = ?3
            WHERE id = ?4 AND channel_id = ?5
            RETURNING id, name, content_json, updated_at`,
        )
        .bind(input.name, json, now, snippetId, channelId),
      bumpCacheStatement(db, channelId, now),
    ]);
    const row = updated?.results[0];
    if (!row) throw new ApiError('not_found', 'Snippet not found.');
    await refreshSnippetUsers(db, channelId, snippetId);
    await appendAudit(db, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'snippet.changed',
      targetType: 'channel',
      targetId: channelId,
    });
    return c.json({ data: toSnippet(row) }, 200);
  },
);

snippets.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}/snippets/{snippetId}',
    tags: ['Dispatches'],
    summary: 'Delete a saved block',
    description:
      'Posts that link to it show nothing in its place, on the website and in emails that start sending from now on, and warn before a send. Copies inserted earlier and emails already sent are not affected.',
    request: { params: snippetParam },
    responses: {
      204: { description: 'Deleted' },
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, snippetId } = c.req.valid('param');
    await guard(c, channelId, 'editor');
    const db = env(c).DB;
    const [deleted] = await db.batch<{ id: string }>([
      db
        .prepare('DELETE FROM snippets WHERE id = ?1 AND channel_id = ?2 RETURNING id')
        .bind(snippetId, channelId),
      bumpCacheStatement(db, channelId, Date.now()),
    ]);
    if (!deleted?.results[0]) throw new ApiError('not_found', 'Snippet not found.');
    await refreshSnippetUsers(db, channelId, snippetId);
    return c.body(null, 204);
  },
);
