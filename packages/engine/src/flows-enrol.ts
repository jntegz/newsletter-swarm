/**
 * Enrolment from the member event bus, wait wake-ups, and the daily unengaged check.
 */
import {
  FLOW_SAME_MOMENT_MS,
  FLOW_TRIGGER_TYPES,
  triggersOf,
  type CircleRule,
  type FlowEnrolDecision,
  type FlowReentry,
  type FlowRunWait,
  type FlowTriggerConfig,
  type FlowTriggerType,
  type MemberEventPayloads,
} from '@swarm/domain';
import { all, first, run as exec } from './db';
import {
  markMemberEventsProcessed,
  pendingMemberEvents,
  pruneMemberEvents,
  type MemberEventRow,
} from './events';
import type { FlowRunRow, FlowsEnv } from './flows';
import { linkAddresses } from './flows-decide';
import { loadVersionGraph, memberMatchesRule, resolveWait, startFlowRun } from './flows-engine';
import { pruneFlowEmailLedger } from './flows-holds';
import { parseJson } from './flows-util';

/** Events drained per 'flow_events' message; a full batch queues the next one. */
export const FLOW_EVENTS_BATCH = 200;
/** Members marked unengaged per (Channel, days) per daily run; the rest follow the next day. */
export const UNENGAGED_BATCH = 1000;

const TRIGGER_TYPES = new Set<string>(FLOW_TRIGGER_TYPES);

/**
 * A payload that matchesTrigger accepts for this start event, for imagining the event in a rehearsal.
 * What the event was "about" is only what the start event asks for.
 */
export function payloadFor(config: FlowTriggerConfig): Record<string, unknown> {
  switch (config.event) {
    case 'member_joined':
      return { source: 'form', ...(config.formId ? { formId: config.formId } : {}) };
    case 'form_submitted':
    case 'confirmed':
      return config.formId ? { formId: config.formId } : {};
    case 'circle_entered':
    case 'circle_exited':
      return { circleId: config.circleId };
    case 'tag_added':
    case 'tag_removed':
      return { tagId: config.tagId };
    case 'field_changed':
      return { fieldId: config.fieldId };
    case 'level_purchased':
    case 'level_canceled':
      return config.levelId ? { levelId: config.levelId } : {};
    case 'ask_answered':
      return { askId: config.askId, ...(config.optionId ? { optionId: config.optionId } : {}) };
    case 'unengaged':
      return { days: config.days };
    case 'link_clicked':
      return {
        ...(config.dispatchId ? { dispatchId: config.dispatchId } : {}),
        ...(config.url ? { url: config.url } : {}),
      };
    case 'gate_hit':
      return config.dispatchId ? { dispatchId: config.dispatchId } : {};
    case 'api_event':
      return { name: config.name };
    case 'roster_joined':
    case 'roster_left':
      return { rosterId: config.rosterId };
    case 'referral_succeeded':
      return {};
    case 'referral_milestone':
      return config.milestoneId ? { milestoneId: config.milestoneId } : {};
  }
}

/** Whether an event's payload satisfies a trigger config (the Circle filter is separate). */
export function matchesTrigger(config: FlowTriggerConfig, type: string, payload: unknown): boolean {
  if (config.event !== type) return false;
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (config.event) {
    case 'member_joined':
      if (p.source === 'import' && !config.includeImports) return false;
      return !config.formId || p.formId === config.formId;
    case 'form_submitted':
    case 'confirmed':
      return !config.formId || p.formId === config.formId;
    case 'circle_entered':
    case 'circle_exited':
      return p.circleId === config.circleId;
    case 'tag_added':
    case 'tag_removed':
      return p.tagId === config.tagId;
    case 'field_changed':
      return p.fieldId === config.fieldId;
    case 'level_purchased':
    case 'level_canceled':
      return !config.levelId || p.levelId === config.levelId;
    case 'ask_answered':
      return p.askId === config.askId && (!config.optionId || p.optionId === config.optionId);
    case 'unengaged':
      return p.days === config.days;
    case 'link_clicked':
      return (
        (!config.dispatchId || p.dispatchId === config.dispatchId) &&
        (!config.url ||
          p.url === config.url ||
          (Array.isArray(p.linkAddresses) && p.linkAddresses.includes(config.url)))
      );
    case 'gate_hit':
      return !config.dispatchId || p.dispatchId === config.dispatchId;
    case 'api_event':
      return p.name === config.name;
    case 'roster_joined':
    case 'roster_left':
      return p.rosterId === config.rosterId;
    case 'referral_succeeded':
      return true;
    case 'referral_milestone':
      return !config.milestoneId || p.milestoneId === config.milestoneId;
  }
}

