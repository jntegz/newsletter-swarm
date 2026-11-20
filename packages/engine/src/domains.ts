/**
 * Sending domains: the DNS records an operator publishes, and verification against the mail
 * provider (SES or Resend) and DNS.
 * The first send from a domain is blocked until its DMARC policy is quarantine or reject.
 */
import type { DnsRecord } from '@swarm/domain';
import {
  dohLookup,
  type DnsLookup,
  type DomainIdentities,
  type DomainIdentityStatus,
  type ProviderDnsRecord,
} from '@swarm/mail';
import { first, run } from './db';

export type DmarcPolicy = 'none' | 'quarantine' | 'reject';

/** TXT lookups. The real one uses DNS over HTTPS; tests and development inject their own. */
export interface TxtResolver {
  txt(name: string): Promise<string[]>;
}

export class DohResolver implements TxtResolver {
  constructor(
    private readonly endpoint = 'https://cloudflare-dns.com/dns-query',
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  /** Throws when DNS fails to answer, so an outage can't look like a missing record. */
  txt(name: string): Promise<string[]> {
    return dohLookup(this.fetcher, this.endpoint).lookup(name, 'TXT');
  }
}

/** Parses the policy tag of a DMARC record. `subdomain` reads sp= (falling back to p=). */
export function parseDmarc(record: string, subdomain = false): DmarcPolicy | null {
  if (!/^v=DMARC1\s*(;|$)/i.test(record.trim())) return null;
  const tags = new Map<string, string>();
  for (const part of record.split(';')) {
    const [key, ...rest] = part.split('=');
    if (key && rest.length) tags.set(key.trim().toLowerCase(), rest.join('=').trim().toLowerCase());
  }
  const policy = (subdomain ? tags.get('sp') : undefined) ?? tags.get('p');
  return policy === 'none' || policy === 'quarantine' || policy === 'reject' ? policy : null;
}

/**
 * The effective DMARC policy for a domain: its own _dmarc record, else the organisational
 * domain's (sp= or p=). The organisational domain is taken as the last two labels, which is
 * wrong for multi-part public suffixes such as co.uk; those domains must publish their own record.
 */
export async function lookupDmarc(
  resolver: TxtResolver,
  domain: string,
): Promise<DmarcPolicy | null> {
  const own = (await resolver.txt(`_dmarc.${domain}`)).map((r) => parseDmarc(r)).find(Boolean);
  if (own) return own;
  const labels = domain.split('.');
  if (labels.length <= 2) return null;
  const org = labels.slice(-2).join('.');
  return (
    (await resolver.txt(`_dmarc.${org}`)).map((r) => parseDmarc(r, true)).find(Boolean) ?? null
  );
}

export const dmarcAllowsSending = (policy: string | null) =>
  policy === 'quarantine' || policy === 'reject';

export function mailFromDomain(domain: string): string {
  return `bounce.${domain}`;
}

/**
 * The DMARC record Swarm recommends: quarantine (the least the first-send check accepts), relaxed
 * alignment, and aggregate reports to the domain's own address (dmarc+<id>@DMARC_MAIL_DOMAIN).
 */
export function recommendedDmarcRecord(domain: string, reportAddress: string): DnsRecord {
  return {
    purpose: 'dmarc',
    type: 'TXT',
    name: `_dmarc.${domain}`,
    value: `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:${reportAddress}`,
  };
}

/**
 * Stored records with the DMARC one replaced by today's recommendation, so domains added before
 * the per-domain report address (Phase 7) show it too.
 */
export function withRecommendedDmarc(
  records: DnsRecord[],
  domain: string,
  reportAddress: string,
): DnsRecord[] {
  return records.map((record) =>
    record.purpose === 'dmarc' ? recommendedDmarcRecord(domain, reportAddress) : record,
  );
}

/**
 * Records for an email sending domain: the provider's own (DKIM and the MAIL FROM/return path,
 * from DomainIdentities.create) and Swarm's recommended DMARC record.
 */
export function emailDomainRecords(
  domain: string,
  providerRecords: ProviderDnsRecord[],
  reportAddress: string,
): DnsRecord[] {
  return [
    ...providerRecords.map((record): DnsRecord => ({
      purpose: record.purpose,
      type: record.type,
      name: record.name,
      value: record.value,
      ...(record.priority === undefined ? {} : { priority: record.priority }),
    })),
    recommendedDmarcRecord(domain, reportAddress),
  ];
}

/** How long the send cron re-checks a domain after it is added or changes service. */
export const DOMAIN_CHECK_WINDOW_MS = 7 * 86_400_000;

/**
 * A domain or hostname is held by proof, not by who added it first. A claim that has never
 * verified holds its name only for its re-check window; within it, another Channel takes the name
 * over by publishing `_swarm-claim.<name>` = `swarm-claim=<token>`. The token only binds the
 * record to that Channel and name: it needs no secret, because only the name's DNS can carry it.
 */
export async function claimProof(
  channelId: string,
  name: string,
): Promise<{ name: string; value: string }> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`swarm-claim:${channelId}:${name.toLowerCase()}`),
  );
  const token = [...new Uint8Array(digest).slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return { name: `_swarm-claim.${name.toLowerCase()}`, value: `swarm-claim=${token}` };
}

