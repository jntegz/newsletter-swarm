// OAuth apps (Phase 7): third-party apps that act on a workspace through /v2 after an admin
// consents. Registration, the consent step and authorised apps are dashboard routes
// (workers/api/src/routes/oauthApps.ts, oauth.ts); the protocol endpoints are /oauth/authorize,
// /oauth/token and /oauth/revoke. Token formats and lifetimes are in p7-platform.ts. Phase 8
// adds RFC 8707 resource indicators (a grant is bound to /v2 or /mcp) and Client ID Metadata
// Documents for MCP clients. Contract: docs/oauth.md.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';
import { API_SCOPES, ApiScopeSchema, type ApiScope } from './p7-platform';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-28T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

/** Confidential clients' secret: swcs_ + 40 base62 characters. Only sha256 of it is stored. */
export const OAUTH_CLIENT_SECRET_PREFIX = 'swcs_';
export const OAUTH_MAX_REDIRECT_URIS = 10;

// ---------------------------------------------------------------------------------------------
// Resource indicators (RFC 8707). A grant, and every token issued from it, is bound to one
// resource: the public API or the MCP server. Without `resource` a request means /v2, so apps
// written before resource indicators keep working.

const OAUTH_RESOURCES = ['v2', 'mcp'] as const;
export type OAuthResource = (typeof OAUTH_RESOURCES)[number];
const OAuthResourceSchema = z.enum(OAUTH_RESOURCES).openapi('OAuthResource');

/**
 * The audience a `resource` parameter names, or null when it names nothing Swarm serves.
 * `<origin>/v2` and the bare `<origin>` are the public API; `<origin>/mcp` is the MCP server.
 * Scheme and host compare without case (the URL parser lowercases them) and one trailing slash
 * is ignored; a query, a fragment or credentials are refused (RFC 8707 §2).
 */
export function oauthResourceFor(raw: string, origin: string): OAuthResource | null {
  let url: URL;
  let base: URL;
  try {
    url = new URL(raw);
    base = new URL(origin);
  } catch {
    return null;
  }
  if (url.origin !== base.origin || url.search || raw.includes('#')) return null;
  if (url.username || url.password) return null;
  const path = url.pathname.replace(/\/$/, '');
  if (path === '' || path === '/v2') return 'v2';
  if (path === '/mcp') return 'mcp';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document, the registration
// the MCP authorization specification recommends). A public client uses the https URL of a JSON
// document about itself as its client_id. Swarm fetches it only on the consent step, for a
// signed-in operator, through the outbound URL guard.

export const CLIENT_METADATA_LIMITS = {
  /** Largest document read, counted while it streams. */
  bytes: 5 * 1024,
  /** The whole fetch. */
  timeoutMs: 5_000,
  /** How long a document is used before it is fetched again (Cache-Control max-age, clamped). */
  minCacheSeconds: 5 * 60,
  defaultCacheSeconds: 60 * 60,
  maxCacheSeconds: 24 * 60 * 60,
  /** A failed fetch is remembered this long, so the same URL is not fetched again at once. */
  errorCacheSeconds: 60,
  /** Documents one operator may have fetched per hour. */
  fetchesPerOperatorHour: 20,
  /** Cached documents are dropped this long after they expire. */
  pruneAfterDays: 7,
} as const;

/** URL client ids name a metadata document; everything else is a registered `swc_…` id. */
export const isClientMetadataUrl = (clientId: string) => clientId.startsWith('https://');

/** Why a client_id URL can't name a metadata document, or null when it can. */
export function clientMetadataUrlProblem(clientId: string): string | null {
  if (clientId.length > 2000) return 'The client_id is too long.';
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return 'The client_id is not a URL.';
  }
  if (url.protocol !== 'https:') return 'A client_id URL must use https.';
  if (url.username || url.password) return 'A client_id URL may not hold credentials.';
  if (clientId.includes('#')) return 'A client_id URL may not have a fragment.';
  if (url.pathname === '/' || url.pathname === '') return 'A client_id URL must have a path.';
  // Dot segments or other non-normal forms would make the URL fetched differ from the client_id.
  if (url.href !== clientId) return 'Use the client_id URL in its normal form.';
  return null;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** http on a loopback host: a native client on the operator's own computer (RFC 8252 §7.3). */
export function isLoopbackRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Why a metadata document's redirect URI is refused, or null. https without credentials or a
 * fragment, or http on a loopback host. No custom schemes and no wildcards.
 */
function clientRedirectUriProblem(uri: string): string | null {
  if (isLoopbackRedirect(uri)) {
    if (uri.includes('#') || uri.includes('*') || new URL(uri).username) {
      return 'Remove the fragment, wildcard or user name.';
    }
    return null;
  }
  return redirectUriProblem(uri, false);
}

/**
 * Whether a requested redirect URI is one of the document's. Exact, character for character,
 * except that a loopback redirect matches on any port (RFC 8252 §7.3: native clients pick a free
 * port when they start).
 */
export function clientRedirectMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  if (!isLoopbackRedirect(requested) || clientRedirectUriProblem(requested)) return false;
  const want = new URL(requested);
  return registered.some((uri) => {
    if (!isLoopbackRedirect(uri)) return false;
    const have = new URL(uri);
    return (
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search
    );
  });
}

