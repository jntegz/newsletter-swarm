// Reads for site pages. Every query is scoped to the Channel resolved from the Host header, and a
// Dispatch is on the site only while web_published_at is set and web_visibility isn't 'hidden'.
// Publishing (the api worker) writes those columns, the current row in dispatch_slugs and the
// dispatch_search index; the site only reads them.
import {
  CaptureFormConfigSchema,
  SiteCodeEntrySchema,
  SiteConsentSchema,
  type CaptureFormConfig,
  type WebVisibility,
} from '@swarm/domain';
import { all, first } from '@swarm/db';
import { formStamp, linksFor, loadSnippets, siteCodeOnPlatform } from '@swarm/engine';
import { D1FlagStore, FlagService, type FlagValues } from '@swarm/flags';
import { expandSnippets, mayUseSnippets, snippetIdsOf, type WebMedia } from '@swarm/mail';
import { z } from 'zod';
import type { SiteChannel, SiteContext } from '../context';
import type { SiteEnv } from '../env';
import type { SiteCodeSettings } from './consent';

export interface SiteDispatch {
  id: string;
  subject: string;
  preheader: string;
  seoTitle?: string;
  seoDescription?: string;
  contentJson: string;
  visibility: Exclude<WebVisibility, 'hidden'>;
  publishedAt: number;
  updatedAt: number;
  sectionId: string | null;
  slug: string;
  /** The teammate who created it: the byline, with flag author_pages. */
  createdBy: string | null;
  /** The cover image: shown to every reader, since the Gate hides the body and not the header. */
  coverMediaId: string | null;
  coverAlt: string;
}

interface DispatchRow {
  id: string;
  subject: string;
  seo_title: string | null;
  seo_description: string | null;
  preheader: string;
  content_json: string;
  web_visibility: Exclude<WebVisibility, 'hidden'>;
  web_published_at: number;
  updated_at: number;
  section_id: string | null;
  slug: string;
  created_by: string | null;
  cover_media_id: string | null;
  cover_alt: string;
}

const DISPATCH_COLUMNS = `d.id, d.subject, d.preheader, d.seo_title, d.seo_description, d.content_json, d.web_visibility,
    d.web_published_at, d.updated_at, d.section_id, s.slug, d.created_by, d.cover_media_id, d.cover_alt`;

/** Dispatches on the site, joined to their current slug. Aliases: d (dispatches), s (slug). */
const ON_SITE = `FROM dispatches d
  JOIN dispatch_slugs s ON s.dispatch_id = d.id AND s.channel_id = d.channel_id AND s.is_current = 1
 WHERE d.channel_id = ?1 AND d.web_published_at IS NOT NULL AND d.web_visibility <> 'hidden'`;

const toDispatch = (row: DispatchRow): SiteDispatch => ({
  id: row.id,
  subject: row.subject,
  preheader: row.preheader,
  seoTitle: row.seo_title ?? '',
  seoDescription: row.seo_description ?? '',
  contentJson: row.content_json,
  visibility: row.web_visibility,
  publishedAt: row.web_published_at,
  updatedAt: row.updated_at,
  sectionId: row.section_id,
  slug: row.slug,
  createdBy: row.created_by,
  coverMediaId: row.cover_media_id,
  coverAlt: row.cover_alt,
});

/**
 * Documents with their linked snippets in place, with one read for all of them, so every page and
 * feed works from what a reader sees. A snippet that is gone is removed: it isn't one of the post's
 * blocks when the free share of a gated post is counted.
 */
async function withSnippets<T extends { contentJson: string }>(
  env: SiteEnv,
  channelId: string,
  items: T[],
): Promise<T[]> {
  if (!items.some((item) => mayUseSnippets(item.contentJson))) return items;
  const parse = (json: string): unknown => {
    if (!mayUseSnippets(json)) return null;
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  };
  const documents = items.map((item) => parse(item.contentJson));
  const snippets = await loadSnippets(env.DB, channelId, documents.flatMap(snippetIdsOf));
  return items.map((item, index) =>
    documents[index]
      ? {
          ...item,
          contentJson: JSON.stringify(
            expandSnippets(documents[index], (id) => snippets.get(id) ?? null, {
              dropMissing: true,
            }),
          ),
        }
      : item,
  );
}

