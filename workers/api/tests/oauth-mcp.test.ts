// OAuth for MCP (Phase 8 follow-up): RFC 8707 resource indicators (a grant is bound to /v2 or
// /mcp, each refuses the other's tokens) and Client ID Metadata Documents (fetch rules, cache,
// abuse limits, consent marking, the whole flow, token-endpoint matching). Contract: docs/oauth.md.
import { SELF, env } from 'cloudflare:test';
import {
  MCP_MODERN_VERSION,
  newId,
  type ConsentInfo,
  type OAuthApp,
  type OAuthGrant,
} from '@swarm/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useClientDocumentFetchForTests } from '../src/lib/oauthClients';
import { call, createChannel, json, signIn, type Session } from './helpers';
import { data } from './money-helpers';
import {
  MCP_RESOURCE,
  ORIGIN,
  REDIRECT,
  V2_RESOURCE,
  authorize,
  authorizeQuery,
  connect,
  createApp,
  form,
  oauthError,
  pkce,
  setPlan,
  v2,
} from './oauth-helpers';
import { createKey } from './v2-helpers';

let owner: Session;
let channelId: string;
let clientId: string;

async function enableFlag(key: string, workspaceId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, ?2, 'workspace', ?3, 1, 0)`,
  )
    .bind(newId('featureFlag'), key, workspaceId)
    .run();
  await env.CACHE.delete(`flags:v1:${workspaceId}:-`);
}

/** tools/list on /mcp (modern revision). */
function mcpList(token: string): Promise<Response> {
  return SELF.fetch('http://localhost/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_MODERN_VERSION,
      'mcp-method': 'tools/list',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MCP_MODERN_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

// ---- Metadata documents served by the stubbed fetch -----------------------------------------

const documents = new Map<string, () => Response>();
const fetched: string[] = [];
const doc = (url: string, extra: Record<string, unknown> = {}) =>
  documents.set(
    url,
    () =>
      new Response(
        JSON.stringify({
          client_id: url,
          client_name: 'Agent Desk',
          client_uri: 'https://agent.example',
          redirect_uris: ['http://127.0.0.1:33418/callback', 'https://agent.example/cb'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          ...extra,
        }),
        { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=600' } },
      ),
  );

let n = 0;
const docUrl = () => `https://agent${++n}.example/oauth/client.json`;

beforeAll(async () => {
  useClientDocumentFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    expect(init?.redirect).toBe('manual');
    const answer = documents.get(url);
    return answer ? answer() : new Response('not found', { status: 404 });
  }) as typeof fetch);
  owner = await signIn();
  await setPlan(owner.workspaceId, 'pro');
  channelId = (await createChannel(owner)).id;
  await enableFlag('open_operator_mcp', owner.workspaceId);
  clientId = (await createApp(owner, { scopes: ['channels:read', 'members:read'] })).app.clientId;
});

afterAll(() => useClientDocumentFetchForTests(undefined));
beforeEach(() => {
  fetched.length = 0;
});

describe('authorization server metadata', () => {
  it('advertises Client ID Metadata Documents and PKCE', async () => {
    const res = await SELF.fetch('http://localhost/.well-known/oauth-authorization-server');
    const body = await res.json<Record<string, unknown>>();
    expect(body.client_id_metadata_document_supported).toBe(true);
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body).not.toHaveProperty('registration_endpoint');
  });
});

