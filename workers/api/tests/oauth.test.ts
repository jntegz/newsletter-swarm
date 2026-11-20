// OAuth apps, the authorization-code flow with PKCE, refresh rotation and family revocation,
// RFC 7009, operator controls, and the role matrix and tenancy of every OAuth v1 route.
import { SELF, env } from 'cloudflare:test';
import { SCOPE_LABELS, newId, type OAuthApp, type OAuthGrant, type SeatRole } from '@swarm/domain';
import { DevMailbox } from '@swarm/mail';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, json, seatAs, signIn, type Session } from './helpers';
import { data, errorCode } from './money-helpers';
import {
  REDIRECT,
  authorize,
  connect,
  consent,
  createApp,
  form,
  oauthError,
  pkce,
  setPlan,
  v2,
  type Tokens,
} from './oauth-helpers';

let owner: Session;
let channelId: string;
let otherChannelId: string;
let clientId: string;
let appId: string;

const sendsPath = (id = channelId) => `/v2/channels/${id}/sends`;

beforeAll(async () => {
  owner = await signIn();
  await setPlan(owner.workspaceId, 'pro');
  channelId = (await createChannel(owner)).id;
  otherChannelId = (await createChannel(owner)).id;
  const created = await createApp(owner, { scopes: ['members:read', 'sends:write'] });
  clientId = created.app.clientId;
  appId = created.app.id;
});

