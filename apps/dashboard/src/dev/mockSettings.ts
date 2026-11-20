// Development only, with ?mock=1: the settings the privacy and security rounds added, in the shapes
// the real API answers with, so their pages show something to look at. Former teammates (Settings →
// Privacy), account activity and Pause all feeds (Security), export destinations with what they
// send (a publication's Subscribers → Export destinations) and the install's audit log (Settings →
// Instance). Changes are kept while the tab is open.
/* eslint-disable @typescript-eslint/no-explicit-any */

const DAY = 86_400_000;
const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const hex = (n: number) => String(n).padStart(32, '0');
const WS = `ws_${hex(1)}`;
const CH = `ch_${hex(2)}`;
const BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';

// ---- Former teammates -----------------------------------------------------------------------

const placeholder = (operatorId: string) =>
  `former-teammate-${operatorId.slice(-12)}@redacted.invalid`;

const formerTeammates = [
  {
    id: `op_${hex(21)}`,
    email: 'ilse@fieldnotes.example',
    name: 'Ilse Brandt',
    redacted: false,
    lastActiveAt: iso(-210 * DAY),
  },
  {
    id: `op_${hex(22)}`,
    email: placeholder(`op_${hex(22)}`),
    name: null,
    redacted: true,
    lastActiveAt: iso(-400 * DAY),
  },
];

// ---- Security: account activity, and Pause all feeds ----------------------------------------

const securityOverview = () => ({
  passkeys: [
    {
      id: `pk_${hex(41)}`,
      name: 'MacBook',
      backedUp: true,
      createdAt: iso(-60 * DAY),
      lastUsedAt: iso(-2 * 3_600_000),
    },
  ],
  totp: { enabled: false, confirmedAt: null },
  recoveryCodes: { remaining: 9, createdAt: iso(-60 * DAY) },
  secondFactor: {
    state: 'ok',
    methods: ['passkey', 'recovery'],
    required: true,
    enrollBy: null,
    verifiedWith: 'passkey',
  },
  activity: [
    ['operator.signed_in', 'passkey', -2 * 3_600_000],
    ['operator.signed_in', 'quickpass', -3 * DAY],
    ['operator.recovery_codes_regenerated', null, -60 * DAY],
    ['operator.passkey_added', null, -60 * DAY],
  ].map(([action, method, offset]) => ({
    action,
    method,
    ipPrefix: '203.0.113.0/24',
    userAgent: BROWSER,
    at: iso(offset as number),
  })),
});

const webhook = { id: `wh_${hex(42)}`, url: 'https://hooks.fieldnotes.example/swarm' };

// ---- Export destinations --------------------------------------------------------------------

const destination = (n: number, over: Record<string, unknown>) => ({
  id: `xd_${hex(n)}`,
  channelId: CH,
  kind: 's3',
  endpoint: null,
  region: 'eu-central-1',
  bucket: 'fieldnotes-exports',
  prefix: 'swarm/',
  schedule: 'daily',
  status: 'active',
  lastRunAt: iso(-5 * 3_600_000),
  lastError: null,
  exportedThrough: iso(-5 * 3_600_000),
  scope: { members: 'active', fields: [] },
  legacyScope: false,
  suspendedReason: null,
  createdAt: iso(-40 * DAY),
  updatedAt: iso(-5 * 3_600_000),
  ...over,
});

let destinations: any[] = [
  destination(43, {}),
  // Added before scopes existed: it sends everyone with every field until an admin narrows it.
  destination(44, {
    kind: 'r2',
    endpoint: 'https://0123456789abcdef.r2.cloudflarestorage.com',
    region: 'auto',
    bucket: 'reader-archive',
    prefix: '',
    schedule: 'hourly',
    scope: { members: 'all', fields: 'all' },
    legacyScope: true,
    createdAt: iso(-200 * DAY),
  }),
];

// ---- The install's audit log ----------------------------------------------------------------

const instanceAudit = [
  ['PUT', `/api/v1/instance/email-checks/workspaces/${WS}`, { allowed: true, dailyChecks: 500 }],
  ['PUT', '/api/v1/instance/sending-limits', { perSecond: 14, perDay: 50_000 }],
  ['PUT', '/api/v1/instance/features/smart_blocks', { enabled: true }],
  ['PUT', '/api/v1/instance/site-code', { everyWorkspace: false }],
  ['PUT', '/api/v1/instance/settings', { signup: 'invite_only' }],
].map(([method, path, request], i, all) => ({
  seq: all.length - i,
  action: 'instance.setting_changed',
  actorEmail: 'mara@fieldnotes.example',
  metadata: { method, path, request },
  ipPrefix: '203.0.113.0/24',
  at: iso(-(i * 9 + 1) * DAY),
}));

