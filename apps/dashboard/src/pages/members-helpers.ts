// Pure helpers for the Members pages: table columns and their persistence, import mapping checks,
// status wording and profile field drafts. Kept free of React so they can be unit tested.
//
// The dashboard imports only types from @swarm/domain, so zod stays out of the bundle. The few
// rules and limits needed here are copied, and members-helpers.test.ts checks them against the
// domain package so they can't drift.
import type {
  FieldType,
  FieldValue,
  ImportTarget,
  MemberEngagement,
  MemberField,
  MemberStatus,
} from '@swarm/domain';
import { ENGAGEMENT_BAND_LABELS } from '../circles/rules';

/**
 * Shown in place of encrypted profile fields when the API flags a subscriber
 * `encryptedUnavailable`: the fields still hold their values, they just couldn't be opened now.
 */
export const FIELDS_UNAVAILABLE =
  'Profile fields are temporarily unavailable. They are kept safe; try again in a few minutes.';

export const MEMBER_STATUSES = [
  'pending',
  'active',
  'paused',
  'unsubscribed',
  'bounced',
  'complained',
] as const satisfies readonly MemberStatus[];

/** Up to this many Members per bulk action (BULK_MAX_MEMBERS). */
export const BULK_MAX = 1000;
export const DEFAULT_PAUSE_DAYS = 28;
export const MAX_PAUSE_DAYS = 366;
/** New Members at or above this start a warm import (WARM_IMPORT_THRESHOLD). */
export const WARM_IMPORT_AT = 10_000;
/** The largest import file (IMPORT_MAX_BYTES). */
export const IMPORT_MAX_BYTES = 50 * 1024 * 1024;

/** The statuses a teammate may move a Member to: `nextStatuses(from, 'operator')`. */
const OPERATOR_NEXT: Record<MemberStatus, readonly MemberStatus[]> = {
  pending: ['unsubscribed'],
  active: ['paused', 'unsubscribed'],
  paused: ['active', 'unsubscribed'],
  unsubscribed: [],
  bounced: [],
  complained: [],
};
export const operatorNext = (from: MemberStatus) => OPERATOR_NEXT[from];

// ---- Statuses --------------------------------------------------------------------------------

export const STATUS_LABEL: Record<MemberStatus, string> = {
  pending: 'Pending',
  active: 'Active',
  paused: 'Paused',
  unsubscribed: 'Unsubscribed',
  bounced: 'Bounced',
  complained: 'Complained',
};

export const STATUS_TONE: Record<MemberStatus, 'success' | 'neutral' | 'scheduled' | 'danger'> = {
  pending: 'scheduled',
  active: 'success',
  paused: 'neutral',
  unsubscribed: 'neutral',
  bounced: 'danger',
  complained: 'danger',
};

/** Why a status has no change on offer, for Members a teammate can't move. */
export const STATUS_LOCKED: Partial<Record<MemberStatus, string>> = {
  unsubscribed:
    'Only the subscriber can come back after unsubscribing, by confirming from an email.',
  bounced: 'This address bounced, so it stays suppressed.',
  complained: 'This address marked a post as spam, so it stays suppressed.',
};

