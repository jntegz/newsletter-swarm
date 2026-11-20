import { SELF, env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { svixSignature } from '@swarm/engine';
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
  const emailId = crypto.randomUUID();
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
    ).bind(ids.delivery, ids.broadcast, ids.channel, ids.member, email, emailId, now),
  ]);
  return { ...ids, email, emailId };
}

/** A Resend webhook payload; tags arrive as an object, as Resend sends them. */
const payload = (
  type: string,
  s: Awaited<ReturnType<typeof seedDelivery>>,
  data: Record<string, unknown> = {},
) =>
  JSON.stringify({
    type,
    created_at: new Date().toISOString(),
    data: {
      email_id: s.emailId,
      created_at: new Date().toISOString(),
      from: 'F <f@mail.swarm.test>',
      to: [s.email],
      subject: 'S',
      tags: { category: 'broadcast', delivery: s.delivery, channel: s.channel },
      ...data,
    },
  });

async function signed(body: string, secret = env.RESEND_WEBHOOK_SECRET) {
  const id = `msg_${crypto.randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'content-type': 'application/json',
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${await svixSignature(secret, id, timestamp, body)}`,
  };
}

const post = async (body: string, headers?: Record<string, string>) =>
  SELF.fetch('https://events.swarm.test/resend', {
    method: 'POST',
    headers: headers ?? (await signed(body)),
    body,
  });

const memberStatus = async (id: string) =>
  (
    await env.DB.prepare('SELECT status FROM members WHERE id = ?1')
      .bind(id)
      .first<{ status: string }>()
  )?.status;

const suppression = (workspace: string, email: string) =>
  env.DB.prepare('SELECT reason, detail FROM suppressions WHERE workspace_id = ?1 AND email = ?2')
    .bind(workspace, email)
    .first<{ reason: string; detail: string | null }>();

describe('Resend webhook endpoint', () => {
  it('suppresses a hard bounce from a signed webhook', async () => {
    const s = await seedDelivery();
    const res = await post(
      payload('email.bounced', s, {
        bounce: { type: 'Permanent', subType: 'General', message: '550 no such user' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { handled: true, kind: 'hard_bounce' } });
    expect(await memberStatus(s.member)).toBe('bounced');
    expect((await suppression(s.workspace, s.email))?.reason).toBe('hard_bounce');
    const delivery = await env.DB.prepare('SELECT status FROM deliveries WHERE id = ?1')
      .bind(s.delivery)
      .first<{ status: string }>();
    expect(delivery?.status).toBe('bounced');
  });

  it('treats a suppressed email as a hard bounce', async () => {
    const s = await seedDelivery();
    const res = await post(
      payload('email.suppressed', s, {
        suppressed: { type: 'OnAccountSuppressionList', message: 'previously bounced' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { kind: 'hard_bounce' } });
    expect(await memberStatus(s.member)).toBe('bounced');
    expect(await suppression(s.workspace, s.email)).toMatchObject({ reason: 'hard_bounce' });
  });

  it('counts a temporary bounce as soft', async () => {
    const s = await seedDelivery();
    const res = await post(payload('email.bounced', s, { bounce: { type: 'Temporary' } }));
    expect(await res.json()).toMatchObject({ data: { kind: 'soft_bounce' } });
    expect(await memberStatus(s.member)).not.toBe('bounced');
  });

  it('marks a complaint, and a delivery found by email id alone', async () => {
    const s = await seedDelivery();
    await post(payload('email.complained', s));
    expect(await memberStatus(s.member)).toBe('complained');

    const t = await seedDelivery();
    const res = await post(payload('email.delivered', t, { tags: undefined }));
    expect(await res.json()).toMatchObject({ data: { kind: 'delivery' } });
    const delivery = await env.DB.prepare('SELECT status FROM deliveries WHERE id = ?1')
      .bind(t.delivery)
      .first<{ status: string }>();
    expect(delivery?.status).toBe('delivered');
  });

  it('acknowledges types it ignores', async () => {
    const s = await seedDelivery();
    for (const type of ['email.sent', 'email.opened', 'email.clicked', 'email.failed']) {
      const res = await post(payload(type, s, { failed: { reason: 'reached_daily_quota' } }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ data: { kind: 'ignored' } });
    }
    expect(await memberStatus(s.member)).toBe('active');
  });

  it('rejects unsigned, wrongly signed and stale webhooks', async () => {
    const s = await seedDelivery();
    const body = payload('email.bounced', s, { bounce: { type: 'Permanent' } });
    expect((await post(body, { 'content-type': 'application/json' })).status).toBe(401);
    const wrong = await signed(body, `whsec_${btoa('not the configured secret at all')}`);
    expect((await post(body, wrong)).status).toBe(401);
    const good = await signed(body);
    expect((await post(body.replace('Permanent', 'Transient'), good)).status).toBe(401);
    const stale = { ...good, 'svix-timestamp': String(Math.floor(Date.now() / 1000) - 600) };
    expect((await post(body, stale)).status).toBe(401);
    expect(await memberStatus(s.member)).toBe('active');
  });

  it('applies a signed webhook once: the same svix-id again is a replay', async () => {
    // Three soft bounces suppress, so a captured soft bounce replayed twice must not count.
    const s = await seedDelivery();
    const body = payload('email.bounced', s, { bounce: { type: 'Temporary' } });
    const headers = await signed(body);
    expect(await (await post(body, headers)).json()).toMatchObject({
      data: { handled: true, kind: 'soft_bounce' },
    });
    for (let i = 0; i < 2; i++) {
      const again = await post(body, headers);
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ data: { handled: false, kind: 'replay' } });
    }
    const soft = await env.DB.prepare(
      "SELECT count(*) AS n FROM bounce_events WHERE kind = 'soft' AND email = ?1",
    )
      .bind(s.email)
      .first<{ n: number }>();
    expect(soft?.n).toBe(1);
    expect(await memberStatus(s.member)).toBe('active');
  });

  it("frees the svix-id when the event can't be applied, so Resend's retry works", async () => {
    const s = await seedDelivery();
    const body = payload('email.bounced', s, { bounce: { type: 'Permanent' } });
    const headers = await signed(body);
    const db = {
      batch: env.DB.batch.bind(env.DB),
      prepare: (sql: string) => {
        if (/SELECT d\.id/.test(sql)) throw new Error('database unavailable');
        return env.DB.prepare(sql);
      },
    };
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await app.fetch(
      new Request('https://events.swarm.test/resend', { method: 'POST', headers, body }),
      { ...env, DB: db as unknown as D1Database },
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );
    silence.mockRestore();
    expect(failed.status).toBe(500);
    expect(await (await post(body, headers)).json()).toMatchObject({
      data: { kind: 'hard_bounce' },
    });
  });

  it('is not found when no secret is configured', async () => {
    const s = await seedDelivery();
    const body = payload('email.delivered', s);
    const res = await app.fetch(
      new Request('https://events.swarm.test/resend', {
        method: 'POST',
        headers: await signed(body),
        body,
      }),
      { ...env, RESEND_WEBHOOK_SECRET: undefined },
    );
    expect(res.status).toBe(404);
  });

  it('answers 404 on /sns/ses when no SNS topics are configured', async () => {
    const res = await app.fetch(
      new Request('https://events.swarm.test/sns/ses', { method: 'POST', body: '{}' }),
      { ...env, SNS_TOPIC_ARNS: undefined },
    );
    expect(res.status).toBe(404);
  });
});
