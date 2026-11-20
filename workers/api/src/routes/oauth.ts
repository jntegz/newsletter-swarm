// OAuth 2.0 for third-party apps (Phase 7): authorization code with PKCE (S256 only, required
// for every client), refresh-token rotation with family revocation, RFC 7009 revocation and RFC
// 8414 metadata. Phase 8 (OAuth for MCP): RFC 8707 resource indicators bind every grant to /v2
// or /mcp, and public clients may identify themselves with a Client ID Metadata Document URL
// instead of a registered client id (lib/oauthClients.ts). Contract: docs/oauth.md.
//
//   GET  /oauth/authorize        checks the request, then hands the browser to the dashboard's
//                                consent page (/oauth/consent). Changes nothing.
//   GET  /api/v1/oauth/consent   what the consent page shows (session).
//   POST /api/v1/oauth/consent   the operator's decision (session + CSRF): creates the grant and
//                                its single-use code, returns where to send the browser.
//   POST /oauth/token            code and refresh exchanges (form-encoded, client auth).
//   POST /oauth/revoke           RFC 7009.
//
// /oauth/token and /oauth/revoke are called by the app's server, not a browser with our cookie,
// so they sit outside /api: no session is loaded and the CSRF check does not apply. They
// authenticate the client instead, and never read cookies.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, run, sha256Hex } from '@swarm/db';
import {
  API_SCOPES,
  AuthorizeParamsSchema,
  ConsentDecisionSchema,
  ConsentInfoSchema,
  ConsentResultSchema,
  OAUTH_CODE_TTL_SECONDS,
  OAUTH_METADATA_CLIENT_PREFIX,
  SCOPE_LABELS,
  clientMetadataUrlProblem,
  clientRedirectMatches,
  homepageUrlProblem,
  isClientMetadataUrl,
  isLoopbackRedirect,
  newId,
  oauthResourceFor,
  type ApiScope,
  type AuthorizeParams,
  type ClientMetadata,
  type OAuthResource,
} from '@swarm/domain';
import { escapeHtml } from '@swarm/mail';
import { ApiError } from '@swarm/runtime';
import { base64UrlEncode } from '@swarm/tokens';
import { isLocal } from '../env';
import { requireAuth, requireWorkspace } from '../lib/access';
import { createRouter, env, type AppContext } from '../lib/context';
import { randomToken } from '../lib/crypto';
import { loadClientDocument } from '../lib/oauthClients';
import { errors, jsonBody, ok } from '../lib/openapi';
import { audit } from '../lib/site';
import { noticeTeam, type TeamNotice } from '../lib/team-notice';
import { LIVE_GRANT_SQL, base62, effectiveScopes, issueTokens, revokeGrant } from '../v2/oauth';
import type { OAuthAppRow } from './oauthApps';

export const oauth = createRouter();

/** RFC 7636: the S256 challenge is base64url(sha256(verifier)), always 43 characters. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 §4.1: 43 to 128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

const issuer = (c: AppContext) => env(c).APP_ORIGIN;

/** Who is asking: an app registered in a workspace, or a Client ID Metadata Document client. */
type Client =
  | { kind: 'registered'; app: OAuthAppRow & { workspace_name: string } }
  | { kind: 'metadata'; url: string; client: ClientMetadata };

type Checked =
  /** Unknown client or unregistered redirect URI: shown as an error, never redirected. */
  | { kind: 'fatal'; message: string }
  /**
   * A metadata document client at /oauth/authorize: its document is fetched only on the consent
   * step, for a signed-in operator, so the request is handed on unchecked (to Swarm's own page).
   */
  | { kind: 'deferred' }
  /** Anything else: sent back to the app's redirect URI as RFC 6749 §4.1.2.1 error params. */
  | { kind: 'error'; redirectUri: string; state: string | null; error: string; description: string }
  | {
      kind: 'ok';
      client: Client;
      redirectUri: string;
      state: string;
      scopes: ApiScope[];
      codeChallenge: string;
      resource: OAuthResource;
    };

