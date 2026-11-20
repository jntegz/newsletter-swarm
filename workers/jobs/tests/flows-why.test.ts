// Why and multiple start events, end to end through the real enrolment drain: which start event let
// a Member in, what is recorded when none did, what that costs, and what the Member's page reads.
import { env } from 'cloudflare:test';
import {
  FlowGraphSchema,
  newId,
  type FlowGraph,
  type FlowRunContext,
  type MemberFlowHistory,
} from '@swarm/domain';
import {
  checkUnengaged,
  emailsPossible,
  enrollFromEvents,
  memberFlowHistory,
  pruneFlowDecisions,
  recordMemberEvent,
  recordMemberEvents,
  toFlowRunStart,
} from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { addMember, count, one, seedChannel } from './helpers';
import {
  HOUR,
  attachPipeline,
  dispatchId,
  harness,
  makeTag,
  publishFlow,
  publishVersion,
  runsOf,
  type Harness,
} from './flows-helpers';

type Seed = Awaited<ReturnType<typeof seedChannel>>;

const graph = (trigger: Record<string, unknown>): FlowGraph =>
  FlowGraphSchema.parse({
    schema: 1,
    nodes: [
      { id: 'trigger', type: 'trigger', config: trigger },
      { id: 'email', type: 'send_email', config: { dispatchId: dispatchId() } },
    ],
    edges: [{ from: 'trigger', to: 'email' }],
  });

const go = (name: string) => ({ type: 'api_event' as const, payload: { name } });

async function setup() {
  const seed = await seedChannel();
  const h = harness();
  attachPipeline(h);
  const memberId = await addMember(seed.channelId, `m-${crypto.randomUUID()}@example.com`);
  return { seed, h, memberId };
}

const fire = (h: Harness, memberId: string, ...names: string[]) =>
  recordMemberEvents(
    env.DB,
    names.map((name) => ({ ...go(name), memberId })),
    h.clock.now,
  );

const decisionOf = (flowId: string, memberId: string) =>
  one<{ reason: string; trigger_event: string; version: number; decided_at: number }>(
    'SELECT reason, trigger_event, version, decided_at FROM flow_enrol_decisions WHERE flow_id = ?1 AND member_id = ?2',
    flowId,
    memberId,
  );

/** A segment with this Member in it, and a rule that asks for it. */
async function segment(seed: Seed, memberId?: string) {
  const id = newId('circle');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Fans', '{"op":"and","children":[]}', 'ready', ?4, ?4)`,
  )
    .bind(id, seed.workspaceId, seed.channelId, now)
    .run();
  if (memberId) {
    await env.DB.prepare(
      'INSERT INTO circle_members (circle_id, member_id, generation) VALUES (?1, ?2, 0)',
    )
      .bind(id, memberId)
      .run();
  }
  return { id, rule: { field: 'circle', cmp: 'eq', value: id } };
}

const noSuchTag = { field: 'tag', cmp: 'eq', value: 'nobody-has-this' };

