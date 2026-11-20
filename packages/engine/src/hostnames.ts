/**
 * Web hostnames for Channel websites (Cloudflare for SaaS custom hostnames with HTTP DCV).
 *
 * The operator points a CNAME at SITE_FALLBACK_ORIGIN; Cloudflare validates the certificate over
 * HTTP once the record is live. Only hostnames the provider reports active are served by the site
 * worker. Adapters:
 * - CloudflareWebHostnames: the Cloudflare API, zone CF_ZONE_ID (the SaaS zone);
 * - DevWebHostnames: development and tests; pending when added, active on the first refresh.
 */
import { z } from 'zod';
import { all, first, run } from './db';

export type WebHostnameStatus = 'pending' | 'active' | 'failed';

export interface WebHostnameState {
  status: WebHostnameStatus;
  /** The provider's latest verification or certificate message, if any. */
  detail: string | null;
}

export interface WebHostnames {
  create(hostname: string): Promise<{ id: string } & WebHostnameState>;
  status(id: string): Promise<WebHostnameState>;
  /** Removing a hostname the provider no longer knows is not an error. */
  remove(id: string): Promise<void>;
}

export const WebHostingEnvFields = {
  /** Who issues web hostnames: Cloudflare for SaaS, the dev fake, or nobody (custom domains off). */
  WEB_HOSTNAMES: z.enum(['cloudflare', 'dev', 'off']),
  /** The hostname operators point their CNAME at (the SaaS zone's fallback origin). */
  SITE_FALLBACK_ORIGIN: z
    .string()
    .regex(/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/, 'a hostname such as sites.swarm.page'),
  CF_ZONE_ID: z.string().min(1).optional(),
  CF_API_TOKEN: z.string().min(1).optional(),
};

export interface WebHostingEnv {
  ENVIRONMENT: string;
  WEB_HOSTNAMES: 'cloudflare' | 'dev' | 'off';
  SITE_FALLBACK_ORIGIN: string;
  CF_ZONE_ID?: string | undefined;
  CF_API_TOKEN?: string | undefined;
}

/** Use inside a worker env schema's superRefine. */
export function checkWebHostingEnv(env: WebHostingEnv, ctx: z.RefinementCtx): void {
  const local = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
  if (env.WEB_HOSTNAMES === 'dev' && !local) {
    ctx.addIssue({
      code: 'custom',
      path: ['WEB_HOSTNAMES'],
      message: 'dev hostnames are only allowed in development and test',
    });
  }
  if (env.WEB_HOSTNAMES === 'cloudflare' && (!env.CF_ZONE_ID || !env.CF_API_TOKEN)) {
    ctx.addIssue({
      code: 'custom',
      path: ['CF_API_TOKEN'],
      message: 'CF_ZONE_ID and CF_API_TOKEN are required for Cloudflare hostnames',
    });
  }
}

/** Null when custom web domains are switched off for this deployment. */
export function webHostnames(env: WebHostingEnv): WebHostnames | null {
  if (env.WEB_HOSTNAMES === 'off') return null;
  if (env.WEB_HOSTNAMES === 'dev') return new DevWebHostnames();
  return new CloudflareWebHostnames(env.CF_ZONE_ID as string, env.CF_API_TOKEN as string);
}

interface CfHostname {
  id: string;
  status: string;
  ssl?: { status?: string; validation_errors?: { message?: string }[] };
  verification_errors?: string[];
}

class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CloudflareApiError';
  }
}