/** The registered app or the metadata document client, or why the request can't name it. */
async function resolveClient(
  c: AppContext,
  params: AuthorizeParams,
  operatorId: string | null,
): Promise<Client | Extract<Checked, { kind: 'fatal' | 'deferred' }>> {
  if (isClientMetadataUrl(params.client_id)) {
    const problem = clientMetadataUrlProblem(params.client_id);
    if (problem) return { kind: 'fatal', message: problem };
    if (operatorId === null) return { kind: 'deferred' };
    const loaded = await loadClientDocument(c, params.client_id, operatorId);
    if (!loaded.ok) return { kind: 'fatal', message: loaded.error };
    if (!clientRedirectMatches(loaded.client.redirectUris, params.redirect_uri)) {
      return {
        kind: 'fatal',
        message: 'This app asked to return to an address its client metadata does not list.',
      };
    }
    return { kind: 'metadata', url: params.client_id, client: loaded.client };
  }
  const app = await first<OAuthAppRow & { workspace_name: string }>(
    env(c).DB,
    `SELECT a.*, w.name AS workspace_name FROM oauth_apps a JOIN workspaces w ON w.id = a.workspace_id
      WHERE a.client_id = ?1 AND a.revoked_at IS NULL AND a.metadata_url IS NULL`,
    params.client_id,
  );
  if (!app) return { kind: 'fatal', message: 'This app is not registered, or it was revoked.' };
  const registered = JSON.parse(app.redirect_uris_json) as string[];
  if (!registered.includes(params.redirect_uri)) {
    return {
      kind: 'fatal',
      message: 'This app asked to return to an address it did not register.',
    };
  }
  return { kind: 'registered', app };
}

/**
 * The one check of an authorization request, shared by /oauth/authorize (no operator yet) and
 * the consent step (the signed-in operator).
 */
async function checkAuthorizeRequest(
  c: AppContext,
  params: AuthorizeParams,
  operatorId: string | null,
): Promise<Checked> {
  const client = await resolveClient(c, params, operatorId);
  if (client.kind === 'fatal' || client.kind === 'deferred') return client;
  const redirectUri = params.redirect_uri;
  const state = params.state ?? null;
  const fail = (error: string, description: string): Checked => ({
    kind: 'error',
    redirectUri,
    state,
    error,
    description,
  });
  if (params.response_type !== 'code') {
    return fail('unsupported_response_type', 'Only response_type=code is supported.');
  }
  if (!params.code_challenge)
    return fail('invalid_request', 'PKCE is required: send code_challenge.');
  if (params.code_challenge_method !== 'S256') {
    return fail('invalid_request', 'code_challenge_method must be S256.');
  }
  if (!CHALLENGE.test(params.code_challenge)) {
    return fail('invalid_request', 'code_challenge is not a base64url SHA-256 value.');
  }
  if (!state) return fail('invalid_request', 'Send a state value.');
  // RFC 8707: no resource means the public API, as before resource indicators.
  const resource =
    params.resource === undefined ? 'v2' : oauthResourceFor(params.resource, issuer(c));
  if (!resource) {
    return fail('invalid_target', 'resource must be this server’s /v2 or /mcp address.');
  }
  const requested = [...new Set((params.scope ?? '').split(' ').filter(Boolean))];
  // A metadata document client may ask for any scope; the operator decides on the consent page.
  const allowed = new Set<string>(
    client.kind === 'registered' ? (JSON.parse(client.app.scopes_json) as string[]) : API_SCOPES,
  );
  if (!requested.length) return fail('invalid_scope', 'Ask for at least one scope.');
  const beyond = requested.filter(
    (scope) => !allowed.has(scope) || !(API_SCOPES as readonly string[]).includes(scope),
  );
  if (beyond.length) {
    return fail('invalid_scope', `This app may not ask for: ${beyond.join(' ')}.`);
  }
  return {
    kind: 'ok',
    client,
    redirectUri,
    state,
    scopes: (requested as ApiScope[]).sort(),
    codeChallenge: params.code_challenge,
    resource,
  };
}

/**
 * Whether a grant for `workspaceId` may reach /v2 directly, where nothing is held: only an app
 * the workspace registered itself, or one platform staff reviewed for the App Directory. Any other
 * app (a metadata document client, or an app another workspace registered under a name of its
 * choosing) gets the MCP server only, so a persuaded admin can't hand it unheld sends, deletes
 * and webhook endpoints in one click.
 */
async function mayUseDirectApi(
  c: AppContext,
  client: Client,
  workspaceId: string,
): Promise<boolean> {
  if (client.kind !== 'registered') return false;
  if (client.app.workspace_id === workspaceId) return true;
  return !!(await first<{ id: string }>(
    env(c).DB,
    "SELECT id FROM app_listings WHERE app_id = ?1 AND status = 'approved' LIMIT 1",
    client.app.id,
  ));
}

