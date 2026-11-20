/**
 * DMARC aggregate reports (RFC 7489 appendix C, and the DMARCbis 2.0 namespace): a bounded XML
 * reader, the report model, per-record alignment, and ingestion into dmarc_reports and
 * dmarc_records with the raw file kept in R2 REPORTS.
 *
 * The XML reader lives in @swarm/mail/xml, and refuses any DOCTYPE. Feed Sync uses it too.
 */
import { isUniqueViolation } from '@swarm/db';
import { DMARC_RUA_LOCAL_PREFIX, idPattern } from '@swarm/domain';
import { XmlInputError, parseXml as readXml, type XmlElement } from '@swarm/mail/xml';
import type { AuthenticatedDomains } from './auth-results';
import { first, newIdFor } from './db';
import {
  DmarcInputError,
  decompressReport,
  extractReportAttachment,
  type ReportAttachment,
} from './dmarc-mime';

// ---- XML -----------------------------------------------------------------------------------

export type { XmlElement };

/** Parses an XML document. Throws DmarcInputError on anything malformed. */
export function parseXml(xml: string, label?: string): XmlElement {
  try {
    return readXml(xml, label);
  } catch (error) {
    if (error instanceof XmlInputError) throw new DmarcInputError(error.message);
    throw error;
  }
}

const child = (el: XmlElement | undefined, name: string) =>
  el?.children.find((c) => c.name === name);
const children = (el: XmlElement | undefined, name: string) =>
  el?.children.filter((c) => c.name === name) ?? [];
const text = (el: XmlElement | undefined, name: string): string | null => {
  const value = child(el, name)?.text.trim();
  return value ? value : null;
};

// ---- Report model --------------------------------------------------------------------------

export type Disposition = 'none' | 'quarantine' | 'reject';
type AuthResult = string;

export interface DmarcPolicyPublished {
  domain: string;
  adkim: 'r' | 's';
  aspf: 'r' | 's';
  p: string | null;
  sp: string | null;
  pct: number | null;
}

export interface DmarcRecord {
  sourceIp: string;
  count: number;
  disposition: Disposition;
  /** policy_evaluated, when the reporter filled it in. */
  evaluatedDkim: AuthResult | null;
  evaluatedSpf: AuthResult | null;
  headerFrom: string;
  envelopeFrom: string | null;
  dkim: { domain: string; selector: string | null; result: AuthResult }[];
  spf: { domain: string; scope: string | null; result: AuthResult }[];
}

export interface DmarcAggregateReport {
  orgName: string;
  email: string | null;
  reportId: string;
  /** Unix seconds, as in the XML. */
  begin: number;
  end: number;
  policy: DmarcPolicyPublished;
  records: DmarcRecord[];
}

const lower = (value: string | null) => (value ? value.toLowerCase() : null);

/** Strips a trailing dot and lowercases; the reporters disagree on both. */
const normaliseDomain = (value: string) => value.trim().replace(/\.$/, '').toLowerCase();

function toInt(value: string | null, what: string): number {
  if (value === null || !/^\d{1,12}$/.test(value)) {
    throw new DmarcInputError(`report XML: ${what} is not a number`);
  }
  return Number(value);
}

function disposition(value: string | null): Disposition {
  return value === 'quarantine' || value === 'reject' ? value : 'none';
}

