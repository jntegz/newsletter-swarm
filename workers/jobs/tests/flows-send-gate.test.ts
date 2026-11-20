// Regression (found by flows-fuzz.test.ts): a Flow step checked the Member and queued the email,
// but the send consumer mailed whoever was on the recipient row, so someone who left between the
// two (a slow queue, a provider throttling and a retry 30 seconds later) still got it. The send
// consumer now applies the same check at the moment it claims the row.
import { env } from 'cloudflare:test';
import { FlowGraphSchema, newId, type FlowGraph } from '@swarm/domain';
import {
  addManualSuppression,
  applySesEvent,
  enrollFromEvents,
  eraseAddress,
  pauseMember,
  recordMemberEvent,
  setMemberEmails,
  suppress,
  unsubscribeMember,
} from '@swarm/engine';
import { MailProviderError } from '@swarm/mail';
import { parseKeyring } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import { addMember, count, one, seedChannel } from './helpers';
import { HOUR, attachPipeline, dispatchId, harness, publishFlow, runsOf } from './flows-helpers';

const markerKeys = parseKeyring(env.TEST_FIELD_KEYS);

const oneEmail = (): FlowGraph =>
  FlowGraphSchema.parse({
    schema: 1,
    nodes: [
      { id: 'trigger', type: 'trigger', config: { event: 'api_event', name: 'go' } },
      { id: 'email', type: 'send_email', config: { dispatchId: dispatchId() } },
    ],
    edges: [{ from: 'trigger', to: 'email' }],
  });

type Seed = Awaited<ReturnType<typeof seedChannel>>;
type Leaver = (seed: Seed, member: { id: string; email: string }, now: number) => Promise<unknown>;

const WAYS_OF_LEAVING: [string, Leaver][] = [
  ['unsubscribes', (_, m, now) => unsubscribeMember(env.DB, m.id, null, now)],
  [
    'hard bounces',
    (s, m, now) => suppress(env.DB, s.workspaceId, m.email, 'hard_bounce', 'x', 'bounced', now),
  ],
  [
    'hits the soft bounce limit',
    (s, m, now) => suppress(env.DB, s.workspaceId, m.email, 'soft_bounce', 'x', 'bounced', now),
  ],
  [
    'complains',
    (s, m, now) => suppress(env.DB, s.workspaceId, m.email, 'complaint', 'x', 'complained', now),
  ],
  [
    'is suppressed for the workspace',
    (s, m, now) =>
      addManualSuppression(env.DB, {
        workspaceId: s.workspaceId,
        channelId: null,
        email: m.email,
        now,
      }),
  ],
  [
    'is suppressed for the Channel',
    (s, m, now) =>
      addManualSuppression(env.DB, {
        workspaceId: s.workspaceId,
        channelId: s.channelId,
        email: m.email,
        now,
      }),
  ],
  ['pauses', (_, m, now) => pauseMember(env.DB, m.id, 2, now)],
  // "Stop emails, keep my membership" (S03-P5-G-paid-mail-choice): still subscribed, no Flow mail.
  ['turns emails off', (_, m, now) => setMemberEmails(env.DB, m.id, false, now)],
  ['is deleted', (_, m) => env.DB.prepare('DELETE FROM members WHERE id = ?1').bind(m.id).run()],
  [
    'is erased',
    (s, m, now) =>
      eraseAddress(env.DB, { workspaceId: s.workspaceId, email: m.email, keys: markerKeys }, now),
  ],
];

/** A Member whose Flow email is queued but not sent yet. */
async function queuedEmail() {
  const seed = await seedChannel();
  const h = harness();
  const sends = attachPipeline(h);
  const flow = await publishFlow(seed, oneEmail());
  const email = `gate-${crypto.randomUUID()}@example.com`;
  const id = await addMember(seed.channelId, email);
  await recordMemberEvent(
    env.DB,
    { type: 'api_event', memberId: id, payload: { name: 'go' } },
    h.clock.now,
  );
  await enrollFromEvents(h.env, h.clock.now);
  await h.drain();
  expect(sends.items).toHaveLength(1);
  return { seed, h, sends, flow, member: { id, email } };
}

