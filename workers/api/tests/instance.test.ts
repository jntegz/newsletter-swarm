// Self-hosting: sign-up mode (open / invite-only) and instance settings (0032_instance.sql).
import { env } from 'cloudflare:test';
import type { Me, Workspace } from '@swarm/domain';
import { DevMailbox } from '@swarm/mail';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { parseApiEnv, type ApiEnv } from '../src/env';
import { signupMode } from '../src/lib/instance';
import { isInviteOnlyError } from '../src/lib/signin';
import { resolveGoogleOperator } from '../src/routes/google';
import {
  call,
  freshFactor,
  json,
  latestToken,
  nextIp,
  ORIGIN,
  requestToken,
  sessionCookie,
  signIn,
  uniqueEmail,
  type Session,
} from './helpers';

const INVITE_ONLY = 'This Swarm is invite-only. Ask the owner for an invite.';

// Storage is shared by the tests of a file: every test starts open, with no instance admins.
afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM instance_settings'),
    env.DB.prepare('DELETE FROM instance_admins'),
  ]);
});

async function setSignup(value: 'open' | 'invite_only') {
  await env.DB.prepare(
    `INSERT INTO instance_settings (key, value, updated_at) VALUES ('signup', ?1, ?2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  )
    .bind(value, Date.now())
    .run();
}

async function makeAdmin(session: Session) {
  await env.DB.prepare('INSERT INTO instance_admins (operator_id, created_at) VALUES (?1, ?2)')
    .bind(session.me.operator.id, Date.now())
    .run();
  // Instance settings need a factor of the admin's own, freshly proved for a change.
  await freshFactor(session);
}

async function consume(token: string, confirmEmail: string) {
  return call('POST', '/api/v1/auth/quickpass/consume', { body: { token, confirmEmail } });
}

async function invite(owner: Session, email: string) {
  const res = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/invites`, {
    cookie: owner.cookie,
    body: { email, role: 'editor' },
  });
  expect(res.status).toBe(201);
  return latestToken(email, 'invite');
}

