/**
 * Publishing a Flow (Phase 6): the same-Channel reference check, freezing one Flow Broadcast per
 * send_email node, the immutable flow_versions row and retiring the previous version. Used by
 * the API (POST /flows/:id/publish) and by Welcome A/B auto-promotion (flow-promote.ts).
 *
 * PUBLISH CONTRACT
 * - The draft must pass FlowGraphSchema (validateFlowGraph) and checkFlowReferences: every id
 *   it refers to belongs to the Flow's Channel, and each send_email dispatchId is a Dispatch of
 *   kind 'flow' owned by this Flow.
 * - Each send_email node's Dispatch passes the pre-send checklist (subject, content, links,
 *   sender and domain, Channel not paused; the audience and ramp checks do not apply) and is
 *   frozen with frozenBroadcastStatements: kind 'flow', status 'sending', flow_id set. The
 *   Broadcast's audience is "everyone"; the engine adds one recipient per run send.
 * - One batch: flow_versions (next version), the Broadcasts and link targets, flow_emails, the
 *   previous versions' retired_at, and flows.live_version / trigger_type / extra_trigger_types /
 *   status 'live'. A concurrent publish loses on the flow_versions primary key (FlowPublishError 'conflict').
 * - A Member who got a step's email from an earlier version doesn't get it from this one, unless
 *   the step is in `resendNodeIds` (flow_emails.resend; the engine's alreadyReceived).
 * - Runs stay on the version they enrolled on. A retired version's Flow Broadcasts are closed
 *   (status 'sent') by closeRetiredFlowBroadcasts once it has no open runs: right after publish
 *   here, and later by the engine's sweep for versions that still had runs.
 */
import { isUniqueViolation } from '@swarm/db';
import {
  FlowGraphSchema,
  collectReferencedIds,
  extraTriggerTypes,
  triggerOf,
  validateFlowGraph,
  type FlowGraph,
  type FlowGraphIssue,
  type FlowStatus,
} from '@swarm/domain';
import type { EngineConfig } from './config';
import { all, first, newIdFor } from './db';
import { FieldValueError, normalizeFieldValue } from './fields';
import { ensureRamp } from './ramp';
import { rostersEnabled } from './rosters';
import { frozenBroadcastStatements, preflight, type DispatchRow } from './start';

/** A flows row. */
export interface FlowTableRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  name: string;
  description: string | null;
  status: FlowStatus;
  recipe: string | null;
  draft_graph_json: string;
  /** Builder steps not set up yet (FlowDraftPending JSON); publishing refuses while any remain. */
  draft_pending_json: string | null;
  live_version: number | null;
  trigger_type: string | null;
  /** The live version's other start event types (JSON array); null when it has only the one. */
  extra_trigger_types: string | null;
  reentry: 'never' | 'after_exit';
  webhook_secret_enc: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export type FlowPublishErrorCode =
  | 'not_found'
  | 'wrong_status'
  | 'invalid_graph'
  | 'invalid_reference'
  | 'email_not_ready'
  | 'conflict';

export class FlowPublishError extends Error {
  constructor(
    readonly code: FlowPublishErrorCode,
    message: string,
    /** One entry per problem; `path` is `nodes.<nodeId>` when a node is at fault. */
    readonly details: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'FlowPublishError';
  }
}

export interface FlowReferenceProblem {
  /** The FlowReferencedIds kind, or 'emails' for a send_email Dispatch not owned by the Flow. */
  kind: string;
  id: string;
  message: string;
  /** Nodes that mention the id. */
  nodeIds: string[];
}

const KIND_LABEL: Record<string, string> = {
  circles: 'That segment is not in this publication.',
  tags: 'That tag is not in this publication.',
  levels: 'That paid plan is not in this publication.',
  dispatches: 'That post is not in this publication.',
  emails: 'That email is not one of this automation’s emails.',
  forms: 'That signup form is not in this publication.',
  flows: 'That automation is not in this publication.',
  self: 'An automation can’t enrol subscribers in itself.',
  fields: 'That profile field is not in this publication.',
  fieldKeys: 'That profile field is not in this publication.',
  asks: 'That poll or survey is not in this publication.',
  askOptions: 'That answer is not in this publication.',
  rosters: 'That Roster is not in this publication.',
  rostersOff: 'Rosters are turned off for this publication.',
  milestones: 'That milestone is not in this publication.',
  operators: 'That person is not on this workspace’s team.',
  value: 'The value does not fit the profile field.',
};

