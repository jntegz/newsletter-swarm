// Applications (flag applications; docs/applications.md): connecting Shorthop, and the short links
// a writer makes while writing. The key stays here: browsers only ever see its last four characters.
import { createRoute } from '@hono/zod-openapi';
import { first, run } from '@swarm/db';
import {
  ConnectShorthopSchema,
  CreateShortLinkSchema,
  SLUG_FORMAT_DEFAULT,
  ShortLinkSchema,
  ShorthopConnectionSchema,
  ShorthopStatusSchema,
  UpdateShorthopSchema,
  idPattern,
  newId,
  renderSlug,
  type ShorthopConnection,
} from '@swarm/domain';
import {
  ShorthopError,
  checkShorthop,
  createShorthopLink,
  normalizeBaseUrl,
  randomSlugPart,
  shorthopUrlProblem,
  VAULT_HELD_KEY,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { vaultValue } from '@swarm/vault';
import { requireChannel, requireWorkspace } from '../lib/access';
import { apiVault, credentialFetch, credentialOf } from '../lib/vault';
import { appendAudit } from '../lib/audit';
import { flagOn } from '../lib/copilot';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';

export const applications = createRouter();

const workspaceParam = idParam('workspaceId', idPattern('workspace'));
const channelParam = idParam('channelId', idPattern('channel'));

let injectedFetch: typeof fetch | undefined;

/** Tests talk to a fake Shorthop. */
export function useApplicationsFetchForTests(fetcher: typeof fetch | undefined): void {
  injectedFetch = fetcher;
}

interface ConnectionRow {
  id: string;
  workspace_id: string;
  base_url: string;
  key_enc: string;
  last4: string;
  slug_format: string;
  domain: string | null;
  updated_at: number;
}

const loadConnection = (db: D1Database, workspaceId: string) =>
  first<ConnectionRow>(
    db,
    `SELECT id, workspace_id, base_url, key_enc, last4, slug_format, domain, updated_at
       FROM app_connections WHERE workspace_id = ?1 AND app = 'shorthop'`,
    workspaceId,
  );

const toConnection = (row: ConnectionRow | null): ShorthopConnection =>
  row
    ? {
        connected: true,
        baseUrl: row.base_url,
        last4: row.last4,
        slugFormat: row.slug_format,
        domain: row.domain,
        updatedAt: new Date(row.updated_at).toISOString(),
      }
    : {
        connected: false,
        baseUrl: null,
        last4: null,
        slugFormat: SLUG_FORMAT_DEFAULT,
        domain: null,
        updatedAt: null,
      };

const requireFlag = async (c: AppContext, scope: { workspaceId: string; channelId?: string }) => {
  if (!(await flagOn(c, 'applications', scope))) {
    throw new ApiError('feature_disabled', 'Applications are not turned on for this workspace.');
  }
};

/** A key just typed is checked directly; a saved one is used through the vault (`via`). */
const target = (baseUrl: string, apiKey: string, via?: typeof fetch) => ({
  fetch:
    via ?? injectedFetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)),
  baseUrl,
  apiKey,
});

/** Shorthop's answer as an API error: a wrong key is the writer's to fix, an outage isn't. */
function toApiError(error: unknown, path?: string): unknown {
  if (!(error instanceof ShorthopError)) return error;
  if (error.kind === 'unavailable') return new ApiError('unavailable', error.message);
  return new ApiError(
    'invalid_input',
    error.message,
    path ? [{ path, message: error.message }] : undefined,
  );
}

const audit = (
  c: AppContext,
  workspaceId: string,
  actorId: string,
  action: string,
  metadata: Record<string, unknown>,
) =>
  appendAudit(env(c).DB, {
    workspaceId,
    actorId,
    action,
    targetType: 'app_connection',
    targetId: 'shorthop',
    metadata,
    ipPrefix: ipPrefix(clientIp(c)),
  });

applications.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/applications/shorthop',
    tags: ['Applications'],
    summary: 'The Shorthop connection',
    request: { params: workspaceParam },
    responses: {
      200: ok(ShorthopConnectionSchema, 'Connection'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await requireWorkspace(c, workspaceId, 'admin');
    await requireFlag(c, { workspaceId });
    return c.json({ data: toConnection(await loadConnection(env(c).DB, workspaceId)) }, 200);
  },
);