/** The aggregate report in an XML document. */
export function parseAggregateReport(xml: string): DmarcAggregateReport {
  const feedback = parseXml(xml);
  if (feedback.name !== 'feedback') throw new DmarcInputError('report XML: not a <feedback>');
  const metadata = child(feedback, 'report_metadata');
  const range = child(metadata, 'date_range');
  const published = child(feedback, 'policy_published');
  const orgName = text(metadata, 'org_name');
  const reportId = text(metadata, 'report_id');
  const policyDomain = text(published, 'domain');
  if (!orgName || !reportId) throw new DmarcInputError('report XML: missing org_name or report_id');
  if (!policyDomain) throw new DmarcInputError('report XML: missing policy_published domain');
  const begin = toInt(text(range, 'begin'), 'date_range begin');
  const end = toInt(text(range, 'end'), 'date_range end');
  const pct = text(published, 'pct');

  const records = children(feedback, 'record').map((record): DmarcRecord => {
    const row = child(record, 'row');
    const evaluated = child(row, 'policy_evaluated');
    const identifiers = child(record, 'identifiers');
    const auth = child(record, 'auth_results');
    const sourceIp = text(row, 'source_ip');
    if (!sourceIp) throw new DmarcInputError('report XML: record without source_ip');
    return {
      sourceIp: sourceIp.toLowerCase(),
      count: toInt(text(row, 'count'), 'record count'),
      disposition: disposition(lower(text(evaluated, 'disposition'))),
      evaluatedDkim: lower(text(evaluated, 'dkim')),
      evaluatedSpf: lower(text(evaluated, 'spf')),
      headerFrom: normaliseDomain(text(identifiers, 'header_from') ?? policyDomain),
      envelopeFrom: lower(text(identifiers, 'envelope_from')),
      dkim: children(auth, 'dkim').map((d) => ({
        domain: normaliseDomain(text(d, 'domain') ?? ''),
        selector: text(d, 'selector'),
        result: lower(text(d, 'result')) ?? 'none',
      })),
      spf: children(auth, 'spf').map((s) => ({
        domain: normaliseDomain(text(s, 'domain') ?? ''),
        scope: lower(text(s, 'scope')),
        result: lower(text(s, 'result')) ?? 'none',
      })),
    };
  });

  return {
    orgName,
    email: text(metadata, 'email'),
    reportId,
    begin,
    end,
    policy: {
      domain: normaliseDomain(policyDomain),
      adkim: lower(text(published, 'adkim')) === 's' ? 's' : 'r',
      aspf: lower(text(published, 'aspf')) === 's' ? 's' : 'r',
      p: lower(text(published, 'p')),
      sp: lower(text(published, 'sp')),
      pct: pct && /^\d{1,3}$/.test(pct) ? Number(pct) : null,
    },
    records,
  };
}

// ---- Alignment -----------------------------------------------------------------------------

/**
 * Public suffixes of two labels that mail commonly comes from. Not the whole Public Suffix List:
 * a suffix missing here makes two domains under it look like one organisation.
 */
const MULTI_LABEL_SUFFIXES = new Set(
  [
    'co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk',
    'co.jp ne.jp or.jp ac.jp go.jp',
    'com.au net.au org.au edu.au gov.au',
    'com.br net.br org.br gov.br',
    'co.nz net.nz org.nz govt.nz',
    'co.za org.za',
    'com.mx org.mx gob.mx',
    'co.in net.in org.in gov.in',
    'com.cn net.cn org.cn com.hk com.tw com.sg com.my co.kr or.kr co.id co.th',
    'com.ar com.co com.tr co.il com.ua',
  ]
    .join(' ')
    .split(' '),
);

/**
 * The organisational domain: the last two labels, or three under a suffix in
 * MULTI_LABEL_SUFFIXES. lookupDmarc (domains.ts) still takes the last two.
 */
export function organisationalDomain(domain: string): string {
  const labels = domain.split('.');
  const take = labels.length > 2 && MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-take).join('.');
}

export function identifierAligned(authDomain: string, headerFrom: string, mode: 'r' | 's') {
  if (!authDomain) return false;
  if (mode === 's') return authDomain === headerFrom;
  return organisationalDomain(authDomain) === organisationalDomain(headerFrom);
}

/**
 * DKIM and SPF alignment for a record. policy_evaluated is the reporter's own DMARC verdict and
 * wins when present; otherwise a passing auth result whose domain aligns with header_from counts.
 */
