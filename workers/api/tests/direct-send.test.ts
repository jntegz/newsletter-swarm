// The Direct Send API (/v2/channels/{channelId}/sends): the compliance gate (suppression,
// unsubscribe headers only for one_off), plans and the daily limit, scope enforcement, provider
// events and unsubscribes for direct sends, and the v1 stats route. Credentials are OAuth tokens.
import { env } from 'cloudflare:test';
import type { DirectSend, DirectSendStats, Template } from '@swarm/domain';
import { applySesEvent, unsubscribeDelivery } from '@swarm/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember } from './audience-helpers';
import { call, createChannel, json, seatAs, signIn, type Session } from './helpers';
import { data, errorCode } from './money-helpers';
import { connect, createApp, setPlan, v2 } from './oauth-helpers';
import { createKey } from './v2-helpers';

const doc = (...paragraphs: string[]) => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

let owner: Session;
let channelId: string;
let token: string;
let templateId: string;
let clientId: string;

interface StoredMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  category: string;
  headers?: Record<string, string>;
}

async function latestMail(to: string): Promise<StoredMail | null> {
  const res = await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(to)}`);
  if (res.status === 404) return null;
  return (await json<{ data: StoredMail }>(res)).data;
}

async function member(status?: string) {
  const created = await addMember(owner, channelId);
  if (status) {
    await env.DB.prepare('UPDATE members SET status = ?1 WHERE id = ?2')
      .bind(status, created.id)
      .run();
  }
  return created;
}

const send = (body: Record<string, unknown>, t = token, ch = channelId) =>
  v2('POST', `/v2/channels/${ch}/sends`, t, body);

beforeAll(async () => {
  owner = await signIn();
  await setPlan(owner.workspaceId, 'pro');
  channelId = (await createChannel(owner)).id;
  clientId = (await createApp(owner, { scopes: ['sends:write', 'members:read'] })).app.clientId;
  token = (await connect(owner, clientId, 'sends:write')).access_token;
  templateId = (
    await data<Template>(
      await call('POST', `/api/v1/workspaces/${owner.workspaceId}/templates`, {
        cookie: owner.cookie,
        body: {
          name: 'Receipt',
          subject: 'Order {{ var.order }} for {{ first_name | there }}',
          content: doc('Thanks, your order {{ var.order }} is on its way.', 'Note: {{ var.note }}'),
        },
      }),
      201,
    )
  ).id;
});

describe('Direct Send', () => {
  it('sends a one-off message with List-Unsubscribe and One-Click', async () => {
    const m = await member();
    const res = await send({
      kind: 'one_off',
      to: { memberId: m.id },
      templateId,
      variables: { order: 'A-17', note: '<b>fragile</b>' },
    });
    const sent = await data<DirectSend>(res, 201);
    expect(sent).toMatchObject({ status: 'sent', kind: 'one_off', memberId: m.id, templateId });
    const mail = (await latestMail(m.email))!;
    expect(mail.subject).toBe('Order A-17 for there');
    expect(mail.text).toContain('your order A-17 is on its way');
    // Variables are escaped in HTML.
    expect(mail.html).toContain('&lt;b&gt;fragile&lt;/b&gt;');
    expect(mail.headers!['List-Unsubscribe']).toMatch(
      /^<http:\/\/localhost:8790\/u\/[0-9a-f-]+>, <mailto:unsub\+/,
    );
    expect(mail.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(mail.headers!['X-Swarm-Direct-Send']).toBe(sent.id);
  });

  it('sends a transactional message without unsubscribe headers', async () => {
    const m = await member();
    const sent = await data<DirectSend>(
      await send({ kind: 'transactional', to: { email: m.email.toUpperCase() }, templateId }),
      201,
    );
    expect(sent.status).toBe('sent');
    const mail = (await latestMail(m.email))!;
    expect(mail.headers!['List-Unsubscribe']).toBeUndefined();
    expect(mail.headers!['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('a suppressed address is never mailed, whatever the kind', async () => {
    for (const kind of ['one_off', 'transactional'] as const) {
      const m = await member();
      await env.DB.prepare(
        "INSERT INTO suppressions (id, workspace_id, email, reason, created_at) VALUES (?1, ?2, ?3, 'manual', 0)",
      )
        .bind(`sp_${crypto.randomUUID().replace(/-/g, '')}`, owner.workspaceId, m.email)
        .run();
      const sent = await data<DirectSend>(
        await send({ kind, to: { memberId: m.id }, templateId }),
        201,
      );
      expect(sent).toMatchObject({ status: 'suppressed', error: 'address_suppressed' });
      expect(await latestMail(m.email)).toBeNull();
    }
  });

  it('one-off needs an active Member; transactional reaches an unsubscribed one', async () => {
    const m = await member('unsubscribed');
    const blocked = await data<DirectSend>(
      await send({ kind: 'one_off', to: { memberId: m.id }, templateId }),
      201,
    );
    expect(blocked).toMatchObject({ status: 'suppressed', error: 'member_not_active' });
    expect(await latestMail(m.email)).toBeNull();
    const receipt = await data<DirectSend>(
      await send({ kind: 'transactional', to: { memberId: m.id }, templateId }),
      201,
    );
    expect(receipt.status).toBe('sent');
  });

  it('only sends to Members of the Channel', async () => {
    const res = await send({
      kind: 'transactional',
      to: { email: 'stranger@example.com' },
      templateId,
    });
    expect(res.status).toBe(400);
    const otherChannel = (await createChannel(owner)).id;
    const outside = await addMember(owner, otherChannel);
    expect(
      (await send({ kind: 'transactional', to: { memberId: outside.id }, templateId })).status,
    ).toBe(400);
  });

  it('sends an existing Dispatch as the body', async () => {
    const dispatch = await data<{ id: string }>(
      await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
        cookie: owner.cookie,
        body: { subject: 'Hello {{ var.who }}', content: doc('Body for {{ var.who }}') },
      }),
      201,
    );
    const m = await member();
    const sent = await data<DirectSend>(
      await send({
        kind: 'one_off',
        to: { memberId: m.id },
        dispatchId: dispatch.id,
        variables: { who: 'Ada' },
      }),
      201,
    );
    expect(sent.dispatchId).toBe(dispatch.id);
    expect((await latestMail(m.email))!.subject).toBe('Hello Ada');
  });

  it('fills a variable named like an Object.prototype member with nothing when not given', async () => {
    const dispatch = await data<{ id: string }>(
      await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
        cookie: owner.cookie,
        body: { subject: 'Hi {{ var.constructor }}!', content: doc('By {{ var.constructor }}.') },
      }),
      201,
    );
    const m = await member();
    const sent = await data<DirectSend>(
      await send({ kind: 'one_off', to: { memberId: m.id }, dispatchId: dispatch.id }),
      201,
    );
    expect(sent.status).toBe('sent');
    const mail = (await latestMail(m.email))!;
    expect(mail.subject).toBe('Hi !');
    expect(mail.text).not.toContain('native code');
  });

  it('refuses a Template of another workspace', async () => {
    const outsider = await signIn();
    const foreign = await data<Template>(
      await call('POST', `/api/v1/workspaces/${outsider.workspaceId}/templates`, {
        cookie: outsider.cookie,
        body: { name: 'x', subject: 'x', content: doc('x') },
      }),
      201,
    );
    const m = await member();
    const res = await send({ kind: 'one_off', to: { memberId: m.id }, templateId: foreign.id });
    expect(res.status).toBe(400);
  });

  it('is refused on the free plan', async () => {
    const free = await signIn();
    const ch = (await createChannel(free)).id;
    const app = await createApp(free, { scopes: ['sends:write'] });
    const t = (await connect(free, app.app.clientId, 'sends:write')).access_token;
    const m = await addMember(free, ch);
    const res = await send({ kind: 'transactional', to: { memberId: m.id }, templateId }, t, ch);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('plan_required');
  });

  it('stops at the plan’s daily limit', async () => {
    const busy = await signIn();
    await setPlan(busy.workspaceId, 'pro');
    const ch = (await createChannel(busy)).id;
    const app = await createApp(busy, { scopes: ['sends:write'] });
    const t = (await connect(busy, app.app.clientId, 'sends:write')).access_token;
    const m = await addMember(busy, ch);
    const tpl = await data<Template>(
      await call('POST', `/api/v1/workspaces/${busy.workspaceId}/templates`, {
        cookie: busy.cookie,
        body: { name: 'x', subject: 'x', content: doc('x') },
      }),
      201,
    );
    // Today's 10,000 Pro sends, already used.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
       INSERT INTO direct_sends (id, workspace_id, channel_id, kind, status, created_at, updated_at)
       SELECT printf('dn_%032x', i), ?1, ?2, 'transactional', 'sent', ?3, ?3 FROM n`,
    )
      .bind(busy.workspaceId, ch, Date.now())
      .run();
    const res = await send(
      { kind: 'transactional', to: { memberId: m.id }, templateId: tpl.id },
      t,
      ch,
    );
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('rate_limited');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    // Yesterday's sends don't count.
    await env.DB.prepare(
      'UPDATE direct_sends SET created_at = created_at - 86400000 WHERE workspace_id = ?1',
    )
      .bind(busy.workspaceId)
      .run();
    const ok = await send(
      { kind: 'transactional', to: { memberId: m.id }, templateId: tpl.id },
      t,
      ch,
    );
    expect(ok.status).toBe(201);
  });

  it('needs the sends:write scope', async () => {
    const readOnly = (await connect(owner, clientId, 'members:read')).access_token;
    const m = await member();
    const res = await send({ kind: 'one_off', to: { memberId: m.id }, templateId }, readOnly);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('insufficient_scope');
    expect((await v2('GET', `/v2/channels/${channelId}/sends`, readOnly)).status).toBe(403);
  });

  it('reads sends with sends:read, which sends:write includes', async () => {
    const reader = (await createKey(owner, { scopes: ['sends:read'], name: 'reader' })).secret;
    expect((await v2('GET', `/v2/channels/${channelId}/sends`, reader)).status).toBe(200);
    const m = await member();
    const res = await send({ kind: 'one_off', to: { memberId: m.id }, templateId }, reader);
    expect(res.status).toBe(403);
    // The OAuth token above holds sends:write only, as grants made before sends:read do.
    expect((await v2('GET', `/v2/channels/${channelId}/sends`, token)).status).toBe(200);
  });

  it('a Channel of another workspace is not found', async () => {
    const outsider = await signIn();
    const foreign = (await createChannel(outsider)).id;
    const res = await send(
      { kind: 'one_off', to: { email: 'a@example.com' }, templateId },
      token,
      foreign,
    );
    expect(res.status).toBe(404);
  });

  it('needs credentials', async () => {
    const res = await v2('GET', `/v2/channels/${channelId}/sends`, 'oat_nope');
    expect(res.status).toBe(401);
  });

  it('reads one send and lists them, and follows provider events', async () => {
    const m = await member();
    const sent = await data<DirectSend>(
      await send({ kind: 'one_off', to: { memberId: m.id }, templateId }),
      201,
    );
    const row = await env.DB.prepare('SELECT provider_message_id FROM direct_sends WHERE id = ?1')
      .bind(sent.id)
      .first<{ provider_message_id: string }>();
    const delivered = await applySesEvent(env.DB, {
      eventType: 'Delivery',
      mail: { messageId: row!.provider_message_id },
    });
    expect(delivered).toMatchObject({ handled: true, kind: 'delivery' });
    const one = await data<DirectSend>(
      await v2('GET', `/v2/channels/${channelId}/sends/${sent.id}`, token),
    );
    expect(one.status).toBe('delivered');
    const list = await data<{ items: DirectSend[] }>(
      await v2('GET', `/v2/channels/${channelId}/sends?status=delivered`, token),
    );
    expect(list.items.map((s) => s.id)).toContain(sent.id);
    const otherChannel = (await createChannel(owner)).id;
    expect((await v2('GET', `/v2/channels/${otherChannel}/sends/${sent.id}`, token)).status).toBe(
      404,
    );
  });

  it('a hard bounce marks the send and suppresses the address', async () => {
    const m = await member();
    const sent = await data<DirectSend>(
      await send({ kind: 'transactional', to: { memberId: m.id }, templateId }),
      201,
    );
    const result = await applySesEvent(env.DB, {
      eventType: 'Bounce',
      mail: { tags: { direct_send: [sent.id] } },
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: m.email }] },
    });
    expect(result.kind).toBe('hard_bounce');
    const after = await data<DirectSend>(
      await v2('GET', `/v2/channels/${channelId}/sends/${sent.id}`, token),
    );
    expect(after.status).toBe('bounced');
    const again = await data<DirectSend>(
      await send({ kind: 'transactional', to: { memberId: m.id }, templateId }),
      201,
    );
    expect(again.status).toBe('suppressed');
  });

  it('the one-off unsubscribe code unsubscribes the Member', async () => {
    const m = await member();
    const sent = await data<DirectSend>(
      await send({ kind: 'one_off', to: { memberId: m.id }, templateId }),
      201,
    );
    const result = await unsubscribeDelivery(env.DB, `dl_${sent.id.slice(3)}`);
    expect(result).toMatchObject({ email: m.email, alreadyUnsubscribed: false });
    const status = await env.DB.prepare('SELECT status FROM members WHERE id = ?1')
      .bind(m.id)
      .first<{ status: string }>();
    expect(status!.status).toBe('unsubscribed');
    // A transactional send has no unsubscribe link to honour.
    const receipt = await data<DirectSend>(
      await send({ kind: 'transactional', to: { memberId: m.id }, templateId }),
      201,
    );
    expect(await unsubscribeDelivery(env.DB, `dl_${receipt.id.slice(3)}`)).toBeNull();
  });
});

