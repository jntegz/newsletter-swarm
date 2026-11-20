// Site Studio: the Channel website's settings, sections, pages, redirects, Bot Rules and
// analytics. Every write bumps the site cache version, so the edge serves fresh pages.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, isUniqueViolation, roleAtLeast, toIso, type ChannelAccess } from '@swarm/db';
import {
  BotRulesSchema,
  CreateSitePageSchema,
  CreateSiteRedirectSchema,
  CreateSiteSectionSchema,
  ImportRedirectsSchema,
  KNOWN_AI_BOTS,
  MAX_REDIRECT_IMPORT_ROWS,
  MAX_SECTIONS,
  RedirectImportResultSchema,
  SITE_PAGE_LIMITS,
  SITE_REDIRECT_LIMITS,
  SiteAnalyticsQuerySchema,
  SiteAnalyticsSchema,
  SitePageListSchema,
  SitePageSchema,
  SiteRedirectListSchema,
  SiteRedirectSchema,
  SiteSectionSchema,
  SiteSettingsSchema,
  UpdateBotRulesSchema,
  UpdateSitePageSchema,
  UpdateSiteRedirectSchema,
  UpdateSiteSectionSchema,
  UpdateSiteSettingsSchema,
  idPattern,
  isReservedSitePath,
  newId,
  slugify,
  type AiBotsPolicy,
  type BotRules,
  type DispatchDocument,
  type SiteAnalytics,
  type SitePage,
  type SiteRedirect,
  type SiteSection,
  type SiteSettings,
  customCssProblem,
  SiteConsentSchema,
  defaultSiteConsent,
  isHttpsUrl,
  isSitePath,
  necessaryTrackerProblem,
  siteCodeProblem,
  trackersIn,
  type SiteCodeEntry,
} from '@swarm/domain';
import {
  bumpCacheStatement,
  bumpCacheVersion,
  hasCustomWebDomain,
  parseCsv,
  siteCodeReason,
  siteCodeRuns,
} from '@swarm/engine';
import { RenderError, renderWeb } from '@swarm/mail';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { flagOn } from '../lib/copilot';
import { createRouter, env, type AppContext } from '../lib/context';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { rawHtmlAllowed } from '../lib/send';
import { audit, limitFor, planOf, requireFlag, siteOrigin } from '../lib/site';

export const site = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const sectionParams = channelParam.extend(idParam('sectionId', idPattern('siteSection')).shape);
const pageParams = channelParam.extend(idParam('pageId', idPattern('sitePage')).shape);
const redirectParams = channelParam.extend(idParam('redirectId', idPattern('siteRedirect')).shape);

const MAX_DOCUMENT_BYTES = 512 * 1024;
const EMPTY_PAGE: DispatchDocument = { type: 'doc', content: [] };

/** Checks an editor document renders for the web, as the site will render it. */
async function webDocument(
  c: AppContext,
  access: ChannelAccess,
  content: DispatchDocument,
  path: string,
): Promise<string> {
  const json = JSON.stringify(content);
  if (new TextEncoder().encode(json).length > MAX_DOCUMENT_BYTES) {
    throw new ApiError('invalid_input', 'The page is too large.', [
      { path, message: 'The page is too large.' },
    ]);
  }
  try {
    renderWeb(content, {
      channelName: '',
      media: () => null,
      allowHtmlBlocks: await rawHtmlAllowed(c, access),
    });
  } catch (error) {
    if (!(error instanceof RenderError)) throw error;
    throw new ApiError('invalid_input', error.message, [{ path, message: error.message }]);
  }
  return json;
}

function reservedSlug(path = 'slug'): ApiError {
  const message = 'That address belongs to the site. Choose another.';
  return new ApiError('invalid_input', message, [{ path, message }]);
}

// ---- Settings ----------------------------------------------------------------------------

interface SettingsRow {
  layout: SiteSettings['layout'];
  pinned_json: string;
  about_json: string;
  nav_json: string;
  seo_json: string;
  theme_json: string;
  ai_bots: AiBotsPolicy;
  expose_gated: number;
  prev_next_nav: number;
  cache_version: number;
  custom_css: string;
  consent_json: string;
  code_json: string;
  updated_at: number;
}

async function readSettings(c: AppContext, channelId: string): Promise<SiteSettings> {
  const row = await first<SettingsRow>(
    env(c).DB,
    'SELECT * FROM site_settings WHERE channel_id = ?1',
    channelId,
  );
  const { origin, platformOrigin } = await siteOrigin(c, channelId);
  const codeAccess = await siteCodeAccess(c, channelId);
  return {
    channelId,
    layout: row?.layout ?? 'magazine',
    pinned: row ? (JSON.parse(row.pinned_json) as string[]) : [],
    about: row ? (JSON.parse(row.about_json) as DispatchDocument) : EMPTY_PAGE,
    nav: row ? (JSON.parse(row.nav_json) as SiteSettings['nav']) : [],
    seo: row ? (JSON.parse(row.seo_json) as SiteSettings['seo']) : {},
    theme: row ? (JSON.parse(row.theme_json) as SiteSettings['theme']) : {},
    customCss: row?.custom_css ?? '',
    consent: row ? SiteConsentSchema.parse(JSON.parse(row.consent_json)) : defaultSiteConsent(),
    code: row ? (JSON.parse(row.code_json) as SiteSettings['code']) : [],
    codeAccess,
    aiBots: row?.ai_bots ?? 'unset',
    exposeGated: row?.expose_gated === 1,
    prevNextNav: row ? row.prev_next_nav === 1 : true,
    cacheVersion: row?.cache_version ?? 1,
    url: origin,
    platformUrl: platformOrigin,
    updatedAt: row ? toIso(row.updated_at) : null,
  };
}

