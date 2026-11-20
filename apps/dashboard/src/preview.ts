/**
 * Sample data for Home's preview states (?preview=first-run | ready | established). Every screen
 * that renders it says "Sample data"; live Home never uses it.
 */
import { projectWarmup } from '@swarm/domain';
import type { HomeModel, SetupStation } from './home/model';
import { homeWarmupNote } from './send/warmup-notes';

export type PreviewState = 'first-run' | 'ready' | 'established';

export const PREVIEW_STATES: { id: PreviewState; label: string }[] = [
  { id: 'first-run', label: 'First run' },
  { id: 'ready', label: 'Ready to send' },
  { id: 'established', label: 'Established' },
];

function setupSteps(state: PreviewState): SetupStation[] {
  const dmarcDone = state !== 'first-run';
  return [
    {
      id: 'domain',
      title: 'Sending domain',
      done: true,
      summary: 'mail.fieldnotes.example verified, DKIM 2048-bit',
    },
    {
      id: 'dmarc',
      title: 'DMARC set to quarantine',
      done: dmarcDone,
      summary: dmarcDone
        ? 'p=quarantine found'
        : 'Your record says p=none. Add this TXT record at your DNS host, then check again.',
    },
    {
      id: 'subscribers',
      title: 'First subscribers',
      done: true,
      summary: '212 imported, 4 already suppressed',
    },
    {
      id: 'post',
      title: 'First post',
      done: state === 'established',
      summary: 'Write it now. It sends once the steps above are done.',
    },
  ];
}

const DMARC_RECORD = 'v=DMARC1; p=quarantine; rua=mailto:dmarc+fn@reports.swarm.example';

/** Unique open and click rates (percent) for the last eight sends. */
const PERFORMANCE = [
  { issue: '#35', opens: 44.1, clicks: 4.2 },
  { issue: '#36', opens: 45.8, clicks: 5.1 },
  { issue: '#37', opens: 43.2, clicks: 3.9 },
  { issue: '#38', opens: 47.5, clicks: 5.4 },
  { issue: '#39', opens: 46.0, clicks: 4.4 },
  { issue: '#40', opens: 49.3, clicks: 5.9 },
  { issue: '#41', opens: 50.1, clicks: 5.2 },
  { issue: '#42', opens: 48.2, clicks: 4.7 },
];

/** Daily subscriber totals for the last 30 days, oldest first. */
const SUBSCRIBER_TREND = [
  12469, 12478, 12490, 12486, 12501, 12515, 12522, 12519, 12534, 12548, 12556, 12551, 12563, 12577,
  12590, 12584, 12597, 12608, 12619, 12613, 12626, 12639, 12650, 12646, 12661, 12675, 12688, 12702,
  12716, 12731,
];

const FLOWS = [
  { name: 'Welcome series', entered: 342, completed: 298 },
  { name: 'Re-engagement', entered: 156, completed: 89 },
];

/** Referrals have no summary API yet, so only the established preview state shows figures. */
const REFERRALS = { came: 141, referred: 64 };

const LINKS: HomeModel['links'] = {
  posts: '/dispatches',
  reports: '/dispatches',
  subscribers: '/members',
  sending: '/channels',
  forms: '/forms',
  paid: '/memberships',
  import: '/members/import',
};

/** A domain on its first day at the Standard pace, with the 212 subscribers of the setup samples. */
function sampleWarmup() {
  const today = new Date().toISOString().slice(0, 10);
  const state = {
    status: 'warming' as const,
    day: today,
    capToday: 200,
    sentToday: 0,
    growth: 1.5,
    maxCap: 1_000_000,
  };
  return homeWarmupNote(
    {
      ...state,
      id: 'rr_sample',
      sendingDomainId: 'sd_sample',
      domain: 'mail.fieldnotes.example',
      kind: 'custom',
      sharedOverride: false,
      skipped: false,
      skippedAt: null,
      startedDay: today,
      pace: 'standard',
      startCap: 200,
      bounceThreshold: 0.02,
      complaintThreshold: 0.0008,
      pausedReason: null,
      pausedBy: null,
      days: [],
      plan: projectWarmup(state, 212, today),
    },
    'weekly',
  );
}

