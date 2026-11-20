import type { WantedRecord } from './cloudflare';
import { fullRecordName } from './resend';
import type { HttpMethod, Transport } from './transport';
import { InstallError } from './ui';

type MailgunRegion = 'us' | 'eu';

const mailgunBaseUrl = (region: MailgunRegion) =>
  region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';

interface MailgunDnsRecord {
  record_type?: string;
  name?: string;
  value?: string;
}

interface MailgunDomainResponse {
  domain?: { name?: string; state?: string };
  sending_dns_records?: MailgunDnsRecord[] | null;
}

/** The webhooks Swarm acts on. Mailgun addresses each one by this name. */
export const MAILGUN_WEBHOOKS = ['delivered', 'permanent_fail', 'temporary_fail', 'complained'];

const BOUNDARY = 'swarm-installer-form';

/** A multipart/form-data body, which Mailgun's docs require on these calls. */
export function multipartBody(fields: Record<string, string | string[]>): string {
  const parts = Object.entries(fields).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map(
      (item) =>
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${item}\r\n`,
    ),
  );
  return `${parts.join('')}--${BOUNDARY}--\r\n`;
}

class MailgunApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MailgunApiError';
  }
}

export class MailgunRest {
  private readonly base: string;

  constructor(
    private readonly t: Transport,
    private readonly apiKey: string,
    region: MailgunRegion,
  ) {
    this.base = mailgunBaseUrl(region);
  }

  private async call<T>(
    method: HttpMethod,
    path: string,
    fields?: Record<string, string | string[]>,
  ): Promise<T> {
    const response = await this.t.http({
      method,
      url: this.base + path,
      headers: {
        authorization: `Basic ${btoa(`api:${this.apiKey}`)}`,
        ...(fields ? { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` } : {}),
      },
      ...(fields ? { body: multipartBody(fields) } : {}),
    });
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(response.text);
    } catch {
      parsed = {};
    }
    if (response.status >= 400) {
      const message = (parsed as { message?: string }).message ?? response.text.slice(0, 200);
      throw new MailgunApiError(
        response.status,
        `Mailgun answered ${response.status} to ${method} ${path}: ${message}`,
      );
    }
    return parsed as T;
  }

  /** Also checks the key: only the account's primary key may read this. */
  async signingKey(): Promise<string> {
    const { http_signing_key: key } = await this.call<{ http_signing_key?: string }>(
      'GET',
      '/v5/accounts/http_signing_key',
    );
    if (!key) throw new InstallError('Mailgun did not return the webhook signing key.');
    return key;
  }

  async getDomain(name: string): Promise<MailgunDomainResponse | null> {
    try {
      return await this.call<MailgunDomainResponse>('GET', `/v4/domains/${name}`);
    } catch (error) {
      if (error instanceof MailgunApiError && error.status === 404) return null;
      throw error;
    }
  }

  createDomain(name: string) {
    return this.call<MailgunDomainResponse>('POST', '/v4/domains', {
      name,
      dkim_key_size: '2048',
    });
  }

  async sendEmail(domain: string, from: string, to: string, subject: string, text: string) {
    await this.call('POST', `/v3/${domain}/messages`, { from, to, subject, text });
  }

  verifyDomain(name: string) {
    return this.call<MailgunDomainResponse>('PUT', `/v4/domains/${name}/verify`);
  }

  /** The URLs of a domain's webhooks, by webhook name. */
  async listWebhooks(domain: string): Promise<Record<string, string[]>> {
    const { webhooks = {} } = await this.call<{
      webhooks?: Record<string, { urls?: string[] }>;
    }>('GET', `/v3/domains/${domain}/webhooks`);
    return Object.fromEntries(Object.entries(webhooks).map(([k, v]) => [k, v.urls ?? []]));
  }

  async createWebhook(domain: string, id: string, url: string) {
    await this.call('POST', `/v3/domains/${domain}/webhooks`, { id, url });
  }

  async updateWebhook(domain: string, id: string, urls: string[]) {
    await this.call('PUT', `/v3/domains/${domain}/webhooks/${id}`, { url: urls });
  }
}

/** Reads the signing key, which also proves the API key is the kind Swarm needs. */
export async function mailgunSigningKey(api: MailgunRest): Promise<string> {
  try {
    return await api.signingKey();
  } catch (error) {
    if (error instanceof MailgunApiError && (error.status === 401 || error.status === 403)) {
      throw new InstallError(
        'Mailgun did not accept the API key.',
        'Use the Private API key from Account Settings > API Keys (a domain sending key is not enough), and check the region matches your account.',
      );
    }
    throw error;
  }
}

/**
 * Mailgun's DKIM and SPF records as zone records, the same ones @swarm/mail's
 * mailgunIdentityRecords picks. The tracking CNAME is skipped, because Swarm turns tracking off.
 */
export function mailgunZoneRecords(
  domain: string,
  response: MailgunDomainResponse,
): WantedRecord[] {
  const out: WantedRecord[] = [];
  for (const record of response.sending_dns_records ?? []) {
    const type = (record.record_type ?? '').toUpperCase();
    const name = record.name ?? '';
    const value = record.value ?? '';
    const spf = type === 'TXT' && /^"?v=spf1\b/i.test(value.trim());
    if ((type !== 'TXT' && type !== 'CNAME') || (!spf && !name.includes('._domainkey'))) continue;
    out.push({
      type,
      name: fullRecordName(name, domain),
      content: type === 'TXT' ? value.replace(/^"(.*)"$/s, '$1') : value,
      proxied: false,
    });
  }
  return out;
}
