// Development only: a canned API so the shell, Home and the editor can be looked at without the
// workers running. Open any dashboard page with ?mock=1 once (it sticks for the tab), ?mock=0 to
// turn it off. Never bundled in production: main.tsx imports it behind import.meta.env.DEV.
/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  RAMP_PACES,
  projectWarmup,
  rampCapAfterPaceChange,
  rampPaceOf,
  type RampKind,
  type RampPaceKey,
} from '@swarm/domain';
import type * as SiteThemes from '@swarm/site-themes';
import type { CompiledTheme, Design, Problem, ThemeFiles } from '@swarm/site-themes';
import type * as SiteThemesBuiltIn from '@swarm/site-themes/themes';
import { emailCheckRoute, rememberEmailCheckScenario, withEmailChecks } from './mockEmailChecks';
import { MOCK_ADVICE, mockCheckup, rememberCheckupScenario } from './mockCheckup';
import { fallbackAnswer } from './mockFallback';
import { settingsRoute } from './mockSettings';

const KEY = 'swarm:mock-api';
const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const DAY = 86_400_000;
const hex = (n: number) => String(n).padStart(32, '0');

const WS = `ws_${hex(1)}`;
const CH = `ch_${hex(2)}`;
const CH2 = `ch_${hex(3)}`;
const DOMAIN = `sd_${hex(4)}`;

// Warm-up on the Sending page. ?warmup=warming (the default), used (today's limit is used up and a
// post is still going out), paused, complete, skipped, shared (no domain of your own yet),
// shared-admin (the same, as an instance admin), empty or error picks the state; it sticks for the
// tab like ?mock. Home, the send panel, the send report and the import review follow it.
// ?importnew=25000 sets how many new addresses the sample import (?import=ij_…) adds.
const WARMUP_KEY = 'swarm:mock-warmup';
const TODAY = new Date(now).toISOString().slice(0, 10);
const utcDayAt = (offsetDays: number) =>
  new Date(now + offsetDays * DAY).toISOString().slice(0, 10);
const warmupScenario = () => sessionStorage.getItem(WARMUP_KEY) ?? 'warming';
/** The active subscribers of the sample publication (members/counts below). */
const AUDIENCE = 12731;
let ramps: any[] | undefined;
function mockRamps(): any[] {
  if (ramps) return ramps;
  const scenario = warmupScenario();
  const shared = {
    id: `rr_${hex(7)}`,
    sendingDomainId: null,
    domain: 'mail.swarm.example',
    kind: 'shared',
    status: 'warming',
    skippedAt: null,
    startedDay: utcDayAt(-30),
    day: TODAY,
    capToday: 100,
    sentToday: 0,
    startCap: 100,
    growth: 1.3,
    maxCap: 5000,
    bounceThreshold: 0.02,
    complaintThreshold: 0.0008,
    pausedReason: null,
    pausedBy: null,
    days: [],
  };
  // Six days in at the Standard pace: 200, 300, 450, 675, 1,013, then 1,520 today.
  const caps = [200, 300, 450, 675, 1013];
  const own = {
    ...shared,
    id: `rr_${hex(6)}`,
    sendingDomainId: DOMAIN,
    domain: 'mail.fieldnotes.example',
    kind: 'custom',
    startedDay: utcDayAt(-5),
    capToday: 1520,
    sentToday: 412,
    startCap: 200,
    growth: 1.5,
    maxCap: 1_000_000,
    days: caps.map((cap, i) => ({
      day: utcDayAt(i - 5),
      cap,
      sent: i === 2 ? Math.round(cap * 0.6) : cap,
      bounces: i,
      complaints: 0,
    })),
  };
  if (scenario === 'used') Object.assign(own, { sentToday: 1520 });
  if (scenario === 'paused')
    Object.assign(own, {
      status: 'paused',
      sentToday: 1204,
      pausedReason: 'Bounce rate 3.4% is over the 2.0% limit.',
      pausedBy: 'system',
    });
  if (scenario === 'complete')
    Object.assign(own, { status: 'complete', capToday: 1_000_000, startedDay: utcDayAt(-40) });
  if (scenario === 'skipped')
    Object.assign(own, { status: 'complete', skippedAt: iso(-2 * DAY), days: [] });
  ramps = scenario === 'empty' ? [] : scenario.startsWith('shared') ? [shared] : [shared, own];
  return ramps;
}
const withPlan = (ramp: any) => ({
  ...ramp,
  sharedOverride: ramp.kind === 'shared' && warmupScenario() === 'shared-admin',
  skipped: ramp.status === 'complete' && ramp.skippedAt !== null,
  pace: rampPaceOf(ramp.kind, ramp.startCap, ramp.growth),
  plan: projectWarmup(ramp, AUDIENCE, TODAY),
});

// Sending limits (Settings → Instance) and a send waiting for one. ?sendwait=day (the email
// service's daily limit), month, stopped (the service stopped accepting mail), limit (this Swarm's
// own daily limit) or none (the default) picks the send report's state, and Home shows it while it
// lasts; it sticks for the tab like ?mock. The limits form starts empty and keeps what is saved.
const SEND_WAIT_KEY = 'swarm:mock-sendwait';
const sendWaitScenario = () => sessionStorage.getItem(SEND_WAIT_KEY) ?? 'none';
const WAITING_BROADCAST = `br_${hex(300)}`;
const nextUtcMidnight = () => {
  const at = new Date(now);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
};
const nextUtcMonth = () => {
  const at = new Date(now);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
};
function mockWait(): any {
  const base = { since: iso(-2 * 3600_000), left: 1240, detail: null };
  switch (sendWaitScenario()) {
    case 'day':
      return {
        ...base,
        reason: 'service_day',
        until: new Date(nextUtcMidnight()).toISOString(),
        detail: 'daily_quota_exceeded: You have reached your daily email sending quota.',
      };
    case 'limit':
      return { ...base, reason: 'day', until: new Date(nextUtcMidnight()).toISOString() };
    case 'month':
      return { ...base, reason: 'month', until: new Date(nextUtcMonth()).toISOString() };
    case 'stopped':
      return {
        ...base,
        reason: 'service_stopped',
        until: null,
        detail: 'invalid_api_key: API key is invalid',
      };
    default:
      return null;
  }
}
let sendingLimits: any = { perSecond: null, perHour: null, perDay: null, perMonth: null };
let sendingLimitsSavedAt: string | null = null;
function sendingLimitsAnswer() {
  const window = (limit: number | null, used: number, resetsAt: number) => ({
    used,
    limit,
    forSends: limit === null ? null : limit - Math.max(1, Math.ceil(limit / 10)),
    resetsAt: new Date(resetsAt).toISOString(),
  });
  const hour = now - (now % 3600_000) + 3600_000;
  return {
    limits: sendingLimits,
    ceiling: null,
    usage: {
      hour: window(sendingLimits.perHour, 38, hour),
      day: window(sendingLimits.perDay, 186, nextUtcMidnight()),
      month: window(sendingLimits.perMonth, 2140, nextUtcMonth()),
    },
    service:
      sendWaitScenario() === 'day'
        ? { window: 'day', until: new Date(nextUtcMidnight()).toISOString() }
        : null,
    waitingSends: mockWait() ? 1 : 0,
    updatedBy: sendingLimitsSavedAt ? `op_${hex(9)}` : null,
    updatedAt: sendingLimitsSavedAt,
  };
}

// Tracking choices (Sending → Tracking) and engagement retention (Settings → Privacy), kept while
// the tab is open so a change shows after a save.
// A new publication starts with per-person tracking off (docs/privacy-controls.md).
const tracking = { trackOpens: false, trackClicks: false, profileReaders: false };
// Settings → Privacy: every period at its default except engagement history (13 months).
const retention = { months: 13, leftMemberMonths: 24, paymentRecordYears: 10, auditLogMonths: 24 };

const channel = (id: string, name: string, slug: string) => ({
  ...tracking,
  sunsetDays: null,
  id,
  workspaceId: WS,
  slug,
  name,
  description: null,
  branding: { accentColor: null, logoMediaId: null },
  status: 'active',
  doubleOptIn: true,
  styleGuide: '',
  role: 'owner',
  createdAt: iso(-90 * DAY),
  updatedAt: iso(-DAY),
  deletedAt: null,
});

const summary = (
  n: number,
  subject: string,
  status: string,
  extra: Record<string, unknown> = {},
) => ({
  id: `di_${hex(100 + n)}`,
  channelId: CH,
  subject,
  preheader: '',
  status,
  senderIdentityId: null,
  publishAt: null,
  sentAt: null,
  createdAt: iso(-20 * DAY),
  updatedAt: iso(-2 * 3600_000),
  latestBroadcastId: null,
  webVisibility: 'public',
  webPublishedAt: null,
  kind: 'broadcast',
  flowId: null,
  createdVia: null,
  ...extra,
});

const SENT = [
  [35, 'Small sites, big referrers', 44.1, 4.2],
  [36, 'Reading on the train', 45.8, 5.1],
  [37, 'Who reads the footer', 43.2, 3.9],
  [38, 'A week without analytics', 47.5, 5.4],
  [39, 'The cost of a font', 46.0, 4.4],
  [40, 'Letters from readers', 49.3, 5.9],
  [41, 'Field report: referrers', 50.1, 5.2],
  [42, 'The slow web, revisited', 48.2, 4.7],
] as const;

const dispatches = [
  summary(43, 'The gate question: free or paid?', 'scheduled', { publishAt: iso(3 * DAY) }),
  summary(44, 'Notes on the popup economy', 'draft'),
  summary(45, 'What the readers asked for', 'draft', { createdVia: 'agent' }),
  ...SENT.map(([n, subject], i) =>
    summary(n, subject, 'sent', {
      sentAt: iso(-(8 - i) * 7 * DAY),
      latestBroadcastId: `br_${hex(200 + n)}`,
      preheader: 'From the archive',
    }),
  ),
  summary(46, 'What the river taught us about deadlines', 'sending', {
    latestBroadcastId: `br_${hex(300)}`,
  }),
];

const content = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'On a lot of small sites now, a reader meets three popups before reading a single sentence.',
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'What a popup costs' }],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Every interruption spends a small amount of the reader’s attention.',
        },
      ],
    },
    { type: 'gate' },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'For paid subscribers, the harder part.' }],
    },
  ],
};

const html =
  '<!doctype html><body style="font-family:Georgia,serif;max-width:560px;margin:24px auto;padding:0 20px;line-height:1.6"><p>On a lot of small sites now, a reader meets three popups before reading a single sentence.</p><h2>What a popup costs</h2><p>Every interruption spends a small amount of the reader’s attention.</p></body>';

const SENDER = { name: 'Mara at Field Notes', address: 'mara@mail.fieldnotes.example' };
const RECIPIENTS = 12731;

/** A sent post's numbers, worked out from its open and click rates so they add up. */
const stats = (open: number, click: number) => {
  const sent = RECIPIENTS;
  const bounced = 114;
  const complained = 3;
  const delivered = sent - bounced;
  const humanOpens = Math.round((open / 100) * delivered);
  const machineOpens = Math.round(delivered * 0.098);
  const humanClicks = Math.round((click / 100) * delivered);
  const scanners = Math.round(humanClicks * 0.11);
  // Some people click more than one link, so the people per link add up to more than humanClicks.
  const links = [
    ['https://fieldnotes.example/p/the-slow-web', null, 0.52],
    ['https://fieldnotes.example/archive', null, 0.27],
    ['https://go.fieldnotes.example/k3', 'https://www.w3.org/WAI/standards-guidelines/', 0.21],
    ['https://fieldnotes.example/refer', null, 0.14],
  ] as const;
  return {
    sent,
    delivered,
    bounced,
    complained,
    failed: 0,
    unsubscribed: 9,
    uniqueOpens: humanOpens + machineOpens,
    humanOpens,
    machineOpens,
    uniqueClicks: humanClicks + scanners,
    humanClicks,
    bounceRate: bounced / sent,
    complaintRate: complained / delivered,
    openRate: humanOpens / delivered,
    clickToOpenRate: humanClicks / humanOpens,
    tracking: { opens: true, clicks: true, untracked: 214 },
    cost: { amountMicros: sent * 100, currency: 'USD' },
    links: links.map(([url, destination, share], i) => {
      const people = Math.round(humanClicks * share);
      const theirClicks = Math.round(people * 1.2);
      return {
        url,
        destination,
        position: i,
        clicks: theirClicks + Math.round(scanners * share),
        humanClicks: theirClicks,
        humanPeople: people,
      };
    }),
  };
};

/** GET /broadcasts/{id} for one of the sent posts, as the API describes it (BroadcastDetail). */
function broadcastFor(id: string) {
  const index = SENT.findIndex(([n]) => id === `br_${hex(200 + n)}`);
  if (index === -1) return null;
  const [n, subject] = SENT[index]!;
  const startedAt = now - (8 - index) * 7 * DAY;
  return {
    id,
    dispatchId: `di_${hex(100 + n)}`,
    channelId: CH,
    status: 'sent',
    subject,
    from: SENDER,
    recipientCount: RECIPIENTS,
    sentCount: RECIPIENTS,
    failedCount: 0,
    failureReason: null,
    createdAt: new Date(startedAt).toISOString(),
    completedAt: new Date(startedAt + 41 * 60_000).toISOString(),
    canceledAt: null,
    bestTime: null,
    splitTest: null,
    cohortSample: null,
  };
}

// One page of the subscribers list. The counts (/members/counts) stand for the whole list.
const PEOPLE = [
  ['Ada', 'Okafor', 'active', ['founding reader']],
  ['Ben', 'Hartley', 'active', []],
  ['Chiara', 'Rossi', 'active', ['paid']],
  ['Dev', 'Patel', 'active', []],
  ['Elin', 'Berg', 'pending', []],
  ['Farah', 'Haddad', 'active', ['paid', 'founding reader']],
  ['Gabriel', 'Moreau', 'active', []],
  ['Hana', 'Sato', 'active', ['referrer']],
  ['Ivan', 'Novak', 'unsubscribed', []],
  ['Jonas', 'Weber', 'active', []],
  ['Kemi', 'Adeyemi', 'active', ['paid']],
  ['Lucía', 'Fernández', 'active', []],
  ['Marek', 'Kowalski', 'bounced', []],
  ['Nora', 'Lindqvist', 'active', ['founding reader']],
  ['Omar', 'Farouk', 'active', []],
  ['Priya', 'Raman', 'active', ['referrer']],
  ['Quinn', 'Murphy', 'pending', []],
  ['Rosa', 'Almeida', 'active', []],
  ['Sam', 'Whitfield', 'active', ['paid']],
  ['Tomás', 'Ruiz', 'active', []],
  ['Uma', 'Iyer', 'active', []],
  ['Viktor', 'Holm', 'active', ['founding reader']],
  ['Wen', 'Zhao', 'active', []],
  ['Yusuf', 'Demir', 'active', ['paid']],
  ['Zoe', 'Campbell', 'active', []],
] as const;
const BANDS = ['very_engaged', 'engaged', 'engaged', 'slipping', 'cold', 'opens_hidden'] as const;

