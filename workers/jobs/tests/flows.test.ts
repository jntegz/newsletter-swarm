// The Flows engine (Phase 6) against real D1: enrolment, steps, delays and the sweep, waits,
// retries, versions, the send gate, and a property test over random graphs.
import { env } from 'cloudflare:test';
import {
  FLOW_NODE_OUTPUTS,
  FlowGraphSchema,
  QUEUE_MAX_DELAY_SECONDS,
  flowStepBackoffSeconds,
  newId,
  nextNodeId,
  validateFlowGraph,
  type FlowGraph,
} from '@swarm/domain';
import {
  checkUnengaged,
  OUTBOUND_WAIT_MS_PER_MINUTE,
  enrollFromEvents,
  migrateRuns,
  recordMemberEvent,
  runStep,
  startFlowRun,
  sweepFlows,
  webhookSignature,
  webhookUrlProblem,
} from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { encrypt } from '@swarm/vault/testing';
import { addMember, count, one, seedChannel, testFieldKeys } from './helpers';
import {
  DAY,
  HOUR,
  dispatchId,
  harness,
  makeAdmin,
  makeTag,
  publishFlow,
  publishVersion,
  recipientsOf,
  runsOf,
  stepsOf,
  type Harness,
} from './flows-helpers';

type RawNode = { id: string; type: string; config: Record<string, unknown> };
type RawEdge = { from: string; to: string; label?: string };

const graph = (nodes: RawNode[], edges: RawEdge[]): FlowGraph =>
  FlowGraphSchema.parse({ schema: 1, nodes, edges });

/** trigger → a → b → … in a line. */
const line = (trigger: Record<string, unknown>, ...steps: RawNode[]): FlowGraph =>
  graph(
    [{ id: 'trigger', type: 'trigger', config: trigger }, ...steps],
    ['trigger', ...steps.map((s) => s.id)]
      .slice(0, -1)
      .map((from, i) => ({ from, to: steps[i]!.id })),
  );

const api = (name = 'go') => ({ event: 'api_event', name });

const fire = (h: Harness, memberId: string, name = 'go') =>
  recordMemberEvent(env.DB, { type: 'api_event', memberId, payload: { name } }, h.clock.now);

const email = () => `m-${crypto.randomUUID()}@example.com`;

const hasTag = async (memberId: string, tagId: string) =>
  (await count(
    'SELECT count(*) AS n FROM member_tags WHERE member_id = ?1 AND tag_id = ?2',
    memberId,
    tagId,
  )) > 0;

/** Enrols from pending events, then runs every due message. */
async function settle(h: Harness) {
  await enrollFromEvents(h.env, h.clock.now);
  await h.drain();
}

describe('Flows: enrolment', () => {
  it('matches trigger config and the enrolment filter, skips imports, paused and archived Flows', async () => {
    const seed = await seedChannel();
    const h = harness();
    const tag = await makeTag(seed.channelId);
    const formId = newId('captureForm');
    await env.DB.prepare(
      `INSERT INTO capture_forms (id, workspace_id, channel_id, name, draft_config_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Footer', '{}', 0, 0)`,
    )
      .bind(formId, seed.workspaceId, seed.channelId)
      .run();
    const welcome = line(
      {
        event: 'member_joined',
        filter: { field: 'first_name', cmp: 'eq', value: 'Ada' },
      },
      { id: 'tag', type: 'add_tag', config: { tagId: tag } },
    );
    const live = await publishFlow(seed, welcome);
    const paused = await publishFlow(seed, welcome, { status: 'paused' });
    const archived = await publishFlow(seed, welcome, { status: 'archived' });
    const byForm = await publishFlow(
      seed,
      line(
        { event: 'member_joined', formId },
        { id: 'tag', type: 'add_tag', config: { tagId: tag } },
      ),
    );

    const ada = await addMember(seed.channelId, email(), { firstName: 'Ada' });
    const bob = await addMember(seed.channelId, email(), { firstName: 'Bob' });
    const imported = await addMember(seed.channelId, email(), { firstName: 'Ada' });
    const now = h.clock.now;
    await recordMemberEvent(
      env.DB,
      {
        type: 'member_joined',
        memberId: ada,
        payload: { source: 'form', formId, status: 'active' },
      },
      now,
    );
    await recordMemberEvent(
      env.DB,
      { type: 'member_joined', memberId: bob, payload: { source: 'operator', status: 'active' } },
      now,
    );
    await recordMemberEvent(
      env.DB,
      {
        type: 'member_joined',
        memberId: imported,
        payload: { source: 'import', status: 'active' },
      },
      now,
    );
    await settle(h);

    const runs = await runsOf(live.flowId);
    expect(runs.map((r) => [r.status, r.current_node_id])).toEqual([['completed', 'tag']]);
    expect(await hasTag(ada, tag)).toBe(true);
    expect(await hasTag(bob, tag)).toBe(false);
    expect(await hasTag(imported, tag)).toBe(false);
    expect(await runsOf(paused.flowId)).toEqual([]);
    expect(await runsOf(archived.flowId)).toEqual([]);
    // formId: only Ada joined through the form.
    expect((await runsOf(byForm.flowId)).map((r) => r.status)).toEqual(['completed']);
    // Every event was stamped.
    expect(
      await count(
        "SELECT count(*) AS n FROM member_events WHERE member_id IN (?1, ?2, ?3) AND type = 'member_joined' AND processed_at IS NULL",
        ada,
        bob,
        imported,
      ),
    ).toBe(0);
  });

  it('enrols imported Members only with includeImports', async () => {
    const seed = await seedChannel();
    const h = harness();
    const tag = await makeTag(seed.channelId);
    const flow = await publishFlow(
      seed,
      line(
        { event: 'member_joined', includeImports: true },
        { id: 't', type: 'add_tag', config: { tagId: tag } },
      ),
    );
    const m = await addMember(seed.channelId, email());
    await recordMemberEvent(
      env.DB,
      { type: 'member_joined', memberId: m, payload: { source: 'import', status: 'active' } },
      h.clock.now,
    );
    await settle(h);
    expect((await runsOf(flow.flowId)).length).toBe(1);
  });

  it('applies re-entry rules and the one-open-run rule', async () => {
    const seed = await seedChannel();
    const h = harness();
    const tag = await makeTag(seed.channelId);
    const quick = line(api(), { id: 't', type: 'add_tag', config: { tagId: tag } });
    const slow = line(api(), {
      id: 'wait',
      type: 'delay',
      config: { mode: 'duration', amount: 2, unit: 'hours' },
    });
    const never = await publishFlow(seed, quick, { reentry: 'never' });
    const again = await publishFlow(seed, quick, { reentry: 'after_exit' });
    const open = await publishFlow(seed, slow, { reentry: 'after_exit' });
    const m = await addMember(seed.channelId, email());
    await fire(h, m);
    await settle(h);
    await fire(h, m);
    await settle(h);
    expect((await runsOf(never.flowId)).length).toBe(1);
    expect((await runsOf(again.flowId)).map((r) => r.status)).toEqual(['completed', 'completed']);
    // The first run of the slow Flow is still waiting, so the second event doesn't enrol.
    expect((await runsOf(open.flowId)).map((r) => r.status)).toEqual(['waiting']);
    // Processing the same events twice never doubles a run.
    await env.DB.prepare('UPDATE member_events SET processed_at = NULL WHERE member_id = ?1')
      .bind(m)
      .run();
    await settle(h);
    expect((await runsOf(again.flowId)).length).toBe(2);
  });

  it('starts test runs regardless of re-entry and the Flow status', async () => {
    const seed = await seedChannel();
    const h = harness();
    const tag = await makeTag(seed.channelId);
    const flow = await publishFlow(
      seed,
      line(api(), { id: 't', type: 'add_tag', config: { tagId: tag } }),
      {
        status: 'draft',
      },
    );
    const m = await addMember(seed.channelId, email());
    const other = await seedChannel();
    const stranger = await addMember(other.channelId, email());
    const start = (memberId: string, channelId = seed.channelId) =>
      startFlowRun(h.env, {
        flowId: flow.flowId,
        version: 1,
        memberId,
        channelId,
        test: true,
        now: h.clock.now,
      });
    expect(await start(m)).toMatch(/^fr_/);
    await h.drain();
    expect(await start(m)).toMatch(/^fr_/);
    await h.drain();
    expect(await start(stranger)).toBeNull();
    expect(await start(stranger, other.channelId)).toBeNull();
    const runs = await runsOf(flow.flowId);
    expect(runs.map((r) => r.status)).toEqual(['completed', 'completed']);
    expect(await hasTag(m, tag)).toBe(true);
  });
});

