import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { SendPacer } from '../src/index';

const pacer = (name: string) => env.SEND_PACER.get(env.SEND_PACER.idFromName(name));
const T0 = 1_800_000_000_000;

describe('SendPacer', () => {
  it('gives the first turn at once and spaces the next by what it reserved', async () => {
    const stub = pacer('spacing');
    // Five sends at 5 a second reserve a whole second.
    expect(await stub.take(5, 5, T0)).toEqual({
      granted: 5,
      startInMs: 0,
      retryAfterSeconds: 0,
    });
    expect(await stub.take(5, 5, T0)).toMatchObject({ granted: 5, startInMs: 1000 });
    expect(await stub.take(1, 5, T0)).toMatchObject({ granted: 1, startInMs: 2000 });
    expect(await stub.take(5, 5, T0 + 500)).toMatchObject({ granted: 5, startInMs: 1700 });
  });

  it('holds the limit whatever number of consumers ask at the same moment', async () => {
    const stub = pacer('concurrent');
    const limit = 10;
    // Forty consumers each asking for a chunk at once: more than the line allows at a time.
    const turns = await Promise.all(Array.from({ length: 40 }, () => stub.take(10, limit, T0)));
    const starts = turns
      .filter((t) => t.granted > 0)
      .map((t) => t.startInMs)
      .sort((a, b) => a - b);
    expect(starts.length).toBeGreaterThan(0);
    for (const [i, start] of starts.entries()) {
      // One chunk a second, never two in the same second.
      expect(start).toBe(i * 1000);
    }
    const sent = turns.reduce((sum, t) => sum + t.granted, 0);
    const window = (starts.at(-1)! + 1000) / 1000;
    expect(sent / window).toBeLessThanOrEqual(limit);
  });

  it('sends the rest away, each later than the last, once the line is too long', async () => {
    const stub = pacer('line');
    // Two seconds ahead at most: turns starting at 0, 1 and 2 s.
    for (let i = 0; i < 3; i++) expect((await stub.take(1, 1, T0)).granted).toBe(1);
    const first = await stub.take(1, 1, T0);
    const second = await stub.take(1, 1, T0);
    expect(first.granted).toBe(0);
    expect(first.retryAfterSeconds).toBeGreaterThanOrEqual(3);
    expect(second.granted).toBe(0);
    expect(second.retryAfterSeconds).toBeGreaterThan(first.retryAfterSeconds);
  });

  it('never tells anyone to wait past the queue’s longest delay', async () => {
    const stub = pacer('cap');
    await stub.take(1, 1, T0);
    await stub.take(1000, 1, T0);
    const told = await stub.take(100_000, 1, T0);
    expect(told.granted).toBe(0);
    expect(told.retryAfterSeconds).toBe(43_200);
  });

  it('is free again when the line has passed', async () => {
    const stub = pacer('idle');
    await stub.take(6, 1, T0);
    expect((await stub.take(1, 1, T0)).granted).toBe(0);
    expect(await stub.take(1, 1, T0 + 60_000)).toMatchObject({ granted: 1, startInMs: 0 });
  });
});

const DAY = 86_400_000;
const NONE = { perSecond: null, perHour: null, perDay: null, perMonth: null };
/** 2026-11-16T10:00:00Z: a Monday, ten hours into the day, mid-month. */
const MON = Date.UTC(2026, 10, 16, 10);
const nextMidnight = Date.UTC(2026, 10, 17);