/** Answers for these settings, or null. */
export function settingsRoute(method: string, path: string, body: any): [number, unknown] | null {
  const [p = '', search = ''] = path.split('?');
  let m: RegExpMatchArray | null;

  if (/^\/api\/v1\/workspaces\/ws_\w+\/former-teammates$/.test(p)) return [200, formerTeammates];
  if ((m = p.match(/^\/api\/v1\/workspaces\/ws_\w+\/former-teammates\/(op_\w+)\/redact$/))) {
    const person = formerTeammates.find((t) => t.id === m![1]);
    if (!person) {
      return [404, { error: { code: 'not_found', message: 'No such former teammate.' } }];
    }
    Object.assign(person, { email: placeholder(person.id), name: null, redacted: true });
    return [200, person];
  }

  if (p === '/api/v1/security' && method === 'GET') return [200, securityOverview()];
  if (/^\/api\/v1\/workspaces\/ws_\w+\/security\/pause-feeds$/.test(p) && method === 'POST') {
    const running = destinations.filter((d) => d.status !== 'paused');
    destinations = destinations.map((d) => ({ ...d, status: 'paused', updatedAt: iso(0) }));
    return [
      200,
      {
        paused: [
          ...running.map((d) => ({
            kind: 'export_destination',
            id: d.id,
            target: `${d.bucket}/${d.prefix}`,
            channelId: d.channelId,
          })),
          { kind: 'webhook_endpoint', id: webhook.id, target: webhook.url, channelId: null },
        ],
        apiKeysRevoked: body?.revokeApiKeys ? 2 : 0,
        appsRevoked: body?.revokeApps ? 1 : 0,
      },
    ];
  }

  if ((m = p.match(/^\/api\/v1\/channels\/(ch_\w+)\/export-destinations$/))) {
    if (method === 'POST') {
      const { accessKeyId: _key, secretAccessKey: _secret, ...config } = body ?? {};
      const made = destination(45 + destinations.length, {
        ...config,
        channelId: m[1],
        lastRunAt: null,
        exportedThrough: null,
        scope: config.scope ?? { members: 'active', fields: [] },
        createdAt: iso(0),
        updatedAt: iso(0),
      });
      destinations = [...destinations, made];
      return [201, made];
    }
    return [200, destinations.filter((d) => d.channelId === m![1])];
  }
  if ((m = p.match(/^\/api\/v1\/export-destinations\/(xd_\w+)(?:\/(confirm|test))?$/))) {
    const found = destinations.find((d) => d.id === m![1]);
    if (!found) return [404, { error: { code: 'not_found', message: 'No such destination.' } }];
    if (m[2] === 'test') return [200, { ok: true, status: 200, message: 'Wrote a test file.' }];
    if (method === 'DELETE') {
      destinations = destinations.filter((d) => d.id !== found.id);
      return [204, null];
    }
    if (m[2] === 'confirm') Object.assign(found, { suspendedReason: null });
    if (method === 'PATCH') {
      const { accessKeyId: _key, secretAccessKey: _secret, ...patch } = body ?? {};
      // Narrowing (or widening) what it sends ends the legacy "everything" scope.
      Object.assign(found, patch, patch.scope ? { legacyScope: false } : {});
    }
    found.updatedAt = iso(0);
    return [200, found];
  }

  if (p === '/api/v1/instance/audit' && method === 'GET') {
    const query = new URLSearchParams(search);
    const limit = Math.min(100, Number(query.get('limit') ?? 100));
    const before = Number(query.get('cursor') ?? Number.MAX_SAFE_INTEGER);
    const older = instanceAudit.filter((e) => e.seq < before);
    const items = older.slice(0, limit);
    return [
      200,
      {
        items,
        nextCursor: older.length > limit ? String(items.at(-1)?.seq) : null,
        verification: { ok: true, checked: instanceAudit.length, brokenAtSeq: null },
      },
    ];
  }
  return null;
}