/** Where this publication's code runs (migrations/0065_site_code_rules.sql). */
async function siteCodeAccess(
  c: AppContext,
  channelId: string,
): Promise<SiteSettings['codeAccess']> {
  const db = env(c).DB;
  const channel = await first<{ workspace_id: string }>(
    db,
    'SELECT workspace_id FROM channels WHERE id = ?1',
    channelId,
  );
  const [reason, customDomain] = await Promise.all([
    channel ? siteCodeReason(db, channel.workspace_id) : Promise.resolve('not_allowed' as const),
    hasCustomWebDomain(db, channelId),
  ]);
  return { platformAddress: siteCodeRuns(reason), reason, customDomain };
}

/** The code of an entry, which is what decides what runs: not its name or category. */
const codeOf = (entry: Pick<SiteCodeEntry, 'preset' | 'value'>) =>
  JSON.stringify([entry.preset, entry.value]);

const SITE_CODE_NOT_ALLOWED =
  'Code can run only on your own domain on this Swarm. Add your domain to the website first, or ask the owner of this Swarm to allow code for this workspace.';

site.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/site/settings',
    tags: ['Site Studio'],
    summary: 'Website settings',
    description: 'Defaults until the first save.',
    request: { params: channelParam },
    responses: {
      200: ok(SiteSettingsSchema, 'Settings'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    return c.json({ data: await readSettings(c, channelId) }, 200);
  },
);

site.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/channels/{channelId}/site/settings',
    tags: ['Site Studio'],
    summary: 'Change website settings',
    description:
      'Editor role. The AI crawler policy (aiBots) and exposeGated need the admin role; exposeGated needs the gated_seo_exposure flag and the newspaper layout the site_homepage_layouts flag. Pinned Dispatches must be on this Channel’s site, and the social image must be in this workspace’s media library. Code (consent, code) needs the admin role and the site_custom_code flag; new or changed scripts are refused with forbidden unless the Channel has an active custom web domain or its workspace may run code on the platform address (codeAccess), and an entry marked necessary that looks like a known tracking tool needs necessaryConfirmed, which the audit log records.',
    request: { params: channelParam, body: jsonBody(UpdateSiteSettingsSchema) },
    responses: {
      200: ok(SiteSettingsSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    const e = env(c);
    if (
      (input.aiBots !== undefined || input.exposeGated !== undefined) &&
      !roleAtLeast(access.role, 'admin')
    ) {
      throw new ApiError(
        'forbidden',
        'Crawler and search engine settings need the admin role or higher.',
      );
    }
    if (input.customCss !== undefined) {
      if (!roleAtLeast(access.role, 'admin')) {
        throw new ApiError('forbidden', 'Custom CSS needs the admin role or higher.');
      }
      const problem = customCssProblem(input.customCss);
      if (problem) {
        throw new ApiError('invalid_input', problem, [{ path: 'customCss', message: problem }]);
      }
    }
    if (input.consent !== undefined || input.code !== undefined) {
      if (!roleAtLeast(access.role, 'admin')) {
        throw new ApiError(
          'forbidden',
          'The cookie popup and site code need the admin role or higher.',
        );
      }
      await requireFlag(c, access, 'site_custom_code', 'Site code is not available.');
      for (const entry of input.code ?? []) {
        const problem = siteCodeProblem(entry) ?? necessaryTrackerProblem(entry);
        if (problem)
          throw new ApiError('invalid_input', problem, [{ path: 'code', message: problem }]);
      }
      // On this install's own domain every website shares the owner's name, so new scripts need
      // a custom domain or an instance admin's say. Code already saved can be kept as it is.
      const runnable = (input.code ?? []).filter((entry) => entry.preset !== 'verification');
      if (runnable.length) {
        const access = await siteCodeAccess(c, channelId);
        if (!access.platformAddress && !access.customDomain) {
          const stored = await first<{ code_json: string }>(
            e.DB,
            'SELECT code_json FROM site_settings WHERE channel_id = ?1',
            channelId,
          );
          const kept = new Set(
            (JSON.parse(stored?.code_json ?? '[]') as SiteCodeEntry[]).map(codeOf),
          );
          if (runnable.some((entry) => !kept.has(codeOf(entry)))) {
            throw new ApiError('forbidden', SITE_CODE_NOT_ALLOWED);
          }
        }
      }

      const url = input.consent?.policyUrl;
      if (url && !isSitePath(url) && !isHttpsUrl(url)) {
        const message = 'Use a path on your site or an https address.';
        throw new ApiError('invalid_input', message, [{ path: 'consent.policyUrl', message }]);
      }
    }
    if (input.theme?.template || input.customCss !== undefined) {
      await requireFlag(c, access, 'site_templates', 'Website templates are not available.');
    }
    if (input.exposeGated === true) {
      await requireFlag(
        c,
        access,
        'gated_seo_exposure',
        'Showing paywalled content to search engines is not available for this publication.',
      );
    }
    if (input.layout === 'newspaper') {
      await requireFlag(
        c,
        access,
        'site_homepage_layouts',
        'The newspaper layout is not available for this publication.',
      );
    }
    if (input.pinned?.length) {
      const ids = [...new Set(input.pinned)];
      const found = await all<{ id: string }>(
        e.DB,
        `SELECT id FROM dispatches WHERE channel_id = ?1 AND web_published_at IS NOT NULL AND web_visibility <> 'hidden'
           AND id IN (${ids.map((_, i) => `?${i + 2}`).join(', ')})`,
        channelId,
        ...ids,
      );
      if (found.length !== ids.length || ids.length !== input.pinned.length) {
        const message = 'Pin posts that are on this publication’s website, each once.';
        throw new ApiError('invalid_input', message, [{ path: 'pinned', message }]);
      }
    }
    if (input.seo?.ogMediaId) {
      const media = await first(
        e.DB,
        'SELECT 1 FROM media WHERE id = ?1 AND workspace_id = ?2 AND deleted_at IS NULL',
        input.seo.ogMediaId,
        access.workspaceId,
      );
      if (!media) {
        const message = 'Choose an image from this workspace’s media library.';
        throw new ApiError('invalid_input', message, [{ path: 'seo.ogMediaId', message }]);
      }
    }
    // The owner's word that a tool that looks like tracking is strictly necessary, kept in the log.
    const necessaryConfirmed = (input.code ?? [])
      .filter((entry) => entry.category === 'necessary' && entry.necessaryConfirmed)
      .map((entry) => ({ name: entry.name, tools: trackersIn(entry) }))
      .filter((entry) => entry.tools.length > 0);
    const about = input.about ? await webDocument(c, access, input.about, 'about') : null;
    const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));
    const bool = (value: boolean | undefined) => (value === undefined ? null : value ? 1 : 0);
    const now = Date.now();
    await e.DB.batch([
      e.DB.prepare(
        'INSERT INTO site_settings (channel_id, updated_at) VALUES (?1, ?2) ON CONFLICT (channel_id) DO NOTHING',
      ).bind(channelId, now),
      e.DB.prepare(
        `UPDATE site_settings SET layout = coalesce(?1, layout), pinned_json = coalesce(?2, pinned_json),
                about_json = coalesce(?3, about_json), nav_json = coalesce(?4, nav_json),
                seo_json = coalesce(?5, seo_json), theme_json = coalesce(?6, theme_json),
                ai_bots = coalesce(?7, ai_bots), expose_gated = coalesce(?8, expose_gated),
                prev_next_nav = coalesce(?9, prev_next_nav), custom_css = coalesce(?13, custom_css),
                consent_json = coalesce(?14, consent_json), code_json = coalesce(?15, code_json),
                cache_version = cache_version + 1,
                updated_by = ?10, updated_at = ?11
          WHERE channel_id = ?12`,
      ).bind(
        input.layout ?? null,
        json(input.pinned),
        about,
        json(input.nav),
        json(input.seo),
        json(input.theme),
        input.aiBots ?? null,
        bool(input.exposeGated),
        bool(input.prevNextNav),
        access.auth.operatorId,
        now,
        channelId,
        input.customCss ?? null,
        json(input.consent),
        json(input.code),
      ),
    ]);
    await audit(c, access, 'site.settings_updated', 'channel', channelId, {
      fields: Object.keys(input).sort(),
      ...(necessaryConfirmed.length ? { necessaryConfirmed } : {}),
    });
    return c.json({ data: await readSettings(c, channelId) }, 200);
  },
);

