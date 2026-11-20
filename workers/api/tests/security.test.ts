// Account security (Phase 7): second-factor sessions, TOTP, recovery codes, passkeys, the 2FA
// policy and its grace period, step-up checks, sign out everywhere and new-device mail.
import { env } from 'cloudflare:test';
import type { Me, SecondFactorStatus } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/lib/crypto';
import { base32Decode, hotp, totpStep } from '../src/lib/mfa';
import {
  call,
  createChannel,
  json,
  requestToken,
  seatAs,
  sessionCookie,
  signIn,
  uniqueEmail,
  type Session,
} from './helpers';
import { SoftAuthenticator } from './webauthn-authenticator';

type MeWith2fa = Me & { secondFactor: SecondFactorStatus };

/** Signs in with QuickPass and returns the session whatever its second-factor state. */
async function quickPass(email: string, headers: Record<string, string> = {}) {
  const token = await requestToken(email);
  const res = await call('POST', '/api/v1/auth/quickpass/consume', {
    body: { token, confirmEmail: email },
    headers,
  });
  expect(res.status).toBe(200);
  return { cookie: sessionCookie(res), me: (await json<{ data: MeWith2fa }>(res)).data };
}

const code = (secret: string, step = totpStep()) => hotp(base32Decode(secret), step);

/** Drops the KV copy of a session, as if its 5-minute cache entry had expired. */
async function forgetCache(cookie: string) {
  await env.CACHE.delete(`sess:v2:${await sha256Hex(cookie.split('=')[1] as string)}`);
}

async function sessionState(cookie: string) {
  const res = await call('GET', '/api/v1/auth/session', { cookie });
  expect(res.status).toBe(200);
  return (await json<{ data: MeWith2fa }>(res)).data;
}

/** Turns on TOTP for a signed-in session. Returns the secret, the rotated cookie and codes. */
async function enrolTotp(cookie: string) {
  const start = await call('POST', '/api/v1/security/totp', { cookie });
  expect(start.status).toBe(200);
  const { secret, uri } = (await json<{ data: { secret: string; uri: string } }>(start)).data;
  expect(uri).toMatch(/^otpauth:\/\/totp\/Swarm%3A/);
  const step = totpStep();
  const confirm = await call('POST', '/api/v1/security/totp/confirm', {
    cookie,
    body: { code: await code(secret, step) },
  });
  expect(confirm.status, await confirm.clone().text()).toBe(200);
  const { recoveryCodes } = (await json<{ data: { recoveryCodes: string[] | null } }>(confirm))
    .data;
  return { secret, step, cookie: sessionCookie(confirm), recoveryCodes };
}

async function verifyTotp(cookie: string, value: string) {
  return call('POST', '/api/v1/auth/second-factor/totp', { cookie, body: { code: value } });
}

/**
 * Sends many wrong second-factor attempts at once on one session. Returns how many were
 * evaluated (400) and refused (429), and the attempt rows left for the operator.
 */
async function burst(owner: Session, cookie: string, path: string, body: unknown, n = 30) {
  const results = await Promise.all(
    Array.from({ length: n }, () => call('POST', path, { cookie, body })),
  );
  const statuses = results.map((res) => res.status);
  const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM mfa_attempts WHERE operator_id = ?1')
    .bind(owner.me.operator.id)
    .first<{ n: number }>();
  return {
    evaluated: statuses.filter((s) => s === 400).length,
    refused: statuses.filter((s) => s === 429).length,
    rows: rows?.n,
  };
}

async function registerPasskey(cookie: string, authenticator: SoftAuthenticator, name = 'Laptop') {
  const options = await call('POST', '/api/v1/security/passkeys/options', { cookie });
  expect(options.status, await options.clone().text()).toBe(200);
  const { data } = await json<{ data: { challenge: string; rp: { id: string } } }>(options);
  expect(data.rp.id).toBe('localhost');
  const res = await call('POST', '/api/v1/security/passkeys', {
    cookie,
    body: { name, response: await authenticator.register(data) },
  });
  return res;
}

async function passkeyAssertion(
  cookie: string,
  authenticator: SoftAuthenticator,
  counter?: number,
) {
  const options = await call('POST', '/api/v1/auth/second-factor/passkey/options', { cookie });
  expect(options.status).toBe(200);
  const { data } = await json<{ data: { challenge: string; rpId: string } }>(options);
  return authenticator.assert(data, counter === undefined ? {} : { counter });
}

