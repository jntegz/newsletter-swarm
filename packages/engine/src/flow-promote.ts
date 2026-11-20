/**
 * Welcome A/B auto-promotion (Phase 6). An ab_split node with `autoPromote` compares the two
 * send_email nodes directly behind its 'a' and 'b' edges on the live version. Once the version
 * has been live `afterHours` and both Flow Broadcasts have `minPerVariant` delivered messages,
 * the winner is picked with pickSplitTestWinner (highest human open or click rate, then most
 * delivered, then A) and a new version is published in which the split node is REPLACED BY A
 * DIRECT EDGE to the winner: edges into the split lead to the winning node, and nodes that are
 * no longer reachable (the losing branch) are dropped. A direct edge is used rather than
 * percentA 100 because ab_split keeps both arms by contract (percentA 1–99) and the engine needs
 * no special case.
 *
 * The new version carries the frozen Flow Broadcasts of the kept send nodes forward (a copy of
 * the html, text, sender and link targets), so the winner sends exactly what was measured and
 * no renderer or engine config is needed in the jobs worker. Runs already on the old version
 * finish there (pinned). The draft graph gets the same edit when it still contains the split.
 * Audited as the system (actor null): flow.split_promoted.
 */
import { appendAudit, isUniqueViolation } from '@swarm/db';
import {
  FlowGraphSchema,
  nextNodeId,
  pickSplitTestWinner,
  extraTriggerTypes,
  triggerOf,
  validateFlowGraph,
  type FlowGraph,
  type FlowNodeOf,
  type SplitTestVariantMetrics,
} from '@swarm/domain';
import { all, first, newIdFor } from './db';
import { closeRetiredFlowBroadcasts } from './flow-publish';
import { OLD_TEST_SENDS_SQL } from './stats';

/**
 * The graph with ab_split `splitId` replaced by a direct edge to the node behind `winner`
 * (edges into the split are re-pointed; unreachable nodes and their edges are dropped).
 */