// ---- Sections ----------------------------------------------------------------------------

interface SectionRow {
  id: string;
  channel_id: string;
  slug: string;
  name: string;
  description: string | null;
  position: number;
  dispatch_count: number;
  created_at: number;
  updated_at: number;
}

const SECTION_SELECT = `SELECT s.*, (SELECT count(*) FROM dispatches d WHERE d.section_id = s.id
    AND d.web_published_at IS NOT NULL AND d.web_visibility <> 'hidden') AS dispatch_count
  FROM site_sections s`;

const toSection = (row: SectionRow): SiteSection => ({
  id: row.id,
  channelId: row.channel_id,
  slug: row.slug,
  name: row.name,
  description: row.description,
  position: row.position,
  dispatchCount: row.dispatch_count,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

async function sectionsAccess(c: AppContext, channelId: string, minimum: 'viewer' | 'editor') {
  const access = await requireChannel(c, channelId, minimum);
  await requireFlag(c, access, 'site_sections', 'Sections are not available for this publication.');
  return access;
}

async function readSection(db: D1Database, channelId: string, id: string): Promise<SectionRow> {
  const row = await first<SectionRow>(
    db,
    `${SECTION_SELECT} WHERE s.id = ?1 AND s.channel_id = ?2`,
    id,
    channelId,
  );
  if (!row) throw new ApiError('not_found', 'Section not found.');
  return row;
}

const sectionTaken = () =>
  new ApiError('conflict', 'Another section uses that address.', [
    { path: 'slug', message: 'Another section uses that address.' },
  ]);

site.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/site/sections',
    tags: ['Site Studio'],
    summary: 'Sections, in order',
    description: 'Needs the site_sections flag.',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(SiteSectionSchema), 'Sections'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await sectionsAccess(c, channelId, 'viewer');
    const rows = await all<SectionRow>(
      env(c).DB,
      `${SECTION_SELECT} WHERE s.channel_id = ?1 ORDER BY s.position, s.name`,
      channelId,
    );
    return c.json({ data: rows.map(toSection) }, 200);
  },
);

