/**
 * Circles: a nested rule tree compiled to parameterised SQL over `members m` for one Channel.
 *
 * Safety:
 * - Leaf fields come from a fixed whitelist; every column name and JSON path in the SQL is a
 *   constant in this file. Profile fields are resolved by key to an id at compile time.
 * - Every value is bound. D1 allows at most 100 bound parameters per statement, and a rule can
 *   have 100 conditions, so all values travel in ONE parameter, `?1`, a JSON array. The SQL
 *   refers to them only by array index (`json_extract(?1, '$[3]')`), so no value ever appears in
 *   the SQL text. Callers bind `params` first and number their own parameters from `?2`.
 * - Every condition compiles to an expression that is 0 or 1, never NULL, so `not` groups and
 *   exclusions behave as plain negation (SQL's three-valued logic would otherwise drop rows).
 *
 * Semantics (mirrored by the reference evaluator in workers/jobs/tests):
 * - Text compares case-insensitively (ASCII folding, as SQLite's lower()).
 * - The negative comparators are exact negations: neq = not eq, not_contains = not contains,
 *   not_in = not in, is_not_set = not is_set, not_within_days = not within_days. So "first name is
 *   not Ada" includes Members with no first name.
 * - A condition on a missing value is false (before/after/eq/contains/...).
 * - `circle` (Phase 6) tests the materialised membership of a live Circle of the same Channel
 *   (circle_members, as of its last refresh); `level` tests the Member's current paid entitlement
 *   (member_entitlements: started, not expired) and its level; is_set = any current one. An id
 *   from another Channel matches nobody: both subqueries are scoped to this Channel.
 * - `email_check` tests the address's email check colour in the workspace (email_checks), or
 *   'unchecked' when it has none.
 * - `engagement_score` and `engagement_band` (Phase 8) test the Member's current row in
 *   member_engagement. A Member with no score, or a row past ENGAGEMENT_FRESH_MS, has a missing
 *   value, so "score below 20" leaves them out and only the negative comparators include them.
 */
import {
  CIRCLE_MAX_DEPTH,
  CircleRuleSchema,
  DIGESTS,
  EMAIL_CHECK_STATES,
  ENGAGEMENT_BANDS,
  FieldKeySchema,
  MEMBER_STATUSES,
  hasRosters,
  type CircleComparator,
  type CircleLeaf,
  type CircleRule,
  type DispatchAudience,
  type FieldType,
} from '@swarm/domain';
import { all, first } from './db';
import { ENGAGEMENT_FRESH_MS, engagementEnabled } from './engagement';
import type { JobQueue } from './jobs';
import { utcDay } from './ramp';
import { liveRosterIds, parseRosterAudience, rosterAudienceSql, rostersEnabled } from './rosters';

/** A rule that can't be compiled: an unknown field, or a comparator or value that doesn't fit. */
export class CircleRuleError extends Error {
  constructor(
    message: string,
    /** Where in the rule, e.g. `children.1.value`. */
    readonly path: string = '',
  ) {
    super(message);
    this.name = 'CircleRuleError';
  }
}

export interface CircleField {
  id: string;
  key: string;
  type: FieldType;
  encrypted: boolean;
  /** Choices of select and multi-select fields. */
  options?: readonly string[];
}

export interface CompileOptions {
  channelId: string;
  /** Profile fields of the Channel, by key. Only the keys the rule uses need to be present. */
  fields: ReadonlyMap<string, CircleField>;
  /** "Within the last N days" is measured from here (ms). */
  now: number;
}

export interface CompiledCircle {
  /** A boolean expression over `members m`. */
  where: string;
  /** Bind first: `?1` is the JSON array of every value. */
  params: [string];
}

/** Collects values; the SQL only ever names them by index. */
export class CircleValues {
  readonly values: unknown[] = [];

  /** A scalar value (string or number). */
  ref(value: string | number): string {
    this.values.push(value);
    return `json_extract(?1, '$[${this.values.length - 1}]')`;
  }

  /** A list, as the table-valued `json_each(...)` with one row per item in `value`. */
  each(values: readonly (string | number)[]): string {
    this.values.push(values);
    return `json_each(?1, '$[${this.values.length - 1}]')`;
  }

  /** A list, as a subquery yielding `value`. */
  list(values: readonly (string | number)[]): string {
    return `(SELECT value FROM ${this.each(values)})`;
  }

  params(): [string] {
    return [JSON.stringify(this.values)];
  }
}

// ---- The leaf whitelist ----------------------------------------------------------------------

type Kind =
  | 'text'
  | 'enum'
  | 'ref'
  | 'time'
  | 'field'
  | 'tag'
  | 'engagement'
  | 'count'
  | 'circle'
  | 'level'
  | 'score'
  | 'band';

