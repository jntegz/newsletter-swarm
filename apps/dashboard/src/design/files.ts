// A theme's files as the code editor works with them: the tree, adding, renaming and deleting
// section and snippet files, finding a problem's place, and the export and import file.
import type { Problem, ThemeFiles } from '@swarm/site-themes';

const ROOT_FILES = ['theme.json', 'layout.html', 'theme.css'] as const;
export type FileFolder = 'sections' | 'snippets';

const BASE_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

interface FileTree {
  root: string[];
  sections: string[];
  snippets: string[];
}

/** The files in the order the editor lists them: the three theme files, then each folder. */
export function fileTree(files: ThemeFiles): FileTree {
  const names = Object.keys(files);
  const inFolder = (folder: FileFolder) =>
    names.filter((n) => n.startsWith(`${folder}/`)).sort((a, b) => a.localeCompare(b));
  return {
    root: ROOT_FILES.filter((n) => n in files),
    sections: inFolder('sections'),
    snippets: inFolder('snippets'),
  };
}

export const pathFor = (folder: FileFolder, base: string) => `${folder}/${base}.html`;

/** "sections/hero.html" reads "hero"; a root file keeps its name. */
export const baseName = (path: string) => path.replace(/^(sections|snippets)\//, '').replace(/\.html$/, '');

export const folderOf = (path: string): FileFolder | null =>
  path.startsWith('sections/') ? 'sections' : path.startsWith('snippets/') ? 'snippets' : null;

/** What the editor highlights a file as. */
export function languageOf(path: string): 'json' | 'css' | 'html' {
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.css')) return 'css';
  return 'html';
}

/** Why a section or snippet can't be called this, or null. Typed names are lower-cased first. */
export function fileNameProblem(
  files: ThemeFiles,
  folder: FileFolder,
  base: string,
  renaming?: string,
): string | null {
  if (!base) return 'Give it a name.';
  if (!BASE_NAME.test(base))
    return 'Use lower case letters, digits, - and _, starting with a letter or digit (up to 40).';
  const path = pathFor(folder, base);
  if (path !== renaming && path in files) return `There is already a ${path}.`;
  return null;
}

/** A typed name made into a file name: "Pull quote" becomes "pull_quote". */
export const toBaseName = (typed: string) =>
  typed
    .trim()
    .toLowerCase()
    .replace(/\.html$/, '')
    .replace(/\s+/g, '_');

/** What a new file starts with: a section has a heading and its schema, a snippet a comment. */
export function starterFile(folder: FileFolder, base: string): string {
  if (folder === 'snippets') {
    return `{% comment %}Use it with {% render '${base}' %}. A snippet sees what it is given, plus site, reader and theme.{% endcomment %}\n<div class="${base.replace(/_/g, '-')}">\n  \n</div>\n`;
  }
  const name = base.replace(/[_-]+/g, ' ');
  const title = name[0]!.toUpperCase() + name.slice(1);
  return `<section class="t-wrap ${base.replace(/_/g, '-')}">
  <h2>{{ section.settings.heading | default: '${title}' }}</h2>
  <div class="t-text">{{ section.settings.text | paragraphs }}</div>
</section>

{% schema %}
{
  "name": "${title}",
  "description": "One line for the Add section menu.",
  "settings": [
    { "id": "heading", "type": "text", "label": "Heading", "max": 120 },
    { "id": "text", "type": "textarea", "label": "Text", "max": 600 }
  ]
}
{% endschema %}
`;
}

export function addFile(files: ThemeFiles, path: string, text: string): ThemeFiles {
  return { ...files, [path]: text };
}

export function deleteFile(files: ThemeFiles, path: string): ThemeFiles {
  const next = { ...files };
  delete next[path];
  return next;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Renames a section or snippet file. Renaming a snippet also changes the {% render %} tags that
 * use it, and a section the {% section %} tags, so nothing points at the old name.
 */
export function renameFile(files: ThemeFiles, from: string, to: string): ThemeFiles {
  if (from === to || !(from in files)) return { ...files };
  const folder = folderOf(from);
  const oldBase = baseName(from);
  const newBase = baseName(to);
  const tag = folder === 'snippets' ? 'render' : 'section';
  const pattern = new RegExp(`(\\{%-?\\s*${tag}\\s+)(['"])${escapeRegExp(oldBase)}\\2`, 'g');
  const next: ThemeFiles = {};
  for (const [name, text] of Object.entries(files)) {
    const updated = name.endsWith('.html') ? text.replace(pattern, `$1$2${newBase}$2`) : text;
    next[name === from ? to : name] = updated;
  }
  return next;
}

/** Problems by file, errors first, then by place. */
export function problemsByFile(problems: readonly Problem[]): Map<string, Problem[]> {
  const out = new Map<string, Problem[]>();
  for (const problem of sortProblems(problems)) {
    const list = out.get(problem.file) ?? [];
    list.push(problem);
    out.set(problem.file, list);
  }
  return out;
}

export function sortProblems(problems: readonly Problem[]): Problem[] {
  return [...problems].sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column,
  );
}

/** The same problem twice (the browser's check and the server's) shows once. */
export function uniqueProblems(problems: readonly Problem[]): Problem[] {
  const seen = new Set<string>();
  return problems.filter((p) => {
    const key = `${p.file}:${p.line}:${p.column}:${p.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The character offset of a 1-based line and column, kept inside the text. */
export function offsetAt(text: string, line: number, column: number): number {
  let offset = 0;
  const lines = text.split('\n');
  const target = Math.max(1, Math.min(line, lines.length));
  for (let i = 0; i < target - 1; i++) offset += (lines[i]?.length ?? 0) + 1;
  const width = lines[target - 1]?.length ?? 0;
  return offset + Math.max(0, Math.min(column - 1, width));
}

export interface ThemeExport {
  format: 'swarm-theme';
  version: 1;
  name: string;
  files: ThemeFiles;
}

/** A file name for an export: "Field Notes theme.json" reads "field-notes-theme.json". */
export function exportFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug || 'theme'}.swarm-theme.json`;
}

/** Reads an uploaded theme file: the export's shape, or why it isn't one. */
export function parseThemeFile(text: string): { theme: ThemeExport } | { problem: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { problem: 'That file isn’t JSON. Choose a theme exported from Swarm.' };
  }
  const value = raw as Partial<ThemeExport> | null;
  if (!value || typeof value !== 'object' || value.format !== 'swarm-theme')
    return { problem: 'That file isn’t a Swarm theme. Choose one exported from Swarm.' };
  if (value.version !== 1)
    return { problem: 'That theme is from a newer version of Swarm. Export it again here.' };
  const files = value.files;
  if (
    !files ||
    typeof files !== 'object' ||
    Array.isArray(files) ||
    !Object.values(files).every((v) => typeof v === 'string')
  )
    return { problem: 'That theme has no files in it.' };
  if (!('theme.json' in files)) return { problem: 'That theme has no theme.json.' };
  return {
    theme: {
      format: 'swarm-theme',
      version: 1,
      name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : 'Theme',
      files: files as ThemeFiles,
    },
  };
}
