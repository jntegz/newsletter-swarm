import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { compileTheme, standardSettings, type ThemeFiles } from '@swarm/site-themes';
import { BUILT_IN_THEMES } from '@swarm/site-themes/themes';
import { signSitePreview } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { testLinks } from './links';
import { parseSiteEnv } from '../src/env';
import { createSite, mountSite } from '../src/index';
import { SUBSCRIBER_COUNT_FLOOR } from '../src/render/templates';
import {
  addEntitlement,
  addMember,
  call,
  seedChannel,
  sessionCookie,
  uniqueEmail,
  type SeededChannel,
} from './helpers';

const site = createSite((s) => mountSite(s));

// A small theme with the shared section ids, standing in for the built-in ones.
const FIXTURE: ThemeFiles = {
  'theme.json': JSON.stringify({
    name: 'Fixture',
    settings: standardSettings({ accent: '#2f5d50', heading_font: 'serif', body_font: 'inter' }),
    sections: [
      { type: 'hero' },
      { type: 'latest', settings: { count: 3 } },
      { type: 'subscribe_band' },
    ],
  }),
  'layout.html': '<div class="t-page">{% sections %}</div>',
  'sections/hero.html': `<section class="t-hero"><h1>{{ section.settings.heading | default: site.name }}</h1>
<p class="t-pitch">{{ section.settings.pitch | default: site.description }}</p>
{% if section.settings.show_count and site.subscriber_count %}<p class="t-count">Read by {{ site.subscriber_count | number }} people</p>{% endif %}
{% if section.settings.image %}{{ section.settings.image | image: '(min-width: 960px) 50vw, 100vw' }}{% endif %}
{% unless reader.is_subscriber %}{% subscribe_form %}{% endunless %}
{% if reader.is_paid %}<p class="t-paid">Thanks for paying</p>{% endif %}
</section>
{% schema %}{"name":"Hero","settings":[{"id":"heading","type":"text","label":"Heading","max":120},{"id":"pitch","type":"textarea","label":"Pitch","max":400},{"id":"show_count","type":"checkbox","label":"Show the count"},{"id":"image","type":"image","label":"Image"}]}{% endschema %}`,
  'sections/benefits.html': `<ul class="t-benefits">{% for item in section.settings.items %}<li>{{ item.title }}</li>{% endfor %}</ul>
{% schema %}{"name":"Benefits","settings":[{"id":"items","type":"list","label":"Items","fields":[{"id":"title","type":"text","label":"Title"},{"id":"text","type":"textarea","label":"Text"}]}]}{% endschema %}`,
  'sections/latest.html': `<ul class="t-latest">{% for post in posts limit: section.settings.count %}<li><a href="{{ post.url }}">{{ post.title }}</a> <span>{{ post.reading_minutes }} min</span>{% if post.is_paid %} paid{% endif %}</li>{% else %}<li>Nothing yet</li>{% endfor %}</ul>
<p class="t-total">{{ site.issue_count | plural: 'issue', 'issues' }}</p>
{% schema %}{"name":"Latest","settings":[{"id":"count","type":"range","label":"How many","min":1,"max":12,"default":3}]}{% endschema %}`,
  'sections/members.html': `<p class="t-members">For subscribers only</p>
{% schema %}{"name":"Members","settings":[]}{% endschema %}`,
  'sections/subscribe_band.html': `<aside class="t-band">{% unless reader.is_subscriber %}{% subscribe_form %}{% endunless %}</aside>
{% schema %}{"name":"Subscribe","settings":[]}{% endschema %}`,
  'sections/boom.html': `{% for a in section.settings.items %}{% for b in section.settings.items %}{% for c in section.settings.items %}{% for d in section.settings.items %}xxxx{% endfor %}{% endfor %}{% endfor %}{% endfor %}
{% schema %}{"name":"Boom","settings":[{"id":"items","type":"list","label":"Items","fields":[{"id":"x","type":"text","label":"X"}]}]}{% endschema %}`,
  'theme.css': '.t-page{color:var(--ink)}.t-fixture-marker{display:block}',
};

for (const id of [
  'gate',
  'letter',
  'magazine',
  'newspaper',
  'launch',
  'night',
  'zine',
  'brief',
] as const) {
  BUILT_IN_THEMES[id] = { id, name: `Fixture ${id}`, description: 'Test theme', files: FIXTURE };
}