describe('multiple start events', () => {
  it('a Flow published with one start event works as it always did', async () => {
    const { seed, h, memberId } = await setup();
    const flow = await publishFlow(seed, graph({ event: 'api_event', name: 'a' }));
    await fire(h, memberId, 'a');
    await enrollFromEvents(h.env, h.clock.now);
    const [run] = await runsOf(flow.flowId, memberId);
    expect(run).toBeDefined();
    expect(toFlowRunStart(run!.context_json)).toMatchObject({ index: 0, event: 'api_event' });
    const row = await one<{ extra: string | null }>(
      'SELECT extra_trigger_types AS extra FROM flows WHERE id = ?1',
      flow.flowId,
    );
    expect(row?.extra).toBeNull();
  });

  it('reads a run saved before start events had an index as the first one', () => {
    const start = toFlowRunStart(
      JSON.stringify({ trigger: { type: 'tag_added', payload: { tagId: 'tg_1' }, seq: 3 } }),
    );
    expect(start).toEqual({ index: 0, event: 'tag_added', details: { tagId: 'tg_1' } });
    expect(toFlowRunStart('{}')).toBeNull();
    expect(toFlowRunStart('not json')).toBeNull();
  });

  it('starts from any of its start events, and says which', async () => {
    const { seed, h, memberId } = await setup();
    const tagId = await makeTag(seed.channelId);
    const flow = await publishFlow(
      seed,
      graph({
        event: 'api_event',
        name: 'first',
        alsoStartOn: [
          { event: 'api_event', name: 'second' },
          { event: 'tag_added', tagId },
        ],
      }),
    );
    await recordMemberEvent(
      env.DB,
      { type: 'tag_added', memberId, payload: { tagId } },
      h.clock.now,
    );
    await enrollFromEvents(h.env, h.clock.now);
    const runs = await runsOf(flow.flowId, memberId);
    expect(runs).toHaveLength(1);
    expect(toFlowRunStart(runs[0]!.context_json)).toEqual({
      index: 2,
      event: 'tag_added',
      details: { tagId },
    });

    const other = await addMember(seed.channelId, `n-${crypto.randomUUID()}@example.com`);
    await fire(h, other, 'second');
    await enrollFromEvents(h.env, h.clock.now);
    const [run] = await runsOf(flow.flowId, other);
    expect((JSON.parse(run!.context_json) as FlowRunContext).trigger?.index).toBe(1);
  });

  it('enters once when two start events fire at once', async () => {
    const { seed, h, memberId } = await setup();
    for (const reentry of ['never', 'after_exit'] as const) {
      const flow = await publishFlow(
        seed,
        graph({ event: 'api_event', name: 'a', alsoStartOn: [{ event: 'api_event', name: 'b' }] }),
        { reentry },
      );
      await fire(h, memberId, 'a', 'b');
      await enrollFromEvents(h.env, h.clock.now);
      expect(await runsOf(flow.flowId, memberId)).toHaveLength(1);
      // Another start event at the same moment isn't something to explain on the page.
      expect(await decisionOf(flow.flowId, memberId)).toBeNull();
    }
  });

  it('with re-entry, a run that ended at once still is not started again by the same moment', async () => {
    const { seed, h, memberId } = await setup();
    const flow = await publishFlow(
      seed,
      graph({ event: 'api_event', name: 'a', alsoStartOn: [{ event: 'api_event', name: 'b' }] }),
      { reentry: 'after_exit' },
    );
    await fire(h, memberId, 'a');
    await enrollFromEvents(h.env, h.clock.now);
    await env.DB.prepare(
      `UPDATE flow_runs SET status = 'completed', ended_at = ?1 WHERE flow_id = ?2`,
    )
      .bind(h.clock.now, flow.flowId)
      .run();
    await fire(h, memberId, 'b');
    await enrollFromEvents(h.env, h.clock.now);
    expect(await runsOf(flow.flowId, memberId)).toHaveLength(1);

    // Later on, the same start event is a real re-entry.
    h.clock.now += HOUR;
    await fire(h, memberId, 'b');
    await enrollFromEvents(h.env, h.clock.now);
    expect(await runsOf(flow.flowId, memberId)).toHaveLength(2);
  });

  it('one event matching two start events starts one run, from the first that lets them in', async () => {
    const { seed, h, memberId } = await setup();
    const fans = await segment(seed, memberId);
    const flow = await publishFlow(
      seed,
      graph({
        event: 'api_event',
        name: 'a',
        filter: noSuchTag,
        alsoStartOn: [{ event: 'api_event', name: 'a', filter: fans.rule }],
      }),
    );
    await fire(h, memberId, 'a');
    await enrollFromEvents(h.env, h.clock.now);
    const runs = await runsOf(flow.flowId, memberId);
    expect(runs).toHaveLength(1);
    expect(toFlowRunStart(runs[0]!.context_json)?.index).toBe(1);
  });

  it('applies filters per start event', async () => {
    const { seed, h, memberId } = await setup();
    const flow = await publishFlow(
      seed,
      graph({
        event: 'api_event',
        name: 'filtered',
        filter: noSuchTag,
        alsoStartOn: [{ event: 'api_event', name: 'open' }],
      }),
    );
    await fire(h, memberId, 'filtered');
    await enrollFromEvents(h.env, h.clock.now);
    expect(await runsOf(flow.flowId, memberId)).toHaveLength(0);
    expect(await decisionOf(flow.flowId, memberId)).toMatchObject({ reason: 'filter_miss' });

    h.clock.now += 1000;
    await fire(h, memberId, 'open');
    await enrollFromEvents(h.env, h.clock.now);
    expect(await runsOf(flow.flowId, memberId)).toHaveLength(1);
    // Entering clears the row: the run is the answer now.
    expect(await decisionOf(flow.flowId, memberId)).toBeNull();
  });

  it('the daily unengaged check looks at every start event', async () => {
    const { seed, h } = await setup();
    await publishFlow(
      seed,
      graph({
        event: 'api_event',
        name: 'a',
        alsoStartOn: [{ event: 'unengaged', days: 30 }],
      }),
    );
    const member = await addMember(seed.channelId, `quiet-${crypto.randomUUID()}@example.com`);
    await env.DB.prepare('UPDATE members SET created_at = 0, confirmed_at = 0 WHERE id = ?1')
      .bind(member)
      .run();
    await checkUnengaged(h.env, h.clock.now);
    expect(
      await count(
        `SELECT count(*) AS n FROM member_events WHERE member_id = ?1 AND type = 'unengaged'`,
        member,
      ),
    ).toBe(1);
  });
});

