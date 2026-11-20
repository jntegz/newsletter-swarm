// The site stylesheet: one file per Channel, served at /_swarm/site.css?v=<version> with an
// immutable cache. The version carries the settings cache version, the accent colour and the
// revision of these rules, so a change to any of them is a new URL. Everything else that varies by
// Channel (font, colour scheme, drop caps) is a class or attribute on <html>/<body>, so the rules
// here are the same for all.
//
// With a website design (flag site_templates, render/design.ts) its tokens and theme.css follow
// the base rules and come before the owner's CSS. The design's variables are set on html, so the
// base variables are too (on :root they would win by specificity); the version then also carries
// a hash of the theme's files, so a new built-in theme is a new URL.
//
// Fonts: Geist and Inter are named first and used when the reader has them installed; otherwise
// the system stack. Nothing is downloaded from anywhere else (no third-party requests on a site):
// a design's built-in fonts come from /_swarm/fonts/ and its uploaded ones from /media/.
//
// Colour: --accent is the owner's colour, used as they chose it for buttons (with --on-accent text
// picked for contrast). --link is the same colour moved, only as far as needed, until it reads as
// text (4.5:1) on the page of each scheme. So any accent works, light or dark.
import { readableColor, textOn } from '@swarm/domain';
import { designCss, type FontLookup } from '@swarm/site-themes';
import { codeTokenCss } from '@swarm/mail';
import type { SiteChannel } from '../context';
import type { ActiveDesign } from './design';
import { accentOf } from './html';
import { ARCHIVE_CSS } from './templates';

/** Bump when the rules below change, so browsers holding the old file for a year fetch the new one. */
export const CSS_REVISION = 3;

export function stylesheetVersion(
  channel: SiteChannel,
  design: ActiveDesign | null = null,
): string {
  return `${channel.settings.cacheVersion}.${accentOf(channel).slice(1)}.${CSS_REVISION}${design ? `.${design.key}` : ''}`;
}

export const stylesheetHref = (channel: SiteChannel, design: ActiveDesign | null = null) =>
  `/_swarm/site.css?v=${stylesheetVersion(channel, design)}`;

/** The lightest surface text sits on in the dark scheme, and the darkest in the light one. */
const LIGHT_SURFACE = '#f8f7fc';
const DARK_SURFACE = '#1d1d24';

/** The accent as link text on a page of this colour. */
const linkColor = (accent: string, surface: string) => readableColor(accent, surface, 4.6);

const SYSTEM = "-apple-system, 'Segoe UI', system-ui, 'Helvetica Neue', sans-serif";
const MONO = "'Geist Mono', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

const LIGHT = `--page:#fbfbfd;--surface:#ffffff;--surface-alt:#f8f7fc;--ink:#0f0f12;--text:#2b2b33;--text-sub:#6b6b76;--line:#ececf2;--line-strong:#dcdae6;--mark:#efeafe`;
const DARK = `--page:#0f0f12;--surface:#17171c;--surface-alt:#1d1d24;--ink:#f4f3f8;--text:#dddce6;--text-sub:#a2a2ad;--line:#2a2a33;--line-strong:#3a3a46;--mark:#2d2550`;

/**
 * The site's rules. With the site_templates flag, a design's rules and then the owner's CSS come
 * last, so they win. `fonts` finds the uploaded fonts the design uses (designFonts).
 */
export function siteCss(
  channel: SiteChannel,
  templates = false,
  design: ActiveDesign | null = null,
  fonts?: FontLookup,
): string {
  const active = templates ? design : null;
  return `${baseCss(channel, active !== null)}${active ? designRules(active, fonts) : ''}${templates ? `${channel.settings.customCss}\n` : ''}`;
}

/** The section analytics beacon (render/design.ts sectionBeacon) takes no space and no clicks. */
const BEACON_CSS =
  '.t-beacon{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}\n';

/**
 * A design's rules: the archive by month, code colours for its own dark scheme (the page says
 * data-scheme="t-dark" or "t-auto", so the base dark rules stay out of the way of its tokens),
 * then its tokens (with the @font-face of any uploaded font) and theme.css.
 */
