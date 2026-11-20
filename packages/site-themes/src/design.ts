// A site's design: which theme, its own copy of the files (once the code was edited), the theme
// settings and the sections in order. Checking a design is what Publish runs; drawing one is what
// the site's home page does.
import type { Problem } from './parse';
import type { RenderHooks, SectionToRender } from './render';
import { renderPage } from './render';
import type { SettingDef } from './settings';
import { mediaIds, resolveSettings, settingsProblems, withImages } from './settings';
import type {
  Audience,
  CompiledTheme,
  Device,
  SectionExperiment,
  SectionInstance,
  ThemeFiles,
  Variant,
} from './theme';
import { THEME_LIMITS, compileTheme } from './theme';
import { tokensCss, type FontLookup } from './tokens';

export interface Design {
  /** The built-in theme it started from. */
  theme: string;
  /** The site's own files once the code was edited; null uses the built-in theme's. */
  files: ThemeFiles | null;
  /** Theme settings (tokens and the theme's own). */
  settings: Record<string, unknown>;
  /** The page's sections in order; null uses the theme's defaults. */
  sections: SectionInstance[] | null;
}

const SECTION_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** How many A/B tests a design may run at once (one per section). */
export const MAX_RUNNING_TESTS = 3;
const AUDIENCES: Audience[] = ['everyone', 'visitors', 'subscribers'];
const DEVICES: Device[] = ['all', 'phone', 'desktop'];

const p = (message: string, severity: Problem['severity'] = 'error'): Problem => ({
  file: 'design',
  line: 1,
  column: 1,
  message,
  severity,
});

export const sectionsOf = (theme: CompiledTheme, design: Design) =>
  design.sections ?? theme.defaults;

/** Whether a section has an A/B test that is running. */
export const isTesting = (
  section: SectionInstance,
): section is SectionInstance & { experiment: SectionExperiment } =>
  section.experiment?.status === 'running';

/** The sections of a design with a running test that a page draws (not hidden). */
export function runningTests(theme: CompiledTheme, design: Design): SectionInstance[] {
  return sectionsOf(theme, design).filter((s) => isTesting(s) && !s.hidden);
}

const isDate = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** What is wrong with a section's A/B test, as messages; B's values against the schema too. */
function experimentProblems(
  name: string,
  experiment: SectionExperiment,
  defs: SettingDef[],
): string[] {
  const out: string[] = [];
  if (typeof experiment.id !== 'string' || !SECTION_ID.test(experiment.id))
    out.push(`${name}: the A/B test needs an id.`);
  if (experiment.status !== 'running' && experiment.status !== 'ended')
    out.push(`${name}: an A/B test is running or ended.`);
  if (!isDate(experiment.startedAt)) out.push(`${name}: the A/B test needs the date it started.`);
  if (experiment.endedAt !== undefined && !isDate(experiment.endedAt))
    out.push(`${name}: the A/B test’s end date isn’t a date.`);
  if (experiment.winner !== undefined && experiment.winner !== 'a' && experiment.winner !== 'b')
    out.push(`${name}: the A/B test’s winner is A or B.`);
  const b = experiment.variantB;
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    out.push(`${name}: variant B needs its settings.`);
  } else {
    for (const message of Object.values(settingsProblems(defs, b)))
      out.push(`${name}, variant B: ${message}`);
  }
  return out;
}

/** Problems with a design for its compiled theme: values, sections and the page's essentials. */
export function checkDesign(theme: CompiledTheme, design: Design): Problem[] {
  const problems: Problem[] = [];
  for (const message of Object.values(settingsProblems(theme.settings, design.settings))) {
    problems.push(p(`Theme setting ${message}`));
  }
  const sections = sectionsOf(theme, design);
  if (sections.length > THEME_LIMITS.sections)
    problems.push(p(`A page can have at most ${THEME_LIMITS.sections} sections.`));
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  for (const s of sections) {
    const schema = theme.schemas[s.type];
    if (!schema) {
      problems.push(p(`There is no “${s.type}” section in this theme.`));
      continue;
    }
    if (!SECTION_ID.test(s.id) || ids.has(s.id))
      problems.push(p(`Section “${schema.name}” needs its own id.`));
    ids.add(s.id);
    counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
    if (s.audience && !AUDIENCES.includes(s.audience))
      problems.push(p(`${schema.name}: who sees it should be everyone, visitors or subscribers.`));
    if (s.device && !DEVICES.includes(s.device))
      problems.push(p(`${schema.name}: where it shows should be all, phone or desktop.`));
    for (const message of Object.values(settingsProblems(schema.settings, s.settings))) {
      problems.push(p(`${schema.name}: ${message}`));
    }
    if (s.experiment) {
      for (const message of experimentProblems(schema.name, s.experiment, schema.settings))
        problems.push(p(message));
      if (isTesting(s) && s.hidden)
        problems.push(
          p(`${schema.name} is hidden, so its A/B test isn’t shown to anyone.`, 'warning'),
        );
    }
  }
  const running = sections.filter(isTesting).length;
  if (running > MAX_RUNNING_TESTS)
    problems.push(
      p(
        `A design can run at most ${MAX_RUNNING_TESTS} A/B tests at once; ${running} are running. End one first.`,
      ),
    );
  for (const [type, n] of counts) {
    const limit = theme.schemas[type]?.limit;
    if (limit && n > limit)
      problems.push(
        p(
          `A page can have ${limit} “${theme.schemas[type]?.name}” section${limit === 1 ? '' : 's'} at most.`,
        ),
      );
  }
  // What a visitor sees must let them subscribe, and the page needs one main heading.
  const forVisitors = sections.filter((s) => !s.hidden && s.audience !== 'subscribers');
  if (!theme.reach.layoutSubscribe && !forVisitors.some((s) => theme.reach.subscribe.has(s.type))) {
    problems.push(
      p(
        'Visitors have no way to subscribe: add a section with the signup form, or {% subscribe_form %} to one they see.',
      ),
    );
  }
  if (!theme.reach.layoutH1 && !sections.some((s) => !s.hidden && theme.reach.h1.has(s.type))) {
    problems.push(
      p('The page has no main heading (<h1>). Add one, usually in the first section.', 'warning'),
    );
  }
  return problems;
}

