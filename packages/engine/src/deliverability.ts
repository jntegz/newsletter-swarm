/**
 * Deliverability Center reads (Phase 7): DMARC alignment per sending domain, the
 * per-mailbox-provider breakdown of deliveries, complaint rates against Gmail's thresholds and
 * Reputation Ramp history. Every query is bounded by a Channel or domain and a date range of at
 * most DELIVERABILITY_MAX_DAYS, and uses an index on that pair (docs/deliverability.md).
 */
import {
  DELIVERABILITY_DEFAULT_DAYS,
  DELIVERABILITY_MAX_DAYS,
  DMARC_FAILING_SOURCES_LIMIT,
  GMAIL_COMPLAINT_TARGET,
  GMAIL_COMPLAINT_THRESHOLD,
  MAILBOX_PROVIDERS,
  type ComplaintStanding,
  type ComplaintSummary,
  type DmarcFailingSource,
  type MailboxProvider,
  type ProviderStats,
  type RampHistory,
} from '@swarm/domain';
import { all, first } from './db';

const DAY_MS = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface DayRange {
  from: string;
  to: string;
  /** Inclusive start, exclusive end (the day after `to`), in ms. */
  startMs: number;
  endMs: number;
}

/**
 * A whole-day UTC range from optional YYYY-MM-DD bounds: the last 30 days by default, never more
 * than 366 days. Returns the problem as a string for an invalid range.
 */
