import { all, toIso } from '@swarm/db';
import type { AuditEvent } from '@swarm/domain';
import { teammateEmailSql } from '@swarm/engine';

export { appendAudit, type AuditInput } from '@swarm/db';

interface AuditRow {
  id: string;
  seq: number;
  action: string;
  actor_id: string | null;
  actor_email: string | null;
  target_type: string | null;
  target_id: string | null;
  metadata_json: string;
  ip_prefix: string | null;
  created_at: number;
  prev_hash: string;
  hash: string;
}

type AuditEventWithChain = AuditEvent & {
  ipPrefix: string | null;
  prevHash: string;
  hash: string;
};

/**
 * Audit event target types that name a row of a Channel-owned table (the row's `channel_id` says
 * which Channel). Events about other targets, or about a row since deleted, are workspace-level.
 */
const CHANNEL_TARGETS: Record<string, string> = {
  member: 'members',
  dispatch: 'dispatches',
  broadcast: 'broadcasts',
  flow: 'flows',
  tag: 'tags',
  circle: 'circles',
  member_field: 'member_fields',
  member_subscription: 'member_subscriptions',
  import_job: 'import_jobs',
  export_job: 'export_jobs',
  bulk_job: 'bulk_jobs',
  export_destination: 'export_destinations',
  feed_source: 'feed_sources',
  roster: 'rosters',
  webhook_endpoint: 'webhook_endpoints',
  media: 'media',
  ask: 'asks',
  template: 'templates',
  series: 'series',
  signup_journey: 'signup_journeys',
  membership_level: 'membership_levels',
  coupon: 'coupons',
  good: 'goods',
  good_order: 'good_orders',
  sending_domain: 'sending_domains',
  sender_identity: 'sender_identities',
  reputation_ramp: 'reputation_ramps',
  custom_hostname: 'custom_hostnames',
  site_section: 'site_sections',
  site_page: 'site_pages',
  site_redirect: 'site_redirects',
  hub_link: 'hub_links',
  champion_reward: 'champion_rewards',
  champion_milestone: 'champion_milestones',
  champion_award: 'champion_awards',
  partner_pick: 'partner_picks',
  sponsor_booking: 'sponsor_bookings',
  recipe_submission: 'recipe_submissions',
  dsr_request: 'dsr_requests',
  agent_approval: 'agent_approvals',
};

/** ?6 is a JSON array of Channel ids, ?7 the principal's id. */
const VISIBLE_TO_LIMITED = `(
  (a.target_type = 'channel' AND a.target_id IN (SELECT value FROM json_each(?6)))
  OR json_extract(a.metadata_json, '$.channelId') IN (SELECT value FROM json_each(?6))
  OR json_extract(a.metadata_json, '$.via.id') = ?7
  OR json_extract(a.metadata_json, '$.via') = ?7
  ${Object.entries(CHANNEL_TARGETS)
    .map(
      ([type, table]) =>
        `OR (a.target_type = '${type}' AND EXISTS (SELECT 1 FROM ${table} t WHERE t.id = a.target_id
              AND t.channel_id IN (SELECT value FROM json_each(?6))))`,
    )
    .join('\n  ')}
)`;

/**
 * Audit events of a workspace, newest first: before `beforeSeq`, optionally inside a time range.
 * Shared by the dashboard log, its export and /v2/audit-events. With `limitedTo` (a /v2 principal
 * limited to some Channels), only events about those Channels or their rows, and the principal's
 * own changes: other Channels' events and workspace-level ones (invites, seats, keys) stay hidden.
 */
export async function readAuditEvents(
  db: D1Database,
  workspaceId: string,
  options: {
    beforeSeq?: number;
    limit: number;
    from?: number;
    to?: number;
    limitedTo?: { channelIds: string[]; principalId: string };
  },
): Promise<AuditEventWithChain[]> {
  const limited = options.limitedTo;
  const rows = await all<AuditRow>(
    db,
    `SELECT a.id, a.seq, a.action, a.actor_operator_id AS actor_id,
            ${teammateEmailSql('o', 'a.workspace_id')} AS actor_email,
            a.target_type, a.target_id, a.metadata_json, a.ip_prefix, a.created_at, a.prev_hash, a.hash
       FROM audit_events a LEFT JOIN operators o ON o.id = a.actor_operator_id
      WHERE a.workspace_id = ?1 AND a.seq < ?2 AND (?3 IS NULL OR a.created_at >= ?3)
        AND (?4 IS NULL OR a.created_at < ?4)${limited ? `\n        AND ${VISIBLE_TO_LIMITED}` : ''}
      ORDER BY a.seq DESC LIMIT ?5`,
    workspaceId,
    options.beforeSeq ?? Number.MAX_SAFE_INTEGER,
    options.from ?? null,
    options.to ?? null,
    options.limit,
    ...(limited ? [JSON.stringify(limited.channelIds), limited.principalId] : []),
  );
  const redacted = await redactions(db, workspaceId);
  return rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    action: row.action,
    actor: row.actor_id && row.actor_email ? { id: row.actor_id, email: row.actor_email } : null,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: redact(JSON.parse(row.metadata_json), redacted) as Record<string, unknown>,
    createdAt: toIso(row.created_at),
    ipPrefix: row.ip_prefix,
    prevHash: row.prev_hash,
    hash: row.hash,
  }));
}

/** Redacted former teammates of the workspace: their address (lowercased) → placeholder. */
async function redactions(db: D1Database, workspaceId: string): Promise<Map<string, string>> {
  const rows = await all<{ email: string; placeholder: string }>(
    db,
    `SELECT lower(o.email) AS email, x.placeholder FROM teammate_redactions x
       JOIN operators o ON o.id = x.operator_id WHERE x.workspace_id = ?1`,
    workspaceId,
  );
  return new Map(rows.map((row) => [row.email, row.placeholder]));
}

/**
 * Entries are hash-chained and stay as written; what the log shows replaces a redacted
 * teammate's address (and a domain-only or name value is left as is) with their placeholder.
 * Such an entry no longer matches its hash outside Swarm: the in-product check reads the stored
 * rows, and the teammate.redacted entry says when the redaction was made.
 */
function redact(value: unknown, redacted: Map<string, string>): unknown {
  if (!redacted.size) return value;
  if (typeof value === 'string') return redacted.get(value.toLowerCase()) ?? value;
  if (Array.isArray(value)) return value.map((item) => redact(item, redacted));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item, redacted)]),
    );
  }
  return value;
}

/** The API shape: the chain fields stay in exports. */
export const publicAuditEvent = ({
  ipPrefix: _ip,
  prevHash: _prev,
  hash: _hash,
  ...event
}: AuditEventWithChain): AuditEvent => event;
