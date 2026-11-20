/**
 * Mailgun webhook signatures.
 *
 * The signature is the hex HMAC-SHA256 of `timestamp + token`, keyed with the account's webhook
 * signing key. It does not cover the event, so a captured signature could be sent again with a
 * different event inside. Each token is therefore accepted once (claimMailgunToken), and bound
 * to the event it first came with: a token released after a failed apply is accepted again only
 * with that same event, never a substituted one. The events worker also applies an event only
 * when it agrees with what Swarm recorded for the send it names (feedback.ts corroborateEvent).
 *
 * Mailgun retries a failed webhook for 8 hours and doesn't say whether a retry is signed afresh, so
 * the time check allows a day, and tokens are remembered for longer than that.
 */

export interface MailgunSignature {
  timestamp: string;
  token: string;
  signature: string;
}

export type MailgunSignatureFailure = 'malformed' | 'stale' | 'signature';

const TOLERANCE_SECONDS = 24 * 60 * 60;
const TOKEN_LIFETIME_MS = (TOLERANCE_SECONDS + 60 * 60) * 1000;

/** The `signature` object of a webhook body, or null when it isn't one. */
export function readMailgunSignature(value: unknown): MailgunSignature | null {
  if (typeof value !== 'object' || value === null) return null;
  const { timestamp, token, signature } = value as Record<string, unknown>;
  const time = typeof timestamp === 'number' ? String(timestamp) : timestamp;
  if (typeof time !== 'string' || !/^\d{1,12}$/.test(time)) return null;
  if (typeof token !== 'string' || token.length === 0 || token.length > 200) return null;
  if (typeof signature !== 'string' || !/^[0-9a-fA-F]{64}$/.test(signature)) return null;
  return { timestamp: time, token, signature };
}

const signingKey = (key: string, usage: 'sign' | 'verify') =>
  crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );

/** The hex signature Mailgun would send (tests use it too). */
export async function mailgunSignature(
  key: string,
  timestamp: string,
  token: string,
): Promise<string> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    await signingKey(key, 'sign'),
    new TextEncoder().encode(`${timestamp}${token}`),
  );
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyMailgunSignature(
  key: string,
  value: unknown,
  now = Date.now(),
): Promise<{ ok: true; token: string } | { ok: false; reason: MailgunSignatureFailure }> {
  const parsed = readMailgunSignature(value);
  if (!parsed) return { ok: false, reason: 'malformed' };
  if (Math.abs(now / 1000 - Number(parsed.timestamp)) > TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale' };
  }
  const bytes = Uint8Array.from(parsed.signature.match(/../g) ?? [], (h) => parseInt(h, 16));
  // subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify(
    'HMAC',
    await signingKey(key, 'verify'),
    bytes,
    new TextEncoder().encode(`${parsed.timestamp}${parsed.token}`),
  );
  return valid ? { ok: true, token: parsed.token } : { ok: false, reason: 'signature' };
}

/** The hash a token is bound to: the event it came with, as parsed and written out again. */
export async function mailgunEventHash(event: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(event ?? null)),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * True the first time a token is seen, or when a token released after a failed apply comes back
 * with the same event (Mailgun's retry). Also clears tokens too old to pass the time check.
 */
export async function claimMailgunToken(
  db: D1Database,
  token: string,
  now = Date.now(),
  eventHash: string | null = null,
): Promise<boolean> {
  const [, claimed] = await db.batch([
    db.prepare('DELETE FROM mailgun_webhook_tokens WHERE expires_at < ?1').bind(now),
    db
      .prepare(
        `INSERT INTO mailgun_webhook_tokens (token, expires_at, event_hash, released) VALUES (?1, ?2, ?3, 0)
         ON CONFLICT (token) DO UPDATE SET released = 0
           WHERE mailgun_webhook_tokens.released = 1
             AND mailgun_webhook_tokens.event_hash IS excluded.event_hash
         RETURNING token`,
      )
      .bind(token, now + TOKEN_LIFETIME_MS, eventHash),
  ]);
  return (claimed?.results.length ?? 0) > 0;
}

/**
 * Lets a token whose event could not be applied be claimed again, so Mailgun's retry is accepted.
 * It stays bound to its event, so the released token can't carry a different one.
 */
export async function releaseMailgunToken(db: D1Database, token: string): Promise<void> {
  await db
    .prepare('UPDATE mailgun_webhook_tokens SET released = 1 WHERE token = ?1')
    .bind(token)
    .run();
}
