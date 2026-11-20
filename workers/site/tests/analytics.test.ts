import { env } from 'cloudflare:test';
import { analyticsDay } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import {
  countedPath,
  deviceClass,
  isBotRequest,
  isPagePath,
  trafficSource,
} from '../src/edge/analytics';
import { BROWSER_UA, call, seedChannel, testSite, type SeededChannel } from './helpers';

const site = testSite();
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

interface Rollup {
  path: string;
  source: string;
  device: string;
  country: string;
  views: number;
  visitors: number;
}

async function rollups(channelId: string): Promise<Rollup[]> {
  const { results } = await env.DB.prepare(
    `SELECT path, source, device, country, views, visitors FROM site_page_views_daily
      WHERE channel_id = ?1 ORDER BY path, source, device`,
  )
    .bind(channelId)
    .all<Rollup>();
  return results;
}

function view(
  ch: SeededChannel,
  path: string,
  { ip = '203.0.113.10', ua = BROWSER_UA, referer = '', country = 'DE' } = {},
) {
  const headers: Record<string, string> = { 'user-agent': ua, 'cf-connecting-ip': ip };
  if (referer) headers.referer = referer;
  return call(site, `${ch.origin}${path}`, { headers, cf: { country } });
}

describe('site analytics', () => {
  it('rolls page views up per day, path, source, device and country, deduping visitors', async () => {
    const ch = await seedChannel();
    await view(ch, '/page?utm_campaign=x', { referer: 'https://www.google.com/search?q=x' });
    await view(ch, '/page', { referer: 'https://www.google.com/' }); // same visitor, a cache hit
    await view(ch, '/page', { ip: '203.0.113.11', referer: 'https://google.com/' });

    expect(await rollups(ch.channelId)).toEqual([
      {
        path: '/page',
        source: 'google.com',
        device: 'desktop',
        country: 'DE',
        views: 3,
        visitors: 2,
      },
    ]);
    const visitors = await env.DB.prepare(
      'SELECT day, visitor_hash FROM site_visitors WHERE channel_id = ?1',
    )
      .bind(ch.channelId)
      .all<{ day: string; visitor_hash: string }>();
    expect(visitors.results).toHaveLength(2);
    for (const row of visitors.results) {
      expect(row.day).toBe(analyticsDay());
      expect(row.visitor_hash).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('counts a returning visitor once a day across pages and sources', async () => {
    const ch = await seedChannel();
    await view(ch, '/page?utm_source=Newsletter!', { ua: IPHONE_UA, country: 'us' });
    await view(ch, '/uncached', { ua: IPHONE_UA, country: 'us', referer: `${ch.origin}/page` });
    await view(ch, '/uncached', { ua: BROWSER_UA, country: '' });
    expect(await rollups(ch.channelId)).toEqual([
      {
        path: '/page',
        source: 'newsletter',
        device: 'mobile',
        country: 'US',
        views: 1,
        visitors: 1,
      },
      {
        path: '/uncached',
        source: 'direct',
        device: 'desktop',
        country: 'XX',
        views: 1,
        visitors: 1,
      },
      {
        path: '/uncached',
        source: 'internal',
        device: 'mobile',
        country: 'US',
        views: 1,
        visitors: 0,
      },
    ]);
  });

  it('adds one funnel visit per visitor per day, with the first view’s source and UTM tags', async () => {
    const ch = await seedChannel();
    await view(ch, '/page?utm_source=Mastodon&utm_medium=social&utm_campaign=fall', {
      ua: IPHONE_UA,
    });
    await view(ch, '/uncached', { ua: IPHONE_UA, referer: `${ch.origin}/page` }); // same visitor
    await view(ch, '/uncached', { referer: 'https://www.bing.com/' });
    const { results } = await env.DB.prepare(
      `SELECT day, source, utm_source, utm_medium, utm_campaign, form_id, champion_id, visits
         FROM funnel_daily WHERE channel_id = ?1 ORDER BY source`,
    )
      .bind(ch.channelId)
      .all();
    const day = analyticsDay();
    expect(results).toEqual([
      {
        day,
        source: 'bing.com',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        form_id: '',
        champion_id: '',
        visits: 1,
      },
      {
        day,
        source: 'mastodon',
        utm_source: 'mastodon',
        utm_medium: 'social',
        utm_campaign: 'fall',
        form_id: '',
        champion_id: '',
        visits: 1,
      },
    ]);
  });

  it('never stores an IP address or a User-Agent', async () => {
    const ch = await seedChannel();
    const ip = '192.0.2.77';
    await view(ch, '/page', { ip });
    const rows = [
      ...(
        await env.DB.prepare('SELECT * FROM site_visitors WHERE channel_id = ?1')
          .bind(ch.channelId)
          .all()
      ).results,
      ...(await rollups(ch.channelId)),
    ];
    expect(rows.length).toBeGreaterThan(0);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(ip);
    expect(stored).not.toContain('Mozilla');
    expect(stored).not.toContain('Chrome');
  });

  it('keeps the daily salt in KV with an expiry', async () => {
    const ch = await seedChannel();
    await view(ch, '/page');
    const listed = await env.CACHE.list({ prefix: `analytics-salt:v1:${analyticsDay()}` });
    expect(listed.keys).toHaveLength(1);
    expect(listed.keys[0]?.expiration).toBeGreaterThan(Date.now() / 1000);
  });

  it('ignores bots, prefetches, system routes, errors and non-GET requests', async () => {
    const ch = await seedChannel();
    await view(ch, '/page', { ua: 'Mozilla/5.0 (compatible; GPTBot/1.2)' });
    await view(ch, '/page', { ua: 'curl/8.4.0' });
    await call(site, `${ch.origin}/page`, {
      headers: { 'user-agent': BROWSER_UA, 'cf-connecting-ip': '203.0.113.12' },
      cf: { verifiedBotCategory: 'Search Engine Crawler' },
    });
    await call(site, `${ch.origin}/page`, {
      headers: {
        'user-agent': BROWSER_UA,
        'cf-connecting-ip': '203.0.113.12',
        'sec-purpose': 'prefetch',
      },
    });
    await view(ch, '/_swarm/reader/signin');
    await view(ch, '/robots.txt');
    await view(ch, '/missing');
    await view(ch, '/does-not-exist');
    await call(site, `${ch.origin}/page`, {
      method: 'HEAD',
      headers: { 'user-agent': BROWSER_UA, 'cf-connecting-ip': '203.0.113.12' },
    });
    expect(await rollups(ch.channelId)).toEqual([]);
  });
});

describe('analytics helpers', () => {
  it('classifies devices', () => {
    expect(deviceClass(BROWSER_UA)).toBe('desktop');
    expect(deviceClass(IPHONE_UA)).toBe('mobile');
    expect(deviceClass('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(deviceClass('Mozilla/5.0 (Linux; Android 14; SM-X710) Safari/537.36')).toBe('tablet');
    expect(deviceClass('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36')).toBe(
      'mobile',
    );
    expect(deviceClass(undefined)).toBe('other');
  });

  it('buckets sources', () => {
    const url = new URL('https://notes.swarm.page/p/x');
    expect(trafficSource(url, undefined)).toBe('direct');
    expect(trafficSource(url, 'https://www.news.ycombinator.com/item')).toBe(
      'news.ycombinator.com',
    );
    expect(trafficSource(url, 'https://notes.swarm.page/archive')).toBe('internal');
    expect(trafficSource(url, 'android-app://com.slack/')).toBe('direct');
    expect(trafficSource(url, 'not a url')).toBe('direct');
    expect(
      trafficSource(new URL('https://n.swarm.page/?utm_source=Twitter%20X'), 'https://t.co/'),
    ).toBe('twitterx');
  });

  it('knows which paths are pages', () => {
    for (const path of ['/', '/p/hello', '/archive', '/about', '/s/news']) {
      expect(isPagePath(path), path).toBe(true);
    }
    for (const path of [
      '/_swarm/reader/signin',
      '/feed',
      '/feed.json',
      '/sitemap.xml',
      '/robots.txt',
      '/media/x.png',
      '/favicon.ico',
      '/.well-known/security.txt',
    ]) {
      expect(isPagePath(path), path).toBe(false);
    }
    expect(countedPath('/p/hello/')).toBe('/p/hello');
    expect(countedPath('/')).toBe('/');
  });

  it('recognises bots', () => {
    expect(isBotRequest(BROWSER_UA, undefined)).toBe(false);
    expect(isBotRequest(BROWSER_UA, { verifiedBotCategory: 'Search Engine Crawler' })).toBe(true);
    expect(isBotRequest('Mozilla/5.0 (compatible; bingbot/2.0)', undefined)).toBe(true);
    expect(isBotRequest('python-requests/2.32', undefined)).toBe(true);
    expect(isBotRequest(undefined, undefined)).toBe(true);
  });
});