describe('Flows: sending', () => {
  it('sends once per node and stops when the Member unsubscribes mid-Flow', async () => {
    const seed = await seedChannel();
    const h = harness();
    const flow = await publishFlow(
      seed,
      line(
        api(),
        { id: 'first', type: 'send_email', config: { dispatchId: dispatchId() } },
        { id: 'pause', type: 'delay', config: { mode: 'duration', amount: 2, unit: 'hours' } },
        { id: 'second', type: 'send_email', config: { dispatchId: dispatchId() } },
      ),
      { reentry: 'after_exit' },
    );
    const stays = await addMember(seed.channelId, email());
    const leaves = await addMember(seed.channelId, email());
    await fire(h, stays);
    await fire(h, leaves);
    await settle(h);
    expect(h.sends.for(leaves)).toEqual([
      { type: 'batch', broadcastId: flow.broadcasts.first, memberIds: [leaves] },
    ]);
    await env.DB.prepare("UPDATE members SET status = 'unsubscribed' WHERE id = ?1")
      .bind(leaves)
      .run();
    await h.advance(3 * HOUR);

    const [left] = await runsOf(flow.flowId, leaves);
    expect([left!.status, left!.exit_reason]).toEqual(['exited', 'member_inactive']);
    expect(await recipientsOf(leaves)).toEqual([flow.broadcasts.first]);
    expect((await runsOf(flow.flowId, stays))[0]!.status).toBe('completed');
    expect(h.sends.for(stays).map((m) => m.type === 'batch' && m.broadcastId)).toEqual([
      flow.broadcasts.first,
      flow.broadcasts.second,
    ]);
    const recipients = await one<{ recipient_count: number }>(
      'SELECT recipient_count FROM broadcasts WHERE id = ?1',
      flow.broadcasts.first,
    );
    expect(recipients?.recipient_count).toBe(2);

    // Re-entering the same version skips emails already sent.
    await fire(h, stays);
    await settle(h);
    await h.advance(3 * HOUR);
    expect(h.sends.for(stays)).toHaveLength(2);
    const second = (await runsOf(flow.flowId, stays))[1]!;
    expect(
      (await stepsOf(second.id)).filter((s) => s.status === 'skipped').map((s) => s.node_id),
    ).toEqual(['first', 'second']);
  });

  it('starts nothing and runs no further step once the Channel is deleted', async () => {
    const seed = await seedChannel();
    const h = harness();
    const first = await makeTag(seed.channelId);
    const later = await makeTag(seed.channelId);
    const flow = await publishFlow(
      seed,
      line(
        api(),
        { id: 'tag', type: 'add_tag', config: { tagId: first } },
        { id: 'pause', type: 'delay', config: { mode: 'duration', amount: 2, unit: 'hours' } },
        { id: 'tag2', type: 'add_tag', config: { tagId: later } },
      ),
      { reentry: 'after_exit' },
    );
    const waiting = await addMember(seed.channelId, email());
    await fire(h, waiting);
    await settle(h);
    expect(await hasTag(waiting, first)).toBe(true);

    await env.DB.prepare('UPDATE channels SET deleted_at = ?1 WHERE id = ?2')
      .bind(h.clock.now, seed.channelId)
      .run();
    const newcomer = await addMember(seed.channelId, email());
    await fire(h, newcomer);
    await settle(h);
    await h.advance(3 * HOUR);

    // The waiting run went no further, and nobody new was enrolled.
    expect(await hasTag(waiting, later)).toBe(false);
    const [run] = await runsOf(flow.flowId, waiting);
    expect([run!.status, run!.exit_reason]).toEqual(['exited', 'flow_archived']);
    expect(await runsOf(flow.flowId, newcomer)).toEqual([]);
    expect(await hasTag(newcomer, first)).toBe(false);
  });

  it('exits on suppression and on lost entitlement for paid-only emails', async () => {
    const seed = await seedChannel();
    const h = harness();
    const flow = await publishFlow(
      seed,
      line(
        api(),
        { id: 'paid', type: 'send_email', config: { dispatchId: dispatchId(), audience: 'paid' } },
        { id: 'wait', type: 'delay', config: { mode: 'duration', amount: 1, unit: 'hours' } },
        { id: 'paid2', type: 'send_email', config: { dispatchId: dispatchId(), audience: 'paid' } },
      ),
    );
    const free = await addMember(seed.channelId, email());
    const paid = await addMember(seed.channelId, email());
    const suppressed = await addMember(seed.channelId, email());
    for (const m of [paid, suppressed]) {
      await env.DB.prepare(
        `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at) VALUES (?1, ?2, 'paid', 'comp', 0)`,
      )
        .bind(m, seed.channelId)
        .run();
    }
    for (const m of [free, paid, suppressed]) await fire(h, m);
    await settle(h);
    expect((await runsOf(flow.flowId, free))[0]!.exit_reason).toBe('not_entitled');
    expect(await recipientsOf(free)).toEqual([]);
    expect(await recipientsOf(paid)).toEqual([flow.broadcasts.paid]);

    await env.DB.prepare('DELETE FROM member_entitlements WHERE member_id = ?1').bind(paid).run();
    const address = await one<{ email: string }>(
      'SELECT email FROM members WHERE id = ?1',
      suppressed,
    );
    await env.DB.prepare(
      `INSERT INTO suppressions (id, workspace_id, email, reason, created_at) VALUES (?1, ?2, ?3, 'complaint', ?4)`,
    )
      .bind(newId('suppression'), seed.workspaceId, address!.email, h.clock.now)
      .run();
    await h.advance(2 * HOUR);
    expect((await runsOf(flow.flowId, paid))[0]!.exit_reason).toBe('not_entitled');
    expect((await runsOf(flow.flowId, suppressed))[0]!.exit_reason).toBe('suppressed');
    expect(await recipientsOf(paid)).toEqual([flow.broadcasts.paid]);
    expect(await recipientsOf(suppressed)).toEqual([flow.broadcasts.paid]);
  });
});