const members = PEOPLE.map(([firstName, lastName, status, tags], i) => {
  const joined = now - (4 + i * 11) * DAY;
  const band = BANDS[i % BANDS.length]!;
  const opened = { very_engaged: 11, engaged: 8, slipping: 4, cold: 0, opens_hidden: 12 }[band];
  return {
    id: `mb_${hex(500 + i)}`,
    channelId: CH,
    email: `${firstName
      .toLowerCase()
      .normalize('NFD')
      .replace(/[^a-z]/g, '')}.${lastName
      .toLowerCase()
      .normalize('NFD')
      .replace(/[^a-z]/g, '')}@example.com`,
    firstName,
    lastName,
    status,
    digest: i % 9 === 4 ? 'weekly' : 'every',
    tags: [...tags],
    createdAt: new Date(joined).toISOString(),
    confirmedAt: status === 'pending' ? null : new Date(joined + 3600_000).toISOString(),
    pausedUntil: null,
    unsubscribedAt: status === 'unsubscribed' ? iso(-6 * DAY) : null,
    emailsOffAt: null,
    engagement:
      status === 'active'
        ? {
            score: band === 'opens_hidden' ? null : Math.round((opened / 12) * 100),
            band,
            sentCount: 12,
            openedCount: band === 'opens_hidden' ? 0 : opened,
            clickedCount: Math.floor(opened / 3),
            lastEngagedAt: opened ? iso(-(i % 7) * DAY) : null,
            computedAt: iso(-3600_000),
          }
        : null,
  };
});

function memberList(path: string) {
  const query = new URLSearchParams(path.split('?')[1] ?? '');
  const status = query.get('status');
  const tag = query.get('tag');
  const q = query.get('q')?.toLowerCase();
  const items = members.filter(
    (m) =>
      (!status || m.status === status) &&
      (!tag || m.tags.includes(tag as never)) &&
      (!q || `${m.email} ${m.firstName} ${m.lastName}`.toLowerCase().includes(q)) &&
      inMockSegment(m.tags, query.get('circle')),
  );
  return { items, nextCursor: null };
}

const memberDetail = (member: (typeof members)[number]) => ({
  ...member,
  source: { utm_source: 'newsletter', referrer: 'https://fieldnotes.example/' },
  consents: [],
  formId: null,
  referredBy: null,
  referralCount: member.tags.includes('referrer' as never) ? 4 : 0,
  unsubscribeReason: null,
  fields: {},
  membership: null,
});

// ---- Subscribers: tags, segments and saved views (?mock=1) -----------------------------------
// The tags and segments the list's filters offer, and the publication's saved views, kept for as
// long as the tab stays open so saving, renaming and deleting a view can be tried. A segment here
// is "everyone with this tag", standing in for a real rule.
const MOCK_SEGMENTS = [
  { id: `cl_${hex(601)}`, name: 'Founding readers', tag: 'founding reader' },
  { id: `cl_${hex(602)}`, name: 'Referrers', tag: 'referrer' },
] as const;

function inMockSegment(tags: readonly string[], circle: string | null): boolean {
  if (!circle) return true;
  const segment = MOCK_SEGMENTS.find((s) => s.id === circle);
  return !!segment && tags.includes(segment.tag);
}

const mockTags = () =>
  [...new Set(members.flatMap((m) => m.tags))].sort().map((name, i) => ({
    id: `tg_${hex(650 + i)}`,
    channelId: CH,
    name,
    memberCount: members.filter((m) => m.tags.includes(name as never)).length,
    createdAt: iso(-40 * DAY),
  }));

const mockSegments = () =>
  MOCK_SEGMENTS.map((s) => {
    const inside = members.filter((m) => m.tags.includes(s.tag as never));
    return {
      id: s.id,
      channelId: CH,
      name: s.name,
      description: null,
      rule: { op: 'and', children: [{ field: 'tag', cmp: 'eq', value: s.tag }] },
      memberCount: inside.length,
      activeCount: inside.filter((m) => m.status === 'active').length,
      status: 'ready',
      evaluatedAt: iso(-3600_000),
      error: null,
      createdAt: iso(-30 * DAY),
      updatedAt: iso(-3600_000),
    };
  });

const savedView = (n: number, name: string, filters: Record<string, unknown>) => ({
  id: `mv_${hex(n)}`,
  channelId: CH,
  name,
  filters,
  createdBy: `op_${hex(9)}`,
  createdAt: iso(-5 * DAY),
  updatedAt: iso(-5 * DAY),
});
const memberViews: any[] = [
  savedView(701, 'Paid readers', { status: 'active', tag: 'paid' }),
  savedView(702, 'Waiting to confirm', { status: 'pending' }),
];
let viewIds = 800;
const byName = (a: any, b: any) => a.name.localeCompare(b.name);
const viewProblem = (status: number, code: string, message: string, path?: string) => [
  status,
  { error: { code, message, requestId: 'mock', details: path ? [{ path, message }] : [] } },
];

function subscriberRoute(method: string, p: string, body: any): [number, unknown] | null {
  if (p === `/api/v1/channels/${CH}/tags` && method === 'GET') return [200, mockTags()];
  if (p === `/api/v1/channels/${CH}/circles` && method === 'GET')
    return [200, { items: mockSegments(), nextCursor: null }];
  const match = /^\/api\/v1\/channels\/(ch_\w+)\/members\/views(?:\/(mv_\w+))?$/.exec(p);
  if (!match) return null;
  const [, channelId, viewId] = match;
  if (channelId !== CH) return method === 'GET' ? [200, []] : null;
  const index = memberViews.findIndex((v) => v.id === viewId);
  const taken = (name: string) =>
    memberViews.some((v) => v.id !== viewId && v.name.toLowerCase() === name.trim().toLowerCase());
  if (!viewId && method === 'GET') return [200, [...memberViews].sort(byName)];
  if (!viewId && method === 'POST') {
    if (taken(body.name))
      return viewProblem(409, 'conflict', 'A view with this name already exists.', 'name') as any;
    const view = { ...savedView(viewIds++, body.name.trim(), body.filters), createdAt: iso(0) };
    memberViews.push(view);
    return [201, view];
  }
  if (index === -1) return viewProblem(404, 'not_found', 'View not found.') as any;
  if (method === 'PATCH') {
    if (body.name && taken(body.name))
      return viewProblem(409, 'conflict', 'A view with this name already exists.', 'name') as any;
    memberViews[index] = {
      ...memberViews[index],
      ...(body.name ? { name: body.name.trim() } : {}),
      ...(body.filters ? { filters: body.filters } : {}),
      updatedAt: iso(0),
    };
    return [200, memberViews[index]];
  }
  if (method === 'DELETE') {
    memberViews.splice(index, 1);
    return [200, null];
  }
  return null;
}
// ---- End of subscribers: tags, segments and saved views ---------------------------------------

// Settings → Developers: kept for as long as the tab stays open, so a created key shows in the list.
let mockIds = 100;
const apiKeys: any[] = [];
const oauthApps: any[] = [];
let shorthop: unknown = null;

const FLOW_ID = `fl_${hex(10)}`;
const FLOW_EMAIL_IDS = [`dp_${hex(301)}`, `dp_${hex(302)}`];
const FLOW_RUNS = { running: 30, waiting: 14, paused: 0, completed: 298, exited: 0, failed: 0 };

const welcomeFlow = {
  id: FLOW_ID,
  channelId: CH,
  name: 'Welcome series',
  description: null,
  status: 'live',
  recipe: null,
  liveVersion: 1,
  triggerType: 'member_joined',
  triggerTypes: ['member_joined'],
  reentry: 'never',
  runs: FLOW_RUNS,
  createdAt: iso(-60 * DAY),
  updatedAt: iso(-3 * DAY),
};

const flowGraph = {
  schema: 1,
  nodes: [
    { id: 'start', type: 'trigger', config: { event: 'member_joined', includeImports: false } },
    { id: 'hello', type: 'send_email', config: { dispatchId: FLOW_EMAIL_IDS[0], audience: 'any' } },
    { id: 'wait', type: 'delay', config: { mode: 'duration', amount: 3, unit: 'days' } },
    { id: 'best', type: 'send_email', config: { dispatchId: FLOW_EMAIL_IDS[1], audience: 'any' } },
  ],
  edges: [
    { from: 'start', to: 'hello', label: 'default' },
    { from: 'hello', to: 'wait', label: 'default' },
    { from: 'wait', to: 'best', label: 'default' },
  ],
};

const flowEmails = [
  ['Welcome to Field Notes', 'hello'],
  ['The best of the archive', 'best'],
].map(([subject, nodeId], i) => ({
  dispatchId: FLOW_EMAIL_IDS[i],
  subject,
  preheader: '',
  nodeIds: [nodeId],
  updatedAt: iso(-3 * DAY),
}));

const flowEmailDispatches = flowEmails.map((email) =>
  summary(0, email.subject!, 'draft', { id: email.dispatchId, kind: 'flow', flowId: FLOW_ID }),
);

const flowDetail = {
  ...welcomeFlow,
  draftGraph: flowGraph,
  draftPending: null,
  issues: [],
  versions: [
    {
      version: 1,
      triggerType: 'member_joined',
      triggerTypes: ['member_joined'],
      publishedBy: null,
      publishedAt: iso(-3 * DAY),
      retiredAt: null,
    },
  ],
  emails: flowEmails,
  webhookSecretSet: false,
};

const flowStats = () => {
  const entered = 342;
  return {
    version: 1,
    triggers: [{ index: 0, config: flowGraph.nodes[0]!.config, runs: entered }],
    nodes: flowGraph.nodes.map((n) => ({
      nodeId: n.id,
      type: n.type,
      entered,
      completed: entered,
      exited: 0,
      failed: 0,
      held: { now: 0, total: 0, expired: 0 },
      email: null,
    })),
    edges: flowGraph.edges.map((e) => ({ ...e, runs: entered, dropOff: 0 })),
  };
};

function flowRoute(method: string, p: string, body: any): [number, unknown] | null {
  const match = /^\/api\/v1\/flows\/(fl_\w+)(\/.*)?$/.exec(p);
  if (!match) return null;
  const [, id, rest] = match;
  if (id !== FLOW_ID)
    return [404, { error: { code: 'not_found', message: 'This automation does not exist.' } }];
  if (!rest && method === 'GET') return [200, flowDetail];
  if (!rest && method === 'PATCH')
    return [200, { ...flowDetail, ...body, updatedAt: new Date().toISOString() }];
  if (rest === '/emails' && method === 'GET') return [200, flowEmails];
  if (rest === '/runs' && method === 'GET') return [200, { items: [], nextCursor: null }];
  if (rest === '/stats' && method === 'GET') return [200, flowStats()];
  return null;
}

function developerRoute(method: string, p: string, body: any): [number, unknown] | null {
  const key = /\/api-keys(?:\/([^/]+))?$/.exec(p);
  if (key) {
    const index = apiKeys.findIndex((k) => k.id === key[1]);
    if (method === 'GET') return [200, apiKeys];
    if (method === 'DELETE') {
      apiKeys[index] = { ...apiKeys[index], status: 'revoked', revokedAt: iso(0) };
      return [200, null];
    }
    if (method === 'PATCH') {
      apiKeys[index] = { ...apiKeys[index], ...body };
      return [200, apiKeys[index]];
    }
    const id = `ak_${hex(mockIds++)}`;
    const created = {
      id,
      workspaceId: WS,
      name: body?.name ?? 'Mock key',
      prefix: 'sk_live_mock',
      scopes: body?.scopes ?? [],
      channelIds: body?.channelIds ?? null,
      ipAllowlist: body?.ipAllowlist ?? null,
      expiresAt: body?.expiresAt ?? null,
      rateCap: body?.rateCap ?? null,
      status: 'active',
      lastUsedAt: null,
      lastUsedIpPrefix: null,
      createdBy: { id: `op_${hex(9)}`, email: 'you@example.com' },
      revokedAt: null,
      createdAt: iso(0),
    };
    apiKeys.unshift(created);
    return [201, { key: created, secret: `sk_live_mock_${hex(mockIds)}` }];
  }
  const app = /\/oauth-apps(?:\/([^/]+))?(\/rotate-secret)?$/.exec(p);
  if (app) {
    const index = oauthApps.findIndex((a) => a.id === app[1]);
    if (method === 'GET') return [200, oauthApps];
    if (app[2]) return [200, { app: oauthApps[index], clientSecret: `sws_mock_${hex(mockIds++)}` }];
    if (method === 'DELETE') {
      oauthApps.splice(index, 1);
      return [200, null];
    }
    if (method === 'PATCH') {
      oauthApps[index] = { ...oauthApps[index], ...body, updatedAt: iso(0) };
      return [200, oauthApps[index]];
    }
    const created = {
      id: `oa_${hex(mockIds++)}`,
      workspaceId: WS,
      name: body?.name ?? 'Mock app',
      clientId: `swc_${hex(mockIds)}`,
      clientType: body?.clientType ?? 'public',
      redirectUris: body?.redirectUris ?? [],
      scopes: body?.scopes ?? [],
      homepageUrl: body?.homepageUrl ?? null,
      createdAt: iso(0),
      updatedAt: iso(0),
    };
    oauthApps.unshift(created);
    const clientSecret = created.clientType === 'confidential' ? `sws_mock_${hex(mockIds)}` : null;
    return [201, { app: created, clientSecret }];
  }
  if (/\/oauth-(?:grants|authorizations)$/.test(p) && method === 'GET') return [200, []];
  if (p.endsWith('/applications/shorthop/links')) {
    const slug = `mock-${String(mockIds++)}`;
    return [200, { url: body?.url, shortUrl: `https://go.example.com/${slug}` }];
  }
  if (p.startsWith('/api/v1/channels/') && p.endsWith('/applications/shorthop')) {
    return [
      200,
      { connected: !!shorthop, slugFormat: shorthop ? (shorthop as any).slugFormat : null },
    ];
  }
  if (p.endsWith('/applications/shorthop')) {
    if (method === 'PUT') {
      shorthop = {
        connected: true,
        baseUrl: new URL(body.baseUrl).origin,
        last4: String(body.apiKey).slice(-4),
        slugFormat: body.slugFormat,
        domain: body.domain ?? null,
        updatedAt: iso(0),
      };
    } else if (method === 'PATCH') {
      shorthop = { ...(shorthop as object), ...body, updatedAt: iso(0) };
    } else if (method === 'DELETE') {
      shorthop = null;
      return [200, null];
    }
    return [
      200,
      shorthop ?? {
        connected: false,
        baseUrl: null,
        last4: null,
        slugFormat: '{post}-{random}',
        domain: null,
        updatedAt: null,
      },
    ];
  }
  return null;
}

