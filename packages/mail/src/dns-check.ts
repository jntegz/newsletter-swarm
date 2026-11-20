/**
 * Compares a DNS record someone should have published with what DNS actually says. The API, the
 * installer's doctor and the setup page all use this, so they can't disagree about a record.
 *
 * A failed lookup is `unknown`, never `missing`: telling someone to go and fix a record that is
 * fine, because a resolver had a bad moment, is worse than saying nothing.
 */
type DnsRecordType = 'TXT' | 'CNAME' | 'MX' | 'A';

export interface DnsLookup {
  /** The answers for that exact type, or an empty list when there are none. Throws if unsure. */
  lookup(name: string, type: DnsRecordType): Promise<string[]>;
}

export interface ExpectedRecord {
  type: 'TXT' | 'CNAME' | 'MX';
  name: string;
  /** Empty when only a person's own mail server knows the value (SMTP): any valid record passes. */
  value: string;
  priority?: number | undefined;
}

export type RecordState = 'ok' | 'missing' | 'different' | 'conflict' | 'unknown';

interface RecordCheck {
  state: RecordState;
  /** What DNS has there now, for showing beside what's expected. */
  found: string[];
}

const host = (value: string) => value.trim().replace(/\.$/, '').toLowerCase();
const compact = (value: string) => value.trim().replace(/\s+/g, ' ');

const isSpf = (value: string) => /^v=spf1\b/i.test(value.trim());
const isDmarc = (value: string) => /^v=DMARC1\s*(;|$)/i.test(value.trim());
const isDkimKey = (value: string) => /(^|;)\s*p=[^;\s]/.test(value);

/** The mechanisms of an SPF record, ignoring order and how it ends (~all or -all). */
const spfParts = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => !/^[-~?+]?all$/.test(part))
    .sort()
    .join(' ');

const dmarcPolicy = (value: string) => /(?:^|;)\s*p=\s*(\w+)/i.exec(value)?.[1]?.toLowerCase();

async function checkTxt(expected: ExpectedRecord, dns: DnsLookup): Promise<RecordCheck> {
  const found = await dns.lookup(expected.name, 'TXT');
  const ownSpf = !expected.value && !/\._domainkey\./i.test(expected.name);
  if (isSpf(expected.value) || ownSpf) {
    // A name may hold other TXT records, but two SPF records make SPF fail outright (RFC 7208).
    const spf = found.filter(isSpf);
    if (!spf.length) return { state: 'missing', found };
    if (spf.length > 1) return { state: 'conflict', found: spf };
    if (!expected.value) return { state: 'ok', found: spf };
    return {
      state: spfParts(spf[0]!) === spfParts(expected.value) ? 'ok' : 'different',
      found: spf,
    };
  }
  if (isDmarc(expected.value)) {
    const dmarc = found.filter(isDmarc);
    if (!dmarc.length) return { state: found.length ? 'different' : 'missing', found };
    if (dmarc.length > 1) return { state: 'conflict', found: dmarc };
    // A person's own reporting address is fine. Sending only needs the policy to be strong enough.
    const policy = dmarcPolicy(dmarc[0]!);
    const strong = policy === 'quarantine' || policy === 'reject';
    return { state: strong ? 'ok' : 'different', found: dmarc };
  }
  if (!found.length) return { state: 'missing', found };
  if (!expected.value) {
    return { state: found.some(isDkimKey) ? 'ok' : 'different', found };
  }
  const wanted = compact(expected.value);
  return { state: found.some((value) => compact(value) === wanted) ? 'ok' : 'different', found };
}

async function checkCname(expected: ExpectedRecord, dns: DnsLookup): Promise<RecordCheck> {
  const found = await dns.lookup(expected.name, 'CNAME');
  if (found.length) {
    return {
      state: found.some((value) => host(value) === host(expected.value)) ? 'ok' : 'different',
      found,
    };
  }
  // Cloudflare can flatten a CNAME, so asking for one finds nothing even though it works. A DKIM
  // key arriving through the name shows it does.
  if (/\._domainkey\./i.test(expected.name)) {
    const keys = (await dns.lookup(expected.name, 'TXT')).filter(isDkimKey);
    if (keys.length) return { state: 'ok', found: keys };
  }
  const addresses = await dns.lookup(expected.name, 'A');
  return addresses.length ? { state: 'different', found: addresses } : { state: 'missing', found };
}

async function checkMx(expected: ExpectedRecord, dns: DnsLookup): Promise<RecordCheck> {
  const found = await dns.lookup(expected.name, 'MX');
  if (!found.length) return { state: 'missing', found };
  // The host is what matters. A different priority still delivers bounces to the right place.
  const hosts = found.map((value) => host(value.split(/\s+/).pop() ?? ''));
  return { state: hosts.includes(host(expected.value)) ? 'ok' : 'different', found };
}

export async function checkRecord(expected: ExpectedRecord, dns: DnsLookup): Promise<RecordCheck> {
  try {
    if (expected.type === 'CNAME') return await checkCname(expected, dns);
    if (expected.type === 'MX') return await checkMx(expected, dns);
    return await checkTxt(expected, dns);
  } catch {
    return { state: 'unknown', found: [] };
  }
}

/** Each record alongside its check, in the same order. */
export function checkRecords<T extends ExpectedRecord>(
  records: T[],
  dns: DnsLookup,
): Promise<(T & { check: RecordCheck })[]> {
  return Promise.all(
    records.map(async (record) => ({ ...record, check: await checkRecord(record, dns) })),
  );
}

const TYPE_NUMBER: Record<DnsRecordType, number> = { A: 1, CNAME: 5, MX: 15, TXT: 16 };

/** TXT data arrives as one or more quoted strings, which together are one value. */
function unquote(data: string): string {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
  return parts.length ? parts.join('') : data;
}

/**
 * Lookups over DNS over HTTPS. Answers are filtered to the type asked for, because a TXT lookup
 * through a CNAME answers with both. "No such name" is an answer; any other failure is not.
 */
export function dohLookup(
  fetcher: (
    url: string,
    init: RequestInit,
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> = (url, init) =>
    fetch(url, init),
  endpoint = 'https://cloudflare-dns.com/dns-query',
): DnsLookup {
  return {
    async lookup(name, type) {
      const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}`;
      const response = await fetcher(url, { headers: { accept: 'application/dns-json' } });
      if (!response.ok) throw new Error(`DNS lookup failed with ${response.status}`);
      const body = (await response.json()) as {
        Status: number;
        Answer?: { type: number; data: string }[];
      };
      // 0 is NOERROR and 3 is NXDOMAIN. Anything else, such as SERVFAIL, tells us nothing.
      if (body.Status !== 0 && body.Status !== 3) {
        throw new Error(`DNS lookup answered status ${body.Status}`);
      }
      return (body.Answer ?? [])
        .filter((answer) => answer.type === TYPE_NUMBER[type])
        .map((answer) => (type === 'TXT' ? unquote(answer.data) : answer.data));
    },
  };
}
