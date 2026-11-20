/**
 * AWS SES v2 over plain fetch: raw sends with a configuration set, domain identities (Easy DKIM
 * RSA-2048 plus a custom MAIL FROM subdomain), dedicated sending (a Channel's own
 * configuration set and a managed dedicated IP pool, Phase 7) and the account-level
 * suppression list.
 */
import {
  IdentityExistsError,
  MailProviderError,
  retryAfterSeconds,
  type ProviderQuota,
} from './errors';
import { buildMime } from './mime';
import { signRequest, type AwsCredentials } from './sigv4';
import type { MailAdapter, OutgoingMail, SentMail } from './index';

interface SesConfig {
  region: string;
  credentials: AwsCredentials;
  configurationSet: string;
  /** SNS topic for SES events; needed only to create configuration sets. */
  eventTopicArn?: string;
  fetch?: typeof fetch;
}

/** SES error codes that mean the whole account can't send: stop the Broadcast. */
const SES_HALTING_CODES: ReadonlySet<string> = new Set([
  'AccountSuspendedException',
  'SendingPausedException',
  'MailFromDomainNotVerifiedException',
]);

export class SesError extends MailProviderError {
  constructor(status: number, code: string, message: string, retryAfter: number | null = null) {
    super(status, code, message, retryAfter);
    this.name = 'SesError';
  }

  /**
   * SES says "Daily message quota exceeded" when the account's 24-hour quota (Max24HourSend) is
   * used up. It is matched on the message, which SES documents, because the error code differs
   * between its APIs.
   */
  override get quota(): ProviderQuota | null {
    return /daily message quota exceeded/i.test(this.message) ? 'day' : null;
  }

  /** Throttling and server errors are worth retrying; rejections and a used-up quota are not. */
  override get retryable(): boolean {
    if (this.quota) return false;
    return (
      this.status === 429 ||
      this.status >= 500 ||
      this.code === 'TooManyRequestsException' ||
      this.code === 'LimitExceededException'
    );
  }

  override get halting(): boolean {
    return SES_HALTING_CODES.has(this.code);
  }
}

export interface DomainIdentityStatus {
  verifiedForSending: boolean;
  dkimStatus: 'pending' | 'success' | 'failed' | 'not_started';
  mailFromStatus: 'pending' | 'success' | 'failed' | 'not_started';
}

/**
 * A DNS record the provider needs for a sending domain (DKIM and the MAIL FROM/return path), with
 * a fully qualified name. The DMARC record is Swarm's own and is added by the engine.
 */
export interface ProviderDnsRecord {
  purpose: 'dkim' | 'mail_from_mx' | 'mail_from_spf';
  type: 'CNAME' | 'TXT' | 'MX';
  name: string;
  value: string;
  priority?: number;
}

export interface CreatedIdentity {
  records: ProviderDnsRecord[];
  /** The provider's id for the domain (Resend); null when the domain name is the id (SES). */
  providerRef: string | null;
}

/** The provider side of sending domains. The dev implementation lives in ./index. */
export interface DomainIdentities {
  /**
   * Creates the identity and returns the DNS records to publish. One the service already has is
   * refused with IdentityExistsError, never taken over.
   */
  create(domain: string, mailFromDomain: string): Promise<CreatedIdentity>;
  /**
   * The records the provider wants for a domain it already has, or none if it doesn't have it.
   * Only reads, unlike create, so it's safe to call just to look.
   */
  records(domain: string, providerRef: string | null): Promise<ProviderDnsRecord[]>;
  /**
   * Services with their own ids look only at providerRef: without one the row never created a
   * domain there, so it isn't verified and there is nothing to remove.
   */
  status(domain: string, providerRef: string | null): Promise<DomainIdentityStatus>;
  /** Idempotent: a domain the provider no longer has is success. */
  remove(domain: string, providerRef: string | null): Promise<void>;
}

/** Records for an SES identity: Easy DKIM CNAMEs and the MAIL FROM MX and SPF. */
export function sesIdentityRecords(
  domain: string,
  dkimTokens: string[],
  region: string,
  mailFromDomain = `bounce.${domain}`,
): ProviderDnsRecord[] {
  return [
    ...dkimTokens.map((token): ProviderDnsRecord => ({
      purpose: 'dkim',
      type: 'CNAME',
      name: `${token}._domainkey.${domain}`,
      value: `${token}.dkim.amazonses.com`,
    })),
    {
      purpose: 'mail_from_mx',
      type: 'MX',
      name: mailFromDomain,
      value: `feedback-smtp.${region}.amazonses.com`,
      priority: 10,
    },
    {
      purpose: 'mail_from_spf',
      type: 'TXT',
      name: mailFromDomain,
      value: 'v=spf1 include:amazonses.com ~all',
    },
  ];
}

