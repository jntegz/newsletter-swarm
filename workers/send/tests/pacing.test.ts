// The install's sending limits in the pipeline: batches take their turns from the pacer,
// recipients over the limit go back on the queue without counting against anyone, and a pacer
// that can't be reached never stops a send. The pacer's own arithmetic is tested in the realtime
// worker; waits for hours, days, months and the email service are in limits.test.ts.
import { env } from 'cloudflare:test';
import { MailProviderError, ResendError } from '@swarm/mail';
import { NO_SENDING_LIMITS, type LimitTurn, type TurnRequest } from '@swarm/domain';
import {
  handleSendMessage,
  limiterOf,
  RetryLater,
  startBroadcast,
  toSendWait,
  WAIT_COLUMNS,
  type MailLimiter,
  type WaitColumns,
} from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { pipelineContext } from '../src/index';
import { parseSendEnv } from '../src/env';
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

/** Answers each turn with the next value; a function runs, and can throw. */
function scripted(...turns: (LimitTurn | (() => LimitTurn))[]) {
  const asked: TurnRequest[] = [];
  const released: number[] = [];
  const blocked: string[] = [];
  const limiter: MailLimiter = {
    turn: async (request) => {
      asked.push(request);
      const next = turns.shift();
      const turn = typeof next === 'function' ? next() : next;
      return turn ?? go(request.count);
    },
    release: async (n) => {
      released.push(n);
    },
    block: async (window) => {
      blocked.push(window);
    },
    usage: async () => {
      throw new Error('not used');
    },
  };
  return { limiter, asked, released, blocked };
}
const go = (granted: number): LimitTurn => ({
  granted,
  startInMs: 0,
  retryAfterSeconds: 0,
  limit: null,
  resetsAt: null,
});
const wait = (retryAfterSeconds: number): LimitTurn => ({
  granted: 0,
  startInMs: 0,
  retryAfterSeconds,
  limit: 'second',
  resetsAt: null,
});
const perSecond = (rate: number) => ({ ...NO_SENDING_LIMITS, perSecond: rate });

async function started(members: number, mail = new CaptureMail()) {
  const { channelId } = await seedChannel({ members });
  await completeRamp(channelId);
  const dispatch = await seedDispatch(channelId);
  const { ctx, queue } = context(mail);
  const { broadcastId } = await startBroadcast(env.DB, queue, config, {
    dispatch,
    operatorId: null,
    allowHtmlBlocks: false,
  });
  return { ctx, queue, mail, broadcastId };
}

/** Runs the snapshot and fan-out, leaving the batch messages on the queue. */
async function toBatches(ctx: Parameters<typeof drain>[0], queue: Parameters<typeof drain>[1]) {
  const batches = [];
  for (let next = queue.items.shift(); next; next = queue.items.shift()) {
    if (next.body.type === 'batch') batches.push(next);
    else await handleSendMessage(ctx, next.body);
  }
  queue.items.push(...batches);
}