const recipientStatus = (broadcastId: string, memberId: string) =>
  one<{ status: string }>(
    'SELECT status FROM broadcast_recipients WHERE broadcast_id = ?1 AND member_id = ?2',
    broadcastId,
    memberId,
  );

describe('Flow emails: a Channel that stopped sending', () => {
  async function waitingFlow() {
    const seed = await seedChannel();
    const h = harness();
    const sends = attachPipeline(h);
    const flow = await publishFlow(seed, oneEmail());
    const id = await addMember(seed.channelId, `channel-${crypto.randomUUID()}@example.com`);
    return { seed, h, sends, flow, id };
  }
  const start = async (h: ReturnType<typeof harness>, id: string) => {
    await recordMemberEvent(
      env.DB,
      { type: 'api_event', memberId: id, payload: { name: 'go' } },
      h.clock.now,
    );
    await enrollFromEvents(h.env, h.clock.now);
    await h.drain();
  };

  it('regression: a paused Channel holds its Flow emails, and sends them when it comes back', async () => {
    const { seed, h, sends, flow, id } = await waitingFlow();
    await env.DB.prepare("UPDATE channels SET status = 'paused' WHERE id = ?1")
      .bind(seed.channelId)
      .run();
    await start(h, id);
    expect(sends.items).toEqual([]);
    expect((await runsOf(flow.flowId, id))[0]?.status).toBe('waiting');

    await h.advance(2 * HOUR);
    expect(sends.items).toEqual([]);

    await env.DB.prepare("UPDATE channels SET status = 'active' WHERE id = ?1")
      .bind(seed.channelId)
      .run();
    await h.advance(2 * HOUR);
    await sends.consumeDue();
    expect(sends.outbox.accepted).toHaveLength(1);
    expect((await runsOf(flow.flowId, id))[0]?.status).toBe('completed');
  });

  it('regression: a deleted Channel starts no runs and sends nothing', async () => {
    const { seed, h, sends, flow, id } = await waitingFlow();
    await env.DB.prepare('UPDATE channels SET deleted_at = ?1 WHERE id = ?2')
      .bind(h.clock.now, seed.channelId)
      .run();
    await start(h, id);
    expect(sends.items).toEqual([]);
    expect(await runsOf(flow.flowId, id)).toEqual([]);
  });
});

