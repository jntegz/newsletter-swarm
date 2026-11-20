// SSO (Phase 7): connections, DNS domain proof and capture, OIDC sign-in against a local fake
// identity provider with its own JWKS, just-in-time seats, enforcement and plan gating.
import { env } from 'cloudflare:test';
import {
  SSO_DOMAIN_LAPSE_DAYS,
  SSO_SESSION_MAX_HOURS,
  newId,
  type Me,
  type SecondFactorStatus,
  type SeatRole,
  type SsoConnection,
  type SsoDomain,
} from '@swarm/domain';
import { DevMailbox } from '@swarm/mail';
import { base64UrlEncode } from '@swarm/tokens';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../src/lib/crypto';
import { s256 } from '../src/lib/oidc';
import { base32Decode, hotp, totpStep } from '../src/lib/mfa';
import {
  call,
  json,
  ORIGIN,
  requestToken,
  seatAs,
  sessionCookie,
  signIn,
  uniqueEmail,
  type Session,
} from './helpers';

const ISSUER = 'https://idp.test';
const CLIENT_ID = 'swarm-client';
const CLIENT_SECRET = 'idp-secret-value';

/** A second provider with its own keys: the kind a rogue admin would point a connection at. */
const ROGUE = {
  issuer: 'https://idp2.test',
  clientId: 'rogue-client',
  clientSecret: 'rogue-secret',
};

type KeyPair = { keys: CryptoKeyPair; jwk: JsonWebKey & { kid: string } };
let keys: CryptoKeyPair;
let jwk: KeyPair['jwk'];
let rogueKey: KeyPair;
const codes = new Map<string, { claims: Record<string, unknown>; challenge: string }>();

const encode = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

/** A fresh RS256 signing key and its public JWK, always under the kid the tokens name. */
async function keyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  return {
    keys: pair,
    jwk: {
      ...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey),
      kid: 'idp-1',
      alg: 'RS256',
      use: 'sig',
    },
  };
}

async function sign(claims: Record<string, unknown>, signer = keys.privateKey) {
  const header = encode({ alg: 'RS256', kid: 'idp-1', typ: 'JWT' });
  const payload = encode(claims);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signer,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

interface FakeIdpOptions {
  /** Merged into the discovery document. */
  discovery?: Record<string, unknown>;
  /** The JWKS it publishes (default: the shared test key). */
  keys?: () => JsonWebKey[];
  /** The key it signs ID tokens with (default: the shared test key). */
  signer?: () => CryptoKey;
  /** The client it accepts at the token endpoint (default: CLIENT_ID and CLIENT_SECRET). */
  client?: { clientId: string; clientSecret: string };
}

/** A fake identity provider at `issuer`: discovery, JWKS and a token endpoint that checks PKCE. */
function fakeIdp(issuer: string, options: FakeIdpOptions = {}) {
  return async (url: URL, init?: RequestInit): Promise<Response> => {
    if (url.pathname === '/.well-known/openid-configuration') {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        ...options.discovery,
      });
    }
    if (url.pathname === '/jwks') return Response.json({ keys: options.keys?.() ?? [jwk] });
    if (url.pathname === '/token' && init?.method === 'POST') {
      const auth = new Headers(init.headers).get('authorization');
      const { clientId, clientSecret } = options.client ?? {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      };
      if (auth !== `Basic ${btoa(`${clientId}:${clientSecret}`)}`) {
        return Response.json({ error: 'invalid_client' }, { status: 401 });
      }
      const body = new URLSearchParams(init.body as URLSearchParams);
      const grant = codes.get(body.get('code') ?? '');
      codes.delete(body.get('code') ?? '');
      if (!grant || (await s256(body.get('code_verifier') ?? '')) !== grant.challenge) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return Response.json({
        access_token: 'at',
        id_token: await sign(grant.claims, options.signer?.()),
      });
    }
    return new Response('not found', { status: 404 });
  };
}

type Handler = (url: URL, init?: RequestInit) => Promise<Response>;
/** Outbound hosts the tests answer, by origin. Tests add their own and remove them after. */
const hosts = new Map<string, Handler>([
  [ISSUER, fakeIdp(ISSUER)],
  [
    ROGUE.issuer,
    fakeIdp(ROGUE.issuer, {
      client: ROGUE,
      keys: () => [rogueKey.jwk],
      signer: () => rogueKey.keys.privateKey,
    }),
  ],
]);

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
     VALUES (?1, 'sso', 'platform', NULL, 1, ?2)`,
  )
    .bind(newId('featureFlag'), Date.now())
    .run();
  await env.CACHE.delete('flags:v1:-:-');
  ({ keys, jwk } = await keyPair());
  rogueKey = await keyPair();
});

beforeEach(() => {
  const spy = vi.mocked(globalThis.fetch);
  const inner = spy.getMockImplementation();
  spy.mockImplementation(async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const handler = hosts.get(new URL(href).origin);
    if (handler) return handler(new URL(href), init);
    return (inner as typeof fetch)(input, init);
  });
});

/** Turns on TOTP for the session's operator (the session's cookie rotates). Returns the secret. */
async function enrolTotp(session: Session): Promise<string> {
  const start = await call('POST', '/api/v1/security/totp', { cookie: session.cookie });
  expect(start.status, await start.clone().text()).toBe(200);
  const { secret } = (await json<{ data: { secret: string } }>(start)).data;
  const confirm = await call('POST', '/api/v1/security/totp/confirm', {
    cookie: session.cookie,
    body: { code: await hotp(base32Decode(secret), totpStep()) },
  });
  expect(confirm.status, await confirm.clone().text()).toBe(200);
  session.cookie = sessionCookie(confirm);
  return secret;
}

async function addSeat(workspaceId: string, operatorId: string, role: SeatRole) {
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)',
  )
    .bind(newId('seat'), workspaceId, operatorId, role, now)
    .run();
}

async function setPlan(workspaceId: string, plan: string) {
  await env.DB.prepare('UPDATE workspaces SET plan = ?1 WHERE id = ?2')
    .bind(plan, workspaceId)
    .run();
}

const corpDomain = () => `corp-${crypto.randomUUID().slice(0, 8)}.test`;

async function createConnection(
  owner: Session,
  jitRole: SeatRole | null = 'editor',
  issuer = ISSUER,
) {
  const res = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/sso-connections`, {
    cookie: owner.cookie,
    body: {
      protocol: 'oidc',
      issuer,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      jitRole,
    },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await json<{ data: SsoConnection }>(res)).data;
}

async function claimAndVerify(owner: Session, connectionId: string, domain: string) {
  const claim = await call('POST', `/api/v1/sso-connections/${connectionId}/domains`, {
    cookie: owner.cookie,
    body: { domain },
  });
  expect(claim.status).toBe(201);
  const claimed = (await json<{ data: SsoDomain }>(claim)).data;
  await env.CACHE.put(
    `dev:txt:${claimed.txtName}`,
    JSON.stringify(['v=spf1 -all', claimed.txtValue]),
  );
  return call('POST', `/api/v1/sso-connections/${connectionId}/domains/${claimed.id}/verify`, {
    cookie: owner.cookie,
  });
}

/** A Pro workspace with an OIDC connection capturing a fresh domain, and the activation answer. */
async function activateConnection(
  options: { jitRole?: SeatRole | null; enforced?: boolean; issuer?: string } = {},
) {
  const owner = await signIn();
  await setPlan(owner.workspaceId, 'pro');
  const connection = await createConnection(
    owner,
    options.jitRole === undefined ? 'editor' : options.jitRole,
    options.issuer,
  );
  const domain = corpDomain();
  expect((await claimAndVerify(owner, connection.id, domain)).status).toBe(200);
  const activate = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
    cookie: owner.cookie,
    body: { status: 'active', ...(options.enforced ? { enforced: true } : {}) },
  });
  return { owner, connection, domain, activate };
}

