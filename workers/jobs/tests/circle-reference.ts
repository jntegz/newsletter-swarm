// An in-memory reference for Circle rules, random Members and random rules, for property tests
// that compare the compiled SQL (run in D1) with a straightforward evaluation in JavaScript.
import { env } from 'cloudflare:test';
import type { CircleComparator, CircleLeaf, CircleRule, FieldType } from '@swarm/domain';
import { ENGAGEMENT_BANDS, newId } from '@swarm/domain';

const DAY = 86_400_000;

/** Deterministic PRNG (mulberry32), so a failing seed reproduces. */
export function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    chance: (p: number) => next() < p,
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T,
    some: <T>(list: readonly T[], p = 0.4): T[] => list.filter(() => next() < p),
  };
}
type Rng = ReturnType<typeof prng>;

// ---- The model -------------------------------------------------------------------------------

interface RefField {
  id: string;
  key: string;
  type: FieldType;
  encrypted: boolean;
}

type RefValue = string | number | string[];

interface RefMember {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: string;
  digest: string;
  created_at: number;
  confirmed_at: number | null;
  form_id: string | null;
  source: Record<string, string>;
  /** By field key; numbers for number/boolean, YYYY-MM-DD for dates, arrays for multi-select. */
  fields: Record<string, RefValue>;
  tags: string[];
  opens: number[];
  clicks: number[];
  referrals: number;
  /** Live Circles of the Channel the Member is materialised in (circle_members). */
  circles: string[];
  /** The member_entitlements 'paid' row, if any (current or not). */
  entitlement: { levelId: string | null; startsAt: number; expiresAt: number | null } | null;
  /** The member_engagement row, if any. A row past the freshness limit counts as missing. */
  engagement: { score: number | null; band: string; computedAt: number } | null;
}

export interface RefWorld {
  now: number;
  workspaceId: string;
  channelId: string;
  formIds: string[];
  fields: RefField[];
  tagNames: string[];
  members: RefMember[];
  /** Live Circles, then one deleted Circle that still has circle_members rows. */
  circleIds: string[];
  levelIds: string[];
}

/** ASCII-only case folding, as SQLite's lower() and NOCASE. */
const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const sameText = (a: string, b: string) => fold(a) === fold(b);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const NAMES = ['Ada', 'ada', 'ADA Lovelace', 'Bob', 'bobby', 'Zoë', 'ZOË', 'Ëlan', '', 'Grace'];
const WORDS = ['news', 'Newsletter', 'twitter', 'TikTok', 'ads', 'partner', 'x'];
const TAGS = ['VIP', 'beta', 'Early-Bird', 'zoë'];
const OPTIONS = ['Weekly', 'Monthly', 'Daily'];
const STATUSES = ['pending', 'active', 'paused', 'unsubscribed', 'bounced', 'complained'];
const DIGESTS = ['every', 'weekly', 'monthly'];
const SOURCE_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'referrer',
  'ref',
];
const FIELD_SPECS: { key: string; type: FieldType; encrypted?: boolean }[] = [
  { key: 'company', type: 'text' },
  { key: 'plan', type: 'select' },
  { key: 'topics', type: 'multi_select' },
  { key: 'age', type: 'number' },
  { key: 'vip', type: 'boolean' },
  { key: 'birthday', type: 'date' },
  { key: 'secret', type: 'text', encrypted: true },
];

// ---- Reference evaluation --------------------------------------------------------------------

function textValue(m: RefMember, field: string): string | null {
  if (field.startsWith('source.')) return m.source[field.slice(7)] ?? null;
  return (m as unknown as Record<string, string | null>)[field] ?? null;
}

function textLeaf(v: string | null, cmp: CircleComparator, x: unknown): boolean {
  switch (cmp) {
    case 'eq':
      return v !== null && sameText(v, x as string);
    case 'contains':
      return v !== null && fold(v).includes(fold(x as string));
    case 'starts_with':
      return v !== null && fold(v).startsWith(fold(x as string));
    case 'in':
      return v !== null && (x as string[]).some((item) => sameText(item, v));
    case 'is_set':
      return v !== null && v !== '';
  }
  throw new Error(`text ${cmp}`);
}

