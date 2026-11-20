/**
 * Web publication of Dispatches: slugs, the site search index and the site cache version.
 *
 * The contract the site worker reads:
 * - A Dispatch is on the site when `web_published_at` is set and `web_visibility` isn't 'hidden'.
 *   It is set once, when the Dispatch starts sending or is published to the web only, and kept
 *   when it is hidden later (unpublishing sets the visibility to 'hidden').
 * - `dispatch_slugs` holds every slug a Dispatch has had; exactly one is current. Old slugs stay
 *   and redirect to the current one. Slugs are unique per Channel across all Dispatches and never
 *   take a reserved site path.
 * - `dispatch_search` has one row per Dispatch on the site: title (subject), subtitle (preheader)
 *   and body. The body is only what anyone may read: the whole text of a public Dispatch, the part
 *   before the gate of a members-only or paid one, and nothing when such a Dispatch has no gate
 *   the website shows (an email-only paywall break doesn't count).
 *   A linked snippet's text counts as the Dispatch's own, so changing a snippet refreshes the rows
 *   of the Dispatches on the site that use it (refreshSnippetUsers).
 * - `site_settings.cache_version` is bumped by every change that affects rendered pages.
 */
import { RESERVED_SITE_PATHS, slugify, type WebVisibility } from '@swarm/domain';
import { RenderError, renderWeb, webMergeTags, webShare } from '@swarm/mail';
import { isUniqueViolation } from '@swarm/db';
import type { SiteOriginConfig } from './config';
import { all, first } from './db';
import { bumpCacheStatement } from './hostnames';
import { resolveSnippetsJson, snippetNeedle, type SnippetSnapshot } from './snippets';

const RESERVED = new Set<string>(RESERVED_SITE_PATHS);

export const isReservedSlug = (slug: string) => RESERVED.has(slug);

/** The address every Channel has: <scheme>://<slug>.<platform site domain>. */
export function platformSiteOrigin(site: SiteOriginConfig, channelSlug: string): string {
  return `${site.scheme}://${channelSlug}.${site.platformDomain}`;
}

/**
 * Where a Channel's site is served: its primary active web hostname, else the platform address.
 * Matches the site worker's canonical origin.
 */
export async function channelSiteOrigin(
  db: D1Database,
  site: SiteOriginConfig,
  channelId: string,
): Promise<{ origin: string; platformOrigin: string }> {
  const row = await first<{ slug: string; primary_host: string | null }>(
    db,
    `SELECT c.slug,
            (SELECT h.hostname FROM custom_hostnames h
              WHERE h.channel_id = c.id AND h.is_primary = 1 AND h.status = 'active' AND h.role = 'web') AS primary_host
       FROM channels c WHERE c.id = ?1`,
    channelId,
  );
  if (!row) throw new Error('channel not found');
  const platformOrigin = platformSiteOrigin(site, row.slug);
  return {
    origin: row.primary_host ? `${site.scheme}://${row.primary_host}` : platformOrigin,
    platformOrigin,
  };
}

export const dispatchWebUrl = (origin: string, slug: string) => `${origin}/p/${slug}`;

export async function currentSlug(db: D1Database, dispatchId: string): Promise<string | null> {
  const row = await first<{ slug: string }>(
    db,
    'SELECT slug FROM dispatch_slugs WHERE dispatch_id = ?1 AND is_current = 1',
    dispatchId,
  );
  return row?.slug ?? null;
}

/** `base`, or `base-2`, `base-3`, … : the first that no Dispatch of the Channel has used. */
export async function uniqueSlug(db: D1Database, channelId: string, base: string): Promise<string> {
  const stem = base.slice(0, 110).replace(/-+$/, '') || 'dispatch';
  const taken = new Set(
    (
      await all<{ slug: string }>(
        db,
        `SELECT slug FROM dispatch_slugs WHERE channel_id = ?1 AND (slug = ?2 OR substr(slug, 1, ?3) = ?4)`,
        channelId,
        stem,
        stem.length + 1,
        `${stem}-`,
      )
    ).map((row) => row.slug),
  );
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? stem : `${stem}-${n}`;
    if (!taken.has(candidate) && !RESERVED.has(candidate)) return candidate;
  }
}

export interface SlugPlan {
  slug: string;
  /** True when the slug still has to be stored. */
  isNew: boolean;
}

/** The Dispatch's current slug, or the one it would get from its subject now. */
export async function planSlug(
  db: D1Database,
  dispatch: { id: string; channel_id: string; subject: string },
): Promise<SlugPlan> {
  const existing = await currentSlug(db, dispatch.id);
  if (existing) return { slug: existing, isNew: false };
  return {
    slug: await uniqueSlug(db, dispatch.channel_id, slugify(dispatch.subject)),
    isNew: true,
  };
}

export interface PublishableDispatch {
  id: string;
  channel_id: string;
  subject: string;
  preheader: string;
  content_json: string;
  web_visibility: WebVisibility;
  web_published_at: number | null;
}

