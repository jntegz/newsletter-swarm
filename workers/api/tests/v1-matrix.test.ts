// The generated role matrix for the dashboard API: every /api/v1 operation in the OpenAPI
// document, checked against its declaration in src/lib/policy.ts. A new route is covered as soon
// as it is in the document; it fails here until it is declared.
//  - signed out → 401 (unless declared public);
//  - an operator of another workspace → 404;
//  - every role below the declared minimum → 403;
//  - reads at the minimum are not refused (the declaration is no stricter than the route).
import { env } from 'cloudflare:test';
import type { SeatRole } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp, openApiDocument } from '../src/app';
import { ANCHORS, ROUTE_POLICY, type RoutePolicy } from '../src/lib/policy';
import { call, createChannel, seatAs, signIn, type Session } from './helpers';

const ROLES: SeatRole[] = ['viewer', 'author', 'editor', 'admin', 'owner'];

interface Param {
  name: string;
  in: string;
  schema?: { pattern?: string };
}
interface Operation {
  key: string;
  method: string;
  path: string;
  params: Param[];
  hasBody: boolean;
  policy: RoutePolicy | undefined;
}

const doc = openApiDocument(createApp());
const OPERATIONS: Operation[] = Object.entries(doc.paths ?? {})
  .filter(([path]) => path.startsWith('/api/v1/'))
  .flatMap(([path, item]) =>
    Object.entries(item as Record<string, Record<string, unknown>>)
      .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
      .map(([method, op]) => {
        const key = `${method.toUpperCase()} ${path}`;
        return {
          key,
          method: method.toUpperCase(),
          path,
          params: (op.parameters as Param[] | undefined) ?? [],
          hasBody: !!op.requestBody,
          policy: ROUTE_POLICY[key],
        };
      }),
  );

const prefixOf = (param?: Param) => /^\^([a-z]+)_/.exec(param?.schema?.pattern ?? '')?.[1];
const hex32 = () => crypto.randomUUID().replace(/-/g, '');

let owner: Session;
let outsider: Session;
const seats = {} as Record<SeatRole, Session>;
/** A real row per anchor parameter, in the owner's workspace. */
const fixtures = new Map<string, string>();

/** Columns whose CHECK the generic filler below can't guess. */
const SAMPLES: Record<string, unknown> = { growth: 1.5 };

/**
 * Inserts the smallest valid row into `table`, filling NOT NULL columns from the schema (CHECK
 * lists, foreign keys made recursively), so every anchor has a real row to be refused on.
 */
async function insertRow(
  table: string,
  idPrefix: string,
  tenant: { workspaceId: string; channelId: string; operatorId: string },
  made: Map<string, string>,
): Promise<string> {
  const cached = made.get(table);
  if (cached) return cached;
  const columns = (
    await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>()
  ).results;
  const fks = (
    await env.DB.prepare(`PRAGMA foreign_key_list(${table})`).all<{ table: string; from: string }>()
  ).results;
  const sql =
    (
      await env.DB.prepare('SELECT sql FROM sqlite_master WHERE name = ?1')
        .bind(table)
        .first<{ sql: string }>()
    )?.sql ?? '';
  const id = `${idPrefix}_${hex32()}`;
  const values: Record<string, unknown> = {};
  for (const col of columns) {
    if (col.name === 'id') values.id = id;
    else if (col.name === 'workspace_id') values.workspace_id = tenant.workspaceId;
    else if (col.name === 'channel_id') values.channel_id = tenant.channelId;
    else if (col.notnull && col.dflt_value === null) {
      const fk = fks.find((f) => f.from === col.name);
      const allowed = new RegExp(
        `\\b${col.name}\\b[^,]*?CHECK\\s*\\(\\s*${col.name}\\s+IN\\s*\\(\\s*'([^']*)'`,
        'i',
      ).exec(sql);
      if (fk?.table === 'operators') values[col.name] = tenant.operatorId;
      else if (fk?.table === 'workspaces') values[col.name] = tenant.workspaceId;
      else if (fk?.table === 'channels') values[col.name] = tenant.channelId;
      else if (fk) values[col.name] = await insertRow(fk.table, 'fx', tenant, made);
      else if (col.name in SAMPLES) values[col.name] = SAMPLES[col.name];
      else if (allowed) values[col.name] = allowed[1];
      else if (/_json$/.test(col.name)) values[col.name] = '{}';
      else if (/REAL/i.test(col.type)) values[col.name] = 0.5;
      else if (/INT|NUM/i.test(col.type)) values[col.name] = /_at$/.test(col.name) ? Date.now() : 1;
      else values[col.name] = `fx-${hex32()}`;
    }
  }
  const names = Object.keys(values);
  await env.DB.prepare(
    `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map((_, i) => `?${i + 1}`).join(', ')})`,
  )
    .bind(...names.map((n) => values[n]))
    .run();
  made.set(table, id);
  return id;
}