interface Candidate {
  id: string;
  version: number;
  reentry: FlowReentry;
  /** How many start events the version has, of any type. */
  triggerCount: number;
  /** The start events of the event's type, with their position among all of them. */
  triggers: { index: number; config: FlowTriggerConfig }[];
}

/** Whether a live Flow is started by this event type (flows.trigger_type or the extra ones). */
const LISTENS_TO = `(trigger_type = ?2 OR EXISTS (
  SELECT 1 FROM json_each(coalesce(extra_trigger_types, '[]')) WHERE value = ?2))`;

async function candidates(
  db: D1Database,
  channelId: string,
  type: FlowTriggerType,
): Promise<Candidate[]> {
  const rows = await all<{ id: string; version: number; reentry: FlowReentry }>(
    db,
    `SELECT id, live_version AS version, reentry FROM flows
      WHERE channel_id = ?1 AND ${LISTENS_TO} AND status = 'live' AND deleted_at IS NULL
        AND live_version IS NOT NULL
        AND EXISTS (SELECT 1 FROM channels c WHERE c.id = ?1 AND c.deleted_at IS NULL)`,
    channelId,
    type,
  );
  const out: Candidate[] = [];
  for (const row of rows) {
    const graph = await loadVersionGraph(db, row.id, row.version);
    const configs = graph ? triggersOf(graph) : [];
    const triggers = configs
      .map((config, index) => ({ index, config }))
      .filter((t) => t.config.event === type);
    if (triggers.length) out.push({ ...row, triggerCount: configs.length, triggers });
  }
  return out;
}

// ---- Enrolment decisions ---------------------------------------------------------------------
//
// Why a start event didn't start a run, for the Member's page: one row per Member and Flow, holding
// only the latest. A start event that did start a run is already a flow_runs row, and clears the
// row. An event that matches no start event of a Flow says nothing and writes nothing, so busy
// event types cost one in-memory match. The upsert skips the write when the answer hasn't changed
// and is under a day old, so a Member clicking every link in a Flow they already ran writes at most
// once a day. Rows go with the Member (ON DELETE CASCADE) and with their Flow when it is archived or
// deleted (pruneFlowDecisions).

interface PendingDecision {
  memberId: string;
  flowId: string;
  /** Null: a run started, so any earlier row is out of date. */
  outcome: { version: number; reason: FlowEnrolDecision; event: FlowTriggerType } | null;
}

/** D1 batches are kept to this many statements. */
const DECISION_BATCH = 100;
const DECISION_REFRESH_MS = 86_400_000;

/** A filter that only asks "is in this Circle", which the Member's page can say in those words. */
export function isSegmentFilter(rule: unknown): boolean {
  const r = rule as { op?: unknown; field?: unknown; cmp?: unknown; children?: unknown[] };
  if (Array.isArray(r.children)) {
    return r.op !== 'not' && r.children.length === 1 && isSegmentFilter(r.children[0]);
  }
  return r.field === 'circle' && (r.cmp === 'eq' || r.cmp === 'in');
}

/**
 * What an event means for one Flow, before anything is written: null when it matches none of the
 * start events, the first one whose filter lets the Member in (one event starts one run, however
 * many it matches), or why none did. `passes` answers a filter, so a caller can cache or stub it.
 */
export async function chooseStartEvent(
  triggers: readonly { index: number; config: FlowTriggerConfig }[],
  type: string,
  payload: unknown,
  passes: (filter: CircleRule, index: number) => Promise<boolean | null>,
): Promise<{ index: number } | { reason: FlowEnrolDecision } | null> {
  const matching = triggers.filter((t) => matchesTrigger(t.config, type, payload));
  if (!matching.length) return null;
  for (const { index, config } of matching) {
    if (!config.filter || (await passes(config.filter, index))) return { index };
  }
  const segment = matching.every((t) => isSegmentFilter(t.config.filter));
  return { reason: segment ? 'not_in_segment' : 'filter_miss' };
}