interface ColumnLeaf {
  kind: 'text' | 'enum' | 'ref' | 'time';
  /** SQL for the value. Constant text from this file only. */
  sql: string;
  /** Never NULL, so comparisons need no NULL guard. */
  notNull?: boolean;
  /** Allowed values, for enums. */
  values?: readonly string[];
}

const COLUMNS: Record<string, ColumnLeaf> = {
  email: { kind: 'text', sql: 'm.email', notNull: true },
  first_name: { kind: 'text', sql: 'm.first_name' },
  last_name: { kind: 'text', sql: 'm.last_name' },
  status: { kind: 'enum', sql: 'm.status', notNull: true, values: MEMBER_STATUSES },
  digest: { kind: 'enum', sql: 'm.digest', notNull: true, values: DIGESTS },
  created_at: { kind: 'time', sql: 'm.created_at', notNull: true },
  confirmed_at: { kind: 'time', sql: 'm.confirmed_at' },
  form_id: { kind: 'ref', sql: 'm.form_id' },
  // Email checks (0068): the address's colour in the Channel's workspace, or 'unchecked'.
  email_check: {
    kind: 'enum',
    sql: `coalesce((SELECT ec.state FROM email_checks ec
      WHERE ec.workspace_id = (SELECT c.workspace_id FROM channels c WHERE c.id = m.channel_id)
        AND ec.email = m.email), 'unchecked')`,
    notNull: true,
    values: EMAIL_CHECK_STATES,
  },
};

export const CIRCLE_SOURCE_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'referrer',
  'ref',
] as const;
for (const key of CIRCLE_SOURCE_KEYS) {
  COLUMNS[`source.${key}`] = { kind: 'text', sql: `json_extract(m.source_json, '$.${key}')` };
}

const TEXT_CMPS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'starts_with',
  'in',
  'not_in',
  'is_set',
  'is_not_set',
] as const;
const ORDER_CMPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const;
const TIME_CMPS = ['before', 'after', 'within_days', 'not_within_days', 'is_set', 'is_not_set'];

/** Which comparators each kind of leaf accepts. Exported for the builder UI and the tests. */
export const CIRCLE_COMPARATORS_BY_KIND: Record<string, readonly CircleComparator[]> = {
  text: TEXT_CMPS,
  enum: ['eq', 'neq', 'in', 'not_in'],
  ref: ['eq', 'neq', 'in', 'not_in', 'is_set', 'is_not_set'],
  time: TIME_CMPS as CircleComparator[],
  'field:text': TEXT_CMPS,
  'field:select': ['eq', 'neq', 'in', 'not_in', 'is_set', 'is_not_set'],
  'field:multi_select': ['contains', 'not_contains', 'in', 'not_in', 'is_set', 'is_not_set'],
  'field:number': [...ORDER_CMPS, 'is_set', 'is_not_set'],
  'field:boolean': ['eq', 'neq', 'is_set', 'is_not_set'],
  'field:date': ['eq', 'neq', ...(TIME_CMPS as CircleComparator[])],
  'field:encrypted': ['is_set', 'is_not_set'],
  tag: ['eq', 'neq', 'in', 'not_in', 'is_set', 'is_not_set'],
  engagement: ['within_days', 'not_within_days'],
  count: ORDER_CMPS,
  circle: ['eq', 'neq', 'in', 'not_in'],
  level: ['eq', 'neq', 'in', 'not_in', 'is_set', 'is_not_set'],
  score: ORDER_CMPS,
  band: ['eq', 'neq', 'in', 'not_in'],
};

const NEGATIONS: Partial<Record<CircleComparator, CircleComparator>> = {
  neq: 'eq',
  not_contains: 'contains',
  not_in: 'in',
  is_not_set: 'is_set',
  not_within_days: 'within_days',
};

const DAY_MS = 86_400_000;
/** ASCII case folding, exactly as SQLite's lower() and NOCASE. */
const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
export const CIRCLE_MAX_DAYS = 3650;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

// ---- Value checks ----------------------------------------------------------------------------

function fail(path: string, message: string): never {
  throw new CircleRuleError(message, path);
}

function text(leaf: CircleLeaf, path: string): string {
  if (typeof leaf.value !== 'string' || leaf.value.length === 0) fail(path, 'Enter a value.');
  return leaf.value;
}

function textList(leaf: CircleLeaf, path: string): string[] {
  const list = leaf.value;
  if (!Array.isArray(list) || list.length === 0) fail(path, 'Pick at least one value.');
  if (list.length > 100) fail(path, 'Pick at most 100 values.');
  return list.map((item) => {
    if (typeof item !== 'string' || item.length === 0) fail(path, 'Each value must be text.');
    return item;
  });
}