// Cookies and code, and Settings → Instance → Code on websites. ?sitecode=blocked (the default:
// saved code that does not run here), custom (runs on the publication's own domain only), allowed,
// or empty picks the state; it sticks for the tab like ?mock.
const SITE_CODE_KEY = 'swarm:mock-sitecode';
let instanceSiteCode: any;
let siteCodeSaved: any;
function siteCodeRoute(method: string, p: string, body: any): [number, unknown] | null {
  if (p === '/api/v1/instance/site-code' || p.startsWith('/api/v1/instance/site-code/')) {
    instanceSiteCode ??= {
      everyWorkspace: false,
      workspaces: [
        {
          id: WS,
          name: 'Field Notes Studio',
          allowed: true,
          ownedByInstanceAdmin: true,
          held: false,
        },
        {
          id: `ws_${hex(8)}`,
          name: 'Side projects',
          allowed: true,
          ownedByInstanceAdmin: false,
          held: false,
        },
        {
          id: `ws_${hex(21)}`,
          name: 'Riverside Gazette',
          allowed: false,
          ownedByInstanceAdmin: false,
          held: false,
        },
      ],
    };
    const one = /\/workspaces\/([^/]+)$/.exec(p);
    if (method === 'PUT' && one) {
      instanceSiteCode.workspaces = instanceSiteCode.workspaces.map((w: any) =>
        w.id === one[1] ? { ...w, allowed: body.allowed } : w,
      );
    } else if (method === 'PUT') {
      instanceSiteCode = { ...instanceSiteCode, everyWorkspace: body.everyWorkspace };
    }
    return [200, instanceSiteCode];
  }
  if (!/^\/api\/v1\/channels\/ch_\w+\/site\/settings$/.test(p)) return null;
  const scenario = sessionStorage.getItem(SITE_CODE_KEY) ?? 'blocked';
  siteCodeSaved ??= {
    consent: {
      enabled: true,
      text: 'We use cookies to understand how this site is used.',
      acceptLabel: 'Accept all',
      rejectLabel: 'Reject all',
      policyUrl: '/cookies',
      position: 'bottom',
    },
    code:
      scenario === 'empty'
        ? []
        : [
            {
              name: 'Google Analytics',
              preset: 'google_analytics',
              category: 'analytics',
              value: 'G-ABC123DEF4',
            },
            {
              name: 'Ads pixel',
              preset: 'custom',
              category: 'necessary',
              value: '<script async src="https://connect.facebook.net/en_US/fbevents.js"></script>',
            },
          ],
  };
  if (method === 'PATCH') siteCodeSaved = { ...siteCodeSaved, ...body };
  return [
    200,
    {
      channelId: p.split('/')[4],
      layout: 'magazine',
      pinned: [],
      about: { type: 'doc', content: [] },
      nav: [],
      seo: {},
      theme: {},
      customCss: '',
      ...siteCodeSaved,
      codeAccess: {
        platformAddress: scenario === 'allowed',
        reason: scenario === 'allowed' ? 'allowed' : 'not_allowed',
        customDomain: scenario === 'custom',
      },
      aiBots: 'unset',
      exposeGated: false,
      prevNextNav: true,
      cacheVersion: 1,
      url:
        scenario === 'custom' ? 'https://news.fieldnotes.example' : 'https://fieldnotes.swarm.page',
      platformUrl: 'https://fieldnotes.swarm.page',
      updatedAt: iso(-DAY),
    },
  ];
}

// Bounce rules (Sending → Bounces), Needs your attention, Blocked addresses and the subscriber's
// Bounces panel. The preview pretends the workspace's stored history has 14 addresses with 2 soft
// bounces in a row, 6 with 3 soft bounces in the last week (delivered in between), 3 with one hard
// bounce under "2 hard bounces", and the two paid-plan subscribers below.
const BOUNCE_POLICY_DEFAULT = { hardBounces: 1, softStreak: 3, softWindow: null, askForPaid: true };
let bouncePolicy: any = { ...BOUNCE_POLICY_DEFAULT, updatedAt: null };
const GMAIL_FULL =
  "smtp; 452-4.2.2 The recipient's inbox is out of storage space. Please direct the recipient to https://support.google.com/mail/?p=OverQuotaTemp";
const NO_USER =
  'smtp; 550 5.1.1 <jonas@oldcompany.example>: Recipient address rejected: User unknown in virtual mailbox table';
let bounceHolds: any[] = [
  {
    id: `bn_${hex(31)}`,
    email: 'priya.raman@example.com',
    memberId: `mb_${hex(41)}`,
    rule: 'soft_streak',
    counted: 3,
    days: null,
    last: {
      kind: 'soft',
      cause: 'mailbox_full',
      code: '4.2.2',
      detail: GMAIL_FULL,
      at: iso(-2 * DAY),
    },
    heldAt: iso(-2 * DAY),
  },
  {
    id: `bn_${hex(32)}`,
    email: 'jonas@oldcompany.example',
    memberId: `mb_${hex(42)}`,
    rule: 'hard',
    counted: 1,
    days: null,
    last: { kind: 'hard', cause: 'no_mailbox', code: '5.1.1', detail: NO_USER, at: iso(-DAY) },
    heldAt: iso(-DAY),
  },
];
function bouncePreview(policy: any) {
  const byRule = {
    hard: 0,
    hard_repeat: 0,
    soft_streak: policy.softStreak === 2 ? 14 : 0,
    soft_window: policy.softWindow && policy.softWindow.count <= 3 ? 6 : 0,
  };
  if (policy.hardBounces === 1 && bouncePolicy.hardBounces === 2) byRule.hard = 3;
  const matched = byRule.hard + byRule.soft_streak + byRule.soft_window;
  const held = policy.askForPaid ? bounceHolds.length : 0;
  return { stopped: matched + (policy.askForPaid ? 0 : bounceHolds.length), held, byRule };
}
const mockSuppressions = () => [
  {
    id: `sp_${hex(51)}`,
    email: 'old.reader@mail.example',
    scope: 'workspace',
    reason: 'soft_bounce',
    detail: 'smtp; 552-5.2.2 The email account that you tried to reach is over quota and inactive.',
    bounce: { rule: 'soft_streak', cause: 'mailbox_full', counted: 3, days: null },
    removable: true,
    createdAt: iso(-3 * DAY),
  },
  {
    id: `sp_${hex(52)}`,
    email: 'typo@gmial.com',
    scope: 'workspace',
    reason: 'hard_bounce',
    detail: 'smtp; 550 5.1.2 Host unknown (Name server: gmial.com: host not found)',
    bounce: { rule: 'hard', cause: 'no_domain', counted: 1, days: null },
    removable: true,
    createdAt: iso(-6 * DAY),
  },
  {
    id: `sp_${hex(53)}`,
    email: 'angry@example.net',
    scope: 'workspace',
    reason: 'complaint',
    detail: 'abuse',
    bounce: null,
    removable: false,
    createdAt: iso(-9 * DAY),
  },
  {
    id: `sp_${hex(54)}`,
    email: 'ask-me-not@example.org',
    scope: 'channel',
    reason: 'manual',
    detail: 'Asked by phone',
    bounce: null,
    removable: true,
    createdAt: iso(-20 * DAY),
  },
];
const MOCK_MEMBERS = [
  { id: `mb_${hex(41)}`, email: 'priya.raman@example.com', firstName: 'Priya', lastName: 'Raman' },
  { id: `mb_${hex(42)}`, email: 'jonas@oldcompany.example', firstName: 'Jonas', lastName: null },
  { id: `mb_${hex(43)}`, email: 'sam@outlook.example', firstName: 'Sam', lastName: 'Okafor' },
];
const mockMember = (m: (typeof MOCK_MEMBERS)[number]) => ({
  ...m,
  channelId: CH,
  status: 'active',
  digest: 'every',
  tags: [],
  createdAt: iso(-200 * DAY),
  confirmedAt: iso(-200 * DAY),
  pausedUntil: null,
  unsubscribedAt: null,
  emailsOffAt: null,
});
function memberBounces(id: string) {
  const hold = bounceHolds.find((h) => h.memberId === id);
  if (hold) {
    return {
      softStreak: hold.rule === 'soft_streak' ? 3 : 0,
      held: { rule: hold.rule, counted: hold.counted, days: hold.days, heldAt: hold.heldAt },
      stopped: null,
      events: [
        hold.last,
        { ...hold.last, at: iso(-9 * DAY) },
        { ...hold.last, at: iso(-16 * DAY) },
      ],
    };
  }
  if (id === `mb_${hex(43)}`) {
    return {
      softStreak: 0,
      held: null,
      stopped: null,
      events: [
        {
          kind: 'blocked',
          cause: 'blocklist',
          code: '5.7.1',
          detail:
            "smtp; 550 5.7.1 Unfortunately, messages from [203.0.113.7] weren't sent. Please contact your Internet service provider since part of their network is on our block list (S3150).",
          at: iso(-DAY),
        },
      ],
    };
  }
  return { softStreak: 0, held: null, stopped: null, events: [] };
}
function bounceRoute(method: string, p: string, body: any): [number, unknown] | null {
  if (/^\/api\/v1\/workspaces\/[^/]+\/bounce-policy$/.test(p)) {
    if (method !== 'PUT') return [200, bouncePolicy];
    const { applyToPast, ...policy } = body;
    const applied = applyToPast ? { ...bouncePreview(policy), remaining: 0 } : null;
    if (applied && !policy.askForPaid) bounceHolds = [];
    bouncePolicy = { ...policy, updatedAt: new Date().toISOString() };
    return [
      200,
      {
        ...bouncePolicy,
        applied: applied && { stopped: applied.stopped, held: applied.held, remaining: 0 },
      },
    ];
  }
  if (/^\/api\/v1\/workspaces\/[^/]+\/bounce-policy\/preview$/.test(p))
    return [200, bouncePreview(body)];
  if (/^\/api\/v1\/channels\/ch_\w+\/bounce-holds$/.test(p)) return [200, bounceHolds];
  const hold = p.match(/^\/api\/v1\/channels\/ch_\w+\/bounce-holds\/(bn_\w+)$/);
  if (hold && method === 'POST') {
    bounceHolds = bounceHolds.filter((h) => h.id !== hold[1]);
    return [200, null];
  }
  if (/^\/api\/v1\/channels\/ch_\w+\/suppressions$/.test(p) && method === 'GET') {
    return [200, mockSuppressions()];
  }
  const bounces = p.match(/^\/api\/v1\/members\/(mb_\w+)\/bounces$/);
  if (bounces) return [200, memberBounces(bounces[1]!)];
  if (/^\/api\/v1\/channels\/ch_\w+\/members$/.test(p) && method === 'GET') {
    return [200, { items: MOCK_MEMBERS.map(mockMember), nextCursor: null }];
  }
  const member = p.match(/^\/api\/v1\/members\/(mb_\w+)$/);
  const known = member && MOCK_MEMBERS.find((m) => m.id === member[1]);
  if (known && method === 'GET') {
    return [
      200,
      {
        ...mockMember(known),
        source: {},
        consents: [],
        formId: null,
        referredBy: null,
        referralCount: 0,
        unsubscribeReason: null,
        fields: {},
        membership: null,
        engagement: null,
      },
    ];
  }
  return null;
}

// ---- Settings pages as bands (UI audit #16 to #19) ------------------------------------------
// Sending & delivery, Referrals and the website's General, Branding, SEO and Domains tabs keep what
// is added or saved for as long as the tab is open, so the inline add forms, "Saved · Undo" and the
// Unsaved changes bar can be tried. The second warm-up has one day of data: the sentence-and-meter
// state instead of a chart. The automation recipes back the re-engagement link on Inactive readers.
const RAMP_NEW = {
  id: `rr_${hex(41)}`,
  sendingDomainId: `sd_${hex(42)}`,
  domain: 'news.fieldnotes.example',
  status: 'warming',
  day: iso(0).slice(0, 10),
  capToday: 40000,
  sentToday: 0,
  startCap: 40000,
  growth: 1.5,
  maxCap: 400000,
  bounceThreshold: 0.05,
  complaintThreshold: 0.003,
  pausedReason: null,
  days: [],
};
const settingsPages = {
  serial: 50,
  /** Set while the block reads the canned answers below it, so route() answers them itself. */
  reading: false,
  channel: { sunsetDays: null as number | null },
  senders: [] as any[],
  domains: [] as any[],
  suppressions: [] as any[],
  milestones: [] as any[],
  rewards: [] as any[],
  champions: null as any,
  web: {
    domains: [] as any[],
    hostnames: [] as any[],
    cnameTarget: 'sites.swarm.example',
    available: true,
  },
  site: {
    channelId: CH,
    layout: 'magazine',
    pinned: [],
    about: { type: 'doc', content: [] },
    nav: [],
    seo: { ogMediaId: null, verification: {}, sameAs: [] },
    theme: { colorScheme: 'auto' },
    customCss: '',
    consent: { mode: 'off' },
    code: [],
    aiBots: 'allow',
    exposeGated: false,
    prevNextNav: true,
    cacheVersion: 1,
    url: 'https://fieldnotes.swarm.example',
    platformUrl: 'https://fieldnotes.swarm.example',
    updatedAt: iso(-3 * DAY),
  } as any,
};
const nextId = (prefix: string) => `${prefix}_${hex(++settingsPages.serial)}`;
/** The canned GET answer for `path`, as route() gives it without this block. */
function canned(path: string): any {
  settingsPages.reading = true;
  try {
    return route('GET', path, null)[1];
  } finally {
    settingsPages.reading = false;
  }
}
const FLOW_RECIPE_LIST = [
  ['welcome', 'Welcome email', 'Greets every confirmed subscriber.', 'confirmed', 2],
  [
    'reengagement',
    'Re-engagement',
    'Checks in with subscribers who have not opened anything for 60 days.',
    'unengaged',
    2,
  ],
  ['win_back', 'Win-back', 'Invites people who cancelled a paid plan back.', 'level_canceled', 2],
].map(([key, name, description, triggerType, emailCount]) => ({
  key,
  name,
  description,
  triggerType,
  emailCount,
}));

/** A list kept in `settingsPages`: GET lists it, POST adds, PATCH changes one, DELETE removes. */
function keptList(
  list: any[],
  method: string,
  id: string | undefined,
  body: any,
  make: (body: any) => any,
): [number, unknown] {
  if (method === 'GET') return [200, list];
  if (method === 'POST') {
    const row = make(body);
    list.push(row);
    return [201, row];
  }
  const index = list.findIndex((row) => row.id === id);
  if (index < 0) return [404, { error: { code: 'not_found', message: 'Not found.' } }];
  if (method === 'DELETE') return [200, list.splice(index, 1)[0]];
  list[index] = { ...list[index], ...body, updatedAt: iso(0) };
  return [200, list[index]];
}

