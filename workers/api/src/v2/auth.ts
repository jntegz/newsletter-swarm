// /v2 authentication: Bearer sk_live_… (scoped keys) or Bearer oat_… (OAuth access tokens bound
// to the /v2 resource; /mcp asks for its own). Public /v2 paths (the OpenAPI document) skip it.
// Rate limiting runs after it (ratelimit.ts).
import { API_KEY_PREFIX, OAUTH_ACCESS_PREFIX, type OAuthResource } from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import type { MiddlewareHandler } from 'hono';
import { clientIp, type AppContext, type AppEnv } from '../lib/context';
import type { ApiPrincipal } from './context';
import { internalCredential, internalPrincipal } from './internal';
import { resolveApiKey } from './keys';
import { resolveOAuthAccess } from './oauth';

/** /v2 paths anyone may read without credentials. */
const PUBLIC_V2_PATHS = new Set(['/v2/openapi.json', '/v2/reference']);

/**
 * The principal for a request's Bearer credential: undefined without one, null when invalid.
 * An OAuth token counts only for the resource it was issued for; API keys work on both, unless
 * the key was issued for agents (surface `mcp`), which works on /mcp only.
 */
export async function resolveBearer(
  c: AppContext,
  resource: OAuthResource,
): Promise<ApiPrincipal | null | undefined> {
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9_\-.]{1,200})$/.exec(header);
  if (!match) return undefined;
  const credential = match[1]!;
  const principal = credential.startsWith(API_KEY_PREFIX)
    ? await resolveApiKey(c, credential, resource)
    : credential.startsWith(OAUTH_ACCESS_PREFIX)
      ? await resolveOAuthAccess(c, credential, resource)
      : null;
  // The vault checks the same credential itself (with the caller's IP for a key's allowlist).
  if (principal) {
    c.set(
      'credential',
      credential.startsWith(API_KEY_PREFIX)
        ? { kind: 'api-key', secret: credential, resource, ip: clientIp(c) ?? null }
        : { kind: 'oauth', accessToken: credential, resource },
    );
  }
  return principal;
}

export const authenticateV2: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('principal', null);
  if (PUBLIC_V2_PATHS.has(c.req.path)) return next();
  // Open Operator's in-process requests carry their principal (v2/internal.ts).
  const internal = internalPrincipal(c.req.raw);
  if (internal) {
    c.set('principal', internal);
    c.set('credential', internalCredential(c.req.raw));
    return next();
  }
  const principal = await resolveBearer(c, 'v2');
  if (principal === undefined) {
    throw new ApiError('unauthorized', 'Send an API key or access token.');
  }
  // One answer for unknown, revoked, expired and blocked-by-IP credentials.
  if (!principal) throw new ApiError('unauthorized', 'The API key or access token is not valid.');
  c.set('principal', principal);
  return next();
};