/**
 * Only a Flow with several start events changes here: one start event can't fire twice at once, and
 * re-entry 'never' already refuses a second run.
 */
export const sameMomentGuard = (
  flow: { triggerCount: number; reentry: FlowReentry },
  eventAt: number,
): { notStartedSince?: number } =>
  flow.triggerCount > 1 && flow.reentry === 'after_exit'
    ? { notStartedSince: eventAt - FLOW_SAME_MOMENT_MS }
    : {};

/**
 * Why startFlowRun refused, or null when there is nothing to tell: this event already has its run,
 * another start event let them in at the same moment, or the Member is gone.
 */
export async function whyRunRefused(
  db: D1Database,
  flow: Pick<Candidate, 'id' | 'version' | 'reentry'>,
  event: Pick<MemberEventRow, 'member_id' | 'seq' | 'created_at'>,
): Promise<FlowEnrolDecision | null> {
  const row = await first<{
    open: number;
    same_event: number;
    version: number | null;
    started_at: number | null;
  }>(
    db,
    `SELECT EXISTS (SELECT 1 FROM flow_runs o WHERE o.flow_id = ?1 AND o.member_id = ?2 AND o.test = 0
                       AND o.status IN ('running', 'waiting', 'paused')) AS open,
            EXISTS (SELECT 1 FROM flow_runs o WHERE o.flow_id = ?1 AND o.member_id = ?2
                       AND o.trigger_event_seq = ?3) AS same_event,
            last.version, last.started_at
       FROM (SELECT 1) LEFT JOIN (
         SELECT version, started_at FROM flow_runs WHERE flow_id = ?1 AND member_id = ?2 AND test = 0
          ORDER BY started_at DESC LIMIT 1) AS last`,
    flow.id,
    event.member_id,
    event.seq,
  );
  if (!row || row.same_event) return null;
  if (row.started_at !== null && row.started_at >= event.created_at - FLOW_SAME_MOMENT_MS) {
    return null;
  }
  if (row.open) return 'already_in';
  if (row.version === null) return null;
  if (flow.reentry === 'after_exit') return 'rate_limited';
  return row.version === flow.version ? 'already_ran_version' : 'already_ran_earlier';
}

async function writeDecisions(
  db: D1Database,
  decisions: Iterable<PendingDecision>,
  now: number,
): Promise<void> {
  const statements = [...decisions].map(({ memberId, flowId, outcome }) =>
    outcome
      ? db
          .prepare(
            `INSERT INTO flow_enrol_decisions (member_id, flow_id, version, reason, trigger_event, decided_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6
              WHERE EXISTS (SELECT 1 FROM members WHERE id = ?1)
                AND EXISTS (SELECT 1 FROM flows WHERE id = ?2)
             ON CONFLICT (member_id, flow_id) DO UPDATE SET
               version = excluded.version, reason = excluded.reason,
               trigger_event = excluded.trigger_event, decided_at = excluded.decided_at
             WHERE reason <> excluded.reason OR version <> excluded.version
                OR trigger_event <> excluded.trigger_event
                OR decided_at < excluded.decided_at - ${DECISION_REFRESH_MS}`,
          )
          .bind(memberId, flowId, outcome.version, outcome.reason, outcome.event, now)
      : db
          .prepare('DELETE FROM flow_enrol_decisions WHERE member_id = ?1 AND flow_id = ?2')
          .bind(memberId, flowId),
  );
  for (let i = 0; i < statements.length; i += DECISION_BATCH) {
    await db.batch(statements.slice(i, i + DECISION_BATCH));
  }
}

/** Rows and passes per daily prune; a Flow with a very large list finishes over the next days. */
const DECISION_PRUNE_PAGE = 5_000;
const DECISION_PRUNE_PAGES = 20;

