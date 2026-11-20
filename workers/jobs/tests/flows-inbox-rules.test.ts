// Inbox rules through the real engine and the real send pipeline, on a simulated clock, and the
// repeat-send check across Flow versions.
import { env } from 'cloudflare:test';
import {
  FlowGraphSchema,
  InboxRulesSchema,
  newId,
  type FlowGraph,
  type InboxRules,
} from '@swarm/domain';
import {
  enrollFromEvents,
  heldNowInChannel,
  migrateRuns,
  pruneFlowEmailLedger,
  recordMemberEvent,
  resumeFlowRuns,
  runStep,
  saveInboxRules,
  startFlowRun,
  sweepFlows,
  takeLedgerSlot,
  unsubscribeMember,
} from '@swarm/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { addField, addMember, count, one, seedChannel } from './helpers';
import {
  DAY,
  HOUR,
  attachPipeline,
  dispatchId,
  harness,
  publishFlow,
  publishVersion,
  runsOf,
  stepsOf,
  type Harness,
  type SendPipeline,
} from './flows-helpers';

/** Monday 2 November 2026, noon UTC. */
const NOON = Date.UTC(2026, 10, 2, 12, 0);

type Seed = Awaited<ReturnType<typeof seedChannel>>;

// The sweep isn't scoped to a Channel, and the database outlives a test: a run left waiting here
// would wake inside the next test.
afterEach(async () => {
  await env.DB.prepare(
    `UPDATE flow_runs SET status = 'exited', exit_reason = 'operator', next_at = NULL
      WHERE status IN ('running', 'waiting', 'paused')`,
  ).run();
});

const emails = (name: string, ...configs: Record<string, unknown>[]): FlowGraph => {
  const nodes: unknown[] = [
    { id: 'trigger', type: 'trigger', config: { event: 'api_event', name } },
  ];
  const edges: unknown[] = [];
  let from = 'trigger';
  configs.forEach((config, i) => {
    const id = `mail${i}`;
    nodes.push({ id, type: 'send_email', config: { dispatchId: dispatchId(), ...config } });
    edges.push({ from, to: id });
    from = id;
  });
  return FlowGraphSchema.parse({ schema: 1, nodes, edges });
};

async function setup(rules: Partial<InboxRules> | null, start = NOON) {
  const seed = await seedChannel();
  const h = harness(start);
  const sends = attachPipeline(h);
  if (rules) {
    await saveInboxRules(
      env.DB,
      seed.channelId,
      { rules: InboxRulesSchema.parse(rules), timezone: null },
      start,
    );
  }
  const member = await addMember(seed.channelId, `rule-${crypto.randomUUID()}@example.com`);
  return { seed, h, sends, member };
}

async function fire(h: Harness, memberId: string, name: string) {
  await recordMemberEvent(env.DB, { type: 'api_event', memberId, payload: { name } }, h.clock.now);
  await enrollFromEvents(h.env, h.clock.now);
}

/** Runs everything due now, both queues, until nothing more is due. */
async function settle(h: Harness, sends: SendPipeline) {
  for (let i = 0; i < 50; i++) {
    const ran = (await h.drain()) + (await sends.consumeDue());
    if (!ran) return;
  }
}

/** Moves the clock in steps, sweeping as the cron does. */
async function advance(h: Harness, sends: SendPipeline, ms: number, stepMs = 15 * 60_000) {
  const end = h.clock.now + ms;
  await settle(h, sends);
  while (h.clock.now < end) {
    h.clock.now = Math.min(end, h.clock.now + stepMs);
    await sweepFlows(h.env, h.clock.now);
    await settle(h, sends);
  }
}

const holdOf = (runId: string) =>
  one<{
    reason: string;
    until: number;
    zone: string;
    held_at: number;
    released_at: number | null;
    outcome: string | null;
  }>('SELECT * FROM flow_holds WHERE run_id = ?1', runId);