export function recordAlignment(
  record: DmarcRecord,
  policy: Pick<DmarcPolicyPublished, 'adkim' | 'aspf'>,
): { dkimAligned: boolean; spfAligned: boolean } {
  const verdict = (value: AuthResult | null) =>
    value === 'pass' ? true : value === 'fail' ? false : null;
  const dkimFromAuth = record.dkim.some(
    (d) => d.result === 'pass' && identifierAligned(d.domain, record.headerFrom, policy.adkim),
  );
  // SPF is checked on the MAIL FROM identity; a HELO-scoped result never aligns.
  const spfFromAuth = record.spf.some(
    (s) =>
      s.result === 'pass' &&
      s.scope !== 'helo' &&
      identifierAligned(s.domain, record.headerFrom, policy.aspf),
  );
  return {
    dkimAligned: verdict(record.evaluatedDkim) ?? dkimFromAuth,
    spfAligned: verdict(record.evaluatedSpf) ?? spfFromAuth,
  };
}

// ---- Ingestion -----------------------------------------------------------------------------

/** Rows kept per report after merging identical ones; counts beyond it still reach the totals. */
export const DMARC_MAX_ROWS = 2000;

/**
 * Reports stored per sending domain in any 24 hours; more are dropped. The report address is
 * public, so this bounds what anyone can make Swarm store. Real reporters send about one report
 * a day each. MAJOR_DMARC_REPORTERS and DMARC_DAILY_RETURNING_REPORTER_RESERVE are on top.
 */
export const DMARC_DAILY_REPORT_LIMIT = 100;

/**
 * Within that limit, reports stored per reporter (the organisational domain Email Routing
 * authenticated, see dmarcReporter) in any 24 hours, so one sender can't use up the whole day's
 * limit.
 */
export const DMARC_DAILY_REPORTS_PER_REPORTER = 10;

/** The reporter_domain of reports with no authenticated domain, which share one small limit. */
export const DMARC_UNAUTHENTICATED_REPORTER = 'unauthenticated';

/** Reports with no authenticated domain stored per sending domain in any 24 hours, together. */
export const DMARC_DAILY_UNAUTHENTICATED_REPORTS = 5;

/**
 * Reporters without a history for the domain (see DMARC_ESTABLISHED_REPORTER_DAYS) stop once the
 * domain has this many reports today. The rest of the daily limit is kept for established
 * reporters, so senders that rotate domains can't crowd out Google's or Microsoft's daily report.
 */
export const DMARC_DAILY_NEW_REPORTER_LIMIT = 50;

/**
 * A reporter is established once it has reports for the domain on this many distinct days (UTC)
 * in the 30 days before today. One earlier report isn't enough: a sender could store a few from
 * each of its own domains one day and fill the whole limit the next.
 */
export const DMARC_ESTABLISHED_REPORTER_DAYS = 3;

/**
 * Past the daily limit, this many more reports a day for established reporters that haven't
 * reported yet today, so reporters a sender kept warm for days can't take a smaller real
 * reporter's daily report as well as the limit.
 */
export const DMARC_DAILY_RETURNING_REPORTER_RESERVE = 20;

/**
 * The big mailbox providers' reporters, as the exact domain of a DKIM or SPF pass. Each keeps its
 * own DMARC_DAILY_REPORTS_PER_REPORTER outside DMARC_DAILY_REPORT_LIMIT, which their reports
 * don't count towards, so no other sender can fill the day before Google's or Microsoft's report
 * arrives. Only identities no consumer can authenticate as belong here: a free Yahoo, Outlook.com,
 * Mail.ru, Yandex, Zoho, Fastmail or Comcast account signs its mail as the provider's domain, so
 * listing those would let anyone with an account store reports outside the shared limit. Gmail
 * mail is signed gmail.com, not google.com, and Outlook.com mail outlook.com, not microsoft.com.
 */
export const MAJOR_DMARC_REPORTERS: readonly string[] = ['google.com', 'microsoft.com'];

const DMARC_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Sending services whose own domains sign or carry mail for all their customers: SES adds a
 * DKIM signature by amazonses.com and its default MAIL FROM is under it, and so on.
 */
const SHARED_SENDING_DOMAINS = [
  'amazonses.com',
  'sendgrid.net',
  'mailgun.org',
  'mcsv.net',
  'sparkpostmail.com',
];

