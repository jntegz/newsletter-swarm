// A rehearsal says what a real run would do. So random Flow graphs, under random inbox rules and
// several start events, go through both: the rehearsal first, then the real engine and the real send
// pipeline. Every step, its outcome and time, every hold, every email and the way the run ended must
// agree, and the rehearsal must have left the database, the queues, the outbox and the network alone.
//
//   pnpm --filter @swarm/jobs exec vitest run tests/flows-rehearse.test.ts
//   FLOW_REHEARSE_ITERATIONS=200 pnpm --filter @swarm/jobs exec vitest run tests/flows-rehearse.test.ts
//   FLOW_REHEARSE_SEED=123 FLOW_REHEARSE_ITERATIONS=1 pnpm --filter @swarm/jobs exec vitest run tests/flows-rehearse.test.ts
import { env } from 'cloudflare:test';
import {
  INBOX_HOLD_REASONS,
  newId,
  triggersOf,
  type FlowGraph,
  type FlowRehearsal,
  type FlowRehearsalAnswer,
  type FlowReentry,
  type InboxRules,
} from '@swarm/domain';
import {
  addManualSuppression,
  enrollFromEvents,
  ensureRamp,
  pauseMember,
  payloadFor,
  readOnlyView,
  recordClick,
  recordMemberEvent,
  recordOpen,
  rehearseFlow,
  runStep,
  saveInboxRules,
  sweepFlows,
  tagStatements,
  unsubscribeMember,
  RehearsalWriteError,
  type FlowStepMessage,
} from '@swarm/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '@swarm/vault/testing';
import {
  ZONES,
  below,
  mulberry32,
  pick,
  randomGraph,
  randomRules,
  type Rand,
} from './flows-fuzz-graphs';
import {
  HOUR,
  addLinkTarget,
  attachPipeline,
  dispatchId,
  harness,
  makeAdmin,
  makeTag,
  publishFlow,
  publishVersion,
  stepsOf,
  type Harness,
  type SendPipeline,
} from './flows-helpers';
import { addField, addMember, seedChannel, testFieldKeys } from './helpers';

const DEFAULT_ITERATIONS = 60;
const DEFAULT_SEED = 0x7e4e_a55e;
const iterations = Number(env.FLOW_REHEARSE_ITERATIONS) || DEFAULT_ITERATIONS;
const baseSeed = env.FLOW_REHEARSE_SEED ? Number(env.FLOW_REHEARSE_SEED) >>> 0 : DEFAULT_SEED;
const roundSeed = (round: number) => (baseSeed + Math.imul(round, 0x9e3779b9)) >>> 0;

const START = Date.UTC(2026, 10, 2, 9, 0, 0);

