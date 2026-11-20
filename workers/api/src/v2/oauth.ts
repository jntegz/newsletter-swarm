// OAuth access tokens (oat_…): resolving a presented token to a principal, plus the token
// bookkeeping the /oauth endpoints share (issuing, family revocation). Only sha256 of a token is
// stored. Contract: docs/oauth.md.
import { oauthAccessRow, oauthAccessScopes, run, sha256Hex } from '@swarm/db';
import {
  OAUTH_ACCESS_PREFIX,
  OAUTH_ACCESS_TTL_SECONDS,
  OAUTH_REFRESH_PREFIX,
  OAUTH_REFRESH_TTL_DAYS,
  newId,
  type OAuthResource,
} from '@swarm/domain';
import { env, type AppContext } from '../lib/context';
import type { ApiPrincipal } from './context';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Uniform random base62 characters (rejection sampling, so no character is favoured). */
export function base62(length: number): string {
  let out = '';
  while (out.length < length) {
    const bytes = new Uint8Array(length * 2);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < 248 && out.length < length) out += BASE62[byte % 62];
    }
  }
  return out;
}

/** Last-used times are written at most once a minute per token. */
const TOUCH_EVERY_MS = 60_000;

export { effectiveScopes, LIVE_GRANT_SQL } from '@swarm/db';

/**
 * The principal for a presented access token, or null when it is not a valid, live token for
 * `resource` (RFC 8707: a token bound to /mcp is not accepted by /v2, and the other way round).
 */
export async function resolveOAuthAccess(
  c: AppContext,
  token: string,
  resource: OAuthResource,
): Promise<ApiPrincipal | null> {
  if (!token.startsWith(OAUTH_ACCESS_PREFIX)) return null;
  const db = env(c).DB;
  const now = Date.now();
  const row = await oauthAccessRow(db, await sha256Hex(token), resource, now);
  if (!row) return null;
  if (row.last_used_at === null || row.last_used_at < now - TOUCH_EVERY_MS) {
    await run(db, 'UPDATE oauth_tokens SET last_used_at = ?1 WHERE id = ?2', now, row.id);
  }
  // Never more than the grant allows now, and no more than the token was issued for.
  const scopes = oauthAccessScopes(row);
  return {
    kind: 'oauth',
    // The grant, not the hourly token: rate limits and Idempotency-Key replays must survive a
    // refresh.
    id: row.grant_id,
    workspaceId: row.workspace_id,
    channelIds: row.channel_ids_json ? (JSON.parse(row.channel_ids_json) as string[]) : null,
    scopes,
    plan: row.plan,
    rateCap: null,
  };
}

interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/**
 * A new access and refresh token in `familyId`, for a grant. `narrowed` limits the access token to
 * a subset of `scopes` (a refresh that asked for less); the refresh token keeps all of `scopes`.
 */
export async function issueTokens(
  db: D1Database,
  grantId: string,
  familyId: string,
  scopes: readonly string[],
  now = Date.now(),
  narrowed: readonly string[] | null = null,
): Promise<IssuedTokens> {
  const access = `${OAUTH_ACCESS_PREFIX}${base62(40)}`;
  const refresh = `${OAUTH_REFRESH_PREFIX}${base62(40)}`;
  const insert = `INSERT INTO oauth_tokens (id, grant_id, family_id, kind, token_hash, expires_at, created_at,
       scopes_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`;
  await db.batch([
    db
      .prepare(insert)
      .bind(
        newId('oauthToken', now),
        grantId,
        familyId,
        'access',
        await sha256Hex(access),
        now + OAUTH_ACCESS_TTL_SECONDS * 1000,
        now,
        narrowed ? JSON.stringify(narrowed) : null,
      ),
    db
      .prepare(insert)
      .bind(
        newId('oauthToken', now),
        grantId,
        familyId,
        'refresh',
        await sha256Hex(refresh),
        now + OAUTH_REFRESH_TTL_DAYS * 86_400_000,
        now,
        null,
      ),
  ]);
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: OAUTH_ACCESS_TTL_SECONDS,
    refresh_token: refresh,
    scope: (narrowed ?? scopes).join(' '),
  };
}

/**
 * Revokes a grant and every token issued from it. Used for a replayed code or refresh token
 * (the family is compromised), for an operator revoking an app, and for a revoked app.
 */
export function revokeGrantStatements(db: D1Database, grantId: string, now: number) {
  return [
    db
      .prepare('UPDATE oauth_grants SET revoked_at = coalesce(revoked_at, ?1) WHERE id = ?2')
      .bind(now, grantId),
    db
      .prepare('UPDATE oauth_tokens SET revoked_at = coalesce(revoked_at, ?1) WHERE grant_id = ?2')
      .bind(now, grantId),
  ];
}

export async function revokeGrant(db: D1Database, grantId: string, now = Date.now()) {
  await db.batch(revokeGrantStatements(db, grantId, now));
}
