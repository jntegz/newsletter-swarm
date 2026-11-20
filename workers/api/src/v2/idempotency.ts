// Idempotency-Key on /v2 and /api/v1 writes (POST, PUT, PATCH, DELETE): 24 hours, per principal
// (a key, a grant or a signed-in operator), stored in api_idempotency. The first request with a
// key claims it (a placeholder row with status 0) and its response is stored; a retry with the
// same key and the same method, path and body (on /api/v1 from the same session, on /v2 with the
// same scopes) replays that response with `Idempotent-Replayed: true`. The same key with a
// different request is 409, and so is a retry while the first request is still running. Server
// errors (5xx) and 429s are not stored, so the request can be retried with the same key. A
// response marked `cache-control: no-store` (one-time secrets: a new API key, a webhook or client
// secret, recovery codes) is never written here; the key is kept as used, so a retry is 409
// rather than a second secret or a copy of the first one; so is any response that holds a bearer
// value (holdsSecret), marked or not. On /v2 this runs inside each route, after its scope and
// Channel check (v2/route.ts), so a replay needs the authority a fresh request would. Old rows
// are pruned by the jobs worker's daily cron (and replaced here when a key is reused after 24
// hours).
import { first, run } from '@swarm/db';
import {
  API_KEY_PREFIX,
  OAUTH_ACCESS_PREFIX,
  OAUTH_CLIENT_SECRET_PREFIX,
  OAUTH_REFRESH_PREFIX,
  WEBHOOK_SECRET_PREFIX,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_TTL_HOURS,
} from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import type { MiddlewareHandler } from 'hono';
import { env, type AppEnv } from '../lib/context';
import { sha256Hex } from '../lib/crypto';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TTL_MS = IDEMPOTENCY_TTL_HOURS * 3_600_000;
const IN_FLIGHT = 0;
/** The request ran but its response was not kept (it was marked no-store). */
const NOT_KEPT = -1;

/**
 * Bearer values a response may carry: API keys, OAuth access and refresh tokens, client and
 * webhook secrets, and an authorization code in a redirect URL. Such a response is never stored,
 * even when its route forgot NO_STORE.
 */
const SECRET_SHAPES = new RegExp(
  `(?:${[API_KEY_PREFIX, OAUTH_ACCESS_PREFIX, OAUTH_REFRESH_PREFIX, OAUTH_CLIENT_SECRET_PREFIX, WEBHOOK_SECRET_PREFIX].join('|')})[A-Za-z0-9]|[?&]code=`,
);
const holdsSecret = (text: string) => SECRET_SHAPES.test(text);

/** Headers for a response that carries a one-time secret: no cache and no idempotency replay. */
export const NO_STORE = { 'cache-control': 'no-store' } as const;

/**
 * Whose keys these are: the /v2 principal (key or grant), or on /api/v1 the signed-in operator.
 * `session` is part of the request hash. On /api/v1 a response replays only to the session that
 * made the request (a rotated token keeps its session id): routes check a recent second factor
 * on the session itself, and a replay never reaches that check. On /v2 it is the principal's
 * scopes. Null skips the check; the route then answers 401 as usual.
 */
function ownerOf(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
): { owner: string; session: string } | null {
  const principal = c.get('principal');
  // The owner of an OAuth principal is its grant, and a refresh may narrow one access token's
  // scopes: the scopes go into the request hash, so a narrower token never gets a replay of a
  // response made with scopes it lacks (the replay runs before the route's scope check).
  if (principal) {
    // On /v2 this runs after the route's scope and Channel check (v2Route), so a Channel path is
    // authorised as it is now before anything replays. A principal limited to some Channels also
    // has its list in the hash on other paths, whose rows a handler checks only after a replay:
    // narrowing the list then makes an old key a different request (409), never a replay.
    const channels =
      principal.channelIds && !/^\/v2\/channels\//.test(c.req.path)
        ? `\nchannels:${[...principal.channelIds].sort().join(' ')}`
        : '';
    return {
      owner: `${principal.kind}:${principal.id}`,
      session: `scopes:${[...principal.scopes].sort().join(' ')}${channels}`,
    };
  }
  const auth = c.get('auth');
  return auth && auth.secondFactor === 'ok'
    ? { owner: `operator:${auth.operatorId}`, session: auth.sessionId }
    : null;
}