/** Whether DNS carries the Channel's claim proof for a name. A failed lookup proves nothing. */
export async function hasClaimProof(
  resolver: TxtResolver,
  channelId: string,
  name: string,
): Promise<boolean> {
  const proof = await claimProof(channelId, name);
  const found = await resolver.txt(proof.name).catch(() => [] as string[]);
  return found.some((record) => record.trim().replace(/^"|"$/g, '') === proof.value);
}

export function linkDomainRecords(domain: string, trackHost: string): DnsRecord[] {
  return [{ purpose: 'link', type: 'CNAME', name: domain, value: trackHost }];
}

/** Custom hostnames for link domains (Cloudflare for SaaS). */
export interface LinkHostnames {
  create(hostname: string): Promise<{ id: string }>;
  status(id: string): Promise<'active' | 'pending' | 'failed'>;
  remove(id: string): Promise<void>;
}

export class CloudflareHostnames implements LinkHostnames {
  constructor(
    private readonly zoneId: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetcher(
      `https://api.cloudflare.com/client/v4/zones/${this.zoneId}/custom_hostnames${path}`,
      {
        method,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: body === undefined ? null : JSON.stringify(body),
      },
    );
    const json = (await res.json()) as {
      success: boolean;
      result: T;
      errors?: { message: string }[];
    };
    if (!json.success) throw new Error(json.errors?.[0]?.message ?? `Cloudflare API ${res.status}`);
    return json.result;
  }

  async create(hostname: string) {
    const result = await this.call<{ id: string }>('POST', '', {
      hostname,
      ssl: { method: 'http', type: 'dv' },
    });
    return { id: result.id };
  }

  async status(id: string) {
    const result = await this.call<{ status: string; ssl?: { status?: string } }>('GET', `/${id}`);
    if (result.status === 'active' && result.ssl?.status === 'active') return 'active' as const;
    if (/blocked|moved|deleted/.test(result.status)) return 'failed' as const;
    return 'pending' as const;
  }

  async remove(id: string) {
    await this.call('DELETE', `/${id}`);
  }
}

/** Development and tests: every hostname is active immediately. */
export class DevHostnames implements LinkHostnames {
  async create(hostname: string) {
    return { id: `dev-${hostname}` };
  }
  async status() {
    return 'active' as const;
  }
  async remove() {}
}

/** Development: as DevResolver below, for full lookups. No other record exists. */
export class DevDnsLookup implements DnsLookup {
  async lookup(name: string, type: string) {
    return type === 'TXT' && name.startsWith('_dmarc.') ? ['v=DMARC1; p=quarantine'] : [];
  }
}

