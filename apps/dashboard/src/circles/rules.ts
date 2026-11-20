// Pure helpers for the Circle rule builder: the field catalogue, the comparator matrix (mirrors
// packages/engine/src/circles.ts), tree edits by path, value coercion and client-side validation.
// The server stays the authority; these only keep the builder from offering what it would refuse.
import type {
  CircleComparator,
  CircleGroup,
  CircleLeaf,
  CircleRule,
  MemberField,
  Tag,
} from '@swarm/domain';

// Mirrors of domain constants. Imported as values they would pull zod into the bundle.
export const MAX_DEPTH = 20;
export const MAX_CONDITIONS = 100;
const MAX_CHILDREN = 50;
const MAX_LIST = 100;
export const MAX_DAYS = 3650;
const MEMBER_STATUSES = [
  'pending',
  'active',
  'paused',
  'unsubscribed',
  'bounced',
  'complained',
] as const;
const DIGESTS = ['every', 'weekly', 'monthly'] as const;
const SOURCE_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'referrer',
  'ref',
] as const;

// ---- Comparator matrix ------------------------------------------------------------------------

const TEXT_CMPS: CircleComparator[] = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'starts_with',
  'in',
  'not_in',
  'is_set',
  'is_not_set',
];
const ORDER_CMPS: CircleComparator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'];
const TIME_CMPS: CircleComparator[] = [
  'before',
  'after',
  'within_days',
  'not_within_days',
  'is_set',
  'is_not_set',
];

/** Which comparators each kind of leaf accepts. Kept in step with CIRCLE_COMPARATORS_BY_KIND. */
const COMPARATORS_BY_KIND: Record<string, readonly CircleComparator[]> = {
  text: TEXT_CMPS,
  enum: ['eq', 'neq', 'in', 'not_in'],
  ref: ['eq', 'neq', 'in', 'not_in', 'is_set', 'is_not_set'],
  time: TIME_CMPS,
  'field:text': TEXT_CMPS,
  'field:select': ['eq', 'neq', 'in', 'not_in', 'is_set', 'is_not_set'],
  'field:multi_select': ['contains', 'not_contains', 'in', 'not_in', 'is_set', 'is_not_set'],
  'field:number': [...ORDER_CMPS, 'is_set', 'is_not_set'],
  'field:boolean': ['eq', 'neq', 'is_set', 'is_not_set'],
  'field:date': ['eq', 'neq', ...TIME_CMPS],
  'field:encrypted': ['is_set', 'is_not_set'],
  tag: ['eq', 'neq', 'in', 'not_in', 'is_set', 'is_not_set'],
  engagement: ['within_days', 'not_within_days'],
  count: ORDER_CMPS,
  // Phase 6 leaves (Smart Blocks, Flow branches): a Circle id, a Membership level id.
  circle: ['eq', 'neq', 'in', 'not_in'],
  level: ['eq', 'neq', 'in', 'not_in', 'is_set', 'is_not_set'],
  score: ORDER_CMPS,
  band: ['eq', 'neq', 'in', 'not_in'],
};

// ---- Field catalogue --------------------------------------------------------------------------

export interface FieldSpec {
  /** The leaf's `field`. */
  value: string;
  label: string;
  group:
    'Subscriber' | 'Tags' | 'Engagement' | 'Source' | 'Profile fields' | 'Segments and paid plans';
  /** Key into COMPARATORS_BY_KIND. */
  matrix: string;
  /** Fixed choices: statuses, digests, select options or tag names. */
  choices?: readonly string[];
  /** Encrypted profile fields can only be tested for presence. */
  encrypted?: boolean;
  /** Display names for `choices` that are ids (Circles, levels). */
  choiceLabels?: Readonly<Record<string, string>>;
}

const ENGAGEMENT_BANDS = [
  'very_engaged',
  'engaged',
  'slipping',
  'cold',
  'too_few_posts',
  'opens_hidden',
] as const;
export const ENGAGEMENT_BAND_LABELS: Record<(typeof ENGAGEMENT_BANDS)[number], string> = {
  very_engaged: 'Very engaged',
  engaged: 'Engaged',
  slipping: 'Slipping',
  cold: 'Cold',
  too_few_posts: 'Too few posts yet',
  opens_hidden: 'Opens hidden',
};