const setMemberZone = async (channelId: string, memberId: string, zone: string) => {
  const fieldId = await addField(channelId, 'timezone', 'text');
  await env.DB.prepare(
    `INSERT INTO member_field_values (member_id, field_id, value_text, updated_at) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(memberId, fieldId, zone, Date.now())
    .run();
};

/** A post this Member got: a Broadcast with a sent recipient row. */
async function postGot(seed: Seed, memberId: string, at: number) {
  const dispatch = dispatchId();
  const broadcast = newId('broadcast', at);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, kind, created_at, updated_at)
       VALUES (?1, ?2, 'Post', '{"type":"doc","content":[]}', 'sent', 'broadcast', ?3, ?3)`,
    ).bind(dispatch, seed.channelId, at),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html,
         text, from_name, from_address, track_opens, snapshot_done, fanout_done, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'Post', '', '<p>Hi</p>', 'Hi', 'Notes', 'notes@mail.swarm.localhost', 1, 1, 1, ?5, ?5)`,
    ).bind(broadcast, dispatch, seed.channelId, seed.workspaceId, at),
    env.DB.prepare(
      `INSERT INTO broadcast_recipients (broadcast_id, member_id, email, status)
       SELECT ?1, id, email, 'sent' FROM members WHERE id = ?2`,
    ).bind(broadcast, memberId),
  ]);
}

/** A post scheduled to go at `at`, to `audience`. */
async function postScheduled(seed: Seed, at: number, audience?: unknown) {
  await env.DB.prepare(
    `INSERT INTO dispatches (id, channel_id, subject, content_json, status, publish_at, kind, audience_json, created_at, updated_at)
     VALUES (?1, ?2, 'Post', '{"type":"doc","content":[]}', 'scheduled', ?3, 'broadcast', ?4, ?3, ?3)`,
  )
    .bind(
      dispatchId(),
      seed.channelId,
      at,
      JSON.stringify(audience ?? { include: [], exclude: [] }),
    )
    .run();
}

describe('inbox rules: nothing changes until a person sets one', () => {
  it('sends straight away with no rule, and holds nothing', async () => {
    const { seed, h, sends, member } = await setup(null);
    await publishFlow(seed, emails('go', {}, {}, {}));
    await fire(h, member, 'go');
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(3);
    expect(
      await count('SELECT count(*) AS n FROM flow_holds WHERE channel_id = ?1', seed.channelId),
    ).toBe(0);
  });

  it('counts sends from before any rule was set', async () => {
    const { seed, h, sends, member } = await setup(null);
    await publishFlow(seed, emails('go', {}));
    const later = await publishFlow(seed, emails('later', {}));
    await fire(h, member, 'go');
    await settle(h, sends);
    await saveInboxRules(
      env.DB,
      seed.channelId,
      { rules: InboxRulesSchema.parse({ perDay: 1 }), timezone: null },
      h.clock.now,
    );
    await fire(h, member, 'later');
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(1);
    const [run] = await runsOf(later.flowId, member);
    expect(run!.status).toBe('waiting');
  });
});

describe('inbox rules: quiet hours', () => {
  const lateEvening = Date.UTC(2026, 10, 2, 23, 0);

  it('parks the run, says why, and sends when they end', async () => {
    const { seed, h, sends, member } = await setup(
      { quietHours: { start: '22:00', end: '08:00' } },
      lateEvening,
    );
    const flow = await publishFlow(seed, emails('go', {}));
    await fire(h, member, 'go');
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(0);
    const [run] = await runsOf(flow.flowId, member);
    expect(run).toMatchObject({ status: 'waiting', next_at: Date.UTC(2026, 10, 3, 8, 0) });
    expect(await holdOf(run!.id)).toMatchObject({
      reason: 'quiet_hours',
      until: Date.UTC(2026, 10, 3, 8, 0),
      zone: 'UTC',
      released_at: null,
    });
    const steps = await stepsOf(run!.id);
    expect(steps.at(-1)).toMatchObject({ node_id: 'mail0', status: 'pending' });
    expect(JSON.parse(steps.at(-1)!.result_json!)).toMatchObject({
      deferred: 'inbox_rules',
      reason: 'quiet_hours',
    });

    await advance(h, sends, 8 * HOUR);
    expect(sends.outbox.accepted).toHaveLength(0);
    await advance(h, sends, 2 * HOUR);
    expect(sends.outbox.accepted).toHaveLength(1);
    const [after] = await runsOf(flow.flowId, member);
    expect(after!.status).toBe('completed');
    expect(await holdOf(run!.id)).toMatchObject({ outcome: 'sent' });
  });

  it('uses the subscriber’s timezone when it is known, else the publication’s', async () => {
    // 23:00 UTC: past midnight in Prague (quiet), late afternoon in New York (not quiet).
    const { seed, h, sends, member } = await setup(null, lateEvening);
    await saveInboxRules(
      env.DB,
      seed.channelId,
      {
        rules: InboxRulesSchema.parse({ quietHours: { start: '22:00', end: '08:00' } }),
        timezone: 'Europe/Prague',
      },
      lateEvening,
    );
    const flow = await publishFlow(seed, emails('go', {}));
    await fire(h, member, 'go');
    const other = await addMember(seed.channelId, `ny-${crypto.randomUUID()}@example.com`);
    await setMemberZone(seed.channelId, other, 'America/New_York');
    await fire(h, other, 'go');
    await settle(h, sends);

    const [prague] = await runsOf(flow.flowId, member);
    expect(await holdOf(prague!.id)).toMatchObject({
      zone: 'Europe/Prague',
      until: Date.UTC(2026, 10, 3, 7, 0),
    });
    expect(sends.outbox.accepted).toHaveLength(1);
    const [ny] = await runsOf(flow.flowId, other);
    expect(ny!.status).toBe('completed');
  });
});

describe('inbox rules: someone who leaves while held', () => {
  it('gets nothing, and the run says so', async () => {
    const { seed, h, sends, member } = await setup(
      { quietHours: { start: '22:00', end: '08:00' } },
      Date.UTC(2026, 10, 2, 23, 0),
    );
    const flow = await publishFlow(seed, emails('go', {}));
    await fire(h, member, 'go');
    await settle(h, sends);
    await unsubscribeMember(env.DB, member, null, h.clock.now);
    await advance(h, sends, 12 * HOUR);
    expect(sends.outbox.accepted).toHaveLength(0);
    const [run] = await runsOf(flow.flowId, member);
    expect(run).toMatchObject({ status: 'exited', exit_reason: 'member_inactive' });
    expect(await holdOf(run!.id)).toMatchObject({ outcome: 'left' });
    expect(
      await count('SELECT count(*) AS n FROM flow_email_ledger WHERE member_id = ?1', member),
    ).toBe(0);
  });
});

describe('inbox rules: the check at the moment of sending', () => {
  it('stops a held email whose subscriber left after it was released and queued', async () => {
    const { seed, h, sends, member } = await setup(
      { quietHours: { start: '22:00', end: '08:00' } },
      Date.UTC(2026, 10, 2, 23, 0),
    );
    const flow = await publishFlow(seed, emails('go', {}));
    await fire(h, member, 'go');
    await settle(h, sends);
    const [run] = await runsOf(flow.flowId, member);
    expect(await holdOf(run!.id)).toMatchObject({ reason: 'quiet_hours', released_at: null });

    // Quiet hours end: the step runs and hands the email to the send queue, and no further.
    h.clock.now = Date.UTC(2026, 10, 3, 8, 1);
    await sweepFlows(h.env, h.clock.now);
    await h.drain();
    expect(await holdOf(run!.id)).toMatchObject({ outcome: 'sent' });
    expect(sends.items).toHaveLength(1);
    expect(sends.outbox.accepted).toHaveLength(0);

    await unsubscribeMember(env.DB, member, null, h.clock.now);
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(0);
    expect(
      await one(
        `SELECT r.status FROM broadcast_recipients r JOIN flow_emails fe ON fe.broadcast_id = r.broadcast_id
          WHERE fe.flow_id = ?1 AND r.member_id = ?2`,
        flow.flowId,
        member,
      ),
    ).toMatchObject({ status: 'skipped' });
  });

  it('sends a released email to someone who stayed, through the same check', async () => {
    const { seed, h, sends, member } = await setup(
      { quietHours: { start: '22:00', end: '08:00' } },
      Date.UTC(2026, 10, 2, 23, 0),
    );
    await publishFlow(seed, emails('go', {}));
    await fire(h, member, 'go');
    await advance(h, sends, 10 * HOUR);
    expect(sends.outbox.accepted).toHaveLength(1);
  });
});

describe('inbox rules: several start events', () => {
  const quiet = { quietHours: { start: '22:00', end: '08:00' } };
  const LATE = Date.UTC(2026, 10, 2, 23, 0);
  const twoStarts = (config: Record<string, unknown> = {}) =>
    FlowGraphSchema.parse({
      schema: 1,
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          config: {
            event: 'api_event',
            name: 'one',
            alsoStartOn: [{ event: 'api_event', name: 'two' }],
          },
        },
        { id: 'mail', type: 'send_email', config: { dispatchId: dispatchId(), ...config } },
      ],
      edges: [{ from: 'trigger', to: 'mail' }],
    });

  it.each(['one', 'two'])('holds and releases a run started by "%s" the same way', async (name) => {
    const { seed, h, sends, member } = await setup(quiet, LATE);
    const flow = await publishFlow(seed, twoStarts());
    await fire(h, member, name);
    await settle(h, sends);
    const [run] = await runsOf(flow.flowId, member);
    expect(await holdOf(run!.id)).toMatchObject({
      reason: 'quiet_hours',
      until: Date.UTC(2026, 10, 3, 8),
    });
    expect(sends.outbox.accepted).toHaveLength(0);
    await advance(h, sends, 10 * HOUR);
    expect(sends.outbox.accepted).toHaveLength(1);
  });

  it.each(['one', 'two'])(
    'sends a marked email at once when "%s" started the run',
    async (name) => {
      const { seed, h, sends, member } = await setup(quiet, LATE);
      await publishFlow(seed, twoStarts({ sendRegardless: true }));
      await fire(h, member, name);
      await settle(h, sends);
      expect(sends.outbox.accepted).toHaveLength(1);
    },
  );

  it('holds the first email of a mixed automation, even for someone who just confirmed', async () => {
    const { seed, h, sends, member } = await setup(quiet, LATE);
    const flow = await publishFlow(
      seed,
      FlowGraphSchema.parse({
        schema: 1,
        nodes: [
          {
            id: 'trigger',
            type: 'trigger',
            config: { event: 'confirmed', alsoStartOn: [{ event: 'api_event', name: 'two' }] },
          },
          { id: 'mail', type: 'send_email', config: { dispatchId: dispatchId() } },
        ],
        edges: [{ from: 'trigger', to: 'mail' }],
      }),
    );
    await recordMemberEvent(
      env.DB,
      { type: 'confirmed', memberId: member, payload: { method: 'single_opt_in' } },
      h.clock.now,
    );
    await enrollFromEvents(h.env, h.clock.now);
    await settle(h, sends);
    const [run] = await runsOf(flow.flowId, member);
    expect(sends.outbox.accepted).toHaveLength(0);
    expect(await holdOf(run!.id)).toMatchObject({ reason: 'quiet_hours' });
  });
});

describe('inbox rules: a hold that outlives its step', () => {
  it('is closed by the next delivery when a consumer died before releasing it', async () => {
    const { seed, h, sends, member } = await setup(
      { quietHours: { start: '22:00', end: '08:00' } },
      Date.UTC(2026, 10, 2, 23, 0),
    );
    const flow = await publishFlow(seed, emails('go', {}, {}));
    await fire(h, member, 'go');
    await settle(h, sends);
    const [run] = await runsOf(flow.flowId, member);
    // The step closed and the consumer died before it released the hold or moved the run.
    await env.DB.prepare(
      `UPDATE flow_run_steps SET status = 'done', outcome = 'default', result_json = '{}'
        WHERE run_id = ?1 AND node_id = 'mail0'`,
    )
      .bind(run!.id)
      .run();
    await runStep(
      h.env,
      { type: 'flow_step', runId: run!.id, nodeId: 'mail0', attempt: 1 },
      Date.UTC(2026, 10, 3, 8, 1),
    );
    expect(await holdOf(run!.id)).toMatchObject({ outcome: 'sent' });
  });

  it('does not count, and holds nobody up, once its run has moved on', async () => {
    const { seed, h, sends, member } = await setup(
      { quietHours: { start: '22:00', end: '08:00' } },
      Date.UTC(2026, 10, 2, 23, 0),
    );
    const first = await publishFlow(seed, emails('first', {}));
    await fire(h, member, 'first');
    await settle(h, sends);
    const [run] = await runsOf(first.flowId, member);
    expect(await heldNowInChannel(env.DB, seed.channelId)).toBe(1);
    await env.DB.prepare(`UPDATE flow_runs SET current_node_id = 'elsewhere' WHERE id = ?1`)
      .bind(run!.id)
      .run();
    expect(await heldNowInChannel(env.DB, seed.channelId)).toBe(0);

    const second = await publishFlow(seed, emails('second', {}));
    await fire(h, member, 'second');
    await settle(h, sends);
    const [behind] = await runsOf(second.flowId, member);
    expect(await holdOf(behind!.id)).toMatchObject({
      reason: 'quiet_hours',
      until: Date.UTC(2026, 10, 3, 8),
    });
  });
});

describe('inbox rules: the limit', () => {
  it('sends stacked emails in order, spaced by the limit, across automations', async () => {
    const { seed, h, sends, member } = await setup({ perDay: 1 });
    const flows = [
      await publishFlow(seed, emails('a', {})),
      await publishFlow(seed, emails('b', {})),
      await publishFlow(seed, emails('c', {})),
    ];
    const subjects = new Map<string, string>();
    for (const [i, flow] of flows.entries()) {
      subjects.set(Object.values(flow.broadcasts)[0]!, 'abc'[i]!);
    }
    for (const name of ['a', 'b', 'c']) {
      await fire(h, member, name);
      await h.drain();
      h.clock.now += 1000;
    }
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(1);

    const sentAt: number[] = [];
    let seen = 1;
    for (let hour = 0; hour < 72 && seen < 3; hour++) {
      await advance(h, sends, HOUR);
      if (sends.outbox.accepted.length > seen) {
        seen = sends.outbox.accepted.length;
        sentAt.push(h.clock.now);
      }
    }
    expect(seen).toBe(3);
    // In the order they were held, and never two within the 24 hours.
    expect(sends.outbox.accepted.map((m) => subjects.get(m.tags!.broadcast!))).toEqual([
      'a',
      'b',
      'c',
    ]);
    const ledger = (
      await env.DB.prepare(
        'SELECT sent_at FROM flow_email_ledger WHERE member_id = ?1 ORDER BY sent_at',
      )
        .bind(member)
        .all<{ sent_at: number }>()
    ).results.map((r) => r.sent_at);
    expect(ledger).toHaveLength(3);
    expect(ledger[1]! - ledger[0]!).toBeGreaterThanOrEqual(DAY);
    expect(ledger[2]! - ledger[1]!).toBeGreaterThanOrEqual(DAY);
  });

  it('never gives two runs the last place, whichever way the steps interleave', async () => {
    const { seed, h, sends, member } = await setup({ perDay: 1 });
    await publishFlow(seed, emails('a', {}));
    await publishFlow(seed, emails('b', {}));
    await fire(h, member, 'a');
    await fire(h, member, 'b');
    const stepJobs = () =>
      h.jobs.items
        .splice(0)
        .flatMap((item) => (item.message.type === 'flow_step' ? [item.message] : []));
    // Past the triggers one by one, then both email steps at the same moment.
    for (const message of stepJobs()) await runStep(h.env, message, h.clock.now);
    await Promise.all(stepJobs().map((message) => runStep(h.env, message, h.clock.now)));
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(1);
    expect(
      await count('SELECT count(*) AS n FROM flow_email_ledger WHERE member_id = ?1', member),
    ).toBe(1);
  });

  it('takes a place in the ledger only while there is room', async () => {
    const { seed, member, h } = await setup(null);
    const flow = await publishFlow(seed, emails('go', {}, {}, {}));
    const [first, second, third] = Object.values(flow.broadcasts) as [string, string, string];
    const run = { member_id: member, channel_id: seed.channelId };
    const rules = InboxRulesSchema.parse({ perDay: 1 });
    const take = (broadcastId: string, sendRegardless = false) =>
      takeLedgerSlot(env.DB, { run, broadcastId, rules, sendRegardless, now: h.clock.now });
    expect(await take(first)).toBe(true);
    expect(await take(second)).toBe(false);
    // A retried step keeps the place it already has; an exempt email always gets one.
    expect(await take(first)).toBe(true);
    expect(await take(third, true)).toBe(true);
    expect(
      await count('SELECT count(*) AS n FROM flow_email_ledger WHERE member_id = ?1', member),
    ).toBe(2);
  });

  it('does not let a paused automation hold up the line', async () => {
    const { seed, h, sends, member } = await setup({ perDay: 1 });
    await publishFlow(seed, emails('first', {}));
    const paused = await publishFlow(seed, emails('paused', {}));
    const other = await publishFlow(seed, emails('other', {}));
    await fire(h, member, 'first');
    await settle(h, sends);
    await fire(h, member, 'paused');
    await settle(h, sends);
    h.clock.now += 1000;
    await fire(h, member, 'other');
    await settle(h, sends);
    await env.DB.prepare("UPDATE flows SET status = 'paused' WHERE id = ?1")
      .bind(paused.flowId)
      .run();

    await advance(h, sends, 25 * HOUR, HOUR);
    await advance(h, sends, 2 * HOUR, 15 * 60_000);
    const [run] = await runsOf(other.flowId, member);
    expect(run!.status).toBe('completed');
    expect(sends.outbox.accepted).toHaveLength(2);

    // Back from its pause, the first email in line still goes, once there is room.
    await env.DB.prepare("UPDATE flows SET status = 'live' WHERE id = ?1")
      .bind(paused.flowId)
      .run();
    await resumeFlowRuns(h.env, paused.flowId, h.clock.now);
    await advance(h, sends, 25 * HOUR, HOUR);
    expect(sends.outbox.accepted).toHaveLength(3);
  });

  it('forgets ledger rows past the longest window, and no sooner', async () => {
    const { seed, h, sends, member } = await setup(null);
    await publishFlow(seed, emails('go', {}));
    await fire(h, member, 'go');
    await settle(h, sends);
    const where = 'SELECT count(*) AS n FROM flow_email_ledger WHERE member_id = ?1';
    await pruneFlowEmailLedger(env.DB, h.clock.now + 7 * DAY);
    expect(await count(where, member)).toBe(1);
    await pruneFlowEmailLedger(env.DB, h.clock.now + 9 * DAY);
    expect(await count(where, member)).toBe(0);
    expect(seed.channelId).toBeTruthy();
  });
});

describe('inbox rules: send regardless', () => {
  it('sends a marked email through every rule, and it counts toward the limit', async () => {
    const { seed, h, sends, member } = await setup(
      { perDay: 1, quietHours: { start: '22:00', end: '08:00' } },
      Date.UTC(2026, 10, 2, 23, 0),
    );
    const flow = await publishFlow(seed, emails('go', { sendRegardless: true }, {}));
    await fire(h, member, 'go');
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(1);
    const [run] = await runsOf(flow.flowId, member);
    expect(run).toMatchObject({ status: 'waiting', current_node_id: 'mail1' });
    // The next email waits for the limit too. Room comes at 23:00 tomorrow, which is inside quiet
    // hours again, so 08:00 the day after is the first moment both rules agree.
    expect(await holdOf(run!.id)).toMatchObject({
      reason: 'quiet_hours',
      until: Date.UTC(2026, 10, 4, 8, 0),
    });
    expect(
      await one('SELECT send_regardless FROM flow_email_ledger WHERE member_id = ?1', member),
    ).toMatchObject({ send_regardless: 1 });
  });

  it('treats the first email after someone confirms as a welcome, and later ones not', async () => {
    const { seed, h, sends, member } = await setup(
      { quietHours: { start: '22:00', end: '08:00' } },
      Date.UTC(2026, 10, 2, 23, 0),
    );
    const welcome = FlowGraphSchema.parse({
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'confirmed' } },
        { id: 'hello', type: 'send_email', config: { dispatchId: dispatchId() } },
        { id: 'next', type: 'send_email', config: { dispatchId: dispatchId() } },
      ],
      edges: [
        { from: 'trigger', to: 'hello' },
        { from: 'hello', to: 'next' },
      ],
    });
    const flow = await publishFlow(seed, welcome);
    await recordMemberEvent(
      env.DB,
      { type: 'confirmed', memberId: member, payload: { method: 'single_opt_in' } },
      h.clock.now,
    );
    await enrollFromEvents(h.env, h.clock.now);
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(1);
    const [run] = await runsOf(flow.flowId, member);
    expect(run).toMatchObject({ status: 'waiting', current_node_id: 'next' });
  });

  it('lets a writer turn the welcome default off', async () => {
    const { seed, h, sends, member } = await setup(
      { quietHours: { start: '22:00', end: '08:00' } },
      Date.UTC(2026, 10, 2, 23, 0),
    );
    const graph = FlowGraphSchema.parse({
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'confirmed' } },
        {
          id: 'hello',
          type: 'send_email',
          config: { dispatchId: dispatchId(), sendRegardless: false },
        },
      ],
      edges: [{ from: 'trigger', to: 'hello' }],
    });
    await publishFlow(seed, graph);
    await recordMemberEvent(
      env.DB,
      { type: 'confirmed', memberId: member, payload: { method: 'single_opt_in' } },
      h.clock.now,
    );
    await enrollFromEvents(h.env, h.clock.now);
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(0);
  });
});

describe('inbox rules: test runs', () => {
  it('are never held and never count', async () => {
    const { seed, h, sends, member } = await setup({
      perDay: 1,
      quietHours: { start: '00:00', end: '23:59' },
    });
    const graph = emails('go', {});
    const flow = await publishFlow(seed, graph);
    await startFlowRun(h.env, {
      flowId: flow.flowId,
      version: 1,
      memberId: member,
      channelId: seed.channelId,
      graph,
      test: true,
      now: h.clock.now,
    });
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(1);
    expect(
      await count('SELECT count(*) AS n FROM flow_email_ledger WHERE member_id = ?1', member),
    ).toBe(0);
  });
});

describe('inbox rules: newsletter day', () => {
  const day = { newsletterDay: { hoursAround: 0 } };

  it('holds until tomorrow when the subscriber got a post today', async () => {
    const { seed, h, sends, member } = await setup(day);
    await postGot(seed, member, NOON - HOUR);
    const flow = await publishFlow(seed, emails('go', {}));
    await fire(h, member, 'go');
    await settle(h, sends);
    const [run] = await runsOf(flow.flowId, member);
    expect(await holdOf(run!.id)).toMatchObject({
      reason: 'newsletter_day',
      until: Date.UTC(2026, 10, 3),
    });
    await advance(h, sends, 13 * HOUR);
    expect(sends.outbox.accepted).toHaveLength(1);
  });

  it('does not hold someone else, who got no post', async () => {
    const { seed, h, sends, member } = await setup(day);
    const other = await addMember(seed.channelId, `other-${crypto.randomUUID()}@example.com`);
    await postGot(seed, other, NOON - HOUR);
    await publishFlow(seed, emails('go', {}));
    await fire(h, member, 'go');
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(1);
  });

  it('holds for a post scheduled later today, when the subscriber is in its audience', async () => {
    const { seed, h, sends, member } = await setup(day);
    await postScheduled(seed, NOON + 5 * HOUR);
    await publishFlow(seed, emails('go', {}));
    await fire(h, member, 'go');
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(0);
  });

  it('does not hold for a scheduled post whose audience leaves the subscriber out', async () => {
    const { seed, h, sends, member } = await setup(day);
    const circle = newId('circle', NOON);
    await env.DB.prepare(
      `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Nobody', ?4, ?5, ?5)`,
    )
      .bind(
        circle,
        seed.workspaceId,
        seed.channelId,
        JSON.stringify({ field: 'email', cmp: 'eq', value: 'nobody@example.com' }),
        NOON,
      )
      .run();
    await postScheduled(seed, NOON + 5 * HOUR, { include: [circle], exclude: [] });
    await publishFlow(seed, emails('go', {}));
    await fire(h, member, 'go');
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(1);
  });

  it('holds for the hours around a post on another day', async () => {
    const { seed, h, sends, member } = await setup({ newsletterDay: { hoursAround: 6 } });
    h.clock.now = Date.UTC(2026, 10, 3, 3, 0);
    await postGot(seed, member, Date.UTC(2026, 10, 2, 23, 0));
    const flow = await publishFlow(seed, emails('go', {}));
    await fire(h, member, 'go');
    await settle(h, sends);
    const [run] = await runsOf(flow.flowId, member);
    expect(await holdOf(run!.id)).toMatchObject({
      reason: 'near_post',
      until: Date.UTC(2026, 10, 3, 5, 0),
    });
  });

  it('holds no email that is marked send regardless', async () => {
    const { seed, h, sends, member } = await setup(day);
    await postGot(seed, member, NOON - HOUR);
    await publishFlow(seed, emails('go', { sendRegardless: true }));
    await fire(h, member, 'go');
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(1);
  });
});

