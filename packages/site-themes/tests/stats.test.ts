import { describe, expect, it } from 'vitest';
import { normalCdf, roundUpViews, testResult, withRate } from '../src/index';

describe('A/B test results', () => {
  it('works out rates, and never divides by nothing', () => {
    expect(withRate({ reached: 1000, signups: 32 })).toEqual({
      reached: 1000,
      signups: 32,
      rate: 0.032,
    });
    expect(withRate({ reached: 0, signups: 3 }).rate).toBe(0);
    expect(withRate({ reached: 2, signups: 5 }).rate).toBe(1);
    expect(withRate({ reached: -4, signups: Number.NaN })).toEqual({
      reached: 0,
      signups: 0,
      rate: 0,
    });
  });

  it('has a normal distribution that matches the tables', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.645)).toBeCloseTo(0.05, 3);
  });

  it('calls a clear difference with enough views', () => {
    // 3.2% against 4.1% over 4,000 views each: z is about 2.15.
    const result = testResult({ reached: 4000, signups: 128 }, { reached: 4000, signups: 164 });
    expect(result.a.rate).toBeCloseTo(0.032, 6);
    expect(result.b.rate).toBeCloseTo(0.041, 6);
    expect(result.difference).toBeCloseTo(0.009, 6);
    expect(result.leader).toBe('b');
    expect(result.confidence).toBeGreaterThan(0.96);
    expect(result.confidence).toBeLessThan(0.97);
    expect(result.decided).toBe(true);
    expect(result.viewsNeeded).toBe(0);
  });

  it('estimates the views still needed while it is unsure', () => {
    const result = testResult({ reached: 1000, signups: 32 }, { reached: 1000, signups: 41 });
    expect(result.decided).toBe(false);
    expect(result.leader).toBe('b');
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.confidence).toBeLessThan(0.95);
    expect(result.viewsNeeded).toBeGreaterThan(4000);
    expect(result.viewsNeeded).toBeLessThan(6000);
    // The estimate is consistent: at that many views, with the same rates, it is about decided.
    const each = (result.viewsNeeded! + 2000) / 2;
    const later = testResult(
      { reached: each, signups: Math.round(each * 0.032) },
      { reached: each, signups: Math.round(each * 0.041) },
    );
    expect(later.confidence).toBeGreaterThan(0.94);
  });

  it('does not call a test on too few views, however sure it looks', () => {
    const result = testResult({ reached: 40, signups: 0 }, { reached: 40, signups: 12 });
    expect(result.confidence).toBeGreaterThan(0.99);
    expect(result.decided).toBe(false);
    expect(result.viewsNeeded).toBeGreaterThan(0);
  });

  it('has nothing to estimate while the rates are level or there are no signups', () => {
    expect(testResult({ reached: 0, signups: 0 }, { reached: 0, signups: 0 })).toMatchObject({
      confidence: 0,
      leader: null,
      decided: false,
      viewsNeeded: null,
    });
    expect(testResult({ reached: 500, signups: 10 }, { reached: 500, signups: 10 })).toMatchObject({
      leader: null,
      viewsNeeded: null,
    });
    expect(
      testResult({ reached: 500, signups: 0 }, { reached: 500, signups: 0 }).viewsNeeded,
    ).toBeNull();
  });

  it('rounds the estimate up to two figures', () => {
    expect(roundUpViews(0)).toBe(0);
    expect(roundUpViews(7)).toBe(10);
    expect(roundUpViews(96)).toBe(100);
    expect(roundUpViews(1734)).toBe(1800);
    expect(roundUpViews(12_001)).toBe(13_000);
  });
});