function compare(a: number, cmp: CircleComparator, b: number): boolean {
  switch (cmp) {
    case 'eq':
      return a === b;
    case 'gt':
      return a > b;
    case 'gte':
      return a >= b;
    case 'lt':
      return a < b;
    case 'lte':
      return a <= b;
  }
  throw new Error(`compare ${cmp}`);
}

const NEGATED: Partial<Record<CircleComparator, CircleComparator>> = {
  neq: 'eq',
  not_contains: 'contains',
  not_in: 'in',
  is_not_set: 'is_set',
  not_within_days: 'within_days',
};

const instant = (s: string) => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);

function leaf(world: RefWorld, m: RefMember, l: CircleLeaf): boolean {
  const base = NEGATED[l.cmp];
  if (base) return !leaf(world, m, { ...l, cmp: base });
  const { cmp, value: x } = l;
  const cutoff = () => world.now - (x as number) * DAY;
  switch (l.field) {
    case 'email':
    case 'first_name':
    case 'last_name':
      return textLeaf(textValue(m, l.field), cmp, x);
    case 'status':
    case 'digest': {
      const v = l.field === 'status' ? m.status : m.digest;
      return cmp === 'eq' ? v === x : (x as string[]).includes(v);
    }
    case 'form_id':
      if (cmp === 'is_set') return m.form_id !== null;
      if (m.form_id === null) return false;
      return cmp === 'eq' ? m.form_id === x : (x as string[]).includes(m.form_id);
    case 'created_at':
    case 'confirmed_at': {
      const v = l.field === 'created_at' ? m.created_at : m.confirmed_at;
      if (cmp === 'is_set') return v !== null;
      if (v === null) return false;
      if (cmp === 'before') return v < instant(x as string);
      if (cmp === 'after') return v > instant(x as string);
      return v >= cutoff();
    }
    case 'tag':
      if (cmp === 'is_set') return m.tags.length > 0;
      if (cmp === 'eq') return m.tags.some((t) => sameText(t, x as string));
      return m.tags.some((t) => (x as string[]).some((n) => sameText(n, t)));
    case 'opened_days':
      return m.opens.some((t) => t >= cutoff());
    case 'clicked_days':
      return m.clicks.some((t) => t >= cutoff());
    case 'referral_count':
      return compare(m.referrals, cmp, x as number);
    case 'engagement_score': {
      const e = m.engagement;
      if (!e || e.score === null || e.computedAt < world.now - 7 * DAY) return false;
      return compare(e.score, cmp, x as number);
    }
    case 'engagement_band': {
      const e = m.engagement;
      if (!e || e.computedAt < world.now - 7 * DAY) return false;
      return cmp === 'eq' ? e.band === x : (x as string[]).includes(e.band);
    }
    case 'circle':
      // Only live Circles of the Channel count; m.circles never holds a deleted one.
      return cmp === 'eq'
        ? m.circles.includes(x as string)
        : (x as string[]).some((id) => m.circles.includes(id));
    case 'level': {
      const e = m.entitlement;
      const current =
        e !== null && e.startsAt <= world.now && (e.expiresAt === null || e.expiresAt > world.now);
      if (!current) return false;
      if (cmp === 'is_set') return true;
      if (e.levelId === null) return false;
      return cmp === 'eq' ? e.levelId === x : (x as string[]).includes(e.levelId);
    }
  }
  if (l.field.startsWith('source.')) return textLeaf(textValue(m, l.field), cmp, x);
  const key = l.field.slice('field:'.length);
  const field = world.fields.find((f) => f.key === key)!;
  const v = m.fields[key];
  if (cmp === 'is_set') return v !== undefined;
  if (v === undefined) return false;
  switch (field.type) {
    case 'text':
    case 'select':
      return textLeaf(v as string, cmp, x);
    case 'multi_select': {
      const list = v as string[];
      if (cmp === 'contains') return list.some((o) => sameText(o, x as string));
      return list.some((o) => (x as string[]).some((n) => sameText(n, o)));
    }
    case 'number':
      return compare(v as number, cmp, x as number);
    case 'boolean':
      return v === (x ? 1 : 0);
    case 'date': {
      const s = v as string;
      if (cmp === 'eq') return s === x;
      if (cmp === 'before') return s < (x as string);
      if (cmp === 'after') return s > (x as string);
      return s >= day(cutoff()) && s <= day(world.now);
    }
  }
}