describe('recording why a start event let nobody in', () => {
  it('records a filter miss, in the words of a segment when the filter is one', async () => {
    const { seed, h, memberId } = await setup();
    const fans = await segment(seed);
    const segmentFlow = await publishFlow(
      seed,
      graph({ event: 'api_event', name: 'a', filter: fans.rule }),
    );
    const ruleFlow = await publishFlow(
      seed,
      graph({ event: 'api_event', name: 'a', filter: noSuchTag }),
    );
    await fire(h, memberId, 'a');
    await enrollFromEvents(h.env, h.clock.now);
    expect(await decisionOf(segmentFlow.flowId, memberId)).toMatchObject({
      reason: 'not_in_segment',
      trigger_event: 'api_event',
      version: 1,
    });
    expect(await decisionOf(ruleFlow.flowId, memberId)).toMatchObject({ reason: 'filter_miss' });
  });

  it('records nothing for an event no start event matches', async () => {
    const { seed, h, memberId } = await setup();
    const flow = await publishFlow(seed, graph({ event: 'api_event', name: 'a' }));
    await fire(h, memberId, 'something-else');
    await enrollFromEvents(h.env, h.clock.now);
    expect(await decisionOf(flow.flowId, memberId)).toBeNull();
  });

  it('tells an open run from a finished one, and this version from an earlier one', async () => {
    const { seed, h, memberId } = await setup();
    const g = graph({ event: 'api_event', name: 'a' });
    const flow = await publishFlow(seed, g);
    await fire(h, memberId, 'a');
    await enrollFromEvents(h.env, h.clock.now);

    h.clock.now += HOUR;
    await fire(h, memberId, 'a');
    await enrollFromEvents(h.env, h.clock.now);
    expect(await decisionOf(flow.flowId, memberId)).toMatchObject({ reason: 'already_in' });

    await env.DB.prepare(
      `UPDATE flow_runs SET status = 'completed', ended_at = ?1 WHERE flow_id = ?2`,
    )
      .bind(h.clock.now, flow.flowId)
      .run();
    h.clock.now += HOUR;
    await fire(h, memberId, 'a');
    await enrollFromEvents(h.env, h.clock.now);
    expect(await decisionOf(flow.flowId, memberId)).toMatchObject({
      reason: 'already_ran_version',
    });

    await publishVersion(seed, flow.flowId, 2, graph({ event: 'api_event', name: 'a' }));
    await env.DB.prepare('UPDATE flows SET live_version = 2 WHERE id = ?1').bind(flow.flowId).run();
    h.clock.now += HOUR;
    await fire(h, memberId, 'a');
    await enrollFromEvents(h.env, h.clock.now);
    expect(await decisionOf(flow.flowId, memberId)).toMatchObject({
      reason: 'already_ran_earlier',
      version: 2,
    });
  });

  it('says when the hourly cap refused a re-entry', async () => {
    const { seed, h, memberId } = await setup();
    const flow = await publishFlow(seed, graph({ event: 'api_event', name: 'a' }), {
      reentry: 'after_exit',
    });
    for (let i = 0; i < 11; i++) {
      h.clock.now += 2 * 60_000;
      await fire(h, memberId, 'a');
      await enrollFromEvents(h.env, h.clock.now);
      await env.DB.prepare(
        `UPDATE flow_runs SET status = 'completed', ended_at = ?1 WHERE flow_id = ?2 AND status = 'running'`,
      )
        .bind(h.clock.now, flow.flowId)
        .run();
    }
    expect(await runsOf(flow.flowId, memberId)).toHaveLength(10);
    expect(await decisionOf(flow.flowId, memberId)).toMatchObject({ reason: 'rate_limited' });
  });

  it('keeps one row per Member and Flow, and does not rewrite it while the answer stands', async () => {
    const { seed, h, memberId } = await setup();
    const flow = await publishFlow(
      seed,
      graph({ event: 'api_event', name: 'a', filter: noSuchTag }),
    );
    const first = h.clock.now;
    await fire(h, memberId, 'a', 'a', 'a');
    await enrollFromEvents(h.env, h.clock.now);
    for (let i = 0; i < 5; i++) {
      h.clock.now += HOUR;
      await fire(h, memberId, 'a');
      await enrollFromEvents(h.env, h.clock.now);
    }
    expect(
      await count('SELECT count(*) AS n FROM flow_enrol_decisions WHERE member_id = ?1', memberId),
    ).toBe(1);
    // Five hours on, still the first write: nothing was written for the repeats.
    expect((await decisionOf(flow.flowId, memberId))?.decided_at).toBe(first);

    h.clock.now += 24 * HOUR;
    await fire(h, memberId, 'a');
    await enrollFromEvents(h.env, h.clock.now);
    expect((await decisionOf(flow.flowId, memberId))?.decided_at).toBe(h.clock.now);
  });

  it('goes with the Member, and the daily job drops the rows of Flows that can no longer run', async () => {
    const { seed, h, memberId } = await setup();
    const live = await publishFlow(
      seed,
      graph({ event: 'api_event', name: 'a', filter: noSuchTag }),
    );
    const archived = await publishFlow(
      seed,
      graph({ event: 'api_event', name: 'a', filter: noSuchTag }),
    );
    const deleted = await publishFlow(
      seed,
      graph({ event: 'api_event', name: 'a', filter: noSuchTag }),
    );
    await fire(h, memberId, 'a');
    await enrollFromEvents(h.env, h.clock.now);
    await env.DB.batch([
      env.DB.prepare(`UPDATE flows SET status = 'archived' WHERE id = ?1`).bind(archived.flowId),
      env.DB.prepare(`UPDATE flows SET deleted_at = 1 WHERE id = ?1`).bind(deleted.flowId),
    ]);
    await pruneFlowDecisions(env.DB);
    expect(await decisionOf(live.flowId, memberId)).not.toBeNull();
    expect(await decisionOf(archived.flowId, memberId)).toBeNull();
    expect(await decisionOf(deleted.flowId, memberId)).toBeNull();

    await env.DB.prepare('DELETE FROM members WHERE id = ?1').bind(memberId).run();
    expect(await decisionOf(live.flowId, memberId)).toBeNull();
  });
});

