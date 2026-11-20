/**
 * The Flows engine's run machinery: starting runs, executing one step, parking and resuming,
 * failures, the minute sweep and version migration. The lifecycle contract is documented in
 * flows.ts; enrolment from member events lives in flows-enrol.ts.
 *
 * Locks, in one place:
 * - flow_runs_one_open: one open real run per (Flow, Member); flow_runs_one_open_test: one open
 *   test run. A test run and a real run don't hold each other up.
 * - flow_run_steps (run, node, attempt): whoever inserts the 'pending' row executes the node.
 *   A parked delay or wait keeps its row 'pending' with result_json.until; resolving it (the
 *   timeout, the awaited event, the delay ending) is a conditional UPDATE from 'pending', so
 *   exactly one resolver moves the run on. A 'pending' row older than FLOW_STEP_STALE_MS (a
 *   crashed consumer) can be taken over.
 * - flow_runs.next_at: when the sweep should look at the run. A queued step carries a lease
 *   (now + FLOW_RUN_LEASE_MS), so a lost message is re-queued; the sweep claims due runs with a
 *   conditional UPDATE, so two sweeps never queue the same run twice.
 * - Moving a run to its next node is conditional on current_node_id, so a duplicate message
 *   can't queue the next node twice.
 *
 * What a step decides lives in flows-decide.ts, which only reads, so that Rehearse takes the same
 * decisions without doing any of this.
 */
import {
  FLOW_REENTRY_MAX_PER_HOUR,
  FLOW_STEP_MAX_ATTEMPTS,
  FlowGraphSchema,
  QUEUE_MAX_DELAY_SECONDS,
  collectReferencedIds,
  flowStepBackoffSeconds,
  nextNodeId,
  triggerOf,
  type FlowEdgeLabel,
  type FlowExitReason,
  type FlowGraph,
  type FlowNode,
  type FlowReferencedIds,
  type FlowRunContext,
  type FlowRunWait,
} from '@swarm/domain';
import { toFlowRun } from './api-shapes';
import { enqueueChannelCircleRefresh } from './circles';
import { grantCompChecked, revokeCompGrants } from './comp-grants';
import { all, first, newIdFor, run as exec } from './db';
import { tagRemovedEventStatement } from './events';
import { storedValue } from './fields';
import type { FlowRunRef, FlowRunRow, FlowStepMessage, FlowsEnv, StartFlowRunInput } from './flows';
import {
  DUE_SLACK_MS,
  PermanentStepError,
  SUPPRESSED_SQL,
  compNoteMarker,
  contextAfterSend,
  decideStep,
  enrolSkipped,
  entryGuardsSql,
  eventHappened,
  inboxRuleHold,
  isPermanentStepError,
  levelUnavailable,
  memberMatchesRule,
  memberZone,
  outcomeOfHold,
  outcomeWhenTimeIsUp,
  recheckBeforeSend,
  type FlowEmailRow,
  type FlowRow,
  type HeldEmail,
  type Outcome,
  type StepAction,
} from './flows-decide';
import {
  dropLedgerSlot,
  holdOutcome,
  recordHold,
  releaseHold,
  takeLedgerSlot,
} from './flows-holds';
import { IN_LINE_GAP_MS } from './flows-inbox-rules';
import { channelAdminEmails, operatorEmails, sendFlowNotice } from './flows-notify';
import { errorText, parseJson } from './flows-util';
import { callWebhook } from './flows-webhook';
import { chargeOutboundWait, outboundWaitDeferral } from './outbound-url';
import { jobQueue } from './jobs';
import { recordPlatformEvent } from './platform-events';
import { channelFields, fieldValueStatements, readFieldValues, tagStatements } from './members';
import { rampRetrySeconds, release, reserve, utcDay } from './ramp';
import { smartBlockConditions, smartBlockVisibility } from './smartblocks';
import { admittedSql } from './variants';

/** A queued step's lease: the sweep re-queues a 'running' run whose message got lost. */
export const FLOW_RUN_LEASE_MS = 15 * 60 * 1000;
/** A 'pending' step older than this belonged to a consumer that died; it can be taken over. */
export const FLOW_STEP_STALE_MS = 10 * 60 * 1000;
const SWEEP_BATCH = 200;
const OPEN = `('running', 'waiting', 'paused')`;
const ACTIVE = `('running', 'waiting')`;

export { memberMatchesRule, memberZone, recheckBeforeSend };

// ---- Graphs ----------------------------------------------------------------------------------

const graphCache = new Map<string, FlowGraph | null>();
const refsCache = new WeakMap<FlowGraph, FlowReferencedIds>();

/** A published version's graph (versions are immutable, so it is cached). Null when unusable. */
export async function loadVersionGraph(
  db: D1Database,
  flowId: string,
  version: number,
): Promise<FlowGraph | null> {
  const key = `${flowId}:${version}`;
  if (graphCache.has(key)) return graphCache.get(key) ?? null;
  const row = await first<{ graph_json: string }>(
    db,
    'SELECT graph_json FROM flow_versions WHERE flow_id = ?1 AND version = ?2',
    flowId,
    version,
  );
  if (!row) return null;
  const parsed = FlowGraphSchema.safeParse(parseJson<unknown>(row.graph_json, null));
  const graph = parsed.success ? parsed.data : null;
  if (graphCache.size > 500) graphCache.clear();
  graphCache.set(key, graph);
  return graph;
}

function referencedIds(graph: FlowGraph): FlowReferencedIds {
  let refs = refsCache.get(graph);
  if (!refs) {
    refs = collectReferencedIds(graph);
    refsCache.set(graph, refs);
  }
  return refs;
}

/**
 * The graph's referenced ids that don't belong to the Flow's Channel (operators: no seat in its
 * workspace), as "kind:id" counts. Ownership only: a soft-deleted form still belongs to the
 * Channel; nodes that need a live row (fields, Circle conditions, enrol_flow) check it themselves.
 */
