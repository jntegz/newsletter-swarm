// The page shell every site page shares: head (SEO, stylesheet, nonce'd page styles, JSON-LD),
// header with the Channel's name, logo, navigation and search, the subscribe section, and the
// footer. Pages run no script, except the small nonce'd script that reveals a Smart Prompt shown
// on scroll, exit intent or after a delay (render/prompts.ts), and the one that loads an embed's
// player when a reader asks for it (render/players.ts).
import { SUBPROCESSORS_URL, isHttpsUrl, isSitePath } from '@swarm/domain';
import type { FlagValues } from '@swarm/flags';
import type { SiteContext } from '../context';
import {
  mediaMap,
  publishedPages,
  sections,
  siteCodeFor,
  siteFlags,
  siteForm,
  type SiteForm,
} from './data';
import { cacheHeaders, h, type Cacheability } from './html';
import {
  headMeta,
  jsonLdScript,
  organizationLd,
  websiteLd,
  type PageMeta,
  type SeoImage,
} from './seo';
import {
  pickPrompt,
  promptHtml,
  promptScript,
  readDismissals,
  sitePrompts,
  type SitePrompt,
} from './prompts';
import { subscribeBlock } from './subscribe';
import {
  CONSENT_CSS,
  consentCss,
  consentMarkup,
  hasRunnableCode,
  verificationTags,
  type SiteCodeSettings,
} from './consent';
import { isPaymentPath, siteCsp } from '../edge/headers';
import { PLAYER_CSS, playerScript } from './players';
import { activeDesign, type ActiveDesign } from './design';
import { SEARCH_LINK, stylesheetHref } from './theme';

/** What every page needs besides its own content, loaded once per request. */
export interface Chrome {
  flags: FlagValues;
  logo: SeoImage | null;
  nav: { label: string; href: string }[];
  form: SiteForm | null;
  /** Published Smart Prompts (flag smart_prompts), and the reader's dismissals. */
  prompts: SitePrompt[];
  dismissed: Map<string, number>;
  /** The cookie popup and the owner's code (flag site_custom_code). */
  code: SiteCodeSettings | null;
  /** The website design the site shows (flag site_templates), or null for the plain layouts. */
  design: ActiveDesign | null;
}

export async function loadChrome(c: SiteContext): Promise<Chrome> {
  const env = c.get('env');
  const channel = c.get('channel');
  const logoId = channel.branding.logoMediaId;
  const [flags, logoMedia, pages, form] = await Promise.all([
    siteFlags(c),
    logoId ? mediaMap(env, channel.workspaceId, [logoId]) : Promise.resolve(null),
    publishedPages(env, channel.id),
    siteForm(env, channel),
  ]);
  const [prompts, code, design] = await Promise.all([
    flags.smart_prompts ? sitePrompts(env, channel) : Promise.resolve([]),
    flags.site_custom_code ? siteCodeFor(env, channel) : Promise.resolve(null),
    activeDesign(c, flags),
  ]);
  const media = logoId ? logoMedia?.get(logoId) : undefined;
  const logo: SeoImage | null = media
    ? {
        url: media.url,
        alt: channel.name,
        width: media.width ?? null,
        height: media.height ?? null,
      }
    : null;

  const nav: Chrome['nav'] = [];
  for (const link of channel.settings.nav ?? []) {
    if (typeof link?.label !== 'string' || typeof link.href !== 'string') continue;
    if (isSitePath(link.href) || isHttpsUrl(link.href))
      nav.push({ label: link.label, href: link.href });
  }
  if (nav.length === 0) {
    nav.push({ label: 'Archive', href: '/archive' }, { label: 'About', href: '/about' });
  }
  for (const page of pages) {
    if (page.inNav) nav.push({ label: page.title, href: `/${page.slug}` });
  }
  if (flags.site_sections) {
    for (const section of await sections(env, channel.id)) {
      nav.push({ label: section.name, href: `/s/${section.slug}` });
    }
  }
  return {
    flags,
    logo,
    nav: nav.slice(0, 30),
    form,
    prompts,
    dismissed: prompts.length ? readDismissals(c) : new Map(),
    code,
    design,
  };
}

