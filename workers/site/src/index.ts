// Channel websites (Phase 4): server-rendered sites on <slug>.<PLATFORM_SITE_DOMAIN> and verified
// custom hostnames, plus public media on the media host and on each Channel's own site.
//
// Order of work for a site request:
//   1. headers: the shared runtime's security headers, then the site's (edge/headers.ts)
//   2. tenant: resolve the Channel from Host; unknown hosts get a 404, apex domains a redirect
//   3. edge: redirects, Bot Rules, reader session and entitlement, verified crawlers, the edge
//      HTML cache and analytics (middleware/edge.ts)
//   4. routes: /_swarm/* system routes (reader sign-in, checkout, portal, gifts), the plans page,
//      then feeds, growth pages (/r/<code>, /champions, /series/<slug>), Link Hub (/links and
//      /_swarm/hub/<id>), then pages (Dispatch slugs never reach /_swarm)
import { useRuntime } from '@swarm/runtime';
import { Hono } from 'hono';
import { first } from '@swarm/db';
import type { SiteBindings } from './context';
import { keepRouteHeaders, siteHeaders } from './edge/headers';
import { cardBackground, parseVariant, serveMedia } from './edge/images';
import { parseSiteEnv, type SiteEnv } from './env';
import { createEdge, type EdgeDeps } from './middleware/edge';
import { askPages } from './routes/ask';
import { checkoutRoutes, type PaymentDeps } from './routes/checkout';
import { feeds } from './routes/feeds';
import { joinRoutes } from './routes/join';
import { partners } from './routes/partners';
import { goods } from './routes/goods';
import { gifts } from './routes/gifts';
import { growth } from './routes/growth';
import { hub } from './routes/hub';
import { plans } from './routes/plans';
import { preview } from './routes/preview';
import { reach } from './routes/reach';
import { notFoundPage, pages } from './routes/pages';
import { reader } from './routes/reader';
import { system } from './routes/system';
import { resolveHost } from './tenant';

const MEDIA_KEY =
  /^ws\/(ws_[0-9a-f]{32})\/ch\/(ch_[0-9a-f]{32})\/md_[0-9a-f]{32}\.(png|jpg|gif|webp|avif|pdf|woff2|woff)$/;

/**
 * Whether `url`'s host may serve an object of Channel `channelId`: the install's media host serves
 * every public object; a Channel's own site (its platform subdomain or custom domain) serves only
 * that Channel's, so one publication's name is never lent to another tenant's file.
 */
async function mediaHostServes(env: SiteEnv, url: URL, channelId: string): Promise<boolean> {
  if (url.hostname === new URL(env.MEDIA_ORIGIN).hostname) return true;
  const resolution = await resolveHost(env, url.host);
  return resolution.kind === 'channel' && resolution.channel.id === channelId;
}

/**
 * Whether a PDF may be served publicly. A file attached to a Good (or one marked private) is only
 * ever downloaded through the order-checked library route (routes/goods.ts), so its public URL
 * answers 404 whoever learns the key, including after a refund. Copies fetched or cached before
 * are outside reach.
 */
async function pdfIsPublic(env: SiteEnv, key: string): Promise<boolean> {
  const row = await first<{ visibility: string; sold: number }>(
    env.DB,
    `SELECT m.visibility, EXISTS (SELECT 1 FROM good_files f WHERE f.media_id = m.id) AS sold
       FROM media m WHERE m.r2_key = ?1 AND m.deleted_at IS NULL`,
    key,
  );
  return row?.visibility === 'public' && row.sold === 0;
}

/** The card colour for the Channel that owns an object: its accent now, else white. */
async function channelCardBackground(env: SiteEnv, channelId: string): Promise<string> {
  const row = await first<{ branding_json: string }>(
    env.DB,
    'SELECT branding_json FROM channels WHERE id = ?1',
    channelId,
  );
  let accent: unknown = null;
  try {
    accent = row ? (JSON.parse(row.branding_json) as { accentColor?: unknown }).accentColor : null;
  } catch {
    accent = null;
  }
  return cardBackground(accent);
}

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/=+$/, '');
}

