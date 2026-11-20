// Link Hub (Phase 8, flag link_hub; docs/link-hub.md):
//
//   GET /links                 the Channel's link-in-bio page: logo, title and bio, social
//                              profiles, the live links, the latest Dispatches and a Capture Form.
//                              Rendered on the server with the site's theme and no script; cached
//                              at the edge like other pages, for 60 seconds so scheduled links
//                              come and go on time.
//   GET /_swarm/hub/<linkId>   the first-party click redirect: looks the link up in this
//                              Channel (the target never comes from the request), counts the
//                              click after the response unless it is a bot or a prefetch, and
//                              redirects with 302. Never cached.
//
// Both answer 404 while the flag is off for the Channel or the page is switched off. The edge
// adds this page view's source to each link after the cache (edge/hub.ts).
import {
  HUB_CLICK_PREFIX,
  HUB_EDGE_TTL_SECONDS,
  HUB_PATH,
  HUB_SOCIAL_LABELS,
  HUB_SOCIAL_NETWORKS,
  SUBPROCESSORS_URL,
  hubClickPath,
  hubLinkLive,
  hubLinkUrlProblem,
  idPattern,
  type HubSocialNetwork,
} from '@swarm/domain';
import { all, first } from '@swarm/db';
import { recordHubClick } from '@swarm/engine';
import { Hono } from 'hono';
import type { SiteBindings, SiteContext } from '../context';
import { countryOf, isBotRequest } from '../edge/analytics';
import { HUB_LINK_ATTRIBUTE } from '../edge/hub';
import { later } from '../readers/later';
import { dispatchLinks, mediaMap, siteFlags, siteForm } from '../render/data';
import { dispatchPath, h, time } from '../render/html';
import { headMeta, jsonLdScript, organizationLd, websiteLd, type SeoImage } from '../render/seo';
import { subscribeBlock } from '../render/subscribe';
import { stylesheetHref } from '../render/theme';
import { notFoundPage } from './pages';

export const hub = new Hono<SiteBindings>();

interface HubRow {
  enabled: number;
  title: string | null;
  bio: string | null;
  socials_json: string;
  latest_dispatches: number;
  show_form: number;
  capture_form_id: string | null;
}

interface LinkRow {
  id: string;
  title: string;
  url: string;
  thumbnail_media_id: string | null;
  starts_at: number | null;
  ends_at: number | null;
}

/** The page's settings while it is on and the flag is on for the Channel, else null. */
async function liveHub(c: SiteContext): Promise<HubRow | null> {
  if (!(await siteFlags(c)).link_hub) return null;
  const row = await first<HubRow>(
    c.get('env').DB,
    `SELECT enabled, title, bio, socials_json, latest_dispatches, show_form, capture_form_id
       FROM hub_settings WHERE channel_id = ?1`,
    c.get('channel').id,
  );
  return row?.enabled === 1 ? row : null;
}

function socialsOf(json: string): { network: HubSocialNetwork; url: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item: { network?: unknown; url?: unknown }) =>
    typeof item?.url === 'string' &&
    item.url.startsWith('https://') &&
    (HUB_SOCIAL_NETWORKS as readonly unknown[]).includes(item.network)
      ? [{ network: item.network as HubSocialNetwork, url: item.url }]
      : [],
  );
}