export async function foreignReferences(
  db: D1Database,
  flow: Pick<FlowRow, 'channel_id' | 'workspace_id'>,
  graph: FlowGraph,
): Promise<string[]> {
  const refs = referencedIds(graph);
  // ?1 is the Channel (or, for operators, the workspace); ?2 the JSON list of ids.
  const list = 'SELECT value FROM json_each(?2)';
  const kinds = [
    ['circles', `SELECT count(*) FROM circles WHERE channel_id = ?1 AND id IN (${list})`],
    ['tags', `SELECT count(*) FROM tags WHERE channel_id = ?1 AND id IN (${list})`],
    ['levels', `SELECT count(*) FROM membership_levels WHERE channel_id = ?1 AND id IN (${list})`],
    ['dispatches', `SELECT count(*) FROM dispatches WHERE channel_id = ?1 AND id IN (${list})`],
    ['forms', `SELECT count(*) FROM capture_forms WHERE channel_id = ?1 AND id IN (${list})`],
    ['flows', `SELECT count(*) FROM flows WHERE channel_id = ?1 AND id IN (${list})`],
    ['fields', `SELECT count(*) FROM member_fields WHERE channel_id = ?1 AND id IN (${list})`],
    ['asks', `SELECT count(*) FROM asks WHERE channel_id = ?1 AND id IN (${list})`],
    [
      'askOptions',
      `SELECT count(*) FROM ask_options o JOIN asks a ON a.id = o.ask_id
        WHERE a.channel_id = ?1 AND o.id IN (${list})`,
    ],
    ['rosters', `SELECT count(*) FROM rosters WHERE channel_id = ?1 AND id IN (${list})`],
    [
      'milestones',
      `SELECT count(*) FROM champion_milestones WHERE channel_id = ?1 AND id IN (${list})`,
    ],
    [
      'operators',
      `SELECT count(DISTINCT operator_id) FROM seats WHERE workspace_id = ?1 AND operator_id IN (${list})`,
    ],
  ] as const;
  const wanted = kinds.filter(([kind]) => refs[kind].length > 0);
  if (!wanted.length) return [];
  // Each subquery gets its own two parameters (D1 wants every bound parameter used).
  const params: unknown[] = [];
  const parts = wanted.map(([kind, sql]) => {
    const base = params.length;
    params.push(
      kind === 'operators' ? flow.workspace_id : flow.channel_id,
      JSON.stringify(refs[kind]),
    );
    const numbered = sql.replace(/\?([12])\b/g, (_, n: string) => `?${base + Number(n)}`);
    return `(${numbered}) AS ${kind}`;
  });
  const row = await first<Record<string, number>>(db, `SELECT ${parts.join(', ')}`, ...params);
  return wanted.filter(([kind]) => (row?.[kind] ?? 0) !== refs[kind].length).map(([kind]) => kind);
}

async function loadFlow(
  db: D1Database,
  flowId: string,
): Promise<(FlowRow & { channel_deleted: number }) | null> {
  return first<FlowRow & { channel_deleted: number }>(
    db,
    `SELECT id, workspace_id, channel_id, name, status, live_version, reentry, webhook_secret_enc,
            deleted_at,
            NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = flows.channel_id
                         AND c.deleted_at IS NULL) AS channel_deleted
       FROM flows WHERE id = ?1`,
    flowId,
  );
}

// ---- Run transitions -------------------------------------------------------------------------

const stepMessage = (runId: string, nodeId: string, attempt: number) =>
  ({ type: 'flow_step', runId, nodeId, attempt }) as const;

/** Ends (or pauses) an open run. True when this call made the change. */
async function endRun(
  db: D1Database,
  run: FlowRunRow,
  status: 'exited' | 'paused' | 'completed',
  reason: FlowExitReason | null,
  now: number,
): Promise<boolean> {
  const result = await exec(
    db,
    `UPDATE flow_runs SET status = ?1, exit_reason = ?2, next_at = NULL, wait_json = NULL,
            ended_at = CASE WHEN ?1 = 'paused' THEN NULL ELSE ?3 END, updated_at = ?3
      WHERE id = ?4 AND status IN ${OPEN}`,
    status,
    reason,
    now,
    run.id,
  );
  return (result.meta.changes ?? 0) > 0;
}

/** Moves a run past `nodeId` along `label` (or completes it), queueing the next node. */
async function moveOn(
  env: FlowsEnv,
  run: FlowRunRow,
  graph: FlowGraph,
  nodeId: string,
  label: FlowEdgeLabel,
  now: number,
): Promise<void> {
  const next = nextNodeId(graph, nodeId, label);
  if (!next) {
    const completed = await first<
      FlowRunRow & { member_email: string | null; workspace_id: string }
    >(
      env.DB,
      `UPDATE flow_runs SET status = 'completed', next_at = NULL, wait_json = NULL, ended_at = ?1,
              updated_at = ?1
        WHERE id = ?2 AND current_node_id = ?3 AND status IN ${ACTIVE}
        RETURNING *, (SELECT email FROM members WHERE id = flow_runs.member_id) AS member_email,
                  (SELECT workspace_id FROM flows WHERE id = flow_runs.flow_id) AS workspace_id`,
      now,
      run.id,
      nodeId,
    );
    // Event Webhooks (Phase 7): flow.completed, for real runs only.
    if (completed && completed.test !== 1) {
      await recordPlatformEvent(
        env.DB,
        {
          type: 'flow.completed',
          workspaceId: completed.workspace_id,
          channelId: completed.channel_id,
          memberId: completed.member_id,
          payload: toFlowRun(completed),
        },
        now,
      );
    }
    return;
  }
  const moved = await exec(
    env.DB,
    `UPDATE flow_runs SET current_node_id = ?1, status = 'running', next_at = ?2, wait_json = NULL,
            updated_at = ?3
      WHERE id = ?4 AND current_node_id = ?5 AND status IN ${ACTIVE}`,
    next,
    now + FLOW_RUN_LEASE_MS,
    now,
    run.id,
    nodeId,
  );
  if (moved.meta.changes) await env.JOBS_QUEUE.send(stepMessage(run.id, next, 1));
}

/** Marks a pending step finished. False when it wasn't pending (someone else finished it). */
async function closeStep(
  db: D1Database,
  run: FlowRunRow,
  nodeId: string,
  attempt: number,
  status: 'done' | 'skipped' | 'failed',
  outcome: FlowEdgeLabel | null,
  result: unknown,
  error: string | null,
  now: number,
): Promise<boolean> {
  const updated = await exec(
    db,
    `UPDATE flow_run_steps SET status = ?1, outcome = ?2, result_json = ?3, error = ?4, finished_at = ?5
      WHERE run_id = ?6 AND node_id = ?7 AND attempt = ?8 AND status = 'pending'`,
    status,
    outcome,
    result === undefined ? null : JSON.stringify(result),
    error,
    now,
    run.id,
    nodeId,
    attempt,
  );
  return (updated.meta.changes ?? 0) > 0;
}

/**
 * Parks `run` until `delayMs` from now at the run's current node: status 'waiting' and next_at,
 * and when delayMs ≤ QUEUE_MAX_DELAY_SECONDS × 1000 also queues the 'flow_step' with
 * delaySeconds = ceil(delayMs / 1000). Longer waits rely on sweepFlows. `attempt` is the attempt
 * the resumed step runs as (default 1).
 */
