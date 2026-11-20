/**
 * Who may enter a Flow by hand: the enrolment rules as an answer instead of a write, for Add people's
 * count, and the chunks of its job. `startFlowRun` stays the last word: the refusals are its own SQL
 * (entryGuardsSql), and the unique index stops a second open run. On top of that Add people refuses
 * anyone who can't be mailed, so nobody who shouldn't get the email ever starts, and it asks the same
 * filters a start event would. There is no event to match, so anyone one start event would let in
 * may enter. Once in, a run is a run: the email steps recheck the Member and obey the inbox rules.
 */
import {
  FLOW_REENTRY_MAX_PER_HOUR,
  triggersOf,
  type BulkSelection,
  type CircleRule,
  type FlowEnrolDecision,
  type FlowEnrolVerdict,
  type FlowGraph,
} from '@swarm/domain';
import {
  CircleRuleError,
  CircleValues,
  circleFieldKeys,
  compileRule,
  loadCircleFields,
  parseCircleRule,
} from './circles';
import { all, first } from './db';
import type { FlowsEnv } from './flows';
import { OPEN_REAL_RUN_SQL, SUPPRESSED_SQL, entryGuardsSql } from './flows-decide';
import { isSegmentFilter } from './flows-enrol';
import { loadVersionGraph, startFlowRun } from './flows-engine';

interface AdmitFlow {
  id: string;
  channel_id: string;
}

interface Compiled {
  /** A boolean over `members m`, using ?1. */
  filter: string;
  params: string;
  /** How Why names a Member the filters kept out. */
  miss: FlowEnrolDecision;
}

/** Anyone one start event lets in: its filters joined with OR, or everyone if one has no filter. */
async function compileFilters(
  db: D1Database,
  flow: AdmitFlow,
  graph: FlowGraph | null,
  now: number,
): Promise<Compiled> {
  const triggers = graph ? triggersOf(graph) : [];
  const rules = triggers.map((t) => t.filter);
  // ?1 is always bound, and D1 wants every bound parameter used.
  const everyone = { filter: 'json_valid(?1)', params: '[]' };
  const miss: FlowEnrolDecision = rules.every((rule) => rule && isSegmentFilter(rule))
    ? 'not_in_segment'
    : 'filter_miss';
  if (!rules.length || rules.some((rule) => !rule)) return { ...everyone, miss };
  const values = new CircleValues();
  const parts: string[] = [];
  for (const rule of rules as CircleRule[]) {
    // A filter that doesn't compile lets nobody in, as with an event, and the others still count.
    try {
      const parsed = parseCircleRule(rule);
      const fields = await loadCircleFields(db, flow.channel_id, circleFieldKeys(parsed));
      parts.push(compileRule(parsed, { channelId: flow.channel_id, fields, now }, values));
    } catch (error) {
      if (!(error instanceof CircleRuleError)) throw error;
    }
  }
  if (!parts.length) return { filter: 'json_valid(?1) AND 0', params: '[]', miss };
  return { filter: `(${parts.join(' OR ')})`, params: values.params()[0] as string, miss };
}

/**
 * The verdict as SQL over `m` (Member), `c` (their Channel), `f` (the Flow). ?1 the filters, ?2 the
 * Flow, ?3 an hour ago, ?4 the hourly limit, ?5 the Channel, ?6 the selection, ?7 the live version.
 */
const verdictSql = ({ filter, miss }: Compiled) => `CASE
  WHEN m.status = 'unsubscribed' THEN 'unsubscribed'
  WHEN ${SUPPRESSED_SQL} THEN 'suppressed'
  WHEN m.status <> 'active' THEN 'not_active'
  WHEN ${OPEN_REAL_RUN_SQL} THEN 'already_in'
  WHEN NOT (${entryGuardsSql({ seq: 'NULL', test: '0', since: '?3', cap: '?4', notStartedSince: 'NULL' })}) THEN
    CASE WHEN f.reentry = 'after_exit' THEN 'rate_limited'
         WHEN (SELECT version FROM flow_runs r WHERE r.flow_id = f.id AND r.member_id = m.id AND r.test = 0
                ORDER BY r.started_at DESC LIMIT 1) = ?7 THEN 'already_ran_version'
         ELSE 'already_ran_earlier' END
  WHEN NOT (${filter}) THEN '${miss}'
  ELSE 'enter' END`;

const FROM = `FROM members m JOIN channels c ON c.id = m.channel_id JOIN flows f ON f.id = ?2`;