/** The oauth_apps row a grant hangs off: the registered app, or the workspace's row for a URL. */
async function grantAppId(
  c: AppContext,
  client: Client,
  workspaceId: string,
  operatorId: string,
  now: number,
): Promise<string> {
  if (client.kind === 'registered') return client.app.id;
  const row = await first<{ id: string }>(
    env(c).DB,
    `INSERT INTO oauth_apps (id, workspace_id, name, client_id, client_secret_hash, redirect_uris_json,
       scopes_json, homepage_url, created_by, created_at, updated_at, metadata_url)
     VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?9, ?10)
     ON CONFLICT (workspace_id, metadata_url) WHERE metadata_url IS NOT NULL DO UPDATE SET
       name = excluded.name, redirect_uris_json = excluded.redirect_uris_json,
       scopes_json = excluded.scopes_json, homepage_url = excluded.homepage_url,
       updated_at = excluded.updated_at
     RETURNING id`,
    newId('oauthApp', now),
    workspaceId,
    client.client.name,
    `${OAUTH_METADATA_CLIENT_PREFIX}${base62(24)}`,
    JSON.stringify(client.client.redirectUris),
    JSON.stringify(API_SCOPES),
    client.client.clientUri,
    operatorId,
    now,
    client.url,
  );
  return row!.id;
}

/** The app's redirect URI with response params added (its own query is kept). */
function backToApp(c: AppContext, redirectUri: string, params: Record<string, string | null>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  // RFC 9207: tells the app which server answered, against mix-up attacks.
  url.searchParams.set('iss', issuer(c));
  return url.toString();
}

const errorRedirect = (c: AppContext, checked: Extract<Checked, { kind: 'error' }>) =>
  backToApp(c, checked.redirectUri, {
    error: checked.error,
    error_description: checked.description,
    state: checked.state,
  });