/** The account's standing with SES: the sandbox, and how much it may send. */
export interface SesAccount {
  productionAccess: boolean;
  sendingEnabled: boolean;
  max24HourSend: number | null;
  maxSendRate: number | null;
  sentLast24Hours: number | null;
}

/** Managed dedicated IP warm-up as SES reports it. */
interface PoolWarmup {
  state: 'in_progress' | 'done';
  /** 0-100; SES reports it per IP, this is the lowest. */
  percent: number;
}

/**
 * The provider side of dedicated sending (Phase 7). The dev implementation is
 * DevDedicatedSending in ./index. Every call is idempotent: "already exists" is success.
 */
export interface DedicatedSending {
  /** A configuration set with reputation metrics and an event destination to the SNS topic. */
  createConfigurationSet(name: string): Promise<void>;
  /** A dedicated IP pool with ScalingMode MANAGED (SES picks, warms and scales the IPs). */
  createDedicatedIpPool(name: string): Promise<void>;
  /** Sends through the configuration set leave from the pool's IPs. */
  attachPool(configurationSet: string, pool: string): Promise<void>;
  poolWarmup(pool: string): Promise<PoolWarmup>;
}

/** Why an address is on the provider's suppression list. */
type SuppressedReason = 'BOUNCE' | 'COMPLAINT';

interface SuppressedDestination {
  email: string;
  reason: SuppressedReason;
  /** Epoch milliseconds. */
  updatedAt: number;
}

/**
 * The provider's account-level suppression list (SES v2 Put/Delete/ListSuppressedDestinations).
 * It covers every workspace on the platform. The dev implementation is DevSuppressionList in
 * ./index. Put and delete are idempotent: putting twice overwrites, deleting a missing address
 * is success.
 */
export interface SuppressionList {
  putSuppressed(email: string, reason: SuppressedReason): Promise<void>;
  deleteSuppressed(email: string): Promise<void>;
  /** One page of addresses added or updated in [from, to). `nextToken` continues it. */
  listSuppressed(input: {
    from: number;
    to: number;
    nextToken?: string | undefined;
    pageSize?: number;
  }): Promise<{ items: SuppressedDestination[]; nextToken: string | null }>;
}

/** Event types every configuration set publishes; the same as the shared sets (docs/deployment.md). */
const SES_EVENT_TYPES = ['BOUNCE', 'COMPLAINT', 'DELIVERY', 'REJECT'] as const;

const mapStatus = (value: unknown): DomainIdentityStatus['dkimStatus'] => {
  switch (value) {
    case 'SUCCESS':
      return 'success';
    case 'FAILED':
    case 'TEMPORARY_FAILURE':
      return 'failed';
    case 'NOT_STARTED':
      return 'not_started';
    default:
      return 'pending';
  }
};

