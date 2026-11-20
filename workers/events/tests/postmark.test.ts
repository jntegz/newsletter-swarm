import { SELF, env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { app } from '../src/index';

async function seedDelivery() {
  const now = Date.now();
  const ids = {
    workspace: newId('workspace'),
    channel: newId('channel'),
    member: newId('member'),
    dispatch: newId('dispatch'),
    broadcast: newId('broadcast'),
    delivery: newId('delivery'),
  };
  const email = `reader-${crypto.randomUUID().slice(0, 8)}@example.org`;
  const messageId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
    ).bind(ids.workspace, 'W', now),
    env.DB.prepare(
      `INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, 'Field Notes', ?4, ?4)`,
    ).bind(ids.channel, ids.workspace, `ch-${crypto.randomUUID().slice(0, 8)}`, now),
    env.DB.prepare(
      `INSERT INTO members (id, channel_id, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)`,
    ).bind(ids.member, ids.channel, email, now),
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at) VALUES (?1, ?2, 'S', '{"type":"doc","content":[]}', 'sent', ?3, ?3)`,
    ).bind(ids.dispatch, ids.channel, now),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text, from_name, from_address, track_opens, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'S', '', '', '', 'F', 'f@mail.swarm.test', 1, ?5, ?5)`,
    ).bind(ids.broadcast, ids.dispatch, ids.channel, ids.workspace, now),
    env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, provider_message_id, status, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'sent', ?7)`,
    ).bind(ids.delivery, ids.broadcast, ids.channel, ids.member, email, messageId, now),
  ]);
  return { ...ids, email, messageId };
}

type Seed = Awaited<ReturnType<typeof seedDelivery>>;

const auth = (password = env.POSTMARK_WEBHOOK_SECRET) => ({
  authorization: `Basic ${btoa(`swarm:${password}`)}`,
});

const post = (body: unknown, headers: Record<string, string> = auth()) =>
  SELF.fetch('https://events.swarm.test/postmark', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const hardBounce = (s: Seed) => ({
  RecordType: 'Bounce',
  Type: 'HardBounce',
  TypeCode: 1,
  Inactive: true,
  Email: s.email,
  MessageID: s.messageId,
  Details: '550 no such user',
  Metadata: { delivery: s.delivery },
});

const memberStatus = async (id: string) =>
  (
    await env.DB.prepare('SELECT status FROM members WHERE id = ?1')
      .bind(id)
      .first<{ status: string }>()
  )?.status;

describe('Postmark webhook endpoint', () => {
  it('suppresses a hard bounce', async () => {
    const s = await seedDelivery();
    const res = await post(hardBounce(s));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { handled: true, kind: 'hard_bounce' } });
    expect(await memberStatus(s.member)).toBe('bounced');
    const suppression = await env.DB.prepare(
      'SELECT reason FROM suppressions WHERE workspace_id = ?1 AND email = ?2',
    )
      .bind(s.workspace, s.email)
      .first<{ reason: string }>();
    expect(suppression?.reason).toBe('hard_bounce');
  });

  it('counts a soft bounce as soft', async () => {
    const s = await seedDelivery();
    const res = await post({ ...hardBounce(s), Type: 'SoftBounce', Inactive: false });
    expect(await res.json()).toMatchObject({ data: { kind: 'soft_bounce' } });
    expect(await memberStatus(s.member)).not.toBe('bounced');
  });

  it('applies a bounce once: the same bounce ID again is a replay', async () => {
    // Three soft bounces suppress, so a captured soft bounce replayed twice must not count.
    const s = await seedDelivery();
    const soft = { ...hardBounce(s), ID: 4323372036, Type: 'SoftBounce', Inactive: false };
    expect(await (await post(soft)).json()).toMatchObject({
      data: { handled: true, kind: 'soft_bounce' },
    });
    for (const again of [soft, { ...soft, Details: 'retried' }]) {
      const res = await post(again);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ data: { handled: false, kind: 'replay' } });
    }
    // Without an ID, an identical body is the same event.
    const { ID: _id, ...anonymous } = { ...soft, Details: 'no id' };
    expect(await (await post(anonymous)).json()).toMatchObject({ data: { kind: 'soft_bounce' } });
    expect(await (await post(anonymous)).json()).toMatchObject({ data: { kind: 'replay' } });
    const n = await env.DB.prepare(
      "SELECT count(*) AS n FROM bounce_events WHERE kind = 'soft' AND email = ?1",
    )
      .bind(s.email)
      .first<{ n: number }>();
    // One email counts once, whatever the provider calls the report.
    expect(n?.n).toBe(1);
    expect(await memberStatus(s.member)).toBe('active');
  });

  it('marks a complaint, and finds a delivery by message id alone', async () => {
    const s = await seedDelivery();
    await post({
      RecordType: 'SpamComplaint',
      Type: 'SpamComplaint',
      Email: s.email,
      MessageID: s.messageId,
      Metadata: { delivery: s.delivery },
    });
    expect(await memberStatus(s.member)).toBe('complained');

    const t = await seedDelivery();
    const res = await post({
      RecordType: 'Delivery',
      Recipient: t.email,
      MessageID: t.messageId,
      DeliveredAt: new Date().toISOString(),
      Metadata: {},
    });
    expect(await res.json()).toMatchObject({ data: { kind: 'delivery' } });
    const delivery = await env.DB.prepare('SELECT status FROM deliveries WHERE id = ?1')
      .bind(t.delivery)
      .first<{ status: string }>();
    expect(delivery?.status).toBe('delivered');
  });

  const change = (s: Seed, fields: Record<string, unknown> = {}) => ({
    RecordType: 'SubscriptionChange',
    MessageID: s.messageId,
    Recipient: s.email,
    Origin: 'Recipient',
    SuppressSending: true,
    SuppressionReason: 'ManualSuppression',
    Metadata: { delivery: s.delivery },
    ...fields,
  });

  it("unsubscribes a reader who used Postmark's own link", async () => {
    const s = await seedDelivery();
    const res = await post(change(s));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { handled: true, kind: 'unsubscribe' } });
    expect(await memberStatus(s.member)).toBe('unsubscribed');
  });

  it('leaves the reader alone on other subscription changes', async () => {
    const s = await seedDelivery();
    for (const fields of [
      { SuppressSending: false },
      { Origin: 'Customer' },
      { SuppressionReason: 'HardBounce' },
    ]) {
      const res = await post(change(s, fields));
      expect(await res.json()).toMatchObject({ data: { handled: false, kind: 'ignored' } });
    }
    expect(await memberStatus(s.member)).toBe('active');
  });

  it("answers 200 to Postmark's test events, for a delivery it can't know", async () => {
    const res = await post({
      RecordType: 'Bounce',
      Type: 'HardBounce',
      Email: 'john@example.com',
      MessageID: '00000000-0000-0000-0000-000000000000',
      Metadata: {},
    });
    expect(res.status).toBe(200);
  });

  it('rejects a missing or wrong password, and changes nothing', async () => {
    const s = await seedDelivery();
    expect((await post(hardBounce(s), {})).status).toBe(401);
    expect((await post(hardBounce(s), auth('not-the-configured-password'))).status).toBe(401);
    expect(await memberStatus(s.member)).toBe('active');
  });

  it('refuses a body that is not JSON', async () => {
    expect((await post('not json')).status).toBe(400);
  });

  it('is not found when no secret is configured', async () => {
    const res = await app.fetch(
      new Request('https://events.swarm.test/postmark', { method: 'POST', body: '{}' }),
      { ...env, POSTMARK_WEBHOOK_SECRET: undefined },
    );
    expect(res.status).toBe(404);
  });
});