describe('Direct Send stats (dashboard)', () => {
  it('counts sends by status per day for viewers; other workspaces get 404', async () => {
    const viewer = await seatAs(owner.workspaceId, 'viewer');
    const stats = await data<DirectSendStats>(
      await call('GET', `/api/v1/channels/${channelId}/direct-sends/stats`, {
        cookie: viewer.cookie,
      }),
    );
    expect(stats.today.limit).toBe(10_000);
    expect(stats.today.used).toBeGreaterThan(0);
    const today = stats.days[0]!;
    expect(today.day).toBe(new Date().toISOString().slice(0, 10));
    expect(today.counts.sent + today.counts.delivered).toBeGreaterThan(0);
    expect(today.counts.suppressed).toBeGreaterThan(0);
    const outsider = await signIn();
    const res = await call('GET', `/api/v1/channels/${channelId}/direct-sends/stats`, {
      cookie: outsider.cookie,
    });
    expect(res.status).toBe(404);
  });
});

// ---- The install's sending limits (docs/direct-send.md "Sending limits") ---------------------

interface PacerStub {
  script(turns: unknown[]): Promise<void>;
  block(window: 'day' | 'month', until: number): Promise<void>;
  counts(): Promise<{
    asked: { count: number; priority: string; canWait?: boolean }[];
    released: number;
  }>;
}
const pacer = () =>
  env.SEND_PACER.get(env.SEND_PACER.idFromName('install')) as unknown as PacerStub;

