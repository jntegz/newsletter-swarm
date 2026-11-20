/**
 * Postmark (https://postmarkapp.com) over plain fetch: an allowed MailAdapter next to SES, Resend
 * and Mailgun. It has no configuration sets Swarm can use, so dedicated sending stays SES-only.
 *
 * - Postmark keeps bulk and transactional mail apart, so posts and automations ("broadcast") go to
 *   a broadcast stream, and everything else to the default transactional stream.
 * - Two tokens: a server token sends, and an account token manages domains.
 * - Swarm's tags travel as Metadata and come back on webhooks.
 * - Postmark documents no idempotency key. As with SES, a retry after a server error can in rare
 *   cases mail twice; the send pipeline only retries 429s and 5xxs.
 * - Open and link tracking are off on every message: Swarm tracks them itself.
 */
import { IdentityExistsError, MailProviderError, type ProviderQuota } from './errors';
import { formatAddress, type MailAdapter, type OutgoingMail, type SentMail } from './index';
import {
  type CreatedIdentity,
  type DomainIdentities,
  type DomainIdentityStatus,
  type ProviderDnsRecord,
} from './ses';

/** The broadcast stream's id on the server; the installer creates it. */
const POSTMARK_BROADCAST_STREAM = 'broadcasts';
const POSTMARK_TRANSACTIONAL_STREAM = 'outbound';

interface PostmarkConfig {
  serverToken: string;
  accountToken: string;
  fetch?: typeof fetch;
  /** Tests only. */
  baseUrl?: string;
}

/** ErrorCodes meaning the account can't send: a bad token, or approval still pending or refused. */
const HALTING_CODES = new Set([10, 412, 413]);
/** "Not allowed to send": the account has no sending credits left until it renews or upgrades. */
const OUT_OF_CREDITS = 405;

export class PostmarkError extends MailProviderError {
  constructor(
    status: number,
    readonly errorCode: number,
    message: string,
  ) {
    super(status, `postmark_${errorCode}`, message);
    this.name = 'PostmarkError';
  }

  override get halting(): boolean {
    return this.status === 401 || HALTING_CODES.has(this.errorCode);
  }

  /** Out of credits: treated as a used-up monthly quota, so sending waits instead of failing. */
  override get quota(): ProviderQuota | null {
    return this.errorCode === OUT_OF_CREDITS ? 'month' : null;
  }

  override get retryable(): boolean {
    return this.quota ? false : super.retryable;
  }
}

interface PostmarkDomain {
  ID?: number;
  Name?: string;
  DKIMVerified?: boolean;
  DKIMHost?: string;
  DKIMTextValue?: string;
  DKIMPendingHost?: string;
  DKIMPendingTextValue?: string;
  ReturnPathDomain?: string;
  ReturnPathDomainVerified?: boolean;
  ReturnPathDomainCNAMEValue?: string;
}

/** The DKIM record, and the return-path CNAME that bounces come back through. */
export function postmarkIdentityRecords(domain: PostmarkDomain): ProviderDnsRecord[] {
  const out: ProviderDnsRecord[] = [];
  const host = domain.DKIMPendingHost || domain.DKIMHost;
  const value = domain.DKIMPendingTextValue || domain.DKIMTextValue;
  if (host && value) out.push({ purpose: 'dkim', type: 'TXT', name: host, value });
  if (domain.ReturnPathDomain && domain.ReturnPathDomainCNAMEValue) {
    out.push({
      purpose: 'mail_from_mx',
      type: 'CNAME',
      name: domain.ReturnPathDomain,
      value: domain.ReturnPathDomainCNAMEValue,
    });
  }
  return out;
}

export function postmarkDomainStatus(domain: PostmarkDomain): DomainIdentityStatus {
  return {
    verifiedForSending: domain.DKIMVerified === true,
    dkimStatus: domain.DKIMVerified ? 'success' : 'pending',
    mailFromStatus: domain.ReturnPathDomainVerified ? 'success' : 'pending',
  };
}

/** Postmark's limits: 10 fields, names up to 20 characters, values up to 80. */
export function postmarkMetadata(tags: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tags)
      .filter(([name, value]) => name.length <= 20 && value.length <= 80)
      .slice(0, 10),
  );
}