export class CloudflareWebHostnames implements WebHostnames {
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
    const json = (await res.json().catch(() => ({ success: false }))) as {
      success: boolean;
      result: T;
      errors?: { message: string }[];
    };
    if (!json.success) {
      throw new CloudflareApiError(
        res.status,
        json.errors?.[0]?.message ?? `Cloudflare API ${res.status}`,
      );
    }
    return json.result;
  }

  private state(result: CfHostname): WebHostnameState {
    const detail =
      result.verification_errors?.[0] ?? result.ssl?.validation_errors?.[0]?.message ?? null;
    if (result.status === 'active' && result.ssl?.status === 'active') {
      return { status: 'active', detail: null };
    }
    if (/blocked|moved|deleted/.test(result.status)) return { status: 'failed', detail };
    return { status: 'pending', detail };
  }

  async create(hostname: string) {
    const result = await this.call<CfHostname>('POST', '', {
      hostname,
      ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } },
    });
    return { id: result.id, ...this.state(result) };
  }

  async status(id: string) {
    return this.state(await this.call<CfHostname>('GET', `/${encodeURIComponent(id)}`));
  }

  async remove(id: string) {
    try {
      await this.call('DELETE', `/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return;
      throw error;
    }
  }
}

/**
 * Development and tests: a hostname is pending when added and active from the first status
 * check, so the pending → active path is exercised. Never selectable outside development and test.
 */
export class DevWebHostnames implements WebHostnames {
  async create(hostname: string) {
    return { id: `dev-${hostname}`, status: 'pending' as const, detail: null };
  }
  async status() {
    return { status: 'active' as const, detail: null };
  }
  async remove() {}
}

export interface CustomHostnameRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  hostname: string;
  role: 'web' | 'apex_redirect';
  status: 'pending' | 'active' | 'failed' | 'removed';
  provider_id: string | null;
  records_json: string;
  detail: string | null;
  is_primary: number;
  last_checked_at: number | null;
  /** First time it was active; never cleared, so a proven hostname stays its Channel's (0065). */
  proven_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Re-checks one hostname with the provider and stores the result. A change of status bumps the
 * Channel's site cache version, since canonical addresses may change with it.
 */
export async function refreshHostname(
  db: D1Database,
  provider: WebHostnames,
  id: string,
  now = Date.now(),
): Promise<CustomHostnameRow | null> {
  const row = await first<CustomHostnameRow>(
    db,
    'SELECT * FROM custom_hostnames WHERE id = ?1',
    id,
  );
  if (!row) return null;
  // The install's own address, the person's main domain, is served by a route and has no provider.
  if (!row.provider_id && row.status === 'active') return row;
  const state: WebHostnameState = row.provider_id
    ? await provider.status(row.provider_id)
    : { status: 'failed', detail: 'The hostname is not registered with the provider.' };
  await db.batch([
    db
      .prepare(
        `UPDATE custom_hostnames SET status = ?1, detail = ?2, last_checked_at = ?3, updated_at = ?3,
                proven_at = CASE WHEN ?1 = 'active' THEN coalesce(proven_at, ?3) ELSE proven_at END
          WHERE id = ?4`,
      )
      .bind(state.status, state.detail, now, id),
    ...(state.status !== row.status ? [bumpCacheStatement(db, row.channel_id, now)] : []),
  ]);
  return {
    ...row,
    status: state.status,
    detail: state.detail,
    last_checked_at: now,
    proven_at: row.proven_at ?? (state.status === 'active' ? now : null),
  };
}

/** How long after it was added a pending hostname is still polled. */
export const HOSTNAME_POLL_WINDOW_MS = 14 * 86_400_000;
/** Pending hostnames checked again no more often than this. */
export const HOSTNAME_POLL_INTERVAL_MS = 4 * 60_000;

/** Cron step: re-checks a bounded batch of pending hostnames, least recently checked first. */
export async function refreshPendingHostnames(
  db: D1Database,
  provider: WebHostnames,
  now = Date.now(),
  limit = 25,
): Promise<{ checked: number; activated: number }> {
  const rows = await all<{ id: string }>(
    db,
    `SELECT id FROM custom_hostnames
      WHERE status = 'pending' AND created_at > ?1 AND ifnull(last_checked_at, 0) < ?2
      ORDER BY ifnull(last_checked_at, 0), created_at LIMIT ?3`,
    now - HOSTNAME_POLL_WINDOW_MS,
    now - HOSTNAME_POLL_INTERVAL_MS,
    limit,
  );
  let activated = 0;
  for (const { id } of rows) {
    try {
      const row = await refreshHostname(db, provider, id, now);
      if (row?.status === 'active') activated += 1;
    } catch {
      // A provider error leaves the row pending; the next run tries again. Mark it checked so one
      // failing hostname can't starve the rest of the batch.
      await run(db, 'UPDATE custom_hostnames SET last_checked_at = ?1 WHERE id = ?2', now, id);
    }
  }
  return { checked: rows.length, activated };
}

/**
 * Bumps a Channel's site cache version (part of the edge cache key), creating the settings row
 * if it doesn't exist yet. An absent row reads as version 1, so a new row starts at 2.
 */
export function bumpCacheStatement(db: D1Database, channelId: string, now: number) {
  return db
    .prepare(
      `INSERT INTO site_settings (channel_id, cache_version, updated_at) VALUES (?1, 2, ?2)
       ON CONFLICT (channel_id) DO UPDATE SET cache_version = cache_version + 1`,
    )
    .bind(channelId, now);
}

export async function bumpCacheVersion(db: D1Database, channelId: string, now = Date.now()) {
  await bumpCacheStatement(db, channelId, now).run();
}
