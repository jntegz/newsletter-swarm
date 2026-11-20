/**
 * The Flows engine (Phase 6). One implementation, run by the jobs worker (queue messages
 * 'flow_events' and 'flow_step', the every-minute sweep and the daily unengaged check); Flow
 * emails are sent by the send worker's existing 'batch' handler.
 *
 * RUN LIFECYCLE (the contract the engine implements; see docs/architecture.md)
 * 1. Enrolment. `enrollFromEvents` drains member_events (pendingMemberEvents, seq order). For each
 *    event it finds live Flows of the event's Channel started by the event's type (flows.trigger_type
 *    or extra_trigger_types), loads the live flow_versions.graph_json, matches each start event's
 *    config (formId, circleId, tagId, ...), evaluates its optional `filter` rule, and for the first
 *    one that lets the Member in calls `startFlowRun`: it applies the Flow's re-entry rule and
 *    inserts a flow_runs row (status 'running', version pinned, current_node_id = the trigger node, context_json.trigger
 *    set). flow_runs_one_open makes a duplicate enrolment a no-op, and so does an existing run
 *    for the same event seq. It then queues { type: 'flow_step', runId, nodeId: <trigger node
 *    id>, attempt: 1 } (the trigger step just moves on) and marks the events processed
 *    (markMemberEventsProcessed). A start event that matched but let nobody in leaves its reason in
 *    flow_enrol_decisions (latest per Member and Flow). The same drain wakes wait_for_event waits on
 *    email_opened and link_clicked events. Test runs and enrol_flow nodes call startFlowRun directly.
 * 2. Steps. `runStep` executes one node: inserts flow_run_steps (run, node, attempt) with
 *    status 'pending' (ON CONFLICT DO NOTHING; an existing done/failed/skipped row ends the
 *    message), re-checks the run is open and every referenced id still belongs to the Channel
 *    (collectReferencedIds; else exit 'invalid_reference'), performs the action, marks the step
 *    'done' with its outcome label, moves current_node_id, and queues the next node (or ends the
 *    run 'completed' when no edge carries the outcome; 'exited' with 'exit_node' at an exit).
 *    An action that throws marks that attempt 'failed' with the error (never 'done') and parks
 *    the run until attempt + 1 after flowStepBackoffSeconds; once FLOW_STEP_MAX_ATTEMPTS
 *    attempts have failed (or the error can't be fixed by retrying), the run is 'paused' with
 *    exit_reason 'step_failed' and the Channel's owners and admins get one email.
 * 3. Delays and waits. A delay or wait_for_event step stays 'pending' with result_json.until
 *    while the run is parked; `scheduleNext` parks the run (status 'waiting', next_at) and, when
 *    the wait is at most QUEUE_MAX_DELAY_SECONDS, also queues the step with delaySeconds. The
 *    every-minute `sweepFlows` claims runs whose next_at has passed with a conditional UPDATE
 *    (long delays, wait timeouts, lost messages: a queued step carries a 15 minute lease in
 *    next_at) and queues them, and kicks event draining. A step that runs early re-parks itself.
 *    The pending step row is the lock between a wait's event and its timeout.
 * 4. Sends. A send_email node calls `recheckBeforeSend` first (exit with its reason on failure),
 *    then adds a broadcast_recipients row to the node's frozen Flow Broadcast (flow_emails, by
 *    version and node) with the same active-and-unsuppressed predicate as the snapshot, then
 *    queues { type: 'batch', broadcastId, memberIds: [memberId] } on SEND_QUEUE, after
 *    reserving Reputation Ramp capacity like fan-out does. A Member already holding a
 *    recipient row for that Broadcast is not sent again (step 'skipped', reason already_sent),
 *    nor is one who already got the same email from another version (reason already_received,
 *    unless the writer asked to resend it at publish; flows-holds.ts). Before that, the Channel's
 *    inbox rules can hold the email: the step parks with result_json.deferred 'inbox_rules' and a
 *    flow_holds row, and runs again from the top when due. A wait past the Channel's maxHoldDays
 *    exits the run with 'hold_expired'. Test runs skip all of this.
 *    The send consumer checks the Member once more when it claims the row (pipeline.ts): someone
 *    who left while the message waited on the queue is skipped there.
 * 5. Versions. Runs finish on their own version. `migrateRuns` (operator choice) moves each
 *    open run whose current node id exists, with the same type, in the new version; the others
 *    exit with 'migrated'.
 * 6. Flow state. An archived or deleted Flow, or one whose Channel was deleted, exits its runs
 *    ('flow_archived') at their next step and enrols nobody; a paused Flow pauses them ('flow_paused'; `resumeFlowRuns` restarts them). Test runs
 *    ignore the Flow's status.
 */