site.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/site/sections',
    tags: ['Site Studio'],
    summary: 'Add a section',
    description: 'Served at /s/<slug>. The slug comes from the name unless given.',
    request: { params: channelParam, body: jsonBody(CreateSiteSectionSchema) },
    responses: {
      201: ok(SiteSectionSchema, 'Added'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await sectionsAccess(c, channelId, 'editor');
    const e = env(c);
    const slug = input.slug ?? slugify(input.name, 60);
    if (isReservedSitePath(slug)) throw reservedSlug();
    const count = await first<{ n: number }>(
      e.DB,
      'SELECT count(*) AS n FROM site_sections WHERE channel_id = ?1',
      channelId,
    );
    if ((count?.n ?? 0) >= MAX_SECTIONS) {
      throw new ApiError('conflict', `A publication can have up to ${MAX_SECTIONS} sections.`);
    }
    const now = Date.now();
    const id = newId('siteSection', now);
    try {
      await e.DB.batch([
        e.DB.prepare(
          `INSERT INTO site_sections (id, channel_id, slug, name, description, position, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
        ).bind(
          id,
          channelId,
          slug,
          input.name,
          input.description ?? null,
          input.position ?? count?.n ?? 0,
          now,
        ),
        bumpCacheStatement(e.DB, channelId, now),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw sectionTaken();
      throw error;
    }
    await audit(c, access, 'site.section_created', 'site_section', id, { slug });
    return c.json({ data: toSection(await readSection(e.DB, channelId, id)) }, 201);
  },
);

site.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/channels/{channelId}/site/sections/{sectionId}',
    tags: ['Site Studio'],
    summary: 'Change a section',
    request: { params: sectionParams, body: jsonBody(UpdateSiteSectionSchema) },
    responses: {
      200: ok(SiteSectionSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, sectionId } = c.req.valid('param');
    const input = c.req.valid('json');
    await sectionsAccess(c, channelId, 'editor');
    const e = env(c);
    await readSection(e.DB, channelId, sectionId);
    if (input.slug && isReservedSitePath(input.slug)) throw reservedSlug();
    const now = Date.now();
    try {
      await e.DB.batch([
        e.DB.prepare(
          `UPDATE site_sections SET name = coalesce(?1, name), slug = coalesce(?2, slug),
                  description = CASE WHEN ?3 = 1 THEN ?4 ELSE description END,
                  position = coalesce(?5, position), updated_at = ?6
            WHERE id = ?7 AND channel_id = ?8`,
        ).bind(
          input.name ?? null,
          input.slug ?? null,
          input.description === undefined ? 0 : 1,
          input.description ?? null,
          input.position ?? null,
          now,
          sectionId,
          channelId,
        ),
        bumpCacheStatement(e.DB, channelId, now),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw sectionTaken();
      throw error;
    }
    return c.json({ data: toSection(await readSection(e.DB, channelId, sectionId)) }, 200);
  },
);

site.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}/site/sections/{sectionId}',
    tags: ['Site Studio'],
    summary: 'Remove a section',
    description: 'Its Dispatches stay on the site, without a section.',
    request: { params: sectionParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { channelId, sectionId } = c.req.valid('param');
    const access = await sectionsAccess(c, channelId, 'editor');
    const e = env(c);
    const row = await readSection(e.DB, channelId, sectionId);
    const now = Date.now();
    await e.DB.batch([
      e.DB.prepare('DELETE FROM site_sections WHERE id = ?1 AND channel_id = ?2').bind(
        sectionId,
        channelId,
      ),
      bumpCacheStatement(e.DB, channelId, now),
    ]);
    await audit(c, access, 'site.section_deleted', 'site_section', sectionId, { slug: row.slug });
    return c.body(null, 204);
  },
);

// ---- Pages -------------------------------------------------------------------------------

interface PageRow {
  landing_form_id: string | null;
  id: string;
  channel_id: string;
  slug: string;
  title: string;
  content_json?: string;
  status: SitePage['status'];
  in_nav: number;
  position: number;
  created_at: number;
  updated_at: number;
}

/**
 * A landing page's form: published, of this Channel, and one the page's plain form can complete.
 * Required profile fields are only asked for in the embed frame, so that form could never succeed.
 */
async function checkLandingForm(
  c: AppContext,
  access: { workspaceId: string; channelId: string },
  formId: string,
): Promise<void> {
  const scope = { workspaceId: access.workspaceId, channelId: access.channelId };
  if (!(await flagOn(c, 'landing_pages', scope))) {
    throw new ApiError('feature_disabled', 'Landing pages are not turned on for this publication.');
  }
  const refuse = (message: string) =>
    new ApiError('invalid_input', message, [{ path: 'landingFormId', message }]);
  const form = await first<{ published_config_json: string | null }>(
    env(c).DB,
    `SELECT published_config_json FROM capture_forms
      WHERE id = ?1 AND channel_id = ?2 AND kind = 'form' AND status = 'published' AND deleted_at IS NULL`,
    formId,
    access.channelId,
  );
  if (!form?.published_config_json) throw refuse('Choose a published form from this publication.');
  const config = JSON.parse(form.published_config_json) as {
    fields: { key: string; required?: boolean }[];
  };
  if (config.fields.some((field) => field.key.startsWith('field:') && field.required)) {
    throw refuse('This form has required custom fields, which a landing page can’t ask for.');
  }
}

const PAGE_SUMMARY = `id, channel_id, slug, title, status, in_nav, position, landing_form_id, created_at, updated_at`;

const toPageSummary = (row: PageRow) => ({
  id: row.id,
  channelId: row.channel_id,
  slug: row.slug,
  title: row.title,
  status: row.status,
  inNav: row.in_nav === 1,
  landingFormId: row.landing_form_id,
  position: row.position,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

async function readPage(c: AppContext, channelId: string, id: string): Promise<SitePage> {
  const row = await first<PageRow & { content_json: string }>(
    env(c).DB,
    'SELECT * FROM site_pages WHERE id = ?1 AND channel_id = ?2',
    id,
    channelId,
  );
  if (!row) throw new ApiError('not_found', 'Page not found.');
  const { origin } = await siteOrigin(c, channelId);
  return {
    ...toPageSummary(row),
    content: JSON.parse(row.content_json) as DispatchDocument,
    url: `${origin}/${row.slug}`,
  };
}

const pageTaken = () =>
  new ApiError('conflict', 'Another page uses that address.', [
    { path: 'slug', message: 'Another page uses that address.' },
  ]);

site.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/site/pages',
    tags: ['Site Studio'],
    summary: 'Custom pages',
    request: { params: channelParam },
    responses: {
      200: ok(SitePageListSchema, 'Pages and the plan limit'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const e = env(c);
    const rows = await all<PageRow>(
      e.DB,
      `SELECT ${PAGE_SUMMARY} FROM site_pages WHERE channel_id = ?1 ORDER BY position, title LIMIT 500`,
      channelId,
    );
    const limit = limitFor(SITE_PAGE_LIMITS, await planOf(e.DB, channelId));
    return c.json({ data: { items: rows.map(toPageSummary), limit } }, 200);
  },
);

site.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/site/pages/{pageId}',
    tags: ['Site Studio'],
    summary: 'One custom page with its content',
    request: { params: pageParams },
    responses: { 200: ok(SitePageSchema, 'Page'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId, pageId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    return c.json({ data: await readPage(c, channelId, pageId) }, 200);
  },
);

site.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/site/pages',
    tags: ['Site Studio'],
    summary: 'Add a custom page',
    description:
      'Served at /<slug>; the slug comes from the title unless given, and can’t be one the site uses (about, archive, search, …). The free plan includes 5 pages per Channel.',
    request: { params: channelParam, body: jsonBody(CreateSitePageSchema) },
    responses: {
      201: ok(SitePageSchema, 'Added'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    const e = env(c);
    const slug = input.slug ?? slugify(input.title, 60);
    if (isReservedSitePath(slug)) throw reservedSlug();
    if (input.landingFormId) await checkLandingForm(c, access, input.landingFormId);
    const limit = limitFor(SITE_PAGE_LIMITS, await planOf(e.DB, channelId));
    const count = await first<{ n: number }>(
      e.DB,
      'SELECT count(*) AS n FROM site_pages WHERE channel_id = ?1',
      channelId,
    );
    if (limit !== null && (count?.n ?? 0) >= limit) {
      throw new ApiError('conflict', `Your plan includes ${limit} pages per publication.`);
    }
    const content = await webDocument(c, access, input.content ?? EMPTY_PAGE, 'content');
    const now = Date.now();
    const id = newId('sitePage', now);
    try {
      await e.DB.batch([
        e.DB.prepare(
          `INSERT INTO site_pages (id, channel_id, slug, title, content_json, status, in_nav, position, created_at, updated_at, landing_form_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)`,
        ).bind(
          id,
          channelId,
          slug,
          input.title,
          content,
          input.status ?? 'draft',
          input.inNav ? 1 : 0,
          input.position ?? count?.n ?? 0,
          now,
          input.landingFormId ?? null,
        ),
        bumpCacheStatement(e.DB, channelId, now),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw pageTaken();
      throw error;
    }
    await audit(c, access, 'site.page_created', 'site_page', id, { slug });
    return c.json({ data: await readPage(c, channelId, id) }, 201);
  },
);

site.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/channels/{channelId}/site/pages/{pageId}',
    tags: ['Site Studio'],
    summary: 'Change a custom page',
    request: { params: pageParams, body: jsonBody(UpdateSitePageSchema) },
    responses: {
      200: ok(SitePageSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, pageId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    const e = env(c);
    await readPage(c, channelId, pageId);
    if (input.slug && isReservedSitePath(input.slug)) throw reservedSlug();
    if (input.landingFormId) await checkLandingForm(c, access, input.landingFormId);
    const content = input.content ? await webDocument(c, access, input.content, 'content') : null;
    const now = Date.now();
    try {
      await e.DB.batch([
        e.DB.prepare(
          `UPDATE site_pages SET title = coalesce(?1, title), slug = coalesce(?2, slug),
                  content_json = coalesce(?3, content_json), status = coalesce(?4, status),
                  in_nav = coalesce(?5, in_nav), position = coalesce(?6, position), updated_at = ?7,
                  landing_form_id = CASE WHEN ?10 = 1 THEN ?11 ELSE landing_form_id END
            WHERE id = ?8 AND channel_id = ?9`,
        ).bind(
          input.title ?? null,
          input.slug ?? null,
          content,
          input.status ?? null,
          input.inNav === undefined ? null : input.inNav ? 1 : 0,
          input.position ?? null,
          now,
          pageId,
          channelId,
          input.landingFormId === undefined ? 0 : 1,
          input.landingFormId ?? null,
        ),
        bumpCacheStatement(e.DB, channelId, now),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw pageTaken();
      throw error;
    }
    return c.json({ data: await readPage(c, channelId, pageId) }, 200);
  },
);

site.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}/site/pages/{pageId}',
    tags: ['Site Studio'],
    summary: 'Remove a custom page',
    request: { params: pageParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { channelId, pageId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'editor');
    const e = env(c);
    const page = await readPage(c, channelId, pageId);
    const now = Date.now();
    await e.DB.batch([
      e.DB.prepare('DELETE FROM site_pages WHERE id = ?1 AND channel_id = ?2').bind(
        pageId,
        channelId,
      ),
      bumpCacheStatement(e.DB, channelId, now),
    ]);
    await audit(c, access, 'site.page_deleted', 'site_page', pageId, { slug: page.slug });
    return c.body(null, 204);
  },
);

// ---- Redirects ---------------------------------------------------------------------------

interface RedirectRow {
  id: string;
  channel_id: string;
  from_path: string;
  to_location: string;
  status_code: SiteRedirect['statusCode'];
  created_at: number;
}

const toRedirect = (row: RedirectRow): SiteRedirect => ({
  id: row.id,
  channelId: row.channel_id,
  from: row.from_path,
  to: row.to_location,
  statusCode: row.status_code,
  createdAt: toIso(row.created_at),
});

async function readRedirect(db: D1Database, channelId: string, id: string): Promise<RedirectRow> {
  const row = await first<RedirectRow>(
    db,
    'SELECT * FROM site_redirects WHERE id = ?1 AND channel_id = ?2',
    id,
    channelId,
  );
  if (!row) throw new ApiError('not_found', 'Redirect not found.');
  return row;
}

const selfRedirect = (from: string, to: string) => to === from || to === `${from}/`;

site.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/site/redirects',
    tags: ['Site Studio'],
    summary: 'Redirects',
    request: { params: channelParam },
    responses: {
      200: ok(SiteRedirectListSchema, 'Redirects and the plan limit'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const e = env(c);
    const rows = await all<RedirectRow>(
      e.DB,
      'SELECT * FROM site_redirects WHERE channel_id = ?1 ORDER BY from_path LIMIT 10000',
      channelId,
    );
    const limit = limitFor(SITE_REDIRECT_LIMITS, await planOf(e.DB, channelId));
    return c.json({ data: { items: rows.map(toRedirect), limit } }, 200);
  },
);

site.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/site/redirects',
    tags: ['Site Studio'],
    summary: 'Add a redirect',
    description:
      'Applied before anything else on the site, by exact path. The free plan includes 50 redirects per Channel.',
    request: { params: channelParam, body: jsonBody(CreateSiteRedirectSchema) },
    responses: {
      201: ok(SiteRedirectSchema, 'Added'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    const e = env(c);
    if (selfRedirect(input.from, input.to)) {
      throw new ApiError('invalid_input', 'A redirect can’t point to itself.', [
        { path: 'to', message: 'A redirect can’t point to itself.' },
      ]);
    }
    const limit = limitFor(SITE_REDIRECT_LIMITS, await planOf(e.DB, channelId));
    if (limit !== null) {
      const count = await first<{ n: number }>(
        e.DB,
        'SELECT count(*) AS n FROM site_redirects WHERE channel_id = ?1',
        channelId,
      );
      if ((count?.n ?? 0) >= limit) {
        throw new ApiError('conflict', `Your plan includes ${limit} redirects per publication.`);
      }
    }
    const now = Date.now();
    const id = newId('siteRedirect', now);
    try {
      await e.DB.batch([
        e.DB.prepare(
          `INSERT INTO site_redirects (id, channel_id, from_path, to_location, status_code, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        ).bind(id, channelId, input.from, input.to, input.statusCode ?? 301, now),
        bumpCacheStatement(e.DB, channelId, now),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError('conflict', 'That path already redirects.', [
          { path: 'from', message: 'That path already redirects.' },
        ]);
      }
      throw error;
    }
    await audit(c, access, 'site.redirect_created', 'site_redirect', id, { from: input.from });
    return c.json({ data: toRedirect(await readRedirect(e.DB, channelId, id)) }, 201);
  },
);

site.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/channels/{channelId}/site/redirects/{redirectId}',
    tags: ['Site Studio'],
    summary: 'Change where a redirect goes',
    request: { params: redirectParams, body: jsonBody(UpdateSiteRedirectSchema) },
    responses: {
      200: ok(SiteRedirectSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, redirectId } = c.req.valid('param');
    const input = c.req.valid('json');
    await requireChannel(c, channelId, 'editor');
    const e = env(c);
    const row = await readRedirect(e.DB, channelId, redirectId);
    if (input.to && selfRedirect(row.from_path, input.to)) {
      throw new ApiError('invalid_input', 'A redirect can’t point to itself.', [
        { path: 'to', message: 'A redirect can’t point to itself.' },
      ]);
    }
    const now = Date.now();
    await e.DB.batch([
      e.DB.prepare(
        `UPDATE site_redirects SET to_location = coalesce(?1, to_location), status_code = coalesce(?2, status_code)
          WHERE id = ?3 AND channel_id = ?4`,
      ).bind(input.to ?? null, input.statusCode ?? null, redirectId, channelId),
      bumpCacheStatement(e.DB, channelId, now),
    ]);
    return c.json({ data: toRedirect(await readRedirect(e.DB, channelId, redirectId)) }, 200);
  },
);

site.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}/site/redirects/{redirectId}',
    tags: ['Site Studio'],
    summary: 'Remove a redirect',
    request: { params: redirectParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { channelId, redirectId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'editor');
    const e = env(c);
    const row = await readRedirect(e.DB, channelId, redirectId);
    await e.DB.batch([
      e.DB.prepare('DELETE FROM site_redirects WHERE id = ?1 AND channel_id = ?2').bind(
        redirectId,
        channelId,
      ),
      bumpCacheStatement(e.DB, channelId, Date.now()),
    ]);
    await audit(c, access, 'site.redirect_deleted', 'site_redirect', redirectId, {
      from: row.from_path,
    });
    return c.body(null, 204);
  },
);

