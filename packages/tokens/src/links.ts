/**
 * v2 links: `v2.<purpose>.<kid>.<payload>.<sig>`.
 * - payload: base64url(JSON) of the claims plus `iat` and `exp` (seconds).
 * - sig: base64url of HMAC-SHA256 or Ed25519 over `v2.<purpose>.<kid>.<payload>`. The algorithm
 *   and keyring follow from the purpose's family (families.ts), never from the token.
 *
 * v1 tokens signed with MEMBER_KEYS before the cutover still verify for a while (`legacy`), under
 * the rule in verifyLink. The installer's two-pass deploy sets the cutover: every verifier first
 * accepts v2, then the signers switch (LINK_SIGNING_MODE, LINK_LEGACY_CUTOFF).
 */
import { familyOf, type FamilySpec } from './families';
import { base64UrlDecode, base64UrlEncode, ownKey, type Keyring } from './keyring';
import type { SigningKeyring, VerifyKeyring } from './keyrings';
import { verifyToken, type VerifyFailure } from './v1';

/**
 * Whether every signer in this code can sign v2 links. The installer runs the cutover's second
 * pass (signers switch to v2, MEMBER_KEYS starts to retire) only when this is true. A release
 * build records it in its signed manifest (`linkSigning`), which is what the Setup Worker reads.
 */
export const LINK_V2_SIGNING_READY = true;

const VERSION = 'v2';
/** Longer than any link Swarm makes; refused before any parsing. */
const MAX_TOKEN_LENGTH = 2048;

export type LinkFailure = VerifyFailure | 'lifetime' | 'tenant' | 'legacy_closed';

export type LinkResult<T> =
  | { ok: true; payload: T & { iat: number; exp?: number }; kid: string; legacy: boolean }
  | { ok: false; reason: LinkFailure };

/** The MEMBER_KEYS keyring and the cutover, for verifiers that still accept v1 links. */
export interface LegacyLinks {
  keyring: Keyring;
  /** When signers switched to v2 (ms); null before that, while signers still issue v1. */
  cutoffMs: number | null;
}

function assertRing(spec: FamilySpec, ring: { name: string; alg: string }): void {
  // A wrong keyring is a bug in the caller: refuse loudly rather than fail one token at a time.
  if (ring.name !== spec.keyring || ring.alg !== spec.alg) {
    throw new Error(
      `the "${spec.purpose}" family needs ${spec.keyring} (${spec.alg}), not ${ring.name} (${ring.alg})`,
    );
  }
}

const signAlg = (spec: FamilySpec) => (spec.alg === 'ed25519' ? 'Ed25519' : 'HMAC');

/**
 * Signs a v2 link. The lifetime defaults to the family's longest and may not exceed it; the
 * family's tenant claim (`c` or `w`) must be in the claims.
 */
