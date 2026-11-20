// Website themes (docs/site-themes.md): the Channel's site design as a draft and a published copy,
// the versions kept on publish, previews, and themes as one file to export and import. Everything
// here needs the site_templates flag. Viewers read; editors save settings and sections, preview,
// publish, schedule a publish and restore; changing the theme's files (Edit code, import) needs
// the admin role. What a publish does is publishSiteDesign (@swarm/engine/site-design), which the
// jobs worker calls too for scheduled publishes.
import { createRoute } from '@hono/zod-openapi';
import { all, first, roleAtLeast, toIso, type ChannelAccess } from '@swarm/db';
import {
  DEFAULT_SITE_THEME,
  SITE_DESIGN_SCHEDULE_MAX_MS,
  SITE_DESIGN_SCHEDULE_MIN_MS,
  SITE_DESIGN_VERSIONS_KEPT,
  SiteDesignPublishedSchema,
  SiteDesignRefusedSchema,
  SiteDesignSavedSchema,
  SiteDesignScheduleRequestSchema,
  SiteDesignScheduleSchema,
  SiteDesignSchema,
  SiteDesignStateSchema,
  SiteDesignStatsQuerySchema,
  SiteDesignStatsSchema,
  SiteDesignVersionListSchema,
  SitePreviewRequestSchema,
  SitePreviewSchema,
  SiteThemeFileSchema,
  idPattern,
  type BuiltInThemeSummary,
  type SiteDesign,
  type SiteDesignSchedule,
  type SiteDesignVersion,
  type SiteTestResult,
  type SiteTheme,
  type SiteThemeFile,
  type ThemeProblem,
} from '@swarm/domain';
import { analyticsDay, linksFor, signSitePreview } from '@swarm/engine';
import {
  builtInThemeFiles as builtInFiles,
  designProblems as problemsOf,
  hasDesignErrors as hasErrors,
  publishSiteDesign,
} from '@swarm/engine/site-design';
import { ApiError } from '@swarm/runtime';
import {
  compileDesign,
  compileTheme,
  designFromLegacy,
  sectionsOf,
  testResult,
  type Design,
} from '@swarm/site-themes';
import { BUILT_IN_THEMES } from '@swarm/site-themes/themes';
import { requireChannel } from '../lib/access';
import { clientIp, createRouter, env, type AppContext, type AuthContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { audit, requireFlag, siteOrigin } from '../lib/site';

export const siteDesign = createRouter();

const BASE = '/api/v1/channels/{channelId}/site/design';
const TAGS = ['Site Studio'];
const channelParam = idParam('channelId', idPattern('channel'));
const versionParams = channelParam.extend(
  idParam('versionId', idPattern('siteDesignVersion')).shape,
);

const refused = {
  description: 'The draft has errors',
  content: { 'application/json': { schema: SiteDesignRefusedSchema } },
};

interface DesignRow {
  draft_json: string;
  draft_updated_at: number;
  published_json: string | null;
  published_by: string | null;
  published_at: number | null;
}

const DAY_MS = 86_400_000;

async function designAccess(c: AppContext, channelId: string, role: 'viewer' | 'editor' | 'admin') {
  const found = await requireChannel(c, channelId, role);
  await requireFlag(c, found, 'site_templates', 'Website themes are not available.');
  return found;
}

interface ScheduleRow {
  publish_at: number;
  scheduled_by: string | null;
  created_at: number;
  status: 'scheduled' | 'failed';
  problems_json: string | null;
}

/** How long after Cancel the dashboard's Undo can put a schedule back. */
const SCHEDULE_UNDO_MS = 10 * 60_000;

const scheduleOf = (row: ScheduleRow): SiteDesignSchedule => ({
  at: toIso(row.publish_at),
  by: row.scheduled_by,
  createdAt: toIso(row.created_at),
  status: row.status,
  problems: row.problems_json ? (JSON.parse(row.problems_json) as ThemeProblem[]) : [],
});

/** The Channel's scheduled publish (site_design_schedules), if there is one. */
async function readSchedule(c: AppContext, channelId: string): Promise<SiteDesignSchedule | null> {
  const row = await first<ScheduleRow>(
    env(c).DB,
    `SELECT publish_at, scheduled_by, created_at, status, problems_json
       FROM site_design_schedules WHERE channel_id = ?1 AND status <> 'cancelled'`,
    channelId,
  );
  return row ? scheduleOf(row) : null;
}

/** The 422 answer while a design has errors. */
const refusal = (c: AppContext, message: string, problems: ThemeProblem[]) =>
  c.json(
    {
      error: { code: 'invalid_input' as const, message, requestId: c.get('requestId') },
      problems,
    },
    422,
  );

const readRow = (c: AppContext, channelId: string) =>
  first<DesignRow>(
    env(c).DB,
    `SELECT draft_json, draft_updated_at, published_json, published_by, published_at
       FROM site_designs WHERE channel_id = ?1`,
    channelId,
  );

/**
 * The draft before the first save: made from the old template settings when a template was chosen
 * (docs/site-themes.md, "From the old template settings"), else the default theme as it comes.
 */
async function initialDraft(c: AppContext, channelId: string): Promise<SiteDesign> {
  const row = await first<{ theme_json: string | null; branding_json: string }>(
    env(c).DB,
    `SELECT s.theme_json, c.branding_json FROM channels c
       LEFT JOIN site_settings s ON s.channel_id = c.id WHERE c.id = ?1`,
    channelId,
  );
  const parse = <T>(json: string | null | undefined, fallback: T): T => {
    try {
      return json ? (JSON.parse(json) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  const theme = parse<SiteTheme>(row?.theme_json, {});
  const branding = parse<{ accentColor?: string | null }>(row?.branding_json, {});
  const files = theme.template ? builtInFiles(theme.template) : null;
  const defaults = files ? (compileTheme(files).theme?.defaults ?? null) : null;
  const legacy = designFromLegacy(theme, branding.accentColor, defaults);
  return (
    (legacy as SiteDesign | null) ?? {
      theme: DEFAULT_SITE_THEME,
      files: null,
      settings: {},
      sections: null,
    }
  );
}

async function currentDraft(c: AppContext, channelId: string, row: DesignRow | null) {
  return row ? (JSON.parse(row.draft_json) as SiteDesign) : initialDraft(c, channelId);
}

/** JSON with sorted keys, so two copies of the same files compare equal. */
const canonical = (files: Record<string, string> | null) =>
  files === null
    ? 'null'
    : JSON.stringify(
        Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))),
      );

function requireFilesRole(access: ChannelAccess, before: SiteDesign, after: SiteDesign) {
  if (canonical(before.files) !== canonical(after.files) && !roleAtLeast(access.role, 'admin')) {
    throw new ApiError('forbidden', 'Changing the theme’s code needs the admin role or higher.', [
      { path: 'files', message: 'Changing the theme’s code needs the admin role or higher.' },
    ]);
  }
}

type Access = ChannelAccess & { auth: AuthContext };

async function saveDraft(
  c: AppContext,
  access: Access,
  design: SiteDesign,
): Promise<{ draft: SiteDesign; draftUpdatedAt: string; problems: ThemeProblem[] }> {
  const now = Date.now();
  await env(c)
    .DB.prepare(
      `INSERT INTO site_designs (channel_id, draft_json, draft_updated_by, draft_updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (channel_id) DO UPDATE SET draft_json = excluded.draft_json,
         draft_updated_by = excluded.draft_updated_by, draft_updated_at = excluded.draft_updated_at`,
    )
    .bind(access.channelId, JSON.stringify(design), access.auth.operatorId, now)
    .run();
  return { draft: design, draftUpdatedAt: toIso(now), problems: problemsOf(design) };
}

const themes = (): BuiltInThemeSummary[] =>
  Object.values(BUILT_IN_THEMES).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    files: t.files,
  }));

