import type { CircleGroup, MemberField, Tag } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  MAX_CONDITIONS,
  MAX_DEPTH,
  addChild,
  asRootGroup,
  canAdd,
  changeComparator,
  changeField,
  choiceLabel,
  comparatorsFor,
  describeAudience,
  errorKey,
  fieldCatalogue,
  findField,
  measure,
  moveNode,
  newCondition,
  parseErrorPath,
  parseList,
  removeNode,
  serverRuleErrors,
  setGroupOp,
  updateNode,
  validateRule,
  valueInput,
} from './rules';

const field = (overrides: Partial<MemberField>): MemberField => ({
  id: 'mf_1',
  channelId: 'ch_1',
  key: 'plan',
  label: 'Plan',
  type: 'text',
  options: [],
  encrypted: false,
  position: 0,
  createdAt: '2026-10-27T12:00:00.000Z',
  ...overrides,
});

const tag = (name: string): Tag => ({
  id: `tg_${name}`,
  channelId: 'ch_1',
  name,
  memberCount: 0,
  createdAt: '2026-10-27T12:00:00.000Z',
});

const catalogue = fieldCatalogue(
  [
    field({ key: 'plan', label: 'Plan', type: 'select', options: ['Free', 'Pro'], position: 1 }),
    field({ key: 'topics', type: 'multi_select', options: ['AI', 'Art'], position: 2 }),
    field({ key: 'age', type: 'number', position: 3 }),
    field({ key: 'vip', type: 'boolean', position: 4 }),
    field({ key: 'birthday', type: 'date', position: 5 }),
    field({ key: 'tax_id', type: 'text', encrypted: true, position: 6 }),
  ],
  [tag('vip'), tag('beta')],
);

const leaf = (value: string) => ({ field: 'tag', cmp: 'eq' as const, value });

describe('comparator matrix', () => {
  it('offers only the comparators the compiler accepts for each kind of field', () => {
    expect(comparatorsFor(findField(catalogue, 'status'))).toEqual(['eq', 'neq', 'in', 'not_in']);
    expect(comparatorsFor(findField(catalogue, 'opened_days'))).toEqual([
      'within_days',
      'not_within_days',
    ]);
    expect(comparatorsFor(findField(catalogue, 'field:tax_id'))).toEqual(['is_set', 'is_not_set']);
    expect(comparatorsFor(findField(catalogue, 'field:topics'))).toContain('contains');
    expect(comparatorsFor(findField(catalogue, 'field:topics'))).not.toContain('eq');
    expect(comparatorsFor(findField(catalogue, 'referral_count'))).not.toContain('is_set');
    expect(comparatorsFor(findField(catalogue, 'field:birthday'))).toEqual([
      'eq',
      'neq',
      'before',
      'after',
      'within_days',
      'not_within_days',
      'is_set',
      'is_not_set',
    ]);
    expect(comparatorsFor(undefined)).toEqual([]);
  });

  it('picks the value input from the field and comparator', () => {
    const spec = (name: string) => findField(catalogue, name);
    expect(valueInput(spec('email'), 'contains')).toBe('text');
    expect(valueInput(spec('email'), 'in')).toBe('text-list');
    expect(valueInput(spec('status'), 'eq')).toBe('choice');
    expect(valueInput(spec('tag'), 'not_in')).toBe('choice-list');
    expect(valueInput(spec('tag'), 'is_set')).toBe('none');
    expect(valueInput(spec('created_at'), 'before')).toBe('date');
    expect(valueInput(spec('created_at'), 'within_days')).toBe('days');
    expect(valueInput(spec('field:age'), 'gt')).toBe('number');
    expect(valueInput(spec('referral_count'), 'gte')).toBe('count');
    expect(valueInput(spec('field:vip'), 'eq')).toBe('boolean');
    expect(valueInput(spec('field:plan'), 'eq')).toBe('choice');
    expect(valueInput(spec('field:topics'), 'contains')).toBe('choice');
  });

  it('falls back to free text for tags when the Channel has none yet', () => {
    const bare = fieldCatalogue([], []);
    expect(valueInput(findField(bare, 'tag'), 'eq')).toBe('text');
    expect(valueInput(findField(bare, 'tag'), 'in')).toBe('text-list');
  });
});

