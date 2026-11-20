import { SELF, env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { mailgunSignature } from '@swarm/engine';
import { describe, expect, it, vi } from 'vitest';
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
  const messageId = `${crypto.randomUUID()}@mg.example`;
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

const eventData = (s: Seed, fields: Record<string, unknown>) => ({
  timestamp: Date.now() / 1000,
  recipient: s.email,
  message: { headers: { 'message-id': s.messageId } },
  'user-variables': { delivery: s.delivery },
  ...fields,
});

async function signature(token = crypto.randomUUID(), key = env.MAILGUN_WEBHOOK_SIGNING_KEY) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { timestamp, token, signature: await mailgunSignature(key, timestamp, token) };
}

const post = (body: unknown) =>
  SELF.fetch('https://events.swarm.test/mailgun', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const send = async (data: unknown, sig?: Awaited<ReturnType<typeof signature>>) =>
  post({ signature: sig ?? (await signature()), 'event-data': data });

const memberStatus = async (id: string) =>
  (
    await env.DB.prepare('SELECT status FROM members WHERE id = ?1')
      .bind(id)
      .first<{ status: string }>()
  )?.status;

const permanent = { event: 'failed', severity: 'permanent', reason: 'bounce' };

describe('Mailgun webhook endpoint', () => {
  it('suppresses a hard bounce', async () => {
    const s = await seedDelivery();
    const res = await send(eventData(s, permanent));
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

  it('accepts the event at the top level too, as Mailgun also documents it', async () => {
    const s = await seedDelivery();
    const res = await post({ signature: await signature(), ...eventData(s, permanent) });
    expect(await res.json()).toMatchObject({ data: { kind: 'hard_bounce' } });
  });

  it('counts a temporary failure as soft', async () => {
    const s = await seedDelivery();
    const res = await send(eventData(s, { event: 'failed', severity: 'temporary' }));
    expect(await res.json()).toMatchObject({ data: { kind: 'soft_bounce' } });
    expect(await memberStatus(s.member)).not.toBe('bounced');
  });

  it('marks a complaint, and finds a delivery by message id alone', async () => {
    const s = await seedDelivery();
    await send(eventData(s, { event: 'complained' }));
    expect(await memberStatus(s.member)).toBe('complained');

    const t = await seedDelivery();
    const res = await send(eventData(t, { event: 'delivered', 'user-variables': [] }));
    expect(await res.json()).toMatchObject({ data: { kind: 'delivery' } });
    const delivery = await env.DB.prepare('SELECT status FROM deliveries WHERE id = ?1')
      .bind(t.delivery)
      .first<{ status: string }>();
    expect(delivery?.status).toBe('delivered');
  });

  it('acknowledges events it ignores', async () => {
    const s = await seedDelivery();
    const res = await send(eventData(s, { event: 'opened' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { kind: 'ignored' } });
    expect(await memberStatus(s.member)).toBe('active');
  });

  it('rejects unsigned and wrongly signed webhooks', async () => {
    const s = await seedDelivery();
    const data = eventData(s, permanent);
    expect((await post({ 'event-data': data })).status).toBe(401);
    expect((await post(data)).status).toBe(401);
    const wrong = await signature(undefined, 'not-the-configured-signing-key');
    expect((await send(data, wrong)).status).toBe(401);
    expect(await memberStatus(s.member)).toBe('active');
  });

  it('does not let a captured signature carry a different event', async () => {
    const victim = await seedDelivery();
    const other = await seedDelivery();
    const captured = await signature();
    expect((await send(eventData(other, { event: 'delivered' }), captured)).status).toBe(200);
    const forged = await send(eventData(victim, permanent), captured);
    expect(await forged.json()).toMatchObject({ data: { handled: false, kind: 'replay' } });
    expect(await memberStatus(victim.member)).toBe('active');
  });

  it('changes nothing for an event that disagrees with the send it names', async () => {
    // Mailgun's signature doesn't cover event-data: the recipient and message id in it must match
    // what Swarm recorded for the delivery, or the event is ignored.
    for (const event of [permanent, { event: 'complained' }]) {
      const s = await seedDelivery();
      const other = newId('member');
      const otherEmail = `other-${crypto.randomUUID().slice(0, 8)}@example.test`;
      await env.DB.prepare(
        'INSERT INTO members (id, channel_id, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
      )
        .bind(other, s.channel, otherEmail, Date.now())
        .run();
      for (const fields of [
        { recipient: otherEmail },
        { message: { headers: { 'message-id': `${crypto.randomUUID()}@mg.example` } } },
        { message: { headers: {} } },
      ]) {
        const res = await send(eventData(s, { ...event, ...fields }));
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ data: { handled: false, kind: 'ignored' } });
      }
      expect(await memberStatus(other)).toBe('active');
      expect(await memberStatus(s.member)).toBe('active');
      const suppressed = await env.DB.prepare(
        'SELECT count(*) AS n FROM suppressions WHERE workspace_id = ?1',
      )
        .bind(s.workspace)
        .first<{ n: number }>();
      expect(suppressed?.n).toBe(0);
    }
  });

  it("an unclaimed signature carrying another tenant's delivery leaves it alone, and the genuine event still applies", async () => {
    const a = await seedDelivery();
    const b = await seedDelivery();
    const sig = await signature();
    // B's delivery id, but the attacker can't know B's address and message id.
    const substituted = await send(
      eventData(a, { ...permanent, 'user-variables': { delivery: b.delivery } }),
      sig,
    );
    expect(await substituted.json()).toMatchObject({ data: { handled: false, kind: 'ignored' } });
    expect(await memberStatus(b.member)).toBe('active');
    const genuine = await send(eventData(a, permanent), sig);
    expect(await genuine.json()).toMatchObject({ data: { handled: true, kind: 'hard_bounce' } });
    expect(await memberStatus(a.member)).toBe('bounced');
    expect(await memberStatus(b.member)).toBe('active');
  });

  it("frees the token when the event can't be applied, so Mailgun's retry works", async () => {
    const s = await seedDelivery();
    const sig = await signature();
    const db = {
      batch: env.DB.batch.bind(env.DB),
      prepare: (sql: string) => {
        if (/UPDATE|INSERT INTO suppressions/.test(sql) || /SELECT d\.id/.test(sql)) {
          throw new Error('database unavailable');
        }
        return env.DB.prepare(sql);
      },
    };
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await app.fetch(
      new Request('https://events.swarm.test/mailgun', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signature: sig, 'event-data': eventData(s, permanent) }),
      }),
      { ...env, DB: db as unknown as D1Database },
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );
    silence.mockRestore();
    expect(failed.status).toBe(500);
    const retry = await send(eventData(s, permanent), sig);
    expect(await retry.json()).toMatchObject({ data: { kind: 'hard_bounce' } });
  });

  it('a released token is accepted again only with the event it first came with', async () => {
    const a = await seedDelivery();
    const b = await seedDelivery();
    const sig = await signature();
    const genuine = eventData(a, permanent);
    // The first apply fails after the token is claimed, so the token is released.
    const db = {
      batch: env.DB.batch.bind(env.DB),
      prepare: (sql: string) => {
        if (/INSERT INTO bounce_events/.test(sql)) throw new Error('database unavailable');
        return env.DB.prepare(sql);
      },
    };
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await app.fetch(
      new Request('https://events.swarm.test/mailgun', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signature: sig, 'event-data': genuine }),
      }),
      { ...env, DB: db as unknown as D1Database },
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );
    silence.mockRestore();
    expect(failed.status).toBe(500);
    // Someone holding the released signature tries a complaint about B, with B's own details.
    const substituted = await send(eventData(b, { event: 'complained' }), sig);
    expect(await substituted.json()).toMatchObject({ data: { handled: false, kind: 'replay' } });
    expect(await memberStatus(b.member)).toBe('active');
    // Mailgun's retry carries the same event, so it is applied.
    const retry = await send(genuine, sig);
    expect(await retry.json()).toMatchObject({ data: { kind: 'hard_bounce' } });
  });

  it('refuses a body that is not JSON', async () => {
    expect((await post('not json')).status).toBe(400);
  });

  it('is not found when no key is configured', async () => {
    const res = await app.fetch(
      new Request('https://events.swarm.test/mailgun', { method: 'POST', body: '{}' }),
      { ...env, MAILGUN_WEBHOOK_SIGNING_KEY: undefined },
    );
    expect(res.status).toBe(404);
  });
});