/** Mounted on /v2/* (after authentication) and /api/v1/* (after the session and route policy). */
export const idempotency: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
  if (key === undefined || !WRITES.has(c.req.method)) return next();
  const who = ownerOf(c);
  if (!who) return next();
  const { owner, session } = who;
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError('invalid_input', 'Idempotency-Key is 1 to 255 visible characters.');
  }
  const db = env(c).DB;
  const body = await c.req.raw.clone().arrayBuffer();
  const requestHash = await sha256Hex(
    `${c.req.method}\n${c.req.path}\n${session ? `${session}\n` : ''}${new TextDecoder().decode(body)}`,
  );
  const now = Date.now();

  const claimed = await first<{ key: string }>(
    db,
    `INSERT INTO api_idempotency (principal, key, method, path, request_hash, status, response_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7)
     ON CONFLICT (principal, key) DO UPDATE SET method = excluded.method, path = excluded.path,
       request_hash = excluded.request_hash, status = excluded.status, response_json = '',
       created_at = excluded.created_at
       WHERE api_idempotency.created_at <= ?8
     RETURNING key`,
    owner,
    key,
    c.req.method,
    c.req.path,
    requestHash,
    IN_FLIGHT,
    now,
    now - TTL_MS,
  );
  if (!claimed) {
    const stored = await first<{ request_hash: string; status: number; response_json: string }>(
      db,
      'SELECT request_hash, status, response_json FROM api_idempotency WHERE principal = ?1 AND key = ?2',
      owner,
      key,
    );
    if (!stored || stored.request_hash !== requestHash) {
      throw new ApiError('conflict', 'This Idempotency-Key was used for a different request.');
    }
    if (stored.status === IN_FLIGHT) {
      throw new ApiError('conflict', 'A request with this Idempotency-Key is still running.');
    }
    if (stored.status === NOT_KEPT) {
      throw new ApiError(
        'conflict',
        'A request with this Idempotency-Key already ran. Its response is never stored (it held a one-time secret or similar), so it cannot be replayed; check what it created before trying again.',
      );
    }
    const replay = new Response(stored.response_json === '' ? null : stored.response_json, {
      status: stored.status,
      headers: stored.response_json === '' ? {} : { 'content-type': 'application/json' },
    });
    replay.headers.set('Idempotent-Replayed', 'true');
    c.res = replay;
    return;
  }

  try {
    await next();
  } catch (error) {
    await run(db, 'DELETE FROM api_idempotency WHERE principal = ?1 AND key = ?2', owner, key);
    throw error;
  }
  const status = c.res.status;
  if (status >= 500 || status === 429) {
    await run(db, 'DELETE FROM api_idempotency WHERE principal = ?1 AND key = ?2', owner, key);
    return;
  }
  // Storing a secret here would keep it readable for 24 hours after the only time it is shown.
  // Safe by default: a response that carries a bearer value is never kept, marked or not.
  const text = await c.res.clone().text();
  if (/\bno-store\b/i.test(c.res.headers.get('cache-control') ?? '') || holdsSecret(text)) {
    await run(
      db,
      "UPDATE api_idempotency SET status = ?1, response_json = '' WHERE principal = ?2 AND key = ?3",
      NOT_KEPT,
      owner,
      key,
    );
    return;
  }
  await run(
    db,
    'UPDATE api_idempotency SET status = ?1, response_json = ?2 WHERE principal = ?3 AND key = ?4',
    status,
    text,
    owner,
    key,
  );
};