const selectionSql = (selection: BulkSelection) =>
  'circleId' in selection
    ? 'm.id IN (SELECT member_id FROM circle_members WHERE circle_id = ?6)'
    : 'm.id IN (SELECT value FROM json_each(?6))';

const selectionParam = (selection: BulkSelection) =>
  'circleId' in selection ? selection.circleId : JSON.stringify(selection.memberIds);

const verdictParams = (
  compiled: Compiled,
  flow: AdmitFlow,
  version: number,
  selection: BulkSelection,
  now: number,
) => [
  compiled.params,
  flow.id,
  now - 3_600_000,
  FLOW_REENTRY_MAX_PER_HOUR,
  flow.channel_id,
  selectionParam(selection),
  version,
];

export interface EnrolmentCounts {
  total: number;
  entering: number;
  skipped: { reason: Exclude<FlowEnrolVerdict, 'enter'>; count: number }[];
}

/** How a selection divides up: who would enter, and why the others wouldn't. */
export async function enrolmentCounts(
  db: D1Database,
  flow: AdmitFlow,
  version: number,
  selection: BulkSelection,
  now: number,
): Promise<EnrolmentCounts> {
  const graph = await loadVersionGraph(db, flow.id, version);
  const compiled = await compileFilters(db, flow, graph, now);
  const rows = await all<{ verdict: FlowEnrolVerdict; n: number }>(
    db,
    `SELECT verdict, count(*) AS n FROM (
       SELECT ${verdictSql(compiled)} AS verdict
         ${FROM}
        WHERE m.channel_id = ?5 AND ${selectionSql(selection)})
      GROUP BY verdict`,
    ...verdictParams(compiled, flow, version, selection, now),
  );
  const skipped: EnrolmentCounts['skipped'] = [];
  for (const row of rows) {
    if (row.verdict !== 'enter') skipped.push({ reason: row.verdict, count: row.n });
  }
  return {
    total: rows.reduce((sum, r) => sum + r.n, 0),
    entering: rows.find((r) => r.verdict === 'enter')?.n ?? 0,
    skipped: skipped.sort((a, b) => b.count - a.count),
  };
}

export interface EnrolChunkInput {
  jobId: string;
  flowId: string;
  channelId: string;
  memberIds: string[];
  now: number;
}

export type EnrolChunkResult = { entered: number } | { stopped: 'not_live' };

/**
 * One chunk of an Add people job: starts a run for each Member the rules let in, as they stand now.
 * A retried chunk is safe: it counts, and doesn't start again, Members this job already started.
 */
export async function enrolChunk(env: FlowsEnv, input: EnrolChunkInput): Promise<EnrolChunkResult> {
  const db = env.DB;
  const flow = await first<AdmitFlow & { status: string; live_version: number | null }>(
    db,
    `SELECT id, channel_id, status, live_version FROM flows WHERE id = ?1 AND channel_id = ?2
        AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM channels c WHERE c.id = ?2 AND c.deleted_at IS NULL)`,
    input.flowId,
    input.channelId,
  );
  if (!flow || flow.status !== 'live' || flow.live_version === null) return { stopped: 'not_live' };
  const graph = await loadVersionGraph(db, flow.id, flow.live_version);
  if (!graph) return { stopped: 'not_live' };
  const selection = { memberIds: input.memberIds };
  const compiled = await compileFilters(db, flow, graph, input.now);
  const verdicts = await all<{ id: string; verdict: FlowEnrolVerdict }>(
    db,
    `SELECT m.id, ${verdictSql(compiled)} AS verdict
       ${FROM}
      WHERE m.channel_id = ?5 AND ${selectionSql(selection)}`,
    ...verdictParams(compiled, flow, flow.live_version, selection, input.now),
  );
  const already = new Set(
    (
      await all<{ member_id: string }>(
        db,
        `SELECT member_id FROM flow_runs
          WHERE flow_id = ?1 AND member_id IN (SELECT value FROM json_each(?2))
            AND json_extract(context_json, '$.addedByJob') = ?3`,
        flow.id,
        JSON.stringify(input.memberIds),
        input.jobId,
      )
    ).map((r) => r.member_id),
  );
  let entered = already.size;
  for (const { id, verdict } of verdicts) {
    if (already.has(id) || verdict !== 'enter') continue;
    const runId = await startFlowRun(env, {
      flowId: flow.id,
      version: flow.live_version,
      memberId: id,
      channelId: flow.channel_id,
      graph,
      context: { addedByJob: input.jobId },
      now: input.now,
    });
    if (runId) entered++;
  }
  return { entered };
}
