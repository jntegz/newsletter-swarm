// Link Hub on the site (Phase 8): /links behind the flag and the page switch, scheduled links,
// thumbnails, latest Dispatches and the form; the per-request source on links after the cache;
// the click redirect (no open redirect, http(s) only, 302 no-store) and cookieless counting that
// skips bots and prefetches.
import { SELF, env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { analyticsDay } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { BROWSER_UA, call, seedChannel, type SeededChannel } from './helpers';

const HOUR = 3_600_000;

async function flag(channelId: string) {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, 'link_hub', 'channel', ?2, 1, 0)`,
  )
    .bind(newId('featureFlag'), channelId)
    .run();
}

async function hubSettings(channelId: string, values: Record<string, unknown> = {}) {
  const row = {
    enabled: 1,
    title: 'Everything we do',
    bio: 'Notes from the field, weekly.',
    socials_json: JSON.stringify([
      { network: 'mastodon', url: 'https://social.example/@notes' },
      { network: 'x', url: 'javascript:alert(1)' },
    ]),
    latest_dispatches: 3,
    show_form: 1,
    ...values,
  };
  await env.DB.prepare(
    `INSERT INTO hub_settings (channel_id, enabled, title, bio, socials_json, latest_dispatches, show_form, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
     ON CONFLICT (channel_id) DO UPDATE SET enabled = excluded.enabled, title = excluded.title,
       bio = excluded.bio, socials_json = excluded.socials_json,
       latest_dispatches = excluded.latest_dispatches, show_form = excluded.show_form`,
  )
    .bind(
      channelId,
      row.enabled,
      row.title,
      row.bio,
      row.socials_json,
      row.latest_dispatches,
      row.show_form,
    )
    .run();
}

async function link(
  channelId: string,
  title: string,
  url: string,
  options: { position?: number; startsAt?: number; endsAt?: number; mediaId?: string } = {},
): Promise<string> {
  const id = newId('hubLink');
  await env.DB.prepare(
    `INSERT INTO hub_links (id, channel_id, title, url, thumbnail_media_id, starts_at, ends_at, position, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0)`,
  )
    .bind(
      id,
      channelId,
      title,
      url,
      options.mediaId ?? null,
      options.startsAt ?? null,
      options.endsAt ?? null,
      options.position ?? 0,
    )
    .run();
  return id;
}

async function image(ch: SeededChannel): Promise<{ id: string; key: string }> {
  const id = newId('media');
  const key = `ws/${ch.workspaceId}/ch/${ch.channelId}/${id}.png`;
  await env.DB.prepare(
    `INSERT INTO media (id, workspace_id, channel_id, r2_key, content_type, bytes, width, height, visibility, created_at)
     VALUES (?1, ?2, ?3, ?4, 'image/png', 10, 40, 40, 'public', 0)`,
  )
    .bind(id, ch.workspaceId, ch.channelId, key)
    .run();
  return { id, key };
}

async function dispatch(channelId: string, slug: string, subject: string, publishedAt: number) {
  const id = newId('dispatch');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, preheader, content_json, status, created_at, updated_at, web_visibility, web_published_at)
       VALUES (?1, ?2, ?3, '', '{"type":"doc","content":[]}', 'sent', 0, 0, 'public', ?4)`,
    ).bind(id, channelId, subject, publishedAt),
    env.DB.prepare(
      'INSERT INTO dispatch_slugs (channel_id, slug, dispatch_id, is_current, created_at) VALUES (?1, ?2, ?3, 1, 0)',
    ).bind(channelId, slug, id),
  ]);
}

const get = (
  ch: SeededChannel,
  path: string,
  init: { headers?: Record<string, string>; cf?: Record<string, unknown> } = {},
) =>
  call(app, `${ch.origin}${path}`, {
    headers: { 'user-agent': BROWSER_UA, 'cf-connecting-ip': '203.0.113.7', ...init.headers },
    cf: init.cf ?? { country: 'DE' },
  });

/**
 * Pages through the deployed worker: the edge cache keeps a copy of the body, which only finishes
 * once the body is read, so waiting for background work first (as `call` does) would stall.
 */
const view = (ch: SeededChannel, path: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`${ch.origin}${path}`, {
    redirect: 'manual',
    headers: { 'user-agent': BROWSER_UA, 'cf-connecting-ip': '203.0.113.7', ...headers },
  });

async function clicks(channelId: string) {
  const { results } = await env.DB.prepare(
    `SELECT day, link_id, source, country, clicks FROM hub_link_clicks_daily
      WHERE channel_id = ?1 ORDER BY link_id, source, country`,
  )
    .bind(channelId)
    .all<{ day: string; link_id: string; source: string; country: string; clicks: number }>();
  return results;
}

