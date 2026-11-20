/**
 * Resend (https://resend.com) over plain fetch: an allowed MailAdapter next to SES, for installs
 * that want a quick start. SES stays the primary engine; Resend has no configuration sets or
 * dedicated IPs, so dedicated sending is SES-only.
 *
 * - Sends go to POST /emails with an Idempotency-Key (the Message-ID), so a retried request
 *   never mails twice. Swarm's tags ride along as Resend tags and come back on webhooks.
 * - Domains are created with a custom return path ("bounce", Swarm's MAIL FROM subdomain) and
 *   open and click tracking off: Swarm tracks opens and clicks itself.
 */
import {
  IdentityExistsError,
  MailProviderError,
  retryAfterSeconds,
  type ProviderQuota,
} from './errors';
import { formatAddress, type MailAdapter, type OutgoingMail, type SentMail } from './index';
import {
  sanitizeTag,
  type CreatedIdentity,
  type DomainIdentities,
  type DomainIdentityStatus,
  type ProviderDnsRecord,
} from './ses';

/** Regions Resend sends from; the domain is created in one of them. */
export const RESEND_REGIONS = ['us-east-1', 'eu-west-1', 'sa-east-1', 'ap-northeast-1'] as const;
type ResendRegion = (typeof RESEND_REGIONS)[number];

export const isResendRegion = (value: string): value is ResendRegion =>
  (RESEND_REGIONS as readonly string[]).includes(value);

interface ResendConfig {
  apiKey: string;
  /** Region new domains are created in. */
  region: string;
  fetch?: typeof fetch;
  /** Tests only. */
  baseUrl?: string;
}

/** Resend error names that mean the account can't send at all. */
const HALTING_NAMES = new Set(['missing_api_key', 'invalid_api_key', 'restricted_api_key']);

export class ResendError extends MailProviderError {
  constructor(status: number, code: string, message: string, retryAfter: number | null = null) {
    super(status, code, message, retryAfter);
    this.name = 'ResendError';
  }

  /** daily_quota_exceeded and monthly_quota_exceeded: wait for the quota, don't retry or stop. */
  override get quota(): ProviderQuota | null {
    if (this.code === 'daily_quota_exceeded') return 'day';
    if (this.code === 'monthly_quota_exceeded') return 'month';
    return null;
  }

  /** Rate limits, concurrent idempotent requests and server errors; never a used-up quota. */
  override get retryable(): boolean {
    if (this.halting || this.quota) return false;
    return (
      this.status === 429 || this.status >= 500 || this.code === 'concurrent_idempotent_requests'
    );
  }

  /** Credentials or a domain Resend refuses (401, 403). */
  override get halting(): boolean {
    if (this.quota) return false;
    return HALTING_NAMES.has(this.code) || this.status === 401 || this.status === 403;
  }
}

interface ResendRecord {
  record?: string;
  name?: string;
  type?: string;
  value?: string;
  status?: string;
  priority?: number | string;
}

interface ResendDomain {
  id: string;
  name: string;
  status?: string;
  region?: string;
  records?: ResendRecord[];
}

const RECORD_TYPES = new Set(['CNAME', 'TXT', 'MX']);

/**
 * A record name as a full domain. Resend gives names relative to the root domain, so for
 * mail.example.com it says "resend._domainkey.mail" and means resend._domainkey.mail.example.com.
 * Names can also be relative to the sending domain ("send") or already full.
 */
export function resendRecordName(name: string | undefined, domain: string): string {
  const lower = domain.toLowerCase();
  const value = (name ?? '').trim().replace(/\.$/, '').toLowerCase();
  if (value === '' || value === '@') return lower;
  if (value === lower || value.endsWith(`.${lower}`)) return value;
  // The name ends in the start of the domain, so only the rest of the domain is missing.
  const labels = lower.split('.');
  for (let cut = labels.length - 1; cut > 0; cut--) {
    const start = labels.slice(0, cut).join('.');
    if (value === start || value.endsWith(`.${start}`)) {
      return `${value}.${labels.slice(cut).join('.')}`;
    }
  }
  return `${value}.${lower}`;
}

