// OAuth apps and the authorization-code flow, for the OAuth and Direct Send tests.
import { SELF, env } from 'cloudflare:test';
import type { ApiScope, OAuthAppWithSecret, Plan } from '@swarm/domain';
import { base64UrlEncode } from '@swarm/tokens';
import { expect } from 'vitest';
import { call, json, type Session } from './helpers';

export const REDIRECT = 'https://app.example/callback';
/** APP_ORIGIN in the test config; resource indicators name it. */
export const ORIGIN = 'http://localhost:5273';
export const MCP_RESOURCE = `${ORIGIN}/mcp`;
export const V2_RESOURCE = `${ORIGIN}/v2`;

export async function setPlan(workspaceId: string, plan: Plan) {
  await env.DB.prepare('UPDATE workspaces SET plan = ?1 WHERE id = ?2')
    .bind(plan, workspaceId)
    .run();
}

export async function createApp(
  s: Session,
  body: {
    scopes: ApiScope[];
    clientType?: 'public' | 'confidential';
    redirectUris?: string[];
    name?: string;
  },
): Promise<OAuthAppWithSecret> {
  const res = await call('POST', `/api/v1/workspaces/${s.workspaceId}/oauth-apps`, {
    cookie: s.cookie,
    body: { name: 'Sync tool', clientType: 'public', redirectUris: [REDIRECT], ...body },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await json<{ data: OAuthAppWithSecret }>(res)).data;
}

export function pkce() {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(48)));
  return {
    verifier,
    challenge: async () =>
      base64UrlEncode(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
      ),
  };
}

interface AuthorizeInput {
  clientId: string;
  scope: string;
  challenge?: string | null;
  method?: string | null;
  redirectUri?: string;
  state?: string;
  /** RFC 8707 resource; omitted means /v2. */
  resource?: string;
}

export function authorizeQuery(input: AuthorizeInput): Record<string, string> {
  const query: Record<string, string> = {
    client_id: input.clientId,
    redirect_uri: input.redirectUri ?? REDIRECT,
    response_type: 'code',
    scope: input.scope,
    state: input.state ?? 'st-123',
  };
  if (input.challenge) query.code_challenge = input.challenge;
  if (input.method !== null) query.code_challenge_method = input.method ?? 'S256';
  if (input.resource !== undefined) query.resource = input.resource;
  return query;
}

export const authorize = (input: AuthorizeInput) =>
  SELF.fetch(`http://localhost/oauth/authorize?${new URLSearchParams(authorizeQuery(input))}`, {
    redirect: 'manual',
  });

/** The operator's decision; returns the URL the browser is sent to. */
export async function consent(
  s: Session,
  input: AuthorizeInput,
  extra: { decision?: 'allow' | 'deny'; workspaceId?: string; channelIds?: string[] | null } = {},
): Promise<URL> {
  const res = await call('POST', '/api/v1/oauth/consent', {
    cookie: s.cookie,
    body: {
      ...authorizeQuery(input),
      decision: extra.decision ?? 'allow',
      workspaceId: extra.workspaceId ?? s.workspaceId,
      ...(extra.channelIds !== undefined ? { channelIds: extra.channelIds } : {}),
    },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return new URL((await json<{ data: { redirectUrl: string } }>(res)).data.redirectUrl);
}

export function form(
  path: '/oauth/token' | '/oauth/revoke',
  params: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return SELF.fetch(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params),
  });
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

/** Runs the whole flow (authorize → consent → token) and returns the tokens. */
export async function connect(
  s: Session,
  clientId: string,
  scope: string,
  extra: {
    channelIds?: string[] | null;
    workspaceId?: string;
    resource?: string;
    redirectUri?: string;
  } = {},
): Promise<Tokens & { code: string; verifier: string }> {
  const { verifier, challenge } = pkce();
  const input = {
    clientId,
    scope,
    challenge: await challenge(),
    ...(extra.resource !== undefined ? { resource: extra.resource } : {}),
    ...(extra.redirectUri !== undefined ? { redirectUri: extra.redirectUri } : {}),
  };
  const url = await consent(s, input, extra);
  const code = url.searchParams.get('code')!;
  expect(code).toBeTruthy();
  const res = await form('/oauth/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: extra.redirectUri ?? REDIRECT,
    code_verifier: verifier,
    client_id: clientId,
    ...(extra.resource !== undefined ? { resource: extra.resource } : {}),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return { ...(await res.json<Tokens>()), code, verifier };
}

export const v2 = (method: string, path: string, token: string, body?: unknown) =>
  SELF.fetch(`http://localhost${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

export async function oauthError(res: Response): Promise<string> {
  return (await res.json<{ error: string }>()).error;
}
