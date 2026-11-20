import { all, first, run } from '@swarm/db';
import { uaFamily } from '@swarm/engine';
import { D1FlagStore, FlagService } from '@swarm/flags';
import {
  MFA_GRACE_DAYS,
  NEW_DEVICE_LOOKBACK_DAYS,
  SSO_SESSION_MAX_HOURS,
  newId,
  type MfaMethod,
  type SecondFactorState,
} from '@swarm/domain';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ApiEnv } from '../env';
import { clientIp, env, type AppContext, type AuthContext } from './context';
import { ipPrefix, randomToken, sha256Hex } from './crypto';
import { mailer } from './mail';
import { newDeviceMail } from './security-mail';

const SESSION_COOKIE = '__Host-swarm_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_AFTER_MS = 60 * 60 * 1000;
const CACHE_TTL_SECONDS = 300;
export const MFA_GRACE_MS = MFA_GRACE_DAYS * 24 * 60 * 60 * 1000;
const SSO_SESSION_MAX_MS = SSO_SESSION_MAX_HOURS * 60 * 60 * 1000;

/** Factors the operator holds themselves. An identity provider's MFA claim ('sso') is not one. */
const OWN_FACTORS: readonly MfaMethod[] = ['passkey', 'totp', 'recovery'];
export const provedOwnFactor = (method: MfaMethod | null) =>
  method !== null && OWN_FACTORS.includes(method);

type FirstFactor = 'quickpass' | 'google' | 'sso';

/**
 * What a session row says about its second factor, read together with the operator's factors and
 * policy. Cached with the session; the state is worked out per request, so a grace period that
 * ends while an entry is cached still takes effect.
 */
export interface SessionFacts {
  mfaPending: number;
  mfaMethod: MfaMethod | null;
  mfaVerifiedAt: number | null;
  /** Passkeys plus a confirmed TOTP secret. Recovery codes are a backup, not a factor. */
  factors: number;
  /** 1 when a second factor is required: an owner or admin seat, a workspace with require_2fa
   *  'all', or an instance admin. */
  required: number;
  requiredSince: number | null;
  /** A workspace whose enforced SSO connection captures this operator's domain, unless this
   *  session came through that connection. */
  ssoBlockedWorkspaceId: string | null;
  /** How the session began: quickpass, google or sso. */
  authMethod: FirstFactor;
  createdAt: number;
  /** For a session that came through SSO: the workspace of its connection while that connection
   *  is active, else null (its provider is no longer trusted). */
  ssoWorkspaceId: string | null;
}

interface CachedSession extends SessionFacts {
  sessionId: string;
  operatorId: string;
  email: string;
  expiresAt: number;
  lastSeenAt: number;
}

const cacheKey = (tokenHash: string) => `sess:v2:${tokenHash}`;

/** SQL that reads SessionFacts for `s` (sessions) joined to `o` (operators). */
const SESSION_FACTS_SQL = `
  s.mfa_pending AS mfaPending, s.mfa_method AS mfaMethod, s.mfa_verified_at AS mfaVerifiedAt,
  o.mfa_required_since AS requiredSince,
  (SELECT COUNT(*) FROM passkeys p WHERE p.operator_id = o.id)
    + (SELECT COUNT(*) FROM totp_secrets t WHERE t.operator_id = o.id AND t.confirmed_at IS NOT NULL)
    AS factors,
  (EXISTS (SELECT 1 FROM seats st JOIN workspaces w ON w.id = st.workspace_id
           WHERE st.operator_id = o.id AND (st.role IN ('owner', 'admin') OR w.require_2fa = 'all'))
    OR EXISTS (SELECT 1 FROM instance_admins ia WHERE ia.operator_id = o.id))
    AS required,
  (SELECT c.workspace_id FROM sso_domains d JOIN sso_connections c ON c.id = d.connection_id
    WHERE d.domain = substr(o.email, instr(o.email, '@') + 1) AND d.verified_at IS NOT NULL
      AND c.status = 'active' AND c.enforced = 1
      AND (s.sso_connection_id IS NULL OR s.sso_connection_id <> c.id)
    LIMIT 1) AS ssoBlockedWorkspaceId,
  s.auth_method AS authMethod, s.created_at AS createdAt,
  (SELECT c.workspace_id FROM sso_connections c
    WHERE c.id = s.sso_connection_id AND c.status = 'active') AS ssoWorkspaceId`;

