// Settings a theme declares, in theme.json and in each section's {% schema %}. The dashboard draws
// a control for each one, and every value an owner saves is checked against its declaration here,
// so a template only ever reads values of the type it asked for.
import { urlProblem } from './html';

const SETTING_TYPES = [
  'text',
  'textarea',
  'url',
  'color',
  'font',
  'select',
  'checkbox',
  'range',
  'number',
  'image',
  'list',
] as const;
export type SettingType = (typeof SETTING_TYPES)[number];

/**
 * The built-in fonts a site can use without loading anything from another server. A `font` setting
 * may also hold a media id: a WOFF2 or WOFF font uploaded to the media library, which the design's
 * CSS loads from the site's own /media/ address (tokens.ts).
 */
export const FONTS = ['grotesk', 'archivo', 'serif', 'geist', 'inter', 'system', 'mono'] as const;
export type FontId = (typeof FONTS)[number];

export interface SettingDef {
  id: string;
  type: SettingType;
  label: string;
  info?: string;
  default?: unknown;
  /** text, textarea: characters. list: items. */
  max?: number;
  /** select: the choices, as values or { value, label }. */
  options?: (string | { value: string; label: string })[];
  /** range and number. */
  min?: number;
  step?: number;
  unit?: string;
  /** list: the fields of each item (no nested lists). */
  fields?: SettingDef[];
  /** Shown in the dashboard only when another setting has this value: "layout:split". */
  visible_if?: string;
  /** Groups settings under a heading in the dashboard. */
  group?: string;
  /** color: text in the theme's ink colour sits on this colour, so the dashboard checks its contrast. */
  text_on?: boolean;
}

export interface SectionSchema {
  name: string;
  /** One line for the "Add section" menu. */
  description?: string;
  settings: SettingDef[];
  /** At most this many of this section on a page (default: no limit up to the page's 30). */
  limit?: number;
}

const ID = /^[a-z][a-z0-9_]{0,39}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const MEDIA_ID = /^md_[0-9a-f]{32}$/;
/** Whether a value names a media library item (an uploaded image or font): md_ and 32 hex. */
export const isMediaId = (value: unknown): value is string =>
  typeof value === 'string' && MEDIA_ID.test(value);
const TEXT_MAX = 2000;
const LIST_MAX = 20;

const optionValues = (def: SettingDef) =>
  (def.options ?? []).map((o) => (typeof o === 'string' ? o : o.value));

/** Problems with a list of declarations, as messages. Ids must be unique and sensible. */
export function settingDefsProblems(defs: unknown, where: string, nested = false): string[] {
  if (!Array.isArray(defs)) return [`${where}: "settings" should be a list.`];
  const problems: string[] = [];
  const seen = new Set<string>();
  defs.forEach((raw, i) => {
    const at = `${where}, setting ${i + 1}`;
    if (!raw || typeof raw !== 'object') return problems.push(`${at}: should be an object.`);
    const def = raw as Partial<SettingDef>;
    if (typeof def.id !== 'string' || !ID.test(def.id)) {
      return problems.push(
        `${at}: "id" should be lower case letters, digits and _, starting with a letter.`,
      );
    }
    if (seen.has(def.id)) problems.push(`${at}: "${def.id}" is declared twice.`);
    seen.add(def.id);
    if (!SETTING_TYPES.includes(def.type as SettingType)) {
      return problems.push(
        `${at} ("${def.id}"): "type" should be one of ${SETTING_TYPES.join(', ')}.`,
      );
    }
    if (typeof def.label !== 'string' || !def.label.trim()) {
      problems.push(`${at} ("${def.id}"): give it a "label" people will see.`);
    }
    if (def.type === 'select' && (!Array.isArray(def.options) || def.options.length === 0)) {
      problems.push(`${at} ("${def.id}"): a select needs "options".`);
    }
    if (def.type === 'range' && (typeof def.min !== 'number' || typeof def.max !== 'number')) {
      problems.push(`${at} ("${def.id}"): a range needs "min" and "max".`);
    }
    if (def.type === 'list') {
      if (nested) problems.push(`${at} ("${def.id}"): a list can't hold another list.`);
      else
        problems.push(...settingDefsProblems(def.fields ?? [], `${at} ("${def.id}") fields`, true));
    }
    if (def.default !== undefined) {
      const problem = valueProblem(def as SettingDef, def.default);
      if (problem) problems.push(`${at} ("${def.id}") default: ${problem}`);
    }
  });
  return problems;
}

