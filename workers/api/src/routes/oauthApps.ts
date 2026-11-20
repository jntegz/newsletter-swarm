// OAuth apps (Settings → Developers → OAuth apps) and the apps authorised on a workspace
// (Phase 7). An app is registered by one workspace; any workspace's admin may authorise it
// (routes/oauth.ts). Everything here needs the admin role and is audited. Contract: docs/oauth.md.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, run, sha256Hex, toIso } from '@swarm/db';
import {
  CreateOAuthAppSchema,
  OAUTH_CLIENT_ID_PREFIX,
  OAUTH_CLIENT_SECRET_PREFIX,
  OAuthAppSchema,
  OAuthAppWithSecretSchema,
  OAuthGrantSchema,
  PLAN_LIMITS,
  UpdateOAuthAppSchema,
  homepageUrlProblem,
  idPattern,
  newId,
  redirectUriProblem,
  type OAuthApp,
  type OAuthGrant,
  type Plan,
} from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import { teammateEmailSql } from '@swarm/engine';
import { isLocal } from '../env';
import { requireWorkspace } from '../lib/access';
import { createRouter, env, type AppContext } from '../lib/context';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { audit } from '../lib/site';
import { NO_STORE } from '../v2/idempotency';
import { base62, effectiveScopes, revokeGrant, revokeGrantStatements } from '../v2/oauth';

export const oauthApps = createRouter();

const workspaceParam = idParam('workspaceId', idPattern('workspace'));
const appParams = workspaceParam.extend({
  appId: z
    .string()
    .regex(idPattern('oauthApp'))
    .openapi({ param: { name: 'appId', in: 'path' } }),
});
const grantParams = workspaceParam.extend({
  grantId: z
    .string()
    .regex(idPattern('oauthGrant'))
    .openapi({ param: { name: 'grantId', in: 'path' } }),
});