describe('pacing across the install', () => {
  it('asks the pacer for each chunk, and sends everyone when turns are free', async () => {
    const { ctx, queue, mail, broadcastId } = await started(6);
    const { limiter, asked } = scripted();
    ctx.limiter = limiter;
    ctx.limits = perSecond(1000);
    (ctx.mail as { maxConcurrency?: number }).maxConcurrency = 2;
    await drain(ctx, queue);
    expect(mail.sent).toHaveLength(6);
    expect(asked.map(({ count, priority }) => [count, priority])).toEqual([
      [2, 'bulk'],
      [2, 'bulk'],
      [2, 'bulk'],
    ]);
    expect(asked[0]!.limits).toEqual(perSecond(1000));
    expect((await broadcastRow(broadcastId))?.status).toBe('sent');
  });

  it('without a per-second limit, takes one turn for the batch, so quotas still count', async () => {
    const { ctx, queue, mail } = await started(3);
    const { limiter, asked } = scripted();
    ctx.limiter = limiter;
    ctx.limits = NO_SENDING_LIMITS;
    await drain(ctx, queue);
    expect(mail.sent).toHaveLength(3);
    expect(asked.map(({ count }) => count)).toEqual([3]);
  });

  it('passes MAIL_MAX_PER_SECOND on as the ceiling, and keeps to it', async () => {
    const { ctx, queue, mail } = await started(4);
    const { limiter, asked } = scripted();
    ctx.limiter = limiter;
    ctx.limits = perSecond(1000);
    ctx.maxPerSecond = 2;
    (ctx.mail as { maxConcurrency?: number }).maxConcurrency = 10;
    await drain(ctx, queue);
    expect(mail.sent).toHaveLength(4);
    // Chunks of two: the ceiling is lower than the setting and the adapter.
    expect(asked.map(({ count, ceiling }) => [count, ceiling])).toEqual([
      [2, 2],
      [2, 2],
    ]);
  });

  it('puts over-limit recipients back on the queue with a delay, not as failures or retries', async () => {
    const { ctx, queue, mail, broadcastId } = await started(5);
    const { limiter } = scripted(go(2), wait(42));
    ctx.limiter = limiter;
    ctx.limits = perSecond(1000);
    (ctx.mail as { maxConcurrency?: number }).maxConcurrency = 2;
    await toBatches(ctx, queue);
    const first = queue.items.shift()!;

    // No error: a thrown retry would count against max_retries, and this message is done.
    await handleSendMessage(ctx, first.body);

    expect(mail.sent).toHaveLength(2);
    const row = await broadcastRow(broadcastId);
    expect(row).toMatchObject({ status: 'sending', sent_count: 2, failed_count: 0 });
    const again = queue.items.filter((item) => item.body.type === 'batch');
    expect(again).toHaveLength(1);
    expect(again[0]!.delaySeconds).toBe(42);
    expect(again[0]!.body).toMatchObject({ type: 'batch', broadcastId });
    const ids = (again[0]!.body as { memberIds: string[] }).memberIds;
    expect(ids).toHaveLength(3);
    // They read as never having been tried.
    expect(
      await count(
        `SELECT count(*) AS n FROM broadcast_recipients WHERE broadcast_id = ?1 AND status = 'pending'
           AND claimed_at IS NULL AND attempts = 0`,
        broadcastId,
      ),
    ).toBe(3);
    // The reaper leaves the send alone until they are due.
    const resume = await env.DB.prepare('SELECT resume_at FROM broadcasts WHERE id = ?1')
      .bind(broadcastId)
      .first<{ resume_at: number }>();
    expect(resume!.resume_at).toBeGreaterThan(Date.now());

    await drain(ctx, queue);
    expect(mail.sent).toHaveLength(5);
    expect(new Set(mail.sent.map((m) => m.to)).size).toBe(5);
    expect(await broadcastRow(broadcastId)).toMatchObject({
      status: 'sent',
      sent_count: 5,
      failed_count: 0,
    });
  });

  it('says a send held for its workspace’s share is waiting for capacity, until it goes on (S04-P3-TR-send-workspace-share)', async () => {
    const { ctx, queue, mail, broadcastId } = await started(4);
    const { limiter, asked } = scripted(go(2), { ...wait(60), share: true });
    ctx.limiter = limiter;
    ctx.limits = perSecond(1000);
    (ctx.mail as { maxConcurrency?: number }).maxConcurrency = 2;
    await toBatches(ctx, queue);
    await handleSendMessage(ctx, queue.items.shift()!.body);
    expect(mail.sent).toHaveLength(2);
    // Every turn names its workspace and whether the install has several.
    expect(asked[0]).toMatchObject({ workspaceId: expect.stringMatching(/^ws_/) });
    expect(typeof asked[0]!.sharedInstall).toBe('boolean');
    const waitOf = async () =>
      toSendWait(
        (await env.DB.prepare(`SELECT ${WAIT_COLUMNS} FROM broadcasts WHERE id = ?1`)
          .bind(broadcastId)
          .first<WaitColumns>())!,
      );
    expect(await waitOf()).toMatchObject({ reason: 'share', left: 2, detail: null });
    // Not a limit of the install: nothing a person has to resume, and no notice to anyone.
    const stored = await env.DB.prepare('SELECT waiting_for FROM broadcasts WHERE id = ?1')
      .bind(broadcastId)
      .first<{ waiting_for: string | null }>();
    expect(stored?.waiting_for).toBeNull();
    await drain(ctx, queue);
    expect(mail.sent).toHaveLength(4);
    expect(await waitOf()).toBeNull();
  });

  it('keeps waiting however many times the line is long, and loses nobody', async () => {
    const { ctx, queue, mail, broadcastId } = await started(2);
    const { limiter } = scripted(...Array.from({ length: 12 }, () => wait(1)));
    ctx.limiter = limiter;
    ctx.limits = perSecond(1000);
    const { retries } = await drain(ctx, queue);
    // More turns refused than the queue's eight retries would have allowed.
    expect(retries).toBe(0);
    expect(mail.sent).toHaveLength(2);
    expect((await broadcastRow(broadcastId))?.status).toBe('sent');
  });

  it('sends a provider’s throttling through the queue retry once, with the waiting recipients', async () => {
    const mail = new CaptureMail();
    mail.fail = (_mail, call) =>
      call === 1 ? new MailProviderError(429, 'throttled', 'Slow down') : null;
    const { ctx, queue, broadcastId } = await started(4, mail);
    const { limiter, released } = scripted(go(1), wait(9));
    ctx.limiter = limiter;
    ctx.limits = perSecond(1000);
    (ctx.mail as { maxConcurrency?: number }).maxConcurrency = 1;
    await toBatches(ctx, queue);
    await expect(handleSendMessage(ctx, queue.items.shift()!.body)).rejects.toBeInstanceOf(
      RetryLater,
    );
    // The message being retried still holds everyone, so nothing else goes on the queue.
    expect(queue.items.filter((item) => item.body.type === 'batch')).toHaveLength(0);
    expect(
      await count(
        `SELECT count(*) AS n FROM broadcast_recipients WHERE broadcast_id = ?1 AND status = 'pending'`,
        broadcastId,
      ),
    ).toBe(4);
    // The throttled email didn't go out, so its turn is given back.
    expect(released).toEqual([1]);
  });

  it('falls back to the per-batch limit when the pacer fails, and keeps sending', async () => {
    const { ctx, queue, mail, broadcastId } = await started(4);
    const logged: string[] = [];
    ctx.log = (message) => logged.push(message);
    const { limiter, asked } = scripted(() => {
      throw new Error('object is down');
    });
    ctx.limiter = limiter;
    ctx.limits = perSecond(100);
    (ctx.mail as { maxConcurrency?: number }).maxConcurrency = 2;
    await drain(ctx, queue);
    expect(mail.sent).toHaveLength(4);
    expect((await broadcastRow(broadcastId))?.status).toBe('sent');
    expect(logged).toContain('send pacer unavailable; pacing per batch');
    // It isn't asked again for the rest of that batch.
    expect(asked).toHaveLength(1);
  });

  it('gives back what an earlier turn counted even after a later turn fails', async () => {
    const mail = new CaptureMail();
    // The first chunk is throttled by the provider; the pacer then stops answering.
    mail.fail = (_mail, call) =>
      call <= 2 ? new MailProviderError(429, 'throttled', 'Slow down') : null;
    const { ctx, queue } = await started(4, mail);
    const { limiter, released } = scripted(go(2), () => {
      throw new Error('the send pacer did not answer');
    });
    ctx.limiter = limiter;
    ctx.limits = perSecond(1000);
    (ctx.mail as { maxConcurrency?: number }).maxConcurrency = 2;
    await toBatches(ctx, queue);
    await expect(handleSendMessage(ctx, queue.items.shift()!.body)).rejects.toBeInstanceOf(
      RetryLater,
    );
    // The second chunk went without the pacer, so only the first one's two were counted.
    expect(mail.sent).toHaveLength(2);
    expect(released).toEqual([2]);
  });

  it('tells the pacer about a used-up quota even after a turn failed', async () => {
    const mail = new CaptureMail();
    mail.fail = (_mail, call) =>
      call === 3
        ? new ResendError(429, 'daily_quota_exceeded', 'You have reached your daily quota.')
        : null;
    const { ctx, queue } = await started(4, mail);
    const { limiter, blocked, released } = scripted(go(2), () => {
      throw new Error('the send pacer did not answer');
    });
    ctx.limiter = limiter;
    ctx.limits = perSecond(1000);
    (ctx.mail as { maxConcurrency?: number }).maxConcurrency = 1;
    await toBatches(ctx, queue);
    await handleSendMessage(ctx, queue.items.shift()!.body);
    // So every other send stops asking the service; nothing counted went unsent.
    expect(blocked).toEqual(['day']);
    expect(released).toEqual([]);
  });

  it('goes back to the queue rather than wait too long in one message', async () => {
    const { ctx, queue, mail } = await started(3);
    const clock = moveClock();
    try {
      const { limiter } = scripted(() => {
        clock.advance(61_000);
        return go(1);
      });
      ctx.limiter = limiter;
      ctx.limits = perSecond(1000);
      (ctx.mail as { maxConcurrency?: number }).maxConcurrency = 1;
      await toBatches(ctx, queue);
      await handleSendMessage(ctx, queue.items.shift()!.body);
      expect(mail.sent).toHaveLength(1);
      expect(queue.items.filter((item) => item.body.type === 'batch')).toHaveLength(1);
    } finally {
      clock.restore();
    }
  });
});