/** Ids from `ids` that the query (?2 = channel or workspace) does not return. */
async function missing(
  db: D1Database,
  ids: string[],
  existing: string,
  scope: string,
  extra: unknown[] = [],
): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await all<{ id: string }>(
    db,
    `SELECT value AS id FROM json_each(?1) WHERE value NOT IN (${existing})`,
    JSON.stringify(ids),
    scope,
    ...extra,
  );
  return rows.map((r) => r.id);
}

function nodesMentioning(graph: FlowGraph, id: string): string[] {
  return graph.nodes.filter((n) => JSON.stringify(n.config).includes(id)).map((n) => n.id);
}

/**
 * The same-Channel check for every id a graph refers to (the legacy "unchecked cross-tenant
 * segment ids" defect). Empty when the graph only uses this Channel's Circles, tags, levels,
 * forms, fields, Asks, Flows and this Flow's own emails. Also checks update_field values against
 * the field's type, and that enrol_flow never names the Flow itself.
 */
export async function checkFlowReferences(
  db: D1Database,
  flow: Pick<FlowTableRow, 'id' | 'channel_id' | 'workspace_id'>,
  graph: FlowGraph,
): Promise<FlowReferenceProblem[]> {
  const refs = collectReferencedIds(graph);
  const ch = flow.channel_id;
  const sendIds = [
    ...new Set(graph.nodes.flatMap((n) => (n.type === 'send_email' ? [n.config.dispatchId] : []))),
  ];
  const otherDispatches = refs.dispatches.filter((d) => !sendIds.includes(d));
  const flowIds = refs.flows.filter((f) => f !== flow.id);
  const found: { kind: string; ids: string[] }[] = [
    {
      kind: 'circles',
      ids: await missing(
        db,
        refs.circles,
        'SELECT id FROM circles WHERE channel_id = ?2 AND deleted_at IS NULL',
        ch,
      ),
    },
    {
      kind: 'tags',
      ids: await missing(db, refs.tags, 'SELECT id FROM tags WHERE channel_id = ?2', ch),
    },
    {
      kind: 'levels',
      ids: await missing(
        db,
        refs.levels,
        'SELECT id FROM membership_levels WHERE channel_id = ?2',
        ch,
      ),
    },
    {
      kind: 'emails',
      ids: await missing(
        db,
        sendIds,
        `SELECT id FROM dispatches WHERE channel_id = ?2 AND kind = 'flow' AND flow_id = ?3`,
        ch,
        [flow.id],
      ),
    },
    {
      kind: 'dispatches',
      ids: await missing(
        db,
        otherDispatches,
        `SELECT id FROM dispatches WHERE channel_id = ?2 AND kind = 'broadcast'`,
        ch,
      ),
    },
    {
      kind: 'forms',
      ids: await missing(
        db,
        refs.forms,
        'SELECT id FROM capture_forms WHERE channel_id = ?2 AND deleted_at IS NULL',
        ch,
      ),
    },
    {
      kind: 'flows',
      ids: await missing(
        db,
        flowIds,
        'SELECT id FROM flows WHERE channel_id = ?2 AND deleted_at IS NULL',
        ch,
      ),
    },
    { kind: 'self', ids: refs.flows.includes(flow.id) ? [flow.id] : [] },
    {
      kind: 'fields',
      ids: await missing(
        db,
        refs.fields,
        'SELECT id FROM member_fields WHERE channel_id = ?2 AND deleted_at IS NULL',
        ch,
      ),
    },
    {
      kind: 'fieldKeys',
      ids: await missing(
        db,
        refs.fieldKeys,
        'SELECT key FROM member_fields WHERE channel_id = ?2 AND deleted_at IS NULL',
        ch,
      ),
    },
    {
      kind: 'asks',
      ids: await missing(
        db,
        refs.asks,
        'SELECT id FROM asks WHERE channel_id = ?2 AND deleted_at IS NULL',
        ch,
      ),
    },
    {
      kind: 'askOptions',
      ids: await missing(
        db,
        refs.askOptions,
        'SELECT o.id FROM ask_options o JOIN asks a ON a.id = o.ask_id WHERE a.channel_id = ?2',
        ch,
      ),
    },
    {
      kind: 'rosters',
      ids: await missing(
        db,
        refs.rosters,
        'SELECT id FROM rosters WHERE channel_id = ?2 AND deleted_at IS NULL',
        ch,
      ),
    },
    {
      kind: 'milestones',
      ids: await missing(
        db,
        refs.milestones,
        'SELECT id FROM champion_milestones WHERE channel_id = ?2',
        ch,
      ),
    },
    // Roster triggers exist only while the rosters flag is on (checked on save and publish).
    {
      kind: 'rostersOff',
      ids: refs.rosters.length && !(await rostersEnabled(db, ch)) ? refs.rosters : [],
    },
    {
      kind: 'operators',
      ids: await missing(
        db,
        refs.operators,
        'SELECT operator_id FROM seats WHERE workspace_id = ?2',
        flow.workspace_id,
      ),
    },
  ];
  const problems: FlowReferenceProblem[] = found.flatMap(({ kind, ids }) =>
    ids.map((id) => ({
      kind,
      id,
      message: KIND_LABEL[kind] ?? 'That item is not in this publication.',
      nodeIds: nodesMentioning(graph, id),
    })),
  );

  // update_field values must fit the field (checked again by the engine at run time).
  const updates = graph.nodes.filter((n) => n.type === 'update_field');
  const badFields = new Set(problems.filter((p) => p.kind === 'fields').map((p) => p.id));
  for (const node of updates) {
    if (node.type !== 'update_field' || badFields.has(node.config.fieldId)) continue;
    const field = await first<{
      key: string;
      type: string;
      options_json: string;
      encrypted: number;
    }>(
      db,
      'SELECT key, type, options_json, encrypted FROM member_fields WHERE id = ?1 AND channel_id = ?2',
      node.config.fieldId,
      ch,
    );
    if (!field) continue;
    try {
      normalizeFieldValue(
        {
          key: field.key,
          type: field.type as Parameters<typeof normalizeFieldValue>[0]['type'],
          options: JSON.parse(field.options_json) as string[],
          encrypted: field.encrypted === 1,
        },
        node.config.value,
      );
    } catch (error) {
      if (!(error instanceof FieldValueError)) throw error;
      problems.push({
        kind: 'value',
        id: node.config.fieldId,
        message: error.message,
        nodeIds: [node.id],
      });
    }
  }
  return problems;
}

