// Development only: email checks with DeBounce in the mock API (docs/email-verification.md).
// ?debounce=connected (DeBounce set up, no check yet), unset (no key: the setup guide),
// notallowed (a key, but this workspace may not use it), running (a check in parts), paused (out
// of credits), results (a finished check with red and orange addresses) or off (the feature is
// off). It sticks for the tab like ?mock. Without the parameter the mock has no email checks.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { EMAIL_CHECK_CODES, EMAIL_CHECK_DEFAULTS } from '@swarm/domain';

const KEY = 'swarm:mock-debounce';
const DAY = 86_400_000;
const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const hex = (n: number) => String(n).padStart(32, '0');
const WS = `ws_${hex(1)}`;
const CH = `ch_${hex(2)}`;
const RUN = `vr_${hex(77)}`;

export function rememberEmailCheckScenario() {
  const value = new URLSearchParams(location.search).get('debounce');
  if (value) sessionStorage.setItem(KEY, value);
}

const scenario = () => sessionStorage.getItem(KEY);

let settings = { ...EMAIL_CHECK_DEFAULTS };
let everyWorkspace = false;
const allowed = new Set<string>();
/** Settings → Instance → DeBounce credits per workspace: a workspace's own numbers, or null. */
const BUDGET_DEFAULTS = { dailyChecks: 200, listChecks: 25_000 };
const budgets = new Map<string, number | null>();

function budgetRow(
  id: string,
  name: string,
  isAllowed: boolean,
  ownedByInstanceAdmin: boolean,
  used = { usedToday: 0, listUsed: 0 },
) {
  const daily = budgets.get(`${id}:daily`) ?? null;
  const list = budgets.get(`${id}:list`) ?? null;
  return {
    id,
    name,
    allowed: isAllowed,
    ownedByInstanceAdmin,
    dailyChecks: daily ?? BUDGET_DEFAULTS.dailyChecks,
    usedToday: used.usedToday,
    listChecks: list ?? BUDGET_DEFAULTS.listChecks,
    listUsedThisMonth: used.listUsed,
    customDailyChecks: daily !== null,
    customListChecks: list !== null,
  };
}
let started = 0;
let stoppedAt: number | null = null;
let planned: any = null;

/** Extra subscribers of the sample publication, one for each colour and reason. */
const EXTRA = [
  ['mb_' + hex(51), 'lena.k@gmial.com', 'red', 6, 'lena.k@gmail.com'],
  ['mb_' + hex(52), 'info@harbourbooks.example', 'orange', 8, null],
  ['mb_' + hex(53), 'tom@catchall.example', 'orange', 4, null],
  ['mb_' + hex(54), 'old-reader@defunct.example', 'red', 6, null],
  ['mb_' + hex(55), 'new.signup@example.com', null, null, null],
] as const;

/** Colours of the three subscribers the other mocks list. */
const COLOURS: Record<string, [string, number] | null> = {
  'priya.raman@example.com': ['green', 5],
  'jonas@oldcompany.example': ['red', 6],
  'sam@outlook.example': ['orange', 7],
};

const check = (state: string | null, code: number | null, didYouMean: string | null = null) =>
  state && code
    ? {
        state,
        code,
        reason: EMAIL_CHECK_CODES[code as keyof typeof EMAIL_CHECK_CODES].label,
        didYouMean,
        source: code === 8 ? 'swarm' : 'debounce',
        checkedAt: iso(-2 * DAY),
        stale: false,
      }
    : null;

const keySet = () => scenario() !== 'unset';
const available = () => keySet() && scenario() !== 'notallowed' && scenario() !== 'off';

function run(): any {
  const s = scenario();
  const parts = 3;
  const base = {
    id: RUN,
    scope: 'workspace',
    channelId: null,
    circleId: null,
    importId: null,
    onlyNeverChecked: false,
    pausedReason: null,
    error: null,
    plan: { addresses: 12_769, fresh: 0, local: 214, toCheck: 12_555, parts, method: 'bulk' },
    balance: 1_087_306,
    createdAt: iso(-DAY),
    startedAt: iso(-DAY),
    completedAt: null,
  };
  if (planned) return planned;
  if (s === 'running' || s === 'paused' || (started && s !== 'results')) {
    const part = 2;
    return {
      ...base,
      status: s === 'paused' ? 'paused' : stoppedAt ? 'stopping' : 'running',
      pausedReason: s === 'paused' ? 'credits' : null,
      progress: { part, parts, checked: 5214, creditsUsed: 5000, partPercent: 62 },
      results: { green: 4730, orange: 351, red: 133 },
    };
  }
  if (s === 'results') {
    return {
      ...base,
      status: 'completed',
      completedAt: iso(-3 * 3_600_000),
      progress: { part: parts, parts, checked: 12_769, creditsUsed: 12_555, partPercent: 100 },
      results: { green: 11_602, orange: 840, red: 327 },
    };
  }
  return null;
}

