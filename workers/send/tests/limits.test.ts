// Nothing gets lost while a send waits for a limit (docs/architecture.md "Pacing"): throttling
// that outlasts the queue's retries, the email service's daily and monthly quotas, this Swarm's
// own sending limits, and an email service that stops accepting mail. Every recipient is mailed
// once, after the wait, by itself or when a person resumes.
import { env } from 'cloudflare:test';
import { newId, type LimitTurn } from '@swarm/domain';
import {
  handleSendMessage,
  reap,
  resumeDueSends,
  resumeLimitWaits,
  resumeSend,
  startBroadcast,
  startWait,
  toSendWait,
  type MailLimiter,
  type SendMessage,
  type WaitColumns,
} from '@swarm/engine';
import { MailProviderError, ResendError, SesError } from '@swarm/mail';
import { describe, expect, it } from 'vitest';
import {
  broadcastRow,
  CaptureMail,
  completeRamp,
  config,
  context,
  count,
  drain,
  seedChannel,
  seedDispatch,
} from './harness';

const MIN = 60_000;

async function start(channelId: string, run: ReturnType<typeof context>) {
  const dispatch = await seedDispatch(channelId);
  const { broadcastId } = await startBroadcast(env.DB, run.queue, config, {
    dispatch,
    operatorId: null,
    allowHtmlBlocks: false,
  });
  return { dispatch, broadcastId };
}

const waitRow = (broadcastId: string) =>
  env.DB.prepare(
    `SELECT status, waiting_for, waiting_since, wait_detail, resume_at, recipient_count, sent_count,
            failed_count, last_progress_at
       FROM broadcasts WHERE id = ?1`,
  )
    .bind(broadcastId)
    .first<WaitColumns>();

const pending = (broadcastId: string) =>
  count(
    `SELECT count(*) AS n FROM broadcast_recipients WHERE broadcast_id = ?1 AND status = 'pending'`,
    broadcastId,
  );

/** Every recipient got exactly one email and one delivery row. */
async function expectEveryoneOnce(mail: CaptureMail, broadcastId: string, members: number) {
  // The reaper also moves other tests' sends in this shared database: only this one's count.
  const posts = mail.sent.filter(
    (m) => m.category === 'broadcast' && m.tags?.broadcast === broadcastId,
  );
  expect(posts).toHaveLength(members);
  expect(new Set(posts.map((m) => m.to)).size).toBe(members);
  expect(
    await count('SELECT count(*) AS n FROM deliveries WHERE broadcast_id = ?1', broadcastId),
  ).toBe(members);
}

/**
 * A pacer with `left` emails for sends until `resetsAt`, then nothing for `limit`. Counts like the
 * real one, which the realtime worker tests.
 */
function windowLimiter(limit: 'day' | 'month', left: number, resetsAt: number) {
  const state = { left, released: 0, blocked: [] as [string, number][] };
  const limiter: MailLimiter = {
    turn: async ({ count: wanted }): Promise<LimitTurn> => {
      const granted = Math.min(wanted, state.left);
      state.left -= granted;
      const short = granted < wanted;
      return {
        granted,
        startInMs: 0,
        retryAfterSeconds: short ? 60 : 0,
        limit: short ? limit : null,
        resetsAt: short ? resetsAt : null,
      };
    },
    release: async (n) => {
      state.released += n;
    },
    block: async (window, until) => {
      state.blocked.push([window, until]);
    },
    usage: async () => {
      throw new Error('not used');
    },
  };
  return { limiter, state };
}

/** What the post's warm-up has counted today (the shared domain's ramp: 100 a day to start). */
const warmupSentToday = (broadcastId: string) =>
  env.DB.prepare(
    'SELECT r.sent_today FROM reputation_ramps r JOIN broadcasts b ON b.ramp_id = r.id WHERE b.id = ?1',
  )
    .bind(broadcastId)
    .first<number>('sent_today');

async function seedOwner(workspaceId: string) {
  const operatorId = newId('operator');
  const email = `owner-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO operators (id, email, name, created_at, updated_at) VALUES (?1, ?2, 'Owner', 0, 0)`,
    ).bind(operatorId, email),
    env.DB.prepare(
      `INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'owner', 0, 0)`,
    ).bind(newId('seat'), workspaceId, operatorId),
  ]);
  return email;
}