const IMPORT_BATCH = 100;

site.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/site/redirects/import',
    tags: ['Site Studio'],
    summary: 'Import redirects from CSV',
    description:
      'Columns: from, to, and optionally status (301, 302, 307 or 308; 301 when empty). A header row is optional. A path that already redirects is updated. Lines with a problem are skipped and reported by line number (counting the header); the rest are imported. Up to 5,000 lines.',
    request: { params: channelParam, body: jsonBody(ImportRedirectsSchema) },
    responses: {
      200: ok(RedirectImportResultSchema, 'Imported'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { csv } = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    const e = env(c);
    // One redirect per physical line (paths and URLs never contain line breaks), so the line
    // numbers reported match what the operator sees in their file.
    const physical = csv.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
    const header =
      physical[0]
        ?.split(/[,;\t]/)[0]
        ?.trim()
        .toLowerCase() === 'from';
    const lines = physical
      .map((text, index) => ({
        cells: text.trim() ? (parseCsv(text)[0] ?? []) : [],
        line: index + 1,
      }))
      .slice(header ? 1 : 0)
      .filter(({ cells }) => cells.some((cell) => cell.trim() !== ''));
    if (lines.length > MAX_REDIRECT_IMPORT_ROWS) {
      throw new ApiError(
        'invalid_input',
        `Import up to ${MAX_REDIRECT_IMPORT_ROWS.toLocaleString('en-US')} redirects at a time.`,
      );
    }

    const existing = new Set(
      (
        await all<{ from_path: string }>(
          e.DB,
          'SELECT from_path FROM site_redirects WHERE channel_id = ?1',
          channelId,
        )
      ).map((row) => row.from_path),
    );
    const limit = limitFor(SITE_REDIRECT_LIMITS, await planOf(e.DB, channelId));
    let room = limit === null ? Number.POSITIVE_INFINITY : Math.max(0, limit - existing.size);

    const errorsByLine: { line: number; message: string }[] = [];
    const seen = new Map<string, number>();
    const accepted: { from: string; to: string; statusCode: number; isNew: boolean }[] = [];
    for (const { cells, line } of lines) {
      const [from = '', to = '', status = ''] = cells.map((cell) => cell.trim());
      const statusCode = status === '' ? undefined : Number(status);
      const parsed = CreateSiteRedirectSchema.safeParse({ from, to, statusCode });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue?.path[0] === 'statusCode' ? 'status' : String(issue?.path[0] ?? '');
        const message =
          field === 'status'
            ? 'Use status 301, 302, 307 or 308.'
            : `${field ? `${field}: ` : ''}${issue?.message ?? 'Not a valid redirect.'}`;
        errorsByLine.push({ line, message });
        continue;
      }
      const value = parsed.data;
      if (selfRedirect(value.from, value.to)) {
        errorsByLine.push({ line, message: 'A redirect can’t point to itself.' });
        continue;
      }
      const earlier = seen.get(value.from);
      if (earlier !== undefined) {
        errorsByLine.push({ line, message: `${value.from} is already on line ${earlier}.` });
        continue;
      }
      const isNew = !existing.has(value.from);
      if (isNew && room <= 0) {
        errorsByLine.push({
          line,
          message: `Your plan includes ${limit} redirects per publication.`,
        });
        continue;
      }
      if (isNew) room -= 1;
      seen.set(value.from, line);
      accepted.push({ from: value.from, to: value.to, statusCode: value.statusCode ?? 301, isNew });
    }

    const now = Date.now();
    for (let i = 0; i < accepted.length; i += IMPORT_BATCH) {
      await e.DB.batch(
        accepted.slice(i, i + IMPORT_BATCH).map((item) =>
          e.DB.prepare(
            `INSERT INTO site_redirects (id, channel_id, from_path, to_location, status_code, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (channel_id, from_path) DO UPDATE SET to_location = excluded.to_location,
               status_code = excluded.status_code`,
          ).bind(newId('siteRedirect', now), channelId, item.from, item.to, item.statusCode, now),
        ),
      );
    }
    const created = accepted.filter((item) => item.isNew).length;
    const updated = accepted.length - created;
    if (accepted.length) {
      await bumpCacheVersion(e.DB, channelId, now);
      await audit(c, access, 'site.redirects_imported', 'channel', channelId, {
        created,
        updated,
        failed: errorsByLine.length,
      });
    }
    return c.json({ data: { created, updated, errors: errorsByLine } }, 200);
  },
);