export async function scheduleNext(
  env: FlowsEnv,
  run: FlowRunRow,
  delayMs: number,
  options: { attempt?: number; now?: number } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  const nodeId = run.current_node_id;
  if (!nodeId) return;
  const delay = Math.max(0, delayMs);
  const parked = await exec(
    env.DB,
    `UPDATE flow_runs SET status = 'waiting', next_at = ?1, updated_at = ?2
      WHERE id = ?3 AND current_node_id = ?4 AND status IN ${ACTIVE}`,
    now + delay,
    now,
    run.id,
    nodeId,
  );
  if (!parked.meta.changes) return;
  if (delay <= QUEUE_MAX_DELAY_SECONDS * 1000) {
    await env.JOBS_QUEUE.send(stepMessage(run.id, nodeId, options.attempt ?? 1), {
      delaySeconds: Math.ceil(delay / 1000),
    });
  }
}

// ---- Starting runs ---------------------------------------------------------------------------

/**
 * Starts a run: inserts flow_runs (status 'running', `version` pinned, current_node_id = the
 * version's trigger node, a lease in next_at) and queues { type: 'flow_step', runId, nodeId:
 * <trigger node>, attempt: 1 }. Returns the run id, or null when nothing was started: the Flow,
 * version or Member isn't in `channelId`, the Member already has an open run of the Flow
 * (flow_runs_one_open), re-entry is 'never' and they ran it before (test runs don't count and
 * aren't limited), they started FLOW_REENTRY_MAX_PER_HOUR runs of it in the last hour, a run
 * already exists for `triggerEventSeq`, or one started since `notStartedSince`. The Flow's status
 * is not checked here: enrolment only calls it for live Flows, the API for test runs.
 */