describe('Flows: delays, the sweep and versions', () => {
  it('queues short delays, keeps long ones for the sweep, and never asks the queue for more than 12 hours', async () => {
    const seed = await seedChannel();
    const h = harness();
    const tag = await makeTag(seed.channelId);
    const flow = await publishFlow(
      seed,
      line(
        api(),
        { id: 'short', type: 'delay', config: { mode: 'duration', amount: 2, unit: 'hours' } },
        { id: 'long', type: 'delay', config: { mode: 'duration', amount: 20, unit: 'days' } },
        { id: 'tag', type: 'add_tag', config: { tagId: tag } },
      ),
    );
    const m = await addMember(seed.channelId, email());
    await fire(h, m);
    await settle(h);
    expect(h.jobs.delays).toContain(7200);
    await h.advance(3 * HOUR);
    const [parked] = await runsOf(flow.flowId);
    expect([parked!.status, parked!.current_node_id]).toEqual(['waiting', 'long']);
    expect(parked!.next_at).toBeGreaterThan(h.clock.now + 19 * DAY);
    await h.advance(19 * DAY, 6 * HOUR);
    expect(await hasTag(m, tag)).toBe(false);
    await h.advance(2 * DAY, 6 * HOUR);
    expect(await hasTag(m, tag)).toBe(true);
    expect((await runsOf(flow.flowId))[0]!.status).toBe('completed');
    expect(Math.max(...h.jobs.delays)).toBeLessThanOrEqual(QUEUE_MAX_DELAY_SECONDS);
    // The delay step was 'pending' while parked and is 'done' now; nothing failed.
    expect((await stepsOf(parked!.id)).map((s) => [s.node_id, s.status])).toEqual([
      ['trigger', 'done'],
      ['short', 'done'],
      ['long', 'done'],
      ['tag', 'done'],
    ]);
  });

  it('waits until a weekday and time in the Member’s time zone', async () => {
    const seed = await seedChannel();
    // 2026-10-28 is a Wednesday. 12:00 UTC.
    const h = harness(Date.UTC(2026, 9, 28, 12, 0));
    const tag = await makeTag(seed.channelId);
    const flow = await publishFlow(
      seed,
      line(
        api(),
        {
          id: 'friday',
          type: 'delay',
          config: { mode: 'until', weekdays: [5], time: '09:00', timezone: 'member' },
        },
        { id: 'tag', type: 'add_tag', config: { tagId: tag } },
      ),
    );
    const fieldId = newId('memberField');
    await env.DB.prepare(
      `INSERT INTO member_fields (id, channel_id, key, label, type, options_json, encrypted, created_at, updated_at)
       VALUES (?1, ?2, 'timezone', 'Time zone', 'text', '[]', 0, 0, 0)`,
    )
      .bind(fieldId, seed.channelId)
      .run();
    const m = await addMember(seed.channelId, email());
    await env.DB.prepare(
      `INSERT INTO member_field_values (member_id, field_id, value_text, updated_at) VALUES (?1, ?2, 'America/New_York', 0)`,
    )
      .bind(m, fieldId)
      .run();
    const utc = await addMember(seed.channelId, email());
    await fire(h, m);
    await fire(h, utc);
    await settle(h);
    // Friday 2026-10-30 09:00 in New York is 13:00 UTC (EDT); in UTC it is 09:00.
    expect((await runsOf(flow.flowId, m))[0]!.next_at).toBe(Date.UTC(2026, 9, 30, 13, 0));
    expect((await runsOf(flow.flowId, utc))[0]!.next_at).toBe(Date.UTC(2026, 9, 30, 9, 0));
  });

  it('claims a due run once even when two sweeps race', async () => {
    const seed = await seedChannel();
    const h = harness();
    await publishFlow(
      seed,
      line(api(), {
        id: 'd',
        type: 'delay',
        config: { mode: 'duration', amount: 15, unit: 'days' },
      }),
    );
    const m = await addMember(seed.channelId, email());
    await fire(h, m);
    await settle(h);
    const [run] = await env.DB.prepare('SELECT id FROM flow_runs WHERE member_id = ?1')
      .bind(m)
      .all<{ id: string }>()
      .then((r) => r.results);
    h.jobs.items.length = 0;
    const later = h.clock.now + 16 * DAY;
    await Promise.all([sweepFlows(h.env, later), sweepFlows(h.env, later)]);
    const mine = h.jobs.items.filter(
      (i) => i.message.type === 'flow_step' && i.message.runId === run!.id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.message).toMatchObject({ nodeId: 'd', attempt: 1 });
  });

  it('keeps runs on their version, and migrateRuns moves or exits them', async () => {
    const seed = await seedChannel();
    const h = harness();
    const [tagA, tagB, tagOld] = [
      await makeTag(seed.channelId),
      await makeTag(seed.channelId),
      await makeTag(seed.channelId),
    ];
    const day = { mode: 'duration', amount: 1, unit: 'days' };
    const v1 = graph(
      [
        { id: 'trigger', type: 'trigger', config: api() },
        {
          id: 'split',
          type: 'branch',
          config: { condition: { field: 'first_name', cmp: 'eq', value: 'Ada' } },
        },
        { id: 'wait1', type: 'delay', config: day },
        { id: 'old', type: 'delay', config: day },
        { id: 'tagA', type: 'add_tag', config: { tagId: tagA } },
        { id: 'tagOld', type: 'add_tag', config: { tagId: tagOld } },
      ],
      [
        { from: 'trigger', to: 'split' },
        { from: 'split', to: 'wait1', label: 'true' },
        { from: 'split', to: 'old', label: 'false' },
        { from: 'wait1', to: 'tagA' },
        { from: 'old', to: 'tagOld' },
      ],
    );
    const v2 = line(
      api(),
      { id: 'wait1', type: 'delay', config: day },
      { id: 'tagB', type: 'add_tag', config: { tagId: tagB } },
    );
    const flow = await publishFlow(seed, v1);
    const pinned = await addMember(seed.channelId, email(), { firstName: 'Ada' });
    const ada = await addMember(seed.channelId, email(), { firstName: 'Ada' });
    const bob = await addMember(seed.channelId, email(), { firstName: 'Bob' });
    for (const m of [pinned, ada, bob]) await fire(h, m);
    await settle(h);

    // Publish v2. Runs stay on v1 unless migrated.
    await publishVersion(seed, flow.flowId, 2, v2);
    await env.DB.batch([
      env.DB.prepare('UPDATE flows SET live_version = 2 WHERE id = ?1').bind(flow.flowId),
      env.DB.prepare(
        'UPDATE flow_versions SET retired_at = ?1 WHERE flow_id = ?2 AND version = 1',
      ).bind(h.clock.now, flow.flowId),
    ]);
    const fresh = await addMember(seed.channelId, email(), { firstName: 'Ada' });
    await fire(h, fresh);
    await settle(h);

    // migrateRuns moves every open v1 run, so `pinned` is set aside to show that a run left on
    // v1 finishes there: Ada's run (at wait1, which v2 keeps) moves, Bob's (at old) exits.
    await env.DB.prepare('UPDATE flow_runs SET version = 99 WHERE member_id = ?1')
      .bind(pinned)
      .run();
    const result = await migrateRuns(h.env, flow.flowId, 1, 2, h.clock.now);
    expect(result).toEqual({ moved: 1, exited: 1 });
    await env.DB.prepare('UPDATE flow_runs SET version = 1 WHERE member_id = ?1')
      .bind(pinned)
      .run();

    await h.advance(2 * DAY, 6 * HOUR);
    expect([await hasTag(pinned, tagA), await hasTag(pinned, tagB)]).toEqual([true, false]);
    expect([await hasTag(ada, tagA), await hasTag(ada, tagB)]).toEqual([false, true]);
    expect([await hasTag(fresh, tagA), await hasTag(fresh, tagB)]).toEqual([false, true]);
    const [bobRun] = await runsOf(flow.flowId, bob);
    expect([bobRun!.status, bobRun!.exit_reason]).toEqual(['exited', 'migrated']);
    expect(await hasTag(bob, tagOld)).toBe(false);
  });
});

