// A design as the studio changes it: which files it draws with, whether it differs from what is
// published, and the template and code switches. Pure, so it is tested on its own.
import type { Design, SectionInstance, ThemeFiles } from '@swarm/site-themes';

export interface ThemeChoice {
  id: string;
  name: string;
  description: string;
  files: ThemeFiles;
}

/** The files a design draws with: its own once the code was edited, else its built-in theme's. */
export function filesOf(design: Design, themes: readonly ThemeChoice[]): ThemeFiles | null {
  return design.files ?? themes.find((t) => t.id === design.theme)?.files ?? null;
}

/** JSON with keys in order, so two designs compare by content, not by how they were built. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const sameDesign = (a: Design | null, b: Design | null) =>
  !!a && !!b && stableStringify(a) === stableStringify(b);

/**
 * Another template. Settings and sections stay: the built-in themes share their section types and
 * their standard tokens, so the words, images and style come along. A design with its own code
 * goes back to the built-in files of the theme chosen.
 */
export function switchTheme(design: Design, id: string): Design {
  return { ...design, theme: id, files: null };
}

/** Edit code: the built-in files become the design's own. */
export function copyThemeFiles(design: Design, files: ThemeFiles): Design {
  return { ...design, files: { ...files } };
}

/** Back to the built-in theme's files. */
export function resetCode(design: Design): Design {
  return { ...design, files: null };
}

/** The sections, made concrete from the theme's defaults the first time someone arranges them. */
export function withSections(
  design: Design,
  defaults: readonly SectionInstance[],
  change: (sections: SectionInstance[]) => SectionInstance[],
): Design {
  const current = design.sections ?? structuredClone([...defaults]);
  return { ...design, sections: change(current) };
}

/** A person as the API names them: a name, else an email, else nothing. */
export function personName(
  person: string | { name?: string | null; email?: string | null } | null | undefined,
): string | null {
  if (!person) return null;
  if (typeof person === 'string') return person;
  return person.name || person.email || null;
}

const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** "21:10" today, else "5 Nov, 21:10". */
export function whenSaved(date: Date, now = new Date()): string {
  return date.toDateString() === now.toDateString()
    ? timeFormat.format(date)
    : dayFormat.format(date);
}
