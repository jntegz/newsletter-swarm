// Author pages (flag author_pages): the flag is enforced, teammates edit their own page and admins
// anyone's, other tenants get 404, avatars come from the workspace's media, and writes purge the
// site's edge cache.
import { env } from 'cloudflare:test';
import type { AuthorProfile, MediaAsset } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  createChannel,
  json,
  pngBytes,
  seatAs,
  signIn,
  uploadForm,
  type Session,
} from './helpers';

async function data<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await json<{ data: T }>(res)).data;
}

async function enableAuthorPages(workspaceId: string, channelId: string) {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, 'author_pages', 'channel', ?2, 1, 0)`,
  )
    .bind(`ff_${crypto.randomUUID().replace(/-/g, '')}`, channelId)
    .run();
  await env.CACHE.delete(`flags:v1:${workspaceId}:${channelId}`);
}

async function cacheVersion(channelId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT cache_version FROM site_settings WHERE channel_id = ?1')
    .bind(channelId)
    .first<{ cache_version: number }>();
  return row?.cache_version ?? 1;
}

describe('author pages', () => {
  let owner: Session;
  let channel: { id: string; slug: string };
  const base = () => `/api/v1/channels/${channel.id}/authors`;
  const put = (s: Session, operatorId: string, body: Record<string, unknown>) =>
    call('PUT', `${base()}/${operatorId}`, { cookie: s.cookie, body });

  beforeAll(async () => {
    owner = await signIn();
    channel = await createChannel(owner);
  });

  it('is refused while the flag is off', async () => {
    const res = await call('GET', base(), { cookie: owner.cookie });
    expect(res.status).toBe(404);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('feature_disabled');
    expect((await put(owner, owner.me.operator.id, { name: 'Ada' })).status).toBe(404);
  });

  it('lets a teammate write their own page, with an avatar, and purges the site cache', async () => {
    await enableAuthorPages(owner.workspaceId, channel.id);
    const avatar = await data<MediaAsset>(
      await call('POST', `/api/v1/channels/${channel.id}/media`, {
        cookie: owner.cookie,
        form: uploadForm(pngBytes()),
      }),
      201,
    );
    const before = await cacheVersion(channel.id);
    const saved = await data<AuthorProfile>(
      await put(owner, owner.me.operator.id, {
        name: 'Ada Lovelace',
        bio: 'Writes about engines.',
        avatarMediaId: avatar.id,
      }),
    );
    expect(saved).toMatchObject({
      operatorId: owner.me.operator.id,
      slug: 'ada-lovelace',
      name: 'Ada Lovelace',
      bio: 'Writes about engines.',
      avatarMediaId: avatar.id,
      avatarUrl: avatar.url,
      url: `http://${channel.slug}.site.localhost/authors/ada-lovelace`,
      dispatchCount: 0,
    });
    expect(await cacheVersion(channel.id)).toBeGreaterThan(before);

    // A partial update keeps the bio and avatar; the slug stays unless given.
    const renamed = await data<AuthorProfile>(
      await put(owner, owner.me.operator.id, { name: 'Ada King' }),
    );
    expect(renamed).toMatchObject({ slug: 'ada-lovelace', bio: 'Writes about engines.' });
    const listed = await data<AuthorProfile[]>(await call('GET', base(), { cookie: owner.cookie }));
    expect(listed.map((a) => a.name)).toEqual(['Ada King']);

    const audit = await env.DB.prepare(
      `SELECT count(*) AS n FROM audit_events WHERE workspace_id = ?1 AND action = 'site.author_saved'`,
    )
      .bind(owner.workspaceId)
      .first<{ n: number }>();
    expect(audit?.n).toBe(2);
  });

  it('refuses reserved and taken addresses, and media from another workspace', async () => {
    const author = await seatAs(owner.workspaceId, 'author');
    expect((await put(author, author.me.operator.id, { name: 'X', slug: 'p' })).status).toBe(400);
    expect(
      (await put(author, author.me.operator.id, { name: 'X', slug: 'ada-lovelace' })).status,
    ).toBe(409);
    const stranger = await signIn();
    const theirs = await createChannel(stranger);
    const foreign = await data<MediaAsset>(
      await call('POST', `/api/v1/channels/${theirs.id}/media`, {
        cookie: stranger.cookie,
        form: uploadForm(pngBytes()),
      }),
      201,
    );
    expect(
      (await put(author, author.me.operator.id, { name: 'X', avatarMediaId: foreign.id })).status,
    ).toBe(400);
  });

  it('needs the author role for your own page and admin for someone else’s', async () => {
    const viewer = await seatAs(owner.workspaceId, 'viewer');
    const author = await seatAs(owner.workspaceId, 'author');
    const admin = await seatAs(owner.workspaceId, 'admin');
    expect((await call('GET', base(), { cookie: viewer.cookie })).status).toBe(200);
    expect((await put(viewer, viewer.me.operator.id, { name: 'Viewer' })).status).toBe(403);
    expect((await put(author, author.me.operator.id, { name: 'Grace Hopper' })).status).toBe(200);
    expect((await put(author, owner.me.operator.id, { name: 'Not me' })).status).toBe(403);
    expect(
      (await call('DELETE', `${base()}/${owner.me.operator.id}`, { cookie: author.cookie })).status,
    ).toBe(403);
    // An admin may edit a teammate's page, but not one for someone outside the Channel or a viewer.
    expect((await put(admin, author.me.operator.id, { name: 'Grace B. Hopper' })).status).toBe(200);
    expect((await put(admin, viewer.me.operator.id, { name: 'Viewer' })).status).toBe(404);
    const outsider = await signIn();
    expect((await put(admin, outsider.me.operator.id, { name: 'Outsider' })).status).toBe(404);
    expect(
      (await call('DELETE', `${base()}/${author.me.operator.id}`, { cookie: admin.cookie })).status,
    ).toBe(204);
    expect(
      (await call('DELETE', `${base()}/${author.me.operator.id}`, { cookie: admin.cookie })).status,
    ).toBe(404);
  });

  it('answers 404 to other tenants', async () => {
    const stranger = await signIn();
    expect((await call('GET', base(), { cookie: stranger.cookie })).status).toBe(404);
    expect((await put(stranger, stranger.me.operator.id, { name: 'Intruder' })).status).toBe(404);
  });
});