describe('second-factor sessions', () => {
  it('a new owner works during the grace period and is told when to enrol', async () => {
    const owner = await signIn();
    const me = await sessionState(owner.cookie);
    expect(me.secondFactor).toMatchObject({ state: 'ok', required: true, methods: [] });
    expect(Date.parse(me.secondFactor.enrollBy as string)).toBeGreaterThan(
      Date.now() + 13 * 24 * 3600_000,
    );
  });

  it('a first factor alone is pending once the operator has a second factor', async () => {
    const owner = await signIn();
    const { secret, step, recoveryCodes } = await enrolTotp(owner.cookie);
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes?.[0]).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);

    const pending = await quickPass(owner.email);
    expect(pending.me.secondFactor).toMatchObject({ state: 'verify' });
    expect(pending.me.secondFactor.methods).toEqual(['totp', 'recovery']);
    // A pending session learns nothing about the workspaces.
    expect(pending.me.workspaces).toEqual([]);

    // Everything else answers 401 mfa_required.
    for (const [method, path] of [
      ['GET', '/api/v1/workspaces'],
      ['GET', `/api/v1/workspaces/${owner.workspaceId}/seats`],
      ['GET', '/api/v1/auth/sessions'],
      ['GET', '/api/v1/security'],
      ['POST', '/api/v1/security/totp'],
      ['POST', '/api/v1/security/passkeys/options'],
    ] as const) {
      const res = await call(method, path, { cookie: pending.cookie });
      expect(res.status, path).toBe(401);
      expect(await res.json()).toMatchObject({ error: { code: 'mfa_required' } });
    }

    const verified = await verifyTotp(pending.cookie, await code(secret, step + 1));
    expect(verified.status).toBe(200);
    const me = (await json<{ data: MeWith2fa }>(verified)).data;
    expect(me.secondFactor).toMatchObject({ state: 'ok', verifiedWith: 'totp' });
    expect(me.workspaces).toHaveLength(1);

    // The token rotated: the pre-verification cookie is dead, the new one works.
    const fresh = sessionCookie(verified);
    expect(fresh).not.toBe(pending.cookie);
    expect((await call('GET', '/api/v1/auth/session', { cookie: pending.cookie })).status).toBe(
      401,
    );
    expect((await call('GET', '/api/v1/workspaces', { cookie: fresh })).status).toBe(200);
  });

  it('a pending session can still sign out', async () => {
    const owner = await signIn();
    await enrolTotp(owner.cookie);
    const pending = await quickPass(owner.email);
    expect((await call('POST', '/api/v1/auth/logout', { cookie: pending.cookie })).status).toBe(
      204,
    );
    expect((await call('GET', '/api/v1/auth/session', { cookie: pending.cookie })).status).toBe(
      401,
    );
  });

  it('adding the first factor holds the other sessions that never verified', async () => {
    const owner = await signIn();
    const laptop = await quickPass(owner.email);
    // Cache the laptop session first, so the hold must clear the cached copy too.
    expect((await call('GET', '/api/v1/workspaces', { cookie: laptop.cookie })).status).toBe(200);
    await enrolTotp(owner.cookie);
    const res = await call('GET', '/api/v1/workspaces', { cookie: laptop.cookie });
    expect(res.status).toBe(401);
    expect((await sessionState(laptop.cookie)).secondFactor.state).toBe('verify');
  });

  it('a session that never verified owes the factor even when it was not marked pending', async () => {
    const owner = await signIn();
    const laptop = await quickPass(owner.email);
    const { cookie } = await enrolTotp(owner.cookie);
    // A sign-in that read "no factors" just before the first one was added, and wrote its row
    // just after the other sessions were held: not pending, nothing verified.
    await env.DB.prepare(
      'UPDATE sessions SET mfa_pending = 0 WHERE operator_id = ?1 AND mfa_method IS NULL',
    )
      .bind(owner.me.operator.id)
      .run();
    await forgetCache(laptop.cookie);
    expect((await sessionState(laptop.cookie)).secondFactor.state).toBe('verify');
    const res = await call('GET', '/api/v1/workspaces', { cookie: laptop.cookie });
    expect(res.status).toBe(401);
    // The session that added the factor proved it, and keeps working.
    expect((await sessionState(cookie)).secondFactor.state).toBe('ok');
  });
});

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 test vectors (last six digits)', async () => {
    const secret = new TextEncoder().encode('12345678901234567890');
    expect(await hotp(secret, Math.floor(59 / 30))).toBe('287082');
    expect(await hotp(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(await hotp(secret, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('never accepts the same code twice, nor an older one', async () => {
    const owner = await signIn();
    const { secret, step } = await enrolTotp(owner.cookie);
    // The confirming code itself can't be replayed.
    const first = await quickPass(owner.email);
    const replay = await verifyTotp(first.cookie, await code(secret, step));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: { code: 'invalid_input' } });

    const next = await code(secret, step + 1);
    expect((await verifyTotp(first.cookie, next)).status).toBe(200);
    const second = await quickPass(owner.email);
    expect((await verifyTotp(second.cookie, next)).status).toBe(400);
  });

  it('refuses codes outside one step either side, and malformed codes', async () => {
    const owner = await signIn();
    const { secret } = await enrolTotp(owner.cookie);
    const pending = await quickPass(owner.email);
    expect((await verifyTotp(pending.cookie, await code(secret, totpStep() + 3))).status).toBe(400);
    expect((await verifyTotp(pending.cookie, await code(secret, totpStep() - 3))).status).toBe(400);
    expect((await verifyTotp(pending.cookie, '12345')).status).toBe(400);
  });

  it('limits failed attempts per session', async () => {
    const owner = await signIn();
    const { secret, step } = await enrolTotp(owner.cookie);
    const pending = await quickPass(owner.email);
    for (let i = 0; i < 5; i++) {
      expect((await verifyTotp(pending.cookie, '000000')).status).toBe(400);
    }
    const limited = await verifyTotp(pending.cookie, await code(secret, step + 1));
    expect(limited.status).toBe(429);
  });

  it('limits failed attempts per operator across sessions', async () => {
    const owner = await signIn();
    await enrolTotp(owner.cookie);
    for (let s = 0; s < 2; s++) {
      const pending = await quickPass(owner.email);
      for (let i = 0; i < 5; i++) await verifyTotp(pending.cookie, '000000');
    }
    const third = await quickPass(owner.email);
    expect((await verifyTotp(third.cookie, '000000')).status).toBe(429);
  });

  it('limits attempts sent at the same time, not only one after another', async () => {
    const owner = await signIn();
    const { secret } = await enrolTotp(owner.cookie);
    const pending = await quickPass(owner.email);
    const now = totpStep();
    const valid = await Promise.all([-1, 0, 1, 2].map((d) => code(secret, now + d)));
    let wrong = 0;
    while (valid.includes(String(wrong).padStart(6, '0'))) wrong++;
    const result = await burst(owner, pending.cookie, '/api/v1/auth/second-factor/totp', {
      code: String(wrong).padStart(6, '0'),
    });
    expect(result.evaluated).toBeLessThanOrEqual(5);
    expect(result).toEqual({ evaluated: 5, refused: 25, rows: 5 });
  });

  it('a successful code does not use up an attempt', async () => {
    const owner = await signIn();
    const { secret, step } = await enrolTotp(owner.cookie);
    const first = await quickPass(owner.email);
    for (let i = 0; i < 4; i++) await verifyTotp(first.cookie, '000000');
    expect((await verifyTotp(first.cookie, await code(secret, step + 1))).status).toBe(200);
    // 4 failures so far: 6 more fit under the operator limit of 10, then it refuses.
    const second = await quickPass(owner.email);
    for (let i = 0; i < 5; i++) {
      expect((await verifyTotp(second.cookie, '000000')).status).toBe(400);
    }
    const third = await quickPass(owner.email);
    expect((await verifyTotp(third.cookie, '000000')).status).toBe(400);
    expect((await verifyTotp(third.cookie, '000000')).status).toBe(429);
  });

  it('refuses a second enrolment while one is on, and a wrong confirmation code', async () => {
    const owner = await signIn();
    const start = await call('POST', '/api/v1/security/totp', { cookie: owner.cookie });
    expect(start.status).toBe(200);
    const wrong = await call('POST', '/api/v1/security/totp/confirm', {
      cookie: owner.cookie,
      body: { code: '000000' },
    });
    expect(wrong.status).toBe(400);
    const { cookie } = await enrolTotp(owner.cookie);
    expect((await call('POST', '/api/v1/security/totp', { cookie })).status).toBe(409);
  });

  it('stores the secret sealed, never in clear', async () => {
    const owner = await signIn();
    const { secret } = await enrolTotp(owner.cookie);
    const row = await env.DB.prepare('SELECT secret_enc FROM totp_secrets WHERE operator_id = ?1')
      .bind(owner.me.operator.id)
      .first<{ secret_enc: string }>();
    expect(row?.secret_enc).not.toContain(secret);
    expect(row?.secret_enc).toMatch(/^f1\./);
  });
});