/** Whether a domain is one of SHARED_SENDING_DOMAINS or under one. */
export const isSharedSendingDomain = (domain: string) =>
  SHARED_SENDING_DOMAINS.some((shared) => domain === shared || domain.endsWith(`.${shared}`));

/**
 * Who the per-reporter limit counts a report against: the organisational domain of a DKIM
 * signature that passed, or else of the SPF identity that passed. The envelope sender alone is
 * whatever the sender typed, so naming google.com there must not spend Google's share. A shared
 * sending service's domain is used only when nothing else passed, and then as the full host, so
 * its customers don't all share one reporter's limit. A pass as exactly one of
 * MAJOR_DMARC_REPORTERS is keyed as that reporter. With nothing authenticated,
 * DMARC_UNAUTHENTICATED_REPORTER.
 */
export function dmarcReporter(authenticated: AuthenticatedDomains): string {
  const passed = [...authenticated.dkim, ...(authenticated.spf ? [authenticated.spf] : [])];
  const major = passed.find((domain) => MAJOR_DMARC_REPORTERS.includes(domain));
  if (major) return major;
  const own = passed.find((domain) => !isSharedSendingDomain(domain));
  if (own) {
    // A subdomain of a big reporter isn't that reporter: keep it apart from the reserved share.
    const organisational = organisationalDomain(own);
    return MAJOR_DMARC_REPORTERS.includes(organisational) ? own : organisational;
  }
  return passed[0] ?? DMARC_UNAUTHENTICATED_REPORTER;
}

const SENDING_DOMAIN_ID = idPattern('sendingDomain');

/** dmarc+<sendingDomainId>@<mailDomain>, case-insensitive; null for anything else. */
export function dmarcDomainIdFromAddress(address: string, mailDomain: string): string | null {
  const at = address.trim().toLowerCase().lastIndexOf('@');
  if (at < 0) return null;
  const local = address.trim().toLowerCase().slice(0, at);
  const domain = address
    .trim()
    .toLowerCase()
    .slice(at + 1);
  if (domain !== mailDomain.toLowerCase() || !local.startsWith(DMARC_RUA_LOCAL_PREFIX)) return null;
  const id = local.slice(DMARC_RUA_LOCAL_PREFIX.length);
  return SENDING_DOMAIN_ID.test(id) ? id : null;
}

export const dmarcReportAddress = (sendingDomainId: string, mailDomain: string) =>
  `${DMARC_RUA_LOCAL_PREFIX}${sendingDomainId}@${mailDomain}`;

export type DmarcIngestResult =
  | { status: 'stored'; reportId: string; records: number; messages: number }
  | { status: 'duplicate'; reportId: string }
  | { status: 'dropped'; reason: string };

interface MergedRow {
  sourceIp: string;
  count: number;
  disposition: Disposition;
  dkimAligned: boolean;
  spfAligned: boolean;
  headerFrom: string;
  dkimDomain: string | null;
  spfDomain: string | null;
}

/** One row per distinct outcome; the largest first so a cut keeps the most mail. */
export function mergeRecords(report: DmarcAggregateReport): MergedRow[] {
  const rows = new Map<string, MergedRow>();
  for (const record of report.records) {
    const { dkimAligned, spfAligned } = recordAlignment(record, report.policy);
    const dkimDomain =
      record.dkim.find((d) => d.result === 'pass')?.domain ?? record.dkim[0]?.domain ?? null;
    const spfDomain =
      record.spf.find((s) => s.result === 'pass')?.domain ?? record.spf[0]?.domain ?? null;
    const key = [
      record.sourceIp,
      record.disposition,
      dkimAligned,
      spfAligned,
      record.headerFrom,
      dkimDomain,
      spfDomain,
    ].join('|');
    const row = rows.get(key);
    if (row) row.count += record.count;
    else
      rows.set(key, {
        sourceIp: record.sourceIp,
        count: record.count,
        disposition: record.disposition,
        dkimAligned,
        spfAligned,
        headerFrom: record.headerFrom,
        dkimDomain: dkimDomain || null,
        spfDomain: spfDomain || null,
      });
  }
  return [...rows.values()].sort((a, b) => b.count - a.count);
}