function number(leaf: CircleLeaf, path: string): number {
  if (typeof leaf.value !== 'number' || !Number.isFinite(leaf.value)) fail(path, 'Enter a number.');
  return leaf.value;
}

function count(leaf: CircleLeaf, path: string): number {
  const n = number(leaf, path);
  if (!Number.isInteger(n) || n < 0) fail(path, 'Enter a whole number, 0 or more.');
  return n;
}

function days(leaf: CircleLeaf, path: string): number {
  const n = number(leaf, path);
  if (!Number.isInteger(n) || n < 1 || n > CIRCLE_MAX_DAYS)
    fail(path, `Enter a number of days from 1 to ${CIRCLE_MAX_DAYS}.`);
  return n;
}

function instant(leaf: CircleLeaf, path: string): number {
  const value = leaf.value;
  if (typeof value !== 'string' || !DATETIME.test(value)) fail(path, 'Use a date like 2026-10-27.');
  const ms = Date.parse(DATE.test(value) ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(ms)) fail(path, 'That date does not exist.');
  return ms;
}

function day(leaf: CircleLeaf, path: string): string {
  const value = leaf.value;
  if (typeof value !== 'string' || !DATE.test(value)) fail(path, 'Use a date like 2026-10-27.');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    fail(path, 'That date does not exist.');
  return value;
}

function bool(leaf: CircleLeaf, path: string): 0 | 1 {
  if (typeof leaf.value !== 'boolean') fail(path, 'Choose yes or no.');
  return leaf.value ? 1 : 0;
}

// ---- Compiling -------------------------------------------------------------------------------

/** Circle and Membership level ids a rule refers to, for checking they belong to a Channel. */
export function circleRuleRefs(
  rule: CircleRule,
  into = { circles: new Set<string>(), levels: new Set<string>() },
): { circles: Set<string>; levels: Set<string> } {
  if ('op' in rule) {
    for (const child of rule.children) circleRuleRefs(child, into);
  } else if (rule.field === 'circle' || rule.field === 'level') {
    const target = rule.field === 'circle' ? into.circles : into.levels;
    const values = Array.isArray(rule.value) ? rule.value : [rule.value];
    for (const value of values) if (typeof value === 'string') target.add(value);
  }
  return into;
}

/** True when a rule tests the engagement score. */
export function ruleUsesEngagement(rule: CircleRule): boolean {
  if ('op' in rule) return rule.children.some(ruleUsesEngagement);
  return rule.field === 'engagement_score' || rule.field === 'engagement_band';
}

/**
 * Refuses a rule that names a Circle or Membership level outside `channelId` (or a deleted
 * Circle), or tests the engagement score while it is off. Compiling alone would only make such a
 * condition match nobody; saving it is an error.
 */
export async function checkCircleRuleRefs(
  db: D1Database,
  channelId: string,
  rule: CircleRule,
): Promise<void> {
  if (ruleUsesEngagement(rule) && !(await engagementEnabled(db, channelId))) {
    throw new CircleRuleError('Engagement scores are off for this publication.', 'field');
  }
  const { circles, levels } = circleRuleRefs(rule);
  if (circles.size) {
    const row = await first<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM circles WHERE channel_id = ?1 AND deleted_at IS NULL
          AND id IN (SELECT value FROM json_each(?2))`,
      channelId,
      JSON.stringify([...circles]),
    );
    if ((row?.n ?? 0) !== circles.size)
      throw new CircleRuleError('Choose segments from this publication.', 'value');
  }
  if (levels.size) {
    const row = await first<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM membership_levels WHERE channel_id = ?1
          AND id IN (SELECT value FROM json_each(?2))`,
      channelId,
      JSON.stringify([...levels]),
    );
    if ((row?.n ?? 0) !== levels.size)
      throw new CircleRuleError('Choose paid plans from this publication.', 'value');
  }
}

/** Field keys a rule refers to (`field:<key>`), for loading their definitions. */
export function circleFieldKeys(rule: CircleRule, into = new Set<string>()): Set<string> {
  if ('op' in rule) {
    for (const child of rule.children) circleFieldKeys(child, into);
  } else if (rule.field.startsWith('field:')) {
    into.add(rule.field.slice('field:'.length));
  }
  return into;
}

interface Resolved {
  kind: Kind;
  /** Matrix key into CIRCLE_COMPARATORS_BY_KIND. */
  matrix: string;
  column?: ColumnLeaf;
  field?: CircleField;
  engagement?: 'human_opened_at' | 'human_clicked_at';
}