export function deliverabilityRange(
  query: { from?: string | undefined; to?: string | undefined },
  now = Date.now(),
): DayRange | string {
  const to = query.to ?? dayOf(now);
  const endMs = Date.parse(`${to}T00:00:00Z`) + DAY_MS;
  const from = query.from ?? dayOf(endMs - DELIVERABILITY_DEFAULT_DAYS * DAY_MS);
  const startMs = Date.parse(`${from}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 'Choose a start and an end date.';
  // Date.parse rolls 2026-02-31 over to March; refuse dates that don't exist.
  if (dayOf(startMs) !== from || dayOf(endMs - DAY_MS) !== to) {
    return 'Use real dates such as 2026-10-27.';
  }
  if (startMs >= endMs) return 'The start date is after the end date.';
  if ((endMs - startMs) / DAY_MS > DELIVERABILITY_MAX_DAYS) {
    return `Choose a range of up to ${DELIVERABILITY_MAX_DAYS} days.`;
  }
  return { from, to, startMs, endMs };
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);

export function complaintStanding(rate: number | null): ComplaintStanding {
  if (rate === null || rate < GMAIL_COMPLAINT_TARGET) return 'good';
  return rate >= GMAIL_COMPLAINT_THRESHOLD ? 'over' : 'watch';
}

// ---- Mailbox providers ---------------------------------------------------------------------

/**
 * Recipient domains per provider. Exact domains, plus country variants of the big brands
 * (hotmail.co.uk, yahoo.fr, live.com.au …): the brand, then a two-letter code, or co. / com.
 * and a two-letter code.
 */
export const MAILBOX_DOMAINS: Record<Exclude<MailboxProvider, 'other'>, string[]> = {
  gmail: ['gmail.com', 'googlemail.com'],
  outlook: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com', 'windowslive.com'],
  yahoo: ['yahoo.com', 'ymail.com', 'rocketmail.com', 'aol.com', 'aim.com', 'yahoodns.net'],
  apple: ['icloud.com', 'me.com', 'mac.com'],
};
export const MAILBOX_BRANDS: Partial<Record<MailboxProvider, string[]>> = {
  outlook: ['outlook', 'hotmail', 'live'],
  yahoo: ['yahoo', 'aol'],
};

const countryVariant = (brand: string) => new RegExp(`^${brand}\\.(?:(?:co|com)\\.)?[a-z]{2}$`);

/** The provider for a recipient address or domain. The SQL below mirrors it exactly. */
export function classifyMailbox(addressOrDomain: string): MailboxProvider {
  const domain = addressOrDomain.slice(addressOrDomain.lastIndexOf('@') + 1).toLowerCase();
  for (const provider of MAILBOX_PROVIDERS) {
    if (provider === 'other') continue;
    if (MAILBOX_DOMAINS[provider].includes(domain)) return provider;
    if (MAILBOX_BRANDS[provider]?.some((brand) => countryVariant(brand).test(domain))) {
      return provider;
    }
  }
  return 'other';
}

const sqlList = (values: string[]) => values.map((v) => `'${v}'`).join(', ');

/** The CASE expression over `dom` (a lowercased recipient domain) that classifyMailbox mirrors. */
export function mailboxProviderSql(dom = 'dom'): string {
  const arms = MAILBOX_PROVIDERS.filter((p) => p !== 'other').map((provider) => {
    const tests = [
      `${dom} IN (${sqlList(MAILBOX_DOMAINS[provider as Exclude<MailboxProvider, 'other'>])})`,
    ];
    for (const brand of MAILBOX_BRANDS[provider] ?? []) {
      tests.push(
        `${dom} GLOB '${brand}.[a-z][a-z]'`,
        `${dom} GLOB '${brand}.co.[a-z][a-z]'`,
        `${dom} GLOB '${brand}.com.[a-z][a-z]'`,
      );
    }
    return `WHEN ${tests.join(' OR ')} THEN '${provider}'`;
  });
  return `CASE ${arms.join(' ')} ELSE 'other' END`;
}

const PROVIDER_SQL = mailboxProviderSql();

/**
 * Deliveries of one Channel sent in the range, by recipient mailbox provider. Failed sends never
 * reached a provider and are left out. Delivered includes messages later complained about.
 * Bounced counts hard bounces and blocks; blocked is the share of those the provider refused
 * because of the sender (bounce_type 'blocked:<cause>', feedback.ts).
 */
export async function providerBreakdown(
  db: D1Database,
  channelId: string,
  range: DayRange,
): Promise<ProviderStats[]> {
  // deliveries_recent_by_channel (channel_id, sent_at) bounds the scan to the range.
  const rows = await all<{
    provider: MailboxProvider;
    sent: number;
    delivered: number;
    bounced: number;
    blocked: number;
    complained: number;
    opened: number;
  }>(
    db,
    `SELECT provider, count(*) AS sent,
            coalesce(sum(delivered), 0) AS delivered,
            coalesce(sum(status = 'bounced'), 0) AS bounced,
            coalesce(sum(status = 'bounced' AND bounce_type LIKE 'blocked:%'), 0) AS blocked,
            coalesce(sum(status = 'complained'), 0) AS complained,
            coalesce(sum(opened), 0) AS opened
       FROM (SELECT ${PROVIDER_SQL} AS provider, status, bounce_type,
                    (status IN ('delivered', 'complained') OR delivered_at IS NOT NULL) AS delivered,
                    (human_opened_at IS NOT NULL) AS opened
               FROM (SELECT lower(substr(email, instr(email, '@') + 1)) AS dom, status, bounce_type, delivered_at, human_opened_at
                       FROM deliveries
                      WHERE channel_id = ?1 AND sent_at >= ?2 AND sent_at < ?3 AND status != 'failed'))
      GROUP BY provider`,
    channelId,
    range.startMs,
    range.endMs,
  );
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  return MAILBOX_PROVIDERS.map((provider): ProviderStats => {
    const row = byProvider.get(provider) ?? {
      sent: 0,
      delivered: 0,
      bounced: 0,
      blocked: 0,
      complained: 0,
      opened: 0,
    };
    const complaintRate = ratio(row.complained, row.delivered);
    return {
      provider,
      sent: row.sent,
      delivered: row.delivered,
      bounced: row.bounced,
      blocked: row.blocked,
      complained: row.complained,
      opened: row.opened,
      bounceRate: ratio(row.bounced, row.sent),
      complaintRate,
      openRate: ratio(row.opened, row.delivered),
      complaintStanding: complaintStanding(complaintRate),
    };
  });
}

export function complaintSummary(providers: ProviderStats[]): ComplaintSummary {
  const delivered = providers.reduce((sum, p) => sum + p.delivered, 0);
  const complained = providers.reduce((sum, p) => sum + p.complained, 0);
  const rate = ratio(complained, delivered);
  return {
    delivered,
    complained,
    rate,
    target: GMAIL_COMPLAINT_TARGET,
    threshold: GMAIL_COMPLAINT_THRESHOLD,
    standing: complaintStanding(rate),
  };
}

// ---- DMARC ---------------------------------------------------------------------------------

export interface DomainDmarcTotals {
  id: string;
  domain: string;
  status: 'pending' | 'verified' | 'failed';
  dmarc_policy: 'none' | 'quarantine' | 'reject' | null;
  last_report_at: number | null;
  messages: number;
  aligned: number;
}

/** Every email sending domain of a Channel with its report totals in the range. */
export async function channelDmarcTotals(
  db: D1Database,
  channelId: string,
  range: DayRange,
): Promise<DomainDmarcTotals[]> {
  return all<DomainDmarcTotals>(
    db,
    `SELECT sd.id, sd.domain, sd.status, sd.dmarc_policy,
            (SELECT max(lr.created_at) FROM dmarc_reports lr WHERE lr.sending_domain_id = sd.id) AS last_report_at,
            coalesce(sum(r.message_count), 0) AS messages,
            coalesce(sum(r.pass_count), 0) AS aligned
       FROM sending_domains sd
       LEFT JOIN dmarc_reports r ON r.sending_domain_id = sd.id AND r.begin_at >= ?2 AND r.begin_at < ?3
      WHERE sd.channel_id = ?1 AND sd.kind = 'email'
      GROUP BY sd.id
      ORDER BY sd.created_at`,
    channelId,
    range.startMs,
    range.endMs,
  );
}

export interface DomainDmarcDetail {
  lastReportAt: number | null;
  totals: { messages: number; aligned: number };
  byDay: { day: string; aligned: number; failed: number }[];
  failingSources: DmarcFailingSource[];
  reporters: { orgName: string; reports: number; messages: number; lastReportAt: number }[];
}

export async function domainDmarcDetail(
  db: D1Database,
  sendingDomainId: string,
  range: DayRange,
): Promise<DomainDmarcDetail> {
  const args = [sendingDomainId, range.startMs, range.endMs] as const;
  // dmarc_reports_by_domain (sending_domain_id, begin_at) bounds every read to the range.
  const [days, sources, reporters, last] = await Promise.all([
    all<{ day: string; aligned: number; messages: number }>(
      db,
      `SELECT strftime('%Y-%m-%d', begin_at / 1000, 'unixepoch') AS day,
              sum(pass_count) AS aligned, sum(message_count) AS messages
         FROM dmarc_reports
        WHERE sending_domain_id = ?1 AND begin_at >= ?2 AND begin_at < ?3
        GROUP BY day ORDER BY day`,
      ...args,
    ),
    all<{
      source_ip: string;
      count: number;
      disposition: DmarcFailingSource['disposition'];
      spf_aligned: number;
      dkim_aligned: number;
      header_from: string;
      reporters: string;
    }>(
      db,
      `SELECT rec.source_ip, sum(rec.count) AS count, rec.disposition, rec.spf_aligned, rec.dkim_aligned,
              rec.header_from, json_group_array(DISTINCT r.org_name) AS reporters
         FROM dmarc_reports r JOIN dmarc_records rec ON rec.report_id = r.id
        WHERE r.sending_domain_id = ?1 AND r.begin_at >= ?2 AND r.begin_at < ?3
          AND (rec.spf_aligned = 0 OR rec.dkim_aligned = 0)
        GROUP BY rec.source_ip, rec.disposition, rec.spf_aligned, rec.dkim_aligned, rec.header_from
        ORDER BY (rec.spf_aligned + rec.dkim_aligned) = 0 DESC, count DESC
        LIMIT ${DMARC_FAILING_SOURCES_LIMIT}`,
      ...args,
    ),
    all<{ org_name: string; reports: number; messages: number; last_report_at: number }>(
      db,
      `SELECT org_name, count(*) AS reports, sum(message_count) AS messages, max(created_at) AS last_report_at
         FROM dmarc_reports
        WHERE sending_domain_id = ?1 AND begin_at >= ?2 AND begin_at < ?3
        GROUP BY org_name ORDER BY messages DESC LIMIT 20`,
      ...args,
    ),
    first<{ at: number | null }>(
      db,
      'SELECT max(created_at) AS at FROM dmarc_reports WHERE sending_domain_id = ?1',
      sendingDomainId,
    ),
  ]);
  const messages = days.reduce((sum, d) => sum + d.messages, 0);
  const aligned = days.reduce((sum, d) => sum + d.aligned, 0);
  return {
    lastReportAt: last?.at ?? null,
    totals: { messages, aligned },
    byDay: days.map((d) => ({ day: d.day, aligned: d.aligned, failed: d.messages - d.aligned })),
    failingSources: sources.map((s) => ({
      sourceIp: s.source_ip,
      count: s.count,
      disposition: s.disposition,
      dmarcPass: s.spf_aligned === 1 || s.dkim_aligned === 1,
      spfAligned: s.spf_aligned === 1,
      dkimAligned: s.dkim_aligned === 1,
      headerFrom: s.header_from,
      reporters: (JSON.parse(s.reporters) as string[]).sort(),
    })),
    reporters: reporters.map((r) => ({
      orgName: r.org_name,
      reports: r.reports,
      messages: r.messages,
      lastReportAt: r.last_report_at,
    })),
  };
}

/** True when a published _dmarc record sends aggregate reports to `address`. */
export function recordReportsTo(record: string, address: string): boolean {
  const rua = /(?:^|;)\s*rua\s*=\s*([^;]*)/i.exec(record)?.[1] ?? '';
  return rua
    .split(',')
    .map((uri) =>
      uri
        .trim()
        .replace(/^mailto:/i, '')
        .replace(/!.*$/, '')
        .toLowerCase(),
    )
    .includes(address.toLowerCase());
}

// ---- Reputation Ramp history ---------------------------------------------------------------

/**
 * Every Reputation Ramp of a Channel with its days in the range. Read-only: unlike the Sending
 * page, this never creates a ramp. Today's row is the live counter (its bounces and complaints
 * are only counted at rollover, so its rates are null).
 */
/** A sending domain's totals from its warm-up record, which is where per-domain rates live. */
export async function domainSendingTotals(
  db: D1Database,
  sendingDomainId: string,
  range: DayRange,
): Promise<{ sent: number; bounces: number; complaints: number }> {
  const row = await first<{ sent: number; bounces: number; complaints: number }>(
    db,
    `SELECT coalesce(sum(d.sent), 0) AS sent, coalesce(sum(d.bounces), 0) AS bounces,
            coalesce(sum(d.complaints), 0) AS complaints
       FROM reputation_ramp_days d JOIN reputation_ramps r ON r.id = d.ramp_id
      WHERE r.sending_domain_id = ?1 AND d.day >= ?2 AND d.day <= ?3`,
    sendingDomainId,
    range.from,
    range.to,
  );
  return row ?? { sent: 0, bounces: 0, complaints: 0 };
}

export async function rampHistory(
  db: D1Database,
  channelId: string,
  range: DayRange,
  platformDomain: string,
): Promise<RampHistory[]> {
  const ramps = await all<{
    id: string;
    sending_domain_id: string | null;
    domain: string | null;
    status: RampHistory['status'];
    paused_reason: string | null;
    day: string;
    cap_today: number;
    sent_today: number;
  }>(
    db,
    `SELECT r.id, r.sending_domain_id, sd.domain, r.status, r.paused_reason, r.day, r.cap_today, r.sent_today
       FROM reputation_ramps r LEFT JOIN sending_domains sd ON sd.id = r.sending_domain_id
      WHERE r.channel_id = ?1
      ORDER BY r.sending_domain_id IS NOT NULL, r.created_at`,
    channelId,
  );
  if (!ramps.length) return [];
  const days = await all<{
    ramp_id: string;
    day: string;
    cap: number;
    sent: number;
    bounces: number;
    complaints: number;
  }>(
    db,
    // The primary key (ramp_id, day) serves each ramp's range.
    `SELECT ramp_id, day, cap, sent, bounces, complaints FROM reputation_ramp_days
      WHERE ramp_id IN (SELECT id FROM reputation_ramps WHERE channel_id = ?1) AND day >= ?2 AND day <= ?3
      ORDER BY day`,
    channelId,
    range.from,
    range.to,
  );
  return ramps.map((ramp): RampHistory => {
    const own = days
      .filter((d) => d.ramp_id === ramp.id)
      .map((d) => ({
        day: d.day,
        cap: d.cap,
        sent: d.sent,
        bounces: d.bounces,
        complaints: d.complaints,
        bounceRate: ratio(d.bounces, d.sent),
        complaintRate: ratio(d.complaints, d.sent),
      }));
    if (ramp.day >= range.from && ramp.day <= range.to && !own.some((d) => d.day === ramp.day)) {
      own.push({
        day: ramp.day,
        cap: ramp.cap_today,
        sent: ramp.sent_today,
        bounces: 0,
        complaints: 0,
        bounceRate: null,
        complaintRate: null,
      });
    }
    return {
      rampId: ramp.id,
      sendingDomainId: ramp.sending_domain_id,
      domain: ramp.domain ?? platformDomain,
      status: ramp.status,
      pausedReason: ramp.paused_reason,
      days: own,
    };
  });
}