/**
 * With a website design, phones get this link to the search page in place of the search field
 * (layout.ts adds it to the header), so the header keeps to one line and the first screen belongs
 * to the page. DESIGN_SHELL_CSS shows one or the other.
 */
export const SEARCH_LINK =
  '<a class="sw-search-link" href="/search" aria-label="Search"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6.25" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="m15.25 15.25 5 5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg></a>';

/**
 * The shell around a design (before theme.css, so a theme can restyle it): on phones the header
 * keeps to one line, with a search link (SEARCH_LINK in layout.ts) in place of the field and the
 * navigation beside the name when it fits, else on a line of its own that scrolls sideways; the
 * footer on one line; text balanced and wrapped with care; a softer selection, a pressed state
 * for buttons, and a smooth jump to the form only when the reader allows motion.
 */
const DESIGN_SHELL_CSS = `body{font-variant-numeric:normal}
h1,h2,h3,h4{text-wrap:balance}
p,li,dd,blockquote,figcaption{text-wrap:pretty}
a{text-underline-offset:.2em;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
::selection{background:color-mix(in srgb,var(--accent) 28%,var(--page));color:var(--ink)}
.sw-button:active,button:active{transform:none;filter:brightness(.85)}
html{scroll-padding-top:20px}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
.sw-brand{min-width:0}
.sw-brand span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw-search input{width:176px}
.sw-search-link{display:none;flex:none;align-items:center;justify-content:center;width:40px;height:40px;margin-right:-8px;border-radius:999px;color:var(--text-sub)}
.sw-search-link:hover{color:var(--ink);background:var(--surface-alt)}
.sw-footer .sw-wrap{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:12px 32px}
.sw-footer nav{margin:0;gap:6px 20px}
.sw-footer p{margin:0}
.sw-footer a{text-decoration:none}
.sw-footer a:hover{color:var(--ink);text-decoration:underline}
@media (max-width:760px){.sw-header .sw-wrap{gap:0 12px;min-height:60px;padding-top:6px;padding-bottom:6px}
.sw-brand{font-size:18px}
.sw-brand img{width:32px;height:32px;border-radius:9px}
.sw-search{display:none}
.sw-search-link{display:inline-flex;order:3}
.sw-header .sw-button{order:4;min-height:38px;padding:10px 15px;font-size:14px}
.sw-nav{order:5;flex:1 1 100%;flex-wrap:nowrap;gap:22px;overflow-x:auto;scrollbar-width:none;margin:0 -18px;padding:0 18px 2px;font-size:14.5px}
.sw-nav::-webkit-scrollbar{display:none}
.sw-nav a{flex:none;padding:9px 0;white-space:nowrap}
.sw-footer nav{gap:4px 18px}
.sw-footer nav a{padding:6px 0}}
@media (min-width:361px) and (max-width:760px){.sw-header .sw-wrap:not(:has(>.sw-button)):not(:has(.sw-nav>a:nth-child(4))) .sw-nav{order:2;flex:0 1 auto;min-width:0;margin:0;padding:0}}
`;

function designRules(active: ActiveDesign, fonts?: FontLookup): string {
  return `${ARCHIVE_CSS}${BEACON_CSS}${DESIGN_SHELL_CSS}${codeTokenCss('dark', 'html[data-scheme=t-dark] .sw-prose ')}
@media (prefers-color-scheme:dark){${codeTokenCss('dark', 'html[data-scheme=t-auto] .sw-prose ')}}
${designCss(active.theme, active.design, undefined, fonts)}`;
}