/** The changes a teammate may make from `status`, with the button wording for each. */
export function statusActions(
  status: MemberStatus,
): { to: MemberStatus; label: string; danger: boolean }[] {
  return operatorNext(status).map((to) => ({
    to,
    label: to === 'paused' ? 'Pause' : to === 'active' ? 'Resume' : 'Unsubscribe',
    danger: to === 'unsubscribed',
  }));
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Date input bounds for a pause: tomorrow up to the longest allowed pause, four weeks by default. */
export function pauseBounds(now = Date.now()) {
  return {
    min: isoDay(now + DAY_MS),
    max: isoDay(now + (MAX_PAUSE_DAYS - 1) * DAY_MS),
    initial: isoDay(now + DEFAULT_PAUSE_DAYS * DAY_MS),
  };
}

/** A YYYY-MM-DD pause end as the timestamp the API takes: the end of that day, UTC. */
export const pauseUntilIso = (day: string) => `${day}T23:59:59.000Z`;

// ---- Columns ---------------------------------------------------------------------------------

export const MEMBER_COLUMNS = [
  { id: 'name', label: 'Name' },
  { id: 'status', label: 'Status' },
  { id: 'tags', label: 'Tags' },
  { id: 'digest', label: 'Delivery' },
  { id: 'joined', label: 'Joined' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'pausedUntil', label: 'Paused until' },
  { id: 'engagement', label: 'Engagement' },
] as const;
export type MemberColumn = (typeof MEMBER_COLUMNS)[number]['id'];
export const DEFAULT_COLUMNS: readonly MemberColumn[] = ['name', 'status', 'tags', 'joined'];

/** A profile field shown as a column: `field:<key>`. */
type FieldColumn = `field:${string}`;
/** Any column the Member list can show: a built-in one or a profile field. */
export type ListColumn = MemberColumn | FieldColumn;
/** The most profile field columns at once (MAX_LIST_FIELDS). */
export const MAX_FIELD_COLUMNS = 20;

const FIELD_COLUMN = /^field:[a-z][a-z0-9_]{0,39}$/;
const isFieldColumn = (id: string): id is FieldColumn => FIELD_COLUMN.test(id);
export const fieldColumn = (key: string): FieldColumn => `field:${key}`;

/** Built-in columns in table order, then profile field columns in the order they were added. */
function ordered(chosen: Iterable<string>): ListColumn[] {
  const set = new Set(chosen);
  const fields = [...set].filter(isFieldColumn).slice(0, MAX_FIELD_COLUMNS);
  return [...MEMBER_COLUMNS.map((c) => c.id).filter((id) => set.has(id)), ...fields];
}

/** The profile field keys to ask the API for: chosen columns whose field still exists. */
export function fieldColumnKeys(columns: readonly ListColumn[], fields: readonly MemberField[]) {
  const keys = new Set(fields.map((f) => f.key));
  return columns
    .filter(isFieldColumn)
    .map((c) => c.slice('field:'.length))
    .filter((k) => keys.has(k));
}

const KNOWN = new Set<string>(MEMBER_COLUMNS.map((c) => c.id));
const known = (v: unknown): v is string =>
  typeof v === 'string' && (KNOWN.has(v) || isFieldColumn(v));

/** Column choices are kept per teammate, on this device. */
export const columnsStorageKey = (operatorId: string) => `swarm:member-columns:${operatorId}`;

type Reader = Pick<Storage, 'getItem'>;
type Writer = Pick<Storage, 'setItem'>;

/** The browser's storage, or null when it is blocked. */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The saved columns, in table order; the defaults when nothing usable is stored. */
export function readColumns(storage: Reader | null, key: string): ListColumn[] {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(key) ?? null;
  } catch {
    return [...DEFAULT_COLUMNS];
  }
  if (!raw) return [...DEFAULT_COLUMNS];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_COLUMNS];
    return ordered(parsed.filter(known));
  } catch {
    return [...DEFAULT_COLUMNS];
  }
}

/**
 * Columns from a comma-separated list (the URL), in table order. An empty list is valid (only the
 * email shows); a list with nothing usable in it is undefined.
 */
export function parseColumns(raw: string): ListColumn[] | undefined {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const usable = parts.filter(known);
  if (parts.length > 0 && usable.length === 0) return undefined;
  return ordered(usable);
}

export function writeColumns(storage: Writer | null, key: string, columns: ListColumn[]) {
  try {
    storage?.setItem(key, JSON.stringify(columns));
  } catch {
    // Storage can be full or blocked; the choice then lasts for this visit only.
  }
}

/** Adds or removes a column, keeping table order (a new profile field column goes last). */
export function toggleColumn(columns: ListColumn[], id: ListColumn): ListColumn[] {
  if (columns.includes(id)) return columns.filter((c) => c !== id);
  if (isFieldColumn(id) && columns.filter(isFieldColumn).length >= MAX_FIELD_COLUMNS) {
    return columns;
  }
  return ordered([...columns, id]);
}

