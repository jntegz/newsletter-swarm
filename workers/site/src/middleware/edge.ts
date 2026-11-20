// Edge middleware for site requests, after tenant resolution. In order:
//   1. redirects: the Channel's own, then trailing-slash normalisation (never under /_swarm);
//   2. Bot Rules: a blocked AI crawler gets a small 403 (robots.txt stays reachable, so it can
//      read that it is disallowed);
//   3. reader session: c.var.reader from the session cookie (anonymous without one; class and, for
//      paid readers, Membership level), with the cookie re-sent when the sliding session was
//      extended;
//   4. verified search crawler: c.var.crawlerFullAccess, only when the Channel exposes gated
//      content to search engines and the gated_seo_exposure flag is on;
//   5. A/B test variants for a home page view (edge/variants.ts), chosen before the cache;
//      the route, or the edge HTML cache (see edge/cache.ts for the route contract), then a
//      Champion's referral code added to subscribe forms (edge/referral.ts) and the page view's
//      source added to Link Hub links (edge/hub.ts);
//   6. browser cache headers, and a page view for analytics after the response (also on hits).
import { D1FlagStore, FlagService } from '@swarm/flags';
import type { MiddlewareHandler } from 'hono';
import type { SiteBindings, SiteContext } from '../context';
import { countryOf, isBotRequest, isPagePath, recordPageView } from '../edge/analytics';
import { botPolicy, isBlocked } from '../edge/bots';
import {
  CACHEABLE_HEADER,
  cacheQuery,
  edgeCacheKey,
  fromCache,
  isCacheLookupPath,
  isCacheable,
  storedCopy,
  type CacheClass,
} from '../edge/cache';
import { SEARCH_BOT_CATEGORIES, isVerifiedSearchCrawler, type DnsFetch } from '../edge/crawler';
import { carryHubSource } from '../edge/hub';
import { findRedirect } from '../edge/redirects';
import { carryReferral } from '../edge/referral';
import { assignVariants, isTestedPath, type Random } from '../edge/variants';
import { later } from '../readers/later';
import { hasPromptCookie } from '../render/prompts';
import { loadReaderSession, refreshReaderCookie } from '../readers/session';

export interface EdgeDeps {
  /** DNS-over-HTTPS fetcher for crawler verification (tests pass a fake). */
  dnsFetch?: DnsFetch;
  /** The edge cache; caches.default unless a test passes another. */
  cache?: () => Cache;
  /** Where A/B test variants come from; crypto random unless a test passes another. */
  random?: Random;
}

interface CfProperties {
  verifiedBotCategory?: string;
  botManagement?: { verifiedBot?: boolean };
  country?: string;
}

const cfOf = (c: SiteContext) => c.req.raw.cf as CfProperties | undefined;

const BLOCKED_TEXT =
  'This site does not allow this crawler. Its robots.txt lists the crawlers it disallows.\n';

/** The class a page is rendered and cached for. */
function cacheClassOf(c: SiteContext): CacheClass {
  return c.get('crawlerFullAccess') ? 'crawler' : c.get('reader').class;
}

async function verifiedCrawler(c: SiteContext, deps: EdgeDeps): Promise<boolean> {
  const channel = c.get('channel');
  const category = cfOf(c)?.verifiedBotCategory;
  if (!channel.settings.exposeGated || !category || !SEARCH_BOT_CATEGORIES.has(category)) {
    return false;
  }
  const env = c.get('env');
  const flags = new FlagService(new D1FlagStore(env.DB, env.CACHE));
  const on = await flags.enabled('gated_seo_exposure', {
    workspaceId: channel.workspaceId,
    channelId: channel.id,
  });
  if (!on) return false;
  return isVerifiedSearchCrawler(
    env,
    {
      ip: c.req.header('cf-connecting-ip'),
      userAgent: c.req.header('user-agent'),
      verifiedBotCategory: category,
    },
    deps.dnsFetch,
  );
}

/**
 * Whether this request is something a person's browser asked for: a GET, with a User-Agent and an
 * IP, not a bot or a verified crawler, not a prefetch or prerender. Page views and section
 * beacons are counted only then.
 */
export function humanRequest(c: SiteContext): { userAgent: string; ip: string } | null {
  const userAgent = c.req.header('user-agent');
  const ip = c.req.header('cf-connecting-ip');
  const purpose = c.req.header('sec-purpose') ?? c.req.header('purpose') ?? '';
  if (
    c.req.method !== 'GET' ||
    c.get('crawlerFullAccess') ||
    /prefetch|prerender/i.test(purpose) ||
    !userAgent ||
    !ip ||
    isBotRequest(userAgent, cfOf(c))
  ) {
    return null;
  }
  return { userAgent, ip };
}

