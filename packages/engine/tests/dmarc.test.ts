import { DevDedicatedSending, SesClient, devDedicatedCalls } from '@swarm/mail';
import { describe, expect, it, vi } from 'vitest';
import {
  DMARC_LIMITS,
  DmarcInputError,
  classifyMailbox,
  complaintStanding,
  decompressReport,
  deliverabilityRange,
  dmarcDomainIdFromAddress,
  dmarcReporter,
  MAJOR_DMARC_REPORTERS,
  dmarcReportAddress,
  extractReportAttachment,
  identifierAligned,
  mergeRecords,
  organisationalDomain,
  parseAggregateReport,
  parseXml,
  recommendedDmarcRecord,
  recordAlignment,
  recordReportsTo,
  withRecommendedDmarc,
  zipEntries,
} from '../src/index';
import googleEml from './fixtures/dmarc/google.eml?raw';
import googleXml from './fixtures/dmarc/google.xml?raw';
import outlookEml from './fixtures/dmarc/outlook.eml?raw';
import outlookXml from './fixtures/dmarc/outlook.xml?raw';
import yahooEml from './fixtures/dmarc/yahoo.eml?raw';
import yahooXml from './fixtures/dmarc/yahoo.xml?raw';

const bytes = (text: string) => new TextEncoder().encode(text);

