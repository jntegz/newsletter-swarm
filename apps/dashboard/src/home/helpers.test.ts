import type { ChannelOverviewBroadcast, Revenue } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  formatDelta,
  formatPercentDelta,
  memberTrend,
  paidState,
  rateTrend,
  rateTrends,
  subscriberDelta,
} from './helpers';

const broadcast = (delivered: number, opens: number, clicks: number): ChannelOverviewBroadcast => ({
  id: `br_${'1'.repeat(32)}`,
  dispatchId: `dp_${'1'.repeat(32)}`,
  subject: 'Issue',
  status: 'sent',
  createdAt: '2026-10-01T00:00:00.000Z',
  completedAt: null,
  recipientCount: delivered,
  delivered,
  humanOpens: opens,
  humanClicks: clicks,
  openRate: delivered ? opens / delivered : 0,
  clickRate: delivered ? clicks / delivered : 0,
});

describe('memberTrend', () => {
  it('is the net change against the estimate for 30 days ago', () => {
    expect(memberTrend({ active: 110, joinedLast30Days: 15, leftLast30Days: 5 })).toEqual({
      value: 110,
      delta: 10,
      percent: 0.1,
    });
  });

  it('has no percentage when every subscriber is new', () => {
    expect(memberTrend({ active: 4, joinedLast30Days: 4, leftLast30Days: 0 }).percent).toBeNull();
  });
});

describe('subscriberDelta', () => {
  it('gives the count and a one-decimal percentage, up or down', () => {
    expect(subscriberDelta({ active: 110, joinedLast30Days: 15, leftLast30Days: 5 })).toEqual({
      count: 10,
      pct: 10,
    });
    expect(subscriberDelta({ active: 95, joinedLast30Days: 1, leftLast30Days: 6 })).toEqual({
      count: -5,
      pct: -5,
    });
  });

  it('keeps a count without a percentage when everyone is new', () => {
    expect(subscriberDelta({ active: 4, joinedLast30Days: 4, leftLast30Days: 0 })).toEqual({
      count: 4,
      pct: null,
    });
  });

  it('says nothing for an empty publication', () => {
    expect(subscriberDelta({ active: 0, joinedLast30Days: 0, leftLast30Days: 0 })).toBeUndefined();
  });

  it('reports no change once there is a base to compare with', () => {
    expect(subscriberDelta({ active: 50, joinedLast30Days: 2, leftLast30Days: 2 })).toEqual({
      count: 0,
      pct: 0,
    });
  });
});

describe('rateTrend', () => {
  it('weights by delivered and compares the latest four with the four before', () => {
    const latest = [broadcast(100, 50, 5), broadcast(300, 90, 9), broadcast(0, 0, 0)];
    const before = [broadcast(100, 40, 4), broadcast(100, 40, 4), broadcast(100, 40, 4)];
    const trend = rateTrend([...latest, broadcast(0, 0, 0), ...before], 'humanOpens');
    expect(trend?.value).toBeCloseTo(0.35);
    expect(trend?.delta).toBeCloseTo(-0.05);
  });

  it('has no comparison with four sends or fewer, and no value with none delivered', () => {
    expect(rateTrend([broadcast(10, 1, 1)], 'humanClicks')).toEqual({ value: 0.1, delta: null });
    expect(rateTrend([broadcast(0, 0, 0)], 'humanClicks')).toBeNull();
    expect(rateTrend([], 'humanClicks')).toBeNull();
  });
});

describe('rateTrends', () => {
  it('counts only the sends it covers', () => {
    expect(rateTrends([broadcast(10, 5, 1), broadcast(10, 5, 1)])?.sends).toBe(2);
    const many = Array.from({ length: 8 }, () => broadcast(10, 5, 1));
    expect(rateTrends(many)?.sends).toBe(4);
  });

  it('is null until a send has delivered', () => {
    expect(rateTrends([])).toBeNull();
    expect(rateTrends([broadcast(0, 0, 0)])).toBeNull();
  });
});

describe('formatDelta', () => {
  it('formats points and counts with a sign', () => {
    expect(formatDelta(0.019, 'points')).toBe('+1.9 pts');
    expect(formatDelta(-0.003, 'points')).toBe('−0.3 pts');
    expect(formatDelta(1200, 'count')).toBe('+1,200');
    expect(formatDelta(0, 'count')).toBe('±0');
  });
});

describe('formatPercentDelta', () => {
  it('signs a percentage', () => {
    expect(formatPercentDelta(2.1)).toBe('+2.1%');
    expect(formatPercentDelta(-0.4)).toBe('−0.4%');
    expect(formatPercentDelta(0)).toBe('±0%');
  });
});

describe('paidState', () => {
  const revenue = (over: Partial<Revenue> = {}) =>
    ({ mrr: [], activePaid: 0, newPaid: 0, ...over }) as Revenue;
  const base = { connected: true, paymentsError: null, revenue: revenue(), revenueError: null };

  it('is off only when Stripe is not connected', () => {
    expect(paidState({ ...base, connected: false, revenue: undefined })).toBe('off');
  });

  it('shows the zero for a connected publication with no paid subscribers yet', () => {
    const paid = paidState(base);
    expect(paid).toMatchObject({ paid: 0, delta: 0 });
    expect(paid).not.toBe('off');
  });

  it('says a failed read failed, instead of claiming payments are off', () => {
    expect(paidState({ ...base, revenue: undefined, revenueError: new Error('x') })).toBe('error');
    expect(
      paidState({
        ...base,
        connected: undefined,
        revenue: undefined,
        paymentsError: new Error('x'),
      }),
    ).toBe('error');
  });

  it('waits while either read is loading', () => {
    expect(paidState({ ...base, connected: undefined, revenue: undefined })).toBeNull();
    expect(paidState({ ...base, revenue: undefined })).toBeNull();
  });
});