// ---- Bot Rules ---------------------------------------------------------------------------

async function readBotRules(db: D1Database, channelId: string): Promise<BotRules> {
  const settings = await first<{ ai_bots: AiBotsPolicy }>(
    db,
    'SELECT ai_bots FROM site_settings WHERE channel_id = ?1',
    channelId,
  );
  const rows = await all<{ agent: string; action: 'allow' | 'block' }>(
    db,
    'SELECT agent, action FROM bot_rules WHERE channel_id = ?1 ORDER BY agent',
    channelId,
  );
  const policy = settings?.ai_bots ?? 'unset';
  const overrides = Object.fromEntries(rows.map((row) => [row.agent, row.action]));
  // Matches the site worker: unset and allow block nothing; custom blocks only 'block' rows.
  const actionFor = (key: string): 'allow' | 'block' =>
    policy === 'block'
      ? 'block'
      : policy === 'custom' && overrides[key] === 'block'
        ? 'block'
        : 'allow';
  return {
    policy,
    overrides,
    agents: KNOWN_AI_BOTS.map((bot) => ({
      key: bot.key,
      name: bot.name,
      robots: bot.robots,
      action: actionFor(bot.key),
    })),
  };
}

site.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/site/bot-rules',
    tags: ['Site Studio'],
    summary: 'Bot Rules: what the site does with AI crawlers',
    request: { params: channelParam },
    responses: { 200: ok(BotRulesSchema, 'Bot Rules'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    return c.json({ data: await readBotRules(env(c).DB, channelId) }, 200);
  },
);