describe('SendPacer: sending limits', () => {
  it('counts the UTC day and leaves a tenth of it for mail people wait for', async () => {
    const stub = pacer('day');
    const limits = { ...NONE, perDay: 100 };
    const bulk = (count: number) => stub.turn({ count, priority: 'bulk', limits, now: MON });
    const urgent = () => stub.turn({ count: 1, priority: 'transactional', limits, now: MON });
    // A send of 95 gets the 90 sends may use; the rest waits for the day to reset.
    expect(await bulk(95)).toEqual({
      granted: 90,
      startInMs: 0,
      retryAfterSeconds: (nextMidnight - MON) / 1000,
      limit: 'day',
      resetsAt: nextMidnight,
    });
    expect(await bulk(1)).toMatchObject({ granted: 0, limit: 'day', resetsAt: nextMidnight });
    // Sign-in links still go: the last ten are theirs.
    for (let i = 0; i < 10; i++) expect((await urgent()).granted).toBe(1);
    expect(await urgent()).toMatchObject({ granted: 0, limit: 'day' });
    // The next day starts from zero.
    expect(
      await stub.turn({ count: 5, priority: 'bulk', limits, now: nextMidnight + 1 }),
    ).toMatchObject({ granted: 5, limit: null });
  });

  it('says the rest waits for the window that resets last', async () => {
    const stub = pacer('month');
    const limits = { ...NONE, perDay: 100, perMonth: 120 };
    expect((await stub.turn({ count: 90, priority: 'bulk', limits, now: MON })).granted).toBe(90);
    // Tomorrow the day has 90 for sends again, but the month only 18 (108 of 120 for sends).
    const turn = await stub.turn({ count: 30, priority: 'bulk', limits, now: MON + DAY });
    expect(turn).toMatchObject({ granted: 18, limit: 'month', resetsAt: Date.UTC(2026, 11, 1) });
  });

  it('counts the clock hour', async () => {
    const stub = pacer('hour');
    const limits = { ...NONE, perHour: 10 };
    expect((await stub.turn({ count: 12, priority: 'bulk', limits, now: MON })).granted).toBe(9);
    expect(
      await stub.turn({ count: 1, priority: 'bulk', limits, now: MON + 3_599_000 }),
    ).toMatchObject({ granted: 0, limit: 'hour', resetsAt: MON + 3_600_000 });
    expect(
      (await stub.turn({ count: 1, priority: 'bulk', limits, now: MON + 3_600_000 })).granted,
    ).toBe(1);
  });

  it('a turn for nothing says whether sending is open, and counts nothing', async () => {
    const stub = pacer('peek');
    const limits = { ...NONE, perDay: 10 };
    expect(await stub.turn({ count: 0, priority: 'bulk', limits, now: MON })).toMatchObject({
      granted: 0,
      limit: null,
    });
    await stub.turn({ count: 9, priority: 'bulk', limits, now: MON });
    expect(await stub.turn({ count: 0, priority: 'bulk', limits, now: MON })).toMatchObject({
      limit: 'day',
    });
    expect((await stub.usage(limits, MON)).day.used).toBe(9);
  });

  it('keeps its counts when the object is evicted', async () => {
    const stub = pacer('evicted');
    const limits = { ...NONE, perDay: 1000 };
    await stub.turn({ count: 40, priority: 'bulk', limits, now: MON });
    await runInDurableObject(stub, (instance: SendPacer) => {
      // What a new instance starts with after eviction: nothing in memory.
      (instance as unknown as { state: unknown }).state = null;
    });
    expect((await stub.usage(limits, MON)).day).toEqual({
      used: 40,
      limit: 1000,
      forSends: 900,
      resetsAt: nextMidnight,
    });
  });

  it('lets mail people wait for go ahead of every bulk turn not handed out yet', async () => {
    const stub = pacer('jump');
    const limits = { ...NONE, perSecond: 2 };
    const bulk = () => stub.turn({ count: 2, priority: 'bulk', limits, now: MON });
    // A send's turns are handed out two seconds ahead: 0, 1 and 2 s. The next one waits.
    expect((await bulk()).startInMs).toBe(0);
    expect((await bulk()).startInMs).toBe(1000);
    expect((await bulk()).startInMs).toBe(2000);
    expect(await bulk()).toMatchObject({ granted: 0, limit: 'second' });
    // A sign-in link goes right after the turns already handed out, ahead of the rest of the send…
    expect(
      await stub.turn({ count: 1, priority: 'transactional', limits, now: MON }),
    ).toMatchObject({ granted: 1, startInMs: 3000 });
    // …whose next turn comes after it.
    expect(await stub.turn({ count: 2, priority: 'bulk', limits, now: MON + 1500 })).toMatchObject({
      granted: 2,
      startInMs: 2000,
    });
  });

  it('keeps bulk and transactional mail together within the per-second limit', async () => {
    const stub = pacer('together');
    const rate = 2;
    const limits = { ...NONE, perSecond: rate };
    // A big send hands out what the line allows; then, at the same moment, sign-in links.
    const turns: { startInMs: number; granted: number }[] = [];
    for (let i = 0; i < 5; i++) {
      turns.push(await stub.turn({ count: 2, priority: 'bulk', limits, now: MON }));
    }
    for (let i = 0; i < 3; i++) {
      const link = await stub.turn({ count: 1, priority: 'transactional', limits, now: MON });
      // Never alongside the send's turns already handed out, which go at 0, 1 and 2 s.
      expect(link.startInMs).toBeGreaterThanOrEqual(3000);
      turns.push(link);
    }
    // Each turn's emails go when it starts; no second, wherever it begins, holds more than two.
    const sends = turns.flatMap((t) => Array<number>(t.granted).fill(t.startInMs));
    expect(sends.length).toBeGreaterThan(6);
    for (const from of sends) {
      expect(sends.filter((at) => at >= from && at < from + 1000).length).toBeLessThanOrEqual(rate);
    }
  });

  it('stops sends, not sign-in links, while the email service’s own quota is used up', async () => {
    const stub = pacer('service');
    await stub.block('day', nextMidnight, MON);
    expect(await stub.turn({ count: 3, priority: 'bulk', limits: NONE, now: MON })).toMatchObject({
      granted: 0,
      limit: 'service_day',
      resetsAt: nextMidnight,
    });
    expect(
      (await stub.turn({ count: 1, priority: 'transactional', limits: NONE, now: MON })).granted,
    ).toBe(1);
    expect((await stub.usage(NONE, MON)).service).toEqual({ window: 'day', until: nextMidnight });
    expect(
      (await stub.turn({ count: 3, priority: 'bulk', limits: NONE, now: nextMidnight })).granted,
    ).toBe(3);
  });

  it('keeps refusing a caller that can wait, not Swarm’s own mail, while the quota is used up', async () => {
    const stub = pacer('service-api');
    await stub.block('day', nextMidnight, MON);
    // A transactional Direct Send: its client is told to come back at midnight.
    expect(
      await stub.turn({
        count: 1,
        priority: 'transactional',
        limits: NONE,
        canWait: true,
        now: MON,
      }),
    ).toMatchObject({ granted: 0, limit: 'service_day', resetsAt: nextMidnight });
    // A sign-in link is still tried: the service may take it.
    expect(
      (await stub.turn({ count: 1, priority: 'transactional', limits: NONE, now: MON })).granted,
    ).toBe(1);
  });

  it('applies the newest saved limits, whatever a worker’s cache brings', async () => {
    const stub = pacer('versions');
    const old = { ...NONE, perMonth: 100 };
    const raised = { ...NONE, perMonth: 1000 };
    // The month is used up under the old limit.
    expect(
      (await stub.turn({ count: 90, priority: 'bulk', limits: old, limitsSavedAt: 1, now: MON }))
        .granted,
    ).toBe(90);
    // Settings saves a higher one and tells the pacer (a turn for nothing).
    await stub.turn({ count: 0, priority: 'bulk', limits: raised, limitsSavedAt: 2, now: MON });
    // A send worker whose cache still holds the old limit is not stopped for the month.
    expect(
      await stub.turn({ count: 5, priority: 'bulk', limits: old, limitsSavedAt: 1, now: MON }),
    ).toMatchObject({ granted: 5, limit: null });
    // Remembered across eviction.
    await runInDurableObject(stub, (instance: SendPacer) => {
      (instance as unknown as { state: unknown }).state = null;
    });
    expect(
      await stub.turn({ count: 5, priority: 'bulk', limits: old, limitsSavedAt: 1, now: MON }),
    ).toMatchObject({ granted: 5, limit: null });
    // A later save lowers it again for everyone.
    await stub.turn({ count: 0, priority: 'bulk', limits: old, limitsSavedAt: 3, now: MON });
    expect(
      await stub.turn({ count: 1, priority: 'bulk', limits: raised, limitsSavedAt: 2, now: MON }),
    ).toMatchObject({ granted: 0, limit: 'month' });
    // take() brings no date: its own limits apply.
    expect((await stub.take(1, 1000, MON)).granted).toBe(1);
  });

  it('gives back counts for mail that did not go, in the window it was counted in', async () => {
    const stub = pacer('release');
    const limits = { ...NONE, perHour: 100 };
    await stub.turn({ count: 10, priority: 'bulk', limits, now: MON });
    await stub.release(4, MON, MON + 1000);
    expect((await stub.usage(limits, MON + 1000)).hour.used).toBe(6);
    // Counted in an hour that has ended: the new hour keeps its own count.
    await stub.turn({ count: 2, priority: 'bulk', limits, now: MON + 3_600_000 });
    await stub.release(6, MON, MON + 3_600_000);
    expect((await stub.usage(limits, MON + 3_600_000)).hour.used).toBe(2);
  });

  it('applies MAIL_MAX_PER_SECOND from the send worker to every turn', async () => {
    const stub = pacer('ceiling');
    const limits = { ...NONE, perSecond: 10 };
    await stub.turn({ count: 1, priority: 'bulk', limits, ceiling: 1, now: MON });
    // Another worker doesn't know the variable, and the ceiling still holds for it.
    expect(
      await stub.turn({ count: 2, priority: 'transactional', limits, now: MON }),
    ).toMatchObject({ granted: 2, startInMs: 1000 });
    expect(
      await stub.turn({ count: 1, priority: 'transactional', limits, now: MON }),
    ).toMatchObject({ granted: 1, startInMs: 3000 });
    expect((await stub.usage(limits, MON)).ceiling).toBe(1);
    await stub.turn({ count: 0, priority: 'bulk', limits, ceiling: null, now: MON });
    expect((await stub.usage(limits, MON)).ceiling).toBeNull();
  });
});