describe('inbox rules: a wait that goes stale', () => {
  it('exits with a visible reason instead of arriving late', async () => {
    const { seed, h, sends, member } = await setup({ perWeek: 1, maxHoldDays: 2 });
    await publishFlow(seed, emails('first', {}));
    const late = await publishFlow(seed, emails('late', {}));
    await fire(h, member, 'first');
    await settle(h, sends);
    await fire(h, member, 'late');
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(1);
    const [run] = await runsOf(late.flowId, member);
    expect(run).toMatchObject({ status: 'exited', exit_reason: 'hold_expired' });
    expect(await holdOf(run!.id)).toMatchObject({ reason: 'weekly_limit', outcome: 'expired' });
    await advance(h, sends, 8 * DAY, 12 * HOUR);
    expect(sends.outbox.accepted).toHaveLength(1);
  });

  it('counts from when the wait began, across re-checks', async () => {
    const { seed, h, sends, member } = await setup({ perDay: 1, maxHoldDays: 3 });
    const graph = emails('go', {}, {}, {}, {}, {});
    const flow = await publishFlow(seed, graph);
    await fire(h, member, 'go');
    await advance(h, sends, 6 * DAY, 6 * HOUR);
    // One a day: each new step starts its own wait, so no single wait goes stale.
    expect(sends.outbox.accepted).toHaveLength(5);
    const [run] = await runsOf(flow.flowId, member);
    expect(run!.status).toBe('completed');
  });
});