describe('OAuth apps', () => {
  it('registers public and confidential apps; the secret is shown once and only its hash kept', async () => {
    const pub = await createApp(owner, { scopes: ['channels:read'] });
    expect(pub.clientSecret).toBeNull();
    expect(pub.app.clientType).toBe('public');
    expect(pub.app.clientId).toMatch(/^swc_[0-9A-Za-z]{24}$/);
    const conf = await createApp(owner, { scopes: ['channels:read'], clientType: 'confidential' });
    expect(conf.clientSecret).toMatch(/^swcs_[0-9A-Za-z]{40}$/);
    const row = await env.DB.prepare('SELECT client_secret_hash FROM oauth_apps WHERE id = ?1')
      .bind(conf.app.id)
      .first<{ client_secret_hash: string }>();
    expect(row!.client_secret_hash).toMatch(/^[0-9a-f]{64}$/);
    const list = await data<OAuthApp[]>(
      await call('GET', `/api/v1/workspaces/${owner.workspaceId}/oauth-apps`, {
        cookie: owner.cookie,
      }),
    );
    expect(JSON.stringify(list)).not.toContain(conf.clientSecret!);
  });

  it('refuses wildcard, fragment and unknown-scheme redirect URIs', async () => {
    for (const uri of ['https://*.example/cb', 'https://app.example/cb#x', 'myapp://cb', 'nope']) {
      const res = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/oauth-apps`, {
        cookie: owner.cookie,
        body: { name: 'x', clientType: 'public', redirectUris: [uri], scopes: ['channels:read'] },
      });
      expect(res.status, uri).toBe(400);
    }
  });

  it('enforces the plan limit on apps', async () => {
    const s = await signIn();
    await createApp(s, { scopes: ['channels:read'] });
    const res = await call('POST', `/api/v1/workspaces/${s.workspaceId}/oauth-apps`, {
      cookie: s.cookie,
      body: {
        name: 'x',
        clientType: 'public',
        redirectUris: [REDIRECT],
        scopes: ['channels:read'],
      },
    });
    expect(res.status).toBe(409);
  });

  it('keeps to the plan limit when many apps are registered at once', async () => {
    const s = await signIn();
    await setPlan(s.workspaceId, 'free');
    // The test runtime runs the first request of a burst on its own, so a read goes first and
    // the registrations start together.
    const [, ...results] = await Promise.all([
      call('GET', `/api/v1/workspaces/${s.workspaceId}/oauth-apps`, { cookie: s.cookie }),
      ...Array.from({ length: 12 }, (_, i) =>
        call('POST', `/api/v1/workspaces/${s.workspaceId}/oauth-apps`, {
          cookie: s.cookie,
          body: {
            name: `App ${i}`,
            clientType: i % 2 ? 'confidential' : 'public',
            redirectUris: [REDIRECT],
            scopes: ['channels:read'],
          },
        }),
      ),
    ]);
    const rows = await env.DB.prepare(
      'SELECT count(*) AS n FROM oauth_apps WHERE workspace_id = ?1 AND revoked_at IS NULL AND metadata_url IS NULL',
    )
      .bind(s.workspaceId)
      .first<{ n: number }>();
    expect({
      added: results.filter((res) => res.status === 201).length,
      refused: results.filter((res) => res.status === 409).length,
      rows: rows?.n,
    }).toEqual({ added: 1, refused: 11, rows: 1 });
  });

  it('rotates a confidential secret and refuses rotation for a public app', async () => {
    const conf = await createApp(owner, { scopes: ['channels:read'], clientType: 'confidential' });
    const rotated = await data<{ clientSecret: string }>(
      await call(
        'POST',
        `/api/v1/workspaces/${owner.workspaceId}/oauth-apps/${conf.app.id}/rotate-secret`,
        { cookie: owner.cookie },
      ),
    );
    expect(rotated.clientSecret).not.toBe(conf.clientSecret);
    const res = await call(
      'POST',
      `/api/v1/workspaces/${owner.workspaceId}/oauth-apps/${appId}/rotate-secret`,
      { cookie: owner.cookie },
    );
    expect(res.status).toBe(409);
  });

  it('refuses a homepage that is not https (http only for localhost here)', async () => {
    const s = await signIn();
    await setPlan(s.workspaceId, 'pro');
    const base = { name: 'x', clientType: 'public', redirectUris: [REDIRECT] };
    const post = (homepageUrl: string) =>
      call('POST', `/api/v1/workspaces/${s.workspaceId}/oauth-apps`, {
        cookie: s.cookie,
        body: { ...base, scopes: ['channels:read'], homepageUrl },
      });
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'http://app.example/']) {
      const res = await post(bad);
      expect(res.status, bad).toBe(400);
    }
    expect((await post('https://app.example/')).status).toBe(201);
    expect((await post('http://localhost:3000/')).status).toBe(201);
    const { app } = await createApp(s, { scopes: ['channels:read'] });
    const patched = await call(
      'PATCH',
      `/api/v1/workspaces/${s.workspaceId}/oauth-apps/${app.id}`,
      {
        cookie: s.cookie,
        body: { homepageUrl: 'javascript:alert(1)' },
      },
    );
    expect(patched.status).toBe(400);
    // A homepage stored before this check is not handed to the consent page as a link.
    await env.DB.prepare("UPDATE oauth_apps SET homepage_url = 'javascript:alert(1)' WHERE id = ?1")
      .bind(app.id)
      .run();
    const { challenge } = pkce();
    const query = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'channels:read',
      state: 's',
      code_challenge: await challenge(),
      code_challenge_method: 'S256',
    });
    const info = await data<{ app: { homepageUrl: string | null } }>(
      await call('GET', `/api/v1/oauth/consent?${query}`, { cookie: s.cookie }),
    );
    expect(info.app.homepageUrl).toBeNull();
  });

  it('sends an approved listing back to review when a reviewed detail of the app changes', async () => {
    const s = await signIn();
    await setPlan(s.workspaceId, 'pro');
    const { app } = await createApp(s, { scopes: ['channels:read', 'members:read'] });
    const listing = newId('appListing');
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO app_listings (id, app_id, workspace_id, status, name, slug, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'approved', 'Sync tool', ?4, ?5, ?5)`,
    )
      .bind(listing, app.id, s.workspaceId, `sync-${now}`, now)
      .run();
    const status = async () =>
      (await env.DB.prepare('SELECT status FROM app_listings WHERE id = ?1')
        .bind(listing)
        .first<{ status: string }>())!.status;
    const approve = () =>
      env.DB.prepare("UPDATE app_listings SET status = 'approved' WHERE id = ?1")
        .bind(listing)
        .run();
    const patch = async (body: Record<string, unknown>) => {
      const res = await call('PATCH', `/api/v1/workspaces/${s.workspaceId}/oauth-apps/${app.id}`, {
        cookie: s.cookie,
        body,
      });
      expect(res.status, await res.clone().text()).toBe(200);
    };
    // Narrowing the scopes, or saving the same details, shows staff nothing new.
    await patch({ scopes: ['channels:read'], name: 'Sync tool' });
    expect(await status()).toBe('approved');
    for (const body of [
      { name: 'Official Swarm Sync' },
      { redirectUris: ['https://elsewhere.example/cb'] },
      { homepageUrl: 'https://elsewhere.example/' },
      { scopes: ['channels:read', 'members:write'] },
    ]) {
      await patch(body);
      expect(await status(), JSON.stringify(body)).toBe('draft');
      await approve();
    }
  });
});