export class SesClient implements DomainIdentities, DedicatedSending, SuppressionList {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: SesConfig) {
    if (!/^[a-z]{2}-[a-z]+-\d$/.test(config.region)) throw new Error('invalid SES region');
    this.endpoint = `https://email.${config.region}.amazonaws.com`;
    this.fetcher = config.fetch ?? ((input, init) => fetch(input, init));
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.endpoint}${path}`;
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers = await signRequest({
      method,
      url,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: payload,
      service: 'ses',
      region: this.config.region,
      credentials: this.config.credentials,
    });
    const res = await this.fetcher(url, {
      method,
      headers,
      body: body === undefined ? null : payload,
    });
    const text = await res.text();
    if (!res.ok) {
      let code = res.headers.get('x-amzn-errortype')?.split(':')[0] ?? 'UnknownError';
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { message?: string; Message?: string; __type?: string };
        code = parsed.__type?.split('#').pop() ?? code;
        message = parsed.message ?? parsed.Message ?? message;
      } catch {
        // Non-JSON error body; keep the raw text.
      }
      throw new SesError(
        res.status,
        code,
        message,
        retryAfterSeconds(res.headers.get('retry-after')),
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** SendEmail with Content.Raw. Returns the SES MessageId. */
  async sendRaw(input: {
    from: string;
    to: string;
    raw: string;
    tags?: Record<string, string>;
    /** Overrides the configured set, e.g. a Channel's own (Phase 7). */
    configurationSet?: string;
  }): Promise<string> {
    const bytes = new TextEncoder().encode(input.raw);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const result = await this.request<{ MessageId: string }>('POST', '/v2/email/outbound-emails', {
      FromEmailAddress: input.from,
      Destination: { ToAddresses: [input.to] },
      Content: { Raw: { Data: btoa(binary) } },
      ConfigurationSetName: input.configurationSet ?? this.config.configurationSet,
      EmailTags: Object.entries(input.tags ?? {}).map(([Name, Value]) => ({
        Name: sanitizeTag(Name),
        Value: sanitizeTag(Value),
      })),
    });
    return result.MessageId;
  }

  async records(domain: string): Promise<ProviderDnsRecord[]> {
    let identity: {
      DkimAttributes?: { Tokens?: string[] };
      MailFromAttributes?: { MailFromDomain?: string };
    };
    try {
      identity = await this.request('GET', `/v2/email/identities/${encodeURIComponent(domain)}`);
    } catch (error) {
      if (error instanceof SesError && error.code === 'NotFoundException') return [];
      throw error;
    }
    return sesIdentityRecords(
      domain,
      identity.DkimAttributes?.Tokens ?? [],
      this.config.region,
      identity.MailFromAttributes?.MailFromDomain || `bounce.${domain}`,
    );
  }

  async account(): Promise<SesAccount> {
    const account = await this.request<{
      ProductionAccessEnabled?: boolean;
      SendingEnabled?: boolean;
      SendQuota?: { Max24HourSend?: number; MaxSendRate?: number; SentLast24Hours?: number };
    }>('GET', '/v2/email/account');
    return {
      productionAccess: account.ProductionAccessEnabled === true,
      sendingEnabled: account.SendingEnabled === true,
      max24HourSend: account.SendQuota?.Max24HourSend ?? null,
      maxSendRate: account.SendQuota?.MaxSendRate ?? null,
      sentLast24Hours: account.SendQuota?.SentLast24Hours ?? null,
    };
  }

  async create(domain: string, mailFromDomain: string): Promise<CreatedIdentity> {
    let tokens: string[] = [];
    try {
      const created = await this.request<{ DkimAttributes?: { Tokens?: string[] } }>(
        'POST',
        '/v2/email/identities',
        {
          EmailIdentity: domain,
          DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
          ConfigurationSetName: this.config.configurationSet,
        },
      );
      tokens = created.DkimAttributes?.Tokens ?? [];
    } catch (error) {
      // An identity Swarm didn't just create may be another environment's or the operator's,
      // verified or not: taking it over would hand its DKIM key to whoever added the domain.
      if (error instanceof SesError && error.code === 'AlreadyExistsException') {
        throw new IdentityExistsError(domain);
      }
      throw error;
    }
    await this.request('PUT', `/v2/email/identities/${encodeURIComponent(domain)}/mail-from`, {
      MailFromDomain: mailFromDomain,
      BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
    });
    return {
      records: sesIdentityRecords(domain, tokens, this.config.region, mailFromDomain),
      providerRef: null,
    };
  }

  async status(domain: string): Promise<DomainIdentityStatus> {
    const result = await this.request<{
      VerifiedForSendingStatus?: boolean;
      DkimAttributes?: { Status?: string };
      MailFromAttributes?: { MailFromDomainStatus?: string };
    }>('GET', `/v2/email/identities/${encodeURIComponent(domain)}`);
    return {
      verifiedForSending: result.VerifiedForSendingStatus === true,
      dkimStatus: mapStatus(result.DkimAttributes?.Status),
      mailFromStatus: mapStatus(result.MailFromAttributes?.MailFromDomainStatus),
    };
  }

  async remove(domain: string): Promise<void> {
    try {
      await this.request('DELETE', `/v2/email/identities/${encodeURIComponent(domain)}`);
    } catch (error) {
      if (!(error instanceof SesError && error.code === 'NotFoundException')) throw error;
    }
  }

  /** Runs `call`, treating SES's AlreadyExistsException as success. */
  private async idempotent(call: () => Promise<unknown>): Promise<void> {
    try {
      await call();
    } catch (error) {
      if (!(error instanceof SesError && error.code === 'AlreadyExistsException')) throw error;
    }
  }

  async createConfigurationSet(name: string): Promise<void> {
    const topic = this.config.eventTopicArn;
    if (!topic) throw new Error('eventTopicArn is required to create configuration sets');
    await this.idempotent(() =>
      this.request('POST', '/v2/email/configuration-sets', {
        ConfigurationSetName: name,
        ReputationOptions: { ReputationMetricsEnabled: true },
        SendingOptions: { SendingEnabled: true },
      }),
    );
    await this.idempotent(() =>
      this.request(
        'POST',
        `/v2/email/configuration-sets/${encodeURIComponent(name)}/event-destinations`,
        {
          EventDestinationName: 'swarm-events',
          EventDestination: {
            Enabled: true,
            MatchingEventTypes: [...SES_EVENT_TYPES],
            SnsDestination: { TopicArn: topic },
          },
        },
      ),
    );
  }

  async createDedicatedIpPool(name: string): Promise<void> {
    await this.idempotent(() =>
      this.request('POST', '/v2/email/dedicated-ip-pools', {
        PoolName: name,
        ScalingMode: 'MANAGED',
      }),
    );
  }

  async attachPool(configurationSet: string, pool: string): Promise<void> {
    await this.request(
      'PUT',
      `/v2/email/configuration-sets/${encodeURIComponent(configurationSet)}/delivery-options`,
      { SendingPoolName: pool },
    );
  }

  async poolWarmup(pool: string): Promise<PoolWarmup> {
    const result = await this.request<{
      DedicatedIps?: { WarmupStatus?: string; WarmupPercentage?: number }[];
    }>('GET', `/v2/email/dedicated-ips?PoolName=${encodeURIComponent(pool)}&PageSize=100`);
    const ips = result.DedicatedIps ?? [];
    // A managed pool has no IPs until SES assigns them: still warming.
    if (ips.length === 0) return { state: 'in_progress', percent: 0 };
    const warmed = (status?: string) => status === 'DONE' || status === 'NOT_APPLICABLE';
    if (ips.every((ip) => warmed(ip.WarmupStatus))) return { state: 'done', percent: 100 };
    const percent = Math.min(
      ...ips.map((ip) =>
        warmed(ip.WarmupStatus)
          ? 100
          : Math.max(0, Math.min(100, Math.round(ip.WarmupPercentage ?? 0))),
      ),
    );
    return { state: 'in_progress', percent };
  }

  async putSuppressed(email: string, reason: SuppressedReason): Promise<void> {
    await this.request('PUT', '/v2/email/suppression/addresses', {
      EmailAddress: email,
      Reason: reason,
    });
  }

  async deleteSuppressed(email: string): Promise<void> {
    try {
      await this.request('DELETE', `/v2/email/suppression/addresses/${encodeURIComponent(email)}`);
    } catch (error) {
      if (!(error instanceof SesError && error.code === 'NotFoundException')) throw error;
    }
  }

  async listSuppressed(input: {
    from: number;
    to: number;
    nextToken?: string | undefined;
    pageSize?: number;
  }): Promise<{ items: SuppressedDestination[]; nextToken: string | null }> {
    const query = new URLSearchParams({
      StartDate: new Date(input.from).toISOString(),
      EndDate: new Date(input.to).toISOString(),
      PageSize: String(Math.min(1000, Math.max(1, input.pageSize ?? 1000))),
    });
    if (input.nextToken) query.set('NextToken', input.nextToken);
    const result = await this.request<{
      SuppressedDestinationSummaries?: {
        EmailAddress?: string;
        Reason?: string;
        LastUpdateTime?: number | string;
      }[];
      NextToken?: string;
    }>('GET', `/v2/email/suppression/addresses?${query.toString()}`);
    const items: SuppressedDestination[] = [];
    for (const row of result.SuppressedDestinationSummaries ?? []) {
      if (!row.EmailAddress || (row.Reason !== 'BOUNCE' && row.Reason !== 'COMPLAINT')) continue;
      // REST-JSON timestamps are epoch seconds; accept ISO strings too.
      const time = row.LastUpdateTime;
      const updatedAt =
        typeof time === 'number' ? Math.round(time * 1000) : Date.parse(time ?? '') || input.to;
      items.push({ email: row.EmailAddress.toLowerCase(), reason: row.Reason, updatedAt });
    }
    return { items, nextToken: result.NextToken ?? null };
  }
}

/** SES tag names and values allow only [A-Za-z0-9_-], up to 256 characters. */
export function sanitizeTag(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) || '_';
}

/** MailAdapter for transactional mail (QuickPass, invites) through SES. */
export class SesMail implements MailAdapter {
  /** Ten in flight keeps a batch well inside the account's per-second rate. */
  readonly maxConcurrency = 10;

  constructor(
    private readonly client: SesClient,
    private readonly messageIdDomain: string,
  ) {}

  async send(mail: OutgoingMail): Promise<SentMail> {
    const raw = buildMime({
      from: mail.from,
      to: mail.to,
      replyTo: mail.replyTo ?? null,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: mail.headers ?? {},
      messageId: mail.messageId ?? `${crypto.randomUUID()}@${this.messageIdDomain}`,
    });
    const messageId = await this.client.sendRaw({
      from: mail.from.address,
      to: mail.to,
      raw,
      tags: { category: mail.category, ...mail.tags },
      ...(mail.configurationSet ? { configurationSet: mail.configurationSet } : {}),
    });
    return { messageId };
  }
}
