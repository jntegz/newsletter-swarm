import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { cacheQuery, edgeCacheKey, edgeTtl, isCacheLookupPath } from '../src/edge/cache';
import { isVerifiedSearchCrawler } from '../src/edge/crawler';
import { parseSiteEnv } from '../src/env';
import app from '../src/index';
import {
  BROWSER_UA,
  PUBLIC_PAGE_CACHE,
  addMember,
  call,
  fakeDoh,
  nextIp,
  renders,
  seedChannel,
  sessionCookie,
  setSettings,
  testSite,
} from './helpers';

const site = testSite();
const GPTBOT_UA =
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';
const CLAUDEBOT_UA = 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)';
const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

async function addRedirect(channelId: string, from: string, to: string, status = 301) {
  await env.DB.prepare(
    `INSERT INTO site_redirects (id, channel_id, from_path, to_location, status_code, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 0)`,
  )
    .bind(`rd_${crypto.randomUUID().replace(/-/g, '')}`, channelId, from, to, status)
    .run();
}

describe('redirects', () => {
  it('applies exact-path redirects and carries the query string over', async () => {
    const ch = await seedChannel();
    await addRedirect(ch.channelId, '/old-post', '/new');
    await addRedirect(ch.channelId, '/moved', '/new?from=moved', 302);
    await addRedirect(ch.channelId, '/away', 'https://elsewhere.example/landing', 308);

    let res = await call(site, `${ch.origin}/old-post`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/new');

    res = await call(site, `${ch.origin}/old-post?utm_source=x`);
    expect(res.headers.get('location')).toBe('/new?utm_source=x');

    // A target with its own query keeps it and doesn't take the request's.
    res = await call(site, `${ch.origin}/moved?a=1`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/new?from=moved');

    res = await call(site, `${ch.origin}/away?a=1`);
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://elsewhere.example/landing');

    // POSTs are never redirected.
    expect((await call(site, `${ch.origin}/old-post`, { method: 'POST' })).status).toBe(404);
  });

  it('matches a redirect through a trailing slash and normalises other trailing slashes', async () => {
    const ch = await seedChannel();
    await addRedirect(ch.channelId, '/old-post', '/new');
    let res = await call(site, `${ch.origin}/old-post/`);
    expect(res.headers.get('location')).toBe('/new');

    res = await call(site, `${ch.origin}/archive/?page=2`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/archive?page=2');
    expect((await call(site, `${ch.origin}/`)).status).not.toBe(301);
  });

  it('never produces a protocol-relative Location', async () => {
    const ch = await seedChannel();
    for (const path of ['//evil.example/', '///evil.example//', '//evil.example']) {
      const res = await call(site, `${ch.origin}${path}`);
      const location = res.headers.get('location');
      if (location) expect(location.startsWith('//'), path).toBe(false);
    }
  });

  it('ignores unsafe targets stored in the table', async () => {
    const ch = await seedChannel();
    await addRedirect(ch.channelId, '/a', 'javascript:alert(1)');
    await addRedirect(ch.channelId, '/b', 'http://insecure.example/');
    await addRedirect(ch.channelId, '/c', '/\t/evil.example');
    await addRedirect(ch.channelId, '/d', '//evil.example');
    for (const path of ['/a', '/b', '/c', '/d']) {
      expect((await call(site, `${ch.origin}${path}`)).status, path).toBe(404);
    }
  });

  it('never shadows /_swarm routes', async () => {
    const ch = await seedChannel();
    await addRedirect(ch.channelId, '/_swarm/reader/signin', '/somewhere-else');
    await addRedirect(ch.channelId, '/_swarm', '/somewhere-else');
    const res = await call(site, `${ch.origin}/_swarm/reader/signin`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Sign in to read');
    expect((await call(site, `${ch.origin}/_swarm`)).status).toBe(404);
  });
});

describe('Bot Rules', () => {
  it('blocks known AI crawlers under the block policy, but serves them robots.txt', async () => {
    const ch = await seedChannel({ aiBots: 'block' });
    const blocked = await call(site, `${ch.origin}/page`, { headers: { 'user-agent': GPTBOT_UA } });
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get('content-type')).toContain('text/plain');
    expect(await blocked.text()).toContain('does not allow this crawler');

    const robots = await call(site, `${ch.origin}/robots.txt`, {
      headers: { 'user-agent': GPTBOT_UA },
    });
    expect(robots.status).toBe(200);

    const person = await call(site, `${ch.origin}/page`, { headers: { 'user-agent': BROWSER_UA } });
    expect(person.status).toBe(200);
  });

  it('blocks what Cloudflare verifies as an AI crawler under the block policy', async () => {
    const ch = await seedChannel({ aiBots: 'block' });
    const res = await call(site, `${ch.origin}/page`, {
      headers: { 'user-agent': 'SomeNewAgent/1.0' },
      cf: { verifiedBotCategory: 'AI Crawler' },
    });
    expect(res.status).toBe(403);
  });

  it('lets crawlers in under the allow and unset policies', async () => {
    for (const aiBots of ['allow', 'unset'] as const) {
      const ch = await seedChannel({ aiBots });
      const res = await call(site, `${ch.origin}/page`, {
        headers: { 'user-agent': GPTBOT_UA },
        cf: { verifiedBotCategory: 'AI Crawler' },
      });
      expect(res.status, aiBots).toBe(200);
    }
  });

  it('applies per-crawler overrides under the custom policy', async () => {
    const ch = await seedChannel({ aiBots: 'custom' });
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO bot_rules (channel_id, agent, action, updated_at) VALUES (?1, 'gptbot', 'block', 0)",
      ).bind(ch.channelId),
      env.DB.prepare(
        "INSERT INTO bot_rules (channel_id, agent, action, updated_at) VALUES (?1, 'claudebot', 'allow', 0)",
      ).bind(ch.channelId),
    ]);
    const gpt = await call(site, `${ch.origin}/page`, { headers: { 'user-agent': GPTBOT_UA } });
    expect(gpt.status).toBe(403);
    const claude = await call(site, `${ch.origin}/page`, {
      headers: { 'user-agent': CLAUDEBOT_UA },
    });
    expect(claude.status).toBe(200);
  });
});

