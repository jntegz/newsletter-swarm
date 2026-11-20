import { SELF, env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { seedChannel, uniqueEmail, type SeededChannel } from './helpers';

const DAY = 86_400_000;
const get = (url: string, init: RequestInit = {}) =>
  SELF.fetch(url, { redirect: 'manual', ...init });

const doc = (text: string) =>
  JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

async function flag(channelId: string, key: string) {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, ?2, 'channel', ?3, 1, 0)`,
  )
    .bind(newId('featureFlag'), key, channelId)
    .run();
}

async function dispatch(channelId: string, slug: string, subject: string, publishedAt: number) {
  const id = newId('dispatch');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, preheader, content_json, status, created_at, updated_at, web_visibility, web_published_at)
       VALUES (?1, ?2, ?3, '', ?4, 'sent', 0, 0, 'public', ?5)`,
    ).bind(id, channelId, subject, doc(`${subject} body.`), publishedAt),
    env.DB.prepare(
      'INSERT INTO dispatch_slugs (channel_id, slug, dispatch_id, is_current, created_at) VALUES (?1, ?2, ?3, 1, 0)',
    ).bind(channelId, slug, id),
  ]);
  return id;
}

describe('referral links', () => {
  it('/r/<code> remembers the code and lands on the home page with ?ref=', async () => {
    const site = await seedChannel();
    const res = await get(`${site.origin}/r/ABCD2345`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?ref=abcd2345');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('swarm_ref=abcd2345');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    // A malformed code goes home without a cookie.
    const bad = await get(`${site.origin}/r/nope`);
    expect(bad.headers.get('location')).toBe('/');
    expect(bad.headers.get('set-cookie')).toBeNull();
  });

  it('puts the code into subscribe forms after the cache, never into the cached page', async () => {
    const site = await seedChannel();
    const anonymous = await (await get(`${site.origin}/about`)).text();
    expect(anonymous).toContain('data-swarm-subscribe');
    expect(anonymous).not.toContain('name="ref"');

    const landing = await get(`${site.origin}/?ref=abcd2345`);
    expect(await landing.text()).toContain('<input type="hidden" name="ref" value="abcd2345">');
    expect(landing.headers.get('set-cookie')).toContain('swarm_ref=abcd2345');

    // Another page, carried by the cookie; the same page without it is clean (a cache hit).
    const withCookie = await get(`${site.origin}/about`, {
      headers: { cookie: 'swarm_ref=abcd2345' },
    });
    expect(await withCookie.text()).toContain('name="ref" value="abcd2345"');
    const again = await get(`${site.origin}/about`);
    expect(await again.text()).not.toContain('name="ref"');
    // Only well-formed codes are carried.
    const odd = await get(`${site.origin}/about`, { headers: { cookie: 'swarm_ref="><x' } });
    expect(await odd.text()).not.toContain('name="ref"');
  });
});

describe('top referrers page', () => {
  async function seedChampions(site: SeededChannel) {
    const champion = newId('member');
    const quiet = newId('member');
    const statements = [
      env.DB.prepare(
        `INSERT INTO members (id, channel_id, email, first_name, last_name, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'Grace', 'hopper', 'active', 0, 0)`,
      ).bind(champion, site.channelId, uniqueEmail('grace')),
      env.DB.prepare(
        `INSERT INTO members (id, channel_id, email, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'active', 0, 0)`,
      ).bind(quiet, site.channelId, uniqueEmail('quiet')),
    ];
    for (const [referrer, n] of [
      [champion, 3],
      [quiet, 1],
    ] as const) {
      for (let i = 0; i < n; i++) {
        const friend = newId('member');
        statements.push(
          env.DB.prepare(
            `INSERT INTO members (id, channel_id, email, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', 0, 0)`,
          ).bind(friend, site.channelId, uniqueEmail('friend')),
          env.DB.prepare(
            `INSERT INTO referrals (id, channel_id, referrer_id, referred_id, created_at, status, counted_at)
             VALUES (?1, ?2, ?3, ?4, 0, 'counted', ?5)`,
          ).bind(newId('referral'), site.channelId, referrer, friend, i),
        );
      }
    }
    await env.DB.batch(statements);
  }

  it('lists first names and initials only, behind the flag and the setting', async () => {
    const site = await seedChannel();
    await seedChampions(site);
    expect((await get(`${site.origin}/champions`)).status).toBe(404);
    await env.DB.prepare(
      `INSERT INTO champion_settings (channel_id, enabled, public_leaderboard, updated_at) VALUES (?1, 1, 1, 0)`,
    )
      .bind(site.channelId)
      .run();
    expect((await get(`${site.origin}/champions`)).status).toBe(404);

    const other = await seedChannel();
    await seedChampions(other);
    await flag(other.channelId, 'referral_awards');
    await env.DB.prepare(
      `INSERT INTO champion_settings (channel_id, enabled, public_leaderboard, updated_at) VALUES (?1, 1, 1, 0)`,
    )
      .bind(other.channelId)
      .run();
    const res = await get(`${other.origin}/champions`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('public');
    const html = await res.text();
    expect(html).toContain('Grace H.');
    expect(html).toContain('3 referrals');
    expect(html).toContain('A referrer');
    expect(html).not.toContain('@example.org');
    expect(html.indexOf('Grace H.')).toBeLessThan(html.indexOf('A referrer'));
    expect(await (await get(`${other.origin}/sitemap-pages.xml`)).text()).toContain('/champions');
  });
});

describe('Series', () => {
  async function seedSeries(withFlag: boolean) {
    const site = await seedChannel();
    if (withFlag) await flag(site.channelId, 'post_series');
    const now = Date.now();
    // Published in a different order than the Series reads.
    const one = await dispatch(site.channelId, 'part-one', 'Part one', now - DAY);
    const two = await dispatch(site.channelId, 'part-two', 'Part two', now - 3 * DAY);
    const three = await dispatch(site.channelId, 'part-three', 'Part three', now - 2 * DAY);
    const seriesId = newId('series');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO series (id, channel_id, name, slug, description, created_at, updated_at)
         VALUES (?1, ?2, 'Fox Season', 'fox-season', 'A field guide in parts.', 0, 0)`,
      ).bind(seriesId, site.channelId),
      ...[one, two, three].map((id, position) =>
        env.DB.prepare(
          'INSERT INTO series_dispatches (series_id, dispatch_id, position) VALUES (?1, ?2, ?3)',
        ).bind(seriesId, id, position),
      ),
    ]);
    return site;
  }

  it('lists a Series in order and links each part to the next', async () => {
    const site = await seedSeries(true);
    const res = await get(`${site.origin}/series/fox-season`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Fox Season');
    const order = ['/p/part-one', '/p/part-two', '/p/part-three'].map((p) => html.indexOf(p));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    const first = await (await get(`${site.origin}/p/part-one`)).text();
    expect(first).toContain('Part 1 of 3 in <a href="/series/fox-season">Fox Season</a>');
    expect(first).toMatch(/href="\/p\/part-two" rel="next"><span>Next in series<\/span>Part two/);
    const last = await (await get(`${site.origin}/p/part-three`)).text();
    expect(last).toContain('Part 3 of 3');
    expect(last).toContain('This is the latest part of');

    const sitemap = await (await get(`${site.origin}/sitemap-pages.xml`)).text();
    expect(sitemap).toContain('/series/fox-season');
    expect((await get(`${site.origin}/series/no-such-series`)).status).toBe(404);
  });

  it('is invisible with the flag off', async () => {
    const site = await seedSeries(false);
    expect((await get(`${site.origin}/series/fox-season`)).status).toBe(404);
    const page = await (await get(`${site.origin}/p/part-one`)).text();
    expect(page).not.toContain('Part 1 of 3');
    expect(await (await get(`${site.origin}/sitemap-pages.xml`)).text()).not.toContain('/series/');
  });
});