function settingsPagesRoute(method: string, path: string, body: any): [number, unknown] | null {
  const p = path.split('?')[0] ?? '';
  const s = settingsPages;
  let m: RegExpMatchArray | null;
  if ((m = p.match(/^\/api\/v1\/channels\/(ch_\w+)$/))) {
    if (method === 'PATCH' && 'sunsetDays' in body) s.channel.sunsetDays = body.sunsetDays;
    return [200, { ...channel(m[1]!, 'Field Notes', 'fieldnotes'), ...s.channel }];
  }
  if (p.endsWith('/ramps')) {
    const done = canned(p) as any[];
    return [200, [...done, RAMP_NEW]];
  }
  if (!s.senders.length) s.senders.push(...canned('/sender-identities'));
  if (!s.domains.length) s.domains.push(...canned('/sending-domains'));
  if ((m = p.match(/\/sender-identities(?:\/(si_\w+))?$/))) {
    if (method === 'PATCH' && body.isDefault) s.senders.forEach((x) => (x.isDefault = false));
    return keptList(s.senders, method, m[1], body, (b) => {
      const domain = s.domains.find((d) => d.id === b.sendingDomainId);
      return {
        id: nextId('si'),
        channelId: CH,
        sendingDomainId: b.sendingDomainId,
        fromName: b.fromName,
        fromAddress: domain ? `${b.fromLocal}@${domain.domain}` : 'fieldnotes@swarm.example',
        replyTo: b.replyTo,
        isDefault: false,
        createdAt: iso(0),
      };
    });
  }
  if ((m = p.match(/\/sending-domains(?:\/(sd_\w+))?$/)))
    return keptList(s.domains, method, m[1], body, (b) => ({
      id: nextId('sd'),
      channelId: CH,
      domain: b.domain,
      kind: b.kind,
      status: 'pending',
      dkimStatus: 'pending',
      mailFromDomain: null,
      mailFromStatus: 'pending',
      dmarcPolicy: null,
      records: [
        {
          purpose: 'dkim',
          type: 'CNAME',
          name: `swarm._domainkey.${b.domain}`,
          value: 'swarm.dkim.example.net',
        },
        { purpose: 'dmarc', type: 'TXT', name: `_dmarc.${b.domain}`, value: 'v=DMARC1; p=none' },
      ],
      lastCheckedAt: null,
      verifiedAt: null,
      createdAt: iso(0),
    }));
  if ((m = p.match(/\/suppressions(?:\/(su_\w+))?$/))) {
    const email = new URLSearchParams(path.split('?')[1] ?? '').get('email');
    if (method === 'GET' && email) return [200, s.suppressions.filter((x) => x.email === email)];
    return keptList(s.suppressions, method, m[1], body, (b) => ({
      id: nextId('su'),
      email: String(b.email).toLowerCase(),
      reason: 'manual',
      scope: 'channel',
      removable: true,
      createdAt: iso(0),
    }));
  }
  if ((m = p.match(/\/champions\/(milestones|rewards)(?:\/(\w+))?$/))) {
    const list = m[1] === 'milestones' ? s.milestones : s.rewards;
    const answer = keptList(list, method, m[2], body, (b) => ({
      id: nextId(m![1] === 'milestones' ? 'cm' : 'cr'),
      description: null,
      levelId: null,
      compDays: null,
      couponId: null,
      goodsRef: null,
      fulfilFlowId: null,
      rewardId: null,
      ...b,
      status: 'active',
      createdAt: iso(0),
      updatedAt: iso(0),
    }));
    return method === 'GET' ? [200, { items: list }] : answer;
  }
  if (p.endsWith('/champions/settings')) {
    s.champions ??= canned(p);
    if (method === 'PATCH') s.champions = { ...s.champions, ...body, updatedAt: iso(0) };
    return [200, s.champions];
  }
  if (/\/channels\/ch_\w+\/site\/settings$/.test(p)) {
    if (method === 'PATCH') s.site = { ...s.site, ...body, updatedAt: iso(0) };
    return [200, s.site];
  }
  if (p === '/api/v1/flow-recipes') return [200, FLOW_RECIPE_LIST];
  if (/\/channels\/ch_\w+\/domains\/web$/.test(p)) {
    if (method === 'POST') {
      const hostname = String(body.hostname);
      const domain = hostname.replace(/^www\./, '');
      const host = (name: string, role: string) => ({
        id: nextId('hn'),
        channelId: CH,
        hostname: name,
        role,
        status: 'pending',
        isPrimary: false,
        records: [{ type: 'CNAME', name, value: s.web.cnameTarget }],
        detail: null,
        lastCheckedAt: null,
        createdAt: iso(0),
      });
      const web = host(hostname, 'web');
      const apex = body.redirectApex ? host(domain, 'apex_redirect') : null;
      s.web.hostnames.push(web, ...(apex ? [apex] : []));
      const off = { hostname: null, status: 'not_set_up', id: null };
      s.web.domains.push({
        domain,
        web: { hostname, status: 'pending', id: web.id },
        apexRedirect: apex
          ? { hostname: domain, status: 'pending', id: apex.id }
          : { hostname: domain, status: 'not_set_up', id: null },
        email: off,
        link: off,
      });
    }
    return [200, s.web];
  }
  return null;
}

// ---- Posts list (UI audit #12, #13, #20) ------------------------------------------------------
// The posts list as the API answers it: search by subject (?q=), the status chips (?status=) and
// their counts (/dispatches/counts), Started by (?startedBy=), the author, the latest send's open
// and click rates (?stats=latest, the same rates as the send reports above), and archive and
// restore. The post_archive flag is on so the Archived chip and Undo can be tried; what you
// archive stays archived for as long as the tab stays open. One sent post starts in the archive.
const POSTS_LIST_FLAGS = { post_archive: true };

const POST_AUTHORS = [
  { id: `op_${hex(9)}`, name: 'Mara Lind', email: 'mara@fieldnotes.example' },
  { id: `op_${hex(10)}`, name: 'Jonas Berg', email: 'jonas@fieldnotes.example' },
] as const;

const postArchive = new Map<string, string>([[`di_${hex(100 + 35)}`, iso(-30 * DAY)]]);

const sentRates = (id: unknown) => SENT.find(([n]) => id === `di_${hex(100 + n)}`);

/** A post as the posts list sees it (DispatchListItem), with or without its latest send. */
function postListItem(d: (typeof dispatches)[number], stats: boolean) {
  const n = Number(String(d.id).slice(3));
  const item: Record<string, unknown> = {
    archivedAt: postArchive.get(d.id as string) ?? null,
    plannedDate: null,
    importedAt: null,
    bestTime: false,
    ...d,
    author: d.createdVia ? null : POST_AUTHORS[n % 2],
  };
  if (stats) {
    const sent = sentRates(d.id);
    const delivered = RECIPIENTS - 114;
    item.latestSend = sent
      ? {
          broadcastId: d.latestBroadcastId,
          delivered,
          humanOpens: Math.round((sent[2] / 100) * delivered),
          humanClicks: Math.round((sent[3] / 100) * delivered),
          openRate: sent[2] / 100,
          clickRate: sent[3] / 100,
        }
      : null;
  }
  return item;
}

const postStatusIs: Record<string, (d: (typeof dispatches)[number]) => boolean> = {
  draft: (d) => d.status === 'draft',
  scheduled: (d) => d.status === 'scheduled',
  sent: (d) => ['sending', 'sent', 'canceled'].includes(d.status as string),
};

function postsMatching(query: URLSearchParams) {
  const q = query.get('q')?.trim().toLowerCase();
  const by = query.get('startedBy');
  return dispatches.filter(
    (d) =>
      (!q || String(d.subject).toLowerCase().includes(q)) &&
      (!by || (by === 'people' ? d.createdVia === null : d.createdVia !== null)),
  );
}

function postsListRoute(method: string, path: string, body: any): [number, unknown] | null {
  const p = path.split('?')[0] ?? '';
  const query = new URLSearchParams(path.split('?')[1] ?? '');
  if (/^\/api\/v1\/channels\/ch_\w+\/dispatches\/counts$/.test(p)) {
    const shown = postsMatching(query).filter((d) => !postArchive.has(d.id as string));
    return [
      200,
      {
        all: shown.length,
        draft: shown.filter(postStatusIs.draft!).length,
        scheduled: shown.filter(postStatusIs.scheduled!).length,
        sent: shown.filter(postStatusIs.sent!).length,
        archived: postsMatching(query).filter((d) => postArchive.has(d.id as string)).length,
      },
    ];
  }
  const filing = p.match(/^\/api\/v1\/channels\/ch_\w+\/dispatches\/(archive|restore)$/);
  if (filing && method === 'POST') {
    const changed: string[] = [];
    const refused: { id: string; message: string }[] = [];
    for (const id of (body?.dispatchIds ?? []) as string[]) {
      const post = dispatches.find((d) => d.id === id);
      if (!post) continue;
      if (filing[1] === 'restore') {
        if (postArchive.delete(id)) changed.push(id);
      } else if (['sent', 'canceled'].includes(post.status as string)) {
        if (!postArchive.has(id)) postArchive.set(id, iso(0));
        changed.push(id);
      } else {
        refused.push({ id, message: 'It hasn’t been sent. You can delete a draft instead.' });
      }
    }
    return [200, { changed, refused }];
  }
  if (/^\/api\/v1\/channels\/ch_\w+\/dispatches$/.test(p) && method === 'GET') {
    const archived = query.get('archived');
    const status = query.get('status');
    const items = postsMatching(query).filter(
      (d) =>
        (archived === 'only'
          ? postArchive.has(d.id as string)
          : archived !== 'exclude' || !postArchive.has(d.id as string)) &&
        (!status || postStatusIs[status]?.(d)),
    );
    return [200, items.map((d) => postListItem(d, query.get('stats') === 'latest'))];
  }
  return null;
}
// ---- End of the posts list ---------------------------------------------------------------------

// ---- Media library (?mock=1) --------------------------------------------------------------------
// The publication's media in memory: one uploaded font to start with, so Style's font menu and the
// media library show "Your fonts". Its file is one of the repository's own (JetBrains Mono, OFL),
// served at /media/mock/ by the dev server (vite.config.ts) as a real upload is at /media/<key>.
// Uploads here are kept as blob: addresses for the session, sniffed by name, not by bytes.
const MOCK_FONT_FILE = 'jetbrains-mono-latin-wght-normal.woff2';
const MOCK_FONT_ID = `md_${hex(700)}`;

const mediaAsset = (fields: Record<string, unknown>) => ({
  channelId: CH,
  width: null,
  height: null,
  altText: null,
  focalPoint: null,
  createdAt: iso(Date.now() - now),
  ...fields,
});

let mediaKept: any[] | null = null;
const mediaStore = () =>
  (mediaKept ??= [
    mediaAsset({
      id: MOCK_FONT_ID,
      contentType: 'font/woff2',
      kind: 'font',
      bytes: 40_404,
      altText: 'JetBrains Mono',
      url: `${location.origin}/media/mock/${MOCK_FONT_FILE}`,
      createdAt: iso(-6 * DAY),
    }),
  ]);

const mockError = (status: number, code: string, message: string): [number, unknown] => [
  status,
  { error: { code, message, details: [] } },
];

/** What the media upload would answer for a file, judged by its name here. */
function mockUpload(file: File, alt: unknown): [number, unknown] {
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
  const types: Record<string, [string, string]> = {
    woff2: ['font/woff2', 'font'],
    woff: ['font/woff', 'font'],
    png: ['image/png', 'image'],
    jpg: ['image/jpeg', 'image'],
    jpeg: ['image/jpeg', 'image'],
    gif: ['image/gif', 'image'],
    webp: ['image/webp', 'image'],
    pdf: ['application/pdf', 'file'],
  };
  const type = types[ext];
  if (!type)
    return mockError(
      415,
      'unsupported_media_type',
      'Upload a JPEG, PNG, GIF, WebP, AVIF or PDF file, or a WOFF2 or WOFF font.',
    );
  if (type[1] === 'font' && file.size > 2 * 1024 * 1024)
    return mockError(400, 'invalid_input', 'Fonts can be up to 2 MB.');
  const asset = mediaAsset({
    id: `md_${crypto.randomUUID().replace(/-/g, '')}`,
    contentType: type[0],
    kind: type[1],
    bytes: Math.max(1, file.size),
    altText: typeof alt === 'string' && alt.trim() ? alt.trim() : null,
    url: URL.createObjectURL(file),
  });
  mediaStore().unshift(asset);
  return [201, asset];
}

function mediaRoute(method: string, path: string, body: any): [number, unknown] | null {
  const p = path.split('?')[0] ?? '';
  const query = new URLSearchParams(path.split('?')[1] ?? '');
  if (/^\/api\/v1\/channels\/ch_\w+\/media$/.test(p)) {
    if (method === 'POST') {
      const file = body instanceof FormData ? body.get('file') : null;
      if (!(file instanceof File)) return mockError(400, 'invalid_input', 'Attach a file.');
      return mockUpload(file, body.get('alt'));
    }
    const kind = query.get('kind');
    const q = query.get('q')?.trim().toLowerCase();
    return [
      200,
      mediaStore().filter(
        (m) =>
          (!kind || m.kind === kind) &&
          (!q ||
            String(m.altText ?? '')
              .toLowerCase()
              .includes(q)),
      ),
    ];
  }
  const one = /^\/api\/v1\/media\/(md_\w+)$/.exec(p);
  if (!one) return null;
  const asset = mediaStore().find((m) => m.id === one[1]);
  if (!asset) return mockError(404, 'not_found', 'Media not found.');
  if (method === 'PATCH') {
    if (body?.altText !== undefined) asset.altText = body.altText || null;
    if (body?.focalPoint !== undefined) asset.focalPoint = body.focalPoint;
    return [200, asset];
  }
  if (method === 'DELETE') {
    mediaKept = mediaStore().filter((m) => m.id !== asset.id);
    return [204, null];
  }
  return null;
}

/** The design's uploaded fonts as the site finds them: at their /media/ path. */
const mockFontLookup: SiteThemes.FontLookup = (id) => {
  const asset = mediaStore().find((m) => m.id === id && m.kind === 'font');
  return asset ? { url: new URL(asset.url).pathname, family: asset.altText } : null;
};
// ---- End of the media library ------------------------------------------------------------------

// ---- Website design: themes, the draft, preview and publish (?mock=1) ------------------------
// The whole /site/design API in memory, so the design studio can be tried end to end: the draft
// saves and answers with its problems (from @swarm/site-themes, as the server's would), publish
// keeps versions, restore puts one back, export and import move a theme as one file. The preview
// is drawn here with renderDesign and designCss inside a small site-like page, as a blob: address
// on this origin. The built-in themes come from BUILT_IN_THEMES once they exist; until then
// small fixture themes stand in, drawing the shared sections of docs/site-themes.md. Each
// {% if %} and {% for %} in them ends on the same kind of tag it starts after: the engine's HTML
// check compares the last tag's name across a block, even between tags (see the report on
// HtmlTracker.snapshot()).
// A scheduled publish is kept here too, with its snapshot, and "publishes" when its time comes while
// the page is open (a timer, and a check on every request), so the whole flow can be seen.
// Section analytics are made up here: each section reaches fewer views the lower it sits, sections
// with a signup form convert at about 3%, and the hero starts with an A/B test 12 days old whose
// variant B converts better, so the results card has something to say.
const SITE_DESIGN_FLAGS = { site_templates: true };

