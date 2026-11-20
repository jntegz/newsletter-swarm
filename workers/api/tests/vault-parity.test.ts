// The api and the vault agree on who a credential is: for the same API keys and sessions, the
// api's /v2 and dashboard routes and the vault's own check (which the api will pass the
// credential to, @swarm/vault) let in and turn away the same ones. Both resolve keys with the
// lookups in @swarm/db credentials.ts; this keeps the rules on top of them from drifting.
import { env } from 'cloudflare:test';
import { createFakeVault, fakeVaultEnv } from '@swarm/vault';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, seatAs, signIn, type Session } from './helpers';
import { createKey, setPlan, v2 } from './v2-helpers';

let owner: Session;
let channelId: string;
let vault: ReturnType<typeof createFakeVault<'api'>>;

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  await setPlan(owner.workspaceId, 'pro');
  vault = createFakeVault('api', await fakeVaultEnv(env.DB));
});

const vaultLets = async (principal: Parameters<typeof vault.openMemberFields>[0]) =>
  (await vault.openMemberFields(principal, { channelId, memberIds: [] })).ok;

const sessionToken = (s: Session) => decodeURIComponent(s.cookie.split('=').slice(1).join('='));

describe('who a credential is, in the api and in the vault', () => {
  it('agrees on API keys: live, revoked, expired, limited to another Channel, out of scope', async () => {
    const other = (await createChannel(owner)).id;
    const cases: { name: string; secret: string }[] = [];
    const add = async (name: string, body: Parameters<typeof createKey>[1]) =>
      cases.push({ name, secret: (await createKey(owner, body)).secret });
    await add('members:read', { scopes: ['members:read'] });
    await add('members:write', { scopes: ['members:write'] });
    await add('other scope', { scopes: ['sends:write'] });
    await add('other Channel', { scopes: ['members:read'], channelIds: [other] });
    await add('this Channel', { scopes: ['members:read'], channelIds: [channelId] });
    await add('revoked', { scopes: ['members:read'] });
    await env.DB.prepare(
      'UPDATE api_keys SET revoked_at = ?1 WHERE secret_hash = (SELECT secret_hash FROM api_keys ORDER BY created_at DESC LIMIT 1)',
    )
      .bind(Date.now())
      .run();
    await add('expired', { scopes: ['members:read'] });
    await env.DB.prepare(
      'UPDATE api_keys SET expires_at = ?1 WHERE secret_hash = (SELECT secret_hash FROM api_keys ORDER BY created_at DESC LIMIT 1)',
    )
      .bind(Date.now() - 1)
      .run();
    for (const { name, secret } of cases) {
      const api = (await v2('GET', `/v2/channels/${channelId}/members`, secret)).status === 200;
      expect(await vaultLets({ kind: 'api-key', secret }), name).toBe(api);
    }
    expect(cases.map((c) => c.name)).toHaveLength(7);
  });

  it('agrees once the admin behind a key is no longer an admin', async () => {
    const admin = await seatAs(owner.workspaceId, 'admin');
    const { secret } = await createKey(
      { ...admin, workspaceId: owner.workspaceId },
      { scopes: ['members:read'] },
    );
    expect((await v2('GET', `/v2/channels/${channelId}/members`, secret)).status).toBe(200);
    expect(await vaultLets({ kind: 'api-key', secret })).toBe(true);
    await env.DB.prepare("UPDATE seats SET role = 'editor' WHERE operator_id = ?1")
      .bind(admin.me.operator.id)
      .run();
    expect((await v2('GET', `/v2/channels/${channelId}/members`, secret)).status).toBe(401);
    expect(await vaultLets({ kind: 'api-key', secret })).toBe(false);
  });

  it('agrees on sessions: a seat in the workspace, none, and a signed-out one', async () => {
    const viewer = await seatAs(owner.workspaceId, 'viewer');
    const stranger = await signIn();
    const members = (s: Session) =>
      call('GET', `/api/v1/channels/${channelId}/members`, { cookie: s.cookie });
    for (const s of [owner, viewer, stranger]) {
      const api = (await members(s)).status === 200;
      expect(await vaultLets({ kind: 'operator-session', sessionToken: sessionToken(s) })).toBe(
        api,
      );
    }
    await call('POST', '/api/v1/auth/logout', { cookie: viewer.cookie });
    expect((await members(viewer)).status).not.toBe(200);
    expect(await vaultLets({ kind: 'operator-session', sessionToken: sessionToken(viewer) })).toBe(
      false,
    );
  });
});