export async function startFlowRun(
  env: FlowsEnv,
  input: StartFlowRunInput,
): Promise<string | null> {
  const graph = input.graph ?? (await loadVersionGraph(env.DB, input.flowId, input.version));
  const trigger = graph ? triggerOf(graph) : undefined;
  if (!trigger) return null;
  const id = newIdFor('flowRun', input.now);
  const result = await env.DB.prepare(
    `INSERT INTO flow_runs (id, flow_id, version, channel_id, member_id, status, current_node_id,
       next_at, context_json, trigger_event_seq, test, started_at, updated_at)
     SELECT ?1, f.id, ?3, f.channel_id, m.id, 'running', ?5, ?6, ?7, ?8, ?9, ?10, ?10
       FROM flows f JOIN members m ON m.id = ?4 AND m.channel_id = f.channel_id
      WHERE f.id = ?2 AND f.channel_id = ?11 AND f.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM flow_versions v WHERE v.flow_id = f.id AND v.version = ?3)
        AND ${entryGuardsSql({ seq: '?8', test: '?9', since: '?12', cap: '?13', notStartedSince: '?14' })}
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      id,
      input.flowId,
      input.version,
      input.memberId,
      trigger.id,
      input.now + FLOW_RUN_LEASE_MS,
      JSON.stringify(input.context ?? {}),
      input.triggerEventSeq ?? null,
      input.test ? 1 : 0,
      input.now,
      input.channelId,
      input.now - 3_600_000,
      FLOW_REENTRY_MAX_PER_HOUR,
      input.notStartedSince ?? null,
    )
    .run();
  if (!result.meta.changes) return null;
  await env.JOBS_QUEUE.send(stepMessage(id, trigger.id, 1));
  return id;
}

// ---- Steps -----------------------------------------------------------------------------------

interface Step {
  env: FlowsEnv;
  db: D1Database;
  run: FlowRunRow;
  flow: FlowRow;
  graph: FlowGraph;
  node: FlowNode;
  attempt: number;
  now: number;
}

/** The run at this step, as the vault's flow-run principal names it. */
const runRef = (step: Step): FlowRunRef => ({
  runId: step.run.id,
  nodeId: step.node.id,
  channelId: step.run.channel_id,
});

type Claim =
  | { kind: 'fresh' }
  | { kind: 'busy' }
  | {
      kind: 'finished';
      status: string;
      outcome: FlowEdgeLabel | null;
      result: Record<string, unknown>;
    }
  | { kind: 'parked'; until: number; resultJson: string; result: Record<string, unknown> };

async function claimStep(step: Omit<Step, 'node'> & { nodeId: string }): Promise<Claim> {
  const { db, run, nodeId, attempt, now } = step;
  const inserted = await exec(
    db,
    `INSERT INTO flow_run_steps (run_id, node_id, attempt, flow_id, version, status, started_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6) ON CONFLICT DO NOTHING`,
    run.id,
    nodeId,
    attempt,
    run.flow_id,
    run.version,
    now,
  );
  if (inserted.meta.changes) return { kind: 'fresh' };
  const row = await first<{
    status: string;
    outcome: FlowEdgeLabel | null;
    result_json: string | null;
    started_at: number;
  }>(
    db,
    `SELECT status, outcome, result_json, started_at FROM flow_run_steps
      WHERE run_id = ?1 AND node_id = ?2 AND attempt = ?3`,
    run.id,
    nodeId,
    attempt,
  );
  if (!row) return { kind: 'busy' };
  const result = parseJson<Record<string, unknown>>(row.result_json, {});
  if (row.status !== 'pending') {
    return { kind: 'finished', status: row.status, outcome: row.outcome, result };
  }
  if (typeof result.until === 'number') {
    return { kind: 'parked', until: result.until, resultJson: row.result_json as string, result };
  }
  if (row.started_at < now - FLOW_STEP_STALE_MS) {
    const taken = await exec(
      db,
      `UPDATE flow_run_steps SET started_at = ?1
        WHERE run_id = ?2 AND node_id = ?3 AND attempt = ?4 AND status = 'pending' AND started_at = ?5`,
      now,
      run.id,
      nodeId,
      attempt,
      row.started_at,
    );
    if (taken.meta.changes) return { kind: 'fresh' };
  }
  return { kind: 'busy' };
}

async function finish(step: Step, outcome: Outcome): Promise<void> {
  const { env, db, run, node, attempt, now } = step;
  switch (outcome.kind) {
    case 'next':
      if (
        await closeStep(
          db,
          run,
          node.id,
          attempt,
          outcome.status ?? 'done',
          outcome.label,
          outcome.result,
          null,
          now,
        )
      ) {
        if (node.type === 'send_email') {
          await releaseHold(db, run.id, node.id, holdOutcome(outcome), now);
        }
        await moveOn(env, run, step.graph, node.id, outcome.label, now);
      }
      return;
    case 'exit':
      if (
        await closeStep(
          db,
          run,
          node.id,
          attempt,
          outcome.status ?? 'skipped',
          null,
          {
            ...(outcome.result as object | undefined),
            exit: outcome.reason,
          },
          null,
          now,
        )
      ) {
        if (node.type === 'send_email') {
          await releaseHold(db, run.id, node.id, holdOutcome(outcome), now);
        }
        await endRun(db, run, 'exited', outcome.reason, now);
      }
      return;
    case 'park': {
      await exec(
        db,
        `UPDATE flow_run_steps SET result_json = ?1
          WHERE run_id = ?2 AND node_id = ?3 AND attempt = ?4 AND status = 'pending'`,
        JSON.stringify(outcome.result),
        run.id,
        node.id,
        attempt,
      );
      if (outcome.wait) {
        await exec(
          db,
          `UPDATE flow_runs SET wait_json = ?1 WHERE id = ?2 AND current_node_id = ?3 AND status IN ${ACTIVE}`,
          JSON.stringify(outcome.wait),
          run.id,
          node.id,
        );
      }
      await scheduleNext(env, run, outcome.until - now, { attempt, now });
      // An awaited event that landed before wait_json was visible resolves the wait now
      // (opens and clicks update the Delivery in the same batch that appends the event).
      if (
        outcome.wait &&
        outcome.wait.broadcastId &&
        (await eventHappened(db, run.member_id, outcome.wait))
      ) {
        await resolveWait(env, run, outcome.wait, { already: true }, now);
      }
      return;
    }
  }
}

async function failStep(step: Step, error: unknown): Promise<void> {
  const { env, db, run, node, attempt, now } = step;
  const permanent = isPermanentStepError(error);
  await closeStep(db, run, node.id, attempt, 'failed', null, undefined, errorText(error), now);
  if (!permanent && attempt < FLOW_STEP_MAX_ATTEMPTS) {
    await scheduleNext(env, run, flowStepBackoffSeconds(attempt) * 1000, {
      attempt: attempt + 1,
      now,
    });
    return;
  }
  if (!(await endRun(db, run, 'paused', 'step_failed', now))) return;
  try {
    await sendFlowNotice(env, {
      to: await channelAdminEmails(db, run.channel_id),
      subject: `A run of “${step.flow.name}” was paused`,
      lines: [
        `A step of the automation “${step.flow.name}” failed ${attempt} time${attempt === 1 ? '' : 's'}, so the run was paused.`,
        `Step: ${node.name ?? node.id} (${node.type}). Run: ${run.id}.`,
        `Last error: ${errorText(error)}`,
        'Fix the problem, then resume the paused runs from the automation’s page.',
      ],
      category: 'flow_paused',
      tags: { flow: run.flow_id, channel: run.channel_id },
    });
  } catch {
    // The pause is recorded on the run; a lost notice must not undo it or retry the step.
  }
}

/**
 * Executes one 'flow_step' message (see the lifecycle in flows.ts). Errors from the node's
 * action are recorded on the step and retried by the engine itself; an error thrown from here
 * (the database) makes the queue retry the message, which is safe.
 */
export async function runStep(
  env: FlowsEnv,
  msg: FlowStepMessage,
  now: number = Date.now(),
): Promise<void> {
  const db = env.DB;
  const run = await first<FlowRunRow>(db, 'SELECT * FROM flow_runs WHERE id = ?1', msg.runId);
  if (!run || (run.status !== 'running' && run.status !== 'waiting')) return;
  if (run.current_node_id !== msg.nodeId) return;

  const flow = await loadFlow(db, run.flow_id);
  // A deleted Channel's runs take no further step of any kind (no email, webhook or change),
  // as an archived Flow's don't: its subscribers' data stops flowing while it can be restored.
  if (!flow || flow.deleted_at !== null || flow.status === 'archived' || flow.channel_deleted) {
    await endRun(db, run, 'exited', 'flow_archived', now);
    return;
  }
  if (flow.status === 'paused' && !run.test) {
    await endRun(db, run, 'paused', 'flow_paused', now);
    return;
  }
  if (run.status === 'waiting' && run.next_at !== null && run.next_at > now + DUE_SLACK_MS) {
    // Early (a duplicate or a re-delivered message): wait for the parked time.
    await scheduleNext(env, run, run.next_at - now, { attempt: msg.attempt, now });
    return;
  }

  const graph = await loadVersionGraph(db, run.flow_id, run.version);
  const node = graph?.nodes.find((n) => n.id === msg.nodeId);
  if (!graph || !node) {
    await endRun(db, run, 'exited', 'invalid_reference', now);
    return;
  }
  // Queue messages are not signed: an attempt the run has not reached yet (the latest step's, one
  // more after a failure, or 1) would start the node a second time beside the real attempt.
  const latest = await first<{ attempt: number; status: string }>(
    db,
    `SELECT attempt, status FROM flow_run_steps WHERE run_id = ?1 AND node_id = ?2
      ORDER BY attempt DESC LIMIT 1`,
    run.id,
    node.id,
  );
  const expected = latest ? latest.attempt + (latest.status === 'failed' ? 1 : 0) : 1;
  if (msg.attempt > expected) return;
  const step: Step = { env, db, run, flow, graph, node, attempt: msg.attempt, now };

  const claim = await claimStep({ ...step, nodeId: node.id });
  switch (claim.kind) {
    case 'busy':
      return;
    case 'finished':
      // A consumer died between finishing the step and moving the run: finish the move.
      if (claim.status === 'done' || claim.status === 'skipped') {
        const exit = claim.result.exit as FlowExitReason | undefined;
        if (node.type === 'send_email') {
          const ended = exit
            ? ({ kind: 'exit', reason: exit } as const)
            : ({ kind: 'next', status: claim.status } as const);
          await releaseHold(db, run.id, node.id, holdOutcome(ended), now);
        }
        if (exit) await endRun(db, run, 'exited', exit, now);
        else if (claim.outcome) await moveOn(env, run, graph, node.id, claim.outcome, now);
      }
      return;
    case 'parked': {
      if (claim.until > now + DUE_SLACK_MS) {
        await scheduleNext(env, run, claim.until - now, { attempt: msg.attempt, now });
        return;
      }
      const whenUp = outcomeWhenTimeIsUp(node);
      if (whenUp) {
        return finish(step, {
          kind: 'next',
          label: whenUp,
          result:
            node.type === 'wait_for_event' ? { ...claim.result, timedOut: true } : claim.result,
        });
      }
      // Deferred (the Reputation Ramp was full, an inbox rule held it, the Channel was paused):
      // run the action again, which checks the Member again first.
      const retaken = await exec(
        db,
        `UPDATE flow_run_steps SET result_json = NULL, started_at = ?1
          WHERE run_id = ?2 AND node_id = ?3 AND attempt = ?4 AND status = 'pending' AND result_json = ?5`,
        now,
        run.id,
        node.id,
        msg.attempt,
        claim.resultJson,
      );
      if (!retaken.meta.changes) return;
      break;
    }
    case 'fresh':
      break;
  }

  await exec(
    db,
    `UPDATE flow_runs SET status = 'running', next_at = ?1, updated_at = ?2
      WHERE id = ?3 AND status IN ${ACTIVE}`,
    now + FLOW_RUN_LEASE_MS,
    now,
    run.id,
  );

  const foreign = await foreignReferences(db, flow, graph);
  if (foreign.length) {
    await finish(step, { kind: 'exit', reason: 'invalid_reference', result: { foreign } });
    return;
  }

  let outcome: Outcome;
  try {
    outcome = await execute(step);
  } catch (error) {
    await failStep(step, error);
    return;
  }
  await finish(step, outcome);
}

// ---- Node actions ----------------------------------------------------------------------------

/** Asks flows-decide.ts what the step does, then does it. Only here does anything get written. */
async function execute(step: Step): Promise<Outcome> {
  const decision = await decideStep({
    db: step.db,
    run: step.run,
    flow: step.flow,
    graph: step.graph,
    node: step.node,
    now: step.now,
    hasFieldKeys: !!step.env.vault,
  });
  switch (decision.kind) {
    case 'outcome':
      return decision.outcome;
    case 'hold':
      return applyHold(step, decision.hold);
    case 'act':
      return perform(step, decision.action);
  }
}

async function perform(step: Step, action: StepAction): Promise<Outcome> {
  const next: Outcome = { kind: 'next', label: 'default' };
  switch (action.type) {
    case 'send':
      return sendEmail(step, action);
    case 'requeue_send': {
      // This run's earlier attempt added the row but the hand-off to the send queue failed.
      const { broadcastId, context } = action;
      await step.env.SEND_QUEUE.send({
        type: 'batch',
        broadcastId,
        memberIds: [step.run.member_id],
      });
      await writeContext(step.db, step.run, contextAfterSend(context, step.node.id, broadcastId));
      return { kind: 'next', label: 'default', result: { broadcastId, requeued: true } };
    }
    case 'add_tag':
      await step.db.batch(tagStatements(step.db, step.run.member_id, [action.tagId], step.now));
      await refreshCircles(step);
      return next;
    case 'remove_tag':
      await step.db.batch([
        tagRemovedEventStatement(step.db, step.run.member_id, [action.tagId], 'only', step.now),
        step.db
          .prepare('DELETE FROM member_tags WHERE member_id = ?1 AND tag_id = ?2')
          .bind(step.run.member_id, action.tagId),
      ]);
      await refreshCircles(step);
      return next;
    case 'update_field': {
      const { field, value } = action;
      const vault = step.env.vault;
      const sealed =
        field.encrypted && value !== null && vault
          ? await vault.sealFields(runRef(step), step.run.member_id, { [field.key]: value })
          : {};
      const stored = storedValue(field, value, sealed[field.key]);
      await step.db.batch(
        fieldValueStatements(step.db, step.run.member_id, [{ field, value, stored }], step.now),
      );
      await refreshCircles(step);
      return next;
    }
    case 'revoke_level': {
      const revoked = await revokeCompGrants(
        step.db,
        {
          channelId: step.run.channel_id,
          memberId: step.run.member_id,
          levelId: action.levelId,
          noteMarker: compNoteMarker(step.run.flow_id),
        },
        step.now,
      );
      return { kind: 'next', label: 'default', result: { revoked } };
    }
    case 'grant_level': {
      const grantId = await grantCompChecked(
        step.db,
        {
          channelId: step.run.channel_id,
          memberId: step.run.member_id,
          levelId: action.levelId,
          expiresAt: action.days === null ? null : step.now + action.days * 86_400_000,
          note: action.note,
          grantedBy: null,
        },
        step.now,
      );
      return grantId ? { kind: 'next', label: 'default', result: { grantId } } : levelUnavailable;
    }
    case 'enrol':
      return enrolFlow(step, action.target);
    case 'webhook':
      return webhook(step, action);
    case 'notify':
      return notifyAuthor(step);
  }
}

async function refreshCircles(step: Step): Promise<void> {
  await enqueueChannelCircleRefresh(step.db, jobQueue(step.env.JOBS_QUEUE), step.run.channel_id, {
    now: step.now,
  });
}

async function writeContext(db: D1Database, run: FlowRunRow, context: FlowRunContext) {
  await exec(
    db,
    'UPDATE flow_runs SET context_json = ?1 WHERE id = ?2',
    JSON.stringify(context),
    run.id,
  );
}

/**
 * A test run's own copy of a Flow email. A Member holds one recipient row per Broadcast, so a test
 * sent from the real Flow Broadcast would use up their real email and land in its numbers. The copy
 * is frozen from the same row and has its own links; flow_emails doesn't know it, so stats, winner
 * picking and the repeat-send check never see it. Safe to repeat: one copy per run and email.
 */
async function testCopyOf(step: Step, email: FlowEmailRow): Promise<string> {
  const { db, run, now } = step;
  const find = () =>
    first<{ id: string }>(
      db,
      'SELECT id FROM broadcasts WHERE test_run_id = ?1 AND dispatch_id = ?2',
      run.id,
      email.dispatch_id,
    );
  const existing = await find();
  if (existing) return existing.id;
  const id = newIdFor('broadcast', now);
  const links = await all<{ url: string; position: number }>(
    db,
    'SELECT url, position FROM link_targets WHERE broadcast_id = ?1 ORDER BY position',
    email.id,
  );
  await db.batch([
    db
      .prepare(
        `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
           from_name, from_address, reply_to, sending_domain_id, ramp_id, track_opens, snapshot_done,
           fanout_done, created_at, last_progress_at, audience_json, teaser_html, teaser_text,
           gate_level_ids_json, kind, flow_id, test_run_id, track_clicks)
         SELECT ?1, dispatch_id, channel_id, workspace_id, 'sending', subject, preheader, html, text,
           from_name, from_address, reply_to, sending_domain_id, ramp_id, track_opens, 1, 1, ?3, ?3,
           audience_json, teaser_html, teaser_text, gate_level_ids_json, 'flow', flow_id, ?4, track_clicks
           FROM broadcasts WHERE id = ?2
         ON CONFLICT DO NOTHING`,
      )
      .bind(id, email.id, now, run.id),
    ...links.map((link) =>
      db
        .prepare(
          `INSERT INTO link_targets (id, broadcast_id, url, position)
           SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM broadcasts WHERE id = ?2)`,
        )
        .bind(newIdFor('linkTarget', now), id, link.url, link.position),
    ),
  ]);
  return (await find())?.id ?? id;
}

/** Everything decideStep let through: the writes and the hand-off to the send queue. */
async function sendEmail(
  step: Step,
  action: Extract<StepAction, { type: 'send' }>,
): Promise<Outcome> {
  const { env, db, run, now, node } = step;
  const { email, context, rules, sendRegardless } = action;
  const audience = node.type === 'send_email' ? node.config.audience : 'any';

  let reserved = false;
  if (email.ramp_id) {
    const reservation = await reserve(db, email.ramp_id, 1, now);
    if (reservation.granted === 0) {
      const delay = rampRetrySeconds(reservation.ramp, now);
      return {
        kind: 'park',
        until: now + delay * 1000,
        result: { until: now + delay * 1000, deferred: 'ramp' },
      };
    }
    reserved = true;
  }
  if (
    !run.test &&
    !(await takeLedgerSlot(db, { run, broadcastId: email.id, rules, sendRegardless, now }))
  ) {
    // Another run of this Member took the last place since the decision above.
    if (reserved && email.ramp_id) await release(db, email.ramp_id, 1);
    const hold = await inboxRuleHold(db, { run, nodeId: node.id, rules, sendRegardless, now });
    return hold ? applyHold(step, hold) : inLineHold(step, now + IN_LINE_GAP_MS);
  }

  const broadcastId = run.test ? await testCopyOf(step, email) : email.id;
  // The snapshot's predicate: active and not suppressed in the workspace (and, for a gated paid
  // Dispatch, full or teaser decided now, once).
  const variant = email.has_teaser
    ? `CASE WHEN ${admittedSql(5, 6)} THEN 'full' ELSE 'teaser' END`
    : `'full'`;
  // reserved_on: the day whose warm-up capacity this recipient holds, given back if it is skipped.
  const inserted = await db
    .prepare(
      `INSERT INTO broadcast_recipients (broadcast_id, member_id, email, first_name, last_name, variant, reserved_on)
       SELECT ?1, m.id, m.email, m.first_name, m.last_name, ${variant}, ?4
         FROM members m JOIN channels c ON c.id = m.channel_id
        WHERE m.id = ?2 AND m.channel_id = ?3 AND m.status = 'active' AND m.emails_off_at IS NULL
          AND NOT ${SUPPRESSED_SQL}
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      broadcastId,
      run.member_id,
      run.channel_id,
      reserved ? utcDay(now) : null,
      ...(email.has_teaser ? [now, email.gate_level_ids_json ?? '[]'] : []),
    )
    .run();
  if (!inserted.meta.changes) {
    if (reserved && email.ramp_id) await release(db, email.ramp_id, 1);
    if (!run.test) await dropLedgerSlot(db, run.member_id, email.id);
    const again = await recheckBeforeSend(db, run, audience, now);
    if (!again.ok) return { kind: 'exit', reason: again.reason };
    return {
      kind: 'next',
      label: 'default',
      status: 'skipped',
      result: { broadcastId, skipped: 'already_sent' },
    };
  }
  // Smart Blocks: which blocks this Member sees, decided once like the snapshot does.
  const source = await first<{ content_json: string }>(
    db,
    'SELECT content_json FROM dispatches WHERE id = ?1',
    email.dispatch_id,
  );
  const content = parseJson<unknown>(source?.content_json ?? null, null);
  if (content && smartBlockConditions(content).length > 0) {
    const visible = await smartBlockVisibility(db, run.channel_id, run.member_id, content, now);
    await exec(
      db,
      'UPDATE broadcast_recipients SET smart_blocks_json = ?1 WHERE broadcast_id = ?2 AND member_id = ?3',
      JSON.stringify(visible),
      broadcastId,
      run.member_id,
    );
  }
  await exec(
    db,
    'UPDATE broadcasts SET recipient_count = recipient_count + 1, last_progress_at = ?1 WHERE id = ?2',
    now,
    broadcastId,
  );
  await writeContext(db, run, contextAfterSend(context, node.id, broadcastId));
  await env.SEND_QUEUE.send({ type: 'batch', broadcastId, memberIds: [run.member_id] });
  return { kind: 'next', label: 'default', result: { broadcastId } };
}

