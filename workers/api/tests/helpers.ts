import { SELF, env } from 'cloudflare:test';
import type { Me, SeatRole } from '@swarm/domain';
import { expect } from 'vitest';
import { sha256Hex } from '../src/lib/crypto';

export const ORIGIN = 'http://localhost:5273';

let ipCounter = 0;
/** A fresh client IP per sign-in, so the per-IP QuickPass limit does not leak between tests. */
export const nextIp = () => `198.51.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

interface CallOptions {
  body?: unknown;
  form?: FormData | URLSearchParams;
  cookie?: string;
  origin?: string | null;
  headers?: Record<string, string>;
  ip?: string;
}

export async function call(
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.ip) headers['cf-connecting-ip'] = options.ip;
  let body: BodyInit | null = null;
  if (options.form) body = options.form;
  else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  return SELF.fetch(`http://localhost${path}`, { method, headers, body, redirect: 'manual' });
}

export async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export function sessionCookie(res: Response): string {
  const header = res.headers.get('set-cookie') ?? '';
  const match = /(__Host-swarm_session=[^;]+)/.exec(header);
  if (!match?.[1]) throw new Error(`no session cookie in: ${header}`);
  return match[1];
}

let emailCounter = 0;
export const uniqueEmail = (label = 'op') =>
  `${label}-${++emailCounter}-${crypto.randomUUID().slice(0, 8)}@example.com`;

/** Requests a QuickPass link and returns the token from the dev mailbox. */
export async function requestToken(email: string, ip = nextIp()): Promise<string> {
  const res = await call('POST', '/api/v1/auth/quickpass', {
    body: { email, turnstileToken: 'x' },
    ip,
  });
  expect(res.status).toBe(202);
  return latestToken(email);
}

export async function latestToken(email: string, category = 'quickpass'): Promise<string> {
  const res = await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(email)}`);
  expect(res.status).toBe(200);
  const { data } = await json<{ data: { text: string; category: string } }>(res);
  expect(data.category).toBe(category);
  const token = /#token=([A-Za-z0-9_-]+)/.exec(data.text)?.[1];
  if (!token) throw new Error('no token in mail');
  return token;
}

export interface Session {
  cookie: string;
  me: Me;
  workspaceId: string;
  email: string;
}

export async function signIn(email = uniqueEmail()): Promise<Session> {
  const token = await requestToken(email);
  const res = await call('POST', '/api/v1/auth/quickpass/consume', {
    body: { token, confirmEmail: email },
  });
  expect(res.status).toBe(200);
  const { data } = await json<{ data: Me }>(res);
  return { cookie: sessionCookie(res), me: data, workspaceId: data.workspaces[0]!.id, email };
}

/** Signs in a new operator and gives them a seat with `role` in `workspaceId`. */
export async function seatAs(
  workspaceId: string,
  role: SeatRole,
  email = uniqueEmail(role),
): Promise<Session> {
  const session = await signIn(email);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)',
  )
    .bind(
      `st_${crypto.randomUUID().replace(/-/g, '')}`,
      workspaceId,
      session.me.operator.id,
      role,
      now,
    )
    .run();
  return session;
}

export async function createChannel(
  session: Session,
  slug = `ch-${crypto.randomUUID().slice(0, 8)}`,
) {
  const res = await call('POST', `/api/v1/workspaces/${session.workspaceId}/channels`, {
    cookie: session.cookie,
    body: { name: 'Field Notes', slug },
  });
  expect(res.status).toBe(201);
  return (await json<{ data: { id: string; slug: string } }>(res)).data;
}

/**
 * Turns per-person tracking and reader profiles on, as a publisher does once readers agreed: a
 * new publication starts with them off (docs/privacy-controls.md).
 */
export async function trackReaders(session: Session, channelId: string) {
  const res = await call('PATCH', `/api/v1/channels/${channelId}`, {
    cookie: session.cookie,
    body: { trackOpens: true, trackClicks: true, profileReaders: true },
  });
  expect(res.status).toBe(200);
}

/** A valid 2×3 PNG. */
export function pngBytes(): Uint8Array {
  const hex =
    '89504e470d0a1a0a0000000d4948445200000002000000030806000000b5c0fb8c0000000d4944415478da63f8ffff3f0300050001ff5a0b2b4b0000000049454e44ae426082';
  return new Uint8Array(hex.match(/../g)!.map((b) => Number.parseInt(b, 16)));
}

export function uploadForm(bytes: Uint8Array, name = 'logo.png', type = 'image/png'): FormData {
  const form = new FormData();
  form.set('file', new File([bytes], name, { type }));
  return form;
}

/**
 * Seeds a confirmed authenticator app for the session's operator and marks the session as having
 * just proved it, as a step-up would. For routes that need a fresh factor of the operator's own
 * (API keys, webhook endpoints, export destinations). Synthetic: no code is checked.
 */
export async function freshFactor<T extends Pick<Session, 'cookie' | 'me'>>(
  session: T,
): Promise<T> {
  const now = Date.now();
  const hash = await sha256Hex(session.cookie.split('=')[1] as string);
  await env.DB.prepare(
    `INSERT INTO totp_secrets (operator_id, secret_enc, created_at, confirmed_at) VALUES (?1, 'test', ?2, ?2)
     ON CONFLICT (operator_id) DO UPDATE SET confirmed_at = COALESCE(totp_secrets.confirmed_at, excluded.confirmed_at)`,
  )
    .bind(session.me.operator.id, now)
    .run();
  await env.DB.prepare(
    "UPDATE sessions SET mfa_pending = 0, mfa_method = 'totp', mfa_verified_at = ?1 WHERE token_hash = ?2",
  )
    .bind(now, hash)
    .run();
  await env.CACHE.delete(`sess:v2:${hash}`);
  return session;
}

/**
 * Signs in an operator who already has a factor (QuickPass alone leaves the session owing it),
 * then marks the session verified as freshFactor does.
 */
export async function signInWithFactor(email: string): Promise<Session> {
  const token = await requestToken(email);
  const res = await call('POST', '/api/v1/auth/quickpass/consume', {
    body: { token, confirmEmail: email },
  });
  expect(res.status).toBe(200);
  const { data: pending } = await json<{ data: Me }>(res);
  const cookie = sessionCookie(res);
  await freshFactor({ cookie, me: pending });
  const me = await json<{ data: Me }>(await call('GET', '/api/v1/auth/session', { cookie }));
  return { cookie, me: me.data, workspaceId: me.data.workspaces[0]!.id, email };
}