describe('Flows: a forged step message (S04-P1-V-job-handler-review)', () => {
  it('an attempt the run has not reached runs nothing', async () => {
    const seed = await seedChannel();
    const calls: Request[] = [];
    const h = harness(Date.now(), {
      fetch: async (input, init) => {
        calls.push(new Request(input, init));
        return new Response('nope', { status: 500 });
      },
    });
    const keys = testFieldKeys;
    const flow = await publishFlow(
      seed,
      line(api(), {
        id: 'hook',
        type: 'webhook_call',
        config: { url: 'https://hooks.example.com/f' },
      }),
      { webhookSecretEnc: await encrypt(keys, 'whsec_test') },
    );
    const m = await addMember(seed.channelId, email());
    await fire(h, m);
    await settle(h);
    const [run] = await runsOf(flow.flowId);
    const before = calls.length;
    expect(before).toBeGreaterThan(0);
    // Long after any retry was due, a message naming the right run and node but attempt 99.
    await runStep(
      h.env,
      { type: 'flow_step', runId: run!.id, nodeId: 'hook', attempt: 99 },
      h.clock.now + DAY,
    );
    expect(calls).toHaveLength(before);
    expect((await stepsOf(run!.id)).some((s) => s.attempt === 99)).toBe(false);
    // Out of the way of later tests' sweeps, which share the database.
    await env.DB.prepare("UPDATE flow_runs SET status = 'exited' WHERE id = ?1")
      .bind(run!.id)
      .run();
  });
});