describe('throttling that outlasts the queue’s retries', () => {
  it('delivers everyone exactly once when the provider answers 429 past max_retries', async () => {
    const { channelId } = await seedChannel({ members: 5 });
    await completeRamp(channelId);
    const mail = new CaptureMail();
    // One batch of five: 60 refused calls are twelve deliveries of it, more than the nine
    // (the first and eight retries) the queue allows before the dead-letter queue.
    mail.fail = (_mail, call) =>
      call <= 60 ? new MailProviderError(429, 'rate_limit_exceeded', 'Too many requests', 2) : null;
    const run = context(mail);
    const { broadcastId } = await start(channelId, run);
    const delays: number[] = [];
    const send = run.queue.send.bind(run.queue);
    run.queue.send = async (body: SendMessage, options?: { delaySeconds?: number }) => {
      if (body.type === 'batch' && body.throttled) delays.push(options?.delaySeconds ?? 0);
      return send(body, options);
    };

    const { deadLettered, retries } = await drain(run.ctx, run.queue, { maxRetries: 8 });

    expect(deadLettered).toEqual([]);
    await expectEveryoneOnce(mail, broadcastId, 5);
    expect(await broadcastRow(broadcastId)).toMatchObject({
      status: 'sent',
      sent_count: 5,
      failed_count: 0,
    });
    // The queue's own retry the first two times, then new messages with a growing delay.
    expect(retries).toBe(2);
    expect(delays.length).toBeGreaterThanOrEqual(9);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(delays.at(-1)).toBe(900);
  });
});

describe('the email service’s own quota', () => {
  it('waits for the next UTC day after a daily quota, then carries on by itself', async () => {
    const { channelId } = await seedChannel({ members: 6 });
    await completeRamp(channelId);
    const mail = new CaptureMail();
    let quotaUsedUp = true;
    mail.fail = (_mail, call) =>
      call > 2 && quotaUsedUp
        ? new ResendError(429, 'daily_quota_exceeded', 'You have reached your daily quota.')
        : null;
    const run = context(mail);
    let now = Date.UTC(2026, 10, 16, 20);
    run.ctx.now = () => now;
    const { limiter, state } = windowLimiter('day', 1000, 0);
    run.ctx.limiter = limiter;
    (run.ctx.mail as { maxConcurrency?: number }).maxConcurrency = 1;
    const { broadcastId } = await start(channelId, run);
    const midnight = Date.UTC(2026, 10, 17);

    const { delayed } = await drain(run.ctx, run.queue, { stopAtDelay: true });

    expect(mail.sent).toHaveLength(2);
    expect(await pending(broadcastId)).toBe(4);
    const row = (await waitRow(broadcastId))!;
    expect(row).toMatchObject({
      status: 'sending',
      waiting_for: 'service_day',
      resume_at: midnight,
    });
    expect(toSendWait(row, now)).toMatchObject({
      reason: 'service_day',
      until: new Date(midnight).toISOString(),
      left: 4,
    });
    // Every other send stops asking the service too, and what didn't go out isn't counted: the
    // one the service refused and the three after it that were never tried.
    expect(state.blocked).toEqual([['day', midnight]]);
    expect(state.released).toBe(4);
    // The four come back at midnight on a new message, which doesn't count as a retry.
    expect(delayed).toHaveLength(1);
    expect(delayed[0]!.delaySeconds).toBe((midnight - now) / 1000 + 1);

    // Arriving early, the message goes back to wait without claiming anyone or asking the service.
    const calls = mail.sent.length;
    await handleSendMessage(run.ctx, delayed[0]!.body);
    expect(run.queue.items).toHaveLength(1);
    expect(run.queue.items[0]!.delaySeconds).toBeGreaterThan(0);
    expect(mail.sent).toHaveLength(calls);

    now = midnight + MIN;
    quotaUsedUp = false;
    run.queue.items.splice(0, run.queue.items.length, { body: delayed[0]!.body, delaySeconds: 0 });
    await drain(run.ctx, run.queue);

    await expectEveryoneOnce(mail, broadcastId, 6);
    expect(await waitRow(broadcastId)).toMatchObject({ status: 'sent', waiting_for: null });
  });

  it('pauses after a monthly quota, tells the owners once, and resumes at the next month', async () => {
    const { channelId, workspaceId } = await seedChannel({ members: 120 });
    await completeRamp(channelId);
    const owner = await seedOwner(workspaceId);
    const mail = new CaptureMail();
    let quotaUsedUp = true;
    mail.fail = (sent, call) =>
      sent.category === 'broadcast' && call > 3 && quotaUsedUp
        ? new ResendError(429, 'monthly_quota_exceeded', 'You have reached your monthly quota.')
        : null;
    const run = context(mail);
    let now = Date.UTC(2026, 10, 16, 12);
    run.ctx.now = () => now;
    const { broadcastId } = await start(channelId, run);
    const december = Date.UTC(2026, 11, 1);

    // Three batches: the first finds the quota, the other two arrive while the send is paused.
    await drain(run.ctx, run.queue);

    expect(mail.sent.filter((m) => m.category === 'broadcast')).toHaveLength(3);
    expect(await pending(broadcastId)).toBe(117);
    expect(await waitRow(broadcastId)).toMatchObject({
      status: 'sending',
      waiting_for: 'service_month',
      resume_at: december,
    });
    const notices = mail.sent.filter((m) => m.category === 'operator');
    expect(notices.map((m) => m.to)).toEqual([owner]);
    expect(notices[0]!.subject).toBe('Sending paused: Issue 1');
    expect(notices[0]!.text).toMatch(/117 subscribers are still waiting/);
    expect(notices[0]!.text).toMatch(/1 December, 00:00 UTC/);

    // Not before the month turns.
    expect(await resumeDueSends(env.DB, run.queue, december - MIN)).toEqual([]);
    now = december + MIN;
    quotaUsedUp = false;
    expect(await resumeDueSends(env.DB, run.queue, now)).toContain(broadcastId);
    await drain(run.ctx, run.queue);

    await expectEveryoneOnce(mail, broadcastId, 120);
    expect(await waitRow(broadcastId)).toMatchObject({ status: 'sent', waiting_for: null });
  });
});

