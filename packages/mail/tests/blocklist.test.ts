import { describe, expect, it } from 'vitest';
import { DOMAIN_BLOCKLISTS, checkDomainBlocklists, type DnsLookup } from '../src/index';

/** Answers A lookups from a table of names; `broken` names fail and `slow` ones never answer. */
const dns = (
  table: Record<string, string[]>,
  options: { broken?: RegExp; slow?: RegExp } = {},
): DnsLookup & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    async lookup(name, type) {
      asked.push(`${name} ${type}`);
      if (options.broken?.test(name)) throw new Error('resolver down');
      if (options.slow?.test(name)) return new Promise<string[]>(() => {});
      return type === 'A' ? (table[name] ?? []) : [];
    },
  };
};

/** Every list's test entry answers as listed: this resolver reaches the lists. */
const REACHABLE = {
  'dbltest.com.dbl.spamhaus.org': ['127.0.1.2'],
  'surbl-org-permanent-test-point.com.multi.surbl.org': ['127.0.0.126'],
  'test.uribl.com.multi.uribl.com': ['127.0.0.14'],
};

const states = async (table: Record<string, string[]>, domain = 'news.example.com') =>
  Object.fromEntries(
    (await checkDomainBlocklists(domain, dns(table))).results.map((r) => [r.list, r.state]),
  );

describe('domain blocklists', () => {
  it('is clean only when the list proves it answers this resolver', async () => {
    expect(await states(REACHABLE)).toEqual({
      spamhaus_dbl: 'clean',
      surbl: 'clean',
      uribl: 'clean',
    });
  });

  it('never calls silence clean: no answer and no proof is unknown', async () => {
    const check = await checkDomainBlocklists('news.example.com', dns({}));
    expect(check.results.map((r) => [r.state, r.reason])).toEqual([
      ['unknown', 'unverified'],
      ['unknown', 'unverified'],
      ['unknown', 'unverified'],
    ]);
  });

  it('reads refusals for public resolvers as unknown, never as listed', async () => {
    const check = await checkDomainBlocklists(
      'news.example.com',
      dns({
        ...REACHABLE,
        // Spamhaus: query came through a public resolver.
        'news.example.com.dbl.spamhaus.org': ['127.255.255.254'],
        'example.com.dbl.spamhaus.org': ['127.255.255.254'],
        // SURBL and URIBL: query refused.
        'example.com.multi.surbl.org': ['127.0.0.1'],
        'example.com.multi.uribl.com': ['127.0.0.1'],
      }),
    );
    expect(check.results.map((r) => [r.list, r.state, r.reason])).toEqual([
      ['spamhaus_dbl', 'unknown', 'refused'],
      ['surbl', 'unknown', 'refused'],
      ['uribl', 'unknown', 'refused'],
    ]);
  });

  it('treats every Spamhaus error code as a refusal', async () => {
    for (const code of ['127.255.255.252', '127.255.255.254', '127.255.255.255']) {
      expect(
        await states({ ...REACHABLE, 'example.com.dbl.spamhaus.org': [code] }),
        code,
      ).toMatchObject({ spamhaus_dbl: 'unknown' });
    }
  });

  it('reports a real listing, on the name itself or on its registered domain', async () => {
    expect(
      await states({ ...REACHABLE, 'example.com.dbl.spamhaus.org': ['127.0.1.2'] }),
    ).toMatchObject({ spamhaus_dbl: 'listed', surbl: 'clean', uribl: 'clean' });
    expect(
      await states({ ...REACHABLE, 'news.example.com.multi.surbl.org': ['127.0.0.64'] }),
    ).toMatchObject({ surbl: 'listed' });
    expect(
      await states({ ...REACHABLE, 'example.com.multi.uribl.com': ['127.0.0.2'] }),
    ).toMatchObject({ uribl: 'listed' });
  });

  it('does not call URIBL grey or red, or an answer it does not know, a listing', async () => {
    expect(
      await states({ ...REACHABLE, 'example.com.multi.uribl.com': ['127.0.0.4'] }),
    ).toMatchObject({ uribl: 'unknown' });
    expect(
      await states({ ...REACHABLE, 'example.com.dbl.spamhaus.org': ['192.0.2.1'] }),
    ).toMatchObject({ spamhaus_dbl: 'unknown' });
    expect(
      await states({ ...REACHABLE, 'example.com.multi.surbl.org': ['127.0.0.2'] }),
    ).toMatchObject({ surbl: 'unknown' });
  });

  it('a refusal on one name wins over a listing on the other', async () => {
    expect(
      await states({
        ...REACHABLE,
        'news.example.com.dbl.spamhaus.org': ['127.0.1.2'],
        'example.com.dbl.spamhaus.org': ['127.255.255.254'],
      }),
    ).toMatchObject({ spamhaus_dbl: 'unknown' });
  });

  it('fails soft: a broken or slow list is unknown and the others still answer', async () => {
    const broken = await checkDomainBlocklists(
      'example.com',
      dns(REACHABLE, { broken: /spamhaus/ }),
    );
    expect(broken.results.map((r) => [r.list, r.state, r.reason])).toEqual([
      ['spamhaus_dbl', 'unknown', 'failed'],
      ['surbl', 'clean', null],
      ['uribl', 'clean', null],
    ]);
    const started = Date.now();
    const slow = await checkDomainBlocklists('example.com', dns(REACHABLE, { slow: /uribl/ }), {
      timeoutMs: 30,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slow.results.map((r) => r.state)).toEqual(['clean', 'clean', 'unknown']);
  });

  it('asks about the registered domain too, and links to each list’s own lookup', async () => {
    const lookup = dns(REACHABLE);
    const check = await checkDomainBlocklists('News.Example.co.uk.', lookup);
    expect(check.domain).toBe('news.example.co.uk');
    expect(lookup.asked).toContain('news.example.co.uk.dbl.spamhaus.org A');
    expect(lookup.asked).toContain('example.co.uk.dbl.spamhaus.org A');
    expect(lookup.asked).not.toContain('co.uk.dbl.spamhaus.org A');
    expect(check.results[0]!.lookupUrl).toBe(
      'https://check.spamhaus.org/results?query=example.co.uk',
    );
    for (const result of check.results) expect(result.lookupUrl).toMatch(/^https:\/\//);
  });

  it('knows each list’s codes', () => {
    const [dbl, surbl, uribl] = DOMAIN_BLOCKLISTS;
    expect(dbl!.read('127.0.1.2')).toBe('listed');
    expect(dbl!.read('127.0.1.106')).toBe('listed');
    expect(dbl!.read('127.0.1.1')).toBe('other');
    expect(dbl!.read('127.255.255.254')).toBe('refused');
    expect(dbl!.read('not an address')).toBe('other');
    expect(surbl!.read('127.0.0.8')).toBe('listed');
    expect(surbl!.read('127.0.0.1')).toBe('refused');
    expect(uribl!.read('127.0.0.2')).toBe('listed');
    expect(uribl!.read('127.0.0.1')).toBe('refused');
  });
});
