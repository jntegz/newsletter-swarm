// A theme's files, checked and parsed together: theme.json, layout.html, sections, snippets and
// theme.css. Compiling is what saving runs (to report problems with their file and line) and what
// rendering starts from (the parsed trees, cached per design version by the site).
import { THEME_LIMITS } from '@swarm/domain';
import type { Node, Parsed, Problem } from './parse';
import { parseTemplate } from './parse';
import { inlineStyleProblem } from './html';
import type { RenderFiles } from './render';
import type { SectionSchema, SettingDef } from './settings';
import { settingDefsProblems, settingsProblems } from './settings';

export type ThemeFiles = Record<string, string>;

// One set of limits for the API's request schema and the engine: they live in @swarm/domain.
export { THEME_LIMITS };

const FILE_NAME =
  /^(theme\.json|layout\.html|theme\.css|(sections|snippets)\/[a-z0-9][a-z0-9_-]{0,39}\.html)$/;

export type Audience = 'everyone' | 'visitors' | 'subscribers';
export type Device = 'all' | 'phone' | 'desktop';

/** Which of a section's two sets of settings a page view drew (docs/site-themes.md, A/B tests). */
export type Variant = 'a' | 'b';

/**
 * An A/B test on one section: a second set of settings (B) drawn for about half the home page
 * views while it runs. Ending it is a change to the draft like any other: `status` 'ended', the
 * `winner`, and for B the section's settings replaced with B's.
 */
export interface SectionExperiment {
  id: string;
  status: 'running' | 'ended';
  /** Variant B's settings, checked against the section's schema like A's. */
  variantB: Record<string, unknown>;
  /** ISO dates. */
  startedAt: string;
  endedAt?: string | undefined;
  winner?: Variant | undefined;
}

/** One section on the page, as the owner arranged it. */
export interface SectionInstance {
  id: string;
  type: string;
  settings: Record<string, unknown>;
  hidden?: boolean | undefined;
  audience?: Audience | undefined;
  device?: Device | undefined;
  experiment?: SectionExperiment | undefined;
}

export interface CompiledTheme {
  name: string;
  settings: SettingDef[];
  /** The sections a new design starts with. */
  defaults: SectionInstance[];
  schemas: Record<string, SectionSchema>;
  files: RenderFiles;
  css: string;
  /** Per file: whether it (or what it renders) has the signup form, or an <h1>. */
  reach: { subscribe: Set<string>; h1: Set<string>; layoutSubscribe: boolean; layoutH1: boolean };
}

const problem = (file: string, message: string, line = 1, column = 1): Problem => ({
  file,
  line,
  column,
  message,
  severity: 'error',
});

/** Why theme CSS can't be used, or null: the custom CSS rules, with a theme-sized limit. */
function themeCssProblem(css: string): string | null {
  if (css.length > THEME_LIMITS.css)
    return `Keep theme.css under ${THEME_LIMITS.css.toLocaleString('en')} characters.`;
  if (css.toLowerCase().includes('</')) return 'CSS can’t contain “</”.';
  return inlineStyleProblem(css);
}

/** Line of the first match, for CSS problems. */
function lineOf(text: string, pattern: RegExp): number {
  const m = pattern.exec(text);
  return m ? text.slice(0, m.index).split('\n').length : 1;
}