export async function signLink(
  purpose: string,
  ring: SigningKeyring,
  claims: Record<string, unknown>,
  options: { now?: number; expiresInSeconds?: number } = {},
): Promise<string> {
  const spec = familyOf(purpose);
  assertRing(spec, ring);
  const key = ownKey(ring.keys, ring.current);
  if (!key) throw new Error(`${ring.name} has no key for current kid "${ring.current}"`);
  if ('iat' in claims || 'exp' in claims) throw new Error('iat and exp are set by signLink');
  const tenant = spec.tenantClaim;
  if (tenant && (typeof claims[tenant] !== 'string' || claims[tenant] === '')) {
    throw new Error(`a "${purpose}" link must name its tenant in "${tenant}"`);
  }
  const lifetime = options.expiresInSeconds ?? spec.maxLifetimeSeconds;
  if (lifetime !== null) {
    if (!Number.isInteger(lifetime) || lifetime < 1) throw new Error('invalid link lifetime');
    if (spec.maxLifetimeSeconds !== null && lifetime > spec.maxLifetimeSeconds) {
      throw new Error(`a "${purpose}" link lives at most ${spec.maxLifetimeSeconds} seconds`);
    }
  }
  const iat = Math.floor((options.now ?? Date.now()) / 1000);
  const body: Record<string, unknown> = { ...claims, iat };
  if (lifetime !== null) body.exp = iat + lifetime;
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(body)));
  const input = `${VERSION}.${purpose}.${ring.current}.${payload}`;
  const sig = await crypto.subtle.sign(signAlg(spec), key, new TextEncoder().encode(input));
  return `${input}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/**
 * Verifies a link of `purpose` with the family's own keyring. A v1 token verifies only through
 * `legacy`, and only when all of these hold:
 * - the family took v1 tokens under MEMBER_KEYS (`spec.legacy`), and the caller passes `legacy`;
 * - the v1 MAC verifies under MEMBER_KEYS, and the token has not expired;
 * - it lived at most the family's v1 lifetime (`exp - iat`);
 * - after the cutover: it was issued before it, and the family's window since it has not passed.
 * A holder of the old key can backdate `iat`, but no v1 token verifies after
 * `cutoff + acceptForSeconds`, so the window closes by itself even before the key is removed.
 * A legacy result carries no tenant claim: the caller checks the tenant against its row.
 */
export async function verifyLink<T = Record<string, unknown>>(
  purpose: string,
  ring: VerifyKeyring,
  token: string,
  options: {
    now?: number;
    legacy?: LegacyLinks;
    /** The family's former keyring (FamilySpec.formerKeyring), for links signed with it before. */
    former?: VerifyKeyring;
  } = {},
): Promise<LinkResult<T>> {
  const spec = familyOf(purpose);
  assertRing(spec, ring);
  if (options.former && options.former.name !== spec.formerKeyring) {
    throw new Error(`"${purpose}" links were never signed with ${options.former.name}`);
  }
  if (spec.alg === 'ed25519' && 'current' in ring) {
    throw new Error(`verify "${purpose}" links with the public keys (parseVerifyKeyring)`);
  }
  const now = options.now ?? Date.now();
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' };
  if (token.startsWith('v1.')) return verifyLegacy<T>(spec, token, now, options.legacy);

  const parts = token.split('.');
  if (parts.length !== 5) return { ok: false, reason: 'malformed' };
  const [version, tokenPurpose, kid, payload, sig] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== VERSION) return { ok: false, reason: 'malformed' };
  if (tokenPurpose !== purpose) return { ok: false, reason: 'purpose' };
  // The family's own key, then its former ring's under the same id (FamilySpec.formerKeyring).
  const keys = [ownKey(ring.keys, kid), options.former && ownKey(options.former.keys, kid)].filter(
    (k): k is NonNullable<typeof k> => !!k,
  );
  if (!keys.length) return { ok: false, reason: 'unknown_key' };

  let sigBytes: Uint8Array<ArrayBuffer>;
  let payloadBytes: Uint8Array<ArrayBuffer>;
  try {
    sigBytes = base64UrlDecode(sig);
    payloadBytes = base64UrlDecode(payload);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  // A signature of the wrong length is refused here: workerd's Ed25519 verify throws on one,
  // and a forged link must be a refusal, never an error.
  if (sigBytes.length !== (spec.alg === 'ed25519' ? 64 : 32)) {
    return { ok: false, reason: 'signature' };
  }
  const input = new TextEncoder().encode(`${version}.${tokenPurpose}.${kid}.${payload}`);
  // Both compare in constant time.
  let signed = false;
  for (const key of keys) {
    if (await crypto.subtle.verify(signAlg(spec), key, sigBytes, input)) {
      signed = true;
      break;
    }
  }
  if (!signed) return { ok: false, reason: 'signature' };

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isClaims(body)) return { ok: false, reason: 'malformed' };
  const lifetime = checkLifetime(body, spec.maxLifetimeSeconds, now);
  if (lifetime) return { ok: false, reason: lifetime };
  const tenant = spec.tenantClaim;
  if (tenant) {
    const value = (body as unknown as Record<string, unknown>)[tenant];
    if (typeof value !== 'string' || value === '') return { ok: false, reason: 'tenant' };
  }
  return { ok: true, payload: body as T & Claims, kid, legacy: false };
}

async function verifyLegacy<T>(
  spec: FamilySpec,
  token: string,
  now: number,
  legacy: LegacyLinks | undefined,
): Promise<LinkResult<T>> {
  if (!spec.legacy || !legacy) return { ok: false, reason: 'legacy_closed' };
  const cutoff = legacy.cutoffMs;
  if (cutoff !== null && now >= cutoff + spec.legacy.acceptForSeconds * 1000) {
    return { ok: false, reason: 'legacy_closed' };
  }
  const read = await verifyToken<T>(legacy.keyring, spec.purpose, token, { now });
  if (!read.ok) return read;
  const lifetime = checkLifetime(read.payload, spec.legacy.lifetimeSeconds, now);
  if (lifetime) return { ok: false, reason: lifetime };
  if (cutoff !== null && read.payload.iat * 1000 >= cutoff) {
    return { ok: false, reason: 'legacy_closed' };
  }
  return { ok: true, payload: read.payload, kid: read.kid, legacy: true };
}

interface Claims {
  iat: number;
  exp?: number;
}

function isClaims(value: unknown): value is Claims {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { iat, exp } = value as Record<string, unknown>;
  return Number.isInteger(iat) && (exp === undefined || Number.isInteger(exp));
}

/** Expiry, and a lifetime within `max` (null: the family's tokens don't expire). */
function checkLifetime(claims: Claims, max: number | null, nowMs: number): LinkFailure | null {
  if (max !== null) {
    if (claims.exp === undefined || claims.exp - claims.iat > max) return 'lifetime';
  }
  if (claims.exp !== undefined && claims.exp <= Math.floor(nowMs / 1000)) return 'expired';
  return null;
}

/** How this deploy signs and what v1 links it still takes, from the vars the installer renders. */
export interface LinkMode {
  /** v1 until every verifier accepts v2 (pass one); v2 after the cutover (pass two). */
  signing: 'v1' | 'v2';
  /** LegacyLinks.cutoffMs. */
  legacyCutoffMs: number | null;
}

/**
 * Reads LINK_SIGNING_MODE (`v1` or `v2`) and LINK_LEGACY_CUTOFF (milliseconds since the epoch),
 * which the installer renders for every worker that holds a link keyring. Throws when the mode is
 * missing or anything else, and on v2 without a cutoff, which would take v1 links forever: a worker
 * refuses to start rather than guess.
 */
export function linkModeFromEnv(env: {
  LINK_SIGNING_MODE?: string | undefined;
  LINK_LEGACY_CUTOFF?: string | undefined;
}): LinkMode {
  const signing = env.LINK_SIGNING_MODE;
  if (signing !== 'v1' && signing !== 'v2') {
    throw new Error(`LINK_SIGNING_MODE must be v1 or v2, not "${signing ?? ''}"`);
  }
  const text = env.LINK_LEGACY_CUTOFF;
  let legacyCutoffMs: number | null = null;
  if (text) {
    if (!/^\d{1,16}$/.test(text)) throw new Error('LINK_LEGACY_CUTOFF must be milliseconds');
    legacyCutoffMs = Number(text);
  }
  if (signing === 'v2' && legacyCutoffMs === null) {
    throw new Error('LINK_SIGNING_MODE=v2 needs LINK_LEGACY_CUTOFF');
  }
  return { signing, legacyCutoffMs };
}