describe('/oauth/authorize', () => {
  it('hands a valid request to the consent page without changing anything', async () => {
    const { challenge } = pkce();
    const res = await authorize({ clientId, scope: 'sends:write', challenge: await challenge() });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/oauth/consent');
    expect(location.searchParams.get('client_id')).toBe(clientId);
    const grants = await env.DB.prepare('SELECT count(*) AS n FROM oauth_grants WHERE app_id = ?1')
      .bind(appId)
      .first<{ n: number }>();
    expect(grants!.n).toBe(0);
  });

  it('shows an error page, never a redirect, for an unknown client or redirect URI', async () => {
    const { challenge } = pkce();
    const unknown = await authorize({
      clientId: 'swc_nope',
      scope: 'sends:write',
      challenge: await challenge(),
    });
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get('location')).toBeNull();
    expect(unknown.headers.get('content-type')).toContain('text/html');
    const mismatch = await authorize({
      clientId,
      scope: 'sends:write',
      challenge: await challenge(),
      redirectUri: 'https://evil.example/callback',
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.headers.get('location')).toBeNull();
    // Exact match only: a different path or an extra query is not the registered URI.
    const extra = await authorize({
      clientId,
      scope: 'sends:write',
      challenge: await challenge(),
      redirectUri: `${REDIRECT}?x=1`,
    });
    expect(extra.status).toBe(400);
  });

  const errorFor = async (res: Response) => {
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe('st-123');
    return url.searchParams.get('error');
  };

  it('rejects a request without PKCE', async () => {
    expect(await errorFor(await authorize({ clientId, scope: 'sends:write' }))).toBe(
      'invalid_request',
    );
  });

  it('rejects the plain method and a missing method', async () => {
    const { verifier } = pkce();
    expect(
      await errorFor(
        await authorize({
          clientId,
          scope: 'sends:write',
          challenge: verifier.slice(0, 43),
          method: 'plain',
        }),
      ),
    ).toBe('invalid_request');
    const { challenge } = pkce();
    expect(
      await errorFor(
        await authorize({
          clientId,
          scope: 'sends:write',
          challenge: await challenge(),
          method: null,
        }),
      ),
    ).toBe('invalid_request');
  });

  it('refuses scopes beyond the app’s', async () => {
    const { challenge } = pkce();
    expect(
      await errorFor(
        await authorize({
          clientId,
          scope: 'sends:write members:write',
          challenge: await challenge(),
        }),
      ),
    ).toBe('invalid_scope');
  });
});