const HUB_CSS = `.sw-hub{max-width:560px;margin:0 auto;padding:48px 20px 24px}
.sw-hub-head{text-align:center}
.sw-hub-head img{width:88px;height:88px;border-radius:24px;object-fit:cover}
.sw-hub-head h1{font-size:clamp(26px,5vw,32px);margin:14px 0 6px}
.sw-hub-head p{color:var(--text-sub);margin:0 auto;max-width:44ch}
.sw-hub-socials{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:20px}
.sw-hub-socials a{display:inline-flex;align-items:center;min-height:40px;padding:0 14px;border:1px solid var(--line-strong);border-radius:999px;color:var(--ink);font-size:14px;text-decoration:none}
.sw-hub-socials a:hover{border-color:var(--accent)}
.sw-hub-links{list-style:none;margin:28px 0 0;padding:0;display:flex;flex-direction:column;gap:12px}
.sw-hub-link{display:flex;align-items:center;gap:14px;min-height:58px;padding:9px 18px;background:var(--surface);border:1px solid var(--line);border-radius:16px;color:var(--ink);font-weight:600;text-decoration:none;transition:transform .15s,border-color .15s}
.sw-hub-link:hover{border-color:var(--accent);transform:translateY(-1px)}
.sw-hub-link img{width:40px;height:40px;border-radius:10px;object-fit:cover;flex:none}
.sw-hub-link span{flex:1;text-align:center;overflow-wrap:anywhere}
.sw-hub-link img+span{text-align:left}
.sw-hub-dispatches{list-style:none;margin:0;padding:0}
.sw-hub-dispatches li{display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}
.sw-hub-dispatches a{color:var(--ink);font-weight:600;text-decoration:none}
.sw-hub-dispatches a:hover{color:var(--accent)}
.sw-hub-dispatches time{color:var(--text-sub);font-size:14px;white-space:nowrap}
.sw-hub-foot{text-align:center;font-size:13.5px;color:var(--text-sub);padding:8px 20px 40px}
.sw-hub-foot a{color:var(--text-sub)}
.sw-hub-foot span{margin:0 8px}`;

hub.get(HUB_PATH, async (c) => {
  const settings = await liveHub(c);
  if (!settings) return notFoundPage(c);
  const env = c.get('env');
  const channel = c.get('channel');
  const nonce = c.get('nonce');
  const now = Date.now();

  const rows = await all<LinkRow>(
    env.DB,
    `SELECT id, title, url, thumbnail_media_id, starts_at, ends_at FROM hub_links
      WHERE channel_id = ?1 ORDER BY position, created_at LIMIT 100`,
    channel.id,
  );
  const links = rows.filter(
    (link) =>
      hubLinkLive({ startsAt: link.starts_at, endsAt: link.ends_at }, now) &&
      hubLinkUrlProblem(link.url) === null,
  );
  const logoId = channel.branding.logoMediaId;
  const mediaIds = links.map((link) => link.thumbnail_media_id).filter((id) => id !== null);
  const [media, dispatches, chosenForm] = await Promise.all([
    mediaMap(env, channel.workspaceId, logoId ? [...mediaIds, logoId] : mediaIds),
    settings.latest_dispatches > 0
      ? dispatchLinks(env, channel.id, settings.latest_dispatches)
      : Promise.resolve([]),
    settings.show_form === 1 && settings.capture_form_id
      ? siteForm(env, channel, settings.capture_form_id)
      : Promise.resolve(null),
  ]);
  // The chosen form when it still qualifies, else the Channel's site form.
  const form = settings.show_form === 1 ? (chosenForm ?? (await siteForm(env, channel))) : null;

  const logoMedia = logoId ? media.get(logoId) : undefined;
  const logo: SeoImage | null = logoMedia
    ? {
        url: logoMedia.url,
        alt: channel.name,
        width: logoMedia.width ?? null,
        height: logoMedia.height ?? null,
      }
    : null;
  const title = settings.title || channel.name;
  const bio = settings.bio || channel.description || '';
  const theme = channel.settings.theme ?? {};
  const font = theme.font === 'inter' ? 'inter' : 'geist';
  const scheme =
    theme.colorScheme === 'light' || theme.colorScheme === 'dark' ? theme.colorScheme : 'auto';

  const socials = socialsOf(settings.socials_json);
  const socialsHtml = socials.length
    ? `<nav class="sw-hub-socials" aria-label="Profiles">${socials
        .map(
          (s) => `<a href="${h(s.url)}" rel="me noopener">${h(HUB_SOCIAL_LABELS[s.network])}</a>`,
        )
        .join('')}</nav>`
    : '';
  const linksHtml = links.length
    ? `<ul class="sw-hub-links">${links
        .map((link) => {
          const thumb = link.thumbnail_media_id ? media.get(link.thumbnail_media_id) : undefined;
          const img = thumb
            ? `<img src="${h(thumb.url)}" alt="" width="40" height="40" loading="lazy" decoding="async">`
            : '';
          return `<li><a class="sw-hub-link" href="${h(hubClickPath(link.id))}" ${HUB_LINK_ATTRIBUTE}>${img}<span>${h(link.title)}</span></a></li>`;
        })
        .join('')}</ul>`
    : '';
  const dispatchesHtml = dispatches.length
    ? `<section aria-labelledby="sw-hub-latest"><h2 class="sw-section-title" id="sw-hub-latest">Latest posts</h2><ul class="sw-hub-dispatches">${dispatches
        .map(
          (d) =>
            `<li><a href="${h(dispatchPath(d.slug))}">${h(d.subject || 'Untitled post')}</a>${time(d.publishedAt)}</li>`,
        )
        .join('')}</ul></section>`
    : '';
  const formHtml = settings.show_form === 1 ? subscribeBlock(env, channel, form) : '';
  const logoHtml = logo ? `<img src="${h(logo.url)}" alt="" width="88" height="88">` : '';

  const html = `<!doctype html>
<html lang="en" class="sw-font-${font}" data-scheme="${scheme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="${scheme === 'auto' ? 'light dark' : scheme}">
<meta name="referrer" content="strict-origin-when-cross-origin">
${headMeta(channel, { title, description: bio || `Links from ${channel.name}.`, path: HUB_PATH, image: logo }, logo, title === channel.name ? `Links · ${channel.name}` : `${title} · ${channel.name}`)}
<link rel="stylesheet" href="${h(stylesheetHref(channel))}">
<style nonce="${h(nonce)}">${HUB_CSS}</style>
${jsonLdScript([websiteLd(channel), organizationLd(channel, logo)], nonce)}
</head>
<body>
<main id="main" class="sw-hub">
<header class="sw-hub-head">${logoHtml}<h1>${h(title)}</h1>${bio ? `<p>${h(bio)}</p>` : ''}</header>
${socialsHtml}
${linksHtml}
${dispatchesHtml}
${formHtml}
</main>
<footer class="sw-hub-foot"><a href="/">${h(channel.name)}</a><span aria-hidden="true">·</span><a href="${SUBPROCESSORS_URL}" rel="noopener">Subprocessors</a></footer>
</body>
</html>`;

  const tags = [channel.id, 'link-hub'];
  return c.html(html, 200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': `public, s-maxage=${HUB_EDGE_TTL_SECONDS}, stale-while-revalidate=${HUB_EDGE_TTL_SECONDS}`,
    'x-swarm-cacheable': '1',
    'cache-tag': tags.join(','),
  });
});

