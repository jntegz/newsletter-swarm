/**
 * Reading linked snippets for a render (see @swarm/mail's ./snippets). Only ever by Channel, so a
 * post can't read another publication's snippet by naming its id.
 */
import { expandSnippets, mayUseSnippets, snippetIdsOf } from '@swarm/mail';
import { all } from './db';

/**
 * Snippets as read so far, by id; null when one is gone. Passing the same snapshot to several
 * renders makes them agree, however the snippet changes in between: that is how every part of one
 * send (the full email, the teaser, the Split Test variants) uses one version of it.
 */
export type SnippetSnapshot = Map<string, unknown>;

/** Reads the snippets the snapshot doesn't hold yet. */
export async function loadSnippets(
  db: D1Database,
  channelId: string,
  ids: Iterable<string>,
  snapshot: SnippetSnapshot = new Map(),
): Promise<SnippetSnapshot> {
  const missing = [...new Set(ids)].filter((id) => !snapshot.has(id));
  if (!missing.length) return snapshot;
  const rows = await all<{ id: string; content_json: string }>(
    db,
    `SELECT id, content_json FROM snippets
      WHERE channel_id = ?1 AND id IN (SELECT value FROM json_each(?2))`,
    channelId,
    JSON.stringify(missing),
  );
  for (const id of missing) snapshot.set(id, null);
  for (const row of rows) {
    try {
      snapshot.set(row.id, JSON.parse(row.content_json));
    } catch {
      // Unreadable reads as gone: the block renders nothing and the post still renders.
    }
  }
  return snapshot;
}

/** The document with its snippets in place. Without snippets: the same object, and no query. */
export async function resolveSnippets<T>(
  db: D1Database,
  channelId: string,
  document: T,
  snapshot: SnippetSnapshot = new Map(),
): Promise<T> {
  const ids = snippetIdsOf(document);
  if (ids.length) await loadSnippets(db, channelId, ids, snapshot);
  return expandSnippets(document, (id) => snapshot.get(id) ?? null);
}

/** A stored document (JSON) with its snippets in place. */
export async function resolveSnippetsJson(
  db: D1Database,
  channelId: string,
  json: string,
  snapshot: SnippetSnapshot = new Map(),
): Promise<string> {
  if (!mayUseSnippets(json)) return json;
  try {
    return JSON.stringify(await resolveSnippets(db, channelId, JSON.parse(json), snapshot));
  } catch (error) {
    if (error instanceof SyntaxError) return json;
    throw error;
  }
}

export interface SnippetUsage {
  posts: number;
  /** Of `posts`, those already sent or sending: their emails keep the version they went out with. */
  sentPosts: number;
  flowEmails: number;
  pages: number;
  templates: number;
}

/** The text every document using this snippet holds; documents are stored as compact JSON. */
export const snippetNeedle = (snippetId: string) => `"snippetId":"${snippetId}"`;

/** Where a snippet is used, derived from the documents themselves. */
export async function snippetUsage(
  db: D1Database,
  channelId: string,
  snippetId: string,
): Promise<SnippetUsage> {
  const [row] = await all<SnippetUsage>(
    db,
    `SELECT
       (SELECT count(*) FROM dispatches WHERE channel_id = ?1 AND kind = 'broadcast' AND instr(content_json, ?2) > 0) AS posts,
       (SELECT count(*) FROM dispatches WHERE channel_id = ?1 AND kind = 'broadcast' AND status IN ('sending', 'sent') AND instr(content_json, ?2) > 0) AS sentPosts,
       (SELECT count(*) FROM dispatches WHERE channel_id = ?1 AND kind = 'flow' AND instr(content_json, ?2) > 0) AS flowEmails,
       (SELECT count(*) FROM site_pages WHERE channel_id = ?1 AND instr(content_json, ?2) > 0)
         + (SELECT count(*) FROM site_settings WHERE channel_id = ?1 AND instr(about_json, ?2) > 0) AS pages,
       (SELECT count(*) FROM templates WHERE channel_id = ?1 AND deleted_at IS NULL AND instr(content_json, ?2) > 0) AS templates`,
    channelId,
    snippetNeedle(snippetId),
  );
  return row ?? { posts: 0, sentPosts: 0, flowEmails: 0, pages: 0, templates: 0 };
}
