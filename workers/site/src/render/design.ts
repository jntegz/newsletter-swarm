// Website themes (flag site_templates, docs/site-themes.md): which design the site shows, and the
// home page drawn from it. The published design wins; a Channel that never published one but chose
// a template before themes gets its design made from those settings (designFromLegacy). Compiled
// themes are kept in module memory by a hash of their files, and published designs by version, so
// a warm isolate parses nothing. A design whose theme doesn't compile is skipped, never shown.
import { all, first } from '@swarm/db';
import { DEFAULT_SITE_THEME, SiteDesignSchema } from '@swarm/domain';
import type { FlagValues } from '@swarm/flags';
import {
  compileTheme,
  designFromLegacy,
  designMediaIds,
  fontMediaIds,
  isTesting,
  renderDesign,
  resolveSettings,
  schemePages,
  sectionsOf,
  type CompiledTheme,
  type Design,
  type FontLookup,
  type TemplateImage,
  type ThemeFiles,
} from '@swarm/site-themes';
import { BUILT_IN_THEMES } from '@swarm/site-themes/themes';
import type { SiteChannel, SiteContext } from '../context';
import type { SiteEnv } from '../env';
import { previewCss, previews, type Preview } from './components';
import { listDispatches, mediaMap, pinnedDispatches } from './data';
import { REACH_PATH } from '../edge/cache';
import { dispatchPath, h } from './html';
import { responsiveImage } from './image';
import type { Chrome } from './layout';
import { subscribeForm } from './subscribe';
import { SUBSCRIBER_COUNT_FLOOR } from './templates';

export interface ActiveDesign {
  design: Design;
  theme: CompiledTheme;
  /** A hash of the theme's files: part of the stylesheet's address. */
  key: string;
  source: 'published' | 'legacy' | 'draft';
  /** The design's light or dark setting and its text font, for the <html> element. */
  scheme: 'light' | 'dark' | 'auto';
  font: string;
  /** The page colour in each scheme, for the browser's own colour around the page. */
  pages: { light: string; dark: string };
}

/** How many issues the home page's templates can read. */
const DESIGN_POSTS = 24;
const CACHE_SIZE = 100;

const compiledThemes = new Map<string, CompiledTheme | null>();
const fileKeys = new WeakMap<ThemeFiles, string>();
const publishedDesigns = new Map<string, { version: number; design: Design }>();

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > CACHE_SIZE) map.delete(map.keys().next().value as K);
}