describe('Direct Send and the sending limits', () => {
  it('takes a transactional turn for a transactional send, and a bulk one for a one-off', async () => {
    const m = await member();
    await data<DirectSend>(
      await send({ kind: 'transactional', to: { memberId: m.id }, templateId }),
      201,
    );
    // Both kinds can wait: the API client is told when to come back.
    expect((await pacer().counts()).asked.at(-1)).toEqual({
      count: 1,
      priority: 'transactional',
      canWait: true,
    });
    await data<DirectSend>(
      await send({ kind: 'one_off', to: { memberId: m.id }, templateId }),
      201,
    );
    expect((await pacer().counts()).asked.at(-1)).toEqual({
      count: 1,
      priority: 'bulk',
      canWait: true,
    });
  });

  it('answers 429 for both kinds while the email service’s quota is used up', async () => {
    const m = await member();
    const rows = async () =>
      (
        await env.DB.prepare('SELECT count(*) AS n FROM direct_sends WHERE member_id = ?1')
          .bind(m.id)
          .first<{ n: number }>()
      )?.n;
    // An earlier send found the daily quota used up and told the pacer.
    const midnight = Date.now() - (Date.now() % 86_400_000) + 86_400_000;
    await pacer().block('day', midnight);
    try {
      for (const kind of ['transactional', 'one_off'] as const) {
        const res = await send({ kind, to: { memberId: m.id }, templateId });
        expect(res.status).toBe(429);
        expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
        const body = await json<{ error: { message: string } }>(res);
        expect(body.error.message).toMatch(/^The email service’s daily quota is reached/);
      }
      // Nothing recorded, so nothing failed and nothing counts against the plan.
      expect(await rows()).toBe(0);
    } finally {
      await pacer().block('day', 0);
    }
    expect((await send({ kind: 'transactional', to: { memberId: m.id }, templateId })).status).toBe(
      201,
    );
  });

  it('answers 429 with Retry-After while a limit holds, and records nothing', async () => {
    const m = await member();
    const before = await env.DB.prepare(
      'SELECT count(*) AS n FROM direct_sends WHERE member_id = ?1',
    )
      .bind(m.id)
      .first<{ n: number }>();
    const midnight = Date.now() - (Date.now() % 86_400_000) + 86_400_000;
    await pacer().script([
      { granted: 0, startInMs: 0, retryAfterSeconds: 3600, limit: 'day', resetsAt: midnight },
    ]);
    const res = await send({ kind: 'one_off', to: { memberId: m.id }, templateId });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    const body = await json<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.message).toMatch(
      /^This Swarm’s daily limit is reached\. Sending can continue at/,
    );
    const after = await env.DB.prepare(
      'SELECT count(*) AS n FROM direct_sends WHERE member_id = ?1',
    )
      .bind(m.id)
      .first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    // Not recorded, so the same request goes through once the limit lets it.
    const sent = await data<DirectSend>(
      await send({ kind: 'one_off', to: { memberId: m.id }, templateId }),
      201,
    );
    expect(sent.status).toBe('sent');
  });

  it('a suppressed address takes no turn', async () => {
    const m = await member('complained');
    const asked = (await pacer().counts()).asked.length;
    const sent = await data<DirectSend>(
      await send({ kind: 'transactional', to: { memberId: m.id }, templateId }),
      201,
    );
    expect(sent.status).toBe('suppressed');
    expect((await pacer().counts()).asked).toHaveLength(asked);
  });
});