export interface ClientMetadata {
  name: string;
  clientUri: string | null;
  redirectUris: string[];
}

const ClientMetadataDocumentSchema = z.object({
  client_id: z.string(),
  client_name: z.string().trim().min(1),
  client_uri: z.string().max(2000).optional(),
  redirect_uris: z.array(z.string().max(2000)).min(1).max(OAUTH_MAX_REDIRECT_URIS),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

/**
 * The client a fetched document describes, or why it is refused. The document's client_id must
 * be the URL it was fetched from, character for character; only public clients (auth method
 * `none`) using the authorization code grant are accepted, and a document carrying a secret is
 * refused.
 */
export function parseClientMetadata(
  body: unknown,
  url: string,
): { ok: true; client: ClientMetadata } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'The client metadata document is not a JSON object.' };
  }
  const doc = body as Record<string, unknown>;
  if ('client_secret' in doc || 'client_secret_expires_at' in doc) {
    return { ok: false, error: 'The client metadata document may not hold a client secret.' };
  }
  const parsed = ClientMetadataDocumentSchema.safeParse(doc);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'The client metadata document needs client_id, client_name and redirect_uris.',
    };
  }
  const d = parsed.data;
  if (d.client_id !== url) {
    return { ok: false, error: 'The document’s client_id is not the URL it was fetched from.' };
  }
  if ((d.token_endpoint_auth_method ?? 'none') !== 'none') {
    return {
      ok: false,
      error: 'Only public clients (token_endpoint_auth_method none) are supported.',
    };
  }
  const grants = d.grant_types ?? ['authorization_code'];
  if (
    !grants.includes('authorization_code') ||
    grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')
  ) {
    return {
      ok: false,
      error: 'Only the authorization_code and refresh_token grants are supported.',
    };
  }
  if (d.response_types?.some((r) => r !== 'code')) {
    return { ok: false, error: 'Only response_type code is supported.' };
  }
  const redirectUris = [...new Set(d.redirect_uris)];
  const bad = redirectUris.find((uri) => clientRedirectUriProblem(uri) !== null);
  if (bad !== undefined) {
    return { ok: false, error: `The redirect URI ${bad.slice(0, 200)} is not allowed.` };
  }
  let clientUri: string | null = null;
  if (d.client_uri) {
    try {
      clientUri = new URL(d.client_uri).protocol === 'https:' ? d.client_uri : null;
    } catch {
      clientUri = null;
    }
  }
  return { ok: true, client: { name: d.client_name.slice(0, 80), clientUri, redirectUris } };
}

/** Never shown: the client_id column of an app row made for a metadata document client. */
export const OAUTH_METADATA_CLIENT_PREFIX = 'swm_';

