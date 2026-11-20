// Small server-rendered pages for reader sign-in. They carry the Channel's name and accent, run
// no script, and are never cached or indexed.
import { readableColor, textOn } from '@swarm/domain';
import { escapeHtml } from '@swarm/mail';
import type { SiteChannel, SiteContext } from '../context';

const STYLE = `:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;background:#fbfbfd;color:#0f0f12}
main{max-width:440px;margin:10vh auto;padding:32px;background:#fff;border:1px solid #efedf6;border-radius:18px}
.channel{font-size:13px;font-weight:600;color:#6b6b76;margin:0 0 12px}
.channel a{color:inherit;text-decoration:none}
h1{font-size:22px;line-height:1.25;letter-spacing:-0.02em;margin:0 0 12px;text-wrap:balance}
p{font-size:15px;line-height:1.55;color:#3a3a44;margin:0 0 16px}
label{display:block;font-size:14px;font-weight:500;margin:0 0 16px}
input[type=email],input[type=text],textarea,select{display:block;width:100%;margin-top:6px;font:inherit;font-weight:400;padding:10px 12px;border:1px solid #e7e5ee;border-radius:10px;background:transparent;color:inherit}
button{font:inherit;font-weight:600;color:var(--on-accent);background:var(--accent);border:0;border-radius:999px;padding:12px 22px;min-height:44px;cursor:pointer}
button:focus-visible,input:focus-visible,a:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--link);outline-offset:2px}
.small{font-size:13px;color:#6b6b76}
a{color:var(--link)}
[role=alert]{padding:10px 14px;border-radius:10px;background:#ffe9e2;color:#b5401f}
@media (prefers-color-scheme:dark){body{background:#0f0f12;color:#f4f3f8}main{background:#17171c;border-color:#2a2a33}p{color:#c9c8d3}input[type],textarea,select{border-color:#3a3a46}.channel,.small{color:#a2a2ad}[role=alert]{background:#3a1a12;color:#ffb39e}}
@media (max-width:520px){main{margin:16px;padding:24px 20px}}`;

export const h = escapeHtml;

const accentOf = (channel: SiteChannel) => {
  const accent = channel.branding.accentColor;
  return accent && /^#[0-9a-f]{6}$/i.test(accent) ? accent.toLowerCase() : '#6c4cf1';
};

/** The accent for buttons as chosen, and for links moved just far enough to read on each card. */
function accentVars(channel: SiteChannel): string {
  const accent = accentOf(channel);
  return `:root{--accent:${accent};--on-accent:${textOn(accent)};--link:${readableColor(accent, '#ffffff', 4.6)}}@media (prefers-color-scheme:dark){:root{--link:${readableColor(accent, '#17171c', 4.6)}}}`;
}

/** Headers for every reader page: no caching, no indexing, no script, no framing. */
const READER_PAGE_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

export function readerPage(
  c: SiteContext,
  title: string,
  body: string,
  status: 200 | 400 | 402 | 403 | 404 | 409 | 410 | 429 | 502 | 503 = 200,
  options: { head?: string } = {},
): Response {
  const channel = c.get('channel');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${options.head ?? ''}<title>${h(title)} · ${h(channel.name)}</title>
<style>${STYLE}${accentVars(channel)}</style></head>
<body><main><p class="channel"><a href="/">${h(channel.name)}</a></p>${body}</main></body></html>`;
  for (const [name, value] of Object.entries(READER_PAGE_HEADERS)) c.header(name, value);
  return c.html(html, status);
}
