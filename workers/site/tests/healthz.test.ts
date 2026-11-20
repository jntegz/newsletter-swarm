import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const MEDIA_KEY = `ws/ws_${'a'.repeat(32)}/ch/ch_${'b'.repeat(32)}/md_${'c'.repeat(32)}.png`;
const hex = () => crypto.randomUUID().replace(/-/g, '');

async function seedChannel(slug: string, status = 'active', deleted = false) {
  const workspaceId = `ws_${hex()}`;
  const channelId = `ch_${hex()}`;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, 0, 0)',
    ).bind(workspaceId, 'W'),
    env.DB.prepare(
      'INSERT INTO channels (id, workspace_id, slug, name, status, created_at, updated_at, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6)',
    ).bind(channelId, workspaceId, slug, 'Field Notes', status, deleted ? 1 : null),
  ]);
  return { workspaceId, channelId };
}

async function addHostname(
  channelId: string,
  workspaceId: string,
  hostname: string,
  role: 'web' | 'apex_redirect',
  primary = false,
) {
  await env.DB.prepare(
    `INSERT INTO custom_hostnames (id, workspace_id, channel_id, hostname, role, status, is_primary, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, 0, 0)`,
  )
    .bind(`hn_${hex()}`, workspaceId, channelId, hostname, role, primary ? 1 : 0)
    .run();
}

const get = (url: string) => SELF.fetch(url, { redirect: 'manual' });

describe('site worker', () => {
  it('reports healthy', async () => {
    const res = await get('http://localhost/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { ok: true, service: 'site' } });
  });

  it('serves public media that cannot run script, on any host', async () => {
    await env.MEDIA.put(MEDIA_KEY, 'png', {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { visibility: 'public' },
    });
    const res = await get(`http://localhost/media/${MEDIA_KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('hides private objects and keys outside the media layout', async () => {
    const key = MEDIA_KEY.replace('.png', '.gif');
    await env.MEDIA.put(key, 'gif', { customMetadata: { visibility: 'private' } });
    expect((await get(`http://localhost/media/${key}`)).status).toBe(404);
    expect((await get('http://localhost/media/../secrets.txt')).status).toBe(404);
  });
});

describe('tenant resolution', () => {
  it('answers unknown hosts with a 404 page that names no publication', async () => {
    for (const url of [
      'http://nobody-here.swarm.test/',
      'http://example.org/',
      'http://a.swarm.test/',
      'http://bad_slug.swarm.test/',
    ]) {
      const res = await get(url);
      expect(res.status, url).toBe(404);
      expect(await res.text()).toContain('There is no site at this address');
    }
  });

  it('serves a publication on its platform subdomain', async () => {
    await seedChannel('field-notes');
    const res = await get('http://field-notes.swarm.test/definitely-not-a-page');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('There is no site at this address');
  });

  it('does not serve paused or deleted publications', async () => {
    await seedChannel('paused-notes', 'paused');
    await seedChannel('gone-notes', 'active', true);
    for (const host of ['paused-notes', 'gone-notes']) {
      expect(await (await get(`http://${host}.swarm.test/`)).text()).toContain(
        'There is no site at this address',
      );
    }
  });

  it('serves active custom hostnames and redirects the bare domain to the primary one', async () => {
    const { channelId, workspaceId } = await seedChannel('custom-notes');
    await addHostname(channelId, workspaceId, 'www.notes.example', 'web', true);
    await addHostname(channelId, workspaceId, 'notes.example', 'apex_redirect');
    expect(await (await get('http://www.notes.example/x')).text()).not.toContain(
      'There is no site at this address',
    );
    const apex = await get('http://notes.example/p/hello');
    expect(apex.status).toBe(301);
    expect(apex.headers.get('location')).toBe('http://www.notes.example/p/hello');
  });

  it('ignores custom hostnames that are not active', async () => {
    const { channelId, workspaceId } = await seedChannel('pending-notes');
    await env.DB.prepare(
      `INSERT INTO custom_hostnames (id, workspace_id, channel_id, hostname, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'pending.example', 'pending', 0, 0)`,
    )
      .bind(`hn_${hex()}`, workspaceId, channelId)
      .run();
    expect((await get('http://pending.example/')).status).toBe(404);
  });
});
