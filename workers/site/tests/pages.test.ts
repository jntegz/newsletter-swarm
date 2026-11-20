import { SELF, env } from 'cloudflare:test';
import { SUBPROCESSORS_URL } from '@swarm/domain';
import { readFormStamp, searchStatements } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { testLinks } from './links';
import type { SiteChannel } from '../src/context';
import { dispatchArticle, renderDispatch, webDocument } from '../src/render/dispatch';
import type { SiteDispatch } from '../src/render/data';
import { ftsQuery } from '../src/render/data';
import { CSS_REVISION } from '../src/render/theme';
import { addMember, allowSiteCode, nextIp, sessionCookie } from './helpers';

const hex = () => crypto.randomUUID().replace(/-/g, '');
const MEDIA_ORIGIN = 'http://localhost:8792';
const CAPTURE_ORIGIN = 'http://localhost:8791';
const DAY = 24 * 60 * 60 * 1000;

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content: unknown[]) => JSON.stringify({ type: 'doc', content });

interface Fixture {
  slug: string;
  host: string;
  origin: string;
  workspaceId: string;
  channelId: string;
  mediaId: string;
  mediaKey: string;
  formId: string;
  ids: { hello: string; members: string; paid: string; hidden: string; draft: string };
}

interface FixtureOptions {
  aiBots?: 'unset' | 'allow' | 'block' | 'custom';
  layout?: 'magazine' | 'newspaper';
  pinPaid?: boolean;
  flags?: string[];
  form?: boolean;
}

async function seedSite(options: FixtureOptions = {}): Promise<Fixture> {
  const slug = `t-${hex().slice(0, 12)}`;
  const workspaceId = `ws_${hex()}`;
  const channelId = `ch_${hex()}`;
  const mediaId = `md_${hex()}`;
  const formId = `cf_${hex()}`;
  const mediaKey = `ws/${workspaceId}/ch/${channelId}/${mediaId}.png`;
  const ids = {
    hello: `dp_${hex()}`,
    members: `dp_${hex()}`,
    paid: `dp_${hex()}`,
    hidden: `dp_${hex()}`,
    draft: `dp_${hex()}`,
  };
  const now = Date.now();
  const dispatch = (
    id: string,
    subject: string,
    content: string,
    visibility: string,
    publishedAt: number | null,
  ) =>
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, preheader, content_json, status, created_at, updated_at, web_visibility, web_published_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'sent', 0, ?6, ?7, ?8)`,
    ).bind(id, channelId, subject, `${subject} subtitle`, content, now, visibility, publishedAt);
  const slugRow = (dispatchId: string, s: string, current = 1) =>
    env.DB.prepare(
      'INSERT INTO dispatch_slugs (channel_id, slug, dispatch_id, is_current, created_at) VALUES (?1, ?2, ?3, ?4, 0)',
    ).bind(channelId, s, dispatchId, current);

  const statements = [
    env.DB.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, 0, 0)',
    ).bind(workspaceId, 'W'),
    env.DB.prepare(
      `INSERT INTO channels (id, workspace_id, slug, name, description, branding_json, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Field Notes', 'Notes from the field.', ?4, 'active', 0, 0)`,
    ).bind(
      channelId,
      workspaceId,
      slug,
      JSON.stringify({ accentColor: '#0A7D5A', logoMediaId: mediaId }),
    ),
    env.DB.prepare(
      `INSERT INTO media (id, workspace_id, channel_id, r2_key, content_type, bytes, width, height, alt_text, visibility, created_at)
       VALUES (?1, ?2, ?3, ?4, 'image/png', 10, 1200, 630, 'A fox', 'public', 0)`,
    ).bind(mediaId, workspaceId, channelId, mediaKey),
    env.DB.prepare(
      `INSERT INTO site_settings (channel_id, layout, pinned_json, about_json, seo_json, theme_json, ai_bots, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)`,
    ).bind(
      channelId,
      options.layout ?? 'magazine',
      JSON.stringify(options.pinPaid ? [ids.paid] : []),
      doc(p('We write about foxes and fields.')),
      JSON.stringify({
        verification: { google: 'google-token-123' },
        sameAs: ['https://social.example/@fieldnotes'],
      }),
      JSON.stringify({ font: 'inter', colorScheme: 'dark', dropCaps: true }),
      options.aiBots ?? 'unset',
    ),
    dispatch(
      ids.hello,
      'Hello world',
      doc(
        { type: 'image', attrs: { mediaId, alt: 'A fox in a field' } },
        p('The quick brown fox jumps over the lazy dog.'),
      ),
      'public',
      now - 3 * DAY,
    ),
    dispatch(
      ids.members,
      'Subscribers note',
      doc(p('Free intro text.'), { type: 'gate' }, p('Secret member text.')),
      'members',
      now - 2 * DAY,
    ),
    dispatch(
      ids.paid,
      'Paid deep dive',
      doc(p('Paid para one.'), p('Paid para two.'), p('Paid para three.'), p('Paid para four.')),
      'paid',
      now - DAY,
    ),
    dispatch(ids.hidden, 'Hidden one', doc(p('Hidden text.')), 'hidden', now),
    dispatch(ids.draft, 'Draft one', doc(p('Draft text.')), 'public', null),
    slugRow(ids.hello, 'hello-world'),
    slugRow(ids.hello, 'hello-old', 0),
    slugRow(ids.members, 'members-note'),
    slugRow(ids.paid, 'paid-deep-dive'),
    slugRow(ids.hidden, 'hidden-one'),
    slugRow(ids.draft, 'draft-one'),
    env.DB.prepare(
      `INSERT INTO dispatch_search (dispatch_id, channel_id, title, subtitle, body)
       VALUES (?1, ?2, 'Hello world', '', 'The quick brown fox jumps over the lazy dog.')`,
    ).bind(ids.hello, channelId),
    env.DB.prepare(
      `INSERT INTO dispatch_search (dispatch_id, channel_id, title, subtitle, body)
       VALUES (?1, ?2, 'Hidden one', '', 'Hidden brown text.')`,
    ).bind(ids.hidden, channelId),
    env.DB.prepare(
      `INSERT INTO site_pages (id, channel_id, slug, title, content_json, status, in_nav, created_at, updated_at)
       VALUES (?1, ?2, 'colophon', 'Colophon', ?3, 'published', 1, 0, 0)`,
    ).bind(`pg_${hex()}`, channelId, doc(p('Set in system fonts.'))),
    env.DB.prepare(
      `INSERT INTO site_pages (id, channel_id, slug, title, content_json, status, created_at, updated_at)
       VALUES (?1, ?2, 'secret-draft', 'Secret', ?3, 'draft', 0, 0)`,
    ).bind(`pg_${hex()}`, channelId, doc(p('Not yet.'))),
  ];
  for (const key of options.flags ?? []) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, ?2, 'channel', ?3, 1, 0)`,
      ).bind(`ff_${hex()}`, key, channelId),
    );
  }
  if (options.form) {
    const config = {
      fields: [
        { key: 'email', label: 'Your email', required: true },
        { key: 'first_name', label: 'First name', required: false },
      ],
      consent: { text: 'I agree to get emails.', required: true },
      layout: 'regular',
      placement: 'popup',
      trigger: { type: 'immediate' },
      frequency: { type: 'every_visit' },
      success: { type: 'message', message: 'Check your inbox.' },
      doubleOptIn: null,
      theme: { accentColor: null, mode: 'auto' },
      allowedOrigins: [],
      copy: { heading: 'Join Field Notes', body: 'One email a week.', button: 'Join now' },
    };
    statements.push(
      env.DB.prepare(
        `INSERT INTO capture_forms (id, workspace_id, channel_id, name, status, draft_config_json, published_config_json, version, published_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'Site', 'published', ?4, ?4, 1, 1, 0, 0)`,
      ).bind(formId, workspaceId, channelId, JSON.stringify(config)),
    );
  }
  await env.DB.batch(statements);
  const host = `${slug}.swarm.test`;
  return {
    slug,
    host,
    origin: `http://${host}`,
    workspaceId,
    channelId,
    mediaId,
    mediaKey,
    formId,
    ids,
  };
}

