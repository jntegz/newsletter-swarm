// Verified search crawlers, for Channels that expose gated content to search engines.
//
// A request gets full access only when all of these hold:
// 1. the Channel has settings.exposeGated on;
// 2. Cloudflare marks it a verified bot in a search-engine category (cf.verifiedBotCategory);
// 3. the User-Agent claims Googlebot or Bingbot;
// 4. forward-confirmed reverse DNS agrees: the client IP's PTR name is under that crawler's
//    domains, and that name resolves back to the same IP. Lookups use DNS over HTTPS, and the
//    answer (yes or no) is cached in KV for a day under a hash of the IP and crawler.
// A forged User-Agent fails 2 and 4; a real crawler of another engine fails 3.
import { sha256Hex } from '@swarm/db';
import type { SiteEnv } from '../env';

export const SEARCH_BOT_CATEGORIES = new Set(['Search Engine Crawler']);

const CRAWLERS = [
  { key: 'googlebot', ua: /googlebot/i, domains: ['googlebot.com', 'google.com'] },
  { key: 'bingbot', ua: /bingbot/i, domains: ['search.msn.com'] },
] as const;

const DOH = 'https://cloudflare-dns.com/dns-query';
const CACHE_TTL_SECONDS = 24 * 60 * 60;

export type DnsFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Expands an IPv6 address to 8 four-digit groups; null when it isn't one. */
function expandIpv6(ip: string): string[] | null {
  if (!/^[0-9a-f:]+$/i.test(ip) || ip.split('::').length > 2) return null;
  const [head = '', tail] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? left.length !== 8 : missing < 1) return null;
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...right];
  if (groups.some((g) => g.length === 0 || g.length > 4)) return null;
  return groups.map((g) => g.padStart(4, '0'));
}

function isIpv4(ip: string): boolean {
  const parts = ip.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** The reverse-DNS name for an IP, or null when the IP can't be parsed. */
function reverseName(ip: string): string | null {
  if (isIpv4(ip)) return `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
  const groups = expandIpv6(ip);
  if (!groups) return null;
  return `${groups.join('').split('').reverse().join('.')}.ip6.arpa`;
}

function sameIp(a: string, b: string): boolean {
  if (isIpv4(a) || isIpv4(b)) return a === b;
  const x = expandIpv6(a);
  const y = expandIpv6(b);
  return !!x && !!y && x.join(':') === y.join(':');
}

async function resolve(fetcher: DnsFetch, name: string, type: 'PTR' | 'A' | 'AAAA') {
  const url = `${DOH}?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetcher(url, { headers: { accept: 'application/dns-json' } });
  if (!res.ok) throw new Error(`DoH ${type} lookup failed: ${res.status}`);
  const body = await res.json<{ Status: number; Answer?: { type: number; data: string }[] }>();
  if (body.Status !== 0) return [];
  const wanted = { PTR: 12, A: 1, AAAA: 28 }[type];
  return (body.Answer ?? [])
    .filter((answer) => answer.type === wanted)
    .map((answer) => answer.data.replace(/\.$/, '').toLowerCase());
}

/**
 * Forward-confirmed reverse DNS for one crawler. Null when a lookup failed (not cached, and not
 * verified for this request).
 */
async function forwardConfirmed(
  fetcher: DnsFetch,
  ip: string,
  domains: readonly string[],
): Promise<boolean | null> {
  const reverse = reverseName(ip);
  if (!reverse) return false;
  try {
    const names = await resolve(fetcher, reverse, 'PTR');
    const host = names.find((name) => domains.some((d) => name.endsWith(`.${d}`)));
    if (!host) return false;
    const addresses = await resolve(fetcher, host, isIpv4(ip) ? 'A' : 'AAAA');
    return addresses.some((address) => sameIp(address, ip));
  } catch {
    return null;
  }
}

interface CrawlerRequest {
  ip: string | undefined;
  userAgent: string | undefined;
  verifiedBotCategory: string | undefined;
}

/** Whether this request is a verified search crawler (see the file comment for the rules). */
export async function isVerifiedSearchCrawler(
  env: SiteEnv,
  request: CrawlerRequest,
  fetcher: DnsFetch = (input, init) => fetch(input, init),
): Promise<boolean> {
  const { ip, userAgent, verifiedBotCategory } = request;
  if (!ip || !userAgent || !verifiedBotCategory) return false;
  if (!SEARCH_BOT_CATEGORIES.has(verifiedBotCategory)) return false;
  const crawler = CRAWLERS.find((candidate) => candidate.ua.test(userAgent));
  if (!crawler) return false;

  const key = `crawler:v1:${crawler.key}:${(await sha256Hex(ip)).slice(0, 32)}`;
  const cached = await env.CACHE.get(key);
  if (cached === '1') return true;
  if (cached === '0') return false;
  const verified = await forwardConfirmed(fetcher, ip, crawler.domains);
  if (verified === null) return false;
  await env.CACHE.put(key, verified ? '1' : '0', { expirationTtl: CACHE_TTL_SECONDS });
  return verified;
}