/** Every row of every table: what "nothing changed" is checked against. */
async function everything(): Promise<string> {
  const tables = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'
      ORDER BY name`,
  ).all<{ name: string }>();
  const results = await env.DB.batch(
    tables.results.map((t) => env.DB.prepare(`SELECT * FROM "${t.name}"`)),
  );
  return JSON.stringify(results.map((r, i) => [tables.results[i]!.name, r.results]));
}

interface Coverage {
  rounds: number;
  compared: number;
  refused: Record<string, number>;
  steps: Record<string, number>;
  emails: number;
  skippedAlreadySent: number;
  skippedAlreadyReceived: number;
  holds: Record<string, number>;
  expired: number;
  ends: Record<string, number>;
  waitsAnsweredYes: number;
  waitsTimedOut: number;
  branches: Record<string, number>;
  secondStartEvent: number;
  channelPaused: number;
  rampWaited: number;
  drafts: number;
}

const newCoverage = (): Coverage => ({
  rounds: 0,
  compared: 0,
  refused: {},
  steps: {},
  emails: 0,
  skippedAlreadySent: 0,
  skippedAlreadyReceived: 0,
  holds: {},
  expired: 0,
  ends: {},
  waitsAnsweredYes: 0,
  waitsTimedOut: 0,
  branches: {},
  secondStartEvent: 0,
  channelPaused: 0,
  rampWaited: 0,
  drafts: 0,
});

const bump = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

interface World {
  rand: Rand;
  h: Harness;
  sends: SendPipeline;
  seed: { workspaceId: string; channelId: string };
  flow: {
    id: string;
    version: number;
    graph: FlowGraph;
    reentry: FlowReentry;
    secret: string | null;
  };
  fired: number[];
  fetched: { count: number };
}

async function runRound(rand: Rand, coverage: Coverage) {
  const seed = await seedChannel();
  const fetched = { count: 0 };
  const h = harness(START + below(rand, 72) * HOUR, {
    fetch: async () => {
      fetched.count++;
      return new Response(null, { status: 204 });
    },
  });
  const sends = attachPipeline(h);
  const tags: { id: string; name: string }[] = [];
  for (const name of ['red', 'green', 'blue']) {
    tags.push({ id: await makeTag(seed.channelId, name), name });
  }
  const levelId = newId('membershipLevel', START);
  await env.DB.prepare(
    `INSERT INTO membership_levels (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, 'Pro', ?3, ?3)`,
  )
    .bind(levelId, seed.channelId, START)
    .run();
  const refs = {
    tags,
    levelId,
    fieldId: await addField(seed.channelId, 'company', 'text'),
    operatorId: await makeAdmin(seed.workspaceId, `admin-${levelId.slice(-12)}@ops.example`),
  };
  const timezoneField = await addField(seed.channelId, 'timezone', 'text');

  let rules: InboxRules | null = null;
  const channelZone = pick(rand, ZONES);
  if (rand() < 0.8) {
    rules = randomRules(rand);
    await saveInboxRules(env.DB, seed.channelId, { rules, timezone: channelZone }, h.clock.now);
  }

  // What a branch or a start event can ask, including what the run itself changes along the way.
  const condition = (r: Rand): unknown =>
    pick(r, [
      () => ({ field: 'tag', cmp: 'eq', value: pick(r, tags).name }),
      () => ({ field: 'tag', cmp: 'eq', value: pick(r, tags).name }),
      () => ({ field: 'field:company', cmp: 'eq', value: pick(r, ['Acme', 'Globex']) }),
      () => ({ field: 'level', cmp: 'is_set' }),
      () => ({ field: 'opened_days', cmp: 'within_days', value: 30 }),
      () => ({ field: 'clicked_days', cmp: 'not_within_days', value: 30 }),
      () => ({
        op: 'and',
        children: [
          { field: 'tag', cmp: 'eq', value: pick(r, tags).name },
          { field: 'status', cmp: 'eq', value: 'active' },
        ],
      }),
      () => ({
        op: 'or',
        children: [
          { field: 'tag', cmp: 'eq', value: pick(r, tags).name },
          { field: 'tag', cmp: 'eq', value: pick(r, tags).name },
        ],
      }),
    ])();

  // The start events: one or several, each with its own filter or none.
  const withFilter = (config: Record<string, unknown>) =>
    rand() < 0.3 ? { ...config, filter: condition(rand) } : config;
  const fireTag = pick(rand, tags);
  const first = withFilter(
    rand() < 0.3 ? { event: 'tag_added', tagId: fireTag.id } : { event: 'api_event', name: 'go' },
  );
  const also = rand() < 0.5;
  const trigger = also
    ? {
        ...first,
        // Two of one type, told apart by their filters: the first that lets them in starts the run.
        alsoStartOn:
          rand() < 0.3
            ? [
                {
                  event: 'api_event',
                  name: 'also',
                  filter: { field: 'tag', cmp: 'eq', value: 'red' },
                },
                {
                  event: 'api_event',
                  name: 'also',
                  filter: { field: 'tag', cmp: 'eq', value: 'green' },
                },
              ]
            : [withFilter({ event: 'api_event', name: 'also' })],
      }
    : first;

  // A second Flow enrol_flow can point at. It sends nothing and changes nothing, because a rehearsal
  // says it would start but doesn't follow it; that limit is stated in the product.
  const webhookSecretEnc = rand() < 0.9 ? await encrypt(testFieldKeys, 'whsec') : null;
  const target = await publishFlow(seed, {
    schema: 1,
    nodes: [
      { id: 'trigger', type: 'trigger', config: { event: 'api_event', name: 'enrolled_only' } },
      { id: 'done', type: 'exit', config: {} },
    ],
    edges: [{ from: 'trigger', to: 'done', label: 'default' }],
  } as FlowGraph);
  const graph = randomGraph(rand, trigger, { ...refs, targetFlowId: target.flowId }, { condition });
  const reentry: FlowReentry = rand() < 0.5 ? 'never' : 'after_exit';
  const published = await publishFlow(seed, graph, { reentry, webhookSecretEnc });
  for (const id of Object.values(published.broadcasts)) await addLinkTarget(id);

  // Sometimes a small warm-up, so a send can wait for tomorrow.
  const useRamp = rand() < 0.25;
  if (useRamp) {
    const ramp = await ensureRamp(env.DB, seed.channelId, null, h.clock.now);
    await env.DB.prepare('UPDATE reputation_ramps SET cap_today = ?1 WHERE id = ?2')
      .bind(1 + below(rand, 3), ramp.id)
      .run();
    for (const id of Object.values(published.broadcasts)) {
      await env.DB.prepare('UPDATE broadcasts SET ramp_id = ?1 WHERE id = ?2')
        .bind(ramp.id, id)
        .run();
    }
  }

  // Sometimes a post around now, for the newsletter day rule.
  if (rand() < 0.5) {
    const at = h.clock.now + (below(rand, 48) - 24) * HOUR;
    await env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, publish_at, kind, audience_json, created_at, updated_at)
       VALUES (?1, ?2, 'Post', '{"type":"doc","content":[]}', 'scheduled', ?3, 'broadcast', '{"include":[],"exclude":[]}', ?4, ?4)`,
    )
      .bind(dispatchId(), seed.channelId, at, h.clock.now)
      .run();
  }

  const world: World = {
    rand,
    h,
    sends,
    seed,
    flow: {
      id: published.flowId,
      version: 1,
      graph,
      reentry,
      secret: webhookSecretEnc,
    },
    fired: [],
    fetched,
  };

  const size = 2 + below(rand, 3);
  for (let i = 0; i < size; i++) {
    const memberId = await addMember(
      seed.channelId,
      `r-${crypto.randomUUID()}@example.com`,
      rand() < 0.5 ? { firstName: 'Ada' } : {},
    );
    if (rand() < 0.5) {
      await env.DB.batch(tagStatements(env.DB, memberId, [pick(rand, tags).id], h.clock.now));
    }
    if (rand() < 0.4) {
      await env.DB.prepare(
        `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at) VALUES (?1, ?2, 'paid', 'comp', 0)`,
      )
        .bind(memberId, seed.channelId)
        .run();
    }
    // Emails from other runs, a post they just got and an email held in front: what the rules weigh.
    if (rand() < 0.5) {
      const emails = 1 + below(rand, 4);
      for (let e = 0; e < emails; e++) {
        const broadcast = await pastBroadcast(seed, h.clock.now - below(rand, 6 * 24) * HOUR);
        await env.DB.prepare(
          `INSERT INTO flow_email_ledger (member_id, broadcast_id, channel_id, send_regardless, sent_at)
           VALUES (?1, ?2, ?3, 0, ?4)`,
        )
          .bind(memberId, broadcast.id, seed.channelId, broadcast.at)
          .run();
      }
    }
    if (rand() < 0.25) {
      const broadcast = await pastBroadcast(seed, h.clock.now - below(rand, 30) * HOUR);
      await env.DB.prepare(
        `INSERT INTO broadcast_recipients (broadcast_id, member_id, email, status)
         SELECT ?1, id, email, 'sent' FROM members WHERE id = ?2`,
      )
        .bind(broadcast.id, memberId)
        .run();
    }
    if (rand() < 0.15) {
      const at = h.clock.now + (1 + below(rand, 30)) * HOUR;
      const heldRun = newId('flowRun', h.clock.now);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO flow_runs (id, flow_id, version, channel_id, member_id, status, current_node_id,
             next_at, context_json, test, started_at, updated_at)
           VALUES (?1, ?2, 1, ?3, ?4, 'waiting', 'trigger', ?5, '{}', 0, ?6, ?6)`,
        ).bind(heldRun, target.flowId, seed.channelId, memberId, at, h.clock.now),
        env.DB.prepare(
          `INSERT INTO flow_holds (run_id, node_id, flow_id, version, channel_id, member_id, reason, until, zone, held_at)
           VALUES (?1, 'trigger', ?2, 1, ?3, ?4, 'quiet_hours', ?5, 'UTC', ?6)`,
        ).bind(heldRun, target.flowId, seed.channelId, memberId, at, h.clock.now),
      ]);
    }
    if (rand() < 0.3) {
      await env.DB.prepare(
        `INSERT INTO member_field_values (member_id, field_id, value_text, updated_at) VALUES (?1, ?2, ?3, ?4)`,
      )
        .bind(memberId, timezoneField, pick(rand, ZONES), h.clock.now)
        .run();
    }
    const change = rand();
    if (change < 0.07) await unsubscribeMember(env.DB, memberId, 'test', h.clock.now);
    else if (change < 0.14) await pauseMember(env.DB, memberId, 2, h.clock.now);
    else if (change < 0.2) {
      const row = await env.DB.prepare('SELECT email FROM members WHERE id = ?1')
        .bind(memberId)
        .first<{ email: string }>();
      await addManualSuppression(env.DB, {
        workspaceId: seed.workspaceId,
        channelId: null,
        email: row!.email,
        now: h.clock.now,
      });
    }
    // A paused publication: the run waits at its first email until someone brings it back.
    if (i === 0 && rand() < 0.25) {
      await env.DB.prepare(`UPDATE channels SET status = 'paused' WHERE id = ?1`)
        .bind(seed.channelId)
        .run();
    }

    await compareOneEntry(world, memberId, coverage);
    if (rand() < 0.4) {
      // Comes back later, on the same or a newer version: re-entry and the repeat-send check.
      h.clock.now += (1 + below(rand, 3)) * HOUR;
      if (rand() < 0.5) {
        world.flow.version++;
        const broadcasts = await publishVersion(seed, world.flow.id, world.flow.version, graph);
        for (const id of Object.values(broadcasts)) await addLinkTarget(id);
        await env.DB.prepare('UPDATE flows SET live_version = ?1 WHERE id = ?2')
          .bind(world.flow.version, world.flow.id)
          .run();
      }
      await compareOneEntry(world, memberId, coverage);
    }
  }
}

/** A post that already went, for a ledger or recipient row to point at. */
async function pastBroadcast(seed: { workspaceId: string; channelId: string }, at: number) {
  const dispatch = dispatchId();
  const id = newId('broadcast', at);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, kind, created_at, updated_at)
       VALUES (?1, ?2, 'Post', '{"type":"doc","content":[]}', 'sent', 'broadcast', ?3, ?3)`,
    ).bind(dispatch, seed.channelId, at),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html,
         text, from_name, from_address, track_opens, snapshot_done, fanout_done, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'Post', '', '<p>Hi</p>', 'Hi', 'Notes', 'notes@mail.swarm.localhost', 1, 1, 1, ?5, ?5)`,
    ).bind(id, dispatch, seed.channelId, seed.workspaceId, at),
  ]);
  return { id, at };
}

/** The answers a writer might give: yes or no for each wait. */
function randomAnswers(rand: Rand, graph: FlowGraph): Record<string, FlowRehearsalAnswer> {
  const answers: Record<string, FlowRehearsalAnswer> = {};
  for (const node of graph.nodes) {
    if (node.type === 'wait_for_event') answers[node.id] = rand() < 0.5 ? 'yes' : 'no';
  }
  return answers;
}

async function compareOneEntry(world: World, memberId: string, coverage: Coverage) {
  const { rand, h, sends, seed, flow, fetched } = world;
  const graph = flow.graph;
  const configs = triggersOf(graph);
  const startEvent = below(rand, configs.length);
  const config = configs[startEvent]!;
  const answers = randomAnswers(rand, graph);
  const flowRow = {
    id: flow.id,
    workspace_id: seed.workspaceId,
    channel_id: seed.channelId,
    webhook_secret_enc: flow.secret,
    reentry: flow.reentry,
  };
  const input = {
    flow: flowRow,
    graph,
    source: 'live' as const,
    version: flow.version,
    memberId,
    hasFieldKeys: true,
    answers,
    startEvent,
  };
  const quiet = async <T>(rehearse: () => Promise<T>): Promise<T> => {
    const before = await everything();
    const queued = [h.jobs.items.length, sends.items.length, h.sends.messages.length];
    const handed = [sends.outbox.accepted.length, h.mail.sent.length, fetched.count];
    const result = await rehearse();
    expect(await everything(), 'a rehearsal changed the database').toBe(before);
    expect([h.jobs.items.length, sends.items.length, h.sends.messages.length]).toEqual(queued);
    expect([sends.outbox.accepted.length, h.mail.sent.length, fetched.count]).toEqual(handed);
    return result;
  };

  // What will happen when this start event's event arrives, asked before it does.
  const before = await quiet(() => rehearseFlow(env.DB, { ...input, now: h.clock.now }));

  const runsBefore = await env.DB.prepare(
    'SELECT count(*) AS n FROM flow_runs WHERE flow_id = ?1 AND member_id = ?2',
  )
    .bind(flow.id, memberId)
    .first<{ n: number }>();
  await recordMemberEvent(
    env.DB,
    {
      type: config.event,
      memberId,
      payload: payloadFor(config),
    } as Parameters<typeof recordMemberEvent>[1],
    h.clock.now,
  );
  // Only the event just fired may start a run; what the earlier steps set off stays out of it.
  const seq = await env.DB.prepare('SELECT max(seq) AS seq FROM member_events').first<{
    seq: number;
  }>();
  world.fired.push(seq!.seq);
  await processEvents(world);
  const started = await env.DB.prepare(
    `SELECT id, context_json FROM flow_runs WHERE flow_id = ?1 AND member_id = ?2
      ORDER BY started_at DESC, id DESC LIMIT 1 OFFSET 0`,
  )
    .bind(flow.id, memberId)
    .first<{ id: string; context_json: string }>();
  const runsAfter = await env.DB.prepare(
    'SELECT count(*) AS n FROM flow_runs WHERE flow_id = ?1 AND member_id = ?2',
  )
    .bind(flow.id, memberId)
    .first<{ n: number }>();
  const entered = (runsAfter?.n ?? 0) > (runsBefore?.n ?? 0);

  expect(before.entry.allowed, 'whether they enter').toBe(entered);
  if (!entered) {
    const decision = await env.DB.prepare(
      'SELECT reason FROM flow_enrol_decisions WHERE member_id = ?1 AND flow_id = ?2',
    )
      .bind(memberId, flow.id)
      .first<{ reason: string }>();
    if (before.entry.reason) expect(decision?.reason).toBe(before.entry.reason);
    bump(coverage.refused, before.entry.reason ?? 'none');
    return;
  }
  const context = JSON.parse(started!.context_json) as { trigger: { index: number } };
  expect(before.entry.startEvent, 'which start event let them in').toBe(context.trigger.index);
  if (context.trigger.index > 0) coverage.secondStartEvent++;

  // The same question with the real run's id, because A/B splits are drawn from it.
  const rehearsed = await quiet(() =>
    rehearseFlow(env.DB, { ...input, now: h.clock.now, runId: started!.id }),
  );

  // A draft with the same graph takes the same path, apart from what the warm-up delays.
  const hasRamp = await env.DB.prepare(
    `SELECT 1 AS ok FROM flow_emails fe JOIN broadcasts b ON b.id = fe.broadcast_id
      WHERE fe.flow_id = ?1 AND b.ramp_id IS NOT NULL LIMIT 1`,
  )
    .bind(flow.id)
    .first();
  if (!hasRamp) {
    const draft = await quiet(() =>
      rehearseFlow(env.DB, {
        ...input,
        source: 'draft',
        version: flow.version + 1,
        now: h.clock.now,
        runId: started!.id,
      }),
    );
    expect(draft.steps.map((s) => [s.nodeId, s.status, s.outcome])).toEqual(
      rehearsed.steps.map((s) => [s.nodeId, s.status, s.outcome]),
    );
    expect(draft.end).toEqual(rehearsed.end);
    coverage.drafts++;
  }

  const mailBefore = sends.outbox.accepted.length;
  await driveRun(world, started!.id, answers, coverage);
  await compareWithRun(world, started!.id, rehearsed, mailBefore, coverage);
}

/** Runs what the queue holds, then jumps the clock to whatever is due next, until the run is over. */
async function driveRun(
  world: World,
  runId: string,
  answers: Record<string, FlowRehearsalAnswer>,
  coverage: Coverage,
) {
  const { h, sends, seed } = world;
  const answered = new Set<string>();
  for (let guard = 0; guard < 2000; guard++) {
    // One message at a time, the send queue caught up after each, so a delivery exists by the time
    // the writer's "if they open" can happen.
    const due = h.jobs.items.findIndex((item) => item.at <= h.clock.now);
    if (due >= 0) {
      const [item] = h.jobs.items.splice(due, 1);
      const message = item!.message;
      if (message.type === 'flow_step') {
        await runStep(h.env, message as FlowStepMessage, h.clock.now);
      } else if (message.type === 'flow_events') {
        await processEvents(world);
      }
      await sends.consumeDue();
      continue;
    }
    const run = await env.DB.prepare(
      'SELECT status, current_node_id, next_at, wait_json FROM flow_runs WHERE id = ?1',
    )
      .bind(runId)
      .first<{
        status: string;
        current_node_id: string;
        next_at: number | null;
        wait_json: string | null;
      }>();
    const parked = await env.DB.prepare(
      `SELECT json_extract(result_json, '$.deferred') AS deferred FROM flow_run_steps
        WHERE run_id = ?1 AND node_id = ?2 AND status = 'pending'`,
    )
      .bind(runId, run!.current_node_id)
      .first<{ deferred: string | null }>();
    if (parked?.deferred === 'channel_paused') {
      // Someone brings the publication back; the run sees it at its next look.
      await env.DB.prepare(`UPDATE channels SET status = 'active' WHERE id = ?1`)
        .bind(seed.channelId)
        .run();
      coverage.channelPaused++;
    }
    if (run!.status === 'waiting' && run!.wait_json) {
      const wait = JSON.parse(run!.wait_json) as {
        node: string;
        event: 'open' | 'click';
        broadcastId: string;
      };
      if (answers[wait.node] === 'yes' && !answered.has(wait.node)) {
        answered.add(wait.node);
        await engage(world, runId, wait);
        if (h.jobs.items.some((item) => item.at <= h.clock.now)) continue;
      }
    }
    const open = await env.DB.prepare(
      `SELECT min(next_at) AS at FROM flow_runs WHERE channel_id = ?1 AND status IN ('running', 'waiting')`,
    )
      .bind(seed.channelId)
      .first<{ at: number | null }>();
    if (open?.at === null || open?.at === undefined) {
      if (!h.jobs.items.length) return;
      h.clock.now = Math.max(h.clock.now, Math.min(...h.jobs.items.map((i) => i.at)));
      continue;
    }
    h.clock.now = Math.max(h.clock.now, open.at);
    await sweepFlows(h.env, h.clock.now);
  }
  throw new Error('the run did not finish');
}

/** The Member does what the writer's answer said, if the email reached them. */
async function engage(
  world: World,
  runId: string,
  wait: { event: 'open' | 'click'; broadcastId: string },
) {
  const { h } = world;
  const member = await env.DB.prepare('SELECT member_id FROM flow_runs WHERE id = ?1')
    .bind(runId)
    .first<{ member_id: string }>();
  const delivery = await env.DB.prepare(
    `SELECT d.id, d.broadcast_id, d.sent_at, l.id AS link FROM deliveries d
       LEFT JOIN link_targets l ON l.broadcast_id = d.broadcast_id
      WHERE d.member_id = ?1 AND d.broadcast_id = ?2 LIMIT 1`,
  )
    .bind(member!.member_id, wait.broadcastId)
    .first<{ id: string; broadcast_id: string; sent_at: number; link: string | null }>();
  if (!delivery) return;
  const signals = {
    method: 'GET',
    userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    asn: null,
    asOrganization: null,
    ip: null,
  };
  if (wait.event === 'open') {
    await recordOpen(env.DB, delivery.id, signals, h.clock.now);
  } else {
    await recordClick(
      env.DB,
      {
        deliveryId: delivery.id,
        linkTargetId: delivery.link!,
        broadcastId: delivery.broadcast_id,
        sentAt: delivery.sent_at,
      },
      signals,
      h.clock.now + 5000,
    );
  }
  await processEvents(world);
}

/**
 * Events are handled, but only start events the test fired and the opens and clicks it caused. A
 * rehearsal says plainly that it doesn't follow other automations a step's own events might start.
 */
async function processEvents(world: World) {
  const keep = world.fired.length ? (world.fired.pop() as number) : -1;
  await env.DB.prepare(
    `UPDATE member_events SET processed_at = ?1
      WHERE processed_at IS NULL AND seq <> ?2 AND type NOT IN ('email_opened', 'link_clicked')`,
  )
    .bind(world.h.clock.now, keep)
    .run();
  await enrollFromEvents(world.h.env, world.h.clock.now);
}

async function compareWithRun(
  world: World,
  runId: string,
  rehearsed: FlowRehearsal,
  mailBefore: number,
  coverage: Coverage,
) {
  const realSteps = await stepsOf(runId);
  const finished = await env.DB.prepare(
    `SELECT node_id, finished_at, status FROM flow_run_steps WHERE run_id = ?1 ORDER BY rowid`,
  )
    .bind(runId)
    .all<{ node_id: string; finished_at: number | null; status: string }>();
  const run = await env.DB.prepare('SELECT status, exit_reason FROM flow_runs WHERE id = ?1')
    .bind(runId)
    .first<{ status: string; exit_reason: string | null }>();

  // The path: each step, how it finished, and the edge it left by.
  expect(rehearsed.steps.map((s) => [s.nodeId, s.status, s.outcome])).toEqual(
    realSteps.map((s) => [s.node_id, s.status, s.outcome]),
  );
  // When: the same clock, step by step, since every wait here took its time.
  expect(rehearsed.steps.map((s) => Date.parse(s.at))).toEqual(
    finished.results.map((s) => s.finished_at),
  );
  // How it ended.
  expect({ status: rehearsed.end.status, reason: rehearsed.end.reason }).toEqual({
    status: run!.status,
    reason: run!.exit_reason,
  });

  // The emails: what a rehearsal says goes out is what the provider was handed.
  const wouldSend = rehearsed.steps.filter(
    (s) => s.detail.kind === 'email' && s.detail.state === 'would_send',
  );
  const sendNodes = new Set(
    world.flow.graph.nodes.filter((n) => n.type === 'send_email').map((n) => n.id),
  );
  const realSent = realSteps.filter(
    (s) =>
      sendNodes.has(s.node_id) &&
      s.status === 'done' &&
      s.result_json !== null &&
      (JSON.parse(s.result_json) as { broadcastId?: string }).broadcastId,
  );
  expect(wouldSend.map((s) => s.nodeId)).toEqual(realSent.map((s) => s.node_id));
  expect(world.sends.outbox.accepted.length - mailBefore).toBe(wouldSend.length);

  // The inbox rules: the last hold of each step, its reason and its time, and how it ended.
  const holds = await env.DB.prepare(
    'SELECT node_id, reason, until, outcome FROM flow_holds WHERE run_id = ?1 ORDER BY held_at, node_id',
  )
    .bind(runId)
    .all<{ node_id: string; reason: string; until: number; outcome: string | null }>();
  const rehearsedHolds = rehearsed.steps.flatMap((s) => {
    if (s.detail.kind !== 'email') return [];
    const rules = s.detail.holds.filter((h) =>
      (INBOX_HOLD_REASONS as readonly string[]).includes(h.reason),
    );
    const last = rules.at(-1);
    return last ? [[s.nodeId, last.reason, Date.parse(last.until as string)]] : [];
  });
  expect(rehearsedHolds).toEqual(holds.results.map((h) => [h.node_id, h.reason, h.until]));

  // Keep count of what was really compared, so a test that exercises nothing can't pass.
  coverage.compared++;
  bump(coverage.ends, `${run!.status}:${run!.exit_reason ?? ''}`);
  coverage.emails += wouldSend.length;
  for (const step of rehearsed.steps) {
    bump(coverage.steps, step.type);
    const { detail } = step;
    if (detail.kind === 'email') {
      if (detail.state === 'already_sent') coverage.skippedAlreadySent++;
      if (detail.state === 'already_received') coverage.skippedAlreadyReceived++;
      for (const hold of detail.holds) {
        bump(coverage.holds, hold.reason);
        if (hold.expired) coverage.expired++;
        if (hold.reason === 'ramp_full') coverage.rampWaited++;
      }
    }
    if (detail.kind === 'wait') {
      if (detail.answer === 'yes') coverage.waitsAnsweredYes++;
      else coverage.waitsTimedOut++;
    }
    if (detail.kind === 'branch') {
      bump(coverage.branches, String(detail.matched));
      // The reason given can't contradict the path.
      expect(detail.because.length).toBeGreaterThan(0);
    }
  }
}

describe('Rehearse: a rehearsal agrees with the real engine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    `over ${iterations} random rounds from seed ${baseSeed}`,
    async () => {
      const coverage = newCoverage();
      for (let i = 0; i < iterations; i++) {
        const seed = roundSeed(i);
        const rand = mulberry32(seed);
        const idRand = mulberry32(seed ^ 0xa5a5a5a5);
        vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
          const bytes = array as unknown as Uint8Array;
          for (let b = 0; b < bytes.length; b++) bytes[b] = below(idRand, 256);
          return array;
        });
        try {
          await runRound(rand, coverage);
          coverage.rounds++;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Rehearsal comparison failed with seed ${seed}. Replay with:\n  FLOW_REHEARSE_SEED=${seed} FLOW_REHEARSE_ITERATIONS=1 pnpm --filter @swarm/jobs exec vitest run tests/flows-rehearse.test.ts\n\n${message}`,
            { cause: error },
          );
        }
      }
      console.log(`rehearse comparison: seed ${baseSeed}, ${JSON.stringify(coverage)}`);
      if (iterations >= DEFAULT_ITERATIONS) {
        expect(coverage.compared).toBeGreaterThan(iterations / 2);
        expect(coverage.emails).toBeGreaterThan(0);
        expect(coverage.waitsAnsweredYes).toBeGreaterThan(0);
        expect(coverage.waitsTimedOut).toBeGreaterThan(0);
        expect(coverage.branches.true).toBeGreaterThan(0);
        expect(coverage.branches.false).toBeGreaterThan(0);
        expect(coverage.secondStartEvent).toBeGreaterThan(0);
        expect(coverage.drafts).toBeGreaterThan(0);
        expect(Object.keys(coverage.refused).length).toBeGreaterThan(1);
        // The inbox rules really held emails, and some waited too long.
        expect(Object.keys(coverage.holds).length).toBeGreaterThan(2);
        expect(coverage.expired).toBeGreaterThan(0);
        expect(coverage.channelPaused).toBeGreaterThan(0);
        expect(coverage.rampWaited).toBeGreaterThan(0);
        expect(coverage.skippedAlreadySent + coverage.skippedAlreadyReceived).toBeGreaterThan(0);
      }
    },
    Math.max(120_000, iterations * 15_000),
  );
});

