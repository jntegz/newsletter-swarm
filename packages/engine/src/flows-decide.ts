/**
 * What a Flow step decides, apart from what it does. `decideStep` reads the database and answers
 * "which outcome does this node take for this Member now, and which action does it need?". It
 * never writes, queues, sends or calls out.
 *
 * Two callers, on purpose one decision:
 * - the real engine (`execute` in flows-engine.ts) performs the action and finishes the step;
 * - Rehearse (flows-rehearse.ts) hands it a read-only view of the database, in which the changes
 *   earlier steps of the rehearsal would have made are already visible, and only records the answer.
 * Anything that picks a path belongs here, so a rehearsal can't drift from a real run.
 */
import {
  FLOW_REENTRY_MAX_PER_HOUR,
  inboxRulesActive,
  inboxRulesFromSettings,
  isSendRegardless,
  type FieldValue,
  type FlowEdgeLabel,
  type FlowExitReason,
  type FlowGraph,
  type FlowNode,
  type FlowNodeOf,
  type FlowRunContext,
  type FlowRunWait,
  type InboxRules,
} from '@swarm/domain';
import { compGrantAllowed } from './comp-grants';
import { CircleRuleError, compileCircle } from './circles';
import { all, first } from './db';
import { entitledLevel } from './entitlements';
import { FieldValueError, normalizeFieldValue } from './fields';
import type { FlowRunRow, RecheckResult } from './flows';
import { alreadyReceived, loadInboxRuleFacts } from './flows-holds';
import { decideInboxRules, type InboxRuleDecision } from './flows-inbox-rules';
import { delayUntil, isTimeZone } from './flows-time';
import { abArm, parseJson } from './flows-util';
import { WebhookError } from './flows-webhook';
import { channelFields, type ChannelField } from './members';

/** How soon a Flow email held back by a paused Channel looks again. */
const CHANNEL_PAUSED_RETRY_MS = 60 * 60 * 1000;
/** Queue deliveries can be a little early relative to our clock. */
export const DUE_SLACK_MS = 1000;

export interface FlowRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  name: string;
  status: 'draft' | 'live' | 'paused' | 'archived';
  live_version: number | null;
  reentry: 'never' | 'after_exit';
  webhook_secret_enc: string | null;
  deleted_at: number | null;
}

/** A failure retrying can't fix: the run is paused at once. */
export class PermanentStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentStepError';
  }
}

/** Whether a step's error pauses the run at once instead of being retried. */
export const isPermanentStepError = (error: unknown) =>
  error instanceof PermanentStepError ||
  error instanceof FieldValueError ||
  (error instanceof WebhookError && error.permanent);

export type Outcome =
  | { kind: 'next'; label: FlowEdgeLabel; status?: 'done' | 'skipped'; result?: unknown }
  | { kind: 'exit'; reason: FlowExitReason; status?: 'done' | 'skipped'; result?: unknown }
  | { kind: 'park'; until: number; result: Record<string, unknown>; wait?: FlowRunWait };

/** The email a send_email node sends: a frozen Flow Broadcast, or a draft's Dispatch in a rehearsal. */
export interface FlowEmailRow {
  id: string;
  dispatch_id: string;
  status: string;
  channel_id: string;
  ramp_id: string | null;
  has_teaser: number;
  gate_level_ids_json: string | null;
  subject: string;
  preheader: string;
}