const STATUS_LABELS: Record<string, string> = {
  ...ENGAGEMENT_BAND_LABELS,
  pending: 'Pending',
  active: 'Active',
  paused: 'Paused',
  unsubscribed: 'Unsubscribed',
  bounced: 'Bounced',
  complained: 'Complained',
  every: 'Every post',
  weekly: 'Weekly digest',
  monthly: 'Monthly digest',
};
// Own keys only: a select field's option "constructor" is not Object.prototype's.
export const choiceLabel = (value: string) =>
  (Object.hasOwn(STATUS_LABELS, value) ? STATUS_LABELS[value] : undefined) ?? value;

/** Email checks (flag email_verification): the colours a segment can test. */
const EMAIL_CHECK_CHOICES = ['green', 'orange', 'red', 'unchecked'] as const;
const EMAIL_CHECK_LABELS: Record<string, string> = {
  green: 'Green (deliverable)',
  orange: 'Orange (worth a look)',
  red: 'Red (will bounce)',
  unchecked: 'Not checked',
};

const EMAIL_CHECK_FIELD: FieldSpec = {
  value: 'email_check',
  label: 'Email check',
  group: 'Subscriber',
  matrix: 'enum',
  choices: EMAIL_CHECK_CHOICES,
  choiceLabels: EMAIL_CHECK_LABELS,
};

const BUILT_IN: FieldSpec[] = [
  { value: 'email', label: 'Email', group: 'Subscriber', matrix: 'text' },
  { value: 'first_name', label: 'First name', group: 'Subscriber', matrix: 'text' },
  { value: 'last_name', label: 'Last name', group: 'Subscriber', matrix: 'text' },
  {
    value: 'status',
    label: 'Status',
    group: 'Subscriber',
    matrix: 'enum',
    choices: MEMBER_STATUSES,
  },
  { value: 'digest', label: 'Delivery', group: 'Subscriber', matrix: 'enum', choices: DIGESTS },
  { value: 'created_at', label: 'Joined', group: 'Subscriber', matrix: 'time' },
  { value: 'confirmed_at', label: 'Confirmed', group: 'Subscriber', matrix: 'time' },
  { value: 'tag', label: 'Tag', group: 'Tags', matrix: 'tag' },
  { value: 'opened_days', label: 'Opened a post', group: 'Engagement', matrix: 'engagement' },
  { value: 'clicked_days', label: 'Clicked a link', group: 'Engagement', matrix: 'engagement' },
  { value: 'referral_count', label: 'Referrals made', group: 'Engagement', matrix: 'count' },
  { value: 'form_id', label: 'Signup form id', group: 'Source', matrix: 'ref' },
  ...SOURCE_KEYS.map((key): FieldSpec => ({
    value: `source.${key}`,
    label: key === 'referrer' ? 'Referrer' : key === 'ref' ? 'Referral code' : key,
    group: 'Source',
    matrix: 'text',
  })),
];

const ENGAGEMENT_SCORE_FIELDS: FieldSpec[] = [
  { value: 'engagement_score', label: 'Engagement score', group: 'Engagement', matrix: 'score' },
  {
    value: 'engagement_band',
    label: 'Engagement level',
    group: 'Engagement',
    matrix: 'band',
    choices: ENGAGEMENT_BANDS,
  },
];

/** Every field a condition can test, for this Channel's profile fields and tags. */
export function fieldCatalogue(
  fields: readonly MemberField[] = [],
  tags: readonly Tag[] = [],
  options: { engagementScores?: boolean; emailChecks?: boolean } = {},
): FieldSpec[] {
  const tagNames = tags.map((t) => t.name);
  return [
    ...BUILT_IN.map((spec) => (spec.value === 'tag' ? { ...spec, choices: tagNames } : spec)),
    ...(options.emailChecks ? [EMAIL_CHECK_FIELD] : []),
    ...(options.engagementScores ? ENGAGEMENT_SCORE_FIELDS : []),
    ...[...fields]
      .sort((a, b) => a.position - b.position)
      .map((field): FieldSpec => ({
        value: `field:${field.key}`,
        label: field.label || field.key,
        group: 'Profile fields',
        matrix: field.encrypted ? 'field:encrypted' : `field:${field.type}`,
        ...(field.encrypted ? { encrypted: true } : {}),
        ...(field.type === 'select' || field.type === 'multi_select'
          ? { choices: field.options }
          : {}),
      })),
  ];
}

/**
 * The `circle` and `level` leaves (Phase 6: Smart Blocks and Flow conditions), offered only where
 * the server accepts them. Circle definitions themselves don't take them.
 */