// The theme engine loads with the first design request, so it never weighs on the app's own bundle.
let engine: typeof SiteThemes | null = null;
let builtIns: typeof SiteThemesBuiltIn | null = null;
async function loadDesignEngine() {
  [engine, builtIns] = await Promise.all([
    import('@swarm/site-themes'),
    import('@swarm/site-themes/themes'),
  ]);
}

const fixtureSections: Record<string, string> = {
  hero: `<section class="t-wrap hero hero--{{ section.settings.layout }}">
  <div class="hero-text">
    {% if section.settings.show_logo and site.logo %}<div class="hero-logo">{{ site.logo | image: '72px' }}</div>{% endif %}
    <h1>{{ section.settings.heading | default: site.name }}</h1>
    <div class="pitch">{{ section.settings.pitch | default: site.description }}</div>
    {% if section.settings.promise %}<div class="promise">{{ section.settings.promise }}</div>{% endif %}
    {% if reader.is_subscriber %}<div class="promise">You’re subscribed. Thank you for reading.</div>{% else %}{% subscribe_form %}{% if section.settings.privacy_note %}<div class="note">{{ section.settings.privacy_note }}</div>{% endif %}{% endif %}
    {% if section.settings.show_count and site.subscriber_count %}<div class="proof">Read by {{ site.subscriber_count | number }} people</div>{% endif %}
  </div>
  {% if section.settings.image %}<div class="hero-image">{{ section.settings.image | image: '(min-width: 960px) 40vw, 100vw' }}</div>{% endif %}
</section>

{% schema %}
{
  "name": "Hero",
  "description": "The first screen: the promise and the signup form.",
  "limit": 1,
  "settings": [
    { "id": "heading", "type": "text", "label": "Heading", "max": 120, "info": "Leave it empty to use the publication’s name." },
    { "id": "pitch", "type": "textarea", "label": "The line under it", "max": 400, "info": "Leave it empty to use the description." },
    { "id": "promise", "type": "text", "label": "Promise", "max": 80, "default": "Every Sunday. Free." },
    { "id": "layout", "type": "select", "label": "Layout", "options": ["centred", "split"], "default": "centred" },
    { "id": "image", "type": "image", "label": "Image", "visible_if": "layout:split" },
    { "id": "show_count", "type": "checkbox", "label": "Show how many people read it", "default": true },
    { "id": "show_logo", "type": "checkbox", "label": "Show the logo" },
    { "id": "privacy_note", "type": "text", "label": "Under the form", "max": 120, "default": "No spam. Unsubscribe in one click." }
  ]
}
{% endschema %}
`,
  benefits: `<section class="t-wrap benefits">
  <h2>{{ section.settings.heading }}</h2>
  <div class="t-grid">
    {% for item in section.settings.items %}<div class="t-card"><h3>{{ item.title }}</h3><div class="t-text">{{ item.text }}</div></div>{% endfor %}
  </div>
</section>

{% schema %}
{
  "name": "Benefits",
  "description": "What subscribers get, as a short list.",
  "settings": [
    { "id": "heading", "type": "text", "label": "Heading", "default": "What you get" },
    { "id": "items", "type": "list", "label": "Benefits", "max": 6, "fields": [
      { "id": "title", "type": "text", "label": "Title", "max": 60 },
      { "id": "text", "type": "textarea", "label": "Text", "max": 240 }
    ], "default": [
      { "title": "One letter a week", "text": "The week’s best field notes, in ten minutes." },
      { "title": "The full archive", "text": "Every issue since the first, searchable." },
      { "title": "Replies read", "text": "Write back; every reply is read." }
    ] }
  ]
}
{% endschema %}
`,
  latest: `<section class="t-wrap latest latest--{{ section.settings.style }}">
  <h2>{{ section.settings.heading }}</h2>
  <div class="latest-list">
    {% for post in posts limit: section.settings.count %}<div class="latest-item"><a href="{{ post.url }}">{{ post.title }}</a><div class="date">{{ post.date | date: 'long' }} · {{ post.reading_minutes }} min</div>{% if section.settings.show_excerpt %}<div class="excerpt">{{ post.excerpt }}</div>{% endif %}</div>{% else %}<div class="latest-item">The first issue is on its way.</div>{% endfor %}
  </div>
  <p class="more"><a href="{{ site.archive_url }}">All {{ site.issue_count | plural: 'issue', 'issues' }}</a></p>
</section>

{% schema %}
{
  "name": "Latest issues",
  "description": "The newest issues, as cards or a list.",
  "settings": [
    { "id": "heading", "type": "text", "label": "Heading", "default": "Latest issues" },
    { "id": "count", "type": "range", "label": "How many", "min": 1, "max": 12, "default": 3 },
    { "id": "style", "type": "select", "label": "Style", "options": ["cards", "list", "compact"], "default": "cards" },
    { "id": "show_images", "type": "checkbox", "label": "Show images", "default": true },
    { "id": "show_excerpt", "type": "checkbox", "label": "Show a summary", "default": true }
  ]
}
{% endschema %}
`,
  featured: `<section class="t-wrap featured">
  <h2>{{ section.settings.heading }}</h2>
  <div class="featured-body">
    {% if featured %}<div class="t-card"><h3>{{ featured.title }}</h3><a class="sw-button" href="{{ featured.url }}">{{ section.settings.button_label | default: 'Read a sample' }}</a><div class="t-text">{{ featured.excerpt }}</div></div>{% endif %}
  </div>
</section>

{% schema %}
{
  "name": "Featured issue",
  "description": "One issue up close: the pinned one, else the latest.",
  "settings": [
    { "id": "heading", "type": "text", "label": "Heading", "default": "Start here" },
    { "id": "button_label", "type": "text", "label": "Button", "max": 40, "default": "Read a sample" }
  ]
}
{% endschema %}
`,
  testimonials: `<section class="t-wrap testimonials">
  <h2>{{ section.settings.heading }}</h2>
  <div class="t-grid">
    {% for item in section.settings.items %}<figure class="t-card"><blockquote>{{ item.quote }}</blockquote><div class="who">{% if item.photo %}<div class="who-photo">{{ item.photo | image: '48px' }}</div>{% endif %}<div class="who-name">{{ item.name }}</div><div class="who-role">{{ item.role }}</div></div></figure>{% else %}<div class="t-card">Add what readers say in the section’s settings.</div>{% endfor %}
  </div>
</section>

{% schema %}
{
  "name": "Testimonials",
  "description": "What readers say.",
  "settings": [
    { "id": "heading", "type": "text", "label": "Heading", "default": "What readers say" },
    { "id": "items", "type": "list", "label": "Quotes", "max": 9, "fields": [
      { "id": "quote", "type": "textarea", "label": "Quote", "max": 400 },
      { "id": "name", "type": "text", "label": "Name", "max": 60 },
      { "id": "role", "type": "text", "label": "Role", "max": 80 },
      { "id": "photo", "type": "image", "label": "Photo" }
    ] }
  ]
}
{% endschema %}
`,
  author: `<section class="t-wrap author">
  <h2>{{ section.settings.heading }}</h2>
  <div class="author-body">
    {% if section.settings.photo %}<div class="author-photo">{{ section.settings.photo | image: '96px' }}</div>{% endif %}
    <div class="author-text"><h3>{{ section.settings.name }}</h3><div class="t-text">{{ section.settings.bio | paragraphs }}</div><a href="{{ section.settings.link_url | default: site.about_url }}">{{ section.settings.link_label | default: 'More about me' }}</a></div>
  </div>
</section>

{% schema %}
{
  "name": "Author",
  "description": "Who writes it.",
  "settings": [
    { "id": "heading", "type": "text", "label": "Heading", "default": "Who writes it" },
    { "id": "name", "type": "text", "label": "Name", "default": "Mara Lind" },
    { "id": "bio", "type": "textarea", "label": "About", "default": "Mara walks the same hill every week and writes down what changed." },
    { "id": "photo", "type": "image", "label": "Photo" },
    { "id": "link_label", "type": "text", "label": "Link text" },
    { "id": "link_url", "type": "url", "label": "Link address" }
  ]
}
{% endschema %}
`,
  faq: `<section class="t-wrap faq">
  <h2>{{ section.settings.heading }}</h2>
  <div class="faq-list">
    {% for item in section.settings.items %}<details class="faq-item"><summary>{{ item.question }}</summary><div class="t-text">{{ item.answer | paragraphs }}</div></details>{% endfor %}
  </div>
</section>

{% schema %}
{
  "name": "Questions",
  "description": "Questions before signing up, with their answers.",
  "settings": [
    { "id": "heading", "type": "text", "label": "Heading", "default": "Questions" },
    { "id": "items", "type": "list", "label": "Questions", "fields": [
      { "id": "question", "type": "text", "label": "Question", "max": 160 },
      { "id": "answer", "type": "textarea", "label": "Answer", "max": 800 }
    ], "default": [
      { "question": "How often does it come?", "answer": "Every Sunday morning." },
      { "question": "Is it free?", "answer": "Yes. Paid subscribers get the long reads too." }
    ] }
  ]
}
{% endschema %}
`,
  numbers: `<section class="t-wrap numbers">
  <h2>{{ section.settings.heading }}</h2>
  <div class="t-grid">
    {% for item in section.settings.items %}<div class="t-card"><div class="num">{{ item.value }}</div><div class="num-label">{{ item.label }}</div></div>{% endfor %}
  </div>
</section>

{% schema %}
{
  "name": "Numbers",
  "description": "A few figures: issues, readers, years.",
  "settings": [
    { "id": "heading", "type": "text", "label": "Heading", "default": "In numbers" },
    { "id": "items", "type": "list", "label": "Figures", "max": 4, "fields": [
      { "id": "value", "type": "text", "label": "Figure", "max": 20 },
      { "id": "label", "type": "text", "label": "What it counts", "max": 60 }
    ], "default": [
      { "value": "42", "label": "issues" },
      { "value": "12,731", "label": "readers" },
      { "value": "3", "label": "years" }
    ] }
  ]
}
{% endschema %}
`,
  text: `<section class="t-wrap text text--{{ section.settings.align }}">
  <h2>{{ section.settings.heading }}</h2>
  <div class="t-text">{{ section.settings.body | paragraphs }}</div>
</section>

{% schema %}
{
  "name": "Text",
  "description": "A heading and paragraphs.",
  "settings": [
    { "id": "heading", "type": "text", "label": "Heading", "default": "About" },
    { "id": "body", "type": "textarea", "label": "Text", "default": "Write a few lines about the publication." },
    { "id": "align", "type": "select", "label": "Align", "options": [{ "value": "left", "label": "Left" }, { "value": "centre", "label": "Centre" }], "default": "left" }
  ]
}
{% endschema %}
`,
  subscribe_band: `<section class="t-wrap band">
  <h2>{{ section.settings.heading | default: 'Get the next issue' }}</h2>
  <div class="t-text">{{ section.settings.text }}</div>
  {% unless reader.is_subscriber %}{% subscribe_form %}{% endunless %}
</section>

{% schema %}
{
  "name": "Subscribe band",
  "description": "A second chance to subscribe, at the end.",
  "limit": 1,
  "settings": [
    { "id": "heading", "type": "text", "label": "Heading", "default": "Get the next issue" },
    { "id": "text", "type": "textarea", "label": "Text", "default": "One email a week. Leave whenever you like." }
  ]
}
{% endschema %}
`,
};

const FIXTURE_CSS = `.t-page { padding-bottom: 48px; }
.t-wrap { max-width: var(--wrap); margin: 0 auto; padding: 56px 24px; }
.t-section + .t-section .t-wrap { border-top: 1px solid var(--line); }
h1, h2, h3 { color: var(--ink); line-height: 1.15; margin: 0 0 14px; }
h1 { font-size: var(--step-5); letter-spacing: -0.02em; }
h2 { font-size: var(--step-3); letter-spacing: -0.01em; }
h3 { font-size: var(--step-1); }
p { margin: 0 0 12px; }
a { color: var(--accent); }
.t-text p { margin: 0 0 10px; }
.t-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.t-card { margin: 0; padding: 20px; border: 1px solid var(--line); border-radius: var(--r-card); background: var(--surface); }
.hero { text-align: center; padding-top: 80px; padding-bottom: 80px; }
.hero .pitch { font-size: var(--step-1); color: var(--text-sub); max-width: 42ch; margin: 0 auto 18px; }
.hero--split { display: grid; gap: 48px; grid-template-columns: 1.2fr 1fr; text-align: left; align-items: center; }
.hero--split .pitch { margin-left: 0; }
.hero-image img { border-radius: var(--r-card); }
.promise, .proof, .note { color: var(--text-sub); font-size: var(--step-m1); margin: 6px 0; }
.hero .sw-subscribe, .band .sw-subscribe { justify-content: center; }
.hero--split .sw-subscribe { justify-content: flex-start; }
.latest-list { display: grid; gap: 18px; margin-bottom: 18px; }
.latest--cards .latest-list { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.latest--cards .latest-item { border: 1px solid var(--line); border-radius: var(--r-card); padding: 18px; }
.latest--compact .latest-list { gap: 8px; }
.latest--compact .excerpt { display: none; }
.latest-item a { color: var(--ink); font-weight: 650; font-size: var(--step-1); text-decoration: none; }
.latest-item .date { color: var(--text-sub); font-size: var(--step-m1); }
.latest-item .excerpt { margin-top: 6px; }
.featured .t-card { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
.featured .sw-button { order: 3; }
.testimonials blockquote { margin: 0 0 14px; font-size: var(--step-1); color: var(--ink); }
.who { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; color: var(--text-sub); font-size: var(--step-m1); }
.who-name { font-weight: 650; color: var(--ink); }
.author-body { display: flex; gap: 24px; align-items: flex-start; }
.author-photo img { border-radius: 999px; }
.faq-item { border-bottom: 1px solid var(--line); padding: 14px 0; }
.faq-item summary { cursor: pointer; font-weight: 650; color: var(--ink); }
.faq-item .t-text { margin-top: 8px; }
.num { font-size: var(--step-4); font-weight: 750; color: var(--ink); line-height: 1.1; }
.num-label { color: var(--text-sub); }
.text--centre { text-align: center; }
.band { text-align: center; background: var(--t-accent-soft); border-radius: var(--r-card); margin-top: 32px; margin-bottom: 32px; }
.t-section + .t-section .band { border-top: 0; }
@media (max-width: 719px) {
  .hero--split { grid-template-columns: 1fr; }
  .t-wrap { padding: 40px 18px; }
  .hero { padding-top: 48px; padding-bottom: 48px; }
}
`;