function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>This sign-in link does not work</title></head>
<body style="margin:0;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;color:#0f0f12;background:#fbfbfd">
<main style="max-width:480px;margin:64px auto;padding:0 16px">
<h1 style="font-size:22px;letter-spacing:-0.02em">This sign-in link does not work</h1>
<p style="font-size:15px;line-height:1.55;color:#3a3a44">${escapeHtml(message)}</p>
<p style="font-size:13px;line-height:1.5;color:#6b6b76">Go back to the app and try again, or contact its developer.</p>
</main></body></html>`;
}

oauth.openapi(
  createRoute({
    method: 'get',
    path: '/oauth/authorize',
    tags: ['OAuth'],
    summary: 'Start an authorization (authorization code with PKCE)',
    description:
      'Checks the request and sends the browser to the consent page. An unknown client_id or unregistered redirect_uri shows an error page and is never redirected; other problems return to the redirect URI with RFC 6749 error params. code_challenge with method S256 is required. resource (RFC 8707) is the /v2 or /mcp address (default /v2). A client_id that is an https URL names a Client ID Metadata Document, which is fetched and checked on the consent page.',
    request: { query: AuthorizeParamsSchema },
    responses: {
      302: { description: 'To the consent page, or back to the app with an error' },
      400: {
        description: 'Unknown client or redirect URI',
        content: { 'text/html': { schema: z.string() } },
      },
    },
  }),
  async (c) => {
    const params = c.req.valid('query');
    const checked = await checkAuthorizeRequest(c, params, null);
    if (checked.kind === 'fatal') {
      return c.html(errorPage(checked.message), 400, { 'cache-control': 'no-store' });
    }
    if (checked.kind === 'error') return c.redirect(errorRedirect(c, checked), 302);
    const consent = new URL('/oauth/consent', env(c).APP_ORIGIN);
    consent.search = new URL(c.req.url).search;
    return c.redirect(consent.toString(), 302);
  },
);

// ---------------------------------------------------------------------------------------------
// The consent step (dashboard)

oauth.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/oauth/consent',
    tags: ['OAuth'],
    summary: 'What the consent page shows',
    description:
      'The app, the scopes it asks for in plain words, and the workspaces where the signed-in operator may authorise it (admin or owner), with their Channels.',
    request: { query: AuthorizeParamsSchema },
    responses: {
      200: ok(ConsentInfoSchema, 'The request is valid'),
      ...errors('invalid_input', 'unauthorized'),
    },
  }),
  async (c) => {
    const auth = requireAuth(c);
    const checked = await checkAuthorizeRequest(c, c.req.valid('query'), auth.operatorId);
    if (checked.kind === 'fatal') throw new ApiError('invalid_input', checked.message);
    if (checked.kind === 'error') throw new ApiError('invalid_input', checked.description);
    if (checked.kind === 'deferred') throw new Error('unreachable: an operator is signed in');
    const db = env(c).DB;
    const workspaces = await all<{ id: string; name: string }>(
      db,
      `SELECT w.id, w.name FROM seats s JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.operator_id = ?1 AND s.role IN ('owner', 'admin') ORDER BY w.name`,
      auth.operatorId,
    );
    const channels = workspaces.length
      ? await all<{ id: string; name: string; workspace_id: string }>(
          db,
          `SELECT c.id, c.name, c.workspace_id FROM channels c
            WHERE c.deleted_at IS NULL AND c.workspace_id IN (SELECT s.workspace_id FROM seats s
              WHERE s.operator_id = ?1 AND s.role IN ('owner', 'admin'))
            ORDER BY c.name`,
          auth.operatorId,
        )
      : [];
    const { client } = checked;
    // Verified means platform staff reviewed it for the App Directory. Registering needs only an
    // admin seat and the workspace name is the registrant's own choice, so it vouches for nothing.
    const reviewed =
      client.kind === 'registered' &&
      !!(await first<{ id: string }>(
        db,
        "SELECT id FROM app_listings WHERE app_id = ?1 AND status = 'approved' LIMIT 1",
        client.app.id,
      ));
    const shared = {
      redirectHost: new URL(checked.redirectUri).host,
      localRedirect: isLoopbackRedirect(checked.redirectUri),
    };
    return c.json(
      {
        data: {
          app:
            client.kind === 'registered'
              ? {
                  name: client.app.name,
                  // The page links to it: a homepage saved before https was required is dropped.
                  homepageUrl:
                    client.app.homepage_url &&
                    !homepageUrlProblem(client.app.homepage_url, isLocal(env(c)))
                      ? client.app.homepage_url
                      : null,
                  clientId: client.app.client_id,
                  registeredBy: client.app.workspace_name,
                  verified: reviewed,
                  clientHost: null,
                  ...shared,
                }
              : {
                  // Self-described: the page marks it unverified and names the document's host.
                  name: client.client.name,
                  homepageUrl: client.client.clientUri,
                  clientId: client.url,
                  registeredBy: null,
                  verified: false,
                  clientHost: new URL(client.url).host,
                  ...shared,
                },
          resource: checked.resource,
          scopes: checked.scopes.map((scope) => ({ scope, label: SCOPE_LABELS[scope] })),
          workspaces: workspaces.map((w) => ({
            id: w.id,
            name: w.name,
            channels: channels
              .filter((ch) => ch.workspace_id === w.id)
              .map((ch) => ({ id: ch.id, name: ch.name })),
          })),
        },
      },
      200,
    );
  },
);

oauth.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/oauth/consent',
    tags: ['OAuth'],
    summary: 'Allow or deny an app',
    description:
      'Allow needs the admin role on the chosen workspace and creates a grant with a single-use code (60 seconds); the workspace’s other owners and admins are emailed the app, its scopes and where to revoke it. Either way the answer is the URL to send the browser to.',
    request: { body: jsonBody(ConsentDecisionSchema) },
    responses: {
      200: ok(ConsentResultSchema, 'Where to go next'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const auth = requireAuth(c);
    const input = c.req.valid('json');
    const checked = await checkAuthorizeRequest(c, input, auth.operatorId);
    if (checked.kind === 'fatal') throw new ApiError('invalid_input', checked.message);
    if (checked.kind === 'deferred') throw new Error('unreachable: an operator is signed in');
    if (checked.kind === 'error') {
      return c.json({ data: { redirectUrl: errorRedirect(c, checked) } }, 200);
    }
    if (input.decision === 'deny') {
      const redirectUrl = backToApp(c, checked.redirectUri, {
        error: 'access_denied',
        error_description: 'The request was denied.',
        state: checked.state,
      });
      return c.json({ data: { redirectUrl } }, 200);
    }
    if (!input.workspaceId) {
      throw new ApiError('invalid_input', 'Choose a workspace.', [
        { path: 'workspaceId', message: 'Choose a workspace.' },
      ]);
    }
    const access = await requireWorkspace(c, input.workspaceId, 'admin');
    const db = env(c).DB;
    if (
      checked.resource === 'v2' &&
      !(await mayUseDirectApi(c, checked.client, access.workspaceId))
    ) {
      throw new ApiError(
        'forbidden',
        'This app has not been reviewed, so it can reach this workspace only through the MCP server, where your approval rules hold its calls. Ask its maker to connect with resource=<this server>/mcp, or give it an API key.',
      );
    }
    const channelIds = input.channelIds ? [...new Set(input.channelIds)] : null;
    if (channelIds) {
      const found = await all<{ id: string }>(
        db,
        `SELECT id FROM channels WHERE workspace_id = ?1 AND deleted_at IS NULL
          AND id IN (SELECT value FROM json_each(?2))`,
        access.workspaceId,
        JSON.stringify(channelIds),
      );
      if (found.length !== channelIds.length) {
        throw new ApiError('invalid_input', 'Pick publications of this workspace.', [
          { path: 'channelIds', message: 'Pick publications of this workspace.' },
        ]);
      }
    }
    const now = Date.now();
    const id = newId('oauthGrant', now);
    const code = randomToken(32);
    const appId = await grantAppId(
      c,
      checked.client,
      access.workspaceId,
      access.auth.operatorId,
      now,
    );
    await run(
      db,
      `INSERT INTO oauth_grants (id, app_id, workspace_id, operator_id, channel_ids_json, scopes_json, code_hash,
         code_challenge, redirect_uri, code_expires_at, created_at, resource)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      id,
      appId,
      access.workspaceId,
      access.auth.operatorId,
      channelIds ? JSON.stringify(channelIds) : null,
      JSON.stringify(checked.scopes),
      await sha256Hex(code),
      checked.codeChallenge,
      checked.redirectUri,
      now + OAUTH_CODE_TTL_SECONDS * 1000,
      now,
      checked.resource,
    );
    await audit(c, access, 'oauth_grant.created', 'oauth_grant', id, {
      appId,
      scopes: checked.scopes,
      channelIds,
      resource: checked.resource,
      ...(checked.client.kind === 'metadata' ? { clientUrl: checked.client.url } : {}),
    });
    // The other owners and admins hear of it, so a mistaken or persuaded consent is noticed.
    const appName =
      checked.client.kind === 'registered' ? checked.client.app.name : checked.client.client.name;
    await noticeTeam(
      env(c),
      c.get('log'),
      access.workspaceId,
      ['owner', 'admin'],
      grantNotice(access.auth.email, appName, checked),
      access.auth.operatorId,
    );
    const redirectUrl = backToApp(c, checked.redirectUri, { code, state: checked.state });
    return c.json({ data: { redirectUrl } }, 200);
  },
);

