/**
 * Purpose-scoped, versioned, expiring HMAC tokens.
 *
 * Format: `v1.<purpose>.<kid>.<payload>.<mac>`
 * - payload: base64url(JSON) containing the caller's claims plus `iat` and (usually) `exp`, in seconds
 * - mac: base64url(HMAC-SHA256(key[kid], "v1.<purpose>.<kid>.<payload>"))
 *
 * The purpose is part of the signed input, so a token minted for one job (say, unsubscribe)
 * can never be replayed for another (say, confirm opt-in), even when keys are shared.
 */

import { base64UrlDecode, base64UrlEncode, keyFor, type Keyring } from './keyring';

const VERSION = 'v1';
const PURPOSE_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export type VerifyFailure = 'malformed' | 'purpose' | 'unknown_key' | 'signature' | 'expired';

type VerifyResult<T> =
  { ok: true; payload: T & Claims; kid: string } | { ok: false; reason: VerifyFailure };

interface Claims {
  iat: number;
  exp?: number;
}

interface SignOptions {
  /** Lifetime in seconds. Required unless `noExpiry` is set. */
  expiresInSeconds?: number;
  /** Only for long-lived single-purpose links such as List-Unsubscribe. */
  noExpiry?: true;
  /** Override the clock (milliseconds), for tests. */
  now?: number;
}

export async function signToken(
  keyring: Keyring,
  purpose: string,
  claims: Record<string, unknown>,
  options: SignOptions,
): Promise<string> {
  assertPurpose(purpose);
  const secret = keyring.keys[keyring.current];
  if (!secret) throw new Error(`keyring has no key for current kid "${keyring.current}"`);
  if (options.expiresInSeconds === undefined && !options.noExpiry) {
    throw new Error('tokens must expire; pass expiresInSeconds or noExpiry explicitly');
  }

  const iat = Math.floor((options.now ?? Date.now()) / 1000);
  const body: Record<string, unknown> = { ...claims, iat };
  if (options.expiresInSeconds !== undefined) body.exp = iat + options.expiresInSeconds;

  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(body)));
  const signingInput = `${VERSION}.${purpose}.${keyring.current}.${payload}`;
  const mac = await hmac(secret, signingInput);
  return `${signingInput}.${base64UrlEncode(mac)}`;
}

export async function verifyToken<T = Record<string, unknown>>(
  keyring: Keyring,
  purpose: string,
  token: string,
  options: { now?: number } = {},
): Promise<VerifyResult<T>> {
  assertPurpose(purpose);
  const parts = token.split('.');
  if (parts.length !== 5) return { ok: false, reason: 'malformed' };
  const [version, tokenPurpose, kid, payload, mac] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== VERSION) return { ok: false, reason: 'malformed' };
  if (tokenPurpose !== purpose) return { ok: false, reason: 'purpose' };

  const secret = keyFor(keyring, kid);
  if (!secret) return { ok: false, reason: 'unknown_key' };

  let macBytes: Uint8Array<ArrayBuffer>;
  let payloadBytes: Uint8Array<ArrayBuffer>;
  try {
    macBytes = base64UrlDecode(mac);
    payloadBytes = base64UrlDecode(payload);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const key = await importKey(secret, ['verify']);
  const signingInput = new TextEncoder().encode(`${version}.${tokenPurpose}.${kid}.${payload}`);
  // crypto.subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify('HMAC', key, macBytes, signingInput);
  if (!valid) return { ok: false, reason: 'signature' };

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isClaims(body)) return { ok: false, reason: 'malformed' };

  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (body.exp !== undefined && body.exp <= now) return { ok: false, reason: 'expired' };

  return { ok: true, payload: body as T & Claims, kid };
}

function isClaims(value: unknown): value is Claims {
  if (typeof value !== 'object' || value === null) return false;
  const { iat, exp } = value as Record<string, unknown>;
  return typeof iat === 'number' && (exp === undefined || typeof exp === 'number');
}

function assertPurpose(purpose: string): void {
  if (!PURPOSE_PATTERN.test(purpose)) throw new Error(`invalid token purpose "${purpose}"`);
}

async function importKey(secret: string, usages: ('sign' | 'verify')[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

async function hmac(secret: string, input: string): Promise<Uint8Array> {
  const key = await importKey(secret, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input)));
}