function summary() {
  const r = run();
  const done = scenario() === 'results' || (r && r.status !== 'planned' && r.status !== 'planning');
  const counts = done
    ? { green: 11_602, orange: 840, red: 327, unchecked: 0, stale: 0 }
    : { green: 0, orange: 0, red: 0, unchecked: 12_769, stale: 0 };
  return {
    enabled: scenario() !== 'off',
    available: available(),
    keySet: keySet(),
    access: scenario() === 'notallowed' ? 'not_allowed' : 'allowed',
    subscribers: 12_769,
    counts,
    reasons: done
      ? [
          { code: 5, state: 'green', label: 'Deliverable', count: 11_602 },
          { code: 4, state: 'orange', label: 'Can’t be confirmed', count: 512 },
          { code: 8, state: 'orange', label: 'Team address', count: 214 },
          { code: 7, state: 'orange', label: 'Server didn’t answer', count: 81 },
          { code: 3, state: 'orange', label: 'Temporary address', count: 33 },
          { code: 6, state: 'red', label: 'Will bounce', count: 301 },
          { code: 2, state: 'red', label: 'Spam trap', count: 4 },
          { code: 1, state: 'red', label: 'Not an email address', count: 22 },
        ]
      : [],
    validMonths: settings.validMonths,
    run: r,
  };
}