/** One stored document, for pages that aren't Dispatches, with its linked snippets in place. */
export async function documentWithSnippets(
  env: SiteEnv,
  channelId: string,
  contentJson: string,
): Promise<string> {
  const [item] = await withSnippets(env, channelId, [{ contentJson }]);
  return item!.contentJson;
}

const PAGE_SIZE = 20;

/** One page of the Channel's Dispatches, newest first; `hasMore` when another page follows. */
export async function listDispatches(
  env: SiteEnv,
  channelId: string,
  options: {
    page?: number;
    pageSize?: number;
    sort?: 'new' | 'top';
    sectionId?: string;
    /** Only this teammate's Dispatches (an author page). */
    authorId?: string;
    exclude?: string[];
  } = {},
): Promise<{ items: SiteDispatch[]; hasMore: boolean }> {
  const size = options.pageSize ?? PAGE_SIZE;
  const offset = Math.max(0, (options.page ?? 1) - 1) * size;
  // "Top": site page views (first-party rollups) plus human email opens of its Broadcasts. With no
  // engagement yet every score is 0 and the order falls back to newest first.
  const score =
    options.sort === 'top'
      ? `(SELECT COALESCE(SUM(v.views), 0) FROM site_page_views_daily v
           WHERE v.channel_id = d.channel_id AND v.path = '/p/' || s.slug)
         + (SELECT COUNT(*) FROM opens o JOIN broadcasts b ON b.id = o.broadcast_id
             WHERE b.dispatch_id = d.id AND o.classification = 'human') DESC, `
      : '';
  const rows = await all<DispatchRow>(
    env.DB,
    `SELECT ${DISPATCH_COLUMNS} ${ON_SITE}
       AND (?2 IS NULL OR d.section_id = ?2)
       AND d.id NOT IN (SELECT value FROM json_each(?3))
       AND (?6 IS NULL OR d.created_by = ?6)
     ORDER BY ${score}d.web_published_at DESC, d.id DESC
     LIMIT ?4 OFFSET ?5`,
    channelId,
    options.sectionId ?? null,
    JSON.stringify(options.exclude ?? []),
    size + 1,
    offset,
    options.authorId ?? null,
  );
  return {
    items: await withSnippets(env, channelId, rows.slice(0, size).map(toDispatch)),
    hasMore: rows.length > size,
  };
}

interface SiteAuthor {
  operatorId: string;
  slug: string;
  name: string;
  bio: string | null;
  avatarMediaId: string | null;
}

const AUTHOR_COLUMNS =
  'operator_id AS operatorId, slug, name, bio, avatar_media_id AS avatarMediaId';

/** An author page by its address, or a byline by the Dispatch's creator (flag author_pages). */
export async function siteAuthor(
  env: SiteEnv,
  channelId: string,
  by: { slug: string } | { operatorId: string },
): Promise<SiteAuthor | null> {
  return 'slug' in by
    ? first<SiteAuthor>(
        env.DB,
        `SELECT ${AUTHOR_COLUMNS} FROM author_profiles WHERE channel_id = ?1 AND slug = ?2`,
        channelId,
        by.slug,
      )
    : first<SiteAuthor>(
        env.DB,
        `SELECT ${AUTHOR_COLUMNS} FROM author_profiles WHERE channel_id = ?1 AND operator_id = ?2`,
        channelId,
        by.operatorId,
      );
}

/** Pinned Dispatches that are on the site, in the order they were pinned. */
export async function pinnedDispatches(
  env: SiteEnv,
  channel: SiteChannel,
): Promise<SiteDispatch[]> {
  const ids = channel.settings.pinned.filter((id) => typeof id === 'string').slice(0, 3);
  if (ids.length === 0) return [];
  const rows = await all<DispatchRow>(
    env.DB,
    `SELECT ${DISPATCH_COLUMNS} ${ON_SITE} AND d.id IN (SELECT value FROM json_each(?2))`,
    channel.id,
    JSON.stringify(ids),
  );
  const dispatches = await withSnippets(env, channel.id, rows.map(toDispatch));
  const byId = new Map(dispatches.map((dispatch) => [dispatch.id, dispatch]));
  return ids.map((id) => byId.get(id)).filter((d): d is SiteDispatch => !!d);
}