describe('SendPacer: workspaces sharing the windows', () => {
  it('lets one workspace use the whole window while it sends alone', async () => {
    const stub = pacer('share-alone');
    const limits = { ...NONE, perDay: 100 };
    const turn = await stub.turn({
      count: 95,
      priority: 'bulk',
      limits,
      now: MON,
      workspaceId: 'ws_a',
    });
    expect(turn.granted).toBe(90);
  });

  it('keeps an equal part of each window for a second workspace that starts sending', async () => {
    const stub = pacer('share-two');
    const limits = { ...NONE, perDay: 100 };
    // A large Broadcast starts first and takes turns while alone.
    expect(
      (await stub.turn({ count: 30, priority: 'bulk', limits, now: MON, workspaceId: 'ws_big' }))
        .granted,
    ).toBe(30);
    // A small one from another workspace arrives: from now on each may use 45 of the 90.
    expect(
      await stub.turn({
        count: 5,
        priority: 'bulk',
        limits,
        now: MON + 1,
        workspaceId: 'ws_small',
      }),
    ).toMatchObject({ granted: 5, limit: null });
    const big = await stub.turn({
      count: 50,
      priority: 'bulk',
      limits,
      now: MON + 2,
      workspaceId: 'ws_big',
    });
    expect(big.granted).toBe(15);
    // Past its share it is sent back for a minute, not paused until the day resets.
    expect(
      await stub.turn({ count: 10, priority: 'bulk', limits, now: MON + 3, workspaceId: 'ws_big' }),
    ).toEqual({
      granted: 0,
      startInMs: 0,
      retryAfterSeconds: 60,
      limit: 'second',
      resetsAt: null,
      share: true,
    });
    // The small workspace still has its part.
    expect(
      (
        await stub.turn({
          count: 20,
          priority: 'bulk',
          limits,
          now: MON + 4,
          workspaceId: 'ws_small',
        })
      ).granted,
    ).toBe(20);
    // Once the small one has stopped asking for a while, the big one may use what is left.
    const later = MON + 11 * 60_000;
    expect(
      (await stub.turn({ count: 50, priority: 'bulk', limits, now: later, workspaceId: 'ws_big' }))
        .granted,
    ).toBe(20);
  });
});