export function replaceSplitWithWinner(
  graph: FlowGraph,
  splitId: string,
  winner: 'a' | 'b',
): FlowGraph {
  const target = nextNodeId(graph, splitId, winner);
  const edges = graph.edges
    .filter((e) => e.from !== splitId)
    .flatMap((e) => (e.to !== splitId ? [e] : target ? [{ ...e, to: target }] : []));
  const nodes = graph.nodes.filter((n) => n.id !== splitId);
  const trigger = nodes.find((n) => n.type === 'trigger');
  const reached = new Set(trigger ? [trigger.id] : []);
  const queue = [...reached];
  while (queue.length) {
    const from = queue.shift()!;
    for (const e of edges) {
      if (e.from === from && !reached.has(e.to)) {
        reached.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return {
    ...graph,
    nodes: nodes.filter((n) => reached.has(n.id)),
    edges: edges.filter((e) => reached.has(e.from) && reached.has(e.to)),
  };
}

/** Human opens or clicks of one Flow Broadcast, counted once per Member. */
async function variantMetrics(
  db: D1Database,
  broadcastId: string,
  metric: 'opens' | 'clicks',
): Promise<{ delivered: number; value: number }> {
  const row = await first<{ sent: number; bounced: number; delivered: number; value: number }>(
    db,
    `SELECT coalesce(sum(status <> 'failed'), 0) AS sent,
            coalesce(sum(status = 'bounced'), 0) AS bounced,
            coalesce(sum(status IN ('delivered', 'complained')), 0) AS delivered,
            coalesce(sum(${metric === 'opens' ? 'human_opened_at' : 'human_clicked_at'} IS NOT NULL), 0) AS value
       FROM deliveries WHERE broadcast_id = ?1 AND ifnull(member_id, '') NOT IN ${OLD_TEST_SENDS_SQL}`,
    broadcastId,
  );
  if (!row) return { delivered: 0, value: 0 };
  // As in broadcastStats: a sent message that hasn't bounced counts as delivered.
  return { delivered: Math.max(row.delivered, row.sent - row.bounced), value: row.value };
}

export interface SplitPromotion {
  flowId: string;
  splitNodeId: string;
  winner: 'a' | 'b';
  winnerNodeId: string;
  fromVersion: number;
  toVersion: number;
  metric: 'opens' | 'clicks';
  variants: SplitTestVariantMetrics[];
}

interface LiveFlow {
  id: string;
  workspace_id: string;
  live_version: number;
  draft_graph_json: string;
  graph_json: string;
  published_at: number;
}

/**
 * Promotes the winner of every ready auto-promote split on live Flows (a bounded batch per
 * call). Deterministic for the same data. Returns what it promoted.
 */
export async function promoteWelcomeSplits(
  db: D1Database,
  now: number,
  limit = 50,
): Promise<SplitPromotion[]> {
  const flows = await all<LiveFlow>(
    db,
    `SELECT f.id, f.workspace_id, f.live_version, f.draft_graph_json, v.graph_json, v.published_at
       FROM flows f JOIN flow_versions v ON v.flow_id = f.id AND v.version = f.live_version
      WHERE f.status = 'live' AND f.deleted_at IS NULL AND v.retired_at IS NULL
        AND instr(v.graph_json, '"autoPromote"') > 0
      ORDER BY f.id LIMIT ?1`,
    limit,
  );
  const done: SplitPromotion[] = [];
  for (const flow of flows) {
    const parsed = FlowGraphSchema.safeParse(JSON.parse(flow.graph_json));
    if (!parsed.success) continue;
    let graph = parsed.data;
    const promotions: SplitPromotion[] = [];
    const splits = graph.nodes.filter(
      (n): n is FlowNodeOf<'ab_split'> => n.type === 'ab_split' && !!n.config.autoPromote,
    );
    for (const split of splits) {
      const rule = split.config.autoPromote!;
      if (now - flow.published_at < rule.afterHours * 3_600_000) continue;
      // Only the original graph's arms are measured; a split removed by an earlier promotion
      // in this pass is skipped.
      if (!graph.nodes.some((n) => n.id === split.id)) continue;
      const arms = (['a', 'b'] as const).map((label) => {
        const nodeId = nextNodeId(parsed.data, split.id, label);
        const node = parsed.data.nodes.find((n) => n.id === nodeId);
        return { label, node: node?.type === 'send_email' ? node : undefined };
      });
      if (arms.some((arm) => !arm.node)) continue;
      const variants: SplitTestVariantMetrics[] = [];
      for (const arm of arms) {
        const email = await first<{ broadcast_id: string }>(
          db,
          'SELECT broadcast_id FROM flow_emails WHERE flow_id = ?1 AND version = ?2 AND node_id = ?3',
          flow.id,
          flow.live_version,
          arm.node!.id,
        );
        if (!email) break;
        const m = await variantMetrics(db, email.broadcast_id, rule.metric);
        variants.push({
          variantId: arm.node!.id,
          label: arm.label === 'a' ? 'A' : 'B',
          delivered: m.delivered,
          value: m.value,
        });
      }
      if (variants.length !== 2 || variants.some((v) => v.delivered < rule.minPerVariant)) {
        continue;
      }
      const best = pickSplitTestWinner(variants)!;
      const winner = best.label === 'A' ? 'a' : 'b';
      graph = replaceSplitWithWinner(graph, split.id, winner);
      promotions.push({
        flowId: flow.id,
        splitNodeId: split.id,
        winner,
        winnerNodeId: best.variantId,
        fromVersion: flow.live_version,
        toVersion: flow.live_version + 1,
        metric: rule.metric,
        variants,
      });
    }
    if (!promotions.length || validateFlowGraph(graph).length) continue;
    if (await publishPromoted(db, flow, graph, promotions, now)) done.push(...promotions);
  }
  return done;
}

/** Writes the promoted version, carrying the kept Flow Broadcasts forward. */
async function publishPromoted(
  db: D1Database,
  flow: LiveFlow,
  graph: FlowGraph,
  promotions: SplitPromotion[],
  now: number,
): Promise<boolean> {
  const version = flow.live_version + 1;
  const trigger = triggerOf(graph)!;
  const extras = extraTriggerTypes(graph);
  const extrasJson = extras ? JSON.stringify(extras) : null;
  const kept = await all<{ node_id: string; dispatch_id: string; broadcast_id: string }>(
    db,
    'SELECT node_id, dispatch_id, broadcast_id FROM flow_emails WHERE flow_id = ?1 AND version = ?2',
    flow.id,
    flow.live_version,
  );
  const sendNodes = new Set(graph.nodes.filter((n) => n.type === 'send_email').map((n) => n.id));
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO flow_versions (flow_id, version, graph_json, trigger_type, extra_trigger_types,
           published_by, published_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)`,
      )
      .bind(flow.id, version, JSON.stringify(graph), trigger.config.event, extrasJson, now),
  ];
  for (const email of kept.filter((e) => sendNodes.has(e.node_id))) {
    const broadcastId = newIdFor('broadcast', now);
    statements.push(
      db
        .prepare(
          `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
             from_name, from_address, reply_to, sending_domain_id, ramp_id, track_opens, created_by, created_at,
             last_progress_at, audience_json, teaser_html, teaser_text, gate_level_ids_json, kind, flow_id,
             track_clicks)
           SELECT ?1, dispatch_id, channel_id, workspace_id, 'sending', subject, preheader, html, text,
             from_name, from_address, reply_to, sending_domain_id, ramp_id, track_opens, NULL, ?3,
             ?3, audience_json, teaser_html, teaser_text, gate_level_ids_json, 'flow', flow_id,
             track_clicks
             FROM broadcasts WHERE id = ?2`,
        )
        .bind(broadcastId, email.broadcast_id, now),
    );
    const links = await all<{ url: string; position: number }>(
      db,
      'SELECT url, position FROM link_targets WHERE broadcast_id = ?1 ORDER BY position',
      email.broadcast_id,
    );
    for (const link of links) {
      statements.push(
        db
          .prepare(
            'INSERT INTO link_targets (id, broadcast_id, url, position) VALUES (?1, ?2, ?3, ?4)',
          )
          .bind(newIdFor('linkTarget', now), broadcastId, link.url, link.position),
      );
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO flow_emails (flow_id, version, node_id, dispatch_id, broadcast_id, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(flow.id, version, email.node_id, email.dispatch_id, broadcastId, now),
    );
  }

  // The draft gets the same edit when it still has the split (and stays valid in shape).
  let draft = flow.draft_graph_json;
  try {
    let next = JSON.parse(draft) as FlowGraph;
    for (const p of promotions) {
      if (next.nodes.some((n) => n.id === p.splitNodeId && n.type === 'ab_split')) {
        next = replaceSplitWithWinner(next, p.splitNodeId, p.winner);
      }
    }
    draft = JSON.stringify(next);
  } catch {
    // An unreadable draft is left alone.
  }

  statements.push(
    db
      .prepare(
        'UPDATE flow_versions SET retired_at = ?1 WHERE flow_id = ?2 AND version <> ?3 AND retired_at IS NULL',
      )
      .bind(now, flow.id, version),
    db
      .prepare(
        `UPDATE flows SET live_version = ?1, trigger_type = ?2, extra_trigger_types = ?7,
                draft_graph_json = ?3, updated_at = ?4
          WHERE id = ?5 AND status = 'live' AND live_version = ?6`,
      )
      .bind(version, trigger.config.event, draft, now, flow.id, flow.live_version, extrasJson),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    // Someone published at the same moment: the next run looks again.
    if (isUniqueViolation(error)) return false;
    throw error;
  }
  for (const p of promotions) {
    await appendAudit(db, {
      workspaceId: flow.workspace_id,
      actorId: null,
      action: 'flow.split_promoted',
      targetType: 'flow',
      targetId: flow.id,
      metadata: {
        splitNodeId: p.splitNodeId,
        winner: p.winner,
        winnerNodeId: p.winnerNodeId,
        metric: p.metric,
        fromVersion: p.fromVersion,
        toVersion: version,
        variants: p.variants.map((v) => ({
          nodeId: v.variantId,
          label: v.label,
          delivered: v.delivered,
          value: v.value,
        })),
      },
    });
  }
  await closeRetiredFlowBroadcasts(db, flow.id, now);
  return true;
}