/** Records the hold decideStep found, and what it means for the step. */
async function applyHold(step: Step, hold: HeldEmail): Promise<Outcome> {
  const { db, run, node, now } = step;
  await recordHold(db, {
    run,
    nodeId: node.id,
    reason: hold.decision.reason,
    until: hold.decision.until,
    zone: hold.zone,
    now,
  });
  return outcomeOfHold(hold);
}

/** Parks a send that lost the last place in the limit to a run deciding at the same moment. */
async function inLineHold(step: Step, until: number): Promise<Outcome> {
  const { db, run, node, now } = step;
  await recordHold(db, {
    run,
    nodeId: node.id,
    reason: 'in_line',
    until,
    zone: await memberZone(db, run),
    now,
  });
  return { kind: 'park', until, result: { until, deferred: 'inbox_rules', reason: 'in_line' } };
}

async function enrolFlow(step: Step, target: FlowRow): Promise<Outcome> {
  const { env, run, node, now } = step;
  const runId = await startFlowRun(env, {
    flowId: target.id,
    version: target.live_version as number,
    memberId: run.member_id,
    channelId: run.channel_id,
    test: run.test === 1,
    context: { enrolledBy: { flowId: run.flow_id, runId: run.id, nodeId: node.id } },
    now,
  });
  return runId
    ? { kind: 'next', label: 'default', result: { enrolled: true, runId } }
    : enrolSkipped('not_eligible');
}