describe('the /links page', () => {
  it('is a 404 while the flag is off or the page is switched off', async () => {
    const ch = await seedChannel();
    await hubSettings(ch.channelId);
    const id = await link(ch.channelId, 'Shop', 'https://shop.example/');
    expect((await view(ch, '/links')).status).toBe(404);
    expect((await get(ch, `/_swarm/hub/${id}`)).status).toBe(404);

    await flag(ch.channelId);
    await env.CACHE.delete(`flags:v1:${ch.workspaceId}:${ch.channelId}`);
    await hubSettings(ch.channelId, { enabled: 0 });
    expect((await view(ch, '/links')).status).toBe(404);
    expect((await get(ch, `/_swarm/hub/${id}`)).status).toBe(404);

    const none = await seedChannel();
    await flag(none.channelId);
    expect((await view(none, '/links')).status).toBe(404);
  });

  it('shows the live links in order with thumbnails, socials, latest posts and the form', async () => {
    const ch = await seedChannel();
    await flag(ch.channelId);
    await hubSettings(ch.channelId);
    const pic = await image(ch);
    const now = Date.now();
    const second = await link(ch.channelId, 'Second <b>', 'https://two.example/', { position: 1 });
    const first = await link(ch.channelId, 'First', 'http://one.example/', {
      position: 0,
      mediaId: pic.id,
    });
    await link(ch.channelId, 'Not yet', 'https://later.example/', {
      position: 2,
      startsAt: now + HOUR,
    });
    await link(ch.channelId, 'Over', 'https://over.example/', { position: 3, endsAt: now - HOUR });
    await link(ch.channelId, 'Running', 'https://running.example/', {
      position: 4,
      startsAt: now - HOUR,
      endsAt: now + HOUR,
    });
    await dispatch(ch.channelId, 'newest', 'Newest post', now - 1000);
    await dispatch(ch.channelId, 'older', 'Older post', now - 2 * HOUR);

    const res = await view(ch, '/links');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=60, stale-while-revalidate=60');
    const html = await res.text();
    expect(html).toContain('<h1>Everything we do</h1>');
    expect(html).toContain('Notes from the field, weekly.');
    expect(html).toContain('href="https://social.example/@notes" rel="me noopener">Mastodon</a>');
    expect(html).not.toContain('javascript:');
    expect(html.indexOf(`/_swarm/hub/${first}`)).toBeLessThan(
      html.indexOf(`/_swarm/hub/${second}`),
    );
    expect(html).toContain('Second &lt;b&gt;');
    expect(html).toContain('Running');
    expect(html).not.toContain('Not yet');
    expect(html).not.toContain('>Over<');
    // Targets never appear on the page: every link goes through the redirect.
    expect(html).not.toContain('one.example');
    expect(html).toContain(`/media/${pic.key}`);
    expect(html.indexOf('Newest post')).toBeLessThan(html.indexOf('Older post'));
    expect(html).toContain('href="/p/newest"');
    expect(html).toContain('data-swarm-subscribe');
    // No script runs: only the JSON-LD block.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('application/ld+json');
  });

  it('leaves out posts and the form when switched off', async () => {
    const ch = await seedChannel();
    await flag(ch.channelId);
    await hubSettings(ch.channelId, { latest_dispatches: 0, show_form: 0, title: null });
    await dispatch(ch.channelId, 'hidden', 'Hidden post', Date.now());
    const html = await (await view(ch, '/links')).text();
    expect(html).toContain('<h1>Field Notes</h1>');
    expect(html).not.toContain('Hidden post');
    expect(html).not.toContain('data-swarm-subscribe');
  });

  it('adds this request’s source to the links after the cache, never into the cached page', async () => {
    const ch = await seedChannel();
    await flag(ch.channelId);
    await hubSettings(ch.channelId);
    const id = await link(ch.channelId, 'Shop', 'https://shop.example/');

    const direct = await view(ch, '/links');
    expect(direct.headers.get('x-swarm-cache')).toBe('miss');
    expect(await direct.text()).toContain(`href="/_swarm/hub/${id}?s=direct"`);

    const fromInstagram = await view(ch, '/links', { referer: 'https://www.instagram.com/' });
    expect(fromInstagram.headers.get('x-swarm-cache')).toBe('hit');
    const body = await fromInstagram.text();
    expect(body).toContain(`href="/_swarm/hub/${id}?s=instagram.com"`);
    expect(body).not.toContain('s=direct');

    const tagged = await view(ch, '/links?utm_source=Spring%20Letter');
    expect(await tagged.text()).toContain(`href="/_swarm/hub/${id}?s=springletter"`);
  });
});