const on = (ch: SeededChannel) =>
  env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
     VALUES (?1, 'site_templates', 'channel', ?2, 1, 0)`,
  )
    .bind(newId('featureFlag'), ch.channelId)
    .run();

const settings = (ch: SeededChannel, theme: Record<string, unknown>, css = '') =>
  env.DB.prepare(
    `INSERT INTO site_settings (channel_id, theme_json, custom_css, updated_at) VALUES (?1, ?2, ?3, 0)
     ON CONFLICT (channel_id) DO UPDATE SET theme_json = ?2, custom_css = ?3,
       cache_version = cache_version + 1`,
  )
    .bind(ch.channelId, JSON.stringify(theme), css)
    .run();

interface DesignInput {
  theme?: string;
  files?: ThemeFiles | null;
  settings?: Record<string, unknown>;
  sections?: Record<string, unknown>[] | null;
}

const design = (d: DesignInput = {}) =>
  JSON.stringify({ theme: 'launch', files: null, settings: {}, sections: null, ...d });

/** Stores a draft and, unless `draftOnly`, publishes it (as the API does). */
async function store(ch: SeededChannel, published: DesignInput | null, draft?: DesignInput) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO site_designs (channel_id, draft_json, draft_updated_at, published_json, published_version, published_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?3)
       ON CONFLICT (channel_id) DO UPDATE SET draft_json = excluded.draft_json,
         published_json = excluded.published_json,
         published_version = site_designs.published_version + 1`,
    ).bind(
      ch.channelId,
      design(draft ?? published ?? {}),
      now,
      published ? design(published) : null,
      published ? 1 : 0,
    ),
    env.DB.prepare(
      `INSERT INTO site_settings (channel_id, cache_version, updated_at) VALUES (?1, 2, ?2)
       ON CONFLICT (channel_id) DO UPDATE SET cache_version = cache_version + 1`,
    ).bind(ch.channelId, now),
  ]);
}

