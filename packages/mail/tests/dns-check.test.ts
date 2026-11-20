import { describe, expect, it } from 'vitest';
import { checkRecord, dohLookup, type DnsLookup, type ExpectedRecord } from '../src/dns-check';

/** Answers from a table of `name TYPE` to values. A name listed under `broken` fails to resolve. */
const dns = (table: Record<string, string[]>, broken: string[] = []): DnsLookup => ({
  async lookup(name, type) {
    if (broken.includes(name)) throw new Error('resolver down');
    return table[`${name} ${type}`] ?? [];
  },
});

const cname: ExpectedRecord = {
  type: 'CNAME',
  name: 'abc._domainkey.mail.example.com',
  value: 'abc.dkim.amazonses.com',
};
const mx: ExpectedRecord = {
  type: 'MX',
  name: 'bounce.mail.example.com',
  value: 'feedback-smtp.eu-west-1.amazonses.com',
  priority: 10,
};
const spf: ExpectedRecord = {
  type: 'TXT',
  name: 'bounce.mail.example.com',
  value: 'v=spf1 include:amazonses.com ~all',
};
const dmarc: ExpectedRecord = {
  type: 'TXT',
  name: '_dmarc.mail.example.com',
  value: 'v=DMARC1; p=quarantine; adkim=r; aspf=r',
};
const dkimTxt: ExpectedRecord = {
  type: 'TXT',
  name: 'resend._domainkey.mail.example.com',
  value: 'p=MIGfMA0GCSqGSIb3DQEB',
};

describe('checking a CNAME', () => {
  it('passes, ignoring case and the trailing dot', async () => {
    const table = { [`${cname.name} CNAME`]: ['ABC.dkim.amazonses.com.'] };
    expect(await checkRecord(cname, dns(table))).toEqual({
      state: 'ok',
      found: ['ABC.dkim.amazonses.com.'],
    });
  });

  it('says what it found when it points somewhere else', async () => {
    const table = { [`${cname.name} CNAME`]: ['other.example.net.'] };
    expect(await checkRecord(cname, dns(table))).toEqual({
      state: 'different',
      found: ['other.example.net.'],
    });
  });

  it('passes a flattened CNAME when the DKIM key still comes through', async () => {
    const table = { [`${cname.name} TXT`]: ['v=DKIM1; k=rsa; p=MIGf'] };
    expect((await checkRecord(cname, dns(table))).state).toBe('ok');
  });

  it('does not take any old address as a flattened CNAME', async () => {
    const table = { [`${cname.name} A`]: ['192.0.2.1'] };
    expect(await checkRecord(cname, dns(table))).toEqual({
      state: 'different',
      found: ['192.0.2.1'],
    });
  });

  it('is missing when nothing is there', async () => {
    expect((await checkRecord(cname, dns({}))).state).toBe('missing');
  });
});

describe('checking an MX', () => {
  const table = (...values: string[]) => ({ [`${mx.name} MX`]: values });

  it('passes on the host, whatever the priority', async () => {
    expect(
      (await checkRecord(mx, dns(table('20 feedback-smtp.eu-west-1.amazonses.com.')))).state,
    ).toBe('ok');
  });

  it('passes when one of several hosts matches', async () => {
    expect(
      (
        await checkRecord(
          mx,
          dns(table('5 other.example.net.', '10 feedback-smtp.eu-west-1.amazonses.com.')),
        )
      ).state,
    ).toBe('ok');
  });

  it('sees the wrong region as different', async () => {
    expect(
      (await checkRecord(mx, dns(table('10 feedback-smtp.us-east-1.amazonses.com.')))).state,
    ).toBe('different');
  });

  it('is missing when nothing is there', async () => {
    expect((await checkRecord(mx, dns({}))).state).toBe('missing');
  });
});

describe('checking SPF', () => {
  const table = (...values: string[]) => ({ [`${spf.name} TXT`]: values });

  it('passes, ignoring how the record ends', async () => {
    expect((await checkRecord(spf, dns(table('v=spf1 include:amazonses.com -all')))).state).toBe(
      'ok',
    );
  });

  it('ignores other TXT records at the same name', async () => {
    expect(
      (await checkRecord(spf, dns(table('google-site-verification=x', spf.value)))).state,
    ).toBe('ok');
  });

  it('calls two SPF records a conflict, because SPF then fails outright', async () => {
    const check = await checkRecord(spf, dns(table(spf.value, 'v=spf1 include:mailgun.org ~all')));
    expect(check.state).toBe('conflict');
    expect(check.found).toHaveLength(2);
  });

  it('sees another service in the record as different', async () => {
    expect((await checkRecord(spf, dns(table('v=spf1 include:mailgun.org ~all')))).state).toBe(
      'different',
    );
  });

  it('is missing when only other TXT records are there', async () => {
    expect((await checkRecord(spf, dns(table('something=else')))).state).toBe('missing');
  });
});