export function membershipLeaves(
  circles: readonly { id: string; name: string }[],
  levels: readonly { id: string; name: string }[],
): FieldSpec[] {
  const labels = (items: readonly { id: string; name: string }[]) =>
    Object.fromEntries(items.map((item) => [item.id, item.name]));
  return [
    {
      value: 'circle',
      label: 'In segment',
      group: 'Segments and paid plans',
      matrix: 'circle',
      choices: circles.map((c) => c.id),
      choiceLabels: labels(circles),
    },
    {
      value: 'level',
      label: 'Paid plan',
      group: 'Segments and paid plans',
      matrix: 'level',
      choices: levels.map((l) => l.id),
      choiceLabels: labels(levels),
    },
  ];
}

/** A choice's display name: its label when it is an id, else the built-in wording. */
export const choiceName = (spec: FieldSpec | undefined, value: string) =>
  (spec?.choiceLabels && Object.hasOwn(spec.choiceLabels, value)
    ? spec.choiceLabels[value]
    : undefined) ?? choiceLabel(value);

export const findField = (catalogue: readonly FieldSpec[], field: string) =>
  catalogue.find((spec) => spec.value === field);

/** Comparators a field accepts, in the order the builder offers them. */
export const comparatorsFor = (spec: FieldSpec | undefined): readonly CircleComparator[] =>
  spec ? (COMPARATORS_BY_KIND[spec.matrix] ?? []) : [];

const CMP_LABELS: Record<CircleComparator, string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  in: 'is any of',
  not_in: 'is none of',
  is_set: 'is set',
  is_not_set: 'is not set',
  before: 'is before',
  after: 'is after',
  within_days: 'in the last',
  not_within_days: 'not in the last',
};

const CMP_LABELS_BY_KIND: Record<string, Partial<Record<CircleComparator, string>>> = {
  tag: {
    eq: 'has the tag',
    neq: 'does not have the tag',
    in: 'has any of the tags',
    not_in: 'has none of the tags',
    is_set: 'has any tag',
    is_not_set: 'has no tags',
  },
  'field:multi_select': {
    contains: 'includes',
    not_contains: 'does not include',
    in: 'includes any of',
    not_in: 'includes none of',
  },
  engagement: { within_days: 'in the last', not_within_days: 'not in the last' },
  time: { within_days: 'in the last', not_within_days: 'not in the last' },
  'field:date': { eq: 'is on', neq: 'is not on' },
};

export const comparatorLabel = (spec: FieldSpec | undefined, cmp: CircleComparator) =>
  (spec && CMP_LABELS_BY_KIND[spec.matrix]?.[cmp]) ?? CMP_LABELS[cmp];

// ---- Value inputs -----------------------------------------------------------------------------

type ValueInput =
  /** No value: is_set and is_not_set. */
  | 'none'
  | 'text'
  /** Comma-separated free text. */
  | 'text-list'
  | 'number'
  /** A whole number, 0 or more. */
  | 'count'
  /** Days, 1 to 3650. */
  | 'days'
  /** YYYY-MM-DD; for timestamps the server reads it as midnight UTC. */
  | 'date'
  | 'boolean'
  /** One of `choices`. */
  | 'choice'
  /** Several of `choices`. */
  | 'choice-list';

const LIST_CMPS = new Set<CircleComparator>(['in', 'not_in']);

/** The input a condition's value needs. */
export function valueInput(spec: FieldSpec | undefined, cmp: CircleComparator): ValueInput {
  if (cmp === 'is_set' || cmp === 'is_not_set') return 'none';
  if (cmp === 'within_days' || cmp === 'not_within_days') return 'days';
  if (!spec) return 'text';
  const list = LIST_CMPS.has(cmp);
  switch (spec.matrix) {
    case 'enum':
    case 'band':
    case 'field:select':
    case 'field:multi_select':
      // A select field without options falls back to free text, as the server compares text.
      if (spec.choices?.length) return list ? 'choice-list' : 'choice';
      return list ? 'text-list' : 'text';
    case 'tag':
    case 'circle':
    case 'level':
      if (spec.choices?.length) return list ? 'choice-list' : 'choice';
      return list ? 'text-list' : 'text';
    case 'time':
    case 'field:date':
      return 'date';
    case 'field:number':
      return 'number';
    case 'count':
    case 'score':
      return 'count';
    case 'field:boolean':
      return 'boolean';
    default:
      return list ? 'text-list' : 'text';
  }
}