/**
 * What site search may hold for a Dispatch: never text behind its gate. The free part comes from
 * webShare, the split the site page uses, so search never holds more than the page shows anyone.
 */
export function searchBody(content: unknown, visibility: WebVisibility, channelName: string) {
  try {
    const options = { channelName, media: () => null, allowHtmlBlocks: false };
    if (visibility === 'public') return renderWeb(content, options).text;
    const share = webShare(content, visibility);
    // Without a paywall break the website shows, a members-only or paid Dispatch indexes nothing.
    if (share.implicitGate) return '';
    const web = renderWeb(share.document, options);
    return web.hasGate ? web.freeText : '';
  } catch (error) {
    if (error instanceof RenderError) return '';
    throw error;
  }
}

/** Replaces the Dispatch's search row; removes it when the Dispatch isn't on the site. */
export function searchStatements(
  db: D1Database,
  dispatch: PublishableDispatch,
  channelName: string,
  onSite: boolean,
): D1PreparedStatement[] {
  const remove = db.prepare('DELETE FROM dispatch_search WHERE dispatch_id = ?1').bind(dispatch.id);
  if (!onSite) return [remove];
  let content: unknown = null;
  try {
    content = JSON.parse(dispatch.content_json);
  } catch {
    // An unreadable document indexes its title and subtitle only.
  }
  return [
    remove,
    db
      .prepare(
        'INSERT INTO dispatch_search (dispatch_id, channel_id, title, subtitle, body) VALUES (?1, ?2, ?3, ?4, ?5)',
      )
      .bind(
        dispatch.id,
        dispatch.channel_id,
        webMergeTags(dispatch.subject, channelName),
        webMergeTags(dispatch.preheader, channelName),
        searchBody(content, dispatch.web_visibility, channelName),
      ),
  ];
}

/**
 * Statements that put a Dispatch on the web: web_published_at (unless hidden), its slug, its
 * search row and a cache bump. Run them in the same batch as whatever triggers publication.
 */
export function publicationStatements(
  db: D1Database,
  input: { dispatch: PublishableDispatch; channelName: string; slug: SlugPlan; now: number },
): D1PreparedStatement[] {
  const { dispatch, channelName, slug, now } = input;
  const hidden = dispatch.web_visibility === 'hidden';
  const published = dispatch.web_published_at !== null || !hidden;
  return [
    db
      .prepare(
        `UPDATE dispatches SET web_published_at = ?1 WHERE id = ?2 AND web_published_at IS NULL AND web_visibility <> 'hidden'`,
      )
      .bind(now, dispatch.id),
    ...(slug.isNew
      ? [
          db
            .prepare(
              'INSERT INTO dispatch_slugs (channel_id, slug, dispatch_id, is_current, created_at) VALUES (?1, ?2, ?3, 1, ?4)',
            )
            .bind(dispatch.channel_id, slug.slug, dispatch.id, now),
        ]
      : []),
    ...searchStatements(db, dispatch, channelName, published && !hidden),
    bumpCacheStatement(db, dispatch.channel_id, now),
  ];
}

/** Whether a unique violation came from a slug another Dispatch took in the meantime. */
export async function slugTakenByAnother(
  db: D1Database,
  dispatch: { id: string; channel_id: string },
  slug: string,
): Promise<boolean> {
  return !!(await first(
    db,
    'SELECT 1 FROM dispatch_slugs WHERE channel_id = ?1 AND slug = ?2 AND dispatch_id <> ?3',
    dispatch.channel_id,
    slug,
    dispatch.id,
  ));
}

async function loadPublishable(db: D1Database, dispatchId: string) {
  const row = await first<PublishableDispatch & { channel_name: string }>(
    db,
    `SELECT d.id, d.channel_id, d.subject, d.preheader, d.content_json, d.web_visibility, d.web_published_at,
            c.name AS channel_name
       FROM dispatches d JOIN channels c ON c.id = d.channel_id WHERE d.id = ?1`,
    dispatchId,
  );
  if (!row) throw new Error('dispatch not found');
  // Everything here is for the site's index: with the post's snippets as they are now.
  return { ...row, content_json: await resolveSnippetsJson(db, row.channel_id, row.content_json) };
}

const SNIPPET_REFRESH_BATCH = 50;

/**
 * Brings the search rows of the Dispatches on the site that use a snippet up to date, after it has
 * changed or gone. Pages themselves follow the cache bump that goes with the change.
 */