/** Moves Date.now forward by hand. */
function moveClock() {
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;
  return {
    advance: (ms: number) => {
      offset += ms;
    },
    restore: () => {
      Date.now = real;
    },
  };
}

describe('the worker’s wiring', () => {
  const vars = {
    ...env,
    ENVIRONMENT: 'development',
    TRACK_ORIGIN: 'https://link.swarm.test',
    PLATFORM_MAIL_DOMAIN: 'mail.swarm.test',
    UNSUBSCRIBE_MAIL_DOMAIN: 'unsubscribe.swarm.test',
    MEDIA_ORIGIN: 'https://media.swarm.test',
    CAPTURE_ORIGIN: 'https://forms.swarm.test',
    MAIL_ADAPTER: 'dev',
    DNS_RESOLVER: 'dev',
    LINK_HOSTNAMES: 'dev',
  };

  it('takes turns from the realtime worker’s pacer, with no ceiling by default', async () => {
    const ctx = pipelineContext(parseSendEnv({ ...vars, MAIL_MAX_PER_SECOND: undefined }));
    expect(ctx.maxPerSecond).toBeUndefined();
    expect(
      await ctx.limiter!.turn({ count: 2, priority: 'bulk', limits: NO_SENDING_LIMITS }),
    ).toMatchObject({ granted: 2, startInMs: 0 });
    // The owners' notices take their turns too, through the limited adapter.
    expect(ctx.notices?.constructor.name).toBe('LimitedMail');
    expect(ctx.mail.constructor.name).toBe('DevMailbox');
  });

  it('keeps MAIL_MAX_PER_SECOND as the ceiling', () => {
    const ctx = pipelineContext(parseSendEnv({ ...vars, MAIL_MAX_PER_SECOND: '5' }));
    expect(ctx.maxPerSecond).toBe(5);
  });

  it('paces on its own when the binding is missing', () => {
    const ctx = pipelineContext(
      parseSendEnv({ ...vars, MAIL_MAX_PER_SECOND: '5', SEND_PACER: undefined }),
    );
    expect(ctx.limiter).toBeUndefined();
    expect(ctx.maxPerSecond).toBe(5);
    expect(ctx.notices?.constructor.name).toBe('DevMailbox');
  });

  it('rejects when the pacer doesn’t answer, so the batch can pace itself', async () => {
    const limiter = limiterOf(
      {
        idFromName: () => 'x',
        get: () => ({ turn: () => new Promise(() => {}) }),
      } as unknown as DurableObjectNamespace,
      50,
    );
    await expect(
      limiter.turn({ count: 1, priority: 'bulk', limits: NO_SENDING_LIMITS }),
    ).rejects.toThrow('did not answer');
  });
});