describe('resource indicators (RFC 8707)', () => {
  it('without resource, tokens are for /v2 and /mcp refuses them with the challenge', async () => {
    const tokens = await connect(owner, clientId, 'channels:read');
    expect((await v2('GET', '/v2/channels', tokens.access_token)).status).toBe(200);
    const res = await mcpList(tokens.access_token);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      'resource_metadata="http://localhost:5273/.well-known/oauth-protected-resource/mcp"',
    );
    const grants = await data<OAuthGrant[]>(
      await call('GET', `/api/v1/workspaces/${owner.workspaceId}/oauth-grants`, {
        cookie: owner.cookie,
      }),
    );
    expect(grants[0]!.resource).toBe('v2');
  });

  it('a /mcp token works on /mcp and not on /v2', async () => {
    const tokens = await connect(owner, clientId, 'channels:read', { resource: MCP_RESOURCE });
    expect((await mcpList(tokens.access_token)).status).toBe(200);
    expect((await v2('GET', '/v2/channels', tokens.access_token)).status).toBe(401);
    // A refreshed token keeps the audience.
    const refreshed = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: MCP_RESOURCE,
    });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json<{ access_token: string }>();
    expect((await mcpList(next.access_token)).status).toBe(200);
    expect((await v2('GET', '/v2/channels', next.access_token)).status).toBe(401);
  });

  it('accepts /v2, the bare origin and a trailing slash as the API', async () => {
    for (const resource of [V2_RESOURCE, ORIGIN, `${ORIGIN}/`, `${ORIGIN}/v2/`]) {
      const tokens = await connect(owner, clientId, 'channels:read', { resource });
      expect((await v2('GET', '/v2/channels', tokens.access_token)).status, resource).toBe(200);
    }
  });

  it('answers invalid_target for a resource Swarm does not serve', async () => {
    const { challenge } = pkce();
    for (const resource of [
      'https://elsewhere.example/mcp',
      `${ORIGIN}/api`,
      `${ORIGIN}/mcp?x=1`,
      `${ORIGIN}/mcp#frag`,
    ]) {
      const res = await authorize({
        clientId,
        scope: 'channels:read',
        challenge: await challenge(),
        resource,
      });
      expect(res.status, resource).toBe(302);
      const url = new URL(res.headers.get('location')!);
      expect(url.origin + url.pathname).toBe(REDIRECT);
      expect(url.searchParams.get('error'), resource).toBe('invalid_target');
    }
  });

  it('refuses a token request for another resource without using up the code', async () => {
    const { verifier, challenge } = pkce();
    const input = { clientId, scope: 'channels:read', challenge: await challenge() };
    const consentRes = await call('POST', '/api/v1/oauth/consent', {
      cookie: owner.cookie,
      body: { ...authorizeQuery(input), decision: 'allow', workspaceId: owner.workspaceId },
    });
    const code = new URL(
      (await json<{ data: { redirectUrl: string } }>(consentRes)).data.redirectUrl,
    ).searchParams.get('code')!;
    const exchange = (resource?: string) =>
      form('/oauth/token', {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        client_id: clientId,
        ...(resource ? { resource } : {}),
      });
    const wrong = await exchange(MCP_RESOURCE);
    expect(wrong.status).toBe(400);
    expect(await oauthError(wrong)).toBe('invalid_target');
    const bogus = await exchange('https://elsewhere.example');
    expect(await oauthError(bogus)).toBe('invalid_target');
    expect((await exchange(V2_RESOURCE)).status).toBe(200);
  });

  it('refuses to refresh into another resource', async () => {
    const tokens = await connect(owner, clientId, 'channels:read');
    const res = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: MCP_RESOURCE,
    });
    expect(await oauthError(res)).toBe('invalid_target');
    // Nothing was used up: the same refresh token still works for its own resource.
    const again = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(again.status).toBe(200);
  });

  it('leaves API keys working on both', async () => {
    const secret = (await createKey(owner, { scopes: ['channels:read'] })).secret;
    expect((await v2('GET', '/v2/channels', secret)).status).toBe(200);
    expect((await mcpList(secret)).status).toBe(200);
  });
});