/**
 * Resolves a parked wait_for_event with its 'default' outcome (the event happened). The
 * pending step is the lock against the timeout: only one of them moves the run on.
 */
export async function resolveWait(
  env: FlowsEnv,
  run: FlowRunRow,
  wait: FlowRunWait,
  result: Record<string, unknown>,
  now: number,
): Promise<boolean> {
  const db = env.DB;
  const pending = await first<{ attempt: number; result_json: string | null }>(
    db,
    `SELECT attempt, result_json FROM flow_run_steps
      WHERE run_id = ?1 AND node_id = ?2 AND status = 'pending' ORDER BY attempt DESC LIMIT 1`,
    run.id,
    wait.node,
  );
  if (!pending) return false;
  const graph = await loadVersionGraph(db, run.flow_id, run.version);
  if (!graph) return false;
  const closed = await closeStep(
    db,
    run,
    wait.node,
    pending.attempt,
    'done',
    'default',
    { ...parseJson<Record<string, unknown>>(pending.result_json, {}), ...result },
    null,
    now,
  );
  if (!closed) return false;
  await moveOn(env, run, graph, wait.node, 'default', now);
  return true;
}

async function webhook(
  step: Step,
  action: Extract<StepAction, { type: 'webhook' }>,
): Promise<Outcome> {
  const { env, db, run, flow, node, now } = step;
  if (node.type !== 'webhook_call') throw new Error('not a webhook step');
  const vault = env.vault;
  if (!flow.webhook_secret_enc || !vault) {
    throw new PermanentStepError('This automation has no webhook secret.');
  }
  const ref = runRef(step);
  const { member } = action;
  let fields: Record<string, unknown> | undefined;
  if (node.config.includeFields) {
    const defs = await channelFields(db, run.channel_id);
    const open = {
      open: async (ids: string[]) => vault.openFields(ref, ids),
    };
    fields = (await readFieldValues(db, [member.id], defs, open)).get(member.id) ?? {};
  }
  // Over the workspace's share of waiting on its own endpoints this minute: the step waits for
  // the next minute instead of holding the jobs consumer other tenants' work runs on.
  const deferUntil = await outboundWaitDeferral(db, flow.workspace_id, now);
  if (deferUntil !== null) {
    return {
      kind: 'park',
      until: deferUntil,
      result: { until: deferUntil, deferred: 'outbound_share' },
    };
  }
  const fetcher: typeof fetch = env.fetch ? env.fetch : (input, init) => fetch(input, init);
  const started = Date.now();
  const { status } = await callWebhook(fetcher, {
    url: node.config.url,
    sign: async (timestamp, body) => {
      const signature = await vault.signWebhook(ref, timestamp, body);
      if (!signature) {
        throw new PermanentStepError('The automation’s webhook secret could not be opened.');
      }
      return signature;
    },
    id: `${run.id}:${node.id}`,
    payload: {
      flowId: run.flow_id,
      runId: run.id,
      nodeId: node.id,
      member: {
        id: member.id,
        email: member.email,
        firstName: member.first_name,
        lastName: member.last_name,
        ...(fields ? { fields } : {}),
      },
    },
    now,
  }).finally(() => chargeOutboundWait(db, flow.workspace_id, Date.now() - started, now));
  return { kind: 'next', label: 'default', result: { status } };
}

