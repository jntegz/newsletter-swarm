import { createRoute, z } from '@hono/zod-openapi';
import { first, run } from '@swarm/db';
import { newId } from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import { signToken, verifyToken } from '@swarm/tokens';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ApiEnv } from '../env';
import { clientIp, createRouter, env } from '../lib/context';
import { ipPrefix, randomToken } from '../lib/crypto';
import { fetchJwks, s256, verifyIdToken } from '../lib/oidc';
import { errors } from '../lib/openapi';
import { createSession, emailSignInRequired } from '../lib/session';
import { findOrCreateOperator, isInviteOnlyError } from '../lib/signin';
import { recordAccountEvent } from '../lib/account-events';

const STATE_COOKIE = '__Host-swarm_oauth';
const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

interface OAuthState {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

interface GoogleClaims {
  iss: string;
  aud: string;
  sub: string;
  email?: string;
  email_verified?: boolean;
  exp: number;
  nonce?: string;
}

export const google = createRouter();

const redirectUri = (e: ApiEnv) => `${e.APP_ORIGIN}/api/v1/auth/google/callback`;

function requireGoogle(e: ApiEnv): { clientId: string; clientSecret: string } {
  if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) {
    throw new ApiError('not_implemented', 'Google sign-in is not configured.');
  }
  return { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET };
}

google.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/auth/google',
    tags: ['Auth'],
    summary: 'Start Google sign-in',
    request: {
      query: z.object({
        return: z
          .string()
          .regex(/^\/(?!\/)[^\s]*$/)
          .max(512)
          .optional(),
      }),
    },
    responses: { 302: { description: 'Redirect to Google' }, ...errors('invalid_input') },
  }),
  async (c) => {
    const e = env(c);
    const { clientId } = requireGoogle(e);
    const state: OAuthState = {
      state: randomToken(24),
      nonce: randomToken(24),
      verifier: randomToken(48),
      returnTo: c.req.valid('query').return ?? '/',
    };
    const cookie = await signToken(
      e.AUTH_KEYS,
      'oauth-state',
      { ...state },
      { expiresInSeconds: 600 },
    );
    setCookie(c, STATE_COOKIE, cookie, {
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 600,
    });

    const url = new URL(AUTHORIZE);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(e),
      response_type: 'code',
      scope: 'openid email profile',
      state: state.state,
      nonce: state.nonce,
      code_challenge: await s256(state.verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return c.redirect(url.toString(), 302);
  },
);

google.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/auth/google/callback',
    tags: ['Auth'],
    summary: 'Finish Google sign-in',
    request: {
      query: z.object({
        code: z.string().max(2048).optional(),
        state: z.string().max(200).optional(),
        error: z.string().max(200).optional(),
      }),
    },
    responses: { 302: { description: 'Redirect into the dashboard' } },
  }),
  async (c) => {
    const e = env(c);
    const fail = (reason: string) => c.redirect(`${e.APP_ORIGIN}/sign-in?error=${reason}`, 302);
    const { clientId, clientSecret } = requireGoogle(e);
    const query = c.req.valid('query');

    const cookie = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
    if (!cookie || query.error || !query.code || !query.state) return fail('google_cancelled');

    const verified = await verifyToken<OAuthState>(e.AUTH_KEYS, 'oauth-state', cookie);
    if (!verified.ok || verified.payload.state !== query.state) return fail('google_state');

    const tokenRes = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: query.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri(e),
        grant_type: 'authorization_code',
        code_verifier: verified.payload.verifier,
      }),
    });
    if (!tokenRes.ok) return fail('google_exchange');
    const { id_token: idToken } = await tokenRes.json<{ id_token?: string }>();
    if (!idToken) return fail('google_exchange');

    const claims = await verifyGoogleIdToken(e, idToken, clientId);
    if (!claims || claims.nonce !== verified.payload.nonce || !claims.email)
      return fail('google_token');

    const ip = ipPrefix(clientIp(c));
    let operatorId: string | null;
    try {
      operatorId = await resolveGoogleOperator(e, claims, ip);
    } catch (error) {
      if (isInviteOnlyError(error)) return fail('invite_only');
      throw error;
    }
    if (!operatorId) return fail('google_unverified');
    if (await emailSignInRequired(e, operatorId)) return fail('email_signin_required');

    await createSession(c, operatorId, { method: 'google' });
    await recordAccountEvent(c, operatorId, 'operator.signed_in', { method: 'google' });
    return c.redirect(`${e.APP_ORIGIN}${verified.payload.returnTo}`, 302);
  },
);

/**
 * Existing Google identity → that operator. Otherwise the email must be verified by
 * Google before it can link to, or create, an operator with that address.
 */
export async function resolveGoogleOperator(e: ApiEnv, claims: GoogleClaims, ip: string | null) {
  const linked = await first<{ operator_id: string }>(
    e.DB,
    "SELECT operator_id FROM oauth_identities WHERE provider = 'google' AND subject = ?1",
    claims.sub,
  );
  if (linked) return linked.operator_id;
  if (claims.email_verified !== true || !claims.email) return null;

  const email = claims.email.toLowerCase();
  const { operatorId } = await findOrCreateOperator(e, email, ip);
  await run(
    e.DB,
    `INSERT INTO oauth_identities (id, provider, subject, operator_id, email, email_verified, created_at)
     VALUES (?1, 'google', ?2, ?3, ?4, 1, ?5)`,
    newId('oauthIdentity'),
    claims.sub,
    operatorId,
    email,
    Date.now(),
  );
  return operatorId;
}

/** Verifies a Google ID token (RS256) with the shared OIDC checks against Google's JWKS. */
export async function verifyGoogleIdToken(
  e: ApiEnv,
  jwt: string,
  clientId: string,
): Promise<GoogleClaims | null> {
  const claims = await verifyIdToken(jwt, {
    // No refetch on an unknown kid: Google publishes the next key well before using it.
    keys: async (kid) => (await fetchJwks(e, 'google:jwks', JWKS)).find((key) => key.kid === kid),
    issuers: ISSUERS,
    audience: clientId,
  });
  if (!claims || Array.isArray(claims.aud)) return null;
  return claims as GoogleClaims;
}
