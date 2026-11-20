// Link Hub (Phase 8): the page settings and links behind the flag, target validation (http and
// https only), thumbnails from the workspace's media, ordering, the cache bump, the click report,
// and the role and tenancy matrix.
import { env } from 'cloudflare:test';
import type { HubLink, LinkHub, LinkHubAnalytics, MediaAsset, SeatRole } from '@swarm/domain';
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

async function errorCode(res: Response): Promise<string> {
  return (await json<{ error: { code: string } }>(res)).error.code;
}

async function enableFlag(workspaceId: string, channelId: string) {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, 'link_hub', 'channel', ?2, 1, 0)`,
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

async function hubChannel(owner: Session) {
  const channel = await createChannel(owner);
  await enableFlag(owner.workspaceId, channel.id);
  return channel;
}

const base = (channelId: string) => `/api/v1/channels/${channelId}/link-hub`;

const addLink = (s: Session, channelId: string, body: Record<string, unknown>) =>
  call('POST', `${base(channelId)}/links`, { cookie: s.cookie, body });

async function publishedForm(workspaceId: string, channelId: string): Promise<string> {
  const id = `cf_${crypto.randomUUID().replace(/-/g, '')}`;
  await env.DB.prepare(
    `INSERT INTO capture_forms (id, workspace_id, channel_id, name, status, draft_config_json, published_config_json, version, published_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Hub form', 'published', '{}', '{}', 1, 0, 0, 0)`,
  )
    .bind(id, workspaceId, channelId)
    .run();
  return id;
}

