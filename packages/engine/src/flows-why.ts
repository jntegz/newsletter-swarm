/**
 * Why (the Member's page): every live Flow of the Member's Channel, with the Member's latest run
 * and the latest start event that didn't let them in. Reads flow_runs, deliveries, the run's
 * version graph and flow_enrol_decisions; writes nothing. One query for each, however many Flows.
 */
import { toIso } from '@swarm/db';
import {
  type FlowEnrolDecision,
  type FlowExitReason,
  type FlowGraph,
  type FlowRunContext,
  type FlowRunStatus,
  type FlowTriggerType,
  type MemberFlowHistory,
} from '@swarm/domain';
import { toFlowRunStart } from './api-shapes';
import { all } from './db';
import { parseJson } from './flows-util';

/** The most emails any path from `from` holds, not counting `from` itself. */
function emailsAhead(graph: FlowGraph, from: string): number {
  const send = new Set(graph.nodes.filter((n) => n.type === 'send_email').map((n) => n.id));
  const memo = new Map<string, number>();
  // A published graph is a DAG, so this ends; the marker guards an unreadable one.
  const best = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    memo.set(id, 0);
    let most = 0;
    for (const edge of graph.edges) {
      if (edge.from !== id) continue;
      most = Math.max(most, (send.has(edge.to) ? 1 : 0) + best(edge.to));
    }
    memo.set(id, most);
    return most;
  };
  return best(from);
}

/**
 * What a run could have sent on the path it took: what it sent, plus the current step's email if it
 * stopped there unsent, plus the most any path ahead holds. A branch not taken doesn't count, and a
 * run that completed took its whole path, so its figure is what it sent.
 */
export function emailsPossible(
  graph: FlowGraph | null,
  sent: readonly string[],
  run: { status: FlowRunStatus; current_node_id: string | null },
): number {
  const currentNodeId = run.current_node_id;
  if (!graph || !currentNodeId || run.status === 'completed') return sent.length;
  const current = graph.nodes.find((n) => n.id === currentNodeId);
  const stoppedAtEmail = current?.type === 'send_email' && !sent.includes(currentNodeId);
  return sent.length + (stoppedAtEmail ? 1 : 0) + emailsAhead(graph, currentNodeId);
}

interface LatestRunRow {
  id: string;
  flow_id: string;
  version: number;
  status: FlowRunStatus;
  exit_reason: FlowExitReason | null;
  current_node_id: string | null;
  context_json: string;
  started_at: number;
  ended_at: number | null;
  graph_json: string | null;
}

export async function memberFlowHistory(
  db: D1Database,
  channelId: string,
  memberId: string,
): Promise<MemberFlowHistory[]> {
  const flows = await all<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM flows
      WHERE channel_id = ?1 AND status = 'live' AND deleted_at IS NULL AND live_version IS NOT NULL
      ORDER BY name, id LIMIT 200`,
    channelId,
  );
  if (!flows.length) return [];
  const runs = await all<LatestRunRow>(
    db,
    `WITH latest AS (
       SELECT id, flow_id, version, status, exit_reason, current_node_id, context_json, started_at,
              ended_at, row_number() OVER (PARTITION BY flow_id ORDER BY started_at DESC, id DESC) AS rn
         FROM flow_runs WHERE member_id = ?1 AND test = 0)
     SELECT l.id, l.flow_id, l.version, l.status, l.exit_reason, l.current_node_id, l.context_json,
            l.started_at, l.ended_at, v.graph_json
       FROM latest l
       JOIN flows f ON f.id = l.flow_id AND f.channel_id = ?2 AND f.status = 'live'
       LEFT JOIN flow_versions v ON v.flow_id = l.flow_id AND v.version = l.version
      WHERE l.rn = 1`,
    memberId,
    channelId,
  );
  const contexts = new Map(
    runs.map((run) => [run.id, parseJson<FlowRunContext>(run.context_json, {})]),
  );
  const broadcasts = runs.flatMap((run) => Object.values(contexts.get(run.id)?.sent ?? {}));
  const received = new Set(
    broadcasts.length
      ? (
          await all<{ broadcast_id: string }>(
            db,
            `SELECT broadcast_id FROM deliveries
              WHERE member_id = ?1 AND bounced_at IS NULL
                AND status IN ('sent', 'delivered', 'complained')
                AND broadcast_id IN (SELECT value FROM json_each(?2))`,
            memberId,
            JSON.stringify(broadcasts),
          )
        ).map((row) => row.broadcast_id)
      : [],
  );
  const decisions = await all<{
    flow_id: string;
    version: number;
    reason: FlowEnrolDecision;
    trigger_event: FlowTriggerType;
    decided_at: number;
  }>(
    db,
    `SELECT flow_id, version, reason, trigger_event, decided_at FROM flow_enrol_decisions
      WHERE member_id = ?1`,
    memberId,
  );
  const runBy = new Map(runs.map((run) => [run.flow_id, run]));
  const decisionBy = new Map(decisions.map((d) => [d.flow_id, d]));

  return flows.map((flow) => {
    const run = runBy.get(flow.id);
    const decision = decisionBy.get(flow.id);
    const context = run ? contexts.get(run.id) : undefined;
    const sent = Object.entries(context?.sent ?? {});
    const graph = parseJson<FlowGraph | null>(run?.graph_json ?? null, null);
    // Entering clears the row, except through a step or the API: those leave an older one behind.
    const later = decision && (!run || decision.decided_at >= run.started_at) ? decision : null;
    return {
      flowId: flow.id,
      flowName: flow.name,
      run: run
        ? {
            id: run.id,
            version: run.version,
            status: run.status,
            exitReason: run.exit_reason,
            startedBy: toFlowRunStart(run.context_json),
            emailsReceived: sent.filter(([, broadcastId]) => received.has(broadcastId)).length,
            emailsPossible: emailsPossible(
              graph,
              sent.map(([nodeId]) => nodeId),
              run,
            ),
            startedAt: toIso(run.started_at),
            endedAt: run.ended_at === null ? null : toIso(run.ended_at),
          }
        : null,
      decision: later
        ? {
            reason: later.reason,
            version: later.version,
            event: later.trigger_event,
            decidedAt: toIso(later.decided_at),
          }
        : null,
    };
  });
}