describe('recovery codes', () => {
  it('work once, are audited and email the operator', async () => {
    const owner = await signIn();
    const { recoveryCodes } = await enrolTotp(owner.cookie);
    const [codeA] = recoveryCodes as string[];

    const pending = await quickPass(owner.email);
    const used = await call('POST', '/api/v1/auth/second-factor/recovery', {
      cookie: pending.cookie,
      body: { code: (codeA as string).toUpperCase() },
    });
    expect(used.status).toBe(200);
    const fresh = sessionCookie(used);

    const mail = await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(owner.email)}`);
    const { data } = await json<{ data: { category: string; text: string } }>(mail);
    expect(data.category).toBe('recovery_code_used');
    expect(data.text).toContain('9 unused codes are left');

    const audit = await call('GET', `/api/v1/workspaces/${owner.workspaceId}/audit`, {
      cookie: fresh,
    });
    const { items } = (await json<{ data: { items: { action: string }[] } }>(audit)).data;
    expect(items.map((item) => item.action)).toContain('operator.recovery_code_used');

    const again = await quickPass(owner.email);
    const reused = await call('POST', '/api/v1/auth/second-factor/recovery', {
      cookie: again.cookie,
      body: { code: codeA },
    });
    expect(reused.status).toBe(400);
  });

  it('limits wrong codes sent at the same time', async () => {
    const owner = await signIn();
    await enrolTotp(owner.cookie);
    const pending = await quickPass(owner.email);
    const result = await burst(owner, pending.cookie, '/api/v1/auth/second-factor/recovery', {
      code: '0000-0000-0000',
    });
    expect(result.evaluated).toBeLessThanOrEqual(5);
    expect(result).toEqual({ evaluated: 5, refused: 25, rows: 5 });
  });

  it('regenerating needs a recent second factor and invalidates the old codes', async () => {
    const owner = await signIn();
    const enrolled = await enrolTotp(owner.cookie);
    const regen = await call('POST', '/api/v1/security/recovery-codes', {
      cookie: enrolled.cookie,
    });
    expect(regen.status).toBe(200);
    const { recoveryCodes } = (await json<{ data: { recoveryCodes: string[] } }>(regen)).data;
    expect(recoveryCodes).toHaveLength(10);

    const pending = await quickPass(owner.email);
    const old = await call('POST', '/api/v1/auth/second-factor/recovery', {
      cookie: pending.cookie,
      body: { code: enrolled.recoveryCodes?.[0] },
    });
    expect(old.status).toBe(400);
    const current = await call('POST', '/api/v1/auth/second-factor/recovery', {
      cookie: pending.cookie,
      body: { code: recoveryCodes[0] },
    });
    expect(current.status).toBe(200);

    // A verification older than the step-up window is not enough.
    const cookie = sessionCookie(current);
    await env.DB.prepare('UPDATE sessions SET mfa_verified_at = ?1 WHERE operator_id = ?2')
      .bind(Date.now() - 11 * 60_000, owner.me.operator.id)
      .run();
    await forgetCache(cookie);
    const stale = await call('POST', '/api/v1/security/recovery-codes', { cookie });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({
      error: { details: [{ path: 'secondFactor', message: 'step_up_required' }] },
    });
  });
});

describe('passkeys', () => {
  it('registers with a real attestation and verifies a real assertion', async () => {
    const owner = await signIn();
    const authenticator = new SoftAuthenticator();
    const added = await registerPasskey(owner.cookie, authenticator);
    expect(added.status, await added.clone().text()).toBe(201);
    const { recoveryCodes } = (await json<{ data: { recoveryCodes: string[] } }>(added)).data;
    expect(recoveryCodes).toHaveLength(10);
    const cookie = sessionCookie(added);

    const overview = await call('GET', '/api/v1/security', { cookie });
    const { data } = await json<{
      data: { passkeys: { id: string; name: string }[]; secondFactor: SecondFactorStatus };
    }>(overview);
    expect(data.passkeys).toMatchObject([{ name: 'Laptop' }]);
    expect(data.secondFactor).toMatchObject({ state: 'ok', methods: ['passkey', 'recovery'] });

    const pending = await quickPass(owner.email);
    expect(pending.me.secondFactor.state).toBe('verify');
    const response = await passkeyAssertion(pending.cookie, authenticator);
    const verified = await call('POST', '/api/v1/auth/second-factor/passkey', {
      cookie: pending.cookie,
      body: { response },
    });
    expect(verified.status, await verified.clone().text()).toBe(200);
    expect((await json<{ data: MeWith2fa }>(verified)).data.secondFactor.verifiedWith).toBe(
      'passkey',
    );

    // The challenge was spent: replaying the same assertion fails.
    const again = await quickPass(owner.email);
    const replay = await call('POST', '/api/v1/auth/second-factor/passkey', {
      cookie: again.cookie,
      body: { response },
    });
    expect(replay.status).toBe(400);
  });

  it('limits failed assertions sent at the same time', async () => {
    const owner = await signIn();
    const added = await registerPasskey(owner.cookie, new SoftAuthenticator());
    expect(added.status).toBe(201);
    const pending = await quickPass(owner.email);
    const result = await burst(owner, pending.cookie, '/api/v1/auth/second-factor/passkey', {
      response: { id: 'not-a-registered-credential' },
    });
    expect(result.evaluated).toBeLessThanOrEqual(5);
    expect(result).toEqual({ evaluated: 5, refused: 25, rows: 5 });
  });

  it('refuses a signature counter that does not move forward', async () => {
    const owner = await signIn();
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(owner.cookie, authenticator)).status).toBe(201);
    const first = await quickPass(owner.email);
    const ok = await call('POST', '/api/v1/auth/second-factor/passkey', {
      cookie: first.cookie,
      body: { response: await passkeyAssertion(first.cookie, authenticator, 5) },
    });
    expect(ok.status).toBe(200);
    const cloned = await quickPass(owner.email);
    const res = await call('POST', '/api/v1/auth/second-factor/passkey', {
      cookie: cloned.cookie,
      body: { response: await passkeyAssertion(cloned.cookie, authenticator, 5) },
    });
    expect(res.status).toBe(400);
  });

  it('refuses an assertion from another origin, or for a key of another operator', async () => {
    const owner = await signIn();
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(owner.cookie, authenticator)).status).toBe(201);
    const pending = await quickPass(owner.email);
    const options = await call('POST', '/api/v1/auth/second-factor/passkey/options', {
      cookie: pending.cookie,
    });
    const { data } = await json<{ data: { challenge: string } }>(options);
    const phished = await authenticator.assert(data, { origin: 'https://evil.example' });
    const res = await call('POST', '/api/v1/auth/second-factor/passkey', {
      cookie: pending.cookie,
      body: { response: phished },
    });
    expect(res.status).toBe(400);

    const other = await signIn();
    const otherKey = new SoftAuthenticator();
    expect((await registerPasskey(other.cookie, otherKey)).status).toBe(201);
    const foreign = await call('POST', '/api/v1/auth/second-factor/passkey', {
      cookie: pending.cookie,
      body: { response: await otherKey.assert({ challenge: data.challenge }) },
    });
    expect(foreign.status).toBe(400);
  });

  it('refuses a registration for another origin or a spent challenge', async () => {
    const owner = await signIn();
    const options = await call('POST', '/api/v1/security/passkeys/options', {
      cookie: owner.cookie,
    });
    const { data } = await json<{ data: { challenge: string } }>(options);
    const authenticator = new SoftAuthenticator();
    const wrongOrigin = await call('POST', '/api/v1/security/passkeys', {
      cookie: owner.cookie,
      body: {
        name: 'Phone',
        response: await authenticator.register(data, { origin: 'https://evil.example' }),
      },
    });
    expect(wrongOrigin.status).toBe(400);
    // That attempt spent the challenge.
    const spent = await call('POST', '/api/v1/security/passkeys', {
      cookie: owner.cookie,
      body: { name: 'Phone', response: await authenticator.register(data) },
    });
    expect(spent.status).toBe(400);
  });

  it('renames and removes, and never removes the last factor of an owner', async () => {
    const owner = await signIn();
    const laptop = new SoftAuthenticator();
    const added = await registerPasskey(owner.cookie, laptop);
    let cookie = sessionCookie(added);
    const list = async () =>
      (
        await json<{ data: { passkeys: { id: string; name: string }[] } }>(
          await call('GET', '/api/v1/security', { cookie }),
        )
      ).data.passkeys;
    const [key] = await list();
    const renamed = await call('PATCH', `/api/v1/security/passkeys/${key?.id}`, {
      cookie,
      body: { name: 'Work laptop' },
    });
    expect(renamed.status).toBe(200);
    expect((await list())[0]?.name).toBe('Work laptop');

    const last = await call('DELETE', `/api/v1/security/passkeys/${key?.id}`, { cookie });
    expect(last.status).toBe(409);

    // A second factor (a second passkey) makes removing the first one fine.
    const phone = new SoftAuthenticator();
    const second = await registerPasskey(cookie, phone, 'Phone');
    expect(second.status).toBe(201);
    expect((await json<{ data: { recoveryCodes: null } }>(second)).data.recoveryCodes).toBeNull();
    cookie = sessionCookie(added);
    expect((await call('DELETE', `/api/v1/security/passkeys/${key?.id}`, { cookie })).status).toBe(
      204,
    );
    expect(await list()).toHaveLength(1);

    const other = await signIn();
    expect(
      (
        await call('DELETE', `/api/v1/security/passkeys/${(await list())[0]?.id}`, {
          cookie: other.cookie,
        })
      ).status,
    ).toBe(404);
  });

  it('adding a factor when one exists needs a recent second factor', async () => {
    const owner = await signIn();
    const enrolled = await enrolTotp(owner.cookie);
    await env.DB.prepare('UPDATE sessions SET mfa_verified_at = ?1 WHERE operator_id = ?2')
      .bind(Date.now() - 60 * 60_000, owner.me.operator.id)
      .run();
    await forgetCache(enrolled.cookie);
    const res = await call('POST', '/api/v1/security/passkeys/options', {
      cookie: enrolled.cookie,
    });
    expect(res.status).toBe(403);
  });

  it("an Idempotency-Key never replays one session's step-up answer to another", async () => {
    const owner = await signIn();
    const enrolled = await enrolTotp(owner.cookie);
    const other = await quickPass(owner.email);
    const verified = await verifyTotp(other.cookie, await code(enrolled.secret, enrolled.step + 1));
    expect(verified.status).toBe(200);
    const fresh = enrolled.cookie;
    const stale = sessionCookie(verified);
    const setVerifiedAt = async (cookie: string, at: number) => {
      await env.DB.prepare('UPDATE sessions SET mfa_verified_at = ?1 WHERE token_hash = ?2')
        .bind(at, await sha256Hex(cookie.split('=')[1] as string))
        .run();
      await forgetCache(cookie);
    };
    await setVerifiedAt(fresh, Date.now());
    await setVerifiedAt(stale, Date.now() - 60 * 60_000);

    const path = '/api/v1/security/passkeys/options';
    const headers = { 'idempotency-key': `step-up-${crypto.randomUUID()}` };
    const first = await call('POST', path, { cookie: fresh, headers });
    expect(first.status).toBe(200);
    // The same session retrying gets its answer back.
    const retry = await call('POST', path, { cookie: fresh, headers });
    expect(retry.status).toBe(200);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    // Another session of the same operator, without a recent check, does not.
    expect((await call('POST', path, { cookie: stale })).status).toBe(403);
    const replayed = await call('POST', path, { cookie: stale, headers });
    expect(replayed.headers.get('idempotent-replayed')).toBeNull();
    expect(replayed.status).toBe(409);
  });
});

describe('policy and grace', () => {
  async function endGrace(session: { cookie: string; me: Me }) {
    await env.DB.prepare('UPDATE operators SET mfa_required_since = ?1 WHERE id = ?2')
      .bind(Date.now() - 15 * 24 * 3600_000, session.me.operator.id)
      .run();
    await forgetCache(session.cookie);
  }

  it('after the grace period an owner without a factor must enrol first', async () => {
    const owner = await signIn();
    await endGrace(owner);
    const refused = await call('GET', '/api/v1/workspaces', { cookie: owner.cookie });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: { code: 'mfa_required' } });
    expect((await sessionState(owner.cookie)).secondFactor).toMatchObject({
      state: 'enroll',
      methods: [],
    });
    // Enrolling is open to it, and finishes the sign-in.
    expect((await call('GET', '/api/v1/security', { cookie: owner.cookie })).status).toBe(200);
    const { cookie } = await enrolTotp(owner.cookie);
    expect((await call('GET', '/api/v1/workspaces', { cookie })).status).toBe(200);
  });

  it('a new sign-in after the grace period starts pending', async () => {
    const owner = await signIn();
    await endGrace(owner);
    const again = await quickPass(owner.email);
    expect(again.me.secondFactor.state).toBe('enroll');
    // Verifying makes no sense without a factor.
    expect(
      (await call('POST', '/api/v1/auth/second-factor/passkey/options', { cookie: again.cookie }))
        .status,
    ).toBe(404);
  });

  it("require_2fa 'all' covers every seat; only owners change it, and it is audited", async () => {
    const owner = await signIn();
    const viewer = await seatAs(owner.workspaceId, 'viewer');
    const admin = await seatAs(owner.workspaceId, 'admin');
    // The viewer's own workspace makes them an owner there; drop it to test the seat alone.
    await env.DB.prepare("DELETE FROM seats WHERE operator_id = ?1 AND role = 'owner'")
      .bind(viewer.me.operator.id)
      .run();
    await forgetCache(viewer.cookie);
    expect((await sessionState(viewer.cookie)).secondFactor.required).toBe(false);

    for (const session of [viewer, admin]) {
      const res = await call('PUT', `/api/v1/workspaces/${owner.workspaceId}/security`, {
        cookie: session.cookie,
        body: { require2fa: 'all' },
      });
      expect(res.status).toBe(403);
    }
    const outsider = await signIn();
    expect(
      (
        await call('PUT', `/api/v1/workspaces/${owner.workspaceId}/security`, {
          cookie: outsider.cookie,
          body: { require2fa: 'all' },
        })
      ).status,
    ).toBe(404);

    const set = await call('PUT', `/api/v1/workspaces/${owner.workspaceId}/security`, {
      cookie: owner.cookie,
      body: { require2fa: 'all' },
    });
    expect(set.status).toBe(200);
    expect((await json<{ data: { seatsWithoutSecondFactor: number } }>(set)).data).toMatchObject({
      require2fa: 'all',
      seatsWithoutSecondFactor: 3,
    });
    await forgetCache(viewer.cookie);
    const status = (await sessionState(viewer.cookie)).secondFactor;
    expect(status).toMatchObject({ state: 'ok', required: true });
    expect(status.enrollBy).not.toBeNull();

    // Viewers read the policy, but not the count.
    const read = await call('GET', `/api/v1/workspaces/${owner.workspaceId}/security`, {
      cookie: viewer.cookie,
    });
    expect((await json<{ data: unknown }>(read)).data).toEqual({
      require2fa: 'all',
      seatsWithoutSecondFactor: null,
    });

    const audit = await call('GET', `/api/v1/workspaces/${owner.workspaceId}/audit`, {
      cookie: owner.cookie,
    });
    const { items } = (
      await json<{ data: { items: { action: string; metadata: unknown }[] } }>(audit)
    ).data;
    expect(items.find((i) => i.action === 'workspace.require_2fa_changed')).toBeTruthy();
  });

  it('the strictest seat wins, and a factor is optional where nothing requires it', async () => {
    const strict = await signIn();
    await call('PUT', `/api/v1/workspaces/${strict.workspaceId}/security`, {
      cookie: strict.cookie,
      body: { require2fa: 'all' },
    });
    const relaxed = await signIn();
    const op = await seatAs(relaxed.workspaceId, 'viewer');
    await env.DB.prepare("DELETE FROM seats WHERE operator_id = ?1 AND role = 'owner'")
      .bind(op.me.operator.id)
      .run();
    await forgetCache(op.cookie);
    expect((await sessionState(op.cookie)).secondFactor.required).toBe(false);

    // Removing the only factor is fine while nothing requires one; recovery codes go with it.
    const enrolled = await enrolTotp(op.cookie);
    expect(
      (await call('DELETE', '/api/v1/security/totp', { cookie: enrolled.cookie })).status,
    ).toBe(204);
    const left = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM recovery_codes WHERE operator_id = ?1',
    )
      .bind(op.me.operator.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);

    await env.DB.prepare(
      "INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'viewer', ?4, ?4)",
    )
      .bind(
        `st_${crypto.randomUUID().replace(/-/g, '')}`,
        strict.workspaceId,
        op.me.operator.id,
        Date.now(),
      )
      .run();
    await forgetCache(enrolled.cookie);
    expect((await sessionState(enrolled.cookie)).secondFactor.required).toBe(true);
  });

  it('turning off the only TOTP of an owner is refused', async () => {
    const owner = await signIn();
    const { cookie } = await enrolTotp(owner.cookie);
    expect((await call('DELETE', '/api/v1/security/totp', { cookie })).status).toBe(409);
  });
});

describe('sessions', () => {
  it('sign out everywhere revokes every other session at once, cache included', async () => {
    const owner = await signIn();
    const other = await quickPass(owner.email);
    // Warm the other session's cache entry.
    expect((await call('GET', '/api/v1/workspaces', { cookie: other.cookie })).status).toBe(200);
    const res = await call('POST', '/api/v1/auth/sessions/sign-out-everywhere', {
      cookie: owner.cookie,
      body: { keepCurrent: true },
    });
    expect(res.status).toBe(200);
    expect((await json<{ data: { revoked: number } }>(res)).data.revoked).toBe(1);
    expect((await call('GET', '/api/v1/workspaces', { cookie: other.cookie })).status).toBe(401);
    expect((await call('GET', '/api/v1/workspaces', { cookie: owner.cookie })).status).toBe(200);

    const all = await call('POST', '/api/v1/auth/sessions/sign-out-everywhere', {
      cookie: owner.cookie,
      body: { keepCurrent: false },
    });
    expect(all.status).toBe(200);
    expect((await call('GET', '/api/v1/workspaces', { cookie: owner.cookie })).status).toBe(401);
  });

  it('a pending session cannot sign out everywhere', async () => {
    const owner = await signIn();
    await enrolTotp(owner.cookie);
    const pending = await quickPass(owner.email);
    const res = await call('POST', '/api/v1/auth/sessions/sign-out-everywhere', {
      cookie: pending.cookie,
      body: {},
    });
    expect(res.status).toBe(401);
  });

  it('emails the operator about a sign-in from a new device, not a known one', async () => {
    const email = uniqueEmail('device');
    const chrome = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36',
      'cf-connecting-ip': '203.0.113.7',
    };
    await quickPass(email, chrome);
    const latest = async () =>
      (
        await json<{ data: { category: string; text: string } }>(
          await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(email)}`),
        )
      ).data;
    // The first sign-in ever has nothing to compare with.
    expect((await latest()).category).toBe('quickpass');

    await quickPass(email, { ...chrome, 'cf-connecting-ip': '203.0.113.99' });
    expect((await latest()).category).toBe('quickpass');

    await quickPass(email, {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Gecko/20100101 Firefox/131.0',
      'cf-connecting-ip': '198.51.100.20',
    });
    const mail = await latest();
    expect(mail.category).toBe('new_device');
    expect(mail.text).toContain('Firefox on macOS');
    expect(mail.text).toContain('198.51.100.0/24');
    expect(mail.text).toContain('http://localhost:5273/settings/sessions');
  });
});

