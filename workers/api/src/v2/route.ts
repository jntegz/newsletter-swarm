// Shared plumbing for /v2 resource routers: a route declares exactly one scope (v2Route), and its
// handler starts with `guard`, which checks that scope and, for Channel resources, the Channel
// (requireApiChannel). The scope is also written into the OpenAPI document (`x-swarm-scope` and
// the operation's security requirement), which the generated scope matrix test reads.
import { createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import { first } from '@swarm/db';
import { ErrorEnvelopeSchema, type ApiScope } from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import { base64UrlDecode, base64UrlEncode } from '@swarm/tokens';
import type { MiddlewareHandler } from 'hono';
import { env, type AppContext, type AppEnv } from '../lib/context';
import { errors } from '../lib/openapi';
import { requireApiChannel, requireScope, type ApiPrincipal } from './context';
import { idempotency } from './idempotency';

/** The security scheme name for Bearer keys in the /v2 document. */
export const BEARER_SCHEME = 'bearerAuth';
export const SCOPE_EXTENSION = 'x-swarm-scope';

const rateLimited = {
  description: 'rate_limited: the token bucket is empty; retry after `Retry-After` seconds',
  headers: z.object({
    'Retry-After': z.string().openapi({ description: 'Seconds until a request is allowed' }),
  }),
  content: { 'application/json': { schema: ErrorEnvelopeSchema } },
};

/**
 * Checks the route's one scope and, for a Channel path, that the principal may reach the
 * Channel. Runs as route middleware, before input validation, so a credential without the
 * scope learns nothing about the request shape.
 */
function scopeGuard(scope: ApiScope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const channelId = c.req.param('channelId');
    if (channelId) await requireApiChannel(c, channelId, scope);
    else requireScope(c, scope);
    await next();
  };
}

/**
 * A /v2 route needing `scope`. Adds the scope check, the security requirement, the scope
 * extension and the error responses every /v2 route can give (401 bad credential, 403 missing
 * scope, 429 rate limited).
 */
export function v2Route<const R extends Omit<RouteConfig, 'middleware'>>(
  scope: ApiScope,
  config: R,
) {
  return createRoute({
    ...config,
    // The Idempotency-Key replay comes after the scope and Channel check, never before it.
    middleware: [scopeGuard(scope), idempotency],
    security: [{ [BEARER_SCHEME]: [scope] }],
    [SCOPE_EXTENSION]: scope,
    responses: {
      ...errors('unauthorized', 'forbidden'),
      429: rateLimited,
      ...config.responses,
    },
  });
}

/**
 * The principal of a v2Route handler. The route's middleware has already checked its scope and
 * Channel; this re-asserts the scope (cheap, no query) so a handler can't run unguarded.
 */
export async function guard(
  c: AppContext,
  route: { [SCOPE_EXTENSION]: ApiScope },
): Promise<ApiPrincipal> {
  return requireScope(c, route[SCOPE_EXTENSION]);
}

const ROWS = {
  members: 'Subscriber',
  dispatches: 'Post',
  broadcasts: 'Send',
  circles: 'Segment',
  capture_forms: 'Signup form',
  flows: 'Automation',
  import_jobs: 'Import',
} as const;

/** A row must sit in the path's Channel; anything else answers 404 like a missing row. */
export async function requireInChannel(
  c: AppContext,
  table: keyof typeof ROWS,
  id: string,
  channelId: string,
): Promise<void> {
  const live = table === 'circles' || table === 'capture_forms' || table === 'flows';
  const row = await first(
    env(c).DB,
    `SELECT 1 FROM ${table} WHERE id = ?1 AND channel_id = ?2${live ? ' AND deleted_at IS NULL' : ''}`,
    id,
    channelId,
  );
  if (!row) throw new ApiError('not_found', `${ROWS[table]} not found.`);
}

/** /v2 cursors are opaque: base64url of the position. */
export const encodeCursor = (position: string | null) =>
  position === null ? null : base64UrlEncode(new TextEncoder().encode(position));

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      base64UrlDecode(cursor),
    );
  } catch {
    throw new ApiError('invalid_input', 'That page cursor is not valid.');
  }
}
