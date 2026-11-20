// Reader-facing pages: home, archive, Dispatch, about, sections, custom pages, search, 404 and
// offline. Server-rendered, no script unless a page shows an embed's player. Anything that doesn't depend on the reader is cacheable at
// the edge for every reader class; Dispatch pages say which class they were rendered for (see
// render/html.ts cacheHeaders).
import { renderWeb, collectMediaIds, RenderError, type WebRendered } from '@swarm/mail';
import { Hono } from 'hono';
import { askBlocksFor, recordMemberEvent } from '@swarm/engine';
import { partnerPicksHtml } from './partners';
import type { SiteBindings, SiteContext } from '../context';
import {
  empty,
  emptyState,
  list,
  magazine,
  newspaper,
  pager,
  previewCss,
  previews,
} from '../render/components';
import {
  dispatchBySlug,
  listDispatches,
  documentWithSnippets,
  mediaMap,
  neighbours,
  pinnedDispatches,
  publishedPages,
  search,
  sections,
  seriesPlace,
  siteAuthor,
  siteFlags,
  siteForm,
} from '../render/data';
import {
  dispatchArticle,
  dispatchImage,
  dispatchMediaIds,
  renderDispatch,
} from '../render/dispatch';
import { dispatchAccess } from '../money/access';
import { later } from '../readers/later';
import { cacheHeaders, dispatchPath, h, time } from '../render/html';
import { loadChrome, page, renderPage, sendPage } from '../render/layout';
import { designHome } from '../render/design';
import { archiveByMonth } from '../render/templates';
import type { SeoImage } from '../render/seo';
import { pickPrompt, promptHtml } from '../render/prompts';
import { subscribeForm } from '../render/subscribe';

export const pages = new Hono<SiteBindings>();

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOME_COUNT = 13;

/**
 * Searches per client IP: the READER_LIMITER binding (10 a minute), under its own key. Without the
 * binding, refused outside development and tests, like reader sign-in.
 */
async function underSearchLimit(c: SiteContext): Promise<boolean> {
  const limiter = c.get('env').READER_LIMITER;
  if (!limiter)
    return c.get('env').ENVIRONMENT === 'development' || c.get('env').ENVIRONMENT === 'test';
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const { success } = await limiter.limit({ key: `search:${ip}` });
  return success;
}

function pageNumber(value: string | undefined): number {
  const n = Number.parseInt(value ?? '1', 10);
  return Number.isFinite(n) && n >= 1 && n <= 10_000 ? n : 1;
}

/** Renders an editor document that isn't a Dispatch (About, custom pages): no gate applies. */
async function renderDocument(c: SiteContext, json: string): Promise<WebRendered | null> {
  const channel = c.get('channel');
  let doc: unknown;
  try {
    doc = JSON.parse(await documentWithSnippets(c.get('env'), channel.id, json));
  } catch {
    return null;
  }
  const [media, flags] = await Promise.all([
    mediaMap(c.get('env'), channel.workspaceId, collectMediaIds(doc)),
    siteFlags(c),
  ]);
  try {
    return renderWeb(doc, {
      channelName: channel.name,
      media: (id) => media.get(id) ?? null,
      allowHtmlBlocks: flags.raw_html_mode,
      codeEmbeds: flags.code_embeds,
      players: true,
    });
  } catch (error) {
    if (error instanceof RenderError) return null;
    throw error;
  }
}

/** The players of a document shown whole (no gate applies). */
const playersOf = (rendered: WebRendered | null) =>
  rendered ? [...rendered.freePlayers, ...rendered.gatedPlayers] : [];

/** The Asks a Dispatch's poll blocks point at (this Channel's only). */
async function pollsOf(c: SiteContext, contentJson: string) {
  try {
    return await askBlocksFor(c.get('env').DB, c.get('channel').id, JSON.parse(contentJson));
  } catch {
    return new Map();
  }
}