/** A Pro workspace with an active OIDC connection capturing a fresh domain. */
async function activeConnection(
  options: { jitRole?: SeatRole | null; enforced?: boolean; issuer?: string } = {},
) {
  const { owner, domain, activate } = await activateConnection(options);
  expect(activate.status, await activate.clone().text()).toBe(200);
  return { owner, connection: (await json<{ data: SsoConnection }>(activate)).data, domain };
}

/**
 * Runs the browser side of an SSO sign-in: start, "log in" at the fake IdP with the given claims
 * (nonce and audience filled in from the request), then the callback with the state cookie.
 * `options.state` and `options.nonce` tamper with the flow. `options.provider` is the IdP the test
 * logs in at; without it, whichever one the start sent the browser to.
 */
async function ssoSignIn(
  email: string,
  claims: Record<string, unknown> = {},
  options?: {
    state?: string;
    nonce?: string;
    provider?: { issuer: string; clientId: string };
    /** Start as the dashboard's form does: a POST with Origin and no Sec-Fetch-Site. */
    form?: boolean;
  },
) {
  const start = options?.form
    ? await call('POST', '/api/v1/auth/sso/start', {
        form: new URLSearchParams({ email, return: '/settings' }),
      })
    : // A link to the GET start: no Origin on a GET navigation, Sec-Fetch-Site same-origin.
      await call(
        'GET',
        `/api/v1/auth/sso/start?email=${encodeURIComponent(email)}&return=/settings`,
        { origin: null, headers: { 'sec-fetch-site': 'same-origin' } },
      );
  const location = await startedAt(start);
  const issuer = options?.provider?.issuer ?? location.origin;
  // Sent back to sign-in, or to another provider than the one the test logs in at.
  if (location.origin === 'http://localhost:5273' || location.origin !== issuer) {
    return { start, location, callback: null as Response | null };
  }
  expect(location.pathname).toBe('/authorize');
  expect(location.searchParams.get('code_challenge_method')).toBe('S256');
  expect(location.searchParams.get('redirect_uri')).toBe(
    'http://localhost:5273/api/v1/auth/sso/callback',
  );
  const stateCookie = /(__Host-swarm_sso=[^;]+)/.exec(start.headers.get('set-cookie') ?? '')?.[1];
  expect(stateCookie).toBeTruthy();

  const code = crypto.randomUUID();
  codes.set(code, {
    challenge: location.searchParams.get('code_challenge') as string,
    claims: {
      iss: issuer,
      aud: options?.provider?.clientId ?? CLIENT_ID,
      sub: `idp-${email}`,
      email,
      email_verified: true,
      nonce: options?.nonce ?? location.searchParams.get('nonce'),
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      ...claims,
    },
  });
  const state = options?.state ?? location.searchParams.get('state');
  const callback = await call('GET', `/api/v1/auth/sso/callback?code=${code}&state=${state}`, {
    cookie: stateCookie as string,
  });
  return { start, location, callback };
}

/**
 * Where a start sends the browser: its redirect, or for a form post that reached a provider, the
 * handoff page's link (a redirect there would break the dashboard's `form-action 'self'`).
 */
async function startedAt(start: Response): Promise<URL> {
  if (start.status === 302) return new URL(start.headers.get('location') as string);
  expect(start.status, await start.clone().text()).toBe(200);
  expect(start.headers.get('content-type')).toContain('text/html');
  const href = /<a href="([^"]+)"/.exec(await start.clone().text())?.[1] ?? '';
  return new URL(href.replaceAll('&amp;', '&'));
}

const errorOf = (res: Response | null) =>
  new URL(res?.headers.get('location') as string).searchParams.get('error');

async function me(cookie: string) {
  const res = await call('GET', '/api/v1/auth/session', { cookie });
  expect(res.status).toBe(200);
  return (await json<{ data: Me & { secondFactor: SecondFactorStatus } }>(res)).data;
}