function resolve(leaf: CircleLeaf, options: CompileOptions, path: string): Resolved {
  const name = leaf.field;
  const column = Object.hasOwn(COLUMNS, name) ? COLUMNS[name] : undefined;
  if (column) return { kind: column.kind, matrix: column.kind, column };
  if (name === 'tag') return { kind: 'tag', matrix: 'tag' };
  if (name === 'opened_days')
    return { kind: 'engagement', matrix: 'engagement', engagement: 'human_opened_at' };
  if (name === 'clicked_days')
    return { kind: 'engagement', matrix: 'engagement', engagement: 'human_clicked_at' };
  if (name === 'referral_count') return { kind: 'count', matrix: 'count' };
  if (name === 'circle') return { kind: 'circle', matrix: 'circle' };
  if (name === 'level') return { kind: 'level', matrix: 'level' };
  if (name === 'engagement_score') return { kind: 'score', matrix: 'score' };
  if (name === 'engagement_band') return { kind: 'band', matrix: 'band' };
  if (name.startsWith('field:')) {
    const key = name.slice('field:'.length);
    if (!FieldKeySchema.safeParse(key).success) fail(`${path}field`, 'That is not a field key.');
    const field = options.fields.get(key);
    if (!field) fail(`${path}field`, `There is no profile field called ${key}.`);
    return {
      kind: 'field',
      matrix: field.encrypted ? 'field:encrypted' : `field:${field.type}`,
      field,
    };
  }
  return fail(`${path}field`, 'Segments can’t filter on that.');
}

