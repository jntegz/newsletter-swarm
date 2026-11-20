/**
 * Who is asking, worked out by the vault itself. A credential the api passes through is resolved
 * against D1 with the same lookups the api uses (@swarm/db credentials.ts); a member link with the
 * vault's own verify key; a stored principal by reading its row. Nothing a caller says about who
 * it serves is taken on trust. The checks are coarse on purpose ("live, reaches this Channel with
 * this role or scope"): route policy (holds, approvals, step-up) stays in the api.
 */
import {
  apiKeyLive,
  apiKeyRow,
  channelAccess,
  first,
  oauthAccessRow,
  oauthAccessScopes,
  roleAtLeast,
  sha256Hex,
} from '@swarm/db';
import {
  API_KEY_PATTERN,
  OAUTH_ACCESS_PREFIX,
  SSO_SESSION_MAX_HOURS,
  ipInCidr,
  scopeAllows,
  type ApiScope,
  type SeatRole,
} from '@swarm/domain';
import { FEED_AUTHORITY_SQL } from '@swarm/engine';
import { verifyLink } from '@swarm/tokens';
import type { CredentialPrincipal, StoredPrincipal } from '../api';
import { invalid, notFound, refuse, type VaultContext } from './context';

// ---- Credentials -------------------------------------------------------------------------------

type Resolved =
  | { kind: 'operator'; operatorId: string; sessionId: string }
  | {
      kind: 'grant';
      via: 'api-key' | 'oauth';
      id: string;
      workspaceId: string;
      channelIds: string[] | null;
      scopes: ApiScope[];
    };

const MAX_CREDENTIAL = 200;

interface SessionRow {
  id: string;
  operator_id: string;
  expires_at: number;
  mfa_pending: number;
  auth_method: string | null;
  created_at: number;
  sso_status: string | null;
}

/**
 * The operator or grant behind a credential, or a refusal. A session still waiting for its second
 * factor is refused unless `allowPendingSecondFactor` (TOTP verification itself). A session that
 * came through SSO lasts only while its connection is active, and SSO_SESSION_MAX_HOURS at most.
 */
export async function resolveCredential(
  ctx: VaultContext,
  credential: CredentialPrincipal,
  options: { allowPendingSecondFactor?: boolean } = {},
): Promise<Resolved> {
  const now = ctx.now();
  switch (credential.kind) {
    case 'operator-session': {
      const token = credential.sessionToken;
      if (typeof token !== 'string' || !token || token.length > MAX_CREDENTIAL) refuse('session');
      const row = await first<SessionRow>(
        ctx.db,
        `SELECT s.id, s.operator_id, s.expires_at, s.mfa_pending, s.auth_method, s.created_at,
                (SELECT c.status FROM sso_connections c WHERE c.id = s.sso_connection_id) AS sso_status
           FROM sessions s WHERE s.token_hash = ?1 AND s.revoked_at IS NULL`,
        await sha256Hex(token),
      );
      if (!row || row.expires_at <= now) return refuse('session');
      if (row.mfa_pending && !options.allowPendingSecondFactor) refuse('second factor pending');
      if (row.auth_method === 'sso') {
        const ended = row.created_at + SSO_SESSION_MAX_HOURS * 3_600_000 <= now;
        if (row.sso_status !== 'active' || ended) refuse('sso session');
      }
      return { kind: 'operator', operatorId: row.operator_id, sessionId: row.id };
    }
    case 'api-key': {
      const secret = credential.secret;
      if (typeof secret !== 'string' || !API_KEY_PATTERN.test(secret)) return refuse('key');
      const row = await apiKeyRow(ctx.db, await sha256Hex(secret));
      if (!row || !apiKeyLive(row, now)) return refuse('key');
      if (row.surface === 'mcp' && (credential.resource ?? 'v2') !== 'mcp') refuse('key surface');
      if (row.ip_allowlist_json) {
        const ranges = JSON.parse(row.ip_allowlist_json) as string[];
        const ip = credential.ip;
        if (!ip || !ranges.some((range) => ipInCidr(ip, range))) refuse('key ip');
      }
      return {
        kind: 'grant',
        via: 'api-key',
        id: row.id,
        workspaceId: row.workspace_id,
        channelIds: row.channel_ids_json ? (JSON.parse(row.channel_ids_json) as string[]) : null,
        scopes: JSON.parse(row.scopes_json) as ApiScope[],
      };
    }
    case 'oauth': {
      const token = credential.accessToken;
      if (
        typeof token !== 'string' ||
        !token.startsWith(OAUTH_ACCESS_PREFIX) ||
        token.length > MAX_CREDENTIAL ||
        (credential.resource !== 'v2' && credential.resource !== 'mcp')
      ) {
        return refuse('oauth');
      }
      const row = await oauthAccessRow(ctx.db, await sha256Hex(token), credential.resource, now);
      if (!row) return refuse('oauth');
      return {
        kind: 'grant',
        via: 'oauth',
        id: row.grant_id,
        workspaceId: row.workspace_id,
        channelIds: row.channel_ids_json ? (JSON.parse(row.channel_ids_json) as string[]) : null,
        scopes: oauthAccessScopes(row),
      };
    }
    default:
      return invalid('not a credential');
  }
}