describe('editing conditions', () => {
  it('starts a condition with a valid comparator and value', () => {
    expect(newCondition(catalogue, 'tag')).toEqual({ field: 'tag', cmp: 'eq', value: 'vip' });
    expect(newCondition(catalogue, 'opened_days')).toEqual({
      field: 'opened_days',
      cmp: 'within_days',
      value: 30,
    });
    expect(newCondition(catalogue, 'field:tax_id')).toEqual({
      field: 'field:tax_id',
      cmp: 'is_set',
    });
  });

  it('keeps the comparator and value when they still fit the new field', () => {
    const first = { field: 'first_name', cmp: 'contains' as const, value: 'ad' };
    expect(changeField(first, catalogue, 'last_name')).toEqual({
      field: 'last_name',
      cmp: 'contains',
      value: 'ad',
    });
    expect(changeField(first, catalogue, 'status')).toEqual({
      field: 'status',
      cmp: 'eq',
      value: 'pending',
    });
    expect(changeField(first, catalogue, 'field:tax_id')).toEqual({
      field: 'field:tax_id',
      cmp: 'is_set',
    });
  });

  it('converts values between single and list comparators', () => {
    const one = leaf('vip');
    const many = changeComparator(one, catalogue, 'in');
    expect(many).toEqual({ field: 'tag', cmp: 'in', value: ['vip'] });
    expect(changeComparator(many, catalogue, 'neq')).toEqual({
      field: 'tag',
      cmp: 'neq',
      value: 'vip',
    });
    expect(changeComparator(one, catalogue, 'is_not_set')).toEqual({
      field: 'tag',
      cmp: 'is_not_set',
    });
  });

  it('parses comma-separated lists', () => {
    expect(parseList(' a, b ,, a ,c')).toEqual(['a', 'b', 'c']);
    expect(parseList('')).toEqual([]);
  });
});

describe('tree edits', () => {
  const tree: CircleGroup = {
    op: 'and',
    children: [leaf('a'), { op: 'or', children: [leaf('b'), leaf('c')] }],
  };

  it('updates by path without touching the input', () => {
    const next = updateNode(tree, [1, 0], () => leaf('z'));
    expect(next.children[1]).toEqual({ op: 'or', children: [leaf('z'), leaf('c')] });
    expect(tree.children[1]).toEqual({ op: 'or', children: [leaf('b'), leaf('c')] });
    expect(updateNode(tree, [9], () => leaf('z'))).toEqual(tree);
  });

  it('adds, removes and moves', () => {
    expect(addChild(tree, [1], leaf('d')).children[1]).toEqual({
      op: 'or',
      children: [leaf('b'), leaf('c'), leaf('d')],
    });
    expect(removeNode(tree, [1, 0]).children[1]).toEqual({ op: 'or', children: [leaf('c')] });
    expect(removeNode(tree, [])).toBe(tree);
    expect(moveNode(tree, [0], 1).children[0]).toEqual(tree.children[1]);
    expect(moveNode(tree, [0], -1)).toEqual(tree);
  });

  it('keeps "None" groups at exactly one child', () => {
    const none = setGroupOp(tree, [], 'not');
    expect(none).toEqual({ op: 'not', children: [{ op: 'or', children: tree.children }] });
    expect(setGroupOp(none, [], 'and')).toEqual(tree);

    const single: CircleGroup = { op: 'not', children: [leaf('a')] };
    expect(addChild(single, [], leaf('b'))).toEqual({
      op: 'not',
      children: [{ op: 'or', children: [leaf('a'), leaf('b')] }],
    });
    expect(addChild(none, [], leaf('d'))).toEqual({
      op: 'not',
      children: [{ op: 'or', children: [...tree.children, leaf('d')] }],
    });
    expect(addChild({ op: 'not', children: [] }, [], leaf('a'))).toEqual({
      op: 'not',
      children: [leaf('a')],
    });
  });

  it('wraps a lone condition in a group', () => {
    expect(asRootGroup(leaf('a'))).toEqual({ op: 'and', children: [leaf('a')] });
    expect(asRootGroup(null)).toEqual({ op: 'and', children: [] });
  });
});

describe('limits', () => {
  const nest = (depth: number): CircleGroup => {
    let node: CircleGroup = { op: 'and', children: [leaf('x')] };
    for (let i = 1; i < depth - 1; i++) node = { op: 'and', children: [node] };
    return node;
  };

  it('measures depth and conditions as the server does', () => {
    expect(measure(leaf('a'))).toEqual({ depth: 1, conditions: 1 });
    expect(measure(nest(MAX_DEPTH))).toEqual({ depth: MAX_DEPTH, conditions: 1 });
  });

  it('stops adding at the depth and condition limits', () => {
    const deep = nest(MAX_DEPTH);
    const deepestGroup = Array.from({ length: MAX_DEPTH - 2 }, () => 0);
    expect(canAdd(deep, deepestGroup)).toEqual({ condition: true, group: false });
    expect(canAdd(deep, [])).toEqual({ condition: true, group: true });

    const full: CircleGroup = {
      op: 'or',
      children: Array.from({ length: 2 }, () => ({
        op: 'and' as const,
        children: Array.from({ length: MAX_CONDITIONS / 2 }, () => leaf('x')),
      })),
    };
    expect(canAdd(full, [])).toEqual({ condition: false, group: false });
    expect(validateRule(full, catalogue)).toEqual({});
    const over = addChild(full, [], leaf('y'));
    expect(validateRule(over, catalogue)[errorKey([])]).toBe('Use at most 100 conditions.');
  });
});

