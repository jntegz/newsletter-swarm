/**
 * Split Tests (flag split_tests) and Cohort Sampling (flag cohort_sampling): both run on one
 * Broadcast by holding recipients back.
 *
 *   start      startBroadcast freezes each variant's render (split_test_variants html/text, with
 *              its links appended to the Broadcast's link targets) and marks the test 'testing'
 *              (the sample 'sampling') with decide_at = start + window.
 *   snapshot   every recipient row gets its place, decided once by a hash of the test id and the
 *              Member id (splitAssignment / inShare): a variant, or held = 1. Fan-out and batches
 *              skip held rows; a batch sends each recipient their variant's subject and render.
 *   decide     the jobs worker's minute cron (decideHoldBacks), once decide_at has passed and the
 *              first part has gone out: a Split Test picks the winner from human opens, clicks or
 *              goal events (pickSplitTestWinner) and releases the held rows with the winner's
 *              variant; a sample that stays within its thresholds is released as it is, one that
 *              doesn't is halted (held rows skipped) and the operators are emailed.
 *
 * Release is one D1 batch whose statements are all guarded on the test still being undecided, so
 * a retried or concurrent decision releases nobody twice. The fan-out it restarts is idempotent.
 *
 * Phase 5's full/teaser split is independent: the snapshot still decides it per recipient, and a
 * subject test on a gated paid Dispatch changes only the subject. Content tests are refused for
 * gated paid Dispatches (the teaser would need one render per variant), and only variant A (the
 * Dispatch itself) may contain Smart Blocks.
 */
import {
  inShare,
  pickSplitTestWinner,
  splitAssignment,
  SplitTestGoalSchema,
  type CohortSample,
  type CohortSampleMetrics,
  type SplitTest,
  type SplitTestGoal,
  type SplitTestLabel,
  type SplitTestVariantMetrics,
} from '@swarm/domain';
import { escapeHtml, smartBlocksOf, type RenderedTemplate } from '@swarm/mail';
import { CHANNEL_DELETED_REASON, cancelBroadcast } from './cancel';
import type { SendMessage } from './config';
import { all, first, run } from './db';

