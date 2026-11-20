import { createRoute, z } from '@hono/zod-openapi';
import { all, first, run, toIso } from '@swarm/db';
import {
  AuthConfigSchema,
  MeSchema,
  QuickPassConsumeSchema,
  QuickPassPeekSchema,
  QuickPassRequestSchema,
  QuickPassTokenSchema,
  SessionSummarySchema,
  idPattern,
  newId,
} from '@swarm/domain';
import type { OutgoingMail } from '@swarm/mail';
import { ApiError } from '@swarm/runtime';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { requireAuth, requireSignedIn } from '../lib/access';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix, randomToken, sha256Hex } from '../lib/crypto';
import { hasPendingInvite, signupMode } from '../lib/instance';
import { inviteOnlyMail, mailer, quickPassMail } from '../lib/mail';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { clearSessionCookie, createSession, revokeSession } from '../lib/session';
import { findOrCreateOperator, loadMe } from '../lib/signin';
import { verifyTurnstile } from '../lib/turnstile';
import { recordAccountEvent } from '../lib/account-events';

const QUICKPASS_TTL_MS = 10 * 60 * 1000;
const QUICKPASS_PER_EMAIL = 5;
/**
 * Marks the browser that asked for a link, so it can use the link without confirming the
 * address. The value is derived from the token, so no row stores it.
 */
const QUICKPASS_BROWSER_COOKIE = '__Host-swarm_quickpass';
const browserBinding = (token: string) => sha256Hex(`quickpass-browser:${token}`);
/** Invite-only notes to one address: three at once, then one every eight hours. */
const INVITE_ONLY_NOTE_BURST = 3;
const INVITE_ONLY_NOTES_PER_MINUTE = 3 / (24 * 60);

interface RateLimiterStub {
  take(perMinute: number, capacity: number): Promise<{ allowed: boolean }>;
}

/** A refused email gets a message saying so. A generic error would leave the person guessing. */
async function sendSignInMail(c: AppContext, mail: OutgoingMail): Promise<void> {
  try {
    await mailer(env(c)).send(mail);
  } catch (error) {
    c.get('log').error('sign-in email was not sent', {
      reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
    });
    throw new ApiError(
      'unavailable',
      "We couldn't send your sign-in email. Whoever runs this Swarm needs to check its email service and sending domain.",
    );
  }
}

/**
 * Whether one more invite-only note may go to this address. The note writes no row, so the count
 * lives in the realtime worker's ApiRateLimiter, named by a hash of the address. Unlimited when
 * the binding is absent (local). If the limiter fails no note goes out: the note can wait, and
 * the caller still answers 202.
 */
async function takeInviteOnlyNote(c: AppContext, email: string): Promise<boolean> {
  const namespace = env(c).API_RATE_LIMITER;
  if (!namespace) return true;
  try {
    const stub = namespace.get(
      namespace.idFromName(`invite-only-note:${await sha256Hex(email)}`),
    ) as unknown as RateLimiterStub;
    const { allowed } = await stub.take(INVITE_ONLY_NOTES_PER_MINUTE, INVITE_ONLY_NOTE_BURST);
    return allowed;
  } catch (error) {
    c.get('log').warn('invite-only note limiter failed', { error: (error as Error).message });
    return false;
  }
}

export const auth = createRouter();

auth.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/auth/config',
    tags: ['Auth'],
    summary: 'Public sign-in configuration',
    responses: { 200: ok(AuthConfigSchema, 'Sign-in options') },
  }),
  (c) => {
    const e = env(c);
    return c.json(
      {
        data: {
          turnstileSiteKey: e.TURNSTILE_SITE_KEY,
          googleEnabled: !!e.GOOGLE_CLIENT_ID,
          devMailbox: !!e.DEV_MAILBOX,
        },
      },
      200,
    );
  },
);