export async function refreshSnippetUsers(
  db: D1Database,
  channelId: string,
  snippetId: string,
): Promise<void> {
  const snapshot: SnippetSnapshot = new Map();
  let after = '';
  for (;;) {
    const rows = await all<PublishableDispatch & { channel_name: string }>(
      db,
      `SELECT d.id, d.channel_id, d.subject, d.preheader, d.content_json, d.web_visibility, d.web_published_at,
              c.name AS channel_name
         FROM dispatches d JOIN channels c ON c.id = d.channel_id
        WHERE d.channel_id = ?1 AND d.web_published_at IS NOT NULL AND d.web_visibility <> 'hidden'
          AND instr(d.content_json, ?2) > 0 AND d.id > ?3
        ORDER BY d.id LIMIT ?4`,
      channelId,
      snippetNeedle(snippetId),
      after,
      SNIPPET_REFRESH_BATCH,
    );
    if (!rows.length) return;
    const statements: D1PreparedStatement[] = [];
    for (const row of rows) {
      const content_json = await resolveSnippetsJson(db, channelId, row.content_json, snapshot);
      statements.push(...searchStatements(db, { ...row, content_json }, row.channel_name, true));
    }
    await db.batch(statements);
    if (rows.length < SNIPPET_REFRESH_BATCH) return;
    after = rows[rows.length - 1]!.id;
  }
}

/**
 * Puts a Dispatch on the web without sending it, or completes a publication: sets
 * web_published_at if it isn't set (unless hidden), assigns its slug, indexes it and bumps the
 * site cache. Safe to call again.
 */
export async function publishToWeb(
  db: D1Database,
  dispatchId: string,
  now = Date.now(),
): Promise<{ slug: string }> {
  for (let attempt = 0; ; attempt++) {
    const dispatch = await loadPublishable(db, dispatchId);
    const slug = await planSlug(db, dispatch);
    try {
      await db.batch(
        publicationStatements(db, { dispatch, channelName: dispatch.channel_name, slug, now }),
      );
      return { slug: slug.slug };
    } catch (error) {
      if (
        attempt < 3 &&
        isUniqueViolation(error) &&
        slug.isNew &&
        (await slugTakenByAnother(db, dispatch, slug.slug))
      ) {
        continue;
      }
      throw error;
    }
  }
}

/** Refreshes the search row and bumps the cache after an edit, if the Dispatch is on the web. */
export async function reindexDispatch(
  db: D1Database,
  dispatchId: string,
  now = Date.now(),
): Promise<void> {
  const dispatch = await loadPublishable(db, dispatchId);
  if (dispatch.web_published_at === null) return;
  await db.batch([
    ...searchStatements(db, dispatch, dispatch.channel_name, dispatch.web_visibility !== 'hidden'),
    bumpCacheStatement(db, dispatch.channel_id, now),
  ]);
}

/** Takes a Dispatch off the site: hidden, out of search, cache bumped. */
export async function unpublishFromWeb(
  db: D1Database,
  dispatchId: string,
  now = Date.now(),
): Promise<void> {
  const dispatch = await loadPublishable(db, dispatchId);
  await db.batch([
    db
      .prepare(`UPDATE dispatches SET web_visibility = 'hidden', updated_at = ?1 WHERE id = ?2`)
      .bind(now, dispatchId),
    db.prepare('DELETE FROM dispatch_search WHERE dispatch_id = ?1').bind(dispatchId),
    bumpCacheStatement(db, dispatch.channel_id, now),
  ]);
}

export class SlugError extends Error {
  constructor(
    readonly code: 'reserved' | 'taken',
    message: string,
  ) {
    super(message);
    this.name = 'SlugError';
  }
}

/**
 * Gives a Dispatch a new current slug. The old one stays as a redirect; taking back one of the
 * Dispatch's own old slugs makes it current again. Throws SlugError for a reserved slug or one
 * another Dispatch of the Channel has used.
 */
export async function changeSlug(
  db: D1Database,
  dispatch: { id: string; channel_id: string },
  slug: string,
  now = Date.now(),
): Promise<void> {
  if (RESERVED.has(slug)) throw new SlugError('reserved', 'That address is reserved by the site.');
  const owner = await first<{ dispatch_id: string; is_current: number }>(
    db,
    'SELECT dispatch_id, is_current FROM dispatch_slugs WHERE channel_id = ?1 AND slug = ?2',
    dispatch.channel_id,
    slug,
  );
  if (owner && owner.dispatch_id !== dispatch.id) {
    throw new SlugError('taken', 'Another post of this publication uses that address.');
  }
  if (owner?.is_current === 1) return;
  try {
    await db.batch([
      db
        .prepare(
          'UPDATE dispatch_slugs SET is_current = 0 WHERE dispatch_id = ?1 AND is_current = 1',
        )
        .bind(dispatch.id),
      owner
        ? db
            .prepare(
              'UPDATE dispatch_slugs SET is_current = 1 WHERE channel_id = ?1 AND slug = ?2 AND dispatch_id = ?3',
            )
            .bind(dispatch.channel_id, slug, dispatch.id)
        : db
            .prepare(
              'INSERT INTO dispatch_slugs (channel_id, slug, dispatch_id, is_current, created_at) VALUES (?1, ?2, ?3, 1, ?4)',
            )
            .bind(dispatch.channel_id, slug, dispatch.id, now),
      bumpCacheStatement(db, dispatch.channel_id, now),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new SlugError('taken', 'Another post of this publication uses that address.');
    }
    throw error;
  }
}
