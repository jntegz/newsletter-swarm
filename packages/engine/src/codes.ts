/**
 * Per-recipient links in a Broadcast.
 *
 * - Click and open tokens: @swarm/tokens with purpose "track". They carry ids only (a delivery
 *   and a server-side link target), never a URL, so the click endpoint can't be an open redirect.
 * - Unsubscribe codes: a compact `<delivery hex>-<mac>` in lowercase hex. They must fit in the
 *   local part of a mailto: address (64 characters) and survive case-folding mail servers, which
 *   a base64url token would not.
 * - Bounce codes: the same shape under their own MAC label and, since the link cutover, their own
 *   key (BOUNCE_KEYS: send signs, events verifies), used only in the VERP return path. The
 *   unsubscribe code is printed in the body and List-Unsubscribe, so anyone with a forwarded copy
 *   holds it; it must not also be able to report a workspace-wide hard bounce. Nor may the workers
 *   that hold UNSUBSCRIBE_KEYS (track, the api) forge one.
 */
import { signToken, verifyToken, type Keyring, type LinkMode } from '@swarm/tokens';

const TRACK_PURPOSE = 'track';
/** Links in old issues keep working for a little over a year. */
const TRACK_LIFETIME_SECONDS = 400 * 24 * 60 * 60;
const MAC_HEX_LENGTH = 20; // 80 bits; the code only ever unsubscribes one delivery's Member.

export interface TrackClaims {
  /** Delivery id. */
  d: string;
  /** Link target id; absent for the open pixel. */
  l?: string;
}

export function trackToken(keys: Keyring, claims: TrackClaims, now?: number): Promise<string> {
  return signToken(
    keys,
    TRACK_PURPOSE,
    { ...claims },
    {
      expiresInSeconds: TRACK_LIFETIME_SECONDS,
      ...(now === undefined ? {} : { now }),
    },
  );
}

export async function readTrackToken(keys: Keyring, token: string): Promise<TrackClaims | null> {
  if (token.length > 512) return null;
  const result = await verifyToken<TrackClaims>(keys, TRACK_PURPOSE, token);
  if (!result.ok) return null;
  const { d, l } = result.payload;
  if (typeof d !== 'string' || !/^dl_[0-9a-f]{32}$/.test(d)) return null;
  if (l !== undefined && (typeof l !== 'string' || !/^lt_[0-9a-f]{32}$/.test(l))) return null;
  return l === undefined ? { d } : { d, l };
}

type CodeLabel = 'unsubscribe' | 'bounce';

async function mac(secret: string, label: CodeLabel, deliveryHex: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${label}:${deliveryHex}`),
  );
  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, MAC_HEX_LENGTH);
}

async function makeCode(keys: Keyring, label: CodeLabel, deliveryId: string): Promise<string> {
  const hex = deliveryId.replace(/^dl_/, '');
  return `${hex}-${await mac(keys.keys[keys.current] as string, label, hex)}`;
}

/** Every key in the ring is tried, so rotation is seamless. */
async function readCode(keys: Keyring, label: CodeLabel, value: string): Promise<string | null> {
  const match = /^([0-9a-f]{32})-([0-9a-f]{20})$/.exec(value.toLowerCase());
  if (!match) return null;
  const [, hex, given] = match as unknown as [string, string, string];
  for (const secret of Object.values(keys.keys)) {
    const expected = await mac(secret, label, hex);
    // Constant-time comparison of equal-length hex strings.
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
    if (diff === 0) return `dl_${hex}`;
  }
  return null;
}

export function unsubscribeCode(keys: Keyring, deliveryId: string): Promise<string> {
  return makeCode(keys, 'unsubscribe', deliveryId);
}

/** Returns the delivery id, or null. */
export function readUnsubscribeCode(keys: Keyring, value: string): Promise<string | null> {
  return readCode(keys, 'unsubscribe', value);
}

/**
 * The code in the return path bounce+<code>@. Never in the body or List-Unsubscribe, but the
 * delivered copy's Return-Path header carries it, so the events worker also bounds its age.
 */
export function bounceCode(keys: Keyring, deliveryId: string): Promise<string> {
  return makeCode(keys, 'bounce', deliveryId);
}

/** Returns the delivery id, or null. An unsubscribe code is not a bounce code. */
export function readBounceCode(keys: Keyring, value: string): Promise<string | null> {
  return readCode(keys, 'bounce', value);
}

/**
 * How long after the link cutover a bounce code signed with UNSUBSCRIBE_KEYS still counts: twice
 * the 7 days the events worker accepts a bounce for, so every code mailed before it is covered.
 */
export const LEGACY_BOUNCE_DAYS = 14;

/**
 * The delivery a bounce code names: under BOUNCE_KEYS, or under UNSUBSCRIBE_KEYS (what signed
 * bounce codes before the cutover) while links are still signed the old way or for
 * LEGACY_BOUNCE_DAYS after. Never an unsubscribe code: the label differs.
 */
export async function readAnyBounceCode(
  keys: { bounceKeys: Keyring; unsubscribeKeys: Keyring; mode: LinkMode },
  value: string,
  now: number = Date.now(),
): Promise<string | null> {
  const current = await readBounceCode(keys.bounceKeys, value);
  if (current) return current;
  const cutoff = keys.mode.legacyCutoffMs;
  if (cutoff !== null && now >= cutoff + LEGACY_BOUNCE_DAYS * 86_400_000) return null;
  return readBounceCode(keys.unsubscribeKeys, value);
}