const FIXTURE_THEMES = [
  {
    id: 'gate',
    name: 'Gate',
    description: 'A full-page signup first, with a link to past issues.',
    tokens: { accent: '#3b4cca', page: '#ffffff', heading_font: 'grotesk', width: 'narrow' },
    sections: [
      { type: 'hero', settings: { show_count: true } },
      { type: 'latest', settings: { style: 'compact', count: 3 } },
    ],
  },
  {
    id: 'letter',
    name: 'Letter',
    description: 'One quiet column and a dated list, for personal writing.',
    tokens: {
      accent: '#9a3412',
      page: '#fbf8f3',
      heading_font: 'serif',
      body_font: 'serif',
      width: 'narrow',
      corners: 'square',
    },
    sections: [
      { type: 'hero' },
      { type: 'latest', settings: { style: 'list', count: 6 } },
      { type: 'author' },
    ],
  },
  {
    id: 'magazine',
    name: 'Magazine',
    description: 'A large lead story and big images, for many posts.',
    tokens: { accent: '#b4235f', heading_font: 'archivo', width: 'wide' },
    sections: [
      { type: 'hero', settings: { layout: 'split' } },
      { type: 'featured' },
      { type: 'latest', settings: { count: 6 } },
      { type: 'testimonials' },
      { type: 'subscribe_band' },
    ],
  },
  {
    id: 'newspaper',
    name: 'Newspaper',
    description: 'A masthead and dense columns, for news and digests.',
    tokens: {
      accent: '#111827',
      page: '#f7f5ef',
      heading_font: 'serif',
      scale: 'compact',
      corners: 'square',
    },
    sections: [
      { type: 'hero' },
      { type: 'latest', settings: { style: 'compact', count: 9 } },
      { type: 'numbers' },
      { type: 'subscribe_band' },
    ],
  },
  {
    id: 'launch',
    name: 'Launch',
    description: 'A sales page with benefits and signup, for paid newsletters.',
    tokens: { accent: '#2f5d50', heading_font: 'grotesk', buttons: 'pill' },
    sections: [
      { type: 'hero' },
      { type: 'benefits' },
      { type: 'latest', settings: { count: 3 } },
      { type: 'testimonials' },
      { type: 'faq' },
      { type: 'subscribe_band' },
    ],
  },
  {
    id: 'night',
    name: 'Night',
    description: 'Dark and cinematic, with the issues on a reel.',
    tokens: {
      accent: '#7c3aed',
      page: '#0b0a0d',
      ink: '#f2eee8',
      scheme: 'dark',
      heading_font: 'archivo',
      width: 'wide',
    },
    sections: [
      { type: 'hero' },
      { type: 'latest', settings: { count: 6 } },
      { type: 'testimonials' },
      { type: 'subscribe_band' },
    ],
  },
  {
    id: 'zine',
    name: 'Zine',
    description: 'Loud spot colours and stickers, for culture and local scenes.',
    tokens: { accent: '#1f4fd1', page: '#f7f2e8', heading_font: 'archivo' },
    sections: [
      { type: 'hero' },
      { type: 'benefits' },
      { type: 'latest', settings: { count: 6 } },
      { type: 'testimonials' },
      { type: 'subscribe_band' },
    ],
  },
  {
    id: 'brief',
    name: 'Brief',
    description: 'A strict grid and a ruled archive, for analysts and researchers.',
    tokens: { accent: '#007f4c', heading_font: 'grotesk', corners: 'square', width: 'wide' },
    sections: [
      { type: 'hero' },
      { type: 'numbers' },
      { type: 'latest', settings: { style: 'compact', count: 8 } },
      { type: 'faq' },
      { type: 'subscribe_band' },
    ],
  },
];
let fixtures: { id: string; name: string; description: string; files: ThemeFiles }[] | null = null;
/** Built on first use, so none of this runs unless the mock API answers a design request. */
const fixtureThemes = () =>
  (fixtures ??= FIXTURE_THEMES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    files: {
      'theme.json': JSON.stringify(
        {
          name: t.name,
          settings: engine!.standardSettings(t.tokens as never),
          sections: t.sections,
        },
        null,
        2,
      ),
      'layout.html': '<div class="t-page">\n  {% sections %}\n</div>\n',
      'theme.css': FIXTURE_CSS,
      ...Object.fromEntries(
        Object.entries(fixtureSections).map(([type, text]) => [`sections/${type}.html`, text]),
      ),
    } as ThemeFiles,
  })));

const designThemes = () => {
  const built = Object.values(builtIns!.BUILT_IN_THEMES);
  return built.length ? built : fixtureThemes();
};

interface MockDesignSchedule {
  at: string;
  by: { name: string };
  createdAt: string;
  status: 'scheduled' | 'failed' | 'cancelled';
  problems: SiteThemes.Problem[];
  design: Design;
  failed: boolean;
  cancelledAt: number | null;
}

let designKept: ReturnType<typeof newDesignStore> | null = null;
function newDesignStore() {
  const live: Design = {
    theme: 'launch',
    files: null,
    settings: { accent: '#2f5d50' },
    sections: null,
  };
  // The theme's sections, the hero with a running A/B test on its heading.
  const defaults = designProblems(live).theme?.defaults;
  if (defaults?.length) {
    live.sections = structuredClone(defaults).map((section) =>
      section.type === 'hero'
        ? {
            ...section,
            experiment: {
              id: 'tmock1',
              status: 'running',
              variantB: { ...section.settings, heading: 'One walk a week, in your inbox' },
              startedAt: iso(-12 * DAY),
            },
          }
        : section,
    );
  }
  const older: Design = {
    theme: 'letter',
    files: null,
    settings: { accent: '#9a3412' },
    sections: null,
  };
  return {
    draft: structuredClone(live),
    published: structuredClone(live) as Design | null,
    draftUpdatedAt: iso(-2 * 3600_000),
    publishedAt: iso(-2 * DAY),
    publishedBy: { id: `op_${hex(9)}`, name: 'Mara Lind', email: 'mara@fieldnotes.example' },
    versions: [
      {
        id: `dv_${hex(902)}`,
        publishedAt: iso(-2 * DAY),
        publishedBy: { name: 'Mara Lind' },
        design: live,
      },
      {
        id: `dv_${hex(901)}`,
        publishedAt: iso(-12 * DAY),
        publishedBy: { name: 'Jonas Berg' },
        design: older,
      },
    ],
    serial: 903,
    previews: [] as string[],
    schedule: null as MockDesignSchedule | null,
    scheduleTimer: 0,
  };
}

function designProblems(design: Design): { theme: CompiledTheme | null; problems: Problem[] } {
  const files = design.files ?? designThemes().find((t) => t.id === design.theme)?.files;
  if (!files) {
    return {
      theme: null,
      problems: [
        {
          file: 'design',
          line: 1,
          column: 1,
          severity: 'error',
          message: `There is no “${design.theme}” template.`,
        },
      ],
    };
  }
  const { theme, problems } = engine!.compileTheme(files);
  return {
    theme,
    problems: theme ? [...problems, ...engine!.checkDesign(theme, design)] : problems,
  };
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The page around a design, as the site draws it: the essentials of the site's base stylesheet
 * (workers/site/src/render/theme.ts, baseCss) and its shell (render/layout.ts, as the theme
 * gallery copies it), so the development preview has the site's widths, gutters, header and
 * footer. The design's own tokens and theme.css follow and win, as they do on the site.
 */
const PREVIEW_SHELL_CSS = `html{--accent:#2f5d50;--on-accent:#ffffff;--page:#fbfbfd;--surface:#ffffff;--surface-alt:#f8f7fc;--ink:#0f0f12;--text:#2b2b33;--text-sub:#6b6b76;--line:#ececf2;--line-strong:#dcdae6;--mark:#efeafe;--font:-apple-system,'Segoe UI',system-ui,'Helvetica Neue',sans-serif;--r-card:18px;--r-control:12px;color-scheme:light}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--page);color:var(--text);font:400 17px/1.6 var(--font);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
img{max-width:100%;height:auto}
h1,h2,h3,h4,h5,h6{color:var(--ink);line-height:1.2;letter-spacing:-0.02em;margin:1.6em 0 .5em}
.sw-wrap{width:100%;max-width:1120px;margin:0 auto;padding:0 22px}
.sw-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.sw-preview-bar{position:sticky;top:0;z-index:50;background:#14203a;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:8px 16px;text-align:center}
.sw-preview-bar span{font-weight:400;opacity:.85}
.sw-header{border-bottom:1px solid var(--line);background:var(--surface)}
.sw-header .sw-wrap{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;min-height:68px;padding-top:10px;padding-bottom:10px}
.sw-brand{display:flex;align-items:center;gap:10px;color:var(--ink);font-weight:700;font-size:19px;letter-spacing:-0.02em;text-decoration:none;margin-right:auto}
.sw-nav{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:15px}
.sw-nav a{color:var(--text-sub);text-decoration:none;padding:6px 0}
.sw-nav a:hover{color:var(--ink)}
input[type=email],input[type=text],input[type=search]{font:inherit;font-size:15px;color:var(--ink);background:var(--surface-alt);border:1px solid var(--line-strong);border-radius:var(--r-control);padding:9px 12px;min-height:42px}
.sw-button,button{display:inline-flex;align-items:center;justify-content:center;font:600 15px/1 var(--font);color:var(--on-accent);background:var(--accent);border:0;border-radius:999px;padding:12px 20px;min-height:42px;cursor:pointer;text-decoration:none}
.sw-main{padding:40px 0 64px}
.sw-subscribe{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:8px 0 12px}
.sw-subscribe input{min-width:0;flex:1 1 220px}
.sw-footer{border-top:1px solid var(--line);padding:28px 0 40px;font-size:14px;color:var(--text-sub)}
.sw-footer nav{display:flex;flex-wrap:wrap;gap:8px 18px;margin-bottom:10px}
.sw-footer a{color:var(--text-sub)}
.sw-footer p{margin:0}`;

/** A made-up but steady number for a section: the same id always gives the same wobble. */
function wobble(id: string): number {
  let h = 7;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 1000;
  return 0.9 + (h / 1000) * 0.2;
}

/** Views a day that reach the section at `index`: fewer further down the page. */
const reachedPerDay = (id: string, index: number) => Math.round(900 * 0.72 ** index * wobble(id));

function designStats(design: Design, days: number) {
  const { theme } = designProblems(design);
  const sections = theme ? engine!.sectionsOf(theme, design).filter((x) => !x.hidden) : [];
  const out: { sectionId: string; variant: 'a' | 'b'; reached: number; signups: number }[] = [];
  const tests: unknown[] = [];
  const rateOf = (type: string, index: number) =>
    theme?.reach.subscribe.has(type) ? (index === 0 ? 0.032 : 0.024) * wobble(type) : 0;
  sections.forEach((section, index) => {
    const perDay = reachedPerDay(section.id, index);
    const rateA = rateOf(section.type, index);
    const rateB = rateA * 1.28;
    const exp = section.experiment;
    // Days of the test that are live: only once published, as on the real site.
    const live = (designKept?.published?.sections ?? []).some(
      (p) => p.id === section.id && p.experiment?.id === exp?.id,
    );
    const testDays = (start: number, end: number) =>
      live ? Math.max(0, Math.floor((end - start) / DAY)) : 0;
    const startedAt = exp ? Date.parse(exp.startedAt) : now;
    const endedAt = exp?.endedAt ? Date.parse(exp.endedAt) : now;
    const split = exp
      ? Math.min(days, testDays(Math.max(startedAt, now - days * DAY), endedAt))
      : 0;
    const reachedA = perDay * (days - split) + Math.round((perDay * split) / 2);
    const reachedB = Math.round((perDay * split) / 2);
    out.push({
      sectionId: section.id,
      variant: 'a',
      reached: reachedA,
      signups: Math.round(reachedA * rateA),
    });
    if (reachedB > 0)
      out.push({
        sectionId: section.id,
        variant: 'b',
        reached: reachedB,
        signups: Math.round(reachedB * rateB),
      });
    if (exp) {
      const each = Math.round((perDay * testDays(startedAt, endedAt)) / 2);
      tests.push({
        sectionId: section.id,
        experimentId: exp.id,
        status: exp.status,
        startedAt: exp.startedAt,
        endedAt: exp.endedAt ?? null,
        winner: exp.winner ?? null,
        ...engine!.testResult(
          { reached: each, signups: Math.round(each * rateA) },
          { reached: each, signups: Math.round(each * rateB) },
        ),
      });
    }
  });
  const totals = out.reduce(
    (t, r) => ({ reached: t.reached + r.reached, signups: t.signups + r.signups }),
    { reached: 0, signups: 0 },
  );
  const day = (offset: number) => new Date(now + offset).toISOString().slice(0, 10);
  return { days, from: day(-(days - 1) * DAY), to: day(0), sections: out, totals, tests };
}

function previewHtml(
  design: Design,
  as: string,
  variant?: { variant?: string; section?: string },
): string {
  const { theme } = designProblems(design);
  const site = settingsPages.site;
  const audience =
    as === 'paid' ? 'a paid subscriber' : as === 'subscriber' ? 'a subscriber' : 'a visitor';
  const head = (css: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="${escapeHtml(location.origin)}/"><title>Preview</title><style>${PREVIEW_SHELL_CSS}</style><style id="swarm-design-css">${css}</style>${site.customCss ? `<style>${site.customCss}</style>` : ''}</head>`;
  if (!theme) {
    return `${head('')}<body><div class="sw-preview-bar">Preview</div><main style="padding:48px 24px;font-family:system-ui"><h1>The draft can’t be drawn yet</h1><p>Its theme files have errors. Fix them in Code, and the preview comes back.</p></main></body></html>`;
  }
  const posts = SENT.slice()
    .reverse()
    .map(([n, title], i) => ({
      title,
      url: `/p/issue-${n}`,
      excerpt: 'A short note from this week’s walk, and what readers wrote back.',
      date: iso(-(i + 1) * 7 * DAY),
      reading_minutes: 4 + (n % 5),
      image: null,
      is_paid: n % 4 === 0,
      is_pinned: false,
      author: 'Mara Lind',
    }));
  const reader = { is_subscriber: as !== 'visitor', is_paid: as === 'paid' };
  const variants: Record<string, 'a' | 'b'> = {};
  if (variant?.variant === 'b') {
    for (const section of engine!.runningTests(theme, design)) {
      if (!variant.section || variant.section === section.id) variants[section.id] = 'b';
    }
  }
  let page: { html: string; css: string };
  try {
    page = engine!.renderDesign(
      theme,
      design,
      {
        globals: {
          site: {
            name: 'Field Notes',
            description: 'One hill, walked every Sunday: what changed, and why it matters.',
            url: site.url,
            logo: null,
            subscriber_count: 12731,
            issue_count: 42,
            nav: [
              { label: 'Archive', url: '/archive', current: false },
              { label: 'About', url: '/about', current: false },
            ],
            archive_url: '/archive',
            about_url: '/about',
            plans_url: '/plans',
            has_paid_plans: true,
          },
          posts,
          pinned: [],
          featured: posts[0],
          page: { path: '/' },
        },
        reader,
        image: () => null,
        variants,
      },
      {
        subscribeForm: () =>
          '<form class="sw-subscribe" id="subscribe" aria-label="Subscribe"><label class="sr" for="sw-email" style="position:absolute;left:-9999px">Email</label><input id="sw-email" type="email" placeholder="you@example.com"><button type="submit">Subscribe</button></form>',
        image: (img, sizes) =>
          `<img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.alt)}" sizes="${escapeHtml(sizes)}">`,
      },
    );
  } catch (error) {
    return `${head('')}<body><div class="sw-preview-bar">Preview</div><main style="padding:48px 24px;font-family:system-ui"><h1>The draft didn’t draw</h1><p>${escapeHtml((error as Error).message)}</p></main></body></html>`;
  }
  // The site adds the design's uploaded fonts to its CSS (designCss with a font lookup); so does
  // this, after the page's own rules, whenever the draft uses one.
  const fonts = engine!.fontMediaIds(
    theme.settings,
    engine!.resolveSettings(theme.settings, design.settings),
  );
  const css = fonts.length
    ? `${page.css}\n${engine!.designCss(theme, design, () => null, mockFontLookup)}`
    : page.css;
  const withB = Object.keys(variants).length ? ', with variant B' : '';
  return `${head(css)}<body><div class="sw-preview-bar" role="status">Preview <span>of the draft, as ${audience}${withB}. Not live until you publish.</span></div>
<header class="sw-header"><div class="sw-wrap"><a class="sw-brand" href="/"><span>Field Notes</span></a><nav class="sw-nav" aria-label="Site"><a href="/archive">Archive</a><a href="/about">About</a></nav>${reader.is_subscriber ? '' : '<a class="sw-button" href="#subscribe">Subscribe</a>'}</div></header>
<main id="main" class="sw-main"><div class="sw-wrap">${page.html}</div></main>
<footer class="sw-footer"><div class="sw-wrap"><nav aria-label="Footer"><a href="/archive">Archive</a><a href="/about">About</a></nav><p>© 2026 Field Notes</p></div></footer></body></html>`;
}