describe('Flows: failures', () => {
  it('retries with backoff, then pauses the run and notifies the admins once', async () => {
    const seed = await seedChannel();
    const calls: Request[] = [];
    const h = harness(Date.now(), {
      fetch: async (input, init) => {
        calls.push(new Request(input, init));
        return new Response('nope', { status: 500 });
      },
    });
    await makeAdmin(seed.workspaceId, `admin-${crypto.randomUUID()}@example.com`);
    const keys = testFieldKeys;
    const flow = await publishFlow(
      seed,
      line(api(), {
        id: 'hook',
        type: 'webhook_call',
        config: { url: 'https://hooks.example.com/x' },
      }),
      { webhookSecretEnc: await encrypt(keys, 'whsec_test') },
    );
    const m = await addMember(seed.channelId, email());
    await fire(h, m);
    await settle(h);
    await h.advance(HOUR, 30_000);
    const [run] = await runsOf(flow.flowId);
    expect([run!.status, run!.exit_reason]).toEqual(['paused', 'step_failed']);
    const steps = (await stepsOf(run!.id)).filter((s) => s.node_id === 'hook');
    expect(steps.map((s) => [s.attempt, s.status])).toEqual(
      [1, 2, 3, 4, 5].map((a) => [a, 'failed']),
    );
    expect(steps.every((s) => s.error?.includes('500'))).toBe(true);
    expect(calls).toHaveLength(5);
    for (const attempt of [1, 2, 3, 4]) {
      expect(h.jobs.delays).toContain(flowStepBackoffSeconds(attempt));
    }
    expect(h.mail.sent.filter((mail) => mail.category === 'flow_paused')).toHaveLength(1);
    // Paused runs stay put through later sweeps.
    await h.advance(2 * HOUR, 30 * 60_000);
    expect(calls).toHaveLength(5);
    expect(h.mail.sent).toHaveLength(1);
  });

  it('waits for the next minute when the workspace has used its share of waiting on endpoints', async () => {
    const seed = await seedChannel();
    const calls: string[] = [];
    const start = Date.now();
    const h = harness(start, {
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(null, { status: 204 });
      },
    });
    const keys = testFieldKeys;
    const flow = await publishFlow(
      seed,
      line(api(), {
        id: 'hook',
        type: 'webhook_call',
        config: { url: 'https://hooks.example.com/s' },
      }),
      { webhookSecretEnc: await encrypt(keys, 'whsec_share') },
    );
    // Its endpoints (any of them, Event Webhooks too) already cost this minute's share.
    await env.DB.prepare(
      `INSERT INTO usage_windows (scope, window_start, count) VALUES (?1, ?2, ?3)
       ON CONFLICT (scope) DO UPDATE SET window_start = excluded.window_start, count = excluded.count`,
    )
      .bind(
        `outbound_wait:${seed.workspaceId}`,
        start - (start % 60_000),
        OUTBOUND_WAIT_MS_PER_MINUTE,
      )
      .run();
    const m = await addMember(seed.channelId, email());
    await fire(h, m);
    await settle(h);
    expect(calls).toHaveLength(0);
    const [waiting] = await runsOf(flow.flowId);
    expect(waiting!.status).toBe('waiting');
    // Next minute: the step runs, without having used an attempt.
    await h.advance(2 * 60_000, 30_000);
    expect(calls).toEqual(['https://hooks.example.com/s']);
    const [run] = await runsOf(flow.flowId);
    expect(run!.status).toBe('completed');
    const steps = (await stepsOf(run!.id)).filter((s) => s.node_id === 'hook');
    expect(steps.map((s) => [s.attempt, s.status])).toEqual([[1, 'done']]);
  });

  it('signs webhooks and refuses non-https and private URLs', async () => {
    const seed = await seedChannel();
    const calls: { url: string; headers: Headers; body: string }[] = [];
    const h = harness(Date.now(), {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push({ url: request.url, headers: request.headers, body: await request.text() });
        return new Response(null, { status: 204 });
      },
    });
    const keys = testFieldKeys;
    const secret = 'whsec_signing';
    const flow = await publishFlow(
      seed,
      line(api(), {
        id: 'hook',
        type: 'webhook_call',
        config: { url: 'https://hooks.example.com/in' },
      }),
      { webhookSecretEnc: await encrypt(keys, secret) },
    );
    const m = await addMember(seed.channelId, email(), { firstName: 'Ada' });
    await fire(h, m);
    await settle(h);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    const signature = call!.headers.get('Swarm-Signature')!;
    const t = Number(/^t=(\d+),v1=[0-9a-f]{64}$/.exec(signature)![1]);
    expect(signature).toBe(await webhookSignature(secret, t, call!.body));
    const [run] = await runsOf(flow.flowId);
    expect(call!.headers.get('Swarm-Webhook-Id')).toBe(`${run!.id}:hook`);
    expect(JSON.parse(call!.body)).toMatchObject({
      flowId: flow.flowId,
      runId: run!.id,
      nodeId: 'hook',
      member: { id: m, firstName: 'Ada' },
    });
    expect(run!.status).toBe('completed');

    expect(webhookUrlProblem('http://hooks.example.com/in')).toMatch(/https/);
    for (const url of [
      'https://localhost/x',
      'https://10.1.2.3/x',
      'https://[::1]/x',
      'https://192.168.0.4/',
      'https://intranet/',
    ]) {
      expect(webhookUrlProblem(url)).not.toBeNull();
    }
    expect(webhookUrlProblem('https://hooks.example.com/in')).toBeNull();

    // A private address is refused without a call, and pauses the run at once.
    const privateFlow = await publishFlow(
      seed,
      line(api('private'), {
        id: 'hook',
        type: 'webhook_call',
        config: { url: 'https://127.0.0.1/hook' },
      }),
      { webhookSecretEnc: await encrypt(keys, secret) },
    );
    await fire(h, m, 'private');
    await settle(h);
    expect(calls).toHaveLength(1);
    const [refused] = await runsOf(privateFlow.flowId);
    expect([refused!.status, refused!.exit_reason]).toEqual(['paused', 'step_failed']);
  });

  it('exits with invalid_reference when a node points at another Channel', async () => {
    const seed = await seedChannel();
    const other = await seedChannel();
    const h = harness();
    const foreignTag = await makeTag(other.channelId);
    const flow = await publishFlow(
      seed,
      line(api(), { id: 't', type: 'add_tag', config: { tagId: foreignTag } }),
    );
    const m = await addMember(seed.channelId, email());
    await fire(h, m);
    await settle(h);
    const [run] = await runsOf(flow.flowId);
    expect([run!.status, run!.exit_reason]).toEqual(['exited', 'invalid_reference']);
    expect(await hasTag(m, foreignTag)).toBe(false);
  });
});