describe('security routes: tenancy and access', () => {
  it('signed-out requests get 401', async () => {
    for (const [method, path] of [
      ['GET', '/api/v1/security'],
      ['POST', '/api/v1/security/totp'],
      ['POST', '/api/v1/security/passkeys/options'],
      ['POST', '/api/v1/security/recovery-codes'],
      ['POST', '/api/v1/auth/second-factor/totp'],
      ['POST', '/api/v1/auth/sessions/sign-out-everywhere'],
    ] as const) {
      const body = path.endsWith('/second-factor/totp') ? { code: '123456' } : {};
      const res = await call(method, path, method === 'GET' ? {} : { body });
      expect(res.status, path).toBe(401);
    }
  });

  it("a workspace's policy is invisible to outsiders and readable by every seat", async () => {
    const owner: Session = await signIn();
    await createChannel(owner);
    for (const role of ['viewer', 'author', 'editor', 'admin'] as const) {
      const seat = await seatAs(owner.workspaceId, role);
      const res = await call('GET', `/api/v1/workspaces/${owner.workspaceId}/security`, {
        cookie: seat.cookie,
      });
      expect(res.status).toBe(200);
      const put = await call('PUT', `/api/v1/workspaces/${owner.workspaceId}/security`, {
        cookie: seat.cookie,
        body: { require2fa: 'admins' },
      });
      expect(put.status).toBe(403);
    }
    const outsider = await signIn();
    expect(
      (
        await call('GET', `/api/v1/workspaces/${owner.workspaceId}/security`, {
          cookie: outsider.cookie,
        })
      ).status,
    ).toBe(404);
  });
});