/** A profile field value as table text. */
export function fieldText(value: FieldValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length ? value.join(', ') : null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

// ---- Import mapping --------------------------------------------------------------------------

/** Select values for import targets: '' means "Don't import". */
export const targetToValue = (target: ImportTarget) => target ?? '';
export const valueToTarget = (value: string): ImportTarget => (value === '' ? null : value);

/** `rosters`: offer Roster names as a target (the rosters flag is on). */
export function targetOptions(fields: MemberField[], rosters = false) {
  return [
    { value: '', label: 'Don’t import' },
    { value: 'email', label: 'Email' },
    { value: 'first_name', label: 'First name' },
    { value: 'last_name', label: 'Last name' },
    { value: 'tags', label: 'Tags' },
    ...(rosters ? [{ value: 'rosters', label: 'Rosters (names)' }] : []),
    ...fields.map((f) => ({ value: `field:${f.key}`, label: `Profile field: ${f.label}` })),
  ];
}

interface MappingCheck {
  /** Problems by column name. */
  columns: Record<string, string>;
  /** A problem with the mapping as a whole. */
  general: string | null;
}

/**
 * Mirrors the server's checks: exactly one email column, and one column per target except tags
 * and Rosters.
 */
export function checkMapping(
  mapping: Record<string, ImportTarget>,
  fields: MemberField[],
): MappingCheck {
  // No prototype: the file's column "constructor" has no problem unless one is found.
  const columns = Object.create(null) as Record<string, string>;
  const seen = new Map<string, string>();
  const keys = new Set(fields.map((f) => f.key));
  for (const [column, target] of Object.entries(mapping)) {
    if (!target) continue;
    if (target.startsWith('field:') && !keys.has(target.slice(6))) {
      columns[column] = 'There is no profile field with this key.';
      continue;
    }
    if (target !== 'tags' && target !== 'rosters') {
      const first = seen.get(target);
      if (first !== undefined) {
        columns[column] = `“${first}” already goes here.`;
        continue;
      }
      seen.set(target, column);
    }
  }
  return {
    columns,
    general: seen.has('email') ? null : 'Pick the column that holds email addresses.',
  };
}

export const mappingIsValid = (check: MappingCheck) =>
  !check.general && Object.keys(check.columns).length === 0;

// ---- Profile field drafts ----------------------------------------------------------------------

/** What a form control holds for a field: text for most, a list for multi-select. */
export type FieldDraft = string | string[];

export function toDraft(type: FieldType, value: FieldValue | undefined): FieldDraft {
  if (value === null || value === undefined) return type === 'multi_select' ? [] : '';
  if (type === 'multi_select') return Array.isArray(value) ? value : [String(value)];
  if (type === 'boolean') return value === true ? 'yes' : value === false ? 'no' : '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/** The API value for a draft. Empty means "clear". Number text the server can't read is sent as is. */
export function fromDraft(type: FieldType, draft: FieldDraft): FieldValue {
  if (Array.isArray(draft)) return draft.length ? draft : null;
  const text = draft.trim();
  if (!text) return null;
  if (type === 'boolean') return text === 'yes';
  if (type === 'number') {
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
  }
  return text;
}

const sameDraft = (a: FieldDraft, b: FieldDraft) =>
  Array.isArray(a) && Array.isArray(b) ? a.join('\u0000') === b.join('\u0000') : a === b;

/** Only the fields whose drafts differ from what is saved. */
export function changedFields(
  fields: MemberField[],
  saved: Record<string, FieldValue>,
  drafts: Record<string, FieldDraft>,
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const field of fields) {
    const draft = drafts[field.key];
    if (draft === undefined) continue;
    if (!sameDraft(draft, toDraft(field.type, saved[field.key]))) {
      out[field.key] = fromDraft(field.type, draft);
    }
  }
  return out;
}

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  boolean: 'Yes or no',
  select: 'One choice',
  multi_select: 'Several choices',
};

/** A field key suggested from its label: lowercase, digits and underscores, starting with a letter. */
export function keyFromLabel(label: string): string {
  const key = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 40)
    .replace(/_+$/, '');
  return key;
}

export const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('en-US')} KB`;

// ---- Engagement ------------------------------------------------------------------------------

/** The engagement column: a level, with the score when there is one. */
export function engagementText(engagement: MemberEngagement | null | undefined): string {
  if (!engagement) return '—';
  const label = ENGAGEMENT_BAND_LABELS[engagement.band];
  return engagement.score === null ? label : `${label} (${engagement.score})`;
}

/** Why a Member has the level they have, in a sentence. */
export function engagementDetail(engagement: MemberEngagement): string {
  const { sentCount: sent, openedCount: opened, clickedCount: clicked, band } = engagement;
  const posts = `${sent} ${sent === 1 ? 'post' : 'posts'}`;
  if (band === 'too_few_posts')
    return `${posts} reached them in the last 90 days, so it's too soon to tell.`;
  if (band === 'opens_hidden')
    return `Their mail app or a privacy service opens everything, and they haven't clicked, so it can't be told if they read.`;
  return `Opened ${opened} and clicked in ${clicked} of the ${posts} that reached them in the last 90 days.`;
}
