// Reader sessions on Channel websites. Separate from operator sessions in every way: their own
// table (reader_sessions), their own keyring (READER_KEYS), their own cookie name, and they are
// scoped to one Channel (and to the host the reader signed in on, since the cookie has no Domain).
//
// Cookie: `__Host-swarm_reader` over https (Secure, Path=/, no Domain, HttpOnly, SameSite=Lax).
// `__Host-` cookies must be Secure, which browsers drop over plain http on *.site.localhost, so
// local development (SITE_SCHEME=http) uses the unprefixed `swarm_reader` with the same
// attributes minus Secure. The value is a signed random token (purpose 'reader-session'); only
// its SHA-256 is stored. The signature lets forged cookies fail without a database read; the
// session row is the source of truth for expiry (30 days, sliding, and never more than
// READER_SESSION_MAX_MS after sign-in) and revocation. Starting a session deletes the one the
// browser had; a session whose Member is no longer a reader is deleted when it is next seen (and
// by a trigger as the status changes, migrations/0092); "sign out everywhere" deletes all of a
// Member's sessions on this Channel.
import { first, run, sha256Hex } from '@swarm/db';
import { entitledLevel, readerClassFor } from '@swarm/engine';
import { base64UrlEncode, signToken, verifyToken } from '@swarm/tokens';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Reader, SiteContext } from '../context';

const READER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** However active a session is, it ends this long after sign-in, and the reader signs in again. */
export const READER_SESSION_MAX_MS = 90 * 24 * 60 * 60 * 1000;
/** Sliding sessions are extended at most this often. */
const REFRESH_AFTER_MS = 60 * 60 * 1000;
const SESSION_PURPOSE = 'reader-session';

const READER_COOKIE_SECURE = '__Host-swarm_reader';
const READER_COOKIE_LOCAL = 'swarm_reader';

function readerCookieName(c: SiteContext): string {
  return c.get('env').SITE_SCHEME === 'https' ? READER_COOKIE_SECURE : READER_COOKIE_LOCAL;
}

/** A URL-safe random secret. */
export function randomSecret(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

function writeCookie(c: SiteContext, value: string): void {
  setCookie(c, readerCookieName(c), value, {
    path: '/',
    secure: c.get('env').SITE_SCHEME === 'https',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: READER_SESSION_TTL_MS / 1000,
  });
}

function clearReaderCookie(c: SiteContext): void {
  deleteCookie(c, readerCookieName(c), {
    path: '/',
    secure: c.get('env').SITE_SCHEME === 'https',
    httpOnly: true,
    sameSite: 'Lax',
  });
}

/** Starts a session for a Member of the current Channel and sets the cookie. */
export async function createReaderSession(c: SiteContext, memberId: string): Promise<void> {
  const env = c.get('env');
  // The session this browser had (anyone's) ends here, rather than staying usable elsewhere.
  const previous = getCookie(c, readerCookieName(c));
  if (previous && previous.length <= 512) {
    await run(
      env.DB,
      'DELETE FROM reader_sessions WHERE id_hash = ?1 AND channel_id = ?2',
      await sha256Hex(previous),
      c.get('channel').id,
    );
  }
  // The signed token never expires by itself; the session row's expires_at does (and slides).
  const value = await signToken(
    env.READER_KEYS,
    SESSION_PURPOSE,
    { n: randomSecret() },
    {
      noExpiry: true,
    },
  );
  const now = Date.now();
  await run(
    env.DB,
    `INSERT INTO reader_sessions (id_hash, channel_id, member_id, created_at, last_seen_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?4, ?5)`,
    await sha256Hex(value),
    c.get('channel').id,
    memberId,
    now,
    now + READER_SESSION_TTL_MS,
  );
  writeCookie(c, value);
}

interface SessionRow {
  member_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

interface LoadedSession {
  reader: Reader;
  /** True when the session was extended and the cookie should be written again. */
  refreshed: boolean;
}

/**
 * Resolves the reader cookie to a reader class (and, for paid readers, the Membership level) for
 * this Channel. Anonymous when there is no
 * cookie, the signature or session is not valid, the session belongs to another Channel, or the
 * Member is no longer active or paused.
 */
/** The reader session cookie's value, as sent: what the vault resolves for the Billing Portal. */
export function readerToken(c: SiteContext): string | undefined {
  const value = getCookie(c, readerCookieName(c));
  return value && value.length <= 512 ? value : undefined;
}

export async function loadReaderSession(c: SiteContext): Promise<LoadedSession | null> {
  const value = getCookie(c, readerCookieName(c));
  if (!value || value.length > 512) return null;
  const env = c.get('env');
  const verified = await verifyToken(env.READER_KEYS, SESSION_PURPOSE, value);
  if (!verified.ok) return null;

  const idHash = await sha256Hex(value);
  const now = Date.now();
  const row = await first<SessionRow>(
    env.DB,
    `SELECT member_id, created_at, last_seen_at, expires_at FROM reader_sessions
      WHERE id_hash = ?1 AND channel_id = ?2`,
    idHash,
    c.get('channel').id,
  );
  if (!row || row.expires_at <= now || row.created_at + READER_SESSION_MAX_MS <= now) return null;

  const cls = await readerClassFor(env.DB, c.get('channel').id, row.member_id, now);
  if (cls === 'anonymous') {
    // No longer a reader: the session ends for good, so coming back never revives it.
    await run(env.DB, 'DELETE FROM reader_sessions WHERE id_hash = ?1', idHash);
    return null;
  }

  let refreshed = false;
  if (now - row.last_seen_at > REFRESH_AFTER_MS) {
    await run(
      env.DB,
      'UPDATE reader_sessions SET last_seen_at = ?1, expires_at = ?2 WHERE id_hash = ?3',
      now,
      Math.min(now + READER_SESSION_TTL_MS, row.created_at + READER_SESSION_MAX_MS),
      idHash,
    );
    refreshed = true;
  }
  const levelId =
    cls === 'paid'
      ? ((await entitledLevel(env.DB, c.get('channel').id, row.member_id, now)) ?? null)
      : null;
  return { reader: { class: cls, memberId: row.member_id, levelId }, refreshed };
}

/** Re-sends the current cookie with a fresh Max-Age (after a sliding refresh). */
export function refreshReaderCookie(c: SiteContext): void {
  const value = getCookie(c, readerCookieName(c));
  if (value) writeCookie(c, value);
}

/**
 * Ends the current session, if any, and clears the cookie. With `everywhere`, every session of
 * the same Member on this Channel ends too (other browsers and devices).
 */
export async function endReaderSession(
  c: SiteContext,
  options: { everywhere?: boolean } = {},
): Promise<void> {
  const value = getCookie(c, readerCookieName(c));
  if (value && value.length <= 512) {
    const env = c.get('env');
    const idHash = await sha256Hex(value);
    const channelId = c.get('channel').id;
    await run(
      env.DB,
      options.everywhere
        ? `DELETE FROM reader_sessions WHERE channel_id = ?2 AND member_id = (
             SELECT member_id FROM reader_sessions WHERE id_hash = ?1 AND channel_id = ?2)`
        : 'DELETE FROM reader_sessions WHERE id_hash = ?1 AND channel_id = ?2',
      idHash,
      channelId,
    );
  }
  clearReaderCookie(c);
}