function baseCss(channel: SiteChannel, design = false): string {
  const accent = accentOf(channel);
  const darkLink = `--link:${linkColor(accent, DARK_SURFACE)}`;
  return `${design ? 'html' : ':root'}{--accent:${accent};--on-accent:${textOn(accent)};--link:${linkColor(accent, LIGHT_SURFACE)};${LIGHT};--font:${SYSTEM};--mono:${MONO};--r-card:18px;--r-control:12px;color-scheme:light}
html.sw-font-geist{--font:'Geist',${SYSTEM}}
html.sw-font-inter{--font:'Inter',${SYSTEM}}
html[data-scheme=dark]{${DARK};${darkLink};color-scheme:dark}
@media (prefers-color-scheme:dark){html[data-scheme=auto]{${DARK};${darkLink};color-scheme:dark}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--page);color:var(--text);font:400 17px/1.6 var(--font);font-variant-numeric:tabular-nums}
a{color:var(--link);text-underline-offset:.15em}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:2px solid var(--link);outline-offset:3px}
::selection{background:var(--accent);color:var(--on-accent)}
img{max-width:100%;height:auto}
h1,h2,h3,h4,h5,h6{color:var(--ink);line-height:1.2;letter-spacing:-0.02em;margin:1.6em 0 .5em;text-wrap:balance;overflow-wrap:break-word}
.sw-wrap{width:100%;max-width:1120px;margin:0 auto;padding:0 22px}
.sw-narrow{max-width:764px}
.sw-skip{position:absolute;left:-10000px;top:8px;background:var(--surface);color:var(--ink);border:1px solid var(--line-strong);padding:8px 14px;border-radius:999px;z-index:30}
.sw-skip:focus{left:16px}
.sw-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.sw-hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
.sw-header{border-bottom:1px solid var(--line);background:var(--surface)}
.sw-header .sw-wrap{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;min-height:68px;padding-top:10px;padding-bottom:10px}
.sw-brand{display:flex;align-items:center;gap:10px;color:var(--ink);font-weight:700;font-size:19px;letter-spacing:-0.02em;line-height:1.2;text-decoration:none;margin-right:auto;min-width:0}
.sw-brand span{overflow-wrap:anywhere}
.sw-brand img{width:36px;height:36px;border-radius:10px;object-fit:cover;flex:none}
.sw-nav{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:15px}
.sw-nav a{color:var(--text-sub);text-decoration:none;padding:8px 0}
.sw-nav a:hover,.sw-nav a[aria-current=page]{color:var(--ink)}
.sw-search{display:flex;gap:6px}
.sw-search input{width:160px}
input[type=email],input[type=text],input[type=search]{font:inherit;font-size:15px;color:var(--ink);background:var(--surface-alt);border:1px solid var(--line-strong);border-radius:var(--r-control);padding:9px 12px;min-height:42px;max-width:100%}
::placeholder{color:var(--text-sub);opacity:.85}
.sw-button,button{display:inline-flex;align-items:center;justify-content:center;font:600 15px/1 var(--font);color:var(--on-accent);background:var(--accent);border:0;border-radius:999px;padding:12px 20px;min-height:42px;cursor:pointer;text-decoration:none;text-align:center;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--on-accent) 14%,transparent);transition:transform .15s,filter .15s}
.sw-button:hover,button:hover{filter:brightness(.92);transform:translateY(-1px)}
.sw-ghost{background:transparent;color:var(--ink);border:1px solid var(--line-strong);box-shadow:none}
.sw-ghost:hover{background:var(--surface-alt);filter:none}
.sw-main{flex:1 0 auto;padding:40px 0 64px}
.sw-pagehead{margin:8px 0 28px}
.sw-pagehead h1{font-size:clamp(30px,4vw,44px);margin:0 0 8px}
.sw-pagehead p{color:var(--text-sub);margin:0;max-width:60ch}
.sw-home-head{margin:8px 0 32px;max-width:720px}
.sw-home-head h1{font-size:clamp(32px,4.5vw,48px);letter-spacing:-0.03em;margin:0 0 10px}
.sw-home-head p{font-size:19px;line-height:1.5;color:var(--text-sub);margin:0}
.sw-empty{margin:24px 0 8px;padding:48px 24px;text-align:center;border:1px dashed var(--line-strong);border-radius:var(--r-card)}
.sw-empty h2{font-size:24px;margin:0 0 8px}
.sw-empty p{color:var(--text-sub);margin:0 auto 18px;max-width:44ch}
.sw-empty p:last-child{margin-bottom:0}
.sw-muted{color:var(--text-sub);font-size:14px}
.sw-badge{display:inline-block;font-size:12px;font-weight:600;line-height:1;padding:5px 9px;border-radius:999px;background:var(--mark);color:var(--ink);vertical-align:middle}
.sw-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px;list-style:none;margin:0;padding:0}
.sw-card{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-card);overflow:hidden;height:100%}
.sw-card img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:var(--surface-alt)}
.sw-card-body{padding:18px 20px 20px;display:flex;flex-direction:column;gap:8px}
.sw-card h2,.sw-card h3{font-size:20px;margin:0}
.sw-card h2 a,.sw-card h3 a,.sw-list h2 a,.sw-list h3 a{color:var(--ink);text-decoration:none}
.sw-card h2 a:hover,.sw-card h3 a:hover,.sw-list h2 a:hover,.sw-list h3 a:hover{color:var(--link)}
.sw-card p{margin:0;color:var(--text-sub);font-size:15.5px}
.sw-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;color:var(--text-sub);font-size:13.5px}
.sw-hero{margin-bottom:28px}
.sw-hero .sw-card{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr)}
.sw-hero .sw-card img{height:100%;aspect-ratio:auto;min-height:260px}
.sw-hero .sw-card-body{justify-content:center;padding:28px}
.sw-hero h2{font-size:clamp(26px,3.4vw,38px)}
.sw-pinned{margin-bottom:28px}
.sw-section-title{font-size:13px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--text-sub);margin:36px 0 14px}
.sw-list{list-style:none;margin:0;padding:0}
.sw-list>li{padding:18px 0;border-bottom:1px solid var(--line)}
.sw-list h2,.sw-list h3{font-size:20px;margin:0 0 4px}
.sw-list p{margin:0 0 6px;color:var(--text-sub);font-size:15.5px}
.sw-list h2,.sw-list h3,.sw-list p{max-width:72ch}
.sw-paper{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:32px}
.sw-paper-lead h2{font-size:clamp(28px,3.6vw,42px);margin:12px 0 8px}
.sw-paper-lead h2 a{color:var(--ink);text-decoration:none}
.sw-paper-lead img{display:block;width:100%;border-radius:var(--r-card);aspect-ratio:16/9;object-fit:cover;background:var(--surface-alt)}
.sw-paper-lead>p:not(.sw-meta){font-size:18px;margin:0 0 10px}
.sw-paper-side .sw-list p:not(.sw-meta){display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sw-paper-side{border-left:1px solid var(--line);padding-left:24px}
.sw-paper-side .sw-list>li:first-child{padding-top:0}
.sw-pager{display:flex;justify-content:space-between;gap:12px;margin-top:28px}
.sw-tabs{display:flex;gap:8px;margin:0 0 20px}
.sw-tabs a{padding:7px 14px;border-radius:999px;border:1px solid var(--line-strong);color:var(--text);text-decoration:none;font-size:14px}
.sw-tabs a[aria-current=page]{background:var(--ink);color:var(--page);border-color:var(--ink)}
.sw-article{max-width:720px;margin:0 auto}
.sw-cover{margin:0 0 24px}
.sw-cover img{display:block;width:100%;height:auto;max-height:min(80vh,720px);object-fit:cover;border-radius:12px}
.sw-article-head{margin:0 0 28px}
.sw-article-head h1{font-size:clamp(32px,5vw,48px);line-height:1.1;letter-spacing:-0.03em;margin:0 0 12px}
.sw-article-head>:last-child{margin-bottom:0}
.sw-subtitle{font-size:20px;color:var(--text-sub);margin:0 0 16px;line-height:1.45}
.sw-byline{margin:0 0 6px;font-size:15px;color:var(--text-sub)}
.sw-byline a{color:var(--ink);font-weight:600}
.sw-author{display:flex;gap:20px;align-items:flex-start;margin:8px 0 28px}
.sw-author img{width:96px;height:96px;border-radius:50%;object-fit:cover;flex:none}
.sw-author h1{font-size:clamp(28px,4vw,40px);margin:0 0 8px}
.sw-author p{color:var(--text-sub);margin:0;white-space:pre-line}
.sw-prose{font-size:18px;line-height:1.7;overflow-wrap:break-word}
.sw-prose p,.sw-prose ul,.sw-prose ol,.sw-prose blockquote,.sw-prose pre,.sw-prose figure{margin:0 0 1.2em}
.sw-prose>:first-child{margin-top:0}
.sw-prose p{text-wrap:pretty}
.sw-prose h2{font-size:1.45em;margin:1.8em 0 .5em}
.sw-prose h3{font-size:1.2em;margin:1.6em 0 .45em}
.sw-prose h4{font-size:1.05em;margin:1.5em 0 .4em}
.sw-prose ul,.sw-prose ol{padding-left:1.3em}
.sw-prose li{margin:.35em 0}
.sw-prose li>p{margin:0}
.sw-prose blockquote{margin-left:0;margin-right:0;border-left:3px solid var(--accent);padding:2px 0 2px 20px;font-size:1.06em;font-style:italic;color:var(--text)}
.sw-prose blockquote>:last-child{margin-bottom:0}
.sw-prose:has(+.sw-gate)>:last-child{-webkit-mask-image:linear-gradient(#000 10%,transparent);mask-image:linear-gradient(#000 10%,transparent)}
.sw-callout{margin:0 0 1.2em;padding:16px 18px;background:var(--surface-alt);border-left:3px solid var(--accent);border-radius:6px}
.sw-callout>:last-child{margin-bottom:0}
.sw-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;margin:0 0 1.2em}
.sw-footnotes{margin:2em 0;padding:1em 0 0 1.4em;border-top:1px solid var(--line);font-size:15px;color:var(--text-sub)}
.sw-figure.sw-w-25{width:25%}.sw-figure.sw-w-50{width:50%}.sw-figure.sw-w-75{width:75%}
@media (max-width:560px){.sw-columns{grid-template-columns:1fr}.sw-figure.sw-w-25,.sw-figure.sw-w-50,.sw-figure.sw-w-75{width:100%}}
.sw-prose pre{background:var(--surface-alt);border:1px solid var(--line);border-radius:12px;padding:14px;overflow:auto;font:14px/1.6 var(--mono)}
.sw-prose code{font-family:var(--mono);font-size:.9em}
.sw-prose hr{border:0;border-top:1px solid var(--line);margin:2em 0}
.sw-figure{margin:1.6em 0}
.sw-figure img{display:block;border-radius:12px;margin:0 auto}
.sw-figure figcaption{font-size:14px;color:var(--text-sub);margin-top:8px;text-align:center}
.sw-button-row{text-align:center;margin:1.6em 0!important}
.sw-link-card,.sw-attachment{display:flex;flex-direction:column;gap:4px;margin:0 0 1em;border:1px solid var(--line);border-radius:14px;padding:14px 16px;text-decoration:none;color:var(--ink);background:var(--surface)}
.sw-link-card-text,.sw-link-card-host,.sw-attachment-kind{color:var(--text-sub);font-size:14px}
.sw-link-card-title,.sw-attachment-name{font-weight:600}
.sw-embed{width:100%;border:1px solid var(--line);border-radius:12px}
body.sw-dropcaps .sw-prose>p:first-of-type::first-letter{float:left;font-size:3.6em;line-height:.9;font-weight:700;padding:.06em .1em 0 0;color:var(--ink)}
.sw-gate{margin:32px 0;padding:28px;border:1px solid var(--line);border-radius:var(--r-card);background:var(--surface);text-align:center}
.sw-gate h2{margin:0 0 8px;font-size:24px}
.sw-gate p{color:var(--text-sub);max-width:46ch;margin-left:auto;margin-right:auto}
.sw-gate .sw-subscribe{margin:18px auto 0;padding:0;border:0;background:none;max-width:460px;text-align:left}
.sw-gate>:last-child{margin-bottom:0}
.sw-share{display:flex;flex-wrap:wrap;gap:8px 16px;margin:28px 0;font-size:14.5px}
.sw-share span{color:var(--text-sub)}
.sw-series{font-size:14px;color:var(--text-sub);margin:8px 0 0}
.sw-series-next a{display:block;border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:32px 0;text-decoration:none;color:var(--ink);background:var(--surface)}
.sw-series-next a span{display:block;font-size:13px;color:var(--text-sub)}
.sw-series-end{font-size:14px;color:var(--text-sub);margin:32px 0}
.sw-champions{padding-left:24px}.sw-champions li{margin:8px 0}.sw-champions span{color:var(--text-sub)}
.sw-prevnext{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:32px 0}
.sw-prevnext a{display:block;border:1px solid var(--line);border-radius:14px;padding:14px 16px;text-decoration:none;color:var(--ink);background:var(--surface)}
.sw-prevnext a span{display:block;font-size:13px;color:var(--text-sub)}
.sw-prevnext .sw-next{text-align:right;grid-column:2}
.sw-subscribe{margin:40px 0;padding:28px;border-radius:var(--r-card);background:var(--surface);border:1px solid var(--line);scroll-margin-top:24px}
.sw-subscribe:target{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}
.sw-subscribe h2{margin:0 0 6px;font-size:24px}
.sw-subscribe p{margin:0 0 14px;color:var(--text-sub);max-width:60ch}
.sw-subscribe form{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.sw-subscribe label{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:600;color:var(--ink);flex:1 1 220px}
.sw-subscribe label.sw-consent{flex-direction:row;align-items:flex-start;font-weight:400;flex-basis:100%;gap:8px}
select,textarea{font:inherit;font-size:15px;color:var(--ink);background:var(--surface-alt);border:1px solid var(--line-strong);border-radius:var(--r-control);padding:9px 12px;min-height:42px}
.sw-gate-benefits,.sw-plan-benefits{text-align:left;margin:0 auto 16px;padding-left:20px;max-width:420px}
.sw-gate-coupon{background:var(--mark);color:var(--ink)!important;border-radius:12px;padding:10px 14px;display:inline-block}
.sw-gate-meter{font-weight:600}
.sw-notice{background:var(--surface-alt);border:1px solid var(--line);border-radius:12px;padding:12px 16px;font-size:15px}
.sw-gift{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:24px 0}
.sw-plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px;list-style:none;margin:0 0 32px;padding:0}
.sw-plan{display:flex;flex-direction:column;gap:10px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-card);padding:24px}
.sw-plan h2{margin:0;font-size:22px}
.sw-plan .sw-badge{align-self:flex-start}
.sw-plan-founding{border:2px solid var(--accent)}
.sw-plan-price{font-size:20px;font-weight:700;color:var(--ink);margin:0}
.sw-plan-benefits{margin:0;max-width:none}
.sw-plan .sw-subscribe{margin:auto 0 0;padding:0;border:0;background:none}
.sw-plan .sw-subscribe form{flex-direction:column;align-items:stretch}
.sw-plan .sw-subscribe label{flex:none}
.sw-plan-form,.sw-plans-extra form{display:flex;flex-direction:column;gap:10px;margin-top:auto}
.sw-plan-form label,.sw-plans-extra label{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:600;color:var(--ink)}
.sw-plans-extra{margin:32px 0;padding:24px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-card);max-width:560px}
.sw-plans-extra h2{margin:0 0 6px}
.sw-billing{margin:24px 0}
.sw-main .sw-search{max-width:560px;margin:0 0 20px}
.sw-main .sw-search input{flex:1;width:auto;min-width:0}
.sw-results mark{background:var(--mark);color:var(--ink);border-radius:3px;padding:0 2px}
.sw-footer{flex:none;border-top:1px solid var(--line);padding:28px 0 40px;font-size:14px;color:var(--text-sub)}
.sw-footer nav a{padding:4px 0}
.sw-footer p{margin:0}
.sw-footer nav{display:flex;flex-wrap:wrap;gap:8px 18px;margin-bottom:10px}
.sw-footer a{color:var(--text-sub)}
.sw-sitemap ul{columns:2 280px;padding-left:18px}
.sw-poll{margin:24px 0;padding:18px 20px;border:1px solid var(--line);border-radius:var(--r-card);background:var(--surface)}
.sw-poll-title{margin:0 0 4px;font-size:13px;font-weight:600;color:var(--text-sub)}
.sw-poll-text{margin:0 0 8px;color:var(--text-sub);font-size:15px}
.sw-poll-prompt{margin:0 0 12px;font-weight:600;color:var(--ink)}
.sw-poll-options{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.sw-poll-options a{display:block;text-align:left}
.sw-prompt{margin:32px 0;padding:24px;border:1px solid var(--line);border-radius:var(--r-card);background:var(--surface)}
.sw-prompt[hidden]{display:none}
.sw-prompt h2{margin:0 0 6px;font-size:22px}
.sw-prompt p{margin:0 0 12px;color:var(--text-sub)}
.sw-prompt form{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.sw-prompt label{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:600;color:var(--ink);flex:1 1 220px}
.sw-prompt label.sw-consent{flex-direction:row;align-items:flex-start;font-weight:400;flex-basis:100%}
.sw-prompt .sw-prompt-dismiss{margin-top:10px}
.sw-prompt .sw-prompt-dismiss button{background:none;border:0;color:var(--text-sub);text-decoration:underline;padding:0;font:inherit;font-size:14px;cursor:pointer}
.sw-toc{margin:0 0 1.6em;padding:16px 20px;border:1px solid var(--line);border-radius:14px;background:var(--surface);font-size:16px}
.sw-toc-title{margin:0 0 6px!important;font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--text-sub)}
.sw-toc ol{margin:0;padding-left:20px}
.sw-toc li{margin:4px 0}
.sw-toc .sw-toc-l3{margin-left:16px}
.sw-prose h2[id],.sw-prose h3[id],.sw-prose h4[id]{scroll-margin-top:16px}
${codeTokenCss('light', '.sw-prose ')}.sw-prose .sw-tk-com{font-style:italic}
${codeTokenCss('dark', 'html[data-scheme=dark] .sw-prose ')}
@media (prefers-color-scheme:dark){${codeTokenCss('dark', 'html[data-scheme=auto] .sw-prose ')}}
.sw-prompt-float{position:fixed;right:16px;bottom:16px;left:16px;margin:0;max-width:420px;margin-left:auto;z-index:20;box-shadow:0 12px 40px rgba(15,15,18,.18)}
.sw-landing .sw-main{padding-top:max(40px,7vh)}
.sw-landing .sw-pagehead h1{font-size:clamp(34px,5.6vw,54px);line-height:1.05;letter-spacing:-0.035em;margin-bottom:0}
.sw-landing .sw-prose{font-size:19px}
.sw-landing .sw-subscribe{margin:32px 0 0}
@media (max-width:760px){.sw-wrap{padding:0 18px}.sw-header .sw-wrap{gap:8px 12px;min-height:56px;padding-top:8px;padding-bottom:8px}.sw-brand{font-size:17px;padding:4px 0}.sw-brand img{width:32px;height:32px}.sw-header .sw-button{min-height:38px;padding:9px 16px}.sw-header .sw-search{display:none}.sw-nav{order:5;flex:1 1 100%;flex-wrap:nowrap;gap:0 20px;margin:0 -18px -8px;padding:0 18px;overflow-x:auto;white-space:nowrap;scrollbar-width:none;-webkit-overflow-scrolling:touch;border-top:1px solid var(--line)}.sw-nav::-webkit-scrollbar{display:none}.sw-nav a{padding:11px 0}.sw-main{padding:28px 0 48px}.sw-hero .sw-card,.sw-paper{grid-template-columns:1fr}.sw-hero .sw-card img{min-height:0;aspect-ratio:16/9}.sw-hero .sw-card-body{padding:20px}.sw-paper-side{border-left:0;padding-left:0}.sw-prevnext{grid-template-columns:1fr}.sw-prevnext .sw-next{grid-column:auto}.sw-subscribe,.sw-gate,.sw-prompt,.sw-plans-extra{padding:22px 18px}.sw-subscribe button,.sw-prompt form button{flex:1 1 100%}.sw-author{flex-direction:column}.sw-prose{font-size:17.5px}.sw-subtitle{font-size:18px}.sw-empty{padding:36px 18px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important;scroll-behavior:auto!important}.sw-button:hover,button:hover{transform:none}}
@media (forced-colors:active){.sw-button,button{border:1px solid ButtonText}}
@media print{.sw-nav,.sw-search,.sw-header .sw-button,.sw-subscribe,.sw-footer nav,.sw-share,.sw-prevnext,.sw-prompt,.sw-skip,.sw-gate{display:none!important}body{background:#fff;color:#000}.sw-prose a{color:inherit}}
`;
}