export interface OAuthAppRow {
  id: string;
  workspace_id: string;
  name: string;
  client_id: string;
  client_secret_hash: string | null;
  redirect_uris_json: string;
  scopes_json: string;
  homepage_url: string | null;
  /** Set for a Client ID Metadata Document client's row (docs/oauth.md); null when registered. */
  metadata_url: string | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

const toApp = (row: OAuthAppRow): OAuthApp => ({
  id: row.id,
  workspaceId: row.workspace_id,
  name: row.name,
  clientId: row.client_id,
  clientType: row.client_secret_hash ? 'confidential' : 'public',
  redirectUris: JSON.parse(row.redirect_uris_json) as string[],
  scopes: JSON.parse(row.scopes_json) as OAuthApp['scopes'],
  homepageUrl: row.homepage_url,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

/** Refuses redirect URIs that could not be matched exactly or are not https. */
function checkRedirectUris(c: AppContext, uris: string[]): void {
  const allowHttp = isLocal(env(c));
  const details = uris.flatMap((uri, i) => {
    const problem = redirectUriProblem(uri, allowHttp);
    return problem ? [{ path: `redirectUris.${i}`, message: problem }] : [];
  });
  if (details.length) throw new ApiError('invalid_input', details[0]!.message, details);
}

/** Refuses a homepage the consent page could not safely link to. */
function checkHomepage(c: AppContext, uri: string | null | undefined): void {
  const problem = uri ? homepageUrlProblem(uri, isLocal(env(c))) : null;
  if (problem)
    throw new ApiError('invalid_input', problem, [{ path: 'homepageUrl', message: problem }]);
}

async function newSecret(): Promise<{ secret: string; hash: string }> {
  const secret = `${OAUTH_CLIENT_SECRET_PREFIX}${base62(40)}`;
  return { secret, hash: await sha256Hex(secret) };
}

/** The workspace's own, unrevoked app; any other is not found. */
async function loadApp(c: AppContext, workspaceId: string, appId: string): Promise<OAuthAppRow> {
  const row = await first<OAuthAppRow>(
    env(c).DB,
    // metadata_url rows belong to Client ID Metadata Document clients: not registered here.
    'SELECT * FROM oauth_apps WHERE id = ?1 AND workspace_id = ?2 AND revoked_at IS NULL AND metadata_url IS NULL',
    appId,
    workspaceId,
  );
  if (!row) throw new ApiError('not_found', 'OAuth app not found.');
  return row;
}

oauthApps.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/oauth-apps',
    tags: ['OAuth apps'],
    summary: 'OAuth apps this workspace registered',
    request: { params: workspaceParam },
    responses: {
      200: ok(z.array(OAuthAppSchema), 'Apps, newest first'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await requireWorkspace(c, workspaceId, 'admin');
    const rows = await all<OAuthAppRow>(
      env(c).DB,
      `SELECT * FROM oauth_apps WHERE workspace_id = ?1 AND revoked_at IS NULL AND metadata_url IS NULL
        ORDER BY created_at DESC`,
      workspaceId,
    );
    return c.json({ data: rows.map(toApp) }, 200);
  },
);

oauthApps.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/oauth-apps',
    tags: ['OAuth apps'],
    summary: 'Register an OAuth app',
    description:
      'A confidential app gets a client secret, shown once in this response; a public app (a browser or mobile app) has none and relies on PKCE alone. Limited per plan.',
    request: { params: workspaceParam, body: jsonBody(CreateOAuthAppSchema) },
    responses: {
      201: ok(OAuthAppWithSecretSchema, 'Registered'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireWorkspace(c, workspaceId, 'admin');
    checkRedirectUris(c, input.redirectUris);
    checkHomepage(c, input.homepageUrl);
    const db = env(c).DB;
    const workspace = await first<{ plan: Plan }>(
      db,
      'SELECT plan FROM workspaces WHERE id = ?1',
      workspaceId,
    );
    const limit = PLAN_LIMITS[workspace!.plan].oauthApps;
    const now = Date.now();
    const id = newId('oauthApp', now);
    const secret = input.clientType === 'confidential' ? await newSecret() : null;
    // The limit is checked in the insert itself, so apps registered at once can't pass it together.
    const added = await first<{ id: string }>(
      db,
      `INSERT INTO oauth_apps (id, workspace_id, name, client_id, client_secret_hash, redirect_uris_json, scopes_json,
         homepage_url, created_by, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10
        WHERE (SELECT count(*) FROM oauth_apps WHERE workspace_id = ?2 AND revoked_at IS NULL
                 AND metadata_url IS NULL) < ?11
       RETURNING id`,
      id,
      workspaceId,
      input.name,
      `${OAUTH_CLIENT_ID_PREFIX}${base62(24)}`,
      secret?.hash ?? null,
      JSON.stringify(input.redirectUris),
      JSON.stringify(input.scopes),
      input.homepageUrl ?? null,
      access.auth.operatorId,
      now,
      limit,
    );
    if (!added) {
      throw new ApiError(
        'conflict',
        `Your plan allows ${limit} OAuth ${limit === 1 ? 'app' : 'apps'}. Revoke one first.`,
      );
    }
    await audit(c, access, 'oauth_app.created', 'oauth_app', id, {
      clientType: input.clientType,
      scopes: input.scopes,
    });
    const row = await loadApp(c, workspaceId, id);
    return c.json(
      { data: { app: toApp(row), clientSecret: secret?.secret ?? null } },
      201,
      NO_STORE,
    );
  },
);

oauthApps.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/workspaces/{workspaceId}/oauth-apps/{appId}',
    tags: ['OAuth apps'],
    summary: 'Change an OAuth app',
    description:
      'Fewer scopes apply at once to every token already issued. More scopes reach existing grants only after the app asks again. A new name, redirect URI or homepage, or more scopes, return the app’s App Directory listing to draft.',
    request: { params: appParams, body: jsonBody(UpdateOAuthAppSchema) },
    responses: {
      200: ok(OAuthAppSchema, 'Changed'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, appId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireWorkspace(c, workspaceId, 'admin');
    const row = await loadApp(c, workspaceId, appId);
    if (input.redirectUris) checkRedirectUris(c, input.redirectUris);
    checkHomepage(c, input.homepageUrl);
    const next = {
      name: input.name ?? row.name,
      redirectUris: input.redirectUris
        ? JSON.stringify(input.redirectUris)
        : row.redirect_uris_json,
      scopes: input.scopes ? JSON.stringify(input.scopes) : row.scopes_json,
      homepageUrl: input.homepageUrl === undefined ? row.homepage_url : input.homepageUrl,
    };
    // The consent page's Verified pill vouches for what staff reviewed (docs/app-directory.md):
    // a new name, redirect URI or homepage, or a wider scope, sends the listing back to draft.
    const current = new Set(JSON.parse(row.scopes_json) as string[]);
    const reviewedChanged =
      next.name !== row.name ||
      next.redirectUris !== row.redirect_uris_json ||
      next.homepageUrl !== row.homepage_url ||
      (input.scopes ?? []).some((scope) => !current.has(scope));
    const db = env(c).DB;
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          `UPDATE oauth_apps SET name = ?1, redirect_uris_json = ?2, scopes_json = ?3, homepage_url = ?4,
             updated_at = ?5
            WHERE id = ?6`,
        )
        .bind(next.name, next.redirectUris, next.scopes, next.homepageUrl, now, appId),
      ...(reviewedChanged
        ? [
            db
              .prepare(
                `UPDATE app_listings SET status = 'draft', updated_at = ?1
                  WHERE app_id = ?2 AND status IN ('submitted', 'approved')`,
              )
              .bind(now, appId),
          ]
        : []),
    ]);
    await audit(c, access, 'oauth_app.updated', 'oauth_app', appId, {
      fields: Object.keys(input),
      ...(reviewedChanged ? { listingReturnedToDraft: true } : {}),
    });
    return c.json({ data: toApp(await loadApp(c, workspaceId, appId)) }, 200);
  },
);