describe('consent and tokens', () => {
  it('shows the app, plain-language scopes and the operator’s admin workspaces', async () => {
    const { challenge } = pkce();
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'members:read sends:write',
      state: 's',
      code_challenge: await challenge(),
      code_challenge_method: 'S256',
    });
    const info = await data<{
      app: { name: string };
      scopes: { scope: string; label: string }[];
      workspaces: { id: string; channels: { id: string }[] }[];
    }>(await call('GET', `/api/v1/oauth/consent?${query}`, { cookie: owner.cookie }));
    expect(info.app.name).toBe('Sync tool');
    expect(info.scopes.map((s) => s.scope)).toEqual(['members:read', 'sends:write']);
    expect(info.scopes[1]!.label).toBe('Send single emails to subscribers');
    const ws = info.workspaces.find((w) => w.id === owner.workspaceId)!;
    expect(ws.channels.map((c) => c.id)).toEqual(
      expect.arrayContaining([channelId, otherChannelId]),
    );
    // A teammate below admin sees no workspace to choose.
    const editor = await seatAs(owner.workspaceId, 'editor');
    const editorInfo = await data<{ workspaces: { id: string }[] }>(
      await call('GET', `/api/v1/oauth/consent?${query}`, { cookie: editor.cookie }),
    );
    expect(editorInfo.workspaces.map((w) => w.id)).not.toContain(owner.workspaceId);
  });

  it('calls a registered app verified only once the App Directory approved it', async () => {
    const { challenge } = pkce();
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'sends:write',
      state: 's',
      code_challenge: await challenge(),
      code_challenge_method: 'S256',
    });
    const read = async () =>
      (
        await data<{ app: { verified: boolean; registeredBy: string | null } }>(
          await call('GET', `/api/v1/oauth/consent?${query}`, { cookie: owner.cookie }),
        )
      ).app;
    // Any admin can register an app under any workspace name; that vouches for nothing.
    expect(await read()).toMatchObject({ verified: false, registeredBy: expect.any(String) });
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO app_listings (id, app_id, workspace_id, status, name, slug, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'approved', 'Sync tool', ?4, ?5, ?5)`,
    )
      .bind(newId('appListing'), appId, owner.workspaceId, `sync-${now}`, now)
      .run();
    expect((await read()).verified).toBe(true);
    await env.DB.prepare(
      "UPDATE app_listings SET status = 'delisted' WHERE app_id = ?1 AND status = 'approved'",
    )
      .bind(appId)
      .run();
    expect((await read()).verified).toBe(false);
  });

  it('needs admin on the chosen workspace to allow', async () => {
    const editor = await seatAs(owner.workspaceId, 'editor');
    const { challenge } = pkce();
    const res = await call('POST', '/api/v1/oauth/consent', {
      cookie: editor.cookie,
      body: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: 'code',
        scope: 'sends:write',
        state: 's',
        code_challenge: await challenge(),
        code_challenge_method: 'S256',
        decision: 'allow',
        workspaceId: owner.workspaceId,
      },
    });
    expect(res.status).toBe(403);
    const outsider = await signIn();
    const foreign = await call('POST', '/api/v1/oauth/consent', {
      cookie: outsider.cookie,
      body: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: 'code',
        scope: 'sends:write',
        state: 's',
        code_challenge: await challenge(),
        code_challenge_method: 'S256',
        decision: 'allow',
        workspaceId: owner.workspaceId,
      },
    });
    expect(foreign.status).toBe(404);
  });

  it('checks the Origin on consent (CSRF)', async () => {
    const res = await call('POST', '/api/v1/oauth/consent', {
      cookie: owner.cookie,
      origin: 'https://evil.example',
      body: { client_id: clientId, redirect_uri: REDIRECT, decision: 'allow' },
    });
    expect(res.status).toBe(403);
  });

  it('a denial returns access_denied to the app', async () => {
    const { challenge } = pkce();
    const url = await consent(
      owner,
      { clientId, scope: 'sends:write', challenge: await challenge() },
      { decision: 'deny' },
    );
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('st-123');
  });

  it('exchanges a code for tokens that work on /v2', async () => {
    const tokens = await connect(owner, clientId, 'members:read sends:write');
    expect(tokens.access_token).toMatch(/^oat_/);
    expect(tokens.refresh_token).toMatch(/^ort_/);
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe('members:read sends:write');
    expect((await v2('GET', sendsPath(), tokens.access_token)).status).toBe(200);
    const stored = await env.DB.prepare(
      'SELECT count(*) AS n FROM oauth_tokens WHERE token_hash = ?1 OR token_hash = ?2',
    )
      .bind(tokens.access_token, tokens.refresh_token)
      .first<{ n: number }>();
    expect(stored!.n).toBe(0);
  });

  it('only the consented scopes reach /v2', async () => {
    const tokens = await connect(owner, clientId, 'members:read');
    const res = await v2('GET', sendsPath(), tokens.access_token);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('insufficient_scope');
  });

  it('a Channel restriction hides other Channels', async () => {
    const tokens = await connect(owner, clientId, 'sends:write', { channelIds: [channelId] });
    expect((await v2('GET', sendsPath(), tokens.access_token)).status).toBe(200);
    expect((await v2('GET', sendsPath(otherChannelId), tokens.access_token)).status).toBe(404);
  });

  it('rejects a wrong verifier, a mismatched redirect URI and an expired code', async () => {
    const { verifier, challenge } = pkce();
    const input = { clientId, scope: 'sends:write', challenge: await challenge() };
    const code = (await consent(owner, input)).searchParams.get('code')!;
    const base = { grant_type: 'authorization_code', code, client_id: clientId };
    const wrong = await form('/oauth/token', {
      ...base,
      redirect_uri: REDIRECT,
      code_verifier: pkce().verifier,
    });
    expect(wrong.status).toBe(400);
    expect(await oauthError(wrong)).toBe('invalid_grant');
    const elsewhere = await form('/oauth/token', {
      ...base,
      redirect_uri: 'https://app.example/other',
      code_verifier: verifier,
    });
    expect(await oauthError(elsewhere)).toBe('invalid_grant');
    await env.DB.prepare(
      'UPDATE oauth_grants SET code_expires_at = 1 WHERE code_hash IS NOT NULL AND app_id = ?1 AND code_consumed_at IS NULL',
    )
      .bind(appId)
      .run();
    const expired = await form('/oauth/token', {
      ...base,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(await oauthError(expired)).toBe('invalid_grant');
  });

  it('rejects code reuse and revokes the tokens issued from it', async () => {
    const tokens = await connect(owner, clientId, 'sends:write');
    const again = await form('/oauth/token', {
      grant_type: 'authorization_code',
      code: tokens.code,
      redirect_uri: REDIRECT,
      code_verifier: tokens.verifier,
      client_id: clientId,
    });
    expect(again.status).toBe(400);
    expect(await oauthError(again)).toBe('invalid_grant');
    expect((await v2('GET', sendsPath(), tokens.access_token)).status).toBe(401);
    const refreshed = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(await oauthError(refreshed)).toBe('invalid_grant');
  });

  it('rotates refresh tokens, and a reused one revokes the whole family', async () => {
    const first = await connect(owner, clientId, 'sends:write');
    const res = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const second = await res.json<{ access_token: string; refresh_token: string }>();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await v2('GET', sendsPath(), second.access_token)).status).toBe(200);

    const replay = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(await oauthError(replay)).toBe('invalid_grant');
    // Everything in the family is gone: the newer refresh token and both access tokens.
    expect((await v2('GET', sendsPath(), second.access_token)).status).toBe(401);
    expect((await v2('GET', sendsPath(), first.access_token)).status).toBe(401);
    const latest = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: second.refresh_token,
      client_id: clientId,
    });
    expect(await oauthError(latest)).toBe('invalid_grant');
  });

  it('a refresh with a narrower scope issues an access token for that subset only', async () => {
    const first = await connect(owner, clientId, 'members:read sends:write');
    const res = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: clientId,
      scope: 'members:read',
    });
    expect(res.status).toBe(200);
    const narrow = await res.json<Tokens>();
    expect(narrow.scope).toBe('members:read');
    const sends = await v2('GET', sendsPath(), narrow.access_token);
    expect(sends.status).toBe(403);
    expect(await errorCode(sends)).toBe('insufficient_scope');
    expect((await v2('GET', `/v2/channels/${channelId}/members`, narrow.access_token)).status).toBe(
      200,
    );
    // RFC 6749 section 6: the new refresh token keeps the original scope.
    const full = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: narrow.refresh_token,
      client_id: clientId,
    });
    const wide = await full.json<Tokens>();
    expect(wide.scope).toBe('members:read sends:write');
    expect((await v2('GET', sendsPath(), wide.access_token)).status).toBe(200);
  });

  it('a narrowed access token gets no Idempotency-Key replay of a wider token of its grant', async () => {
    const { app } = await createApp(owner, { scopes: ['members:read', 'members:write'] });
    const full = await connect(owner, app.clientId, 'members:read members:write');
    const key = `narrow-${crypto.randomUUID()}`;
    const body = JSON.stringify({ email: `narrow-${crypto.randomUUID()}@example.com` });
    const send = (token: string) =>
      SELF.fetch(`http://localhost/v2/channels/${channelId}/members`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body,
      });
    expect((await send(full.access_token)).status).toBe(201);
    const res = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: full.refresh_token,
      client_id: app.clientId,
      scope: 'members:read',
    });
    const narrow = await res.json<Tokens>();
    expect(narrow.scope).toBe('members:read');
    // The stored 201 was made with members:write; this token may not see it, nor write.
    const replay = await send(narrow.access_token);
    expect(replay.headers.get('idempotent-replayed')).toBeNull();
    expect(replay.status).not.toBe(201);
  });

  it('refuses a refresh token presented by another app', async () => {
    const tokens = await connect(owner, clientId, 'sends:write');
    const other = await createApp(owner, { scopes: ['sends:write'] });
    const res = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: other.app.clientId,
    });
    expect(await oauthError(res)).toBe('invalid_grant');
    // Not a replay by the owner: the family keeps working.
    expect((await v2('GET', sendsPath(), tokens.access_token)).status).toBe(200);
  });

  it('authenticates confidential clients with Basic or client_secret', async () => {
    const conf = await createApp(owner, { scopes: ['sends:write'], clientType: 'confidential' });
    const id = conf.app.clientId;
    const secret = conf.clientSecret!;
    const exchange = async (
      extra: Record<string, string>,
      headers: Record<string, string> = {},
    ) => {
      const { verifier, challenge } = pkce();
      const url = await consent(owner, {
        clientId: id,
        scope: 'sends:write',
        challenge: await challenge(),
      });
      return form(
        '/oauth/token',
        {
          grant_type: 'authorization_code',
          code: url.searchParams.get('code')!,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
          ...extra,
        },
        headers,
      );
    };
    const missing = await exchange({ client_id: id });
    expect(missing.status).toBe(401);
    expect(await oauthError(missing)).toBe('invalid_client');
    const wrongSecret = await exchange({ client_id: id, client_secret: `swcs_${'x'.repeat(40)}` });
    expect(wrongSecret.status).toBe(401);
    expect((await exchange({ client_id: id, client_secret: secret })).status).toBe(200);
    const basic = await exchange({}, { authorization: `Basic ${btoa(`${id}:${secret}`)}` });
    expect(basic.status).toBe(200);
  });

  it('answers malformed requests in the RFC shape', async () => {
    const res = await form('/oauth/token', { grant_type: 'password', client_id: clientId });
    expect(res.status).toBe(400);
    expect(await oauthError(res)).toBe('unsupported_grant_type');
    // A JSON body is not a token request (refused before it reaches the endpoint).
    const asJson = await SELF.fetch('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code' }),
    });
    expect(asJson.status).toBe(415);
  });

  it('revokes with RFC 7009: a refresh token takes its family with it', async () => {
    const tokens = await connect(owner, clientId, 'sends:write');
    const unknown = await form('/oauth/revoke', { token: 'ort_unknown', client_id: clientId });
    expect(unknown.status).toBe(200);
    const res = await form('/oauth/revoke', {
      token: tokens.refresh_token,
      token_type_hint: 'refresh_token',
      client_id: clientId,
    });
    expect(res.status).toBe(200);
    expect((await v2('GET', sendsPath(), tokens.access_token)).status).toBe(401);
  });

  it('an access token stops working when its seat drops below admin', async () => {
    const admin = await seatAs(owner.workspaceId, 'admin');
    const tokens = await connect(admin, clientId, 'sends:write', {
      workspaceId: owner.workspaceId,
    });
    expect((await v2('GET', sendsPath(), tokens.access_token)).status).toBe(200);
    await env.DB.prepare(
      "UPDATE seats SET role = 'editor' WHERE operator_id = ?1 AND workspace_id = ?2",
    )
      .bind(admin.me.operator.id, owner.workspaceId)
      .run();
    expect((await v2('GET', sendsPath(), tokens.access_token)).status).toBe(401);
  });

  it('serves RFC 8414 metadata', async () => {
    const res = await call('GET', '/.well-known/oauth-authorization-server');
    const body = await json<{ code_challenge_methods_supported: string[]; token_endpoint: string }>(
      res,
    );
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.token_endpoint).toMatch(/\/oauth\/token$/);
  });
});

