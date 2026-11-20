import { env } from 'cloudflare:test';
import { API_KEY_PATTERN, type ApiKey, type AuditEvent } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { data } from './audience-helpers';
import { call, createChannel, json, seatAs, signIn, type Session } from './helpers';
import { createKey, setPlan, v2 } from './v2-helpers';

let owner: Session;
let channelId: string;

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  await setPlan(owner.workspaceId, 'pro');
});

const keysPath = (s: Session) => `/api/v1/workspaces/${s.workspaceId}/api-keys`;

describe('API keys (dashboard)', () => {
  it('creates a key, shows the secret once and stores only its hash', async () => {
    const { key, secret } = await createKey(owner, {
      name: 'Zapier sync',
      scopes: ['members:read', 'members:write', 'members:read'],
      channelIds: [channelId],
      ipAllowlist: ['203.0.113.7', '2001:DB8::/32'],
      rateCap: 120,
    });
    expect(secret).toMatch(API_KEY_PATTERN);
    expect(key).toMatchObject({
      name: 'Zapier sync',
      prefix: secret.slice(8, 16),
      scopes: ['members:read', 'members:write'],
      channelIds: [channelId],
      ipAllowlist: ['203.0.113.7/32', '2001:db8::/32'],
      rateCap: 120,
      status: 'active',
      lastUsedAt: null,
      createdBy: { id: owner.me.operator.id, email: owner.email },
    });
    const row = await env.DB.prepare('SELECT * FROM api_keys WHERE id = ?1')
      .bind(key.id)
      .first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(secret.slice(8));
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)),
    );
    expect(row?.secret_hash).toBe([...digest].map((b) => b.toString(16).padStart(2, '0')).join(''));

    const list = await data<ApiKey[]>(await call('GET', keysPath(owner), { cookie: owner.cookie }));
    expect(list.find((k) => k.id === key.id)).toMatchObject({ prefix: key.prefix });
    expect(JSON.stringify(list)).not.toContain(secret);
  });

  it('validates scopes, Channels, ranges, the cap and the expiry', async () => {
    const bad = async (body: Record<string, unknown>) =>
      (await call('POST', keysPath(owner), { cookie: owner.cookie, body: { name: 'x', ...body } }))
        .status;
    expect(await bad({ scopes: [] })).toBe(400);
    expect(await bad({ scopes: ['members:destroy'] })).toBe(400);
    expect(await bad({ scopes: ['members:read'], ipAllowlist: ['300.1.1.1'] })).toBe(400);
    expect(await bad({ scopes: ['members:read'], ipAllowlist: ['10.0.0.1/24'] })).toBe(400);
    expect(await bad({ scopes: ['members:read'], ipAllowlist: ['2001:db8:::1'] })).toBe(400);
    // Pro allows 600 a minute.
    expect(await bad({ scopes: ['members:read'], rateCap: 601 })).toBe(400);
    expect(await bad({ scopes: ['members:read'], expiresAt: '2020-01-01T00:00:00.000Z' })).toBe(
      400,
    );
    const other = await signIn();
    const foreign = (await createChannel(other)).id;
    expect(await bad({ scopes: ['members:read'], channelIds: [foreign] })).toBe(400);
  });

  it('enforces the plan’s number of active keys', async () => {
    const s = await signIn();
    // Free: 2 active keys. Revoking one frees a place.
    const first = await createKey(s, { scopes: ['channels:read'] });
    await createKey(s, { scopes: ['channels:read'] });
    const third = await call('POST', keysPath(s), {
      cookie: s.cookie,
      body: { name: 'Third', scopes: ['channels:read'] },
    });
    expect(third.status).toBe(409);
    expect(
      (await call('DELETE', `${keysPath(s)}/${first.key.id}`, { cookie: s.cookie })).status,
    ).toBe(204);
    await createKey(s, { scopes: ['channels:read'] });
  });

  it('updates name, scopes, Channels, allowlist and cap; a revoked key can’t change', async () => {
    const { key, secret } = await createKey(owner, { scopes: ['channels:read'] });
    const updated = await data<ApiKey>(
      await call('PATCH', `${keysPath(owner)}/${key.id}`, {
        cookie: owner.cookie,
        body: {
          name: 'Renamed',
          scopes: ['members:read'],
          channelIds: [channelId],
          ipAllowlist: null,
          rateCap: 30,
        },
      }),
    );
    expect(updated).toMatchObject({ name: 'Renamed', scopes: ['members:read'], rateCap: 30 });
    // The change applies to the next request.
    expect((await v2('GET', '/v2/channels', secret)).status).toBe(403);
    expect((await v2('GET', `/v2/channels/${channelId}/members`, secret)).status).toBe(200);

    expect(
      (await call('DELETE', `${keysPath(owner)}/${key.id}`, { cookie: owner.cookie })).status,
    ).toBe(204);
    expect(
      (await call('DELETE', `${keysPath(owner)}/${key.id}`, { cookie: owner.cookie })).status,
    ).toBe(204);
    expect((await v2('GET', `/v2/channels/${channelId}/members`, secret)).status).toBe(401);
    const patch = await call('PATCH', `${keysPath(owner)}/${key.id}`, {
      cookie: owner.cookie,
      body: { name: 'Again' },
    });
    expect(patch.status).toBe(409);
  });

  it('needs the admin role and hides other workspaces', async () => {
    const editor = await seatAs(owner.workspaceId, 'editor');
    expect((await call('GET', keysPath(owner), { cookie: editor.cookie })).status).toBe(403);
    const admin = await seatAs(owner.workspaceId, 'admin');
    expect((await call('GET', keysPath(owner), { cookie: admin.cookie })).status).toBe(200);
    const outsider = await signIn();
    expect((await call('GET', keysPath(owner), { cookie: outsider.cookie })).status).toBe(404);
    const { key } = await createKey(owner, { scopes: ['channels:read'] });
    const foreign = await call(
      'DELETE',
      `/api/v1/workspaces/${outsider.workspaceId}/api-keys/${key.id}`,
      { cookie: outsider.cookie },
    );
    expect(foreign.status).toBe(404);
  });

  it('audits create, update and revoke without the secret', async () => {
    const { key, secret } = await createKey(owner, { scopes: ['channels:read'], name: 'Audited' });
    await call('PATCH', `${keysPath(owner)}/${key.id}`, {
      cookie: owner.cookie,
      body: { name: 'Audited 2' },
    });
    await call('DELETE', `${keysPath(owner)}/${key.id}`, { cookie: owner.cookie });
    const log = await json<{ data: { items: AuditEvent[] } }>(
      await call('GET', `/api/v1/workspaces/${owner.workspaceId}/audit?limit=100`, {
        cookie: owner.cookie,
      }),
    );
    const actions = log.data.items.filter((e) => e.targetId === key.id).map((e) => e.action);
    expect(actions).toEqual(['api_key.revoked', 'api_key.updated', 'api_key.created']);
    expect(JSON.stringify(log)).not.toContain(secret.slice(8));
  });
});