/** Every Dispatch on the site, newest first, for feeds and sitemaps. */
export async function recentDispatches(
  env: SiteEnv,
  channelId: string,
  limit: number,
): Promise<SiteDispatch[]> {
  const rows = await all<DispatchRow>(
    env.DB,
    `SELECT ${DISPATCH_COLUMNS} ${ON_SITE} ORDER BY d.web_published_at DESC, d.id DESC LIMIT ?2`,
    channelId,
    limit,
  );
  return withSnippets(env, channelId, rows.map(toDispatch));
}

interface DispatchLink {
  slug: string;
  subject: string;
  publishedAt: number;
  updatedAt: number;
}

/** Slugs and titles of every Dispatch on the site, newest first (sitemaps), without content. */
export async function dispatchLinks(
  env: SiteEnv,
  channelId: string,
  limit: number,
): Promise<DispatchLink[]> {
  return all<DispatchLink>(
    env.DB,
    `SELECT s.slug, d.subject, d.web_published_at AS publishedAt, d.updated_at AS updatedAt
     ${ON_SITE} ORDER BY d.web_published_at DESC, d.id DESC LIMIT ?2`,
    channelId,
    limit,
  );
}

type SlugLookup =
  | { kind: 'found'; dispatch: SiteDispatch }
  /** An old slug: answer with a permanent redirect to the current one. */
  | { kind: 'moved'; slug: string }
  | { kind: 'missing' };

export async function dispatchBySlug(
  env: SiteEnv,
  channelId: string,
  slug: string,
): Promise<SlugLookup> {
  const hit = await first<{ dispatch_id: string; is_current: number }>(
    env.DB,
    'SELECT dispatch_id, is_current FROM dispatch_slugs WHERE channel_id = ?1 AND slug = ?2',
    channelId,
    slug,
  );
  if (!hit) return { kind: 'missing' };
  const row = await first<DispatchRow>(
    env.DB,
    `SELECT ${DISPATCH_COLUMNS} ${ON_SITE} AND d.id = ?2`,
    channelId,
    hit.dispatch_id,
  );
  if (!row) return { kind: 'missing' };
  if (hit.is_current !== 1) return { kind: 'moved', slug: row.slug };
  const [dispatch] = await withSnippets(env, channelId, [toDispatch(row)]);
  return { kind: 'found', dispatch: dispatch! };
}

interface Neighbour {
  slug: string;
  subject: string;
}

/** The next older and next newer Dispatch on the site. */
export async function neighbours(
  env: SiteEnv,
  channelId: string,
  dispatch: SiteDispatch,
): Promise<{ older: Neighbour | null; newer: Neighbour | null }> {
  const [older, newer] = await Promise.all([
    first<Neighbour>(
      env.DB,
      `SELECT s.slug, d.subject ${ON_SITE}
         AND (d.web_published_at < ?2 OR (d.web_published_at = ?2 AND d.id < ?3))
       ORDER BY d.web_published_at DESC, d.id DESC LIMIT 1`,
      channelId,
      dispatch.publishedAt,
      dispatch.id,
    ),
    first<Neighbour>(
      env.DB,
      `SELECT s.slug, d.subject ${ON_SITE}
         AND (d.web_published_at > ?2 OR (d.web_published_at = ?2 AND d.id > ?3))
       ORDER BY d.web_published_at ASC, d.id ASC LIMIT 1`,
      channelId,
      dispatch.publishedAt,
      dispatch.id,
    ),
  ]);
  return { older, newer };
}

