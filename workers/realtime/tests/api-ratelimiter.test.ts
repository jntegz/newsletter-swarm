import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const bucket = (name: string) => env.API_RATE_LIMITER.get(env.API_RATE_LIMITER.idFromName(name));
const T0 = 1_800_000_000_000;

describe('ApiRateLimiter', () => {
  it('lets the whole bucket through at once, then refuses with Retry-After', async () => {
    const stub = bucket('burst');
    // 60 a minute plus a burst of 30: a bucket of 90.
    const results = [];
    for (let i = 0; i < 91; i++) results.push(await stub.take(60, 90, T0));
    expect(results.slice(0, 90).every((r) => r.allowed)).toBe(true);
    expect(results[0]).toMatchObject({ limit: 90, remaining: 89 });
    expect(results[89]!.remaining).toBe(0);
    const refused = results[90]!;
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    // One token comes back every second at 60 a minute; the bucket is full in 90 s.
    expect(refused.retryAfterSeconds).toBe(1);
    expect(refused.resetSeconds).toBe(90);
  });

  it('refills at the steady rate', async () => {
    const stub = bucket('refill');
    for (let i = 0; i < 3; i++) expect((await stub.take(6, 3, T0)).allowed).toBe(true);
    expect((await stub.take(6, 3, T0 + 1000)).allowed).toBe(false);
    // 6 a minute is one every 10 seconds.
    const back = await stub.take(6, 3, T0 + 10_000);
    expect(back.allowed).toBe(true);
    expect(back.remaining).toBe(0);
    expect((await stub.take(6, 3, T0 + 10_001)).allowed).toBe(false);
    // A long pause fills the bucket, never beyond its size.
    expect((await stub.take(6, 3, T0 + 3_600_000)).remaining).toBe(2);
  });

  it('applies a smaller policy at once', async () => {
    const stub = bucket('shrink');
    expect((await stub.take(600, 900, T0)).remaining).toBe(899);
    // The plan dropped: the saved tokens are clamped to the new bucket.
    expect((await stub.take(60, 90, T0)).remaining).toBe(89);
  });

  it('keeps principals apart and forgets one when its alarm fires', async () => {
    expect((await bucket('a').take(1, 1, Date.now())).allowed).toBe(true);
    expect((await bucket('a').take(1, 1, Date.now())).allowed).toBe(false);
    expect((await bucket('b').take(1, 1, Date.now())).allowed).toBe(true);
    expect(await runDurableObjectAlarm(bucket('a'))).toBe(true);
    expect((await bucket('a').take(1, 1, Date.now())).allowed).toBe(true);
  });
});