const get = (url: string, init: RequestInit = {}) =>
  SELF.fetch(url, { redirect: 'manual', ...init });

function jsonLd(html: string): { '@graph': Record<string, unknown>[] } {
  const match = /<script type="application\/ld\+json" nonce="[^"]+">([\s\S]*?)<\/script>/.exec(
    html,
  );
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as { '@graph': Record<string, unknown>[] };
}

/**
 * Every absolute URL a page loads or links to is first-party (share links and the footer's
 * plain link to the published subprocessor list excepted).
 */
function expectFirstParty(html: string, fx: Fixture) {
  const allowed = [fx.origin, MEDIA_ORIGIN, CAPTURE_ORIGIN];
  const withoutShare = html
    .replace(/<nav class="sw-share"[\s\S]*?<\/nav>/g, '')
    .replaceAll(`href="${SUBPROCESSORS_URL}"`, '');
  const urls = [
    ...withoutShare.matchAll(/\s(?:src|href|action|content)="(https?:\/\/[^"]*)"/g),
  ].map((m) => m[1]!);
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    expect(
      allowed.some((origin) => url.startsWith(`${origin}/`) || url === origin),
      url,
    ).toBe(true);
  }
  // Share links are plain links (no script), and nothing on the page is a script.
  expect(html).not.toMatch(/<script(?![^>]*application\/ld\+json)/);
}

/** A small well-formedness check: balanced tags and valid entities. */
function expectWellFormedXml(xml: string) {
  const body = xml.replace(/^<\?xml[^>]*\?>/, '');
  expect(body).not.toMatch(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i);
  const stack: string[] = [];
  for (const match of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
    const [, close, name, selfClose] = match;
    if (selfClose) continue;
    if (close) expect(stack.pop()).toBe(name);
    else stack.push(name!);
  }
  expect(stack).toEqual([]);
  // No raw "<" outside tags.
  expect(body.replace(/<\/?[A-Za-z][^>]*>/g, '')).not.toContain('<');
}