/** To the other owners and admins: an admin allowed an app into the workspace. */
function grantNotice(
  by: string,
  appName: string,
  checked: {
    scopes: readonly (keyof typeof SCOPE_LABELS)[];
    resource: string;
    client: { kind: string };
  },
): TeamNotice {
  const where = checked.resource === 'mcp' ? ' through the MCP server' : ' through the API';
  return {
    category: 'standing_feed_changed',
    subject: `An app was allowed into your workspace: ${appName}`,
    heading: 'New app access',
    lines: [
      `${by} allowed the app “${appName}”${checked.client.kind === 'metadata' ? ' (unverified)' : ''} to act in this workspace${where}. It can: ${checked.scopes.map((scope) => SCOPE_LABELS[scope]).join('; ')}.`,
      'If you did not expect this, revoke it under Settings → Developers → OAuth apps, in Authorised apps.',
    ],
    path: '/settings/developers/oauth-apps',
    label: 'Review authorised apps',
  };
}

// ---------------------------------------------------------------------------------------------
// Token and revocation endpoints (RFC 6749 §3.2, RFC 7009). Errors use the RFC's own shape,
// { error, error_description }, not the API envelope, because OAuth client libraries expect it.

/** Every field optional: a missing one is an RFC error, not the API's validation envelope. */
const TokenFormSchema = z.object({
  grant_type: z.string().optional(),
  code: z.string().optional(),
  redirect_uri: z.string().optional(),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  token: z.string().optional(),
  token_type_hint: z.string().optional(),
  /** RFC 8707. When sent, it must name the resource the grant is bound to. */
  resource: z.string().optional(),
});
type TokenForm = z.infer<typeof TokenFormSchema>;

const formBody = {
  required: false,
  content: { 'application/x-www-form-urlencoded': { schema: TokenFormSchema } },
};

const TokenResponseSchema = z
  .object({
    access_token: z.string(),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int(),
    refresh_token: z.string(),
    scope: z.string(),
  })
  .openapi('OAuthTokenResponse');
const OAuthErrorSchema = z
  .object({ error: z.string(), error_description: z.string() })
  .openapi('OAuthError');

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

class OAuthFailure extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status: 400 | 401 = 400,
  ) {
    super(description);
  }
}

function oauthError(c: AppContext, failure: OAuthFailure, basic: boolean) {
  const headers: Record<string, string> = { ...NO_STORE };
  if (failure.status === 401 && basic) headers['www-authenticate'] = 'Basic realm="oauth"';
  return c.json(
    { error: failure.error, error_description: failure.description },
    failure.status,
    headers,
  );
}

/** Form values are strings; a repeated parameter is refused (RFC 6749 §3.1). */
async function readForm(c: AppContext): Promise<TokenForm> {
  const type = c.req.header('content-type') ?? '';
  if (!type.startsWith('application/x-www-form-urlencoded')) {
    throw new OAuthFailure('invalid_request', 'Send the parameters form-encoded.');
  }
  const params = new URLSearchParams(new TextDecoder().decode(await c.req.arrayBuffer()));
  const form: Record<string, string> = {};
  for (const key of params.keys()) {
    const values = params.getAll(key);
    if (values.length > 1) throw new OAuthFailure('invalid_request', `${key} is repeated.`);
    if (values[0]!.length > 4096) throw new OAuthFailure('invalid_request', `${key} is too long.`);
    form[key] = values[0]!;
  }
  return TokenFormSchema.parse(form);
}