describe('this Swarm’s own sending limits', () => {
  it('sends what the day allows, and the rest the next day, without a retry', async () => {
    const { channelId } = await seedChannel({ members: 8 });
    await completeRamp(channelId);
    const run = context();
    let now = Date.UTC(2026, 10, 16, 9);
    run.ctx.now = () => now;
    const midnight = Date.UTC(2026, 10, 17);
    const { limiter, state } = windowLimiter('day', 3, midnight);
    run.ctx.limiter = limiter;
    const { broadcastId } = await start(channelId, run);

    const { delayed, retries } = await drain(run.ctx, run.queue, { stopAtDelay: true });

    expect(retries).toBe(0);
    expect(run.mail.sent).toHaveLength(3);
    expect(await waitRow(broadcastId)).toMatchObject({ waiting_for: 'day', resume_at: midnight });
    expect(delayed).toHaveLength(1);
    expect((delayed[0]!.body as { memberIds: string[] }).memberIds).toHaveLength(5);
    // They read as never having been tried.
    expect(
      await count(
        `SELECT count(*) AS n FROM broadcast_recipients WHERE broadcast_id = ?1 AND status = 'pending'
           AND claimed_at IS NULL AND attempts = 0`,
        broadcastId,
      ),
    ).toBe(5);

    now = midnight + MIN;
    state.left = 1000;
    run.queue.items.push({ body: delayed[0]!.body, delaySeconds: 0 });
    await drain(run.ctx, run.queue);
    await expectEveryoneOnce(run.mail, broadcastId, 8);
    expect(await waitRow(broadcastId)).toMatchObject({ status: 'sent', waiting_for: null });
  });

  it('resumes a daily wait without counting a warming post’s recipients twice', async () => {
    // No completeRamp: the post warms up, and its fan-out reserves today's capacity for everyone.
    const { channelId } = await seedChannel({ members: 8 });
    const run = context();
    const midnight = Date.now() - (Date.now() % 86_400_000) + 86_400_000;
    const { limiter, state } = windowLimiter('day', 3, midnight);
    run.ctx.limiter = limiter;
    const { broadcastId } = await start(channelId, run);
    const { delayed } = await drain(run.ctx, run.queue, { stopAtDelay: true });
    expect(run.mail.sent).toHaveLength(3);
    expect(await waitRow(broadcastId)).toMatchObject({ waiting_for: 'day' });
    // The five left wait in a delayed batch, still holding their warm-up reservation (and the
    // fan-out looks again later).
    expect(delayed.map((item) => item.body.type).sort()).toEqual(['batch', 'fanout']);
    expect(await warmupSentToday(broadcastId)).toBe(8);

    // An instance admin raises the limit: the wait is resumed at once, and the five go now.
    state.left = 1000;
    expect(await resumeLimitWaits(env.DB, run.queue, Date.now())).toBe(1);
    await drain(run.ctx, run.queue);
    expect(run.mail.sent).toHaveLength(8);
    // The delayed messages come later and find nobody left to send.
    run.queue.items.push(...delayed.map((item) => ({ body: item.body, delaySeconds: 0 })));
    await drain(run.ctx, run.queue);

    await expectEveryoneOnce(run.mail, broadcastId, 8);
    expect(await waitRow(broadcastId)).toMatchObject({ status: 'sent', waiting_for: null });
    // Eight people, eight of today's warm-up: none counted twice for other sends on the domain.
    expect(await warmupSentToday(broadcastId)).toBe(8);
  });

  it('gives a paused post’s warm-up back once, however often its batch arrives', async () => {
    const { channelId } = await seedChannel({ members: 4 });
    const run = context();
    const { broadcastId } = await start(channelId, run);
    // The snapshot and fan-out (warm-up walks the engaged first: none here): four reserved, one
    // batch on the queue.
    while (run.queue.items[0]?.body.type !== 'batch') {
      await handleSendMessage(run.ctx, run.queue.items.shift()!.body);
    }
    expect(run.queue.items.filter((item) => item.body.type === 'batch')).toHaveLength(1);
    // Other sends on the domain have used some of today too.
    await env.DB.prepare(
      'UPDATE reputation_ramps SET sent_today = sent_today + 50 WHERE id = (SELECT ramp_id FROM broadcasts WHERE id = ?1)',
    )
      .bind(broadcastId)
      .run();
    expect(await warmupSentToday(broadcastId)).toBe(54);
    const now = Date.now();
    await startWait(env.DB, broadcastId, { reason: 'month', until: now + 86_400_000 }, now);
    // The batch arrives twice (the queue delivers at least once, a resume pulls batches forward).
    await drain(run.ctx, run.queue, { duplicateBatches: true });
    expect(run.mail.sent.filter((m) => m.category === 'broadcast')).toHaveLength(0);
    expect(await warmupSentToday(broadcastId)).toBe(50);

    // Resumed the same day, the walk reserves them again, once.
    run.queue.items.splice(0);
    expect(await resumeSend(env.DB, run.queue, broadcastId, Date.now())).toBe(true);
    await drain(run.ctx, run.queue, { duplicateBatches: true });
    await expectEveryoneOnce(run.mail, broadcastId, 4);
    expect(await warmupSentToday(broadcastId)).toBe(54);
  });

  it('holds the fan-out back while a send waits, and checks again later', async () => {
    const { channelId } = await seedChannel({ members: 4 });
    await completeRamp(channelId);
    const run = context();
    const now = Date.UTC(2026, 10, 16, 9);
    run.ctx.now = () => now;
    const { broadcastId } = await start(channelId, run);
    // The snapshot, then a wait recorded before the fan-out runs.
    await handleSendMessage(run.ctx, run.queue.items.shift()!.body);
    expect(run.queue.items.map((item) => item.body.type)).toEqual(['fanout']);
    await startWait(env.DB, broadcastId, { reason: 'hour', until: now + 30 * MIN }, now);
    await handleSendMessage(run.ctx, run.queue.items.shift()!.body);
    // At most fifteen minutes, so a send someone resumes by hand isn't kept waiting long.
    expect(run.queue.items).toEqual([{ body: { type: 'fanout', broadcastId }, delaySeconds: 900 }]);
    expect(run.mail.sent).toHaveLength(0);
  });

  it('pauses for a monthly limit; nothing is in flight until it resumes', async () => {
    const { channelId } = await seedChannel({ members: 4 });
    await completeRamp(channelId);
    const run = context();
    const now = Date.UTC(2026, 10, 30, 23);
    run.ctx.now = () => now;
    const december = Date.UTC(2026, 11, 1);
    const { limiter, state } = windowLimiter('month', 1, december);
    run.ctx.limiter = limiter;
    const { broadcastId } = await start(channelId, run);
    await drain(run.ctx, run.queue);
    expect(run.mail.sent.filter((m) => m.category === 'broadcast')).toHaveLength(1);
    expect(await waitRow(broadcastId)).toMatchObject({ waiting_for: 'month', resume_at: december });
    expect(run.queue.items).toEqual([]);
    state.left = 1000;
    expect(await resumeDueSends(env.DB, run.queue, december)).toContain(broadcastId);
    run.queue.items.splice(
      0,
      run.queue.items.length,
      ...run.queue.items.filter((item) => item.body.broadcastId === broadcastId),
    );
    await drain(run.ctx, run.queue);
    await expectEveryoneOnce(run.mail, broadcastId, 4);
  });
});

