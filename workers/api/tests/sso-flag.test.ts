// The sso flag (off by default, read at platform scope). Off: every SSO route in the document
// answers feature_disabled, whoever asks and whatever they send, and an enforced connection left
// behind locks nobody out. On: the routes answer again, with plan gating still in place. The full
// sign-in flow, with the flag on, is in sso.test.ts.
import { env } from 'cloudflare:test';
import { newId, type SeatRole } from '@swarm/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, openApiDocument } from '../src/app';
import { call, createChannel, json, signIn, uniqueEmail, type Session } from './helpers';

const ISSUER = 'https://idp.test';

interface Operation {
  key: string;
  method: string;
  path: string;
}

const OPERATIONS: Operation[] = Object.entries(openApiDocument(createApp()).paths ?? {})
  .filter(([path]) => /sso/.test(path))
  .flatMap(([path, item]) =>
    Object.keys(item as Record<string, unknown>).map((method) => ({
      key: `${method.toUpperCase()} ${path}`,
      method: method.toUpperCase(),
      path,
    })),
  );

const isPublic = (op: Operation) => op.path.startsWith('/api/v1/auth/sso/');

async function setSso(enabled: boolean) {
  await env.DB.prepare("DELETE FROM feature_flags WHERE key = 'sso' AND scope = 'platform'").run();
  if (enabled) {
    await env.DB.prepare(
      `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
       VALUES (?1, 'sso', 'platform', NULL, 1, ?2)`,
    )
      .bind(newId('featureFlag'), Date.now())
      .run();
  }
  await env.CACHE.delete('flags:v1:-:-');
}

/** A workspace on a plan with SSO, with an active connection and a verified domain, as SQL rows. */
async function workspaceWithConnection(options: { enforced?: boolean } = {}) {
  const owner = await signIn();
  await env.DB.prepare("UPDATE workspaces SET plan = 'enterprise' WHERE id = ?1")
    .bind(owner.workspaceId)
    .run();
  const connectionId = newId('ssoConnection');
  const domainId = newId('ssoDomain');
  const domain = `corp-${crypto.randomUUID().slice(0, 8)}.test`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sso_connections (id, workspace_id, protocol, domains_json, config_json, jit_role,
                                  enforced, status, created_at, updated_at)
     VALUES (?1, ?2, 'oidc', ?3, ?4, 'editor', ?5, 'active', ?6, ?6)`,
  )
    .bind(
      connectionId,
      owner.workspaceId,
      JSON.stringify([domain]),
      JSON.stringify({ issuer: ISSUER, clientId: 'client', clientSecretEnc: '' }),
      options.enforced ? 1 : 0,
      now,
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO sso_domains (id, connection_id, workspace_id, domain, verification_token, verified_at, created_at)
     VALUES (?1, ?2, ?3, ?4, 'token', ?5, ?5)`,
  )
    .bind(domainId, connectionId, owner.workspaceId, domain, now)
    .run();
  return { owner, connectionId, domainId, domain };
}

async function seatIn(workspaceId: string, session: Session, role: SeatRole) {
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)',
  )
    .bind(newId('seat'), workspaceId, session.me.operator.id, role, now)
    .run();
}

const connectionCount = async (id: string) =>
  (
    await env.DB.prepare('SELECT COUNT(*) AS n FROM sso_connections WHERE id = ?1')
      .bind(id)
      .first<{ n: number }>()
  )?.n;

beforeEach(() => setSso(false));

describe('with the sso flag off', () => {
  it('finds every SSO operation in the document', () => {
    expect(OPERATIONS.map((op) => op.key).sort()).toEqual(
      [
        'GET /api/v1/workspaces/{workspaceId}/sso-connections',
        'POST /api/v1/workspaces/{workspaceId}/sso-connections',
        'PATCH /api/v1/sso-connections/{connectionId}',
        'DELETE /api/v1/sso-connections/{connectionId}',
        'POST /api/v1/sso-connections/{connectionId}/domains',
        'POST /api/v1/sso-connections/{connectionId}/domains/{domainId}/verify',
        'DELETE /api/v1/sso-connections/{connectionId}/domains/{domainId}',
        'GET /api/v1/auth/sso/start',
        'POST /api/v1/auth/sso/start',
        'GET /api/v1/auth/sso/callback',
      ].sort(),
    );
  });

  it('is off by default on the public flags route', async () => {
    const res = await call('GET', '/api/v1/flags', { origin: null });
    expect((await json<{ data: { flags: Record<string, boolean> } }>(res)).data.flags.sso).toBe(
      false,
    );
  });

  it.each(OPERATIONS.map((op) => [op.key, op] as const))(
    '%s answers feature_disabled, on a plan that includes SSO',
    async (_, op) => {
      const { owner, connectionId, domainId } = await workspaceWithConnection();
      const url = op.path
        .replace('{workspaceId}', owner.workspaceId)
        .replace('{connectionId}', connectionId)
        .replace('{domainId}', domainId);
      // No query and an empty body: refused for the flag, before the input is looked at.
      const res = await call(op.method, url, {
        cookie: owner.cookie,
        ...(['POST', 'PATCH'].includes(op.method) ? { body: {} } : {}),
      });
      expect(res.status, await res.clone().text()).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: 'feature_disabled' } });
      expect(await connectionCount(connectionId)).toBe(1);
    },
  );

  it.each(OPERATIONS.filter(isPublic).map((op) => [op.key, op] as const))(
    '%s refuses a signed-out browser, and starts nothing for a captured address',
    async (_, op) => {
      const { domain } = await workspaceWithConnection();
      const res = await call(
        op.method,
        `${op.path}?email=${encodeURIComponent(`f@${domain}`)}&code=c&state=s`,
        { origin: null },
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: 'feature_disabled' } });
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('set-cookie')).toBeNull();
    },
  );

  it('still answers 401 to a signed-out caller of the management routes', async () => {
    const { connectionId } = await workspaceWithConnection();
    const res = await call('PATCH', `/api/v1/sso-connections/${connectionId}`, { body: {} });
    expect(res.status).toBe(401);
  });

  it('is not turned on by a workspace override', async () => {
    const { owner } = await workspaceWithConnection();
    await env.DB.prepare(
      `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
       VALUES (?1, 'sso', 'workspace', ?2, 1, ?3)`,
    )
      .bind(newId('featureFlag'), owner.workspaceId, Date.now())
      .run();
    await env.CACHE.delete(`flags:v1:${owner.workspaceId}:-`);
    const res = await call('GET', `/api/v1/workspaces/${owner.workspaceId}/sso-connections`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'feature_disabled' } });
  });
});

