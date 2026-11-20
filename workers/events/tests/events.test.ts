import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import {
  applySesEvent,
  readQueueMessage,
  stringToSign,
  unsubscribeCode,
  type SnsMessage,
} from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cert, signingKey } from '../../../packages/engine/tests/fixtures/sns-test-keys';
import { app, codeFromAddress, handleEmail } from '../src/index';

const TOPIC = 'arn:aws:sns:eu-west-1:123456789012:swarm-ses-events';
const CERT_URL = 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem';
const fetched: string[] = [];

beforeEach(() => {
  fetched.length = 0;
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://sns.')) {
      fetched.push(url);
      return url.endsWith('.pem')
        ? new Response(cert)
        : new Response('<ConfirmSubscriptionResponse/>');
    }
    return real(input, init);
  });
});

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
  const messageId = `ses-${crypto.randomUUID()}`;
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

async function sign(message: Omit<SnsMessage, 'Signature'>): Promise<SnsMessage> {
  const full = { ...message, Signature: '' } as SnsMessage;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signingKey,
    new TextEncoder().encode(stringToSign(full)),
  );
  return { ...full, Signature: btoa(String.fromCharCode(...new Uint8Array(signature))) };
}

const notification = (event: unknown, overrides: Partial<SnsMessage> = {}) =>
  sign({
    Type: 'Notification',
    MessageId: crypto.randomUUID(),
    TopicArn: TOPIC,
    Message: JSON.stringify(event),
    Timestamp: new Date().toISOString(),
    SignatureVersion: '2',
    SigningCertURL: CERT_URL,
    ...overrides,
  });

const post = (message: unknown) =>
  SELF.fetch('https://events.swarm.test/sns/ses', {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=UTF-8' },
    body: JSON.stringify(message),
  });

const memberStatus = async (id: string) =>
  (
    await env.DB.prepare('SELECT status FROM members WHERE id = ?1')
      .bind(id)
      .first<{ status: string }>()
  )?.status;

