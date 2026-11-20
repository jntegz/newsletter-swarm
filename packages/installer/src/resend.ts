import type { WantedRecord } from './cloudflare';
import type { HttpMethod, Transport } from './transport';
import { InstallError } from './ui';

// A thin client for the parts of the Resend API the installer needs. When @swarm/mail exports
// ResendClient (Phase 1), the domain calls can move there; this interface stays the same.

const BASE = 'https://api.resend.com';

export const RESEND_EVENTS = [
  'email.delivered',
  'email.bounced',
  'email.complained',
  'email.suppressed',
  'email.failed',
];

interface ResendRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  priority?: number;
  status?: string;
}

interface ResendDomain {
  id: string;
  name: string;
  status: string;
  region?: string;
  records?: ResendRecord[];
}

interface ResendWebhook {
  id: string;
  endpoint: string;
  signing_secret?: string;
}

class ResendError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ResendError';
  }
}

interface ResendApi {
  listDomains(): Promise<ResendDomain[]>;
  createDomain(name: string, region: string, returnPath: string): Promise<ResendDomain>;
  getDomain(id: string): Promise<ResendDomain>;
  verifyDomain(id: string): Promise<void>;
  sendEmail(from: string, to: string, subject: string, text: string): Promise<void>;
  listWebhooks(): Promise<ResendWebhook[]>;
  createWebhook(endpoint: string, events: string[]): Promise<ResendWebhook>;
  getWebhook(id: string): Promise<ResendWebhook>;
  deleteWebhook(id: string): Promise<void>;
}

export class ResendRest implements ResendApi {
  constructor(
    private readonly t: Transport,
    private readonly apiKey: string,
  ) {}

  private async call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const response = await this.t.http({
      method,
      url: BASE + path,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(response.text);
    } catch {
      parsed = {};
    }
    if (response.status >= 400) {
      const message = (parsed as { message?: string }).message ?? response.text.slice(0, 200);
      throw new ResendError(
        response.status,
        `Resend answered ${response.status} to ${method} ${path}: ${message}`,
      );
    }
    return parsed as T;
  }

  async listDomains() {
    return (await this.call<{ data?: ResendDomain[] }>('GET', '/domains')).data ?? [];
  }

  createDomain(name: string, region: string, returnPath: string) {
    return this.call<ResendDomain>('POST', '/domains', {
      name,
      region,
      custom_return_path: returnPath,
    });
  }

  getDomain(id: string) {
    return this.call<ResendDomain>('GET', `/domains/${id}`);
  }

  async sendEmail(from: string, to: string, subject: string, text: string) {
    await this.call('POST', '/emails', { from, to: [to], subject, text });
  }

  async verifyDomain(id: string) {
    await this.call('POST', `/domains/${id}/verify`);
  }

  async listWebhooks() {
    return (await this.call<{ data?: ResendWebhook[] }>('GET', '/webhooks')).data ?? [];
  }

  createWebhook(endpoint: string, events: string[]) {
    return this.call<ResendWebhook>('POST', '/webhooks', { endpoint, events });
  }

  getWebhook(id: string) {
    return this.call<ResendWebhook>('GET', `/webhooks/${id}`);
  }

  async deleteWebhook(id: string) {
    await this.call('DELETE', `/webhooks/${id}`);
  }
}

/** Checks the key by listing domains; a 401/403 means the key is wrong or restricted. */
export async function validateResendKey(api: ResendApi): Promise<void> {
  try {
    await api.listDomains();
  } catch (error) {
    if (error instanceof ResendError && (error.status === 401 || error.status === 403)) {
      throw new InstallError(
        'Resend did not accept the API key.',
        'Create a key with "Full access" at https://resend.com/api-keys and paste it again.',
      );
    }
    throw error;
  }
}

/**
 * A record name as a full domain, the same way @swarm/mail's resendRecordName does it. Names can be
 * relative to the root domain ("resend._domainkey.mail" for mail.example.com), which is what Resend
 * really sends, relative to the sending domain ("send"), or already full.
 */
export function fullRecordName(name: string, domain: string): string {
  if (name === domain || name.endsWith(`.${domain}`)) return name;
  const labels = domain.split('.');
  for (let cut = labels.length - 1; cut > 0; cut--) {
    const start = labels.slice(0, cut).join('.');
    if (name === start || name.endsWith(`.${start}`)) {
      return `${name}.${labels.slice(cut).join('.')}`;
    }
  }
  return `${name}.${domain}`;
}

/**
 * Resend's records as zone records. Names come back relative ("resend._domainkey") or in full;
 * the domain is appended only when missing. Receiving and tracking records are skipped.
 */
export function resendZoneRecords(domain: string, records: ResendRecord[]): WantedRecord[] {
  return records
    .filter((r) => r.record === 'SPF' || r.record === 'DKIM')
    .filter((r): r is ResendRecord & { type: 'TXT' | 'CNAME' | 'MX' } =>
      ['TXT', 'CNAME', 'MX'].includes(r.type),
    )
    .map((r) => ({
      type: r.type,
      name: fullRecordName(r.name, domain),
      content: r.value,
      ...(r.type === 'MX' ? { priority: r.priority ?? 10 } : {}),
      proxied: false,
    }));
}
