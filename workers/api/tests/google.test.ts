import { env } from 'cloudflare:test';
import { base64UrlEncode } from '@swarm/tokens';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseApiEnv } from '../src/env';
import { resolveGoogleOperator, verifyGoogleIdToken } from '../src/routes/google';
import { signIn } from './helpers';

const CLIENT_ID = 'swarm-test.apps.googleusercontent.com';
let keys: CryptoKeyPair;

const encode = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

async function idToken(
  claims: Record<string, unknown>,
  kid = 'test-key',
  signer = keys.privateKey,
) {
  const header = encode({ alg: 'RS256', kid, typ: 'JWT' });
  const payload = encode(claims);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signer,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

const validClaims = () => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: `google-${crypto.randomUUID()}`,
  email: 'g@example.com',
  email_verified: true,
  exp: Math.floor(Date.now() / 1000) + 600,
  nonce: 'n',
});

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey;
  // Seed the JWKS cache so verification never reaches Google.
  await env.CACHE.put(
    'google:jwks',
    JSON.stringify([{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }]),
  );
});

describe('Google ID token verification', () => {
  const apiEnv = () => parseApiEnv(env);

  it('accepts a correctly signed token for this client', async () => {
    const claims = await verifyGoogleIdToken(apiEnv(), await idToken(validClaims()), CLIENT_ID);
    expect(claims?.email).toBe('g@example.com');
  });

  it('rejects the wrong audience, issuer, expiry or key', async () => {
    const e = apiEnv();
    expect(
      await verifyGoogleIdToken(e, await idToken({ ...validClaims(), aud: 'other' }), CLIENT_ID),
    ).toBeNull();
    expect(
      await verifyGoogleIdToken(
        e,
        await idToken({ ...validClaims(), iss: 'https://evil.example' }),
        CLIENT_ID,
      ),
    ).toBeNull();
    expect(
      await verifyGoogleIdToken(e, await idToken({ ...validClaims(), exp: 1 }), CLIENT_ID),
    ).toBeNull();
    expect(
      await verifyGoogleIdToken(e, await idToken(validClaims(), 'unknown-key'), CLIENT_ID),
    ).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const token = await idToken(validClaims());
    const [header, , signature] = token.split('.');
    const forged = `${header}.${encode({ ...validClaims(), email: 'victim@example.com' })}.${signature}`;
    expect(await verifyGoogleIdToken(apiEnv(), forged, CLIENT_ID)).toBeNull();
  });
});

describe('Google account linking', () => {
  it('does not link an existing account to an unverified Google email', async () => {
    const existing = await signIn();
    const operatorId = await resolveGoogleOperator(
      parseApiEnv(env),
      { ...validClaims(), email: existing.email, email_verified: false },
      null,
    );
    expect(operatorId).toBeNull();
  });

  it('links a verified Google email to the existing operator', async () => {
    const existing = await signIn();
    const claims = { ...validClaims(), email: existing.email.toUpperCase() };
    const operatorId = await resolveGoogleOperator(parseApiEnv(env), claims, null);
    expect(operatorId).toBe(existing.me.operator.id);
    // The identity is now linked, so later sign-ins use the subject, not the email.
    expect(
      await resolveGoogleOperator(parseApiEnv(env), { ...claims, email_verified: false }, null),
    ).toBe(operatorId);
  });
});
