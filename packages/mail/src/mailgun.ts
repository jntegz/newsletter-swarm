/**
 * Mailgun (https://www.mailgun.com) over plain fetch: an allowed MailAdapter next to SES and Resend.
 * It has no configuration sets Swarm can use, so dedicated sending stays SES-only.
 *
 * - Sends go to POST /v3/<domain>/messages as multipart form data, with the sending domain taken
 *   from the From address. Swarm's tags travel as custom variables (v:) and come back on webhooks
 *   as user-variables. Mailgun copies them into the X-Mailgun-Variables header of the delivered
 *   email, so they must stay free of personal data (they hold ids only).
 * - Mailgun documents no idempotency key. As with SES, a retry after a server error can in rare
 *   cases mail twice; the send pipeline only retries 429s and 5xxs.
 * - Open and click tracking are off on every message: Swarm tracks them itself.
 * - The API key must be the account's primary key. Domain sending keys can't manage domains.
 */
import { IdentityExistsError, MailProviderError, retryAfterSeconds } from './errors';
import { formatAddress, type MailAdapter, type OutgoingMail, type SentMail } from './index';
import { resendRecordName } from './resend';
import {
  type CreatedIdentity,
  type DomainIdentities,
  type DomainIdentityStatus,
  type ProviderDnsRecord,
} from './ses';

/** Mailgun keeps separate US and EU infrastructure; a domain lives in one of them. */
export const MAILGUN_REGIONS = ['us', 'eu'] as const;
type MailgunRegion = (typeof MAILGUN_REGIONS)[number];

export const mailgunBaseUrl = (region: MailgunRegion): string =>
  region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';

interface MailgunConfig {
  apiKey: string;
  region: MailgunRegion;
  fetch?: typeof fetch;
  /** Tests only. */
  baseUrl?: string;
}

export class MailgunError extends MailProviderError {
  constructor(status: number, code: string, message: string, retryAfter: number | null = null) {
    super(status, code, message, retryAfter);
    this.name = 'MailgunError';
  }

  /** A key or domain Mailgun refuses stops the send; 429 and 5xx stay retryable. */
  override get halting(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

interface MailgunDnsRecord {
  record_type?: string;
  name?: string;
  value?: string;
  valid?: string;
  priority?: string;
}

interface MailgunDomainResponse {
  domain?: { name?: string; state?: string; is_disabled?: boolean };
  sending_dns_records?: MailgunDnsRecord[] | null;
}

const isDkim = (record: MailgunDnsRecord) => (record.name ?? '').includes('._domainkey');
const isSpf = (record: MailgunDnsRecord) =>
  (record.record_type ?? '').toUpperCase() === 'TXT' &&
  /^"?v=spf1\b/i.test((record.value ?? '').trim());

/**
 * The DKIM and SPF records of a Mailgun domain. Its tracking CNAME is left out because Swarm turns
 * tracking off, and so are the receiving MX records, which Mailgun lists as being for receiving.
 */
export function mailgunIdentityRecords(
  domain: string,
  records: MailgunDnsRecord[] | null | undefined,
): ProviderDnsRecord[] {
  const out: ProviderDnsRecord[] = [];
  for (const record of records ?? []) {
    const type = (record.record_type ?? '').toUpperCase();
    if (typeof record.value !== 'string' || (type !== 'TXT' && type !== 'CNAME')) continue;
    const purpose = isSpf(record) ? 'mail_from_spf' : isDkim(record) ? 'dkim' : null;
    if (!purpose) continue;
    out.push({
      purpose,
      type,
      name: resendRecordName(record.name, domain),
      // TXT values sometimes arrive quoted; the DNS provider adds its own quotes.
      value: type === 'TXT' ? record.value.replace(/^"(.*)"$/s, '$1') : record.value,
    });
  }
  return out;
}

/**
 * Mailgun marks a record invalid until DNS has it, which is the normal state of a new domain, so
 * that counts as pending. Swarm would otherwise show a domain as failed before anyone added it.
 */
function recordsStatus(records: MailgunDnsRecord[]): DomainIdentityStatus['dkimStatus'] {
  if (records.length === 0) return 'not_started';
  return records.every((r) => r.valid === 'valid') ? 'success' : 'pending';
}

export function mailgunDomainStatus(response: MailgunDomainResponse): DomainIdentityStatus {
  const records = response.sending_dns_records ?? [];
  return {
    verifiedForSending: response.domain?.state === 'active' && !response.domain.is_disabled,
    dkimStatus: recordsStatus(records.filter(isDkim)),
    mailFromStatus: recordsStatus(records.filter(isSpf)),
  };
}

/**
 * Seconds until the rate limit resets. Mailgun describes X-RateLimit-Reset as "Unix milliseconds
 * until the limit resets", which could mean a moment or a duration, so both are read.
 */
export function mailgunResetSeconds(value: string | null, now = Date.now()): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const number = Number(value);
  const ms = number > 100_000_000_000 ? number - now : number;
  return Math.max(0, Math.ceil(ms / 1000));
}

export class MailgunClient implements DomainIdentities {
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: MailgunConfig) {
    if (!config.apiKey) throw new Error('Mailgun API key is required');
    this.base = config.baseUrl ?? mailgunBaseUrl(config.region);
    this.fetcher = config.fetch ?? ((input, init) => fetch(input, init));
  }