/** Why a value can't be used for this setting, or null. */
export function valueProblem(def: SettingDef, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  switch (def.type) {
    case 'text':
    case 'textarea': {
      if (typeof value !== 'string') return 'should be text.';
      const max = Math.min(def.max ?? TEXT_MAX, TEXT_MAX);
      return value.length > max ? `keep it under ${max} characters.` : null;
    }
    case 'url':
      if (typeof value !== 'string') return 'should be an address.';
      if (!value) return null;
      return urlProblem('href', value);
    case 'color':
      return typeof value === 'string' && HEX.test(value) ? null : 'use a colour like #1a2b3c.';
    case 'font':
      return FONTS.includes(value as FontId) || isMediaId(value)
        ? null
        : `choose one of ${FONTS.join(', ')}, or a font from the media library.`;
    case 'select':
      return optionValues(def).includes(value as string)
        ? null
        : `choose one of ${optionValues(def).join(', ')}.`;
    case 'checkbox':
      return typeof value === 'boolean' ? null : 'should be on or off.';
    case 'range':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'should be a number.';
      if (def.min !== undefined && value < def.min) return `the least is ${def.min}.`;
      if (def.max !== undefined && value > def.max) return `the most is ${def.max}.`;
      return null;
    }
    case 'image':
      return typeof value === 'string' && MEDIA_ID.test(value)
        ? null
        : 'choose an image from the media library.';
    case 'list': {
      if (!Array.isArray(value)) return 'should be a list.';
      const max = Math.min(def.max ?? LIST_MAX, LIST_MAX);
      if (value.length > max) return `at most ${max} items.`;
      for (const [i, item] of value.entries()) {
        if (!item || typeof item !== 'object') return `item ${i + 1} should have fields.`;
        for (const field of def.fields ?? []) {
          const problem = valueProblem(field, (item as Record<string, unknown>)[field.id]);
          if (problem) return `item ${i + 1}, ${field.label}: ${problem}`;
        }
      }
      return null;
    }
  }
}

/** Values for every declared setting: what was saved when it is valid, else the default. */
export function resolveSettings(
  defs: SettingDef[],
  saved: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    const value = saved?.[def.id];
    const usable = value !== undefined && value !== null && !valueProblem(def, value);
    if (def.type === 'list') {
      const items =
        (usable
          ? (value as Record<string, unknown>[])
          : (def.default as Record<string, unknown>[] | undefined)) ?? [];
      out[def.id] = items.map((item) => resolveSettings(def.fields ?? [], item));
    } else {
      out[def.id] = usable ? value : (def.default ?? (def.type === 'checkbox' ? false : null));
    }
  }
  return out;
}

/** Problems with saved values, keyed by setting id, for the dashboard to show by each control. */
export function settingsProblems(
  defs: SettingDef[],
  saved: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of defs) {
    const problem = valueProblem(def, saved?.[def.id]);
    if (problem) out[def.id] = `${def.label}: ${problem}`;
  }
  return out;
}

/** Media ids used by these values (image settings, also inside lists), to look them up at once. */
export function mediaIds(defs: SettingDef[], values: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const def of defs) {
    const v = values[def.id];
    if (def.type === 'image' && typeof v === 'string' && MEDIA_ID.test(v)) ids.push(v);
    if (def.type === 'list' && Array.isArray(v)) {
      for (const item of v)
        ids.push(...mediaIds(def.fields ?? [], item as Record<string, unknown>));
    }
  }
  return ids;
}

/** Uploaded fonts these values use (font settings holding a media id), to look them up at once. */
export function fontMediaIds(defs: SettingDef[], values: Record<string, unknown>): string[] {
  const ids = defs.flatMap((def) =>
    def.type === 'font' && isMediaId(values[def.id]) ? [values[def.id] as string] : [],
  );
  return [...new Set(ids)];
}

/** Swaps image ids for images (or null), so templates can draw them with | image. */
export function withImages(
  defs: SettingDef[],
  values: Record<string, unknown>,
  lookup: (id: string) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  for (const def of defs) {
    const v = values[def.id];
    if (def.type === 'image') out[def.id] = typeof v === 'string' ? (lookup(v) ?? null) : null;
    if (def.type === 'list' && Array.isArray(v)) {
      out[def.id] = v.map((item) =>
        withImages(def.fields ?? [], item as Record<string, unknown>, lookup),
      );
    }
  }
  return out;
}
