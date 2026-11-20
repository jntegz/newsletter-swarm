// The Circle compiler without a database: the comparator matrix, typed errors and the SQL shape.
// Behaviour against real data is tested in workers/jobs/tests/circles.test.ts.
import { CIRCLE_COMPARATORS, type CircleLeaf, type CircleRule } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  CIRCLE_COMPARATORS_BY_KIND,
  CircleRuleError,
  CircleValues,
  compileRule,
  parseCircleRule,
  type CircleField,
} from '../src/circles';

const now = Date.parse('2026-10-27T12:00:00Z');
const fields = new Map<string, CircleField>(
  (
    [
      ['company', 'text'],
      ['plan', 'select'],
      ['topics', 'multi_select'],
      ['age', 'number'],
      ['vip', 'boolean'],
      ['birthday', 'date'],
    ] as const
  ).map(([key, type], i) => [
    key,
    { id: `mf_${i}`, key, type, encrypted: false, options: ['Weekly', 'Monthly'] },
  ]),
);
fields.set('secret', { id: 'mf_9', key: 'secret', type: 'text', encrypted: true });
const options = { channelId: 'ch_test', fields, now };

const compile = (rule: CircleRule) => {
  const v = new CircleValues();
  return { where: compileRule(parseCircleRule(rule), options, v), values: v.values };
};

/** A field of each kind, with a value that fits each comparator. */
const SAMPLES: Record<string, { field: string; value: (cmp: string) => CircleLeaf['value'] }> = {
  text: { field: 'first_name', value: (c) => (c.endsWith('in') ? ['Ada'] : 'Ada') },
  enum: { field: 'status', value: (c) => (c.endsWith('in') ? ['active'] : 'active') },
  ref: { field: 'form_id', value: (c) => (c.endsWith('in') ? ['cf_1'] : 'cf_1') },
  time: { field: 'created_at', value: (c) => (c.includes('days') ? 7 : '2026-10-01') },
  'field:text': { field: 'field:company', value: (c) => (c.endsWith('in') ? ['Acme'] : 'Acme') },
  'field:select': { field: 'field:plan', value: (c) => (c.endsWith('in') ? ['weekly'] : 'Weekly') },
  'field:multi_select': {
    field: 'field:topics',
    value: (c) => (c.endsWith('in') ? ['Weekly'] : 'Weekly'),
  },
  'field:number': { field: 'field:age', value: () => 30 },
  'field:boolean': { field: 'field:vip', value: () => true },
  'field:date': { field: 'field:birthday', value: (c) => (c.includes('days') ? 7 : '2026-10-01') },
  'field:encrypted': { field: 'field:secret', value: () => undefined },
  tag: { field: 'tag', value: (c) => (c.endsWith('in') ? ['VIP'] : 'VIP') },
  engagement: { field: 'opened_days', value: () => 30 },
  count: { field: 'referral_count', value: () => 2 },
};

describe('Circle compiler', () => {
  it('accepts exactly the comparators in the matrix for every kind of field', () => {
    for (const [kind, sample] of Object.entries(SAMPLES)) {
      const allowed = CIRCLE_COMPARATORS_BY_KIND[kind]!;
      for (const cmp of CIRCLE_COMPARATORS) {
        const leaf = { field: sample.field, cmp, value: sample.value(cmp) };
        if (allowed.includes(cmp)) {
          expect(() => compile(leaf), `${kind} ${cmp}`).not.toThrow();
        } else {
          expect(() => compile(leaf), `${kind} ${cmp}`).toThrow(CircleRuleError);
        }
      }
    }
  });

  it('binds every value through ?1 and keeps the SQL free of them', () => {
    const { where, values } = compile({
      op: 'and',
      children: [
        { field: 'first_name', cmp: 'eq', value: "O'Brien" },
        { field: 'tag', cmp: 'in', value: ['VIP', 'x"y'] },
        { op: 'not', children: [{ field: 'field:age', cmp: 'gt', value: 30 }] },
        { field: 'source.utm_source', cmp: 'contains', value: 'news' },
      ],
    });
    expect(values).toEqual(["O'Brien", 'ch_test', ['VIP', 'x"y'], 'mf_3', 30, 'news']);
    for (const value of ["O'Brien", 'x"y', 'ch_test', 'mf_3', 'news']) {
      expect(where).not.toContain(value);
    }
    // No other placeholders: one parameter regardless of the number of conditions.
    expect(where.match(/\?\d*/g)?.every((p) => p === '?1')).toBe(true);
  });

  it('compiles a select value that names an option to an exact, indexable comparison', () => {
    expect(compile({ field: 'field:plan', cmp: 'eq', value: 'weekly' }).values).toContain('Weekly');
    expect(compile({ field: 'field:plan', cmp: 'eq', value: 'weekly' }).where).toContain(
      'v.value_text = json_extract',
    );
    expect(compile({ field: 'field:plan', cmp: 'eq', value: 'Yearly' }).where).toContain(
      'lower(v.value_text)',
    );
  });

  it('refuses fields outside the whitelist, and says where', () => {
    const cases: [unknown, string][] = [
      [{ field: 'password_hash', cmp: 'eq', value: 'x' }, 'field'],
      [{ field: 'field:missing', cmp: 'is_set' }, 'field'],
      [{ field: 'field:Bad-Key', cmp: 'is_set' }, 'field'],
      [{ field: 'source.first_url', cmp: 'eq', value: 'x' }, 'field'],
      [{ field: 'toString', cmp: 'eq', value: 'x' }, 'field'],
      [{ op: 'and', children: [{ field: 'email', cmp: 'gt', value: 'x' }] }, 'children.0.cmp'],
      [
        {
          op: 'or',
          children: [
            { field: 'email', cmp: 'is_set' },
            { field: 'status', cmp: 'eq', value: 'gone' },
          ],
        },
        'children.1.value',
      ],
    ];
    for (const [rule, path] of cases) {
      try {
        compile(rule as CircleRule);
        throw new Error(`compiled ${JSON.stringify(rule)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CircleRuleError);
        expect((error as CircleRuleError).path).toBe(path);
      }
    }
  });

  it('validates values for their type', () => {
    const bad: CircleLeaf[] = [
      { field: 'created_at', cmp: 'before', value: 'yesterday' },
      { field: 'field:birthday', cmp: 'after', value: '2026-02-30' },
      { field: 'created_at', cmp: 'within_days', value: 0 },
      { field: 'opened_days', cmp: 'within_days', value: 3651 },
      { field: 'referral_count', cmp: 'gte', value: -1 },
      { field: 'field:age', cmp: 'gt', value: Number.NaN },
      { field: 'field:vip', cmp: 'eq', value: 1 },
      { field: 'first_name', cmp: 'eq', value: '' },
      { field: 'first_name', cmp: 'in', value: [] },
      { field: 'digest', cmp: 'in', value: ['daily'] },
    ];
    for (const leaf of bad)
      expect(() => compile(leaf), JSON.stringify(leaf)).toThrow(CircleRuleError);
  });

  it('negates by wrapping the positive form, so missing values stay in "not" results', () => {
    expect(compile({ field: 'first_name', cmp: 'neq', value: 'Ada' }).where).toBe(
      `(NOT ifnull(lower(m.first_name) = lower(json_extract(?1, '$[0]')), 0))`,
    );
  });

  it('enforces the depth limit even without the schema', () => {
    let rule: CircleRule = { field: 'email', cmp: 'is_set' };
    for (let i = 0; i < 25; i++) rule = { op: 'not', children: [rule] };
    expect(() => compileRule(rule, options)).toThrow(/at most 20 deep/);
  });
});