  private async request<T>(method: string, path: string, form?: FormData): Promise<T> {
    const res = await this.fetcher(`${this.base}${path}`, {
      method,
      headers: { authorization: `Basic ${btoa(`api:${this.config.apiKey}`)}` },
      body: form ?? null,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300) || `Mailgun answered ${res.status}`;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        // Non-JSON error body; keep the raw text.
      }
      throw new MailgunError(
        res.status,
        `http_${res.status}`,
        message,
        retryAfterSeconds(res.headers.get('retry-after')) ??
          mailgunResetSeconds(res.headers.get('x-ratelimit-reset')),
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Returns Mailgun's message id without angle brackets, as webhooks carry it. */
  async sendMessage(domain: string, form: FormData): Promise<string> {
    const result = await this.request<{ id?: string }>(
      'POST',
      `/v3/${encodeURIComponent(domain)}/messages`,
      form,
    );
    const id = result.id?.trim().replace(/^<|>$/g, '');
    if (!id) throw new MailgunError(502, 'missing_id', 'Mailgun accepted the email without an id');
    return id;
  }

  private async getDomain(domain: string): Promise<MailgunDomainResponse | null> {
    try {
      return await this.request<MailgunDomainResponse>(
        'GET',
        `/v4/domains/${encodeURIComponent(domain)}`,
      );
    } catch (error) {
      if (error instanceof MailgunError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * The mail-from host stays the domain itself, so `mailFromDomain` isn't used and the SPF record
   * goes on the sending domain.
   */
  async create(domain: string): Promise<CreatedIdentity> {
    // One Swarm didn't just create may be the operator's own, verified or not: never taken over.
    if (await this.getDomain(domain)) throw new IdentityExistsError(domain);
    const form = new FormData();
    form.set('name', domain);
    form.set('dkim_key_size', '2048');
    const found = await this.request<MailgunDomainResponse>('POST', '/v4/domains', form);
    return {
      records: mailgunIdentityRecords(domain, found.sending_dns_records),
      providerRef: null,
    };
  }

  async records(domain: string): Promise<ProviderDnsRecord[]> {
    const found = await this.getDomain(domain);
    return found ? mailgunIdentityRecords(domain, found.sending_dns_records) : [];
  }

  async status(domain: string): Promise<DomainIdentityStatus> {
    const found = await this.getDomain(domain);
    if (!found) {
      return {
        verifiedForSending: false,
        dkimStatus: 'not_started',
        mailFromStatus: 'not_started',
      };
    }
    if (found.domain?.state === 'active') return mailgunDomainStatus(found);
    // Ask Mailgun to look at DNS again, so new records get noticed.
    const checked = await this.request<MailgunDomainResponse>(
      'PUT',
      `/v4/domains/${encodeURIComponent(domain)}/verify`,
    ).catch(() => found);
    return mailgunDomainStatus(checked);
  }

  async remove(domain: string): Promise<void> {
    try {
      await this.request('DELETE', `/v3/domains/${encodeURIComponent(domain)}`);
    } catch (error) {
      if (!(error instanceof MailgunError && error.status === 404)) throw error;
    }
  }
}

/** MailAdapter for Mailgun: Broadcasts, transactional mail and Direct Sends alike. */
export class MailgunMail implements MailAdapter {
  /** Mailgun's docs give no sending rate per second, so this stays as cautious as Resend's. */
  readonly maxConcurrency = 8;

  constructor(
    private readonly client: MailgunClient,
    private readonly messageIdDomain: string,
  ) {}

  async send(mail: OutgoingMail): Promise<SentMail> {
    const domain = mail.from.address.split('@').pop();
    if (!domain) throw new Error('The From address has no domain');
    const messageId = mail.messageId ?? `${crypto.randomUUID()}@${this.messageIdDomain}`;
    const form = new FormData();
    form.set('from', formatAddress(mail.from));
    form.set('to', mail.to);
    form.set('subject', mail.subject);
    form.set('text', mail.text);
    form.set('html', mail.html);
    form.set('o:tag', mail.category);
    form.set('o:tracking', 'no');
    form.set('o:tracking-clicks', 'no');
    form.set('o:tracking-opens', 'no');
    form.set('h:Message-Id', `<${messageId}>`);
    if (mail.replyTo) form.set('h:Reply-To', mail.replyTo);
    // List-Unsubscribe(-Post), Feedback-ID and X-Swarm-* pass through as they are.
    for (const [name, value] of Object.entries(mail.headers ?? {})) form.set(`h:${name}`, value);
    for (const [name, value] of Object.entries(mail.tags ?? {})) form.set(`v:${name}`, value);
    // Correlation on webhooks is by the `delivery` variable, then by this id (as for Resend).
    return { messageId: await this.client.sendMessage(domain, form) };
  }
}