interface SiteSection {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

export async function sections(env: SiteEnv, channelId: string): Promise<SiteSection[]> {
  return all<SiteSection>(
    env.DB,
    `SELECT id, slug, name, description FROM site_sections WHERE channel_id = ?1
      ORDER BY position, name LIMIT 50`,
    channelId,
  );
}

interface SitePage {
  slug: string;
  title: string;
  contentJson: string;
  inNav: boolean;
  /** Set on a landing page: the form it shows. */
  landingFormId: string | null;
  updatedAt: number;
}

/** Published custom pages (all of them, or one by slug). */
export async function publishedPages(
  env: SiteEnv,
  channelId: string,
  slug?: string,
): Promise<SitePage[]> {
  const rows = await all<{
    slug: string;
    title: string;
    content_json: string;
    in_nav: number;
    landing_form_id: string | null;
    updated_at: number;
  }>(
    env.DB,
    `SELECT slug, title, content_json, in_nav, landing_form_id, updated_at FROM site_pages
      WHERE channel_id = ?1 AND status = 'published' AND (?2 IS NULL OR slug = ?2)
      ORDER BY position, title LIMIT 500`,
    channelId,
    slug ?? null,
  );
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    contentJson: r.content_json,
    inNav: r.in_nav === 1,
    landingFormId: r.landing_form_id,
    updatedAt: r.updated_at,
  }));
}

/** Public media of the Channel's workspace, by id, as the web renderer wants it. */
export async function mediaMap(
  env: SiteEnv,
  workspaceId: string,
  ids: Iterable<string>,
): Promise<Map<string, WebMedia>> {
  const list = [...new Set(ids)].filter((id) => /^md_[0-9a-f]{32}$/.test(id)).slice(0, 200);
  if (list.length === 0) return new Map();
  const rows = await all<{
    id: string;
    r2_key: string;
    alt_text: string | null;
    width: number | null;
    height: number | null;
    focal_x: number | null;
    focal_y: number | null;
  }>(
    env.DB,
    `SELECT id, r2_key, alt_text, width, height, focal_x, focal_y FROM media
      WHERE workspace_id = ?1 AND visibility = 'public' AND deleted_at IS NULL
        AND id IN (SELECT value FROM json_each(?2))`,
    workspaceId,
    JSON.stringify(list),
  );
  return new Map(
    rows.map((r) => [
      r.id,
      {
        url: mediaUrl(env, r.r2_key),
        alt: r.alt_text,
        width: r.width,
        height: r.height,
        focalX: r.focal_x,
        focalY: r.focal_y,
      },
    ]),
  );
}

/** Public media are served by this worker at /media/<r2 key> on MEDIA_ORIGIN (as in the api). */
const mediaUrl = (env: SiteEnv, key: string) =>
  `${env.MEDIA_ORIGIN.replace(/\/$/, '')}/media/${key}`;

/** The cookie popup and the owner's code. Read only when a page is rendered, not on a cache hit. */
export async function siteCode(env: SiteEnv, channelId: string): Promise<SiteCodeSettings | null> {
  const row = await first<{ consent_json: string; code_json: string }>(
    env.DB,
    'SELECT consent_json, code_json FROM site_settings WHERE channel_id = ?1',
    channelId,
  );
  if (!row) return null;
  const consent = SiteConsentSchema.safeParse(JSON.parse(row.consent_json));
  const code = z.array(SiteCodeEntrySchema).safeParse(JSON.parse(row.code_json));
  return { consent: consent.success ? consent.data : null, code: code.success ? code.data : [] };
}

/** Whether this request arrived on this install's own domain (<slug>.PLATFORM_SITE_DOMAIN). */
const onPlatformDomain = (env: SiteEnv, host: string) =>
  (host.split(':')[0] ?? '').toLowerCase().endsWith(`.${env.PLATFORM_SITE_DOMAIN.toLowerCase()}`);

/**
 * The popup and the code this request may run (migrations/0065_site_code_rules.sql). On the
 * publication's own custom domain all of it. On this install's own domain, scripts only for a
 * workspace an instance admin owns or allowed: there every site shares the install owner's name.
 * Saved code that may not run is kept, and the dashboard says why. Verification tags load
 * nothing, so they stay.
 */