oauthApps.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/oauth-apps/{appId}/rotate-secret',
    tags: ['OAuth apps'],
    summary: 'Replace a confidential app’s client secret',
    description:
      'The new secret is shown once. The old one stops working immediately; tokens already issued keep working.',
    request: { params: appParams },
    responses: {
      200: ok(OAuthAppWithSecretSchema, 'Rotated'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId, appId } = c.req.valid('param');
    const access = await requireWorkspace(c, workspaceId, 'admin');
    const row = await loadApp(c, workspaceId, appId);
    if (!row.client_secret_hash) {
      throw new ApiError('conflict', 'A public app has no client secret.');
    }
    const secret = await newSecret();
    await run(
      env(c).DB,
      'UPDATE oauth_apps SET client_secret_hash = ?1, updated_at = ?2 WHERE id = ?3',
      secret.hash,
      Date.now(),
      appId,
    );
    await audit(c, access, 'oauth_app.secret_rotated', 'oauth_app', appId);
    const fresh = await loadApp(c, workspaceId, appId);
    return c.json({ data: { app: toApp(fresh), clientSecret: secret.secret } }, 200, NO_STORE);
  },
);

oauthApps.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/workspaces/{workspaceId}/oauth-apps/{appId}',
    tags: ['OAuth apps'],
    summary: 'Revoke an OAuth app',
    description:
      'Every workspace that authorised it loses access at once: its grants and tokens are revoked. It cannot be undone.',
    request: { params: appParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { workspaceId, appId } = c.req.valid('param');
    const access = await requireWorkspace(c, workspaceId, 'admin');
    await loadApp(c, workspaceId, appId);
    const db = env(c).DB;
    const now = Date.now();
    const grants = await all<{ id: string }>(
      db,
      'SELECT id FROM oauth_grants WHERE app_id = ?1 AND revoked_at IS NULL',
      appId,
    );
    await db.batch([
      db
        .prepare('UPDATE oauth_apps SET revoked_at = ?1, updated_at = ?1 WHERE id = ?2')
        .bind(now, appId),
      ...grants.flatMap((grant) => revokeGrantStatements(db, grant.id, now)),
    ]);
    await audit(c, access, 'oauth_app.revoked', 'oauth_app', appId, { grants: grants.length });
    return c.body(null, 204);
  },
);