async function notifyAuthor(step: Step): Promise<Outcome> {
  const { env, db, run, flow, node } = step;
  if (node.type !== 'notify_author') throw new Error('not a notify step');
  const to = node.config.operatorIds?.length
    ? await operatorEmails(db, run.channel_id, node.config.operatorIds)
    : await channelAdminEmails(db, run.channel_id);
  const member = await first<{ email: string }>(
    db,
    'SELECT email FROM members WHERE id = ?1',
    run.member_id,
  );
  const notified = await sendFlowNotice(env, {
    to,
    subject: `${flow.name}: ${node.config.message.slice(0, 80)}`,
    lines: [
      node.config.message,
      `Subscriber: ${member?.email ?? run.member_id}. Automation: ${flow.name}${run.test ? ' (test run)' : ''}.`,
    ],
    category: 'flow_notify',
    tags: { flow: run.flow_id, channel: run.channel_id },
  });
  return { kind: 'next', label: 'default', result: { notified } };
}

// ---- The minute sweep ------------------------------------------------------------------------

/**
 * Every-minute cron hook (jobs worker): kicks event draining when events are waiting, claims
 * due runs (next_at ≤ now: delays ending, wait timeouts, retry backoffs, expired leases of lost
 * messages) with one conditional UPDATE and queues their current node, and closes Flow
 * Broadcasts whose version can no longer send.
 */
export async function sweepFlows(env: FlowsEnv, now: number): Promise<void> {
  const db = env.DB;
  if (await first(db, 'SELECT 1 AS ok FROM member_events WHERE processed_at IS NULL LIMIT 1')) {
    await env.JOBS_QUEUE.send({ type: 'flow_events' });
  }
  const claimed = await all<{ id: string }>(
    db,
    `UPDATE flow_runs SET status = 'running', next_at = ?2, updated_at = ?1
      WHERE id IN (SELECT id FROM flow_runs WHERE status IN ${ACTIVE} AND next_at <= ?1
                    ORDER BY next_at LIMIT ?3)
        AND status IN ${ACTIVE} AND next_at <= ?1
      RETURNING id`,
    now,
    now + FLOW_RUN_LEASE_MS,
    SWEEP_BATCH,
  );
  if (claimed.length) {
    const due = await all<{ id: string; node: string | null; attempt: number | null }>(
      db,
      `SELECT r.id, r.current_node_id AS node,
              (SELECT CASE WHEN s.status = 'failed' THEN s.attempt + 1 ELSE s.attempt END
                 FROM flow_run_steps s WHERE s.run_id = r.id AND s.node_id = r.current_node_id
                ORDER BY s.attempt DESC LIMIT 1) AS attempt
         FROM flow_runs r WHERE r.id IN (SELECT value FROM json_each(?1))`,
      JSON.stringify(claimed.map((c) => c.id)),
    );
    for (const run of due) {
      if (run.node) await env.JOBS_QUEUE.send(stepMessage(run.id, run.node, run.attempt ?? 1));
    }
  }
  await closeFinishedFlowBroadcasts(db, now);
}

/**
 * Runs one Channel's due steps (next_at ≤ now) right here, as of `now`, instead of queueing
 * them. Only the jobs worker's development time-advance endpoint calls this (end-to-end tests
 * use it to end a delay without waiting for it); the cron always goes through sweepFlows and the
 * real clock. What a step queues next runs on the queue as usual. Returns how many steps ran.
 */
export async function runDueFlowSteps(
  env: FlowsEnv,
  channelId: string,
  now: number,
): Promise<number> {
  const due = await all<{ id: string; node: string; attempt: number | null }>(
    env.DB,
    `SELECT r.id, r.current_node_id AS node,
            (SELECT CASE WHEN s.status = 'failed' THEN s.attempt + 1 ELSE s.attempt END
               FROM flow_run_steps s WHERE s.run_id = r.id AND s.node_id = r.current_node_id
              ORDER BY s.attempt DESC LIMIT 1) AS attempt
       FROM flow_runs r
      WHERE r.channel_id = ?1 AND r.status IN ${ACTIVE} AND r.next_at <= ?2
        AND r.current_node_id IS NOT NULL
      ORDER BY r.next_at LIMIT ?3`,
    channelId,
    now,
    SWEEP_BATCH,
  );
  for (const run of due) await runStep(env, stepMessage(run.id, run.node, run.attempt ?? 1), now);
  return due.length;
}