type LeafValue = CircleLeaf['value'];

/**
 * A value for `input`, keeping `previous` when it still fits, so switching between "is" and
 * "is not" keeps what was typed.
 */
function coerceValue(input: ValueInput, previous: LeafValue, spec?: FieldSpec): LeafValue {
  const choices = spec?.choices ?? [];
  switch (input) {
    case 'none':
      return undefined;
    case 'text':
      if (typeof previous === 'string') return previous;
      if (Array.isArray(previous) && typeof previous[0] === 'string') return previous[0];
      return '';
    case 'date':
      return typeof previous === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(previous) ? previous : '';
    case 'choice':
      if (typeof previous === 'string' && choices.includes(previous)) return previous;
      if (Array.isArray(previous) && choices.includes(String(previous[0])))
        return String(previous[0]);
      return choices[0] ?? '';
    case 'text-list':
      if (Array.isArray(previous)) return previous.map(String);
      return typeof previous === 'string' && previous ? [previous] : [];
    case 'choice-list':
      if (Array.isArray(previous)) return previous.map(String).filter((v) => choices.includes(v));
      return typeof previous === 'string' && choices.includes(previous) ? [previous] : [];
    case 'number':
      return typeof previous === 'number' ? previous : null;
    case 'count':
      return typeof previous === 'number' && Number.isInteger(previous) && previous >= 0
        ? previous
        : 1;
    case 'days':
      return typeof previous === 'number' && Number.isInteger(previous) && previous >= 1
        ? Math.min(previous, MAX_DAYS)
        : 30;
    case 'boolean':
      return typeof previous === 'boolean' ? previous : true;
  }
}

/** A fresh condition on `field`, with its first comparator and a starting value. */
export function newCondition(catalogue: readonly FieldSpec[], field = 'tag'): CircleLeaf {
  const spec = findField(catalogue, field) ?? catalogue[0];
  const cmp = comparatorsFor(spec)[0] ?? 'eq';
  const value = coerceValue(valueInput(spec, cmp), undefined, spec);
  return value === undefined
    ? { field: spec?.value ?? field, cmp }
    : { field: spec?.value ?? field, cmp, value };
}

/** The leaf with a new field: the comparator and value carry over when they still apply. */
export function changeField(
  leaf: CircleLeaf,
  catalogue: readonly FieldSpec[],
  field: string,
): CircleLeaf {
  const spec = findField(catalogue, field);
  const allowed = comparatorsFor(spec);
  const cmp = allowed.includes(leaf.cmp) ? leaf.cmp : (allowed[0] ?? 'eq');
  return withValue({ field, cmp }, coerceValue(valueInput(spec, cmp), leaf.value, spec));
}

export function changeComparator(
  leaf: CircleLeaf,
  catalogue: readonly FieldSpec[],
  cmp: CircleComparator,
): CircleLeaf {
  const spec = findField(catalogue, leaf.field);
  return withValue(
    { field: leaf.field, cmp },
    coerceValue(valueInput(spec, cmp), leaf.value, spec),
  );
}

function withValue(leaf: CircleLeaf, value: LeafValue): CircleLeaf {
  return value === undefined ? { field: leaf.field, cmp: leaf.cmp } : { ...leaf, value };
}

/** Splits comma-separated text into trimmed, non-empty, unique values. */
export function parseList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
}

// ---- Tree edits -------------------------------------------------------------------------------

/** Indexes into `children`, from the root group. The root is `[]`. */
export type NodePath = readonly number[];

export const isGroup = (rule: CircleRule): rule is CircleGroup => 'op' in rule;

/** The builder always edits a group at the root; a lone condition is wrapped (same meaning). */
export function asRootGroup(rule: CircleRule | null | undefined): CircleGroup {
  if (!rule) return { op: 'and', children: [] };
  return isGroup(rule) ? rule : { op: 'and', children: [rule] };
}

function getNode(root: CircleRule, path: NodePath): CircleRule | undefined {
  let node: CircleRule | undefined = root;
  for (const index of path) {
    if (!node || !isGroup(node)) return undefined;
    node = node.children[index];
  }
  return node;
}

/** Replaces the node at `path` with `update(node)`. Returns a new tree; the input is untouched. */
export function updateNode(
  root: CircleGroup,
  path: NodePath,
  update: (node: CircleRule) => CircleRule,
): CircleGroup {
  const walk = (node: CircleRule, depth: number): CircleRule => {
    if (depth === path.length) return update(node);
    if (!isGroup(node)) return node;
    const index = path[depth] as number;
    if (index < 0 || index >= node.children.length) return node;
    const children = node.children.slice();
    children[index] = walk(node.children[index] as CircleRule, depth + 1);
    return { ...node, children };
  };
  const next = walk(root, 0);
  return isGroup(next) ? next : root;
}

