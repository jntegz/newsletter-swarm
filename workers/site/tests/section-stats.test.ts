// Section analytics and A/B tests on the home page (docs/site-themes.md): variants chosen before
// the edge cache and kept apart in it, the lazy beacon and what it counts, the section in the
// signup form, and previews of variant B that count nothing.
import { env } from 'cloudflare:test';
import { analyticsDay } from '@swarm/engine';
import { newId } from '@swarm/domain';
import { standardSettings, type ThemeFiles } from '@swarm/site-themes';
import { signSitePreview } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { testLinks } from './links';
import { edgeCacheKey, variantsKey } from '../src/edge/cache';
import { assignVariants } from '../src/edge/variants';
import { createSite, mountSite } from '../src/index';
import { BROWSER_UA, call, seedChannel, type SeededChannel } from './helpers';

const FILES: ThemeFiles = {
  'theme.json': JSON.stringify({
    name: 'Tests',
    settings: standardSettings({ accent: '#2f5d50' }),
    sections: [{ type: 'hero' }],
  }),
  'layout.html': '<div class="t-page">{% sections %}</div>',
  'sections/hero.html': `<section><h1>{{ section.settings.heading | default: site.name }}</h1>{% unless reader.is_subscriber %}{% subscribe_form %}{% endunless %}</section>
{% schema %}{"name":"Hero","settings":[{"id":"heading","type":"text","label":"Heading","max":120}]}{% endschema %}`,
  'sections/note.html': `<p class="t-note">{{ section.settings.text }}</p>
{% schema %}{"name":"Note","settings":[{"id":"text","type":"text","label":"Text"}]}{% endschema %}`,
  'theme.css': '.t-page{color:var(--ink)}',
};

const experiment = (variantB: Record<string, unknown>, status = 'running') => ({
  id: 'exp-1',
  status,
  variantB,
  startedAt: '2026-11-01T09:00:00.000Z',
});

const SECTIONS = [
  {
    id: 'hero',
    type: 'hero',
    settings: { heading: 'Heading A' },
    experiment: experiment({ heading: 'Heading B' }),
  },
  { id: 'note', type: 'note', settings: { text: 'A note' } },
];

/** A fixed sequence of coin tosses for the edge: 0 is A, 0.9 is B. */
function tosses() {
  const queue: number[] = [];
  return { random: () => queue.shift() ?? 0, next: (...v: number[]) => queue.push(...v) };
}

const coin = tosses();
const site = createSite((s) => mountSite(s), { random: coin.random });