/** What each scope lets an app do, in the words the consent screen shows. */
export const SCOPE_LABELS: Record<ApiScope, string> = {
  'channels:read': 'See your publications and their settings',
  'members:read': 'See subscribers, their tags and profile fields',
  'members:write': 'Add, change and remove subscribers',
  'dispatches:read': 'See posts',
  'dispatches:write': 'Write, schedule and send posts',
  'broadcasts:read': 'See sends and their results',
  'circles:read': 'See segments',
  'circles:write': 'Create and change segments',
  'fields:read': 'See profile fields',
  'fields:write': 'Create and change profile fields',
  'levels:read': 'See paid plans',
  'forms:read': 'See signup forms',
  'flows:read': 'See automations',
  'flows:write': 'Enrol subscribers in automations and trigger them',
  'webhooks:read': 'See webhook endpoints',
  'webhooks:write': 'Create and change webhook endpoints',
  'sends:read': 'See single emails sent to subscribers and their status',
  'sends:write': 'Send single emails to subscribers',
  'imports:read': 'See subscriber imports and their reports',
  'imports:write': 'Import subscribers',
  'audit:read': 'Read the audit log',
  'rosters:read': 'See Rosters and who is on them',
  'rosters:write': 'Create and change Rosters and who is on them',
  'goods:read': 'See products, orders and license keys',
};

/**
 * Why a redirect URI can't be registered, or null when it can. Absolute, https (http only in
 * development), no fragment, no credentials, no wildcard. Authorization requests then match it
 * exactly, character for character.
 */
export function redirectUriProblem(uri: string, allowHttp: boolean): string | null {
  if (uri.length > 2000) return 'Use an address under 2,000 characters.';
  if (uri.includes('*')) return 'Wildcards are not allowed. Register each address.';
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'Use a full web address, starting with https://.';
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    return 'Use an https address.';
  }
  if (uri.includes('#')) return 'Remove the fragment (the part after #).';
  if (url.username || url.password) return 'Remove the user name and password.';
  return null;
}

/**
 * Why an app's homepage is refused, or null. The consent page links to it, so only https (and,
 * with `allowLocalHttp` in development, http on a loopback host): never javascript: or data:.
 */
export function homepageUrlProblem(uri: string, allowLocalHttp: boolean): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'Use a full web address, starting with https://.';
  }
  if (url.protocol === 'https:') return null;
  if (allowLocalHttp && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return null;
  return 'Use an https address.';
}

const scopesSchema = z
  .array(ApiScopeSchema)
  .min(1, 'Pick at least one scope.')
  .max(API_SCOPES.length)
  .transform((scopes) => [...new Set(scopes)].sort() as ApiScope[]);

const redirectUrisSchema = z
  .array(z.string().trim().min(1).max(2000))
  .min(1, 'Add at least one redirect URI.')
  .max(OAUTH_MAX_REDIRECT_URIS)
  .transform((uris) => [...new Set(uris)]);

export const OAuthAppSchema = z
  .object({
    id: id('oauthApp'),
    workspaceId: id('workspace'),
    name: z.string(),
    clientId: z.string(),
    /** Confidential clients authenticate with a secret at the token endpoint; public ones don't. */
    clientType: z.enum(['public', 'confidential']),
    redirectUris: z.array(z.string()),
    scopes: z.array(ApiScopeSchema),
    homepageUrl: z.string().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('OAuthApp');
export type OAuthApp = z.infer<typeof OAuthAppSchema>;

/** Returned once, on create and on secret rotation. */
export const OAuthAppWithSecretSchema = z
  .object({ app: OAuthAppSchema, clientSecret: z.string().nullable() })
  .openapi('OAuthAppWithSecret');
export type OAuthAppWithSecret = z.infer<typeof OAuthAppWithSecretSchema>;

export const CreateOAuthAppSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the app.').max(80),
    clientType: z.enum(['public', 'confidential']),
    redirectUris: redirectUrisSchema,
    scopes: scopesSchema,
    homepageUrl: z.url().max(2000).nullish(),
  })
  .openapi('CreateOAuthApp');
export type CreateOAuthApp = z.input<typeof CreateOAuthAppSchema>;