export async function siteCodeFor(
  env: SiteEnv,
  channel: Pick<SiteChannel, 'id' | 'workspaceId' | 'host'>,
): Promise<SiteCodeSettings | null> {
  const settings = await siteCode(env, channel.id);
  if (!settings || !settings.code.some((entry) => entry.preset !== 'verification')) return settings;
  if (!onPlatformDomain(env, channel.host)) return settings;
  if (await siteCodeOnPlatform(env.DB, channel.workspaceId)) return settings;
  return { ...settings, code: settings.code.filter((entry) => entry.preset === 'verification') };
}

export interface SiteForm {
  id: string;
  version: number;
  config: CaptureFormConfig;
  /** The form asks for the address alone; the name and plan steps follow on /_swarm/join. */
  join?: boolean;
  /** consents.ts formStamp: proves on submit which version this page showed, cached or not. */
  stamp?: string;
}

/**
 * The Capture Form the site renders inline: the most recently published form of the Channel,
 * preferring inline placements, that the capture worker will accept from this site (its origin
 * allowlist) and that the plain form can complete (no required profile fields, which only the
 * embed frame can ask for). Null when there is none. With `formId`, only that form is considered
 * (Link Hub's chosen form).
 */
export async function siteForm(
  env: SiteEnv,
  channel: SiteChannel,
  formId: string | null = null,
): Promise<SiteForm | null> {
  const rows = await all<{ id: string; version: number; published_config_json: string }>(
    env.DB,
    `SELECT id, version, published_config_json FROM capture_forms
      WHERE channel_id = ?1 AND status = 'published' AND deleted_at IS NULL AND kind = 'form'
        AND published_config_json IS NOT NULL AND (?2 IS NULL OR id = ?2)
      ORDER BY (json_extract(published_config_json, '$.placement') = 'inline') DESC,
               published_at DESC
      LIMIT 10`,
    channel.id,
    formId,
  );
  for (const row of rows) {
    let config: CaptureFormConfig;
    try {
      const parsed = CaptureFormConfigSchema.safeParse(JSON.parse(row.published_config_json));
      if (!parsed.success) continue;
      config = parsed.data;
    } catch {
      continue;
    }
    const allowed =
      config.allowedOrigins.length === 0 || config.allowedOrigins.includes(channel.origin);
    const plain = !config.fields.some((f) => f.key.startsWith('field:') && f.required);
    if (allowed && plain) {
      const join =
        channel.settings.signupPath !== 'email' &&
        config.success.type === 'message' &&
        (await new FlagService(new D1FlagStore(env.DB)).enabled('signup_paths', {
          workspaceId: channel.workspaceId,
          channelId: channel.id,
        }));
      const stamp = await formStamp(linksFor(env), row.id, row.version);
      return { id: row.id, version: row.version, config, join, stamp };
    }
  }
  return null;
}

interface SearchHit {
  subject: string;
  preheader: string;
  slug: string;
  publishedAt: number;
  visibility: SiteDispatch['visibility'];
  /** Escaped-later snippet with \u0001 / \u0002 around matches. */
  snippet: string;
}

/** Quoted tokens, so nothing a reader types is read as FTS5 syntax. */
export function ftsQuery(input: string): string | null {
  const tokens = input
    .slice(0, 200)
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter(Boolean)
    .slice(0, 12);
  return tokens.length ? tokens.map((t) => `"${t}"`).join(' ') : null;
}

export async function search(env: SiteEnv, channelId: string, q: string): Promise<SearchHit[]> {
  const match = ftsQuery(q);
  if (!match) return [];
  const rows = await all<{
    subject: string;
    preheader: string;
    slug: string;
    web_published_at: number;
    web_visibility: SiteDispatch['visibility'];
    snip: string | null;
  }>(
    env.DB,
    `SELECT d.subject, d.preheader, s.slug, d.web_published_at, d.web_visibility,
            snippet(dispatch_search, -1, char(1), char(2), '…', 24) AS snip
       FROM dispatch_search f
       JOIN dispatches d ON d.id = f.dispatch_id
       JOIN dispatch_slugs s ON s.dispatch_id = d.id AND s.channel_id = d.channel_id AND s.is_current = 1
      WHERE dispatch_search MATCH ?2 AND f.channel_id = ?1 AND d.channel_id = ?1
        AND d.web_published_at IS NOT NULL AND d.web_visibility <> 'hidden'
      ORDER BY rank LIMIT 20`,
    channelId,
    match,
  );
  return rows.map((r) => ({
    subject: r.subject,
    preheader: r.preheader,
    slug: r.slug,
    publishedAt: r.web_published_at,
    visibility: r.web_visibility,
    snippet: r.snip ?? '',
  }));
}