/** The positive form of a leaf: an expression that is 0 or 1, never NULL. */
function positive(
  leaf: CircleLeaf,
  cmp: CircleComparator,
  r: Resolved,
  options: CompileOptions,
  v: CircleValues,
  path: string,
): string {
  const at = `${path}value`;
  // Wraps a comparison that is NULL when the value is missing.
  const nn = (expr: string, notNull?: boolean) => (notNull ? `(${expr})` : `ifnull(${expr}, 0)`);
  const cutoff = () => options.now - days(leaf, at) * DAY_MS;

  switch (r.kind) {
    case 'text': {
      const col = r.column as ColumnLeaf;
      switch (cmp) {
        case 'eq':
          return nn(`lower(${col.sql}) = lower(${v.ref(text(leaf, at))})`);
        case 'contains':
          return nn(`instr(lower(${col.sql}), lower(${v.ref(text(leaf, at))})) > 0`);
        case 'starts_with':
          return nn(`instr(lower(${col.sql}), lower(${v.ref(text(leaf, at))})) = 1`);
        case 'in':
          return nn(
            `lower(${col.sql}) IN (SELECT lower(value) FROM ${v.each(textList(leaf, at))})`,
          );
        case 'is_set':
          return `(ifnull(${col.sql}, '') <> '')`;
      }
      break;
    }
    case 'enum': {
      const col = r.column as ColumnLeaf;
      const check = (value: string) => {
        if (!col.values?.includes(value)) fail(at, `Pick one of: ${col.values?.join(', ')}.`);
        return value;
      };
      if (cmp === 'eq') return `(${col.sql} = ${v.ref(check(text(leaf, at)))})`;
      if (cmp === 'in') return `(${col.sql} IN ${v.list(textList(leaf, at).map(check))})`;
      break;
    }
    case 'ref': {
      const col = r.column as ColumnLeaf;
      if (cmp === 'eq') return nn(`${col.sql} = ${v.ref(text(leaf, at))}`);
      if (cmp === 'in') return nn(`${col.sql} IN ${v.list(textList(leaf, at))}`);
      if (cmp === 'is_set') return `(${col.sql} IS NOT NULL)`;
      break;
    }
    case 'time': {
      const col = r.column as ColumnLeaf;
      if (cmp === 'before') return nn(`${col.sql} < ${v.ref(instant(leaf, at))}`, col.notNull);
      if (cmp === 'after') return nn(`${col.sql} > ${v.ref(instant(leaf, at))}`, col.notNull);
      if (cmp === 'within_days') return nn(`${col.sql} >= ${v.ref(cutoff())}`, col.notNull);
      if (cmp === 'is_set') return `(${col.sql} IS NOT NULL)`;
      break;
    }
    case 'field': {
      const field = r.field as CircleField;
      const fid = v.ref(field.id);
      // Membership in the set of Members whose stored value passes `cond`. The member_id column
      // is never NULL, so IN is never NULL either.
      const has = (cond: string, from = 'member_field_values v') =>
        `(m.id IN (SELECT v.member_id FROM ${from} WHERE v.field_id = ${fid} AND ${cond}))`;
      if (cmp === 'is_set')
        return has(
          '(v.value_text IS NOT NULL OR v.value_num IS NOT NULL OR v.value_enc IS NOT NULL)',
        );
      if (field.encrypted) break;
      if (field.type === 'select') {
        // Stored values are always in an option's own spelling, so a value that names an option
        // compares exactly and can use the (field_id, value_text) index. Anything else compares
        // like text below.
        const canonical = (value: string) =>
          field.options?.find((option) => fold(option) === fold(value));
        if (cmp === 'eq') {
          const option = canonical(text(leaf, at));
          if (option) return has(`v.value_text = ${v.ref(option)}`);
        }
        if (cmp === 'in') {
          const options = textList(leaf, at).map(canonical);
          if (options.every(Boolean)) return has(`v.value_text IN ${v.list(options as string[])}`);
        }
      }
      switch (field.type) {
        case 'text':
        case 'select':
          if (cmp === 'eq') return has(`lower(v.value_text) = lower(${v.ref(text(leaf, at))})`);
          if (cmp === 'in')
            return has(
              `lower(v.value_text) IN (SELECT lower(value) FROM ${v.each(textList(leaf, at))})`,
            );
          if (cmp === 'contains')
            return has(`instr(lower(v.value_text), lower(${v.ref(text(leaf, at))})) > 0`);
          if (cmp === 'starts_with')
            return has(`instr(lower(v.value_text), lower(${v.ref(text(leaf, at))})) = 1`);
          break;
        case 'multi_select': {
          const from = 'member_field_values v, json_each(v.value_text) j';
          if (cmp === 'contains')
            return has(`lower(j.value) = lower(${v.ref(text(leaf, at))})`, from);
          if (cmp === 'in')
            return has(
              `lower(j.value) IN (SELECT lower(value) FROM ${v.each(textList(leaf, at))})`,
              from,
            );
          break;
        }
        case 'number': {
          const op = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[cmp as string];
          if (op) return has(`v.value_num ${op} ${v.ref(number(leaf, at))}`);
          break;
        }
        case 'boolean':
          if (cmp === 'eq') return has(`v.value_num = ${v.ref(bool(leaf, at))}`);
          break;
        case 'date': {
          if (cmp === 'eq') return has(`v.value_text = ${v.ref(day(leaf, at))}`);
          if (cmp === 'before') return has(`v.value_text < ${v.ref(day(leaf, at))}`);
          if (cmp === 'after') return has(`v.value_text > ${v.ref(day(leaf, at))}`);
          if (cmp === 'within_days') {
            const from = v.ref(utcDay(cutoff()));
            return has(`v.value_text >= ${from} AND v.value_text <= ${v.ref(utcDay(options.now))}`);
          }
          break;
        }
      }
      break;
    }
    case 'tag': {
      if (cmp === 'is_set')
        return '(EXISTS (SELECT 1 FROM member_tags mt WHERE mt.member_id = m.id))';
      const channel = v.ref(options.channelId);
      // tags.name is COLLATE NOCASE, so both forms match case-insensitively.
      if (cmp === 'eq')
        return `(m.id IN (SELECT mt.member_id FROM tags t JOIN member_tags mt ON mt.tag_id = t.id
                 WHERE t.channel_id = ${channel} AND t.name = ${v.ref(text(leaf, at))}))`;
      // Driven from the list, so each name is an index lookup on tags (channel_id, name).
      if (cmp === 'in')
        return `(m.id IN (SELECT mt.member_id FROM ${v.each(textList(leaf, at))} j
                 JOIN tags t ON t.channel_id = ${channel} AND t.name = j.value
                 JOIN member_tags mt ON mt.tag_id = t.id))`;
      break;
    }
    case 'engagement': {
      // First human open or click per Delivery (machine opens never set these); a click also
      // counts as an open.
      if (cmp === 'within_days') {
        const col = r.engagement as string;
        return `(m.id IN (SELECT d.member_id FROM deliveries d
                  WHERE d.channel_id = ${v.ref(options.channelId)} AND d.${col} >= ${v.ref(cutoff())}
                    AND d.member_id IS NOT NULL))`;
      }
      break;
    }
    case 'count': {
      const op = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[cmp as string];
      if (op)
        return `((SELECT count(*) FROM referrals r WHERE r.referrer_id = m.id) ${op} ${v.ref(count(leaf, at))})`;
      break;
    }
    case 'circle': {
      const ids =
        cmp === 'eq'
          ? `= ${v.ref(text(leaf, at))}`
          : cmp === 'in'
            ? `IN ${v.list(textList(leaf, at))}`
            : null;
      if (ids)
        return `(m.id IN (SELECT cm.member_id FROM circle_members cm JOIN circles c ON c.id = cm.circle_id
                 WHERE c.channel_id = ${v.ref(options.channelId)} AND c.deleted_at IS NULL AND cm.circle_id ${ids}))`;
      break;
    }
    case 'score':
    case 'band': {
      const has = (cond: string) =>
        `(m.id IN (SELECT e.member_id FROM member_engagement e
                 WHERE e.channel_id = ${v.ref(options.channelId)}
                   AND e.computed_at >= ${v.ref(options.now - ENGAGEMENT_FRESH_MS)} AND ${cond}))`;
      if (r.kind === 'score') {
        const op = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[cmp as string];
        if (op) {
          const score = number(leaf, at);
          if (!Number.isInteger(score) || score < 0 || score > 100)
            fail(at, 'Enter a whole number from 0 to 100.');
          return has(`e.score ${op} ${v.ref(score)}`);
        }
        break;
      }
      const band = (value: string) => {
        if (!(ENGAGEMENT_BANDS as readonly string[]).includes(value))
          fail(at, `Pick one of: ${ENGAGEMENT_BANDS.join(', ')}.`);
        return value;
      };
      if (cmp === 'eq') return has(`e.band = ${v.ref(band(text(leaf, at)))}`);
      if (cmp === 'in') return has(`e.band IN ${v.list(textList(leaf, at).map(band))}`);
      break;
    }
    case 'level': {
      const which =
        cmp === 'eq'
          ? ` AND e.level_id = ${v.ref(text(leaf, at))}`
          : cmp === 'in'
            ? ` AND e.level_id IN ${v.list(textList(leaf, at))}`
            : cmp === 'is_set'
              ? ''
              : null;
      if (which !== null) {
        const now = v.ref(options.now);
        return `(m.id IN (SELECT e.member_id FROM member_entitlements e
                 WHERE e.channel_id = ${v.ref(options.channelId)} AND e.kind = 'paid'
                   AND e.starts_at <= ${now} AND (e.expires_at IS NULL OR e.expires_at > ${now})${which}))`;
      }
      break;
    }
  }
  return fail(`${path}cmp`, 'That comparison doesn’t apply to this field.');
}