describe('SendPacer: workspaces sharing the per-second line (S04-P3-TR-send-workspace-share)', () => {
  const limits = { ...NONE, perSecond: 10 };
  const turn = (stub: ReturnType<typeof pacer>, workspaceId: string, now: number, count = 10) =>
    stub.turn({ count, priority: 'bulk', limits, now, workspaceId });

  it('gives a workspace alone the whole rate', async () => {
    const stub = pacer('line-alone');
    // One second per turn of 10 at 10 a second, back to back.
    expect((await turn(stub, 'ws_a', MON)).startInMs).toBe(0);
    expect((await turn(stub, 'ws_a', MON)).startInMs).toBe(1000);
    expect((await turn(stub, 'ws_a', MON)).startInMs).toBe(2000);
  });

  it('splits the rate between workspaces in the line, whoever asks more often', async () => {
    const stub = pacer('line-two');
    expect(await turn(stub, 'ws_a', MON)).toMatchObject({ granted: 10, startInMs: 0 });
    expect(await turn(stub, 'ws_b', MON)).toMatchObject({ granted: 10, startInMs: 1000 });
    // A asks again and again: with B in the line its own lane allows one turn in two seconds.
    expect(await turn(stub, 'ws_a', MON)).toMatchObject({ granted: 10, startInMs: 2000 });
    const greedy = await turn(stub, 'ws_a', MON);
    expect(greedy).toMatchObject({ granted: 0, limit: 'second', share: true });
    expect(greedy.retryAfterSeconds).toBeGreaterThanOrEqual(2);
    // B still gets the next turn, without waiting behind A's sent-away one.
    expect(await turn(stub, 'ws_b', MON + 1500)).toMatchObject({ granted: 10, startInMs: 1500 });
  });

  it('gives the whole rate back once the other workspace has stopped asking', async () => {
    const stub = pacer('line-release');
    await turn(stub, 'ws_a', MON);
    await turn(stub, 'ws_b', MON);
    const later = MON + 20_000;
    expect((await turn(stub, 'ws_a', later)).startInMs).toBe(0);
    expect((await turn(stub, 'ws_a', later)).startInMs).toBe(1000);
  });
});

