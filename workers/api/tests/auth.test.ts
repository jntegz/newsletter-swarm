import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import type { Me, SessionSummary } from '@swarm/domain';
import { describe, expect, it, vi } from 'vitest';
import type { ApiEnv } from '../src/env';
import app from '../src/index';
import { sha256Hex } from '../src/lib/crypto';
import { verifyTurnstile } from '../src/lib/turnstile';
import {
  ORIGIN,
  call,
  json,
  latestToken,
  nextIp,
  requestToken,
  sessionCookie,
  signIn,
  uniqueEmail,
} from './helpers';
import { turnstile } from './turnstile';

describe('QuickPass', () => {
  it('signs a new operator in, creating their workspace and owner seat', async () => {
    const email = uniqueEmail();
    const token = await requestToken(email);
    const res = await call('POST', '/api/v1/auth/quickpass/consume', {
      body: { token, confirmEmail: email },
    });
    expect(res.status).toBe(200);

    const { data } = await json<{ data: Me }>(res);
    expect(data.operator.email).toBe(email);
    expect(data.workspaces).toHaveLength(1);
    expect(data.workspaces[0]?.role).toBe('owner');

    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^__Host-swarm_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=2592000/);
  });

  it('keeps the token out of the URL path and query', async () => {
    const email = uniqueEmail();
    await requestToken(email);
    const res = await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(email)}`);
    const { data } = await json<{ data: { text: string } }>(res);
    expect(data.text).toMatch(/\/sign-in\/continue#token=/);
  });

  it('normalises the email so case does not create a second operator', async () => {
    const first = await signIn('Mixed.Case@Example.com');
    const second = await signIn('mixed.case@example.com');
    expect(second.me.operator.id).toBe(first.me.operator.id);
  });

  it('rejects a replayed token', async () => {
    const email = uniqueEmail();
    const token = await requestToken(email);
    const body = { token, confirmEmail: email };
    expect((await call('POST', '/api/v1/auth/quickpass/consume', { body })).status).toBe(200);
    const replay = await call('POST', '/api/v1/auth/quickpass/consume', { body });
    expect(replay.status).toBe(401);
  });

  it('signs in through a moment of D1 failure, which would otherwise use up the link', async () => {
    const email = uniqueEmail();
    const token = await requestToken(email);
    // The read that failed in practice: createSession's check for a known device, which runs after
    // the single-use token has been consumed.
    let attempts = 0;
    const db = new Proxy(env.DB, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (key !== 'prepare') return typeof value === 'function' ? value.bind(target) : value;
        return (sql: string) => {
          if (!sql.includes('SELECT DISTINCT user_agent') || ++attempts > 1) {
            return target.prepare(sql);
          }
          const fail = () =>
            Promise.reject(
              new Error('D1_ERROR: Failed to get session commit token: internal error'),
            );
          return { bind: () => ({ all: fail }) };
        };
      },
    });
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('http://localhost/api/v1/auth/quickpass/consume', {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ token, confirmEmail: email }),
      }),
      { ...env, DB: db },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(attempts).toBe(2);
    expect(res.status).toBe(200);
  });

  it('lets exactly one of two concurrent consumes win', async () => {
    const email = uniqueEmail();
    const token = await requestToken(email);
    const body = { token, confirmEmail: email };
    const results = await Promise.all([
      call('POST', '/api/v1/auth/quickpass/consume', { body }),
      call('POST', '/api/v1/auth/quickpass/consume', { body }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('rejects an expired token', async () => {
    const token = 'expired-token-0123456789abcdef';
    await env.DB.prepare(
      'INSERT INTO quickpass_tokens (id, token_hash, email, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    )
      .bind(
        'qp_expired',
        await sha256Hex(token),
        'late@example.com',
        Date.now() - 3_600_000,
        Date.now() - 60_000,
      )
      .run();
    const res = await call('POST', '/api/v1/auth/quickpass/consume', {
      body: { token, confirmEmail: 'late@example.com' },
    });
    expect(res.status).toBe(401);
  });

  it("signs in with the installer's link for an address the email check would refuse", async () => {
    // The installer accepts any a@b.c owner address and writes its first sign-in link directly.
    for (const local of ['first!last', 'josé']) {
      const email = `${local}-${crypto.randomUUID().slice(0, 8)}@corp.example.com`;
      const token = `installer-${crypto.randomUUID()}`;
      await env.DB.prepare(
        'INSERT INTO quickpass_tokens (id, token_hash, email, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)',
      )
        .bind(
          `qp_${crypto.randomUUID()}`,
          await sha256Hex(token),
          email,
          Date.now(),
          Date.now() + 3_600_000,
        )
        .run();
      const peek = await call('POST', '/api/v1/auth/quickpass/peek', { body: { token } });
      const { data: peeked } = await json<{ data: { email: string } }>(peek);
      expect(peeked.email).toBe(email);
      const res = await call('POST', '/api/v1/auth/quickpass/consume', {
        body: { token, confirmEmail: peeked.email },
      });
      expect(res.status).toBe(200);
      const { data } = await json<{ data: Me }>(res);
      expect(data.operator.email).toBe(email);
    }
  });

  it('fails closed when the security check fails or is for another action', async () => {
    turnstile.pass = false;
    let res = await call('POST', '/api/v1/auth/quickpass', {
      body: { email: uniqueEmail(), turnstileToken: 'x' },
      ip: nextIp(),
    });
    expect(res.status).toBe(403);

    turnstile.pass = true;
    turnstile.action = 'something-else';
    res = await call('POST', '/api/v1/auth/quickpass', {
      body: { email: uniqueEmail(), turnstileToken: 'x' },
      ip: nextIp(),
    });
    expect(res.status).toBe(403);
  });

  it('refuses a token without an action outside development', async () => {
    const production = {
      ...env,
      ENVIRONMENT: 'production',
      APP_ORIGIN: 'https://example.com',
    } as unknown as ApiEnv;
    turnstile.action = undefined;
    expect(await verifyTurnstile(production, 'x', undefined, 'quickpass')).toBe(false);
    turnstile.action = 'quickpass';
    expect(await verifyTurnstile(production, 'x', undefined, 'quickpass')).toBe(true);
  });

  it('stops issuing links after five per email in ten minutes, without telling the caller', async () => {
    const email = uniqueEmail();
    for (let i = 0; i < 7; i++) {
      const res = await call('POST', '/api/v1/auth/quickpass', {
        body: { email, turnstileToken: 'x' },
        ip: nextIp(),
      });
      expect(res.status).toBe(202);
    }
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM quickpass_tokens WHERE email = ?1')
      .bind(email)
      .first<{ n: number }>();
    expect(row?.n).toBe(5);
  });

  it('rate limits by IP', async () => {
    const ip = '203.0.113.99';
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await call('POST', '/api/v1/auth/quickpass', {
        body: { email: uniqueEmail(), turnstileToken: 'x' },
        ip,
      });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });

  it("does not replace a signed-in operator's session with another address's link unless that address is confirmed", async () => {
    const victim = await signIn();
    // Someone asks for a link to their own address and sends it to the signed-in operator.
    const attackerEmail = uniqueEmail('attacker');
    const token = await requestToken(attackerEmail);

    const res = await call('POST', '/api/v1/auth/quickpass/consume', {
      body: { token },
      cookie: victim.cookie,
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie') ?? '').not.toMatch(/__Host-swarm_session=/);
    const session = await call('GET', '/api/v1/auth/session', { cookie: victim.cookie });
    expect(session.status).toBe(200);
    expect((await json<{ data: Me }>(session)).data.operator.email).toBe(victim.email);

    // The link is not spent: confirming the address it names still signs in (another device).
    const confirmed = await call('POST', '/api/v1/auth/quickpass/consume', {
      body: { token, confirmEmail: attackerEmail },
    });
    expect(confirmed.status).toBe(200);
  });

  it('lets the browser that asked for a link use it without confirming the address', async () => {
    const email = uniqueEmail();
    const request = await call('POST', '/api/v1/auth/quickpass', {
      body: { email, turnstileToken: 'x' },
      ip: nextIp(),
    });
    const setCookie = request.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^__Host-swarm_quickpass=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Max-Age=600/);
    const browser = /(__Host-swarm_quickpass=[^;]+)/.exec(setCookie)![1]!;
    const token = await latestToken(email);

    const res = await call('POST', '/api/v1/auth/quickpass/consume', {
      body: { token },
      cookie: browser,
    });
    expect(res.status).toBe(200);
    expect((await json<{ data: Me }>(res)).data.operator.email).toBe(email);
  });

  it('refuses a confirmation of another address and leaves the link unused', async () => {
    const email = uniqueEmail();
    const token = await requestToken(email);
    const wrong = await call('POST', '/api/v1/auth/quickpass/consume', {
      body: { token, confirmEmail: uniqueEmail() },
    });
    expect(wrong.status).toBe(401);
    const right = await call('POST', '/api/v1/auth/quickpass/consume', {
      body: { token, confirmEmail: email.toUpperCase() },
    });
    expect(right.status).toBe(200);
  });

  it('names the address a link signs in as without using it', async () => {
    const email = uniqueEmail();
    const token = await requestToken(email);
    for (let i = 0; i < 2; i++) {
      const peek = await call('POST', '/api/v1/auth/quickpass/peek', { body: { token } });
      expect(peek.status).toBe(200);
      expect(peek.headers.get('set-cookie')).toBeNull();
      expect(await json(peek)).toEqual({ data: { email } });
    }
    const consumed = await call('POST', '/api/v1/auth/quickpass/consume', {
      body: { token, confirmEmail: email },
    });
    expect(consumed.status).toBe(200);
    expect((await call('POST', '/api/v1/auth/quickpass/peek', { body: { token } })).status).toBe(
      401,
    );
    expect(
      (
        await call('POST', '/api/v1/auth/quickpass/peek', {
          body: { token },
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
  });

  it('only accepts return paths on this site', async () => {
    const res = await call('POST', '/api/v1/auth/quickpass', {
      body: { email: uniqueEmail(), turnstileToken: 'x', returnTo: '//evil.example/steal' },
      ip: nextIp(),
    });
    expect(res.status).toBe(400);
  });
});

describe('CSRF', () => {
  const body = { email: 'x@example.com', turnstileToken: 'x' };

  it('blocks writes without an Origin from the dashboard', async () => {
    expect((await call('POST', '/api/v1/auth/quickpass', { body, origin: null })).status).toBe(403);
    expect(
      (await call('POST', '/api/v1/auth/quickpass', { body, origin: 'https://evil.example' }))
        .status,
    ).toBe(403);
  });

  it('accepts a same-origin fetch that sends no Origin', async () => {
    const res = await call('POST', '/api/v1/auth/quickpass', {
      body: { email: uniqueEmail(), turnstileToken: 'x' },
      origin: null,
      headers: { 'sec-fetch-site': 'same-origin' },
      ip: nextIp(),
    });
    expect(res.status).toBe(202);
  });

  it('refuses bodies a cross-site HTML form could send', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
      const res = await SELF.fetch('http://localhost/api/v1/auth/quickpass', {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': type },
        body: '{"email":"x@example.com","turnstileToken":"x"}',
      });
      expect(res.status).toBe(415);
    }
  });
});

describe('sessions', () => {
  it('requires a session', async () => {
    expect((await call('GET', '/api/v1/auth/session')).status).toBe(401);
    expect(
      (await call('GET', '/api/v1/auth/session', { cookie: '__Host-swarm_session=forged' })).status,
    ).toBe(401);
  });

  it('signs out, and the cookie stops working immediately', async () => {
    const session = await signIn();
    expect((await call('GET', '/api/v1/auth/session', { cookie: session.cookie })).status).toBe(
      200,
    );
    const out = await call('POST', '/api/v1/auth/logout', { cookie: session.cookie });
    expect(out.status).toBe(204);
    expect((await call('GET', '/api/v1/auth/session', { cookie: session.cookie })).status).toBe(
      401,
    );
  });

  it('lists devices and signs out another one', async () => {
    const email = uniqueEmail();
    const laptop = await signIn(email);
    const phoneToken = await requestToken(email);
    const phoneRes = await call('POST', '/api/v1/auth/quickpass/consume', {
      body: { token: phoneToken, confirmEmail: email },
    });
    const phone = sessionCookie(phoneRes);

    const list = await json<{ data: SessionSummary[] }>(
      await call('GET', '/api/v1/auth/sessions', { cookie: laptop.cookie }),
    );
    expect(list.data).toHaveLength(2);
    const other = list.data.find((s) => !s.current);
    expect(other).toBeDefined();

    expect(
      (await call('DELETE', `/api/v1/auth/sessions/${other!.id}`, { cookie: laptop.cookie }))
        .status,
    ).toBe(204);
    expect((await call('GET', '/api/v1/auth/session', { cookie: phone })).status).toBe(401);
    expect((await call('GET', '/api/v1/auth/session', { cookie: laptop.cookie })).status).toBe(200);
  });

  it('signing in again in the same browser ends the session it replaces', async () => {
    const email = uniqueEmail();
    const before = await signIn(email);
    for (const next of [email, uniqueEmail()]) {
      const old = (await call('GET', '/api/v1/auth/session', { cookie: before.cookie })).status;
      expect(old).toBe(200);
      const token = await requestToken(next);
      const res = await call('POST', '/api/v1/auth/quickpass/consume', {
        body: { token, confirmEmail: next },
        cookie: before.cookie,
      });
      expect(res.status).toBe(200);
      const after = sessionCookie(res);
      // The browser's old cookie is gone, and so is the session behind it, wherever a copy of
      // that token lives.
      expect((await call('GET', '/api/v1/auth/session', { cookie: before.cookie })).status).toBe(
        401,
      );
      expect((await call('GET', '/api/v1/auth/session', { cookie: after })).status).toBe(200);
      before.cookie = after;
    }
  });

  it("cannot sign out someone else's device", async () => {
    const a = await signIn();
    const b = await signIn();
    const res = await call('DELETE', `/api/v1/auth/sessions/${b.me.sessionId}`, {
      cookie: a.cookie,
    });
    expect(res.status).toBe(404);
    expect((await call('GET', '/api/v1/auth/session', { cookie: b.cookie })).status).toBe(200);
  });
});

describe('Google sign-in', () => {
  it('reports itself unavailable when not configured', async () => {
    const res = await call('GET', '/api/v1/auth/google');
    expect(res.status).toBe(501);
  });
});

describe('when the email service refuses the sign-in email', () => {
  it('says so, in place of a generic error', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://api.resend.com/')) {
        return Response.json(
          { name: 'validation_error', message: 'The mail.example.com domain is not verified.' },
          { status: 403 },
        );
      }
      return Response.json({ success: true, action: 'quickpass', hostname: 'example.com' });
    });
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`${ORIGIN}/api/v1/auth/quickpass`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          'cf-connecting-ip': nextIp(),
        },
        body: JSON.stringify({ email: uniqueEmail(), turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }),
      }),
      {
        ...env,
        MAIL_ADAPTER: 'resend',
        RESEND_API_KEY: 're_test_key_123456',
        AWS_REGION: 'us-east-1',
      },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(spy).toHaveBeenCalled();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toMatch(/couldn't send your sign-in email/);
    // The provider's words stay in the log.
    expect(body.error.message).not.toContain('mail.example.com');
  });
});
