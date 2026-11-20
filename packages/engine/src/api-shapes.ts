/**
 * Row → API shape mappers shared by the API worker and Event Webhooks (Phase 7): a webhook's
 * `data` is the resource exactly as the API returns it, so both use these.
 */
import { toIso } from '@swarm/db';
import {
  FLOW_TRIGGER_TYPES,
  type Broadcast,
  type DispatchSummary,
  type FlowRun,
  type FlowRunContext,
  type FlowRunHold,
  type FlowRunStart,
  type FlowTriggerType,
  type Member,
} from '@swarm/domain';
import { bestTimeReport } from './best-time';
import type { FlowRunRow } from './flows';
import type { BroadcastRow } from './pipeline';
import type { DispatchRow } from './start';

const iso = (ms: number | null) => (ms === null ? null : toIso(ms));

export interface MemberRow {
  id: string;
  channel_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: Member['status'];
  digest: Member['digest'];
  /** JSON array of tag names, from MEMBER_COLUMNS. */
  tags_json: string | null;
  created_at: number;
  confirmed_at: number | null;
  paused_until: number | null;
  unsubscribed_at: number | null;
  emails_off_at: number | null;
}

/** Selects a MemberRow from `members m`. */
export const MEMBER_COLUMNS = `m.id, m.channel_id, m.email, m.first_name, m.last_name, m.status, m.digest,
  (SELECT json_group_array(t.name) FROM member_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.member_id = m.id) AS tags_json,
  m.created_at, m.confirmed_at, m.paused_until, m.unsubscribed_at, m.emails_off_at`;

export const toMember = (row: MemberRow): Member => ({
  id: row.id,
  channelId: row.channel_id,
  email: row.email,
  firstName: row.first_name,
  lastName: row.last_name,
  status: row.status,
  digest: row.digest,
  tags: row.tags_json ? (JSON.parse(row.tags_json) as string[]).sort() : [],
  createdAt: toIso(row.created_at),
  confirmedAt: iso(row.confirmed_at),
  pausedUntil: iso(row.paused_until),
  unsubscribedAt: iso(row.unsubscribed_at),
  emailsOffAt: iso(row.emails_off_at ?? null),
});

export const toDispatchSummary = (
  row: DispatchRow & { latest_broadcast_id?: string | null },
): DispatchSummary => ({
  id: row.id,
  channelId: row.channel_id,
  subject: row.subject,
  preheader: row.preheader,
  status: row.status,
  senderIdentityId: row.sender_identity_id,
  publishAt: iso(row.publish_at),
  sentAt: iso(row.sent_at),
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
  latestBroadcastId: row.latest_broadcast_id ?? null,
  webVisibility: row.web_visibility,
  webPublishedAt: iso(row.web_published_at),
  kind: row.kind ?? 'broadcast',
  flowId: row.flow_id ?? null,
  createdVia: row.from_feed ? 'feed' : (row.created_via ?? null),
  archivedAt: iso(row.archived_at ?? null),
  plannedDate: row.planned_date ?? null,
  importedAt: iso(row.imported_at ?? null),
  bestTime: row.best_time === 1,
});

export const toBroadcast = (row: BroadcastRow): Broadcast => ({
  id: row.id,
  dispatchId: row.dispatch_id,
  channelId: row.channel_id,
  status: row.status,
  subject: row.subject,
  from: { name: row.from_name, address: row.from_address },
  recipientCount: row.recipient_count,
  sentCount: row.sent_count,
  failedCount: row.failed_count,
  failureReason: row.failure_reason,
  createdAt: toIso(row.created_at),
  completedAt: iso(row.completed_at),
  canceledAt: iso(row.canceled_at),
  bestTime: bestTimeReport(row),
});

/** A flow_holds row as the API returns it. */
export interface FlowHoldRow {
  node_id: string;
  reason: FlowRunHold['reason'];
  until: number;
  zone: string;
  held_at: number;
  released_at: number | null;
  outcome: FlowRunHold['outcome'];
}

export const toFlowRunHold = (row: FlowHoldRow): FlowRunHold => ({
  nodeId: row.node_id,
  reason: row.reason,
  until: toIso(row.until),
  zone: row.zone,
  heldAt: toIso(row.held_at),
  releasedAt: iso(row.released_at),
  outcome: row.outcome,
});

/** Selects an open run's current hold as JSON (hold_json), for rows from `flow_runs r`. */
export const FLOW_RUN_HOLD_COLUMN = `(SELECT json_object('node_id', h.node_id, 'reason', h.reason, 'until', h.until,
    'zone', h.zone, 'held_at', h.held_at, 'released_at', h.released_at, 'outcome', h.outcome)
    FROM flow_holds h WHERE h.run_id = r.id AND h.node_id = r.current_node_id AND h.released_at IS NULL
      AND r.status IN ('running', 'waiting', 'paused') LIMIT 1) AS hold_json`;

/** What a trigger can select on. A payload's other values never leave the run's context. */
const RUN_START_DETAILS = [
  'formId',
  'circleId',
  'tagId',
  'fieldId',
  'levelId',
  'askId',
  'optionId',
  'days',
  'dispatchId',
  'name',
  'rosterId',
  'milestoneId',
] as const;

/** Which start event started a run, from its context_json; null when none did. */
export function toFlowRunStart(contextJson: string): FlowRunStart | null {
  let context: FlowRunContext;
  try {
    context = JSON.parse(contextJson) as FlowRunContext;
  } catch {
    return null;
  }
  const trigger = context.trigger;
  if (!trigger || !(FLOW_TRIGGER_TYPES as readonly string[]).includes(trigger.type)) return null;
  const payload = (trigger.payload ?? {}) as Record<string, unknown>;
  const details: FlowRunStart['details'] = {};
  for (const key of RUN_START_DETAILS) {
    const value = payload[key];
    if (typeof value === 'string' || typeof value === 'number') details[key] = value;
  }
  return { index: trigger.index ?? 0, event: trigger.type as FlowTriggerType, details };
}

export const toFlowRun = (
  row: FlowRunRow & { member_email: string | null; hold_json?: string | null },
): FlowRun => ({
  id: row.id,
  flowId: row.flow_id,
  version: row.version,
  memberId: row.member_id,
  memberEmail: row.member_email,
  status: row.status,
  exitReason: row.exit_reason,
  currentNodeId: row.current_node_id,
  nextAt: iso(row.next_at),
  hold: row.hold_json ? toFlowRunHold(JSON.parse(row.hold_json) as FlowHoldRow) : null,
  test: row.test === 1,
  startedBy: toFlowRunStart(row.context_json),
  startedAt: toIso(row.started_at),
  updatedAt: toIso(row.updated_at),
  endedAt: iso(row.ended_at),
});