describe('verified search crawlers', () => {
  const IP = '66.249.66.1';
  const REVERSE = '1.66.249.66.in-addr.arpa';
  const genuine = () =>
    fakeDoh({
      [`PTR ${REVERSE}`]: [{ type: 12, data: 'crawl-66-249-66-1.googlebot.com.' }],
      'A crawl-66-249-66-1.googlebot.com': [{ type: 1, data: IP }],
    });

  it('accepts forward-confirmed reverse DNS and caches the answer in KV', async () => {
    const siteEnv = parseSiteEnv(env);
    const ip = '66.249.66.1';
    const doh = genuine();
    const request = {
      ip,
      userAgent: GOOGLEBOT_UA,
      verifiedBotCategory: 'Search Engine Crawler',
    };
    expect(await isVerifiedSearchCrawler(siteEnv, request, doh.fetch)).toBe(true);
    expect(doh.lookups).toEqual([`PTR ${REVERSE}`, 'A crawl-66-249-66-1.googlebot.com']);

    // Cached: no further lookups, even with a resolver that fails.
    const failing = async () => {
      throw new Error('no network');
    };
    expect(await isVerifiedSearchCrawler(siteEnv, request, failing)).toBe(true);
  });

  it('denies a forged User-Agent without a verified category, without any lookup', async () => {
    const doh = genuine();
    const siteEnv = parseSiteEnv(env);
    expect(
      await isVerifiedSearchCrawler(
        siteEnv,
        { ip: '203.0.113.9', userAgent: GOOGLEBOT_UA, verifiedBotCategory: undefined },
        doh.fetch,
      ),
    ).toBe(false);
    expect(
      await isVerifiedSearchCrawler(
        siteEnv,
        { ip: '203.0.113.9', userAgent: GOOGLEBOT_UA, verifiedBotCategory: 'AI Crawler' },
        doh.fetch,
      ),
    ).toBe(false);
    expect(doh.lookups).toEqual([]);
  });

  it('denies reverse DNS outside the crawler domains or that does not resolve back', async () => {
    const siteEnv = parseSiteEnv(env);
    const request = (ip: string) => ({
      ip,
      userAgent: GOOGLEBOT_UA,
      verifiedBotCategory: 'Search Engine Crawler',
    });
    const wrongDomain = fakeDoh({
      'PTR 7.113.0.203.in-addr.arpa': [{ type: 12, data: 'googlebot.com.evil.example.' }],
      'A googlebot.com.evil.example': [{ type: 1, data: '203.0.113.7' }],
    });
    expect(await isVerifiedSearchCrawler(siteEnv, request('203.0.113.7'), wrongDomain.fetch)).toBe(
      false,
    );
    const noForward = fakeDoh({
      'PTR 8.113.0.203.in-addr.arpa': [{ type: 12, data: 'crawl.googlebot.com.' }],
      'A crawl.googlebot.com': [{ type: 1, data: '66.249.66.2' }],
    });
    expect(await isVerifiedSearchCrawler(siteEnv, request('203.0.113.8'), noForward.fetch)).toBe(
      false,
    );
  });

  it('gives full access only with exposeGated on, the flag on and a verified crawler', async () => {
    const doh = genuine();
    const crawlerSite = testSite({ dnsFetch: doh.fetch });
    const init = {
      headers: { 'user-agent': GOOGLEBOT_UA, 'cf-connecting-ip': IP },
      cf: { verifiedBotCategory: 'Search Engine Crawler' },
    };
    const whoami = async (origin: string, extra = init) =>
      (await (await call(crawlerSite, `${origin}/whoami`, extra)).json()) as { crawler: boolean };

    const off = await seedChannel({ exposeGated: false });
    expect((await whoami(off.origin)).crawler).toBe(false);

    const ch = await seedChannel({ exposeGated: true });
    // Flag off (the default): no access.
    expect((await whoami(ch.origin)).crawler).toBe(false);

    await env.DB.prepare(
      `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
       VALUES (?1, 'gated_seo_exposure', 'channel', ?2, 1, 0)`,
    )
      .bind(`ff_${crypto.randomUUID()}`, ch.channelId)
      .run();
    await env.CACHE.delete(`flags:v1:${ch.workspaceId}:${ch.channelId}`);
    expect((await whoami(ch.origin)).crawler).toBe(true);

    // Same request without Cloudflare's verification: a forged User-Agent.
    expect(
      (await whoami(ch.origin, { headers: init.headers, cf: {} } as typeof init)).crawler,
    ).toBe(false);
  });
});