describe('authorised apps', () => {
  it('lists grants and revoking one cuts the app off at once', async () => {
    const tokens = await connect(owner, clientId, 'sends:write');
    const grants = await data<OAuthGrant[]>(
      await call('GET', `/api/v1/workspaces/${owner.workspaceId}/oauth-grants`, {
        cookie: owner.cookie,
      }),
    );
    const grantId = (await env.DB.prepare(
      "SELECT t.grant_id FROM oauth_tokens t WHERE t.kind = 'access' ORDER BY t.created_at DESC LIMIT 1",
    ).first<{ grant_id: string }>())!.grant_id;
    expect(grants.map((g) => g.id)).toContain(grantId);
    expect(grants.find((g) => g.id === grantId)!.authorisedBy).toBe(owner.email);
    const res = await call(
      'DELETE',
      `/api/v1/workspaces/${owner.workspaceId}/oauth-grants/${grantId}`,
      { cookie: owner.cookie },
    );
    expect(res.status).toBe(204);
    const after = await v2('GET', sendsPath(), tokens.access_token);
    expect(after.status).toBe(401);
    const refreshed = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(await oauthError(refreshed)).toBe('invalid_grant');
  });

  it("emails the workspace's other owners and admins the app, its scopes and where to revoke it", async () => {
    const s = await signIn();
    await setPlan(s.workspaceId, 'pro');
    const otherAdmin = await seatAs(s.workspaceId, 'admin');
    const editor = await seatAs(s.workspaceId, 'editor');
    const app = await createApp(s, {
      scopes: ['members:read', 'sends:write'],
      name: 'Inbox Helper',
    });
    await connect(s, app.app.clientId, 'members:read sends:write');
    const mails = async (to: string) =>
      (await new DevMailbox(env.DEV_MAILBOX).list({ to, limit: 20 })).filter(
        (m) => m.category === 'standing_feed_changed',
      );
    const [notice] = await mails(otherAdmin.email);
    expect(notice?.subject).toBe('An app was allowed into your workspace: Inbox Helper');
    expect(notice!.text).toContain(s.email);
    expect(notice!.text).toContain(SCOPE_LABELS['members:read']);
    expect(notice!.text).toContain(SCOPE_LABELS['sends:write']);
    expect(notice!.text).toContain('/settings/developers/oauth-apps');
    // Not the admin who allowed it, and not someone who can't revoke it.
    expect(await mails(s.email)).toEqual([]);
    expect(await mails(editor.email)).toEqual([]);
  });

  it('revoking an app revokes every grant of it', async () => {
    const extra = await createApp(owner, { scopes: ['sends:write'] });
    const tokens = await connect(owner, extra.app.clientId, 'sends:write');
    const res = await call(
      'DELETE',
      `/api/v1/workspaces/${owner.workspaceId}/oauth-apps/${extra.app.id}`,
      { cookie: owner.cookie },
    );
    expect(res.status).toBe(204);
    expect((await v2('GET', sendsPath(), tokens.access_token)).status).toBe(401);
    const { challenge } = pkce();
    expect(
      (
        await authorize({
          clientId: extra.app.clientId,
          scope: 'sends:write',
          challenge: await challenge(),
        })
      ).status,
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
// Role matrix and tenancy (the pattern of audience-roles.test.ts)

const ROLES: SeatRole[] = ['viewer', 'author', 'editor', 'admin', 'owner'];
const rank = (role: SeatRole) => ROLES.indexOf(role);

describe('OAuth routes: roles and tenancy', () => {
  let matrixOwner: Session;
  let outsider: Session;
  const sessions = {} as Record<SeatRole, Session>;

  beforeAll(async () => {
    matrixOwner = await signIn();
    await setPlan(matrixOwner.workspaceId, 'enterprise');
    sessions.owner = matrixOwner;
    for (const role of ['viewer', 'author', 'editor', 'admin'] as const) {
      sessions[role] = await seatAs(matrixOwner.workspaceId, role);
    }
    outsider = await signIn();
  });

  const ws = () => `/api/v1/workspaces/${matrixOwner.workspaceId}`;
  const freshApp = async () =>
    (await createApp(matrixOwner, { scopes: ['channels:read'], clientType: 'confidential' })).app
      .id;
  const freshGrant = async () => {
    const app = await createApp(matrixOwner, { scopes: ['channels:read'] });
    await connect(matrixOwner, app.app.clientId, 'channels:read');
    return (await env.DB.prepare('SELECT id FROM oauth_grants WHERE app_id = ?1')
      .bind(app.app.id)
      .first<{ id: string }>())!.id;
  };

  const ROUTES: { name: string; request: (s: Session) => Promise<Response> }[] = [
    { name: 'list apps', request: (s) => call('GET', `${ws()}/oauth-apps`, { cookie: s.cookie }) },
    {
      name: 'create app',
      request: (s) =>
        call('POST', `${ws()}/oauth-apps`, {
          cookie: s.cookie,
          body: {
            name: 'x',
            clientType: 'public',
            redirectUris: [REDIRECT],
            scopes: ['channels:read'],
          },
        }),
    },
    {
      name: 'update app',
      request: async (s) =>
        call('PATCH', `${ws()}/oauth-apps/${await freshApp()}`, {
          cookie: s.cookie,
          body: { name: 'Renamed' },
        }),
    },
    {
      name: 'rotate secret',
      request: async (s) =>
        call('POST', `${ws()}/oauth-apps/${await freshApp()}/rotate-secret`, { cookie: s.cookie }),
    },
    {
      name: 'revoke app',
      request: async (s) =>
        call('DELETE', `${ws()}/oauth-apps/${await freshApp()}`, { cookie: s.cookie }),
    },
    {
      name: 'list grants',
      request: (s) => call('GET', `${ws()}/oauth-grants`, { cookie: s.cookie }),
    },
    {
      name: 'revoke grant',
      request: async (s) =>
        call('DELETE', `${ws()}/oauth-grants/${await freshGrant()}`, { cookie: s.cookie }),
    },
  ];

  for (const route of ROUTES) {
    it(`${route.name}: admin and owner only`, async () => {
      for (const role of ROLES) {
        const res = await route.request(sessions[role]);
        if (rank(role) >= rank('admin')) expect(res.status, role).toBeLessThan(300);
        else expect(res.status, role).toBe(403);
      }
    });
    it(`${route.name}: another workspace's operator gets 404`, async () => {
      expect((await route.request(outsider)).status).toBe(404);
    });
  }

  it('an app of another workspace is not found through this workspace', async () => {
    const foreignApp = await createApp(outsider, { scopes: ['channels:read'] });
    for (const [method, path] of [
      ['PATCH', `/api/v1/workspaces/${matrixOwner.workspaceId}/oauth-apps/${foreignApp.app.id}`],
      ['DELETE', `/api/v1/workspaces/${matrixOwner.workspaceId}/oauth-apps/${foreignApp.app.id}`],
    ] as const) {
      const res = await call(method, path, { cookie: matrixOwner.cookie, body: { name: 'x' } });
      expect(res.status, method).toBe(404);
    }
  });

  it('a grant of another workspace is not found through this workspace', async () => {
    await setPlan(outsider.workspaceId, 'pro');
    const foreignApp = await createApp(outsider, { scopes: ['channels:read'] });
    await connect(outsider, foreignApp.app.clientId, 'channels:read');
    const grant = (await env.DB.prepare('SELECT id FROM oauth_grants WHERE app_id = ?1')
      .bind(foreignApp.app.id)
      .first<{ id: string }>())!;
    const res = await call(
      'DELETE',
      `/api/v1/workspaces/${matrixOwner.workspaceId}/oauth-grants/${grant.id}`,
      { cookie: matrixOwner.cookie },
    );
    expect(res.status).toBe(404);
  });

  it('every OAuth route needs a session', async () => {
    const res = await call('GET', `${ws()}/oauth-apps`);
    expect(res.status).toBe(401);
  });
});