export function compileTheme(files: ThemeFiles): {
  theme: CompiledTheme | null;
  problems: Problem[];
} {
  const problems: Problem[] = [];
  const names = Object.keys(files);
  if (names.length > THEME_LIMITS.files)
    problems.push(problem('theme', `A theme can have at most ${THEME_LIMITS.files} files.`));
  const bytes = names.reduce((n, name) => n + (files[name]?.length ?? 0), 0);
  if (bytes > THEME_LIMITS.bytes)
    problems.push(problem('theme', `A theme can be at most ${THEME_LIMITS.bytes / 1024} KB.`));
  for (const name of names) {
    if (!FILE_NAME.test(name)) {
      problems.push(
        problem(
          name,
          'Theme files are theme.json, layout.html, theme.css, sections/<name>.html and snippets/<name>.html, in lower case.',
        ),
      );
    }
  }

  // theme.json
  let manifest: { name?: unknown; settings?: unknown; sections?: unknown } = {};
  const manifestText = files['theme.json'];
  if (manifestText === undefined)
    problems.push(problem('theme.json', 'A theme needs a theme.json.'));
  else {
    try {
      manifest = JSON.parse(manifestText) as typeof manifest;
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
        throw new Error('not an object');
    } catch (error) {
      problems.push(
        problem('theme.json', `theme.json isn’t valid JSON: ${(error as Error).message}`),
      );
      manifest = {};
    }
  }
  const name =
    typeof manifest.name === 'string' && manifest.name.trim()
      ? manifest.name.trim().slice(0, 60)
      : 'Untitled theme';
  const settingDefs = Array.isArray(manifest.settings) ? (manifest.settings as SettingDef[]) : [];
  for (const message of settingDefsProblems(manifest.settings ?? [], 'theme.json'))
    problems.push(problem('theme.json', message));

  // Templates.
  const parsed = new Map<string, Parsed>();
  for (const file of names.filter((n) => n.endsWith('.html')).sort()) {
    const result = parseTemplate(file, files[file] ?? '');
    parsed.set(file, result);
    problems.push(...result.problems);
    if (!file.startsWith('sections/') && result.schema) {
      problems.push(
        problem(file, '{% schema %} belongs in section files only.', result.schema.line),
      );
    }
    if (
      file.startsWith('snippets/') &&
      (result.facts.sectionsTag || result.facts.sections.length)
    ) {
      problems.push(
        problem(file, 'Snippets can’t draw sections; use {% render %} from a section instead.'),
      );
    }
    if (file.startsWith('sections/') && result.facts.sectionsTag) {
      problems.push(problem(file, '{% sections %} belongs in layout.html.'));
    }
  }
  const layout = parsed.get('layout.html');
  if (layout && !layout.facts.sectionsTag && layout.facts.sections.length === 0) {
    problems.push(
      problem('layout.html', 'layout.html should draw the sections with {% sections %}.', 1, 1),
    );
  }

  // Section schemas.
  const schemas: Record<string, SectionSchema> = {};
  const sections: Record<string, Node[]> = {};
  const snippets: Record<string, Node[]> = {};
  for (const [file, result] of parsed) {
    const base = file.replace(/^(sections|snippets)\//, '').replace(/\.html$/, '');
    if (file.startsWith('snippets/')) snippets[base] = result.nodes;
    if (!file.startsWith('sections/')) continue;
    sections[base] = result.nodes;
    let schema: SectionSchema = { name: base, settings: [] };
    if (result.schema) {
      try {
        const raw = JSON.parse(result.schema.text) as Partial<SectionSchema>;
        schema = {
          name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : base,
          ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
          settings: Array.isArray(raw.settings) ? raw.settings : [],
          ...(typeof raw.limit === 'number' ? { limit: raw.limit } : {}),
        };
        for (const message of settingDefsProblems(raw.settings ?? [], `${file} schema`)) {
          problems.push(problem(file, message, result.schema.line));
        }
      } catch (error) {
        problems.push(
          problem(
            file,
            `The {% schema %} isn’t valid JSON: ${(error as Error).message}`,
            result.schema.line,
          ),
        );
      }
    } else {
      problems.push({
        ...problem(
          file,
          'This section has no {% schema %}, so it has no settings and is named after its file.',
        ),
        severity: 'warning',
      });
    }
    schemas[base] = schema;
  }

  // References between files.
  for (const [file, result] of parsed) {
    for (const s of result.facts.sections) {
      if (!sections[s])
        problems.push(problem(file, `There is no section “${s}” (sections/${s}.html).`));
    }
    for (const r of result.facts.renders) {
      if (!snippets[r])
        problems.push(problem(file, `There is no snippet “${r}” (snippets/${r}.html).`));
    }
  }

  // Which files reach the signup form and an <h1>, following {% render %}.
  const reaches = (start: string, test: (p: Parsed) => boolean) => {
    const seen = new Set<string>();
    const visit = (file: string): boolean => {
      if (seen.has(file)) return false;
      seen.add(file);
      const p = parsed.get(file);
      if (!p) return false;
      return test(p) || p.facts.renders.some((r) => visit(`snippets/${r}.html`));
    };
    return visit(start);
  };
  const reach: CompiledTheme['reach'] = {
    subscribe: new Set(
      Object.keys(sections).filter((s) => reaches(`sections/${s}.html`, (p) => p.facts.subscribe)),
    ),
    h1: new Set(
      Object.keys(sections).filter((s) =>
        reaches(`sections/${s}.html`, (p) => p.facts.headings.includes('h1')),
      ),
    ),
    layoutSubscribe: !!layout && reaches('layout.html', (p) => p.facts.subscribe),
    layoutH1: !!layout && reaches('layout.html', (p) => p.facts.headings.includes('h1')),
  };

  // CSS.
  const css = files['theme.css'] ?? '';
  const cssProblem = themeCssProblem(css);
  if (cssProblem)
    problems.push(
      problem(
        'theme.css',
        cssProblem,
        lineOf(css, /@import|url\(|\\|expression\(|javascript:|<\//i),
      ),
    );

  // Default sections.
  const defaults: SectionInstance[] = [];
  if (manifest.sections !== undefined && !Array.isArray(manifest.sections)) {
    problems.push(problem('theme.json', '"sections" should be a list.'));
  }
  (Array.isArray(manifest.sections) ? manifest.sections : []).forEach((raw: unknown, i: number) => {
    const item = (raw ?? {}) as Partial<SectionInstance>;
    if (typeof item.type !== 'string' || !sections[item.type]) {
      problems.push(
        problem('theme.json', `Section ${i + 1}: there is no section “${String(item.type)}”.`),
      );
      return;
    }
    const settings = item.settings && typeof item.settings === 'object' ? item.settings : {};
    for (const message of Object.values(
      settingsProblems(schemas[item.type]?.settings ?? [], settings),
    )) {
      problems.push(problem('theme.json', `Section ${i + 1} (${item.type}): ${message}`));
    }
    defaults.push({
      id: `${item.type}-${i + 1}`,
      type: item.type,
      settings,
      ...(item.audience ? { audience: item.audience } : {}),
      ...(item.device ? { device: item.device } : {}),
    });
  });

  const errors = problems.filter((p) => p.severity === 'error');
  return {
    theme: errors.length
      ? null
      : {
          name,
          settings: settingDefs,
          defaults,
          schemas,
          files: { layout: layout?.nodes ?? null, sections, snippets },
          css,
          reach,
        },
    problems,
  };
}