describe('security headers', () => {
  it('sends a strict CSP whose nonce matches the page', async () => {
    const ch = await seedChannel();
    const res = await call(site, `${ch.origin}/page`, { headers: { 'user-agent': BROWSER_UA } });
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`style-src 'self' 'nonce-${nonce}'`);
    expect(csp).toContain("img-src 'self' http://localhost:8792 https: data:");
    expect(csp).toContain("form-action 'self' http://localhost:8791");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(await res.text()).toContain(`<script nonce="${nonce}">`);
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('permissions-policy')).toContain('camera=()');
  });

  it('keeps headers a route set itself', async () => {
    const ch = await seedChannel();
    const res = await call(site, `${ch.origin}/_swarm/reader/signin`);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('serves media with a cross-origin resource policy, so other origins can embed it', async () => {
    const key = `ws/ws_${'d'.repeat(32)}/ch/ch_${'e'.repeat(32)}/md_${'f'.repeat(32)}.png`;
    await env.MEDIA.put(key, 'png', {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { visibility: 'public' },
    });
    const res = await call(app, `http://localhost/media/${key}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('gives the unknown-host page a CSP too', async () => {
    const res = await call(app, 'http://nobody-at-all.swarm.test/');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});

describe('edge HTML cache', () => {
  it('keys pages by host, path and query, reader class and cache version', () => {
    const base = {
      host: 'a.swarm.test',
      channelId: 'ch_a',
      pathAndQuery: '/p/x?y=1',
      readerClass: 'anonymous',
      cacheVersion: 1,
    } as const;
    const keys = new Set([
      edgeCacheKey(base),
      edgeCacheKey({ ...base, readerClass: 'member' }),
      edgeCacheKey({ ...base, readerClass: 'paid' }),
      edgeCacheKey({ ...base, readerClass: 'crawler' }),
      edgeCacheKey({ ...base, cacheVersion: 2 }),
      edgeCacheKey({ ...base, host: 'b.swarm.test' }),
      edgeCacheKey({ ...base, channelId: 'ch_b' }),
      edgeCacheKey({ ...base, pathAndQuery: '/p/x?y=2' }),
      edgeCacheKey({ ...base, pathAndQuery: '/p/x' }),
    ]);
    expect(keys.size).toBe(9);
    expect(edgeCacheKey({ ...base, host: 'A.SWARM.TEST' })).toBe(edgeCacheKey(base));
    expect(new URL(edgeCacheKey(base)).protocol).toBe('https:');
  });

  it('keys only the query parameters a route renders from, in one order', () => {
    const q = (search: string) => cacheQuery(new URLSearchParams(search));
    expect(q('page=2&sort=top')).toEqual({ query: '?page=2&sort=top', lookup: true, store: true });
    // Another order, noise and campaign tags: the canonical entry, never stored.
    expect(q('sort=top&page=2')).toEqual({ query: '?page=2&sort=top', lookup: true, store: false });
    expect(q('page=2&utm_source=x&junk=1')).toEqual({
      query: '?page=2',
      lookup: true,
      store: false,
    });
    expect(q('page=0002')).toEqual({ query: '', lookup: true, store: false });
    expect(q('page=2&page=3')).toEqual({ query: '?page=2', lookup: true, store: false });
    // Per-request pages skip the cache altogether.
    expect(q('gift=abc').lookup).toBe(false);
    expect(q('q=fox').lookup).toBe(false);
    expect(q('')).toEqual({ query: '', lookup: true, store: true });
  });

  it('answers query noise from the canonical entry and never stores it', async () => {
    const ch = await seedChannel();
    const headers = { 'user-agent': BROWSER_UA };
    const noisy = await call(site, `${ch.origin}/page?utm_campaign=a1`, { headers });
    expect(noisy.status).toBe(200);
    expect(noisy.headers.get('x-swarm-cache')).toBeNull();
    // Still nothing stored: the clean page misses, then hits.
    expect((await call(site, `${ch.origin}/page`, { headers })).headers.get('x-swarm-cache')).toBe(
      'miss',
    );
    const rendered = renders.count;
    for (const junk of ['a2', 'a3', 'a4']) {
      const res = await call(site, `${ch.origin}/page?utm_campaign=${junk}&x=${junk}`, { headers });
      expect(res.headers.get('x-swarm-cache')).toBe('hit');
    }
    expect(renders.count).toBe(rendered);
  });

  it('serves a cacheable page from the cache with a fresh nonce', async () => {
    const ch = await seedChannel();
    const headers = { 'user-agent': BROWSER_UA };
    const first = await call(site, `${ch.origin}/page`, { headers });
    expect(first.headers.get('x-swarm-cache')).toBe('miss');
    expect(first.headers.get('x-swarm-cacheable')).toBeNull();
    expect(first.headers.get('cache-control')).toBe(PUBLIC_PAGE_CACHE);
    const firstBody = await first.text();
    const rendered = renders.count;

    const second = await call(site, `${ch.origin}/page`, { headers });
    expect(second.headers.get('x-swarm-cache')).toBe('hit');
    expect(second.headers.get('x-swarm-nonce')).toBeNull();
    expect(renders.count).toBe(rendered);
    expect(second.headers.get('cache-control')).toBe(PUBLIC_PAGE_CACHE);
    expect(second.headers.get('cache-tag')).toBe(ch.channelId);
    const body = await second.text();
    const nonce = /'nonce-([^']+)'/.exec(second.headers.get('content-security-policy') ?? '')?.[1];
    expect(body).toContain(`<script nonce="${nonce}">`);
    expect(body).toContain(`<style nonce="${nonce}">`);
    expect(body.replace(/nonce="[^"]+"/g, '')).toBe(firstBody.replace(/nonce="[^"]+"/g, ''));
    expect(firstBody).not.toContain(`nonce="${nonce}"`);
  });

  it('keeps reader classes apart and marks signed-in pages private', async () => {
    const ch = await seedChannel();
    await call(site, `${ch.origin}/page`);
    expect((await call(site, `${ch.origin}/page`)).headers.get('x-swarm-cache')).toBe('hit');

    const memberId = await addMember(ch.channelId, `m-${crypto.randomUUID()}@example.org`);
    const cookie = await sessionCookie(ch.channelId, memberId);
    const member = await call(site, `${ch.origin}/page`, { headers: { cookie } });
    expect(member.headers.get('x-swarm-cache')).toBe('miss');
    expect(await member.text()).toContain('member render');
    expect(member.headers.get('cache-control')).toBe('private, no-cache');
    const again = await call(site, `${ch.origin}/page`, { headers: { cookie } });
    expect(again.headers.get('x-swarm-cache')).toBe('hit');
    expect(await again.text()).toContain('member render');
    expect(again.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('misses after the cache version is bumped', async () => {
    const ch = await seedChannel({ cacheVersion: 1 });
    await call(site, `${ch.origin}/page`);
    expect((await call(site, `${ch.origin}/page`)).headers.get('x-swarm-cache')).toBe('hit');
    await setSettings(ch.channelId, { cacheVersion: 2 });
    expect((await call(site, `${ch.origin}/page`)).headers.get('x-swarm-cache')).toBe('miss');
  });

  it('never serves a hostname’s pages from the Channel it belonged to before', async () => {
    const before = await seedChannel({ cacheVersion: 1 });
    const after = await seedChannel({ cacheVersion: 1 });
    await call(site, `${before.origin}/page`);
    expect((await call(site, `${before.origin}/page`)).headers.get('x-swarm-cache')).toBe('hit');
    // The hostname moves: the old Channel gives up the slug and the other one takes it.
    await env.DB.prepare('UPDATE channels SET slug = ?1 WHERE id = ?2')
      .bind(`${before.slug}-old`, before.channelId)
      .run();
    await env.DB.prepare('UPDATE channels SET slug = ?1 WHERE id = ?2')
      .bind(before.slug, after.channelId)
      .run();
    const res = await call(site, `${before.origin}/page`);
    expect(res.headers.get('x-swarm-cache')).toBe('miss');
    expect(res.headers.get('cache-tag')).toBe(after.channelId);
  });

  it('never stores responses with Set-Cookie, non-200 responses or unmarked pages', async () => {
    const ch = await seedChannel();
    for (const path of ['/with-cookie', '/missing', '/uncached']) {
      await call(site, `${ch.origin}${path}`);
      const res = await call(site, `${ch.origin}${path}`);
      expect(res.headers.get('x-swarm-cache'), path).not.toBe('hit');
      expect(res.headers.get('x-swarm-cacheable'), path).toBeNull();
    }
  });

  it('does not cache pages for a reader whose session cookie was just refreshed', async () => {
    const ch = await seedChannel();
    const memberId = await addMember(ch.channelId, `m-${crypto.randomUUID()}@example.org`);
    const cookie = await sessionCookie(ch.channelId, memberId);
    await env.DB.prepare('UPDATE reader_sessions SET last_seen_at = 0 WHERE member_id = ?1')
      .bind(memberId)
      .run();
    const res = await call(site, `${ch.origin}/page`, {
      headers: { cookie, 'cf-connecting-ip': nextIp() },
    });
    expect(res.headers.get('set-cookie')).toContain('swarm_reader=');
    expect(res.headers.get('x-swarm-cache')).toBeNull();
    // The next request (no refresh due) is a miss, then a hit.
    expect(
      (await call(site, `${ch.origin}/page`, { headers: { cookie } })).headers.get('x-swarm-cache'),
    ).toBe('miss');
  });

  it('caches the stylesheet, feeds and permanent redirects without touching their bodies', async () => {
    const ch = await seedChannel();
    for (const path of ['/_swarm/site.css?v=1.abc', '/feed', '/p/old-slug']) {
      const first = await call(site, `${ch.origin}${path}`);
      const firstBody = await first.text();
      const rendered = renders.count;
      const second = await call(site, `${ch.origin}${path}`);
      expect(second.headers.get('x-swarm-cache'), path).toBe('hit');
      expect(second.status, path).toBe(first.status);
      expect(await second.text(), path).toBe(firstBody);
      expect(second.headers.get('cache-control'), path).toBe(PUBLIC_PAGE_CACHE);
      expect(renders.count, path).toBe(rendered);
      if (path === '/p/old-slug') expect(second.headers.get('location')).toBe('/p/new-slug');
    }
  });

  it('keeps the route s-maxage as the edge lifetime and skips reader routes', () => {
    expect(edgeTtl(PUBLIC_PAGE_CACHE)).toBe(300);
    expect(edgeTtl('private, no-cache')).toBe(300);
    expect(edgeTtl('public, max-age=0, s-maxage=60')).toBe(60);
    expect(isCacheLookupPath('/_swarm/reader/signin')).toBe(false);
    expect(isCacheLookupPath('/_swarm/site.css')).toBe(true);
    expect(isCacheLookupPath('/p/x')).toBe(true);
  });
});
