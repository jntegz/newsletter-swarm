import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const limiter = (name: string) => env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name));
const MINUTE = 60_000;
// Aligned to a window boundary so the arithmetic below is exact.
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % MINUTE);

describe('RateLimiter', () => {
  it('allows up to the limit in a window, then refuses with a retry time', async () => {
    const stub = limiter('burst');
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await stub.hit(3, MINUTE, T0 + i * 1000));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[2]!.remaining).toBe(0);
    expect(results[3]!.retryAfterSeconds).toBeGreaterThan(0);
    expect(results[3]!.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('slides: hits from the previous window count by how much they still overlap', async () => {
    const stub = limiter('slide');
    for (let i = 0; i < 4; i++) expect((await stub.hit(4, MINUTE, T0 + i)).allowed).toBe(true);
    // A quarter into the next window, 3 of the previous 4 hits still count: one more fits.
    expect((await stub.hit(4, MINUTE, T0 + MINUTE + MINUTE / 4)).allowed).toBe(true);
    expect((await stub.hit(4, MINUTE, T0 + MINUTE + MINUTE / 4 + 1)).allowed).toBe(false);
    // Three quarters in, only one previous hit still counts.
    expect((await stub.hit(4, MINUTE, T0 + MINUTE + (3 * MINUTE) / 4)).allowed).toBe(true);
    // Two windows later everything has expired.
    const later = T0 + 3 * MINUTE;
    for (let i = 0; i < 4; i++) expect((await stub.hit(4, MINUTE, later + i)).allowed).toBe(true);
  });

  it('keeps keys apart', async () => {
    expect((await limiter('a').hit(1, MINUTE, T0)).allowed).toBe(true);
    expect((await limiter('a').hit(1, MINUTE, T0 + 1)).allowed).toBe(false);
    expect((await limiter('b').hit(1, MINUTE, T0 + 1)).allowed).toBe(true);
  });

  it('forgets a key when its alarm fires', async () => {
    const stub = limiter('forget');
    await stub.hit(1, MINUTE, Date.now());
    expect((await stub.hit(1, MINUTE, Date.now())).allowed).toBe(false);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.hit(1, MINUTE, Date.now())).allowed).toBe(true);
  });
});