function countPageView(c: SiteContext, res: Response): void {
  const url = new URL(c.req.url);
  if (
    res.status !== 200 ||
    !(res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html') ||
    !isPagePath(url.pathname)
  ) {
    return;
  }
  const human = humanRequest(c);
  if (!human) return;
  const { userAgent, ip } = human;
  later(
    c,
    recordPageView(c.get('env'), {
      channelId: c.get('channel').id,
      url,
      referrer: c.req.header('referer'),
      userAgent,
      ip,
      country: countryOf(cfOf(c)),
      readerClass: cacheClassOf(c),
      now: Date.now(),
    }),
  );
}

export function createEdge(deps: EdgeDeps = {}): MiddlewareHandler<SiteBindings> {
  const cacheOf = deps.cache ?? (() => caches.default);

  return async (c, next) => {
    const env = c.get('env');
    const channel = c.get('channel');
    const url = new URL(c.req.url);
    const method = c.req.method;

    // 1. Redirects.
    const redirect = await findRedirect(env, channel, method, url);
    if (redirect) return c.redirect(redirect.location, redirect.status);

    // 2. Bot Rules.
    if (url.pathname !== '/robots.txt' && channel.settings.aiBots !== 'unset') {
      const policy = await botPolicy(env, channel);
      if (isBlocked(policy, c.req.header('user-agent'), cfOf(c)?.verifiedBotCategory)) {
        return c.text(BLOCKED_TEXT, 403, {
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex',
        });
      }
    }

    // 3. Reader session.
    const session = await loadReaderSession(c);
    if (session) {
      c.set('reader', session.reader);
      if (session.refreshed) refreshReaderCookie(c);
    }

    // 4. Verified search crawler.
    if (await verifiedCrawler(c, deps)) c.set('crawlerFullAccess', true);

    // 5. A/B test variants for this view, then the edge cache, or the route.
    if (isTestedPath(url.pathname) && channel.settings.designTests.length > 0) {
      c.set('variants', assignVariants(channel.settings.designTests, deps.random));
    }
    const readerClass = cacheClassOf(c);
    // Smart Prompt dismissals change what a page shows, so those requests skip the cache.
    const query = cacheQuery(url.searchParams);
    const lookup =
      method === 'GET' && query.lookup && isCacheLookupPath(url.pathname) && !hasPromptCookie(c);
    const key = edgeCacheKey({
      host: url.host,
      channelId: channel.id,
      pathAndQuery: `${url.pathname}${query.query}`,
      readerClass,
      levelId: c.get('reader').levelId,
      cacheVersion: channel.settings.cacheVersion,
      variants: c.get('variants'),
    });
    const cached = lookup ? await cacheOf().match(key) : undefined;

    let res: Response;
    if (cached) {
      const hit = fromCache(cached, c.get('nonce'));
      // c.body keeps headers set earlier (a refreshed cookie, the request id).
      res = c.body(hit.body, {
        status: hit.status as 200 | 301 | 308,
        headers: Object.fromEntries(hit.headers),
      });
      res.headers.set('x-swarm-cache', 'hit');
      c.res = res;
    } else {
      await next();
      res = c.res;
      const cacheable = isCacheable(method, res);
      if (res.headers.has(CACHEABLE_HEADER)) {
        res.headers.delete(CACHEABLE_HEADER);
        // A request with extra parameters is answered fresh but never stored: query noise
        // can't fill the cache, and a stored page never carries someone else's parameters.
        if (cacheable && lookup && query.store) {
          later(c, cacheOf().put(key, storedCopy(res, c.get('nonce'))));
          res.headers.set('x-swarm-cache', 'miss');
        }
      }
    }

    // Champions: the visitor's referral code into the page's subscribe forms (edge/referral.ts),
    // after the cache so stored pages never carry it.
    await carryReferral(c);
    // Link Hub: this page view's source onto the links of /links (edge/hub.ts), likewise.
    carryHubSource(c);
    res = c.res;

    // 6. Pages for signed-in readers and crawlers are never public, whatever the route said.
    if (readerClass !== 'anonymous' && isHtmlResponse(res)) {
      const control = res.headers.get('cache-control') ?? '';
      if (!/\b(private|no-store)\b/.test(control)) {
        res.headers.set('cache-control', 'private, no-cache');
      }
    }
    // A design preview never sets a cookie, not even a refreshed reader session.
    if (url.pathname === '/_swarm/preview') c.res.headers.delete('set-cookie');
    countPageView(c, res);
    return c.res;
  };
}

function isHtmlResponse(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html');
}