beforeAll(async () => {
  owner = await signIn();
  seats.owner = owner;
  for (const role of ['viewer', 'author', 'editor', 'admin'] as const) {
    seats[role] = await seatAs(owner.workspaceId, role);
  }
  outsider = await signIn();
  const channelId = (await createChannel(owner)).id;
  fixtures.set('workspaceId', owner.workspaceId);
  fixtures.set('channelId', channelId);
  const tenant = { workspaceId: owner.workspaceId, channelId, operatorId: owner.me.operator.id };
  const made = new Map<string, string>([
    ['channels', channelId],
    ['workspaces', owner.workspaceId],
  ]);
  for (const [name, rule] of Object.entries(ANCHORS)) {
    if (fixtures.has(name)) continue;
    const param = OPERATIONS.flatMap((op) => op.params).find((p) => p.name === name);
    fixtures.set(name, await insertRow(rule.table, prefixOf(param) ?? 'fx', tenant, made));
  }
});

/** The path with real rows for anchors and absent ids for everything else. */
function urlOf(op: Operation): string {
  return op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const real = fixtures.get(name);
    if (real) return real;
    const prefix = prefixOf(op.params.find((p) => p.name === name));
    return prefix ? `${prefix}_${'0'.repeat(32)}` : '1';
  });
}

const request = (op: Operation, session: Session | null) =>
  call(op.method, urlOf(op), {
    ...(session ? { cookie: session.cookie } : {}),
    ...(op.hasBody ? { body: {} } : {}),
  });

const anchorOf = (op: Operation) => /\{(\w+)\}/.exec(op.path)?.[1];

describe('the /api/v1 policy', () => {
  it('declares every operation in the document, and nothing else', () => {
    expect(OPERATIONS.length).toBeGreaterThan(250);
    const undeclared = OPERATIONS.filter((op) => !op.policy).map((op) => op.key);
    expect(undeclared, 'add these to ROUTE_POLICY in src/lib/policy.ts').toEqual([]);
    const known = new Set(OPERATIONS.map((op) => op.key));
    expect(Object.keys(ROUTE_POLICY).filter((key) => !known.has(key))).toEqual([]);
  });

  it('makes public only the reviewed operations, each with its own proof', () => {
    expect(
      OPERATIONS.filter((op) => op.policy === 'public')
        .map((op) => op.key)
        .sort(),
    ).toEqual(
      [
        'GET /api/v1/flags', // flag values only, nothing per workspace
        'GET /api/v1/auth/config', // the sign-in page's settings
        'POST /api/v1/auth/quickpass', // Turnstile and rate limits
        'POST /api/v1/auth/quickpass/consume', // the single-use token
        'POST /api/v1/auth/quickpass/peek', // the token; reads its address, changes nothing
        'POST /api/v1/auth/undo-first-factor', // the single-use token from the first-factor mail
        'GET /api/v1/auth/google', // starts sign-in
        'GET /api/v1/auth/google/callback', // PKCE, state cookie and nonce
        'GET /api/v1/auth/sso/start', // starts sign-in
        'POST /api/v1/auth/sso/start', // starts sign-in, only with the dashboard's Origin
        'GET /api/v1/auth/sso/callback', // PKCE, state cookie and nonce
        'GET /api/v1/payments/connect/callback', // the signed OAuth state
        'POST /api/v1/stripe/webhook', // the Stripe signature
        'POST /api/v1/stripe/webhook/{channelId}', // the signature with that publication's secret
        'POST /api/v1/paypal/webhook/{channelId}', // PayPal's own signature check
        'GET /api/v1/instance', // only whether sign-up is open, for the sign-in page
        'GET /api/v1/public/apps', // the published App Directory, rate limited
        'GET /api/v1/public/apps/{slug}', // one published app
        'GET /api/v1/public/app-manifest.schema.json', // a static schema
        'GET /api/v1/public/email-check-lists/{file}', // a random single-use token, 24 hours at most
      ].sort(),
    );
  });

  it('anchors every role-checked operation on a workspace, a Channel or a known row', () => {
    const loose = OPERATIONS.filter(
      (op) => op.policy && ROLES.includes(op.policy as SeatRole) && !ANCHORS[anchorOf(op) ?? ''],
    ).map((op) => op.key);
    expect(loose, 'declare the anchor in ANCHORS, or the route signed-in').toEqual([]);
  });
});

describe.each(
  OPERATIONS.filter((op) => op.policy && op.policy !== 'public').map((op) => [op.key, op] as const),
)('%s', (_, op) => {
  it('answers 401 when signed out', async () => {
    expect((await request(op, null)).status).toBe(401);
  });

  if (op.policy === 'signed-in') return;
  const minimum = op.policy as SeatRole;

  it("answers 404 to another workspace's operator", async () => {
    const res = await request(op, outsider);
    expect(res.status, await res.clone().text()).toBe(404);
  });

  for (const role of ROLES.slice(0, ROLES.indexOf(minimum))) {
    it(`answers 403 to ${role} (needs ${minimum})`, async () => {
      const res = await request(op, seats[role]);
      expect(res.status, await res.clone().text()).toBe(403);
    });
  }

  if (op.method === 'GET') {
    it(`lets ${minimum} read`, async () => {
      const res = await request(op, seats[minimum]);
      expect([401, 403], await res.clone().text()).not.toContain(res.status);
    });
  }
});