/** The authenticated client at the token and revocation endpoints. */
type TokenClient = { kind: 'registered'; app: OAuthAppRow } | { kind: 'metadata'; url: string };

/** Whether a grant (its app row) belongs to the client presenting its code or token. */
const ownsGrant = (client: TokenClient, row: { app_id: string; metadata_url: string | null }) =>
  client.kind === 'registered'
    ? row.app_id === client.app.id && row.metadata_url === null
    : row.metadata_url === client.url;

/** RFC 8707 on the token endpoint: no resource, or the grant's own. */
function checkTokenResource(c: AppContext, form: TokenForm, bound: OAuthResource): void {
  if (form.resource === undefined) return;
  const named = oauthResourceFor(form.resource, issuer(c));
  if (named !== bound) {
    throw new OAuthFailure(
      'invalid_target',
      named
        ? 'This grant is not for that resource. Authorise again for it.'
        : 'resource must be this server’s /v2 or /mcp address.',
    );
  }
}

/**
 * Client authentication: HTTP Basic or client_id/client_secret in the body for confidential
 * apps; client_id alone for public apps (PKCE stands in for the secret), including metadata
 * document clients, which are always public. Their grants are matched by the client_id URL.
 */
async function authenticateClient(c: AppContext, form: TokenForm): Promise<TokenClient> {
  let clientId = form.client_id;
  let secret = form.client_secret;
  const header = c.req.header('authorization');
  if (header) {
    const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header);
    if (!match || secret !== undefined) {
      throw new OAuthFailure('invalid_request', 'Authenticate the client one way only.');
    }
    // RFC 6749 §2.3.1: base64 of form-encoded id ":" form-encoded secret.
    let basicId: string;
    try {
      const decoded = atob(match[1]!);
      const colon = decoded.indexOf(':');
      if (colon < 0) throw new Error('no colon');
      basicId = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' '));
      secret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' '));
    } catch {
      throw new OAuthFailure('invalid_client', 'Client authentication failed.', 401);
    }
    if (clientId !== undefined && clientId !== basicId) {
      throw new OAuthFailure('invalid_request', 'Authenticate the client one way only.');
    }
    clientId = basicId;
  }
  if (!clientId) throw new OAuthFailure('invalid_client', 'Send client_id.', 401);
  const refused = new OAuthFailure('invalid_client', 'Client authentication failed.', 401);
  if (isClientMetadataUrl(clientId)) {
    if (secret !== undefined || clientMetadataUrlProblem(clientId)) throw refused;
    return { kind: 'metadata', url: clientId };
  }
  const app = await first<OAuthAppRow>(
    env(c).DB,
    'SELECT * FROM oauth_apps WHERE client_id = ?1 AND revoked_at IS NULL AND metadata_url IS NULL',
    clientId,
  );
  if (!app) throw refused;
  if (app.client_secret_hash) {
    if (!secret || (await sha256Hex(secret)) !== app.client_secret_hash) throw refused;
  } else if (secret !== undefined) {
    throw refused;
  }
  return { kind: 'registered', app };
}

interface CodeGrantRow {
  id: string;
  app_id: string;
  metadata_url: string | null;
  resource: OAuthResource;
  scopes_json: string;
  app_scopes: string;
  code_challenge: string | null;
  redirect_uri: string | null;
  code_expires_at: number | null;
  code_consumed_at: number | null;
  live: number;
}