/** The default social image from settings.seo.ogMediaId, when it is public media. */
async function defaultImage(c: SiteContext): Promise<SeoImage | null> {
  const channel = c.get('channel');
  const id = channel.settings.seo?.ogMediaId;
  if (!id) return null;
  const media = (await mediaMap(c.get('env'), channel.workspaceId, [id])).get(id);
  return media
    ? {
        url: media.url,
        alt: media.alt ?? channel.name,
        width: media.width ?? null,
        height: media.height ?? null,
        focal:
          media.focalX != null && media.focalY != null
            ? [media.focalX * 100, media.focalY * 100]
            : null,
      }
    : null;
}

const pagehead = (title: string, text?: string | null) =>
  `<header class="sw-pagehead"><h1>${h(title)}</h1>${text ? `<p>${h(text)}</p>` : ''}</header>`;

pages.get('/', async (c) => {
  const env = c.get('env');
  const channel = c.get('channel');
  const [chrome, image] = await Promise.all([loadChrome(c), defaultImage(c)]);
  const meta = {
    title: channel.name,
    description: channel.description ?? `Posts from ${channel.name}.`,
    path: '/',
    image,
  };
  // A website design (flag site_templates) draws the home page. Should drawing it fail (a theme
  // past its limits, anything else), this request gets the plain layout instead.
  if (chrome.design) {
    const reader = c.get('reader');
    // The variants this view was given at the edge, before the cache (edge/variants.ts).
    const variants = c.get('variants');
    try {
      const home = await designHome(
        c,
        chrome,
        chrome.design,
        { is_subscriber: reader.class !== 'anonymous', is_paid: reader.class === 'paid' },
        { variants, counted: true },
      );
      const html = renderPage(c, chrome, {
        meta,
        body: home.html,
        subscribe: false,
        wrap: false,
        css: home.css,
      });
      const res = sendPage(c, html, { cache: reader.class === 'anonymous' ? 'public' : 'reader' });
      // With A/B tests running, the copy depends on this view's variants: the edge keeps it per
      // set of variants, and no cache outside it (a proxy, the browser) may keep one for the URL.
      if (Object.keys(variants).length > 0) res.headers.set('cache-control', 'private, no-cache');
      return res;
    } catch (error) {
      c.get('log').error('site design failed to render; showing the plain home page', {
        channel: channel.id,
        theme: chrome.design.design.theme,
        error: (error as Error).message,
      });
    }
  }
  // Pins belong to the homepage layouts: with site_homepage_layouts off none are loaded.
  const pinned = chrome.flags.site_homepage_layouts ? await pinnedDispatches(env, channel) : [];
  const { items, hasMore } = await listDispatches(env, channel.id, {
    pageSize: HOME_COUNT,
    exclude: pinned.map((d) => d.id),
  });
  const [pinnedViews, latestViews] = await Promise.all([previews(c, pinned), previews(c, items)]);
  const layout = chrome.flags.site_homepage_layouts ? channel.settings.layout : 'magazine';
  const content =
    pinnedViews.length || latestViews.length
      ? (layout === 'newspaper' ? newspaper : magazine)(pinnedViews, latestViews)
      : emptyState('The first issue is on its way', 'Subscribe and it will land in your inbox.', {
          label: 'Subscribe',
          href: '#subscribe',
        });
  const picks = chrome.flags.partner_exchange ? await partnerPicksHtml(c) : '';
  const partnerSection = picks
    ? `<section class="sw-home-partners"><h2>Publications we recommend</h2>${picks}</section>`
    : '';
  const body = `<header class="sw-home-head"><h1>${h(channel.name)}</h1>${channel.description ? `<p>${h(channel.description)}</p>` : ''}</header>
<div class="sw-home sw-home-${layout}">${content}</div>
${hasMore ? '<p><a class="sw-button sw-ghost" href="/archive">All posts</a></p>' : ''}
${partnerSection}`;
  const html = renderPage(c, chrome, {
    meta,
    body,
    css: previewCss([...pinnedViews, ...latestViews]),
  });
  return sendPage(c, html);
});

