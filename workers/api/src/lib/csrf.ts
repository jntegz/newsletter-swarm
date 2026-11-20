import { ApiError } from '@swarm/runtime';
import type { MiddlewareHandler } from 'hono';
import { env, type AppEnv } from './context';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Server-to-server endpoints that authenticate each request by its own signature, never by a
 * cookie. They skip the CSRF check and session loading; the route verifies the signature.
 */
export const isSignedEndpoint = (path: string) =>
  path === '/api/v1/stripe/webhook' ||
  /^\/api\/v1\/(stripe|paypal)\/webhook\/ch_[A-Za-z0-9]+$/.test(path);

/**
 * Form posts the dashboard sends as a top-level navigation, so their body is form-encoded and a
 * refusal must be a redirect, not JSON. The route checks Origin itself, more strictly than here:
 * it must equal the dashboard's, with no Sec-Fetch-Site fallback.
 */
const isFormNavigation = (method: string, path: string) =>
  method === 'POST' && path === '/api/v1/auth/sso/start';

/**
 * Blocks cross-site writes. A state-changing request must come from the dashboard origin
 * (Origin header) or declare itself same-origin (Sec-Fetch-Site), and must carry JSON or
 * multipart, which an HTML form on another site cannot send with credentials.
 */
export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE.has(c.req.method)) return next();
  if (isSignedEndpoint(c.req.path)) return next();
  if (isFormNavigation(c.req.method, c.req.path)) return next();

  const origin = c.req.header('origin');
  const site = c.req.header('sec-fetch-site');
  const allowed = origin ? origin === env(c).APP_ORIGIN : site === 'same-origin';
  if (!allowed) throw new ApiError('forbidden', 'Cross-site request blocked.');

  const length = c.req.header('content-length');
  const hasBody = length !== undefined ? length !== '0' : c.req.raw.body !== null;
  const type = c.req.header('content-type') ?? '';
  if (hasBody && !type.startsWith('application/json') && !type.startsWith('multipart/form-data')) {
    throw new ApiError('unsupported_media_type', 'Send JSON.');
  }
  return next();
};