async function exchangeCode(c: AppContext, client: TokenClient, form: TokenForm) {
  if (!form.code || !form.redirect_uri || !form.code_verifier) {
    throw new OAuthFailure('invalid_request', 'Send code, redirect_uri and code_verifier.');
  }
  if (!VERIFIER.test(form.code_verifier)) {
    throw new OAuthFailure('invalid_request', 'code_verifier must be 43 to 128 characters.');
  }
  const db = env(c).DB;
  const now = Date.now();
  const grant = await first<CodeGrantRow>(
    db,
    `SELECT g.id, g.app_id, a.metadata_url, g.resource, g.scopes_json, a.scopes_json AS app_scopes,
            g.code_challenge, g.redirect_uri, g.code_expires_at, g.code_consumed_at,
            (${LIVE_GRANT_SQL}) AS live
       FROM oauth_grants g JOIN oauth_apps a ON a.id = g.app_id
      WHERE g.code_hash = ?1`,
    await sha256Hex(form.code),
  );
  const invalid = new OAuthFailure('invalid_grant', 'The code is not valid.');
  if (!grant || !ownsGrant(client, grant)) throw invalid;
  // Checked before the code is used, so a wrong resource leaves the code for a corrected retry.
  checkTokenResource(c, form, grant.resource);
  if (grant.code_consumed_at !== null) {
    // RFC 6749 §4.1.2: a code used twice revokes what was issued from it.
    await revokeGrant(db, grant.id, now);
    throw invalid;
  }
  if (!grant.live || (grant.code_expires_at ?? 0) <= now) throw invalid;
  if (grant.redirect_uri !== form.redirect_uri) throw invalid;
  if ((await s256(form.code_verifier)) !== grant.code_challenge) throw invalid;
  const consumed = await run(
    db,
    'UPDATE oauth_grants SET code_consumed_at = ?1 WHERE id = ?2 AND code_consumed_at IS NULL AND revoked_at IS NULL',
    now,
    grant.id,
  );
  if (!consumed.meta.changes) {
    await revokeGrant(db, grant.id, now);
    throw invalid;
  }
  // One family per grant: every refresh token descends from this exchange.
  return issueTokens(
    db,
    grant.id,
    grant.id,
    effectiveScopes(grant.scopes_json, grant.app_scopes),
    now,
  );
}

interface RefreshRow {
  id: string;
  grant_id: string;
  family_id: string;
  app_id: string;
  metadata_url: string | null;
  resource: OAuthResource;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
  scopes_json: string;
  app_scopes: string;
  live: number;
}

async function refresh(c: AppContext, client: TokenClient, form: TokenForm) {
  if (!form.refresh_token) throw new OAuthFailure('invalid_request', 'Send refresh_token.');
  const db = env(c).DB;
  const now = Date.now();
  const token = await first<RefreshRow>(
    db,
    `SELECT t.id, t.grant_id, t.family_id, g.app_id, a.metadata_url, g.resource, t.expires_at, t.used_at,
            t.revoked_at, g.scopes_json, a.scopes_json AS app_scopes, (${LIVE_GRANT_SQL}) AS live
       FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN oauth_apps a ON a.id = g.app_id
      WHERE t.token_hash = ?1 AND t.kind = 'refresh'`,
    await sha256Hex(form.refresh_token),
  );
  const invalid = new OAuthFailure('invalid_grant', 'The refresh token is not valid.');
  if (!token || !ownsGrant(client, token)) throw invalid;
  if (token.used_at !== null || token.revoked_at !== null) {
    // A rotated-out token came back: someone else has a copy. Revoke the whole family.
    await revokeGrant(db, token.grant_id, now);
    throw invalid;
  }
  if (!token.live || token.expires_at <= now) throw invalid;
  checkTokenResource(c, form, token.resource);
  const scopes = effectiveScopes(token.scopes_json, token.app_scopes);
  // RFC 6749 section 6: a narrower scope limits the new access token to it; the new refresh
  // token keeps the grant's scope, so a later refresh can ask for all of it again.
  const requested = (form.scope ?? '').split(' ').filter(Boolean);
  const beyond = requested.filter((s) => !(scopes as string[]).includes(s));
  if (beyond.length) {
    throw new OAuthFailure('invalid_scope', `Not granted: ${beyond.join(' ')}.`);
  }
  const narrowed = requested.length ? scopes.filter((s) => requested.includes(s)) : null;
  const used = await run(
    db,
    'UPDATE oauth_tokens SET used_at = ?1 WHERE id = ?2 AND used_at IS NULL AND revoked_at IS NULL',
    now,
    token.id,
  );
  if (!used.meta.changes) {
    await revokeGrant(db, token.grant_id, now);
    throw invalid;
  }
  return issueTokens(db, token.grant_id, token.family_id, scopes, now, narrowed);
}