function compileNode(
  rule: CircleRule,
  options: CompileOptions,
  v: CircleValues,
  path: string,
  depth: number,
): string {
  if (depth > CIRCLE_MAX_DEPTH) fail(path, `Nest groups at most ${CIRCLE_MAX_DEPTH} deep.`);
  if ('op' in rule) {
    if (!Array.isArray(rule.children) || rule.children.length === 0)
      fail(`${path}children`, 'A group needs at least one condition.');
    const parts = rule.children.map((child, i) =>
      compileNode(child, options, v, `${path}children.${i}.`, depth + 1),
    );
    switch (rule.op) {
      case 'and':
        return `(${parts.join(' AND ')})`;
      case 'or':
        return `(${parts.join(' OR ')})`;
      case 'not':
        if (parts.length !== 1) fail(path, '"Not" takes exactly one condition or group.');
        return `(NOT ${parts[0]})`;
    }
    return fail(`${path}op`, 'Use and, or or not.');
  }
  const resolved = resolve(rule, options, path);
  const allowed = CIRCLE_COMPARATORS_BY_KIND[resolved.matrix] ?? [];
  if (!allowed.includes(rule.cmp))
    fail(`${path}cmp`, 'That comparison doesn’t apply to this field.');
  const base = NEGATIONS[rule.cmp];
  return base
    ? `(NOT ${positive(rule, base, resolved, options, v, path)})`
    : positive(rule, rule.cmp, resolved, options, v, path);
}

/** Compiles a validated rule into `v`. Pure: profile fields must already be resolved. */
export function compileRule(
  rule: CircleRule,
  options: CompileOptions,
  v = new CircleValues(),
): string {
  return compileNode(rule, options, v, '', 1);
}

/** Validates an untrusted rule against the domain schema (shape, depth, number of conditions). */
export function parseCircleRule(rule: unknown): CircleRule {
  const parsed = CircleRuleSchema.safeParse(rule);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CircleRuleError(issue?.message ?? 'That rule is not valid.', issue?.path.join('.'));
  }
  return parsed.data;
}

interface FieldRow {
  id: string;
  key: string;
  type: FieldType;
  encrypted: number;
  options_json: string;
}