export interface SplitTestRow {
  id: string;
  channel_id: string;
  dispatch_id: string;
  broadcast_id: string | null;
  variable: 'subject' | 'content';
  test_percent: number;
  metric: 'opens' | 'clicks' | 'goal';
  goal_json: string | null;
  window_minutes: number;
  status: 'draft' | 'testing' | 'promoted' | 'canceled';
  winner_variant_id: string | null;
  decision_json: string | null;
  started_at: number | null;
  decide_at: number | null;
  decided_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SplitVariantRow {
  id: string;
  split_test_id: string;
  label: SplitTestLabel;
  subject: string | null;
  preheader: string | null;
  content_json: string | null;
  html: string | null;
  text: string | null;
  created_at: number;
}

export interface CohortSampleRow {
  id: string;
  channel_id: string;
  dispatch_id: string;
  broadcast_id: string | null;
  sample_percent: number;
  window_minutes: number;
  min_open_rate: number | null;
  max_bounce_rate: number;
  max_complaint_rate: number;
  max_unsubscribe_rate: number;
  status: 'draft' | 'sampling' | 'extended' | 'halted' | 'canceled';
  metrics_json: string | null;
  decide_at: number | null;
  decided_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Which optional send features are on for the Channel (flags), as the caller resolved them. */
export interface SendFeatures {
  splitTests?: boolean;
  cohortSampling?: boolean;
  smartBlocks?: boolean;
  /** Sending at each reader's best time (best-time.ts). */
  bestTime?: boolean;
}

const MINUTE = 60_000;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export async function loadSplitTest(
  db: D1Database,
  dispatchId: string,
): Promise<{ test: SplitTestRow; variants: SplitVariantRow[] } | null> {
  const test = await first<SplitTestRow>(
    db,
    'SELECT * FROM split_tests WHERE dispatch_id = ?1',
    dispatchId,
  );
  if (!test) return null;
  return { test, variants: await loadVariants(db, test.id) };
}

export function loadVariants(db: D1Database, splitTestId: string): Promise<SplitVariantRow[]> {
  return all<SplitVariantRow>(
    db,
    'SELECT * FROM split_test_variants WHERE split_test_id = ?1 ORDER BY label',
    splitTestId,
  );
}

export function loadCohortSample(
  db: D1Database,
  dispatchId: string,
): Promise<CohortSampleRow | null> {
  return first<CohortSampleRow>(
    db,
    'SELECT * FROM cohort_samples WHERE dispatch_id = ?1',
    dispatchId,
  );
}

/** A test or sample that a new send would run (not one already decided for an earlier send). */
export const pendingSplitTest = (row: { status: string } | null | undefined) =>
  row?.status === 'draft' || row?.status === 'canceled';
export const pendingCohortSample = (row: { status: string } | null | undefined) =>
  row?.status === 'draft' || row?.status === 'canceled';

/**
 * The hold-back a send would run, as the preflight reports it, with whatever stops the send.
 * Counts are estimates from the percentage; the snapshot decides per Member.
 */
export async function planHoldBackCheck(
  db: D1Database,
  dispatch: { id: string; web_visibility: string },
  gated: boolean,
  recipientCount: number,
  features: SendFeatures,
): Promise<{
  holdBack: {
    kind: 'split_test' | 'cohort_sample';
    test: number;
    held: number;
    variants: number;
  } | null;
  problem: string | null;
  split: { test: SplitTestRow; variants: SplitVariantRow[] } | null;
  sample: CohortSampleRow | null;
}> {
  const loaded = features.splitTests ? await loadSplitTest(db, dispatch.id) : null;
  const split = loaded && pendingSplitTest(loaded.test) ? loaded : null;
  const sampleRow = features.cohortSampling ? await loadCohortSample(db, dispatch.id) : null;
  const sample = pendingCohortSample(sampleRow) ? sampleRow : null;
  let problem: string | null = null;
  if (split && sample) problem = 'A post can have a split test or a cohort sample, not both.';
  if (split && split.variants.length < 2) problem = 'The split test needs at least two variants.';
  if (split?.test.variable === 'content' && gated) {
    problem =
      'Content split tests can’t run on a paid post with a paywall break. Test the subject instead.';
  }
  if (split?.test.variable === 'content') {
    for (const variant of split.variants) {
      if (variant.label === 'A') continue;
      if (smartBlocksOf(JSON.parse(variant.content_json ?? '{}')).length) {
        problem = `Variant ${variant.label} has Smart blocks; only variant A (the post) can.`;
      }
    }
  }
  const estimate = (percent: number) => Math.round((recipientCount * percent) / 100);
  const holdBack = split
    ? {
        kind: 'split_test' as const,
        test: estimate(split.test.test_percent),
        held: recipientCount - estimate(split.test.test_percent),
        variants: split.variants.length,
      }
    : sample
      ? {
          kind: 'cohort_sample' as const,
          test: estimate(sample.sample_percent),
          held: recipientCount - estimate(sample.sample_percent),
          variants: 1,
        }
      : null;
  return { holdBack, problem, split, sample };
}

/**
 * Renumbers a variant template's links into `links` (appending new ones), so the Broadcast's
 * link targets serve every variant. Mutates `links`.
 */
export function appendLinks(links: string[], template: RenderedTemplate): RenderedTemplate {
  const map = template.links.map((url) => {
    const index = links.indexOf(url);
    return index === -1 ? links.push(url) - 1 : index;
  });
  const renumber = (input: string) =>
    input.replace(/\{\{@link:(\d+)\}\}/g, (_, n: string) => `{{@link:${map[Number(n)] ?? n}}}`);
  return { ...template, html: renumber(template.html), text: renumber(template.text), links };
}

/**
 * The statements that start a Split Test or a Cohort Sample with a new Broadcast, for the start
 * batch (after the Broadcast insert). `renders` holds the frozen render of each variant that has
 * its own (by variant id).
 */
export function holdBackStartStatements(
  db: D1Database,
  input: {
    broadcastId: string;
    now: number;
    split: { test: SplitTestRow; variants: SplitVariantRow[] } | null;
    sample: CohortSampleRow | null;
    renders: Map<string, { html: string; text: string }>;
  },
): D1PreparedStatement[] {
  const { broadcastId, now, split, sample } = input;
  const statements: D1PreparedStatement[] = [];
  if (split) {
    for (const variant of split.variants) {
      const render = input.renders.get(variant.id);
      statements.push(
        db
          .prepare('UPDATE split_test_variants SET html = ?1, text = ?2 WHERE id = ?3')
          .bind(render?.html ?? null, render?.text ?? null, variant.id),
      );
    }
    statements.push(
      db
        .prepare(
          `UPDATE split_tests SET status = 'testing', broadcast_id = ?1, started_at = ?2, decide_at = ?3,
                  winner_variant_id = NULL, decision_json = NULL, decided_at = NULL, updated_at = ?2
            WHERE id = ?4 AND status IN ('draft', 'canceled')`,
        )
        .bind(broadcastId, now, now + split.test.window_minutes * MINUTE, split.test.id),
      db
        .prepare('UPDATE broadcasts SET split_test_id = ?1 WHERE id = ?2')
        .bind(split.test.id, broadcastId),
    );
  }
  if (sample) {
    statements.push(
      db
        .prepare(
          `UPDATE cohort_samples SET status = 'sampling', broadcast_id = ?1, decide_at = ?2,
                  metrics_json = NULL, decided_at = NULL, updated_at = ?3
            WHERE id = ?4 AND status IN ('draft', 'canceled')`,
        )
        .bind(broadcastId, now + sample.window_minutes * MINUTE, now, sample.id),
      db
        .prepare('UPDATE broadcasts SET cohort_sample_id = ?1 WHERE id = ?2')
        .bind(sample.id, broadcastId),
    );
  }
  return statements;
}

// ---- Snapshot ----------------------------------------------------------------------------------

/** Where each Member of a snapshot page goes: test variant, sample or held. */
export async function holdBackPlacements(
  db: D1Database,
  broadcast: { split_test_id: string | null; cohort_sample_id: string | null },
  memberIds: readonly string[],
): Promise<Map<string, { held: 0 | 1; variantId: string | null }> | null> {
  if (broadcast.split_test_id) {
    const test = await first<{ id: string; test_percent: number }>(
      db,
      'SELECT id, test_percent FROM split_tests WHERE id = ?1',
      broadcast.split_test_id,
    );
    const variants = await all<{ id: string }>(
      db,
      'SELECT id FROM split_test_variants WHERE split_test_id = ?1 ORDER BY label',
      broadcast.split_test_id,
    );
    if (!test || variants.length === 0) return null;
    return new Map(
      memberIds.map((id) => {
        const index = splitAssignment(test.id, id, test.test_percent, variants.length);
        return [
          id,
          index === null
            ? { held: 1, variantId: null }
            : { held: 0, variantId: variants[index]!.id },
        ];
      }),
    );
  }
  if (broadcast.cohort_sample_id) {
    const sample = await first<{ id: string; sample_percent: number }>(
      db,
      'SELECT id, sample_percent FROM cohort_samples WHERE id = ?1',
      broadcast.cohort_sample_id,
    );
    if (!sample) return null;
    return new Map(
      memberIds.map((id) => [
        id,
        { held: inShare(sample.id, id, sample.sample_percent) ? 0 : 1, variantId: null },
      ]),
    );
  }
  return null;
}

// ---- Metrics -----------------------------------------------------------------------------------

function parseGoal(json: string | null): SplitTestGoal | null {
  if (!json) return null;
  const parsed = SplitTestGoalSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : null;
}

/** The goal's payload filter: [JSON path, value], or nulls for "any event of the type". */
function goalFilter(goal: SplitTestGoal | null): [string | null, string | null] {
  if (goal?.levelId) return ['$.levelId', goal.levelId];
  if (goal?.url) return ['$.url', goal.url];
  if (goal?.name) return ['$.name', goal.name];
  return [null, null];
}

export interface VariantMetrics extends SplitTestVariantMetrics {
  recipients: number;
}

/**
 * Per-variant results of a Split Test: delivered messages of the test phase (sent before the
 * decision, or before `now` while it runs) and how many of them converted, once per Member:
 * a human open, a human click, or the goal event between the send and the window's end.
 */
export async function splitTestMetrics(
  db: D1Database,
  test: SplitTestRow,
  now = Date.now(),
): Promise<VariantMetrics[]> {
  if (!test.broadcast_id) {
    const variants = await loadVariants(db, test.id);
    return variants.map((v) => ({
      variantId: v.id,
      label: v.label,
      delivered: 0,
      value: 0,
      recipients: 0,
    }));
  }
  const until = test.decided_at ?? now;
  const goal = parseGoal(test.goal_json);
  const [path, expected] = goalFilter(goal);
  const value =
    test.metric === 'opens'
      ? 'd.human_opened_at IS NOT NULL'
      : test.metric === 'clicks'
        ? 'd.human_clicked_at IS NOT NULL'
        : `EXISTS (SELECT 1 FROM member_events e
             WHERE e.member_id = d.member_id AND e.channel_id = d.channel_id AND e.type = ?4
               AND e.created_at >= d.sent_at AND e.created_at <= ?3
               AND (?5 IS NULL OR json_extract(e.payload_json, ?5) = ?6))`;
  const rows = await all<{
    id: string;
    label: SplitTestLabel;
    recipients: number;
    delivered: number;
    value: number;
  }>(
    db,
    `SELECT v.id, v.label,
            (SELECT count(*) FROM broadcast_recipients x WHERE x.broadcast_id = ?2 AND x.split_variant_id = v.id) AS recipients,
            coalesce(sum(d.status IN ('sent', 'delivered', 'complained')), 0) AS delivered,
            coalesce(sum(d.status IN ('sent', 'delivered', 'complained') AND ${value}), 0) AS value
       FROM split_test_variants v
       LEFT JOIN broadcast_recipients r ON r.broadcast_id = ?2 AND r.split_variant_id = v.id
       LEFT JOIN deliveries d ON d.broadcast_id = r.broadcast_id AND d.member_id = r.member_id AND d.sent_at <= ?3
      WHERE v.split_test_id = ?1
      GROUP BY v.id ORDER BY v.label`,
    test.id,
    test.broadcast_id,
    until,
    ...(test.metric === 'goal' ? [goal?.event ?? '', path, expected] : []),
  );
  return rows.map((row) => ({
    variantId: row.id,
    label: row.label,
    recipients: row.recipients,
    delivered: row.delivered,
    value: row.value,
  }));
}

const rate = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0;

/** The sample's health: deliveries of the recipients that were not held back. */
export async function cohortSampleMetrics(
  db: D1Database,
  sample: CohortSampleRow,
): Promise<CohortSampleMetrics> {
  const t = (sample.broadcast_id
    ? await first<{
        sent: number;
        bounced: number;
        complained: number;
        unsubscribed: number;
        opened: number;
      }>(
        db,
        `SELECT coalesce(sum(d.status <> 'failed'), 0) AS sent,
                coalesce(sum(d.status = 'bounced'), 0) AS bounced,
                coalesce(sum(d.status = 'complained'), 0) AS complained,
                coalesce(sum(d.unsubscribed_at IS NOT NULL), 0) AS unsubscribed,
                coalesce(sum(d.human_opened_at IS NOT NULL), 0) AS opened
           FROM broadcast_recipients r
           JOIN deliveries d ON d.broadcast_id = r.broadcast_id AND d.member_id = r.member_id
          WHERE r.broadcast_id = ?1 AND r.held = 0`,
        sample.broadcast_id,
      )
    : null) ?? { sent: 0, bounced: 0, complained: 0, unsubscribed: 0, opened: 0 };
  const delivered = Math.max(0, t.sent - t.bounced);
  const metrics = {
    sent: t.sent,
    delivered,
    bounced: t.bounced,
    complained: t.complained,
    unsubscribed: t.unsubscribed,
    opened: t.opened,
    openRate: rate(t.opened, delivered),
    bounceRate: rate(t.bounced, t.sent),
    complaintRate: rate(t.complained, delivered),
    unsubscribeRate: rate(t.unsubscribed, delivered),
  };
  const reasons: string[] = [];
  const pct = (n: number) => `${(n * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
  if (metrics.bounceRate > sample.max_bounce_rate)
    reasons.push(`Bounces ${pct(metrics.bounceRate)} (limit ${pct(sample.max_bounce_rate)})`);
  if (metrics.complaintRate > sample.max_complaint_rate)
    reasons.push(
      `Complaints ${pct(metrics.complaintRate)} (limit ${pct(sample.max_complaint_rate)})`,
    );
  if (metrics.unsubscribeRate > sample.max_unsubscribe_rate)
    reasons.push(
      `Unsubscribes ${pct(metrics.unsubscribeRate)} (limit ${pct(sample.max_unsubscribe_rate)})`,
    );
  if (sample.min_open_rate !== null && metrics.openRate < sample.min_open_rate)
    reasons.push(`Opens ${pct(metrics.openRate)} (at least ${pct(sample.min_open_rate)})`);
  return { ...metrics, passed: reasons.length === 0, reasons };
}

// ---- Views (API) ---------------------------------------------------------------------------------

export async function splitTestView(
  db: D1Database,
  test: SplitTestRow,
  now = Date.now(),
): Promise<SplitTest> {
  const variants = await loadVariants(db, test.id);
  const metrics = new Map((await splitTestMetrics(db, test, now)).map((m) => [m.variantId, m]));
  return {
    id: test.id,
    dispatchId: test.dispatch_id,
    broadcastId: test.broadcast_id,
    variable: test.variable,
    testPercent: test.test_percent,
    metric: test.metric,
    goal: parseGoal(test.goal_json),
    windowMinutes: test.window_minutes,
    status: test.status,
    winnerVariantId: test.winner_variant_id,
    startedAt: iso(test.started_at),
    decideAt: iso(test.decide_at),
    decidedAt: iso(test.decided_at),
    variants: variants.map((v) => {
      const m = metrics.get(v.id);
      const delivered = m?.delivered ?? 0;
      const value = m?.value ?? 0;
      return {
        id: v.id,
        label: v.label,
        subject: v.subject,
        preheader: v.preheader,
        content: v.content_json
          ? (JSON.parse(v.content_json) as SplitTest['variants'][number]['content'])
          : null,
        recipients: m?.recipients ?? 0,
        delivered,
        value,
        rate: rate(value, delivered),
      };
    }),
    createdAt: new Date(test.created_at).toISOString(),
    updatedAt: new Date(test.updated_at).toISOString(),
  };
}

export async function cohortSampleView(
  db: D1Database,
  sample: CohortSampleRow,
): Promise<CohortSample> {
  const metrics = sample.metrics_json
    ? (JSON.parse(sample.metrics_json) as CohortSampleMetrics)
    : sample.status === 'sampling'
      ? await cohortSampleMetrics(db, sample)
      : null;
  return {
    id: sample.id,
    dispatchId: sample.dispatch_id,
    broadcastId: sample.broadcast_id,
    samplePercent: sample.sample_percent,
    windowMinutes: sample.window_minutes,
    minOpenRate: sample.min_open_rate,
    maxBounceRate: sample.max_bounce_rate,
    maxComplaintRate: sample.max_complaint_rate,
    maxUnsubscribeRate: sample.max_unsubscribe_rate,
    status: sample.status,
    decideAt: iso(sample.decide_at),
    decidedAt: iso(sample.decided_at),
    metrics,
    createdAt: new Date(sample.created_at).toISOString(),
    updatedAt: new Date(sample.updated_at).toISOString(),
  };
}

// ---- Decisions (jobs worker, minute cron) ----------------------------------------------------

export interface HoldBackEnv {
  DB: D1Database;
  /** The send queue (a Queue binding or the engine's SendQueue). */
  SEND_QUEUE: { send(message: SendMessage, options?: { delaySeconds?: number }): Promise<unknown> };
}

type Readiness = 'ready' | 'wait' | 'ended' | 'stopped';

/**
 * Whether a Broadcast's first part has gone out: the snapshot is done and no recipient that
 * isn't held is still waiting. 'ended': the Broadcast finished (a 100% test); 'stopped':
 * canceled or failed, so the test is canceled too. A deleted Channel's Broadcast is canceled
 * here, so its held recipients are never released.
 */
async function readiness(
  db: D1Database,
  broadcastId: string | null,
  now: number,
): Promise<Readiness> {
  if (!broadcastId) return 'stopped';
  const row = await first<{
    status: string;
    snapshot_done: number;
    busy: number;
    channel_deleted: number;
  }>(
    db,
    `SELECT b.status, b.snapshot_done,
            EXISTS (SELECT 1 FROM broadcast_recipients r
                     WHERE r.broadcast_id = b.id AND r.held = 0 AND r.status IN ('pending', 'sending')) AS busy,
            EXISTS (SELECT 1 FROM channels c WHERE c.id = b.channel_id AND c.deleted_at IS NOT NULL) AS channel_deleted
       FROM broadcasts b WHERE b.id = ?1`,
    broadcastId,
  );
  if (!row || row.status === 'canceled' || row.status === 'failed') return 'stopped';
  if (row.channel_deleted) {
    await cancelBroadcast(db, broadcastId, now, CHANNEL_DELETED_REASON);
    return 'stopped';
  }
  if (row.status !== 'queued' && row.status !== 'sending') return 'ended';
  return row.snapshot_done && !row.busy ? 'ready' : 'wait';
}

/**
 * Decides one Split Test if it is due and its test part has gone out. Returns the winner's
 * variant id when this call promoted it (null when there was nothing to do, or another run did).
 */
export async function decideSplitTest(
  env: HoldBackEnv,
  testId: string,
  now = Date.now(),
): Promise<string | null> {
  const db = env.DB;
  const test = await first<SplitTestRow>(
    db,
    `SELECT * FROM split_tests WHERE id = ?1 AND status = 'testing' AND decide_at <= ?2`,
    testId,
    now,
  );
  if (!test) return null;
  const state = await readiness(db, test.broadcast_id, now);
  if (state === 'wait') return null;
  if (state === 'stopped') {
    await run(
      db,
      `UPDATE split_tests SET status = 'canceled', decided_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'testing'`,
      now,
      test.id,
    );
    return null;
  }
  const metrics = await splitTestMetrics(db, { ...test, decided_at: now }, now);
  const winner = pickSplitTestWinner(metrics);
  if (!winner) return null;
  const decision = {
    metric: test.metric,
    decidedAt: new Date(now).toISOString(),
    winner: winner.label,
    variants: metrics.map((m) => ({
      label: m.label,
      variantId: m.variantId,
      delivered: m.delivered,
      value: m.value,
      rate: rate(m.value, m.delivered),
    })),
  };
  const guard = (n: number) =>
    `EXISTS (SELECT 1 FROM split_tests WHERE id = ?${n} AND status = 'testing')`;
  const results = await db.batch([
    // Held recipients get the winner. Guarded, so only the run that decides releases anyone.
    db
      .prepare(
        `UPDATE broadcast_recipients SET held = 0, split_variant_id = ?1
          WHERE broadcast_id = ?2 AND held = 1 AND status = 'pending' AND ${guard(3)}`,
      )
      .bind(winner.variantId, test.broadcast_id, test.id),
    db
      .prepare(
        `UPDATE broadcasts SET fanout_done = 0, fanout_cursor = NULL, fanout_tier = CASE WHEN fanout_tier IS NULL THEN NULL ELSE 1 END, last_progress_at = ?1
          WHERE id = ?2 AND status IN ('queued', 'sending') AND ${guard(3)}`,
      )
      .bind(now, test.broadcast_id, test.id),
    db
      .prepare(
        `UPDATE split_tests SET status = 'promoted', winner_variant_id = ?1, decision_json = ?2,
                decided_at = ?3, updated_at = ?3
          WHERE id = ?4 AND status = 'testing'`,
      )
      .bind(winner.variantId, JSON.stringify(decision), now, test.id),
  ]);
  if (!results[2]?.meta.changes) return null;
  if (state === 'ready' && test.broadcast_id) {
    await env.SEND_QUEUE.send({ type: 'fanout', broadcastId: test.broadcast_id });
  }
  return winner.variantId;
}

/**
 * Decides one Cohort Sample if it is due and the sample has gone out: 'extended' (the held
 * recipients are released) or 'halted' (they are skipped and the operators are notified).
 */
export async function decideCohortSample(
  env: HoldBackEnv,
  sampleId: string,
  now = Date.now(),
): Promise<'extended' | 'halted' | null> {
  const db = env.DB;
  const sample = await first<CohortSampleRow>(
    db,
    `SELECT * FROM cohort_samples WHERE id = ?1 AND status = 'sampling' AND decide_at <= ?2`,
    sampleId,
    now,
  );
  if (!sample) return null;
  const state = await readiness(db, sample.broadcast_id, now);
  if (state === 'wait') return null;
  if (state === 'stopped') {
    await run(
      db,
      `UPDATE cohort_samples SET status = 'canceled', decided_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'sampling'`,
      now,
      sample.id,
    );
    return null;
  }
  const metrics = await cohortSampleMetrics(db, sample);
  const outcome = metrics.passed ? 'extended' : 'halted';
  const guard = (n: number) =>
    `EXISTS (SELECT 1 FROM cohort_samples WHERE id = ?${n} AND status = 'sampling')`;
  const results = await db.batch([
    metrics.passed
      ? db
          .prepare(
            `UPDATE broadcast_recipients SET held = 0
              WHERE broadcast_id = ?1 AND held = 1 AND status = 'pending' AND ${guard(2)}`,
          )
          .bind(sample.broadcast_id, sample.id)
      : // Halted: the held recipients stay unsent (and held), so the Broadcast can finish.
        db
          .prepare(
            `UPDATE broadcast_recipients SET status = 'skipped'
              WHERE broadcast_id = ?1 AND held = 1 AND status = 'pending' AND ${guard(2)}`,
          )
          .bind(sample.broadcast_id, sample.id),
    db
      .prepare(
        `UPDATE broadcasts SET fanout_done = 0, fanout_cursor = NULL, fanout_tier = CASE WHEN fanout_tier IS NULL THEN NULL ELSE 1 END, last_progress_at = ?1
          WHERE id = ?2 AND status IN ('queued', 'sending') AND ${guard(3)}`,
      )
      .bind(now, sample.broadcast_id, sample.id),
    db
      .prepare(
        `UPDATE cohort_samples SET status = ?1, metrics_json = ?2, decided_at = ?3, updated_at = ?3
          WHERE id = ?4 AND status = 'sampling'`,
      )
      .bind(outcome, JSON.stringify(metrics), now, sample.id),
  ]);
  if (!results[2]?.meta.changes) return null;
  // The fan-out sends the released recipients, or finds nothing left and completes the Broadcast.
  await env.SEND_QUEUE.send({ type: 'fanout', broadcastId: sample.broadcast_id as string });
  if (outcome === 'halted') {
    await env.SEND_QUEUE.send({
      type: 'cohort_halted',
      broadcastId: sample.broadcast_id as string,
    });
  }
  return outcome;
}

/**
 * The minute cron's hook: decides every due Split Test and Cohort Sample (a bounded batch per
 * run; the rest wait for the next minute).
 */
export async function decideHoldBacks(
  env: HoldBackEnv,
  now = Date.now(),
): Promise<{ promoted: number; extended: number; halted: number }> {
  const tests = await all<{ id: string }>(
    env.DB,
    `SELECT id FROM split_tests WHERE status = 'testing' AND decide_at <= ?1 ORDER BY decide_at LIMIT 20`,
    now,
  );
  const samples = await all<{ id: string }>(
    env.DB,
    `SELECT id FROM cohort_samples WHERE status = 'sampling' AND decide_at <= ?1 ORDER BY decide_at LIMIT 20`,
    now,
  );
  const result = { promoted: 0, extended: 0, halted: 0 };
  for (const { id } of tests) if (await decideSplitTest(env, id, now)) result.promoted++;
  for (const { id } of samples) {
    const outcome = await decideCohortSample(env, id, now);
    if (outcome) result[outcome]++;
  }
  return result;
}

// ---- Halt notice (send worker) -------------------------------------------------------------

/** The email to a workspace's owners and admins (and whoever started the send) on a halt. */
export async function cohortHaltNotice(
  db: D1Database,
  broadcastId: string,
): Promise<{ to: string[]; subject: string; html: string; text: string } | null> {
  const row = await first<{
    workspace_id: string;
    subject: string;
    created_by: string | null;
    channel_name: string;
    metrics_json: string | null;
  }>(
    db,
    `SELECT b.workspace_id, b.subject, b.created_by, c.name AS channel_name, s.metrics_json
       FROM broadcasts b JOIN channels c ON c.id = b.channel_id
       JOIN cohort_samples s ON s.id = b.cohort_sample_id
      WHERE b.id = ?1 AND s.status = 'halted'`,
    broadcastId,
  );
  if (!row) return null;
  const operators = await all<{ email: string }>(
    db,
    `SELECT DISTINCT o.email FROM operators o JOIN seats s ON s.operator_id = o.id
      WHERE s.workspace_id = ?1 AND (s.role IN ('owner', 'admin') OR o.id = ?2)`,
    row.workspace_id,
    row.created_by,
  );
  if (!operators.length) return null;
  const metrics = row.metrics_json ? (JSON.parse(row.metrics_json) as CohortSampleMetrics) : null;
  const reasons = metrics?.reasons.length ? metrics.reasons : ['The sample missed its thresholds.'];
  const subject = `Sending stopped after the sample: ${row.subject}`.slice(0, 200);
  const lead = `The cohort sample of “${row.subject}” in ${row.channel_name} missed its health thresholds, so the rest of the audience was not sent.`;
  return {
    to: operators.map((o) => o.email),
    subject,
    text: `${lead}\n\n${reasons.map((r) => `- ${r}`).join('\n')}\n\nThe subscribers held back stay unsent. Check the sending domain and the list before sending again.\n`,
    html: `<p>${escapeHtml(lead)}</p><ul>${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul><p>The subscribers held back stay unsent. Check the sending domain and the list before sending again.</p>`,
  };
}