describe('Client ID Metadata Documents', () => {
  const consentInfo = (query: Record<string, string>, session = owner) =>
    call('GET', `/api/v1/oauth/consent?${new URLSearchParams(query)}`, { cookie: session.cookie });

  it('hands /oauth/authorize straight to the consent page without fetching anything', async () => {
    const url = docUrl();
    doc(url);
    const { challenge } = pkce();
    const res = await authorize({
      clientId: url,
      scope: 'channels:read',
      challenge: await challenge(),
      redirectUri: 'http://127.0.0.1:50000/callback',
    });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/oauth/consent');
    expect(fetched).toEqual([]);
  });

  it('shows an error page for a client_id URL that can never be a document', async () => {
    for (const bad of [
      'https://agent.example',
      'https://agent.example/',
      'https://u:p@agent.example/c.json',
    ]) {
      const res = await authorize({
        clientId: bad,
        scope: 'channels:read',
        challenge: 'x'.repeat(43),
      });
      expect(res.status, bad).toBe(400);
    }
  });

  it('marks the client unverified on the consent page, with its host and a loopback warning', async () => {
    const url = docUrl();
    doc(url);
    const { challenge } = pkce();
    const query = authorizeQuery({
      clientId: url,
      scope: 'channels:read members:read',
      challenge: await challenge(),
      // Any port matches a loopback redirect in the document (RFC 8252).
      redirectUri: 'http://127.0.0.1:61234/callback',
      resource: MCP_RESOURCE,
    });
    const info = await data<ConsentInfo>(await consentInfo(query));
    expect(info.app).toMatchObject({
      name: 'Agent Desk',
      verified: false,
      registeredBy: null,
      clientHost: new URL(url).host,
      redirectHost: '127.0.0.1:61234',
      localRedirect: true,
      homepageUrl: 'https://agent.example',
    });
    expect(info.resource).toBe('mcp');
    // Cached: the second read does not fetch again.
    await data<ConsentInfo>(await consentInfo(query));
    expect(fetched).toEqual([url]);
  });

  it('runs the whole flow for an MCP client and keeps it out of the registered apps', async () => {
    const url = docUrl();
    doc(url);
    const redirectUri = 'http://127.0.0.1:40111/callback';
    const tokens = await connect(owner, url, 'channels:read', {
      resource: MCP_RESOURCE,
      redirectUri,
    });
    expect((await mcpList(tokens.access_token)).status).toBe(200);
    expect((await v2('GET', '/v2/channels', tokens.access_token)).status).toBe(401);

    const refreshed = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: url,
    });
    expect(refreshed.status).toBe(200);

    const grants = await data<OAuthGrant[]>(
      await call('GET', `/api/v1/workspaces/${owner.workspaceId}/oauth-grants`, {
        cookie: owner.cookie,
      }),
    );
    const grant = grants.find((g) => g.app.clientUrl === url)!;
    expect(grant).toMatchObject({ resource: 'mcp', app: { name: 'Agent Desk' } });
    const apps = await data<OAuthApp[]>(
      await call('GET', `/api/v1/workspaces/${owner.workspaceId}/oauth-apps`, {
        cookie: owner.cookie,
      }),
    );
    expect(apps.some((a) => a.name === 'Agent Desk')).toBe(false);
    // A second consent in the same workspace reuses the app row.
    await connect(owner, url, 'channels:read', { resource: MCP_RESOURCE, redirectUri });
    const rows = await env.DB.prepare(
      'SELECT count(*) AS n FROM oauth_apps WHERE metadata_url = ?1',
    )
      .bind(url)
      .first<{ n: number }>();
    expect(rows!.n).toBe(1);

    // Revoking access works like any app.
    const revoke = await call(
      'DELETE',
      `/api/v1/workspaces/${owner.workspaceId}/oauth-grants/${grant.id}`,
      { cookie: owner.cookie },
    );
    expect(revoke.status).toBe(204);
  });

  it('refuses secrets and other clients at the token endpoint', async () => {
    const url = docUrl();
    doc(url);
    const other = docUrl();
    doc(other);
    const redirectUri = 'https://agent.example/cb';
    const { verifier, challenge } = pkce();
    const query = authorizeQuery({
      clientId: url,
      scope: 'channels:read',
      challenge: await challenge(),
      redirectUri,
      resource: MCP_RESOURCE,
    });
    const consentRes = await call('POST', '/api/v1/oauth/consent', {
      cookie: owner.cookie,
      body: { ...query, decision: 'allow', workspaceId: owner.workspaceId },
    });
    const code = new URL(
      (await json<{ data: { redirectUrl: string } }>(consentRes)).data.redirectUrl,
    ).searchParams.get('code')!;
    const base = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: MCP_RESOURCE,
    };
    const withSecret = await form('/oauth/token', { ...base, client_id: url, client_secret: 'x' });
    expect(withSecret.status).toBe(401);
    const wrongClient = await form('/oauth/token', { ...base, client_id: other });
    expect(await oauthError(wrongClient)).toBe('invalid_grant');
    // A registered client can't redeem it either.
    expect(await oauthError(await form('/oauth/token', { ...base, client_id: clientId }))).toBe(
      'invalid_grant',
    );
    expect((await form('/oauth/token', { ...base, client_id: url })).status).toBe(200);
  });

  it('refuses documents that break the rules', async () => {
    const cases: [string, () => Response][] = [];
    const add = (body: unknown, init: ResponseInit = {}) => {
      const url = docUrl();
      cases.push([url, () => new Response(JSON.stringify(body), init)]);
      return url;
    };
    const valid = (url: string, extra: Record<string, unknown> = {}) => ({
      client_id: url,
      client_name: 'X',
      redirect_uris: ['https://agent.example/cb'],
      ...extra,
    });
    // client_id differs from the URL.
    add({ ...valid('https://someone-else.example/c.json') });
    for (const extra of [
      { client_secret: 's3cret' },
      { token_endpoint_auth_method: 'client_secret_basic' },
      { grant_types: ['client_credentials'] },
      { redirect_uris: ['myapp://cb'] },
      { redirect_uris: ['https://*.agent.example/cb'] },
    ]) {
      const url = docUrl();
      cases.push([url, () => new Response(JSON.stringify(valid(url, extra)))]);
    }
    // A redirect, an error status, not JSON, too large.
    const redirecting = docUrl();
    cases.push([
      redirecting,
      () => new Response(null, { status: 302, headers: { location: 'https://x.example/c.json' } }),
    ]);
    const missing = docUrl();
    cases.push([missing, () => new Response('nope', { status: 500 })]);
    const notJson = docUrl();
    cases.push([notJson, () => new Response('<html>')]);
    const huge = docUrl();
    cases.push([
      huge,
      () => new Response(JSON.stringify({ ...valid(huge), padding: 'x'.repeat(6000) })),
    ]);
    const session = await signIn();
    for (const [url, answer] of cases) {
      documents.set(url, answer);
      const { challenge } = pkce();
      const res = await consentInfo(
        authorizeQuery({
          clientId: url,
          scope: 'channels:read',
          challenge: await challenge(),
          redirectUri: 'https://agent.example/cb',
        }),
        session,
      );
      expect(res.status, url).toBe(400);
    }
  });

  it('refuses a redirect URI the document does not list, and private hosts without fetching', async () => {
    const url = docUrl();
    doc(url);
    const { challenge } = pkce();
    const res = await consentInfo(
      authorizeQuery({
        clientId: url,
        scope: 'channels:read',
        challenge: await challenge(),
        redirectUri: 'https://evil.example/cb',
      }),
    );
    expect(res.status).toBe(400);
    fetched.length = 0;
    for (const host of [
      'https://localhost/c.json',
      'https://10.0.0.1/c.json',
      'https://intranet/c.json',
    ]) {
      const blocked = await consentInfo(
        authorizeQuery({ clientId: host, scope: 'channels:read', challenge: await challenge() }),
      );
      expect(blocked.status, host).toBe(400);
    }
    expect(fetched).toEqual([]);
  });

  it('limits how many documents one operator can have fetched in an hour', async () => {
    const session = await signIn();
    const { challenge } = pkce();
    const value = await challenge();
    let limited = false;
    for (let i = 0; i < 21; i++) {
      const url = docUrl();
      doc(url);
      const res = await consentInfo(
        authorizeQuery({
          clientId: url,
          scope: 'channels:read',
          challenge: value,
          redirectUri: 'https://agent.example/cb',
        }),
        session,
      );
      if (i < 20) expect(res.status, String(i)).toBe(200);
      else {
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('Too many');
        limited = true;
      }
    }
    expect(limited).toBe(true);
  });

  it('needs a signed-in operator to fetch', async () => {
    const url = docUrl();
    doc(url);
    const res = await call(
      'GET',
      `/api/v1/oauth/consent?${new URLSearchParams(
        authorizeQuery({ clientId: url, scope: 'channels:read', challenge: 'x'.repeat(43) }),
      )}`,
    );
    expect(res.status).toBe(401);
    expect(fetched).toEqual([]);
  });
});