/** The whole of Home for a preview state. */
export function sampleHome(state: PreviewState): HomeModel {
  const established = state === 'established';
  const stations = setupSteps(state);
  if (!established) {
    return {
      mode: 'setup',
      subtitle:
        state === 'ready'
          ? 'Your domain is ready. One step left: your first post.'
          : 'One step left before you can send.',
      setup: {
        stations,
        dmarc:
          state === 'first-run' ? { host: '_dmarc.fieldnotes.example', value: DMARC_RECORD } : null,
      },
      warmup: sampleWarmup(),
      needs: [],
      upNext: [],
      lastSend: null,
      placement: null,
      sends: [],
      rates: null,
      subscribers: {
        total: 212,
        facts: [],
        note: '4 addresses were already suppressed and won’t be mailed. The 30-day trend starts drawing once signups come in through a form.',
      },
      automations: [],
      referrals: null,
      paid: 'off',
      health: [
        { tone: 'ok', text: 'mail.fieldnotes.example verified, DKIM 2048-bit' },
        state === 'first-run'
          ? { tone: 'warn', text: 'DMARC is p=none, see step 2 above' }
          : { tone: 'ok', text: 'DMARC p=quarantine' },
        { tone: 'wait', text: 'Warm-up starts with your first send' },
      ],
      links: LINKS,
    };
  }
  return {
    mode: 'established',
    subtitle: 'Tuesday’s send reached 99.1% of inboxes. Next send Friday 06:00.',
    setup: { stations, dmarc: null },
    warmup: null,
    needs: [
      {
        id: 'preview-text',
        title: '#43 sends Fri 31 Oct, 06:00, and its preview text is empty.',
        detail: 'Inboxes will show the first line of the post instead.',
        action: { label: 'Add preview text', href: '/dispatches' },
      },
    ],
    upNext: [
      {
        id: 'p43',
        title: '#43 The gate question: free or paid?',
        when: { kind: 'scheduled', day: 'Fri 31 Oct', time: '06:00', iso: '2025-10-31T06:00' },
        meta: 'Scheduled · to Everyone, 12,731 subscribers',
      },
      {
        id: 'p44',
        title: 'Notes on the popup economy',
        when: { kind: 'draft', edited: 'edited 2h ago' },
        meta: '642 words · not scheduled',
      },
    ],
    lastSend: {
      title: '#42 The slow web, revisited',
      sentAt: 'Tue 28 Oct, 06:00',
      queued: 12731,
      delivered: 12617,
      opened: 6081,
      clicked: 593,
      bounced: 114,
      unsubscribed: 9,
      complained: 0,
    },
    placement: {
      items: [
        { label: 'Gmail', rate: 0.994 },
        { label: 'Outlook', rate: 0.988 },
        { label: 'Apple', rate: 0.992 },
        { label: 'Yahoo', rate: 0.976 },
      ],
      note: 'Inbox placement',
    },
    sends: PERFORMANCE.map((p) => ({
      label: p.issue,
      name: p.issue,
      open: p.opens,
      click: p.clicks,
    })),
    rates: {
      sends: 4,
      opens: { value: 0.4865, delta: 0.035 },
      clicks: { value: 0.0505, delta: 0.004 },
    },
    subscribers: {
      total: 12731,
      delta: { count: 262, pct: 2.1 },
      trend: SUBSCRIBER_TREND,
      facts: [
        { label: 'New this month', value: '1,212' },
        { label: 'Unsubscribed this month', value: '87' },
        { label: 'Top signup form', value: 'Footer form', note: '38% of new subscribers' },
      ],
    },
    automations: FLOWS,
    referrals: REFERRALS,
    paid: { mrr: '$2,508', paid: 418, delta: 12, note: 'Paid at Stripe, 0% platform fee' },
    health: [
      { tone: 'ok', text: 'mail.fieldnotes.example verified, DKIM 2048-bit' },
      { tone: 'ok', text: 'DMARC p=quarantine' },
      { tone: 'ok', text: 'Warm-up finished: day 21, daily cap 40,000' },
    ],
    links: LINKS,
  };
}