applications.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/workspaces/{workspaceId}/applications/shorthop',
    tags: ['Applications'],
    summary: 'Connect Shorthop',
    description:
      'Checks the address and the key with Shorthop, then stores the key sealed. A new address forgets the links made through the old one.',
    request: { params: workspaceParam, body: jsonBody(ConnectShorthopSchema) },
    responses: {
      200: ok(ShorthopConnectionSchema, 'Connected'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireWorkspace(c, workspaceId, 'admin');
    await requireFlag(c, { workspaceId });
    const e = env(c);
    const problem = shorthopUrlProblem(input.baseUrl, e.ENVIRONMENT);
    if (problem) {
      throw new ApiError('invalid_input', problem, [{ path: 'baseUrl', message: problem }]);
    }
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    try {
      await checkShorthop(target(baseUrl, input.apiKey));
    } catch (error) {
      throw toApiError(error, 'apiKey');
    }
    const now = Date.now();
    const current = await loadConnection(e.DB, workspaceId);
    // The key is sealed by the vault for this row; the upsert keeps an existing row's id.
    const connectionId = current?.id ?? newId('appConnection', now);
    if (current && current.base_url !== baseUrl) {
      await run(e.DB, 'DELETE FROM app_short_links WHERE connection_id = ?1', current.id);
    }
    await run(
      e.DB,
      `INSERT INTO app_connections (id, workspace_id, app, base_url, key_enc, last4, slug_format, domain,
         created_by, created_at, updated_at)
       VALUES (?1, ?2, 'shorthop', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
       ON CONFLICT (workspace_id, app) DO UPDATE SET base_url = excluded.base_url,
         key_enc = excluded.key_enc, last4 = excluded.last4, slug_format = excluded.slug_format,
         domain = excluded.domain, updated_at = excluded.updated_at`,
      connectionId,
      workspaceId,
      baseUrl,
      vaultValue(
        await apiVault(c).sealCredential(credentialOf(c), {
          ref: { kind: 'shorthop', workspaceId, connectionId },
          plaintext: input.apiKey,
        }),
      ),
      input.apiKey.slice(-4),
      input.slugFormat,
      input.domain ?? null,
      access.auth.operatorId,
      now,
    );
    await audit(c, workspaceId, access.auth.operatorId, 'application.connected', {
      app: 'shorthop',
      baseUrl,
    });
    return c.json({ data: toConnection(await loadConnection(e.DB, workspaceId)) }, 200);
  },
);

applications.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/workspaces/{workspaceId}/applications/shorthop',
    tags: ['Applications'],
    summary: 'Change the slug format or the short domain',
    description: 'Only for links made from now on: links already made keep their address.',
    request: { params: workspaceParam, body: jsonBody(UpdateShorthopSchema) },
    responses: {
      200: ok(ShorthopConnectionSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireWorkspace(c, workspaceId, 'admin');
    await requireFlag(c, { workspaceId });
    const e = env(c);
    const current = await loadConnection(e.DB, workspaceId);
    if (!current) throw new ApiError('not_found', 'Shorthop isn’t connected.');
    await run(
      e.DB,
      `UPDATE app_connections SET slug_format = ?1, domain = ?2, updated_at = ?3 WHERE id = ?4`,
      input.slugFormat ?? current.slug_format,
      input.domain === undefined ? current.domain : input.domain,
      Date.now(),
      current.id,
    );
    await audit(c, workspaceId, access.auth.operatorId, 'application.updated', {
      app: 'shorthop',
      fields: Object.keys(input),
    });
    return c.json({ data: toConnection(await loadConnection(e.DB, workspaceId)) }, 200);
  },
);

applications.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/workspaces/{workspaceId}/applications/shorthop',
    tags: ['Applications'],
    summary: 'Disconnect Shorthop',
    description: 'Forgets the key. Links already in posts keep working: they live in Shorthop.',
    request: { params: workspaceParam },
    responses: {
      204: noContent,
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const access = await requireWorkspace(c, workspaceId, 'admin');
    await run(
      env(c).DB,
      `DELETE FROM app_connections WHERE workspace_id = ?1 AND app = 'shorthop'`,
      workspaceId,
    );
    await audit(c, workspaceId, access.auth.operatorId, 'application.disconnected', {
      app: 'shorthop',
    });
    return c.body(null, 204);
  },
);