async function latestMail(email: string) {
  const res = await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(email)}`);
  expect(res.status).toBe(200);
  return (await json<{ data: { category: string; subject: string; text: string } }>(res)).data;
}

const quickpassTokens = async (email: string) =>
  (
    await env.DB.prepare('SELECT COUNT(*) AS n FROM quickpass_tokens WHERE email = ?1')
      .bind(email)
      .first<{ n: number }>()
  )?.n;

describe('open sign-up (the default)', () => {
  it('is public and open when nothing is set', async () => {
    const res = await call('GET', '/api/v1/instance');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ data: { signup: 'open' } });
  });

  it('gives a new address an account, a workspace and an owner seat', async () => {
    const session = await signIn();
    expect(session.me.workspaces).toMatchObject([{ name: 'My workspace', role: 'owner' }]);
    expect(session.me.instanceAdmin).toBe(false);
  });
});

describe('invite-only sign-up', () => {
  it('a QuickPass request for an unknown address still answers 202, with a note instead of a link', async () => {
    await setSignup('invite_only');
    const email = uniqueEmail('stranger');
    const res = await call('POST', '/api/v1/auth/quickpass', {
      body: { email, turnstileToken: 'x' },
      ip: nextIp(),
    });
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ data: { ok: true } });
    // The browser cookie a link request sets is there too, so it does not tell the cases apart.
    expect(res.headers.get('set-cookie')).toMatch(/^__Host-swarm_quickpass=/);
    const mail = await latestMail(email);
    expect(mail.category).toBe('invite_only');
    expect(mail.text).toContain('invite-only');
    expect(mail.text).not.toContain('#token=');
    expect(await quickpassTokens(email)).toBe(0);
  });

  it('caps the note per address behind the same 202, across IPs and without touching other addresses', async () => {
    const owner = await signIn();
    await setSignup('invite_only');
    const email = uniqueEmail('capped');
    const ask = async (address: string) => {
      const res = await call('POST', '/api/v1/auth/quickpass', {
        body: { email: address, turnstileToken: 'x' },
        ip: nextIp(),
      });
      expect(res.status).toBe(202);
      expect(await json(res)).toEqual({ data: { ok: true } });
    };
    const notes = async (address: string) =>
      (await new DevMailbox(env.DEV_MAILBOX).list({ to: address })).length;

    // The same address in capitals counts too.
    for (const address of [email, email, email.toUpperCase(), email, email]) await ask(address);
    expect(await notes(email)).toBe(3);

    const other = uniqueEmail('uncapped');
    await ask(other);
    expect(await notes(other)).toBe(1);

    // The cap is on the note alone: once invited, the address still gets its link.
    await invite(owner, email);
    const signedIn = await consume(await requestToken(email), email);
    expect(signedIn.status).toBe(200);
  });

  it('sends no note when the limiter fails, and still answers 202', async () => {
    await setSignup('invite_only');
    const email = uniqueEmail('limiter-down');
    const broken = {
      idFromName: () => 'id',
      get: () => ({
        take: () => Promise.reject(new Error('limiter is down')),
      }),
    };
    const res = await createApp().request(
      '/api/v1/auth/quickpass',
      {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          'cf-connecting-ip': nextIp(),
        },
        body: JSON.stringify({ email, turnstileToken: 'x' }),
      },
      { ...env, API_RATE_LIMITER: broken },
    );
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ data: { ok: true } });
    expect(await new DevMailbox(env.DEV_MAILBOX).list({ to: email })).toEqual([]);
  });

  it('refuses an unknown address at consume, even with a link from before the switch', async () => {
    const email = uniqueEmail('early');
    const token = await requestToken(email);
    await setSignup('invite_only');
    const res = await consume(token, email);
    expect(res.status).toBe(403);
    expect((await json<{ error: { message: string } }>(res)).error.message).toBe(INVITE_ONLY);
    const operator = await env.DB.prepare('SELECT 1 FROM operators WHERE email = ?1')
      .bind(email)
      .first();
    expect(operator).toBeNull();
  });

  it('lets an existing operator sign in as before', async () => {
    const email = uniqueEmail('existing');
    const first = await signIn(email);
    await setSignup('invite_only');
    const again = await signIn(email);
    expect(again.me.operator.id).toBe(first.me.operator.id);
    expect(again.workspaceId).toBe(first.workspaceId);
  });

  it('an invited address gets an account without a workspace, then joins by accepting', async () => {
    const owner = await signIn();
    const email = uniqueEmail('invited');
    const inviteToken = await invite(owner, email);
    await setSignup('invite_only');

    const signedIn = await consume(await requestToken(email), email);
    expect(signedIn.status).toBe(200);
    const me = (await json<{ data: Me }>(signedIn)).data;
    expect(me.operator.email).toBe(email);
    expect(me.workspaces).toEqual([]);
    const cookie = sessionCookie(signedIn);

    const accepted = await call('POST', '/api/v1/invites/accept', {
      cookie,
      body: { token: inviteToken },
    });
    expect(accepted.status).toBe(200);
    expect((await json<{ data: Workspace }>(accepted)).data).toMatchObject({
      id: owner.workspaceId,
      role: 'editor',
    });
    const session = await call('GET', '/api/v1/auth/session', { cookie });
    expect((await json<{ data: Me }>(session)).data.workspaces).toMatchObject([
      { id: owner.workspaceId, role: 'editor' },
    ]);
  });

  it('a withdrawn or expired invite does not count', async () => {
    const owner = await signIn();
    const email = uniqueEmail('withdrawn');
    await invite(owner, email);
    await env.DB.prepare('UPDATE invites SET expires_at = 1 WHERE email = ?1').bind(email).run();
    await setSignup('invite_only');
    const res = await call('POST', '/api/v1/auth/quickpass', {
      body: { email, turnstileToken: 'x' },
      ip: nextIp(),
    });
    expect(res.status).toBe(202);
    expect((await latestMail(email)).category).toBe('invite_only');
  });

  it('Google sign-in of an unknown address is refused with invite_only; an invited one gets in', async () => {
    await setSignup('invite_only');
    const e = parseApiEnv(env);
    const claims = (email: string) => ({
      iss: 'https://accounts.google.com',
      aud: 'client',
      sub: `google-${crypto.randomUUID()}`,
      email,
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const refused = await resolveGoogleOperator(e, claims(uniqueEmail('g')), null).catch(
      (error: unknown) => error,
    );
    // The callback turns exactly this error into /sign-in?error=invite_only.
    expect(isInviteOnlyError(refused)).toBe(true);

    await setSignup('open');
    const owner = await signIn();
    const email = uniqueEmail('g-invited');
    await invite(owner, email);
    await setSignup('invite_only');
    const operatorId = await resolveGoogleOperator(e, claims(email), null);
    expect(operatorId).toMatch(/^op_/);
    const seats = await env.DB.prepare('SELECT COUNT(*) AS n FROM seats WHERE operator_id = ?1')
      .bind(operatorId)
      .first<{ n: number }>();
    expect(seats?.n).toBe(0);
  });
});

describe('instance settings', () => {
  it('only instance admins can read or change them', async () => {
    expect((await call('GET', '/api/v1/instance/settings')).status).toBe(401);
    const someone = await signIn();
    expect(
      (await call('GET', '/api/v1/instance/settings', { cookie: someone.cookie })).status,
    ).toBe(403);
    const put = await call('PUT', '/api/v1/instance/settings', {
      cookie: someone.cookie,
      body: { signup: 'invite_only' },
    });
    expect(put.status).toBe(403);
    expect((await json(await call('GET', '/api/v1/instance'))) as unknown).toEqual({
      data: { signup: 'open' },
    });
  });

  it('an instance admin switches sign-up and Me says so', async () => {
    const admin = await signIn();
    await makeAdmin(admin);
    const me = await call('GET', '/api/v1/auth/session', { cookie: admin.cookie });
    expect((await json<{ data: Me }>(me)).data.instanceAdmin).toBe(true);

    const read = await call('GET', '/api/v1/instance/settings', { cookie: admin.cookie });
    expect(await json(read)).toEqual({ data: { signup: 'open' } });

    const bad = await call('PUT', '/api/v1/instance/settings', {
      cookie: admin.cookie,
      body: { signup: 'closed' },
    });
    expect(bad.status).toBe(400);

    const put = await call('PUT', '/api/v1/instance/settings', {
      cookie: admin.cookie,
      body: { signup: 'invite_only' },
    });
    expect(put.status).toBe(200);
    expect(await json(put)).toEqual({ data: { signup: 'invite_only' } });
    expect(await json(await call('GET', '/api/v1/instance'))).toEqual({
      data: { signup: 'invite_only' },
    });
    const row = await env.DB.prepare(
      "SELECT updated_by FROM instance_settings WHERE key = 'signup'",
    ).first<{ updated_by: string }>();
    expect(row?.updated_by).toBe(admin.me.operator.id);

    const reopen = await call('PUT', '/api/v1/instance/settings', {
      cookie: admin.cookie,
      body: { signup: 'open' },
    });
    expect(await json(reopen)).toEqual({ data: { signup: 'open' } });
  });

  it('the schema refuses unknown keys and values', async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO instance_settings (key, value, updated_at) VALUES ('signup', 'closed', 0)",
      ).run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      env.DB.prepare(
        "INSERT INTO instance_settings (key, value, updated_at) VALUES ('theme', 'dark', 0)",
      ).run(),
    ).rejects.toThrow(/CHECK/);
  });
});

describe('with no sign-up setting saved', () => {
  // A deployed install with no row: the installer always writes one, but a hand-made install may
  // not. It must not be open to the whole internet.
  const deployed = (environment: ApiEnv['ENVIRONMENT']): ApiEnv => ({
    ...parseApiEnv(env),
    ENVIRONMENT: environment,
  });

  it('is open for local development and tests', async () => {
    expect(await signupMode(deployed('development'))).toBe('open');
    expect(await signupMode(deployed('test'))).toBe('open');
  });

  it('lets a deployed install’s first account in, then needs invites', async () => {
    await signIn();
    for (const environment of ['production', 'staging'] as const) {
      expect(await signupMode(deployed(environment))).toBe('invite_only');
    }
    // A saved choice always wins.
    await setSignup('open');
    expect(await signupMode(deployed('production'))).toBe('open');
  });
});