export class PostmarkClient implements DomainIdentities {
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: PostmarkConfig) {
    if (!config.serverToken || !config.accountToken) {
      throw new Error('Postmark server and account tokens are required');
    }
    this.base = config.baseUrl ?? 'https://api.postmarkapp.com';
    this.fetcher = config.fetch ?? ((input, init) => fetch(input, init));
  }

  private async request<T>(
    token: 'server' | 'account',
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetcher(`${this.base}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(token === 'server'
          ? { 'x-postmark-server-token': this.config.serverToken }
          : { 'x-postmark-account-token': this.config.accountToken }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: { ErrorCode?: number; Message?: string } = {};
    try {
      parsed = text ? (JSON.parse(text) as typeof parsed) : {};
    } catch {
      // Non-JSON body; the status says enough.
    }
    if (!res.ok || (parsed.ErrorCode ?? 0) !== 0) {
      throw new PostmarkError(
        res.ok ? 422 : res.status,
        parsed.ErrorCode ?? 0,
        parsed.Message ?? (text.slice(0, 300) || `Postmark answered ${res.status}`),
      );
    }
    return parsed as T;
  }

  /** POST /email. Returns Postmark's MessageID, which webhooks carry too. */
  async sendEmail(body: Record<string, unknown>): Promise<string> {
    const result = await this.request<{ MessageID?: string }>('server', 'POST', '/email', body);
    if (!result.MessageID) {
      throw new PostmarkError(502, 0, 'Postmark accepted the email without an id');
    }
    return result.MessageID;
  }

  private async findDomain(name: string): Promise<PostmarkDomain | null> {
    const wanted = name.toLowerCase();
    for (let offset = 0; offset < 10_000; offset += 500) {
      const list = await this.request<{ Domains?: PostmarkDomain[] }>(
        'account',
        'GET',
        `/domains?count=500&offset=${offset}`,
      );
      const items = list.Domains ?? [];
      const found = items.find((d) => d.Name?.toLowerCase() === wanted);
      if (found) return found;
      if (items.length < 500) return null;
    }
    return null;
  }

  private getDomain(id: string | number): Promise<PostmarkDomain> {
    return this.request<PostmarkDomain>('account', 'GET', `/domains/${id}`);
  }

  async create(domain: string, mailFromDomain: string): Promise<CreatedIdentity> {
    // One Swarm didn't just create may be the operator's own, verified or not: never taken over.
    if (await this.findDomain(domain)) throw new IdentityExistsError(domain);
    const full = await this.request<PostmarkDomain>('account', 'POST', '/domains', {
      Name: domain,
      ReturnPathDomain: mailFromDomain,
    });
    return {
      records: postmarkIdentityRecords(full),
      providerRef: full.ID === undefined ? null : String(full.ID),
    };
  }

  async records(domain: string, providerRef: string | null): Promise<ProviderDnsRecord[]> {
    const id = providerRef ?? (await this.findDomain(domain))?.ID;
    if (id === undefined || id === null) return [];
    return postmarkIdentityRecords(await this.getDomain(id));
  }

  async status(_domain: string, providerRef: string | null): Promise<DomainIdentityStatus> {
    const id = providerRef;
    if (id === null) {
      return {
        verifiedForSending: false,
        dkimStatus: 'not_started',
        mailFromStatus: 'not_started',
      };
    }
    let found = await this.getDomain(id);
    // Postmark only rechecks DNS when asked, so ask again until both records pass.
    if (!found.DKIMVerified) {
      found = await this.request<PostmarkDomain>(
        'account',
        'PUT',
        `/domains/${id}/verifyDkim`,
      ).catch(() => found);
    }
    if (!found.ReturnPathDomainVerified) {
      found = await this.request<PostmarkDomain>(
        'account',
        'PUT',
        `/domains/${id}/verifyReturnPath`,
      ).catch(() => found);
    }
    return postmarkDomainStatus(found);
  }

  async remove(_domain: string, providerRef: string | null): Promise<void> {
    const id = providerRef;
    if (id === null) return;
    try {
      await this.request('account', 'DELETE', `/domains/${id}`);
    } catch (error) {
      if (!(error instanceof PostmarkError && error.status === 404)) throw error;
    }
  }
}

/** MailAdapter for Postmark: Broadcasts, transactional mail and Direct Sends alike. */
export class PostmarkMail implements MailAdapter {
  /** Postmark publishes no rate per second, so this stays as cautious as Resend's. */
  readonly maxConcurrency = 8;

  constructor(
    private readonly client: PostmarkClient,
    private readonly messageIdDomain: string,
  ) {}

  async send(mail: OutgoingMail): Promise<SentMail> {
    const messageId = mail.messageId ?? `${crypto.randomUUID()}@${this.messageIdDomain}`;
    // List-Unsubscribe(-Post), Feedback-ID and X-Swarm-* pass through as they are.
    const headers = Object.entries({ ...mail.headers, 'Message-ID': `<${messageId}>` }).map(
      ([Name, Value]) => ({ Name, Value }),
    );
    const id = await this.client.sendEmail({
      From: formatAddress(mail.from),
      To: mail.to,
      Subject: mail.subject,
      HtmlBody: mail.html,
      TextBody: mail.text,
      ...(mail.replyTo ? { ReplyTo: mail.replyTo } : {}),
      Headers: headers,
      Tag: mail.category,
      Metadata: postmarkMetadata(mail.tags),
      MessageStream:
        mail.category === 'broadcast' ? POSTMARK_BROADCAST_STREAM : POSTMARK_TRANSACTIONAL_STREAM,
      TrackOpens: false,
      TrackLinks: 'None',
    });
    return { messageId: id };
  }
}