describe('Rehearse: inbox rules, in so many words', () => {
  const start = Date.UTC(2026, 10, 2, 23, 0, 0);
  const oneEmail = (): FlowGraph =>
    ({
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'api_event', name: 'go' } },
        { id: 'mail', type: 'send_email', config: { dispatchId: dispatchId(), audience: 'any' } },
      ],
      edges: [{ from: 'trigger', to: 'mail', label: 'default' }],
    }) as FlowGraph;

  async function setup(rules: Partial<InboxRules>) {
    const seed = await seedChannel();
    await saveInboxRules(
      env.DB,
      seed.channelId,
      {
        rules: {
          perDay: null,
          perWeek: null,
          quietHours: null,
          newsletterDay: null,
          maxHoldDays: 14,
          ...rules,
        },
        timezone: 'UTC',
      },
      start,
    );
    const graph = oneEmail();
    const flow = await publishFlow(seed, graph);
    const memberId = await addMember(seed.channelId, `h-${crypto.randomUUID()}@example.com`);
    const rehearse = () =>
      rehearseFlow(env.DB, {
        flow: {
          id: flow.flowId,
          workspace_id: seed.workspaceId,
          channel_id: seed.channelId,
          webhook_secret_enc: null,
          reentry: 'never',
        },
        graph,
        source: 'live',
        version: 1,
        memberId,
        now: start,
        hasFieldKeys: true,
      });
    return { rehearse, seed, memberId };
  }

  it('shows the hold and the time, then the email going out', async () => {
    const { rehearse } = await setup({ quietHours: { start: '22:00', end: '08:00' } });
    const result = await rehearse();
    const mail = result.steps[1]!;
    expect(mail.detail).toMatchObject({
      kind: 'email',
      state: 'would_send',
      holds: [
        {
          reason: 'quiet_hours',
          until: '2026-11-03T08:00:00.000Z',
          expired: false,
          zone: 'UTC',
        },
      ],
    });
    expect(mail.at).toBe('2026-11-03T08:00:00.000Z');
    expect(result.end.status).toBe('completed');
  });

  it('says when the wait is too long, and that they exit', async () => {
    const { rehearse, seed, memberId } = await setup({ perWeek: 1, maxHoldDays: 1 });
    const earlier = await pastBroadcast(seed, start - 3_600_000);
    await env.DB.prepare(
      `INSERT INTO flow_email_ledger (member_id, broadcast_id, channel_id, send_regardless, sent_at)
       VALUES (?1, ?2, ?3, 0, ?4)`,
    )
      .bind(memberId, earlier.id, seed.channelId, earlier.at)
      .run();
    const result = await rehearse();
    expect(result.end).toEqual({ status: 'exited', reason: 'hold_expired', problem: null });
    expect(result.steps[1]!.detail).toMatchObject({ state: 'not_sent' });
  });
});

