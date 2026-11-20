// First-party, cookieless page-view analytics.
//
// One page view = a successful HTML GET of a site page by something that isn't a bot or a
// prefetch. It is written, after the response, to:
// - Analytics Engine (ANALYTICS, when bound): one data point with index channel id and blobs
//   path, source, device, country, reader class; doubles [views = 1, new visitor 0 or 1];
// - the D1 rollups: site_page_views_daily (+1 view, and +1 visitor when this is the visitor's
//   first view of the day on this Channel) and site_visitors (the day's visitor hashes);
// - for a new visitor of the day, +1 visit in funnel_daily (Funnel Explorer) with the view's
//   source and UTM tags (@swarm/engine funnel.ts).
//
// Visitors: visitor_hash = first 32 hex of sha256(daily salt, IP, User-Agent, Channel id). The salt
// is random per UTC day, lives only in KV (2-day TTL) and is never stored with the hashes, which
// the jobs worker deletes after a day (pruneSiteEdge). IP addresses and user agents are never
// stored or sent anywhere.
//
// Source: utm_source when present (lowercased, [a-z0-9._-], 60 characters at most), else the
// referrer's host without "www." ("internal" for this site's own host), else "direct".
import { run, sha256Hex } from '@swarm/db';
import { analyticsDay, funnelSource, funnelVisitStatement } from '@swarm/engine';
import type { SiteEnv } from '../env';
import { matchAiBot } from './bots';

type DeviceClass = 'desktop' | 'mobile' | 'tablet' | 'other';

const SALT_TTL_SECONDS = 2 * 24 * 60 * 60;

/** Paths that are never page views: platform routes, feeds, sitemaps and files. */
export function isPagePath(path: string): boolean {
  if (path === '/_swarm' || path.startsWith('/_swarm/')) return false;
  if (path.startsWith('/media/') || path.startsWith('/.well-known/')) return false;
  if (path === '/healthz' || path === '/feed' || path === '/sitemap') return false;
  // Anything that looks like a file: robots.txt, feed.json, sitemap.xml, icons, assets.
  return !/\.[a-z0-9]{1,8}$/i.test(path);
}

const BOT_UA =
  /bot\b|bot\/|crawl|spider|slurp|archiver|facebookexternalhit|embedly|preview|headless|lighthouse|pingdom|uptime|monitor|python-|curl\/|wget|go-http-client|okhttp|java\/|libwww|httpclient|axios\/|node-fetch|undici/i;

/** Verified bots (Cloudflare) and anything whose User-Agent says it is automated. */
export function isBotRequest(
  userAgent: string | undefined,
  cf: { verifiedBotCategory?: unknown; botManagement?: { verifiedBot?: unknown } } | undefined,
): boolean {
  if (!userAgent) return true;
  if (cf?.verifiedBotCategory || cf?.botManagement?.verifiedBot) return true;
  return BOT_UA.test(userAgent) || matchAiBot(userAgent) !== null;
}

export function deviceClass(userAgent: string | undefined): DeviceClass {
  if (!userAgent) return 'other';
  if (/ipad|tablet|kindle|silk\/|playbook/i.test(userAgent)) return 'tablet';
  if (/android/i.test(userAgent) && !/mobile/i.test(userAgent)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(userAgent)) return 'mobile';
  if (/windows|macintosh|mac os x|x11|linux|cros/i.test(userAgent)) return 'desktop';
  return 'other';
}

export function trafficSource(url: URL, referrer: string | undefined): string {
  return funnelSource(url.searchParams.get('utm_source'), referrer, url.hostname);
}

export function countryOf(cf: { country?: unknown } | undefined): string {
  const country = typeof cf?.country === 'string' ? cf.country.toUpperCase() : '';
  return /^[A-Z0-9]{2}$/.test(country) ? country : 'XX';
}

/** The page path as counted: no query, no trailing slash, at most 512 characters. */
export function countedPath(path: string): string {
  if (path.length <= 1) return path;
  // A scan, not /\/+$/: that regex is quadratic on a long run of slashes inside the path.
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) end--;
  return (path.slice(0, end) || '/').slice(0, 512);
}

/** Today's salt, created on first use; one per UTC day, kept for two days. */
async function dailySalt(cache: KVNamespace, day: string): Promise<string> {
  const key = `analytics-salt:v1:${day}`;
  const existing = await cache.get(key);
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const salt = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await cache.put(key, salt, { expirationTtl: SALT_TTL_SECONDS });
  return salt;
}

async function visitorHash(
  salt: string,
  ip: string,
  userAgent: string,
  channelId: string,
): Promise<string> {
  return (await sha256Hex(`${salt}\n${ip}\n${userAgent}\n${channelId}`)).slice(0, 32);
}

interface PageView {
  channelId: string;
  url: URL;
  referrer: string | undefined;
  userAgent: string;
  ip: string;
  country: string;
  readerClass: string;
  now: number;
}

/** Records one page view (see the file comment). */
export async function recordPageView(env: SiteEnv, view: PageView): Promise<void> {
  const day = analyticsDay(view.now);
  const path = countedPath(view.url.pathname);
  const source = trafficSource(view.url, view.referrer);
  const device = deviceClass(view.userAgent);
  const hash = await visitorHash(
    await dailySalt(env.CACHE, day),
    view.ip,
    view.userAgent,
    view.channelId,
  );

  const inserted = await run(
    env.DB,
    'INSERT OR IGNORE INTO site_visitors (channel_id, day, visitor_hash) VALUES (?1, ?2, ?3)',
    view.channelId,
    day,
    hash,
  );
  const newVisitor = inserted.meta.changes > 0 ? 1 : 0;
  await run(
    env.DB,
    `INSERT INTO site_page_views_daily (channel_id, day, path, source, device, country, views, visitors)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)
     ON CONFLICT (channel_id, day, path, source, device, country)
     DO UPDATE SET views = views + 1, visitors = visitors + excluded.visitors`,
    view.channelId,
    day,
    path,
    source,
    device,
    view.country,
    newVisitor,
  );
  // Funnel Explorer: a visit is the visitor's first counted view of the day.
  if (newVisitor) {
    await funnelVisitStatement(env.DB, {
      channelId: view.channelId,
      url: view.url,
      referrer: view.referrer,
      now: view.now,
    }).run();
  }

  env.ANALYTICS?.writeDataPoint({
    indexes: [view.channelId],
    blobs: [path, source, device, view.country, view.readerClass],
    doubles: [1, newVisitor],
  });
}
