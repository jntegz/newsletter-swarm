// Edge cache (Workers Cache API, caches.default) for site pages, feeds, robots.txt, the site
// stylesheet and permanent redirects.
//
// Contract with the routes:
// - A route opts a response in with the header `x-swarm-cacheable: 1`. The edge strips it before
//   the response leaves the worker.
// - Only GET responses with status 200, 301 or 308 and no Set-Cookie are stored. /_swarm/reader/*
//   is never looked up or stored.
// - A response is cached per reader class (anonymous, member, paid, crawler), so it may depend on
//   the class but never on the individual reader. Paid readers are further keyed by their
//   Membership level (a Gate may admit some levels and not others), so a page rendered for one
//   level is never served to another. Anything that depends on the individual reader (a metered
//   read, a soft Gate dismissed, a gift link) is sent `private, no-store` and never stored. The route's Cache-Control is what the browser
//   gets (on a hit too): `public, s-maxage=…` for anonymous-safe pages, `private, no-cache` for a
//   gated Dispatch rendered for a member or paid reader. The edge keeps the entry for the route's
//   s-maxage (5 minutes when it gives none), whatever the browser directive says.
// - The key carries the Channel's site_settings.cache_version: bumping it (settings change,
//   Dispatch publish or edit) makes every older entry unreachable, which is the purge. It carries
//   the Channel's id too: versions start at 1 for every Channel, so a hostname moved to another
//   Channel would otherwise find the old Channel's pages under the same key.
// - A home page view with A/B tests running is given its variants before the lookup
//   (edge/variants.ts), and the key carries them after the reader class (".ab-hero-1=b,faq-3=a"),
//   so a page drawn with one set of variants is only ever served for that same set. Publishing a
//   design bumps cache_version, so the sets of one design never meet another's.
// - The key carries only the query parameters a cached route renders from (KEYED_PARAMS), in a
//   fixed order and only with a value that route accepts (cacheQuery). Anything else (campaign
//   tags, a referral code the edge adds after the cache, noise) is left out: such a request is
//   answered from the canonical entry, and on a miss rendered without being stored, so changing
//   query values can't create new entries. A parameter that changes the page per request (a gift
//   link, a search, a soft Gate's continue) skips the cache altogether.
// - HTML keeps a per-request CSP nonce: the nonce a stored page was rendered with is kept in
//   `x-swarm-nonce`, and a hit has it swapped for this request's nonce (elements and any
//   route-set CSP).
import type { ReaderClass } from '@swarm/domain';

export type CacheClass = ReaderClass | 'crawler';

export const CACHEABLE_HEADER = 'x-swarm-cacheable';
const NONCE_HEADER = 'x-swarm-nonce';
const BROWSER_CONTROL_HEADER = 'x-swarm-browser-cache-control';
/** Edge lifetime when the route gives no s-maxage. */
const DEFAULT_EDGE_TTL_SECONDS = 300;
const CACHEABLE_STATUSES = new Set([200, 301, 308]);
/** Response headers that belong to one request and are never stored. */
const PER_REQUEST = ['set-cookie', 'x-request-id', CACHEABLE_HEADER, 'x-swarm-cache'];
/** Headers the stored entry carries for the edge only. */
const EDGE_ONLY = [NONCE_HEADER, BROWSER_CONTROL_HEADER, 'age', 'cf-cache-status', 'expires'];

interface CacheKeyInput {
  host: string;
  /** The Channel the host resolved to, so a hostname moved to another Channel starts afresh. */
  channelId: string;
  /** Path and query, as requested ("/p/hello?ref=x"). */
  pathAndQuery: string;
  readerClass: CacheClass;
  /** The paid reader's Membership level; ignored for other classes. */
  levelId?: string | null;
  cacheVersion: number;
  /** The variant of each running A/B test this view was given, by section id. */
  variants?: Record<string, 'a' | 'b'>;
}

/**
 * The variants as part of a key: ".ab-" then id=variant pairs in id order. Ids are section ids
 * ([a-z0-9_-]) and the level before it is URI-encoded, so neither can produce "=" or ",".
 */
export function variantsKey(variants: Record<string, 'a' | 'b'> | undefined): string {
  const pairs = Object.entries(variants ?? {})
    .filter(([, v]) => v === 'a' || v === 'b')
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([id, v]) => `${encodeURIComponent(id)}=${v}`);
  return pairs.length ? `.ab-${pairs.join(',')}` : '';
}

/** The synthetic URL a response is stored under. */
export function edgeCacheKey(input: CacheKeyInput): string {
  const host = encodeURIComponent(input.host.toLowerCase());
  const level =
    input.readerClass === 'paid' ? `.${encodeURIComponent(input.levelId ?? 'any')}` : '';
  const channel = encodeURIComponent(input.channelId);
  return `https://edge-cache.swarm.invalid/v1/${host}/${channel}/${input.cacheVersion}/${input.readerClass}${level}${variantsKey(input.variants)}${input.pathAndQuery}`;
}

