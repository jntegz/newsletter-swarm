/**
 * Helpers for the Flows routes: run starts for test runs, the jobs queue (replaceable in tests),
 * row mappers, run counts and the Membership grant checks.
 */
import { loadVersionGraph, type FlowsEnv } from '@swarm/engine';
import { all, first, toIso } from '@swarm/db';
import {
  FLOW_RUN_STATUSES,
  validateFlowGraph,
  type FlowGraph,
  type FlowTriggerType,
  type FlowRun,
  type FlowRunCounts,
  type FlowSummary,
} from '@swarm/domain';
import type { FlowTableRow, JobMessage } from '@swarm/engine';
import { env, type AppContext } from './context';

// ---- Jobs queue ------------------------------------------------------------------------------

interface JobsQueueLike {
  send(message: JobMessage, options?: { delaySeconds?: number }): Promise<void>;
}

let injectedQueue: JobsQueueLike | undefined;

/** Tests capture JOBS_QUEUE messages here. Pass undefined to go back to the binding. */
export function useJobsQueueForTests(queue: JobsQueueLike | undefined): void {
  injectedQueue = queue;
}

export function jobsQueue(c: AppContext): JobsQueueLike {
  if (injectedQueue) return injectedQueue;
  const queue = env(c).JOBS_QUEUE;
  return { send: async (message, options) => void (await queue.send(message, options)) };
}

// ---- Runs ----------------------------------------------------------------------------------

/**
 * The Flows engine's env for API calls (test runs, run migration, resume). JOBS_QUEUE goes
 * through `jobsQueue`, so tests capture the messages.
 */
export function flowsEnvFor(c: AppContext): FlowsEnv {
  const queue = jobsQueue(c);
  return {
    DB: env(c).DB,
    JOBS_QUEUE: queue as unknown as FlowsEnv['JOBS_QUEUE'],
    SEND_QUEUE: env(c).SEND_QUEUE as unknown as FlowsEnv['SEND_QUEUE'],
  };
}

// ---- Mappers ---------------------------------------------------------------------------------

const emptyCounts = (): FlowRunCounts =>
  Object.fromEntries(FLOW_RUN_STATUSES.map((s) => [s, 0])) as FlowRunCounts;

/** Run counts by status for the given Flows (test runs excluded). */
export async function runCounts(
  db: D1Database,
  flowIds: string[],
): Promise<Map<string, FlowRunCounts>> {
  const counts = new Map<string, FlowRunCounts>(flowIds.map((id) => [id, emptyCounts()]));
  if (!flowIds.length) return counts;
  const rows = await all<{ flow_id: string; status: FlowRun['status']; n: number }>(
    db,
    `SELECT flow_id, status, count(*) AS n FROM flow_runs
      WHERE flow_id IN (SELECT value FROM json_each(?1)) AND test = 0 GROUP BY flow_id, status`,
    JSON.stringify(flowIds),
  );
  for (const row of rows) {
    const entry = counts.get(row.flow_id);
    if (entry) entry[row.status] = row.n;
  }
  return counts;
}

/** A Flow's or version's first start event type, then the others. */
export function triggerTypes(row: {
  trigger_type: string | null;
  extra_trigger_types: string | null;
}): FlowTriggerType[] {
  if (!row.trigger_type) return [];
  const extra = row.extra_trigger_types
    ? (JSON.parse(row.extra_trigger_types) as FlowTriggerType[])
    : [];
  return [row.trigger_type as FlowTriggerType, ...extra];
}

export const toFlowSummary = (row: FlowTableRow, runs: FlowRunCounts): FlowSummary => ({
  id: row.id,
  channelId: row.channel_id,
  name: row.name,
  description: row.description,
  status: row.status,
  recipe: row.recipe as FlowSummary['recipe'],
  liveVersion: row.live_version,
  triggerType: row.trigger_type as FlowSummary['triggerType'],
  triggerTypes: triggerTypes(row),
  reentry: row.reentry,
  runs,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

// In the engine (api-shapes.ts), so flow.completed webhooks carry the same shape.
export { toFlowRun } from '@swarm/engine';

/** Structural issues of a stored draft (never throws on an old or odd draft). */
export function draftIssues(graph: FlowGraph) {
  try {
    return validateFlowGraph(graph);
  } catch {
    return [{ code: 'unreadable', message: 'The draft can’t be read.' }];
  }
}

// ---- Membership grants -----------------------------------------------------------------------
// A change_level grant step makes a comp grant, which the comp route lets only an admin make. So
// only an admin adds or changes such a step, publishes a Flow that can reach one, or starts real
// runs of it by hand. Test runs never grant (flows-decide.ts), so editors keep those.

/** The graph's grant steps by node id, each as what it gives (level and length). */
function grantSteps(graph: FlowGraph): Map<string, string> {
  const steps = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.type === 'change_level' && node.config.action === 'grant') {
      steps.set(node.id, JSON.stringify([node.config.levelId, node.config.days ?? null]));
    }
  }
  return steps;
}

/** Whether `next` adds a grant step, or changes what one of `previous` gives. */
export function changesGrantSteps(previous: FlowGraph, next: FlowGraph): boolean {
  const before = grantSteps(previous);
  return [...grantSteps(next)].some(([id, gives]) => before.get(id) !== gives);
}

/**
 * Whether a run of this graph can make a comp grant: it has a grant step, or an enrol_flow step
 * into a Flow whose live version can (followed through that Flow's own enrol_flow steps).
 */
export async function graphGrantsLevel(
  db: D1Database,
  graph: FlowGraph,
  seen: Set<string> = new Set(),
): Promise<boolean> {
  if (grantSteps(graph).size) return true;
  for (const node of graph.nodes) {
    if (node.type !== 'enrol_flow' || seen.has(node.config.flowId)) continue;
    seen.add(node.config.flowId);
    const target = await first<{ live_version: number | null }>(
      db,
      'SELECT live_version FROM flows WHERE id = ?1 AND deleted_at IS NULL',
      node.config.flowId,
    );
    if (target?.live_version == null) continue;
    const next = await loadVersionGraph(db, node.config.flowId, target.live_version);
    if (next && (await graphGrantsLevel(db, next, seen))) return true;
  }
  return false;
}