/** Development: every domain publishes p=quarantine. Never selectable outside development and test. */
export class DevResolver implements TxtResolver {
  async txt(name: string) {
    return name.startsWith('_dmarc.') ? ['v=DMARC1; p=quarantine'] : [];
  }
}

export interface DomainRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  domain: string;
  kind: 'email' | 'link';
  status: 'pending' | 'verified' | 'failed';
  dkim_status: string;
  mail_from_domain: string | null;
  mail_from_status: string;
  dmarc_policy: DmarcPolicy | null;
  records_json: string;
  provider_ref: string | null;
  /** The mail service the row's identity is at; NULL on rows from before 0053 (the current one). */
  provider: string | null;
  provider_changed_at: number | null;
  pending_provider: string | null;
  pending_provider_ref: string | null;
  pending_records_json: string | null;
  last_checked_at: number | null;
  verified_at: number | null;
  /** First verification; never cleared, so a proven claim keeps its domain (0065). */
  proven_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface VerifyDeps {
  identities: DomainIdentities;
  /** The mail service `identities` talks to (MAIL_ADAPTER). */
  service?: string;
  hostnames: LinkHostnames;
  resolver: TxtResolver;
}

const NOT_REGISTERED: DomainIdentityStatus = {
  verifiedForSending: false,
  dkimStatus: 'not_started',
  mailFromStatus: 'not_started',
};

/** Re-checks one domain with the provider and DNS and stores the result. */
export async function refreshDomain(
  db: D1Database,
  deps: VerifyDeps,
  domainId: string,
  now = Date.now(),
): Promise<DomainRow> {
  const row = await first<DomainRow>(db, 'SELECT * FROM sending_domains WHERE id = ?1', domainId);
  if (!row) throw new Error('sending domain not found');

  if (row.kind === 'link') {
    const state = row.provider_ref ? await deps.hostnames.status(row.provider_ref) : 'failed';
    const status = state === 'active' ? 'verified' : state === 'failed' ? 'failed' : 'pending';
    await run(
      db,
      `UPDATE sending_domains SET status = ?1, last_checked_at = ?2, updated_at = ?2,
              verified_at = CASE WHEN ?1 = 'verified' THEN coalesce(verified_at, ?2) ELSE verified_at END,
              proven_at = CASE WHEN ?1 = 'verified' THEN coalesce(proven_at, ?2) ELSE proven_at END
        WHERE id = ?3`,
      status,
      now,
      domainId,
    );
  } else {
    // A domain a service change couldn't move is still on its old service. Whatever this service
    // has under its name, Swarm didn't create it for this row, so it proves nothing.
    const elsewhere = !!deps.service && !!row.provider && row.provider !== deps.service;
    const identity = elsewhere
      ? NOT_REGISTERED
      : await deps.identities.status(row.domain, row.provider_ref);
    let dmarc: DmarcPolicy | null = row.dmarc_policy;
    try {
      dmarc = await lookupDmarc(deps.resolver, row.domain);
    } catch {
      // A DNS outage keeps the last known policy rather than blocking or unblocking sends.
    }
    const verified = identity.verifiedForSending && identity.dkimStatus === 'success';
    const status = verified ? 'verified' : identity.dkimStatus === 'failed' ? 'failed' : 'pending';
    await run(
      db,
      `UPDATE sending_domains SET status = ?1, dkim_status = ?2, mail_from_status = ?3, dmarc_policy = ?4,
              last_checked_at = ?5, updated_at = ?5,
              verified_at = CASE WHEN ?1 = 'verified' THEN coalesce(verified_at, ?5) ELSE verified_at END,
              proven_at = CASE WHEN ?1 = 'verified' THEN coalesce(proven_at, ?5) ELSE proven_at END
        WHERE id = ?6`,
      status,
      identity.dkimStatus,
      identity.mailFromStatus,
      dmarc,
      now,
      domainId,
    );
  }
  return (await first<DomainRow>(
    db,
    'SELECT * FROM sending_domains WHERE id = ?1',
    domainId,
  )) as DomainRow;
}