/**
 * Query parameters a cached route renders from, with the values it accepts. A value outside the
 * pattern renders the same page as no value (the route falls back), so it is not keyed.
 */
const KEYED_PARAMS: Record<string, RegExp> = {
  page: /^[1-9]\d{0,3}$/,
  sort: /^(?:new|top)$/,
  v: /^[A-Za-z0-9._-]{1,64}$/,
  interval: /^(?:month|year)$/,
  level: /^lv_[0-9a-f]{32}$/,
  coupon: /^[A-Za-z0-9_-]{1,64}$/,
  canceled: /^1$/,
  from: /^(?:signup|site)$/,
};

/**
 * Parameters whose page depends on the one request: never served from or stored to the cache.
 * (A search runs per query; gift, continue and tokens unlock or sign in.)
 */
const UNCACHED_PARAMS = new Set([
  'q',
  'gift',
  'continue',
  'token',
  'return',
  'o',
  't',
  's',
  'd',
  'variant',
  'section',
]);

/**
 * How a request's query takes part in the edge cache: the canonical query for the key, whether
 * to look the page up at all, and whether its response may be stored (only when the query was
 * already canonical, so a stored page never carries someone else's parameters).
 */
export function cacheQuery(params: URLSearchParams): {
  query: string;
  lookup: boolean;
  store: boolean;
} {
  const kept: [string, string][] = [];
  let canonical = true;
  const seen = new Set<string>();
  for (const [name, value] of params) {
    if (UNCACHED_PARAMS.has(name)) return { query: '', lookup: false, store: false };
    const pattern = KEYED_PARAMS[name];
    if (!pattern || !pattern.test(value) || seen.has(name)) {
      canonical = false;
      continue;
    }
    seen.add(name);
    kept.push([name, value]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = kept.length ? `?${new URLSearchParams(kept).toString()}` : '';
  const original = params.toString();
  const ordered = canonical && query === (original ? `?${original}` : '');
  return { query, lookup: true, store: ordered };
}

/** Paths that are never looked up in or stored to the edge cache. */
export function isCacheLookupPath(path: string): boolean {
  return (
    !path.startsWith('/_swarm/reader') &&
    path !== '/_swarm/preview' &&
    path !== REACH_PATH &&
    path !== SEARCH_PATH
  );
}

/** Search runs per query, so it is never cached; it has a per-client limit instead. */
const SEARCH_PATH = '/search';

/** The section analytics beacon (routes/reach.ts): always answered fresh. */
export const REACH_PATH = '/_swarm/r';

/** Whether a route's response may be stored. */
export function isCacheable(method: string, res: Response): boolean {
  return (
    method === 'GET' &&
    CACHEABLE_STATUSES.has(res.status) &&
    res.headers.get(CACHEABLE_HEADER) === '1' &&
    !res.headers.has('set-cookie')
  );
}

const isHtml = (headers: Headers) =>
  (headers.get('content-type') ?? '').toLowerCase().startsWith('text/html');

/** Seconds the edge keeps a response: the route's s-maxage, else the default. */
export function edgeTtl(cacheControl: string | null): number {
  const match = /(?:^|[,\s])s-maxage=(\d+)/i.exec(cacheControl ?? '');
  const seconds = match ? Number(match[1]) : DEFAULT_EDGE_TTL_SECONDS;
  return Math.min(Math.max(seconds, 1), 24 * 60 * 60);
}

/** The copy that goes into the cache: no per-request headers, an edge lifetime, the nonce. */
export function storedCopy(res: Response, nonce: string): Response {
  const copy = new Response(res.clone().body, res);
  for (const name of PER_REQUEST) copy.headers.delete(name);
  const browser = res.headers.get('cache-control');
  if (browser) copy.headers.set(BROWSER_CONTROL_HEADER, browser);
  copy.headers.set('cache-control', `public, max-age=${edgeTtl(browser)}`);
  if (isHtml(copy.headers)) copy.headers.set(NONCE_HEADER, nonce);
  return copy;
}

/** A stored response for this request: the route's browser caching, this request's nonce. */
export function fromCache(
  cached: Response,
  nonce: string,
): { status: number; body: ReadableStream | string; headers: Headers } {
  const headers = new Headers(cached.headers);
  const old = headers.get(NONCE_HEADER);
  const browser = headers.get(BROWSER_CONTROL_HEADER);
  for (const name of EDGE_ONLY) headers.delete(name);
  if (browser) headers.set('cache-control', browser);
  else headers.delete('cache-control');

  let body: ReadableStream | string = cached.body ?? '';
  if (old && cached.body && isHtml(headers)) {
    const csp = headers.get('content-security-policy');
    if (csp) headers.set('content-security-policy', csp.split(old).join(nonce));
    body =
      new HTMLRewriter()
        .on('[nonce]', {
          element(element) {
            if (element.getAttribute('nonce') === old) element.setAttribute('nonce', nonce);
          },
        })
        .transform(new Response(cached.body)).body ?? '';
  }
  return { status: cached.status, body, headers };
}