import type { FlowExitReason, FlowGraph, FlowRunStatus } from '@swarm/domain';
import type { MailAdapter } from '@swarm/mail';
import type { FieldValues } from './vault-ports';
import type { SendMessage } from './config';
import type { JobMessage } from './jobs';

/** What the Flows engine needs from the jobs worker's env (see `flowsEnv` in workers/jobs). */
export interface FlowsEnv {
  DB: D1Database;
  JOBS_QUEUE: Queue<JobMessage>;
  /** Flow emails are handed to the send worker as 'batch' messages. */
  SEND_QUEUE: Queue<SendMessage>;
  /**
   * The vault, for encrypted profile fields (update_field, webhook includeFields) and the Flow's
   * webhook signature. Without it those steps fail permanently.
   */
  vault?: FlowsVault;
  /** Operator notices (notify_author, paused runs). Without it, notices are skipped. */
  notices?: { mail: MailAdapter; from: string };
  /** webhook_call transport; the global fetch when absent (tests pass a fake). */
  fetch?: typeof fetch;
}

/** The run a vault call acts for: its row (running at this node) is the authority. */
export interface FlowRunRef {
  runId: string;
  nodeId: string;
  channelId: string;
}

/**
 * The jobs worker's vault, as the Flows engine uses it. Each call throws when the vault can't
 * answer (the step is retried); `signWebhook` answers null when the secret can't be opened.
 */
export interface FlowsVault {
  sealFields(
    run: FlowRunRef,
    memberId: string,
    values: FieldValues,
  ): Promise<Record<string, string>>;
  openFields(run: FlowRunRef, memberIds: string[]): Promise<Record<string, FieldValues>>;
  signWebhook(run: FlowRunRef, timestamp: number, body: string): Promise<string | null>;
}

/** A flow_runs row. */
export interface FlowRunRow {
  id: string;
  flow_id: string;
  version: number;
  channel_id: string;
  member_id: string;
  status: FlowRunStatus;
  exit_reason: FlowExitReason | null;
  current_node_id: string | null;
  next_at: number | null;
  wait_json: string | null;
  context_json: string;
  trigger_event_seq: number | null;
  test: 0 | 1;
  started_at: number;
  updated_at: number;
  ended_at: number | null;
}

export type FlowStepMessage = Extract<JobMessage, { type: 'flow_step' }>;

export type RecheckResult = { ok: true } | { ok: false; reason: FlowExitReason };

export interface StartFlowRunInput {
  flowId: string;
  /** The version to pin (normally flows.live_version). */
  version: number;
  memberId: string;
  channelId: string;
  /** member_events.seq of the enrolling event; a second run for the same event is refused. */
  triggerEventSeq?: number | null;
  /** A test run: ignores re-entry 'never' and the Flow's status, and is flagged in stats. */
  test?: boolean;
  /** The version's graph when the caller already has it; loaded from flow_versions otherwise. */
  graph?: FlowGraph;
  /** Extra context_json (the trigger payload, who enrolled the Member). */
  context?: Record<string, unknown>;
  /** Refused when a real run of this Flow for this Member started at or after this time. */
  notStartedSince?: number;
  now: number;
}

export {
  checkUnengaged,
  chooseStartEvent,
  enrollFromEvents,
  matchesTrigger,
  payloadFor,
  pruneFlowDecisions,
  whyRunRefused,
  FLOW_EVENTS_BATCH,
  UNENGAGED_BATCH,
} from './flows-enrol';
export {
  foreignReferences,
  loadVersionGraph,
  memberZone,
  migrateRuns,
  recheckBeforeSend,
  resumeFlowRuns,
  runDueFlowSteps,
  runStep,
  scheduleNext,
  startFlowRun,
  sweepFlows,
  FLOW_RUN_LEASE_MS,
  FLOW_STEP_STALE_MS,
} from './flows-engine';
export {
  enrolChunk,
  enrolmentCounts,
  type EnrolChunkInput,
  type EnrolChunkResult,
  type EnrolmentCounts,
} from './flows-admit';
export {
  RehearsalWriteError,
  readOnlyView,
  rehearseFlow,
  sampleCircle,
  type RehearseInput,
} from './flows-rehearse';
export { delayUntil, isTimeZone, nextWeekdayTime } from './flows-time';
export {
  IN_LINE_GAP_MS,
  decideInboxRules,
  inQuietHours,
  type InboxRuleDecision,
  type InboxRuleFacts,
} from './flows-inbox-rules';
export {
  alreadyReceived,
  heldNowInChannel,
  loadInboxRuleFacts,
  postTimesForMember,
  pruneFlowEmailLedger,
  saveInboxRules,
  takeLedgerSlot,
} from './flows-holds';
export {
  callWebhook,
  webhookSignature,
  webhookUrlProblem,
  WebhookError,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMEOUT_MS,
} from './flows-webhook';
export { abArm } from './flows-util';
export { channelAdminEmails, sendOperatorNotice } from './flows-notify';