async function publish(ch: SeededChannel, sections: unknown[], draft?: unknown[]) {
  const now = Date.now();
  const design = (list: unknown[]) =>
    JSON.stringify({ theme: 'launch', files: FILES, settings: {}, sections: list });
  const tests = sections
    .filter((s) => (s as { experiment?: { status: string } }).experiment?.status === 'running')
    .map((s) => (s as { id: string }).id);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
       VALUES (?1, 'site_templates', 'channel', ?2, 1, 0) ON CONFLICT DO NOTHING`,
    ).bind(newId('featureFlag'), ch.channelId),
    env.DB.prepare(
      `INSERT INTO site_designs (channel_id, draft_json, draft_updated_at, published_json,
         published_version, published_at, published_tests)
       VALUES (?1, ?2, ?3, ?4, 1, ?3, ?5)
       ON CONFLICT (channel_id) DO UPDATE SET draft_json = excluded.draft_json,
         published_json = excluded.published_json, published_tests = excluded.published_tests,
         published_version = site_designs.published_version + 1`,
    ).bind(ch.channelId, design(draft ?? sections), now, design(sections), JSON.stringify(tests)),
    env.DB.prepare(
      `INSERT INTO site_settings (channel_id, cache_version, updated_at) VALUES (?1, 2, ?2)
       ON CONFLICT (channel_id) DO UPDATE SET cache_version = cache_version + 1`,
    ).bind(ch.channelId, now),
  ]);
}

const version = async (ch: SeededChannel) =>
  (
    await env.DB.prepare('SELECT published_version AS v FROM site_designs WHERE channel_id = ?1')
      .bind(ch.channelId)
      .first<{ v: number }>()
  )?.v ?? 0;

interface Row {
  section_id: string;
  variant: string;
  reached: number;
  signups: number;
}

const rows = async (ch: SeededChannel) =>
  (
    await env.DB.prepare(
      `SELECT section_id, variant, reached, signups FROM site_section_daily
        WHERE channel_id = ?1 AND day = ?2 ORDER BY section_id, variant`,
    )
      .bind(ch.channelId, analyticsDay())
      .all<Row>()
  ).results;

const browser = (extra: Record<string, string> = {}) => ({
  headers: { 'user-agent': BROWSER_UA, 'cf-connecting-ip': '203.0.113.40', ...extra },
});

const home = (ch: SeededChannel, init: RequestInit = browser()) =>
  call(site, `${ch.origin}/`, init);

const beaconOf = (html: string, section: string) => {
  const m = new RegExp(
    `<img src="(/_swarm/r\\?[^"]*s=${section}&amp;[^"]*)"[^>]*class="t-beacon">`,
  ).exec(html);
  return m ? m[1]!.replace(/&amp;/g, '&') : null;
};

describe('A/B test variants and the edge cache', () => {
  it('keys a page by its variants, in id order', () => {
    const base = {
      host: 'a.swarm.test',
      pathAndQuery: '/',
      readerClass: 'anonymous',
      channelId: 'ch_1',
      cacheVersion: 3,
    } as const;
    expect(variantsKey({})).toBe('');
    expect(variantsKey({ 'faq-3': 'a', 'hero-1': 'b' })).toBe('.ab-faq-3=a,hero-1=b');
    const keys = new Set([
      edgeCacheKey(base),
      edgeCacheKey({ ...base, variants: { hero: 'a' } }),
      edgeCacheKey({ ...base, variants: { hero: 'b' } }),
      edgeCacheKey({ ...base, variants: { hero: 'b', note: 'a' } }),
      edgeCacheKey({ ...base, readerClass: 'paid', levelId: 'lv_1', variants: { hero: 'b' } }),
      edgeCacheKey({ ...base, readerClass: 'paid', levelId: 'lv_1' }),
    ]);
    expect(keys.size).toBe(6);
    expect(edgeCacheKey({ ...base, variants: { note: 'a', hero: 'b' } })).toBe(
      edgeCacheKey({ ...base, variants: { hero: 'b', note: 'a' } }),
    );
    // A level id can't pass for a set of variants: it is URI-encoded.
    expect(edgeCacheKey({ ...base, readerClass: 'paid', levelId: 'x.ab-hero=b' })).not.toBe(
      edgeCacheKey({ ...base, readerClass: 'paid', levelId: 'x', variants: { hero: 'b' } }),
    );
  });

  it('gives each test A or B at random', () => {
    let n = 0;
    const flip = () => (n++ % 2 === 0 ? 0.2 : 0.7);
    expect(assignVariants(['hero', 'note'], flip)).toEqual({ hero: 'a', note: 'b' });
    expect(assignVariants([])).toEqual({});
  });

  it('draws the variant chosen before the cache, and never serves one for the other', async () => {
    const ch = await seedChannel();
    await publish(ch, SECTIONS);

    coin.next(0.9);
    const b = await home(ch);
    const bHtml = await b.text();
    expect(b.headers.get('x-swarm-cache')).toBe('miss');
    expect(bHtml).toContain('<h1>Heading B</h1>');
    expect(bHtml).not.toContain('Heading A');
    // No cache outside the edge may keep it for the address.
    expect(b.headers.get('cache-control')).toBe('private, no-cache');

    coin.next(0.1);
    const a = await home(ch);
    const aHtml = await a.text();
    expect(a.headers.get('x-swarm-cache')).toBe('miss');
    expect(aHtml).toContain('<h1>Heading A</h1>');
    expect(aHtml).not.toContain('Heading B');

    coin.next(0.9, 0.1);
    const bAgain = await home(ch);
    expect(bAgain.headers.get('x-swarm-cache')).toBe('hit');
    expect(await bAgain.text()).toContain('<h1>Heading B</h1>');
    expect(bAgain.headers.get('cache-control')).toBe('private, no-cache');
    const aAgain = await home(ch);
    expect(aAgain.headers.get('x-swarm-cache')).toBe('hit');
    expect(await aAgain.text()).toContain('<h1>Heading A</h1>');

    // Other pages are not tested and keep their public caching.
    const archive = await call(site, `${ch.origin}/archive`, browser());
    expect(archive.headers.get('cache-control')).toContain('public');
  });

  it('marks each section with its beacon, and the form with its section and variant', async () => {
    const ch = await seedChannel();
    await publish(ch, SECTIONS);
    const v = await version(ch);
    coin.next(0.9);
    const html = await (await home(ch)).text();
    expect(beaconOf(html, 'hero')).toBe(`/_swarm/r?d=${v}&s=hero&v=b`);
    expect(beaconOf(html, 'note')).toBe(`/_swarm/r?d=${v}&s=note&v=a`);
    expect(html).toMatch(
      /<img src="[^"]+" alt="" width="1" height="1" loading="lazy" decoding="async" aria-hidden="true" class="t-beacon"><\/div>/,
    );
    expect(html).toContain('<input type="hidden" name="sw_section" value="hero">');
    expect(html).toContain('<input type="hidden" name="sw_variant" value="b">');

    // Without tests, the page stays public and every section still has its beacon (variant A).
    const plain = await seedChannel();
    await publish(plain, [{ id: 'hero', type: 'hero', settings: {} }]);
    const res = await home(plain);
    const plainHtml = await res.text();
    expect(res.headers.get('cache-control')).toContain('public');
    expect(beaconOf(plainHtml, 'hero')).toBe(`/_swarm/r?d=${await version(plain)}&s=hero&v=a`);
    expect(plainHtml).toContain('name="sw_variant" value="a"');
  });
});

describe('the section beacon', () => {
  const beacon = (ch: SeededChannel, query: string, init: RequestInit = browser()) =>
    call(site, `${ch.origin}/_swarm/r?${query}`, init);

  it('answers a GIF nothing stores, and counts real views of the published design', async () => {
    const ch = await seedChannel();
    await publish(ch, SECTIONS);
    const v = await version(ch);
    const res = await beacon(ch, `d=${v}&s=hero&v=b`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await res.arrayBuffer()).slice(0, 3)).toEqual(
      new Uint8Array([0x47, 0x49, 0x46]),
    );
    await beacon(ch, `d=${v}&s=hero&v=b`);
    await beacon(ch, `d=${v}&s=hero&v=a`);
    await beacon(ch, `d=${v}&s=note&v=a`);
    expect(await rows(ch)).toEqual([
      { section_id: 'hero', variant: 'a', reached: 1, signups: 0 },
      { section_id: 'hero', variant: 'b', reached: 2, signups: 0 },
      { section_id: 'note', variant: 'a', reached: 1, signups: 0 },
    ]);
  });

  it('counts nothing for bots, prefetches, previews, other versions or unknown sections', async () => {
    const ch = await seedChannel();
    await publish(ch, SECTIONS);
    const v = await version(ch);
    const asks: [string, RequestInit][] = [
      [
        `d=${v}&s=hero&v=a`,
        browser({ 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' }),
      ],
      [`d=${v}&s=hero&v=a`, browser({ 'sec-purpose': 'prefetch' })],
      [`d=${v}&s=hero&v=a`, browser({ referer: `${ch.origin}/_swarm/preview?token=x` })],
      [`d=${v}&s=hero&v=a`, { headers: { 'cf-connecting-ip': '203.0.113.40' } }],
      [`d=${v - 1}&s=hero&v=a`, browser()],
      [`d=${v}&s=missing&v=a`, browser()],
      // The note has no test, so it has no variant B.
      [`d=${v}&s=note&v=b`, browser()],
      [`d=${v}&s=hero&v=c`, browser()],
      [`d=${v}&s=Not%20an%20id&v=a`, browser()],
      ['', browser()],
    ];
    for (const [query, init] of asks) {
      const res = await beacon(ch, query, init);
      expect(res.status, query).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/gif');
    }
    expect(await rows(ch)).toEqual([]);
    // Nor once the test has ended: B is gone from the page.
    await publish(ch, [
      { ...SECTIONS[0], experiment: { ...experiment({ heading: 'B' }, 'ended'), winner: 'a' } },
    ]);
    await beacon(ch, `d=${await version(ch)}&s=hero&v=b`);
    expect(await rows(ch)).toEqual([]);
  });
});

describe('previews of variant B', () => {
  const previewOf = async (ch: SeededChannel, query = '') => {
    const { token } = await signSitePreview(testLinks(), {
      channelId: ch.channelId,
      as: 'visitor',
    });
    return call(
      site,
      `${ch.origin}/_swarm/preview?token=${encodeURIComponent(token)}${query}`,
      browser(),
    );
  };

  it('shows B when asked, for every test or one section, and counts nothing', async () => {
    const ch = await seedChannel();
    const note = {
      id: 'note',
      type: 'note',
      settings: { text: 'Note A' },
      experiment: { ...experiment({ text: 'Note B' }), id: 'exp-2' },
    };
    await publish(ch, [SECTIONS[0]], [SECTIONS[0], note]);

    const a = await (await previewOf(ch)).text();
    expect(a).toContain('Heading A');
    expect(a).toContain('Note A');
    expect(a).not.toContain('with variant B');

    const allB = await (await previewOf(ch, '&variant=b')).text();
    expect(allB).toContain('Heading B');
    expect(allB).toContain('Note B');
    expect(allB).toContain('with variant B');

    const one = await (await previewOf(ch, '&variant=b&section=note')).text();
    expect(one).toContain('Heading A');
    expect(one).toContain('Note B');

    // Never counted: no beacon, and no section in the form.
    expect(allB).not.toContain('class="t-beacon"');
    expect(allB).not.toContain('sw_section');
    expect(await rows(ch)).toEqual([]);
  });
});