function evaluate(world: RefWorld, m: RefMember, rule: CircleRule): boolean {
  if ('op' in rule) {
    if (rule.op === 'and') return rule.children.every((c) => evaluate(world, m, c));
    if (rule.op === 'or') return rule.children.some((c) => evaluate(world, m, c));
    return !evaluate(world, m, rule.children[0]!);
  }
  return leaf(world, m, rule);
}

export const expected = (world: RefWorld, rule: CircleRule) =>
  world.members
    .filter((m) => evaluate(world, m, rule))
    .map((m) => m.id)
    .sort();

// ---- Random rules ----------------------------------------------------------------------------

function randomText(rng: Rng): string {
  const pool = [...NAMES.filter(Boolean), ...WORDS, 'a', 'Lo', 'zo', 'example', '@'];
  return rng.pick(pool);
}

function randomInstant(rng: Rng, now: number): string {
  const ms = now - rng.int(-5, 120) * DAY + rng.int(0, DAY);
  return rng.chance(0.5) ? day(ms) : new Date(ms).toISOString();
}

/** A random valid leaf from the comparator matrix. */
function randomLeaf(rng: Rng, world: RefWorld): CircleLeaf {
  if (rng.chance(0.1)) {
    if (rng.chance(0.5)) {
      return {
        field: 'engagement_score',
        cmp: rng.pick(['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const),
        value: rng.pick([0, 10, 30, 50, 60, 100]),
      };
    }
    const cmp = rng.pick(['eq', 'neq', 'in', 'not_in'] as const);
    const band = () => rng.pick(ENGAGEMENT_BANDS);
    return {
      field: 'engagement_band',
      cmp,
      value: cmp === 'eq' || cmp === 'neq' ? band() : [band(), band()],
    };
  }
  const kind = rng.int(0, 13);
  const textCmp = (): CircleLeaf['cmp'] =>
    rng.pick([
      'eq',
      'neq',
      'contains',
      'not_contains',
      'starts_with',
      'in',
      'not_in',
      'is_set',
      'is_not_set',
    ] as const);
  const textArg = (cmp: CircleComparator) =>
    cmp === 'in' || cmp === 'not_in'
      ? [randomText(rng), randomText(rng)]
      : cmp === 'is_set' || cmp === 'is_not_set'
        ? undefined
        : randomText(rng);
  switch (kind) {
    case 0:
    case 1: {
      const field = rng.pick([
        'email',
        'first_name',
        'last_name',
        'source.utm_source',
        'source.ref',
      ]);
      const cmp = textCmp();
      return { field, cmp, value: textArg(cmp) };
    }
    case 2: {
      const field = rng.pick(['status', 'digest'] as const);
      const values = field === 'status' ? STATUSES : DIGESTS;
      const cmp = rng.pick(['eq', 'neq', 'in', 'not_in'] as const);
      return {
        field,
        cmp,
        value:
          cmp === 'eq' || cmp === 'neq'
            ? rng.pick(values)
            : rng.some(values, 0.5).concat(values[0]!),
      };
    }
    case 3: {
      const cmp = rng.pick(['eq', 'neq', 'in', 'not_in', 'is_set', 'is_not_set'] as const);
      const value =
        cmp === 'eq' || cmp === 'neq'
          ? rng.pick(world.formIds)
          : cmp === 'in' || cmp === 'not_in'
            ? [rng.pick(world.formIds)]
            : undefined;
      return { field: 'form_id', cmp, value };
    }
    case 4: {
      const field = rng.pick(['created_at', 'confirmed_at'] as const);
      const cmp = rng.pick([
        'before',
        'after',
        'within_days',
        'not_within_days',
        'is_set',
        'is_not_set',
      ] as const);
      const value =
        cmp === 'before' || cmp === 'after'
          ? randomInstant(rng, world.now)
          : cmp === 'within_days' || cmp === 'not_within_days'
            ? rng.int(1, 90)
            : undefined;
      return { field, cmp, value };
    }
    case 5: {
      const cmp = rng.pick(['eq', 'neq', 'in', 'not_in', 'is_set', 'is_not_set'] as const);
      const name = () => {
        const t = rng.pick([...TAGS, 'missing']);
        return rng.chance(0.3) ? t.toUpperCase() : t;
      };
      const value =
        cmp === 'eq' || cmp === 'neq'
          ? name()
          : cmp === 'in' || cmp === 'not_in'
            ? [name(), name()]
            : undefined;
      return { field: 'tag', cmp, value };
    }
    case 6:
      return {
        field: rng.pick(['opened_days', 'clicked_days']),
        cmp: rng.pick(['within_days', 'not_within_days'] as const),
        value: rng.int(1, 60),
      };
    case 7:
      return {
        field: 'referral_count',
        cmp: rng.pick(['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const),
        value: rng.int(0, 3),
      };
    case 8: {
      const cmp = rng.pick(['eq', 'neq', 'in', 'not_in'] as const);
      const id = () => rng.pick(world.circleIds);
      return { field: 'circle', cmp, value: cmp === 'eq' || cmp === 'neq' ? id() : [id(), id()] };
    }
    case 9: {
      const cmp = rng.pick(['eq', 'neq', 'in', 'not_in', 'is_set', 'is_not_set'] as const);
      const id = () => rng.pick(world.levelIds);
      return {
        field: 'level',
        cmp,
        value:
          cmp === 'eq' || cmp === 'neq'
            ? id()
            : cmp === 'in' || cmp === 'not_in'
              ? [id()]
              : undefined,
      };
    }
    default:
      return randomFieldLeaf(rng, world);
  }
}

function randomFieldLeaf(rng: Rng, world: RefWorld): CircleLeaf {
  const field = rng.pick(world.fields);
  const name = `field:${field.key}`;
  const set = rng.pick(['is_set', 'is_not_set'] as const);
  if (field.encrypted || rng.chance(0.1)) return { field: name, cmp: set };
  switch (field.type) {
    case 'text': {
      const cmp = rng.pick([
        'eq',
        'neq',
        'contains',
        'not_contains',
        'starts_with',
        'in',
        'not_in',
      ] as const);
      return {
        field: name,
        cmp,
        value:
          cmp === 'in' || cmp === 'not_in'
            ? [randomText(rng), 'Acme']
            : rng.pick(['Acme', 'acme inc', 'ac', 'Globex', 'x']),
      };
    }
    case 'select': {
      const cmp = rng.pick(['eq', 'neq', 'in', 'not_in'] as const);
      const option = () => (rng.chance(0.3) ? rng.pick(OPTIONS).toLowerCase() : rng.pick(OPTIONS));
      return {
        field: name,
        cmp,
        value: cmp === 'eq' || cmp === 'neq' ? option() : [option(), option()],
      };
    }
    case 'multi_select': {
      const cmp = rng.pick(['contains', 'not_contains', 'in', 'not_in'] as const);
      return {
        field: name,
        cmp,
        value:
          cmp === 'contains' || cmp === 'not_contains' ? rng.pick(OPTIONS) : [rng.pick(OPTIONS)],
      };
    }
    case 'number':
      return {
        field: name,
        cmp: rng.pick(['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const),
        value: rng.pick([0, 1, 2.5, 18, 30, -1, 65]),
      };
    case 'boolean':
      return { field: name, cmp: rng.pick(['eq', 'neq'] as const), value: rng.chance(0.5) };
    case 'date': {
      const cmp = rng.pick([
        'eq',
        'neq',
        'before',
        'after',
        'within_days',
        'not_within_days',
      ] as const);
      const value =
        cmp === 'within_days' || cmp === 'not_within_days'
          ? rng.int(1, 60)
          : day(world.now - rng.int(-30, 60) * DAY);
      return { field: name, cmp, value };
    }
  }
}

export function randomRule(
  rng: Rng,
  world: RefWorld,
  depth = 1,
  maxDepth = 5,
  maxChildren = 4,
): CircleRule {
  // Narrow trees (maxChildren 2) are kept deep by stopping early less often.
  const stop = maxChildren > 2 ? 0.45 : 0.1;
  if (depth >= maxDepth || rng.chance(depth === 1 ? 0.25 : stop)) return randomLeaf(rng, world);
  const op = rng.pick(['and', 'or', 'or', 'not'] as const);
  const child = () => randomRule(rng, world, depth + 1, maxDepth, maxChildren);
  if (op === 'not') return { op, children: [child()] };
  return { op, children: Array.from({ length: rng.int(1, maxChildren) }, child) };
}

// ---- Seeding ---------------------------------------------------------------------------------

/** Writes a random Channel of `count` Members to D1 and returns the model of it. */
export async function seedWorld(rng: Rng, count: number, now = Date.now()): Promise<RefWorld> {
  const db = env.DB;
  const workspaceId = newId('workspace');
  const channelId = newId('channel');
  const formIds = [newId('captureForm'), newId('captureForm')];
  const dispatchId = newId('dispatch');
  const broadcastIds = [newId('broadcast'), newId('broadcast'), newId('broadcast')];
  const statements: D1PreparedStatement[] = [
    db
      .prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)')
      .bind(workspaceId, 'Reference', now),
    db
      .prepare(
        `INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'Reference', ?4, ?4)`,
      )
      .bind(channelId, workspaceId, `ref-${crypto.randomUUID().slice(0, 12)}`, now),
    ...formIds.map((id) =>
      db
        .prepare(
          `INSERT INTO capture_forms (id, workspace_id, channel_id, name, draft_config_json, created_at, updated_at)
           VALUES (?1, ?2, ?3, 'Form', '{}', ?4, ?4)`,
        )
        .bind(id, workspaceId, channelId, now),
    ),
    db
      .prepare(
        `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
         VALUES (?1, ?2, 'Issue', '{}', 'sent', ?3, ?3)`,
      )
      .bind(dispatchId, channelId, now),
    ...broadcastIds.map((id) =>
      db
        .prepare(
          `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
             from_name, from_address, track_opens, created_at, last_progress_at)
           VALUES (?1, ?2, ?3, ?4, 'sent', 'Issue', '', '', '', 'Ref', 'ref@mail.test', 1, ?5, ?5)`,
        )
        .bind(id, dispatchId, channelId, workspaceId, now),
    ),
  ];

  const fields: RefField[] = FIELD_SPECS.map((spec) => ({
    id: newId('memberField'),
    key: spec.key,
    type: spec.type,
    encrypted: spec.encrypted ?? false,
  }));
  for (const [i, f] of fields.entries()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO member_fields (id, channel_id, key, label, type, options_json, encrypted, position, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
        )
        .bind(f.id, channelId, f.key, f.type, JSON.stringify(OPTIONS), f.encrypted ? 1 : 0, i, now),
    );
  }
  const tagIds = new Map(TAGS.map((name) => [name, newId('tag')]));
  for (const [name, id] of tagIds) {
    statements.push(
      db
        .prepare('INSERT INTO tags (id, channel_id, name, created_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(id, channelId, name, now),
    );
  }

  const members: RefMember[] = [];
  for (let i = 0; i < count; i++) {
    const created = now - rng.int(0, 120) * DAY - rng.int(0, DAY);
    const m: RefMember = {
      id: newId('member', now - i),
      email: `${rng.pick(['ada', 'Bob', 'zoë', 'news', 'x'])}.${i}@${rng.pick(['Example.org', 'mail.test', 'news.io'])}`,
      first_name: rng.chance(0.8) ? rng.pick(NAMES) : null,
      last_name: rng.chance(0.5) ? rng.pick(['Lovelace', 'Hopper', 'lovelace', 'Zoë']) : null,
      status: rng.pick(STATUSES),
      digest: rng.pick(DIGESTS),
      created_at: created,
      confirmed_at: rng.chance(0.6) ? created + rng.int(0, 5) * DAY : null,
      form_id: rng.chance(0.6) ? rng.pick(formIds) : null,
      source: Object.fromEntries(
        SOURCE_KEYS.filter(() => rng.chance(0.4)).map((k) => [k, rng.pick(WORDS)]),
      ),
      fields: {},
      tags: rng.some(TAGS, 0.35),
      opens: [],
      clicks: [],
      referrals: 0,
      circles: [],
      entitlement: null,
      engagement: rng.chance(0.7)
        ? (() => {
            const hidden = rng.chance(0.2);
            return {
              score: hidden ? null : rng.pick([0, 10, 29, 30, 50, 60, 100]),
              band: hidden
                ? rng.pick(['too_few_posts', 'opens_hidden'] as const)
                : rng.pick(['very_engaged', 'engaged', 'slipping', 'cold'] as const),
              // Some rows are past the freshness limit and must count as missing.
              computedAt: now - rng.int(0, 10) * DAY,
            };
          })()
        : null,
    };
    for (const f of fields) {
      if (!rng.chance(0.6)) continue;
      m.fields[f.key] =
        f.encrypted || f.type === 'text'
          ? rng.pick(['Acme', 'ACME Inc', 'Globex', 'acme'])
          : f.type === 'select'
            ? rng.pick(OPTIONS)
            : f.type === 'multi_select'
              ? OPTIONS.filter(() => rng.chance(0.5))
              : f.type === 'number'
                ? rng.pick([0, 1, 2.5, 18, 30, 64, -1])
                : f.type === 'boolean'
                  ? rng.int(0, 1)
                  : day(now - rng.int(-40, 80) * DAY);
      if (Array.isArray(m.fields[f.key]) && (m.fields[f.key] as string[]).length === 0) {
        delete m.fields[f.key];
      }
    }
    members.push(m);
  }
  // Referrals: each referred Member once, by someone else.
  const referrals: [string, string][] = [];
  for (const m of members) {
    if (!rng.chance(0.3)) continue;
    const by = rng.pick(members);
    if (by.id === m.id) continue;
    by.referrals++;
    referrals.push([by.id, m.id]);
  }

  for (const m of members) {
    statements.push(
      db
        .prepare(
          `INSERT INTO members (id, channel_id, email, first_name, last_name, status, digest, source_json, form_id,
             confirmed_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
        )
        .bind(
          m.id,
          channelId,
          m.email,
          m.first_name,
          m.last_name,
          m.status,
          m.digest,
          JSON.stringify(m.source),
          m.form_id,
          m.confirmed_at,
          m.created_at,
        ),
    );
    for (const name of m.tags) {
      statements.push(
        db
          .prepare('INSERT INTO member_tags (member_id, tag_id, created_at) VALUES (?1, ?2, ?3)')
          .bind(m.id, tagIds.get(name)!, now),
      );
    }
    for (const f of fields) {
      const v = m.fields[f.key];
      if (v === undefined) continue;
      const enc = f.encrypted ? `k1.iv.${btoa(String(v))}` : null;
      const text = f.encrypted
        ? null
        : f.type === 'multi_select'
          ? JSON.stringify(v)
          : typeof v === 'string'
            ? v
            : null;
      const num = !f.encrypted && typeof v === 'number' ? v : null;
      statements.push(
        db
          .prepare(
            `INSERT INTO member_field_values (member_id, field_id, value_text, value_num, value_enc, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          )
          .bind(m.id, f.id, text, num, enc, now),
      );
    }
    for (const broadcastId of broadcastIds) {
      if (!rng.chance(0.5)) continue;
      const sent = now - rng.int(0, 90) * DAY;
      const opened = rng.chance(0.5) ? sent + rng.int(0, 3) * DAY : null;
      const clicked = opened !== null && rng.chance(0.5) ? opened : null;
      // A machine open sets opened_at only: it must never count.
      const machine = opened === null && rng.chance(0.5) ? sent : null;
      if (opened !== null) m.opens.push(opened);
      if (clicked !== null) m.clicks.push(clicked);
      statements.push(
        db
          .prepare(
            `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at,
               opened_at, human_opened_at, clicked_at, human_clicked_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'delivered', ?6, ?7, ?8, ?9, ?9)`,
          )
          .bind(
            newId('delivery'),
            broadcastId,
            channelId,
            m.id,
            m.email,
            sent,
            opened ?? machine,
            opened,
            clicked,
          ),
      );
    }
  }
  for (const m of members) {
    if (!m.engagement) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO member_engagement
             (member_id, channel_id, score, band, sent_count, opened_count, clicked_count, computed_at)
           VALUES (?1, ?2, ?3, ?4, 5, 1, 0, ?5)`,
        )
        .bind(m.id, channelId, m.engagement.score, m.engagement.band, m.engagement.computedAt),
    );
  }
  for (const [referrer, referred] of referrals) {
    statements.push(
      db
        .prepare(
          `INSERT INTO referrals (id, channel_id, referrer_id, referred_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(newId('referral'), channelId, referrer, referred, now),
    );
  }
  // Circles (Phase 6 `circle` leaf): three live ones and a deleted one, with materialised members.
  const circleIds = [newId('circle'), newId('circle'), newId('circle'), newId('circle')];
  for (const [i, id] of circleIds.entries()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, status, created_at, updated_at, deleted_at)
           VALUES (?1, ?2, ?3, ?4, '{"field":"email","cmp":"is_set"}', 'ready', ?5, ?5, ?6)`,
        )
        .bind(id, workspaceId, channelId, `Circle ${i}`, now, i === 3 ? now : null),
    );
    for (const m of members) {
      if (!rng.chance(0.4)) continue;
      if (i < 3) m.circles.push(id);
      statements.push(
        db
          .prepare(
            'INSERT INTO circle_members (circle_id, member_id, generation) VALUES (?1, ?2, 0)',
          )
          .bind(id, m.id),
      );
    }
  }
  // Membership levels (Phase 6 `level` leaf): current, expired and future entitlements.
  const levelIds = [newId('membershipLevel'), newId('membershipLevel')];
  for (const id of levelIds) {
    statements.push(
      db
        .prepare(
          'INSERT INTO membership_levels (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
        )
        .bind(id, channelId, 'Level', now),
    );
  }
  for (const m of members) {
    if (!rng.chance(0.6)) continue;
    const when = rng.pick(['current', 'current', 'open', 'expired', 'future'] as const);
    m.entitlement = {
      levelId: rng.chance(0.15) ? null : rng.pick(levelIds),
      startsAt: when === 'future' ? now + DAY : now - rng.int(1, 60) * DAY,
      expiresAt:
        when === 'expired' ? now - DAY : when === 'open' ? null : now + rng.int(1, 30) * DAY,
    };
    statements.push(
      db
        .prepare(
          `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at, expires_at, level_id)
           VALUES (?1, ?2, 'paid', 'stripe', ?3, ?4, ?5)`,
        )
        .bind(
          m.id,
          channelId,
          m.entitlement.startsAt,
          m.entitlement.expiresAt,
          m.entitlement.levelId,
        ),
    );
  }
  for (let i = 0; i < statements.length; i += 200) await db.batch(statements.slice(i, i + 200));
  return {
    now,
    workspaceId,
    channelId,
    formIds,
    fields,
    tagNames: TAGS,
    members,
    circleIds,
    levelIds,
  };
}