/** FNV-1a over the files in name order: cheap, stable and only used as a cache key. */
function filesKey(files: ThemeFiles): string {
  const known = fileKeys.get(files);
  if (known) return known;
  let hash = 0x811c9dc5;
  for (const name of Object.keys(files).sort()) {
    const text = `${name}\u0000${files[name]}\u0000`;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  const key = (hash >>> 0).toString(16).padStart(8, '0');
  fileKeys.set(files, key);
  return key;
}

const builtInFiles = (theme: string): ThemeFiles | null =>
  BUILT_IN_THEMES[theme as keyof typeof BUILT_IN_THEMES]?.files ?? null;

/** The compiled theme of a design (its own files, else the built-in theme's), or null. */
function compiledTheme(design: Design): { theme: CompiledTheme; key: string } | null {
  const files = design.files ?? builtInFiles(design.theme);
  if (!files) return null;
  const key = filesKey(files);
  if (!compiledThemes.has(key)) remember(compiledThemes, key, compileTheme(files).theme);
  const theme = compiledThemes.get(key);
  return theme ? { theme, key } : null;
}

/** The design a Channel that chose a template before themes gets, or null. */
function legacyDesign(channel: SiteChannel): Design | null {
  const template = channel.settings.theme.template;
  if (!template) return null;
  const defaults = compiledTheme({ theme: template, files: null, settings: {}, sections: null })
    ?.theme.defaults;
  return designFromLegacy(channel.settings.theme, channel.branding.accentColor, defaults ?? null);
}

/** The draft or nothing-yet design, as the editor sees it. */
export const defaultDesign = (channel: SiteChannel): Design =>
  legacyDesign(channel) ?? { theme: DEFAULT_SITE_THEME, files: null, settings: {}, sections: null };

/** The published design, from memory when this version was read before, else one row read. */
export async function publishedDesign(env: SiteEnv, channel: SiteChannel): Promise<Design | null> {
  const version = channel.settings.designVersion;
  if (version === null) return null;
  const known = publishedDesigns.get(channel.id);
  if (known?.version === version) return known.design;
  const row = await first<{ published_json: string | null; published_version: number }>(
    env.DB,
    'SELECT published_json, published_version FROM site_designs WHERE channel_id = ?1',
    channel.id,
  );
  if (!row?.published_json) return null;
  const parsed = SiteDesignSchema.safeParse(JSON.parse(row.published_json));
  if (!parsed.success) return null;
  remember(publishedDesigns, channel.id, { version: row.published_version, design: parsed.data });
  return parsed.data;
}

/** A design with its compiled theme, ready to draw, or null when its theme doesn't compile. */
export function activate(design: Design, source: ActiveDesign['source']): ActiveDesign | null {
  const compiled = compiledTheme(design);
  if (!compiled) return null;
  const values = resolveSettings(compiled.theme.settings, design.settings);
  const scheme = values.scheme === 'dark' || values.scheme === 'auto' ? values.scheme : 'light';
  const font = typeof values.body_font === 'string' ? values.body_font : 'geist';
  return { design, ...compiled, source, scheme, font, pages: schemePages(values) };
}

/** What the site shows: the published design, else one made from the old template settings. */
export async function activeDesign(
  c: SiteContext,
  flags: FlagValues,
): Promise<ActiveDesign | null> {
  if (!flags.site_templates) return null;
  const channel = c.get('channel');
  try {
    const published = await publishedDesign(c.get('env'), channel);
    const design = published ?? legacyDesign(channel);
    if (!design) return null;
    const active = activate(design, published ? 'published' : 'legacy');
    if (!active) {
      c.get('log').warn('site design skipped: its theme does not compile', {
        channel: channel.id,
        theme: design.theme,
      });
    }
    return active;
  } catch (error) {
    c.get('log').error('site design failed to load', {
      channel: channel.id,
      error: (error as Error).message,
    });
    return null;
  }
}

/**
 * The uploaded fonts a design's font settings name, as the lookup designCss takes: one query for
 * all of them, this Channel's public font files only. Each is served from the site's own /media/,
 * so readers load nothing from another server. A font that is gone is simply not found, and the
 * setting's default is used; so is every default if the lookup fails (docs/site-themes.md).
 */
export async function designFonts(c: SiteContext, active: ActiveDesign): Promise<FontLookup> {
  const ids = fontMediaIds(
    active.theme.settings,
    resolveSettings(active.theme.settings, active.design.settings),
  );
  if (ids.length === 0) return () => null;
  const channel = c.get('channel');
  try {
    const rows = await all<{ id: string; r2_key: string; alt_text: string | null }>(
      c.get('env').DB,
      `SELECT id, r2_key, alt_text FROM media
        WHERE workspace_id = ?1 AND channel_id = ?2 AND visibility = 'public' AND deleted_at IS NULL
          AND content_type IN ('font/woff2', 'font/woff')
          AND id IN (SELECT value FROM json_each(?3))`,
      channel.workspaceId,
      channel.id,
      JSON.stringify(ids),
    );
    const fonts = new Map(
      rows.map((r) => [r.id, { url: `/media/${r.r2_key}`, family: r.alt_text }]),
    );
    return (id) => fonts.get(id) ?? null;
  } catch (error) {
    c.get('log').warn('site design fonts failed to load', {
      channel: channel.id,
      error: (error as Error).message,
    });
    return () => null;
  }
}

// ---- The home page ---------------------------------------------------------------------------

export interface DesignReader {
  is_subscriber: boolean;
  is_paid: boolean;
}

const percent = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value * 100)))
    : 50;

/** One half of "50% 30%", as a whole percentage. */
const focalPart = (value: string | undefined) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 50;
};

