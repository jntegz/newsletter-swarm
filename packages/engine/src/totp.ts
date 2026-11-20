/**
 * TOTP (RFC 6238) codes: HOTP with HMAC-SHA1, as every authenticator app implements it. Shared by
 * the api (workers/api/src/lib/mfa.ts) and the vault, which holds the sealed secrets.
 */
import { PRODUCT_NAME, TOTP_DIGITS, TOTP_PERIOD_SECONDS, TOTP_WINDOW } from '@swarm/domain';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '').toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** HOTP (RFC 4226) with HMAC-SHA1, as every authenticator app implements it. */
export async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ]);
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export const totpStep = (now = Date.now()) => Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);

/**
 * The time step a code matches, within TOTP_WINDOW steps of now and after `lastStep` (a code, or
 * an older one, is never accepted twice). Compares every candidate so timing reveals nothing.
 */
export async function matchTotp(
  secret: Uint8Array,
  code: string,
  lastStep: number | null,
  now = Date.now(),
): Promise<number | null> {
  const current = totpStep(now);
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    const expected = await hotp(secret, step);
    let diff = expected.length ^ code.length;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ (code.charCodeAt(i) || 0);
    }
    if (diff === 0 && (lastStep === null || step > lastStep) && matched === null) matched = step;
  }
  return matched;
}

export function newTotpSecret(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

export function otpauthUri(secret: string, email: string): string {
  const label = encodeURIComponent(`${PRODUCT_NAME}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer: PRODUCT_NAME,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