// ---- Read ------------------------------------------------------------------------------------

siteDesign.openapi(
  createRoute({
    method: 'get',
    path: BASE,
    tags: TAGS,
    summary: 'Website design',
    description:
      'The draft and published designs, the draft’s problems, the built-in themes and the scheduled publish, if any. Before the first save the draft is made from the old template settings. Needs the site_templates flag.',
    request: { params: channelParam },
    responses: {
      200: ok(SiteDesignStateSchema, 'The design'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await designAccess(c, channelId, 'viewer');
    const row = await readRow(c, channelId);
    const draft = await currentDraft(c, channelId, row);
    return c.json(
      {
        data: {
          draft,
          published: row?.published_json ? (JSON.parse(row.published_json) as SiteDesign) : null,
          draftUpdatedAt: row ? toIso(row.draft_updated_at) : null,
          publishedAt: row?.published_at ? toIso(row.published_at) : null,
          publishedBy: row?.published_by ?? null,
          problems: problemsOf(draft),
          themes: themes(),
          schedule: await readSchedule(c, channelId),
        },
      },
      200,
    );
  },
);

// ---- Draft -----------------------------------------------------------------------------------

siteDesign.openapi(
  createRoute({
    method: 'put',
    path: `${BASE}/draft`,
    tags: TAGS,
    summary: 'Save the draft design',
    description:
      'Saves the whole draft. It is always stored when its shape is right, so work is never lost, and the answer lists its problems. Editor role; changing `files` needs the admin role.',
    request: { params: channelParam, body: jsonBody(SiteDesignSchema) },
    responses: {
      200: ok(SiteDesignSavedSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const found = await designAccess(c, channelId, 'editor');
    const before = await currentDraft(c, channelId, await readRow(c, channelId));
    requireFilesRole(found, before, input);
    return c.json({ data: await saveDraft(c, found, input) }, 200);
  },
);

// ---- Publish ---------------------------------------------------------------------------------

siteDesign.openapi(
  createRoute({
    method: 'post',
    path: `${BASE}/publish`,
    tags: TAGS,
    summary: 'Publish the draft design',
    description:
      'Copies the draft to the live site, keeps it as a version (the last 20) and bumps the site’s cache version. Refused with 422 and the problems while the draft has errors. Editor role.',
    request: { params: channelParam },
    responses: {
      200: ok(SiteDesignPublishedSchema, 'Published'),
      422: refused,
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const found = await designAccess(c, channelId, 'editor');
    const row = await readRow(c, channelId);
    const draft = await currentDraft(c, channelId, row);
    // A scheduled publish stays as it is; the dashboard asks whether to keep it.
    const result = await publishSiteDesign(env(c).DB, {
      channelId,
      workspaceId: found.workspaceId,
      design: draft,
      ...(row ? { json: row.draft_json } : {}),
      operatorId: found.auth.operatorId,
      now: Date.now(),
      ipPrefix: ipPrefix(clientIp(c)),
    });
    if (result.status !== 'published') {
      return refusal(
        c,
        'Fix the errors in the design before publishing it.',
        result.status === 'refused' ? result.problems : [],
      );
    }
    const version: SiteDesignVersion = result.version;
    return c.json(
      {
        data: {
          published: JSON.parse(result.json) as SiteDesign,
          publishedAt: version.publishedAt,
          publishedBy: version.publishedBy,
          version,
          problems: result.problems,
        },
      },
      200,
    );
  },
);

// ---- Scheduled publish -------------------------------------------------------------------------

siteDesign.openapi(
  createRoute({
    method: 'put',
    path: `${BASE}/schedule`,
    tags: TAGS,
    summary: 'Schedule the draft design',
    description:
      'Takes a snapshot of the draft as it is now and publishes it at `at` (at least 5 minutes and at most 90 days ahead) exactly as Publish would, from the jobs worker’s five-minute cron, so up to five minutes later. Later edits to the draft don’t change what goes live. Replaces any schedule there is. Refused with 422 and the problems while the draft has errors. Editor role.',
    request: { params: channelParam, body: jsonBody(SiteDesignScheduleRequestSchema) },
    responses: {
      200: ok(SiteDesignScheduleSchema, 'Scheduled'),
      422: refused,
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { at } = c.req.valid('json');
    const found = await designAccess(c, channelId, 'editor');
    const now = Date.now();
    const publishAt = Date.parse(at);
    const tooSoon = publishAt < now + SITE_DESIGN_SCHEDULE_MIN_MS;
    if (tooSoon || publishAt > now + SITE_DESIGN_SCHEDULE_MAX_MS) {
      const message = tooSoon
        ? 'Choose a time at least 5 minutes from now.'
        : 'Choose a time within the next 90 days.';
      throw new ApiError('invalid_input', message, [{ path: 'at', message }]);
    }
    const row = await readRow(c, channelId);
    const draft = await currentDraft(c, channelId, row);
    const problems = problemsOf(draft);
    if (hasErrors(problems)) {
      return refusal(c, 'Fix the errors in the design before scheduling it.', problems);
    }
    const db = env(c).DB;
    const operatorId = found.auth.operatorId;
    const before = await first<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM site_design_schedules
        WHERE channel_id = ?1 AND status <> 'cancelled'`,
      channelId,
    );
    // One per Channel: a new schedule replaces the old one, failed, waiting or cancelled, and
    // drops any claim on it, so a cron run holding the old one publishes nothing.
    await db
      .prepare(
        `INSERT INTO site_design_schedules (channel_id, design_json, publish_at, scheduled_by,
           created_at, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'scheduled')
         ON CONFLICT (channel_id) DO UPDATE SET design_json = excluded.design_json,
           publish_at = excluded.publish_at, scheduled_by = excluded.scheduled_by,
           created_at = excluded.created_at, status = 'scheduled', problems_json = NULL,
           failed_at = NULL, cancelled_at = NULL, claim_token = NULL, claimed_until = NULL`,
      )
      .bind(channelId, row?.draft_json ?? JSON.stringify(draft), publishAt, operatorId, now)
      .run();
    await audit(c, found, 'site.design_scheduled', 'channel', channelId, {
      at: toIso(publishAt),
      theme: draft.theme,
      replaced: (before?.n ?? 0) > 0,
    });
    const schedule: SiteDesignSchedule = {
      at: toIso(publishAt),
      by: operatorId,
      createdAt: toIso(now),
      status: 'scheduled',
      problems: [],
    };
    return c.json({ data: schedule }, 200);
  },
);

siteDesign.openapi(
  createRoute({
    method: 'delete',
    path: `${BASE}/schedule`,
    tags: TAGS,
    summary: 'Cancel the scheduled publish',
    description:
      'Removes the schedule, waiting or failed, so nothing is published. For 10 minutes it can be put back as it was (`POST …/schedule/restore`). 404 when nothing is scheduled. Editor role.',
    request: { params: channelParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const found = await designAccess(c, channelId, 'editor');
    // Kept as cancelled, for Undo; the claim goes, so a cron run holding it publishes nothing.
    const removed = await first<{ publish_at: number; failed_at: number | null }>(
      env(c).DB,
      `UPDATE site_design_schedules SET status = 'cancelled', cancelled_at = ?2,
              claim_token = NULL, claimed_until = NULL
        WHERE channel_id = ?1 AND status <> 'cancelled'
        RETURNING publish_at, failed_at`,
      channelId,
      Date.now(),
    );
    if (!removed) throw new ApiError('not_found', 'Nothing is scheduled.');
    await audit(c, found, 'site.design_schedule_cancelled', 'channel', channelId, {
      at: toIso(removed.publish_at),
      status: removed.failed_at === null ? 'scheduled' : 'failed',
    });
    return c.body(null, 204);
  },
);

siteDesign.openapi(
  createRoute({
    method: 'post',
    path: `${BASE}/schedule/restore`,
    tags: TAGS,
    summary: 'Put a cancelled schedule back',
    description:
      'Undoes Cancel within 10 minutes: the same snapshot and time, waiting or failed as it was. 404 when there is nothing to put back. Editor role.',
    request: { params: channelParam },
    responses: {
      200: ok(SiteDesignScheduleSchema, 'Scheduled again'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const found = await designAccess(c, channelId, 'editor');
    const restored = await first<ScheduleRow>(
      env(c).DB,
      `UPDATE site_design_schedules
          SET status = CASE WHEN failed_at IS NULL THEN 'scheduled' ELSE 'failed' END,
              cancelled_at = NULL
        WHERE channel_id = ?1 AND status = 'cancelled' AND cancelled_at > ?2
        RETURNING publish_at, scheduled_by, created_at, status, problems_json`,
      channelId,
      Date.now() - SCHEDULE_UNDO_MS,
    );
    if (!restored) throw new ApiError('not_found', 'There is no cancelled schedule to put back.');
    await audit(c, found, 'site.design_schedule_restored', 'channel', channelId, {
      at: toIso(restored.publish_at),
    });
    return c.json({ data: scheduleOf(restored) }, 200);
  },
);

// ---- Versions --------------------------------------------------------------------------------

siteDesign.openapi(
  createRoute({
    method: 'get',
    path: `${BASE}/versions`,
    tags: TAGS,
    summary: 'Published designs',
    description: 'The last 20 published designs, newest first.',
    request: { params: channelParam },
    responses: {
      200: ok(SiteDesignVersionListSchema, 'Versions'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await designAccess(c, channelId, 'viewer');
    const rows = await all<{
      id: string;
      theme: string;
      published_by: string | null;
      published_at: number;
    }>(
      env(c).DB,
      `SELECT id, theme, published_by, published_at FROM site_design_versions
        WHERE channel_id = ?1 ORDER BY published_at DESC, id DESC LIMIT ?2`,
      channelId,
      SITE_DESIGN_VERSIONS_KEPT,
    );
    const items: SiteDesignVersion[] = rows.map((r) => ({
      id: r.id,
      publishedAt: toIso(r.published_at),
      publishedBy: r.published_by,
      theme: r.theme,
    }));
    return c.json({ data: { items } }, 200);
  },
);

siteDesign.openapi(
  createRoute({
    method: 'post',
    path: `${BASE}/versions/{versionId}/restore`,
    tags: TAGS,
    summary: 'Restore a published design',
    description:
      'Puts a published version into the draft, files included (they were published before). The live site changes only on Publish. Editor role.',
    request: { params: versionParams },
    responses: {
      200: ok(SiteDesignSavedSchema, 'Restored into the draft'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, versionId } = c.req.valid('param');
    const found = await designAccess(c, channelId, 'editor');
    const version = await first<{ design_json: string }>(
      env(c).DB,
      'SELECT design_json FROM site_design_versions WHERE id = ?1 AND channel_id = ?2',
      versionId,
      channelId,
    );
    if (!version) throw new ApiError('not_found', 'Version not found.');
    const saved = await saveDraft(c, found, JSON.parse(version.design_json) as SiteDesign);
    await audit(c, found, 'site.design_restored', 'channel', channelId, { versionId });
    return c.json({ data: saved }, 200);
  },
);

// ---- Section analytics and A/B test results ----------------------------------------------------

interface CountRow {
  section_id: string;
  variant: 'a' | 'b';
  reached: number | null;
  signups: number | null;
}

/** The A/B tests of a design, running or ended, by section. */
function experimentsOf(design: SiteDesign | null) {
  if (!design) return [];
  const { theme } = compileDesign(design as Design, builtInFiles(design.theme));
  const sections = theme ? sectionsOf(theme, design as Design) : (design.sections ?? []);
  return sections.flatMap((s) =>
    s.experiment ? [{ sectionId: s.id, experiment: s.experiment }] : [],
  );
}

siteDesign.openapi(
  createRoute({
    method: 'get',
    path: `${BASE}/stats`,
    tags: TAGS,
    summary: 'Section analytics and A/B test results',
    description:
      'Per home page section and variant, the views that reached it and the signups through its form over the last 7, 30 or 90 days (UTC), with totals; and for every running or ended A/B test of the draft or the published design, both variants counted from the day it started, their signup rates, the difference, how sure it is (two-proportion z-test) and about how many more views would make it 95%. Counted without cookies, so these are views, not people.',
    request: { params: channelParam, query: SiteDesignStatsQuerySchema },
    responses: {
      200: ok(SiteDesignStatsSchema, 'The numbers'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { days } = c.req.valid('query');
    await designAccess(c, channelId, 'viewer');
    const db = env(c).DB;
    const now = Date.now();
    const to = analyticsDay(now);
    const from = analyticsDay(now - (days - 1) * DAY_MS);
    const rows = await all<CountRow>(
      db,
      `SELECT section_id, variant, sum(reached) AS reached, sum(signups) AS signups
         FROM site_section_daily WHERE channel_id = ?1 AND day >= ?2 AND day <= ?3
        GROUP BY section_id, variant ORDER BY section_id, variant`,
      channelId,
      from,
      to,
    );
    const sections = rows.map((r) => ({
      sectionId: r.section_id,
      variant: r.variant,
      reached: r.reached ?? 0,
      signups: r.signups ?? 0,
    }));
    const totals = sections.reduce(
      (sum, s) => ({ reached: sum.reached + s.reached, signups: sum.signups + s.signups }),
      { reached: 0, signups: 0 },
    );

    // The draft's tests first (they say how a test ended before it is published), then the
    // published design's that the draft no longer has.
    const row = await readRow(c, channelId);
    const draft = await currentDraft(c, channelId, row);
    const published = row?.published_json ? (JSON.parse(row.published_json) as SiteDesign) : null;
    const seen = new Set<string>();
    const experiments = [...experimentsOf(draft), ...experimentsOf(published)].filter((t) => {
      const key = `${t.sectionId}\u0000${t.experiment.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const tests: SiteTestResult[] = [];
    for (const { sectionId, experiment } of experiments) {
      const start = Date.parse(experiment.startedAt);
      const end = experiment.endedAt ? Date.parse(experiment.endedAt) : now;
      const counts = await all<CountRow>(
        db,
        `SELECT section_id, variant, sum(reached) AS reached, sum(signups) AS signups
           FROM site_section_daily
          WHERE channel_id = ?1 AND section_id = ?2 AND day >= ?3 AND day <= ?4
          GROUP BY section_id, variant`,
        channelId,
        sectionId,
        analyticsDay(Number.isFinite(start) ? start : now),
        analyticsDay(Number.isFinite(end) ? Math.min(end, now) : now),
      );
      const of = (variant: 'a' | 'b') => {
        const r = counts.find((x) => x.variant === variant);
        return { reached: r?.reached ?? 0, signups: r?.signups ?? 0 };
      };
      tests.push({
        sectionId,
        experimentId: experiment.id,
        status: experiment.status,
        startedAt: experiment.startedAt,
        endedAt: experiment.endedAt ?? null,
        winner: experiment.winner ?? null,
        ...testResult(of('a'), of('b')),
      });
    }
    return c.json({ data: { days, from, to, sections, totals, tests } }, 200);
  },
);

// ---- Preview ---------------------------------------------------------------------------------

/**
 * The address the preview frame loads from. In local development the site worker listens on its
 * own port, which the platform address doesn't carry; MEDIA_ORIGIN is that same worker.
 */
function previewOrigin(c: AppContext, platformOrigin: string): string {
  if (env(c).ENVIRONMENT !== 'development') return platformOrigin;
  const { port } = new URL(env(c).MEDIA_ORIGIN);
  return port ? `${platformOrigin}:${port}` : platformOrigin;
}

siteDesign.openapi(
  createRoute({
    method: 'post',
    path: `${BASE}/preview`,
    tags: TAGS,
    summary: 'Preview the draft design',
    description:
      'A site address with a signed token (purpose site-preview, 30 minutes) that renders the draft home page as a visitor, a subscriber or a paid subscriber. Never cached, never indexed. Editor role.',
    request: { params: channelParam, body: jsonBody(SitePreviewRequestSchema) },
    responses: {
      200: ok(SitePreviewSchema, 'Preview address'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { as, variant, section } = c.req.valid('json');
    await designAccess(c, channelId, 'editor');
    const { token, expiresAt } = await signSitePreview(linksFor(env(c)), { channelId, as });
    // The platform address always reaches the Channel, whatever its custom domain is doing.
    const { platformOrigin } = await siteOrigin(c, channelId);
    // Variant B of the draft's A/B tests (all, or one section's); the site reads it unsigned,
    // since a preview is the draft for editors anyway.
    const ab =
      variant === 'b'
        ? `&variant=b${section ? `&section=${encodeURIComponent(section)}` : ''}`
        : '';
    return c.json(
      {
        data: {
          url: `${previewOrigin(c, platformOrigin)}/_swarm/preview?token=${encodeURIComponent(token)}${ab}`,
          expiresAt: toIso(expiresAt),
        },
      },
      200,
    );
  },
);

// ---- Export and import -----------------------------------------------------------------------

siteDesign.openapi(
  createRoute({
    method: 'get',
    path: `${BASE}/export`,
    tags: TAGS,
    summary: 'Export the theme',
    description:
      'The draft’s theme as one file: its own files, or the built-in theme’s when the code was never edited.',
    request: { params: channelParam },
    responses: {
      200: ok(SiteThemeFileSchema, 'The theme file'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await designAccess(c, channelId, 'viewer');
    const draft = await currentDraft(c, channelId, await readRow(c, channelId));
    const files = draft.files ?? builtInFiles(draft.theme);
    if (!files) throw new ApiError('not_found', 'This theme isn’t available.');
    const compiled = compileTheme(files).theme;
    const name =
      compiled?.name ??
      BUILT_IN_THEMES[draft.theme as keyof typeof BUILT_IN_THEMES]?.name ??
      'Theme';
    const file: SiteThemeFile = { format: 'swarm-theme', version: 1, name, files };
    return c.json({ data: file }, 200);
  },
);

siteDesign.openapi(
  createRoute({
    method: 'post',
    path: `${BASE}/import`,
    tags: TAGS,
    summary: 'Import a theme',
    description:
      'Takes a theme file into the draft: its files replace the draft’s, the settings stay, and the sections stay when the theme has every type they use. Answers with the problems. Admin role.',
    request: { params: channelParam, body: jsonBody(SiteThemeFileSchema) },
    responses: {
      200: ok(SiteDesignSavedSchema, 'Imported into the draft'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const found = await designAccess(c, channelId, 'admin');
    const before = await currentDraft(c, channelId, await readRow(c, channelId));
    const compiled = compileTheme(input.files).theme;
    const keepSections =
      before.sections !== null &&
      compiled !== null &&
      before.sections.every((s) => compiled.schemas[s.type]);
    const draft: SiteDesign = {
      theme: before.theme,
      files: input.files,
      settings: before.settings,
      sections: keepSections ? before.sections : null,
    };
    const saved = await saveDraft(c, found, draft);
    await audit(c, found, 'site.design_imported', 'channel', channelId, {
      name: input.name,
      files: Object.keys(input.files).length,
    });
    return c.json({ data: saved }, 200);
  },
);