pages.get('/archive', async (c) => {
  const env = c.get('env');
  const channel = c.get('channel');
  const sort = c.req.query('sort') === 'top' ? 'top' : 'new';
  const n = pageNumber(c.req.query('page'));
  const { items, hasMore } = await listDispatches(env, channel.id, { page: n, sort });
  if (n > 1 && items.length === 0) return notFoundPage(c);
  const views = await previews(c, items);
  const query = [sort === 'top' ? 'sort=top' : '', n > 1 ? `page=${n}` : '']
    .filter(Boolean)
    .join('&');
  const chrome = await loadChrome(c);
  const months = chrome.design !== null && sort === 'new';
  const tabs = `<nav class="sw-tabs" aria-label="Sort"><a href="/archive"${sort === 'new' ? ' aria-current="page"' : ''}>Newest</a><a href="/archive?sort=top"${sort === 'top' ? ' aria-current="page"' : ''}>Top</a></nav>`;
  const html = renderPage(c, chrome, {
    narrow: true,
    meta: {
      title: n > 1 ? `Archive, page ${n}` : 'Archive',
      description: `Every post from ${channel.name}.`,
      path: `/archive${query ? `?${query}` : ''}`,
    },
    body: `${pagehead('Archive', channel.description)}${tabs}${(months ? archiveByMonth(views, n === 1) : list(views)) || emptyState('Nothing published yet', 'Subscribe and the first issue will land in your inbox.', { label: 'Subscribe', href: '#subscribe' })}${pager('/archive', n, hasMore, sort === 'top' ? 'sort=top' : '')}`,
    css: previewCss(views),
  });
  return sendPage(c, html);
});