hub.get(`${HUB_CLICK_PREFIX}:linkId`, async (c) => {
  const linkId = c.req.param('linkId');
  if (!idPattern('hubLink').test(linkId) || !(await liveHub(c))) return notFoundPage(c);
  const channel = c.get('channel');
  const link = await first<LinkRow>(
    c.get('env').DB,
    `SELECT id, title, url, thumbnail_media_id, starts_at, ends_at FROM hub_links
      WHERE id = ?1 AND channel_id = ?2`,
    linkId,
    channel.id,
  );
  if (!link || hubLinkUrlProblem(link.url) !== null) return notFoundPage(c);
  c.header('cache-control', 'no-store');
  c.header('x-robots-tag', 'noindex');
  if (!hubLinkLive({ startsAt: link.starts_at, endsAt: link.ends_at }, Date.now())) {
    return c.redirect(HUB_PATH, 302);
  }
  countClick(c, link.id);
  return c.redirect(new URL(link.url).href, 302);
});

interface CfProperties {
  verifiedBotCategory?: string;
  botManagement?: { verifiedBot?: boolean };
  country?: string;
}

/** Counts a click after the response, unless it is a HEAD, a bot or a prefetch. */
function countClick(c: SiteContext, linkId: string): void {
  const cf = c.req.raw.cf as CfProperties | undefined;
  const userAgent = c.req.header('user-agent');
  const purpose = c.req.header('sec-purpose') ?? c.req.header('purpose') ?? '';
  if (
    c.req.method !== 'GET' ||
    /prefetch|prerender/i.test(purpose) ||
    !userAgent ||
    isBotRequest(userAgent, cf)
  ) {
    return;
  }
  const url = new URL(c.req.url);
  later(
    c,
    recordHubClick(c.get('env').DB, {
      channelId: c.get('channel').id,
      linkId,
      source: url.searchParams.get('s'),
      referrer: c.req.header('referer') ?? null,
      host: url.hostname,
      country: countryOf(cf),
      now: Date.now(),
    }),
  );
}