describe('Flows: waits, enrolment in other Flows, levels and engagement', () => {
  async function deliver(broadcastId: string, memberId: string, channelId: string) {
    const id = newId('delivery');
    await env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at)
       SELECT ?1, ?2, ?3, ?4, email, 'sent', ?5 FROM members WHERE id = ?4`,
    )
      .bind(id, broadcastId, channelId, memberId, Date.now())
      .run();
    return id;
  }

  it('takes the default edge on an open or a matching click, and the timeout edge otherwise', async () => {
    const seed = await seedChannel();
    const h = harness();
    const [opened, timedOut] = [await makeTag(seed.channelId), await makeTag(seed.channelId)];
    const flowGraph = (event: 'open' | 'click', name: string) =>
      graph(
        [
          { id: 'trigger', type: 'trigger', config: api(name) },
          { id: 'mail', type: 'send_email', config: { dispatchId: dispatchId() } },
          {
            id: 'wait',
            type: 'wait_for_event',
            config: {
              event,
              sendNodeId: 'mail',
              timeoutHours: 48,
              ...(event === 'click' ? { url: 'https://example.com/a' } : {}),
            },
          },
          { id: 'yes', type: 'add_tag', config: { tagId: opened } },
          { id: 'no', type: 'add_tag', config: { tagId: timedOut } },
        ],
        [
          { from: 'trigger', to: 'mail' },
          { from: 'mail', to: 'wait' },
          { from: 'wait', to: 'yes', label: 'default' },
          { from: 'wait', to: 'no', label: 'timeout' },
        ],
      );
    const openFlow = await publishFlow(seed, flowGraph('open', 'open'));
    const clickFlow = await publishFlow(seed, flowGraph('click', 'click'));
    const reader = await addMember(seed.channelId, email());
    const silent = await addMember(seed.channelId, email());
    const clicker = await addMember(seed.channelId, email());
    await fire(h, reader, 'open');
    await fire(h, silent, 'open');
    await fire(h, clicker, 'click');
    await settle(h);
    expect((await runsOf(openFlow.flowId, reader))[0]!.status).toBe('waiting');

    // The reader opens: the event wakes the wait.
    const delivery = await deliver(openFlow.broadcasts.mail!, reader, seed.channelId);
    await env.DB.prepare('UPDATE deliveries SET human_opened_at = ?1 WHERE id = ?2')
      .bind(h.clock.now, delivery)
      .run();
    await recordMemberEvent(
      env.DB,
      {
        type: 'email_opened',
        memberId: reader,
        payload: { dispatchId: 'dp_x', broadcastId: openFlow.broadcasts.mail! },
      },
      h.clock.now,
    );

    // The clicker clicks another link first, then the awaited one.
    const click = (url: string) =>
      recordMemberEvent(
        env.DB,
        {
          type: 'link_clicked',
          memberId: clicker,
          payload: {
            url,
            dispatchId: 'dp_x',
            broadcastId: clickFlow.broadcasts.mail!,
            linkTargetId: 'lt_x',
          },
        },
        h.clock.now,
      );
    await click('https://example.com/other');
    await settle(h);
    expect((await runsOf(clickFlow.flowId, clicker))[0]!.status).toBe('waiting');
    await click('https://example.com/a');
    await settle(h);

    expect(await hasTag(reader, opened)).toBe(true);
    expect(await hasTag(clicker, opened)).toBe(true);
    expect(await hasTag(silent, opened)).toBe(false);
    await h.advance(49 * HOUR, 6 * HOUR);
    expect(await hasTag(silent, timedOut)).toBe(true);
    expect(await hasTag(reader, timedOut)).toBe(false);
    const silentRun = (await runsOf(openFlow.flowId, silent))[0]!;
    expect((await stepsOf(silentRun.id)).find((s) => s.node_id === 'wait')?.outcome).toBe(
      'timeout',
    );
  });

  it('resolves a wait at once when the open happened before it started', async () => {
    const seed = await seedChannel();
    const h = harness();
    const yes = await makeTag(seed.channelId);
    const flow = await publishFlow(
      seed,
      line(
        api(),
        { id: 'mail', type: 'send_email', config: { dispatchId: dispatchId() } },
        { id: 'pause', type: 'delay', config: { mode: 'duration', amount: 1, unit: 'hours' } },
        { id: 'wait', type: 'wait_for_event', config: { event: 'open', timeoutHours: 24 } },
        { id: 'yes', type: 'add_tag', config: { tagId: yes } },
      ),
    );
    const m = await addMember(seed.channelId, email());
    await fire(h, m);
    await settle(h);
    const delivery = await deliver(flow.broadcasts.mail!, m, seed.channelId);
    await env.DB.prepare('UPDATE deliveries SET human_opened_at = ?1 WHERE id = ?2')
      .bind(h.clock.now, delivery)
      .run();
    await h.advance(2 * HOUR);
    expect(await hasTag(m, yes)).toBe(true);
  });

  it('enrols the Member in another live Flow', async () => {
    const seed = await seedChannel();
    const h = harness();
    const tag = await makeTag(seed.channelId);
    const target = await publishFlow(
      seed,
      line(api('never_fired'), { id: 't', type: 'add_tag', config: { tagId: tag } }),
    );
    const source = await publishFlow(
      seed,
      line(api(), { id: 'enrol', type: 'enrol_flow', config: { flowId: target.flowId } }),
    );
    const m = await addMember(seed.channelId, email());
    await fire(h, m);
    await settle(h);
    const [run] = await runsOf(target.flowId, m);
    expect(run!.status).toBe('completed');
    expect(JSON.parse(run!.context_json).enrolledBy.flowId).toBe(source.flowId);
    expect(await hasTag(m, tag)).toBe(true);
  });

  it('grants and revokes a comp level', async () => {
    const seed = await seedChannel();
    const h = harness();
    const levelId = newId('membershipLevel');
    await env.DB.prepare(
      `INSERT INTO membership_levels (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, 'Pro', 0, 0)`,
    )
      .bind(levelId, seed.channelId)
      .run();
    await publishFlow(
      seed,
      line(
        api(),
        { id: 'grant', type: 'change_level', config: { action: 'grant', levelId, days: 30 } },
        { id: 'wait', type: 'delay', config: { mode: 'duration', amount: 1, unit: 'hours' } },
        { id: 'revoke', type: 'change_level', config: { action: 'revoke', levelId } },
      ),
    );
    const m = await addMember(seed.channelId, email());
    await fire(h, m);
    await settle(h);
    const entitlement = await one<{ level_id: string; source: string }>(
      "SELECT level_id, source FROM member_entitlements WHERE member_id = ?1 AND kind = 'paid'",
      m,
    );
    expect(entitlement).toEqual({ level_id: levelId, source: 'comp' });
    expect(await count('SELECT count(*) AS n FROM comp_grants WHERE member_id = ?1', m)).toBe(1);
    await h.advance(2 * HOUR);
    expect(await one('SELECT 1 AS x FROM member_entitlements WHERE member_id = ?1', m)).toBeNull();
    expect(
      await count(
        'SELECT count(*) AS n FROM comp_grants WHERE member_id = ?1 AND revoked_at IS NOT NULL',
        m,
      ),
    ).toBe(1);
  });

  it('emits unengaged once per stretch of silence and enrols from it', async () => {
    const seed = await seedChannel();
    const h = harness();
    const tag = await makeTag(seed.channelId);
    const flow = await publishFlow(
      seed,
      line({ event: 'unengaged', days: 30 }, { id: 't', type: 'add_tag', config: { tagId: tag } }),
    );
    const quiet = await addMember(seed.channelId, email());
    const engaged = await addMember(seed.channelId, email());
    const newcomer = await addMember(seed.channelId, email());
    const longAgo = h.clock.now - 40 * DAY;
    await env.DB.prepare(
      'UPDATE members SET created_at = ?1, confirmed_at = ?1 WHERE id IN (?2, ?3)',
    )
      .bind(longAgo, quiet, engaged)
      .run();
    const broadcast = await publishFlow(
      seed,
      line(api('x'), { id: 'mail', type: 'send_email', config: { dispatchId: dispatchId() } }),
    );
    const d = await deliver(broadcast.broadcasts.mail!, engaged, seed.channelId);
    await env.DB.prepare('UPDATE deliveries SET human_clicked_at = ?1 WHERE id = ?2')
      .bind(h.clock.now - 2 * DAY, d)
      .run();

    await checkUnengaged(h.env, h.clock.now);
    await checkUnengaged(h.env, h.clock.now + HOUR);
    const unengaged = (memberId: string) =>
      count(
        "SELECT count(*) AS n FROM member_events WHERE member_id = ?1 AND type = 'unengaged'",
        memberId,
      );
    expect(await unengaged(quiet)).toBe(1);
    expect(await unengaged(engaged)).toBe(0);
    expect(await unengaged(newcomer)).toBe(0);
    await settle(h);
    expect((await runsOf(flow.flowId)).map((r) => r.status)).toEqual(['completed']);
    expect(await hasTag(quiet, tag)).toBe(true);
  });
});

describe('Flows: Flow Broadcasts', () => {
  it('closes a retired version’s Flow Broadcasts once no run is open on it', async () => {
    const seed = await seedChannel();
    const h = harness();
    const flow = await publishFlow(
      seed,
      line(
        api('close_me'),
        { id: 'pause', type: 'delay', config: { mode: 'duration', amount: 1, unit: 'hours' } },
        { id: 'mail', type: 'send_email', config: { dispatchId: dispatchId() } },
      ),
    );
    const m = await addMember(seed.channelId, email());
    await fire(h, m, 'close_me');
    await settle(h);
    await env.DB.prepare('UPDATE flow_versions SET retired_at = ?1 WHERE flow_id = ?2')
      .bind(h.clock.now, flow.flowId)
      .run();
    const status = async () =>
      (
        await one<{ status: string }>(
          'SELECT status FROM broadcasts WHERE id = ?1',
          flow.broadcasts.mail,
        )
      )?.status;
    await sweepFlows(h.env, h.clock.now);
    expect(await status()).toBe('sending'); // a run is still open on the version
    await h.advance(2 * HOUR);
    // The run sent, but its recipient is still pending (no send worker here).
    expect(await status()).toBe('sending');
    await env.DB.prepare("UPDATE broadcast_recipients SET status = 'sent' WHERE member_id = ?1")
      .bind(m)
      .run();
    await sweepFlows(h.env, h.clock.now);
    expect(await status()).toBe('sent');
  });
});

// ---- Property test -------------------------------------------------------------------------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGraph(rand: () => number, tags: { id: string; name: string }[]): FlowGraph {
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
  const nodes: RawNode[] = [{ id: 'trigger', type: 'trigger', config: api() }];
  const edges: RawEdge[] = [];
  const free: { from: string; label: string }[] = [{ from: 'trigger', label: 'default' }];
  const size = 3 + Math.floor(rand() * 8);
  for (let i = 0; i < size && free.length; i++) {
    const id = `n${i}`;
    const type = pick([
      'send_email',
      'send_email',
      'delay',
      'add_tag',
      'remove_tag',
      'branch',
      'ab_split',
      'wait_for_event',
      'exit',
      'notify_author',
    ] as const);
    let config: Record<string, unknown>;
    switch (type) {
      case 'send_email':
        config = { dispatchId: dispatchId(), audience: pick(['any', 'any', 'paid', 'free']) };
        break;
      case 'delay':
        config =
          rand() < 0.2
            ? { mode: 'duration', amount: 1 + Math.floor(rand() * 3), unit: 'days' }
            : { mode: 'duration', amount: 1 + Math.floor(rand() * 30), unit: 'hours' };
        break;
      case 'add_tag':
      case 'remove_tag':
        config = { tagId: pick(tags).id };
        break;
      case 'branch':
        config = { condition: { field: 'tag', cmp: 'eq', value: pick(tags).name } };
        break;
      case 'ab_split':
        config = { percentA: 1 + Math.floor(rand() * 98) };
        break;
      case 'wait_for_event':
        config = { event: 'open', timeoutHours: 1 + Math.floor(rand() * 48) };
        break;
      case 'notify_author':
        config = { message: 'A Member got here.' };
        break;
      case 'exit':
        config = {};
        break;
    }
    const slot = free.splice(Math.floor(rand() * free.length), 1)[0]!;
    edges.push({ from: slot.from, to: id, label: slot.label });
    nodes.push({ id, type, config });
    for (const label of FLOW_NODE_OUTPUTS[type]) free.push({ from: id, label });
    // Sometimes join an extra free outcome of an earlier node to this one (a DAG merge).
    if (free.length > 1 && rand() < 0.3) {
      const extra = free.findIndex((f) => f.from !== id);
      if (extra >= 0) {
        const [s] = free.splice(extra, 1);
        edges.push({ from: s!.from, to: id, label: s!.label });
      }
    }
  }
  const g = graph(nodes, edges);
  expect(validateFlowGraph(g)).toEqual([]);
  return g;
}

describe('Flows: property', () => {
  it('never sends a node twice, never sends after the gate closes, and follows the graph', async () => {
    const rand = rng(0x5eed);
    for (let round = 0; round < 10; round++) {
      const seed = await seedChannel();
      const h = harness(Date.now() + round * 1000);
      const tags: { id: string; name: string }[] = [];
      for (const name of ['red', 'green', 'blue'])
        tags.push({ id: await makeTag(seed.channelId, name), name });
      const g = randomGraph(rand, tags);
      const flow = await publishFlow(seed, g, { reentry: rand() < 0.5 ? 'never' : 'after_exit' });
      const sendNodes = g.nodes.filter((n) => n.type === 'send_email');
      const paidBroadcasts = new Set(
        sendNodes
          .filter((n) => n.type === 'send_email' && n.config.audience === 'paid')
          .map((n) => flow.broadcasts[n.id]!),
      );
      const members: string[] = [];
      for (let i = 0; i < 4; i++) {
        const m = await addMember(seed.channelId, email());
        members.push(m);
        if (rand() < 0.5) {
          await env.DB.prepare(
            `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at) VALUES (?1, ?2, 'paid', 'comp', 0)`,
          )
            .bind(m, seed.channelId)
            .run();
        }
        if (rand() < 0.5) {
          await env.DB.prepare(
            'INSERT INTO member_tags (member_id, tag_id, created_at) VALUES (?1, ?2, 0)',
          )
            .bind(m, tags[Math.floor(rand() * 3)]!.id)
            .run();
        }
        await fire(h, m);
      }
      await settle(h);

      /** After a gate closes: recipient rows (all, or paid only) must not grow. */
      const closed = new Map<string, { all?: number; paid?: number }>();
      const paidCount = async (m: string) =>
        (await recipientsOf(m)).filter((b) => paidBroadcasts.has(b)).length;
      for (let tick = 0; tick < 12; tick++) {
        const m = members[Math.floor(rand() * members.length)]!;
        const roll = rand();
        if (roll < 0.15) {
          await env.DB.prepare("UPDATE members SET status = 'unsubscribed' WHERE id = ?1")
            .bind(m)
            .run();
          closed.set(m, {
            ...closed.get(m),
            all: closed.get(m)?.all ?? (await recipientsOf(m)).length,
          });
        } else if (roll < 0.25) {
          const address = await one<{ email: string }>(
            'SELECT email FROM members WHERE id = ?1',
            m,
          );
          await env.DB.prepare(
            `INSERT INTO suppressions (id, workspace_id, email, reason, created_at) VALUES (?1, ?2, ?3, 'hard_bounce', 0) ON CONFLICT DO NOTHING`,
          )
            .bind(newId('suppression'), seed.workspaceId, address!.email)
            .run();
          closed.set(m, {
            ...closed.get(m),
            all: closed.get(m)?.all ?? (await recipientsOf(m)).length,
          });
        } else if (roll < 0.4) {
          await env.DB.prepare('DELETE FROM member_entitlements WHERE member_id = ?1')
            .bind(m)
            .run();
          closed.set(m, { ...closed.get(m), paid: closed.get(m)?.paid ?? (await paidCount(m)) });
        } else if (roll < 0.55) {
          await env.DB.prepare(
            'INSERT INTO member_tags (member_id, tag_id, created_at) VALUES (?1, ?2, 0) ON CONFLICT DO NOTHING',
          )
            .bind(m, tags[Math.floor(rand() * 3)]!.id)
            .run();
        } else if (roll < 0.65) {
          await fire(h, m); // re-entry attempt
          await enrollFromEvents(h.env, h.clock.now);
        }
        await h.advance((1 + Math.floor(rand() * 20)) * HOUR, 6 * HOUR);
      }
      await h.advance(40 * DAY, 12 * HOUR);

      for (const m of members) {
        // One send message per (Broadcast, Member), matching the recipient rows.
        const sent = h.sends.for(m).map((s) => s.broadcastId);
        expect(new Set(sent).size).toBe(sent.length);
        expect([...sent].sort()).toEqual(await recipientsOf(m));
        const gate = closed.get(m);
        if (gate?.all !== undefined) expect((await recipientsOf(m)).length).toBe(gate.all);
        if (gate?.paid !== undefined) expect(await paidCount(m)).toBe(gate.paid);

        for (const run of await runsOf(flow.flowId, m)) {
          expect(['completed', 'exited']).toContain(run.status);
          const steps = (await stepsOf(run.id)).filter((s) => s.status !== 'failed');
          expect(steps[0]?.node_id).toBe('trigger');
          for (let i = 0; i + 1 < steps.length; i++) {
            const step = steps[i]!;
            expect(step.outcome).not.toBeNull();
            expect(steps[i + 1]!.node_id).toBe(nextNodeId(g, step.node_id, step.outcome as never));
          }
          const last = steps.at(-1)!;
          const lastNode = g.nodes.find((n) => n.id === last.node_id)!;
          if (run.status === 'exited') {
            expect(lastNode.type === 'exit' || last.status === 'skipped').toBe(true);
            expect(run.exit_reason).not.toBeNull();
          } else {
            expect(nextNodeId(g, last.node_id, last.outcome as never)).toBeUndefined();
          }
          if (lastNode.type === 'exit') expect(run.exit_reason).toBe('exit_node');
        }
      }
    }
  });
});