applications.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/applications/shorthop',
    tags: ['Applications'],
    summary: 'Whether writers here can shorten links',
    request: { params: channelParam },
    responses: {
      200: ok(ShorthopStatusSchema, 'Status'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'viewer');
    const scope = { workspaceId: access.workspaceId, channelId };
    const row = (await flagOn(c, 'applications', scope))
      ? await loadConnection(env(c).DB, access.workspaceId)
      : null;
    return c.json({ data: { connected: !!row, slugFormat: row?.slug_format ?? null } }, 200);
  },
);

applications.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/applications/shorthop/links',
    tags: ['Applications'],
    summary: 'Shorten a web address',
    description:
      'Makes a Shorthop link with the workspace’s slug format. The same address in the same post gets the same link.',
    request: { params: channelParam, body: jsonBody(CreateShortLinkSchema) },
    responses: {
      200: ok(ShortLinkSchema, 'The link'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'author');
    await requireFlag(c, { workspaceId: access.workspaceId, channelId });
    const e = env(c);
    const connection = await loadConnection(e.DB, access.workspaceId);
    if (!connection) throw new ApiError('not_found', 'Shorthop isn’t connected.');
    const { protocol, origin } = new URL(input.url);
    if (protocol !== 'https:' && protocol !== 'http:') {
      throw new ApiError('invalid_input', 'Only web addresses can be shortened.');
    }
    // Already a short link from this Shorthop: nothing to do.
    const host = new URL(input.url).hostname;
    const known =
      origin === connection.base_url ||
      host === connection.domain ||
      // The short domain can be Shorthop's primary one, which Swarm isn't told: a link it made.
      (await first(
        e.DB,
        'SELECT 1 AS ok FROM app_short_links WHERE connection_id = ?1 AND short_url = ?2 LIMIT 1',
        connection.id,
        input.url,
      )) !== null;
    if (known) return c.json({ data: { url: input.url, shortUrl: input.url } }, 200);

    let subject = '';
    if (input.dispatchId) {
      const post = await first<{ subject: string }>(
        e.DB,
        'SELECT subject FROM dispatches WHERE id = ?1 AND channel_id = ?2',
        input.dispatchId,
        channelId,
      );
      if (!post) throw new ApiError('not_found', 'Post not found.');
      subject = post.subject;
    }
    const postId = input.dispatchId ?? '';
    const existing = await first<{ short_url: string }>(
      e.DB,
      'SELECT short_url FROM app_short_links WHERE connection_id = ?1 AND post_id = ?2 AND url = ?3',
      connection.id,
      postId,
      input.url,
    );
    if (existing) return c.json({ data: { url: input.url, shortUrl: existing.short_url } }, 200);

    // The key stays in the vault, which attaches it to the request (Shorthop's own base URL).
    const shorthopFetch = credentialFetch(c, { kind: 'shorthop', connectionId: connection.id });
    const channel = await first<{ slug: string }>(
      e.DB,
      'SELECT slug FROM channels WHERE id = ?1',
      channelId,
    );
    const now = Date.now();
    let shortUrl: string;
    try {
      shortUrl = await createShorthopLink(
        target(connection.base_url, VAULT_HELD_KEY, shorthopFetch),
        {
          url: input.url,
          slug: renderSlug(connection.slug_format, {
            publication: channel?.slug ?? '',
            post: subject,
            url: input.url,
            now,
            random: randomSlugPart(),
          }),
          domain: connection.domain,
          title: subject,
          tags: ['swarm', ...(channel?.slug ? [channel.slug] : [])],
        },
      );
    } catch (error) {
      throw toApiError(error);
    }
    await run(
      e.DB,
      `INSERT OR IGNORE INTO app_short_links (connection_id, post_id, url, short_url, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
      connection.id,
      postId,
      input.url,
      shortUrl,
      now,
    );
    return c.json({ data: { url: input.url, shortUrl } }, 200);
  },
);