/** sizes="…" comes from theme code: only what a sizes list is made of, else the whole width. */
const safeSizes = (sizes: string) =>
  /^[\w\s(),.:%-]{1,200}$/.test(sizes) && !/[<>"'&]/.test(sizes) ? sizes : '100vw';

interface Counts {
  subscribers: number | null;
  issues: number;
  paidPlans: boolean;
}

async function counts(env: SiteEnv, channelId: string, subscribers: boolean): Promise<Counts> {
  const [members, issues, plan] = await Promise.all([
    subscribers
      ? first<{ n: number }>(
          env.DB,
          `SELECT count(*) AS n FROM members WHERE channel_id = ?1 AND status = 'active'`,
          channelId,
        )
      : null,
    first<{ n: number }>(
      env.DB,
      `SELECT count(*) AS n FROM dispatches
        WHERE channel_id = ?1 AND web_published_at IS NOT NULL AND web_visibility <> 'hidden'`,
      channelId,
    ),
    first<{ ok: number }>(
      env.DB,
      `SELECT 1 AS ok FROM membership_levels l
        WHERE l.channel_id = ?1 AND l.status = 'active' AND l.visibility = 'public'
          AND EXISTS (SELECT 1 FROM level_prices p WHERE p.level_id = l.id AND p.status = 'active')
        LIMIT 1`,
      channelId,
    ),
  ]);
  const n = members?.n ?? null;
  return {
    subscribers: n !== null && n >= SUBSCRIBER_COUNT_FLOOR ? n : null,
    issues: issues?.n ?? 0,
    paidPlans: plan !== null,
  };
}

async function authorNames(
  env: SiteEnv,
  channelId: string,
  operatorIds: string[],
): Promise<Map<string, { name: string; slug: string }>> {
  const ids = [...new Set(operatorIds)];
  if (ids.length === 0) return new Map();
  const rows = await all<{ operator_id: string; name: string; slug: string }>(
    env.DB,
    `SELECT operator_id, name, slug FROM author_profiles
      WHERE channel_id = ?1 AND operator_id IN (SELECT value FROM json_each(?2))`,
    channelId,
    JSON.stringify(ids),
  );
  return new Map(rows.map((r) => [r.operator_id, { name: r.name, slug: r.slug }]));
}

/** Whether the page shows the subscriber count: a shown hero asks for it (show_count), A or B. */
function showsCount(active: ActiveDesign): boolean {
  const defs = active.theme.schemas.hero?.settings ?? [];
  const counts = (settings: Record<string, unknown>) =>
    resolveSettings(defs, settings).show_count === true;
  return sectionsOf(active.theme, active.design).some(
    (s) =>
      s.type === 'hero' &&
      !s.hidden &&
      (counts(s.settings) || (isTesting(s) && counts(s.experiment.variantB))),
  );
}

/**
 * The section analytics beacon (docs/site-themes.md): a 1×1 same-origin image the browser loads
 * lazily, so only when the reader scrolls near the section. It names the published design's
 * version, the section and the variant, nothing about the reader (routes/reach.ts counts it).
 */
function sectionBeacon(designVersion: number, sectionId: string, variant: 'a' | 'b') {
  const src = `${REACH_PATH}?d=${designVersion}&s=${encodeURIComponent(sectionId)}&v=${variant}`;
  return `<img src="${h(src)}" alt="" width="1" height="1" loading="lazy" decoding="async" aria-hidden="true" class="t-beacon">`;
}

interface DesignHomeOptions {
  /** The variant of each running A/B test this view shows (c.var.variants on the live site). */
  variants?: Record<string, 'a' | 'b'>;
  /**
   * Count this page: a beacon at the end of each section and the section in its signup forms.
   * Only the published design is counted; previews and old template settings never are.
   */
  counted?: boolean;
}

/**
 * Draws the home page of a design for a reader: the HTML for <main> and the page's own rules
 * (focal points of the images it shows). Throws what the renderer throws (RenderLimit).
 */
export async function designHome(
  c: SiteContext,
  chrome: Chrome,
  active: ActiveDesign,
  reader: DesignReader,
  options: DesignHomeOptions = {},
): Promise<{ html: string; css: string }> {
  const env = c.get('env');
  const channel = c.get('channel');
  const version = channel.settings.designVersion;
  const counted = options.counted === true && active.source === 'published' && version !== null;
  // Pins belong to the homepage layouts: with site_homepage_layouts off none are loaded.
  const [pinned, latest, numbers, media] = await Promise.all([
    chrome.flags.site_homepage_layouts ? pinnedDispatches(env, channel) : Promise.resolve([]),
    listDispatches(env, channel.id, { pageSize: DESIGN_POSTS }),
    counts(env, channel.id, showsCount(active)),
    mediaMap(env, channel.workspaceId, designMediaIds(active.theme, active.design)),
  ]);
  const pinnedIds = new Set(pinned.map((d) => d.id));
  const unique = [...pinned, ...latest.items.filter((d) => !pinnedIds.has(d.id))];
  const [views, authors] = await Promise.all([
    previews(c, unique),
    chrome.flags.author_pages
      ? authorNames(
          env,
          channel.id,
          unique.flatMap((d) => (d.createdBy ? [d.createdBy] : [])),
        )
      : Promise.resolve(new Map<string, { name: string; slug: string }>()),
  ]);
  const byId = new Map(views.map((v) => [v.dispatch.id, v]));
  const post = (p: Preview) => {
    const author = p.dispatch.createdBy ? authors.get(p.dispatch.createdBy) : undefined;
    return {
      title: p.dispatch.subject || 'Untitled post',
      url: dispatchPath(p.dispatch.slug),
      excerpt: p.summary,
      date: new Date(p.dispatch.publishedAt).toISOString(),
      reading_minutes: p.rendered.readingMinutes,
      image: p.image
        ? {
            url: p.image.url,
            alt: p.image.alt,
            width: p.image.width,
            height: p.image.height,
            focal: p.image.objectPosition,
          }
        : null,
      is_paid: p.dispatch.visibility === 'paid',
      is_pinned: pinnedIds.has(p.dispatch.id),
      author: author?.name ?? null,
      author_url: author ? `/authors/${author.slug}` : null,
    };
  };
  const pinnedPosts = pinned.flatMap((d) => (byId.has(d.id) ? [post(byId.get(d.id)!)] : []));
  const posts = latest.items.flatMap((d) => (byId.has(d.id) ? [post(byId.get(d.id)!)] : []));

  const images = new Map<string, TemplateImage>();
  for (const [id, m] of media) {
    images.set(id, {
      url: m.url,
      alt: m.alt ?? '',
      width: m.width ?? null,
      height: m.height ?? null,
      focal: `${percent(m.focalX)}% ${percent(m.focalY)}%`,
    });
  }
  const logo: TemplateImage | null = chrome.logo
    ? {
        url: chrome.logo.url,
        alt: chrome.logo.alt,
        width: chrome.logo.width ?? null,
        height: chrome.logo.height ?? null,
        focal: '50% 50%',
      }
    : null;

  const focal = new Map<string, string>();
  const { html } = renderDesign(
    active.theme,
    active.design,
    {
      globals: {
        site: {
          name: channel.name,
          description: channel.description,
          url: channel.origin,
          logo,
          subscriber_count: numbers.subscribers,
          issue_count: numbers.issues,
          nav: chrome.nav.map((link) => ({
            label: link.label,
            url: link.href,
            current: link.href === '/',
          })),
          archive_url: '/archive',
          about_url: '/about',
          plans_url: numbers.paidPlans ? '/subscribe' : null,
          has_paid_plans: numbers.paidPlans,
        },
        posts,
        pinned: pinnedPosts,
        featured: pinnedPosts[0] ?? posts[0] ?? null,
        page: { path: '/' },
      },
      reader,
      image: (id) => images.get(id) ?? null,
      variants: options.variants,
    },
    {
      subscribeForm: (context) => subscribeForm(env, chrome.form, counted ? context : undefined),
      ...(counted && version !== null
        ? { sectionEnd: (id: string, variant: 'a' | 'b') => sectionBeacon(version, id, variant) }
        : {}),
      image: (image, sizes) => {
        const [x, y] = image.focal.split(' ').map(focalPart);
        const name = `sw-fp-${x}-${y}`;
        focal.set(name, `.${name}{object-position:${x}% ${y}%}`);
        return responsiveImage(
          {
            url: image.url,
            alt: image.alt,
            width: image.width,
            height: image.height,
            objectPosition: `${x}% ${y}%`,
          },
          { eager: false, images: !!env.IMAGES, sizes: safeSizes(sizes) },
        );
      },
    },
  );
  return { html, css: `${previewCss(views)}${[...focal.values()].join('')}` };
}