/** FlowReferenceProblem[] as error details. */
export const referenceDetails = (problems: FlowReferenceProblem[]) =>
  problems.flatMap((p) =>
    (p.nodeIds.length ? p.nodeIds : ['graph']).map((nodeId) => ({
      path: nodeId === 'graph' ? 'draftGraph' : `nodes.${nodeId}`,
      message: p.message,
    })),
  );

/** FlowGraphIssue[] as error details. */
export const issueDetails = (issues: FlowGraphIssue[]) =>
  issues.map((issue) => ({
    path: issue.nodeId ? `nodes.${issue.nodeId}` : 'draftGraph',
    message: issue.message,
  }));

export async function loadFlowRow(db: D1Database, flowId: string): Promise<FlowTableRow | null> {
  return first<FlowTableRow>(
    db,
    'SELECT * FROM flows WHERE id = ?1 AND deleted_at IS NULL',
    flowId,
  );
}

export interface PublishedFlowVersion {
  version: number;
  triggerType: string;
  emails: { nodeId: string; dispatchId: string; broadcastId: string }[];
  /** The versions retired by this publish. */
  retired: number[];
}

/** Statements that retire every unretired version of a Flow except `keep`. */
function retireStatements(db: D1Database, flowId: string, keep: number, now: number) {
  return db
    .prepare(
      'UPDATE flow_versions SET retired_at = ?1 WHERE flow_id = ?2 AND version <> ?3 AND retired_at IS NULL',
    )
    .bind(now, flowId, keep);
}

