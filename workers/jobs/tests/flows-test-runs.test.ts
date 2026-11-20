// A test run sends real mail, but it must not cost the person their real run or their real email,
// and its sends stay out of the numbers.
import { env } from 'cloudflare:test';
import { broadcastStats, startFlowRun, sweepFlows } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { addMember, seedChannel } from './helpers';
import {
  HOUR,
  addLinkTarget,
  attachPipeline,
  dispatchId,
  harness,
  publishFlow,
  publishVersion,
  recipientsOf,
  runsOf,
  stepsOf,
  type Harness,
} from './flows-helpers';

const email = () => `t-${crypto.randomUUID().slice(0, 8)}@example.com`;

const oneEmail = (delayHours = 0) => ({
  schema: 1 as const,
  nodes: [
    {
      id: 'trigger',
      type: 'trigger' as const,
      config: { event: 'api_event' as const, name: 'go' },
    },
    ...(delayHours
      ? [
          {
            id: 'pause',
            type: 'delay' as const,
            config: { mode: 'duration' as const, amount: delayHours, unit: 'hours' as const },
          },
        ]
      : []),
    {
      id: 'mail',
      type: 'send_email' as const,
      config: { dispatchId: dispatchId(), audience: 'any' as const },
    },
  ],
  edges: delayHours
    ? [
        { from: 'trigger', to: 'pause', label: 'default' as const },
        { from: 'pause', to: 'mail', label: 'default' as const },
      ]
    : [{ from: 'trigger', to: 'mail', label: 'default' as const }],
});

const starter =
  (h: Harness, flowId: string, memberId: string, channelId: string) => (test: boolean) =>
    startFlowRun(h.env, { flowId, version: 1, memberId, channelId, test, now: h.clock.now });