describe('SSO connections', () => {
  it('needs a Pro plan or higher', async () => {
    const owner = await signIn();
    const res = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/sso-connections`, {
      cookie: owner.cookie,
      body: { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'plan_required' } });
    const list = await call('GET', `/api/v1/workspaces/${owner.workspaceId}/sso-connections`, {
      cookie: owner.cookie,
    });
    expect((await json<{ data: unknown[] }>(list)).data).toEqual([]);
  });

  it('refuses SAML with a clear message', async () => {
    const owner = await signIn();
    await setPlan(owner.workspaceId, 'pro');
    const res = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/sso-connections`, {
      cookie: owner.cookie,
      body: { protocol: 'saml', issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    });
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({
      error: { code: 'not_implemented', message: expect.stringContaining('OpenID Connect') },
    });
  });

  it('never returns or stores the client secret in clear', async () => {
    const owner = await signIn();
    await setPlan(owner.workspaceId, 'pro');
    const connection = await createConnection(owner);
    expect(connection).toMatchObject({ status: 'draft', clientSecretSet: true, protocol: 'oidc' });
    expect(JSON.stringify(connection)).not.toContain(CLIENT_SECRET);
    const row = await env.DB.prepare('SELECT config_json FROM sso_connections WHERE id = ?1')
      .bind(connection.id)
      .first<{ config_json: string }>();
    expect(row?.config_json).not.toContain(CLIENT_SECRET);
  });

  it('verifies a domain by its TXT record and lets one connection capture it', async () => {
    const owner = await signIn();
    await setPlan(owner.workspaceId, 'pro');
    const connection = await createConnection(owner);
    const domain = corpDomain();

    const claim = await call('POST', `/api/v1/sso-connections/${connection.id}/domains`, {
      cookie: owner.cookie,
      body: { domain: domain.toUpperCase() },
    });
    const claimed = (await json<{ data: SsoDomain }>(claim)).data;
    expect(claimed).toMatchObject({ domain, verified: false, txtName: `_swarm-sso.${domain}` });
    expect(claimed.txtValue).toMatch(/^swarm-sso=/);

    // Not published yet.
    const early = await call(
      'POST',
      `/api/v1/sso-connections/${connection.id}/domains/${claimed.id}/verify`,
      { cookie: owner.cookie },
    );
    expect((await json<{ data: SsoDomain }>(early)).data.verified).toBe(false);
    // Can't activate without a verified domain.
    const draft = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: owner.cookie,
      body: { status: 'active' },
    });
    expect(draft.status).toBe(409);

    await env.CACHE.put(`dev:txt:${claimed.txtName}`, JSON.stringify([claimed.txtValue]));
    const verified = await call(
      'POST',
      `/api/v1/sso-connections/${connection.id}/domains/${claimed.id}/verify`,
      { cookie: owner.cookie },
    );
    expect((await json<{ data: SsoDomain }>(verified)).data.verified).toBe(true);
    const mirror = await env.DB.prepare('SELECT domains_json FROM sso_connections WHERE id = ?1')
      .bind(connection.id)
      .first<{ domains_json: string }>();
    expect(JSON.parse(mirror?.domains_json ?? '[]')).toEqual([domain]);

    // Another workspace can claim it (claims block nobody) but can't verify it.
    const rival = await signIn();
    await setPlan(rival.workspaceId, 'scale');
    const rivalConnection = await createConnection(rival);
    const res = await claimAndVerify(rival, rivalConnection.id, domain);
    expect(res.status).toBe(409);
  });

  it('only owners can give admin seats just in time', async () => {
    const owner = await signIn();
    await setPlan(owner.workspaceId, 'pro');
    const admin = await seatAs(owner.workspaceId, 'admin');
    const res = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/sso-connections`, {
      cookie: admin.cookie,
      body: { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, jitRole: 'admin' },
    });
    expect(res.status).toBe(403);
    expect((await createConnection(owner, 'admin')).jitRole).toBe('admin');
  });
});

describe('SSO sign-in', () => {
  it('signs a new teammate in with a seat given just in time', async () => {
    const { owner, domain } = await activeConnection();
    const email = `ana@${domain}`;
    const { callback } = await ssoSignIn(email);
    expect(callback?.status).toBe(302);
    expect(callback?.headers.get('location')).toBe('http://localhost:5273/settings');
    const cookie = sessionCookie(callback as Response);
    const session = await me(cookie);
    expect(session.operator.email).toBe(email);
    // Only the SSO workspace: no personal workspace is created for a provisioned teammate.
    expect(session.workspaces).toMatchObject([{ id: owner.workspaceId, role: 'editor' }]);
    expect(session.secondFactor).toMatchObject({ state: 'ok', required: false });

    const audit = await call('GET', `/api/v1/workspaces/${owner.workspaceId}/audit`, {
      cookie: owner.cookie,
    });
    const actions = (await json<{ data: { items: { action: string }[] } }>(audit)).data.items.map(
      (item) => item.action,
    );
    expect(actions).toContain('seat.provisioned');

    // The identity is linked: a second sign-in uses the subject and gives no second seat.
    const again = await ssoSignIn(email);
    expect(again.callback?.status).toBe(302);
    expect((await me(sessionCookie(again.callback as Response))).workspaces).toHaveLength(1);
  });

  it('links an existing operator who holds a seat in the connection’s workspace', async () => {
    const { owner, domain } = await activeConnection();
    const email = `bo@${domain}`;
    const existing = await seatAs(owner.workspaceId, 'editor', email);
    const { callback } = await ssoSignIn(email);
    const session = await me(sessionCookie(callback as Response));
    expect(session.operator.id).toBe(existing.me.operator.id);
    expect(session.workspaces.map((w) => w.id)).toEqual(
      expect.arrayContaining([existing.workspaceId, owner.workspaceId]),
    );
  });

  it('after "This wasn\'t me", the next sign-in must be an email link, not the provider', async () => {
    const { owner, domain } = await activeConnection();
    const email = `undo@${domain}`;
    const existing = await seatAs(owner.workspaceId, 'editor', email);
    await env.DB.prepare('UPDATE operators SET email_signin_required_at = 1 WHERE id = ?1')
      .bind(existing.me.operator.id)
      .run();
    const { callback } = await ssoSignIn(email);
    expect(errorOf(callback)).toBe('email_signin_required');
    expect(callback?.headers.get('set-cookie') ?? '').not.toContain('__Host-swarm_session=');
  });

  it('refuses an operator seated only in other workspaces, and tells them and the workspace', async () => {
    const { owner, connection, domain } = await activeConnection();
    const email = `elsewhere@${domain}`;
    // Seated in their own workspace (and holding TOTP), with no seat in the connection's.
    const existing = await signIn(email);
    await enrolTotp(existing);
    const { callback } = await ssoSignIn(email, { amr: ['pwd', 'mfa'] });
    expect(errorOf(callback)).toBe('sso_no_seat');
    expect(callback?.headers.get('set-cookie') ?? '').not.toContain('__Host-swarm_session=');
    const links = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM oauth_identities WHERE provider = 'sso' AND operator_id = ?1",
    )
      .bind(existing.me.operator.id)
      .first<{ n: number }>();
    expect(links?.n).toBe(0);
    const seat = await env.DB.prepare(
      'SELECT 1 FROM seats WHERE workspace_id = ?1 AND operator_id = ?2',
    )
      .bind(owner.workspaceId, existing.me.operator.id)
      .first();
    expect(seat).toBeNull();
    const sessions = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE operator_id = ?1 AND auth_method = 'sso'",
    )
      .bind(existing.me.operator.id)
      .first<{ n: number }>();
    expect(sessions?.n).toBe(0);

    const refused = await env.DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE workspace_id = ?1 AND action = 'sso.sign_in_refused' AND target_id = ?2",
    )
      .bind(owner.workspaceId, connection.id)
      .first<{ metadata_json: string }>();
    expect(JSON.parse(refused?.metadata_json ?? '{}')).toMatchObject({
      email,
      reason: 'not_a_member',
    });
    const [mail] = await new DevMailbox(env.DEV_MAILBOX).list({ to: email, limit: 1 });
    expect(mail?.category).toBe('sso_sign_in_refused');
  });

  it('a provider session reaches only its own workspace until the operator proves their own factor', async () => {
    const { owner, domain } = await activeConnection();
    const email = `multi@${domain}`;
    // Seated in their own workspace B (with TOTP) and as an editor in the connection's A.
    const existing = await signIn(email);
    const secret = await enrolTotp(existing);
    await addSeat(owner.workspaceId, existing.me.operator.id, 'editor');
    const { callback } = await ssoSignIn(email, { amr: ['pwd', 'mfa'] });
    let cookie = sessionCookie(callback as Response);
    const ownWorkspace = `/api/v1/workspaces/${existing.workspaceId}/seats`;
    const ssoWorkspace = `/api/v1/workspaces/${owner.workspaceId}/seats`;
    expect((await call('GET', ssoWorkspace, { cookie })).status).toBe(200);
    const blocked = await call('GET', ownWorkspace, { cookie });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({
      error: { details: expect.arrayContaining([{ path: 'sso', message: 'sso_other_workspace' }]) },
    });
    expect(
      JSON.stringify(await (await call('GET', ownWorkspace, { cookie })).json()),
    ).not.toContain(existing.me.operator.id);
    // A Channel read in B goes through the same rule (the route policy and requireChannel).
    const channels = await call('GET', `/api/v1/workspaces/${existing.workspaceId}/channels`, {
      cookie,
    });
    expect(channels.status).toBe(403);

    // Proving the operator's own factor lifts the limit.
    const verified = await call('POST', '/api/v1/auth/second-factor/totp', {
      cookie,
      body: { code: await hotp(base32Decode(secret), totpStep() + 1) },
    });
    expect(verified.status, await verified.clone().text()).toBe(200);
    cookie = sessionCookie(verified);
    expect((await call('GET', ownWorkspace, { cookie })).status).toBe(200);
  });
  it('just-in-time seats still work on an invite-only Swarm', async () => {
    const { owner, domain } = await activeConnection();
    await env.DB.prepare(
      "INSERT INTO instance_settings (key, value, updated_at) VALUES ('signup', 'invite_only', ?1)",
    )
      .bind(Date.now())
      .run();
    try {
      const { callback } = await ssoSignIn(`jit@${domain}`);
      expect(callback?.headers.get('location')).toBe('http://localhost:5273/settings');
      const session = await me(sessionCookie(callback as Response));
      expect(session.workspaces).toMatchObject([{ id: owner.workspaceId, role: 'editor' }]);
    } finally {
      await env.DB.prepare('DELETE FROM instance_settings').run();
    }
  });

  it('without just-in-time seats, a new address is not signed in', async () => {
    const { domain } = await activeConnection({ jitRole: null });
    const { callback } = await ssoSignIn(`new@${domain}`);
    expect(errorOf(callback)).toBe('sso_no_seat');
  });

  it('refuses unverified emails, other domains, a bad nonce, state or signature', async () => {
    const { domain } = await activeConnection();
    expect(errorOf((await ssoSignIn(`c@${domain}`, { email_verified: false })).callback)).toBe(
      'sso_unverified',
    );
    expect(
      errorOf((await ssoSignIn(`c@${domain}`, { email: 'victim@elsewhere.example' })).callback),
    ).toBe('sso_domain');
    expect(errorOf((await ssoSignIn(`c@${domain}`, {}, { nonce: 'other' })).callback)).toBe(
      'sso_token',
    );
    expect(errorOf((await ssoSignIn(`c@${domain}`, {}, { state: 'forged' })).callback)).toBe(
      'sso_state',
    );
    expect(errorOf((await ssoSignIn(`c@${domain}`, { aud: 'someone-else' })).callback)).toBe(
      'sso_token',
    );
    expect(errorOf((await ssoSignIn(`c@${domain}`, { exp: 1 })).callback)).toBe('sso_token');
  });

  it('starts only from the dashboard, never from another site', async () => {
    const { domain } = await activeConnection();
    const path = `/api/v1/auth/sso/start?email=${encodeURIComponent(`a@${domain}`)}`;
    const crossSite: Record<string, string>[] = [
      {},
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'none' },
      { origin: 'https://evil.example' },
      { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' },
    ];
    for (const headers of crossSite) {
      const res = await call('GET', path, { origin: null, headers });
      expect.soft(res.status, JSON.stringify(headers)).toBe(302);
      expect.soft(errorOf(res), JSON.stringify(headers)).toBe('sso_start');
      expect
        .soft(res.headers.get('set-cookie') ?? '', JSON.stringify(headers))
        .not.toContain('__Host-swarm_sso=');
    }
    // The dashboard's own navigation (no Origin on a GET), or a request naming the dashboard.
    for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { origin: ORIGIN }]) {
      const res = await call('GET', path, { origin: null, headers });
      expect(new URL(res.headers.get('location') as string).origin).toBe(ISSUER);
      expect(res.headers.get('set-cookie')).toContain('__Host-swarm_sso=');
    }
  });

  it("starts from the dashboard's form post, which older browsers send without Sec-Fetch-Site", async () => {
    const { owner, domain } = await activeConnection();
    const email = `form@${domain}`;
    const { start, location, callback } = await ssoSignIn(email, {}, { form: true });
    expect(location.origin).toBe(ISSUER);
    expect(location.searchParams.get('login_hint')).toBe(email);
    expect(start.headers.get('cache-control')).toBe('no-store');
    expect(start.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(callback?.headers.get('location')).toBe('http://localhost:5273/settings');
    const session = await me(sessionCookie(callback as Response));
    expect(session.workspaces).toMatchObject([{ id: owner.workspaceId, role: 'editor' }]);
  });

  it('a form post from another site, or with no Origin, starts nothing', async () => {
    const { domain } = await activeConnection();
    const crossSite: { origin: string | null; headers?: Record<string, string> }[] = [
      { origin: null },
      // Browsers send Origin on every form post, so a post without one is not the dashboard.
      { origin: null, headers: { 'sec-fetch-site': 'same-origin' } },
      { origin: 'null' },
      { origin: 'https://evil.example' },
      { origin: 'https://evil.example', headers: { 'sec-fetch-site': 'same-origin' } },
    ];
    for (const options of crossSite) {
      const res = await call('POST', '/api/v1/auth/sso/start', {
        ...options,
        form: new URLSearchParams({ email: `b@${domain}` }),
      });
      expect.soft(res.status, JSON.stringify(options)).toBe(302);
      expect.soft(errorOf(res), JSON.stringify(options)).toBe('sso_start');
      expect
        .soft(res.headers.get('set-cookie') ?? '', JSON.stringify(options))
        .not.toContain('__Host-swarm_sso=');
    }
  });

  it('a callback without the browser-bound state cookie is refused', async () => {
    const res = await call('GET', '/api/v1/auth/sso/callback?code=x&state=y');
    expect(errorOf(res)).toBe('sso_cancelled');
  });

  it('an address no connection captures goes back to sign-in', async () => {
    const { location, start } = await ssoSignIn(uniqueEmail('nobody'));
    expect(location.origin).toBe('http://localhost:5273');
    expect(errorOf(start)).toBe('sso_unknown');
  });

  it('stops working when the workspace drops below Pro', async () => {
    const { owner, domain } = await activeConnection();
    await setPlan(owner.workspaceId, 'free');
    const { start } = await ssoSignIn(`d@${domain}`);
    expect(errorOf(start)).toBe('sso_unknown');
  });

  it('counts as the second factor only when the IdP asserts MFA', async () => {
    const { domain } = await activeConnection();
    const email = `e@${domain}`;
    const first = await ssoSignIn(email);
    let cookie = sessionCookie(first.callback as Response);
    // Turn on TOTP for this teammate, so a first factor alone is pending.
    const start = await call('POST', '/api/v1/security/totp', { cookie });
    const { secret } = (await json<{ data: { secret: string } }>(start)).data;
    const confirm = await call('POST', '/api/v1/security/totp/confirm', {
      cookie,
      body: { code: await hotp(base32Decode(secret), totpStep()) },
    });
    expect(confirm.status).toBe(200);
    cookie = sessionCookie(confirm);

    const plain = await ssoSignIn(email, { amr: ['pwd'] });
    expect((await me(sessionCookie(plain.callback as Response))).secondFactor.state).toBe('verify');
    const strong = await ssoSignIn(email, { amr: ['pwd', 'mfa'] });
    expect((await me(sessionCookie(strong.callback as Response))).secondFactor).toMatchObject({
      state: 'ok',
      verifiedWith: 'sso',
    });
  });

  it('an enforced connection keeps QuickPass sessions out of its workspace, not owners', async () => {
    const { owner, domain } = await activeConnection({ enforced: true });
    const email = `f@${domain}`;
    const viaSso = await ssoSignIn(email);
    const ssoCookie = sessionCookie(viaSso.callback as Response);
    const seats = `/api/v1/workspaces/${owner.workspaceId}/seats`;
    expect((await call('GET', seats, { cookie: ssoCookie })).status).toBe(200);

    const token = await requestToken(email);
    const consume = await call('POST', '/api/v1/auth/quickpass/consume', {
      body: { token, confirmEmail: email },
    });
    const quickCookie = sessionCookie(consume);
    const blocked = await call('GET', seats, { cookie: quickCookie });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({
      error: { code: 'forbidden', details: [{ path: 'sso', message: 'sso_required' }] },
    });

    // An owner whose address is captured can still get in (break-glass).
    await env.DB.prepare("UPDATE seats SET role = 'owner' WHERE operator_id = ?1")
      .bind((await me(quickCookie)).operator.id)
      .run();
    expect((await call('GET', seats, { cookie: quickCookie })).status).toBe(200);
  });
});

describe('SSO: changing the identity provider', () => {
  const repoint = {
    issuer: ROGUE.issuer,
    clientId: ROGUE.clientId,
    clientSecret: ROGUE.clientSecret,
  };

  async function connectionOf(owner: Session, id: string) {
    const res = await call('GET', `/api/v1/workspaces/${owner.workspaceId}/sso-connections`, {
      cookie: owner.cookie,
    });
    return (await json<{ data: SsoConnection[] }>(res)).data.find((c) => c.id === id);
  }

  it("an admin can't repoint a connection with verified domains to sign in as the owner", async () => {
    const domain = corpDomain();
    const owner = await signIn(`boss@${domain}`);
    await setPlan(owner.workspaceId, 'pro');
    const connection = await createConnection(owner, null);
    expect((await claimAndVerify(owner, connection.id, domain)).status).toBe(200);
    const activate = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: owner.cookie,
      body: { status: 'active' },
    });
    expect(activate.status).toBe(200);
    // The owner has their own second factor, which the rogue IdP's amr must not stand in for.
    const totp = await call('POST', '/api/v1/security/totp', { cookie: owner.cookie });
    const { secret } = (await json<{ data: { secret: string } }>(totp)).data;
    const confirm = await call('POST', '/api/v1/security/totp/confirm', {
      cookie: owner.cookie,
      body: { code: await hotp(base32Decode(secret), totpStep()) },
    });
    expect(confirm.status).toBe(200);
    owner.cookie = sessionCookie(confirm);
    const admin = await seatAs(owner.workspaceId, 'admin');

    const res = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: admin.cookie,
      body: repoint,
    });
    expect.soft(res.status).toBe(403);
    const clientOnly = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: admin.cookie,
      body: { clientId: ROGUE.clientId },
    });
    expect.soft(clientOnly.status).toBe(403);

    // The owner's address still goes to the owner's provider: the rogue one is never asked.
    const rogue = await ssoSignIn(
      owner.email,
      { sub: 'rogue-sub', amr: ['pwd', 'mfa'] },
      { provider: ROGUE },
    );
    expect(rogue.location.origin).toBe(ISSUER);
    expect(rogue.callback).toBeNull();
    expect(await connectionOf(owner, connection.id)).toMatchObject({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      status: 'active',
      domains: [{ domain, verified: true }],
    });

    // Admins can still rotate the client secret of the same provider.
    const secretOnly = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: admin.cookie,
      body: { clientSecret: CLIENT_SECRET },
    });
    expect(secretOnly.status).toBe(200);
  });

  /** A Pro workspace whose owner (with TOTP) has signed in once through the connection at ISSUER. */
  async function ownerLinkedBySso() {
    const domain = corpDomain();
    const owner = await signIn(`boss@${domain}`);
    await setPlan(owner.workspaceId, 'pro');
    const connection = await createConnection(owner, null);
    expect((await claimAndVerify(owner, connection.id, domain)).status).toBe(200);
    const activate = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: owner.cookie,
      body: { status: 'active' },
    });
    expect(activate.status).toBe(200);
    const totp = await call('POST', '/api/v1/security/totp', { cookie: owner.cookie });
    const { secret } = (await json<{ data: { secret: string } }>(totp)).data;
    const confirm = await call('POST', '/api/v1/security/totp/confirm', {
      cookie: owner.cookie,
      body: { code: await hotp(base32Decode(secret), totpStep()) },
    });
    expect(confirm.status).toBe(200);
    owner.cookie = sessionCookie(confirm);
    // The (connection, sub) link: sub is `idp-<owner email>` at ISSUER.
    const first = await ssoSignIn(owner.email);
    expect((await me(sessionCookie(first.callback as Response))).operator.id).toBe(
      owner.me.operator.id,
    );
    const domainId = (await connectionOf(owner, connection.id))!.domains[0]!.id;
    return { owner, connection, domain, domainId };
  }

  /** Who a callback signed in, or null when it signed nobody in. */
  async function signedInAs(callback: Response | null) {
    if (!callback?.headers.get('set-cookie')?.includes('__Host-swarm_session=')) return null;
    return me(sessionCookie(callback));
  }

  it("an admin can't release the domains, repoint, and replay the owner's subject", async () => {
    const { owner, connection, domainId } = await ownerLinkedBySso();
    const admin = await seatAs(owner.workspaceId, 'admin');

    const release = await call(
      'DELETE',
      `/api/v1/sso-connections/${connection.id}/domains/${domainId}`,
      { cookie: admin.cookie },
    );
    expect(release.status).toBe(204);
    // No verified domain is left, but people signed in through this provider.
    const res = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: admin.cookie,
      body: repoint,
    });
    expect.soft(res.status).toBe(403);
    const other = corpDomain();
    expect((await claimAndVerify(admin, connection.id, other)).status).toBe(200);
    await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: admin.cookie,
      body: { status: 'active' },
    });

    const rogue = await ssoSignIn(
      `mallory@${other}`,
      { sub: `idp-${owner.email}`, amr: ['pwd', 'mfa'] },
      { provider: ROGUE },
    );
    const session = await signedInAs(rogue.callback);
    expect(session?.operator.id).not.toBe(owner.me.operator.id);
  });

  it("repointing a connection forgets the old provider's subjects", async () => {
    const { owner, connection, domain } = await ownerLinkedBySso();
    const res = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: owner.cookie,
      body: repoint,
    });
    expect(res.status).toBe(200);
    const links = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM oauth_identities WHERE provider = 'sso' AND sso_connection_id = ?1",
    )
      .bind(connection.id)
      .first<{ n: number }>();
    expect.soft(links?.n).toBe(0);

    const after = (await json<{ data: SsoConnection }>(res)).data.domains[0]!;
    await env.CACHE.put(`dev:txt:${after.txtName}`, JSON.stringify([after.txtValue]));
    const verify = `/api/v1/sso-connections/${connection.id}/domains/${after.id}/verify`;
    expect((await call('POST', verify, { cookie: owner.cookie })).status).toBe(200);
    const active = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: owner.cookie,
      body: { status: 'active' },
    });
    expect(active.status).toBe(200);

    // The new provider's user with the same sub is someone else: no seat, so nobody signs in.
    const { callback } = await ssoSignIn(
      `x@${domain}`,
      { sub: `idp-${owner.email}`, amr: ['mfa'] },
      { provider: ROGUE },
    );
    expect((await signedInAs(callback))?.operator.id).not.toBe(owner.me.operator.id);
    expect(errorOf(callback)).toBe('sso_no_seat');
  });

  it("a subject linked on a released domain doesn't sign in from another domain", async () => {
    const { owner, connection, domainId } = await ownerLinkedBySso();
    const release = await call(
      'DELETE',
      `/api/v1/sso-connections/${connection.id}/domains/${domainId}`,
      { cookie: owner.cookie },
    );
    expect(release.status).toBe(204);
    const other = corpDomain();
    expect((await claimAndVerify(owner, connection.id, other)).status).toBe(200);

    const { callback } = await ssoSignIn(`y@${other}`, { sub: `idp-${owner.email}` });
    expect((await signedInAs(callback))?.operator.id).not.toBe(owner.me.operator.id);
    expect(errorOf(callback)).toBe('sso_no_seat');
  });

  it('an owner can repoint a connection, and its domains must be proven again', async () => {
    const { owner, connection, domain } = await activeConnection();
    const before = connection.domains[0]!;

    const res = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: owner.cookie,
      body: repoint,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const changed = (await json<{ data: SsoConnection }>(res)).data;
    expect(changed).toMatchObject({
      issuer: ROGUE.issuer,
      clientId: ROGUE.clientId,
      status: 'draft',
      domains: [{ domain, verified: false, verifiedAt: null }],
    });
    const after = changed.domains[0]!;
    expect(after.txtValue).not.toBe(before.txtValue);
    const mirror = await env.DB.prepare('SELECT domains_json FROM sso_connections WHERE id = ?1')
      .bind(connection.id)
      .first<{ domains_json: string }>();
    expect(JSON.parse(mirror?.domains_json ?? '')).toEqual([]);

    // Nothing is captured until the domain is proven for the new provider.
    expect(errorOf((await ssoSignIn(`g@${domain}`, {}, { provider: ROGUE })).start)).toBe(
      'sso_unknown',
    );
    const reactivate = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: owner.cookie,
      body: { status: 'active' },
    });
    expect(reactivate.status).toBe(409);

    // The TXT record published for the old provider no longer proves anything.
    const verifyPath = `/api/v1/sso-connections/${connection.id}/domains/${after.id}/verify`;
    const stale = await call('POST', verifyPath, { cookie: owner.cookie });
    expect((await json<{ data: SsoDomain }>(stale)).data.verified).toBe(false);

    await env.CACHE.put(`dev:txt:${after.txtName}`, JSON.stringify([after.txtValue]));
    const fresh = await call('POST', verifyPath, { cookie: owner.cookie });
    expect((await json<{ data: SsoDomain }>(fresh)).data.verified).toBe(true);
    const active = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: owner.cookie,
      body: { status: 'active' },
    });
    expect(active.status).toBe(200);

    const { callback } = await ssoSignIn(`g@${domain}`, {}, { provider: ROGUE });
    expect(callback?.headers.get('location')).toBe('http://localhost:5273/settings');
    const session = await me(sessionCookie(callback as Response));
    expect(session.workspaces).toMatchObject([{ id: owner.workspaceId, role: 'editor' }]);
  });
});

describe('SSO calls to the identity provider', () => {
  const reached: string[] = [];
  const added: string[] = [];
  /** Answers `origin` with `handler` for this test only. */
  const serve = (origin: string, handler: Handler) => {
    hosts.set(origin, handler);
    added.push(origin);
  };
  const freshIssuer = () => `https://idp-${crypto.randomUUID().slice(0, 8)}.test`;
  /** Stands in for a service on the private network: it answers, and records that it was called. */
  const internal = (handler: Handler): Handler => {
    return async (url, init) => {
      reached.push(url.href);
      return handler(url, init);
    };
  };

  beforeEach(() => {
    reached.length = 0;
  });
  afterEach(() => {
    for (const origin of added.splice(0)) hosts.delete(origin);
  });

  it('refuses an issuer on a private host or an IP address', async () => {
    const owner = await signIn();
    await setPlan(owner.workspaceId, 'pro');
    for (const issuer of ['https://idp.internal', 'https://10.0.0.5', 'https://localhost:8443']) {
      const res = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/sso-connections`, {
        cookie: owner.cookie,
        body: { issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      });
      expect(res.status, issuer).toBe(400);
    }
  });

  for (const field of ['jwks_uri', 'token_endpoint'] as const) {
    it(`refuses a discovery document whose ${field} is on a private host`, async () => {
      const issuer = freshIssuer();
      const path = field === 'jwks_uri' ? '/jwks' : '/token';
      serve(issuer, fakeIdp(issuer, { discovery: { [field]: `https://idp.internal${path}` } }));
      serve('https://idp.internal', internal(fakeIdp(issuer)));
      const { activate, domain } = await activateConnection({ issuer });
      expect(activate.status).toBe(400);
      // Nor does a sign-in reach it.
      await ssoSignIn(`a@${domain}`);
      expect(reached).toEqual([]);
    });
  }

  it('does not fetch a private host from a discovery document cached before the check', async () => {
    const issuer = freshIssuer();
    serve(issuer, fakeIdp(issuer));
    serve('https://idp.internal', internal(fakeIdp(issuer)));
    const { domain } = await activeConnection({ issuer });
    const key = `oidc:discovery:${await sha256Hex(issuer)}`;
    const cached = await env.CACHE.get<Record<string, string>>(key, 'json');
    await env.CACHE.put(key, JSON.stringify({ ...cached, jwks_uri: 'https://idp.internal/jwks' }));
    expect(errorOf((await ssoSignIn(`b@${domain}`)).callback)).toBe('sso_token');
    await env.CACHE.put(
      key,
      JSON.stringify({ ...cached, token_endpoint: 'https://idp.internal/token' }),
    );
    // The code is exchanged by the vault, at the token endpoint it discovers itself from the
    // issuer (through its own URL guard): the api's cached document can't point it elsewhere.
    expect(errorOf((await ssoSignIn(`b@${domain}`)).callback)).toBeNull();
    expect(reached).toEqual([]);
  });

  it("trusts only the new issuer's keys after the issuer changes", async () => {
    const { owner, connection, domain } = await activeConnection();
    const email = `rotate@${domain}`;
    // The first sign-in caches the old issuer's keys for this connection.
    expect(errorOf((await ssoSignIn(email)).callback)).toBeNull();

    // Same kid, other key material: nothing about the kid says the keys changed.
    const next = await keyPair();
    const issuer = freshIssuer();
    let signer = next.keys.privateKey;
    serve(issuer, fakeIdp(issuer, { keys: () => [next.jwk], signer: () => signer }));
    const moved = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: owner.cookie,
      body: { issuer },
    });
    expect(moved.status).toBe(200);
    // A new provider needs its domain proven again before the connection is active.
    const reclaimed = (await json<{ data: SsoConnection }>(moved)).data.domains[0]!;
    await env.CACHE.put(`dev:txt:${reclaimed.txtName}`, JSON.stringify([reclaimed.txtValue]));
    const verify = `/api/v1/sso-connections/${connection.id}/domains/${reclaimed.id}/verify`;
    const proven = await call('POST', verify, { cookie: owner.cookie });
    expect((await json<{ data: SsoDomain }>(proven)).data.verified).toBe(true);
    const reactivated = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: owner.cookie,
      body: { status: 'active' },
    });
    expect(reactivated.status).toBe(200);

    // The new issuer's own key works at once.
    expect(errorOf((await ssoSignIn(email)).callback)).toBeNull();
    // A token for the new issuer signed with the old issuer's key does not.
    signer = keys.privateKey;
    expect(errorOf((await ssoSignIn(email)).callback)).toBe('sso_token');
  });

  const hops = [
    { path: '/.well-known/openid-configuration', error: null },
    { path: '/jwks', error: 'sso_token' },
    { path: '/token', error: 'sso_exchange' },
  ];
  for (const hop of hops) {
    it(`does not follow a redirect from ${hop.path}`, async () => {
      const issuer = freshIssuer();
      const idp = fakeIdp(issuer);
      serve(issuer, async (url, init) => {
        if (url.pathname !== hop.path) return idp(url, init);
        if (init?.redirect === 'manual') {
          return new Response(null, {
            status: 302,
            headers: { location: `https://idp.internal${hop.path}` },
          });
        }
        // What fetch would do when it follows the redirect.
        return internal(idp)(new URL(`https://idp.internal${hop.path}`), init);
      });
      const { activate, domain } = await activateConnection({ issuer });
      if (hop.error === null) {
        expect(activate.status).toBe(400);
      } else {
        expect(activate.status).toBe(200);
        expect(errorOf((await ssoSignIn(`c@${domain}`)).callback)).toBe(hop.error);
      }
      expect(reached).toEqual([]);
    });
  }
});