/**
 * The site app with everything up to and including the edge middleware; `mount` adds the routes.
 * Tests build their own with stub routes and fake edge dependencies.
 */
export function createSite(
  mount: (site: Hono<SiteBindings>) => void,
  deps: EdgeDeps = {},
): Hono<SiteBindings> {
  const site = new Hono<SiteBindings>();
  // Registered before the runtime so it runs after the runtime's headers on the way out.
  site.use('*', siteHeaders);
  useRuntime(site, { service: 'site', parseEnv: parseSiteEnv, securityTxt: true });
  site.use('*', keepRouteHeaders);

  /**
   * Public media, on the media host and on the owning Channel's own site. Only objects uploaded
   * through the API (sniffed type, public visibility) are served, never a file sold as a Good, and
   * they can never run script. ?w=, ?og= and ?icon= ask for a variant made with the Images
   * binding (edge/images.ts). Uploaded fonts (WOFF2, WOFF) are served here too, for designs that
   * use them (docs/site-themes.md, "Uploaded fonts").
   */
  site.get('/media/*', async (c) => {
    const key = c.req.path.slice('/media/'.length);
    const match = MEDIA_KEY.exec(key);
    if (!match) return c.notFound();
    const channelId = match[2] ?? '';
    const url = new URL(c.req.url);
    let variant = parseVariant(url.searchParams);
    if (variant === 'invalid') return c.notFound();
    const env = parseSiteEnv(c.env);
    if (!(await mediaHostServes(env, url, channelId))) return c.notFound();
    if (match[3] === 'pdf' && !(await pdfIsPublic(env, key))) return c.notFound();
    if (variant?.kind === 'card') {
      variant = { kind: 'card', background: await channelCardBackground(env, channelId) };
    }
    const response = await serveMedia({
      bucket: env.MEDIA,
      images: env.IMAGES,
      key,
      variant,
      accept: c.req.header('accept') ?? '',
      origin: new URL(env.MEDIA_ORIGIN).origin,
      waitUntil: (work) => {
        try {
          c.executionCtx.waitUntil(work);
        } catch {
          // No execution context (unit tests): the promise still runs.
        }
      },
    });
    return response ?? c.notFound();
  });

  site.use('*', async (c, next) => {
    const env = parseSiteEnv(c.env);
    c.set('env', env);
    c.set('nonce', nonce());
    // Defaults for every request, including unknown hosts; the edge middleware refines them.
    c.set('reader', { class: 'anonymous', memberId: null, levelId: null });
    c.set('crawlerFullAccess', false);
    c.set('variants', {});
    const url = new URL(c.req.url);
    const resolution = await resolveHost(env, url.host);
    if (resolution.kind === 'redirect') {
      return c.redirect(`${resolution.location}${url.pathname}${url.search}`, 301);
    }
    if (resolution.kind === 'unknown') {
      return c.html(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Not found</title><p>There is no site at this address.</p></html>',
        404,
        { 'cache-control': 'public, max-age=60' },
      );
    }
    c.set('channel', resolution.channel);
    await next();
  });

  site.use('*', createEdge(deps));
  mount(site);
  return site;
}

/** Every route of the site. Tests pass payment deps (a shared DevStripe, a fake processor). */
export function mountSite(site: Hono<SiteBindings>, payments: PaymentDeps = {}): void {
  site.route('/_swarm/reader', reader);
  site.route('/', system);
  site.route('/', preview);
  site.route('/', reach);
  site.route('/', joinRoutes);
  site.route('/', askPages);
  site.route('/', checkoutRoutes(payments));
  site.route('/', gifts);
  site.route('/', plans);
  site.route('/', goods);
  site.route('/', partners);
  site.route('/', feeds);
  site.route('/', growth);
  site.route('/', hub);
  site.route('/', pages);
  site.notFound((c) => notFoundPage(c));
}

export const app = createSite((site) => mountSite(site));

export default app;
