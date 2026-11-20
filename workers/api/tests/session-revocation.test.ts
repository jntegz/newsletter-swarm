// Revocation wins over the session cache: a cached copy of a revoked session is never honoured,
// even one written back after the revocation by a request that read the row just before it
// (S04-P1-V-session-late-cache-write). Real KV propagation is not shown here.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/lib/crypto';
import { call, json, seatAs, signIn, type Session } from './helpers';

const cacheKey = async (cookie: string) => `sess:v2:${await sha256Hex(cookie.split('=')[1]!)}`;

/** The cached copy of a session as a concurrent reader would have seen it. */
async function captureCache(session: Session): Promise<{ key: string; value: string }> {
  expect((await call('GET', '/api/v1/auth/session', { cookie: session.cookie })).status).toBe(200);
  const key = await cacheKey(session.cookie);
  const value = await env.CACHE.get(key);
  expect(value).toBeTruthy();
  return { key, value: value as string };
}

async function refusedWithStaleCache(session: Session, captured: { key: string; value: string }) {
  // A late writer puts the entry back after the revocation deleted it.
  await env.CACHE.put(captured.key, captured.value, { expirationTtl: 300 });
  const own = await call('GET', '/api/v1/auth/session', { cookie: session.cookie });
  expect(own.status).toBe(401);
  expect(JSON.stringify(await own.json())).not.toContain(session.email);
  const workspace = await call('GET', `/api/v1/workspaces/${session.workspaceId}/seats`, {
    cookie: session.cookie,
  });
  expect(workspace.status).toBe(401);
}

describe('session revocation and the cache', () => {
  it('sign out everywhere: a restored cache entry does not bring the session back', async () => {
    const victim = await signIn();
    const other = { ...victim, cookie: (await signIn(victim.email)).cookie };
    const captured = await captureCache(victim);
    const out = await call('POST', '/api/v1/auth/sessions/sign-out-everywhere', {
      cookie: other.cookie,
      body: { keepCurrent: true },
    });
    expect(out.status).toBe(200);
    await refusedWithStaleCache(victim, captured);
    // The session that was kept goes on working.
    expect((await call('GET', '/api/v1/auth/session', { cookie: other.cookie })).status).toBe(200);
  });

  it('removing one device: a restored cache entry does not bring it back', async () => {
    const victim = await signIn();
    const other = { ...victim, cookie: (await signIn(victim.email)).cookie };
    const captured = await captureCache(victim);
    const list = await call('GET', '/api/v1/auth/sessions', { cookie: other.cookie });
    const sessions = (await json<{ data: { id: string; current: boolean }[] }>(list)).data;
    const target = sessions.find((s) => !s.current);
    expect(target).toBeTruthy();
    const removed = await call('DELETE', `/api/v1/auth/sessions/${target!.id}`, {
      cookie: other.cookie,
    });
    expect(removed.status).toBe(204);
    await refusedWithStaleCache(victim, captured);
  });

  it("a teammate's role change: a restored cache entry does not bring the old token back", async () => {
    const owner = await signIn();
    const teammate = { ...(await seatAs(owner.workspaceId, 'editor')) };
    const captured = await captureCache(teammate);
    const seats = await call('GET', `/api/v1/workspaces/${owner.workspaceId}/seats`, {
      cookie: owner.cookie,
    });
    const seat = (
      await json<{ data: { id: string; operator: { id: string } }[] }>(seats)
    ).data.find((s) => s.operator.id === teammate.me.operator.id);
    const changed = await call(
      'PATCH',
      `/api/v1/workspaces/${owner.workspaceId}/seats/${seat!.id}`,
      { cookie: owner.cookie, body: { role: 'viewer' } },
    );
    expect(changed.status, await changed.clone().text()).toBe(200);
    await refusedWithStaleCache(teammate, captured);
  });
});