describe('SSO routes: roles and tenancy', () => {
  const ROLES: SeatRole[] = ['viewer', 'author', 'editor', 'admin', 'owner'];
  let owner: Session;
  let connectionId: string;
  const seats = {} as Record<SeatRole, Session>;
  let outsider: Session;

  beforeAll(async () => {
    owner = await signIn();
    await setPlan(owner.workspaceId, 'pro');
    seats.owner = owner;
    for (const role of ['viewer', 'author', 'editor', 'admin'] as const) {
      seats[role] = await seatAs(owner.workspaceId, role);
    }
    outsider = await signIn();
    const res = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/sso-connections`, {
      cookie: owner.cookie,
      body: { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    });
    connectionId = (await json<{ data: SsoConnection }>(res)).data.id;
  });

  const ROUTES: { name: string; request: (s: Session) => Promise<Response> }[] = [
    {
      name: 'list connections',
      request: (s) =>
        call('GET', `/api/v1/workspaces/${owner.workspaceId}/sso-connections`, {
          cookie: s.cookie,
        }),
    },
    {
      name: 'add a connection',
      request: (s) =>
        call('POST', `/api/v1/workspaces/${owner.workspaceId}/sso-connections`, {
          cookie: s.cookie,
          body: { issuer: ISSUER, clientId: `c-${crypto.randomUUID()}`, clientSecret: 'x' },
        }),
    },
    {
      name: 'change a connection',
      request: (s) =>
        call('PATCH', `/api/v1/sso-connections/${connectionId}`, {
          cookie: s.cookie,
          body: { clientId: CLIENT_ID },
        }),
    },
    {
      name: 'claim a domain',
      request: (s) =>
        call('POST', `/api/v1/sso-connections/${connectionId}/domains`, {
          cookie: s.cookie,
          body: { domain: corpDomain() },
        }),
    },
  ];

  for (const route of ROUTES) {
    for (const role of ROLES) {
      const allowed = role === 'admin' || role === 'owner';
      it(`${route.name}: ${role} is ${allowed ? 'allowed' : 'refused'}`, async () => {
        const res = await route.request(seats[role]);
        if (allowed) expect(res.status, await res.clone().text()).toBeLessThan(300);
        else expect(res.status).toBe(403);
      });
    }
    it(`${route.name}: another workspace's operator gets 404`, async () => {
      expect((await route.request(outsider)).status).toBe(404);
    });
    it(`${route.name}: signed out gets 401`, async () => {
      expect((await route.request({ ...owner, cookie: '' })).status).toBe(401);
    });
  }

  it('removing a connection: admins may, others may not, outsiders see nothing', async () => {
    const res = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/sso-connections`, {
      cookie: owner.cookie,
      body: { issuer: ISSUER, clientId: 'to-remove', clientSecret: 'x' },
    });
    const { id } = (await json<{ data: SsoConnection }>(res)).data;
    expect(
      (await call('DELETE', `/api/v1/sso-connections/${id}`, { cookie: seats.editor.cookie }))
        .status,
    ).toBe(403);
    expect(
      (await call('DELETE', `/api/v1/sso-connections/${id}`, { cookie: outsider.cookie })).status,
    ).toBe(404);
    expect(
      (await call('DELETE', `/api/v1/sso-connections/${id}`, { cookie: seats.admin.cookie }))
        .status,
    ).toBe(204);
  });
});

describe('SSO: a provider’s MFA claim and the operator’s own factors', () => {
  it('needs a factor of the operator’s own for durable account changes, and mails the operator', async () => {
    const { owner, domain } = await activeConnection();
    const email = `own@${domain}`;
    const teammate = await seatAs(owner.workspaceId, 'editor', email);
    const secret = await enrolTotp(teammate);
    const { callback } = await ssoSignIn(email, { amr: ['pwd', 'mfa'] });
    let cookie = sessionCookie(callback as Response);
    expect((await me(cookie)).secondFactor).toMatchObject({ state: 'ok', verifiedWith: 'sso' });

    const stepUp = { details: [{ path: 'secondFactor', message: 'step_up_required' }] };
    const attempts = [
      () => call('POST', '/api/v1/security/passkeys/options', { cookie }),
      () => call('POST', '/api/v1/security/recovery-codes', { cookie }),
      () => call('DELETE', '/api/v1/security/totp', { cookie }),
      () =>
        call('POST', '/api/v1/auth/sessions/sign-out-everywhere', {
          cookie,
          body: { keepCurrent: true },
        }),
    ];
    for (const attempt of attempts) {
      const res = await attempt();
      expect.soft(res.status).toBe(403);
      expect.soft(await res.json()).toMatchObject({ error: stepUp });
    }
    // Nothing changed: the TOTP is on, and the teammate's QuickPass session still works.
    const totp = await env.DB.prepare(
      'SELECT confirmed_at FROM totp_secrets WHERE operator_id = ?1',
    )
      .bind(teammate.me.operator.id)
      .first<{ confirmed_at: number | null }>();
    expect(totp?.confirmed_at).not.toBeNull();
    expect((await call('GET', '/api/v1/security', { cookie: teammate.cookie })).status).toBe(200);

    // After the operator's own TOTP, the same change works and the operator is told.
    const verified = await call('POST', '/api/v1/auth/second-factor/totp', {
      cookie,
      body: { code: await hotp(base32Decode(secret), totpStep() + 1) },
    });
    expect(verified.status, await verified.clone().text()).toBe(200);
    cookie = sessionCookie(verified);
    expect((await call('POST', '/api/v1/security/recovery-codes', { cookie })).status).toBe(200);
    const [mail] = await new DevMailbox(env.DEV_MAILBOX).list({ to: email, limit: 1 });
    expect(mail).toMatchObject({ category: 'account_security_changed' });
    expect(mail?.subject).toContain('New recovery codes');
  });
});

describe('SSO: when trust in the provider is withdrawn', () => {
  async function signedInTeammate() {
    const active = await activeConnection();
    const { callback } = await ssoSignIn(`t-${crypto.randomUUID().slice(0, 6)}@${active.domain}`, {
      amr: ['pwd', 'mfa'],
    });
    const cookie = sessionCookie(callback as Response);
    const seats = `/api/v1/workspaces/${active.owner.workspaceId}/seats`;
    expect((await call('GET', seats, { cookie })).status).toBe(200);
    return { ...active, cookie, seats };
  }

  async function signedOut(cookie: string, seats: string) {
    expect((await call('GET', seats, { cookie })).status).toBe(401);
    expect((await call('POST', '/api/v1/security/passkeys/options', { cookie })).status).toBe(401);
  }

  it('deleting the connection ends its sessions', async () => {
    const { owner, connection, cookie, seats } = await signedInTeammate();
    const res = await call('DELETE', `/api/v1/sso-connections/${connection.id}`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(204);
    await signedOut(cookie, seats);
  });

  it('disabling the connection ends its sessions', async () => {
    const { owner, connection, cookie, seats } = await signedInTeammate();
    const res = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: owner.cookie,
      body: { status: 'disabled' },
    });
    expect(res.status).toBe(200);
    await signedOut(cookie, seats);
  });

  it('repointing the connection ends its sessions', async () => {
    const { owner, connection, cookie, seats } = await signedInTeammate();
    const res = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: owner.cookie,
      body: { issuer: ROGUE.issuer, clientId: ROGUE.clientId, clientSecret: ROGUE.clientSecret },
    });
    expect(res.status).toBe(200);
    await signedOut(cookie, seats);
  });

  it('turning the sso flag off signs its sessions out, and other sessions keep working', async () => {
    const { owner, cookie, seats } = await signedInTeammate();
    await env.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'sso'").run();
    await env.CACHE.delete('flags:v1:-:-');
    try {
      await signedOut(cookie, seats);
      expect((await call('GET', seats, { cookie: owner.cookie })).status).toBe(200);
    } finally {
      await env.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'sso'").run();
      await env.CACHE.delete('flags:v1:-:-');
    }
  });

  it('a provider session ends after SSO_SESSION_MAX_HOURS, however active', async () => {
    const { cookie, seats } = await signedInTeammate();
    const token = cookie.split('=')[1] as string;
    const hash = await sha256Hex(token);
    await env.DB.prepare('UPDATE sessions SET created_at = ?1 WHERE token_hash = ?2')
      .bind(Date.now() - (SSO_SESSION_MAX_HOURS * 60 + 1) * 60_000, hash)
      .run();
    await env.CACHE.delete(`sess:v2:${hash}`);
    await signedOut(cookie, seats);
  });
});

describe('SSO: replacing the provider of a proven domain', () => {
  it('an admin who deletes a connection can’t prove its domain for a new provider; owners can, and are told', async () => {
    const { owner, connection, domain } = await activeConnection();
    const admin = { ...(await seatAs(owner.workspaceId, 'admin')), workspaceId: owner.workspaceId };
    const removed = await call('DELETE', `/api/v1/sso-connections/${connection.id}`, {
      cookie: admin.cookie,
    });
    expect(removed.status).toBe(204);
    const [notice] = await new DevMailbox(env.DEV_MAILBOX).list({ to: owner.email, limit: 1 });
    expect(notice).toMatchObject({ category: 'sso_provider_changed' });
    expect(notice?.text).toContain(domain);

    const rogue = await createConnection(admin, null, ROGUE.issuer);
    const refused = await claimAndVerify(admin, rogue.id, domain);
    expect(refused.status).toBe(403);
    const row = await env.DB.prepare(
      'SELECT verified_at FROM sso_domains WHERE connection_id = ?1 AND domain = ?2',
    )
      .bind(rogue.id, domain)
      .first<{ verified_at: number | null }>();
    expect(row?.verified_at).toBeNull();

    // An owner may make the same change.
    const domains = await call('GET', `/api/v1/workspaces/${owner.workspaceId}/sso-connections`, {
      cookie: owner.cookie,
    });
    const claimed = (await json<{ data: SsoConnection[] }>(domains)).data
      .find((c) => c.id === rogue.id)!
      .domains.find((d) => d.domain === domain)!;
    const verified = await call(
      'POST',
      `/api/v1/sso-connections/${rogue.id}/domains/${claimed.id}/verify`,
      { cookie: owner.cookie },
    );
    expect((await json<{ data: SsoDomain }>(verified)).data.verified).toBe(true);

    // A domain the workspace never proved is still the admin's to set up.
    const fresh = await createConnection(admin, null, ROGUE.issuer);
    expect((await claimAndVerify(admin, fresh.id, corpDomain())).status).toBe(200);
  });

  it('an admin may set the same provider up again after deleting it', async () => {
    const { owner, connection, domain } = await activeConnection();
    const admin = { ...(await seatAs(owner.workspaceId, 'admin')), workspaceId: owner.workspaceId };
    await call('DELETE', `/api/v1/sso-connections/${connection.id}`, { cookie: admin.cookie });
    const again = await createConnection(admin, null);
    expect((await claimAndVerify(admin, again.id, domain)).status).toBe(200);
  });
});

describe('SSO: domain proof that lapses', () => {
  const DAY = 86_400_000;
  async function proofRow(domain: string) {
    return env.DB.prepare('SELECT * FROM sso_domains WHERE domain = ?1 AND verified_at IS NOT NULL')
      .bind(domain)
      .first<{ id: string; failing_since: number | null; checked_at: number | null }>();
  }

  it('re-checks an old proof at sign-in, warns admins, and stops capturing once it lapses', async () => {
    const { owner, domain } = await activeConnection();
    const email = `lapse@${domain}`;
    const txt = `dev:txt:_swarm-sso.${domain}`;
    // Proven and checked long ago; the record is gone now.
    await env.CACHE.delete(txt);
    await env.DB.prepare('UPDATE sso_domains SET checked_at = ?1 WHERE domain = ?2')
      .bind(Date.now() - 2 * DAY, domain)
      .run();
    // Inside the lapse period sign-in still works, and the owner hears about it.
    expect(errorOf((await ssoSignIn(email)).callback)).toBeNull();
    expect((await proofRow(domain))?.failing_since).not.toBeNull();
    const [warning] = await new DevMailbox(env.DEV_MAILBOX).list({ to: owner.email, limit: 1 });
    expect(warning).toMatchObject({ category: 'sso_domain_failing' });

    // Past the lapse period, the next check ends the proof.
    await env.DB.prepare(
      'UPDATE sso_domains SET checked_at = ?1, failing_since = ?2 WHERE domain = ?3',
    )
      .bind(Date.now() - 2 * DAY, Date.now() - (SSO_DOMAIN_LAPSE_DAYS + 1) * DAY, domain)
      .run();
    expect(errorOf((await ssoSignIn(email)).callback)).toBe('sso_domain');
    expect(await proofRow(domain)).toBeNull();
    // Nothing captures the domain any more, and another workspace can prove it.
    expect(errorOf((await ssoSignIn(email)).start)).toBe('sso_unknown');
    const rival = await signIn();
    await setPlan(rival.workspaceId, 'pro');
    const rivalConnection = await createConnection(rival, null, ROGUE.issuer);
    expect((await claimAndVerify(rival, rivalConnection.id, domain)).status).toBe(200);
  });

  it('a record that is still published keeps the proof through every re-check', async () => {
    const { domain } = await activeConnection();
    await env.DB.prepare('UPDATE sso_domains SET checked_at = ?1 WHERE domain = ?2')
      .bind(Date.now() - 2 * DAY, domain)
      .run();
    expect(errorOf((await ssoSignIn(`kept@${domain}`)).callback)).toBeNull();
    const row = await proofRow(domain);
    expect(row?.failing_since).toBeNull();
    expect(row?.checked_at).toBeGreaterThan(Date.now() - 60_000);
  });

  it('a new owner of the domain can take it over once the old record stays gone', async () => {
    const { domain } = await activeConnection();
    await env.CACHE.delete(`dev:txt:_swarm-sso.${domain}`);
    const rival = await signIn();
    await setPlan(rival.workspaceId, 'pro');
    const rivalConnection = await createConnection(rival, null, ROGUE.issuer);
    // The first attempt starts the clock on the old proof instead of taking it at once.
    const early = await claimAndVerify(rival, rivalConnection.id, domain);
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({
      error: { message: expect.stringContaining('missing') },
    });
    expect((await proofRow(domain))?.failing_since).not.toBeNull();
    // Once the old record has been missing for the lapse period, the rival's proof wins.
    await env.DB.prepare(
      'UPDATE sso_domains SET failing_since = ?1 WHERE domain = ?2 AND verified_at IS NOT NULL',
    )
      .bind(Date.now() - (SSO_DOMAIN_LAPSE_DAYS + 1) * DAY, domain)
      .run();
    const claimed = (
      await json<{ data: SsoConnection[] }>(
        await call('GET', `/api/v1/workspaces/${rival.workspaceId}/sso-connections`, {
          cookie: rival.cookie,
        }),
      )
    ).data
      .find((c) => c.id === rivalConnection.id)!
      .domains.find((d) => d.domain === domain)!;
    const later = await call(
      'POST',
      `/api/v1/sso-connections/${rivalConnection.id}/domains/${claimed.id}/verify`,
      { cookie: rival.cookie },
    );
    expect((await json<{ data: SsoDomain }>(later)).data.verified).toBe(true);
  });
});

describe('SSO: enforcement', () => {
  it('turning enforcement on applies to cached sessions on their next request, on every path', async () => {
    const { owner, connection, domain } = await activeConnection();
    const teammate = await seatAs(owner.workspaceId, 'editor', `quick@${domain}`);
    const outsider = await seatAs(owner.workspaceId, 'editor');
    const seats = `/api/v1/workspaces/${owner.workspaceId}/seats`;
    const channels = `/api/v1/workspaces/${owner.workspaceId}/channels`;
    expect((await call('GET', seats, { cookie: teammate.cookie })).status).toBe(200);
    const on = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: owner.cookie,
      body: { enforced: true },
    });
    expect(on.status).toBe(200);
    for (const path of [seats, channels]) {
      const res = await call('GET', path, { cookie: teammate.cookie });
      expect.soft(res.status, path).toBe(403);
      expect.soft(await res.json()).toMatchObject({
        error: { details: [{ path: 'sso', message: 'sso_required' }] },
      });
    }
    // Enforcement covers the captured domains: a teammate on another domain is not affected.
    expect((await call('GET', seats, { cookie: outsider.cookie })).status).toBe(200);
    const off = await call('PATCH', `/api/v1/sso-connections/${connection.id}`, {
      cookie: owner.cookie,
      body: { enforced: false },
    });
    expect(off.status).toBe(200);
    expect((await call('GET', seats, { cookie: teammate.cookie })).status).toBe(200);
  });
});