describe('account activity', () => {
  it('keeps the full record for the operator and copies only action, method and time to workspaces', async () => {
    const owner = await signIn();
    const teammate = await seatAs(owner.workspaceId, 'editor');
    // The teammate signs in again from a known network and browser, then adds a factor.
    const token = await requestToken(teammate.email);
    const res = await call('POST', '/api/v1/auth/quickpass/consume', {
      body: { token, confirmEmail: teammate.email },
      headers: { 'cf-connecting-ip': '203.0.113.77', 'user-agent': 'SyntheticBrowser/1.0' },
    });
    expect(res.status).toBe(200);
    const enrolled = await enrolTotp(sessionCookie(res));

    // The owner's workspace sees the event types and methods, with no network or browser.
    const rows = await env.DB.prepare(
      `SELECT action, metadata_json, ip_prefix FROM audit_events
        WHERE workspace_id = ?1 AND actor_operator_id = ?2 AND action LIKE 'operator.%' ORDER BY seq`,
    )
      .bind(owner.workspaceId, teammate.me.operator.id)
      .all<{ action: string; metadata_json: string; ip_prefix: string | null }>();
    expect(rows.results.map((r) => [r.action, JSON.parse(r.metadata_json)])).toEqual([
      ['operator.signed_in', { method: 'quickpass' }],
      ['operator.totp_enabled', { method: 'totp' }],
    ]);
    expect(rows.results.every((r) => r.ip_prefix === null)).toBe(true);
    const exported = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/audit/export`, {
      cookie: owner.cookie,
      body: { format: 'jsonl' },
    });
    expect(exported.status).toBe(200);
    const text = await exported.text();
    expect(text).toContain('operator.totp_enabled');
    expect(text).not.toContain('203.0.113');
    expect(text).not.toContain('SyntheticBrowser');
    const verify = await call('GET', `/api/v1/workspaces/${owner.workspaceId}/audit/verify`, {
      cookie: owner.cookie,
    });
    expect(await verify.json()).toMatchObject({ data: { ok: true } });

    // The teammate's own Security page has the whole record, newest first.
    const overview = await call('GET', '/api/v1/security', { cookie: enrolled.cookie });
    const { activity } = (
      await json<{
        data: {
          activity: {
            action: string;
            method: string | null;
            ipPrefix: string | null;
            userAgent: string | null;
          }[];
        };
      }>(overview)
    ).data;
    expect(activity[0]).toMatchObject({ action: 'operator.totp_enabled', method: 'totp' });
    expect(activity[1]).toMatchObject({
      action: 'operator.signed_in',
      method: 'quickpass',
      ipPrefix: '203.0.113.0/24',
      userAgent: 'SyntheticBrowser/1.0',
    });
    // Nobody else's events are in it.
    const ownerOverview = await call('GET', '/api/v1/security', { cookie: owner.cookie });
    const ownerActivity = (await json<{ data: { activity: { action: string }[] } }>(ownerOverview))
      .data.activity;
    expect(ownerActivity.every((event) => event.action === 'operator.signed_in')).toBe(true);
  });
});

describe('undoing a first factor ("This wasn\'t me", S04-P1-V-first-factor-takeover)', () => {
  it('removes the factor, signs out every session and needs an email sign-in, once', async () => {
    // The real person's session, then someone with their mailbox signs in and adds a factor.
    const owner = await signIn();
    const intruder = await quickPass(owner.email);
    await enrolTotp(intruder.cookie);
    expect((await sessionState(owner.cookie)).secondFactor.state).toBe('verify');

    const mail = await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(owner.email)}`);
    const { data } = await json<{ data: { category: string; text: string } }>(mail);
    expect(data.category).toBe('account_security_changed');
    const token = /\/sign-in\/undo-factor#token=([A-Za-z0-9_-]+)/.exec(data.text)?.[1];
    expect(token).toBeTruthy();
    // Only a hash is stored, valid for 7 days.
    const stored = await env.DB.prepare(
      'SELECT token_hash, expires_at - created_at AS ttl FROM factor_undo_tokens WHERE operator_id = ?1',
    )
      .bind(owner.me.operator.id)
      .first<{ token_hash: string; ttl: number }>();
    expect(stored?.token_hash).toBe(await sha256Hex(token!));
    expect(stored?.ttl).toBe(7 * 86_400_000);

    const res = await call('POST', '/api/v1/auth/undo-first-factor', { body: { token } });
    expect(res.status).toBe(200);
    expect((await json<{ data: Record<string, unknown> }>(res)).data).toMatchObject({
      authenticatorRemoved: true,
      passkeysRemoved: 0,
    });
    const left = await env.DB.prepare(
      `SELECT (SELECT count(*) FROM totp_secrets WHERE operator_id = ?1)
            + (SELECT count(*) FROM recovery_codes WHERE operator_id = ?1) AS n`,
    )
      .bind(owner.me.operator.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    for (const cookie of [owner.cookie, intruder.cookie]) {
      expect((await call('GET', '/api/v1/auth/session', { cookie })).status).toBe(401);
    }
    // Once only.
    expect((await call('POST', '/api/v1/auth/undo-first-factor', { body: { token } })).status).toBe(
      401,
    );
    // Audited in the workspace, and the person is told.
    const audit = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_events WHERE workspace_id = ?1 AND action = 'operator.first_factor_undone'",
    )
      .bind(owner.workspaceId)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
    const told = await json<{ data: { subject: string } }>(
      await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(owner.email)}`),
    );
    expect(told.data.subject).toContain('Second factor removed');

    // The next sign-in has to be an email link; that one clears the mark and needs no factor.
    const required = () =>
      env.DB.prepare('SELECT email_signin_required_at AS at FROM operators WHERE id = ?1')
        .bind(owner.me.operator.id)
        .first<{ at: number | null }>();
    expect((await required())?.at).not.toBeNull();
    const back = await quickPass(owner.email);
    expect(back.me.secondFactor.state).toBe('ok');
    expect((await required())?.at).toBeNull();
  });

  it('refuses a token nobody issued, and an expired one', async () => {
    expect(
      (
        await call('POST', '/api/v1/auth/undo-first-factor', {
          body: { token: 'x'.repeat(43) },
        })
      ).status,
    ).toBe(401);
    const owner = await signIn();
    await enrolTotp(owner.cookie);
    const { data } = await json<{ data: { text: string } }>(
      await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(owner.email)}`),
    );
    const token = /#token=([A-Za-z0-9_-]+)/.exec(data.text)![1];
    await env.DB.prepare('UPDATE factor_undo_tokens SET expires_at = 0 WHERE operator_id = ?1')
      .bind(owner.me.operator.id)
      .run();
    expect((await call('POST', '/api/v1/auth/undo-first-factor', { body: { token } })).status).toBe(
      401,
    );
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM totp_secrets WHERE operator_id = ?1')
        .bind(owner.me.operator.id)
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });
  });
});
