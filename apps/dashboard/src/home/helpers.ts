// Home's arithmetic: subscriber growth and rate trends from the publication overview read, and
// what the paid subscriptions block should say. Pure, so it is tested without rendering.
import type { ChannelOverview, ChannelOverviewBroadcast, Revenue } from '@swarm/domain';
import { formatMrr } from '../money/helpers';
import type { HomeModel, RateTrends } from './model';

const number = new Intl.NumberFormat('en-US');

interface Trend {
  /** The current value: a count, or a rate from 0 to 1. */
  value: number;
  /** Change against the comparison; null when there is nothing to compare with. */
  delta: number | null;
}

/**
 * Subscribers now against 30 days ago. 30 days ago is estimated as active now minus the net change
 * (joined minus unsubscribed), so the delta is that net change.
 */
export function memberTrend(
  members: ChannelOverview['members'],
): Trend & { percent: number | null } {
  const delta = members.joinedLast30Days - members.leftLast30Days;
  const before = members.active - delta;
  return { value: members.active, delta, percent: before > 0 ? delta / before : null };
}

/**
 * The 30-day change as Home shows it (`pct` in percent, one decimal). Undefined when there is
 * nothing to say: no change, and nobody 30 days ago to compare with.
 */
export function subscriberDelta(
  members: ChannelOverview['members'],
): { count: number; pct: number | null } | undefined {
  const { delta, percent } = memberTrend(members);
  const count = delta ?? 0;
  if (count === 0 && percent === null) return undefined;
  return { count, pct: percent === null ? null : Math.round(percent * 1000) / 10 };
}

/**
 * A delivered-weighted rate over the latest `size` sends, against the `size` before them (a delta
 * in rate points, 0.01 = one point). Sends come newest first.
 */
export function rateTrend(
  broadcasts: readonly ChannelOverviewBroadcast[],
  key: 'humanOpens' | 'humanClicks',
  size = 4,
): Trend | null {
  const rate = (list: readonly ChannelOverviewBroadcast[]) => {
    const delivered = list.reduce((sum, b) => sum + b.delivered, 0);
    return delivered > 0 ? list.reduce((sum, b) => sum + b[key], 0) / delivered : null;
  };
  const latest = rate(broadcasts.slice(0, size));
  if (latest === null) return null;
  const previous = rate(broadcasts.slice(size, size * 2));
  return { value: latest, delta: previous === null ? null : latest - previous };
}

/** Opens and clicks over the latest sends; null until a send has delivered anything. */
export function rateTrends(
  broadcasts: readonly ChannelOverviewBroadcast[],
  size = 4,
): RateTrends | null {
  const opens = rateTrend(broadcasts, 'humanOpens', size);
  const clicks = rateTrend(broadcasts, 'humanClicks', size);
  if (!opens || !clicks) return null;
  return { sends: Math.min(size, broadcasts.length), opens, clicks };
}

/** "+1.9 pts", "−0.3 pts" for a rate delta; "+12" or "−4" for a count. */
export function formatDelta(delta: number, kind: 'points' | 'count'): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
  const size = Math.abs(delta);
  return kind === 'points'
    ? `${sign}${(size * 100).toFixed(1)} pts`
    : `${sign}${number.format(Math.round(size))}`;
}

/** "+2.1%", "−0.4%" or "±0%" for a change already in percent. */
export function formatPercentDelta(pct: number): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '±';
  return `${sign}${Math.abs(pct)}%`;
}

/**
 * The paid subscriptions block. Whether Stripe is connected decides between "off" and the figures,
 * so a connected publication with no paid subscribers yet shows its zero, and a failed read says
 * it failed rather than claiming payments are off.
 */
export function paidState(input: {
  /** From the payments read; undefined while it loads or when it failed. */
  connected: boolean | undefined;
  paymentsError: Error | null;
  revenue: Revenue | undefined;
  revenueError: Error | null;
}): HomeModel['paid'] {
  const { connected, paymentsError, revenue, revenueError } = input;
  if (paymentsError) return 'error';
  if (connected === undefined) return null;
  if (!connected) return 'off';
  if (revenueError) return 'error';
  if (!revenue) return null;
  return {
    mrr: formatMrr(revenue.mrr),
    paid: revenue.activePaid,
    delta: revenue.newPaid,
    note:
      revenue.activePaid === 0
        ? 'Stripe is connected. Paid subscribers show here once someone pays.'
        : 'Paid at Stripe. New paid subscribers in the last 30 days shown beside the count.',
  };
}
