// Mail outside the send pipeline takes a transactional turn from the install's sending limits
// (LimitedMail), and the wait helpers the send report reads. The pipeline's own turns are tested
// in the send worker (pacing.test.ts, limits.test.ts), the pacer in the realtime worker.
import {
  NO_SENDING_LIMITS,
  UpdateSendingLimitsSchema,
  bulkAllowance,
  effectivePerSecond,
  windowEnd,
  windowStart,
  type LimitTurn,
  type TurnRequest,
} from '@swarm/domain';
import { MailProviderError, ResendError, type MailAdapter, type OutgoingMail } from '@swarm/mail';
import { describe, expect, it } from 'vitest';
import {
  LimitedMail,
  SendingLimitError,
  activeWait,
  resumeTime,
  toSendWait,
  type MailLimiter,
  type WaitColumns,
} from '../src/index';

const mail: OutgoingMail = {
  category: 'quickpass',
  from: { address: 'swarm@mail.example' },
  to: 'ada@example.com',
  subject: 'Sign in',
  text: 'x',
  html: '<p>x</p>',
};

function recorder(turn: (request: TurnRequest) => LimitTurn | Promise<LimitTurn>) {
  const calls = { asked: [] as TurnRequest[], released: 0, blocked: [] as [string, number][] };
  const limiter: MailLimiter = {
    turn: async (request) => {
      calls.asked.push(request);
      return turn(request);
    },
    release: async (n) => {
      calls.released += n;
    },
    block: async (window, until) => {
      calls.blocked.push([window, until]);
    },
    usage: async () => {
      throw new Error('not used');
    },
  };
  return { limiter, calls };
}

const provider = (fail?: Error) => {
  const sent: OutgoingMail[] = [];
  const adapter: MailAdapter = {
    maxConcurrency: 8,
    send: async (outgoing) => {
      if (fail) throw fail;
      sent.push(outgoing);
      return { messageId: 'm-1' };
    },
  };
  return { adapter, sent };
};

const granted: LimitTurn = {
  granted: 1,
  startInMs: 0,
  retryAfterSeconds: 0,
  limit: null,
  resetsAt: null,
};
const limits = async () => ({ limits: { ...NO_SENDING_LIMITS, perDay: 100 }, savedAt: 7 });

describe('LimitedMail', () => {
  it('takes a transactional turn with the stored limits before each email', async () => {
    const { limiter, calls } = recorder(() => granted);
    const { adapter, sent } = provider();
    const limited = new LimitedMail(adapter, limiter, limits);
    expect(limited.maxConcurrency).toBe(8);
    await limited.send(mail);
    expect(sent).toHaveLength(1);
    // With when they were saved, so the pacer can apply newer ones than this worker's cache.
    expect(calls.asked).toEqual([
      {
        count: 1,
        priority: 'transactional',
        limits: { ...NO_SENDING_LIMITS, perDay: 100 },
        limitsSavedAt: 7,
      },
    ]);
  });

  it('refuses with a retryable error, and sends nothing, when a limit is used up', async () => {
    const midnight = Date.UTC(2026, 10, 17);
    const { limiter } = recorder(() => ({
      granted: 0,
      startInMs: 0,
      retryAfterSeconds: 3600,
      limit: 'day',
      resetsAt: midnight,
    }));
    const { adapter, sent } = provider();
    const error = await new LimitedMail(adapter, limiter, limits)
      .send(mail)
      .catch((e: unknown) => e as SendingLimitError);
    expect(error).toBeInstanceOf(SendingLimitError);
    expect(error).toMatchObject({ status: 429, retryable: true, retryAfterSeconds: 3600 });
    expect((error as Error).message).toMatch(/^This Swarm’s daily limit is reached/);
    expect(sent).toEqual([]);
  });

  it('still sends when the pacer can’t be reached', async () => {
    const { limiter } = recorder(() => {
      throw new Error('the send pacer did not answer');
    });
    const { adapter, sent } = provider();
    const logged: string[] = [];
    await new LimitedMail(adapter, limiter, limits, (m) => logged.push(m)).send(mail);
    expect(sent).toHaveLength(1);
    expect(logged).toEqual(['send pacer unavailable; sending without it']);
  });

  it('gives the turn back and tells the pacer when the service’s quota is used up', async () => {
    const { limiter, calls } = recorder(() => granted);
    const { adapter } = provider(new ResendError(429, 'daily_quota_exceeded', 'quota'));
    await expect(new LimitedMail(adapter, limiter, limits).send(mail)).rejects.toMatchObject({
      quota: 'day',
    });
    expect(calls.released).toBe(1);
    expect(calls.blocked).toHaveLength(1);
    expect(calls.blocked[0]![0]).toBe('day');
  });

  it('keeps the count for an address the provider rejected', async () => {
    const { limiter, calls } = recorder(() => granted);
    const { adapter } = provider(new MailProviderError(422, 'invalid_to', 'bad'));
    await expect(new LimitedMail(adapter, limiter, limits).send(mail)).rejects.toThrow('bad');
    expect(calls.released).toBe(0);
  });
});