/**
 * Adds `child` to the group at `path`. A "None" group holds exactly one child, so adding to one
 * adds inside its group, or turns its lone condition into an "Any" group of both.
 */
export function addChild(root: CircleGroup, path: NodePath, child: CircleRule): CircleGroup {
  return updateNode(root, path, (node) => {
    if (!isGroup(node)) return node;
    if (node.op !== 'not' || node.children.length === 0) {
      return { ...node, children: [...node.children, child] };
    }
    const only = node.children[0] as CircleRule;
    if (isGroup(only) && only.op !== 'not') {
      return { ...node, children: [{ ...only, children: [...only.children, child] }] };
    }
    return { op: 'not', children: [{ op: 'or', children: [only, child] }] };
  });
}

/** Removes the node at `path`. The root can't be removed. */
export function removeNode(root: CircleGroup, path: NodePath): CircleGroup {
  if (path.length === 0) return root;
  const parent = path.slice(0, -1);
  const index = path.at(-1) as number;
  return updateNode(root, parent, (node) =>
    isGroup(node) ? { ...node, children: node.children.filter((_, i) => i !== index) } : node,
  );
}

/** Moves the node at `path` up (-1) or down (+1) among its siblings. */
export function moveNode(root: CircleGroup, path: NodePath, delta: -1 | 1): CircleGroup {
  if (path.length === 0) return root;
  const parent = path.slice(0, -1);
  const from = path.at(-1) as number;
  return updateNode(root, parent, (node) => {
    if (!isGroup(node)) return node;
    const to = from + delta;
    if (to < 0 || to >= node.children.length) return node;
    const children = node.children.slice();
    [children[from], children[to]] = [children[to] as CircleRule, children[from] as CircleRule];
    return { ...node, children };
  });
}

/**
 * Changes a group's match. Switching several children to "None" puts them in an "Any" group
 * first, so the meaning is "none of these"; leaving "None" unwraps that group again.
 */
export function setGroupOp(root: CircleGroup, path: NodePath, op: CircleGroup['op']): CircleGroup {
  return updateNode(root, path, (node) => {
    if (!isGroup(node) || node.op === op) return node;
    if (op === 'not' && node.children.length > 1) {
      return { op: 'not', children: [{ op: 'or', children: node.children }] };
    }
    if (node.op === 'not' && node.children.length === 1) {
      const only = node.children[0] as CircleRule;
      if (isGroup(only) && only.op === 'or') return { op, children: only.children };
    }
    return { ...node, op };
  });
}

// ---- Limits and validation --------------------------------------------------------------------

/** Deepest node (the root group is 1) and number of conditions, as the server measures them. */
export function measure(rule: CircleRule, depth = 1): { depth: number; conditions: number } {
  if (!isGroup(rule)) return { depth, conditions: 1 };
  return rule.children.reduce(
    (acc, child) => {
      const m = measure(child, depth + 1);
      return { depth: Math.max(acc.depth, m.depth), conditions: acc.conditions + m.conditions };
    },
    { depth, conditions: 0 },
  );
}

/** What can still be added to the group at `path`. */
export function canAdd(root: CircleGroup, path: NodePath) {
  const node = getNode(root, path);
  const { conditions } = measure(root);
  // The node's own depth: the root is 1.
  const depth = path.length + 1;
  const full = !node || !isGroup(node) || node.children.length >= MAX_CHILDREN;
  return {
    condition: !full && conditions < MAX_CONDITIONS && depth + 1 <= MAX_DEPTH,
    // A new group needs room for a condition inside it.
    group: !full && conditions < MAX_CONDITIONS && depth + 2 <= MAX_DEPTH,
  };
}

/** Where an error belongs: a node and the part of it (field, cmp, value, children or ''). */
interface ErrorTarget {
  node: number[];
  slot: string;
}

export const errorKey = (node: NodePath, slot = '') => `${node.join('.')}|${slot}`;

/**
 * Reads a server error path (`rule.children.1.value`, `rule.children.0.`, `rule`) into a node
 * path and slot. Returns null for paths outside the rule.
 */
