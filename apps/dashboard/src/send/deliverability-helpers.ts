// Pure helpers for the Deliverability Center page, kept free of React so they can be unit tested.
import {
  GMAIL_COMPLAINT_TARGET,
  GMAIL_COMPLAINT_THRESHOLD,
  type ComplaintStanding,
  type MailboxProvider,
} from '@swarm/domain';

export const PROVIDER_LABEL: Record<MailboxProvider, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  yahoo: 'Yahoo and AOL',
  apple: 'Apple iCloud',
  other: 'Other',
};

export const STANDING: Record<
  ComplaintStanding,
  { label: string; tone: 'success' | 'scheduled' | 'danger' }
> = {
  good: { label: 'Below 0.1%', tone: 'success' },
  watch: { label: 'Above 0.1%', tone: 'scheduled' },
  over: { label: 'Above 0.3%', tone: 'danger' },
};

/** Rates as small as complaint rates need two decimals: 0.08%. */
const ratePercent = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export const formatRate = (rate: number | null) => (rate === null ? '—' : ratePercent.format(rate));

/**
 * The scale of the complaint gauge: the threshold sits at 60% of the track, so both lines and a
 * rate a little over the ceiling stay visible; beyond that the fill is clipped.
 */
export const GAUGE_MAX = GMAIL_COMPLAINT_THRESHOLD / 0.6;

/** A rate's position on the gauge, 0–1. */
export const gaugePosition = (rate: number | null) =>
  rate === null ? 0 : Math.max(0, Math.min(1, rate / GAUGE_MAX));

export const GAUGE_MARKS = [
  { rate: GMAIL_COMPLAINT_TARGET, label: '0.1% target' },
  { rate: GMAIL_COMPLAINT_THRESHOLD, label: '0.3% ceiling' },
];

/** Alignment share as a whole-number percentage, or null with no reported mail. */
export function alignmentPercent(aligned: number, messages: number): number | null {
  return messages > 0 ? Math.round((aligned / messages) * 1000) / 10 : null;
}

export const DEDICATED_IP_LABEL = {
  none: 'Not requested',
  requested: 'Requested',
  warming: 'Warming up',
  active: 'Active',
} as const;