/** Answers for the email check routes, or null. */
export function emailCheckRoute(method: string, path: string, body: any): [number, unknown] | null {
  if (!scenario()) return null;
  const p = path.split('?')[0] ?? '';
  let m: RegExpMatchArray | null;
  if (p.endsWith('/flags') && scenario() !== 'off') {
    return [
      200,
      {
        flags: {
          smart_blocks: false,
          applications: true,
          site_custom_code: true,
          email_verification: true,
        },
      },
    ];
  }
  if (p === '/api/v1/instance/email-checks') {
    if (method === 'PUT') everyWorkspace = body.everyWorkspace;
    return [
      200,
      {
        keySet: keySet(),
        balance: keySet() ? 1_087_306 : null,
        keyRejected: false,
        everyWorkspace,
        defaults: BUDGET_DEFAULTS,
        workspaces: [
          budgetRow(WS, 'Field Notes Studio', true, true, { usedToday: 12, listUsed: 4_200 }),
          budgetRow(`ws_${hex(8)}`, 'Side projects', allowed.has(`ws_${hex(8)}`), false),
          budgetRow(`ws_${hex(31)}`, 'Harbour Books', allowed.has(`ws_${hex(31)}`), false),
        ],
      },
    ];
  }
  if ((m = p.match(/^\/api\/v1\/instance\/email-checks\/workspaces\/(ws_\w+)$/))) {
    if (body.allowed) allowed.add(m[1]!);
    else allowed.delete(m[1]!);
    // A number of its own, or null (or nothing) for the default.
    if (body.dailyChecks !== undefined) budgets.set(`${m[1]}:daily`, body.dailyChecks);
    if (body.listChecks !== undefined) budgets.set(`${m[1]}:list`, body.listChecks);
    return emailCheckRoute('GET', '/api/v1/instance/email-checks', null);
  }
  const status = () => ({
    enabled: scenario() !== 'off',
    keySet: keySet(),
    access: scenario() === 'notallowed' ? 'not_allowed' : 'allowed',
    available: available(),
    balance: available() ? 1_087_306 : null,
    settings,
    budget: {
      dailyChecks: 200,
      usedToday: 12,
      exhausted: false,
      listChecks: 25_000,
      listUsedThisMonth: 4_200,
      listResetsAt: '2026-12-01T00:00:00.000Z',
    },
  });
  if (/^\/api\/v1\/workspaces\/ws_\w+\/email-checks$/.test(p)) return [200, status()];
  if (/^\/api\/v1\/workspaces\/ws_\w+\/email-checks\/settings$/.test(p)) {
    settings = body;
    return [200, status()];
  }
  if (/^\/api\/v1\/channels\/ch_\w+\/email-checks$/.test(p)) return [200, summary()];
  if (/^\/api\/v1\/workspaces\/ws_\w+\/email-checks\/runs$/.test(p) && method === 'POST') {
    planned = {
      ...(run() ?? {}),
      id: RUN,
      scope: body.scope,
      channelId: body.channelId ?? null,
      circleId: body.circleId ?? null,
      importId: null,
      onlyNeverChecked: !!body.onlyNeverChecked,
      status: 'planned',
      pausedReason: null,
      error: null,
      plan: { addresses: 12_769, fresh: 0, local: 214, toCheck: 12_555, parts: 3, method: 'bulk' },
      balance: 1_087_306,
      progress: { part: 0, parts: 3, checked: 0, creditsUsed: 0, partPercent: 0 },
      results: { green: 0, orange: 0, red: 0 },
      createdAt: iso(0),
      startedAt: null,
      completedAt: null,
    };
    return [202, planned];
  }
  if (
    (m = p.match(
      /^\/api\/v1\/workspaces\/ws_\w+\/email-checks\/runs\/(vr_\w+)(?:\/(start|stop|resume))?$/,
    ))
  ) {
    const action = m[2];
    if (action === 'start') {
      planned = null;
      started = Date.now();
      sessionStorage.setItem(KEY, 'running');
    }
    if (action === 'stop') {
      if (planned) planned = { ...planned, status: 'canceled' };
      else stoppedAt = Date.now();
    }
    if (action === 'resume') sessionStorage.setItem(KEY, 'running');
    return [200, run()];
  }
  if (/^\/api\/v1\/channels\/ch_\w+\/email-checks\/red$/.test(p)) {
    const confirm = body.confirm === true;
    return [
      200,
      {
        actionable: confirm ? 0 : 325,
        done: confirm ? 325 : 0,
        remaining: 0,
        paying: 2,
        needsAttention: [
          { id: `mb_${hex(61)}`, email: 'patron.member@gmial.com' },
          { id: `mb_${hex(62)}`, email: 'ceo@defunct-startup.example' },
        ],
        jobIds: [],
      },
    ];
  }
  if ((m = p.match(/^\/api\/v1\/members\/(mb_\w+)\/email-check$/))) {
    if (method === 'POST') return [202, null];
    const extra = EXTRA.find((e) => e[0] === m![1]);
    return [
      200,
      {
        available: available(),
        check: extra ? check(extra[2], extra[3], extra[4]) : check('red', 6),
      },
    ];
  }
  const extra = p.match(/^\/api\/v1\/members\/(mb_\w+)$/);
  const known = extra && EXTRA.find((e) => e[0] === extra[1]);
  if (known && method === 'GET') {
    return [
      200,
      {
        id: known[0],
        email: known[1],
        firstName: null,
        lastName: null,
        channelId: CH,
        status: 'active',
        digest: 'every',
        tags: [],
        createdAt: iso(-40 * DAY),
        confirmedAt: iso(-40 * DAY),
        pausedUntil: null,
        unsubscribedAt: null,
        emailsOffAt: null,
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

/** Adds email checks (and a few more subscribers) to the mock subscriber list. */
export function withEmailChecks(path: string, answer: [number, unknown]): [number, unknown] {
  if (!scenario() || scenario() === 'off') return answer;
  const p = path.split('?')[0] ?? '';
  if (!/^\/api\/v1\/channels\/ch_\w+\/members$/.test(p)) return answer;
  const query = new URLSearchParams(path.split('?')[1] ?? '');
  const results = scenario() === 'results';
  const list = answer[1] as { items: any[]; nextCursor: string | null };
  const extras = EXTRA.map(([id, email, state, code, mean]) => ({
    id,
    email,
    firstName: null,
    lastName: null,
    channelId: CH,
    status: 'active',
    digest: 'every',
    tags: [],
    createdAt: iso(-40 * DAY),
    confirmedAt: iso(-40 * DAY),
    pausedUntil: null,
    unsubscribedAt: null,
    emailsOffAt: null,
    emailCheck: results ? check(state, code, mean) : null,
  }));
  const items = [
    ...list.items.map((item) => {
      const colour = COLOURS[item.email];
      return { ...item, emailCheck: results && colour ? check(colour[0], colour[1]) : null };
    }),
    ...extras,
  ].filter((item) => {
    const want = query.get('emailCheck');
    const code = query.get('emailCheckCode');
    if (want === 'unchecked' && item.emailCheck) return false;
    if (want && want !== 'unchecked' && item.emailCheck?.state !== want) return false;
    if (code && String(item.emailCheck?.code) !== code) return false;
    return true;
  });
  return [answer[0], { ...list, items }];
}
