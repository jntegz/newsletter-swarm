import type { WantedRecord } from './cloudflare';
import type { HttpMethod, Transport } from './transport';
import { InstallError } from './ui';

const BASE = 'https://api.postmarkapp.com';

/** The same stream ids as @swarm/mail. */
export const POSTMARK_BROADCAST_STREAM = 'broadcasts';
export const POSTMARK_TRANSACTIONAL_STREAM = 'outbound';

/** "You do not have permission to use Custom Unsubscribe Handling for this stream." */
const CUSTOM_UNSUBSCRIBE_REFUSED = 1238;

interface PostmarkServer {
  ID: number;
  Name: string;
  ApiTokens?: string[];
}

interface PostmarkDomain {
  ID: number;
  Name: string;
  DKIMVerified?: boolean;
  DKIMHost?: string;
  DKIMTextValue?: string;
  DKIMPendingHost?: string;
  DKIMPendingTextValue?: string;
  ReturnPathDomain?: string;
  ReturnPathDomainVerified?: boolean;
  ReturnPathDomainCNAMEValue?: string;
}

interface PostmarkStream {
  ID: string;
  SubscriptionManagementConfiguration?: { UnsubscribeHandlingType?: string };
}

class PostmarkApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'PostmarkApiError';
  }
}

export class PostmarkRest {
  constructor(
    private readonly t: Transport,
    private readonly tokens: { account?: string; server?: string },
  ) {}

  private async call<T>(
    token: 'account' | 'server',
    method: HttpMethod,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const value = this.tokens[token];
    if (!value)
      throw new InstallError(`The Postmark ${token} token is missing.`, 'Run `pnpm swarm`.');
    const response = await this.t.http({
      method,
      url: BASE + path,
      headers: {
        accept: 'application/json',
        [`x-postmark-${token}-token`]: value,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let parsed: { ErrorCode?: number; Message?: string } = {};
    try {
      parsed = JSON.parse(response.text) as typeof parsed;
    } catch {
      parsed = {};
    }
    if (response.status >= 400) {
      throw new PostmarkApiError(
        response.status,
        parsed.ErrorCode ?? 0,
        `Postmark answered ${response.status} to ${method} ${path}: ${parsed.Message ?? response.text.slice(0, 200)}`,
      );
    }
    return parsed as T;
  }

  /** The server with this exact name, created when missing. Its token is what the workers send with. */
  async ensureServer(name: string): Promise<PostmarkServer> {
    const { Servers = [] } = await this.call<{ Servers?: PostmarkServer[] }>(
      'account',
      'GET',
      `/servers?count=500&offset=0&name=${encodeURIComponent(name)}`,
    );
    return (
      Servers.find((s) => s.Name === name) ??
      this.call<PostmarkServer>('account', 'POST', '/servers', { Name: name })
    );
  }

  /** Creates the broadcast stream when missing, and says who handles its unsubscribes. */
  async ensureBroadcastStream(): Promise<string> {
    const { MessageStreams = [] } = await this.call<{ MessageStreams?: PostmarkStream[] }>(
      'server',
      'GET',
      '/message-streams?MessageStreamType=Broadcasts',
    );
    const existing = MessageStreams.find((s) => s.ID === POSTMARK_BROADCAST_STREAM);
    if (existing) {
      return existing.SubscriptionManagementConfiguration?.UnsubscribeHandlingType ?? 'Postmark';
    }
    const stream = {
      ID: POSTMARK_BROADCAST_STREAM,
      Name: 'Swarm posts',
      MessageStreamType: 'Broadcasts',
    };
    try {
      await this.call('server', 'POST', '/message-streams', {
        ...stream,
        SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Custom' },
      });
      return 'Custom';
    } catch (error) {
      if (!(error instanceof PostmarkApiError) || error.errorCode !== CUSTOM_UNSUBSCRIBE_REFUSED) {
        throw error;
      }
      await this.call('server', 'POST', '/message-streams', stream);
      return 'Postmark';
    }
  }

  async ensureDomain(name: string, returnPath: string): Promise<PostmarkDomain> {
    const { Domains = [] } = await this.call<{ Domains?: PostmarkDomain[] }>(
      'account',
      'GET',
      '/domains?count=500&offset=0',
    );
    const found = Domains.find((d) => d.Name === name);
    return found
      ? this.getDomain(found.ID)
      : this.call<PostmarkDomain>('account', 'POST', '/domains', {
          Name: name,
          ReturnPathDomain: returnPath,
        });
  }

  getDomain(id: number) {
    return this.call<PostmarkDomain>('account', 'GET', `/domains/${id}`);
  }

  async sendEmail(from: string, to: string, subject: string, text: string) {
    await this.call('server', 'POST', '/email', {
      From: from,
      To: to,
      Subject: subject,
      TextBody: text,
      MessageStream: POSTMARK_TRANSACTIONAL_STREAM,
    });
  }

  verifyDkim(id: number) {
    return this.call<PostmarkDomain>('account', 'PUT', `/domains/${id}/verifyDkim`);
  }

  verifyReturnPath(id: number) {
    return this.call<PostmarkDomain>('account', 'PUT', `/domains/${id}/verifyReturnPath`);
  }

  /** Connects a stream to the endpoint, unless a webhook on it already points there. */
  async ensureWebhook(stream: string, url: string, password: string, subscriptionChange: boolean) {
    const { Webhooks = [] } = await this.call<{ Webhooks?: { Url?: string }[] }>(
      'server',
      'GET',
      `/webhooks?MessageStream=${stream}`,
    );
    if (Webhooks.some((w) => w.Url === url)) return;
    await this.call('server', 'POST', '/webhooks', {
      Url: url,
      MessageStream: stream,
      HttpAuth: { Username: 'swarm', Password: password },
      Triggers: {
        Delivery: { Enabled: true },
        Bounce: { Enabled: true, IncludeContent: false },
        SpamComplaint: { Enabled: true, IncludeContent: false },
        ...(subscriptionChange ? { SubscriptionChange: { Enabled: true } } : {}),
      },
    });
  }
}

/** Explains a refused account token, which is the mistake people are likeliest to make. */
export async function checkedPostmarkServer(
  api: PostmarkRest,
  name: string,
): Promise<PostmarkServer> {
  try {
    return await api.ensureServer(name);
  } catch (error) {
    if (error instanceof PostmarkApiError && error.status === 401) {
      throw new InstallError(
        'Postmark did not accept the account token.',
        'Copy the Account API token from the API Tokens page in Postmark. A server token is not enough.',
      );
    }
    throw error;
  }
}

/** Postmark's DKIM and return-path records as zone records. */
export function postmarkZoneRecords(domain: PostmarkDomain): WantedRecord[] {
  const out: WantedRecord[] = [];
  const host = domain.DKIMPendingHost || domain.DKIMHost;
  const value = domain.DKIMPendingTextValue || domain.DKIMTextValue;
  if (host && value) out.push({ type: 'TXT', name: host, content: value, proxied: false });
  if (domain.ReturnPathDomain && domain.ReturnPathDomainCNAMEValue) {
    out.push({
      type: 'CNAME',
      name: domain.ReturnPathDomain,
      content: domain.ReturnPathDomainCNAMEValue,
      proxied: false,
    });
  }
  return out;
}