/** Daily: drops the decisions of Flows that can no longer run, so rows stay bounded by live Flows. */
export async function pruneFlowDecisions(db: D1Database): Promise<void> {
  for (let page = 0; page < DECISION_PRUNE_PAGES; page++) {
    const result = await db
      .prepare(
        `DELETE FROM flow_enrol_decisions WHERE (member_id, flow_id) IN (
           SELECT member_id, flow_id FROM flow_enrol_decisions WHERE flow_id IN (
             SELECT id FROM flows WHERE status = 'archived' OR deleted_at IS NOT NULL)
           LIMIT ${DECISION_PRUNE_PAGE})`,
      )
      .run();
    if ((result.meta.changes ?? 0) < DECISION_PRUNE_PAGE) return;
  }
}

/** Wakes wait_for_event waits an email_opened or link_clicked event satisfies. */
async function wakeWaits(env: FlowsEnv, event: MemberEventRow, now: number): Promise<number> {
  const payload = parseJson<Partial<MemberEventPayloads['link_clicked']>>(event.payload_json, {});
  if (!payload.broadcastId) return 0;
  const runs = await all<FlowRunRow>(
    env.DB,
    `SELECT * FROM flow_runs
      WHERE member_id = ?1 AND status IN ('running', 'waiting') AND wait_json IS NOT NULL
        AND json_extract(wait_json, '$.broadcastId') = ?2`,
    event.member_id,
    payload.broadcastId,
  );
  let woken = 0;
  for (const run of runs) {
    const wait = parseJson<FlowRunWait | null>(run.wait_json, null);
    if (!wait || run.current_node_id !== wait.node || event.created_at > wait.until) continue;
    // A human click implies an open (recordClick sets human_opened_at too).
    const satisfied =
      wait.event === 'open' ||
      (event.type === 'link_clicked' &&
        (!wait.url ||
          payload.url === wait.url ||
          (!!payload.url && (await linkAddresses(env.DB, payload.url)).includes(wait.url))));
    if (!satisfied) continue;
    if (await resolveWait(env, run, wait, { event: event.type, seq: event.seq }, now)) woken++;
  }
  return woken;
}

/**
 * Drains member_events (a bounded batch per call) and enrols Members in matching live Flows.
 * Returns how many runs were created. Safe to run concurrently with itself: enrolment is
 * guarded by flow_runs_one_open and by the trigger event seq, wake-ups by the pending wait step,
 * and events are stamped processed only after their runs exist. A full batch queues another
 * 'flow_events' message.
 */
export async function enrollFromEvents(env: FlowsEnv, now: number): Promise<number> {
  const db = env.DB;
  const events = await pendingMemberEvents(db, FLOW_EVENTS_BATCH);
  if (!events.length) return 0;
  const byTrigger = new Map<string, Candidate[]>();
  const filters = new Map<string, boolean | null>();
  // Latest per Member and Flow; a Member can have many events in one batch.
  const decisions = new Map<string, PendingDecision>();
  let started = 0;
  for (const event of events) {
    if (event.type === 'email_opened' || event.type === 'link_clicked') {
      await wakeWaits(env, event, now);
    }
    if (!TRIGGER_TYPES.has(event.type)) continue;
    const type = event.type as FlowTriggerType;
    const key = `${event.channel_id}:${type}`;
    let flows = byTrigger.get(key);
    if (!flows) {
      flows = await candidates(db, event.channel_id, type);
      byTrigger.set(key, flows);
    }
    if (!flows.length) continue;
    let payload = parseJson<unknown>(event.payload_json, {});
    if (type === 'link_clicked') {
      const url = (payload as { url?: unknown }).url;
      if (typeof url === 'string') {
        payload = { ...(payload as object), linkAddresses: await linkAddresses(db, url) };
      }
    }
    for (const flow of flows) {
      const choice = await chooseStartEvent(flow.triggers, type, payload, async (filter, index) => {
        // The enrolment filter is evaluated against the Member as they are now.
        const filterKey = `${flow.id}:${flow.version}:${index}:${event.member_id}`;
        let ok = filters.get(filterKey);
        if (ok === undefined) {
          ok = await memberMatchesRule(
            db,
            { member_id: event.member_id, channel_id: event.channel_id },
            filter,
            now,
          );
          filters.set(filterKey, ok);
        }
        return ok;
      });
      if (!choice) continue;
      const decisionKey = `${flow.id}:${event.member_id}`;
      const decide = (outcome: PendingDecision['outcome']) =>
        decisions.set(decisionKey, { memberId: event.member_id, flowId: flow.id, outcome });
      if ('reason' in choice) {
        decide({ version: flow.version, reason: choice.reason, event: type });
        continue;
      }
      const runId = await startFlowRun(env, {
        flowId: flow.id,
        version: flow.version,
        memberId: event.member_id,
        channelId: event.channel_id,
        triggerEventSeq: event.seq,
        context: { trigger: { type, payload, seq: event.seq, index: choice.index } },
        ...sameMomentGuard(flow, event.created_at),
        now,
      });
      if (runId) {
        started++;
        decide(null);
      } else {
        const reason = await whyRunRefused(db, flow, event);
        if (reason) decide({ version: flow.version, reason, event: type });
      }
    }
  }
  await writeDecisions(db, decisions.values(), now);
  await markMemberEventsProcessed(
    db,
    events.map((e) => e.seq),
    now,
  );
  if (events.length === FLOW_EVENTS_BATCH) await env.JOBS_QUEUE.send({ type: 'flow_events' });
  return started;
}