describe('SNS endpoint', () => {
  it('suppresses a hard bounce from a signed notification', async () => {
    const s = await seedDelivery();
    const res = await post(
      await notification({
        eventType: 'Bounce',
        mail: { messageId: s.messageId },
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'General',
          bouncedRecipients: [{ emailAddress: s.email, diagnosticCode: '550 5.1.1' }],
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { handled: true, kind: 'hard_bounce' } });
    expect(await memberStatus(s.member)).toBe('bounced');
    const suppression = await env.DB.prepare(
      'SELECT reason FROM suppressions WHERE workspace_id = ?1 AND email = ?2',
    )
      .bind(s.workspace, s.email)
      .first<{ reason: string }>();
    expect(suppression?.reason).toBe('hard_bounce');
    expect(fetched).toContain(CERT_URL);
  });

  it('marks the Member complained on a complaint in the notification format', async () => {
    const s = await seedDelivery();
    const res = await post(
      await notification({
        notificationType: 'Complaint',
        mail: { messageId: s.messageId },
        complaint: {
          complainedRecipients: [{ emailAddress: s.email }],
          complaintFeedbackType: 'abuse',
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(await memberStatus(s.member)).toBe('complained');
    const delivery = await env.DB.prepare('SELECT status FROM deliveries WHERE id = ?1')
      .bind(s.delivery)
      .first<{ status: string }>();
    expect(delivery?.status).toBe('complained');
  });

  it('applies only system transitions: a complaint overrides a bounce, never the reverse', async () => {
    const setStatus = (id: string, status: string) =>
      env.DB.prepare('UPDATE members SET status = ?1, paused_until = 1 WHERE id = ?2')
        .bind(status, id)
        .run();
    const bounce = (s: Awaited<ReturnType<typeof seedDelivery>>) =>
      applySesEvent(env.DB, {
        eventType: 'Bounce',
        mail: { messageId: s.messageId },
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: s.email }] },
      });
    const complain = (s: Awaited<ReturnType<typeof seedDelivery>>) =>
      applySesEvent(env.DB, { eventType: 'Complaint', mail: { messageId: s.messageId } });

    const paused = await seedDelivery();
    await setStatus(paused.member, 'paused');
    await bounce(paused);
    expect(await memberStatus(paused.member)).toBe('bounced');
    await complain(paused);
    expect(await memberStatus(paused.member)).toBe('complained');

    const complained = await seedDelivery();
    await setStatus(complained.member, 'complained');
    await bounce(complained);
    expect(await memberStatus(complained.member)).toBe('complained');
  });

  it('marks a rejected message failed without blaming the address', async () => {
    const s = await seedDelivery();
    const res = await post(
      await notification({
        eventType: 'Reject',
        mail: { messageId: s.messageId },
        reject: { reason: 'Bad content' },
      }),
    );
    expect(res.status).toBe(200);
    const delivery = await env.DB.prepare('SELECT status, error FROM deliveries WHERE id = ?1')
      .bind(s.delivery)
      .first<{ status: string; error: string }>();
    expect(delivery).toEqual({
      status: 'failed',
      error: 'Rejected by the email service: Bad content',
    });
    expect(await memberStatus(s.member)).toBe('active');
    const suppression = await env.DB.prepare(
      'SELECT reason FROM suppressions WHERE workspace_id = ?1 AND email = ?2',
    )
      .bind(s.workspace, s.email)
      .first();
    expect(suppression).toBeNull();
  });

  it('marks deliveries as delivered', async () => {
    const s = await seedDelivery();
    await post(
      await notification({ eventType: 'Delivery', mail: { messageId: s.messageId }, delivery: {} }),
    );
    const delivery = await env.DB.prepare('SELECT status FROM deliveries WHERE id = ?1')
      .bind(s.delivery)
      .first<{ status: string }>();
    expect(delivery?.status).toBe('delivered');
  });

  it('rejects a forged signature, an unknown topic and a replayed message', async () => {
    const s = await seedDelivery();
    const bounce = {
      eventType: 'Bounce',
      mail: { messageId: s.messageId },
      bounce: { bounceType: 'Permanent' },
    };
    const valid = await notification(bounce);
    const forged = {
      ...valid,
      Message: JSON.stringify({ ...bounce, mail: { messageId: 'someone-else' } }),
    };
    expect((await post(forged)).status).toBe(403);
    expect(
      (
        await post(
          await notification(bounce, { TopicArn: 'arn:aws:sns:eu-west-1:999999999999:other' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          await notification(bounce, {
            Timestamp: new Date(Date.now() - 3 * 3600_000).toISOString(),
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          await notification(bounce, { SigningCertURL: 'https://attacker.example/cert.pem' }),
        )
      ).status,
    ).toBe(403);
    expect((await post({ hello: 'world' })).status).toBe(400);
    expect(await memberStatus(s.member)).toBe('active');
  });

  it('applies a notification once: the same MessageId again is a replay', async () => {
    // Three soft bounces suppress, so a captured soft bounce replayed twice must not count.
    const s = await seedDelivery();
    const message = await notification({
      eventType: 'Bounce',
      mail: { messageId: s.messageId },
      bounce: {
        bounceType: 'Transient',
        bouncedRecipients: [{ emailAddress: s.email }],
      },
    });
    expect(await (await post(message)).json()).toMatchObject({
      data: { handled: true, kind: 'soft_bounce' },
    });
    for (let i = 0; i < 2; i++) {
      const again = await post(message);
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

  it('confirms subscriptions only on the SNS host', async () => {
    const confirm = await sign({
      Type: 'SubscriptionConfirmation',
      MessageId: crypto.randomUUID(),
      TopicArn: TOPIC,
      Message: 'You have chosen to subscribe',
      Timestamp: new Date().toISOString(),
      SignatureVersion: '2',
      SigningCertURL: CERT_URL,
      Token: 'tok',
      SubscribeURL: 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok',
    });
    const res = await post(confirm);
    expect(res.status).toBe(200);
    expect(fetched.some((url) => url.includes('Action=ConfirmSubscription'))).toBe(true);
  });
});

describe('email unsubscribe', () => {
  const unsubscribeKeys = parseKeyring(env.UNSUBSCRIBE_KEYS);
  const mailTo = (to: string) => {
    const rejected: string[] = [];
    return {
      message: {
        to,
        from: 'reader@example.org',
        setReject: (reason: string) => rejected.push(reason),
      } as unknown as ForwardableEmailMessage,
      rejected,
    };
  };

  it('parses only well-formed addresses', () => {
    expect(
      codeFromAddress('UNSUB+0123456789ABCDEF0123456789abcdef-0123456789abcdef0123@x.example'),
    ).toBe('0123456789abcdef0123456789abcdef-0123456789abcdef0123');
    expect(codeFromAddress('hello@x.example')).toBeNull();
  });

  it('unsubscribes the Member behind a valid code', async () => {
    const s = await seedDelivery();
    const code = await unsubscribeCode(unsubscribeKeys, s.delivery);
    const { message, rejected } = mailTo(`unsub+${code}@unsubscribe.swarm.test`);
    await handleEmail(message, env);
    expect(rejected).toEqual([]);
    expect(await memberStatus(s.member)).toBe('unsubscribed');
  });

  it('rejects unknown or forged codes', async () => {
    const s = await seedDelivery();
    const code = await unsubscribeCode(unsubscribeKeys, s.delivery);
    const forged = code.slice(0, -1) + (code.endsWith('0') ? '1' : '0');
    const { message, rejected } = mailTo(`unsub+${forged}@unsubscribe.swarm.test`);
    await handleEmail(message, env);
    expect(rejected).toHaveLength(1);
    expect(await memberStatus(s.member)).toBe('active');
  });
});

describe('health', () => {
  it('reports healthy', async () => {
    const res = await app.request('/healthz', {}, env);
    expect(res.status).toBe(200);
  });
});

describe('Circles follow feedback', () => {
  it('queues only "this publication changed", on the public queue, for a hard bounce', async () => {
    const s = await seedDelivery();
    const queued: unknown[] = [];
    const bindings = {
      ...env,
      PUBLIC_QUEUE: { send: async (message: unknown) => void queued.push(message) },
    };
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('https://events.swarm.test/sns/ses', {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=UTF-8' },
        body: JSON.stringify(
          await notification({
            eventType: 'Bounce',
            mail: { messageId: s.messageId },
            bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: s.email }] },
          }),
        ),
      }),
      bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(queued).toEqual([{ type: 'channel_changed', channelId: s.channel }]);
    expect(readQueueMessage('public', queued[0]).ok).toBe(true);
    // The events worker writes no Circle row and has no jobs queue (S04-P1-TR).
    expect('JOBS_QUEUE' in env).toBe(false);
  });

  it('reports the Channel for a hard bounce and a complaint, not for a soft bounce or delivery', async () => {
    const s = await seedDelivery();
    const mail = { messageId: s.messageId };
    expect(
      (await applySesEvent(env.DB, { eventType: 'Delivery', mail, delivery: {} })).memberChangedIn,
    ).toBeUndefined();
    expect(
      (
        await applySesEvent(env.DB, {
          eventType: 'Bounce',
          mail,
          bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: s.email }] },
        })
      ).memberChangedIn,
    ).toBeUndefined();
    expect(
      (
        await applySesEvent(env.DB, {
          eventType: 'Bounce',
          mail,
          bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: s.email }] },
        })
      ).memberChangedIn,
    ).toBe(s.channel);
    const other = await seedDelivery();
    expect(
      (
        await applySesEvent(env.DB, {
          eventType: 'Complaint',
          mail: { messageId: other.messageId },
        })
      ).memberChangedIn,
    ).toBe(other.channel);
  });
});
