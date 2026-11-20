// What Home shows, in the order it answers: what needs me, what's next, how the last send did,
// then growth and money. Filled from the API (./useLiveHome) or from the sample states
// (../preview), so both render through the same components.

import type { WarmupNote } from '../send/warmup-notes';

type HomeMode = 'setup' | 'established';

export interface SetupStation {
  id: 'domain' | 'dmarc' | 'subscribers' | 'post';
  title: string;
  done: boolean;
  summary: string;
}

/** The DMARC record to publish, shown on the DMARC station while it is the current one. */
interface DmarcFix {
  host: string;
  value: string;
  /** The sending domain to check again; absent for sample data. */
  domainId?: string;
}

export interface NeedItem {
  id: string;
  title: string;
  detail: string;
  action?: { label: string; href: string };
}

export interface NextItem {
  id: string;
  title: string;
  href?: string;
  /** Scheduled posts show their send time; drafts when they were last edited. */
  when:
    | { kind: 'scheduled'; day: string; time: string; iso: string }
    | { kind: 'draft'; edited: string };
  meta: string;
}

interface LastSend {
  title: string;
  href?: string;
  reportHref?: string;
  sentAt: string;
  queued: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  unsubscribed: number;
  complained: number;
}

interface SendPoint {
  /** Short x-axis label (a date, or an issue number in the samples). */
  label: string;
  /** Row label in the table. */
  name: string;
  open: number;
  click: number;
}

interface Fact {
  label: string;
  value: string;
  note?: string;
}

interface SubscribersBlock {
  total: number;
  /** Net change over 30 days; `pct` in percent, null with nobody to compare against. */
  delta?: { count: number; pct: number | null };
  /** Daily totals for the last 30 days, oldest first. */
  trend?: number[];
  facts: Fact[];
  note?: string;
}

/** Unique open and click rates over the latest sends, against the sends before them. */
export interface RateTrends {
  sends: number;
  opens: { value: number; delta: number | null };
  clicks: { value: number; delta: number | null };
}

export interface HealthItem {
  tone: 'ok' | 'warn' | 'wait';
  text: string;
}

export interface HomeModel {
  mode: HomeMode;
  subtitle: string;
  setup: { stations: SetupStation[]; dmarc: DmarcFix | null };
  /** Said while a sending domain is warming up or paused; null once warm-up is done or skipped. */
  warmup: WarmupNote | null;
  needs: NeedItem[];
  upNext: NextItem[];
  lastSend: LastSend | null;
  placement: { items: { label: string; rate: number }[]; note: string } | null;
  sends: SendPoint[];
  rates: RateTrends | null;
  subscribers: SubscribersBlock | null;
  /** 'live' renders the publication's automations; a list is sample data. */
  automations: 'live' | { name: string; entered: number; completed: number }[];
  /** Null on live data: referrals have no summary API yet, so Home shows no figures. */
  referrals: { came: number; referred: number } | null;
  /** 'off' means Stripe isn't connected, 'error' that a read failed, null that it is loading. */
  paid: { mrr: string; paid: number; delta?: number; note: string } | 'off' | 'error' | null;
  health: HealthItem[];
  /** Links used across the page. */
  links: {
    posts: string;
    reports: string;
    subscribers: string;
    sending: string;
    forms: string;
    paid: string;
    import: string;
  };
}