describe('resolving a key', () => {
  it('refuses expired keys, keys outside their allowlist and malformed keys alike', async () => {
    const { key, secret } = await createKey(owner, { scopes: ['channels:read'] });
    expect((await v2('GET', '/v2/channels', secret)).status).toBe(200);
    await env.DB.prepare('UPDATE api_keys SET expires_at = ?1 WHERE id = ?2')
      .bind(Date.now() - 1, key.id)
      .run();
    const expired = await v2('GET', '/v2/channels', secret);
    expect(expired.status).toBe(401);
    expect((await json<{ error: { code: string } }>(expired)).error.code).toBe('unauthorized');

    const fenced = await createKey(owner, {
      scopes: ['channels:read'],
      ipAllowlist: ['198.51.100.0/24', '2001:db8:1::/48'],
    });
    expect((await v2('GET', '/v2/channels', fenced.secret, { ip: '198.51.100.9' })).status).toBe(
      200,
    );
    expect(
      (await v2('GET', '/v2/channels', fenced.secret, { ip: '2001:db8:1:ff::1' })).status,
    ).toBe(200);
    expect(
      (await v2('GET', '/v2/channels', fenced.secret, { ip: '::ffff:198.51.100.10' })).status,
    ).toBe(200);
    expect((await v2('GET', '/v2/channels', fenced.secret, { ip: '198.51.101.9' })).status).toBe(
      401,
    );
    expect((await v2('GET', '/v2/channels', fenced.secret)).status).toBe(401);
    expect((await v2('GET', '/v2/channels', 'sk_live_short')).status).toBe(401);
    expect((await v2('GET', '/v2/channels', `${secret.slice(0, -1)}X`)).status).toBe(401);
  });

  it('records last use at most once a minute', async () => {
    const { key, secret } = await createKey(owner, { scopes: ['channels:read'] });
    await v2('GET', '/v2/channels', secret, { ip: '192.0.2.44' });
    const read = () =>
      env.DB.prepare('SELECT last_used_at, last_used_ip_prefix FROM api_keys WHERE id = ?1')
        .bind(key.id)
        .first<{ last_used_at: number; last_used_ip_prefix: string }>();
    const firstUse = await read();
    expect(firstUse?.last_used_ip_prefix).toBe('192.0.2.0/24');
    await v2('GET', '/v2/channels', secret, { ip: '192.0.2.45' });
    expect((await read())?.last_used_at).toBe(firstUse?.last_used_at);
    // A minute later it is written again.
    await env.DB.prepare('UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2')
      .bind(Date.now() - 61_000, key.id)
      .run();
    await v2('GET', '/v2/channels', secret, { ip: '192.0.2.45' });
    expect((await read())?.last_used_at).toBeGreaterThan(Date.now() - 5000);
  });
});
