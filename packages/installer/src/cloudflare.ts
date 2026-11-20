import type { HttpMethod, Transport } from './transport';
import { InstallError } from './ui';

const BASE = 'https://api.cloudflare.com/client/v4';

export class CloudflareError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly errors: { code: number; message: string }[],
  ) {
    super(
      `Cloudflare answered ${status} to ${method} ${path}: ${
        errors.map((e) => `${e.message} (${e.code})`).join('; ') || 'no details'
      }`,
    );
    this.name = 'CloudflareError';
  }

  get forbidden() {
    return this.status === 401 || this.status === 403 || this.errors.some((e) => e.code === 10000);
  }
}

interface Envelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: { page?: number; total_pages?: number };
}

/**
 * The Cloudflare REST API with one token. The installer holds two: wrangler's OAuth token
 * (account resources, Turnstile, routes, Email Routing, D1 queries) and the scoped DNS token the
 * person pastes (DNS records only; it is never given to a worker).
 */
export class CloudflareApi {
  constructor(
    private readonly t: Transport,
    private readonly token: string,
    readonly label: string,
  ) {}

  async request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    query?: Record<string, string | number>,
  ): Promise<Envelope<T>> {
    const url = new URL(BASE + path);
    for (const [key, value] of Object.entries(query ?? {}))
      url.searchParams.set(key, String(value));
    const response = await this.t.http({
      method,
      url: url.toString(),
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(response.text) as Envelope<T>;
    } catch {
      throw new CloudflareError(response.status, method, path, [
        { code: 0, message: response.text.slice(0, 200) },
      ]);
    }
    if (response.status >= 400 || envelope.success === false) {
      throw new CloudflareError(response.status, method, path, envelope.errors ?? []);
    }
    return envelope;
  }

  async get<T>(path: string, query?: Record<string, string | number>): Promise<T> {
    return (await this.request<T>('GET', path, undefined, query)).result;
  }

  /** Worker settings are the one PATCH that takes a form, not JSON. */
  async patchSettings(path: string, settings: unknown): Promise<void> {
    const boundary = `swarm${Math.random().toString(36).slice(2)}`;
    const response = await this.t.http({
      method: 'PATCH',
      url: BASE + path,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: `--${boundary}\r\nContent-Disposition: form-data; name="settings"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(settings)}\r\n--${boundary}--\r\n`,
    });
    if (response.status >= 400) {
      throw new InstallError(
        `Cloudflare refused the Worker settings (${response.status}).`,
        'Check the token has Workers Scripts: Edit, then try again.',
      );
    }
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.request<T>('POST', path, body)).result;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return (await this.request<T>('PUT', path, body)).result;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return (await this.request<T>('PATCH', path, body)).result;
  }

  /** Every page of a list endpoint. */
  async list<T>(
    path: string,
    query: Record<string, string | number> = {},
    perPage = 100,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const envelope = await this.request<T[]>('GET', path, undefined, {
        ...query,
        page,
        per_page: perPage,
      });
      out.push(...(envelope.result ?? []));
      const total = envelope.result_info?.total_pages ?? 1;
      if (page >= total || (envelope.result ?? []).length < perPage) break;
    }
    return out;
  }
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  priority?: number;
}

/** The DNS token's link: the dashboard opens with these permissions already picked. */
export function dnsTokenLink(): string {
  const permissions = JSON.stringify([
    { key: 'dns', type: 'edit' },
    { key: 'zone', type: 'read' },
    { key: 'workers_routes', type: 'edit' },
    { key: 'zone_settings', type: 'edit' },
  ]);
  return (
    'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=' +
    encodeURIComponent(permissions) +
    '&accountId=*&zoneId=all&name=swarm-installer'
  );
}

export async function verifyToken(cf: CloudflareApi): Promise<void> {
  try {
    const result = await cf.get<{ status: string }>('/user/tokens/verify');
    if (result.status !== 'active') {
      throw new InstallError(
        `The DNS token is ${result.status}.`,
        'Create a new token with the link above and paste it again.',
      );
    }
  } catch (error) {
    if (error instanceof CloudflareError) {
      throw new InstallError(
        'Cloudflare did not accept the DNS token.',
        'Check that you copied the whole token, or create a new one with the link above.',
      );
    }
    throw error;
  }
}

/** TXT content must be quoted in the Cloudflare API. */
const quoteTxt = (value: string) => (value.startsWith('"') ? value : `"${value}"`);
const unquote = (value: string) => value.replace(/^"|"$/g, '').replace(/"\s*"/g, '');

export interface WantedRecord {
  type: 'TXT' | 'CNAME' | 'MX' | 'AAAA';
  name: string;
  content: string;
  priority?: number | undefined;
  proxied?: boolean | undefined;
}

/**
 * Creates or updates one record, matched by name and type. TXT records are matched by their
 * leading tag (v=DMARC1, v=spf1, DKIM keys) so other TXT records at the same name survive.
 * Returns what happened.
 */
export async function upsertRecord(
  cf: CloudflareApi,
  zoneId: string,
  wanted: WantedRecord,
): Promise<'created' | 'updated' | 'unchanged'> {
  const existing = await cf.list<DnsRecord>(`/zones/${zoneId}/dns_records`, { name: wanted.name });
  const content = wanted.type === 'TXT' ? quoteTxt(wanted.content) : wanted.content;
  const conflict = existing.find(
    (r) =>
      r.type !== wanted.type &&
      (r.type === 'CNAME' || wanted.type === 'CNAME' || (wanted.type === 'AAAA' && r.type === 'A')),
  );
  if (conflict) {
    throw new InstallError(
      `${wanted.name} already has a ${conflict.type} record (${conflict.content}), so the installer cannot add its ${wanted.type} record there.`,
      `Remove or rename that record in the Cloudflare dashboard (DNS > Records), then run \`pnpm swarm\` again.`,
    );
  }
  const sameType = existing.filter((r) => r.type === wanted.type);
  const tag = (value: string) => unquote(value).split(/[;\s]/)[0]?.toLowerCase() ?? '';
  const match =
    wanted.type === 'TXT'
      ? sameType.find((r) => tag(r.content) === tag(content))
      : wanted.type === 'MX'
        ? (sameType.find((r) => r.content === content) ?? sameType[0])
        : sameType[0];
  const body = {
    type: wanted.type,
    name: wanted.name,
    content,
    ttl: 1,
    ...(wanted.proxied !== undefined ? { proxied: wanted.proxied } : {}),
    ...(wanted.priority !== undefined ? { priority: wanted.priority } : {}),
    comment: 'Added by the Swarm installer',
  };
  if (!match) {
    await cf.post(`/zones/${zoneId}/dns_records`, body);
    return 'created';
  }
  const same =
    unquote(match.content) === unquote(content) &&
    (wanted.proxied === undefined || !!match.proxied === wanted.proxied) &&
    (wanted.priority === undefined || match.priority === wanted.priority);
  if (same) return 'unchanged';
  await cf.patch(`/zones/${zoneId}/dns_records/${match.id}`, body);
  return 'updated';
}