interface PageInput {
  meta: PageMeta;
  /** Inner HTML of <main>. */
  body: string;
  /** Extra JSON-LD nodes; WebSite and Organization are always included. */
  jsonLd?: Record<string, unknown>[];
  /** Page-specific rules (focal points from the web renderer), sent in a nonce'd <style>. */
  css?: string;
  /** False when the page carries its own subscribe form (a gated Dispatch). */
  subscribe?: boolean;
  /** A reading page: one column of about 720px, so the heading, text and subscribe box line up. */
  narrow?: boolean;
  /** Extra classes on <body>. */
  bodyClass?: string;
  /** A landing page: no navigation, search, footer links or Smart Prompts to lead people away. */
  bare?: boolean;
  /**
   * Keeps the owner's code off a page whose URL holds a secret (a gift link, a signup step) or
   * that shows gated text in full.
   */
  noOwnerCode?: boolean;
  /**
   * The referrer policy of a page whose URL holds a secret, sent as the header and the meta element
   * alike (a meta element replaces the header's policy). Default 'strict-origin'.
   */
  referrer?: 'no-referrer' | 'strict-origin';
  /** Origins of the players in `body`, so the page gets their script, rules and frame-src. */
  players?: string[];
  /** The whole stylesheet inline instead of linked (a preview of a draft design). */
  stylesheet?: string;
  /** HTML at the top of <body>, outside <main> (the preview bar). */
  banner?: string;
  /**
   * False: `body` is all there is in the page-width wrapper, without the subscribe section (a
   * design's home page; its themes were drawn inside that wrapper and reach past it themselves).
   */
  wrap?: boolean;
}

/** The browser's own colour around the page (the address bar on phones), matching the page. */
function themeColorMeta(
  scheme: 'light' | 'dark' | 'auto',
  pages: { light: string; dark: string } = { light: '#fbfbfd', dark: '#0f0f12' },
): string {
  const light = `<meta name="theme-color" content="${h(pages.light)}"`;
  const dark = `<meta name="theme-color" content="${h(pages.dark)}"`;
  if (scheme === 'light') return `${light}>`;
  if (scheme === 'dark') return `${dark}>`;
  return `${light} media="(prefers-color-scheme: light)">\n${dark} media="(prefers-color-scheme: dark)">`;
}