/**
 * Daily cron hook (jobs worker): emits 'unengaged' events for active Members of Channels with a
 * live unengaged Flow, once per distinct `days` those Flows use. A Member qualifies when they
 * joined (or confirmed) more than `days` ago, have no human open or click in the last `days`
 * days, and have no unengaged event for that threshold since their last engagement, so each
 * stretch of silence emits once (the check is idempotent within and across days; a run that
 * misses a day catches up). Bounded per (Channel, days). Then prunes processed member_events
 * (pruneMemberEvents) and kicks event draining. Note: once the 90-day event retention prunes an
 * old unengaged event, a Member still silent is emitted again; re-entry 'never' stops a repeat
 * enrolment.
 */
export async function checkUnengaged(env: FlowsEnv, now: number): Promise<void> {
  const db = env.DB;
  const flows = await all<{ id: string; channel_id: string; version: number }>(
    db,
    `SELECT id, channel_id, live_version AS version FROM flows
      WHERE (trigger_type = 'unengaged' OR EXISTS (
               SELECT 1 FROM json_each(coalesce(extra_trigger_types, '[]')) WHERE value = 'unengaged'))
        AND status = 'live' AND deleted_at IS NULL AND live_version IS NOT NULL
        AND EXISTS (SELECT 1 FROM channels c WHERE c.id = flows.channel_id AND c.deleted_at IS NULL)`,
  );
  const thresholds = new Map<string, { channelId: string; days: number }>();
  for (const flow of flows) {
    const graph = await loadVersionGraph(db, flow.id, flow.version);
    for (const trigger of graph ? triggersOf(graph) : []) {
      if (trigger.event !== 'unengaged') continue;
      const days = trigger.days;
      thresholds.set(`${flow.channel_id}:${days}`, { channelId: flow.channel_id, days });
    }
  }
  let emitted = 0;
  for (const { channelId, days } of thresholds.values()) {
    const since = now - days * 86_400_000;
    const result = await exec(
      db,
      `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
       SELECT m.channel_id, m.id, 'unengaged', json_object('days', ?2), ?3 FROM members m
        WHERE m.channel_id = ?1 AND m.status = 'active' AND m.emails_off_at IS NULL
          AND coalesce(m.confirmed_at, m.created_at) < ?4
          AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.member_id = m.id
                            AND (d.human_opened_at >= ?4 OR d.human_clicked_at >= ?4))
          AND NOT EXISTS (
            SELECT 1 FROM member_events e
             WHERE e.member_id = m.id AND e.type = 'unengaged'
               AND json_extract(e.payload_json, '$.days') = ?2
               AND e.created_at >= max(coalesce(m.confirmed_at, m.created_at),
                     coalesce((SELECT max(max(coalesce(d.human_opened_at, 0), coalesce(d.human_clicked_at, 0)))
                                 FROM deliveries d WHERE d.member_id = m.id), 0)))
        LIMIT ?5`,
      channelId,
      days,
      now,
      since,
      UNENGAGED_BATCH,
    );
    emitted += result.meta.changes ?? 0;
  }
  await pruneMemberEvents(db, now);
  await pruneFlowEmailLedger(db, now);
  await pruneFlowDecisions(db);
  if (emitted) await env.JOBS_QUEUE.send({ type: 'flow_events' });
}