/**
 * Flow Broadcasts stay 'sending' while their version can send. Once a version is retired (or the
 * Flow archived or deleted), no run is open on it and no recipient is still in flight, its Flow
 * Broadcasts are marked 'sent'. Returns how many were closed. (Same name and semantics as the
 * publish module's helper on the API branch; one of the two goes at merge.)
 */
async function closeRetiredFlowBroadcasts(
  db: D1Database,
  flowId: string,
  now: number,
): Promise<number> {
  const result = await exec(
    db,
    `UPDATE broadcasts SET status = 'sent', completed_at = ?2, last_progress_at = ?2
      WHERE id IN (
        SELECT b.id FROM flow_emails fe
          JOIN broadcasts b ON b.id = fe.broadcast_id
          JOIN flow_versions v ON v.flow_id = fe.flow_id AND v.version = fe.version
          JOIN flows f ON f.id = fe.flow_id
         WHERE fe.flow_id = ?1 AND b.kind = 'flow' AND b.status IN ('queued', 'sending')
           AND (v.retired_at IS NOT NULL OR f.status = 'archived' OR f.deleted_at IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM flow_runs r WHERE r.flow_id = fe.flow_id AND r.version = fe.version
                             AND r.status IN ${OPEN})
           AND NOT EXISTS (SELECT 1 FROM broadcast_recipients br WHERE br.broadcast_id = b.id
                             AND br.status IN ('pending', 'sending')))`,
    flowId,
    now,
  );
  return result.meta.changes ?? 0;
}

/** The sweep's bounded pass over Flows that may have Flow Broadcasts to close. */
async function closeFinishedFlowBroadcasts(db: D1Database, now: number): Promise<void> {
  const flows = await all<{ flow_id: string }>(
    db,
    `SELECT DISTINCT fe.flow_id FROM flow_emails fe
       JOIN broadcasts b ON b.id = fe.broadcast_id
       JOIN flow_versions v ON v.flow_id = fe.flow_id AND v.version = fe.version
       JOIN flows f ON f.id = fe.flow_id
      WHERE b.kind = 'flow' AND b.status IN ('queued', 'sending')
        AND (v.retired_at IS NOT NULL OR f.status = 'archived' OR f.deleted_at IS NOT NULL)
      LIMIT 20`,
  );
  for (const { flow_id } of flows) await closeRetiredFlowBroadcasts(db, flow_id, now);
  // A test run's copies of its emails close once the run has ended and nothing is in flight. A
  // copy whose run is gone (test_run_id cleared with the Member) closes the same way.
  await exec(
    db,
    `UPDATE broadcasts SET status = 'sent', completed_at = ?1, last_progress_at = ?1
      WHERE id IN (
        SELECT b.id FROM broadcasts b
         WHERE b.kind = 'flow' AND b.status IN ('queued', 'sending')
           AND NOT EXISTS (SELECT 1 FROM flow_emails fe WHERE fe.broadcast_id = b.id)
           AND NOT EXISTS (SELECT 1 FROM flow_runs r WHERE r.id = b.test_run_id AND r.status IN ${OPEN})
           AND NOT EXISTS (SELECT 1 FROM broadcast_recipients br WHERE br.broadcast_id = b.id
                             AND br.status IN ('pending', 'sending'))
         LIMIT 20)`,
    now,
  );
}

// ---- Operator actions ------------------------------------------------------------------------

/**
 * Moves the open runs of `fromVersion` to `toVersion` (the operator chose to migrate on publish).
 * A run moves when its current node id exists in the new version with the same type; it then
 * continues there (its pending delay or wait carries over). Every other open run exits with
 * 'migrated'. Returns the counts.
 */
export async function migrateRuns(
  env: FlowsEnv,
  flowId: string,
  fromVersion: number,
  toVersion: number,
  now: number = Date.now(),
): Promise<{ moved: number; exited: number }> {
  const db = env.DB;
  const [from, to] = await Promise.all([
    loadVersionGraph(db, flowId, fromVersion),
    loadVersionGraph(db, flowId, toVersion),
  ]);
  if (!to) throw new Error(`Flow ${flowId} has no version ${toVersion}.`);
  if (fromVersion === toVersion) return { moved: 0, exited: 0 };
  const oldTypes = new Map((from?.nodes ?? []).map((n) => [n.id, n.type]));
  const keep = to.nodes.filter((n) => oldTypes.get(n.id) === n.type).map((n) => n.id);
  const results = await db.batch([
    db
      .prepare(
        `UPDATE flow_runs SET version = ?3, updated_at = ?4
          WHERE flow_id = ?1 AND version = ?2 AND status IN ${OPEN}
            AND current_node_id IN (SELECT value FROM json_each(?5))`,
      )
      .bind(flowId, fromVersion, toVersion, now, JSON.stringify(keep)),
    // The moved runs' parked steps (delays, waits) now belong to the new version.
    db
      .prepare(
        `UPDATE flow_run_steps SET version = ?3
          WHERE flow_id = ?1 AND version = ?2 AND status = 'pending'
            AND run_id IN (SELECT id FROM flow_runs WHERE flow_id = ?1 AND version = ?3 AND status IN ${OPEN})`,
      )
      .bind(flowId, fromVersion, toVersion),
    // Their holds too, so the stats count a waiting email on the version it will send from.
    db
      .prepare(
        `UPDATE flow_holds SET version = ?3
          WHERE flow_id = ?1 AND version = ?2 AND released_at IS NULL
            AND run_id IN (SELECT id FROM flow_runs WHERE flow_id = ?1 AND version = ?3 AND status IN ${OPEN})`,
      )
      .bind(flowId, fromVersion, toVersion),
    db
      .prepare(
        `UPDATE flow_runs SET status = 'exited', exit_reason = 'migrated', next_at = NULL, wait_json = NULL,
                ended_at = ?3, updated_at = ?3
          WHERE flow_id = ?1 AND version = ?2 AND status IN ${OPEN}`,
      )
      .bind(flowId, fromVersion, now),
  ]);
  return { moved: results[0]?.meta.changes ?? 0, exited: results[3]?.meta.changes ?? 0 };
}

/**
 * Restarts a Flow's paused runs (paused with the Flow, or after a step failed): they become due
 * now and the next minute sweep queues them; a failed step gets one more attempt. Returns how
 * many were resumed.
 */
export async function resumeFlowRuns(
  env: FlowsEnv,
  flowId: string,
  now: number = Date.now(),
): Promise<number> {
  const result = await exec(
    env.DB,
    `UPDATE flow_runs SET status = 'waiting', exit_reason = NULL, next_at = ?2, updated_at = ?2
      WHERE flow_id = ?1 AND status = 'paused' AND exit_reason IN ('flow_paused', 'step_failed')`,
    flowId,
    now,
  );
  return result.meta.changes ?? 0;
}