export function renderPage(c: SiteContext, chrome: Chrome, input: PageInput): string {
  const channel = c.get('channel');
  const env = c.get('env');
  const nonce = c.get('nonce');
  const theme = channel.settings.theme ?? {};
  const design = chrome.design;
  // A design's tokens carry its fonts and its light and dark colours; data-scheme="t-…" keeps the
  // base dark rules (data-scheme=dark, auto) from overriding them.
  const font = design ? design.font : theme.font === 'inter' ? 'inter' : 'geist';
  const scheme = design
    ? design.scheme
    : theme.colorScheme === 'light' || theme.colorScheme === 'dark'
      ? theme.colorScheme
      : 'auto';
  const path = new URL(c.req.url).pathname;
  const title = input.meta.path === '/' ? channel.name : `${input.meta.title} · ${channel.name}`;

  const navHtml = chrome.nav
    .map(
      (link) =>
        `<a href="${h(link.href)}"${link.href === path ? ' aria-current="page"' : ''}>${h(link.label)}</a>`,
    )
    .join('');
  const logo = chrome.logo ? `<img src="${h(chrome.logo.url)}" alt="" width="36" height="36">` : '';
  // The header button jumps to the page's signup: the shared section, or a paywall panel's form.
  const subscribeTarget = input.subscribe !== false || input.body.includes(' id="subscribe"');
  const bodyClass = [input.bodyClass ?? ''].filter(Boolean).join(' ');
  // A Smart Prompt shown on scroll, exit intent or after a delay: hidden until the script shows it.
  const floating =
    input.bare || c.get('crawlerFullAccess') || !chrome.prompts.length
      ? null
      : pickPrompt(chrome.prompts, {
          triggers: ['scroll', 'exit_intent', 'delay'],
          path,
          reader: c.get('reader').class,
          dismissed: chrome.dismissed,
        });
  const promptMarkup = floating
    ? `${promptHtml(env, floating, `${path}${new URL(c.req.url).search}`)}
${promptScript(nonce)}`
    : '';

  const secretUrl =
    input.noOwnerCode ||
    input.referrer !== undefined ||
    path.startsWith('/_swarm/') ||
    new URL(c.req.url).searchParams.has('gift');
  // A secret URL is never sent on, not even to this site's next page, where owner code can read
  // document.referrer. Origin only by default, not no-referrer: with no-referrer a browser sends
  // `Origin: null` on form posts, and the capture worker checks the subscribe form's origin.
  const referrer = secretUrl ? (input.referrer ?? 'strict-origin') : null;
  if (referrer) c.header('referrer-policy', referrer);
  // Full-access crawlers see the page as it is, without anyone's analytics. Owner code (including
  // a third-party tag the owner added, and whatever that vendor later serves) never runs for a
  // signed-in reader: it would be same-origin with their session and could act as them (share
  // gift links, sign out, read their pages). Nor on a page showing gated text in full.
  const signedIn = c.get('reader').memberId !== null;
  const ownerCode =
    chrome.code && !secretUrl && !signedIn && !c.get('crawlerFullAccess') ? chrome.code : null;
  if (ownerCode && hasRunnableCode(ownerCode)) c.set('ownerCode', true);
  const consent = ownerCode?.consent?.enabled ? ownerCode.consent : null;
  const players = [...new Set(input.players)];
  if (players.length) c.set('players', players);
  const pageCss = `${input.stylesheet ?? ''}${input.css ?? ''}${players.length ? PLAYER_CSS : ''}${consent ? CONSENT_CSS : ''}${consentCss(consent)}`;

  return `<!doctype html>
<html lang="en" class="sw-font-${h(font)}" data-scheme="${design ? `t-${scheme}` : scheme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="${scheme === 'auto' ? 'light dark' : scheme}">
${themeColorMeta(scheme, design?.pages)}
<meta name="referrer" content="${referrer ?? 'strict-origin-when-cross-origin'}">
${headMeta(channel, input.meta, chrome.logo, title, !!env.IMAGES)}
${input.stylesheet === undefined ? `<link rel="stylesheet" href="${h(stylesheetHref(channel, design))}">` : ''}
${pageCss ? `<style nonce="${h(nonce)}">${pageCss.replace(/<\//g, '<\\/')}</style>` : ''}
${ownerCode ? verificationTags(ownerCode.code) : ''}
${jsonLdScript([websiteLd(channel), organizationLd(channel, chrome.logo), ...(input.jsonLd ?? [])], nonce)}
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
${input.banner ?? ''}<a class="sw-skip" href="#main">Skip to content</a>
<header class="sw-header"><div class="sw-wrap">
<a class="sw-brand" href="/">${logo}<span>${h(channel.name)}</span></a>
${
  input.bare
    ? ''
    : `<nav class="sw-nav" aria-label="Site">${navHtml}</nav>
<form class="sw-search" method="get" action="/search" role="search"><label class="sw-sr" for="sw-q">Search</label><input id="sw-q" type="search" name="q" placeholder="Search" maxlength="200"></form>${design ? SEARCH_LINK : ''}`
}
${subscribeTarget ? '<a class="sw-button" href="#subscribe">Subscribe</a>' : ''}
</div></header>
${
  input.wrap === false
    ? `<main id="main" class="sw-main sw-main-design"><div class="sw-wrap">
${input.body}
${promptMarkup}
</div></main>`
    : `<main id="main" class="sw-main"><div class="sw-wrap${input.narrow ? ' sw-narrow' : ''}">
${input.body}
${input.subscribe === false ? '' : subscribeBlock(env, channel, chrome.form)}
${promptMarkup}
</div></main>`
}
<footer class="sw-footer"><div class="sw-wrap">
${
  input.bare
    ? ''
    : `<nav aria-label="Footer"><a href="/archive">Archive</a><a href="/about">About</a><a href="/search">Search</a><a href="/feed">RSS</a><a href="/sitemap">Sitemap</a><a href="/_swarm/reader/signin?return=${encodeURIComponent(path)}">Sign in</a><a href="${SUBPROCESSORS_URL}" rel="noopener">Subprocessors</a><a href="${h(`${env.CAPTURE_ORIGIN.replace(/\/$/, '')}/privacy/${channel.id}`)}">Your data</a></nav>`
}
<p>© ${new Date().getUTCFullYear()} ${h(channel.name)}${consent ? ' <button type="button" id="sw-consent-open" class="sw-consent-link" hidden>Cookie settings</button>' : ''}</p>
</div></footer>
${ownerCode ? consentMarkup(ownerCode, nonce, env) : ''}${players.length ? `\n${playerScript(nonce)}` : ''}
</body>
</html>`;
}

/** Sends a rendered page with the right content type and cache headers. */
export function sendPage(
  c: SiteContext,
  html: string,
  options: { status?: 200 | 404; cache?: Cacheability; tags?: string[] } = {},
): Response {
  // Decided per page, not by path: the owner's code stays off some pages of the same path. A route-set
  // CSP is kept on a cache hit, with this request's nonce swapped in.
  const ownerCode = c.get('ownerCode') === true;
  const players = c.get('players') ?? [];
  const csp =
    ownerCode || players.length
      ? {
          'content-security-policy': siteCsp(c.get('env'), c.get('nonce'), {
            ownerCode,
            players,
            payments: isPaymentPath(new URL(c.req.url).pathname),
          }),
        }
      : {};
  return c.html(html, options.status ?? 200, {
    ...cacheHeaders(c, options.cache ?? 'public', options.tags),
    ...csp,
    'content-type': 'text/html; charset=utf-8',
  });
}

/** Shell + send in one step, for pages that need nothing else. */
export async function page(
  c: SiteContext,
  input: PageInput,
  options: { status?: 200 | 404; cache?: Cacheability; tags?: string[] } = {},
): Promise<Response> {
  const chrome = await loadChrome(c);
  return sendPage(c, renderPage(c, chrome, input), options);
}