/**
 * Compiles a design's theme (its own files, else the built-in theme's `builtIn` files) and checks
 * the design against it: what saving answers with and what Publish requires to have no errors.
 */
export function compileDesign(
  design: Design,
  builtIn: ThemeFiles | null | undefined,
): { theme: CompiledTheme | null; problems: Problem[] } {
  const files = design.files ?? builtIn;
  if (!files)
    return { theme: null, problems: [p(`There is no built-in theme “${design.theme}”.`)] };
  const { theme, problems } = compileTheme(files);
  return { theme, problems: theme ? [...problems, ...checkDesign(theme, design)] : problems };
}

/**
 * The media library images a design's values use (theme settings and shown sections, with the B
 * settings of a running A/B test).
 */
export function designMediaIds(theme: CompiledTheme, design: Design): string[] {
  const ids = mediaIds(theme.settings, resolveSettings(theme.settings, design.settings));
  for (const s of sectionsOf(theme, design)) {
    const defs = theme.schemas[s.type]?.settings;
    if (!defs || s.hidden) continue;
    ids.push(...mediaIds(defs, resolveSettings(defs, s.settings)));
    if (isTesting(s)) ids.push(...mediaIds(defs, resolveSettings(defs, s.experiment.variantB)));
  }
  return [...new Set(ids)];
}

interface PageInput {
  /** site, posts, pinned, featured, page… (see docs/site-themes.md). */
  globals: Record<string, unknown>;
  reader: { is_subscriber: boolean; is_paid: boolean };
  /** Images by media id, for image settings. */
  image: (id: string) => unknown;
  /**
   * The variant each A/B test shows this view, by section id. A section with a running test and
   * 'b' here draws variant B's settings; anything else draws A's.
   */
  variants?: Record<string, Variant> | undefined;
}

/** Draws the home page of a design: the HTML for <main> and the CSS to add to the site's. */
export function renderDesign(
  theme: CompiledTheme,
  design: Design,
  input: PageInput,
  hooks: RenderHooks,
): { html: string; css: string } {
  const themeValues = withImages(
    theme.settings,
    resolveSettings(theme.settings, design.settings),
    input.image,
  );
  const sections: SectionToRender[] = sectionsOf(theme, design)
    .filter((s) => !s.hidden && theme.schemas[s.type])
    .filter((s) =>
      s.audience === 'visitors'
        ? !input.reader.is_subscriber
        : s.audience === 'subscribers'
          ? input.reader.is_subscriber
          : true,
    )
    .map((s) => {
      const defs = theme.schemas[s.type]?.settings ?? [];
      const variant: Variant = isTesting(s) && input.variants?.[s.id] === 'b' ? 'b' : 'a';
      const settings = variant === 'b' && s.experiment ? s.experiment.variantB : s.settings;
      return {
        id: s.id,
        type: s.type,
        variant,
        settings: withImages(defs, resolveSettings(defs, settings), input.image),
        classes:
          s.device === 'phone'
            ? ['t-only-phone']
            : s.device === 'desktop'
              ? ['t-only-desktop']
              : [],
      };
    });
  const html = renderPage(
    theme.files,
    sections,
    { ...input.globals, reader: input.reader, theme: themeValues },
    hooks,
  );
  const css = designCss(theme, design, input.image);
  return { html, css };
}

/**
 * A design's CSS: its tokens, the rules for where sections show, and theme.css. The site serves
 * the published design's in its stylesheet; previews put the draft's in the page. `font` finds the
 * uploaded fonts its font settings name (fontMediaIds); without it they fall back to the defaults.
 */
export function designCss(
  theme: CompiledTheme,
  design: Pick<Design, 'settings'>,
  image: (id: string) => unknown = () => null,
  font?: FontLookup,
): string {
  const values = withImages(
    theme.settings,
    resolveSettings(theme.settings, design.settings),
    image,
  );
  return `${tokensCss(theme.settings, values, font)}
.t-only-phone{display:none}@media (max-width:719px){.t-only-phone{display:block}.t-only-desktop{display:none}}
${theme.css}
`;
}