/** The id to record for a resolved principal (never the credential itself). */
export const resolvedId = (resolved: Resolved) =>
  resolved.kind === 'operator' ? resolved.operatorId : `${resolved.via}:${resolved.id}`;

interface Reach {
  workspaceId: string;
  channelId: string;
}

/**
 * The Channel, when the principal reaches it with at least `role` (an operator; the per-Channel
 * role lowers the seat's) or `scope` (a key or token: its workspace, its Channel list, its
 * scopes). A deleted Channel is not reached. `scope: null` refuses keys and tokens.
 */
export async function reachChannel(
  ctx: VaultContext,
  resolved: Resolved,
  channelId: string,
  need: { role: SeatRole; scope: ApiScope | null },
): Promise<Reach> {
  if (typeof channelId !== 'string' || !channelId) invalid('channel');
  if (resolved.kind === 'operator') {
    const access = await channelAccess(ctx.db, resolved.operatorId, channelId);
    if (!access || access.deleted) return notFound('channel');
    if (!roleAtLeast(access.role, need.role)) refuse('role');
    return { workspaceId: access.workspaceId, channelId };
  }
  const channel = await first<{ workspace_id: string; deleted_at: number | null }>(
    ctx.db,
    'SELECT workspace_id, deleted_at FROM channels WHERE id = ?1',
    channelId,
  );
  if (!channel || channel.deleted_at !== null || channel.workspace_id !== resolved.workspaceId) {
    return notFound('channel');
  }
  if (resolved.channelIds && !resolved.channelIds.includes(channelId)) notFound('channel');
  if (!need.scope || !scopeAllows(resolved.scopes, need.scope)) refuse('scope');
  return { workspaceId: channel.workspace_id, channelId };
}

/** The workspace, when the principal has at least `role` in it, or `scope` for a key or token. */
export async function reachWorkspace(
  ctx: VaultContext,
  resolved: Resolved,
  workspaceId: string,
  need: { role: SeatRole; scope: ApiScope | null },
): Promise<void> {
  if (typeof workspaceId !== 'string' || !workspaceId) invalid('workspace');
  if (resolved.kind === 'operator') {
    const seat = await first<{ role: SeatRole }>(
      ctx.db,
      'SELECT role FROM seats WHERE workspace_id = ?1 AND operator_id = ?2',
      workspaceId,
      resolved.operatorId,
    );
    if (!seat) notFound('workspace');
    if (!roleAtLeast((seat as { role: SeatRole }).role, need.role)) refuse('role');
    return;
  }
  if (resolved.workspaceId !== workspaceId) notFound('workspace');
  if (!need.scope || !scopeAllows(resolved.scopes, need.scope)) refuse('scope');
}

// ---- Member links ------------------------------------------------------------------------------

interface MemberLink {
  memberId: string;
  channelId: string;
  workspaceId: string;
  email: string;
  status: string;
  emailed: boolean;
  /** When the link was issued (ms). */
  issuedAt: number;
}

const MEMBER_ID = /^mb_[0-9a-f]{32}$/;

