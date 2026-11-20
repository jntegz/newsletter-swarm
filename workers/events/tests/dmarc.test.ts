import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import {
  DMARC_DAILY_NEW_REPORTER_LIMIT,
  DMARC_DAILY_REPORT_LIMIT,
  DMARC_DAILY_REPORTS_PER_REPORTER,
  DMARC_DAILY_UNAUTHENTICATED_REPORTS,
  DMARC_ESTABLISHED_REPORTER_DAYS,
} from '@swarm/engine';
import { beforeEach, describe, expect, it } from 'vitest';
import googleEml from '../../../packages/engine/tests/fixtures/dmarc/google.eml?raw';
import googleXml from '../../../packages/engine/tests/fixtures/dmarc/google.xml?raw';
import outlookEml from '../../../packages/engine/tests/fixtures/dmarc/outlook.eml?raw';
import yahooEml from '../../../packages/engine/tests/fixtures/dmarc/yahoo.eml?raw';
import { handleEmail } from '../src/index';

const DOMAIN = 'news.example.com';
let domainId: string;
let workspaceId: string;

async function seedDomain(domain = DOMAIN) {
  const now = Date.now();
  const workspace = newId('workspace');
  const channel = newId('channel');
  const id = newId('sendingDomain');
  // sending_domains is unique per (domain, kind): start each test from a clean domain.
  await env.DB.prepare('DELETE FROM sending_domains WHERE domain = ?1').bind(domain).run();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
    ).bind(workspace, 'W', now),
    env.DB.prepare(
      `INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, 'Field Notes', ?4, ?4)`,
    ).bind(channel, workspace, `ch-${crypto.randomUUID().slice(0, 8)}`, now),
    env.DB.prepare(
      `INSERT INTO sending_domains (id, workspace_id, channel_id, domain, kind, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'email', 'verified', ?5, ?5)`,
    ).bind(id, workspace, channel, domain, now),
  ]);
  return { id, workspace };
}

/** The Authentication-Results header Email Routing prepends, for a sender that passed both. */
const cloudflareAuth = (from: string) => {
  const domain = from.slice(from.lastIndexOf('@') + 1);
  return (
    `mx.cloudflare.net; dkim=pass header.d=${domain} header.s=20230601 header.b=abc; ` +
    `dmarc=pass header.from=${domain} policy.dmarc=reject; spf=pass (mx.cloudflare.net: domain ` +
    `of ${from} designates 1.2.3.4 as permitted sender) smtp.mailfrom=${from}`
  );
};

function message(
  raw: string,
  to = `dmarc+${domainId}@${env.DMARC_MAIL_DOMAIN}`,
  from = 'noreply-dmarc-support@google.com',
  /** Authentication-Results headers, first first; by default Email Routing's for the sender. */
  auth: string[] = [cloudflareAuth(from)],
) {
  const bytes = new TextEncoder().encode(raw);
  const rejected: string[] = [];
  const headers = new Headers();
  for (const value of auth) headers.append('Authentication-Results', value);
  return {
    message: {
      to,
      from,
      headers,
      rawSize: bytes.length,
      raw: new Blob([bytes]).stream(),
      setReject: (reason: string) => rejected.push(reason),
    } as unknown as ForwardableEmailMessage,
    rejected,
  };
}

const reports = () =>
  env.DB.prepare('SELECT * FROM dmarc_reports WHERE sending_domain_id = ?1 ORDER BY org_name')
    .bind(domainId)
    .all<{
      id: string;
      workspace_id: string;
      org_name: string;
      report_id: string;
      begin_at: number;
      end_at: number;
      raw_key: string;
      message_count: number;
      pass_count: number;
      policy_json: string;
    }>()
    .then((r) => r.results);

const records = (reportId: string) =>
  env.DB.prepare('SELECT * FROM dmarc_records WHERE report_id = ?1 ORDER BY count DESC')
    .bind(reportId)
    .all<{
      source_ip: string;
      count: number;
      disposition: string;
      dkim_aligned: number;
      spf_aligned: number;
      header_from: string;
      dkim_domain: string | null;
      spf_domain: string | null;
    }>()
    .then((r) => r.results);

const DAY_MS = 24 * 3600_000;