pages.get('/p/:slug', async (c) => {
  const env = c.get('env');
  const channel = c.get('channel');
  const slug = c.req.param('slug');
  if (!SLUG.test(slug) || slug.length > 120) return notFoundPage(c);
  const lookup = await dispatchBySlug(env, channel.id, slug);
  if (lookup.kind === 'missing') return notFoundPage(c);
  if (lookup.kind === 'moved') {
    for (const [name, value] of Object.entries(cacheHeaders(c, 'public'))) c.header(name, value);
    return c.redirect(dispatchPath(lookup.slug), 301);
  }
  const dispatch = lookup.dispatch;
  const reader = c.get('reader');
  const crawlerFullAccess = c.get('crawlerFullAccess');

  const [chrome, media, fallbackImage, polls] = await Promise.all([
    loadChrome(c),
    mediaMap(env, channel.workspaceId, dispatchMediaIds([dispatch])),
    defaultImage(c),
    pollsOf(c, dispatch.contentJson),
  ]);
  const showNeighbours = channel.settings.prevNextNav && chrome.flags.site_prev_next_nav;
  const [near, series, author] = await Promise.all([
    showNeighbours ? neighbours(env, channel.id, dispatch) : null,
    chrome.flags.post_series ? seriesPlace(env, channel.id, dispatch.id) : null,
    chrome.flags.author_pages && dispatch.createdBy
      ? siteAuthor(env, channel.id, { operatorId: dispatch.createdBy })
      : null,
  ]);
  const rendered = renderDispatch(dispatch, {
    channelName: channel.name,
    media,
    allowHtmlBlocks: chrome.flags.raw_html_mode,
    codeEmbeds: chrome.flags.code_embeds,
    polls,
    players: true,
  });
  const image = dispatchImage(rendered, env.MEDIA_ORIGIN, fallbackImage);
  const form = subscribeForm(env, chrome.form);
  // Gate levels, meters, soft Gates and gift links decide what this reader sees and how the
  // page may be cached (money/access.ts).
  const access = await dispatchAccess(c, dispatch, { subscribeForm: form, flags: chrome.flags });
  // Flow trigger gate_hit (Phase 6): a signed-in reader was shown the Gate. After the response.
  if (access.gate && reader.memberId) {
    later(
      c,
      recordMemberEvent(env.DB, {
        type: 'gate_hit',
        memberId: reader.memberId,
        channelId: channel.id,
        payload: { dispatchId: dispatch.id },
      }),
    );
  }
  const article = dispatchArticle({
    channel,
    dispatch,
    rendered,
    reader: reader.class,
    crawlerFullAccess,
    subscribeForm: form,
    entitled: access.entitled,
    ...(access.gate ? { gate: access.gate } : {}),
    ...(access.notice ? { notice: access.notice } : {}),
    ...(access.after ? { after: access.after } : {}),
    neighbours: near,
    image,
    series,
    author: author ? { name: author.name, slug: author.slug } : null,
    images: !!env.IMAGES,
  });
  // Smart Prompts: one at the end of the Dispatch, or under the Gate when the reader hit it.
  const prompt = crawlerFullAccess
    ? null
    : pickPrompt(chrome.prompts, {
        triggers: article.showsGate ? ['gate_hit'] : ['dispatch_end'],
        path: dispatchPath(dispatch.slug),
        reader: reader.class,
        dismissed: chrome.dismissed,
      });
  const promptMarkup = prompt ? promptHtml(env, prompt, dispatchPath(dispatch.slug)) : '';
  const cache = access.cache;
  const dropCaps = channel.settings.theme?.dropCaps === true && chrome.flags.site_drop_caps;
  const html = renderPage(c, chrome, {
    narrow: true,
    meta: {
      title: dispatch.seoTitle || dispatch.subject || 'Untitled post',
      description:
        dispatch.seoDescription || dispatch.preheader.trim() || rendered.excerpt || channel.name,
      path: dispatchPath(dispatch.slug),
      type: 'article',
      image,
      publishedAt: dispatch.publishedAt,
      modifiedAt: dispatch.updatedAt,
      ...(access.noindex ? { noindex: true } : {}),
    },
    body: `${article.html}${promptMarkup}`,
    jsonLd: [article.jsonLd],
    css: rendered.css,
    // A reader who can't see the gated part gets neither its players nor a hint of them.
    players: [...rendered.freePlayers, ...(article.showsGated ? rendered.gatedPlayers : [])],
    subscribe: !article.showsGate && reader.class === 'anonymous',
    ...(dropCaps ? { bodyClass: 'sw-dropcaps' } : {}),
    // Gated text shown in full (a free read, a gift link, a soft Gate passed) is never handed to
    // the owner's code and the tools it loads.
    ...(dispatch.visibility !== 'public' && access.entitled ? { noOwnerCode: true } : {}),
  });
  return sendPage(c, html, { cache, tags: [dispatch.id] });
});

pages.get('/about', async (c) => {
  const channel = c.get('channel');
  const rendered = await renderDocument(c, channel.settings.aboutJson);
  const content = rendered ? `${rendered.freeHtml}${rendered.gatedHtml}` : '';
  return page(c, {
    narrow: true,
    meta: {
      title: `About ${channel.name}`,
      description: rendered?.excerpt || channel.description || `About ${channel.name}.`,
      path: '/about',
    },
    body: `<div class="sw-article">${pagehead(`About ${channel.name}`, channel.description)}<div class="sw-prose">${content || empty('Nothing here yet.')}</div></div>`,
    css: rendered?.css ?? '',
    players: playersOf(rendered),
  });
});

pages.get('/s/:section', async (c) => {
  const env = c.get('env');
  const channel = c.get('channel');
  if (!(await siteFlags(c)).site_sections) return notFoundPage(c);
  const slug = c.req.param('section');
  const section = SLUG.test(slug)
    ? (await sections(env, channel.id)).find((s) => s.slug === slug)
    : undefined;
  if (!section) return notFoundPage(c);
  const n = pageNumber(c.req.query('page'));
  const { items, hasMore } = await listDispatches(env, channel.id, {
    page: n,
    sectionId: section.id,
  });
  if (n > 1 && items.length === 0) return notFoundPage(c);
  const views = await previews(c, items);
  const base = `/s/${section.slug}`;
  return page(c, {
    narrow: true,
    meta: {
      title: section.name,
      description: section.description ?? `${section.name} from ${channel.name}.`,
      path: n > 1 ? `${base}?page=${n}` : base,
    },
    body: `${pagehead(section.name, section.description)}${list(views) || empty('No posts in this section yet.')}${pager(base, n, hasMore)}`,
    css: previewCss(views),
  });
});