describe('Rehearse: values the run itself writes', () => {
  it('regression: reads back a field value no SQL literal can carry', async () => {
    const start = Date.UTC(2026, 10, 2, 9, 0, 0);
    const seed = await seedChannel();
    const fieldId = await addField(seed.channelId, 'company', 'text');
    // A NUL ends a quoted literal in SQLite; a bound value carries it, as the real run's write does.
    const value = "O'Brien\u0000 & Co";
    const graph = {
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'api_event', name: 'go' } },
        { id: 'set', type: 'update_field', config: { fieldId, value } },
        {
          id: 'check',
          type: 'branch',
          config: { condition: { field: 'field:company', cmp: 'eq', value } },
        },
        { id: 'yes', type: 'exit', config: {} },
      ],
      edges: [
        { from: 'trigger', to: 'set', label: 'default' },
        { from: 'set', to: 'check', label: 'default' },
        { from: 'check', to: 'yes', label: 'true' },
      ],
    } as unknown as FlowGraph;
    const flow = await publishFlow(seed, graph);
    const memberId = await addMember(seed.channelId, `v-${crypto.randomUUID()}@example.com`);
    const result = await rehearseFlow(env.DB, {
      flow: {
        id: flow.flowId,
        workspace_id: seed.workspaceId,
        channel_id: seed.channelId,
        webhook_secret_enc: null,
        reentry: 'never',
      },
      graph,
      source: 'live',
      version: 1,
      memberId,
      now: start,
      hasFieldKeys: true,
    });
    expect(result.steps.map((step) => step.nodeId)).toEqual(['trigger', 'set', 'check', 'yes']);
  });
});