describe('Flows: test runs stay out of the real run', () => {
  it('reaches the provider through the real send pipeline, from its own copy', async () => {
    const seed = await seedChannel();
    const h = harness();
    const pipeline = attachPipeline(h);
    const flow = await publishFlow(seed, oneEmail());
    await addLinkTarget(flow.broadcasts.mail!);
    const member = await addMember(seed.channelId, email());
    const start = starter(h, flow.flowId, member, seed.channelId);
    await start(true);
    await h.drain();
    await pipeline.consumeDue();
    await start(false);
    await h.drain();
    await pipeline.consumeDue();

    const sent = pipeline.outbox.accepted.map((m) => m.tags?.broadcast);
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toBe(flow.broadcasts.mail);
    expect(sent[1]).toBe(flow.broadcasts.mail);
    const stats = await broadcastStats(env.DB, flow.broadcasts.mail!);
    expect(stats.sent).toBe(1);
  });

  it('sends a second email whose step id Object.prototype has', async () => {
    // Step ids are any 1 to 40 of letters, digits, - and _: "constructor" is one.
    const seed = await seedChannel();
    const h = harness();
    const flow = await publishFlow(seed, {
      schema: 1 as const,
      nodes: [
        {
          id: 'trigger',
          type: 'trigger' as const,
          config: { event: 'api_event' as const, name: 'go' },
        },
        {
          id: 'mail',
          type: 'send_email' as const,
          config: { dispatchId: dispatchId(), audience: 'any' as const },
        },
        {
          id: 'constructor',
          type: 'send_email' as const,
          config: { dispatchId: dispatchId(), audience: 'any' as const },
        },
      ],
      edges: [
        { from: 'trigger', to: 'mail', label: 'default' as const },
        { from: 'mail', to: 'constructor', label: 'default' as const },
      ],
    });
    const member = await addMember(seed.channelId, email());
    const run = await starter(h, flow.flowId, member, seed.channelId)(true);
    await h.drain();
    const second = (await stepsOf(run!)).find((s) => s.node_id === 'constructor');
    expect(second?.status).toBe('done');
    expect(h.sends.for(member)).toHaveLength(2);
  });

  it('leaves the real email for a real run on a newer version too', async () => {
    const seed = await seedChannel();
    const h = harness();
    const graph = oneEmail();
    const flow = await publishFlow(seed, graph);
    const member = await addMember(seed.channelId, email());
    await starter(h, flow.flowId, member, seed.channelId)(true);
    await h.drain();
    const broadcasts = await publishVersion(seed, flow.flowId, 2, graph);
    const real = await startFlowRun(h.env, {
      flowId: flow.flowId,
      version: 2,
      memberId: member,
      channelId: seed.channelId,
      now: h.clock.now,
    });
    await h.drain();
    const mail = (await stepsOf(real!)).find((s) => s.node_id === 'mail')!;
    expect(mail.status).toBe('done');
    expect(await recipientsOf(member)).toContain(broadcasts.mail);
  });

  it('does not stop a real run’s second try from counting who it already sent', async () => {
    const seed = await seedChannel();
    const h = harness();
    const flow = await publishFlow(seed, oneEmail());
    const member = await addMember(seed.channelId, email());
    const start = starter(h, flow.flowId, member, seed.channelId);
    // The real email first, then a test: the test still shows the writer the email.
    await start(false);
    await h.drain();
    await start(true);
    await h.drain();
    expect(h.sends.for(member)).toHaveLength(2);
  });

  it('leaves the real email for the real run', async () => {
    const seed = await seedChannel();
    const h = harness();
    const flow = await publishFlow(seed, oneEmail());
    const member = await addMember(seed.channelId, email());
    const start = starter(h, flow.flowId, member, seed.channelId);

    expect(await start(true)).toMatch(/^fr_/);
    await h.drain();
    const real = await start(false);
    expect(real).toMatch(/^fr_/);
    await h.drain();

    const mail = (await stepsOf(real!)).find((s) => s.node_id === 'mail')!;
    expect(mail.status).toBe('done');
    expect(JSON.parse(mail.result_json!)).toEqual({ broadcastId: flow.broadcasts.mail });
    expect(await recipientsOf(member)).toContain(flow.broadcasts.mail);
    // The test's own email and the real one are two different messages.
    const sent = h.sends.for(member).map((m) => m.broadcastId);
    expect(sent).toHaveLength(2);
    expect(new Set(sent).size).toBe(2);
    expect(sent[1]).toBe(flow.broadcasts.mail);
  });

  it('lets someone waiting in a test run enter the real run', async () => {
    const seed = await seedChannel();
    const h = harness();
    const flow = await publishFlow(seed, oneEmail(24));
    const member = await addMember(seed.channelId, email());
    const start = starter(h, flow.flowId, member, seed.channelId);

    expect(await start(true)).toMatch(/^fr_/);
    await h.drain();
    expect(await start(false)).toMatch(/^fr_/);
    await h.drain();
    // Still one open run of each kind.
    expect(await start(false)).toBeNull();
    expect(await start(true)).toBeNull();
    expect((await runsOf(flow.flowId, member)).map((r) => r.status)).toEqual([
      'waiting',
      'waiting',
    ]);
    await h.advance(25 * HOUR);
    expect((await runsOf(flow.flowId, member)).map((r) => r.status)).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('can test the same person twice and sends each time', async () => {
    const seed = await seedChannel();
    const h = harness();
    const flow = await publishFlow(seed, oneEmail());
    const member = await addMember(seed.channelId, email());
    const start = starter(h, flow.flowId, member, seed.channelId);
    await start(true);
    await h.drain();
    await start(true);
    await h.drain();
    expect(h.sends.for(member)).toHaveLength(2);
    expect(await recipientsOf(member)).not.toContain(flow.broadcasts.mail);
  });

  it('gives the test its own copy of the email, links included, and closes it afterwards', async () => {
    const seed = await seedChannel();
    const h = harness();
    const flow = await publishFlow(seed, oneEmail());
    await addLinkTarget(flow.broadcasts.mail!);
    const member = await addMember(seed.channelId, email());
    const run = await starter(h, flow.flowId, member, seed.channelId)(true);
    await h.drain();

    const copy = await env.DB.prepare(
      `SELECT id, kind, status, flow_id, subject, test_run_id, recipient_count FROM broadcasts WHERE test_run_id = ?1`,
    )
      .bind(run)
      .first<Record<string, unknown>>();
    expect(copy).toMatchObject({
      kind: 'flow',
      flow_id: flow.flowId,
      subject: 'Hello',
      recipient_count: 1,
    });
    const links = await env.DB.prepare(
      'SELECT count(*) AS n FROM link_targets WHERE broadcast_id = ?1',
    )
      .bind(copy!.id)
      .first<{ n: number }>();
    expect(links?.n).toBe(1);
    const real = await env.DB.prepare('SELECT recipient_count FROM broadcasts WHERE id = ?1')
      .bind(flow.broadcasts.mail)
      .first<{ recipient_count: number }>();
    expect(real?.recipient_count).toBe(0);

    // The run has ended and nobody is in flight: the sweep closes the copy.
    await env.DB.prepare(`UPDATE broadcast_recipients SET status = 'sent' WHERE broadcast_id = ?1`)
      .bind(copy!.id)
      .run();
    await sweepFlows(h.env, h.clock.now);
    const closed = await env.DB.prepare('SELECT status FROM broadcasts WHERE id = ?1')
      .bind(copy!.id)
      .first<{ status: string }>();
    expect(closed?.status).toBe('sent');
  });
});
