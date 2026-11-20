/**
 * The email service, as Settings shows it: the records it needs for the domain system mail comes
 * from, what DNS says about each, whether reports are coming back, and for SES the account's limits.
 * None of this changes anything, at the service or in DNS.
 */
import type { CheckedDnsRecord, DnsRecord, InstanceMail } from '@swarm/domain';
import { checkRecords, type DnsLookup, type DomainIdentities, type SesAccount } from '@swarm/mail';
import { all, first } from './db';

/** Sending needs at least this policy, and the installer publishes it (see domains.ts). */
const PLATFORM_DMARC = 'v=DMARC1; p=quarantine; adkim=r; aspf=r';
/** Long enough that a healthy service has reported on what it was sent. */
const SETTLE_MS = 60 * 60 * 1000;
const LOOK_BACK_MS = 14 * 86_400_000;

export async function checkDnsRecords(
  records: DnsRecord[],
  dns: DnsLookup,
): Promise<CheckedDnsRecord[]> {
  // A link host answers for a hostname on Cloudflare, so its DNS says little about whether it works.
  const checked = await checkRecords(
    records.filter((record) => record.purpose !== 'link'),
    dns,
  );
  return checked.map(({ check, ...record }) => ({
    ...record,
    state: check.state,
    found: check.found,
  }));
}

/**
 * Whether the service reports back, from the latest finished Broadcasts. Every report moves a
 * delivery off 'sent', so a batch still all at 'sent' an hour on means reports aren't arriving.
 */
export async function feedbackHealth(
  db: D1Database,
  now: number,
): Promise<{ state: 'ok' | 'silent' | 'no_data'; sent: number; reported: number }> {
  const broadcasts = await all<{ id: string }>(
    db,
    `SELECT id FROM broadcasts WHERE completed_at BETWEEN ?1 AND ?2 AND sent_count > 0
      ORDER BY completed_at DESC LIMIT 5`,
    now - LOOK_BACK_MS,
    now - SETTLE_MS,
  );
  let sent = 0;
  let reported = 0;
  for (const { id } of broadcasts) {
    const row = await first<{ total: number; waiting: number }>(
      db,
      `SELECT count(*) AS total, coalesce(sum(status = 'sent'), 0) AS waiting
         FROM deliveries WHERE broadcast_id = ?1`,
      id,
    );
    sent += row?.total ?? 0;
    reported += (row?.total ?? 0) - (row?.waiting ?? 0);
  }
  if (!sent) return { state: 'no_data', sent, reported };
  return { state: reported ? 'ok' : 'silent', sent, reported };
}

export async function mailServiceStatus(input: {
  db: D1Database;
  service: InstanceMail['service'];
  region: string | null;
  domain: string;
  identities: DomainIdentities;
  dns: DnsLookup;
  ses: { account(): Promise<SesAccount> } | null;
  now?: number;
}): Promise<InstanceMail> {
  const now = input.now ?? Date.now();
  let provider: DnsRecord[] = [];
  let recordsComplete = true;
  try {
    provider = await input.identities.records(input.domain, null);
  } catch {
    // Wrong key, or the service is down. DMARC can still be checked, and the page says what's left.
    recordsComplete = false;
  }
  const dmarc: DnsRecord = {
    purpose: 'dmarc',
    type: 'TXT',
    name: `_dmarc.${input.domain}`,
    value: PLATFORM_DMARC,
  };
  // Plain SMTP servers don't report deliveries, so silence from one means nothing.
  const reports = input.service === 'smtp' || input.service === 'dev';
  const feedback = reports
    ? { state: 'not_reported' as const, sent: 0, reported: 0 }
    : await feedbackHealth(input.db, now);
  const ses = input.ses ? await input.ses.account().catch(() => null) : null;
  const change = await first<{
    from_provider: string;
    to_provider: string;
    state: 'prepared' | 'cut_over';
    started_at: number;
    drain_until: number | null;
  }>(
    input.db,
    `SELECT from_provider, to_provider, state, started_at, drain_until
       FROM mail_service_changes WHERE state IN ('prepared', 'cut_over') LIMIT 1`,
  );
  return {
    service: input.service,
    region: input.region,
    domain: input.domain,
    records: await checkDnsRecords([...provider, dmarc], input.dns),
    recordsComplete,
    feedback,
    ses,
    change: change
      ? {
          from: change.from_provider,
          to: change.to_provider,
          state: change.state,
          startedAt: new Date(change.started_at).toISOString(),
          drainUntil: change.drain_until ? new Date(change.drain_until).toISOString() : null,
        }
      : null,
    checkedAt: new Date(now).toISOString(),
  };
}