// ---------------------------------------------------------------------------------------------
// Apps authorised on this workspace

interface GrantRow {
  id: string;
  app_id: string;
  app_name: string;
  homepage_url: string | null;
  metadata_url: string | null;
  resource: OAuthGrant['resource'];
  channel_ids_json: string | null;
  scopes_json: string;
  app_scopes: string;
  operator_email: string | null;
  created_at: number;
  last_used_at: number | null;
}

const toGrant = (row: GrantRow): OAuthGrant => ({
  id: row.id,
  app: {
    id: row.app_id,
    name: row.app_name,
    homepageUrl: row.homepage_url,
    clientUrl: row.metadata_url,
  },
  resource: row.resource,
  channelIds: row.channel_ids_json ? (JSON.parse(row.channel_ids_json) as string[]) : null,
  scopes: effectiveScopes(row.scopes_json, row.app_scopes),
  authorisedBy: row.operator_email,
  createdAt: toIso(row.created_at),
  lastUsedAt: row.last_used_at === null ? null : toIso(row.last_used_at),
});

oauthApps.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/oauth-grants',
    tags: ['OAuth apps'],
    summary: 'Apps authorised to use this workspace',
    request: { params: workspaceParam },
    responses: {
      200: ok(z.array(OAuthGrantSchema), 'Active grants, newest first'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await requireWorkspace(c, workspaceId, 'admin');
    const rows = await all<GrantRow>(
      env(c).DB,
      `SELECT g.id, g.app_id, a.name AS app_name, a.homepage_url, a.metadata_url, g.resource,
              g.channel_ids_json, g.scopes_json,
              a.scopes_json AS app_scopes, ${teammateEmailSql('o', 'g.workspace_id')} AS operator_email, g.created_at,
              (SELECT max(t.last_used_at) FROM oauth_tokens t WHERE t.grant_id = g.id) AS last_used_at
         FROM oauth_grants g
         JOIN oauth_apps a ON a.id = g.app_id
         LEFT JOIN operators o ON o.id = g.operator_id
        WHERE g.workspace_id = ?1 AND g.revoked_at IS NULL AND g.code_consumed_at IS NOT NULL
          AND a.revoked_at IS NULL
        ORDER BY g.created_at DESC`,
      workspaceId,
    );
    return c.json({ data: rows.map(toGrant) }, 200);
  },
);

oauthApps.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/workspaces/{workspaceId}/oauth-grants/{grantId}',
    tags: ['OAuth apps'],
    summary: 'Revoke an app’s access to this workspace',
    description: 'Revokes the grant and every token issued from it.',
    request: { params: grantParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { workspaceId, grantId } = c.req.valid('param');
    const access = await requireWorkspace(c, workspaceId, 'admin');
    const db = env(c).DB;
    const grant = await first<{ app_id: string }>(
      db,
      'SELECT app_id FROM oauth_grants WHERE id = ?1 AND workspace_id = ?2 AND revoked_at IS NULL',
      grantId,
      workspaceId,
    );
    if (!grant) throw new ApiError('not_found', 'Authorised app not found.');
    await revokeGrant(db, grantId);
    await audit(c, access, 'oauth_grant.revoked', 'oauth_grant', grantId, {
      appId: grant.app_id,
    });
    return c.body(null, 204);
  },
);