describe('the channel the token reaches', () => {
  it('gives an unreviewed app the MCP server only, never the API directly', async () => {
    const url = docUrl();
    doc(url);
    const { challenge } = pkce();
    for (const resource of [V2_RESOURCE, undefined]) {
      const refused = await call('POST', '/api/v1/oauth/consent', {
        cookie: owner.cookie,
        body: {
          ...authorizeQuery({
            clientId: url,
            scope: 'webhooks:write members:write',
            challenge: await challenge(),
            redirectUri: 'https://agent.example/cb',
            ...(resource ? { resource } : {}),
          }),
          decision: 'allow',
          workspaceId: owner.workspaceId,
        },
      });
      expect(refused.status, String(resource)).toBe(403);
      expect(await refused.text()).toContain('MCP server');
    }
    // No grant was made for it.
    const grants = await env.DB.prepare(
      `SELECT count(*) AS n FROM oauth_grants g JOIN oauth_apps a ON a.id = g.app_id
        WHERE a.metadata_url = ?1`,
    )
      .bind(url)
      .first<{ n: number }>();
    expect(grants?.n).toBe(0);
    // Through the MCP server, where holds apply, it connects.
    const tokens = await connect(owner, url, 'channels:read', {
      resource: MCP_RESOURCE,
      redirectUri: 'https://agent.example/cb',
      channelIds: [channelId],
    });
    expect((await mcpList(tokens.access_token)).status).toBe(200);
    expect((await v2('GET', '/v2/channels', tokens.access_token)).status).toBe(401);
  });

  it('still lets an app the workspace registered itself use the API directly', async () => {
    const tokens = await connect(owner, clientId, 'channels:read', { resource: V2_RESOURCE });
    expect((await v2('GET', '/v2/channels', tokens.access_token)).status).toBe(200);
  });
});
