// RSS, JSON Feed and sitemaps.
//
//   /feed                    RSS 2.0, the latest 50 Dispatches
//   /feed.json               JSON Feed 1.1, the same items
//   /sitemap.xml             sitemap index → /sitemap-pages.xml and /sitemap-dispatches.xml
//   /sitemap                 the same as an HTML page for readers
//
// Feeds are read as an anonymous reader: public Dispatches carry their full content; Member-only
// and paid ones carry their free part (see render/dispatch.ts for the implicit preview) and a link
// to the site. All of it is cacheable at the edge.
import { championSettings } from '@swarm/engine';
import { Hono } from 'hono';
import type { SiteBindings, SiteContext } from '../context';
import {
  dispatchLinks,
  mediaMap,
  publishedPages,
  recentDispatches,
  sections,
  seriesLinks,
  siteFlags,
} from '../render/data';
import { dispatchImage, dispatchMediaIds, renderDispatch, summaryOf } from '../render/dispatch';
import { absolute, cacheHeaders, dispatchPath, h, time, x } from '../render/html';
import { page } from '../render/layout';

export const feeds = new Hono<SiteBindings>();

const FEED_ITEMS = 50;
const SITEMAP_LIMIT = 50_000;

interface FeedItem {
  url: string;
  title: string;
  summary: string;
  html: string;
  image: string | null;
  publishedAt: number;
  updatedAt: number;
}

async function feedItems(c: SiteContext): Promise<FeedItem[]> {
  const env = c.get('env');
  const channel = c.get('channel');
  const dispatches = await recentDispatches(env, channel.id, FEED_ITEMS);
  const [media, flags] = await Promise.all([
    mediaMap(env, channel.workspaceId, dispatchMediaIds(dispatches)),
    siteFlags(c),
  ]);
  return dispatches.map((dispatch) => {
    const rendered = renderDispatch(dispatch, {
      channelName: channel.name,
      media,
      allowHtmlBlocks: flags.raw_html_mode,
      codeEmbeds: flags.code_embeds,
    });
    const url = absolute(channel, dispatchPath(dispatch.slug));
    const html =
      dispatch.visibility === 'public'
        ? [rendered.freeHtml, rendered.gatedHtml].filter(Boolean).join('\n')
        : `${rendered.freeHtml}\n<p><a href="${h(url)}">${
            dispatch.visibility === 'paid'
              ? 'This post is for paid subscribers. Read it on the site.'
              : 'Read the rest on the site as a subscriber.'
          }</a></p>`;
    return {
      url,
      title: dispatch.subject || 'Untitled post',
      summary: summaryOf(dispatch, rendered),
      html,
      image: dispatchImage(rendered, env.MEDIA_ORIGIN, null)?.url ?? null,
      publishedAt: dispatch.publishedAt,
      updatedAt: Math.max(dispatch.updatedAt, dispatch.publishedAt),
    };
  });
}

async function logoUrl(c: SiteContext): Promise<string | null> {
  const channel = c.get('channel');
  const id = channel.branding.logoMediaId;
  if (!id) return null;
  return (await mediaMap(c.get('env'), channel.workspaceId, [id])).get(id)?.url ?? null;
}

function send(c: SiteContext, body: string, type: string): Response {
  return c.body(body, 200, { ...cacheHeaders(c, 'public'), 'content-type': type });
}

feeds.get('/feed', async (c) => {
  const channel = c.get('channel');
  const [items, logo] = await Promise.all([feedItems(c), logoUrl(c)]);
  const home = absolute(channel, '/');
  const description = channel.description || `Posts from ${channel.name}.`;
  const latest = items[0]?.publishedAt ?? Date.now();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${x(channel.name)}</title>
<link>${x(home)}</link>
<description>${x(description)}</description>
<language>en</language>
<generator>Swarm</generator>
<lastBuildDate>${new Date(latest).toUTCString()}</lastBuildDate>
<atom:link href="${x(absolute(channel, '/feed'))}" rel="self" type="application/rss+xml"/>
${logo ? `<image><url>${x(logo)}</url><title>${x(channel.name)}</title><link>${x(home)}</link></image>` : ''}
${items
  .map(
    (item) => `<item>
<title>${x(item.title)}</title>
<link>${x(item.url)}</link>
<guid isPermaLink="true">${x(item.url)}</guid>
<pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate>
<description>${x(item.summary)}</description>
<content:encoded>${x(item.html)}</content:encoded>
</item>`,
  )
  .join('\n')}
</channel>
</rss>
`;
  return send(c, xml, 'application/rss+xml; charset=utf-8');
});

feeds.get('/feed.json', async (c) => {
  const channel = c.get('channel');
  const [items, logo] = await Promise.all([feedItems(c), logoUrl(c)]);
  const feed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: channel.name,
    home_page_url: absolute(channel, '/'),
    feed_url: absolute(channel, '/feed.json'),
    ...(channel.description ? { description: channel.description } : {}),
    ...(logo ? { icon: logo, favicon: logo } : {}),
    language: 'en',
    authors: [{ name: channel.name, url: absolute(channel, '/') }],
    items: items.map((item) => ({
      id: item.url,
      url: item.url,
      title: item.title,
      content_html: item.html,
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.image ? { image: item.image } : {}),
      date_published: new Date(item.publishedAt).toISOString(),
      date_modified: new Date(item.updatedAt).toISOString(),
    })),
  };
  return send(c, JSON.stringify(feed), 'application/feed+json; charset=utf-8');
});

const iso = (ms: number) => new Date(ms).toISOString();

feeds.get('/sitemap.xml', (c) => {
  const channel = c.get('channel');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>${x(absolute(channel, '/sitemap-pages.xml'))}</loc></sitemap>
<sitemap><loc>${x(absolute(channel, '/sitemap-dispatches.xml'))}</loc></sitemap>
</sitemapindex>
`;
  return send(c, xml, 'application/xml; charset=utf-8');
});