describe('SendPacer: large sends admitted in parts (S04-P3-TR-send-workspace-share)', () => {
  // perHour 1000: bulk mail may use 900 of each hour.
  const limits = { ...NONE, perHour: 1000 };
  const turn = (
    stub: ReturnType<typeof pacer>,
    workspaceId: string,
    now: number,
    count: number,
    sharedInstall = true,
  ) => stub.turn({ count, priority: 'bulk', limits, now, workspaceId, sharedInstall });

  it('admits at most half of what is left of the hour on an install with several workspaces', async () => {
    const stub = pacer('admit-half');
    expect((await turn(stub, 'ws_big', MON, 600)).granted).toBe(450);
    const held = await turn(stub, 'ws_big', MON + 1, 100);
    expect(held).toMatchObject({ granted: 0, limit: 'second', share: true });
    // It asks again when the hour's last fifth begins (12 minutes before the hour ends).
    expect(held.retryAfterSeconds).toBe(48 * 60);
    // Another workspace arriving later still finds room: half of the 450 left for it.
    expect((await turn(stub, 'ws_late', MON + 2, 500)).granted).toBe(225);
  });

  it('releases the rest in the last part of the hour', async () => {
    const stub = pacer('admit-release');
    expect((await turn(stub, 'ws_big', MON, 900)).granted).toBe(450);
    const release = MON + 48 * 60_000;
    expect((await turn(stub, 'ws_big', release, 900)).granted).toBe(450);
  });

  it('leaves a single-workspace install the whole window', async () => {
    const stub = pacer('admit-single');
    expect((await turn(stub, 'ws_only', MON, 900, false)).granted).toBe(900);
  });
});