describe('Flow emails: the check at the moment of sending', () => {
  it('queues no Flow email for a Member who turned emails off, and leaves them subscribed', async () => {
    const seed = await seedChannel();
    const h = harness();
    const sends = attachPipeline(h);
    await publishFlow(seed, oneEmail());
    const id = await addMember(seed.channelId, `off-${crypto.randomUUID()}@example.com`);
    expect(await setMemberEmails(env.DB, id, false, h.clock.now)).toBe(true);
    await recordMemberEvent(
      env.DB,
      { type: 'api_event', memberId: id, payload: { name: 'go' } },
      h.clock.now,
    );
    await enrollFromEvents(h.env, h.clock.now);
    await h.drain();
    await sends.consumeDue();
    expect(sends.outbox.accepted).toEqual([]);
    expect(await one('SELECT status FROM members WHERE id = ?1', id)).toEqual({ status: 'active' });
  });

  it('sends a queued email to a Member who stayed', async () => {
    const { sends, flow, member } = await queuedEmail();
    await sends.consumeDue();
    expect(sends.outbox.accepted.map((m) => m.to)).toEqual([member.email]);
    expect((await recipientStatus(flow.broadcasts.email!, member.id))?.status).toBe('sent');
  });

  it.each(WAYS_OF_LEAVING)(
    'regression: sends nothing when the Member %s after the email was queued',
    async (_, leave) => {
      const { seed, h, sends, flow, member } = await queuedEmail();
      await leave(seed, member, h.clock.now);
      await sends.consumeDue();
      expect(sends.outbox.accepted).toEqual([]);
      expect(
        await count(
          'SELECT count(*) AS n FROM deliveries WHERE broadcast_id = ?1',
          flow.broadcasts.email,
        ),
      ).toBe(0);
    },
  );

  it.each(WAYS_OF_LEAVING)(
    'regression: sends nothing on the retry when the Member %s while the provider was throttling',
    async (_, leave) => {
      const { seed, h, sends, member } = await queuedEmail();
      let attempts = 0;
      sends.outbox.fail = () => {
        attempts++;
        return new MailProviderError(429, 'throttled', 'Slow down', 30);
      };
      await sends.consume(0);
      expect(attempts).toBe(1);
      expect(sends.items).toHaveLength(1);

      await leave(seed, member, h.clock.now);
      h.clock.now += 31_000;
      sends.outbox.fail = null;
      await sends.consumeDue();
      expect(sends.outbox.accepted).toEqual([]);
    },
  );

  it('regression: a stale claim is not sent either once the Member has left', async () => {
    const { seed, h, sends, flow, member } = await queuedEmail();
    const message = sends.items[0]!.message;
    // A consumer claimed the row and died; its message comes back after the claim timed out.
    await env.DB.prepare(
      `UPDATE broadcast_recipients SET status = 'sending', claimed_at = ?1 WHERE broadcast_id = ?2 AND member_id = ?3`,
    )
      .bind(h.clock.now, flow.broadcasts.email, member.id)
      .run();
    await suppress(
      env.DB,
      seed.workspaceId,
      member.email,
      'complaint',
      'x',
      'complained',
      h.clock.now,
    );
    h.clock.now += 24 * 3_600_000;
    await sends.send(message);
    await sends.consumeDue();
    expect(sends.outbox.accepted).toEqual([]);
    expect((await recipientStatus(flow.broadcasts.email!, member.id))?.status).toBe('skipped');
  });

  it('a suppression for another Channel does not stop the email', async () => {
    const { seed, sends, member } = await queuedEmail();
    const otherChannelId = newId('channel');
    await env.DB.prepare(
      `INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Other', 0, 0)`,
    )
      .bind(otherChannelId, seed.workspaceId, `ch-${otherChannelId.slice(-12)}`)
      .run();
    await addManualSuppression(env.DB, {
      workspaceId: seed.workspaceId,
      channelId: otherChannelId,
      email: member.email,
    });
    await sends.consumeDue();
    expect(sends.outbox.accepted.map((m) => m.to)).toEqual([member.email]);
  });

  it('a provider bounce for this address stops the next queued email', async () => {
    const seed = await seedChannel();
    const h = harness();
    const sends = attachPipeline(h);
    const graph = FlowGraphSchema.parse({
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'api_event', name: 'go' } },
        { id: 'first', type: 'send_email', config: { dispatchId: dispatchId() } },
        { id: 'second', type: 'send_email', config: { dispatchId: dispatchId() } },
      ],
      edges: [
        { from: 'trigger', to: 'first' },
        { from: 'first', to: 'second' },
      ],
    });
    await publishFlow(seed, graph);
    const email = `bounce-${crypto.randomUUID()}@example.com`;
    const id = await addMember(seed.channelId, email);
    await recordMemberEvent(
      env.DB,
      { type: 'api_event', memberId: id, payload: { name: 'go' } },
      h.clock.now,
    );
    await enrollFromEvents(h.env, h.clock.now);
    await h.drain();
    // Both emails are queued. The first goes out and bounces before the second is consumed.
    expect(sends.items).toHaveLength(2);
    await sends.consume(0);
    expect(sends.outbox.accepted).toHaveLength(1);
    await applySesEvent(
      env.DB,
      {
        eventType: 'Bounce',
        mail: { tags: { delivery: [String(sends.outbox.accepted[0]!.tags?.delivery)] } },
        bounce: { bounceType: 'Permanent', bounceSubType: 'General' },
      },
      h.clock.now,
    );
    await sends.consumeDue();
    expect(sends.outbox.accepted).toHaveLength(1);
  });
});