/**
 * A Member Center link checked with the vault's own key: a v2 link under MEMBER_SIGNING_KEYS (its
 * `c` must be the Member's Channel), or a v1 link under MEMBER_KEYS within the legacy rule. The
 * Member must exist in a live Channel, and the link must be newer than member_links_after.
 */
export async function verifyMemberLink(ctx: VaultContext, token: string): Promise<MemberLink> {
  if (typeof token !== 'string' || !token || token.length > 512) return refuse('member link');
  const legacy = ctx.keys.memberLegacy
    ? { keyring: ctx.keys.memberLegacy, cutoffMs: ctx.config.links.legacyCutoffMs }
    : undefined;
  const read = await verifyLink<{ m?: unknown; c?: unknown; e?: unknown }>(
    'member',
    ctx.keys.memberVerify,
    token,
    { now: ctx.now(), ...(legacy ? { legacy } : {}) },
  );
  if (!read.ok) return refuse('member link');
  const { m, c, e, iat } = read.payload;
  if (typeof m !== 'string' || !MEMBER_ID.test(m)) return refuse('member link');
  const member = await first<{
    channel_id: string;
    workspace_id: string;
    email: string;
    status: string;
    member_links_after: number | null;
  }>(
    ctx.db,
    `SELECT m.channel_id, c.workspace_id, m.email, m.status, m.member_links_after
       FROM members m JOIN channels c ON c.id = m.channel_id
      WHERE m.id = ?1 AND c.deleted_at IS NULL`,
    m,
  );
  if (!member) return refuse('member link');
  if (!read.legacy && c !== member.channel_id) refuse('member link tenant');
  const issuedAt = iat * 1000;
  if (member.member_links_after !== null && issuedAt < member.member_links_after) {
    refuse('member link ended');
  }
  return {
    memberId: m,
    channelId: member.channel_id,
    workspaceId: member.workspace_id,
    email: member.email,
    status: member.status,
    emailed: e === 1,
    issuedAt,
  };
}

/** A reader session cookie of a Channel: the Member it signs in, while the row is live. */
export async function verifyReaderSession(
  ctx: VaultContext,
  token: string,
  channelId: string,
): Promise<{ memberId: string; channelId: string }> {
  if (typeof token !== 'string' || !token || token.length > 512) return refuse('reader session');
  const row = await first<{ member_id: string; expires_at: number }>(
    ctx.db,
    `SELECT r.member_id, r.expires_at FROM reader_sessions r JOIN members m ON m.id = r.member_id
      WHERE r.id_hash = ?1 AND r.channel_id = ?2 AND m.channel_id = ?2
        AND m.status IN ('active', 'paused')`,
    await sha256Hex(token),
    channelId,
  );
  if (!row || row.expires_at <= ctx.now()) return refuse('reader session');
  return { memberId: row.member_id, channelId };
}

// ---- Stored principals -------------------------------------------------------------------------

interface StoredReach {
  workspaceId: string;
  channelId: string | null;
  /** The job's id, for records. */
  id: string;
}

const HOUR = 3_600_000;

/**
 * The tenant a stored principal acts in, when its row says it may act now. Each kind reads only
 * its own row: an export job that is running and whose creator is still an admin of its
 * Channel, an import that is analyzing or importing, and so on (api.ts StoredPrincipal).
 */