describe('the click redirect', () => {
  async function hubWith(url = 'https://shop.example/sale?x=1') {
    const ch = await seedChannel();
    await flag(ch.channelId);
    await hubSettings(ch.channelId);
    const id = await link(ch.channelId, 'Shop', url);
    return { ch, id };
  }

  it('redirects to the stored target and counts the click without cookies', async () => {
    const { ch, id } = await hubWith();
    const res = await get(ch, `/_swarm/hub/${id}?s=instagram.com`, { cf: { country: 'fr' } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://shop.example/sale?x=1');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-swarm-cache')).toBeNull();

    await get(ch, `/_swarm/hub/${id}?s=instagram.com`, { cf: { country: 'FR' } });
    // Without s, the click's own referrer decides; the page itself is "internal".
    await get(ch, `/_swarm/hub/${id}`, { headers: { referer: `${ch.origin}/links` } });
    await get(ch, `/_swarm/hub/${id}?s=${encodeURIComponent('Odd Value!')}`);
    expect(await clicks(ch.channelId)).toEqual([
      { day: analyticsDay(), link_id: id, source: 'instagram.com', country: 'FR', clicks: 2 },
      { day: analyticsDay(), link_id: id, source: 'internal', country: 'DE', clicks: 1 },
      { day: analyticsDay(), link_id: id, source: 'oddvalue', country: 'DE', clicks: 1 },
    ]);
  });

  it('does not count bots, prefetches, HEAD requests or requests without a User-Agent', async () => {
    const { ch, id } = await hubWith();
    const quiet = [
      get(ch, `/_swarm/hub/${id}`, { headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0' } }),
      get(ch, `/_swarm/hub/${id}`, { headers: { 'user-agent': 'curl/8.4.0' } }),
      get(ch, `/_swarm/hub/${id}`, { headers: { 'sec-purpose': 'prefetch' } }),
      get(ch, `/_swarm/hub/${id}`, { headers: { purpose: 'prefetch' } }),
      get(ch, `/_swarm/hub/${id}`, {
        cf: { country: 'DE', verifiedBotCategory: 'Search Engine Crawler' },
      }),
      call(app, `${ch.origin}/_swarm/hub/${id}`, {
        method: 'HEAD',
        headers: { 'user-agent': BROWSER_UA },
      }),
      call(app, `${ch.origin}/_swarm/hub/${id}`),
    ];
    for (const res of await Promise.all(quiet)) expect(res.status).toBe(302);
    expect(await clicks(ch.channelId)).toEqual([]);
  });

  it('never redirects anywhere the publication did not store', async () => {
    const { ch, id } = await hubWith();
    // Another Channel's link, an unknown id and a malformed id are 404s.
    const other = await hubWith();
    expect((await get(ch, `/_swarm/hub/${other.id}`)).status).toBe(404);
    expect((await get(ch, `/_swarm/hub/${newId('hubLink')}`)).status).toBe(404);
    expect((await get(ch, '/_swarm/hub/https%3A%2F%2Fevil.example')).status).toBe(404);
    // Query parameters never choose the target.
    const res = await get(ch, `/_swarm/hub/${id}?url=https://evil.example&to=https://evil.example`);
    expect(res.headers.get('location')).toBe('https://shop.example/sale?x=1');
    expect(await clicks(other.ch.channelId)).toEqual([]);
  });

  it('refuses a stored target that is not http(s), and sends visitors back outside the window', async () => {
    const ch = await seedChannel();
    await flag(ch.channelId);
    await hubSettings(ch.channelId);
    // The table only takes http(s); a credentialed URL slips past the CHECK but not the site.
    const creds = await link(ch.channelId, 'Creds', 'https://user:pw@evil.example/');
    expect((await get(ch, `/_swarm/hub/${creds}`)).status).toBe(404);
    expect(await (await view(ch, '/links')).text()).not.toContain(creds);

    const ended = await link(ch.channelId, 'Ended', 'https://ended.example/', {
      endsAt: Date.now() - HOUR,
    });
    const res = await get(ch, `/_swarm/hub/${ended}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/links');
    expect(await clicks(ch.channelId)).toEqual([]);
  });

  it('is not a page view', async () => {
    const { ch, id } = await hubWith();
    await get(ch, `/_swarm/hub/${id}`);
    const views = await env.DB.prepare(
      'SELECT count(*) AS n FROM site_page_views_daily WHERE channel_id = ?1',
    )
      .bind(ch.channelId)
      .first<{ n: number }>();
    expect(views?.n).toBe(0);
  });
});