const EXTENSION: Record<ReportAttachment['format'], string> = {
  zip: 'zip',
  gzip: 'xml.gz',
  xml: 'xml',
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface DmarcIngestDeps {
  db: D1Database;
  /** R2 REPORTS: raw report files, private. */
  reports: R2Bucket;
}

/** Records per multi-row INSERT: 9 × 10 bound values stays under D1's 100-parameter limit. */
const ROWS_PER_INSERT = 9;

/**
 * Stores one report message for a sending domain. Bad input is never thrown: it comes back as
 * `dropped` with a reason to log, so the mail is accepted and the reporter doesn't retry. Storage
 * errors (D1, R2) do throw, which lets Email Routing try again later.
 */
export async function ingestDmarcMessage(
  deps: DmarcIngestDeps,
  /** authenticated: what Email Routing verified (authenticatedDomains), which keys the reporter. */
  input: {
    sendingDomainId: string;
    authenticated: AuthenticatedDomains;
    raw: Uint8Array;
    now?: number;
  },
): Promise<DmarcIngestResult> {
  const now = input.now ?? Date.now();
  const domain = await first<{ id: string; workspace_id: string; domain: string }>(
    deps.db,
    `SELECT id, workspace_id, domain FROM sending_domains WHERE id = ?1 AND kind = 'email'`,
    input.sendingDomainId,
  );
  if (!domain) return { status: 'dropped', reason: 'unknown sending domain' };
  // Before parsing or storing anything, so mail past the limit costs almost nothing. A sender
  // only spends the share of a domain it passed SPF or DKIM for.
  const reporter = dmarcReporter(input.authenticated);
  const unauthenticated = reporter === DMARC_UNAUTHENTICATED_REPORTER;
  const major = MAJOR_DMARC_REPORTERS.includes(reporter);
  const dayAgo = now - 24 * 60 * 60 * 1000;
  // total leaves out the big reporters, whose share is kept outside the daily limit.
  const today = await first<{ total: number | null; mine: number | null; days: number }>(
    deps.db,
    `SELECT sum(coalesce(reporter_domain, '') NOT IN (SELECT value FROM json_each(?5))) AS total,
       sum(reporter_domain = ?3) AS mine,
       (SELECT count(DISTINCT k.created_at / 86400000) FROM dmarc_reports k
         WHERE k.sending_domain_id = ?1 AND k.reporter_domain = ?3
           AND k.created_at <= ?2 AND k.created_at > ?4) AS days
     FROM dmarc_reports WHERE sending_domain_id = ?1 AND created_at > ?2`,
    domain.id,
    dayAgo,
    reporter,
    now - DMARC_HISTORY_WINDOW_MS,
    JSON.stringify(MAJOR_DMARC_REPORTERS),
  );
  const established =
    major || (!unauthenticated && (today?.days ?? 0) >= DMARC_ESTABLISHED_REPORTER_DAYS);
  const total = today?.total ?? 0;
  // An established reporter's first report today may use the small reserve past the limit.
  const limit =
    established && !today?.mine
      ? DMARC_DAILY_REPORT_LIMIT + DMARC_DAILY_RETURNING_REPORTER_RESERVE
      : DMARC_DAILY_REPORT_LIMIT;
  if (!major && total >= limit) {
    return { status: 'dropped', reason: 'daily report limit reached' };
  }
  const share = unauthenticated
    ? DMARC_DAILY_UNAUTHENTICATED_REPORTS
    : DMARC_DAILY_REPORTS_PER_REPORTER;
  if ((today?.mine ?? 0) >= share) {
    return {
      status: 'dropped',
      reason: unauthenticated
        ? 'daily report limit for unauthenticated reports reached'
        : 'daily report limit for this reporter reached',
    };
  }
  if (!established && total >= DMARC_DAILY_NEW_REPORTER_LIMIT) {
    return { status: 'dropped', reason: 'daily report limit for new reporters reached' };
  }

  let attachment: ReportAttachment;
  let report: DmarcAggregateReport;
  try {
    attachment = extractReportAttachment(input.raw);
    report = parseAggregateReport(await decompressReport(attachment));
  } catch (error) {
    if (error instanceof DmarcInputError) return { status: 'dropped', reason: error.message };
    throw error;
  }
  if (report.policy.domain !== domain.domain.toLowerCase()) {
    return {
      status: 'dropped',
      reason: `report is for ${report.policy.domain}, not ${domain.domain}`,
    };
  }
  if (report.end < report.begin) return { status: 'dropped', reason: 'date range is reversed' };

  const existing = await first<{ id: string }>(
    deps.db,
    'SELECT id FROM dmarc_reports WHERE sending_domain_id = ?1 AND org_name = ?2 AND report_id = ?3',
    domain.id,
    report.orgName,
    report.reportId,
  );
  if (existing) return { status: 'duplicate', reportId: existing.id };

  const merged = mergeRecords(report);
  const kept = merged.slice(0, DMARC_MAX_ROWS);
  const messages = merged.reduce((sum, row) => sum + row.count, 0);
  const passed = merged
    .filter((row) => row.dkimAligned || row.spfAligned)
    .reduce((sum, row) => sum + row.count, 0);

  const day = new Date(report.begin * 1000).toISOString().slice(0, 10);
  const rawKey = `dmarc/${domain.id}/${day}/${await sha256Hex(attachment.bytes)}.${EXTENSION[attachment.format]}`;
  await deps.reports.put(rawKey, attachment.bytes, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { org: report.orgName.slice(0, 200), report: report.reportId.slice(0, 200) },
  });

  const reportRowId = newIdFor('dmarcReport', now);
  const statements: D1PreparedStatement[] = [
    deps.db
      .prepare(
        `INSERT INTO dmarc_reports (id, workspace_id, sending_domain_id, org_name, report_id, begin_at, end_at,
           policy_json, raw_key, message_count, pass_count, created_at, reporter_domain)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .bind(
        reportRowId,
        domain.workspace_id,
        domain.id,
        report.orgName,
        report.reportId,
        report.begin * 1000,
        report.end * 1000,
        JSON.stringify(report.policy),
        rawKey,
        messages,
        passed,
        now,
        reporter,
      ),
  ];
  for (let i = 0; i < kept.length; i += ROWS_PER_INSERT) {
    const chunk = kept.slice(i, i + ROWS_PER_INSERT);
    const values = chunk
      .map((_, n) => {
        const b = n * 10;
        return `(?${b + 1}, ?${b + 2}, ?${b + 3}, ?${b + 4}, ?${b + 5}, ?${b + 6}, ?${b + 7}, ?${b + 8}, ?${b + 9}, ?${b + 10})`;
      })
      .join(', ');
    statements.push(
      deps.db
        .prepare(
          `INSERT INTO dmarc_records (id, report_id, source_ip, count, disposition, dkim_aligned, spf_aligned,
             header_from, dkim_domain, spf_domain) VALUES ${values}`,
        )
        .bind(
          ...chunk.flatMap((row) => [
            newIdFor('dmarcRecord', now),
            reportRowId,
            row.sourceIp.slice(0, 64),
            row.count,
            row.disposition,
            row.dkimAligned ? 1 : 0,
            row.spfAligned ? 1 : 0,
            row.headerFrom.slice(0, 253),
            row.dkimDomain?.slice(0, 253) ?? null,
            row.spfDomain?.slice(0, 253) ?? null,
          ]),
        ),
    );
  }
  try {
    // One batch is one transaction: a report is stored with all its rows or not at all.
    await deps.db.batch(statements);
  } catch (error) {
    // A copy of the same report delivered at the same moment won the race.
    if (isUniqueViolation(error)) {
      return { status: 'duplicate', reportId: reportRowId };
    }
    throw error;
  }
  return { status: 'stored', reportId: reportRowId, records: kept.length, messages };
}