describe('Rehearse: start events', () => {
  it('imagines every kind of start event so that it matches', async () => {
    const { matchesTrigger } = await import('@swarm/engine');
    const configs: Record<string, unknown>[] = [
      { event: 'member_joined' },
      { event: 'member_joined', formId: 'x' },
      { event: 'form_submitted', formId: 'x' },
      { event: 'confirmed' },
      { event: 'circle_entered', circleId: 'x' },
      { event: 'circle_exited', circleId: 'x' },
      { event: 'tag_added', tagId: 'x' },
      { event: 'tag_removed', tagId: 'x' },
      { event: 'field_changed', fieldId: 'x' },
      { event: 'level_purchased' },
      { event: 'level_canceled', levelId: 'x' },
      { event: 'ask_answered', askId: 'x', optionId: 'y' },
      { event: 'unengaged', days: 60 },
      { event: 'link_clicked', url: 'https://example.com/' },
      { event: 'gate_hit', dispatchId: 'x' },
      { event: 'api_event', name: 'go' },
      { event: 'roster_joined', rosterId: 'x' },
      { event: 'roster_left', rosterId: 'x' },
      { event: 'referral_succeeded' },
      { event: 'referral_milestone', milestoneId: 'x' },
    ];
    for (const config of configs) {
      const typed = config as Parameters<typeof payloadFor>[0];
      expect(matchesTrigger(typed, typed.event, payloadFor(typed)), typed.event).toBe(true);
    }
  });
});

describe('Rehearse: the read-only view', () => {
  it('refuses anything that writes', async () => {
    const view = readOnlyView(env.DB);
    for (const sql of [
      'INSERT INTO tags (id) VALUES (1)',
      'UPDATE tags SET name = 1',
      'DELETE FROM tags',
      'REPLACE INTO tags (id) VALUES (1)',
      'DROP TABLE tags',
      'WITH x AS (SELECT 1) DELETE FROM tags',
      'PRAGMA foreign_keys = OFF',
    ]) {
      expect(() => view.prepare(sql), sql).toThrow(RehearsalWriteError);
    }
    expect(() => view.batch([])).toThrow(RehearsalWriteError);
    expect(() => view.exec('SELECT 1')).toThrow(RehearsalWriteError);
    expect(await view.prepare('SELECT 1 AS ok').first()).toEqual({ ok: 1 });
  });
});