site.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/channels/{channelId}/site/bot-rules',
    tags: ['Site Studio'],
    summary: 'Set the Bot Rules',
    description:
      'Admin role. allow and block apply to every known AI crawler; custom applies the per-crawler overrides (crawlers without one are allowed). Blocked crawlers are refused at the edge and disallowed in robots.txt. The overrides replace the stored ones.',
    request: { params: channelParam, body: jsonBody(UpdateBotRulesSchema) },
    responses: {
      200: ok(BotRulesSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const e = env(c);
    const now = Date.now();
    const overrides = Object.entries(input.overrides ?? {}).filter(
      (entry): entry is [string, 'allow' | 'block'] => entry[1] !== undefined,
    );
    await e.DB.batch([
      e.DB.prepare(
        `INSERT INTO site_settings (channel_id, ai_bots, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (channel_id) DO UPDATE SET ai_bots = excluded.ai_bots,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ).bind(channelId, input.policy, access.auth.operatorId, now),
      e.DB.prepare('DELETE FROM bot_rules WHERE channel_id = ?1').bind(channelId),
      ...overrides.map(([agent, action]) =>
        e.DB.prepare(
          'INSERT INTO bot_rules (channel_id, agent, action, updated_at) VALUES (?1, ?2, ?3, ?4)',
        ).bind(channelId, agent, action, now),
      ),
      bumpCacheStatement(e.DB, channelId, now),
    ]);
    await audit(c, access, 'site.bot_rules_updated', 'channel', channelId, {
      policy: input.policy,
      overrides: overrides.length,
    });
    return c.json({ data: await readBotRules(e.DB, channelId) }, 200);
  },
);

// ---- Analytics ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;
const TOP = 20;

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

site.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/site/analytics',
    tags: ['Site Studio'],
    summary: 'Website analytics',
    description:
      'First-party, cookieless page views from daily rollups (UTC days). Defaults to the last 30 days; filter by exact path and source. Visitors are summed from daily counts, so a visitor on two days counts twice.',
    request: { params: channelParam, query: SiteAnalyticsQuerySchema },
    responses: {
      200: ok(SiteAnalyticsSchema, 'Analytics'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const query = c.req.valid('query');
    await requireChannel(c, channelId, 'viewer');
    const today = dayOf(Date.now());
    const to = query.to ?? today;
    const from = query.from ?? dayOf(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS);
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    if (Number.isNaN(start) || Number.isNaN(end) || dayOf(start) !== from || dayOf(end) !== to) {
      throw new ApiError('invalid_input', 'Use real dates such as 2026-10-27.');
    }
    if (start > end) throw new ApiError('invalid_input', 'The start date is after the end date.');
    if ((end - start) / DAY_MS + 1 > MAX_RANGE_DAYS) {
      throw new ApiError('invalid_input', `Choose a range of up to ${MAX_RANGE_DAYS} days.`);
    }

    // ?1 channel, ?2 from, ?3 to, ?4 path or null, ?5 source or null.
    const where = `channel_id = ?1 AND day BETWEEN ?2 AND ?3
      AND (?4 IS NULL OR path = ?4) AND (?5 IS NULL OR source = ?5)`;
    const params = [channelId, from, to, query.path ?? null, query.source ?? null];
    const db = env(c).DB;
    const grouped = <K extends string>(column: K, limit: number | null) =>
      all<Record<K, string> & { views: number; visitors: number }>(
        db,
        `SELECT ${column}, sum(views) AS views, sum(visitors) AS visitors FROM site_page_views_daily
          WHERE ${where} GROUP BY ${column}
          ORDER BY ${limit === null ? column : `views DESC, ${column}`}${limit === null ? '' : ` LIMIT ${limit}`}`,
        ...params,
      );
    const [totals, days, paths, sources, devices, countries] = await Promise.all([
      first<{ views: number | null; visitors: number | null }>(
        db,
        `SELECT sum(views) AS views, sum(visitors) AS visitors FROM site_page_views_daily WHERE ${where}`,
        ...params,
      ),
      grouped('day', null),
      grouped('path', TOP),
      grouped('source', TOP),
      grouped('device', null),
      grouped('country', TOP),
    ]);
    // Every day in the range, with zeros where nothing was recorded.
    const byDayMap = new Map(days.map((row) => [row.day, row]));
    const byDay: SiteAnalytics['byDay'] = [];
    for (let ms = start; ms <= end; ms += DAY_MS) {
      const day = dayOf(ms);
      const row = byDayMap.get(day);
      byDay.push({ day, views: row?.views ?? 0, visitors: row?.visitors ?? 0 });
    }
    const counted = (row: { views: number; visitors: number }) => ({
      views: row.views,
      visitors: row.visitors,
    });
    const data: SiteAnalytics = {
      from,
      to,
      totals: { views: totals?.views ?? 0, visitors: totals?.visitors ?? 0 },
      byDay,
      topPaths: paths.map((row) => ({ path: row.path, ...counted(row) })),
      topSources: sources.map((row) => ({ source: row.source, ...counted(row) })),
      devices: devices
        .map((row) => ({ device: row.device, ...counted(row) }))
        .sort((a, b) => b.views - a.views),
      countries: countries.map((row) => ({ country: row.country, ...counted(row) })),
    };
    return c.json({ data }, 200);
  },
);