const flagCache = new WeakMap<object, Promise<FlagValues>>();

/** Feature flags for this request's Channel, evaluated once per request. */
export function siteFlags(c: SiteContext): Promise<FlagValues> {
  const key = c.req.raw;
  let values = flagCache.get(key);
  if (!values) {
    const env = c.get('env');
    const channel = c.get('channel');
    values = new FlagService(new D1FlagStore(env.DB, env.CACHE)).all({
      workspaceId: channel.workspaceId,
      channelId: channel.id,
    });
    flagCache.set(key, values);
  }
  return values;
}

// ---- Series (flag post_series) ----------------------------------------------------------------

interface SiteSeries {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  updatedAt: number;
}

/** A Series' Dispatches that are on the site, in Series order. */
export async function seriesDispatches(
  env: SiteEnv,
  channelId: string,
  seriesId: string,
): Promise<SiteDispatch[]> {
  const rows = await all<DispatchRow>(
    env.DB,
    `SELECT ${DISPATCH_COLUMNS}
       FROM series_dispatches sd
       JOIN dispatches d ON d.id = sd.dispatch_id
       JOIN dispatch_slugs s ON s.dispatch_id = d.id AND s.channel_id = d.channel_id AND s.is_current = 1
      WHERE sd.series_id = ?2 AND d.channel_id = ?1
        AND d.web_published_at IS NOT NULL AND d.web_visibility <> 'hidden'
      ORDER BY sd.position`,
    channelId,
    seriesId,
  );
  return withSnippets(env, channelId, rows.map(toDispatch));
}

export async function seriesBySlug(
  env: SiteEnv,
  channelId: string,
  slug: string,
): Promise<SiteSeries | null> {
  return first<SiteSeries>(
    env.DB,
    `SELECT id, name, slug, description, updated_at AS updatedAt FROM series
      WHERE channel_id = ?1 AND slug = ?2 AND deleted_at IS NULL`,
    channelId,
    slug,
  );
}

/** Every Series with at least one Dispatch on the site (sitemaps). */
export async function seriesLinks(env: SiteEnv, channelId: string): Promise<SiteSeries[]> {
  return all<SiteSeries>(
    env.DB,
    `SELECT se.id, se.name, se.slug, se.description, se.updated_at AS updatedAt FROM series se
      WHERE se.channel_id = ?1 AND se.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM series_dispatches sd JOIN dispatches d ON d.id = sd.dispatch_id
                     WHERE sd.series_id = se.id AND d.web_published_at IS NOT NULL
                       AND d.web_visibility <> 'hidden')
      ORDER BY se.name LIMIT 500`,
    channelId,
  );
}

/** Where a Dispatch sits in its Series, or null when it is in none. */
export async function seriesPlace(
  env: SiteEnv,
  channelId: string,
  dispatchId: string,
): Promise<{
  name: string;
  slug: string;
  part: number;
  total: number;
  next: { slug: string; subject: string } | null;
} | null> {
  const series = await first<SiteSeries>(
    env.DB,
    `SELECT se.id, se.name, se.slug, se.description, se.updated_at AS updatedAt
       FROM series_dispatches sd JOIN series se ON se.id = sd.series_id
      WHERE sd.dispatch_id = ?2 AND se.channel_id = ?1 AND se.deleted_at IS NULL`,
    channelId,
    dispatchId,
  );
  if (!series) return null;
  const items = await seriesDispatches(env, channelId, series.id);
  const index = items.findIndex((d) => d.id === dispatchId);
  if (index < 0) return null;
  const next = items[index + 1];
  return {
    name: series.name,
    slug: series.slug,
    part: index + 1,
    total: items.length,
    next: next ? { slug: next.slug, subject: next.subject } : null,
  };
}