export async function resolveStored(
  ctx: VaultContext,
  principal: StoredPrincipal,
): Promise<StoredReach> {
  const id = (value: unknown) => {
    if (typeof value !== 'string' || !value || value.length > 120) invalid('principal id');
    return value as string;
  };
  switch (principal.kind) {
    case 'export-job': {
      const row = await first<{
        workspace_id: string;
        channel_id: string;
        created_by: string | null;
      }>(
        ctx.db,
        `SELECT workspace_id, channel_id, created_by FROM export_jobs
          WHERE id = ?1 AND status IN ('queued', 'running')`,
        id(principal.jobId),
      );
      if (!row) return refuse('export job');
      // The export stops being an authority once its creator is no longer an admin there.
      const access = row.created_by
        ? await channelAccess(ctx.db, row.created_by, row.channel_id)
        : null;
      if (!access || access.deleted || !roleAtLeast(access.role, 'admin')) refuse('export creator');
      return { workspaceId: row.workspace_id, channelId: row.channel_id, id: principal.jobId };
    }
    case 'import-job':
      return jobRow(ctx, 'import_jobs', id(principal.jobId), ['analyzing', 'importing']);
    case 'bulk-job':
      return jobRow(ctx, 'bulk_jobs', id(principal.jobId), ['queued', 'running']);
    case 'flow-run': {
      const row = await first<{ workspace_id: string; channel_id: string }>(
        ctx.db,
        `SELECT f.workspace_id, r.channel_id FROM flow_runs r JOIN flows f ON f.id = r.flow_id
          WHERE r.id = ?1 AND r.status IN ('running', 'waiting') AND r.current_node_id = ?2
            AND f.deleted_at IS NULL`,
        id(principal.runId),
        id(principal.nodeId),
      );
      if (!row) return refuse('flow run');
      return { workspaceId: row.workspace_id, channelId: row.channel_id, id: principal.runId };
    }
    case 'dsr-request': {
      const row = await first<{ workspace_id: string; channel_id: string | null }>(
        ctx.db,
        `SELECT workspace_id, channel_id FROM dsr_requests
          WHERE id = ?1 AND (status = 'processing' OR (status IN ('completed', 'rejected', 'failed')
                AND outcome_noticed_at IS NULL))`,
        id(principal.requestId),
      );
      if (!row) return refuse('data request');
      return { workspaceId: row.workspace_id, channelId: row.channel_id, id: principal.requestId };
    }
    case 'export-destination': {
      // A failing destination keeps retrying on its schedule, while its authority stands.
      const row = await first<{ workspace_id: string; channel_id: string }>(
        ctx.db,
        `SELECT f.workspace_id, f.channel_id FROM export_destinations f
          WHERE f.id = ?1 AND f.status IN ('active', 'failing') AND f.confirmed_at IS NOT NULL
            AND ${FEED_AUTHORITY_SQL('export_destination')}`,
        id(principal.destinationId),
      );
      if (!row) return refuse('export destination');
      return {
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        id: principal.destinationId,
      };
    }
    case 'webhook-delivery': {
      const row = await first<{ workspace_id: string; channel_id: string | null }>(
        ctx.db,
        `SELECT d.workspace_id, e.channel_id FROM webhook_deliveries d
           JOIN webhook_endpoints e ON e.id = d.endpoint_id
          WHERE d.id = ?1 AND d.status IN ('pending', 'retrying')
            AND (e.status = 'active' OR d.test = 1) AND e.workspace_id = d.workspace_id`,
        id(principal.deliveryId),
      );
      if (!row) return refuse('webhook delivery');
      return { workspaceId: row.workspace_id, channelId: row.channel_id, id: principal.deliveryId };
    }
    case 'payment-event': {
      const table = principal.provider === 'stripe' ? 'stripe_events' : 'paypal_events';
      if (principal.provider !== 'stripe' && principal.provider !== 'paypal') invalid('provider');
      const row = await first<{ workspace_id: string }>(
        ctx.db,
        `SELECT c.workspace_id FROM ${table} ev JOIN channels c ON c.id = ev.channel_id
          WHERE ev.event_id = ?1 AND ev.channel_id = ?2 AND ev.received_at > ?3
            AND c.deleted_at IS NULL`,
        id(principal.eventId),
        id(principal.channelId),
        ctx.now() - HOUR,
      );
      if (!row) return refuse('payment event');
      return {
        workspaceId: row.workspace_id,
        channelId: principal.channelId,
        id: principal.eventId,
      };
    }
    default:
      return invalid('not a stored principal');
  }
}

async function jobRow(
  ctx: VaultContext,
  table: 'import_jobs' | 'bulk_jobs',
  jobId: string,
  statuses: string[],
): Promise<StoredReach> {
  const row = await first<{ workspace_id: string; channel_id: string }>(
    ctx.db,
    `SELECT workspace_id, channel_id FROM ${table}
      WHERE id = ?1 AND status IN (${statuses.map((s) => `'${s}'`).join(', ')})`,
    jobId,
  );
  if (!row) return refuse(table);
  return { workspaceId: row.workspace_id, channelId: row.channel_id, id: jobId };
}