// Author pages (flag author_pages): the teammate's profile and their Dispatches on the site.
pages.get('/authors/:slug', async (c) => {
  const env = c.get('env');
  const channel = c.get('channel');
  if (!(await siteFlags(c)).author_pages) return notFoundPage(c);
  const slug = c.req.param('slug');
  const author =
    SLUG.test(slug) && slug.length <= 60 ? await siteAuthor(env, channel.id, { slug }) : null;
  if (!author) return notFoundPage(c);
  const n = pageNumber(c.req.query('page'));
  const [{ items, hasMore }, avatars] = await Promise.all([
    listDispatches(env, channel.id, { page: n, authorId: author.operatorId }),
    author.avatarMediaId
      ? mediaMap(env, channel.workspaceId, [author.avatarMediaId])
      : Promise.resolve(null),
  ]);
  if (n > 1 && items.length === 0) return notFoundPage(c);
  const avatar = author.avatarMediaId ? avatars?.get(author.avatarMediaId) : undefined;
  const views = await previews(c, items);
  const base = `/authors/${author.slug}`;
  const description = author.bio?.trim() || `Posts by ${author.name} in ${channel.name}.`;
  return page(c, {
    narrow: true,
    meta: {
      title: n > 1 ? `${author.name}, page ${n}` : author.name,
      description,
      path: n > 1 ? `${base}?page=${n}` : base,
      type: 'profile',
      image: avatar
        ? {
            url: avatar.url,
            alt: author.name,
            width: avatar.width ?? null,
            height: avatar.height ?? null,
          }
        : null,
    },
    body: `<header class="sw-author">${avatar ? `<img src="${h(avatar.url)}" alt="" width="96" height="96">` : ''}<div><h1>${h(author.name)}</h1>${author.bio ? `<p>${h(author.bio)}</p>` : ''}</div></header>
<h2 class="sw-section-title">Posts by ${h(author.name)}</h2>
${list(views, 3) || empty('No posts on the website yet.')}${pager(base, n, hasMore)}`,
    jsonLd: [
      {
        '@type': 'ProfilePage',
        url: `${channel.origin}${base}`,
        mainEntity: {
          '@type': 'Person',
          name: author.name,
          ...(author.bio ? { description: author.bio } : {}),
          ...(avatar ? { image: avatar.url } : {}),
        },
      },
    ],
    css: previewCss(views),
  });
});

pages.get('/search', async (c) => {
  const env = c.get('env');
  const channel = c.get('channel');
  const q = (c.req.query('q') ?? '').trim().slice(0, 200);
  // Each query runs a database search and is never cached, so one client gets a few a minute.
  if (q && !(await underSearchLimit(c))) {
    c.header('retry-after', '60');
    return c.html(
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Too many searches</title><p>Too many searches. Wait a minute, then try again.</p></html>',
      429,
      { 'cache-control': 'no-store' },
    );
  }
  const hits = q ? await search(env, channel.id, q) : [];
  const results = hits
    .map((hit) => {
      // FTS5 marks matches with \u0001 and \u0002; they survive escaping and become <mark>.
      const snippet = h(hit.snippet).split('\u0001').join('<mark>').split('\u0002').join('</mark>');
      return `<li><h2><a href="${h(dispatchPath(hit.slug))}">${h(hit.subject || 'Untitled post')}</a></h2>${snippet ? `<p>${snippet}</p>` : hit.preheader ? `<p>${h(hit.preheader)}</p>` : ''}<p class="sw-meta">${time(hit.publishedAt)}</p></li>`;
    })
    .join('');
  const summary = !q
    ? ''
    : hits.length
      ? `<p class="sw-muted">${hits.length === 20 ? 'Top 20 results' : `${hits.length} result${hits.length === 1 ? '' : 's'}`} for “${h(q)}”.</p>`
      : `<p class="sw-muted">No posts match “${h(q)}”. Try fewer or different words.</p>`;
  return page(c, {
    narrow: true,
    meta: {
      title: q ? `Search: ${q}` : 'Search',
      description: `Search posts from ${channel.name}.`,
      path: '/search',
      noindex: true,
    },
    body: `${pagehead('Search')}
<form class="sw-search" method="get" action="/search" role="search"><label class="sw-sr" for="sw-q-page">Search posts</label><input id="sw-q-page" type="search" name="q" value="${h(q)}" maxlength="200"><button type="submit">Search</button></form>
${summary}${results ? `<ul class="sw-list sw-results">${results}</ul>` : ''}`,
  });
});