describe('validation', () => {
  it('accepts a complete rule', () => {
    const rule: CircleGroup = {
      op: 'and',
      children: [
        { field: 'tag', cmp: 'in', value: ['vip'] },
        { field: 'created_at', cmp: 'after', value: '2026-01-31' },
        { field: 'opened_days', cmp: 'within_days', value: 30 },
        { field: 'field:age', cmp: 'gte', value: 18 },
        { field: 'field:vip', cmp: 'eq', value: false },
        { field: 'field:tax_id', cmp: 'is_set' },
        { op: 'not', children: [{ field: 'status', cmp: 'eq', value: 'paused' }] },
      ],
    };
    expect(validateRule(rule, catalogue)).toEqual({});
  });

  it('points at the condition and part that needs attention', () => {
    const rule: CircleGroup = {
      op: 'and',
      children: [
        { field: 'email', cmp: 'contains', value: '' },
        { field: 'created_at', cmp: 'before', value: '2026-02-30' },
        { field: 'opened_days', cmp: 'within_days', value: 0 },
        { field: 'field:gone', cmp: 'eq', value: 'x' },
        { field: 'status', cmp: 'contains', value: 'x' },
        { field: 'referral_count', cmp: 'gt', value: 1.5 },
        { op: 'or', children: [] },
        { op: 'not', children: [leaf('a'), leaf('b')] },
      ],
    };
    expect(validateRule(rule, catalogue)).toEqual({
      [errorKey([0], 'value')]: 'Enter a value.',
      [errorKey([1], 'value')]: 'Use a date like 2026-10-27.',
      [errorKey([2], 'value')]: 'Enter a number of days from 1 to 3650.',
      [errorKey([3], 'field')]: 'That profile field no longer exists. Choose another.',
      [errorKey([4], 'cmp')]: 'That comparison doesn’t apply to this field.',
      [errorKey([5], 'value')]: 'Enter a whole number, 0 or more.',
      [errorKey([6], 'children')]: 'Add a condition to this group, or remove it.',
      [errorKey([7], 'children')]: '“None” takes exactly one condition or group.',
    });
  });

  it('flags an empty root so an empty rule is never previewed', () => {
    expect(validateRule({ op: 'and', children: [] }, catalogue)).toEqual({
      [errorKey([], 'children')]: 'Add a condition to this group, or remove it.',
    });
  });
});

describe('server errors', () => {
  it('reads detail paths onto nodes', () => {
    expect(parseErrorPath('rule.children.1.children.0.value')).toEqual({
      node: [1, 0],
      slot: 'value',
    });
    expect(parseErrorPath('rule.children.2.')).toEqual({ node: [2], slot: '' });
    expect(parseErrorPath('rule')).toEqual({ node: [], slot: '' });
    expect(parseErrorPath('rule.field')).toEqual({ node: [], slot: 'field' });
    expect(parseErrorPath('name')).toBeNull();
  });

  it('keeps the first message per place', () => {
    expect(
      serverRuleErrors([
        { path: 'rule.children.0.value', message: 'Enter a value.' },
        { path: 'rule.children.0.value', message: 'Other.' },
        { path: 'name', message: 'Name the segment.' },
      ]),
    ).toEqual({ [errorKey([0], 'value')]: 'Enter a value.' });
  });
});

describe('describeAudience', () => {
  const names = new Map([
    ['cl_a', 'Readers'],
    ['cl_b', 'Buyers'],
    ['cl_c', 'Lapsed'],
  ]);
  it('names who a send goes to', () => {
    expect(describeAudience({ include: [], exclude: [] }, names)).toBe('Everyone');
    expect(describeAudience({ include: ['cl_a', 'cl_b'], exclude: ['cl_c'] }, names)).toBe(
      'Subscribers in Readers and Buyers, except subscribers in Lapsed',
    );
    expect(describeAudience({ include: [], exclude: ['cl_x'] }, names)).toBe(
      'Everyone, except subscribers in a deleted segment',
    );
  });
});

describe('engagement score conditions', () => {
  it('are offered only when the score is on', () => {
    expect(findField(fieldCatalogue(), 'engagement_score')).toBeUndefined();
    const on = fieldCatalogue([], [], { engagementScores: true });
    expect(comparatorsFor(findField(on, 'engagement_score'))).toEqual([
      'eq',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
    ]);
    expect(valueInput(findField(on, 'engagement_score'), 'lt')).toBe('count');
    expect(valueInput(findField(on, 'engagement_band'), 'eq')).toBe('choice');
    expect(valueInput(findField(on, 'engagement_band'), 'in')).toBe('choice-list');
    expect(choiceLabel('opens_hidden')).toBe('Opens hidden');
    // A select field's own option may be called "constructor"; it is shown as it is.
    expect(choiceLabel('constructor')).toBe('constructor');
    expect(choiceLabel('__proto__')).toBe('__proto__');
  });
});