/**
 * The rule (docs/security.md "Second factor"): a session that proved a second factor is done. One
 * that did not must verify whenever the operator has a factor; with no factor, it must enrol once
 * the grace period is over. Otherwise it may work (with a prompt during the grace period).
 * mfa_pending is not consulted: a session written without it (a sign-in racing the first factor
 * being added) still owes the factor, so the state fails closed.
 */
export function secondFactorState(facts: SessionFacts, now = Date.now()): SecondFactorState {
  if (facts.mfaMethod) return 'ok';
  if (facts.factors > 0) return 'verify';
  return graceEnded(facts, now) ? 'enroll' : 'ok';
}

function graceEnded(facts: SessionFacts, now = Date.now()): boolean {
  return (
    !!facts.required && facts.requiredSince !== null && now >= facts.requiredSince + MFA_GRACE_MS
  );
}

/**
 * Starts the grace period the first time a second factor is required, and clears it when nothing
 * requires one any more (so a later promotion gets a fresh one). Bookkeeping like last_seen_at:
 * it changes no permission by itself. Returns the effective value.
 */
async function syncRequiredSince(
  e: ApiEnv,
  operatorId: string,
  facts: Pick<SessionFacts, 'required' | 'requiredSince' | 'factors'>,
  now = Date.now(),
): Promise<number | null> {
  if (facts.required && facts.requiredSince === null) {
    await run(
      e.DB,
      'UPDATE operators SET mfa_required_since = ?1 WHERE id = ?2 AND mfa_required_since IS NULL',
      now,
      operatorId,
    );
    return now;
  }
  if (!facts.required && facts.requiredSince !== null) {
    await run(e.DB, 'UPDATE operators SET mfa_required_since = NULL WHERE id = ?1', operatorId);
    return null;
  }
  return facts.requiredSince;
}

function writeCookie(c: AppContext, token: string): void {
  // __Host- forces Secure, Path=/ and no Domain. Browsers treat localhost as secure.
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: AppContext): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
}

interface CreateSessionOptions {
  method: FirstFactor;
  ssoConnectionId?: string;
  /** The identity provider asserted MFA (amr/acr): it counts as the second factor. */
  idpMfa?: boolean;
}

/**
 * Creates a session for the operator after a first factor and sets the cookie. The session is
 * created pending (mfa_pending = 1) when the operator has a second factor, or must have one and
 * their grace period is over. Returns the session id.
 */
/**
 * After "This wasn't me" undid a first factor (routes/security.ts), the next sign-in must be an
 * email link: Google and SSO callbacks refuse until a QuickPass sign-in clears the mark.
 */
export async function emailSignInRequired(e: ApiEnv, operatorId: string): Promise<boolean> {
  return !!(await first(
    e.DB,
    'SELECT 1 FROM operators WHERE id = ?1 AND email_signin_required_at IS NOT NULL',
    operatorId,
  ));
}