async function publishDispatch(ch: SeededChannel, subject: string, visibility = 'public') {
  const id = newId('dispatch');
  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, preheader, content_json, status, created_at, updated_at, web_visibility, web_published_at)
       VALUES (?1, ?2, ?3, '', ?4, 'sent', 0, ?5, ?6, ?5)`,
    ).bind(
      id,
      ch.channelId,
      subject,
      JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Words' }] }],
      }),
      now,
      visibility,
    ),
    env.DB.prepare(
      'INSERT INTO dispatch_slugs (channel_id, slug, dispatch_id, is_current, created_at) VALUES (?1, ?2, ?3, 1, 0)',
    ).bind(ch.channelId, slug, id),
  ]);
}

const get = (ch: SeededChannel, path: string, init: RequestInit = {}) =>
  call(site, `${ch.origin}${path}`, init);

const stylesheetOf = async (ch: SeededChannel, html: string) => {
  const href = /href="(\/_swarm\/site\.css[^"]*)"/.exec(html)![1]!;
  return { href, css: await (await get(ch, href.replace(/&amp;/g, '&'))).text() };
};

describe('website designs', () => {
  it('starts from a fixture theme that compiles', () => {
    const { problems } = compileTheme(FIXTURE);
    expect(problems.filter((p) => p.severity === 'error')).toEqual([]);
  });

  it('draws the published design: for a visitor, a subscriber and a paid subscriber', async () => {
    const ch = await seedChannel();
    await on(ch);
    await publishDispatch(ch, 'First light');
    await publishDispatch(ch, 'Behind the paywall', 'paid');
    await store(ch, {
      settings: { accent: '#aa3311' },
      sections: [
        { id: 'hero', type: 'hero', settings: { heading: 'Letters from the field' } },
        { id: 'news', type: 'latest', settings: { count: 5 } },
        { id: 'members', type: 'members', settings: {}, audience: 'subscribers' },
      ],
    });

    const visitor = await get(ch, '/');
    expect(visitor.status).toBe(200);
    const html = await visitor.text();
    expect(html).toContain('<h1>Letters from the field</h1>');
    expect(html).toContain('First light');
    expect(html).toMatch(/Behind the paywall<\/a> <span>1 min<\/span> paid/);
    expect(html).toContain('2 issues');
    expect(html).toContain('data-swarm-subscribe');
    expect(html).not.toContain('For subscribers only');
    expect(html).toContain('class="t-section t-section--hero"');
    // The design's tokens decide light and dark, and its text font names the <html> class.
    expect(html).toContain('class="sw-font-inter" data-scheme="t-light"');
    // The theme draws its own signup, so the page adds none.
    expect(html).not.toContain('id="subscribe"');
    expect(visitor.headers.get('cache-control')).toContain('public');

    const memberId = await addMember(ch.channelId, uniqueEmail());
    const cookie = await sessionCookie(ch.channelId, memberId);
    const member = await (await get(ch, '/', { headers: { cookie } })).text();
    expect(member).toContain('For subscribers only');
    expect(member).not.toContain('data-swarm-subscribe');
    expect(member).not.toContain('Thanks for paying');

    const paidId = await addMember(ch.channelId, uniqueEmail());
    await addEntitlement(ch.channelId, paidId, Date.now() - 1000, null);
    const paid = await get(ch, '/', {
      headers: { cookie: await sessionCookie(ch.channelId, paidId) },
    });
    expect(await paid.text()).toContain('Thanks for paying');
  });

  it('puts the design’s rules in the stylesheet, after the base and before the owner’s CSS', async () => {
    const ch = await seedChannel();
    await on(ch);
    await settings(ch, {}, 'body{outline:1px solid red}');
    await store(ch, { settings: { accent: '#aa3311' } });
    const html = await (await get(ch, '/')).text();
    const { href, css } = await stylesheetOf(ch, html);
    const base = css.indexOf('.sw-wrap{');
    const tokens = css.indexOf('--accent:#aa3311');
    const theme = css.indexOf('.t-fixture-marker');
    const own = css.indexOf('body{outline:1px solid red}');
    expect(base).toBeGreaterThan(-1);
    expect(tokens).toBeGreaterThan(base);
    expect(theme).toBeGreaterThan(tokens);
    expect(own).toBeGreaterThan(theme);
    // The base variables sit on html, so the design's (also on html, later) win.
    expect(css.startsWith('html{--accent:')).toBe(true);
    expect(css).not.toMatch(/https?:\/\//);

    // Publishing again bumps the cache version: a new stylesheet address.
    await store(ch, { settings: { accent: '#113355' } });
    const again = await (await get(ch, '/')).text();
    const next = await stylesheetOf(ch, again);
    expect(next.href).not.toBe(href);
    expect(next.css).toContain('--accent:#113355');
  });

  it('gives other pages the tokens, with their own markup', async () => {
    const ch = await seedChannel();
    await on(ch);
    await publishDispatch(ch, 'An old issue');
    await store(ch, { settings: { scheme: 'dark' } });
    const archive = await (await get(ch, '/archive')).text();
    expect(archive).toContain('data-scheme="t-dark"');
    expect(archive).toContain('sw-t-featured');
    const { css } = await stylesheetOf(ch, archive);
    expect(css).toContain('.t-fixture-marker');
  });

  it('makes a design from the old template settings until one is published', async () => {
    const ch = await seedChannel();
    await on(ch);
    await settings(ch, {
      template: 'gate',
      headline: 'The old headline',
      pitch: 'The old pitch',
      benefits: ['Never lost'],
      showSubscriberCount: true,
    });
    let html = await (await get(ch, '/')).text();
    expect(html).toContain('<h1>The old headline</h1>');
    expect(html).toContain('The old pitch');
    // Fewer than the floor: no count.
    expect(html).not.toContain('Read by');

    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: SUBSCRIBER_COUNT_FLOOR }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO members (id, channel_id, email, status, created_at, updated_at)
           VALUES (?1, ?2, ?3, 'active', ?4, ?4)`,
        ).bind(newId('member', now), ch.channelId, `r${i}-${ch.slug}@example.org`, now),
      ),
    );
    await settings(ch, {
      template: 'gate',
      headline: 'The old headline',
      showSubscriberCount: true,
    });
    html = await (await get(ch, '/')).text();
    expect(html).toContain(`Read by ${SUBSCRIBER_COUNT_FLOOR} people`);

    // A saved draft changes nothing on the site; publishing does.
    await store(ch, null, {
      sections: [{ id: 'h', type: 'hero', settings: { heading: 'Draft' } }],
    });
    expect(await (await get(ch, '/')).text()).toContain('The old headline');
    await store(ch, { sections: [{ id: 'h', type: 'hero', settings: { heading: 'Published' } }] });
    expect(await (await get(ch, '/')).text()).toContain('<h1>Published</h1>');
  });

  it('leaves the site as it was with the flag off or no template chosen', async () => {
    const off = await seedChannel();
    await store(off, { sections: [{ id: 'h', type: 'hero', settings: { heading: 'Hidden' } }] });
    const plain = await (await get(off, '/')).text();
    expect(plain).not.toContain('Hidden');
    expect(plain).toContain('sw-home-magazine');
    expect(plain).toContain('data-scheme="auto"');

    const none = await seedChannel();
    await on(none);
    const html = await (await get(none, '/')).text();
    expect(html).toContain('sw-home-magazine');
    expect(html).not.toContain('t-section');
  });

  it('falls back to the plain home page when a design can’t be drawn', async () => {
    const ch = await seedChannel();
    await on(ch);
    const items = Array.from({ length: 20 }, (_, i) => ({ x: `${i}` }));
    await store(ch, {
      sections: [
        { id: 'hero', type: 'hero', settings: {} },
        { id: 'boom', type: 'boom', settings: { items } },
      ],
    });
    const res = await get(ch, '/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('sw-home-magazine');
    expect(html).not.toContain('xxxx');
  });

  it('serves the fonts it names, and refuses others', async () => {
    const ch = await seedChannel();
    const font = await get(ch, '/_swarm/fonts/grotesk.woff2');
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect((await get(ch, '/_swarm/fonts/other.woff2')).status).toBe(404);
    // The name comes from the URL: Object.prototype's names are no fonts either.
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty.woff2']) {
      expect((await get(ch, `/_swarm/fonts/${name}`)).status, name).toBe(404);
    }
  });
});