pages.get('/offline', (c) =>
  page(c, {
    narrow: true,
    meta: {
      title: 'You are offline',
      description: 'This page needs a connection.',
      path: '/offline',
      noindex: true,
    },
    body: `${pagehead('You are offline', 'Check your connection, then reload the page.')}<p><a class="sw-button sw-ghost" href="/">Go to the home page</a></p>`,
    subscribe: false,
  }),
);

pages.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!SLUG.test(slug) || slug.length > 60) return notFoundPage(c);
  const [custom] = await publishedPages(c.get('env'), c.get('channel').id, slug);
  if (!custom) return notFoundPage(c);
  const rendered = await renderDocument(c, custom.contentJson);
  const content = rendered ? `${rendered.freeHtml}${rendered.gatedHtml}` : '';
  // With the flag off, a landing page is shown as the ordinary page it also is.
  if (custom.landingFormId && (await siteFlags(c)).landing_pages) {
    const form = await siteForm(c.get('env'), c.get('channel'), custom.landingFormId);
    return page(c, {
      narrow: true,
      meta: {
        title: custom.title,
        description: rendered?.excerpt || custom.title,
        path: `/${custom.slug}`,
      },
      bare: true,
      subscribe: false,
      bodyClass: 'sw-landing',
      body: `<div class="sw-article">${pagehead(custom.title)}<div class="sw-prose">${content}</div>
<section class="sw-subscribe" aria-label="Sign up">${subscribeForm(c.get('env'), form)}</section></div>`,
      css: rendered?.css ?? '',
      players: playersOf(rendered),
    });
  }
  return page(c, {
    narrow: true,
    meta: {
      title: custom.title,
      description: rendered?.excerpt || custom.title,
      path: `/${custom.slug}`,
    },
    body: `<div class="sw-article">${pagehead(custom.title)}<div class="sw-prose">${content || empty('Nothing here yet.')}</div></div>`,
    css: rendered?.css ?? '',
    players: playersOf(rendered),
  });
});

/**
 * The 404 page: branded for the Channel. Also used by routes that run before tenant resolution
 * (public media on any host), where there is no Channel; those get a plain page.
 */
export async function notFoundPage(c: SiteContext): Promise<Response> {
  if (!c.get('channel') || !c.get('env')) {
    return c.html(
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Not found</title><p>Page not found.</p></html>',
      404,
      { 'cache-control': 'public, max-age=60' },
    );
  }
  return page(
    c,
    {
      narrow: true,
      meta: {
        title: 'Page not found',
        description: 'There is no page at this address.',
        path: new URL(c.req.url).pathname,
        noindex: true,
      },
      body: `${pagehead('Page not found', 'There is no page at this address. It may have moved, or the link may be mistyped.')}
<p><a class="sw-button" href="/">Go to the home page</a> <a class="sw-button sw-ghost" href="/archive">Browse the archive</a></p>`,
    },
    { status: 404 },
  );
}