/** Live profile fields of a Channel with the given keys. */
export async function loadCircleFields(
  db: D1Database,
  channelId: string,
  keys: Iterable<string>,
): Promise<Map<string, CircleField>> {
  const wanted = [...keys];
  if (!wanted.length) return new Map();
  const rows = await all<FieldRow>(
    db,
    `SELECT id, key, type, encrypted, options_json FROM member_fields
      WHERE channel_id = ?1 AND deleted_at IS NULL AND key IN (SELECT value FROM json_each(?2))`,
    channelId,
    JSON.stringify(wanted),
  );
  return new Map(
    rows.map((row) => [
      row.key,
      {
        id: row.id,
        key: row.key,
        type: row.type,
        encrypted: row.encrypted === 1,
        options: JSON.parse(row.options_json) as string[],
      },
    ]),
  );
}

/** Validates and compiles an untrusted rule for a Channel. Throws CircleRuleError. */
export async function compileCircle(
  db: D1Database,
  rule: unknown,
  channelId: string,
  now = Date.now(),
): Promise<CompiledCircle> {
  const parsed = parseCircleRule(rule);
  const fields = await loadCircleFields(db, channelId, circleFieldKeys(parsed));
  const v = new CircleValues();
  const where = compileRule(parsed, { channelId, fields, now }, v);
  return { where, params: v.params() };
}

// ---- Dispatch audiences ----------------------------------------------------------------------

/** Rules frozen onto a Broadcast, so every snapshot chunk applies the rules the count used. */
export interface FrozenAudience extends DispatchAudience {
  rules: Record<string, CircleRule>;
  /** A resend: only Members this Broadcast reached who neither opened nor clicked it. */
  unopenedOf?: string;
}

export class AudienceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudienceError';
  }
}

/** D1 refuses statements over 100 KB; leave room for the rest of the query. */
const MAX_AUDIENCE_SQL = 80_000;

export function parseAudience(json: string | null | undefined): FrozenAudience {
  const parsed = JSON.parse(json || '{}') as Partial<FrozenAudience>;
  const rosters = parseRosterAudience(parsed.rosters);
  return {
    include: Array.isArray(parsed.include) ? parsed.include : [],
    exclude: Array.isArray(parsed.exclude) ? parsed.exclude : [],
    ...(rosters ? { rosters } : {}),
    ...(typeof parsed.unopenedOf === 'string' ? { unopenedOf: parsed.unopenedOf } : {}),
    rules: parsed.rules && typeof parsed.rules === 'object' ? parsed.rules : {},
  };
}

export const isEveryone = (audience: DispatchAudience & { unopenedOf?: string }) =>
  audience.include.length === 0 &&
  audience.exclude.length === 0 &&
  !hasRosters(audience.rosters) &&
  !audience.unopenedOf;

/**
 * Loads the rules of an audience's Circles. Every Circle must be live and in `channelId`;
 * otherwise AudienceError, which the API answers with 400 and preflight shows as a failed check.
 */
export async function loadAudienceRules(
  db: D1Database,
  channelId: string,
  audience: DispatchAudience & { unopenedOf?: string },
): Promise<FrozenAudience> {
  const resend = audience.unopenedOf ? { unopenedOf: audience.unopenedOf } : {};
  if (audience.unopenedOf) {
    const source = await first(
      db,
      'SELECT 1 FROM broadcasts WHERE id = ?1 AND channel_id = ?2',
      audience.unopenedOf,
      channelId,
    );
    if (!source) {
      throw new AudienceError('The send this one follows no longer exists.');
    }
  }
  // Rosters (Phase 8): the flag must still be on, and every Roster live in this Channel.
  const rosters = hasRosters(audience.rosters) ? audience.rosters : null;
  if (rosters) {
    if (!(await rostersEnabled(db, channelId))) {
      throw new AudienceError(
        'This audience uses Rosters, which are off for this publication. Choose the audience again.',
      );
    }
    const wanted = [...rosters.include, ...rosters.exclude];
    const live = await liveRosterIds(db, channelId, wanted);
    if (wanted.some((id) => !live.has(id))) {
      throw new AudienceError(
        'A Roster in this audience no longer exists. Choose the audience again.',
      );
    }
  }
  const withRosters = rosters ? { rosters: { ...rosters } } : {};
  const ids = [...audience.include, ...audience.exclude];
  if (!ids.length) return { include: [], exclude: [], ...withRosters, ...resend, rules: {} };
  const rows = await all<{ id: string; rule_json: string }>(
    db,
    `SELECT id, rule_json FROM circles
      WHERE channel_id = ?1 AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?2))`,
    channelId,
    JSON.stringify(ids),
  );
  const rules = Object.fromEntries(rows.map((row) => [row.id, JSON.parse(row.rule_json)]));
  if (ids.some((id) => !Object.hasOwn(rules, id))) {
    throw new AudienceError(
      'A segment in this audience no longer exists. Choose the audience again.',
    );
  }
  return {
    include: [...audience.include],
    exclude: [...audience.exclude],
    ...withRosters,
    ...resend,
    rules,
  };
}