/** The DKIM and return-path records of a Resend domain; Receiving and Tracking are ignored. */
export function resendIdentityRecords(
  domain: string,
  records: ResendRecord[] | undefined,
): ProviderDnsRecord[] {
  const out: ProviderDnsRecord[] = [];
  for (const record of records ?? []) {
    const kind = (record.record ?? '').toUpperCase();
    const type = (record.type ?? '').toUpperCase();
    if (!RECORD_TYPES.has(type) || typeof record.value !== 'string') continue;
    let purpose: ProviderDnsRecord['purpose'];
    if (kind === 'DKIM') purpose = 'dkim';
    else if (kind === 'SPF' && (type === 'MX' || type === 'CNAME')) purpose = 'mail_from_mx';
    else if (kind === 'SPF' && type === 'TXT') purpose = 'mail_from_spf';
    else continue;
    // TXT values sometimes arrive quoted; the DNS provider adds its own quotes.
    const value = type === 'TXT' ? record.value.replace(/^"(.*)"$/s, '$1') : record.value;
    const priority = Number(record.priority);
    out.push({
      purpose,
      type: type as ProviderDnsRecord['type'],
      name: resendRecordName(record.name, domain),
      value,
      ...(type === 'MX' && Number.isFinite(priority) ? { priority } : {}),
    });
  }
  return out;
}

const mapRecordStatus = (value: string | undefined): DomainIdentityStatus['dkimStatus'] => {
  switch (value) {
    case 'verified':
      return 'success';
    case 'failed':
    case 'temporary_failure':
      return 'failed';
    case 'not_started':
    case undefined:
      return 'not_started';
    default:
      return 'pending';
  }
};

/** One status for a group of records: failed beats pending beats not started; all verified is success. */
function combine(
  statuses: DomainIdentityStatus['dkimStatus'][],
): DomainIdentityStatus['dkimStatus'] {
  if (statuses.length === 0) return 'not_started';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.every((s) => s === 'success')) return 'success';
  if (statuses.every((s) => s === 'not_started')) return 'not_started';
  return 'pending';
}

export function resendDomainStatus(domain: ResendDomain): DomainIdentityStatus {
  const records = domain.records ?? [];
  const of = (match: (r: ResendRecord) => boolean) =>
    combine(records.filter(match).map((r) => mapRecordStatus(r.status)));
  return {
    verifiedForSending: domain.status === 'verified',
    dkimStatus: of((r) => (r.record ?? '').toUpperCase() === 'DKIM'),
    mailFromStatus: of((r) => (r.record ?? '').toUpperCase() === 'SPF'),
  };
}

/** Domain statuses where Resend is not checking DNS and needs a nudge. */
const NEEDS_VERIFY = new Set(['not_started', 'failed', 'partially_failed', 'temporary_failure']);