describe('Link Hub API', () => {
  let owner: Session;
  let channelId: string;
  beforeAll(async () => {
    owner = await signIn();
    channelId = (await hubChannel(owner)).id;
  });

  it('answers feature_disabled while the flag is off', async () => {
    const other = await createChannel(owner);
    const res = await call('GET', base(other.id), { cookie: owner.cookie });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('feature_disabled');
    const write = await addLink(owner, other.id, { title: 'A', url: 'https://example.com' });
    expect(write.status).toBe(404);
  });

  it('starts switched off with defaults, and saves settings', async () => {
    const hub = await data<LinkHub>(await call('GET', base(channelId), { cookie: owner.cookie }));
    expect(hub).toMatchObject({
      enabled: false,
      title: null,
      bio: null,
      socials: [],
      latestDispatches: 3,
      showCaptureForm: true,
      captureFormId: null,
      links: [],
      updatedAt: null,
    });
    expect(hub.url).toMatch(/\/links$/);

    const before = await cacheVersion(channelId);
    const formId = await publishedForm(owner.workspaceId, channelId);
    const saved = await data<LinkHub>(
      await call('PATCH', base(channelId), {
        cookie: owner.cookie,
        body: {
          enabled: true,
          title: 'Everything we do',
          bio: 'Weekly notes from the field.',
          socials: [{ network: 'mastodon', url: 'https://social.example/@notes' }],
          latestDispatches: 5,
          captureFormId: formId,
        },
      }),
    );
    expect(saved).toMatchObject({
      enabled: true,
      title: 'Everything we do',
      bio: 'Weekly notes from the field.',
      socials: [{ network: 'mastodon', url: 'https://social.example/@notes' }],
      latestDispatches: 5,
      captureFormId: formId,
    });
    expect(await cacheVersion(channelId)).toBeGreaterThan(before);

    // Clearing: null empties the title and the form choice; the rest stays.
    const cleared = await data<LinkHub>(
      await call('PATCH', base(channelId), {
        cookie: owner.cookie,
        body: { title: null, captureFormId: null },
      }),
    );
    expect(cleared).toMatchObject({
      title: null,
      captureFormId: null,
      bio: 'Weekly notes from the field.',
    });

    const audit = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_events WHERE action = 'link_hub.updated' AND target_id = ?1",
    )
      .bind(channelId)
      .first<{ n: number }>();
    expect(audit?.n).toBe(2);
  });

  it('refuses settings that point elsewhere', async () => {
    const other = await createChannel(owner);
    const foreignForm = await publishedForm(owner.workspaceId, other.id);
    for (const body of [
      { captureFormId: foreignForm },
      { socials: [{ network: 'x', url: 'http://x.example/notes' }] },
      { socials: [{ network: 'myspace', url: 'https://myspace.example/notes' }] },
      { latestDispatches: 11 },
      {},
    ]) {
      const res = await call('PATCH', base(channelId), { cookie: owner.cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('adds links with http(s) targets only, and keeps them in order', async () => {
    const before = await cacheVersion(channelId);
    const first = await data<HubLink>(
      await addLink(owner, channelId, { title: 'Shop', url: 'https://shop.example/' }),
      201,
    );
    expect(first).toMatchObject({ title: 'Shop', position: 0, live: true, thumbnailUrl: null });
    expect(first.id).toMatch(/^lk_[0-9a-f]{32}$/);
    expect(await cacheVersion(channelId)).toBeGreaterThan(before);

    // Plain http is a valid link target.
    const second = await data<HubLink>(
      await addLink(owner, channelId, { title: 'Old blog', url: 'http://blog.example/' }),
      201,
    );
    expect(second.position).toBe(1);
    // position 0 puts it first and moves the others down.
    const top = await data<HubLink>(
      await addLink(owner, channelId, { title: 'Top', url: 'https://top.example', position: 0 }),
      201,
    );
    expect(top.position).toBe(0);
    const hub = await data<LinkHub>(await call('GET', base(channelId), { cookie: owner.cookie }));
    expect(hub.links.map((l) => l.title)).toEqual(['Top', 'Shop', 'Old blog']);

    for (const url of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://files.example/x',
      '/relative/path',
      '//evil.example',
      'https://user:pass@evil.example/',
      `https://example.com/${'a'.repeat(2048)}`,
    ]) {
      const res = await addLink(owner, channelId, { title: 'Bad', url });
      expect(res.status, url).toBe(400);
    }
    // The table refuses anything else too, should a write ever skip the schema.
    await expect(
      env.DB.prepare(
        `INSERT INTO hub_links (id, channel_id, title, url, created_at, updated_at) VALUES ('lk_x', ?1, 'x', 'javascript:1', 0, 0)`,
      )
        .bind(channelId)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it('schedules links and checks the window', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const later = await data<HubLink>(
      await addLink(owner, channelId, {
        title: 'Soon',
        url: 'https://soon.example',
        startsAt: future,
      }),
      201,
    );
    expect(later.live).toBe(false);
    const ended = await data<HubLink>(
      await addLink(owner, channelId, { title: 'Over', url: 'https://over.example', endsAt: past }),
      201,
    );
    expect(ended.live).toBe(false);
    const bad = await addLink(owner, channelId, {
      title: 'Backwards',
      url: 'https://x.example',
      startsAt: future,
      endsAt: past,
    });
    expect(bad.status).toBe(400);
    // A change is checked against the stored start too.
    const res = await call('PATCH', `${base(channelId)}/links/${later.id}`, {
      cookie: owner.cookie,
      body: { endsAt: past },
    });
    expect(res.status).toBe(400);
    const cleared = await data<HubLink>(
      await call('PATCH', `${base(channelId)}/links/${later.id}`, {
        cookie: owner.cookie,
        body: { startsAt: null, title: 'Now' },
      }),
    );
    expect(cleared).toMatchObject({ title: 'Now', startsAt: null, live: true });
  });

  it('takes thumbnails only from this workspace’s public images', async () => {
    const asset = await data<MediaAsset>(
      await call('POST', `/api/v1/channels/${channelId}/media`, {
        cookie: owner.cookie,
        form: uploadForm(pngBytes()),
      }),
      201,
    );
    const link = await data<HubLink>(
      await addLink(owner, channelId, {
        title: 'With a picture',
        url: 'https://pic.example',
        thumbnailMediaId: asset.id,
      }),
      201,
    );
    expect(link.thumbnailUrl).toBe(asset.url);

    const stranger = await signIn();
    const theirs = await createChannel(stranger);
    const foreign = await data<MediaAsset>(
      await call('POST', `/api/v1/channels/${theirs.id}/media`, {
        cookie: stranger.cookie,
        form: uploadForm(pngBytes()),
      }),
      201,
    );
    const res = await addLink(owner, channelId, {
      title: 'Not mine',
      url: 'https://x.example',
      thumbnailMediaId: foreign.id,
    });
    expect(res.status).toBe(400);
  });

  it('reorders with every link exactly once, and deletes', async () => {
    const hub = await data<LinkHub>(await call('GET', base(channelId), { cookie: owner.cookie }));
    const ids = hub.links.map((l) => l.id);
    const reversed = [...ids].reverse();
    const after = await data<LinkHub>(
      await call('PUT', `${base(channelId)}/order`, {
        cookie: owner.cookie,
        body: { ids: reversed },
      }),
    );
    expect(after.links.map((l) => l.id)).toEqual(reversed);
    expect(after.links.map((l) => l.position)).toEqual(reversed.map((_, i) => i));

    for (const body of [{ ids: reversed.slice(1) }, { ids: [...reversed, reversed[0]] }]) {
      const res = await call('PUT', `${base(channelId)}/order`, { cookie: owner.cookie, body });
      expect(res.status).toBe(400);
    }

    const victim = reversed[1]!;
    const del = await call('DELETE', `${base(channelId)}/links/${victim}`, {
      cookie: owner.cookie,
    });
    expect(del.status).toBe(204);
    const left = await data<LinkHub>(await call('GET', base(channelId), { cookie: owner.cookie }));
    expect(left.links.map((l) => l.id)).toEqual(reversed.filter((id) => id !== victim));
    expect(left.links.map((l) => l.position)).toEqual(left.links.map((_, i) => i));
    const again = await call('DELETE', `${base(channelId)}/links/${victim}`, {
      cookie: owner.cookie,
    });
    expect(again.status).toBe(404);
  });

  it('stops at 50 links', async () => {
    const { id } = await hubChannel(owner);
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 50 }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO hub_links (id, channel_id, title, url, position, created_at, updated_at) VALUES (?1, ?2, 'L', 'https://x.example', ?3, ?4, ?4)`,
        ).bind(`lk_${crypto.randomUUID().replace(/-/g, '')}`, id, i, now),
      ),
    );
    const res = await addLink(owner, id, { title: 'One more', url: 'https://x.example' });
    expect(res.status).toBe(409);
  });

  it('reports clicks per link, day, source and country, with the page’s views', async () => {
    const { id } = await hubChannel(owner);
    const a = await data<HubLink>(
      await addLink(owner, id, { title: 'A', url: 'https://a.example' }),
      201,
    );
    const b = await data<HubLink>(
      await addLink(owner, id, { title: 'B', url: 'https://b.example' }),
      201,
    );
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const rows: [string, string, string, string, number][] = [
      [today, a.id, 'instagram.com', 'DE', 4],
      [today, a.id, 'direct', 'US', 1],
      [yesterday, b.id, 'instagram.com', 'DE', 2],
      [today, 'lk_00000000000000000000000000000000', 'direct', 'XX', 3],
    ];
    await env.DB.batch([
      ...rows.map(([day, link, source, country, clicks]) =>
        env.DB.prepare(
          'INSERT INTO hub_link_clicks_daily (channel_id, day, link_id, source, country, clicks) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
        ).bind(id, day, link, source, country, clicks),
      ),
      env.DB.prepare(
        `INSERT INTO site_page_views_daily (channel_id, day, path, source, device, country, views, visitors)
         VALUES (?1, ?2, '/links', 'direct', 'mobile', 'DE', 20, 12)`,
      ).bind(id, today),
    ]);

    const report = await data<LinkHubAnalytics>(
      await call('GET', `${base(id)}/analytics?from=${yesterday}&to=${today}`, {
        cookie: owner.cookie,
      }),
    );
    expect(report).toMatchObject({ clicks: 10, pageViews: 20, pageVisitors: 12 });
    expect(report.byDay).toEqual([
      { day: yesterday, clicks: 2 },
      { day: today, clicks: 8 },
    ]);
    expect(report.byLink).toEqual([
      { linkId: a.id, title: 'A', clicks: 5 },
      { linkId: b.id, title: 'B', clicks: 2 },
      { linkId: 'lk_00000000000000000000000000000000', title: null, clicks: 3 },
    ]);
    expect(report.sources[0]).toEqual({ source: 'instagram.com', clicks: 6 });
    expect(report.countries[0]).toEqual({ country: 'DE', clicks: 6 });

    const one = await data<LinkHubAnalytics>(
      await call('GET', `${base(id)}/analytics?from=${yesterday}&to=${today}&linkId=${a.id}`, {
        cookie: owner.cookie,
      }),
    );
    expect(one.clicks).toBe(5);
    expect(one.byLink).toEqual([{ linkId: a.id, title: 'A', clicks: 5 }]);

    const defaults = await data<LinkHubAnalytics>(
      await call('GET', `${base(id)}/analytics`, { cookie: owner.cookie }),
    );
    expect(defaults.byDay).toHaveLength(30);
    expect(defaults.to).toBe(today);

    for (const query of [
      'from=2026-02-30',
      `from=${today}&to=${yesterday}`,
      'from=2020-01-01&to=2026-01-01',
    ]) {
      const res = await call('GET', `${base(id)}/analytics?${query}`, { cookie: owner.cookie });
      expect(res.status, query).toBe(400);
    }
  });
});

describe('roles and tenancy for Link Hub routes', () => {
  const ROLES: SeatRole[] = ['viewer', 'author', 'editor', 'admin', 'owner'];
  let outsider: Session;
  const seats = {} as Record<SeatRole, Session>;
  let channelId: string;
  let linkId: string;

  beforeAll(async () => {
    const owner = await signIn();
    seats.owner = owner;
    for (const role of ['viewer', 'author', 'editor', 'admin'] as const)
      seats[role] = await seatAs(owner.workspaceId, role);
    outsider = await signIn();
    channelId = (await hubChannel(owner)).id;
    linkId = (
      await data<HubLink>(
        await addLink(owner, channelId, { title: 'Base', url: 'https://base.example' }),
        201,
      )
    ).id;
  });

  const ch = () => base(channelId);
  const ROUTES: { name: string; minimum: SeatRole; request: (s: Session) => Promise<Response> }[] =
    [
      {
        name: 'read the page',
        minimum: 'viewer',
        request: (s) => call('GET', ch(), { cookie: s.cookie }),
      },
      {
        name: 'change the page',
        minimum: 'editor',
        request: (s) => call('PATCH', ch(), { cookie: s.cookie, body: { latestDispatches: 2 } }),
      },
      {
        name: 'add a link',
        minimum: 'editor',
        request: (s) =>
          call('POST', `${ch()}/links`, {
            cookie: s.cookie,
            body: { title: 'More', url: 'https://more.example' },
          }),
      },
      {
        name: 'change a link',
        minimum: 'editor',
        request: (s) =>
          call('PATCH', `${ch()}/links/${linkId}`, { cookie: s.cookie, body: { title: 'Base' } }),
      },
      {
        name: 'reorder',
        minimum: 'editor',
        request: async (s) => {
          const res = await call('GET', ch(), { cookie: seats.owner.cookie });
          const ids = (await json<{ data: LinkHub }>(res)).data.links.map((l) => l.id);
          return call('PUT', `${ch()}/order`, { cookie: s.cookie, body: { ids } });
        },
      },
      {
        name: 'analytics',
        minimum: 'viewer',
        request: (s) => call('GET', `${ch()}/analytics`, { cookie: s.cookie }),
      },
    ];

  for (const route of ROUTES) {
    for (const role of ROLES) {
      const allowed = ROLES.indexOf(role) >= ROLES.indexOf(route.minimum);
      it(`${route.name}: ${role} is ${allowed ? 'allowed' : 'refused'}`, async () => {
        const res = await route.request(seats[role]);
        if (allowed) expect(res.status, await res.clone().text()).toBeLessThan(300);
        else expect(res.status).toBe(403);
      });
    }
    it(`${route.name}: another workspace's operator gets 404`, async () => {
      expect((await route.request(outsider)).status).toBe(404);
    });
  }

  it('deleting a link needs the editor role', async () => {
    for (const role of ['viewer', 'author'] as const) {
      const res = await call('DELETE', `${ch()}/links/${linkId}`, { cookie: seats[role].cookie });
      expect(res.status).toBe(403);
    }
    expect(
      (await call('DELETE', `${ch()}/links/${linkId}`, { cookie: outsider.cookie })).status,
    ).toBe(404);
  });

  it('hides another Channel’s links behind 404, even inside a Channel the operator can see', async () => {
    const own = await hubChannel(outsider);
    const theirs = base(own.id);
    for (const [method, path, body] of [
      ['PATCH', `${theirs}/links/${linkId}`, { title: 'Taken' }],
      ['DELETE', `${theirs}/links/${linkId}`, undefined],
      ['PUT', `${theirs}/order`, { ids: [linkId] }],
    ] as const) {
      const res = await call(method, path, { cookie: outsider.cookie, ...(body ? { body } : {}) });
      expect(res.status, path).toBe(method === 'PUT' ? 400 : 404);
    }
    const mine = await data<LinkHub>(await call('GET', ch(), { cookie: seats.owner.cookie }));
    expect(mine.links.find((l) => l.id === linkId)?.title).toBe('Base');
  });
});