auth.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/auth/quickpass',
    tags: ['Auth'],
    summary: 'Email a QuickPass sign-in link',
    description:
      'Always answers 202 for a valid request, whether or not the address has an account, so the response reveals nothing. On an invite-only instance an address with no account and no pending invite is emailed a short note instead of a link.',
    request: { body: jsonBody(QuickPassRequestSchema) },
    responses: {
      202: ok(z.object({ ok: z.literal(true) }), 'Accepted'),
      ...errors('invalid_input', 'forbidden', 'rate_limited'),
    },
  }),
  async (c) => {
    const e = env(c);
    const { email, turnstileToken, returnTo } = c.req.valid('json');
    const ip = clientIp(c);

    const { success } = await e.QUICKPASS_LIMITER.limit({ key: `quickpass:${ip ?? 'unknown'}` });
    if (!success)
      throw new ApiError('rate_limited', 'Too many requests. Wait a minute and try again.');

    if (!(await verifyTurnstile(e, turnstileToken, ip, 'quickpass'))) {
      throw new ApiError('forbidden', 'The security check did not pass. Try again.');
    }

    // Every 202 sets the cookie, so its presence says nothing about the address. When no link
    // is sent, the token behind it is never stored and the cookie matches nothing.
    const token = randomToken(32);
    setCookie(c, QUICKPASS_BROWSER_COOKIE, await browserBinding(token), {
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
      maxAge: QUICKPASS_TTL_MS / 1000,
    });

    // Invite-only: an address with no account and no pending invite gets a short note instead of
    // a link. The answer is the same 202 either way, so it does not reveal who has an account.
    if (
      (await signupMode(e)) === 'invite_only' &&
      !(await first(e.DB, 'SELECT 1 FROM operators WHERE email = ?1', email)) &&
      !(await hasPendingInvite(e, email))
    ) {
      if (await takeInviteOnlyNote(c, email)) await sendSignInMail(c, inviteOnlyMail(e, email));
      else c.get('log').warn('invite-only note limit reached');
      return c.json({ data: { ok: true as const } }, 202);
    }

    const now = Date.now();
    const recent = await first<{ n: number }>(
      e.DB,
      'SELECT COUNT(*) AS n FROM quickpass_tokens WHERE email = ?1 AND created_at > ?2',
      email,
      now - QUICKPASS_TTL_MS,
    );
    if ((recent?.n ?? 0) >= QUICKPASS_PER_EMAIL) {
      c.get('log').warn('quickpass per-email limit reached');
      return c.json({ data: { ok: true as const } }, 202);
    }

    await run(
      e.DB,
      `INSERT INTO quickpass_tokens (id, token_hash, email, ip_prefix, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      newId('quickpass'),
      await sha256Hex(token),
      email,
      ipPrefix(ip),
      now,
      now + QUICKPASS_TTL_MS,
    );

    // The token rides in the fragment, so it never reaches server logs or Referer headers.
    const link = new URL('/sign-in/continue', e.APP_ORIGIN);
    if (returnTo) link.searchParams.set('return', returnTo);
    link.hash = `token=${token}`;
    await sendSignInMail(c, quickPassMail(e, email, link.toString()));

    return c.json({ data: { ok: true as const } }, 202);
  },
);

auth.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/auth/quickpass/consume',
    tags: ['Auth'],
    summary: 'Exchange a QuickPass token for a session',
    description:
      'Single use: the token is consumed atomically, so a replay or a concurrent second use fails. A browser other than the one that asked for the link must send `confirmEmail`, the address the link signs in as, so a link someone else forwarded cannot sign it in to their account unseen.',
    request: { body: jsonBody(QuickPassConsumeSchema) },
    responses: { 200: ok(MeSchema, 'Signed in'), ...errors('invalid_input', 'unauthorized') },
  }),
  async (c) => {
    const e = env(c);
    const { token, confirmEmail } = c.req.valid('json');
    // Login CSRF: anyone can mail a link to their own account to someone else. Only the browser
    // that asked for it may skip naming the address; any other must confirm the address it saw.
    const sameBrowser = getCookie(c, QUICKPASS_BROWSER_COOKIE) === (await browserBinding(token));
    if (!sameBrowser && !confirmEmail) {
      throw new ApiError(
        'invalid_input',
        'Confirm the address this sign-in link is for before continuing.',
      );
    }
    const now = Date.now();
    const consumed = await first<{ email: string }>(
      e.DB,
      `UPDATE quickpass_tokens SET consumed_at = ?1
        WHERE token_hash = ?2 AND consumed_at IS NULL AND expires_at > ?1
          AND (?3 IS NULL OR email = ?3)
       RETURNING email`,
      now,
      await sha256Hex(token),
      confirmEmail ?? null,
    );
    if (!consumed) {
      throw new ApiError('unauthorized', 'This sign-in link has expired or was already used.');
    }
    if (sameBrowser) deleteCookie(c, QUICKPASS_BROWSER_COOKIE, { path: '/', secure: true });

    const ip = ipPrefix(clientIp(c));
    const { operatorId } = await findOrCreateOperator(e, consumed.email, ip);
    const sessionId = await createSession(c, operatorId, { method: 'quickpass' });
    await recordAccountEvent(c, operatorId, 'operator.signed_in', { method: 'quickpass' });
    return c.json({ data: await loadMe(e, operatorId, sessionId) }, 200);
  },
);

auth.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/auth/quickpass/peek',
    tags: ['Auth'],
    summary: 'The address a QuickPass link signs in as',
    description:
      'Does not use the link. The sign-in page shows the address before the person continues.',
    request: { body: jsonBody(QuickPassTokenSchema) },
    responses: {
      200: ok(QuickPassPeekSchema, 'The address'),
      ...errors('invalid_input', 'unauthorized'),
    },
  }),
  async (c) => {
    const row = await first<{ email: string }>(
      env(c).DB,
      'SELECT email FROM quickpass_tokens WHERE token_hash = ?1 AND consumed_at IS NULL AND expires_at > ?2',
      await sha256Hex(c.req.valid('json').token),
      Date.now(),
    );
    if (!row) {
      throw new ApiError('unauthorized', 'This sign-in link has expired or was already used.');
    }
    return c.json({ data: { email: row.email } }, 200);
  },
);

auth.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/auth/session',
    tags: ['Auth'],
    summary: 'The signed-in operator and their workspaces',
    description:
      'Also answers a session that still owes a second factor: `secondFactor.state` is then `verify` (with the `methods` it can use) or `enroll`, and `workspaces` is empty until it is done.',
    responses: { 200: ok(MeSchema, 'Signed in'), ...errors('unauthorized') },
  }),
  async (c) => {
    const authCtx = requireSignedIn(c);
    return c.json({ data: await loadMe(env(c), authCtx.operatorId, authCtx.sessionId) }, 200);
  },
);

auth.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/auth/logout',
    tags: ['Auth'],
    summary: 'Sign out of this device',
    responses: { 204: noContent, ...errors('unauthorized') },
  }),
  async (c) => {
    const authCtx = requireSignedIn(c);
    await revokeSession(env(c), authCtx.operatorId, authCtx.sessionId);
    clearSessionCookie(c);
    return c.body(null, 204);
  },
);

auth.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/auth/sessions',
    tags: ['Auth'],
    summary: 'Devices signed in to this account',
    responses: {
      200: ok(z.array(SessionSummarySchema), 'Active sessions'),
      ...errors('unauthorized'),
    },
  }),
  async (c) => {
    const authCtx = requireAuth(c);
    const rows = await all<{
      id: string;
      user_agent: string | null;
      ip_prefix: string | null;
      created_at: number;
      last_seen_at: number;
      expires_at: number;
    }>(
      env(c).DB,
      `SELECT id, user_agent, ip_prefix, created_at, last_seen_at, expires_at FROM sessions
        WHERE operator_id = ?1 AND revoked_at IS NULL AND expires_at > ?2
        ORDER BY last_seen_at DESC`,
      authCtx.operatorId,
      Date.now(),
    );
    return c.json(
      {
        data: rows.map((row) => ({
          id: row.id,
          current: row.id === authCtx.sessionId,
          userAgent: row.user_agent,
          ipPrefix: row.ip_prefix,
          createdAt: toIso(row.created_at),
          lastSeenAt: toIso(row.last_seen_at),
          expiresAt: toIso(row.expires_at),
        })),
      },
      200,
    );
  },
);

auth.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/auth/sessions/{sessionId}',
    tags: ['Auth'],
    summary: 'Sign out another device',
    request: { params: idParam('sessionId', idPattern('session')) },
    responses: { 204: noContent, ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const authCtx = requireAuth(c);
    const { sessionId } = c.req.valid('param');
    if (!(await revokeSession(env(c), authCtx.operatorId, sessionId))) {
      throw new ApiError('not_found', 'Session not found.');
    }
    if (sessionId === authCtx.sessionId) clearSessionCookie(c);
    return c.body(null, 204);
  },
);
