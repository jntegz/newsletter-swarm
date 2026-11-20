// The settings form the design studio draws from a theme's declarations (theme.json settings and
// each section's {% schema %}): how settings group, which ones show, which control each one gets,
// and the small edits a list setting needs. Pure, so it is tested on its own.
import type { FontId, SettingDef } from '@swarm/site-themes';
import { valueProblem } from '@swarm/site-themes';

interface SettingGroup {
  /** The heading over the group; null for settings declared without a group. */
  title: string | null;
  defs: SettingDef[];
}

/** Settings in the order they were declared, grouped by `group` (first appearance wins). */
export function groupSettings(defs: readonly SettingDef[]): SettingGroup[] {
  const groups: SettingGroup[] = [];
  for (const def of defs) {
    const title = def.group?.trim() || null;
    const found = groups.find((g) => g.title === title);
    if (found) found.defs.push(def);
    else groups.push({ title, defs: [def] });
  }
  return groups;
}

/**
 * Whether a setting shows, by its `visible_if`: "layout:split" shows it while layout is split,
 * "layout:split,cover" while it is either, "show_count:true" while a checkbox is on, and
 * "layout:!split" while it is anything else. A condition naming a setting that doesn't exist shows
 * the setting, so a typo in a theme never hides a control for good.
 */
export function isVisible(
  def: Pick<SettingDef, 'visible_if'>,
  values: Record<string, unknown>,
  defs: readonly Pick<SettingDef, 'id'>[],
): boolean {
  const rule = def.visible_if?.trim();
  if (!rule) return true;
  const at = rule.indexOf(':');
  if (at < 1) return true;
  const id = rule.slice(0, at).trim();
  if (!defs.some((d) => d.id === id)) return true;
  let wanted = rule.slice(at + 1).trim();
  const negate = wanted.startsWith('!');
  if (negate) wanted = wanted.slice(1);
  const current = String(values[id] ?? '');
  const match = wanted
    .split(',')
    .map((w) => w.trim())
    .includes(current);
  return negate ? !match : match;
}

/** A plain label for an option value: "centred" reads "Centred", "two_up" reads "Two up". */
export function optionLabel(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : value;
}

/** A select's choices as value and label. */
export function optionsOf(def: Pick<SettingDef, 'options'>): { value: string; label: string }[] {
  return (def.options ?? []).map((o) =>
    typeof o === 'string' ? { value: o, label: optionLabel(o) } : { value: o.value, label: o.label },
  );
}

/**
 * Segmented buttons hold 2 to 4 choices across the panel (a long label wraps inside its button);
 * labels long enough to need three lines each get a select.
 */
const SEGMENTED_MAX_CHARS = 72;

type ControlKind =
  | 'text'
  | 'textarea'
  | 'url'
  | 'color'
  | 'font'
  | 'segmented'
  | 'select'
  | 'switch'
  | 'range'
  | 'number'
  | 'image'
  | 'list';

/** The control a setting gets in the studio. */
export function controlKind(def: Pick<SettingDef, 'type' | 'options'>): ControlKind {
  switch (def.type) {
    case 'select': {
      const options = optionsOf(def);
      const chars = options.reduce((n, o) => n + o.label.length, 0);
      return options.length >= 2 && options.length <= 4 && chars <= SEGMENTED_MAX_CHARS
        ? 'segmented'
        : 'select';
    }
    case 'checkbox':
      return 'switch';
    default:
      return def.type;
  }
}

const FONT_NAMES: Record<FontId, string> = {
  grotesk: 'Grotesk',
  archivo: 'Archivo',
  serif: 'Serif',
  geist: 'Geist',
  inter: 'Inter',
  system: 'System',
  mono: 'Mono',
};
const FONT_NOTES: Record<FontId, string> = {
  grotesk: 'Warm and confident',
  archivo: 'Strong at large sizes',
  serif: 'Bookish, from the device',
  geist: 'Crisp and modern',
  inter: 'Neutral, very readable',
  system: 'The reader’s own',
  mono: 'Typewritten',
};

export const fontName = (id: string) => FONT_NAMES[id as FontId] ?? optionLabel(id);
export const fontNote = (id: string) => FONT_NOTES[id as FontId] ?? '';

/** A value with a setting's change applied, as a new object. Undefined removes the key. */
export function withValue(
  values: Record<string, unknown>,
  id: string,
  value: unknown,
): Record<string, unknown> {
  const next = { ...values };
  if (value === undefined) delete next[id];
  else next[id] = value;
  return next;
}

/** A fresh list item: each field at its default, empty text otherwise. */
export function newListItem(fields: readonly SettingDef[]): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.default !== undefined) item[field.id] = field.default;
    else if (field.type === 'checkbox') item[field.id] = false;
    else if (field.type === 'text' || field.type === 'textarea' || field.type === 'url')
      item[field.id] = '';
  }
  return item;
}

/** The most items a list setting takes (the engine's cap is 20). */
export const listMax = (def: Pick<SettingDef, 'max'>) => Math.min(def.max ?? 20, 20);

/** A short name for an item in a list, for its heading and for screen readers. */
export function itemTitle(
  item: Record<string, unknown>,
  fields: readonly SettingDef[],
  index: number,
): string {
  for (const field of fields) {
    if (field.type !== 'text' && field.type !== 'textarea') continue;
    const value = item[field.id];
    if (typeof value === 'string' && value.trim()) {
      const text = value.trim().replace(/\s+/g, ' ');
      return text.length > 48 ? `${text.slice(0, 47)}…` : text;
    }
  }
  return `Item ${index + 1}`;
}

/** Why a value can't be used, as a sentence for the field, or undefined. */
export function fieldProblem(def: SettingDef, value: unknown): string | undefined {
  const problem = valueProblem(def, value);
  if (!problem) return undefined;
  return problem[0]!.toUpperCase() + problem.slice(1);
}

const HEX = /^#[0-9a-f]{6}$/i;
const SHORT_HEX = /^#?[0-9a-f]{3}$/i;

/**
 * A colour as typed in the hex field, made usable: "#ABC" and "abc" become "#aabbcc", "2f5d50"
 * gets its "#". Null while it isn't a colour yet, so the field can wait for the rest.
 */
export function normaliseHex(typed: string): string | null {
  const text = typed.trim();
  if (SHORT_HEX.test(text)) {
    const digits = text.replace('#', '');
    return `#${[...digits].map((d) => d + d).join('')}`.toLowerCase();
  }
  const full = text.startsWith('#') ? text : `#${text}`;
  return HEX.test(full) ? full.toLowerCase() : null;
}
