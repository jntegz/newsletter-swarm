// /v2 rate limits: a token bucket per principal in the realtime worker's ApiRateLimiter. Runs
// after authenticateV2. The bucket refills at min(plan rate, key cap) a minute and holds a burst
// on top (apiRatePolicy). Every response to an authenticated request carries the IETF draft
// headers (RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset) plus RateLimit-Policy; a
// refusal is 429 rate_limited with Retry-After.
import { apiRatePolicy } from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import type { MiddlewareHandler } from 'hono';
import { env, type AppContext, type AppEnv } from '../lib/context';
import type { ApiPrincipal } from './context';
import { internalPrincipal } from './internal';

interface ApiRateResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  retryAfterSeconds: number;
}

interface ApiRateLimiterStub {
  take(perMinute: number, capacity: number): Promise<ApiRateResult>;
}

/** Takes one token from the principal's bucket; null when there is no limiter (local dev). */
export async function takeRateToken(
  c: AppContext,
  principal: ApiPrincipal,
): Promise<{ allowed: boolean; headers: Record<string, string>; retryAfter: number } | null> {
  const namespace = env(c).API_RATE_LIMITER;
  if (!namespace) return null;
  const policy = apiRatePolicy(principal.plan, principal.rateCap);
  const stub = namespace.get(
    namespace.idFromName(`v2:${principal.kind}:${principal.id}`),
  ) as unknown as ApiRateLimiterStub;
  const result = await stub.take(policy.perMinute, policy.capacity);
  return {
    allowed: result.allowed,
    retryAfter: result.retryAfterSeconds,
    headers: {
      'RateLimit-Limit': String(result.limit),
      'RateLimit-Remaining': String(result.remaining),
      'RateLimit-Reset': String(result.resetSeconds),
      'RateLimit-Policy': `${policy.capacity};w=60;burst=${policy.burst};rate=${policy.perMinute}`,
    },
  };
}

export const rateLimitV2: MiddlewareHandler<AppEnv> = async (c, next) => {
  const principal = c.get('principal');
  // Public paths have no principal; Open Operator's in-process requests were already counted on
  // /mcp; a local worker without the realtime binding is unlimited.
  if (!principal || internalPrincipal(c.req.raw)) return next();
  const taken = await takeRateToken(c, principal);
  if (!taken) return next();
  if (!taken.allowed) {
    for (const [name, value] of Object.entries(taken.headers)) c.header(name, value);
    c.header('Retry-After', String(taken.retryAfter));
    throw new ApiError('rate_limited', 'Too many requests. Wait and try again.');
  }
  await next();
  for (const [name, value] of Object.entries(taken.headers)) c.res.headers.set(name, value);
};