/** Publishes the design store's snapshot as the cron would: the same check, a version, or failed. */
function publishDueSchedule(s: ReturnType<typeof newDesignStore>) {
  const due = s.schedule;
  if (!due || due.status !== 'scheduled' || Date.parse(due.at) > Date.now()) return;
  const { problems } = designProblems(due.design);
  if (problems.some((x) => x.severity === 'error')) {
    s.schedule = { ...due, status: 'failed', failed: true, problems };
    return;
  }
  publishMockDesign(s, due.design, due.by);
  s.schedule = null;
}

function publishMockDesign(
  s: ReturnType<typeof newDesignStore>,
  design: Design,
  by: { name: string },
) {
  s.published = structuredClone(design);
  s.publishedAt = new Date().toISOString();
  s.publishedBy = { id: `op_${hex(9)}`, name: by.name, email: 'mara@fieldnotes.example' };
  s.versions.unshift({
    id: `dv_${hex(s.serial++)}`,
    publishedAt: s.publishedAt,
    publishedBy: by,
    design: structuredClone(design),
  });
  s.versions = s.versions.slice(0, 20);
}

const scheduleAnswer = (schedule: MockDesignSchedule | null) =>
  schedule && schedule.status !== 'cancelled'
    ? {
        at: schedule.at,
        by: schedule.by,
        createdAt: schedule.createdAt,
        status: schedule.status,
        problems: schedule.problems,
      }
    : null;

/** Publish the snapshot when its time comes, while the page is open. */
function armSchedule(s: ReturnType<typeof newDesignStore>) {
  window.clearTimeout(s.scheduleTimer);
  if (s.schedule?.status !== 'scheduled') return;
  const wait = Math.min(Math.max(Date.parse(s.schedule.at) - Date.now(), 0), 2 ** 31 - 1);
  s.scheduleTimer = window.setTimeout(() => publishDueSchedule(s), wait);
}

function siteDesignRoute(method: string, path: string, body: any): [number, unknown] | null {
  const p = path.split('?')[0] ?? '';
  const m = /^\/api\/v1\/channels\/ch_\w+\/site\/design(\/.*)?$/.exec(p);
  if (!m) return null;
  const rest = m[1] ?? '';
  const s = (designKept ??= newDesignStore());
  publishDueSchedule(s);
  const state = () => ({
    draft: s.draft,
    published: s.published,
    draftUpdatedAt: s.draftUpdatedAt,
    publishedAt: s.publishedAt,
    publishedBy: s.publishedBy,
    problems: designProblems(s.draft).problems,
    themes: designThemes(),
    schedule: scheduleAnswer(s.schedule),
  });
  if (rest === '' && method === 'GET') return [200, state()];
  if (rest === '/schedule' && method === 'PUT') {
    const at = Date.parse(body?.at ?? '');
    const tooSoon = !(at >= Date.now() + 5 * 60_000);
    if (tooSoon || at > Date.now() + 90 * DAY) {
      const message = tooSoon
        ? 'Choose a time at least 5 minutes from now.'
        : 'Choose a time within the next 90 days.';
      return [
        400,
        { error: { code: 'invalid_input', message, details: [{ path: 'at', message }] } },
      ];
    }
    const { problems } = designProblems(s.draft);
    if (problems.some((x) => x.severity === 'error'))
      return [
        422,
        {
          error: {
            code: 'invalid_input',
            message: 'Fix the errors in the design before scheduling it.',
            details: [],
          },
          problems,
        },
      ];
    s.schedule = {
      at: new Date(at).toISOString(),
      by: { name: 'Mara Lind' },
      createdAt: new Date().toISOString(),
      status: 'scheduled',
      problems: [],
      design: structuredClone(s.draft),
      failed: false,
      cancelledAt: null,
    };
    armSchedule(s);
    return [200, scheduleAnswer(s.schedule)];
  }
  if (rest === '/schedule' && method === 'DELETE') {
    if (!scheduleAnswer(s.schedule))
      return [404, { error: { code: 'not_found', message: 'Nothing is scheduled.' } }];
    s.schedule = { ...s.schedule!, status: 'cancelled', cancelledAt: Date.now() };
    armSchedule(s);
    return [204, null];
  }
  if (rest === '/schedule/restore' && method === 'POST') {
    const kept = s.schedule;
    if (kept?.status !== 'cancelled' || (kept.cancelledAt ?? 0) < Date.now() - 10 * 60_000)
      return [
        404,
        { error: { code: 'not_found', message: 'There is no cancelled schedule to put back.' } },
      ];
    s.schedule = { ...kept, status: kept.failed ? 'failed' : 'scheduled', cancelledAt: null };
    armSchedule(s);
    return [200, scheduleAnswer(s.schedule)];
  }
  if (rest === '/draft' && method === 'PUT') {
    if (!body || typeof body.theme !== 'string' || typeof body.settings !== 'object')
      return [
        400,
        { error: { code: 'invalid_input', message: 'That isn’t a design.', details: [] } },
      ];
    s.draft = structuredClone(body);
    s.draftUpdatedAt = iso(Date.now() - now);
    return [200, { problems: designProblems(s.draft).problems, draftUpdatedAt: s.draftUpdatedAt }];
  }
  if (rest === '/publish' && method === 'POST') {
    const { problems } = designProblems(s.draft);
    if (problems.some((x) => x.severity === 'error'))
      return [
        422,
        {
          error: {
            code: 'invalid_input',
            message: 'The draft has problems to fix first.',
            details: [],
          },
          problems,
        },
      ];
    publishMockDesign(s, s.draft, { name: 'Mara Lind' });
    return [
      200,
      { published: s.published, publishedAt: s.publishedAt, publishedBy: s.publishedBy },
    ];
  }
  if (rest === '/versions' && method === 'GET')
    return [
      200,
      {
        items: s.versions.map((v) => ({
          id: v.id,
          publishedAt: v.publishedAt,
          publishedBy: v.publishedBy,
          theme: v.design.theme,
        })),
      },
    ];
  const restore = /^\/versions\/(dv_\w+)\/restore$/.exec(rest);
  if (restore && method === 'POST') {
    const version = s.versions.find((v) => v.id === restore[1]);
    if (!version) return [404, { error: { code: 'not_found', message: 'That version is gone.' } }];
    s.draft = structuredClone(version.design);
    s.draftUpdatedAt = iso(Date.now() - now);
    return [200, { draft: s.draft, problems: designProblems(s.draft).problems }];
  }
  if (rest === '/preview' && method === 'POST') {
    const url = URL.createObjectURL(
      new Blob([previewHtml(s.draft, body?.as ?? 'visitor', body)], { type: 'text/html' }),
    );
    // Keep a few, so the frame showing now and the one loading stay valid.
    s.previews.push(url);
    while (s.previews.length > 6) URL.revokeObjectURL(s.previews.shift()!);
    return [200, { url, expiresAt: iso(Date.now() - now + 30 * 60_000) }];
  }
  if (rest === '/stats' && method === 'GET') {
    const days = Number(new URLSearchParams(path.split('?')[1] ?? '').get('days') ?? '30');
    if (![7, 30, 90].includes(days))
      return [400, { error: { code: 'invalid_input', message: 'Use 7, 30 or 90 days.' } }];
    return [200, designStats(s.draft, days)];
  }
  if (rest === '/export' && method === 'GET') {
    const theme = designThemes().find((t) => t.id === s.draft.theme);
    const files = s.draft.files ?? theme?.files ?? {};
    return [
      200,
      {
        format: 'swarm-theme',
        version: 1,
        name: theme ? `${theme.name} (Field Notes)` : 'Field Notes',
        files,
      },
    ];
  }
  if (rest === '/import' && method === 'POST') {
    if (body?.format !== 'swarm-theme' || typeof body.files !== 'object')
      return [
        400,
        { error: { code: 'invalid_input', message: 'That isn’t a Swarm theme.', details: [] } },
      ];
    s.draft = { ...s.draft, files: body.files };
    s.draftUpdatedAt = iso(Date.now() - now);
    return [200, { problems: designProblems(s.draft).problems }];
  }
  return null;
}
// ---- End of the website design ----------------------------------------------------------------