export function parseErrorPath(path: string): ErrorTarget | null {
  const parts = path.split('.');
  if (parts[0] !== 'rule') return null;
  const node: number[] = [];
  let i = 1;
  while (parts[i] === 'children' && /^\d+$/.test(parts[i + 1] ?? '')) {
    node.push(Number(parts[i + 1]));
    i += 2;
  }
  return { node, slot: parts.slice(i).filter(Boolean).join('.') };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function realDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function leafError(leaf: CircleLeaf, spec: FieldSpec | undefined): [string, string] | null {
  if (!spec) {
    return leaf.field.startsWith('field:')
      ? ['field', 'That profile field no longer exists. Choose another.']
      : ['field', 'Segments can’t filter on that. Choose another field.'];
  }
  if (!comparatorsFor(spec).includes(leaf.cmp)) {
    return ['cmp', 'That comparison doesn’t apply to this field.'];
  }
  const value = leaf.value;
  switch (valueInput(spec, leaf.cmp)) {
    case 'none':
      return null;
    case 'text':
      return typeof value === 'string' && value.length > 0 ? null : ['value', 'Enter a value.'];
    case 'choice':
      if (typeof value !== 'string' || !value) return ['value', 'Choose a value.'];
      return spec.matrix === 'enum' && !spec.choices?.includes(value)
        ? ['value', 'Choose one of the listed values.']
        : null;
    case 'text-list':
    case 'choice-list':
      if (!Array.isArray(value) || value.length === 0) return ['value', 'Pick at least one value.'];
      if (value.length > MAX_LIST) return ['value', `Pick at most ${MAX_LIST} values.`];
      return null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : ['value', 'Enter a number.'];
    case 'count':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? null
        : ['value', 'Enter a whole number, 0 or more.'];
    case 'days':
      return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_DAYS
        ? null
        : ['value', `Enter a number of days from 1 to ${MAX_DAYS}.`];
    case 'date':
      return typeof value === 'string' && realDate(value)
        ? null
        : ['value', 'Use a date like 2026-10-27.'];
    case 'boolean':
      return typeof value === 'boolean' ? null : ['value', 'Choose yes or no.'];
  }
}

/**
 * Problems the server would refuse, keyed by errorKey(node, slot). Empty when the rule can be
 * previewed and saved. Limits on depth and conditions are reported on the root.
 */
export function validateRule(
  root: CircleGroup,
  catalogue: readonly FieldSpec[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  const visit = (node: CircleRule, path: number[]) => {
    if (isGroup(node)) {
      if (node.children.length === 0) {
        errors[errorKey(path, 'children')] = 'Add a condition to this group, or remove it.';
      } else if (node.op === 'not' && node.children.length !== 1) {
        errors[errorKey(path, 'children')] = '“None” takes exactly one condition or group.';
      } else if (node.children.length > MAX_CHILDREN) {
        errors[errorKey(path, 'children')] = `A group holds at most ${MAX_CHILDREN} items.`;
      }
      node.children.forEach((child, i) => visit(child, [...path, i]));
      return;
    }
    const problem = leafError(node, findField(catalogue, node.field));
    if (problem) errors[errorKey(path, problem[0])] = problem[1];
  };
  visit(root, []);
  const { depth, conditions } = measure(root);
  if (depth > MAX_DEPTH) errors[errorKey([], '')] = `Nest groups at most ${MAX_DEPTH} deep.`;
  if (conditions > MAX_CONDITIONS)
    errors[errorKey([], '')] = `Use at most ${MAX_CONDITIONS} conditions.`;
  return errors;
}

/** Server error details mapped onto the tree, keyed like validateRule. */
export function serverRuleErrors(
  details: readonly { path: string; message: string }[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const detail of details) {
    const target = parseErrorPath(detail.path);
    if (!target) continue;
    const key = errorKey(target.node, target.slot);
    errors[key] ??= detail.message;
  }
  return errors;
}

/** A plain-language summary, for the audience picker and the send dialog. */
export function describeAudience(
  audience: { include: readonly string[]; exclude: readonly string[] },
  names: ReadonlyMap<string, string>,
): string {
  const name = (id: string) => names.get(id) ?? 'a deleted segment';
  const list = (ids: readonly string[]) => {
    const items = ids.map(name);
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  };
  const base = audience.include.length ? `Subscribers in ${list(audience.include)}` : 'Everyone';
  return audience.exclude.length
    ? `${base}, except subscribers in ${list(audience.exclude)}`
    : base;
}