export const UpdateOAuthAppSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the app.').max(80).optional(),
    redirectUris: redirectUrisSchema.optional(),
    /** Narrowing takes effect at once: tokens carry the grant's scopes ∩ the app's. */
    scopes: scopesSchema.optional(),
    homepageUrl: z.url().max(2000).nullish(),
  })
  .openapi('UpdateOAuthApp');
export type UpdateOAuthApp = z.input<typeof UpdateOAuthAppSchema>;

/** An app authorised on a workspace (an active grant). */
export const OAuthGrantSchema = z
  .object({
    id: id('oauthGrant'),
    app: z.object({
      id: z.string(),
      name: z.string(),
      homepageUrl: z.string().nullable(),
      /**
       * The Client ID Metadata Document URL of an unverified client (its name is what its own
       * document says); null for an app registered in a workspace.
       */
      clientUrl: z.string().nullable(),
    }),
    /** The audience of the grant's tokens: the public API or the MCP server. */
    resource: OAuthResourceSchema,
    /** null = every Channel in the workspace. */
    channelIds: z.array(z.string()).nullable(),
    scopes: z.array(ApiScopeSchema),
    authorisedBy: z.string().nullable(),
    createdAt: timestamp,
    lastUsedAt: timestamp.nullable(),
  })
  .openapi('OAuthGrant');
export type OAuthGrant = z.infer<typeof OAuthGrantSchema>;

// ---------------------------------------------------------------------------------------------
// The consent step. /oauth/authorize checks the request and hands the browser to the dashboard's
// consent page with the same parameters; the page reads them back here and posts the decision.

export const AuthorizeParamsSchema = z.object({
  /** A registered `swc_…` id, or the https URL of a Client ID Metadata Document. */
  client_id: z.string().max(2000),
  redirect_uri: z.string().max(2000),
  response_type: z.string().max(40).optional(),
  scope: z.string().max(2000).optional(),
  state: z.string().max(512).optional(),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().max(20).optional(),
  /** RFC 8707: `<origin>/v2` (also the default) or `<origin>/mcp`. */
  resource: z.string().max(2000).optional(),
});
export type AuthorizeParams = z.infer<typeof AuthorizeParamsSchema>;

export const ConsentInfoSchema = z
  .object({
    app: z.object({
      name: z.string(),
      homepageUrl: z.string().nullable(),
      clientId: z.string(),
      /** The workspace that registered the app; null for a metadata document client. */
      registeredBy: z.string().nullable(),
      redirectHost: z.string(),
      /**
       * true only for a registered app with an approved App Directory listing (reviewed by
       * platform staff). false for any other registered app, whose name and workspace name are
       * the registrant's own, and for a Client ID Metadata Document client, whose name and links
       * are what its own document says.
       */
      verified: z.boolean(),
      /** The host serving the metadata document (who the client says it is); null if registered. */
      clientHost: z.string().nullable(),
      /** The redirect goes to this computer (a loopback address), which any local app can use. */
      localRedirect: z.boolean(),
    }),
    /** What the tokens will be good for. */
    resource: OAuthResourceSchema,
    scopes: z.array(z.object({ scope: ApiScopeSchema, label: z.string() })),
    /** Workspaces where the operator may authorise apps (admin or owner), with their Channels. */
    workspaces: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        channels: z.array(z.object({ id: z.string(), name: z.string() })),
      }),
    ),
  })
  .openapi('OAuthConsentInfo');
export type ConsentInfo = z.infer<typeof ConsentInfoSchema>;

export const ConsentDecisionSchema = AuthorizeParamsSchema.extend({
  decision: z.enum(['allow', 'deny']),
  workspaceId: id('workspace').optional(),
  /** null or absent = every Channel; otherwise Channels of the chosen workspace. */
  channelIds: z.array(id('channel')).min(1).max(100).nullish(),
}).openapi('OAuthConsentDecision');
export type ConsentDecision = z.infer<typeof ConsentDecisionSchema>;

/** Where the dashboard sends the browser next: the app's redirect URI with a code or an error. */
export const ConsentResultSchema = z
  .object({ redirectUrl: z.string() })
  .openapi('OAuthConsentResult');
export type ConsentResult = z.infer<typeof ConsentResultSchema>;