interface MemberContact {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

export type StepAction =
  | {
      type: 'send';
      email: FlowEmailRow;
      context: FlowRunContext;
      rules: InboxRules;
      sendRegardless: boolean;
    }
  /** An earlier attempt added the recipient row, but its hand-off to the send queue failed. */
  | { type: 'requeue_send'; broadcastId: string; email: FlowEmailRow; context: FlowRunContext }
  | { type: 'add_tag'; tagId: string }
  | { type: 'remove_tag'; tagId: string }
  | { type: 'update_field'; field: ChannelField; value: FieldValue }
  | { type: 'grant_level'; levelId: string; days: number | null; note: string }
  | { type: 'revoke_level'; levelId: string }
  | { type: 'enrol'; target: FlowRow }
  | { type: 'webhook'; member: MemberContact }
  | { type: 'notify' };

/** An inbox rule stops the email now. The engine records the hold; a rehearsal only shows it. */
export interface HeldEmail {
  decision: Exclude<InboxRuleDecision, { action: 'send' }>;
  zone: string;
}

type Decision =
  | { kind: 'outcome'; outcome: Outcome }
  | { kind: 'hold'; hold: HeldEmail }
  | { kind: 'act'; action: StepAction };

type DecisionRun = Pick<
  FlowRunRow,
  'id' | 'flow_id' | 'version' | 'channel_id' | 'member_id' | 'context_json' | 'test'
>;

interface DecideInput {
  db: D1Database;
  run: DecisionRun;
  flow: Pick<FlowRow, 'webhook_secret_enc'>;
  graph: FlowGraph;
  node: FlowNode;
  now: number;
  /** Whether encrypted fields and webhook secrets can be opened. */
  hasFieldKeys: boolean;
  // ---- Only a rehearsal sets these ----
  /** Where a send node's email comes from; a real run reads the version's frozen Flow Broadcast. */
  findEmail?: (node: FlowNodeOf<'send_email'>) => Promise<FlowEmailRow | null>;
  /** Decide as if a paused Channel were back, to show what comes after the wait. */
  channelBack?: boolean | undefined;
  /** The arm the writer picked for an A/B split. */
  arm?: 'a' | 'b';
}

/** SQL: the address is in suppressions for the workspace (`m` a Member, `c` their Channel). */
export const SUPPRESSED_SQL = `EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = c.workspace_id AND s.email = m.email AND (s.channel_id IS NULL OR s.channel_id = m.channel_id))`;

/** SQL: the Member has an open real run of the Flow (`f` the Flow, `m` the Member). */
export const OPEN_REAL_RUN_SQL = `EXISTS (SELECT 1 FROM flow_runs r WHERE r.flow_id = f.id AND r.member_id = m.id AND r.test = 0
                 AND r.status IN ('running', 'waiting', 'paused'))`;

/**
 * SQL: what startFlowRun refuses, apart from a second open run (flow_runs_one_open). `f` is the Flow,
 * `m` the Member. Rehearse and Add people read the same words instead of trying the insert.
 */
export const entryGuardsSql = (at: {
  seq: string;
  test: string;
  since: string;
  cap: string;
  notStartedSince: string;
}) => `(${at.test} = 1 OR f.reentry = 'after_exit'
             OR NOT EXISTS (SELECT 1 FROM flow_runs r WHERE r.flow_id = f.id AND r.member_id = m.id AND r.test = 0))
        AND (${at.test} = 1 OR (SELECT count(*) FROM flow_runs r WHERE r.flow_id = f.id AND r.member_id = m.id
                          AND r.test = 0 AND r.started_at > ${at.since}) < ${at.cap})
        AND (${at.seq} IS NULL
             OR NOT EXISTS (SELECT 1 FROM flow_runs r WHERE r.flow_id = f.id AND r.member_id = m.id
                              AND r.trigger_event_seq = ${at.seq}))
        AND (${at.notStartedSince} IS NULL
             OR NOT EXISTS (SELECT 1 FROM flow_runs r WHERE r.flow_id = f.id AND r.member_id = m.id
                              AND r.test = 0 AND r.started_at >= ${at.notStartedSince}))`;

/** Whether startFlowRun would start a real run now. Reads only. */
export async function wouldStartFlowRun(
  db: D1Database,
  input: {
    flowId: string;
    memberId: string;
    channelId: string;
    /** The version to pin; null for a draft, which has none yet. */
    version: number | null;
    notStartedSince?: number;
    now: number;
  },
): Promise<boolean> {
  const row = await first(
    db,
    `SELECT 1 AS ok FROM flows f JOIN members m ON m.id = ?1 AND m.channel_id = f.channel_id
      WHERE f.id = ?2 AND f.channel_id = ?3 AND f.deleted_at IS NULL
        AND (?4 IS NULL OR EXISTS (SELECT 1 FROM flow_versions v WHERE v.flow_id = f.id AND v.version = ?4))
        AND NOT ${OPEN_REAL_RUN_SQL}
        AND ${entryGuardsSql({ seq: 'NULL', test: '0', since: '?5', cap: '?6', notStartedSince: '?7' })}`,
    input.memberId,
    input.flowId,
    input.channelId,
    input.version,
    input.now - 3_600_000,
    FLOW_REENTRY_MAX_PER_HOUR,
    input.notStartedSince ?? null,
  );
  return row !== null;
}

/**
 * The gate before every send_email node: the Member is still in the run's Channel and 'active'
 * (else 'member_inactive'), their address isn't in suppressions for the workspace (else
 * 'suppressed'), and, for audience 'paid' / 'free', their current entitlement fits (else
 * 'not_entitled' / 'already_paid'). Reads only; the caller exits the run on failure.
 */
export async function recheckBeforeSend(
  db: D1Database,
  run: Pick<FlowRunRow, 'member_id' | 'channel_id'>,
  audience: 'any' | 'paid' | 'free' = 'any',
  now: number = Date.now(),
): Promise<RecheckResult> {
  const member = await first<{ status: string; suppressed: number }>(
    db,
    `SELECT m.status,
            ${SUPPRESSED_SQL} AS suppressed
       FROM members m JOIN channels c ON c.id = m.channel_id
      WHERE m.id = ?1 AND m.channel_id = ?2`,
    run.member_id,
    run.channel_id,
  );
  if (!member || member.status !== 'active') return { ok: false, reason: 'member_inactive' };
  if (member.suppressed) return { ok: false, reason: 'suppressed' };
  if (audience !== 'any') {
    const entitled = (await entitledLevel(db, run.channel_id, run.member_id, now)) !== undefined;
    if (audience === 'paid' && !entitled) return { ok: false, reason: 'not_entitled' };
    if (audience === 'free' && entitled) return { ok: false, reason: 'already_paid' };
  }
  return { ok: true };
}

/** Whether the run's Member matches a Circle rule now; null when the rule can't be compiled. */
export async function memberMatchesRule(
  db: D1Database,
  run: Pick<FlowRunRow, 'member_id' | 'channel_id'>,
  rule: unknown,
  now: number,
): Promise<boolean | null> {
  let compiled;
  try {
    compiled = await compileCircle(db, rule, run.channel_id, now);
  } catch (error) {
    if (error instanceof CircleRuleError) return null;
    throw error;
  }
  const row = await first(
    db,
    `SELECT 1 AS ok FROM members m WHERE m.id = ?2 AND m.channel_id = ?3 AND (${compiled.where})`,
    ...compiled.params,
    run.member_id,
    run.channel_id,
  );
  return row !== null;
}

/**
 * The zone a delay with timezone 'member' uses: the Member's `timezone` profile field when it
 * holds a valid IANA zone, else the Channel's settings timezone, else UTC. (Members have no
 * timezone column; encrypted timezone fields are not read.)
 */
export async function memberZone(
  db: D1Database,
  run: Pick<FlowRunRow, 'member_id' | 'channel_id'>,
): Promise<string> {
  const row = await first<{ settings_json: string; tz: string | null }>(
    db,
    `SELECT c.settings_json,
            (SELECT v.value_text FROM member_field_values v JOIN member_fields f ON f.id = v.field_id
              WHERE v.member_id = ?1 AND f.channel_id = c.id AND f.key = 'timezone' AND f.deleted_at IS NULL) AS tz
       FROM channels c WHERE c.id = ?2`,
    run.member_id,
    run.channel_id,
  );
  const tz = row?.tz;
  if (isTimeZone(tz)) return tz;
  const channelZone = parseJson<{ timezone?: unknown }>(row?.settings_json, {}).timezone;
  return isTimeZone(channelZone) ? channelZone : 'UTC';
}

/** The frozen Flow Broadcast of a send node on the run's version. */
async function findFlowEmail(
  db: D1Database,
  run: DecisionRun,
  node: FlowNodeOf<'send_email'>,
): Promise<FlowEmailRow | null> {
  return first<FlowEmailRow>(
    db,
    `SELECT b.id, fe.dispatch_id, b.status, b.channel_id, b.ramp_id,
            b.teaser_html IS NOT NULL AS has_teaser, b.gate_level_ids_json, b.subject, b.preheader
       FROM flow_emails fe JOIN broadcasts b ON b.id = fe.broadcast_id
      WHERE fe.flow_id = ?1 AND fe.version = ?2 AND fe.node_id = ?3 AND b.kind = 'flow'`,
    run.flow_id,
    run.version,
    node.id,
  );
}

/**
 * The email a send node handed over in this run. Own keys only: step ids are any letters, so a
 * step "constructor" that has not sent yet must not find Object.prototype's.
 */
const sentBy = (context: FlowRunContext, nodeId: string): string | undefined =>
  context.sent && Object.hasOwn(context.sent, nodeId) ? context.sent[nodeId] : undefined;

/** What flow_runs.context_json holds once a send node has handed its email over. */
export const contextAfterSend = (
  context: FlowRunContext,
  nodeId: string,
  broadcastId: string,
): FlowRunContext => ({
  ...context,
  sent: { ...context.sent, [nodeId]: broadcastId },
  lastSendNodeId: nodeId,
});

/**
 * The inbox rule answer for this send step now: null when it may go. Reads only, so the engine and a
 * rehearsal ask the same question; only the engine then records the hold.
 */
export async function inboxRuleHold(
  db: D1Database,
  input: {
    run: Pick<DecisionRun, 'id' | 'member_id' | 'channel_id'>;
    nodeId: string;
    rules: InboxRules;
    sendRegardless: boolean;
    now: number;
  },
): Promise<HeldEmail | null> {
  const { run, nodeId, rules, sendRegardless, now } = input;
  if (sendRegardless || !inboxRulesActive(rules)) return null;
  const zone = await memberZone(db, run);
  const decision = decideInboxRules(
    await loadInboxRuleFacts(db, { run, nodeId, rules, zone, sendRegardless, now }),
  );
  return decision.action === 'send' ? null : { decision, zone };
}

/** How a hold ends the step for now: the run parks, or exits when it has waited too long. */
export function outcomeOfHold(hold: HeldEmail): Outcome {
  const { decision } = hold;
  if (decision.action === 'expire') {
    return {
      kind: 'exit',
      reason: 'hold_expired',
      result: { heldFor: decision.reason, wouldWaitUntil: decision.until },
    };
  }
  return {
    kind: 'park',
    until: decision.until,
    result: { until: decision.until, deferred: 'inbox_rules', reason: decision.reason },
  };
}

async function decideSend(input: DecideInput, node: FlowNodeOf<'send_email'>): Promise<Decision> {
  const { db, run, now } = input;
  const exit = (reason: FlowExitReason, result?: unknown): Decision => ({
    kind: 'outcome',
    outcome: { kind: 'exit', reason, ...(result === undefined ? {} : { result }) },
  });
  const check = await recheckBeforeSend(db, run, node.config.audience, now);
  if (!check.ok) return exit(check.reason);

  // A paused Channel can't start a Broadcast (preflight); its Flows wait the same way, and pick
  // up where they were if it comes back. A deleted Channel mails nobody again.
  const channel = await first<{
    status: string;
    deleted_at: number | null;
    settings_json: string;
  }>(db, 'SELECT status, deleted_at, settings_json FROM channels WHERE id = ?1', run.channel_id);
  if (!channel || channel.deleted_at !== null) return exit('flow_archived');
  if (channel.status === 'paused' && !input.channelBack) {
    const until = now + CHANNEL_PAUSED_RETRY_MS;
    return {
      kind: 'outcome',
      outcome: { kind: 'park', until, result: { until, deferred: 'channel_paused' } },
    };
  }

  const email = input.findEmail ? await input.findEmail(node) : await findFlowEmail(db, run, node);
  if (
    !email ||
    email.channel_id !== run.channel_id ||
    (email.status !== 'sending' && email.status !== 'queued')
  ) {
    return exit('invalid_reference', { missing: 'flow_email' });
  }

  const context = parseJson<FlowRunContext>(run.context_json, {});
  // A test run sends from its own copy of the email (flows-engine.ts), so what the Member got from
  // the real one neither stops the test nor gets used up by it.
  const held = run.test ? sentBy(context, node.id) : email.id;
  const existing = held
    ? await first<{ status: string }>(
        db,
        'SELECT status FROM broadcast_recipients WHERE broadcast_id = ?1 AND member_id = ?2',
        held,
        run.member_id,
      )
    : null;
  if (held && existing) {
    if (existing.status === 'pending' && sentBy(context, node.id) === held) {
      return { kind: 'act', action: { type: 'requeue_send', broadcastId: held, email, context } };
    }
    return {
      kind: 'outcome',
      outcome: {
        kind: 'next',
        label: 'default',
        status: 'skipped',
        result: { broadcastId: held, skipped: 'already_sent' },
      },
    };
  }
  // Test runs are how a writer sees a new version, so only real runs skip what was sent before,
  // only real runs are held, and only real runs count toward the limit.
  if (!run.test && (await alreadyReceived(db, run, email.dispatch_id, email.id))) {
    return {
      kind: 'outcome',
      outcome: {
        kind: 'next',
        label: 'default',
        status: 'skipped',
        result: { broadcastId: email.id, skipped: 'already_received' },
      },
    };
  }
  const rules = inboxRulesFromSettings(parseJson<unknown>(channel.settings_json, {}));
  const sendRegardless = isSendRegardless(input.graph, node);
  if (!run.test) {
    const hold = await inboxRuleHold(db, { run, nodeId: node.id, rules, sendRegardless, now });
    if (hold) return { kind: 'hold', hold };
  }
  return { kind: 'act', action: { type: 'send', email, context, rules, sendRegardless } };
}

async function decideField(input: DecideInput, node: FlowNodeOf<'update_field'>) {
  const { db, run } = input;
  const field = [...(await channelFields(db, run.channel_id)).values()].find(
    (f) => f.id === node.config.fieldId,
  );
  if (!field) {
    return {
      kind: 'outcome',
      outcome: { kind: 'exit', reason: 'invalid_reference', result: { missing: 'field' } },
    } satisfies Decision;
  }
  const value = normalizeFieldValue(field, node.config.value);
  if (field.encrypted && !input.hasFieldKeys) {
    throw new PermanentStepError('Encrypted profile fields need the vault.');
  }
  return { kind: 'act', action: { type: 'update_field', field, value } } satisfies Decision;
}

/** comp_grants.note for a grant made by a Flow node; revoke finds a Flow's grants by its marker. */
const compNote = (flowId: string, runId: string, nodeId: string) =>
  `Granted by an automation (flow:${flowId} run:${runId} node:${nodeId})`;

/** What a Flow's revoke step looks for in comp_grants.note. */
export const compNoteMarker = (flowId: string) => `(flow:${flowId} `;

/** The outcome when a change_level node's level can't be granted. */
export const levelUnavailable: Outcome = {
  kind: 'next',
  label: 'default',
  status: 'skipped',
  result: { skipped: 'level_unavailable' },
};

/**
 * A test run's change_level step. Comp grants are real paid access that only an admin may give
 * (the comp route), and a test run can be started by an editor, so a test changes no one's level.
 */
const levelTestSkipped: Outcome = {
  kind: 'next',
  label: 'default',
  status: 'skipped',
  result: { skipped: 'test_run' },
};

async function decideLevel(input: DecideInput, node: FlowNodeOf<'change_level'>) {
  const { db, run } = input;
  const config = node.config;
  if (run.test) return { kind: 'outcome', outcome: levelTestSkipped } as Decision;
  if (config.action === 'revoke') {
    return { kind: 'act', action: { type: 'revoke_level', levelId: config.levelId } } as Decision;
  }
  const note = compNote(run.flow_id, run.id, node.id);
  const done = await first<{ id: string }>(
    db,
    'SELECT id FROM comp_grants WHERE member_id = ?1 AND note = ?2',
    run.member_id,
    note,
  );
  if (done) {
    return {
      kind: 'outcome',
      outcome: { kind: 'next', label: 'default', result: { grantId: done.id } },
    } as Decision;
  }
  const allowed = await compGrantAllowed(db, {
    channelId: run.channel_id,
    memberId: run.member_id,
    levelId: config.levelId,
  });
  if (!allowed) return { kind: 'outcome', outcome: levelUnavailable } as Decision;
  return {
    kind: 'act',
    action: { type: 'grant_level', levelId: config.levelId, days: config.days, note },
  } as Decision;
}

/** The outcome of an enrol_flow node that started nothing, and why. */
export const enrolSkipped = (reason: string): Outcome => ({
  kind: 'next',
  label: 'default',
  status: 'skipped',
  result: { enrolled: false, reason },
});

async function decideEnrol(input: DecideInput, node: FlowNodeOf<'enrol_flow'>): Promise<Decision> {
  const { db, run } = input;
  const target = await first<FlowRow>(
    db,
    `SELECT id, workspace_id, channel_id, name, status, live_version, reentry, webhook_secret_enc,
            deleted_at
       FROM flows WHERE id = ?1 AND channel_id = ?2 AND deleted_at IS NULL`,
    node.config.flowId,
    run.channel_id,
  );
  if (!target || target.id === run.flow_id) {
    return { kind: 'outcome', outcome: enrolSkipped('unavailable') };
  }
  if (target.live_version === null || (target.status !== 'live' && !run.test)) {
    return { kind: 'outcome', outcome: enrolSkipped('not_live') };
  }
  return { kind: 'act', action: { type: 'enrol', target } };
}

async function decideWait(input: DecideInput, node: FlowNodeOf<'wait_for_event'>) {
  const { db, run, now } = input;
  const context = parseJson<FlowRunContext>(run.context_json, {});
  const source = node.config.sendNodeId ?? context.lastSendNodeId;
  let broadcastId = source ? sentBy(context, source) : undefined;
  if (!broadcastId && source) {
    broadcastId = (
      await first<{ broadcast_id: string }>(
        db,
        'SELECT broadcast_id FROM flow_emails WHERE flow_id = ?1 AND version = ?2 AND node_id = ?3',
        run.flow_id,
        run.version,
        source,
      )
    )?.broadcast_id;
  }
  const until = now + node.config.timeoutHours * 3_600_000;
  const wait: FlowRunWait = {
    node: node.id,
    event: node.config.event,
    broadcastId: broadcastId ?? '',
    ...(node.config.url ? { url: node.config.url } : {}),
    until,
  };
  // Without an email to watch the wait can only time out; it still waits, as configured.
  return {
    kind: 'park',
    until,
    result: { until, broadcastId: wait.broadcastId },
    wait,
  } satisfies Outcome;
}

/**
 * Every address a link goes by: itself, plus its short link or its destination when Swarm shortened
 * it. A writer can name either in a Flow, and shortening a post mustn't break a step watching it.
 */
export async function linkAddresses(db: D1Database, url: string): Promise<string[]> {
  const rows = await all<{ url: string; short_url: string }>(
    db,
    'SELECT url, short_url FROM app_short_links WHERE url = ?1 OR short_url = ?1',
    url,
  );
  return [...new Set([url, ...rows.flatMap((row) => [row.url, row.short_url])])];
}

/** Whether the awaited open or click already happened (human only). */
export async function eventHappened(
  db: D1Database,
  memberId: string,
  wait: FlowRunWait,
): Promise<boolean> {
  if (wait.event === 'open') {
    return (
      (await first(
        db,
        `SELECT 1 AS ok FROM deliveries
          WHERE broadcast_id = ?1 AND member_id = ?2 AND human_opened_at IS NOT NULL LIMIT 1`,
        wait.broadcastId,
        memberId,
      )) !== null
    );
  }
  return (
    (await first(
      db,
      `SELECT 1 AS ok FROM clicks c
         JOIN deliveries d ON d.id = c.delivery_id
         JOIN link_targets l ON l.id = c.link_target_id
        WHERE d.broadcast_id = ?1 AND d.member_id = ?2 AND c.classification = 'human'
          AND (?3 IS NULL OR l.url IN (SELECT value FROM json_each(?3))) LIMIT 1`,
      wait.broadcastId,
      memberId,
      wait.url ? JSON.stringify(await linkAddresses(db, wait.url)) : null,
    )) !== null
  );
}

async function decideWebhook(input: DecideInput): Promise<Decision> {
  const { db, run, flow } = input;
  if (!flow.webhook_secret_enc || !input.hasFieldKeys) {
    throw new PermanentStepError('This automation has no webhook secret.');
  }
  const member = await first<MemberContact>(
    db,
    'SELECT id, email, first_name, last_name FROM members WHERE id = ?1 AND channel_id = ?2',
    run.member_id,
    run.channel_id,
  );
  if (!member) return { kind: 'outcome', outcome: { kind: 'exit', reason: 'member_inactive' } };
  return { kind: 'act', action: { type: 'webhook', member } };
}

/** The outcome that ends a parked delay or wait when its time is up. */
export const outcomeWhenTimeIsUp = (node: FlowNode): FlowEdgeLabel | null =>
  node.type === 'delay' ? 'default' : node.type === 'wait_for_event' ? 'timeout' : null;

/**
 * The one decision a step makes. Reads only. May throw what `isPermanentStepError` recognises, in
 * which case the run pauses.
 */
export async function decideStep(input: DecideInput): Promise<Decision> {
  const { db, run, node, now } = input;
  const outcome = (o: Outcome): Decision => ({ kind: 'outcome', outcome: o });
  const act = (action: StepAction): Decision => ({ kind: 'act', action });
  switch (node.type) {
    case 'trigger':
      return outcome({ kind: 'next', label: 'default' });
    case 'exit':
      return outcome({ kind: 'exit', reason: 'exit_node', status: 'done' });
    case 'send_email':
      return decideSend(input, node);
    case 'delay': {
      const zone =
        node.config.mode === 'until' && node.config.timezone === 'member'
          ? await memberZone(db, run)
          : 'UTC';
      const until = delayUntil(node.config, now, zone);
      if (until <= now + DUE_SLACK_MS) return outcome({ kind: 'next', label: 'default' });
      return outcome({ kind: 'park', until, result: { until, zone } });
    }
    case 'add_tag':
      return act({ type: 'add_tag', tagId: node.config.tagId });
    case 'remove_tag':
      return act({ type: 'remove_tag', tagId: node.config.tagId });
    case 'update_field':
      return decideField(input, node);
    case 'change_level':
      return decideLevel(input, node);
    case 'enrol_flow':
      return decideEnrol(input, node);
    case 'branch': {
      const matched = await memberMatchesRule(db, run, node.config.condition, now);
      if (matched === null) return outcome({ kind: 'exit', reason: 'invalid_reference' });
      return outcome({ kind: 'next', label: matched ? 'true' : 'false' });
    }
    case 'ab_split': {
      const arm = input.arm ?? (await abArm(run.id, node.id, node.config.percentA));
      return outcome({ kind: 'next', label: arm, result: { arm } });
    }
    case 'wait_for_event':
      return outcome(await decideWait(input, node));
    case 'webhook_call':
      return decideWebhook(input);
    case 'notify_author':
      return act({ type: 'notify' });
  }
}