describe('home page', () => {
  it('renders the magazine layout by default, with SEO, theme and first-party URLs only', async () => {
    const fx = await seedSite({ layout: 'newspaper' });
    const res = await get(`${fx.origin}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe(
      'public, s-maxage=300, stale-while-revalidate=86400',
    );
    expect(res.headers.get('x-swarm-cacheable')).toBeNull();
    expect(res.headers.get('x-swarm-cache')).toBe('miss');
    const html = await res.text();
    // The layout setting needs the site_homepage_layouts flag.
    expect(html).toContain('sw-home-magazine');
    expect(html).toContain('Hello world');
    expect(html).toContain('Paid deep dive');
    expect(html).not.toContain('Hidden one');
    expect(html).not.toContain('Draft one');
    expect(html).not.toContain('Secret member text');
    expect(html).toContain(`<link rel="canonical" href="${fx.origin}/">`);
    expect(html).toContain('<meta name="google-site-verification" content="google-token-123">');
    expect(html).toContain(`<link rel="icon" href="${MEDIA_ORIGIN}/media/${fx.mediaKey}">`);
    expect(html).toContain('class="sw-font-inter" data-scheme="dark"');
    expect(html).toMatch(/<link rel="stylesheet" href="\/_swarm\/site\.css\?v=1\.0a7d5a\.\d+">/);
    expect(html).toContain('<a href="/colophon">Colophon</a>');
    // No inline style attributes (the site CSP forbids them).
    expect(html).not.toMatch(/\sstyle="/);
    expectFirstParty(html, fx);

    const graph = jsonLd(html)['@graph'];
    const types = graph.map((node) => node['@type']);
    expect(types).toEqual(expect.arrayContaining(['WebSite', 'Organization']));
    const site = graph.find((n) => n['@type'] === 'WebSite')!;
    expect(JSON.stringify(site.potentialAction)).toContain(
      `${fx.origin}/search?q={search_term_string}`,
    );
    const org = graph.find((n) => n['@type'] === 'Organization')!;
    expect(org.sameAs).toEqual(['https://social.example/@fieldnotes']);
  });

  it('uses the newspaper layout and pinned posts when the flag is on', async () => {
    const fx = await seedSite({
      layout: 'newspaper',
      pinPaid: true,
      flags: ['site_homepage_layouts'],
    });
    const html = await (await get(`${fx.origin}/`)).text();
    expect(html).toContain('sw-home-newspaper');
    // Pinned first, ahead of newer and older Dispatches.
    expect(html.indexOf('Paid deep dive')).toBeLessThan(html.indexOf('Hello world'));
  });

  it('ignores pins while site_homepage_layouts is off', async () => {
    const fx = await seedSite({ pinPaid: true });
    const html = await (await get(`${fx.origin}/`)).text();
    expect(html).toContain('sw-home-magazine');
    expect(html).not.toContain('sw-pinned');
    expect(html).toContain('Paid deep dive');
  });

  it('renders the publication Capture Form inline, posting to the capture worker', async () => {
    const fx = await seedSite({ form: true });
    const html = await (await get(`${fx.origin}/`)).text();
    expect(html).toContain(
      `<form method="post" action="${CAPTURE_ORIGIN}/v1/${fx.formId}/subscribe" data-swarm-subscribe>`,
    );
    expect(html).toContain('name="email"');
    expect(html).toContain('name="firstName"');
    expect(html).toContain('name="consent" value="yes" required');
    expect(html).toContain('name="website"');
    expect(html).toContain('Join now');
    expect(html).not.toContain('<iframe');
    // The server's stamp of the version shown, which the capture worker verifies on submit.
    const stamp = /<input type="hidden" name="formStamp" value="([^"]+)">/.exec(html)?.[1];
    expect(stamp).toMatch(/^v2\.form-stamp\./);
    const read = await readFormStamp(testLinks(), stamp, fx.formId);
    expect(read?.version).toBe(1);
  });

  it("links the footer to the publication's data request page", async () => {
    const fx = await seedSite();
    const html = await (await get(`${fx.origin}/`)).text();
    expect(html).toContain(`<a href="${CAPTURE_ORIGIN}/privacy/${fx.channelId}">Your data</a>`);
  });

  it('falls back to a plain form posting to /_swarm/subscribe', async () => {
    const fx = await seedSite();
    const html = await (await get(`${fx.origin}/`)).text();
    expect(html).toContain('<form method="post" action="/_swarm/subscribe" data-swarm-subscribe>');
  });
});

describe('/_swarm/subscribe', () => {
  const post = (fx: Fixture) =>
    get(`${fx.origin}/_swarm/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=reader%40example.com&website=',
    });

  it('hands the post to the capture worker with a 307', async () => {
    const fx = await seedSite({ form: true });
    const res = await post(fx);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${CAPTURE_ORIGIN}/v1/${fx.formId}/subscribe`);
  });

  it('says sign-ups are closed when there is no published form', async () => {
    const fx = await seedSite();
    const res = await post(fx);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Sign-ups are closed');
  });
});

describe('Post pages', () => {
  it('renders a public post with article metadata and share links', async () => {
    const fx = await seedSite();
    const res = await get(`${fx.origin}/p/hello-world`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-tag')).toContain(fx.ids.hello);
    const html = await res.text();
    expect(html).toContain('<h1>Hello world</h1>');
    expect(html).toContain('<p class="sw-subtitle">Hello world subtitle</p>');
    expect(html).toContain('min read');
    expect(html).toContain('The quick brown fox');
    expect(html).toContain(
      `<meta property="og:image" content="${MEDIA_ORIGIN}/media/${fx.mediaKey}">`,
    );
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain('https://x.com/intent/post?');
    expect(html).toMatch(/<style nonce="[^"]+">\.sw-fp-50-50\{object-position:50% 50%\}<\/style>/);
    expectFirstParty(html, fx);
    const article = jsonLd(html)['@graph'].find((n) => n['@type'] === 'Article')!;
    expect(article).toMatchObject({
      headline: 'Hello world',
      isAccessibleForFree: true,
      image: [`${MEDIA_ORIGIN}/media/${fx.mediaKey}`],
    });
    expect(article.hasPart).toBeUndefined();
    expect(typeof article.datePublished).toBe('string');
  });

  it('redirects old slugs to the current one', async () => {
    const fx = await seedSite();
    const res = await get(`${fx.origin}/p/hello-old`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/p/hello-world');
  });

  it('keeps hidden and unpublished posts off the site', async () => {
    const fx = await seedSite();
    for (const path of ['/p/hidden-one', '/p/draft-one', '/p/no-such-thing', '/p/Bad_Slug']) {
      expect((await get(`${fx.origin}${path}`)).status, path).toBe(404);
    }
  });

  it('shows anonymous readers the free part and a gate panel', async () => {
    const fx = await seedSite();
    const html = await (await get(`${fx.origin}/p/members-note`)).text();
    expect(html).toContain('Free intro text.');
    expect(html).not.toContain('Secret member text.');
    expect(html).toContain('class="sw-gate"');
    expect(html).toContain('href="/_swarm/reader/signin?return=%2Fp%2Fmembers-note"');
    expect(html).toContain('<form method="post" action="/_swarm/subscribe" data-swarm-subscribe>');
    const article = jsonLd(html)['@graph'].find((n) => n['@type'] === 'Article')!;
    expect(article.isAccessibleForFree).toBe(false);
  });

  it('previews a paid post without a gate divider by its first blocks', async () => {
    const fx = await seedSite();
    const html = await (await get(`${fx.origin}/p/paid-deep-dive`)).text();
    expect(html).toContain('Paid para one.');
    expect(html).toContain('Paid para two.');
    expect(html).not.toContain('Paid para three.');
    expect(html).not.toContain('Paid para four.');
    expect(html).toContain('This post is for paid subscribers');
  });

  it('adds previous and next links when the flag and setting are on', async () => {
    const off = await seedSite();
    expect(await (await get(`${off.origin}/p/members-note`)).text()).not.toContain('rel="prev"');
    const fx = await seedSite({ flags: ['site_prev_next_nav', 'site_drop_caps'] });
    const html = await (await get(`${fx.origin}/p/members-note`)).text();
    expect(html).toContain('<a class="sw-prev" href="/p/hello-world" rel="prev">');
    expect(html).toContain('<a class="sw-next" href="/p/paid-deep-dive" rel="next">');
    expect(html).toContain('<body class="sw-dropcaps">');
  });
});

describe('gated rendering by reader class', () => {
  const channel: SiteChannel = {
    id: 'ch_x',
    workspaceId: 'ws_x',
    slug: 'notes',
    name: 'Field Notes',
    description: null,
    branding: {},
    origin: 'https://notes.example',
    host: 'notes.example',
    settings: {
      signupPath: 'email',
      customCss: '',
      layout: 'magazine',
      pinned: [],
      aboutJson: '{"type":"doc","content":[]}',
      nav: [],
      seo: {},
      theme: {},
      aiBots: 'unset',
      exposeGated: false,
      prevNextNav: true,
      cacheVersion: 1,
      designVersion: null,
      designTests: [],
    },
  };
  const base = {
    id: 'dp_x',
    subject: 'S',
    preheader: '',
    publishedAt: 1,
    updatedAt: 2,
    sectionId: null,
    slug: 's',
    createdBy: null,
    coverMediaId: null,
    coverAlt: '',
  };
  const members: SiteDispatch = {
    ...base,
    visibility: 'members',
    contentJson: doc(p('Free intro.'), { type: 'gate' }, p('Secret text.')),
  };
  const paid: SiteDispatch = {
    ...base,
    visibility: 'paid',
    contentJson: doc(
      p('One.'),
      p('Two.'),
      p('Three.'),
      p('Four.'),
      p('Five.'),
      p('Six.'),
      p('Seven.'),
    ),
  };
  const view = (dispatch: SiteDispatch, reader: 'anonymous' | 'member' | 'paid', crawler = false) =>
    dispatchArticle({
      channel,
      dispatch,
      rendered: renderDispatch(dispatch, {
        channelName: 'Field Notes',
        media: new Map(),
        allowHtmlBlocks: false,
      }),
      reader,
      crawlerFullAccess: crawler,
      subscribeForm: '<form></form>',
      image: null,
    });

  it('shows subscribers the gated part, marked for structured data', () => {
    const anonymous = view(members, 'anonymous');
    expect(anonymous.html).not.toContain('Secret text.');
    expect(anonymous.showsGate).toBe(true);

    const member = view(members, 'member');
    expect(member.html).toContain('<div class="sw-gated"><p>Secret text.</p></div>');
    expect(member.showsGate).toBe(false);
    expect(member.jsonLd).toMatchObject({
      isAccessibleForFree: false,
      hasPart: { '@type': 'WebPageElement', isAccessibleForFree: false, cssSelector: '.sw-gated' },
    });
  });

  it('shows paid posts in full only to paid readers and verified crawlers', () => {
    expect(view(paid, 'anonymous').html).not.toContain('Four.');
    // At most 3 free blocks without a gate divider.
    expect(view(paid, 'anonymous').html).toContain('Three.');
    const member = view(paid, 'member');
    expect(member.html).not.toContain('Four.');
    expect(member.html).toContain('for paid subscribers');
    expect(member.html).not.toContain('/_swarm/reader/signin');
    expect(view(paid, 'paid').html).toContain('Seven.');
    expect(view(paid, 'anonymous', true).html).toContain('Seven.');
  });

  it('adds an implicit gate only where one is needed', () => {
    const single: SiteDispatch = { ...paid, contentJson: doc(p('Only.')) };
    expect((webDocument(single) as { content: unknown[] }).content[0]).toEqual({ type: 'gate' });
    const open: SiteDispatch = { ...paid, visibility: 'public' };
    expect(JSON.stringify(webDocument(open))).not.toContain('"gate"');
  });

  it('counts only website blocks towards the free share of a post with no paywall break', () => {
    const para = (text: string, showOn?: string) => ({
      type: 'paragraph',
      ...(showOn ? { attrs: { showOn } } : {}),
      content: [{ type: 'text', text }],
    });
    // Six blocks, three of them email-only: counting those would give all the rest away.
    const contentJson = JSON.stringify({
      type: 'doc',
      content: [
        para('One'),
        para('Two'),
        para('Three'),
        para('Inbox A', 'email'),
        para('Inbox B', 'email'),
        para('Inbox C', 'email'),
      ],
    });
    const out = webDocument({ contentJson, visibility: 'members' }) as {
      content: { type: string; content?: { text: string }[] }[];
    };
    expect(out.content.map((n) => n.content?.[0]?.text ?? n.type)).toEqual([
      'One',
      'gate',
      'Two',
      'Three',
    ]);
    expect(JSON.stringify(out)).not.toContain('Inbox');
  });
});

describe('archive, sections, about and custom pages', () => {
  it('lists posts newest first, or by engagement with ?sort=top', async () => {
    const fx = await seedSite();
    await env.DB.prepare(
      `INSERT INTO site_page_views_daily (channel_id, day, path, source, device, country, views, visitors)
       VALUES (?1, '2026-10-01', '/p/hello-world', 'direct', 'desktop', 'US', 50, 10)`,
    )
      .bind(fx.channelId)
      .run();
    const newest = await (await get(`${fx.origin}/archive`)).text();
    expect(newest.indexOf('Paid deep dive')).toBeLessThan(newest.indexOf('Hello world'));
    const top = await (await get(`${fx.origin}/archive?sort=top`)).text();
    expect(top.indexOf('Hello world')).toBeLessThan(top.indexOf('Paid deep dive'));
    expect(top).toContain(`<link rel="canonical" href="${fx.origin}/archive?sort=top">`);
    expect((await get(`${fx.origin}/archive?page=9`)).status).toBe(404);
  });

  it('serves sections only with the site_sections flag', async () => {
    const off = await seedSite();
    expect((await get(`${off.origin}/s/notes`)).status).toBe(404);
    const fx = await seedSite({ flags: ['site_sections'] });
    const sectionId = `sx_${hex()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO site_sections (id, channel_id, slug, name, description, created_at, updated_at)
         VALUES (?1, ?2, 'notes', 'Notes', 'Short notes.', 0, 0)`,
      ).bind(sectionId, fx.channelId),
      env.DB.prepare('UPDATE dispatches SET section_id = ?1 WHERE id = ?2').bind(
        sectionId,
        fx.ids.hello,
      ),
    ]);
    const res = await get(`${fx.origin}/s/notes`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Notes</h1>');
    expect(html).toContain('Hello world');
    expect(html).not.toContain('Paid deep dive');
  });

  it('renders the about page and published custom pages only', async () => {
    const fx = await seedSite();
    expect(await (await get(`${fx.origin}/about`)).text()).toContain(
      'We write about foxes and fields.',
    );
    const colophon = await get(`${fx.origin}/colophon`);
    expect(colophon.status).toBe(200);
    expect(await colophon.text()).toContain('Set in system fonts.');
    expect((await get(`${fx.origin}/secret-draft`)).status).toBe(404);
  });

  it('answers unknown paths with a branded 404 page', async () => {
    const fx = await seedSite();
    const res = await get(`${fx.origin}/no/such/page`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Page not found');
    expect(html).toContain('Field Notes');
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it('serves an offline page', async () => {
    const fx = await seedSite();
    const res = await get(`${fx.origin}/offline`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('You are offline');
  });
});

describe('author pages', () => {
  /** A teammate with an author page who created the Hello world Dispatch. */
  async function seedAuthor(fx: Fixture) {
    const operatorId = `op_${hex()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO operators (id, email, name, created_at, updated_at) VALUES (?1, ?2, 'Ada', 0, 0)`,
      ).bind(operatorId, `ada-${hex().slice(0, 8)}@example.org`),
      env.DB.prepare(
        `INSERT INTO author_profiles (channel_id, operator_id, slug, name, bio, avatar_media_id, created_at, updated_at)
         VALUES (?1, ?2, 'ada', 'Ada Lovelace', 'Writes <about> engines.', ?3, 0, 0)`,
      ).bind(fx.channelId, operatorId, fx.mediaId),
      env.DB.prepare('UPDATE dispatches SET created_by = ?1 WHERE id IN (?2, ?3)').bind(
        operatorId,
        fx.ids.hello,
        fx.ids.draft,
      ),
    ]);
    return operatorId;
  }

  it('shows nothing of authors while author_pages is off', async () => {
    const fx = await seedSite();
    await seedAuthor(fx);
    expect((await get(`${fx.origin}/authors/ada`)).status).toBe(404);
    const html = await (await get(`${fx.origin}/p/hello-world`)).text();
    expect(html).not.toContain('sw-byline');
    expect(html).not.toContain('/authors/');
  });

  it('serves the profile with its posts, and bylines that link to it', async () => {
    const fx = await seedSite({ flags: ['author_pages'] });
    await seedAuthor(fx);
    const res = await get(`${fx.origin}/authors/ada`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(
      'public, s-maxage=300, stale-while-revalidate=86400',
    );
    const html = await res.text();
    expect(html).toContain('<h1>Ada Lovelace</h1>');
    expect(html).toContain('Writes &lt;about&gt; engines.');
    expect(html).toContain(`<img src="${MEDIA_ORIGIN}/media/${fx.mediaKey}" alt=""`);
    expect(html).toContain('Hello world');
    // Only their Dispatches, and only those on the site.
    expect(html).not.toContain('Paid deep dive');
    expect(html).not.toContain('Draft one');
    expect(html).toContain('<meta property="og:type" content="profile">');
    expectFirstParty(html, fx);
    expect((await get(`${fx.origin}/authors/nobody`)).status).toBe(404);

    const page = await (await get(`${fx.origin}/p/hello-world`)).text();
    expect(page).toContain(
      '<p class="sw-byline">By <a href="/authors/ada" rel="author">Ada Lovelace</a></p>',
    );
    const article = jsonLd(page)['@graph'].find((n) => n['@type'] === 'Article')!;
    expect(article.author).toEqual({
      '@type': 'Person',
      name: 'Ada Lovelace',
      url: `${fx.origin}/authors/ada`,
    });
    // A Dispatch whose creator has no author page has no byline.
    expect(await (await get(`${fx.origin}/p/paid-deep-dive`)).text()).not.toContain('sw-byline');
  });
});

describe('search', () => {
  // Searches are limited per client, so each request here comes from its own address.
  const search = (url: string) => get(url, { headers: { 'cf-connecting-ip': nextIp() } });

  it('limits searches per client and never caches them', async () => {
    const fx = await seedSite();
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await get(`${fx.origin}/search?q=word${i}`, {
        headers: { 'cf-connecting-ip': ip },
      });
      statuses.push(res.status);
      expect(res.headers.get('x-swarm-cache')).toBeNull();
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('finds posts on the site and highlights matches', async () => {
    const fx = await seedSite();
    const res = await search(`${fx.origin}/search?q=brown`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<a href="/p/hello-world">Hello world</a>');
    expect(html).toContain('<mark>brown</mark>');
    expect(html).not.toContain('Hidden one');
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it('treats FTS syntax in the query as plain words', async () => {
    const fx = await seedSite();
    for (const q of ['"fox', 'fox OR *', 'NEAR(fox dog)', '()^:-']) {
      const res = await search(`${fx.origin}/search?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
    }
    expect(ftsQuery('a "b" c*')).toBe('"a" "b" "c*"');
    expect(ftsQuery('  ')).toBeNull();
  });

  it('finds no text the page keeps behind the gate when the paywall break is email-only', async () => {
    const fx = await seedSite();
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    // The website drops an email-only break, so the page shows its own short preview instead.
    const contentJson = doc(
      ...words.map((word) => p(`Paid ${word} words.`)),
      { type: 'gate', attrs: { showOn: 'email' } },
      p('Paid golf words.'),
    );
    await env.DB.prepare('UPDATE dispatches SET content_json = ?1 WHERE id = ?2')
      .bind(contentJson, fx.ids.paid)
      .run();
    await env.DB.batch(
      searchStatements(
        env.DB,
        {
          id: fx.ids.paid,
          channel_id: fx.channelId,
          subject: 'Paid deep dive',
          preheader: '',
          content_json: contentJson,
          web_visibility: 'paid',
          web_published_at: Date.now(),
        },
        'Field Notes',
        true,
      ),
    );
    const page = await (await get(`${fx.origin}/p/paid-deep-dive`)).text();
    expect(page).toContain('Paid alpha words.');
    expect(page).not.toContain('Paid echo words.');
    for (const word of [...words, 'golf']) {
      const html = await (await search(`${fx.origin}/search?q=${word}`)).text();
      // Search may hold no more than the page shows anyone; here, nothing of the body at all.
      expect(html, word).not.toContain('paid-deep-dive');
      expect(html, word).not.toContain(`${word} words`);
    }
    // The title is still found.
    expect(await (await search(`${fx.origin}/search?q=deep`)).text()).toContain('paid-deep-dive');
  });
});

describe('feeds and sitemaps', () => {
  it('serves RSS with full public content and excerpts for gated posts', async () => {
    const fx = await seedSite();
    const res = await get(`${fx.origin}/feed`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/rss+xml');
    expect(res.headers.get('x-swarm-cacheable')).toBeNull();
    expect(res.headers.get('x-swarm-cache')).toBe('miss');
    const xml = await res.text();
    expectWellFormedXml(xml);
    expect(xml).toContain(`<link>${fx.origin}/p/hello-world</link>`);
    expect(xml).toContain('The quick brown fox');
    expect(xml).toContain('Free intro text.');
    expect(xml).not.toContain('Secret member text.');
    expect(xml).not.toContain('Paid para three.');
    expect(xml).not.toContain('Hidden one');
    expect(xml.match(/<item>/g)).toHaveLength(3);
  });

  it('serves JSON Feed 1.1', async () => {
    const fx = await seedSite();
    const res = await get(`${fx.origin}/feed.json`);
    expect(res.headers.get('content-type')).toContain('application/feed+json');
    const feed = (await res.json()) as {
      version: string;
      items: { url: string; content_html: string }[];
    };
    expect(feed.version).toBe('https://jsonfeed.org/version/1.1');
    expect(feed.items.map((i) => i.url)).toEqual([
      `${fx.origin}/p/paid-deep-dive`,
      `${fx.origin}/p/members-note`,
      `${fx.origin}/p/hello-world`,
    ]);
    expect(JSON.stringify(feed)).not.toContain('Secret member text.');
  });

  it('serves a sitemap index and valid url sets', async () => {
    const fx = await seedSite();
    const index = await (await get(`${fx.origin}/sitemap.xml`)).text();
    expectWellFormedXml(index);
    expect(index).toContain(`<loc>${fx.origin}/sitemap-pages.xml</loc>`);
    expect(index).toContain(`<loc>${fx.origin}/sitemap-dispatches.xml</loc>`);

    const dispatches = await (await get(`${fx.origin}/sitemap-dispatches.xml`)).text();
    expectWellFormedXml(dispatches);
    expect(dispatches).toContain(`<loc>${fx.origin}/p/hello-world</loc>`);
    expect(dispatches).not.toContain('hidden-one');
    expect(dispatches).not.toContain('hello-old');

    const pagesXml = await (await get(`${fx.origin}/sitemap-pages.xml`)).text();
    expectWellFormedXml(pagesXml);
    expect(pagesXml).toContain(`<loc>${fx.origin}/colophon</loc>`);
    expect(pagesXml).not.toContain('secret-draft');

    const html = await (await get(`${fx.origin}/sitemap`)).text();
    expect(html).toContain('<a href="/p/members-note">Subscribers note</a>');
    expectFirstParty(html, fx);
  });
});

describe('robots.txt and the stylesheet', () => {
  it('allows everything but /_swarm/ when AI crawlers are not blocked', async () => {
    const fx = await seedSite();
    const res = await get(`${fx.origin}/robots.txt`);
    const text = await res.text();
    expect(text).toContain('User-agent: *\nAllow: /\nDisallow: /_swarm/');
    expect(text).toContain(`Sitemap: ${fx.origin}/sitemap.xml`);
    expect(text).not.toContain('GPTBot');
  });

  it('disallows every known AI crawler with the block policy', async () => {
    const fx = await seedSite({ aiBots: 'block' });
    const text = await (await get(`${fx.origin}/robots.txt`)).text();
    expect(text).toContain('User-agent: GPTBot\n');
    expect(text).toContain('User-agent: ClaudeBot\n');
    expect(text).toMatch(/User-agent: cohere-ai\nDisallow: \/\n/);
  });

  it('disallows only the crawlers a custom policy blocks', async () => {
    const fx = await seedSite({ aiBots: 'custom' });
    await env.DB.prepare(
      "INSERT INTO bot_rules (channel_id, agent, action, updated_at) VALUES (?1, 'ccbot', 'block', 0)",
    )
      .bind(fx.channelId)
      .run();
    const text = await (await get(`${fx.origin}/robots.txt`)).text();
    expect(text).toContain('User-agent: CCBot\nDisallow: /');
    expect(text).not.toContain('GPTBot');
  });

  it('serves the publication stylesheet, immutable for the current version', async () => {
    const fx = await seedSite();
    const res = await get(`${fx.origin}/_swarm/site.css?v=1.0a7d5a.${CSS_REVISION}`);
    expect(res.headers.get('content-type')).toContain('text/css');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(await res.text()).toContain('--accent:#0a7d5a');
    const stale = await get(`${fx.origin}/_swarm/site.css?v=0.000000`);
    expect(stale.headers.get('cache-control')).not.toContain('immutable');
  });
});

describe('landing pages', () => {
  const seedLanding = async (flags: string[]) => {
    const fx = await seedSite({ flags, form: true });
    await env.DB.prepare(
      `INSERT INTO site_pages (id, channel_id, slug, title, content_json, status, created_at, updated_at, landing_form_id)
       VALUES (?1, ?2, 'join', 'Join us', ?3, 'published', 0, 0, ?4)`,
    )
      .bind(`pg_${hex()}`, fx.channelId, doc(p('Worth your time.')), fx.formId)
      .run();
    return (await get(`${fx.origin}/join`)).text();
  };

  it('shows the form and nothing to wander off to', async () => {
    const html = await seedLanding(['landing_pages']);
    expect(html).toContain('Join us');
    expect(html).toContain('Worth your time.');
    expect(html).toMatch(/<form method="post" action="[^"]*\/v1\/cf_[0-9a-f]+\/subscribe"/);
    expect(html.match(/data-swarm-subscribe/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="Site"');
    expect(html).not.toContain('aria-label="Footer"');
    expect(html).not.toContain('role="search"');
    expect(html).not.toContain('id="subscribe"');
  });

  it('is an ordinary page with the flag off, with nothing lost', async () => {
    const html = await seedLanding([]);
    expect(html).toContain('Worth your time.');
    expect(html).toContain('aria-label="Site"');
    expect(html).toContain('id="subscribe"');
  });
});

describe('linked snippets on the site', () => {
  const link = (snippetId: string, showOn?: string) => ({
    type: 'snippet',
    attrs: { snippetId, ...(showOn ? { showOn } : {}) },
  });
  const para = (text: string, showOn?: string) => ({
    ...p(text),
    ...(showOn ? { attrs: { showOn } } : {}),
  });
  const saveSnippet = async (channelId: string, content: string) => {
    const id = `sn_${hex()}`;
    await env.DB.prepare(
      `INSERT INTO snippets (id, channel_id, name, content_json, created_at, updated_at)
       VALUES (?1, ?2, 'Sign-off', ?3, 0, 0)`,
    )
      .bind(id, channelId, content)
      .run();
    return id;
  };
  const setContent = (dispatchId: string, content: string) =>
    env.DB.prepare('UPDATE dispatches SET content_json = ?1 WHERE id = ?2')
      .bind(content, dispatchId)
      .run();
  const nextVersion = (channelId: string) =>
    env.DB.prepare(
      'UPDATE site_settings SET cache_version = cache_version + 1 WHERE channel_id = ?1',
    )
      .bind(channelId)
      .run();
  const article = async (origin: string, slug = 'hello-world') =>
    (await get(`${origin}/p/${slug}`)).text();

  it('shows the snippet’s current content, on the page, in cards and in the feed', async () => {
    const fx = await seedSite();
    const id = await saveSnippet(fx.channelId, doc(p('Yours, Jan')));
    await setContent(fx.ids.hello, doc(p('Hello.'), link(id)));
    const page = await article(fx.origin);
    expect(page).toContain('Yours, Jan');
    expect(await (await get(`${fx.origin}/feed`)).text()).toContain('Yours, Jan');

    await env.DB.prepare('UPDATE snippets SET content_json = ?1 WHERE id = ?2')
      .bind(doc(p('Warmly, Jan')), id)
      .run();
    await nextVersion(fx.channelId);
    const updated = await article(fx.origin);
    expect(updated).toContain('Warmly, Jan');
    expect(updated).not.toContain('Yours, Jan');
  });

  it('never shows a snippet of another publication', async () => {
    const fx = await seedSite();
    const other = await seedSite();
    const id = await saveSnippet(other.channelId, doc(p('Their secret')));
    await setContent(fx.ids.hello, doc(p('Hello.'), link(id)));
    const page = await article(fx.origin);
    expect(page).toContain('Hello.');
    expect(page).not.toContain('Their secret');
  });

  it('renders the post without a snippet that is gone', async () => {
    const fx = await seedSite();
    await setContent(fx.ids.hello, doc(p('Hello.'), link('sn_gone'), p('Bye.')));
    const page = await article(fx.origin);
    expect(page).toContain('Hello.');
    expect(page).toContain('Bye.');
  });

  it('keeps to showOn, on the snippet block and inside it', async () => {
    const fx = await seedSite();
    const id = await saveSnippet(
      fx.channelId,
      doc(para('Inbox words', 'email'), para('Site words')),
    );
    const inbox = await saveSnippet(fx.channelId, doc(p('Inbox block')));
    await setContent(fx.ids.hello, doc(p('Hello.'), link(id), link(inbox, 'email')));
    const page = await article(fx.origin);
    expect(page).toContain('Site words');
    expect(page).not.toContain('Inbox words');
    expect(page).not.toContain('Inbox block');
  });

  it('counts a snippet’s own blocks in the free share of a gated post', async () => {
    const fx = await seedSite();
    // One block in the document, six on the page: taken as one, it would be all free or all shut.
    const id = await saveSnippet(
      fx.channelId,
      doc(
        p('Open one.'),
        p('Open two.'),
        p('Open three.'),
        p('Shut four.'),
        p('Shut five.'),
        p('Shut six.'),
      ),
    );
    await setContent(fx.ids.paid, doc(link(id)));
    const page = await article(fx.origin, 'paid-deep-dive');
    expect(page).toContain('Open three.');
    expect(page).not.toContain('Shut four.');
  });

  it('gives a snippet that is gone no place in the free share', () => {
    const contentJson = doc(p('Only real block.'), link('sn_gone'));
    const out = webDocument({ contentJson, visibility: 'members' }) as {
      content: { type: string }[];
    };
    expect(out.content[0]).toEqual({ type: 'gate' });
  });

  it('renders a website page with a snippet in it', async () => {
    const fx = await seedSite();
    const id = await saveSnippet(fx.channelId, doc(p('Shared footer words')));
    await env.DB.prepare(
      `INSERT INTO site_pages (id, channel_id, slug, title, content_json, status, in_nav, position, created_at, updated_at)
       VALUES (?1, ?2, 'contact', 'Contact', ?3, 'published', 0, 0, 0, 0)`,
    )
      .bind(`pg_${hex()}`, fx.channelId, doc(p('Write to us.'), link(id)))
      .run();
    const page = await (await get(`${fx.origin}/contact`)).text();
    expect(page).toContain('Write to us.');
    expect(page).toContain('Shared footer words');
  });
});

describe('embed players on the site', () => {
  const VIDEO = 'https://www.youtube-nocookie.com';
  const embed = (url: string) => ({ type: 'embed', attrs: { url } });
  const setContent = (id: string, content: string) =>
    env.DB.prepare('UPDATE dispatches SET content_json = ?1 WHERE id = ?2').bind(content, id).run();
  const bumpVersion = (channelId: string) =>
    env.DB.prepare(
      'UPDATE site_settings SET cache_version = cache_version + 1 WHERE channel_id = ?1',
    )
      .bind(channelId)
      .run();
  const frameSrc = (res: Response) =>
    /frame-src [^;]*/.exec(res.headers.get('content-security-policy') ?? '')?.[0];

  it('keeps a page without one exactly as it was', async () => {
    const fx = await seedSite();
    const res = await get(`${fx.origin}/p/hello-world`);
    expect(frameSrc(res)).toBe("frame-src 'self'");
    const html = await res.text();
    expect(html).not.toContain('sw-player');
    // No empty line where the player's script would go.
    expect(html).toMatch(/<\/footer>\n\n?<\/body>/);
  });

  it('allows exactly its own players, with a nonce’d script and no frame before the click', async () => {
    const fx = await seedSite();
    await setContent(
      fx.ids.hello,
      doc(
        embed('https://youtu.be/dQw4w9WgXcQ'),
        embed('https://youtu.be/aaaaaaaaaaa'),
        embed('https://x.com/a/status/1'),
      ),
    );
    await bumpVersion(fx.channelId);
    const res = await get(`${fx.origin}/p/hello-world`);
    expect(frameSrc(res)).toBe(`frame-src 'self' ${VIDEO}`);
    const nonce = /'nonce-([^']+)'/.exec(res.headers.get('content-security-policy')!)![1]!;
    const html = await res.text();
    expect(html).toContain(`<script nonce="${nonce}">(function(){var d=document;[].forEach`);
    expect(html).toContain('.sw-player-frame{');
    // Only the script holds the word iframe, and nothing points at the service but its address.
    expect(html.match(/<iframe/g)).toBeNull();
    expect(html).not.toContain('img.youtube.com');
    expect(html.split(VIDEO).length - 1).toBe(2);

    // The other pages of the site stay as they were.
    expect(frameSrc(await get(`${fx.origin}/archive`))).toBe("frame-src 'self'");
  });

  it('keeps the policy on a cached copy, with the new nonce', async () => {
    const fx = await seedSite();
    await setContent(fx.ids.hello, doc(embed('https://vimeo.com/76979871')));
    await bumpVersion(fx.channelId);
    const first = await get(`${fx.origin}/p/hello-world`);
    await first.text();
    const second = await get(`${fx.origin}/p/hello-world`);
    expect(second.headers.get('x-swarm-cache')).toBe('hit');
    expect(frameSrc(second)).toBe("frame-src 'self' https://player.vimeo.com");
    const nonce = /'nonce-([^']+)'/.exec(second.headers.get('content-security-policy')!)![1]!;
    expect(first.headers.get('content-security-policy')).not.toContain(nonce);
    expect(await second.text()).toContain(`<script nonce="${nonce}">(function(){var d=document`);
  });

  it('shows a gated player only to a reader who can read that part', async () => {
    const fx = await seedSite();
    await setContent(
      fx.ids.members,
      doc(p('Free intro.'), { type: 'gate' }, embed('https://vimeo.com/76979871')),
    );
    await bumpVersion(fx.channelId);
    const anonymous = await get(`${fx.origin}/p/members-note`);
    expect(frameSrc(anonymous)).toBe("frame-src 'self'");
    const html = await anonymous.text();
    expect(html).toContain('Free intro.');
    expect(html).not.toContain('vimeo');
    expect(html).not.toContain('sw-player');
  });

  it('gives a subscriber the gated player, with its origin in the policy', async () => {
    const fx = await seedSite();
    await setContent(
      fx.ids.members,
      doc(p('Free intro.'), { type: 'gate' }, embed('https://vimeo.com/76979871')),
    );
    await bumpVersion(fx.channelId);
    const memberId = await addMember(fx.channelId, 'player-member@example.org');
    const res = await get(`${fx.origin}/p/members-note`, {
      headers: { cookie: await sessionCookie(fx.channelId, memberId) },
    });
    expect(frameSrc(res)).toBe("frame-src 'self' https://player.vimeo.com");
    expect(await res.text()).toContain(
      'data-sw-src="https://player.vimeo.com/video/76979871?dnt=1"',
    );
  });

  it('runs alongside the cookie popup and an owner’s code', async () => {
    const consent = JSON.stringify({
      enabled: true,
      text: 'We use cookies.',
      acceptLabel: 'Accept all',
      rejectLabel: 'Reject all',
      policyUrl: '',
      position: 'bottom',
    });
    const save = (channelId: string, code: unknown[]) =>
      env.DB.prepare(
        'UPDATE site_settings SET consent_json = ?1, code_json = ?2, cache_version = cache_version + 1 WHERE channel_id = ?3',
      )
        .bind(consent, JSON.stringify(code), channelId)
        .run();

    // A popup with no code keeps the strict policy, plus the player.
    const popupOnly = await seedSite({ flags: ['site_custom_code'] });
    await setContent(popupOnly.ids.hello, doc(embed('https://youtu.be/dQw4w9WgXcQ')));
    await save(popupOnly.channelId, []);
    const strict = await get(`${popupOnly.origin}/p/hello-world`);
    expect(strict.headers.get('content-security-policy')).not.toContain('strict-dynamic');
    expect(frameSrc(strict)).toBe(`frame-src 'self' ${VIDEO}`);

    // Owner code's wider policy already allows the player, and the script still has its nonce.
    const withCode = await seedSite({ flags: ['site_custom_code'] });
    await allowSiteCode(withCode.workspaceId);
    await setContent(withCode.ids.hello, doc(embed('https://youtu.be/dQw4w9WgXcQ')));
    await save(withCode.channelId, [
      { name: 'A', preset: 'google_analytics', category: 'analytics', value: 'G-ABC123DEF4' },
    ]);
    const wide = await get(`${withCode.origin}/p/hello-world`);
    const csp = wide.headers.get('content-security-policy')!;
    expect(csp).toContain('strict-dynamic');
    expect(frameSrc(wide)).toBe("frame-src 'self' https:");
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
    expect(await wide.text()).toContain(`<script nonce="${nonce}">(function(){var d=document`);
  });

  it('works from a linked snippet and on a page that isn’t a post', async () => {
    const fx = await seedSite();
    const id = `sn_${hex()}`;
    await env.DB.prepare(
      `INSERT INTO snippets (id, channel_id, name, content_json, created_at, updated_at)
       VALUES (?1, ?2, 'Clip', ?3, 0, 0)`,
    )
      .bind(id, fx.channelId, doc(embed('https://youtu.be/dQw4w9WgXcQ')))
      .run();
    const linked = doc(p('Watch.'), { type: 'snippet', attrs: { snippetId: id } });
    await setContent(fx.ids.hello, linked);
    await env.DB.prepare(
      'UPDATE site_settings SET about_json = ?1, cache_version = cache_version + 1 WHERE channel_id = ?2',
    )
      .bind(linked, fx.channelId)
      .run();
    for (const path of ['/p/hello-world', '/about']) {
      const res = await get(`${fx.origin}${path}`);
      expect(frameSrc(res), path).toBe(`frame-src 'self' ${VIDEO}`);
      expect(await res.text(), path).toContain(`data-sw-src="${VIDEO}/embed/dQw4w9WgXcQ"`);
    }
  });

  it('stays a plain link in the feed', async () => {
    const fx = await seedSite();
    await setContent(fx.ids.hello, doc(embed('https://youtu.be/dQw4w9WgXcQ')));
    await bumpVersion(fx.channelId);
    const feed = await (await get(`${fx.origin}/feed`)).text();
    expect(feed).toContain('Watch on YouTube');
    expect(feed).not.toContain('sw-player');
    expect(feed).not.toContain('youtube-nocookie');
  });
});
