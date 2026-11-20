/**
 * Svix webhook signatures (Resend's webhooks are sent through Svix).
 *
 * - The secret is `whsec_<base64 key>`; the HMAC key is the decoded part after the prefix.
 * - Signed content is `${svix-id}.${svix-timestamp}.${raw body}`, HMAC-SHA256, base64.
 * - svix-signature is a space-separated list of `v1,<base64>`; any one matching is enough
 *   (several appear while a secret is being rotated).
 * - Timestamps more than five minutes from now are refused, which limits replay; within that
 *   window each svix-id is accepted once (claimSvixId).
 */

export interface SvixHeaders {
  id: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
}

export type SvixFailure = 'malformed' | 'secret' | 'stale' | 'signature';

const TOLERANCE_SECONDS = 5 * 60;
/** Longer than any id can pass the time check: twice the tolerance, plus a margin. */
const ID_LIFETIME_MS = (2 * TOLERANCE_SECONDS + 60 * 60) * 1000;

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Compares two strings in time that depends only on their lengths. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The base64 signature Svix would send for this message (also used by tests). */
export async function svixSignature(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
): Promise<string | null> {
  const key = base64ToBytes(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret);
  if (!key || key.length === 0) return null;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return bytesToBase64(new Uint8Array(mac));
}

export async function verifySvix(
  secret: string,
  headers: SvixHeaders,
  rawBody: string,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: SvixFailure }> {
  const { id, timestamp, signature } = headers;
  if (!id || id.length > 200 || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) {
    return { ok: false, reason: 'malformed' };
  }
  if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale' };
  }
  const expected = await svixSignature(secret, id, timestamp, rawBody);
  if (!expected) return { ok: false, reason: 'secret' };
  let match = false;
  for (const part of signature.split(' ')) {
    const [version, value] = part.split(',', 2);
    // Check every candidate rather than stopping early, so timing says nothing about which.
    if (version === 'v1' && value && constantTimeEqual(value, expected)) match = true;
  }
  return match ? { ok: true } : { ok: false, reason: 'signature' };
}

/** Which endpoint an id was accepted on: each has its own secret, so ids may coincide. */
export type SvixScope = 'resend' | 'smtp-feedback';

/**
 * True the first time a webhook event key is seen within `lifetimeMs`, so a captured request
 * can't be applied again while it still passes its sender's checks. Also clears expired keys.
 * Every provider shares svix_webhook_ids; each key starts with its provider.
 */
export async function claimWebhookId(
  db: D1Database,
  key: string,
  lifetimeMs: number,
  now = Date.now(),
): Promise<boolean> {
  const [, inserted] = await db.batch([
    db.prepare('DELETE FROM svix_webhook_ids WHERE expires_at < ?1').bind(now),
    db
      .prepare('INSERT OR IGNORE INTO svix_webhook_ids (id, expires_at) VALUES (?1, ?2)')
      .bind(key, now + lifetimeMs),
  ]);
  return (inserted?.meta.changes ?? 0) > 0;
}

/** Forgets a key whose event could not be applied, so the sender's retry is accepted. */
export async function releaseWebhookId(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM svix_webhook_ids WHERE id = ?1').bind(key).run();
}

/**
 * True the first time a verified svix-id is seen, so a captured request can't be applied again
 * within the time check. Also clears ids too old to pass it.
 */
export function claimSvixId(
  db: D1Database,
  scope: SvixScope,
  id: string,
  now = Date.now(),
): Promise<boolean> {
  return claimWebhookId(db, `${scope}:${id}`, ID_LIFETIME_MS, now);
}

/** Forgets an id whose event could not be applied, so the sender's retry is accepted. */
export function releaseSvixId(db: D1Database, scope: SvixScope, id: string): Promise<void> {
  return releaseWebhookId(db, `${scope}:${id}`);
}
