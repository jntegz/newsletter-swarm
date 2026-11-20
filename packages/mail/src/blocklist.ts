/**
 * Domain blocklists (DNSBLs that list domain names), asked over the same DNS lookups as the record
 * checks in ./dns-check.
 *
 * The hard part is honesty. The big lists refuse queries that arrive through public resolvers
 * (which is what DNS over HTTPS is) and answer them with special codes, or with nothing at all.
 * So an answer is only ever read as "listed" when it is one of the list's documented listing
 * codes, and "not listed" only when the list's own permanent test entry came back as listed
 * through the same resolver a moment earlier. Everything else is "unknown", with a link to the
 * list's own lookup page so a person can check by hand.
 */
import { registrableDomain } from './content-check';
import type { DnsLookup } from './dns-check';

type BlocklistState = 'listed' | 'clean' | 'unknown';

interface DomainBlocklist {
  id: 'spamhaus_dbl' | 'surbl' | 'uribl';
  name: string;
  /** The DNS zone a domain is looked up under: <domain>.<zone>. */
  zone: string;
  /** A name the list always lists, to prove that this resolver gets real answers. */
  testPoint: string;
  /** The list's own page for looking a domain up (and asking for removal). */
  lookupUrl(domain: string): string;
  /** What an A record answer means. */
  read(address: string): 'listed' | 'refused' | 'other';
}

const octets = (address: string): number[] | null => {
  const parts = address.trim().split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : null;
};

/**
 * The lists that matter for a sending domain. Return codes as each list documents them:
 * - Spamhaus DBL: 127.0.1.2 to 127.0.1.106 are listings; 127.255.255.x are errors
 *   (252 typing error, 254 query through a public resolver, 255 too many queries).
 * - SURBL multi: 127.0.0.x is a bitmask (8 phishing, 16 malware, 64 abuse, 128 cracked site);
 *   127.0.0.1 means the query was refused.
 * - URIBL multi: 127.0.0.x is a bitmask (2 black, 4 grey, 8 red); bit 1 means the query was
 *   refused. Only "black" is treated as listed: grey and red are not delivery problems.
 */
export const DOMAIN_BLOCKLISTS: readonly DomainBlocklist[] = [
  {
    id: 'spamhaus_dbl',
    name: 'Spamhaus DBL',
    zone: 'dbl.spamhaus.org',
    testPoint: 'dbltest.com',
    lookupUrl: (domain) => `https://check.spamhaus.org/results?query=${encodeURIComponent(domain)}`,
    read(address) {
      const ip = octets(address);
      if (!ip || ip[0] !== 127) return 'other';
      if (ip[1] === 255) return 'refused';
      return ip[1] === 0 && ip[2] === 1 && ip[3]! >= 2 ? 'listed' : 'other';
    },
  },
  {
    id: 'surbl',
    name: 'SURBL',
    zone: 'multi.surbl.org',
    testPoint: 'surbl-org-permanent-test-point.com',
    lookupUrl: () => 'https://surbl.org/surbl-analysis',
    read(address) {
      const ip = octets(address);
      if (!ip || ip[0] !== 127 || ip[1] !== 0 || ip[2] !== 0) return 'other';
      if (ip[3]! & 1) return 'refused';
      return ip[3]! & (8 | 16 | 64 | 128) ? 'listed' : 'other';
    },
  },
  {
    id: 'uribl',
    name: 'URIBL',
    zone: 'multi.uribl.com',
    testPoint: 'test.uribl.com',
    lookupUrl: (domain) => `https://lookup.uribl.com/?domain=${encodeURIComponent(domain)}`,
    read(address) {
      const ip = octets(address);
      if (!ip || ip[0] !== 127 || ip[1] !== 0 || ip[2] !== 0) return 'other';
      if (ip[3]! & 1) return 'refused';
      return ip[3]! & 2 ? 'listed' : 'other';
    },
  },
];

interface BlocklistResult {
  list: DomainBlocklist['id'];
  name: string;
  state: BlocklistState;
  /** Why the state is unknown, for logs and tests; null otherwise. */
  reason: 'refused' | 'unverified' | 'failed' | null;
  lookupUrl: string;
}

export interface DomainBlocklistCheck {
  domain: string;
  results: BlocklistResult[];
}

const TIMEOUT = Symbol('timeout');

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function askList(
  list: DomainBlocklist,
  names: string[],
  dns: DnsLookup,
): Promise<Pick<BlocklistResult, 'state' | 'reason'>> {
  const answers = (
    await Promise.all(names.map((name) => dns.lookup(`${name}.${list.zone}`, 'A')))
  ).flat();
  const read = answers.map((answer) => list.read(answer));
  if (read.includes('refused')) return { state: 'unknown', reason: 'refused' };
  if (read.includes('listed')) return { state: 'listed', reason: null };
  // An answer that is neither a listing nor a refusal is nothing we understand.
  if (read.length) return { state: 'unknown', reason: 'unverified' };
  // No answer at all. That is "not listed" only if this resolver really reaches the list, which
  // the list's permanent test entry proves. Lists that silently drop public resolvers fail here.
  const proof = await dns.lookup(`${list.testPoint}.${list.zone}`, 'A');
  return proof.some((answer) => list.read(answer) === 'listed')
    ? { state: 'clean', reason: null }
    : { state: 'unknown', reason: 'unverified' };
}

/**
 * Looks one sending domain up on every domain blocklist. Lists hold registered domains, so both
 * the name as given and its registered parent are asked. Never throws: a list that cannot be
 * reached, answers slowly or refuses is `unknown`.
 */
export async function checkDomainBlocklists(
  domain: string,
  dns: DnsLookup,
  options: { timeoutMs?: number; lists?: readonly DomainBlocklist[] } = {},
): Promise<DomainBlocklistCheck> {
  const name = domain.trim().toLowerCase().replace(/\.$/, '');
  const names = [...new Set([name, registrableDomain(name)])];
  const lists = options.lists ?? DOMAIN_BLOCKLISTS;
  const results = await Promise.all(
    lists.map(async (list): Promise<BlocklistResult> => {
      const base = { list: list.id, name: list.name, lookupUrl: list.lookupUrl(names.at(-1)!) };
      try {
        const outcome = await withTimeout(askList(list, names, dns), options.timeoutMs ?? 3000);
        if (outcome === TIMEOUT) return { ...base, state: 'unknown', reason: 'failed' };
        return { ...base, ...outcome };
      } catch {
        return { ...base, state: 'unknown', reason: 'failed' };
      }
    }),
  );
  return { domain: name, results };
}