export class ResendClient implements DomainIdentities {
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: ResendConfig) {
    if (!config.apiKey) throw new Error('Resend API key is required');
    this.base = config.baseUrl ?? 'https://api.resend.com';
    this.fetcher = config.fetch ?? ((input, init) => fetch(input, init));
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const res = await this.fetcher(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        // Resend refuses requests without a User-Agent; Workers' fetch sends none.
        'user-agent': 'swarm-newsletter',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let code = `http_${res.status}`;
      let message = text.slice(0, 300) || `Resend answered ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { name?: string; type?: string; message?: string };
        code = parsed.name ?? parsed.type ?? code;
        message = parsed.message ?? message;
      } catch {
        // Non-JSON error body; keep the raw text.
      }
      throw new ResendError(
        res.status,
        code,
        message,
        retryAfterSeconds(res.headers.get('retry-after')),
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** POST /emails. Returns Resend's email id (webhooks carry it as data.email_id). */
  async sendEmail(input: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    replyTo?: string;
    headers?: Record<string, string>;
    tags?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<string> {
    const tags = Object.entries(input.tags ?? {}).map(([name, value]) => ({
      name: sanitizeTag(name),
      value: sanitizeTag(value),
    }));
    const headers = input.headers ?? {};
    const result = await this.request<{ id?: string }>(
      'POST',
      '/emails',
      {
        from: input.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(tags.length ? { tags } : {}),
      },
      input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey.slice(0, 256) } : {},
    );
    if (!result.id)
      throw new ResendError(502, 'missing_id', 'Resend accepted the email without an id');
    return result.id;
  }

  /** The domain with this name, or null. */
  async findDomain(domain: string): Promise<ResendDomain | null> {
    const wanted = domain.toLowerCase();
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const query: string = after ? `?limit=100&after=${encodeURIComponent(after)}` : '?limit=100';
      const list = await this.request<{ data?: ResendDomain[]; has_more?: boolean }>(
        'GET',
        `/domains${query}`,
      );
      const items = list.data ?? [];
      const found = items.find((d) => d.name?.toLowerCase() === wanted);
      if (found) return found;
      if (!list.has_more || items.length === 0) return null;
      after = items[items.length - 1]!.id;
    }
    return null;
  }

  private getDomain(id: string): Promise<ResendDomain> {
    return this.request<ResendDomain>('GET', `/domains/${encodeURIComponent(id)}`);
  }

  private async verify(id: string): Promise<void> {
    await this.request('POST', `/domains/${encodeURIComponent(id)}/verify`);
  }

  async create(domain: string, mailFromDomain: string): Promise<CreatedIdentity> {
    if (!isResendRegion(this.config.region)) {
      throw new Error(`Resend has no region ${this.config.region}`);
    }
    const suffix = `.${domain}`;
    const returnPath = mailFromDomain.endsWith(suffix)
      ? mailFromDomain.slice(0, -suffix.length)
      : 'bounce';
    // One Swarm didn't just create may be the operator's own, verified or not: never taken over.
    if (await this.findDomain(domain)) throw new IdentityExistsError(domain);
    const found = await this.request<ResendDomain>('POST', '/domains', {
      name: domain,
      region: this.config.region,
      custom_return_path: returnPath,
      open_tracking: false,
      click_tracking: false,
    });
    const id = found.id;
    // Tracking stays off whatever the create call applied.
    await this.request('PATCH', `/domains/${encodeURIComponent(id)}`, {
      open_tracking: false,
      click_tracking: false,
    });
    const full = found.records?.length ? found : await this.getDomain(id);
    await this.verify(id);
    return { records: resendIdentityRecords(domain, full.records), providerRef: id };
  }

  async records(domain: string, providerRef: string | null): Promise<ProviderDnsRecord[]> {
    const id = providerRef ?? (await this.findDomain(domain))?.id;
    if (!id) return [];
    return resendIdentityRecords(domain, (await this.getDomain(id)).records);
  }

  async status(_domain: string, providerRef: string | null): Promise<DomainIdentityStatus> {
    const id = providerRef;
    if (!id)
      return {
        verifiedForSending: false,
        dkimStatus: 'not_started',
        mailFromStatus: 'not_started',
      };
    const found = await this.getDomain(id);
    if (found.status && NEEDS_VERIFY.has(found.status)) {
      // Resend checks DNS only after a verify request; ask again so new records get noticed.
      await this.verify(id).catch(() => {});
    }
    return resendDomainStatus(found);
  }

  async remove(_domain: string, providerRef: string | null): Promise<void> {
    const id = providerRef;
    if (!id) return;
    try {
      await this.request('DELETE', `/domains/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!(error instanceof ResendError && error.status === 404)) throw error;
    }
  }
}

/** MailAdapter for Resend: Broadcasts, transactional mail and Direct Sends alike. */
export class ResendMail implements MailAdapter {
  /** Resend allows 10 requests a second per team; 8 in flight leaves room for other mail. */
  readonly maxConcurrency = 8;

  constructor(
    private readonly client: ResendClient,
    private readonly messageIdDomain: string,
  ) {}

  async send(mail: OutgoingMail): Promise<SentMail> {
    const messageId = mail.messageId ?? `${crypto.randomUUID()}@${this.messageIdDomain}`;
    const id = await this.client.sendEmail({
      from: formatAddress(mail.from),
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      // List-Unsubscribe(-Post), Feedback-ID and X-Swarm-* pass through as they are. Resend
      // sets its own Message-ID, so ours becomes the Idempotency-Key instead.
      headers: { ...mail.headers },
      tags: { category: mail.category, ...mail.tags },
      idempotencyKey: messageId,
    });
    return { messageId: id };
  }
}