/**
 * The audience as one expression over `members m`: in any include Circle (everyone when there
 * are none) and in no exclude Circle. Status and suppression are left to the caller.
 */
export async function compileAudience(
  db: D1Database,
  channelId: string,
  audience: FrozenAudience,
  now = Date.now(),
): Promise<CompiledCircle> {
  const v = new CircleValues();
  if (isEveryone(audience)) return { where: '1', params: v.params() };
  const evaluable = (run: () => string) => {
    try {
      return run();
    } catch (error) {
      if (error instanceof CircleRuleError) {
        throw new AudienceError(`A segment in this audience can’t be evaluated: ${error.message}`);
      }
      throw error;
    }
  };
  const rules = new Map(
    [...audience.include, ...audience.exclude].map((id) => {
      const rule = audience.rules[id];
      if (!rule) throw new AudienceError('A segment in this audience has no rule.');
      evaluable(() => {
        parseCircleRule(rule);
        return '';
      });
      return [id, rule] as const;
    }),
  );
  const keys = new Set<string>();
  for (const rule of rules.values()) circleFieldKeys(rule, keys);
  const fields = await loadCircleFields(db, channelId, keys);
  const options = { channelId, fields, now };
  const compile = (id: string) =>
    evaluable(() => compileRule(rules.get(id) as CircleRule, options, v));
  const parts: string[] = [];
  if (audience.include.length) parts.push(`(${audience.include.map(compile).join(' OR ')})`);
  for (const id of audience.exclude) parts.push(`(NOT ${compile(id)})`);
  const rosters = rosterAudienceSql(audience.rosters, (ids) => v.list(ids));
  if (rosters) parts.push(`(${rosters})`);
  // A privacy proxy's open isn't counted as an open, so people behind one may get the copy. An
  // email without an open pixel (open tracking off, or the person asked not to be tracked) can't
  // show it went unread, so it never counts as unopened.
  if (audience.unopenedOf) {
    const of = v.ref(audience.unopenedOf);
    parts.push(
      `(m.id IN (SELECT r.member_id FROM deliveries r WHERE r.broadcast_id = ${of}
          AND r.status NOT IN ('failed', 'bounced', 'complained') AND r.tracked = 1
          AND r.human_opened_at IS NULL AND r.human_clicked_at IS NULL
          AND EXISTS (SELECT 1 FROM broadcasts ob WHERE ob.id = ${of} AND ob.track_opens = 1)))`,
    );
  }
  const where = parts.join(' AND ');
  if (where.length > MAX_AUDIENCE_SQL) {
    throw new AudienceError('This audience is too complex to send to. Use fewer segments.');
  }
  return { where, params: v.params() };
}

/**
 * Exact recipients for an audience right now: active Members matching it whose address is not
 * suppressed in the workspace. The snapshot applies the same predicate, so the numbers agree.
 */
export async function countAudience(
  db: D1Database,
  channelId: string,
  workspaceId: string,
  compiled: CompiledCircle,
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM members m
      WHERE m.channel_id = ?2 AND m.status = 'active' AND m.emails_off_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = ?3 AND s.email = m.email AND (s.channel_id IS NULL OR s.channel_id = m.channel_id))
        AND (${compiled.where})`,
    ...compiled.params,
    channelId,
    workspaceId,
  );
  return row?.n ?? 0;
}

// ---- Refresh ---------------------------------------------------------------------------------

/**
 * A Circle pending or refreshing for this long lost its message: the jobs cron queues it again,
 * and a manual refresh does not wait for the cron.
 */
export const CIRCLE_STUCK_AFTER_MS = 15 * 60 * 1000;

/**
 * Event-driven refresh: queues a re-evaluation of every Circle in the Channel after member data
 * changed. Circles already waiting for one are skipped, and the message is delayed a little, so
 * a burst of changes costs one evaluation per Circle.
 */
export async function enqueueChannelCircleRefresh(
  db: D1Database,
  queue: JobQueue,
  channelId: string,
  options: { now?: number; delaySeconds?: number } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const rows = await all<{ id: string; generation: number }>(
    db,
    `UPDATE circles SET status = 'pending', updated_at = ?2
      WHERE channel_id = ?1 AND deleted_at IS NULL AND status <> 'pending'
      RETURNING id, generation`,
    channelId,
    now,
  );
  for (const row of rows) {
    await queue.send(
      { type: 'circle_refresh', circleId: row.id, generation: row.generation },
      { delaySeconds: options.delaySeconds ?? 30 },
    );
  }
  return rows.length;
}