describe('an enforced connection', () => {
  async function capturedEditor() {
    const { owner, domain } = await workspaceWithConnection({ enforced: true });
    const channel = await createChannel(owner);
    const editor = await signIn(uniqueEmail('f').replace(/@.*/, `@${domain}`));
    await seatIn(owner.workspaceId, editor, 'editor');
    return {
      cookie: editor.cookie,
      workspace: `/api/v1/workspaces/${owner.workspaceId}/seats`,
      channel: `/api/v1/channels/${channel.id}/flags`,
    };
  }

  it('locks nobody out while the flag is off, since nobody could sign in through it', async () => {
    const { cookie, workspace, channel } = await capturedEditor();
    expect((await call('GET', workspace, { cookie })).status).toBe(200);
    expect((await call('GET', channel, { cookie })).status).toBe(200);
  });

  it('applies again once the flag is on', async () => {
    const { cookie, workspace, channel } = await capturedEditor();
    await setSso(true);
    for (const path of [workspace, channel]) {
      const blocked = await call('GET', path, { cookie });
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toMatchObject({
        error: { details: [{ path: 'sso', message: 'sso_required' }] },
      });
    }
  });
});

describe('with the sso flag on', () => {
  beforeEach(() => setSso(true));

  it('reports it on the public flags route', async () => {
    const res = await call('GET', '/api/v1/flags', { origin: null });
    expect((await json<{ data: { flags: Record<string, boolean> } }>(res)).data.flags.sso).toBe(
      true,
    );
  });

  it('serves the management routes', async () => {
    const { owner, connectionId } = await workspaceWithConnection();
    const list = await call('GET', `/api/v1/workspaces/${owner.workspaceId}/sso-connections`, {
      cookie: owner.cookie,
    });
    expect(list.status).toBe(200);
    expect((await json<{ data: { id: string }[] }>(list)).data.map((c) => c.id)).toEqual([
      connectionId,
    ]);
    const add = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/sso-connections`, {
      cookie: owner.cookie,
      body: { issuer: ISSUER, clientId: 'client', clientSecret: 'secret' },
    });
    expect(add.status, await add.clone().text()).toBe(201);
    const remove = await call('DELETE', `/api/v1/sso-connections/${connectionId}`, {
      cookie: owner.cookie,
    });
    expect(remove.status).toBe(204);
  });

  it('keeps the plan gate', async () => {
    const free = await signIn();
    const res = await call('POST', `/api/v1/workspaces/${free.workspaceId}/sso-connections`, {
      cookie: free.cookie,
      body: { issuer: ISSUER, clientId: 'client', clientSecret: 'secret' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'plan_required' } });
  });

  it('starts sign-in at the identity provider for a captured address', async () => {
    const { domain } = await workspaceWithConnection();
    // After signing in, which needs the Turnstile answer from setup.ts.
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      }),
    );
    const res = await call(
      'GET',
      `/api/v1/auth/sso/start?email=${encodeURIComponent(`f@${domain}`)}`,
      { origin: null, headers: { 'sec-fetch-site': 'same-origin' } },
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') as string).origin).toBe(ISSUER);
  });

  it('sends an address no connection captures back to sign-in', async () => {
    const res = await call('GET', '/api/v1/auth/sso/start?email=nobody%40nowhere.test', {
      origin: null,
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') as string).searchParams.get('error')).toBe(
      'sso_unknown',
    );
  });

  it('runs the callback, which refuses a browser without the state cookie', async () => {
    const res = await call('GET', '/api/v1/auth/sso/callback?code=c&state=s', { origin: null });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') as string).searchParams.get('error')).toBe(
      'sso_cancelled',
    );
  });
});