describe('an email service that stops accepting mail', () => {
  it('pauses with everyone pending, is left alone by the reaper, and resumes when asked', async () => {
    const { channelId, workspaceId } = await seedChannel({ members: 5 });
    await completeRamp(channelId);
    await seedOwner(workspaceId);
    const mail = new CaptureMail();
    mail.fail = () => new SesError(400, 'AccountSuspendedException', 'Your account is suspended.');
    const run = context(mail);
    const { broadcastId, dispatch } = await start(channelId, run);
    // The notice can't go out either; that's logged, not retried.
    const logged: string[] = [];
    run.ctx.log = (message) => logged.push(message);
    await drain(run.ctx, run.queue);

    const row = (await waitRow(broadcastId))!;
    expect(toSendWait(row)).toMatchObject({ reason: 'service_stopped', left: 5 });
    // The next try of the service, five minutes after it stopped.
    expect(row.resume_at).toBe(row.waiting_since! + 5 * MIN);
    expect(toSendWait(row)?.detail).toMatch(/AccountSuspendedException/);
    expect(logged).toContain('paused send notice not sent');
    expect(await pending(broadcastId)).toBe(5);

    // Hours later the reaper sees a paused send, not a stuck one.
    await env.DB.prepare('UPDATE broadcasts SET last_progress_at = 0 WHERE id = ?1')
      .bind(broadcastId)
      .run();
    const touched = await reap(run.ctx);
    expect(touched).not.toContain(broadcastId);
    expect(run.queue.items.filter((item) => item.body.broadcastId === broadcastId)).toEqual([]);
    run.queue.items.splice(0);

    mail.fail = null;
    expect(await resumeSend(env.DB, run.queue, broadcastId, Date.now())).toBe(true);
    // A second resume finds nothing to resume.
    expect(await resumeSend(env.DB, run.queue, broadcastId, Date.now())).toBe(false);
    await drain(run.ctx, run.queue);
    await expectEveryoneOnce(mail, broadcastId, 5);
    expect(await broadcastRow(broadcastId)).toMatchObject({ status: 'sent', sent_count: 5 });
    const status = await env.DB.prepare('SELECT status FROM dispatches WHERE id = ?1')
      .bind(dispatch.id)
      .first<{ status: string }>();
    expect(status?.status).toBe('sent');
  });

  it('tries the service again by itself, less often each time, and goes on when it takes mail', async () => {
    const { channelId, workspaceId } = await seedChannel({ members: 5 });
    await completeRamp(channelId);
    const owner = await seedOwner(workspaceId);
    const mail = new CaptureMail();
    let suspended = true;
    // The service refuses posts; the owners' notice still gets through.
    mail.fail = (sent) =>
      suspended && sent.category === 'broadcast'
        ? new SesError(400, 'AccountSuspendedException', 'Your account is suspended.')
        : null;
    const run = context(mail);
    const stoppedAt = Date.now();
    let now = stoppedAt;
    run.ctx.now = () => now;
    const { broadcastId, dispatch } = await start(channelId, run);
    await drain(run.ctx, run.queue);
    expect(await waitRow(broadcastId)).toMatchObject({
      waiting_for: 'service_stopped',
      waiting_since: stoppedAt,
      resume_at: stoppedAt + 5 * MIN,
    });
    const tries = () =>
      run.queue.items.filter(
        (item) => item.body.broadcastId === broadcastId && item.body.type === 'batch',
      );

    // Not before its time.
    now = stoppedAt + 4 * MIN;
    await reap(run.ctx);
    expect(tries()).toEqual([]);
    // Then one email tries the service, and the next try is as far off as the stop is old.
    for (const [at, next] of [
      [5, 10],
      [10, 20],
      [20, 40],
    ] as const) {
      now = stoppedAt + at * MIN;
      expect(await reap(run.ctx)).toContain(broadcastId);
      expect(tries()).toHaveLength(1);
      expect((tries()[0]!.body as { memberIds: string[] }).memberIds).toHaveLength(1);
      expect((await waitRow(broadcastId))?.resume_at).toBe(stoppedAt + next * MIN);
      await drain(run.ctx, run.queue);
      expect(await waitRow(broadcastId)).toMatchObject({
        waiting_for: 'service_stopped',
        waiting_since: stoppedAt,
      });
      expect(await pending(broadcastId)).toBe(5);
    }
    // At most six hours apart, and never past the end.
    now = stoppedAt + 9 * 3_600_000;
    await reap(run.ctx);
    expect((await waitRow(broadcastId))?.resume_at).toBe(now + 6 * 3_600_000);
    await drain(run.ctx, run.queue);

    // The account is fixed: the next try gets through, and so does everyone else.
    suspended = false;
    now += 6 * 3_600_000;
    await reap(run.ctx);
    await drain(run.ctx, run.queue);
    await expectEveryoneOnce(mail, broadcastId, 5);
    expect(await waitRow(broadcastId)).toMatchObject({ status: 'sent', waiting_for: null });
    const status = await env.DB.prepare('SELECT status FROM dispatches WHERE id = ?1')
      .bind(dispatch.id)
      .first<{ status: string }>();
    expect(status?.status).toBe('sent');
    // The owners heard about the stop once, however many tries failed.
    const notices = mail.sent.filter((m) => m.category === 'operator' && m.to === owner);
    expect(notices.map((m) => m.subject)).toEqual(['Sending paused: Issue 1']);
    expect(notices[0]!.text).toMatch(/Swarm tries the email service again by itself/);
  });

  it('ends after seven days: the rest are recorded as not sent and the post goes back to draft', async () => {
    const { channelId, workspaceId } = await seedChannel({ members: 3 });
    await completeRamp(channelId);
    const owner = await seedOwner(workspaceId);
    const mail = new CaptureMail();
    mail.fail = (sent) =>
      sent.category === 'broadcast'
        ? new ResendError(403, 'invalid_from', 'Domain not verified')
        : null;
    // Resend's "domain not verified" is a halt, like a suspended account.
    const halting = new ResendError(403, 'invalid_from', 'Domain not verified');
    expect(halting.halting).toBe(true);
    const run = context(mail);
    const stoppedAt = Date.now();
    let now = stoppedAt;
    run.ctx.now = () => now;
    const { broadcastId, dispatch } = await start(channelId, run);
    await drain(run.ctx, run.queue);
    expect((await waitRow(broadcastId))?.waiting_for).toBe('service_stopped');

    // The last try is set for the end, not past it.
    now = stoppedAt + 7 * 86_400_000 - 3_600_000;
    await reap(run.ctx);
    expect((await waitRow(broadcastId))?.resume_at).toBe(stoppedAt + 7 * 86_400_000);
    await drain(run.ctx, run.queue);
    expect((await broadcastRow(broadcastId))?.status).toBe('sending');

    now = stoppedAt + 7 * 86_400_000;
    expect(await reap(run.ctx)).toContain(broadcastId);
    await drain(run.ctx, run.queue);
    expect(await broadcastRow(broadcastId)).toMatchObject({
      status: 'failed',
      sent_count: 0,
      failed_count: 3,
    });
    expect((await broadcastRow(broadcastId))?.failure_reason).toMatch(
      /^The email service stopped accepting mail and still refused it after 7 days \(invalid_from/,
    );
    expect(await waitRow(broadcastId)).toMatchObject({ waiting_for: null, resume_at: null });
    expect(
      await count(
        `SELECT count(*) AS n FROM broadcast_recipients WHERE broadcast_id = ?1 AND status = 'failed'`,
        broadcastId,
      ),
    ).toBe(3);
    // Nobody got it, so the post can be fixed and sent again.
    const status = await env.DB.prepare('SELECT status FROM dispatches WHERE id = ?1')
      .bind(dispatch.id)
      .first<{ status: string }>();
    expect(status?.status).toBe('draft');
    const ended = mail.sent.filter((m) => m.to === owner && m.subject === 'Send ended: Issue 1');
    expect(ended).toHaveLength(1);
    expect(ended[0]!.text).toMatch(/3 subscribers were not sent it/);
    expect(ended[0]!.text).toMatch(/back in your drafts/);
    // Nothing is left to try.
    expect(await reap(run.ctx)).not.toContain(broadcastId);
  });

  it('records an automation email’s waiting subscribers as not sent after seven days, and stays open', async () => {
    const { channelId } = await seedChannel({ members: 3 });
    await completeRamp(channelId);
    const mail = new CaptureMail();
    mail.fail = () => new ResendError(401, 'invalid_api_key', 'API key is invalid');
    const run = context(mail);
    const stoppedAt = Date.now();
    let now = stoppedAt;
    run.ctx.now = () => now;
    const { broadcastId } = await start(channelId, run);
    const batches: SendMessage[] = [];
    await drain(run.ctx, run.queue, {
      filter: (message) => {
        if (message.type !== 'batch') return true;
        batches.push(message);
        return false;
      },
    });
    await env.DB.prepare(`UPDATE broadcasts SET kind = 'flow' WHERE id = ?1`)
      .bind(broadcastId)
      .run();
    for (const batch of batches) await handleSendMessage(run.ctx, batch);
    expect((await waitRow(broadcastId))?.waiting_for).toBe('service_stopped');
    run.queue.items.splice(0);

    now = stoppedAt + 7 * 86_400_000;
    expect(await reap(run.ctx)).toContain(broadcastId);
    // Still open for the next subscribers who reach it, without the wait.
    expect(await waitRow(broadcastId)).toMatchObject({
      status: 'sending',
      waiting_for: null,
      failed_count: 3,
    });
    expect(await pending(broadcastId)).toBe(0);
  });

  it('pauses and resumes an automation email’s standing send the same way', async () => {
    const { channelId } = await seedChannel({ members: 3 });
    await completeRamp(channelId);
    const mail = new CaptureMail();
    mail.fail = () => new ResendError(401, 'invalid_api_key', 'API key is invalid');
    const run = context(mail);
    const { broadcastId } = await start(channelId, run);
    // Snapshot and fan-out as for a post, then it becomes a Flow email's Broadcast: no fan-out,
    // its recipients arrive one run at a time.
    const batches: SendMessage[] = [];
    await drain(run.ctx, run.queue, {
      filter: (message) => {
        if (message.type !== 'batch') return true;
        batches.push(message);
        return false;
      },
    });
    await env.DB.prepare(`UPDATE broadcasts SET kind = 'flow' WHERE id = ?1`)
      .bind(broadcastId)
      .run();
    for (const batch of batches) await handleSendMessage(run.ctx, batch);
    expect(await waitRow(broadcastId)).toMatchObject({
      status: 'sending',
      waiting_for: 'service_stopped',
    });
    mail.fail = null;
    run.queue.items.splice(0);
    expect(await resumeSend(env.DB, run.queue, broadcastId, Date.now())).toBe(true);
    await drain(run.ctx, run.queue);
    await expectEveryoneOnce(mail, broadcastId, 3);
    // A Flow email's Broadcast stays open for the next runs.
    expect(await waitRow(broadcastId)).toMatchObject({ status: 'sending', waiting_for: null });
  });
});
