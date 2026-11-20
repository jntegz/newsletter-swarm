// The page's sections as the studio edits them: add, duplicate, delete, move, hide, and who and
// where each one shows. Every operation returns a new list, so Undo is keeping the old one.
import type {
  Audience,
  CompiledTheme,
  Device,
  SectionInstance,
  SectionSchema,
} from '@swarm/site-themes';
import { moveItem } from '../site/helpers';

const SECTION_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** The engine's own cap on sections per page. */
export const MAX_SECTIONS = 30;

/** A new id for a section of `type`: hero-2 when hero-1 is taken. */
export function newSectionId(type: string, taken: readonly SectionInstance[]): string {
  const ids = new Set(taken.map((s) => s.id));
  const base =
    type
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .slice(0, 34) || 'section';
  for (let n = 1; ; n++) {
    const id = `${base}-${n}`;
    if (!ids.has(id) && SECTION_ID.test(id)) return id;
  }
}

/** Why another section of this type can't go on the page, or null. */
export function addProblem(
  schemas: CompiledTheme['schemas'],
  sections: readonly SectionInstance[],
  type: string,
): string | null {
  const schema = schemas[type];
  if (!schema) return 'This theme has no such section.';
  if (sections.length >= MAX_SECTIONS) return `A page holds at most ${MAX_SECTIONS} sections.`;
  const limit = schema.limit;
  if (limit && sections.filter((s) => s.type === type).length >= limit)
    return limit === 1 ? 'Already on the page.' : `At most ${limit} on a page.`;
  return null;
}

/** Adds a section of `type` after `afterIndex` (at the end without one). */
export function addSection(
  sections: readonly SectionInstance[],
  type: string,
  afterIndex?: number,
): { sections: SectionInstance[]; added: SectionInstance } {
  const added: SectionInstance = { id: newSectionId(type, sections), type, settings: {} };
  const at = afterIndex === undefined ? sections.length : afterIndex + 1;
  const next = [...sections];
  next.splice(Math.max(0, Math.min(at, next.length)), 0, added);
  return { sections: next, added };
}

/** A copy of a section, right after it, with its own id. */
export function duplicateSection(
  sections: readonly SectionInstance[],
  id: string,
): { sections: SectionInstance[]; added: SectionInstance | null } {
  const index = sections.findIndex((s) => s.id === id);
  const source = sections[index];
  if (!source) return { sections: [...sections], added: null };
  const added: SectionInstance = {
    ...structuredClone(source),
    id: newSectionId(source.type, sections),
  };
  // A copy starts without the original's A/B test, whose results belong to the original.
  delete added.experiment;
  const next = [...sections];
  next.splice(index + 1, 0, added);
  return { sections: next, added };
}

/** The list without a section, and where it was, so Undo can put it back. */
export function removeSection(
  sections: readonly SectionInstance[],
  id: string,
): { sections: SectionInstance[]; removed: SectionInstance | null; index: number } {
  const index = sections.findIndex((s) => s.id === id);
  if (index === -1) return { sections: [...sections], removed: null, index: -1 };
  return {
    sections: sections.filter((s) => s.id !== id),
    removed: sections[index] ?? null,
    index,
  };
}

/** Moves a section by `by` places (-1 up, 1 down), staying inside the list. */
export function moveSection(
  sections: readonly SectionInstance[],
  id: string,
  by: number,
): SectionInstance[] {
  const index = sections.findIndex((s) => s.id === id);
  if (index === -1) return [...sections];
  return moveItem(sections, index, index + by);
}

/**
 * Moves a section to where it was dropped: `to` is the gap it lands in, 0 before the first
 * section and `length` after the last, as a drop line between rows reads.
 */
export function dropSection(
  sections: readonly SectionInstance[],
  id: string,
  to: number,
): SectionInstance[] {
  const from = sections.findIndex((s) => s.id === id);
  if (from === -1) return [...sections];
  const target = to > from ? to - 1 : to;
  return moveItem(sections, from, target);
}

/** One section changed, the rest as they are. */
export function updateSection(
  sections: readonly SectionInstance[],
  id: string,
  patch: Partial<Omit<SectionInstance, 'id'>>,
): SectionInstance[] {
  return sections.map((s) => {
    if (s.id !== id) return s;
    const next: SectionInstance = { ...s, ...patch } as SectionInstance;
    // The defaults are left out, so a saved design only says what differs.
    if (next.hidden === false) delete next.hidden;
    if (next.audience === 'everyone') delete next.audience;
    if (next.device === 'all') delete next.device;
    return next;
  });
}

/**
 * When the theme's files rename a section type, the page's sections of that type follow, so
 * renaming sections/quote.html to sections/pull_quote.html keeps them on the page.
 */
export function renameSectionType(
  sections: readonly SectionInstance[] | null,
  from: string,
  to: string,
): SectionInstance[] | null {
  if (!sections) return null;
  return sections.map((s) => (s.type === from ? { ...s, type: to } : s));
}

export const AUDIENCES: { value: Audience; label: string; short: string }[] = [
  { value: 'everyone', label: 'Everyone', short: 'Everyone' },
  { value: 'visitors', label: 'Visitors', short: 'Visitors only' },
  { value: 'subscribers', label: 'Subscribers', short: 'Subscribers only' },
];

export const DEVICES: { value: Device; label: string; short: string }[] = [
  { value: 'all', label: 'All screens', short: 'All screens' },
  { value: 'phone', label: 'Phones', short: 'Phones only' },
  { value: 'desktop', label: 'Larger screens', short: 'Larger screens only' },
];

/** What a section's row says about where it shows, in words: nothing when it's everywhere. */
export function sectionNotes(section: SectionInstance): string[] {
  const notes: string[] = [];
  if (section.hidden) notes.push('Hidden');
  const audience = AUDIENCES.find((a) => a.value === section.audience);
  if (audience && audience.value !== 'everyone') notes.push(audience.short);
  const device = DEVICES.find((d) => d.value === section.device);
  if (device && device.value !== 'all') notes.push(device.short);
  return notes;
}

/**
 * A section's name in the list: the schema's name, and its heading when it has one, so two Text
 * sections can be told apart ("Text: Why I write").
 */
export function sectionTitle(
  section: SectionInstance,
  schema: SectionSchema | undefined,
): { name: string; detail: string | null } {
  const name = schema?.name ?? section.type;
  const heading = section.settings.heading;
  const detail =
    typeof heading === 'string' && heading.trim()
      ? heading.trim().replace(/\s+/g, ' ').slice(0, 60)
      : null;
  return { name, detail };
}