/** A stored report from `reporter`, as if it had arrived at `createdAt`. */
const seedReport = (reporter: string, reportId: string, createdAt: number) =>
  env.DB.prepare(
    `INSERT INTO dmarc_reports (id, workspace_id, sending_domain_id, org_name, report_id, begin_at, end_at,
       policy_json, raw_key, message_count, pass_count, created_at, reporter_domain)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, '{}', 'k', 0, 0, ?6, ?4)`,
  ).bind(newId('dmarcReport'), workspaceId, domainId, reporter, reportId, createdAt);

beforeEach(async () => {
  ({ id: domainId, workspace: workspaceId } = await seedDomain());
});

describe('DMARC aggregate reports by email', () => {
  it('stores Google, Outlook.com and Yahoo reports with their records and raw files', async () => {
    for (const raw of [googleEml, outlookEml, yahooEml]) {
      const { message: m, rejected } = message(raw);
      await handleEmail(m, env);
      expect(rejected).toEqual([]);
    }
    const stored = await reports();
    expect(stored.map((r) => [r.org_name, r.message_count, r.pass_count])).toEqual([
      ['Enterprise Outlook', 642, 640],
      ['Yahoo', 315, 315],
      ['google.com', 1215, 1203],
    ]);
    const google = stored.find((r) => r.org_name === 'google.com')!;
    expect(google.workspace_id).toBe(workspaceId);
    expect(google.begin_at).toBe(1761523200 * 1000);
    expect(JSON.parse(google.policy_json)).toMatchObject({ domain: DOMAIN, p: 'quarantine' });
    expect(await records(google.id)).toEqual([
      {
        id: expect.any(String),
        report_id: google.id,
        source_ip: '54.240.27.16',
        count: 1200,
        disposition: 'none',
        dkim_aligned: 1,
        spf_aligned: 1,
        header_from: DOMAIN,
        dkim_domain: DOMAIN,
        spf_domain: `bounce.${DOMAIN}`,
      },
      expect.objectContaining({
        source_ip: '203.0.113.7',
        count: 12,
        disposition: 'quarantine',
        dkim_aligned: 0,
        spf_aligned: 0,
      }),
      expect.objectContaining({
        source_ip: '2a01:111:f400:fe0c::300',
        dkim_aligned: 1,
        spf_aligned: 0,
      }),
    ]);

    for (const report of stored) {
      expect(report.raw_key).toMatch(
        new RegExp(`^dmarc/${domainId}/2025-10-27/[0-9a-f]{64}\\.(zip|xml\\.gz)$`),
      );
      const object = await env.REPORTS.get(report.raw_key);
      expect(object).not.toBeNull();
      await object!.arrayBuffer();
    }
  });

  it('is idempotent: the same report twice is stored once', async () => {
    await handleEmail(message(googleEml).message, env);
    await handleEmail(message(googleEml).message, env);
    const stored = await reports();
    expect(stored).toHaveLength(1);
    expect(await records(stored[0]!.id)).toHaveLength(3);
  });

  it('drops a report for another domain without rejecting it', async () => {
    const other = await seedDomain('other.example.com');
    const { message: m, rejected } = message(
      googleEml,
      `dmarc+${other.id}@${env.DMARC_MAIL_DOMAIN}`,
    );
    await handleEmail(m, env);
    expect(rejected).toEqual([]);
    const count = await env.DB.prepare(
      'SELECT count(*) AS n FROM dmarc_reports WHERE sending_domain_id = ?1',
    )
      .bind(other.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('drops unknown domains, malformed mail and bad addresses without rejecting', async () => {
    const cases = [
      message(googleEml, `dmarc+${newId('sendingDomain')}@${env.DMARC_MAIL_DOMAIN}`),
      message('Subject: hi\r\nContent-Type: text/plain\r\n\r\nnot a report'),
      message('Content-Type: application/zip\r\nContent-Transfer-Encoding: base64\r\n\r\nUEsDBAo='),
      message(googleEml, `dmarc+not-an-id@${env.DMARC_MAIL_DOMAIN}`),
      message(googleEml, `postmaster@${env.DMARC_MAIL_DOMAIN}`),
    ];
    for (const { message: m, rejected } of cases) {
      await handleEmail(m, env);
      expect(rejected).toEqual([]);
    }
    expect(await reports()).toHaveLength(0);
  });

  it('drops oversized messages before reading them', async () => {
    const { message: m, rejected } = message(googleEml);
    (m as unknown as { rawSize: number }).rawSize = 11 * 1024 * 1024;
    await handleEmail(m, env);
    expect(rejected).toEqual([]);
    expect(await reports()).toHaveLength(0);
  });

  it('drops reports past the daily limit for a sending domain, before storing anything', async () => {
    // The report address is public (rua in DNS), so a sender can invent report ids at will.
    const now = Date.now();
    const seed = (n: number, createdAt: number) =>
      env.DB.prepare(
        `INSERT INTO dmarc_reports (id, workspace_id, sending_domain_id, org_name, report_id, begin_at, end_at,
           policy_json, raw_key, message_count, pass_count, created_at)
         VALUES (?1, ?2, ?3, 'invented.example', ?4, ?5, ?5, '{}', 'k', 0, 0, ?5)`,
      ).bind(newId('dmarcReport'), workspaceId, domainId, `r-${createdAt}-${n}`, createdAt);
    // Reports from yesterday don't count against today.
    await env.DB.batch(
      Array.from({ length: DMARC_DAILY_REPORT_LIMIT }, (_, n) => seed(n, now - 25 * 3600_000)),
    );
    // Not from a big reporter: their share is kept outside the limit.
    const from = 'dmarc@reporter.example';
    await handleEmail(message(yahooEml, undefined, from).message, env);
    expect(await reports()).toHaveLength(DMARC_DAILY_REPORT_LIMIT + 1);

    await env.DB.batch(
      Array.from({ length: DMARC_DAILY_REPORT_LIMIT - 1 }, (_, n) => seed(n, now - 60_000)),
    );
    const { message: m, rejected } = message(googleEml, undefined, from);
    await handleEmail(m, env);
    expect(rejected).toEqual([]);
    const stored = await reports();
    expect(stored).toHaveLength(2 * DMARC_DAILY_REPORT_LIMIT);
    expect(stored.some((r) => r.org_name === 'google.com')).toBe(false);
    const objects = await env.REPORTS.list({ prefix: `dmarc/${domainId}/` });
    expect(objects.objects).toHaveLength(1);
  });

  it('does not let one sender use up the daily limit for the real reporters', async () => {
    // Anyone can mail the public report address well-formed reports with invented ids.
    const forged = (n: number) =>
      'Content-Type: text/xml\r\n\r\n' +
      googleXml
        .replace('<org_name>google.com</org_name>', '<org_name>forged.example</org_name>')
        .replace('noreply-dmarc-support@google.com', 'dmarc@forged.example')
        .replace(
          '<report_id>4381273540812537241</report_id>',
          `<report_id>forged-${n}</report_id>`,
        );
    for (let n = 0; n < DMARC_DAILY_REPORT_LIMIT; n++) {
      await handleEmail(message(forged(n), undefined, 'dmarc@forged.example').message, env);
    }
    await handleEmail(message(googleEml).message, env);
    const stored = await reports();
    expect(stored.some((r) => r.org_name === 'google.com')).toBe(true);
    expect(stored.filter((r) => r.org_name === 'forged.example').length).toBeLessThan(
      DMARC_DAILY_REPORT_LIMIT,
    );
  });

  it('does not let a forger spend the share of a reporter it only names', async () => {
    // The envelope sender is whatever the forger types; Email Routing records what it verified.
    const forged = (n: number) =>
      'Content-Type: text/xml\r\n\r\n' +
      googleXml.replace(
        '<report_id>4381273540812537241</report_id>',
        `<report_id>forged-${n}</report_id>`,
      );
    const notCloudflare =
      'mx.evil.test; dkim=pass header.d=google.com; spf=pass smtp.mailfrom=noreply-dmarc-support@google.com';
    for (let n = 0; n < 12; n++) {
      // No trusted header, or only one the sender wrote itself.
      const auth = n % 2 === 0 ? [] : [notCloudflare];
      await handleEmail(message(forged(n), undefined, undefined, auth).message, env);
    }
    await handleEmail(message(googleEml).message, env);
    const stored = await reports();
    expect(stored.map((r) => r.report_id)).toContain('4381273540812537241');
    expect(stored.filter((r) => r.report_id.startsWith('forged-')).length).toBeLessThanOrEqual(
      DMARC_DAILY_UNAUTHENTICATED_REPORTS,
    );
  });

  it('does not let a MAIL FROM that Email Routing echoes pass for another reporter', async () => {
    // Email Routing echoes the envelope sender in its SPF result; one with ')' or '"' could
    // end the comment early and add a DKIM pass for google.com to the header.
    const mailfrom = '"a);dkim=pass header.d=google.com (b"@attacker.com';
    const auth =
      `mx.cloudflare.net; spf=pass (mx.cloudflare.net: domain of ${mailfrom} designates ` +
      `1.2.3.4 as permitted sender) smtp.mailfrom=${mailfrom}`;
    const forged = (n: number) =>
      'Content-Type: text/xml\r\n\r\n' +
      googleXml.replace(
        '<report_id>4381273540812537241</report_id>',
        `<report_id>forged-${n}</report_id>`,
      );
    for (let n = 0; n < 12; n++) {
      await handleEmail(message(forged(n), undefined, mailfrom, [auth]).message, env);
    }
    const stored = await reports();
    const reporters = await env.DB.prepare(
      'SELECT DISTINCT reporter_domain AS r FROM dmarc_reports WHERE sending_domain_id = ?1',
    )
      .bind(domainId)
      .all<{ r: string }>();
    expect(reporters.results.map((row) => row.r)).toEqual(['unauthenticated']);
    expect(stored).toHaveLength(DMARC_DAILY_UNAUTHENTICATED_REPORTS);
  });

  it('keeps part of the daily limit for reporters with a history for the domain', async () => {
    const now = Date.now();
    const days = DMARC_ESTABLISHED_REPORTER_DAYS;
    await env.DB.batch([
      ...Array.from({ length: days }, (_, n) =>
        seedReport('isp.example', `g-${n}`, now - (n + 2) * DAY_MS),
      ),
      ...Array.from({ length: DMARC_DAILY_NEW_REPORTER_LIMIT }, (_, n) =>
        seedReport(`rotated-${n}.example`, `r-${n}`, now - 60_000),
      ),
    ]);
    // A reporter new to the domain is dropped; one seen on earlier days still gets in.
    await handleEmail(message(yahooEml, undefined, 'dmarc@new.example').message, env);
    await handleEmail(message(googleEml, undefined, 'dmarc@isp.example').message, env);
    const stored = await reports();
    expect(stored.some((r) => r.org_name === 'Yahoo')).toBe(false);
    expect(stored.some((r) => r.org_name === 'google.com')).toBe(true);
  });

  it('does not let reporters warmed up for a day take the part kept for real ones', async () => {
    // A sender can pass DKIM for domains of its own: on day one, five reports from each of ten.
    const now = Date.now();
    const attackers = Array.from({ length: 10 }, (_, n) => `warm-${n}.example`);
    await env.DB.batch(
      attackers.flatMap((reporter) =>
        Array.from({ length: 5 }, (_, n) =>
          seedReport(reporter, `${reporter}-day1-${n}`, now - DAY_MS - 3600_000),
        ),
      ),
    );
    // Google and Microsoft have reported for the domain every day this week.
    await env.DB.batch(
      ['google.com', 'microsoft.com'].flatMap((reporter) =>
        Array.from({ length: 7 }, (_, n) => seedReport(reporter, `h-${n}`, now - (n + 2) * DAY_MS)),
      ),
    );
    // Day two: ten more from each, enough for the whole daily limit.
    const forged = (n: number) =>
      'Content-Type: text/xml\r\n\r\n' +
      googleXml.replace(
        '<report_id>4381273540812537241</report_id>',
        `<report_id>warm-${n}</report_id>`,
      );
    let n = 0;
    for (const reporter of attackers) {
      for (let i = 0; i < 10; i++) {
        await handleEmail(message(forged(n++), undefined, `dmarc@${reporter}`).message, env);
      }
    }
    await handleEmail(message(googleEml).message, env);
    await handleEmail(message(outlookEml, undefined, 'dmarcreport@microsoft.com').message, env);
    const stored = await reports();
    expect(stored.map((r) => r.report_id)).toContain('4381273540812537241');
    expect(stored.some((r) => r.org_name === 'Enterprise Outlook')).toBe(true);
  });

  it('keeps room for the big reporters after reporters warmed up for days fill the limit', async () => {
    // Ten domains of a sender's own, five reports a day each for three days: all established.
    const now = Date.now();
    const attackers = Array.from({ length: 10 }, (_, n) => `warm-${n}.example`);
    await env.DB.batch(
      attackers.flatMap((reporter) =>
        [1, 2, 3].flatMap((day) =>
          Array.from({ length: 5 }, (_, n) =>
            seedReport(reporter, `${reporter}-${day}-${n}`, now - day * DAY_MS - 3600_000),
          ),
        ),
      ),
    );
    // A smaller reporter with a history for the domain that hasn't reported yet today.
    await env.DB.batch(
      [1, 2, 3].map((day) => seedReport('isp.example', `isp-${day}`, now - day * DAY_MS)),
    );
    // Day four: ten from each attacker, the whole daily limit.
    await env.DB.batch(
      attackers.flatMap((reporter) =>
        Array.from({ length: DMARC_DAILY_REPORTS_PER_REPORTER }, (_, n) =>
          seedReport(reporter, `${reporter}-today-${n}`, now - 60_000),
        ),
      ),
    );
    const report = (id: string) =>
      'Content-Type: text/xml\r\n\r\n' +
      googleXml.replace(
        '<report_id>4381273540812537241</report_id>',
        `<report_id>${id}</report_id>`,
      );
    await handleEmail(message(googleEml).message, env);
    await handleEmail(message(outlookEml, undefined, 'dmarcreport@microsoft.com').message, env);
    await handleEmail(message(report('isp-today'), undefined, 'dmarc@isp.example').message, env);
    // The attackers, and a domain new to the domain, get nothing more.
    await handleEmail(
      message(report('warm-extra'), undefined, 'dmarc@warm-0.example').message,
      env,
    );
    await handleEmail(message(report('new-today'), undefined, 'dmarc@new.example').message, env);
    const ids = (await reports()).map((r) => r.report_id);
    expect(ids).toContain('4381273540812537241');
    expect((await reports()).some((r) => r.org_name === 'Enterprise Outlook')).toBe(true);
    expect(ids).toContain('isp-today');
    expect(ids).not.toContain('warm-extra');
    expect(ids).not.toContain('new-today');
  });

  it('does not give a free mailbox account the share kept for the big reporters', async () => {
    // Anyone with a free Yahoo, Outlook.com or Fastmail account passes DKIM as that provider.
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: DMARC_DAILY_REPORT_LIMIT }, (_, n) =>
        seedReport(`filler-${n % 10}.example`, `filler-${n}`, now - 60_000),
      ),
    );
    const report = (id: string) =>
      'Content-Type: text/xml\r\n\r\n' +
      googleXml.replace(
        '<report_id>4381273540812537241</report_id>',
        `<report_id>${id}</report_id>`,
      );
    for (const from of ['someone@yahoo.com', 'someone@outlook.com', 'someone@fastmail.com']) {
      await handleEmail(message(report(from), undefined, from).message, env);
    }
    const consumer = `mx.cloudflare.net; dkim=pass header.d=messagingengine.com header.s=fm1 header.b=abc; dmarc=pass header.from=custom.example policy.dmarc=none; spf=pass (mx.cloudflare.net: domain of someone@custom.example designates 1.2.3.4 as permitted sender) smtp.mailfrom=someone@custom.example`;
    await handleEmail(
      message(report('fastmail-custom'), undefined, 'someone@custom.example', [consumer]).message,
      env,
    );
    // Google's own report still gets its share.
    await handleEmail(message(googleEml).message, env);
    const ids = (await reports()).map((r) => r.report_id);
    expect(ids.filter((id) => !id.startsWith('filler-'))).toEqual(['4381273540812537241']);
  });

  it('still holds a big reporter to its own daily share', async () => {
    const report = (id: string) =>
      'Content-Type: text/xml\r\n\r\n' +
      googleXml.replace(
        '<report_id>4381273540812537241</report_id>',
        `<report_id>${id}</report_id>`,
      );
    for (let n = 0; n < DMARC_DAILY_REPORTS_PER_REPORTER + 2; n++) {
      await handleEmail(message(report(`g-${n}`)).message, env);
    }
    expect(await reports()).toHaveLength(DMARC_DAILY_REPORTS_PER_REPORTER);
  });

  it('deletes reports with their sending domain', async () => {
    await handleEmail(message(yahooEml).message, env);
    expect(await reports()).toHaveLength(1);
    await env.DB.prepare('DELETE FROM sending_domains WHERE id = ?1').bind(domainId).run();
    const left = await env.DB.prepare('SELECT count(*) AS n FROM dmarc_records').first<{
      n: number;
    }>();
    expect(left?.n).toBe(0);
  });
});
