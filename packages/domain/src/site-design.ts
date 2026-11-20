// Website themes (docs/site-themes.md): a Channel's site design, its draft and published copies,
// the versions kept on publish, previews and the theme file people share. Zod checks the shape and
// the size limits only; whether the files and values make a working page is the theme engine's
// job (@swarm/site-themes compileTheme and checkDesign), which answers with problems instead.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';
import { SiteTemplateSchema } from './p4-site';

const timestamp = z.iso.datetime().openapi({ example: '2026-11-08T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

/** How large a theme may be. @swarm/site-themes uses these same numbers when compiling. */
export const THEME_LIMITS = { files: 64, bytes: 256 * 1024, css: 120_000, sections: 30 } as const;
/** A whole design as JSON (files, settings and sections), in characters. */
export const SITE_DESIGN_MAX_CHARS = 512 * 1024;
/** Published designs kept per Channel; older ones are deleted on publish. */
export const SITE_DESIGN_VERSIONS_KEPT = 20;
/** The theme a Channel starts from when it never chose a template. */
export const DEFAULT_SITE_THEME = 'launch';

const SettingsSchema = z.record(z.string().max(60), z.unknown());

/** Which of a section's two sets of settings a view drew. */
const SectionVariantSchema = z.enum(['a', 'b']).openapi('SectionVariant');
export type SectionVariant = z.infer<typeof SectionVariantSchema>;

/** A section id as the theme engine accepts it; the beacon and the signup form carry it too. */
export const SECTION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * An A/B test on one section (docs/site-themes.md): variant B's settings, drawn for about half
 * the home page views while it runs. Ending it is an ordinary draft change: `status` ended, the
 * `winner`, and for B the section's settings replaced with B's. The engine checks B's values.
 */
const SiteDesignExperimentSchema = z
  .object({
    id: z.string().min(1).max(40),
    status: z.enum(['running', 'ended']),
    variantB: SettingsSchema,
    startedAt: timestamp,
    endedAt: timestamp.optional(),
    winner: SectionVariantSchema.optional(),
  })
  .openapi('SiteDesignExperiment');

const SiteDesignSectionSchema = z
  .object({
    id: z.string().min(1).max(40),
    type: z.string().min(1).max(40),
    settings: SettingsSchema,
    hidden: z.boolean().optional(),
    audience: z.enum(['everyone', 'visitors', 'subscribers']).optional(),
    device: z.enum(['all', 'phone', 'desktop']).optional(),
    /** An A/B test on this section, running or ended. */
    experiment: SiteDesignExperimentSchema.optional(),
  })
  .openapi('SiteDesignSection');

/** A theme's files by name: theme.json, layout.html, theme.css, sections/… and snippets/…. */
const ThemeFilesSchema = z
  .record(z.string().min(1).max(80), z.string())
  .superRefine((files, ctx) => {
    const names = Object.keys(files);
    if (names.length > THEME_LIMITS.files) {
      ctx.addIssue({
        code: 'custom',
        message: `A theme can have at most ${THEME_LIMITS.files} files.`,
      });
    }
    const size = names.reduce((n, name) => n + (files[name]?.length ?? 0), 0);
    if (size > THEME_LIMITS.bytes) {
      ctx.addIssue({
        code: 'custom',
        message: `A theme can be at most ${THEME_LIMITS.bytes / 1024} KB.`,
      });
    }
  })
  .openapi('ThemeFiles');

export const SiteDesignSchema = z
  .object({
    /** The built-in theme it started from. */
    theme: SiteTemplateSchema,
    /** The site's own files once the code was edited; null uses the built-in theme's. */
    files: ThemeFilesSchema.nullable(),
    /** Theme settings: the standard tokens and the theme's own. */
    settings: SettingsSchema,
    /** The home page's sections in order; null uses the theme's defaults. */
    sections: z.array(SiteDesignSectionSchema).max(THEME_LIMITS.sections).nullable(),
  })
  .superRefine((design, ctx) => {
    if (JSON.stringify(design).length > SITE_DESIGN_MAX_CHARS) {
      ctx.addIssue({
        code: 'custom',
        message: `A design can be at most ${SITE_DESIGN_MAX_CHARS / 1024} KB.`,
      });
    }
  })
  .openapi('SiteDesign');
export type SiteDesign = z.infer<typeof SiteDesignSchema>;

/** Something wrong with a design, at a file, line and column ("design" for values and sections). */
const ThemeProblemSchema = z
  .object({
    file: z.string(),
    line: z.number().int(),
    column: z.number().int(),
    message: z.string(),
    /** Errors stop Publish; warnings don't. */
    severity: z.enum(['error', 'warning']),
  })
  .openapi('ThemeProblem');
export type ThemeProblem = z.infer<typeof ThemeProblemSchema>;

const BuiltInThemeSchema = z
  .object({
    id: SiteTemplateSchema,
    name: z.string(),
    description: z.string(),
    files: z.record(z.string(), z.string()),
  })
  .openapi('BuiltInTheme');
export type BuiltInThemeSummary = z.infer<typeof BuiltInThemeSchema>;

/** How far ahead a design can be scheduled to publish (docs/site-themes.md). */
export const SITE_DESIGN_SCHEDULE_MIN_MS = 5 * 60_000;
export const SITE_DESIGN_SCHEDULE_MAX_MS = 90 * 86_400_000;

const SiteDesignScheduleStatusSchema = z
  .enum(['scheduled', 'failed'])
  .openapi('SiteDesignScheduleStatus');

/** The draft as it was when scheduled, waiting to publish at `at`, or refused at its time. */
export const SiteDesignScheduleSchema = z
  .object({
    /** When it publishes: the jobs worker's five-minute cron, so up to five minutes later. */
    at: timestamp,
    /** Who scheduled it; null once that operator is gone. */
    by: id('operator').nullable(),
    createdAt: timestamp,
    /** `failed`: the check at the time found errors and nothing was published. */
    status: SiteDesignScheduleStatusSchema,
    /** Why it failed; empty while it waits. */
    problems: z.array(ThemeProblemSchema),
  })
  .openapi('SiteDesignSchedule');
export type SiteDesignSchedule = z.infer<typeof SiteDesignScheduleSchema>;

export const SiteDesignScheduleRequestSchema = z
  .object({
    /** At least 5 minutes and at most 90 days from now. */
    at: timestamp,
  })
  .openapi('SiteDesignScheduleRequest');

export const SiteDesignStateSchema = z
  .object({
    /** What the editor works on. Before the first save it is made from the old template settings. */
    draft: SiteDesignSchema,
    /** What the site shows; null until the first publish. */
    published: SiteDesignSchema.nullable(),
    draftUpdatedAt: timestamp.nullable(),
    publishedAt: timestamp.nullable(),
    publishedBy: id('operator').nullable(),
    /** The draft's problems. */
    problems: z.array(ThemeProblemSchema),
    /** The built-in themes: id, name, description and files. */
    themes: z.array(BuiltInThemeSchema),
    /** The scheduled publish, if there is one. */
    schedule: SiteDesignScheduleSchema.nullable(),
  })
  .openapi('SiteDesignState');
export type SiteDesignState = z.infer<typeof SiteDesignStateSchema>;

export const SiteDesignSavedSchema = z
  .object({
    draft: SiteDesignSchema,
    draftUpdatedAt: timestamp,
    problems: z.array(ThemeProblemSchema),
  })
  .openapi('SiteDesignSaved');
export type SiteDesignSaved = z.infer<typeof SiteDesignSavedSchema>;

const SiteDesignVersionSchema = z
  .object({
    id: id('siteDesignVersion'),
    publishedAt: timestamp,
    publishedBy: id('operator').nullable(),
    theme: z.string(),
  })
  .openapi('SiteDesignVersion');
export type SiteDesignVersion = z.infer<typeof SiteDesignVersionSchema>;

export const SiteDesignVersionListSchema = z
  .object({ items: z.array(SiteDesignVersionSchema) })
  .openapi('SiteDesignVersionList');
export type SiteDesignVersionList = z.infer<typeof SiteDesignVersionListSchema>;

export const SiteDesignPublishedSchema = z
  .object({
    published: SiteDesignSchema,
    publishedAt: timestamp,
    publishedBy: id('operator').nullable(),
    version: SiteDesignVersionSchema,
    /** Warnings that didn't stop the publish. */
    problems: z.array(ThemeProblemSchema),
  })
  .openapi('SiteDesignPublished');
export type SiteDesignPublished = z.infer<typeof SiteDesignPublishedSchema>;

/** The 422 answer to Publish while the draft has errors. */
export const SiteDesignRefusedSchema = z
  .object({
    error: z.object({
      code: z.literal('invalid_input'),
      message: z.string(),
      requestId: z.string(),
    }),
    problems: z.array(ThemeProblemSchema),
  })
  .openapi('SiteDesignRefused');
export type SiteDesignRefused = z.infer<typeof SiteDesignRefusedSchema>;

const SITE_PREVIEW_AUDIENCES = ['visitor', 'subscriber', 'paid'] as const;

export const SitePreviewRequestSchema = z
  .object({
    /** Who the preview shows the page to. */
    as: z.enum(SITE_PREVIEW_AUDIENCES).default('visitor'),
    /** Draw variant B of the draft's running A/B tests instead of A. */
    variant: SectionVariantSchema.optional(),
    /** With variant b: only this section's test shows B. */
    section: z.string().regex(SECTION_ID_PATTERN).optional(),
  })
  .openapi('SitePreviewRequest');

export const SitePreviewSchema = z
  .object({
    /** The site address that renders the draft: /_swarm/preview?token=… */
    url: z.string(),
    expiresAt: timestamp,
  })
  .openapi('SitePreview');
export type SitePreview = z.infer<typeof SitePreviewSchema>;

/** A theme as one file, to download and import. */
export const SiteThemeFileSchema = z
  .object({
    format: z.literal('swarm-theme'),
    version: z.literal(1),
    name: z.string().trim().min(1).max(60),
    files: ThemeFilesSchema,
  })
  .openapi('SiteThemeFile');
export type SiteThemeFile = z.infer<typeof SiteThemeFileSchema>;

// ---- Section analytics and A/B test results ---------------------------------------------------

export const SiteDesignStatsQuerySchema = z.object({
  days: z
    .enum(['7', '30', '90'])
    .default('30')
    // The period, in days ending today (UTC).
    .transform((v) => Number(v) as 7 | 30 | 90)
    .openapi({ param: { name: 'days', in: 'query' }, example: '30' }),
});

const counts = {
  /** Home page views that reached the section (its lazy beacon loaded). */
  reached: z.number().int().nonnegative(),
  /** Signups through the signup form inside the section. */
  signups: z.number().int().nonnegative(),
};

const SiteSectionStatsSchema = z
  .object({ sectionId: z.string(), variant: SectionVariantSchema, ...counts })
  .openapi('SiteSectionStats');

const VariantResultSchema = z
  .object({ ...counts, rate: z.number().min(0).max(1) })
  .openapi('SiteTestVariantResult');

const SiteTestResultSchema = z
  .object({
    sectionId: z.string(),
    experimentId: z.string(),
    status: z.enum(['running', 'ended']),
    startedAt: timestamp,
    endedAt: timestamp.nullable(),
    winner: SectionVariantSchema.nullable(),
    /** Counted from the day the test started (UTC) to the day it ended, or today. */
    a: VariantResultSchema,
    b: VariantResultSchema,
    /** B's rate minus A's. */
    difference: z.number(),
    /** 1 minus the two-sided p-value of a two-proportion z-test. */
    confidence: z.number().min(0).max(1),
    leader: SectionVariantSchema.nullable(),
    /** At least 95% sure, with at least 100 views on each side. */
    decided: z.boolean(),
    /** About how many more views (both variants) until 95% sure; null with nothing to measure. */
    viewsNeeded: z.number().int().nonnegative().nullable(),
  })
  .openapi('SiteTestResult');
export type SiteTestResult = z.infer<typeof SiteTestResultSchema>;

export const SiteDesignStatsSchema = z
  .object({
    days: z.number().int(),
    /** The first and last day counted (UTC, YYYY-MM-DD). */
    from: z.string(),
    to: z.string(),
    /** Per section and variant over the period; a section with no views has no rows. */
    sections: z.array(SiteSectionStatsSchema),
    totals: z.object(counts),
    /** Every running or ended test of the draft or the published design. */
    tests: z.array(SiteTestResultSchema),
  })
  .openapi('SiteDesignStats');
export type SiteDesignStats = z.infer<typeof SiteDesignStatsSchema>;