async function compress(data: Uint8Array, format: 'gzip' | 'deflate-raw'): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A minimal zip writer for the bounds tests (CRCs are zero; the reader does not check them). */
async function zipOf(
  entries: { name: string; data: Uint8Array; method?: 0 | 8 }[],
  options: { flags?: number; uncompressedSize?: number } = {},
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const body = method === 8 ? await compress(entry.data, 'deflate-raw') : entry.data;
    const name = bytes(entry.name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(6, options.flags ?? 0, true);
    local.setUint16(8, method, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, options.uncompressedSize ?? entry.data.length, true);
    local.setUint16(26, name.length, true);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(8, options.flags ?? 0, true);
    header.setUint16(10, method, true);
    header.setUint32(20, body.length, true);
    header.setUint32(24, options.uncompressedSize ?? entry.data.length, true);
    header.setUint16(28, name.length, true);
    header.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, body);
    central.push(new Uint8Array(header.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((sum, p) => sum + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const b64 = (data: Uint8Array) => {
  let binary = '';
  for (const b of data) binary += String.fromCharCode(b);
  return btoa(binary).replace(/.{76}/g, '$&\r\n');
};

const mail = (headers: string, body: string) => bytes(`${headers}\r\n\r\n${body}`);

describe('DMARC XML reader', () => {
  it('reads elements, text, CDATA, comments and entities', () => {
    const root = parseXml(
      `<?xml version="1.0"?><!-- hi --><a x="1 > 0"><b>one &amp; two &#x41;&#66;</b><c><![CDATA[<raw>]]></c><d/></a>`,
    );
    expect(root.name).toBe('a');
    expect(root.children.map((c) => c.name)).toEqual(['b', 'c', 'd']);
    expect(root.children[0]!.text).toBe('one & two AB');
    expect(root.children[1]!.text).toBe('<raw>');
  });

  it('drops namespace prefixes', () => {
    const root = parseXml(
      `<dmarc:feedback xmlns:dmarc="urn:ietf:params:xml:ns:dmarc-2.0"><dmarc:x>1</dmarc:x></dmarc:feedback>`,
    );
    expect(root.name).toBe('feedback');
    expect(root.children[0]!.name).toBe('x');
  });

  it('refuses DTDs, so no entity can expand', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><feedback>&lol2;</feedback>`;
    expect(() => parseXml(bomb)).toThrow(DmarcInputError);
    // An undeclared entity stays as text; it is never looked up.
    expect(parseXml('<a>&lol;</a>').text).toBe('&lol;');
  });

  it('refuses malformed and over-deep documents', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(/unexpected/);
    expect(() => parseXml('<a>')).toThrow(/unclosed/);
    expect(() => parseXml('<a/><b/>')).toThrow(/more than one root/);
    expect(() => parseXml('text')).toThrow(DmarcInputError);
    expect(() => parseXml(`${'<a>'.repeat(40)}${'</a>'.repeat(40)}`)).toThrow(/deep/);
  });

  it('reads a long attribute-like run in linear time', () => {
    // Anyone can mail a report, so a 2 MB tag with no '=' must not take quadratic time (it took
    // over a minute before attribute names had to follow whitespace).
    const started = performance.now();
    const root = parseXml(`<feedback ${'x'.repeat(2_000_000)} version="1"/>`);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(root.attrs).toEqual({ version: '1' });
  });
});

describe('DMARC aggregate reports', () => {
  it('parses a Google report', () => {
    const report = parseAggregateReport(googleXml);
    expect(report).toMatchObject({
      orgName: 'google.com',
      reportId: '4381273540812537241',
      begin: 1761523200,
      end: 1761609599,
      policy: { domain: 'news.example.com', adkim: 'r', aspf: 'r', p: 'quarantine', pct: 100 },
    });
    expect(report.records).toHaveLength(3);
    expect(report.records[1]!.sourceIp).toBe('2a01:111:f400:fe0c::300');
    expect(report.records[0]!.dkim).toHaveLength(2);
  });

  it('parses an Outlook.com report with schema namespaces and envelope fields', () => {
    const report = parseAggregateReport(outlookXml);
    expect(report.orgName).toBe('Enterprise Outlook');
    expect(report.policy.sp).toBeNull();
    expect(report.records[1]).toMatchObject({
      sourceIp: '2001:db8:4006:80b::200e',
      count: 2,
      disposition: 'quarantine',
      envelopeFrom: 'forwarder.example.org',
    });
  });

  it('parses a Yahoo report with missing optional fields', () => {
    const report = parseAggregateReport(yahooXml);
    const sparse = report.records[1]!;
    expect(sparse.evaluatedDkim).toBeNull();
    expect(sparse.evaluatedSpf).toBeNull();
    expect(sparse.headerFrom).toBe('news.example.com');
    expect(sparse.dkim[0]!.selector).toBeNull();
  });

  it('parses a DMARC 2.0 report with a prefixed namespace', () => {
    const report = parseAggregateReport(
      googleXml
        .replace('<feedback>', '<d:feedback xmlns:d="urn:ietf:params:xml:ns:dmarc-2.0">')
        .replace('</feedback>', '</d:feedback>')
        .replace(/<(\/?)(record|row|count)>/g, '<$1d:$2>'),
    );
    expect(report.records).toHaveLength(3);
    expect(report.records[0]!.count).toBe(1200);
  });

  it('refuses reports without the required fields', () => {
    expect(() => parseAggregateReport('<feedback><report_metadata/></feedback>')).toThrow(
      /org_name/,
    );
    expect(() => parseAggregateReport('<other/>')).toThrow(/feedback/);
    expect(() =>
      parseAggregateReport(googleXml.replace('<count>1200</count>', '<count>many</count>')),
    ).toThrow(/count/);
  });

  it('computes alignment from policy_evaluated, else from auth results', () => {
    const google = parseAggregateReport(googleXml);
    expect(google.records.map((r) => recordAlignment(r, google.policy))).toEqual([
      { dkimAligned: true, spfAligned: true },
      { dkimAligned: true, spfAligned: false },
      { dkimAligned: false, spfAligned: false },
    ]);
    const yahoo = parseAggregateReport(yahooXml);
    // DKIM d=example.com aligns relaxed with news.example.com; an SPF HELO pass never aligns.
    expect(recordAlignment(yahoo.records[1]!, yahoo.policy)).toEqual({
      dkimAligned: true,
      spfAligned: false,
    });
    expect(recordAlignment(yahoo.records[1]!, { adkim: 's', aspf: 'r' })).toEqual({
      dkimAligned: false,
      spfAligned: false,
    });
  });

  it('merges identical rows and keeps the totals', () => {
    const report = parseAggregateReport(googleXml);
    report.records.push({ ...report.records[2]!, count: 8 });
    const rows = mergeRecords(report);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.sourceIp === '203.0.113.7')!.count).toBe(20);
    expect(rows[0]!.dkimDomain).toBe('news.example.com');
    expect(rows[0]!.spfDomain).toBe('bounce.news.example.com');
  });
});

describe('DMARC report mail', () => {
  it('finds the zip that is a Google message’s whole body', async () => {
    const attachment = extractReportAttachment(bytes(googleEml));
    expect(attachment.format).toBe('zip');
    expect(attachment.filename).toMatch(/^google\.com!news\.example\.com!.*\.zip$/);
    expect(await decompressReport(attachment)).toBe(googleXml);
  });

  it('skips the text part and gunzips an Outlook.com attachment', async () => {
    const attachment = extractReportAttachment(bytes(outlookEml));
    expect(attachment.format).toBe('gzip');
    expect(await decompressReport(attachment)).toBe(outlookXml);
  });

  it('reads a Yahoo zip with an RFC 2231 filename', async () => {
    const attachment = extractReportAttachment(bytes(yahooEml));
    expect(attachment.format).toBe('zip');
    expect(attachment.filename).toBe('yahoo.com!news.example.com!1761523200!1761609599.xml.zip');
    expect(await decompressReport(attachment)).toBe(yahooXml);
  });

  it('accepts inline XML and recognises untyped attachments by their bytes', async () => {
    const inline = extractReportAttachment(
      mail('Content-Type: text/plain; charset=utf-8', googleXml),
    );
    expect(inline.format).toBe('xml');
    expect(await decompressReport(inline)).toBe(googleXml);

    const gz = await compress(bytes(googleXml), 'gzip');
    const untyped = extractReportAttachment(
      mail(
        'Content-Type: multipart/mixed; boundary=b1',
        `--b1\r\nContent-Type: text/plain\r\n\r\nReport attached.\r\n--b1\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(gz)}\r\n--b1--\r\n`,
      ),
    );
    expect(untyped.format).toBe('gzip');
    expect(await decompressReport(untyped)).toBe(googleXml);
  });

  it('does not take a part typed with an Object.prototype name for a report', () => {
    // Anyone can mail the report address; "constructor" is no content type it knows.
    for (const type of ['constructor', 'tostring', '__proto__']) {
      expect(() =>
        extractReportAttachment(
          mail(
            'Content-Type: multipart/mixed; boundary=b1',
            `--b1\r\nContent-Type: ${type}\r\n\r\nnot a report\r\n--b1--\r\n`,
          ),
        ),
      ).toThrow('no report attachment found');
    }
  });

  it('reads stored zip entries and picks the XML among several', async () => {
    const zip = await zipOf([
      { name: 'readme.txt', data: bytes('hello'), method: 0 },
      { name: 'report.xml', data: bytes(yahooXml), method: 0 },
    ]);
    expect(await decompressReport({ format: 'zip', filename: null, bytes: zip })).toBe(yahooXml);
  });

  it('refuses mail without a report', () => {
    expect(() => extractReportAttachment(mail('Content-Type: text/plain', 'Just a note.'))).toThrow(
      /no report/,
    );
    expect(() =>
      extractReportAttachment(mail('Content-Type: multipart/mixed', 'no boundary')),
    ).toThrow(/boundary/);
  });

  it('bounds MIME nesting', () => {
    let body = `Content-Type: text/xml\r\n\r\n<feedback/>`;
    for (let i = 0; i < 8; i++) {
      body = `Content-Type: multipart/mixed; boundary=n${i}\r\n\r\n--n${i}\r\n${body}\r\n--n${i}--`;
    }
    expect(() => extractReportAttachment(bytes(body))).toThrow(/too deep/);
  });

  it('strips base64 padding in linear time after a long run of =', () => {
    // Anyone can mail a report, so a long '=' run that is not at the end must not take quadratic
    // time (a trailing-run regex took over three seconds on 100,000 of them).
    const body = `${'='.repeat(100_000)}QQ==`;
    const started = performance.now();
    expect(() =>
      extractReportAttachment(
        mail('Content-Type: application/gzip\r\nContent-Transfer-Encoding: base64', body),
      ),
    ).toThrow('attachment is not valid base64');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('stops at the part limit without splitting the whole body first', () => {
    const many = (piece: string) =>
      mail('Content-Type: multipart/mixed; boundary=b', `--b\r\n${piece}\r\n`.repeat(100_000));
    // Parts that hold no leaves (an empty multipart) count against the limit too.
    const empty = many('Content-Type: multipart/mixed; boundary=z\r\n\r\n');
    expect(() => extractReportAttachment(empty)).toThrow(/too many parts/);

    const split = vi.spyOn(String.prototype, 'split');
    try {
      expect(() => extractReportAttachment(many('Content-Type: text/plain\r\n\r\nx'))).toThrow(
        /too many parts/,
      );
      const longest = Math.max(0, ...split.mock.results.map((r) => (r.value as string[]).length));
      expect(longest).toBeLessThanOrEqual(DMARC_LIMITS.mimeParts + 1);
    } finally {
      split.mockRestore();
    }
  });
});

describe('DMARC decompression bounds', () => {
  const big = () => new Uint8Array(DMARC_LIMITS.uncompressedBytes + 1024);

  it('stops a gzip bomb at 25 MB', async () => {
    const bomb = await compress(big(), 'gzip');
    expect(bomb.length).toBeLessThan(DMARC_LIMITS.compressedBytes);
    await expect(decompressReport({ format: 'gzip', filename: null, bytes: bomb })).rejects.toThrow(
      /too large once decompressed/,
    );
  });

  it('stops a zip bomb at 25 MB even when the header lies about its size', async () => {
    const lying = await zipOf([{ name: 'r.xml', data: big() }], { uncompressedSize: 1000 });
    await expect(decompressReport({ format: 'zip', filename: null, bytes: lying })).rejects.toThrow(
      /too large once decompressed/,
    );
    const honest = await zipOf([{ name: 'r.xml', data: big() }]);
    await expect(
      decompressReport({ format: 'zip', filename: null, bytes: honest }),
    ).rejects.toThrow(/too large once decompressed/);
  });

  it('refuses more than 5 entries, encryption, and oversized attachments', async () => {
    const many = await zipOf(
      Array.from({ length: 6 }, (_, i) => ({
        name: `${i}.xml`,
        data: bytes('<a/>'),
        method: 0 as const,
      })),
    );
    expect(() => zipEntries(many)).toThrow(/too many entries/);
    const encrypted = await zipOf([{ name: 'r.xml', data: bytes('<a/>'), method: 0 }], {
      flags: 1,
    });
    await expect(
      decompressReport({ format: 'zip', filename: null, bytes: encrypted }),
    ).rejects.toThrow(/encrypted/);
    await expect(
      decompressReport({
        format: 'gzip',
        filename: null,
        bytes: new Uint8Array(DMARC_LIMITS.compressedBytes + 1),
      }),
    ).rejects.toThrow(/attachment is too large/);
  });

  it('turns corrupt archives into input errors', async () => {
    await expect(
      decompressReport({ format: 'gzip', filename: null, bytes: bytes('\x1f\x8bnot gzip at all') }),
    ).rejects.toThrow(DmarcInputError);
    await expect(
      decompressReport({ format: 'zip', filename: null, bytes: bytes('PK\x03\x04 truncated') }),
    ).rejects.toThrow(/central directory/);
  });
});

describe('DMARC addresses and records', () => {
  const id = 'sd_0192f8a0c0de7c3a9e2b4f1d6a8b0c11';

  it('reads the sending domain id from the rua address', () => {
    expect(
      dmarcDomainIdFromAddress(`dmarc+${id}@dmarc.swarm.localhost`, 'dmarc.swarm.localhost'),
    ).toBe(id);
    expect(
      dmarcDomainIdFromAddress(
        `DMARC+${id.toUpperCase()}@DMARC.swarm.localhost`,
        'dmarc.swarm.localhost',
      ),
    ).toBe(id);
    expect(
      dmarcDomainIdFromAddress(`dmarc+${id}@other.example`, 'dmarc.swarm.localhost'),
    ).toBeNull();
    expect(
      dmarcDomainIdFromAddress('dmarc+nope@dmarc.swarm.localhost', 'dmarc.swarm.localhost'),
    ).toBeNull();
    expect(
      dmarcDomainIdFromAddress(`unsub+${id}@dmarc.swarm.localhost`, 'dmarc.swarm.localhost'),
    ).toBeNull();
  });

  it('keys the per-reporter limit on the organisational domain Email Routing authenticated', () => {
    expect(dmarcReporter({ dkim: ['google.com'], spf: 'google.com' })).toBe('google.com');
    expect(dmarcReporter({ dkim: ['dmarc.yahoo.com'] })).toBe('yahoo.com');
    // DKIM first: it signs the message, while SPF only names the server that relayed it.
    expect(dmarcReporter({ dkim: ['mail.outlook.com'], spf: 'relay.example.net' })).toBe(
      'outlook.com',
    );
    expect(dmarcReporter({ dkim: [], spf: 'bounce.example.net' })).toBe('example.net');
    expect(dmarcReporter({ dkim: [] })).toBe('unauthenticated');
  });

  it('keys a big reporter only on its exact domain, never on a consumer mailbox domain', () => {
    expect(dmarcReporter({ dkim: ['example.org', 'google.com'] })).toBe('google.com');
    expect(dmarcReporter({ dkim: [], spf: 'microsoft.com' })).toBe('microsoft.com');
    // Not the reserved google.com share, and not one shared by every google.com subdomain.
    expect(dmarcReporter({ dkim: ['groups.google.com'] })).toBe('groups.google.com');
    for (const consumer of ['yahoo.com', 'outlook.com', 'messagingengine.com', 'mail.ru']) {
      expect(MAJOR_DMARC_REPORTERS).not.toContain(dmarcReporter({ dkim: [consumer] }));
    }
  });

  it('keeps the registrable part of a domain under a multi-label public suffix', () => {
    expect(organisationalDomain('dmarc.yahoo.co.jp')).toBe('yahoo.co.jp');
    expect(organisationalDomain('mail.example.co.uk')).toBe('example.co.uk');
    expect(organisationalDomain('reports.example.com.au')).toBe('example.com.au');
    expect(organisationalDomain('a.b.example.com.br')).toBe('example.com.br');
    expect(organisationalDomain('example.co.uk')).toBe('example.co.uk');
    expect(organisationalDomain('dmarc.yahoo.com')).toBe('yahoo.com');
    // So two senders under co.uk neither align nor share a reporter's limit.
    expect(identifierAligned('a.co.uk', 'b.co.uk', 'r')).toBe(false);
    expect(identifierAligned('bounce.example.co.uk', 'example.co.uk', 'r')).toBe(true);
    expect(dmarcReporter({ dkim: ['yahoo.co.jp'] })).not.toBe(
      dmarcReporter({ dkim: ['other.co.jp'] }),
    );
  });

  it('does not key reporters on a sending service many senders share', () => {
    // SES signs with amazonses.com besides the sender's own key, and its default MAIL FROM is
    // under amazonses.com for every customer.
    expect(dmarcReporter({ dkim: ['amazonses.com', 'reports.example.org'] })).toBe('example.org');
    expect(dmarcReporter({ dkim: ['amazonses.com'], spf: 'mail.example.org' })).toBe('example.org');
    expect(dmarcReporter({ dkim: [], spf: 'us-east-1.amazonses.com' })).toBe(
      'us-east-1.amazonses.com',
    );
    expect(dmarcReporter({ dkim: ['sendgrid.net'], spf: 'em123.sendgrid.net' })).toBe(
      'sendgrid.net',
    );
    expect(dmarcReporter({ dkim: [], spf: 'bounces.mcsv.net' })).not.toBe(
      dmarcReporter({ dkim: [], spf: 'other.mcsv.net' }),
    );
  });

  it('recommends quarantine with the per-domain report address, for old domains too', () => {
    const address = dmarcReportAddress(id, 'dmarc.swarm.localhost');
    const record = recommendedDmarcRecord('news.example.com', address);
    expect(record).toEqual({
      purpose: 'dmarc',
      type: 'TXT',
      name: '_dmarc.news.example.com',
      value: `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:${address}`,
    });
    const old = [
      { purpose: 'dkim' as const, type: 'CNAME' as const, name: 'a', value: 'b' },
      { ...record, value: 'v=DMARC1; p=quarantine; rua=mailto:dmarc@unsubscribe.example' },
    ];
    expect(withRecommendedDmarc(old, 'news.example.com', address)).toEqual([old[0], record]);
    expect(recordReportsTo(record.value, address)).toBe(true);
    expect(
      recordReportsTo(`v=DMARC1; p=reject; rua=mailto:a@b.example,mailto:${address}!10m`, address),
    ).toBe(true);
    expect(recordReportsTo('v=DMARC1; p=reject; rua=mailto:a@b.example', address)).toBe(false);
  });
});

describe('Deliverability helpers', () => {
  it('classifies mailbox providers, including aliases and country domains', () => {
    const cases: [string, string][] = [
      ['a@gmail.com', 'gmail'],
      ['a@GoogleMail.com', 'gmail'],
      ['a@hotmail.co.uk', 'outlook'],
      ['a@live.com', 'outlook'],
      ['a@msn.com', 'outlook'],
      ['a@outlook.fr', 'outlook'],
      ['a@yahoo.com.au', 'yahoo'],
      ['a@ymail.com', 'yahoo'],
      ['a@aol.com', 'yahoo'],
      ['a@icloud.com', 'apple'],
      ['a@me.com', 'apple'],
      ['a@mac.com', 'apple'],
      ['a@example.com', 'other'],
      ['a@live.example.com', 'other'],
      ['a@gmail.com.evil.example', 'other'],
    ];
    for (const [address, provider] of cases)
      expect(classifyMailbox(address), address).toBe(provider);
  });

  it('rates complaints against Gmail’s target and ceiling', () => {
    expect(complaintStanding(null)).toBe('good');
    expect(complaintStanding(0.0009)).toBe('good');
    expect(complaintStanding(0.001)).toBe('watch');
    expect(complaintStanding(0.003)).toBe('over');
  });

  it('bounds date ranges', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    expect(deliverabilityRange({}, now)).toMatchObject({ from: '2026-09-29', to: '2026-10-28' });
    expect(deliverabilityRange({ from: '2026-10-01', to: '2026-10-01' }, now)).toMatchObject({
      startMs: Date.parse('2026-10-01T00:00:00Z'),
      endMs: Date.parse('2026-10-02T00:00:00Z'),
    });
    expect(deliverabilityRange({ from: '2025-01-01', to: '2026-10-01' }, now)).toMatch(/366/);
    expect(deliverabilityRange({ from: '2026-10-05', to: '2026-10-01' }, now)).toMatch(/after/);
    expect(deliverabilityRange({ from: '2026-02-30', to: '2026-03-01' }, now)).toMatch(
      /real dates/,
    );
  });
});

describe('Dedicated sending providers', () => {
  it('the dev fake records every call', async () => {
    const before = devDedicatedCalls.length;
    const fake = new DevDedicatedSending();
    await fake.createConfigurationSet('cs');
    await fake.createDedicatedIpPool('pool');
    await fake.attachPool('cs', 'pool');
    expect(await fake.poolWarmup('pool')).toEqual({ state: 'done', percent: 100 });
    expect(devDedicatedCalls.slice(before).map((c) => c.method)).toEqual([
      'createConfigurationSet',
      'createDedicatedIpPool',
      'attachPool',
      'poolWarmup',
    ]);
  });

  it('SES: creates sets with an SNS destination, managed pools, and reads warm-up', async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    let warmup: unknown = { DedicatedIps: [] };
    const ses = new SesClient({
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AKIAEXAMPLEEXAMPLE', secretAccessKey: 's'.repeat(40) },
      configurationSet: 'shared',
      eventTopicArn: 'arn:aws:sns:eu-west-1:123456789012:swarm-ses-events',
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({
          method: init?.method ?? 'GET',
          url,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (url.includes('/dedicated-ips?')) return Response.json(warmup);
        // The second create of anything already exists: still success.
        if (calls.filter((c) => c.url === url && c.method === 'POST').length > 1) {
          return Response.json(
            { __type: 'AlreadyExistsException', message: 'exists' },
            { status: 400 },
          );
        }
        return Response.json({});
      },
    });
    await ses.createConfigurationSet('swarm-ch-1');
    await ses.createConfigurationSet('swarm-ch-1');
    await ses.createDedicatedIpPool('swarm-ip-ch-1');
    await ses.attachPool('swarm-ch-1', 'swarm-ip-ch-1');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://email.eu-west-1.amazonaws.com/v2/email/configuration-sets',
      body: {
        ConfigurationSetName: 'swarm-ch-1',
        ReputationOptions: { ReputationMetricsEnabled: true },
      },
    });
    expect(calls[1]).toMatchObject({
      url: 'https://email.eu-west-1.amazonaws.com/v2/email/configuration-sets/swarm-ch-1/event-destinations',
      body: {
        EventDestination: {
          Enabled: true,
          MatchingEventTypes: ['BOUNCE', 'COMPLAINT', 'DELIVERY', 'REJECT'],
          SnsDestination: { TopicArn: 'arn:aws:sns:eu-west-1:123456789012:swarm-ses-events' },
        },
      },
    });
    expect(calls.find((c) => c.url.endsWith('/dedicated-ip-pools'))!.body).toEqual({
      PoolName: 'swarm-ip-ch-1',
      ScalingMode: 'MANAGED',
    });
    expect(calls.find((c) => c.url.endsWith('/delivery-options'))).toMatchObject({
      method: 'PUT',
      body: { SendingPoolName: 'swarm-ip-ch-1' },
    });

    expect(await ses.poolWarmup('swarm-ip-ch-1')).toEqual({ state: 'in_progress', percent: 0 });
    warmup = {
      DedicatedIps: [
        { WarmupStatus: 'IN_PROGRESS', WarmupPercentage: 40 },
        { WarmupStatus: 'DONE', WarmupPercentage: 100 },
      ],
    };
    expect(await ses.poolWarmup('swarm-ip-ch-1')).toEqual({ state: 'in_progress', percent: 40 });
    warmup = { DedicatedIps: [{ WarmupStatus: 'DONE', WarmupPercentage: 100 }] };
    expect(await ses.poolWarmup('swarm-ip-ch-1')).toEqual({ state: 'done', percent: 100 });
  });

  it('SES: a Channel configuration set overrides the shared one on send', async () => {
    const bodies: { ConfigurationSetName: string }[] = [];
    const ses = new SesClient({
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AKIAEXAMPLEEXAMPLE', secretAccessKey: 's'.repeat(40) },
      configurationSet: 'shared',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ MessageId: 'm' });
      },
    });
    await ses.sendRaw({ from: 'a@b.example', to: 'c@d.example', raw: 'x' });
    await ses.sendRaw({
      from: 'a@b.example',
      to: 'c@d.example',
      raw: 'x',
      configurationSet: 'own',
    });
    expect(bodies.map((b) => b.ConfigurationSetName)).toEqual(['shared', 'own']);
  });
});
