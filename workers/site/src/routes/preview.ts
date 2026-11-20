// GET /_swarm/preview?token=… : the home page drawn from the Channel's draft design, for the
// dashboard's preview pane (docs/site-themes.md). The API mints the token (purpose site-preview,
// 30 minutes, the Channel and who the page is for). The page is never cached or indexed, sets no
// cookie, runs no script and submits no form; its whole stylesheet is inline, so the published
// design's rules stay out of it. Only the dashboard may frame it.
import { first } from '@swarm/db';
import { SiteDesignSchema } from '@swarm/domain';
import { runningTests } from '@swarm/site-themes';
import { linksFor, verifySitePreview } from '@swarm/engine';
import { Hono } from 'hono';
import type { SiteBindings, SiteContext } from '../context';
import type { SiteEnv } from '../env';
import {
  activate,
  defaultDesign,
  designFonts,
  designHome,
  type ActiveDesign,
  type DesignReader,
} from '../render/design';
import { h } from '../render/html';
import { loadChrome, renderPage } from '../render/layout';
import { siteCss } from '../render/theme';

export const preview = new Hono<SiteBindings>();

export const PREVIEW_PATH = '/_swarm/preview';

const READERS: Record<'visitor' | 'subscriber' | 'paid', DesignReader> = {
  visitor: { is_subscriber: false, is_paid: false },
  subscriber: { is_subscriber: true, is_paid: false },
  paid: { is_subscriber: true, is_paid: true },
};

const LABELS = { visitor: 'a visitor', subscriber: 'a subscriber', paid: 'a paid subscriber' };

const BAR_CSS = `.sw-preview-bar{position:fixed;left:0;right:0;bottom:0;z-index:50;display:flex;justify-content:center;gap:8px;padding:8px 16px;font:600 13px/1.4 -apple-system,'Segoe UI',system-ui,sans-serif;background:#0f0f12;color:#fff;text-align:center}
.sw-preview-bar span{font-weight:400;opacity:.8}
body{padding-bottom:40px}
`;

/** What the page needs and nothing more: its inline style, the site's fonts and images. */
function previewCsp(env: Pick<SiteEnv, 'MEDIA_ORIGIN' | 'APP_ORIGIN'>, nonce: string) {
  return [
    "default-src 'none'",
    "script-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `img-src 'self' ${new URL(env.MEDIA_ORIGIN).origin} https: data:`,
    "font-src 'self'",
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    `frame-ancestors ${new URL(env.APP_ORIGIN).origin}`,
  ].join('; ');
}

/**
 * The variants a preview shows: `?variant=b` draws B of every running A/B test in the draft, and
 * with `&section=<id>` only that section's. Anything else draws A.
 */
function previewVariants(
  draft: ActiveDesign,
  variant: string | undefined,
  section: string | undefined,
): Record<string, 'a' | 'b'> {
  if (variant !== 'b') return {};
  const out: Record<string, 'a' | 'b'> = {};
  for (const s of runningTests(draft.theme, draft.design)) {
    if (!section || s.id === section) out[s.id] = 'b';
  }
  return out;
}

function refused(c: SiteContext): Response {
  return c.html(
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Preview expired</title><p>This preview address is not valid or has expired. Open the preview again from the dashboard.</p></html>',
    403,
    { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  );
}

const headers = (c: SiteContext) => ({
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
  'content-security-policy': previewCsp(c.get('env'), c.get('nonce')),
  'content-type': 'text/html; charset=utf-8',
});

preview.get(PREVIEW_PATH, async (c) => {
  const env = c.get('env');
  const channel = c.get('channel');
  const token = c.req.query('token') ?? '';
  const claims = token ? await verifySitePreview(linksFor(env), token) : null;
  if (!claims || claims.channelId !== channel.id) return refused(c);
  const chrome = await loadChrome(c);
  if (!chrome.flags.site_templates) return refused(c);

  const row = await first<{ draft_json: string }>(
    env.DB,
    'SELECT draft_json FROM site_designs WHERE channel_id = ?1',
    channel.id,
  );
  const parsed = row ? SiteDesignSchema.safeParse(JSON.parse(row.draft_json)) : null;
  const draft = activate(parsed?.success ? parsed.data : defaultDesign(channel), 'draft');
  const nonce = c.get('nonce');
  const variants = draft
    ? previewVariants(draft, c.req.query('variant'), c.req.query('section'))
    : {};
  const withB = Object.keys(variants).length > 0 ? ', with variant B' : '';
  const bar = `<div class="sw-preview-bar" role="status">Preview <span>of the draft, as ${LABELS[claims.as]}${withB}</span></div>`;
  if (!draft) {
    return c.html(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex"><title>Preview</title><style nonce="${h(nonce)}">body{font:16px/1.5 system-ui,sans-serif;margin:40px}</style><p>The draft’s theme has errors, so it can’t be drawn yet. Fix the problems the editor lists, then preview again.</p></html>`,
      200,
      headers(c),
    );
  }
  // The draft in place of the published design; no Smart Prompts and no owner code in a preview.
  const previewChrome = { ...chrome, design: draft, prompts: [], code: null };
  // The draft's uploaded fonts, looked up while the page is drawn.
  const fonts = designFonts(c, draft);
  let body: string;
  let css = '';
  try {
    // Never counted: no beacons and no section in the forms (counted is false).
    const home = await designHome(c, previewChrome, draft, READERS[claims.as], { variants });
    body = home.html;
    css = home.css;
  } catch (error) {
    body = `<div class="sw-wrap"><p class="sw-muted">The draft can’t be drawn: ${h((error as Error).message)}</p></div>`;
  }
  const html = renderPage(c, previewChrome, {
    meta: {
      title: channel.name,
      description: channel.description ?? `Posts from ${channel.name}.`,
      path: '/',
      noindex: true,
    },
    body,
    subscribe: false,
    wrap: false,
    noOwnerCode: true,
    stylesheet: `${siteCss(channel, true, draft, await fonts)}${BAR_CSS}`,
    banner: bar,
    css,
  });
  return c.html(html, 200, headers(c));
});