describe('inbox rules: changing the rules', () => {
  it('looks at held emails again as soon as a rule is loosened', async () => {
    const { seed, h, sends, member } = await setup(
      { quietHours: { start: '22:00', end: '08:00' } },
      Date.UTC(2026, 10, 2, 23, 0),
    );
    const flow = await publishFlow(seed, emails('go', {}));
    await fire(h, member, 'go');
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(0);
    await saveInboxRules(
      env.DB,
      seed.channelId,
      { rules: InboxRulesSchema.parse({}), timezone: null },
      h.clock.now,
    );
    await sweepFlows(h.env, h.clock.now);
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(1);
    const [run] = await runsOf(flow.flowId, member);
    expect(run!.status).toBe('completed');
    expect(await holdOf(run!.id)).toMatchObject({ outcome: 'sent' });
  });

  it('keeps the settings next to it, and a time zone can be set and cleared', async () => {
    const { seed, h } = await setup(null);
    await env.DB.prepare(
      `UPDATE channels SET settings_json = '{"doubleOptIn":false}' WHERE id = ?1`,
    )
      .bind(seed.channelId)
      .run();
    const settings = async () =>
      JSON.parse(
        (await one<{ settings_json: string }>(
          'SELECT settings_json FROM channels WHERE id = ?1',
          seed.channelId,
        ))!.settings_json,
      ) as Record<string, unknown>;
    const rules = InboxRulesSchema.parse({ perDay: 3 });
    await saveInboxRules(env.DB, seed.channelId, { rules, timezone: 'Europe/Prague' }, h.clock.now);
    expect(await settings()).toEqual({
      doubleOptIn: false,
      inboxRules: rules,
      timezone: 'Europe/Prague',
    });
    await saveInboxRules(env.DB, seed.channelId, { rules, timezone: null }, h.clock.now);
    expect(await settings()).toEqual({ doubleOptIn: false, inboxRules: rules });
  });
});