/**
 * Publishes the Flow's draft as a new version (see the contract above). `allowHtmlBlocks` is
 * the raw_html_mode flag for the Channel. Throws FlowPublishError.
 */
export async function publishFlowVersion(
  db: D1Database,
  config: EngineConfig,
  input: {
    flowId: string;
    operatorId: string | null;
    now?: number;
    allowHtmlBlocks: boolean;
    /** Email steps whose email may reach people who got it from an earlier version. */
    resendNodeIds?: readonly string[];
    /**
     * Called with the exact graph about to go live, before anything is written; it throws to
     * refuse. The API checks role-dependent steps here, so a draft saved meanwhile can't slip by.
     */
    authorize?: (graph: FlowGraph) => Promise<void>;
  },
): Promise<PublishedFlowVersion> {
  const now = input.now ?? Date.now();
  const flow = await loadFlowRow(db, input.flowId);
  if (!flow) throw new FlowPublishError('not_found', 'Automation not found.');
  if (flow.status === 'archived') {
    throw new FlowPublishError('wrong_status', 'An archived automation can’t be published.');
  }
  const pending = flow.draft_pending_json
    ? (JSON.parse(flow.draft_pending_json) as { nodes: { id: string }[] }).nodes
    : [];
  if (pending.length) {
    throw new FlowPublishError(
      'invalid_graph',
      'Finish setting up every step before publishing.',
      pending.map((n) => ({ path: `nodes.${n.id}`, message: 'Finish setting up this step.' })),
    );
  }
  const parsed = FlowGraphSchema.safeParse(JSON.parse(flow.draft_graph_json));
  if (!parsed.success) {
    const issues = (() => {
      try {
        return validateFlowGraph(JSON.parse(flow.draft_graph_json) as FlowGraph);
      } catch {
        return [];
      }
    })();
    throw new FlowPublishError(
      'invalid_graph',
      'Fix the problems in the automation before publishing.',
      issues.length
        ? issueDetails(issues)
        : parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  const graph = parsed.data;
  await input.authorize?.(graph);
  const problems = await checkFlowReferences(db, flow, graph);
  if (problems.length) {
    throw new FlowPublishError(
      'invalid_reference',
      'The automation refers to things outside this publication.',
      referenceDetails(problems),
    );
  }
  const trigger = triggerOf(graph);
  if (!trigger) throw new FlowPublishError('invalid_graph', 'An automation starts with a trigger.');
  const extras = extraTriggerTypes(graph);
  const extrasJson = extras ? JSON.stringify(extras) : null;

  // Every Flow email passes the same checklist as a Broadcast, minus audience and ramp.
  const sends = graph.nodes.flatMap((n) =>
    n.type === 'send_email' ? [{ nodeId: n.id, dispatchId: n.config.dispatchId }] : [],
  );
  const frozen: {
    nodeId: string;
    dispatchId: string;
    broadcastId: string;
    statements: D1PreparedStatement[];
  }[] = [];
  const notReady: { path: string; message: string }[] = [];
  const resend = new Set(input.resendNodeIds ?? []);
  const unknownResend = [...resend].filter((id) => !sends.some((s) => s.nodeId === id));
  if (unknownResend.length) {
    throw new FlowPublishError(
      'invalid_graph',
      'Only email steps of this automation can be resent.',
      unknownResend.map((id) => ({ path: `nodes.${id}`, message: 'This is not an email step.' })),
    );
  }
  for (const send of sends) {
    const dispatch = await first<DispatchRow>(
      db,
      'SELECT * FROM dispatches WHERE id = ?1',
      send.dispatchId,
    );
    if (!dispatch) {
      notReady.push({ path: `nodes.${send.nodeId}`, message: 'The email is missing.' });
      continue;
    }
    const check = await preflight(db, config, dispatch, {
      allowHtmlBlocks: input.allowHtmlBlocks,
      webUrl: null,
    });
    const failing = check.checks.filter((c) => !c.ok && c.key !== 'audience' && c.key !== 'ramp');
    if (failing.length || !check.template) {
      notReady.push(...failing.map((c) => ({ path: `nodes.${send.nodeId}`, message: c.message })));
      if (!failing.length) {
        notReady.push({ path: `nodes.${send.nodeId}`, message: 'The email does not render.' });
      }
      continue;
    }
    const ramp = await ensureRamp(db, check.channel.id, check.sender.sendingDomainId, now);
    const broadcastId = newIdFor('broadcast', now);
    frozen.push({
      ...send,
      broadcastId,
      statements: frozenBroadcastStatements(db, {
        broadcastId,
        dispatch,
        check: { ...check, template: check.template },
        rampId: ramp.id,
        operatorId: input.operatorId,
        now,
        status: 'sending',
        kind: 'flow',
        flowId: flow.id,
      }),
    });
  }
  if (notReady.length) {
    throw new FlowPublishError(
      'email_not_ready',
      'Some automation emails are not ready to send.',
      notReady,
    );
  }

  const latest = await first<{ v: number | null }>(
    db,
    'SELECT max(version) AS v FROM flow_versions WHERE flow_id = ?1',
    flow.id,
  );
  const version = (latest?.v ?? 0) + 1;
  const retiring = await all<{ version: number }>(
    db,
    'SELECT version FROM flow_versions WHERE flow_id = ?1 AND retired_at IS NULL',
    flow.id,
  );
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO flow_versions (flow_id, version, graph_json, trigger_type, extra_trigger_types,
             published_by, published_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        .bind(
          flow.id,
          version,
          JSON.stringify(graph),
          trigger.config.event,
          extrasJson,
          input.operatorId,
          now,
        ),
      ...frozen.flatMap((f) => [
        ...f.statements,
        db
          .prepare(
            `INSERT INTO flow_emails (flow_id, version, node_id, dispatch_id, broadcast_id, created_at, resend)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          )
          .bind(
            flow.id,
            version,
            f.nodeId,
            f.dispatchId,
            f.broadcastId,
            now,
            resend.has(f.nodeId) ? 1 : 0,
          ),
      ]),
      retireStatements(db, flow.id, version, now),
      db
        .prepare(
          `UPDATE flows SET live_version = ?1, trigger_type = ?2, extra_trigger_types = ?5,
                  status = 'live', updated_at = ?3
            WHERE id = ?4 AND status <> 'archived'`,
        )
        .bind(version, trigger.config.event, now, flow.id, extrasJson),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new FlowPublishError(
        'conflict',
        'The automation was published at the same time. Reload.',
      );
    }
    throw error;
  }
  await closeRetiredFlowBroadcasts(db, flow.id, now);
  return {
    version,
    triggerType: trigger.config.event,
    emails: frozen.map(({ nodeId, dispatchId, broadcastId }) => ({
      nodeId,
      dispatchId,
      broadcastId,
    })),
    retired: retiring.map((r) => r.version),
  };
}

/**
 * Closes the Flow Broadcasts (status 'sending' → 'sent') of retired versions that have no open
 * runs left, or of every version when the Flow is archived. Returns how many it closed. Safe to
 * call repeatedly; the engine's sweep calls it for versions that still had runs at publish.
 */
export async function closeRetiredFlowBroadcasts(
  db: D1Database,
  flowId: string,
  now: number,
): Promise<number> {
  const rows = await all<{ id: string }>(
    db,
    `UPDATE broadcasts SET status = 'sent', completed_at = ?2, last_progress_at = ?2
      WHERE kind = 'flow' AND status = 'sending' AND id IN (
        SELECT fe.broadcast_id FROM flow_emails fe
          JOIN flow_versions v ON v.flow_id = fe.flow_id AND v.version = fe.version
          JOIN flows f ON f.id = fe.flow_id
         WHERE fe.flow_id = ?1
           AND (f.status = 'archived' OR (v.retired_at IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM flow_runs r WHERE r.flow_id = fe.flow_id AND r.version = fe.version
                AND r.status IN ('running', 'waiting', 'paused')))))
     RETURNING id`,
    flowId,
    now,
  );
  return rows.length;
}