export async function createSession(
  c: AppContext,
  operatorId: string,
  options: CreateSessionOptions,
): Promise<string> {
  const e = env(c);
  const now = Date.now();
  if (options.method === 'quickpass') {
    await run(
      e.DB,
      'UPDATE operators SET email_signin_required_at = NULL WHERE id = ?1 AND email_signin_required_at IS NOT NULL',
      operatorId,
    );
  }
  const facts = await first<Pick<SessionFacts, 'factors' | 'required' | 'requiredSince'>>(
    e.DB,
    `SELECT o.mfa_required_since AS requiredSince,
            (SELECT COUNT(*) FROM passkeys p WHERE p.operator_id = o.id)
              + (SELECT COUNT(*) FROM totp_secrets t WHERE t.operator_id = o.id AND t.confirmed_at IS NOT NULL)
              AS factors,
            (EXISTS (SELECT 1 FROM seats st JOIN workspaces w ON w.id = st.workspace_id
                     WHERE st.operator_id = o.id AND (st.role IN ('owner', 'admin') OR w.require_2fa = 'all'))
              OR EXISTS (SELECT 1 FROM instance_admins ia WHERE ia.operator_id = o.id))
              AS required
       FROM operators o WHERE o.id = ?1`,
    operatorId,
  );
  if (!facts) throw new Error('operator vanished');
  const requiredSince = await syncRequiredSince(e, operatorId, facts, now);
  const idpMfa = options.idpMfa === true;
  const pending =
    !idpMfa && (facts.factors > 0 || graceEnded({ ...facts, requiredSince } as SessionFacts, now));

  const userAgent = c.req.header('user-agent')?.slice(0, 300) ?? null;
  const network = ipPrefix(clientIp(c));
  const seenBefore = await knownDevice(e, operatorId, userAgent, network, now);

  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const id = newId('session');
  await run(
    e.DB,
    `INSERT INTO sessions (id, token_hash, operator_id, user_agent, ip_prefix, created_at, last_seen_at,
                           expires_at, mfa_pending, mfa_method, mfa_verified_at, auth_method, sso_connection_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    id,
    tokenHash,
    operatorId,
    userAgent,
    network,
    now,
    now + SESSION_TTL_MS,
    pending ? 1 : 0,
    idpMfa ? 'sso' : null,
    idpMfa ? now : null,
    options.method,
    options.ssoConnectionId ?? null,
  );
  // The session this browser held ends with the cookie being replaced, so a copy of its token
  // (whoever signed in, and wherever the copy is) stops working too.
  const previous = getCookie(c, SESSION_COOKIE);
  if (previous && previous.length <= 100) {
    const previousHash = await sha256Hex(previous);
    await run(
      e.DB,
      'UPDATE sessions SET revoked_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL',
      now,
      previousHash,
    );
    await e.CACHE.delete(cacheKey(previousHash));
  }
  writeCookie(c, token);

  if (seenBefore === false) {
    const operator = await first<{ email: string }>(
      e.DB,
      'SELECT email FROM operators WHERE id = ?1',
      operatorId,
    );
    if (operator) {
      try {
        await mailer(e).send(newDeviceMail(e, operator.email, { userAgent, network, at: now }));
      } catch (error) {
        // A mail outage must not stop the sign-in; the device still shows in Settings → Devices.
        c.get('log').warn('new device mail failed', { error: (error as Error).message });
      }
    }
  }
  return id;
}

/**
 * Whether this browser family and network appeared in the operator's sessions within
 * NEW_DEVICE_LOOKBACK_DAYS. Null on a first sign-in ever (there is nothing to compare with, and
 * no reason to warn).
 */
async function knownDevice(
  e: ApiEnv,
  operatorId: string,
  userAgent: string | null,
  network: string | null,
  now: number,
): Promise<boolean | null> {
  const rows = await all<{ user_agent: string | null; ip_prefix: string | null }>(
    e.DB,
    `SELECT DISTINCT user_agent, ip_prefix FROM sessions
      WHERE operator_id = ?1 AND last_seen_at > ?2 LIMIT 500`,
    operatorId,
    now - NEW_DEVICE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  if (!rows.length) {
    const ever = await first(
      e.DB,
      'SELECT 1 FROM sessions WHERE operator_id = ?1 LIMIT 1',
      operatorId,
    );
    if (!ever) return null;
    return false;
  }
  const family = uaFamily(userAgent);
  return rows.some((row) => uaFamily(row.user_agent) === family && row.ip_prefix === network);
}

/**
 * Resolves the session cookie to an operator. Reads the derived facts through a short KV cache,
 * but liveness always from the session row: a cached copy can't outlive a revocation, even one
 * written back by a request that read the row just before it was revoked. Sessions slide: an
 * active session is extended at most once an hour.
 */
/** The session cookie's value, as sent: what the vault resolves (lib/vault.ts). */
export function sessionToken(c: AppContext): string | undefined {
  const token = getCookie(c, SESSION_COOKIE);
  return token && token.length <= 100 ? token : undefined;
}

export async function loadSession(c: AppContext): Promise<AuthContext | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const e = env(c);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();

  let session = await e.CACHE.get<CachedSession>(cacheKey(tokenHash), 'json');
  if (session) {
    // Revocation is recorded in D1; the cache only saves working out the facts again.
    const live = await first(
      e.DB,
      'SELECT 1 FROM sessions WHERE token_hash = ?1 AND revoked_at IS NULL',
      tokenHash,
    );
    if (!live) {
      await e.CACHE.delete(cacheKey(tokenHash));
      return null;
    }
  } else {
    const row = await first<CachedSession>(
      e.DB,
      `SELECT s.id AS sessionId, s.operator_id AS operatorId, o.email AS email,
              s.expires_at AS expiresAt, s.last_seen_at AS lastSeenAt, ${SESSION_FACTS_SQL}
         FROM sessions s JOIN operators o ON o.id = s.operator_id
        WHERE s.token_hash = ?1 AND s.revoked_at IS NULL`,
      tokenHash,
    );
    if (!row) return null;
    row.requiredSince = await syncRequiredSince(e, row.operatorId, row, now);
    session = row;
    await e.CACHE.put(cacheKey(tokenHash), JSON.stringify(session), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  }
  if (session.expiresAt <= now) return null;
  if (session.authMethod === 'sso' && !(await ssoSessionTrusted(c, session, now))) return null;

  if (now - session.lastSeenAt > REFRESH_AFTER_MS) {
    await run(
      e.DB,
      'UPDATE sessions SET last_seen_at = ?1, expires_at = ?2 WHERE id = ?3 AND revoked_at IS NULL',
      now,
      now + SESSION_TTL_MS,
      session.sessionId,
    );
    await e.CACHE.delete(cacheKey(tokenHash));
    writeCookie(c, token);
  }

  return {
    operatorId: session.operatorId,
    email: session.email,
    sessionId: session.sessionId,
    tokenHash,
    secondFactor: secondFactorState(session, now),
    mfaMethod: session.mfaMethod,
    mfaVerifiedAt: session.mfaVerifiedAt,
    ssoBlockedWorkspaceId: session.ssoBlockedWorkspaceId,
    // Until the operator proves a factor of their own, the provider speaks only for its workspace.
    ssoWorkspaceId:
      session.authMethod === 'sso' && !provedOwnFactor(session.mfaMethod)
        ? session.ssoWorkspaceId
        : null,
  };
}

/**
 * A session that came through an identity provider lasts only while that provider is trusted:
 * its connection still exists and is active (deleting, repointing or disabling it also revokes
 * the session), the platform sso flag is on, and for at most SSO_SESSION_MAX_HOURS from sign-in.
 * Otherwise it reads as signed out, and the operator signs in again.
 */
async function ssoSessionTrusted(c: AppContext, session: CachedSession, now: number) {
  if (!session.ssoWorkspaceId) return false;
  if (now >= session.createdAt + SSO_SESSION_MAX_MS) return false;
  const e = env(c);
  return new FlagService(new D1FlagStore(e.DB, e.CACHE)).enabled('sso', {});
}

/**
 * Ends every live session that came through one SSO connection, before its trust is withdrawn
 * (the connection is removed, repointed or no longer active). Returns how many ended.
 */
export async function revokeConnectionSessions(e: ApiEnv, connectionId: string): Promise<number> {
  const rows = await all<{ token_hash: string }>(
    e.DB,
    `UPDATE sessions SET revoked_at = ?1
      WHERE sso_connection_id = ?2 AND revoked_at IS NULL RETURNING token_hash`,
    Date.now(),
    connectionId,
  );
  await Promise.all(rows.map((row) => e.CACHE.delete(cacheKey(row.token_hash))));
  return rows.length;
}

/** Reads SessionFacts for one session id, uncached (sign-in responses and Settings → Security). */
export async function sessionFacts(e: ApiEnv, sessionId: string): Promise<SessionFacts | null> {
  return first<SessionFacts>(
    e.DB,
    `SELECT ${SESSION_FACTS_SQL} FROM sessions s JOIN operators o ON o.id = s.operator_id
      WHERE s.id = ?1`,
    sessionId,
  );
}

/**
 * Records a verified second factor on the current session and rotates its token (a privilege
 * change), so a token captured before the check is worth nothing after it.
 */
export async function markSecondFactor(
  c: AppContext,
  auth: AuthContext,
  method: MfaMethod,
): Promise<void> {
  const e = env(c);
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const updated = await first(
    e.DB,
    `UPDATE sessions SET token_hash = ?1, mfa_pending = 0, mfa_method = ?2, mfa_verified_at = ?3
      WHERE id = ?4 AND token_hash = ?5 AND revoked_at IS NULL RETURNING id`,
    tokenHash,
    method,
    now,
    auth.sessionId,
    auth.tokenHash,
  );
  await e.CACHE.delete(cacheKey(auth.tokenHash));
  if (!updated) throw new Error('session vanished during verification');
  writeCookie(c, token);
}

/**
 * When an operator adds their first factor, sessions that never proved one become pending, so a
 * first factor alone (an old session, a lost laptop) no longer gets past the new factor.
 */
export async function holdOtherSessions(
  e: ApiEnv,
  operatorId: string,
  keepSessionId: string,
): Promise<void> {
  const rows = await all<{ token_hash: string }>(
    e.DB,
    `UPDATE sessions SET mfa_pending = 1
      WHERE operator_id = ?1 AND id <> ?2 AND revoked_at IS NULL AND mfa_method IS NULL
     RETURNING token_hash`,
    operatorId,
    keepSessionId,
  );
  await Promise.all(rows.map((row) => e.CACHE.delete(cacheKey(row.token_hash))));
}

/**
 * Drops the cached copy of every live session of an operator whose address is on a domain the
 * connection verified, so a change to its enforcement applies on their next request.
 */
export async function forgetCapturedSessions(e: ApiEnv, connectionId: string): Promise<void> {
  const rows = await all<{ token_hash: string }>(
    e.DB,
    `SELECT s.token_hash FROM sessions s JOIN operators o ON o.id = s.operator_id
      WHERE s.revoked_at IS NULL AND s.expires_at > ?2
        AND substr(o.email, instr(o.email, '@') + 1) IN (
          SELECT domain FROM sso_domains WHERE connection_id = ?1 AND verified_at IS NOT NULL)`,
    connectionId,
    Date.now(),
  );
  await Promise.all(rows.map((row) => e.CACHE.delete(cacheKey(row.token_hash))));
}

/** Drops the cached copy of every live session of an operator (after a policy or factor change). */
export async function forgetCachedSessions(e: ApiEnv, operatorId: string): Promise<void> {
  const rows = await all<{ token_hash: string }>(
    e.DB,
    'SELECT token_hash FROM sessions WHERE operator_id = ?1 AND revoked_at IS NULL AND expires_at > ?2',
    operatorId,
    Date.now(),
  );
  await Promise.all(rows.map((row) => e.CACHE.delete(cacheKey(row.token_hash))));
}

export async function revokeSession(
  e: ApiEnv,
  operatorId: string,
  sessionId: string,
): Promise<boolean> {
  const row = await first<{ tokenHash: string }>(
    e.DB,
    `UPDATE sessions SET revoked_at = ?1 WHERE id = ?2 AND operator_id = ?3 AND revoked_at IS NULL
     RETURNING token_hash AS tokenHash`,
    Date.now(),
    sessionId,
    operatorId,
  );
  if (!row) return false;
  await e.CACHE.delete(cacheKey(row.tokenHash));
  return true;
}

/** Sign out everywhere: revokes every live session (optionally not this one) and its cache entry. */
export async function revokeAllSessions(
  e: ApiEnv,
  operatorId: string,
  exceptSessionId: string | null,
): Promise<number> {
  const rows = await all<{ token_hash: string }>(
    e.DB,
    `UPDATE sessions SET revoked_at = ?1
      WHERE operator_id = ?2 AND revoked_at IS NULL AND id <> ?3
     RETURNING token_hash`,
    Date.now(),
    operatorId,
    exceptSessionId ?? '',
  );
  await Promise.all(rows.map((row) => e.CACHE.delete(cacheKey(row.token_hash))));
  return rows.length;
}

/**
 * A role change is a privilege change, so the operator's session tokens are replaced. The
 * current session (when it is theirs) gets a new token in place and a new cookie; their other
 * sessions end, because a cookie in someone else's browser can't be swapped. A token captured
 * before the change is worth nothing after it. Returns how many sessions ended.
 */
export async function rotateSessionsForRoleChange(
  c: AppContext,
  operatorId: string,
  current: AuthContext,
): Promise<number> {
  const e = env(c);
  if (operatorId !== current.operatorId) return revokeAllSessions(e, operatorId, null);
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const updated = await first(
    e.DB,
    `UPDATE sessions SET token_hash = ?1 WHERE id = ?2 AND token_hash = ?3 AND revoked_at IS NULL
     RETURNING id`,
    tokenHash,
    current.sessionId,
    current.tokenHash,
  );
  await e.CACHE.delete(cacheKey(current.tokenHash));
  if (updated) writeCookie(c, token);
  return revokeAllSessions(e, operatorId, current.sessionId);
}