function route(method: string, path: string, body: any): [number, unknown] {
  const p = path.split('?')[0] ?? '';
  if (!settingsPages.reading) {
    const kept = settingsPagesRoute(method, path, body);
    if (kept) return kept;
  }
  let m: RegExpMatchArray | null;
  const checks = emailCheckRoute(method, path, body);
  if (checks) return checks;
  const settings = settingsRoute(method, path, body);
  if (settings) return settings;
  const bounce = bounceRoute(method, p, body);
  if (bounce) return withEmailChecks(path, bounce);
  const media = mediaRoute(method, path, body);
  if (media) return media;
  const design = siteDesignRoute(method, path, body);
  if (design) return design;
  const posts = postsListRoute(method, path, body);
  if (posts) return posts;
  if (p === `/api/v1/workspaces/${WS}/seats` && method === 'GET')
    return [
      200,
      [
        ['mara@fieldnotes.example', 'Mara Lind', 'owner', 9],
        ['jonas@fieldnotes.example', 'Jonas Berg', 'editor', 10],
        ['priya@fieldnotes.example', 'Priya Raman', 'author', 11],
      ].map(([email, name, role, n]) => ({
        id: `st_${hex(n as number)}`,
        operator: { id: `op_${hex(n as number)}`, email, name, createdAt: iso(-99 * DAY) },
        role,
        createdAt: iso(-90 * DAY),
      })),
    ];
  if (p === '/api/v1/auth/session')
    return [
      200,
      {
        operator: {
          id: `op_${hex(9)}`,
          email: 'mara@fieldnotes.example',
          name: 'Mara Lind',
          createdAt: iso(-99 * DAY),
        },
        workspaces: [
          {
            id: WS,
            name: 'Field Notes Studio',
            plan: 'pro',
            role: 'owner',
            createdAt: iso(-99 * DAY),
          },
          {
            id: `ws_${hex(8)}`,
            name: 'Side projects',
            plan: 'free',
            role: 'admin',
            createdAt: iso(-9 * DAY),
          },
        ],
        sessionId: `se_${hex(7)}`,
        instanceAdmin: true,
      },
    ];
  if (/\/workspaces\/[^/]+\/channels$/.test(p))
    return [
      200,
      [channel(CH, 'Field Notes', 'fieldnotes'), channel(CH2, 'Morning Ledger', 'morningledger')],
    ];
  if ((m = p.match(/^\/api\/v1\/channels\/(ch_\w+)$/))) {
    if (method === 'PATCH') {
      for (const key of ['trackOpens', 'trackClicks', 'profileReaders'] as const) {
        if (typeof body?.[key] === 'boolean') tracking[key] = body[key];
      }
      if (!tracking.trackOpens) tracking.profileReaders = false;
    }
    return [200, channel(m[1]!, 'Field Notes', 'fieldnotes')];
  }
  if (/^\/api\/v1\/workspaces\/[^/]+\/retention$/.test(p)) {
    // A save names only what changed.
    if (method === 'PUT') {
      for (const key of Object.keys(retention) as (keyof typeof retention)[]) {
        if (typeof body?.[key] === 'number') retention[key] = body[key];
      }
    }
    return [200, { ...retention }];
  }
  if (p === '/api/v1/instance/sending-limits') {
    if (method === 'PUT') {
      sendingLimits = body;
      sendingLimitsSavedAt = new Date().toISOString();
    }
    return [200, sendingLimitsAnswer()];
  }
  if ((m = p.match(/^\/api\/v1\/broadcasts\/(br_\w+)\/resume$/)) && method === 'POST') {
    sessionStorage.setItem(SEND_WAIT_KEY, 'none');
    return route('GET', `/api/v1/broadcasts/${m[1]}`, undefined);
  }
  if (p === '/api/v1/instance/mail')
    return [
      200,
      {
        service: 'ses',
        region: 'eu-west-1',
        domain: 'mail.example.com',
        recordsComplete: true,
        feedback: { state: 'silent', sent: 412, reported: 0 },
        ses: {
          productionAccess: false,
          sendingEnabled: true,
          max24HourSend: 200,
          maxSendRate: 1,
          sentLast24Hours: 12,
        },
        checkedAt: iso(0),
        change: null,
        records: [
          {
            purpose: 'dkim',
            type: 'CNAME',
            name: 'abc123._domainkey.mail.example.com',
            value: 'abc123.dkim.amazonses.com',
            state: 'ok',
            found: ['abc123.dkim.amazonses.com.'],
          },
          {
            purpose: 'mail_from_mx',
            type: 'MX',
            name: 'bounce.mail.example.com',
            value: 'feedback-smtp.eu-west-1.amazonses.com',
            priority: 10,
            state: 'different',
            found: ['10 feedback-smtp.us-east-1.amazonses.com.'],
          },
          {
            purpose: 'mail_from_spf',
            type: 'TXT',
            name: 'bounce.mail.example.com',
            value: 'v=spf1 include:amazonses.com ~all',
            state: 'missing',
            found: [],
          },
          {
            purpose: 'dmarc',
            type: 'TXT',
            name: '_dmarc.mail.example.com',
            value: 'v=DMARC1; p=quarantine; adkim=r; aspf=r',
            state: 'unknown',
            found: [],
          },
        ],
      },
    ];
  if (p.endsWith('/flags'))
    return [
      200,
      {
        flags: {
          smart_blocks: false,
          applications: true,
          site_custom_code: true,
          ...POSTS_LIST_FLAGS,
          ...SITE_DESIGN_FLAGS,
        },
      },
    ];
  const siteCode = siteCodeRoute(method, p, body);
  if (siteCode) return siteCode;
  if (p.endsWith('/dispatches') && method === 'GET') {
    // The post going out now is listed only while ?sendwait holds it.
    return [200, mockWait() ? dispatches : dispatches.filter((d) => d.status !== 'sending')];
  }
  if (p.endsWith('/members/counts'))
    return [
      200,
      { pending: 38, active: 12731, paused: 0, unsubscribed: 412, bounced: 37, complained: 2 },
    ];
  if (
    p.endsWith('/sending-domains') &&
    ['shared', 'shared-admin', 'empty'].includes(warmupScenario())
  )
    return [200, []];
  const subscriber = subscriberRoute(method, p, body);
  if (subscriber) return subscriber;
  if (/^\/api\/v1\/channels\/ch_\w+\/members$/.test(p) && method === 'GET')
    return [200, memberList(path)];
  if ((m = p.match(/^\/api\/v1\/members\/(mb_\w+)$/)) && method === 'GET') {
    const member = members.find((x) => x.id === m![1]);
    if (member) return [200, memberDetail(member)];
  }
  if (p.endsWith('/champions/settings') && method === 'GET')
    return [
      200,
      {
        enabled: true,
        engagementDays: 14,
        clusterLimit: 3,
        clusterWindowHours: 24,
        blockDisposable: true,
        publicLeaderboard: false,
        shareText: 'I read Field Notes every week. You might like it too.',
        updatedAt: iso(-12 * DAY),
      },
    ];
  if (p.endsWith('/sending-domains'))
    return [
      200,
      [
        {
          id: DOMAIN,
          channelId: CH,
          domain: 'mail.fieldnotes.example',
          kind: 'email',
          status: 'verified',
          dkimStatus: 'success',
          mailFromDomain: null,
          mailFromStatus: 'success',
          dmarcPolicy: 'quarantine',
          records: [
            {
              purpose: 'dmarc',
              type: 'TXT',
              name: '_dmarc.fieldnotes.example',
              value: 'v=DMARC1; p=quarantine',
            },
          ],
          lastCheckedAt: iso(-DAY),
          verifiedAt: iso(-30 * DAY),
          createdAt: iso(-30 * DAY),
        },
      ],
    ];
  if (p.endsWith('/sender-identities'))
    return [
      200,
      [
        {
          id: `si_${hex(5)}`,
          channelId: CH,
          sendingDomainId: DOMAIN,
          fromName: 'Mara at Field Notes',
          fromAddress: 'mara@mail.fieldnotes.example',
          replyTo: null,
          isDefault: true,
          createdAt: iso(-30 * DAY),
        },
      ],
    ];
  if (p.endsWith('/ramps')) {
    if (warmupScenario() === 'error')
      return [500, { error: { code: 'internal', message: 'Something went wrong on our side.' } }];
    return [200, mockRamps().map(withPlan)];
  }
  if ((m = p.match(/\/ramps\/([^/]+)(?:\/(skip|restart))?$/))) {
    const ramp = mockRamps().find((r) => r.id === m?.[1]);
    if (!ramp) return [404, { error: { code: 'not_found', message: 'Warm-up not found.' } }];
    if (m[2] === 'skip')
      Object.assign(ramp, { status: 'complete', skippedAt: iso(0), pausedReason: null });
    else if (m[2] === 'restart') {
      const pace = RAMP_PACES[ramp.kind as RampKind][(body?.pace ?? 'standard') as RampPaceKey];
      Object.assign(ramp, pace, {
        status: 'warming',
        skippedAt: null,
        capToday: pace.startCap,
        sentToday: 0,
        startedDay: TODAY,
        day: TODAY,
        days: [],
      });
    } else {
      const pace = body?.pace ? RAMP_PACES[ramp.kind as RampKind][body.pace as RampPaceKey] : body;
      if (pace?.startCap) {
        ramp.capToday = rampCapAfterPaceChange(ramp, pace.startCap);
        ramp.startCap = pace.startCap;
      }
      if (pace?.growth) ramp.growth = pace.growth;
      if (body?.maxCap) ramp.maxCap = body.maxCap;
      if (body?.status && ramp.status !== 'complete' && ramp.status !== body.status) {
        ramp.status = body.status;
        ramp.pausedReason = body.status === 'paused' ? 'Paused by a teammate.' : null;
        ramp.pausedBy = body.status === 'paused' ? 'person' : null;
      }
    }
    return [200, withPlan(ramp)];
  }
  if (/\/sending-domains\/[^/]+\/health$/.test(p))
    return [
      200,
      {
        sendingDomainId: p.split('/')[4],
        domain: 'news.fieldnotes.example',
        from: iso(-30 * DAY).slice(0, 10),
        to: iso(0).slice(0, 10),
        status: 'verified',
        dmarcPolicy: 'quarantine',
        records: [
          {
            purpose: 'dkim',
            type: 'CNAME',
            name: 'abc._domainkey.news.fieldnotes.example',
            value: 'abc.dkim.amazonses.com',
            state: 'ok',
            found: ['abc.dkim.amazonses.com.'],
          },
          {
            purpose: 'mail_from_spf',
            type: 'TXT',
            name: 'bounce.news.fieldnotes.example',
            value: 'v=spf1 include:amazonses.com ~all',
            state: 'missing',
            found: [],
          },
        ],
        ramp: { status: 'warming', pausedReason: null, capToday: 1012 },
        sending: {
          sent: 4210,
          bounces: 21,
          complaints: 2,
          bounceRate: 0.005,
          complaintRate: 0.0004,
        },
        dmarc: { messages: 0, aligned: 0, alignmentRate: null, lastReportAt: null },
      },
    ];
  if (p.endsWith('/deliverability/checkup')) return mockCheckup();
  if (p.endsWith('/deliverability'))
    return [
      200,
      {
        from: iso(-30 * DAY).slice(0, 10),
        to: iso(0).slice(0, 10),
        domains: [
          {
            sendingDomainId: `sd_${hex(16)}`,
            domain: 'news.fieldnotes.example',
            status: 'verified',
            dmarcPolicy: 'quarantine',
            reportAddress: 'dmarc+sd@dmarc.example.com',
            recommendedRecord: {
              purpose: 'dmarc',
              type: 'TXT',
              name: '_dmarc.news.fieldnotes.example',
              value: 'v=DMARC1; p=quarantine',
            },
            lastReportAt: null,
            messages: 0,
            aligned: 0,
          },
        ],
        providers: [
          ['gmail', 0.994],
          ['outlook', 0.988],
          ['apple', 0.992],
          ['yahoo', 0.976],
        ].map(([provider, rate]) => ({
          provider,
          sent: 1000,
          delivered: Math.round((rate as number) * 1000),
          bounced: 0,
          complained: 0,
          opened: 0,
          bounceRate: 0,
          complaintRate: 0,
          openRate: 0,
          complaintStanding: 'good',
        })),
        complaints: {
          delivered: 1,
          complained: 0,
          rate: 0,
          target: 0.001,
          threshold: 0.003,
          standing: 'good',
        },
        ramps: [],
      },
    ];
  if ((m = p.match(/^\/api\/v1\/broadcasts\/br_0*(\d+)\/stats$/))) {
    const row = SENT.find(([n]) => n === Number(m![1]) - 200);
    return [200, stats(row?.[2] ?? 45, row?.[3] ?? 4)];
  }
  if ((m = p.match(/^\/api\/v1\/broadcasts\/(br_\w+)$/))) {
    // With ?warmup=used or paused the send is still going out, held by warm-up. With ?sendwait
    // set, the send of post 46 waits for a sending limit.
    const waiting = m[1] === WAITING_BROADCAST ? mockWait() : null;
    if (m[1] === WAITING_BROADCAST) {
      return [
        200,
        {
          id: m[1],
          dispatchId: `di_${hex(146)}`,
          channelId: CH,
          subject: 'What the river taught us about deadlines',
          from: { name: 'Mara at Field Notes', address: 'mara@mail.fieldnotes.example' },
          recipientCount: 12731,
          sentCount: waiting ? 12731 - 1240 : 12731,
          failedCount: 0,
          failureReason: null,
          status: waiting ? 'sending' : 'sent',
          createdAt: iso(-3 * 3600_000),
          completedAt: waiting ? null : iso(-60_000),
          canceledAt: null,
          bestTime: null,
          splitTest: null,
          cohortSample: null,
          waiting,
        },
      ];
    }
    const held = ['used', 'paused'].includes(warmupScenario());
    const broadcast = broadcastFor(m[1]!);
    if (!broadcast) {
      return [404, { error: { code: 'not_found', message: 'This send report does not exist.' } }];
    }
    return [
      200,
      {
        ...broadcast,
        waiting: null,
        ...(held ? { sentCount: 3658, status: 'sending', completedAt: null } : {}),
      },
    ];
  }
  if ((m = p.match(/^\/api\/v1\/imports\/(ij_\w+)$/)) && method === 'GET') {
    const added = Number(sessionStorage.getItem('swarm:mock-import-new') ?? 4200);
    const classes = [
      'new',
      'updated',
      'unchanged',
      'invalid',
      'role',
      'disposable',
      'suppressed',
      'duplicate',
    ];
    const counts: Record<string, number> = {
      new: added,
      updated: 0,
      unchanged: 310,
      invalid: 12,
      role: 9,
      disposable: 4,
      suppressed: 21,
      duplicate: 6,
    };
    return [
      200,
      {
        id: m[1],
        channelId: CH,
        status: 'analyzed',
        fileName: 'old-list.csv',
        bytes: 482_113,
        columns: ['email', 'name'],
        mapping: { email: 'email', name: 'first_name' },
        consentAttested: true,
        updateExisting: false,
        source: 'csv',
        report: {
          total: Object.values(counts).reduce((a, b) => a + b, 0),
          counts,
          samples: Object.fromEntries(classes.map((k) => [k, []])),
          fieldErrors: 0,
          fieldErrorSamples: [],
          warmImport: added >= 10_000,
        },
        totalRows: 0,
        processedRows: 0,
        error: null,
        createdAt: iso(-60_000),
        completedAt: null,
      },
    ];
  }
  if ((m = p.match(/^\/api\/v1\/dispatches\/(d[ip]_\w+)\/preflight$/)))
    return [
      200,
      {
        ready: true,
        recipientCount: 12731,
        from: { name: 'Mara at Field Notes', address: 'mara@mail.fieldnotes.example' },
        checks: [
          { key: 'subject', ok: true, message: 'Subject is set' },
          { key: 'domain', ok: true, message: 'Sender domain verified' },
          { key: 'links', ok: true, message: 'Links checked (4 links, all reachable)' },
        ],
        // The server's own line; the send panel replaces it with the fuller warm-up note.
        warnings:
          warmupScenario() === 'warming'
            ? [
                "Today's warm-up allows 1,108 more messages; the rest will go out over the next days.",
              ]
            : [],
        // ?advice=1 shows the content advice block in the send panel.
        advice: sessionStorage.getItem('swarm:mock-advice') === '1' ? MOCK_ADVICE : [],
        audience: { include: [], exclude: [] },
        split: null,
        holdBack: null,
        bestTime: null,
      },
    ];
  if ((m = p.match(/^\/api\/v1\/dispatches\/(d[ip]_\w+)$/))) {
    const s = [...dispatches, ...flowEmailDispatches].find((d) => d.id === m![1]) ?? dispatches[1]!;
    const full = {
      ...s,
      content,
      html,
      warnings: [],
      htmlBlocksAllowed: false,
      coverImage: null,
      unopenedOf: null,
      internalNote: '',
      audience: { include: [], exclude: [] },
      sectionId: null,
      slug: null,
      onSite: false,
      webUrl: null,
    };
    return [
      200,
      method === 'PATCH' ? { ...full, ...body, updatedAt: new Date().toISOString() } : full,
    ];
  }
  if (p.endsWith('/revisions')) return [200, []];
  if (/\/members\/[^/]+\/flows$/.test(p)) return [200, []];
  const flow = flowRoute(method, p, body);
  if (flow) return flow;
  if (p.endsWith('/flows')) return [200, [welcomeFlow]];
  const developer = developerRoute(method, p, body);
  if (developer) return developer;
  if (p.endsWith('/payments/paypal')) {
    return [
      200,
      {
        available: true,
        connected: false,
        mode: null,
        clientId: null,
        secretLast4: null,
        connectedAt: null,
        unfinishedEvents: 0,
      },
    ];
  }
  if (p.endsWith('/payments')) {
    return [
      200,
      {
        available: true,
        connected: false,
        state: 'not_connected',
        connectAvailable: false,
        keyAvailable: true,
        method: null,
        keyLast4: null,
      },
    ];
  }
  if (p.endsWith('/overview'))
    return [
      200,
      { members: { active: 12731, joinedLast30Days: 349, leftLast30Days: 87 }, broadcasts: [] },
    ];
  if (p.endsWith('/circles')) return [200, { items: [], nextCursor: null }];
  if (p.includes('/audience')) return [200, { recipientCount: 12731, problem: null }];
  return [
    404,
    { error: { code: 'not_found', message: `Mock API has no answer for ${method} ${p}` } },
  ];
}

export function installMockApi() {
  const flag = new URLSearchParams(location.search).get('mock');
  if (flag === '1') sessionStorage.setItem(KEY, '1');
  if (flag === '0') sessionStorage.removeItem(KEY);
  const warmup = new URLSearchParams(location.search).get('warmup');
  if (warmup) sessionStorage.setItem(WARMUP_KEY, warmup);
  const importNew = new URLSearchParams(location.search).get('importnew');
  if (importNew) sessionStorage.setItem('swarm:mock-import-new', importNew);
  rememberCheckupScenario();
  rememberEmailCheckScenario();
  const sendWait = new URLSearchParams(location.search).get('sendwait');
  if (sendWait) sessionStorage.setItem(SEND_WAIT_KEY, sendWait);
  const siteCode = new URLSearchParams(location.search).get('sitecode');
  if (siteCode) sessionStorage.setItem(SITE_CODE_KEY, siteCode);
  const advice = new URLSearchParams(location.search).get('advice');
  if (advice) sessionStorage.setItem('swarm:mock-advice', advice);
  if (sessionStorage.getItem(KEY) !== '1') return;
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.pathname + input.search
          : input.url;
    if (!url.startsWith('/api/')) return real(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body =
      typeof init?.body === 'string'
        ? JSON.parse(init.body)
        : init?.body instanceof FormData
          ? init.body
          : undefined;
    if (url.includes('/site/design') && !engine) await loadDesignEngine();
    let [status, data] = route(method, url, body);
    // Anything the canned data above doesn't cover gets an empty answer of the right shape.
    if (status === 404) {
      const answer = await fallbackAnswer(method, url.split('?')[0] ?? '', body);
      if (answer) [status, data] = answer;
    }
    await new Promise((r) => setTimeout(r, 120));
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(status < 400 ? { data } : data), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}