describe('the Member page', () => {
  const byName = (items: MemberFlowHistory[], name: string) =>
    items.find((item) => item.flowName === name)!;

  it('lists every live Flow with the run, the emails and what was skipped', async () => {
    const { seed, h, memberId } = await setup();
    const two = FlowGraphSchema.parse({
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'api_event', name: 'a' } },
        { id: 'one', type: 'send_email', config: { dispatchId: dispatchId() } },
        { id: 'two', type: 'send_email', config: { dispatchId: dispatchId() } },
        { id: 'three', type: 'send_email', config: { dispatchId: dispatchId() } },
      ],
      edges: [
        { from: 'trigger', to: 'one' },
        { from: 'one', to: 'two' },
        { from: 'two', to: 'three' },
      ],
    });
    const welcome = await publishFlow(seed, two, { name: 'Welcome' });
    const missed = await publishFlow(
      seed,
      graph({ event: 'api_event', name: 'a', filter: noSuchTag }),
      { name: 'Win-back' },
    );
    await publishFlow(seed, graph({ event: 'api_event', name: 'never_fired' }), { name: 'Quiet' });
    await publishFlow(seed, graph({ event: 'api_event', name: 'a' }), {
      name: 'Old',
      status: 'archived',
    });
    await fire(h, memberId, 'a');
    await enrollFromEvents(h.env, h.clock.now);

    // Two of three emails reached them, then the send gate stopped the run on the third.
    const [run] = await runsOf(welcome.flowId, memberId);
    const sent = { one: welcome.broadcasts.one!, two: welcome.broadcasts.two! };
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE flow_runs SET status = 'exited', exit_reason = 'member_inactive', current_node_id = 'three',
           ended_at = ?1, context_json = ?2 WHERE id = ?3`,
      ).bind(h.clock.now, JSON.stringify({ ...JSON.parse(run!.context_json), sent }), run!.id),
      ...Object.values(sent).map((broadcastId) =>
        env.DB.prepare(
          `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, sent_at)
           VALUES (?1, ?2, ?3, ?4, 'x@example.com', ?5)`,
        ).bind(newId('delivery'), broadcastId, seed.channelId, memberId, h.clock.now),
      ),
    ]);

    const items = await memberFlowHistory(env.DB, seed.channelId, memberId);
    expect(items.map((i) => i.flowName)).toEqual(['Quiet', 'Welcome', 'Win-back']);
    expect(byName(items, 'Welcome').run).toMatchObject({
      status: 'exited',
      exitReason: 'member_inactive',
      emailsReceived: 2,
      emailsPossible: 3,
      startedBy: { index: 0, event: 'api_event' },
    });
    expect(byName(items, 'Welcome').decision).toBeNull();
    expect(byName(items, 'Win-back')).toMatchObject({
      flowId: missed.flowId,
      run: null,
      decision: { reason: 'filter_miss', event: 'api_event' },
    });
    expect(byName(items, 'Quiet')).toMatchObject({ run: null, decision: null });
  });

  it('shows a skip that came after the run, not one from before it', async () => {
    const { seed, h, memberId } = await setup();
    const flow = await publishFlow(seed, graph({ event: 'api_event', name: 'a' }), {
      name: 'Welcome',
    });
    await fire(h, memberId, 'a');
    await enrollFromEvents(h.env, h.clock.now);
    let [item] = await memberFlowHistory(env.DB, seed.channelId, memberId);
    expect(item?.decision).toBeNull();

    h.clock.now += HOUR;
    await fire(h, memberId, 'a');
    await enrollFromEvents(h.env, h.clock.now);
    [item] = await memberFlowHistory(env.DB, seed.channelId, memberId);
    expect(item?.run).not.toBeNull();
    expect(item?.decision?.reason).toBe('already_in');

    // A row older than the run (a step or the API enrolled them since) is out of date.
    await env.DB.prepare('UPDATE flow_enrol_decisions SET decided_at = 1 WHERE flow_id = ?1')
      .bind(flow.flowId)
      .run();
    [item] = await memberFlowHistory(env.DB, seed.channelId, memberId);
    expect(item?.decision).toBeNull();
  });

  it('leaves out test runs and other publications', async () => {
    const { seed, h, memberId } = await setup();
    const flow = await publishFlow(seed, graph({ event: 'api_event', name: 'a' }), {
      name: 'Welcome',
    });
    await env.DB.prepare(
      `INSERT INTO flow_runs (id, flow_id, version, channel_id, member_id, status, context_json, test, started_at, updated_at)
       VALUES (?1, ?2, 1, ?3, ?4, 'completed', '{}', 1, ?5, ?5)`,
    )
      .bind(newId('flowRun'), flow.flowId, seed.channelId, memberId, h.clock.now)
      .run();
    const [item] = await memberFlowHistory(env.DB, seed.channelId, memberId);
    expect(item?.run).toBeNull();
    const elsewhere = await seedChannel();
    expect(await memberFlowHistory(env.DB, elsewhere.channelId, memberId)).toEqual([]);
  });

  it('counts only the path a run took', () => {
    const g = FlowGraphSchema.parse({
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'api_event', name: 'a' } },
        { id: 'one', type: 'send_email', config: { dispatchId: dispatchId() } },
        {
          id: 'split',
          type: 'ab_split',
          config: { percentA: 50 },
        },
        { id: 'a', type: 'send_email', config: { dispatchId: dispatchId() } },
        { id: 'b', type: 'send_email', config: { dispatchId: dispatchId() } },
        { id: 'b2', type: 'send_email', config: { dispatchId: dispatchId() } },
      ],
      edges: [
        { from: 'trigger', to: 'one' },
        { from: 'one', to: 'split' },
        { from: 'split', to: 'a', label: 'a' },
        { from: 'split', to: 'b', label: 'b' },
        { from: 'b', to: 'b2' },
      ],
    });
    // In progress at the split: the longest way on is two more.
    expect(emailsPossible(g, ['one'], { status: 'waiting', current_node_id: 'split' })).toBe(3);
    // Finished down the short arm: two was all there was, not four.
    expect(emailsPossible(g, ['one', 'a'], { status: 'completed', current_node_id: 'a' })).toBe(2);
    // Stopped on an email it never sent.
    expect(emailsPossible(g, ['one'], { status: 'exited', current_node_id: 'b' })).toBe(3);
    expect(emailsPossible(null, ['one'], { status: 'exited', current_node_id: 'b' })).toBe(1);
  });
});