describe('checking DMARC', () => {
  const table = (...values: string[]) => ({ [`${dmarc.name} TXT`]: values });

  it('passes quarantine or reject, whatever else the record says', async () => {
    for (const record of [
      'v=DMARC1; p=quarantine',
      'v=DMARC1; p=reject; rua=mailto:me@example.com',
      'v=dmarc1;p=REJECT',
    ]) {
      expect((await checkRecord(dmarc, dns(table(record)))).state, record).toBe('ok');
    }
  });

  it('sees p=none as different, because sending needs more', async () => {
    expect((await checkRecord(dmarc, dns(table('v=DMARC1; p=none')))).state).toBe('different');
  });

  it('calls two DMARC records a conflict', async () => {
    expect(
      (await checkRecord(dmarc, dns(table('v=DMARC1; p=reject', 'v=DMARC1; p=none')))).state,
    ).toBe('conflict');
  });

  it('is missing when nothing is there', async () => {
    expect((await checkRecord(dmarc, dns({}))).state).toBe('missing');
  });
});

describe('checking a DKIM key in TXT', () => {
  const table = (...values: string[]) => ({ [`${dkimTxt.name} TXT`]: values });

  it('passes the same key, and sees another key as different', async () => {
    expect((await checkRecord(dkimTxt, dns(table(dkimTxt.value)))).state).toBe('ok');
    expect((await checkRecord(dkimTxt, dns(table('p=SOMETHINGELSE')))).state).toBe('different');
  });
});

describe("a person's own mail server, where Swarm doesn't know the value", () => {
  const key: ExpectedRecord = { type: 'TXT', name: 's1._domainkey.mail.example.com', value: '' };
  const own: ExpectedRecord = { type: 'TXT', name: 'mail.example.com', value: '' };

  it('passes any DKIM key, and not something that is not one', async () => {
    const found = (value: string) => dns({ [`${key.name} TXT`]: [value] });
    expect((await checkRecord(key, found('v=DKIM1; k=rsa; p=MIGf'))).state).toBe('ok');
    expect((await checkRecord(key, found('hello'))).state).toBe('different');
    expect((await checkRecord(key, dns({}))).state).toBe('missing');
  });

  it('passes any one SPF record', async () => {
    const found = (...values: string[]) => dns({ [`${own.name} TXT`]: values });
    expect((await checkRecord(own, found('v=spf1 ip4:192.0.2.1 ~all'))).state).toBe('ok');
    expect((await checkRecord(own, found('v=spf1 a ~all', 'v=spf1 mx ~all'))).state).toBe(
      'conflict',
    );
    expect((await checkRecord(own, dns({}))).state).toBe('missing');
  });
});

describe('when DNS itself fails', () => {
  it.each([
    ['a CNAME', cname],
    ['an MX', mx],
    ['SPF', spf],
    ['DMARC', dmarc],
    ['a DKIM key', dkimTxt],
  ])('reports %s as unknown, never missing', async (_what, record) => {
    expect(await checkRecord(record, dns({}, [record.name]))).toEqual({
      state: 'unknown',
      found: [],
    });
  });
});

describe('looking records up over DNS over HTTPS', () => {
  const answering = (body: unknown, ok = true, status = 200) =>
    dohLookup(async () => ({ ok, status, json: async () => body }));

  it('joins the quoted parts of a long TXT record', async () => {
    const lookup = answering({
      Status: 0,
      Answer: [{ type: 16, data: '"v=DKIM1; p=abc" "def"' }],
    });
    expect(await lookup.lookup('x.example.com', 'TXT')).toEqual(['v=DKIM1; p=abcdef']);
  });

  it('keeps only the type it asked for, as a lookup through a CNAME answers with both', async () => {
    const lookup = answering({
      Status: 0,
      Answer: [
        { type: 5, data: 'target.example.net.' },
        { type: 16, data: '"p=abc"' },
      ],
    });
    expect(await lookup.lookup('x.example.com', 'TXT')).toEqual(['p=abc']);
    expect(await lookup.lookup('x.example.com', 'CNAME')).toEqual(['target.example.net.']);
  });

  it('treats no such name as an empty answer', async () => {
    expect(await answering({ Status: 3 }).lookup('x.example.com', 'TXT')).toEqual([]);
  });

  it('throws on a server failure, so it can never read as missing', async () => {
    await expect(answering({ Status: 2 }).lookup('x.example.com', 'TXT')).rejects.toThrow();
    await expect(answering({}, false, 503).lookup('x.example.com', 'TXT')).rejects.toThrow();
  });

  it('asks for the name safely encoded', async () => {
    let asked = '';
    const lookup = dohLookup(async (url) => {
      asked = url;
      return { ok: true, status: 200, json: async () => ({ Status: 0 }) };
    });
    await lookup.lookup('a b.example.com', 'MX');
    expect(asked).toBe('https://cloudflare-dns.com/dns-query?name=a%20b.example.com&type=MX');
  });
});