describe('design previews', () => {
  const keys = () => testLinks();
  const previewOf = async (ch: SeededChannel, as: 'visitor' | 'subscriber' | 'paid') => {
    const { token } = await signSitePreview(keys(), { channelId: ch.channelId, as });
    return `/_swarm/preview?token=${encodeURIComponent(token)}`;
  };

  it('draws the draft, never cached, never indexed, with no cookie and only what it needs', async () => {
    const ch = await seedChannel();
    await on(ch);
    await store(
      ch,
      { sections: [{ id: 'h', type: 'hero', settings: { heading: 'Live' } }] },
      {
        settings: { accent: '#225588' },
        sections: [
          { id: 'h', type: 'hero', settings: { heading: 'Draft heading' } },
          { id: 'm', type: 'members', settings: {}, audience: 'subscribers' },
        ],
      },
    );
    const res = await get(ch, await previewOf(ch, 'visitor'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Draft heading');
    expect(html).not.toContain('>Live<');
    expect(html).not.toContain('For subscribers only');
    expect(html).toContain('sw-preview-bar');
    expect(html).not.toContain('<script nonce');
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).toContain('--accent:#225588');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-frame-options')).toBeNull();
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = /<style nonce="([^"]+)"/.exec(html)![1]!;
    expect(csp).toContain(`style-src 'nonce-${nonce}'`);
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain(`frame-ancestors ${parseSiteEnv(env).APP_ORIGIN}`);

    const member = await (await get(ch, await previewOf(ch, 'subscriber'))).text();
    expect(member).toContain('For subscribers only');
    expect(member).toContain('as a subscriber');
    // The live site still shows the published design.
    expect(await (await get(ch, '/')).text()).toContain('<h1>Live</h1>');
  });

  it('previews a Channel that only has its old template settings', async () => {
    const ch = await seedChannel();
    await on(ch);
    await settings(ch, { template: 'letter', headline: 'From the old settings' });
    const html = await (await get(ch, await previewOf(ch, 'paid'))).text();
    expect(html).toContain('From the old settings');
    expect(html).toContain('Thanks for paying');
  });

  it('refuses bad, expired and other Channels’ tokens with a plain 403', async () => {
    const ch = await seedChannel();
    const other = await seedChannel();
    await on(ch);
    await on(other);
    const expired = await signSitePreview(
      keys(),
      { channelId: ch.channelId, as: 'visitor' },
      { now: Date.now() - 31 * 60 * 1000 },
    );
    const wrongPurpose = await keys().sign('checkout-ref', {
      r: 'x',
      c: ch.channelId,
      as: 'visitor',
    });
    for (const path of [
      '/_swarm/preview',
      '/_swarm/preview?token=nope',
      `/_swarm/preview?token=${encodeURIComponent(expired.token)}`,
      `/_swarm/preview?token=${encodeURIComponent(wrongPurpose)}`,
      await previewOf(other, 'visitor'),
    ]) {
      const res = await get(ch, path);
      expect(res.status, path).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).not.toContain('sw-preview-bar');
    }
  });

  it('is refused with the flag off', async () => {
    const ch = await seedChannel();
    expect((await get(ch, await previewOf(ch, 'visitor'))).status).toBe(403);
  });
});