describe('repeat sends across versions', () => {
  const live = async (flowId: string, version: number) => {
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE flow_versions SET retired_at = ?1 WHERE flow_id = ?2 AND version < ?3',
      ).bind(Date.now(), flowId, version),
      env.DB.prepare('UPDATE flows SET live_version = ?1 WHERE id = ?2').bind(version, flowId),
    ]);
  };

  async function reentered() {
    const seed = await seedChannel();
    const h = harness(NOON);
    const sends = attachPipeline(h);
    const graph = emails('go', {});
    const flow = await publishFlow(seed, graph, { reentry: 'after_exit' });
    const member = await addMember(seed.channelId, `again-${crypto.randomUUID()}@example.com`);
    const go = async () => {
      h.clock.now += 1000;
      await fire(h, member, 'go');
      await settle(h, sends);
    };
    return { seed, h, sends, graph, flow, member, go };
  }

  it('sends nothing when the same version is entered again (as before)', async () => {
    const { sends, go } = await reentered();
    await go();
    await go();
    expect(sends.outbox.accepted).toHaveLength(1);
  });

  it('sends nothing more from a new version, and the step says why', async () => {
    const { seed, sends, graph, flow, member, go } = await reentered();
    await go();
    await publishVersion(seed, flow.flowId, 2, graph);
    await live(flow.flowId, 2);
    await go();
    expect(sends.outbox.accepted).toHaveLength(1);
    const runs = await runsOf(flow.flowId, member);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ version: 2, status: 'completed' });
    const step = (await stepsOf(runs[1]!.id)).at(-1)!;
    expect(step.status).toBe('skipped');
    expect(JSON.parse(step.result_json!)).toMatchObject({ skipped: 'already_received' });
  });

  it('still sends a different email on the same step', async () => {
    const { seed, sends, flow, go } = await reentered();
    await go();
    await publishVersion(seed, flow.flowId, 2, emails('go', {}));
    await live(flow.flowId, 2);
    await go();
    expect(sends.outbox.accepted).toHaveLength(2);
  });

  it('sends again when the writer asked at publish, once per asking', async () => {
    const { seed, sends, graph, flow, go } = await reentered();
    await go();
    await publishVersion(seed, flow.flowId, 2, graph);
    await env.DB.prepare('UPDATE flow_emails SET resend = 1 WHERE flow_id = ?1 AND version = 2')
      .bind(flow.flowId)
      .run();
    await live(flow.flowId, 2);
    await go();
    expect(sends.outbox.accepted).toHaveLength(2);
    // A later version without the request: they have this email since the resend, so it stops.
    await publishVersion(seed, flow.flowId, 3, graph);
    await live(flow.flowId, 3);
    await go();
    expect(sends.outbox.accepted).toHaveLength(2);
  });

  it('stops a migrated run from getting an email it already had', async () => {
    const seed = await seedChannel();
    const h = harness(NOON);
    const sends = attachPipeline(h);
    const mail = dispatchId();
    const v1 = FlowGraphSchema.parse({
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'api_event', name: 'go' } },
        { id: 'mail', type: 'send_email', config: { dispatchId: mail } },
        { id: 'wait', type: 'delay', config: { mode: 'duration', amount: 1, unit: 'hours' } },
      ],
      edges: [
        { from: 'trigger', to: 'mail' },
        { from: 'mail', to: 'wait' },
      ],
    });
    // The writer moved the email behind the wait in version 2.
    const v2 = FlowGraphSchema.parse({
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'api_event', name: 'go' } },
        { id: 'wait', type: 'delay', config: { mode: 'duration', amount: 1, unit: 'hours' } },
        { id: 'mail', type: 'send_email', config: { dispatchId: mail } },
      ],
      edges: [
        { from: 'trigger', to: 'wait' },
        { from: 'wait', to: 'mail' },
      ],
    });
    const flow = await publishFlow(seed, v1);
    const member = await addMember(seed.channelId, `moved-${crypto.randomUUID()}@example.com`);
    await fire(h, member, 'go');
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(1);
    await publishVersion(seed, flow.flowId, 2, v2);
    await live(flow.flowId, 2);
    await migrateRuns(h.env, flow.flowId, 1, 2, h.clock.now);
    await advance(h, sends, 2 * HOUR);
    expect(sends.outbox.accepted).toHaveLength(1);
    const [run] = await runsOf(flow.flowId, member);
    expect(run!.status).toBe('completed');
  });

  it('sends to someone whose earlier copy was stopped before it went', async () => {
    const { seed, h, sends, graph, flow, member, go } = await reentered();
    await fire(h, member, 'go');
    await h.drain();
    // The email is queued and has not gone: the send consumer finds them gone and skips it.
    await env.DB.prepare("UPDATE members SET status = 'paused' WHERE id = ?1").bind(member).run();
    await sends.consumeDue();
    expect(sends.outbox.accepted).toHaveLength(0);
    await env.DB.prepare("UPDATE members SET status = 'active' WHERE id = ?1").bind(member).run();
    await publishVersion(seed, flow.flowId, 2, graph);
    await live(flow.flowId, 2);
    h.clock.now += 1000;
    await go();
    expect(sends.outbox.accepted).toHaveLength(1);
  });

  it('lets a test run show the new version to a writer who already had the email', async () => {
    const { seed, h, sends, graph, flow, member, go } = await reentered();
    await go();
    await publishVersion(seed, flow.flowId, 2, graph);
    await live(flow.flowId, 2);
    await startFlowRun(h.env, {
      flowId: flow.flowId,
      version: 2,
      memberId: member,
      channelId: seed.channelId,
      graph,
      test: true,
      now: h.clock.now,
    });
    await settle(h, sends);
    expect(sends.outbox.accepted).toHaveLength(2);
  });
});