oauth.openapi(
  createRoute({
    method: 'post',
    path: '/oauth/token',
    tags: ['OAuth'],
    summary: 'Exchange a code or a refresh token',
    description:
      'Form-encoded (RFC 6749). grant_type=authorization_code needs code, redirect_uri and code_verifier; grant_type=refresh_token rotates the refresh token, and presenting a used one revokes every token of the grant. Confidential apps authenticate with HTTP Basic or client_secret; public apps send client_id (a registered id or a Client ID Metadata Document URL). resource (RFC 8707), when sent, must name the resource the grant is bound to (invalid_target otherwise).',
    request: { body: formBody },
    responses: {
      200: {
        description: 'Tokens',
        content: { 'application/json': { schema: TokenResponseSchema } },
      },
      400: {
        description: 'RFC 6749 error',
        content: { 'application/json': { schema: OAuthErrorSchema } },
      },
      401: {
        description: 'invalid_client',
        content: { 'application/json': { schema: OAuthErrorSchema } },
      },
    },
  }),
  async (c) => {
    const basic = !!c.req.header('authorization');
    try {
      const form = await readForm(c);
      const client = await authenticateClient(c, form);
      const tokens =
        form.grant_type === 'authorization_code'
          ? await exchangeCode(c, client, form)
          : form.grant_type === 'refresh_token'
            ? await refresh(c, client, form)
            : null;
      if (!tokens) {
        throw new OAuthFailure(
          form.grant_type ? 'unsupported_grant_type' : 'invalid_request',
          'grant_type must be authorization_code or refresh_token.',
        );
      }
      return c.json(tokens, 200, NO_STORE);
    } catch (error) {
      if (error instanceof OAuthFailure) return oauthError(c, error, basic);
      if (error instanceof z.ZodError) {
        return oauthError(
          c,
          new OAuthFailure('invalid_request', 'The request is malformed.'),
          basic,
        );
      }
      throw error;
    }
  },
);

oauth.openapi(
  createRoute({
    method: 'post',
    path: '/oauth/revoke',
    tags: ['OAuth'],
    summary: 'Revoke a token (RFC 7009)',
    description:
      'Revoking a refresh token revokes every token of its grant; revoking an access token revokes that token. Unknown tokens and tokens of other apps answer 200 and change nothing.',
    request: { body: formBody },
    responses: {
      200: { description: 'Done' },
      400: {
        description: 'RFC 6749 error',
        content: { 'application/json': { schema: OAuthErrorSchema } },
      },
      401: {
        description: 'invalid_client',
        content: { 'application/json': { schema: OAuthErrorSchema } },
      },
    },
  }),
  async (c) => {
    const basic = !!c.req.header('authorization');
    try {
      const form = await readForm(c);
      const client = await authenticateClient(c, form);
      if (!form.token) throw new OAuthFailure('invalid_request', 'Send token.');
      const db = env(c).DB;
      const token = await first<{
        id: string;
        kind: 'access' | 'refresh';
        grant_id: string;
        app_id: string;
        metadata_url: string | null;
      }>(
        db,
        `SELECT t.id, t.kind, t.grant_id, g.app_id, a.metadata_url
           FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN oauth_apps a ON a.id = g.app_id
          WHERE t.token_hash = ?1`,
        await sha256Hex(form.token),
      );
      if (token && ownsGrant(client, token)) {
        if (token.kind === 'refresh') await revokeGrant(db, token.grant_id);
        else {
          await run(
            db,
            'UPDATE oauth_tokens SET revoked_at = coalesce(revoked_at, ?1) WHERE id = ?2',
            Date.now(),
            token.id,
          );
        }
      }
      return c.body(null, 200, NO_STORE);
    } catch (error) {
      if (error instanceof OAuthFailure) return oauthError(c, error, basic);
      if (error instanceof z.ZodError) {
        return oauthError(
          c,
          new OAuthFailure('invalid_request', 'The request is malformed.'),
          basic,
        );
      }
      throw error;
    }
  },
);

const MetadataSchema = z
  .object({
    issuer: z.string(),
    authorization_endpoint: z.string(),
    token_endpoint: z.string(),
    revocation_endpoint: z.string(),
    response_types_supported: z.array(z.string()),
    grant_types_supported: z.array(z.string()),
    code_challenge_methods_supported: z.array(z.string()),
    token_endpoint_auth_methods_supported: z.array(z.string()),
    revocation_endpoint_auth_methods_supported: z.array(z.string()),
    scopes_supported: z.array(z.string()),
    authorization_response_iss_parameter_supported: z.boolean(),
    /** Public clients may use the https URL of a Client ID Metadata Document as client_id. */
    client_id_metadata_document_supported: z.boolean(),
  })
  .openapi('OAuthServerMetadata');

oauth.openapi(
  createRoute({
    method: 'get',
    path: '/.well-known/oauth-authorization-server',
    tags: ['OAuth'],
    summary: 'Authorization server metadata (RFC 8414)',
    responses: {
      200: { description: 'Metadata', content: { 'application/json': { schema: MetadataSchema } } },
    },
  }),
  (c) => {
    const base = issuer(c);
    const auth = ['none', 'client_secret_basic', 'client_secret_post'];
    return c.json(
      {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        revocation_endpoint: `${base}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: auth,
        revocation_endpoint_auth_methods_supported: auth,
        scopes_supported: [...API_SCOPES],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
      },
      200,
      { 'cache-control': 'public, max-age=3600' },
    );
  },
);
