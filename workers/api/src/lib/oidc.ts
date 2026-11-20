// OpenID Connect pieces shared by Google sign-in and SSO connections: PKCE, ID-token signature and
// claim checks against a JWKS, discovery documents, and KV caching of both.
import { outboundUrlProblem } from '@swarm/engine';
import { base64UrlDecode, base64UrlEncode } from '@swarm/tokens';
import type { ApiEnv } from '../env';
import { isLocal } from '../env';
import { sha256Hex } from './crypto';

interface Jwk extends JsonWebKey {
  kid?: string;
}

interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  azp?: string;
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  exp: number;
  nbf?: number;
  iat?: number;
  nonce?: string;
  amr?: string[];
  acr?: string;
}

export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

const decodeJson = <T>(part: string): T =>
  JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as T;

const ALGORITHMS = {
  RS256: {
    import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    verify: { name: 'RSASSA-PKCS1-v1_5' },
  },
  ES256: {
    import: { name: 'ECDSA', namedCurve: 'P-256' },
    verify: { name: 'ECDSA', hash: 'SHA-256' },
  },
} as const;

/**
 * Verifies a JWT signed with RS256 or ES256 by a key from `keys` (looked up by kid), then its
 * issuer, audience (and azp when there are several), expiry and not-before. Null on any failure;
 * the caller checks nonce and email.
 */
export async function verifyIdToken(
  jwt: string,
  options: {
    keys: (kid: string | undefined) => Promise<Jwk | undefined>;
    issuers: ReadonlySet<string>;
    audience: string;
    now?: number;
  },
): Promise<IdTokenClaims | null> {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  try {
    const header = decodeJson<{ alg: string; kid?: string }>(headerB64);
    const alg = ALGORITHMS[header.alg as keyof typeof ALGORITHMS];
    if (!alg) return null;
    const jwk = await options.keys(header.kid);
    if (!jwk) return null;
    if (jwk.alg && jwk.alg !== header.alg) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, alg.import, false, ['verify']);
    const valid = await crypto.subtle.verify(
      alg.verify,
      key,
      base64UrlDecode(signatureB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    if (!valid) return null;
    const claims = decodeJson<IdTokenClaims>(payloadB64);
    if (!options.issuers.has(claims.iss)) return null;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(options.audience)) return null;
    if (audiences.length > 1 && claims.azp !== options.audience) return null;
    const now = options.now ?? Date.now();
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
    // A minute of clock skew either way.
    if (typeof claims.nbf === 'number' && claims.nbf * 1000 > now + 60_000) return null;
    if (typeof claims.sub !== 'string' || !claims.sub) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * A server-side fetch of an identity provider URL. Issuers and the endpoints their discovery
 * documents name are chosen by workspace admins, so each URL passes the shared outbound check
 * and redirects are not followed (a 3xx is a failure): a public host can't bounce the request
 * to a private one. Null when the URL may not be called.
 */
async function idpFetch(e: ApiEnv, url: string, init: RequestInit = {}): Promise<Response | null> {
  if (outboundUrlProblem(url, { allowHttp: isLocal(e) })) return null;
  return fetch(url, { ...init, redirect: 'manual' });
}

/** Fetches a JWKS through a KV cache; `refresh` skips the cache (an unknown kid after rotation). */
export async function fetchJwks(
  e: ApiEnv,
  cacheKey: string,
  url: string,
  refresh = false,
): Promise<Jwk[]> {
  if (!refresh) {
    const cached = await e.CACHE.get<Jwk[]>(cacheKey, 'json');
    if (cached) return cached;
  }
  const res = await idpFetch(e, url, { headers: { accept: 'application/json' } });
  if (!res?.ok) return [];
  const { keys } = await res.json<{ keys?: Jwk[] }>();
  if (!Array.isArray(keys)) return [];
  await e.CACHE.put(cacheKey, JSON.stringify(keys), { expirationTtl: 3600 });
  return keys;
}

/** A key lookup that refetches the JWKS once when the kid is unknown. */
export function jwksLookup(e: ApiEnv, cacheKey: string, url: string) {
  return async (kid: string | undefined) => {
    const pick = (keys: Jwk[]) =>
      kid ? keys.find((k) => k.kid === kid) : keys.length === 1 ? keys[0] : undefined;
    return pick(await fetchJwks(e, cacheKey, url)) ?? pick(await fetchJwks(e, cacheKey, url, true));
  };
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

/** For the endpoint the browser is sent to; the worker never fetches it. */
const secureUrl = (e: ApiEnv, value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (isLocal(e) && url.protocol === 'http:');
  } catch {
    return false;
  }
};

/**
 * The issuer's discovery document (cached an hour). Its `issuer` must equal the configured one
 * exactly, the authorization endpoint must be https outside development, and the endpoints the
 * worker calls (token, JWKS) must pass the outbound URL check.
 */
export async function discover(e: ApiEnv, issuer: string): Promise<Discovery | null> {
  const key = `oidc:discovery:${await sha256Hex(issuer)}`;
  const cached = await e.CACHE.get<Discovery>(key, 'json');
  if (cached) return cached;
  try {
    const res = await idpFetch(e, `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
    });
    if (!res?.ok) return null;
    const doc = await res.json<Partial<Discovery>>();
    if (doc.issuer !== issuer) return null;
    if (!secureUrl(e, doc.authorization_endpoint)) return null;
    const callable = (u: unknown) =>
      typeof u === 'string' && !outboundUrlProblem(u, { allowHttp: isLocal(e) });
    if (!callable(doc.token_endpoint) || !callable(doc.jwks_uri)) return null;
    const discovery: Discovery = {
      issuer: doc.issuer,
      authorization_endpoint: doc.authorization_endpoint as string,
      token_endpoint: doc.token_endpoint as string,
      jwks_uri: doc.jwks_uri as string,
      ...(Array.isArray(doc.token_endpoint_auth_methods_supported)
        ? { token_endpoint_auth_methods_supported: doc.token_endpoint_auth_methods_supported }
        : {}),
    };
    await e.CACHE.put(key, JSON.stringify(discovery), { expirationTtl: 3600 });
    return discovery;
  } catch {
    return null;
  }
}

export async function forgetDiscovery(e: ApiEnv, issuer: string): Promise<void> {
  await e.CACHE.delete(`oidc:discovery:${await sha256Hex(issuer)}`);
}

/**
 * Whether the identity provider says the person used more than one factor: `amr` contains
 * "mfa" (RFC 8176), or `acr` is the OpenID PAPE multi-factor policy. Nothing else counts.
 */
export function idpAssertsMfa(claims: IdTokenClaims): boolean {
  if (Array.isArray(claims.amr) && claims.amr.includes('mfa')) return true;
  return claims.acr === 'http://schemas.openid.net/pape/policies/2007/06/multi-factor';
}

export const emailVerified = (claims: IdTokenClaims) =>
  claims.email_verified === true || claims.email_verified === 'true';