/** The site's own pages: home, archive, about, published custom pages and sections. */
async function sitePaths(
  c: SiteContext,
): Promise<{ path: string; title: string; updatedAt?: number }[]> {
  const env = c.get('env');
  const channel = c.get('channel');
  const [custom, flags] = await Promise.all([publishedPages(env, channel.id), siteFlags(c)]);
  const paths: { path: string; title: string; updatedAt?: number }[] = [
    { path: '/', title: 'Home' },
    { path: '/archive', title: 'Archive' },
    { path: '/about', title: `About ${channel.name}` },
    { path: '/subscribe', title: 'Plans' },
    ...custom.map((p) => ({ path: `/${p.slug}`, title: p.title, updatedAt: p.updatedAt })),
  ];
  if (flags.site_sections) {
    for (const section of await sections(env, channel.id)) {
      paths.push({ path: `/s/${section.slug}`, title: section.name });
    }
  }
  if (flags.post_series) {
    for (const series of await seriesLinks(env, channel.id)) {
      paths.push({
        path: `/series/${series.slug}`,
        title: series.name,
        updatedAt: series.updatedAt,
      });
    }
  }
  if (flags.referral_awards) {
    const champions = await championSettings(env.DB, channel.id);
    if (champions.enabled === 1 && champions.public_leaderboard === 1) {
      paths.push({ path: '/champions', title: 'Top referrers' });
    }
  }
  return paths;
}

const urlset = (entries: { loc: string; lastmod?: number }[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    (e) =>
      `<url><loc>${x(e.loc)}</loc>${e.lastmod ? `<lastmod>${iso(e.lastmod)}</lastmod>` : ''}</url>`,
  )
  .join('\n')}
</urlset>
`;

feeds.get('/sitemap-pages.xml', async (c) => {
  const channel = c.get('channel');
  const paths = await sitePaths(c);
  return send(
    c,
    urlset(
      paths.map((p) => ({
        loc: absolute(channel, p.path),
        ...(p.updatedAt ? { lastmod: p.updatedAt } : {}),
      })),
    ),
    'application/xml; charset=utf-8',
  );
});

feeds.get('/sitemap-dispatches.xml', async (c) => {
  const channel = c.get('channel');
  const links = await dispatchLinks(c.get('env'), channel.id, SITEMAP_LIMIT);
  return send(
    c,
    urlset(
      links.map((d) => ({
        loc: absolute(channel, dispatchPath(d.slug)),
        lastmod: Math.max(d.updatedAt, d.publishedAt),
      })),
    ),
    'application/xml; charset=utf-8',
  );
});

feeds.get('/sitemap', async (c) => {
  const channel = c.get('channel');
  const [paths, links] = await Promise.all([
    sitePaths(c),
    dispatchLinks(c.get('env'), channel.id, 5000),
  ]);
  const pagesList = paths.map((p) => `<li><a href="${h(p.path)}">${h(p.title)}</a></li>`).join('');
  const dispatches = links
    .map(
      (d) =>
        `<li><a href="${h(dispatchPath(d.slug))}">${h(d.subject || 'Untitled post')}</a> <span class="sw-muted">${time(d.publishedAt)}</span></li>`,
    )
    .join('');
  return page(c, {
    meta: {
      title: 'Sitemap',
      description: `Every page and post on ${channel.name}.`,
      path: '/sitemap',
    },
    body: `<header class="sw-pagehead"><h1>Sitemap</h1></header>
<div class="sw-sitemap">
<h2>Pages</h2><ul>${pagesList}</ul>
<h2>Posts</h2>${dispatches ? `<ul>${dispatches}</ul>` : '<p class="sw-muted">No posts yet.</p>'}
</div>`,
  });
});
