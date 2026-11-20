/**
 * The one check for URLs the platform calls on someone else's behalf: Event Webhook endpoints,
 * Flow webhook_call steps, feed sources, export destinations, Shorthop, OAuth client metadata,
 * OIDC and SSO issuers, and links a vendor hands back (DeBounce results). https only (plain http
 * is allowed in development, for local tunnels); no credentials in the URL; no IP literals (v4 in
 * any notation the URL parser accepts, or v6); no localhost, single-label, .local, .internal or
 * .home.arpa names; and none of the install's own hosts (setOutboundPlatformHosts), so a tenant
 * can't point Swarm's own egress at Swarm. Callers apply it again at every attempt and every
 * redirect hop.
 *
 * Workers cannot resolve DNS before a fetch, so a public name pointing at a private address is
 * not caught here; that rests on Cloudflare refusing fetches from Workers to private and loopback
 * addresses, which this repository can't show (security review GB4).
 */

import { takeUsage, usageOf } from './usage';

export interface OutboundUrlOptions {
  /** Allow http:// as well (development only). */
  allowHttp?: boolean;
  /** The install's own hosts; by default the ones set with setOutboundPlatformHosts. */
  platformHosts?: readonly string[];
}

/** The install's own hosts: each refused, and so is every name under it. */
let platformHosts: readonly string[] = [];

/** The env vars whose hosts are the install's own (origins, or bare domains). */
export const PLATFORM_HOST_VARS = [
  'APP_ORIGIN',
  'API_ORIGIN',
  'CAPTURE_ORIGIN',
  'MEDIA_ORIGIN',
  'TRACK_ORIGIN',
  'EVENTS_ORIGIN',
  'SITE_FALLBACK_ORIGIN',
  'PLATFORM_SITE_DOMAIN',
  'PLATFORM_MAIL_DOMAIN',
  'DMARC_MAIL_DOMAIN',
] as const;

const hostOf = (value: string): string | null => {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.replace(
      /\.$/,
      '',
    );
  } catch {
    return null;
  }
};

/**
 * The install's own hosts from a worker's env: the hosts of PLATFORM_HOST_VARS, plus any names
 * listed (comma-separated) in OUTBOUND_BLOCKED_HOSTS, for hosts the vars don't name.
 */
export function platformHostsFromEnv(env: unknown): string[] {
  const record = (env && typeof env === 'object' ? env : {}) as Record<string, unknown>;
  const values = PLATFORM_HOST_VARS.map((name) => record[name]).filter(
    (v): v is string => typeof v === 'string',
  );
  const extra =
    typeof record.OUTBOUND_BLOCKED_HOSTS === 'string'
      ? record.OUTBOUND_BLOCKED_HOSTS.split(',')
      : [];
  const hosts = [...values, ...extra]
    .map(hostOf)
    .filter((h): h is string => !!h && h.includes('.'));
  return [...new Set(hosts)];
}

/** Sets the hosts every outbound check refuses (each worker does at startup, from its env). */
export function setOutboundPlatformHosts(hosts: readonly string[]): void {
  platformHosts = [...new Set(hosts.map((h) => h.toLowerCase()))];
}

/** Why a URL may not be called, or null when it may. */
export function outboundUrlProblem(raw: string, options: OutboundUrlOptions = {}): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) {
    return 'webhooks must use https';
  }
  if (url.username || url.password) return 'credentials in the URL are not allowed';
  const bare = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // Trailing dots go by a scan: /\.+$/ is quadratic on a long run of dots mid-host, and a
  // feed's redirect Location (a third party's) comes through here.
  let end = bare.length;
  while (end > 0 && bare.charCodeAt(end - 1) === 46) end--;
  const host = bare.slice(0, end);
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa') ||
    (!host.includes('.') && !host.includes(':'))
  ) {
    return 'private hosts are not allowed';
  }
  // The URL parser normalises 0x7f.1, 2130706433 and the like to dotted decimal.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    return 'IP addresses are not allowed; use a host name';
  }
  const own = options.platformHosts ?? platformHosts;
  if (own.some((h) => host === h || host.endsWith(`.${h}`))) {
    return 'this server’s own addresses are not allowed';
  }
  return null;
}

// ---- Time spent waiting on tenant-chosen addresses ------------------------------------------

/**
 * Milliseconds of waiting on its own endpoints (Event Webhooks, Flow webhook steps, test sends
 * and redrives alike) one workspace may cost the shared consumers per minute: about two calls
 * at a time that use the whole 10-second timeout, or a thousand fast ones. Past it, the
 * workspace's next calls wait for the next minute instead of holding a consumer other tenants
 * need, so an endpoint that answers successfully but slowly is slowed down too (security review
 * S02-P3-T-webhook-delivery-share, S02-P3-T-flow-webhook-jobs-queue). Owner decision: the
 * delay budget for hosted installs.
 */
export const OUTBOUND_WAIT_MS_PER_MINUTE = 120_000;
const WAIT_WINDOW_MS = 60_000;
const waitScope = (workspaceId: string) => `outbound_wait:${workspaceId}`;

/** When a workspace over its waiting budget may call out again, or null when it may now. */
export async function outboundWaitDeferral(
  db: D1Database,
  workspaceId: string,
  now: number,
): Promise<number | null> {
  const spent = await usageOf(db, { scope: waitScope(workspaceId), windowMs: WAIT_WINDOW_MS, now });
  if (spent < OUTBOUND_WAIT_MS_PER_MINUTE) return null;
  return now - (now % WAIT_WINDOW_MS) + WAIT_WINDOW_MS;
}

/** Charges a call's waiting time to its workspace. */
export async function chargeOutboundWait(
  db: D1Database,
  workspaceId: string,
  waitedMs: number,
  now: number,
): Promise<void> {
  await takeUsage(db, {
    scope: waitScope(workspaceId),
    windowMs: WAIT_WINDOW_MS,
    limit: OUTBOUND_WAIT_MS_PER_MINUTE,
    now,
    amount: Math.max(1, Math.round(waitedMs)),
  }).catch(() => undefined);
}