describe('the limits’ arithmetic', () => {
  it('uses fixed UTC windows', () => {
    const at = Date.UTC(2026, 10, 30, 23, 45, 10);
    expect(windowStart('hour', at)).toBe(Date.UTC(2026, 10, 30, 23));
    expect(windowEnd('hour', at)).toBe(Date.UTC(2026, 11, 1));
    expect(windowStart('day', at)).toBe(Date.UTC(2026, 10, 30));
    expect(windowEnd('month', at)).toBe(Date.UTC(2026, 11, 1));
    expect(windowEnd('month', Date.UTC(2026, 11, 31, 12))).toBe(Date.UTC(2027, 0, 1));
  });

  it('leaves a tenth of each window, and at least one email, for mail people wait for', () => {
    expect(bulkAllowance(100)).toBe(90);
    expect(bulkAllowance(3000)).toBe(2700);
    expect(bulkAllowance(10)).toBe(9);
    expect(bulkAllowance(15)).toBe(13);
  });

  it('lets MAIL_MAX_PER_SECOND lower the per-second setting, never raise it', () => {
    expect(effectivePerSecond({ perSecond: 10 }, 2)).toBe(2);
    expect(effectivePerSecond({ perSecond: 1 }, 5)).toBe(1);
    expect(effectivePerSecond({ perSecond: null }, 5)).toBe(5);
    expect(effectivePerSecond({ perSecond: null }, undefined)).toBeNull();
  });

  it('validates the setting', () => {
    const parse = (value: object) =>
      UpdateSendingLimitsSchema.safeParse({ ...NO_SENDING_LIMITS, ...value });
    expect(parse({ perSecond: 2, perDay: 100, perMonth: 3000 }).success).toBe(true);
    expect(parse({ perSecond: 0.5 }).success).toBe(true);
    expect(parse({ perSecond: 0.25 }).success).toBe(false);
    expect(parse({ perSecond: 0 }).success).toBe(false);
    expect(parse({ perSecond: 1001 }).success).toBe(false);
    expect(parse({ perDay: 5 }).success).toBe(false);
    expect(parse({ perDay: 100.5 }).success).toBe(false);
    const ordered = parse({ perHour: 500, perDay: 100 });
    expect(ordered.success).toBe(false);
    expect(ordered.error?.issues[0]?.path).toEqual(['perHour']);
    expect(parse({ perDay: 5000, perMonth: 3000 }).error?.issues[0]?.path).toEqual(['perDay']);
  });
});

describe('a waiting send', () => {
  const row = (over: Partial<WaitColumns>): WaitColumns => ({
    status: 'sending',
    waiting_for: null,
    waiting_since: 1000,
    wait_detail: null,
    resume_at: null,
    recipient_count: 2000,
    sent_count: 750,
    failed_count: 10,
    last_progress_at: 1000,
    ...over,
  });
  const now = Date.UTC(2026, 10, 16, 18);
  const midnight = Date.UTC(2026, 10, 17);

  it('is waiting for a day until it resets, and counts who is left', () => {
    const wait = row({ waiting_for: 'day', resume_at: midnight });
    expect(toSendWait(wait, now)).toEqual({
      reason: 'day',
      since: new Date(1000).toISOString(),
      until: new Date(midnight).toISOString(),
      left: 1240,
      detail: null,
    });
    // Past the reset, a short wait is over even before the next batch clears it.
    expect(activeWait(wait, midnight + 1)).toBeNull();
  });

  it('stays paused past resume_at until it is resumed, and needs a person without one', () => {
    expect(activeWait(row({ waiting_for: 'month', resume_at: now - 1 }), now)).toBe('month');
    expect(toSendWait(row({ waiting_for: 'service_stopped' }), now)?.until).toBeNull();
    // A finished send isn't waiting, whatever is left in the columns.
    expect(activeWait(row({ status: 'canceled', waiting_for: 'service_stopped' }), now)).toBeNull();
  });

  it('says when sending continues in plain words', () => {
    expect(resumeTime(midnight, now)).toBe('00:00 UTC');
    expect(resumeTime(Date.UTC(2026, 11, 1), now)).toBe('1 December, 00:00 UTC');
  });
});
