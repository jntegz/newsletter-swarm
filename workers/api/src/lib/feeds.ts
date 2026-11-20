/**
 * Feed Sync (Phase 8, flag feed_sync) for the dashboard (/api/v1, routes/feeds.ts) and the
 * public API (/v2, v2/feeds.ts): one implementation behind both. The caller has already resolved
 * the Channel (channelAccess or the principal's scope); everything here is scoped to it, and a
 * feed source of another Channel answers 404. The polling itself is in @swarm/engine
 * (feed-sync.ts). Contract: docs/feed-sync.md.
 */
import { all, first, run } from '@swarm/db';
import {
  FEED_SYNC_LIMITS,
  newId,
  type CreateFeedSourceSchema,
  type FeedCheckResult,
  type FeedItem,
  type FeedItemStatus,
  type FeedPreview,
  type FeedSource,
  type UpdateFeedSourceSchema,
} from '@swarm/domain';
import {
  AudienceError,
  checkFeedSource,
  clockToMinutes,
  feedUrlProblem,
  loadAudienceRules,
  previewFeedDispatch,
  toFeedItem,
  toFeedSources,
  type FeedItemRow,
  type FeedSourceRow,
  type FeedSyncDeps,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import type { z } from '@hono/zod-openapi';
import { actorAudit, type Actor } from './actor';
import { appendAudit } from './audit';
import { env, type AppContext } from './context';
import { checkRosterAudience } from './rosters';
import { engine } from './send';
import { requireFlag } from './site';

type CreateInput = z.output<typeof CreateFeedSourceSchema>;
type UpdateInput = z.output<typeof UpdateFeedSourceSchema>;

// ---- Fetching (replaceable in tests) ---------------------------------------------------------

let injectedFetch: typeof fetch | undefined;

/** Tests answer feed requests here. Pass undefined to go back to the real fetch. */
export function useFeedFetchForTests(fetcher: typeof fetch | undefined): void {
  injectedFetch = fetcher;
}

function feedDeps(c: AppContext): FeedSyncDeps {
  return {
    db: env(c).DB,
    fetch: injectedFetch ?? ((input, init) => fetch(input, init)),
    environment: env(c).ENVIRONMENT,
    mediaOrigin: engine(c).mediaOrigin,
  };
}

// ---- Access ----------------------------------------------------------------------------------

/** Refuses with feature_disabled (404) while feed_sync is off for the Channel. */
export const requireFeedSync = (
  c: AppContext,
  access: { workspaceId: string; channelId: string },
) => requireFlag(c, access, 'feed_sync', 'Feed Sync is not turned on for this publication.');

async function requireSource(
  db: D1Database,
  channelId: string,
  sourceId: string,
): Promise<FeedSourceRow> {
  const row = await first<FeedSourceRow>(
    db,
    'SELECT * FROM feed_sources WHERE id = ?1 AND channel_id = ?2',
    sourceId,
    channelId,
  );
  if (!row) throw new ApiError('not_found', 'Feed source not found.');
  return row;
}

async function sourceOut(db: D1Database, row: FeedSourceRow): Promise<FeedSource> {
  return (await toFeedSources(db, [row]))[0]!;
}

const invalid = (path: string, message: string) =>
  new ApiError('invalid_input', message, [{ path, message }]);

/**
 * Checks what a create or update refers to: the URL, and a Template, sender, Circles and Rosters
 * of this Channel. Normalises `input.audience` the way a Dispatch's is saved: an empty Roster
 * part is dropped, and a Roster part needs the rosters flag.
 */
async function checkReferences(
  c: AppContext,
  actor: Actor,
  channelId: string,
  input: {
    url?: string | undefined;
    templateId?: string | null | undefined;
    senderIdentityId?: string | null | undefined;
    audience?: CreateInput['audience'] | undefined;
  },
): Promise<void> {
  const db = env(c).DB;
  if (input.url !== undefined) {
    const problem = feedUrlProblem(input.url, env(c).ENVIRONMENT);
    if (problem) throw invalid('url', `This feed address can't be used: ${problem}.`);
  }
  if (input.templateId) {
    const template = await first<{ kind: string }>(
      db,
      `SELECT kind FROM templates WHERE id = ?1 AND deleted_at IS NULL AND workspace_id = ?2
         AND (channel_id IS NULL OR channel_id = ?3)`,
      input.templateId,
      actor.workspaceId,
      channelId,
    );
    if (!template)
      throw invalid('templateId', 'Choose a template of this publication or workspace.');
    if (template.kind !== 'dispatch') {
      throw invalid('templateId', 'Choose a template with content, not a design.');
    }
  }
  if (input.senderIdentityId) {
    const sender = await first(
      db,
      'SELECT 1 FROM sender_identities WHERE id = ?1 AND channel_id = ?2',
      input.senderIdentityId,
      channelId,
    );
    if (!sender)
      throw invalid('senderIdentityId', 'That sender is not set up for this publication.');
  }
  if (input.audience) {
    // Rosters (Phase 8): the flag (feature_disabled otherwise) and live Rosters of this Channel.
    const rosters = await checkRosterAudience(
      c,
      { workspaceId: actor.workspaceId, channelId },
      input.audience.rosters,
    );
    input.audience = {
      include: input.audience.include,
      exclude: input.audience.exclude,
      ...(rosters ? { rosters } : {}),
    };
    try {
      await loadAudienceRules(db, channelId, input.audience);
    } catch (error) {
      if (!(error instanceof AudienceError)) throw error;
      throw invalid('audience', 'Choose segments from this publication.');
    }
  }
}

const quiet = (clock: string | null | undefined) =>
  clock === undefined ? undefined : clock === null ? null : clockToMinutes(clock);

// ---- Feed sources ----------------------------------------------------------------------------

export async function listSources(c: AppContext, channelId: string): Promise<FeedSource[]> {
  const db = env(c).DB;
  const rows = await all<FeedSourceRow>(
    db,
    'SELECT * FROM feed_sources WHERE channel_id = ?1 ORDER BY created_at LIMIT 100',
    channelId,
  );
  return toFeedSources(db, rows);
}

export async function getSource(
  c: AppContext,
  channelId: string,
  sourceId: string,
): Promise<FeedSource> {
  const db = env(c).DB;
  return sourceOut(db, await requireSource(db, channelId, sourceId));
}

export async function createSource(
  c: AppContext,
  actor: Actor,
  channelId: string,
  input: CreateInput,
): Promise<FeedSource> {
  const db = env(c).DB;
  await checkReferences(c, actor, channelId, input);
  const existing = await first<{ n: number; same: number }>(
    db,
    'SELECT count(*) AS n, sum(url = ?2) AS same FROM feed_sources WHERE channel_id = ?1',
    channelId,
    input.url,
  );
  if ((existing?.same ?? 0) > 0) {
    throw new ApiError('conflict', 'This publication already follows that feed.');
  }
  if ((existing?.n ?? 0) >= FEED_SYNC_LIMITS.sourcesPerChannel) {
    throw new ApiError(
      'conflict',
      `A publication can follow up to ${FEED_SYNC_LIMITS.sourcesPerChannel} feeds. Delete one first.`,
    );
  }
  const workspaceSources = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM feed_sources fs JOIN channels c ON c.id = fs.channel_id
      WHERE c.workspace_id = (SELECT workspace_id FROM channels WHERE id = ?1)`,
    channelId,
  );
  if ((workspaceSources?.n ?? 0) >= FEED_SYNC_LIMITS.sourcesPerWorkspace) {
    throw new ApiError(
      'conflict',
      `A workspace can follow up to ${FEED_SYNC_LIMITS.sourcesPerWorkspace} feeds across its publications. Delete one first.`,
    );
  }
  const now = Date.now();
  const id = newId('feedSource', now);
  await run(
    db,
    `INSERT INTO feed_sources (id, channel_id, url, name, mode, grouping, content_mode, template_id, sender_identity_id,
       audience_json, subject_template, interval_minutes, min_gap_minutes, max_per_day, digest_limit, quiet_start,
       quiet_end, timezone, status, next_check_at, created_by, created_at, updated_at,
       digest_weekdays_json, digest_time, digest_since)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 'active', ?19, ?20, ?19, ?19, ?21, ?22, ?19)`,
    id,
    channelId,
    input.url,
    input.name || null,
    input.mode,
    input.grouping,
    input.contentMode,
    input.templateId ?? null,
    input.senderIdentityId ?? null,
    JSON.stringify(input.audience ?? { include: [], exclude: [] }),
    input.subjectTemplate ?? null,
    input.intervalMinutes,
    input.minGapMinutes,
    input.maxPerDay,
    input.digestLimit,
    quiet(input.quietStart) ?? null,
    quiet(input.quietEnd) ?? null,
    input.timezone,
    now,
    actor.operatorId,
    input.digestSchedule ? JSON.stringify(input.digestSchedule.weekdays) : null,
    input.digestSchedule?.time ?? null,
  );
  await appendAudit(
    db,
    actorAudit(actor, {
      action: 'feed_source.created',
      targetType: 'feed_source',
      targetId: id,
      metadata: { channelId, url: input.url, mode: input.mode, grouping: input.grouping },
    }),
  );
  return getSource(c, channelId, id);
}

export async function updateSource(
  c: AppContext,
  actor: Actor,
  channelId: string,
  sourceId: string,
  input: UpdateInput,
): Promise<FeedSource> {
  const db = env(c).DB;
  const row = await requireSource(db, channelId, sourceId);
  await checkReferences(c, actor, channelId, input);
  if (input.url !== undefined && input.url !== row.url) {
    const taken = await first(
      db,
      'SELECT 1 FROM feed_sources WHERE channel_id = ?1 AND url = ?2 AND id <> ?3',
      channelId,
      input.url,
      sourceId,
    );
    if (taken) throw new ApiError('conflict', 'This publication already follows that feed.');
  }
  const now = Date.now();
  const urlChanged = input.url !== undefined && input.url !== row.url;
  const resuming = input.status === 'active' && row.status !== 'active';
  const pick = <T>(value: T | undefined, current: T): T => (value === undefined ? current : value);
  // A new schedule starts now: a slot that passed before it was set releases nothing.
  const digest =
    input.digestSchedule === undefined
      ? {
          weekdays: row.digest_weekdays_json,
          time: row.digest_time,
          since: row.digest_since,
        }
      : {
          weekdays: input.digestSchedule ? JSON.stringify(input.digestSchedule.weekdays) : null,
          time: input.digestSchedule?.time ?? null,
          since: now,
        };
  await run(
    db,
    `UPDATE feed_sources SET url = ?2, name = ?3, mode = ?4, grouping = ?5, content_mode = ?6, template_id = ?7,
       sender_identity_id = ?8, audience_json = ?9, subject_template = ?10, interval_minutes = ?11,
       min_gap_minutes = ?12, max_per_day = ?13, digest_limit = ?14, quiet_start = ?15, quiet_end = ?16,
       timezone = ?17, status = ?18, updated_at = ?19,
       -- A new URL is a new feed: its first fetch is the baseline again.
       title = CASE WHEN ?20 = 1 THEN NULL ELSE title END,
       format = CASE WHEN ?20 = 1 THEN NULL ELSE format END,
       etag = CASE WHEN ?20 = 1 THEN NULL ELSE etag END,
       last_modified = CASE WHEN ?20 = 1 THEN NULL ELSE last_modified END,
       last_success_at = CASE WHEN ?20 = 1 THEN NULL ELSE last_success_at END,
       failure_count = CASE WHEN ?20 = 1 OR ?21 = 1 THEN 0 ELSE failure_count END,
       last_error = CASE WHEN ?20 = 1 OR ?21 = 1 THEN NULL ELSE last_error END,
       next_check_at = CASE WHEN ?20 = 1 OR ?21 = 1 THEN ?19 ELSE next_check_at END,
       digest_weekdays_json = ?22, digest_time = ?23, digest_since = ?24
     WHERE id = ?1`,
    sourceId,
    pick(input.url, row.url),
    input.name === undefined ? row.name : input.name || null,
    pick(input.mode, row.mode),
    pick(input.grouping, row.grouping),
    pick(input.contentMode, row.content_mode),
    pick(input.templateId, row.template_id),
    pick(input.senderIdentityId, row.sender_identity_id),
    input.audience ? JSON.stringify(input.audience) : row.audience_json,
    pick(input.subjectTemplate, row.subject_template),
    pick(input.intervalMinutes, row.interval_minutes),
    pick(input.minGapMinutes, row.min_gap_minutes),
    pick(input.maxPerDay, row.max_per_day),
    pick(input.digestLimit, row.digest_limit),
    pick(quiet(input.quietStart), row.quiet_start),
    pick(quiet(input.quietEnd), row.quiet_end),
    pick(input.timezone, row.timezone),
    pick(input.status, row.status),
    now,
    urlChanged ? 1 : 0,
    resuming ? 1 : 0,
    digest.weekdays,
    digest.time,
    digest.since,
  );
  const changed = Object.keys(input).filter((key) => key !== 'status');
  const action =
    input.status === 'paused' && row.status !== 'paused'
      ? 'feed_source.paused'
      : resuming
        ? 'feed_source.resumed'
        : 'feed_source.changed';
  await appendAudit(
    db,
    actorAudit(actor, {
      action,
      targetType: 'feed_source',
      targetId: sourceId,
      metadata: { channelId, ...(changed.length ? { changed } : {}) },
    }),
  );
  return getSource(c, channelId, sourceId);
}

export async function deleteSource(
  c: AppContext,
  actor: Actor,
  channelId: string,
  sourceId: string,
): Promise<void> {
  const db = env(c).DB;
  const row = await requireSource(db, channelId, sourceId);
  // Its items go with it; the Dispatches it made stay.
  await run(db, 'DELETE FROM feed_sources WHERE id = ?1', sourceId);
  await appendAudit(
    db,
    actorAudit(actor, {
      action: 'feed_source.deleted',
      targetType: 'feed_source',
      targetId: sourceId,
      metadata: { channelId, url: row.url },
    }),
  );
}

/**
 * "Check now": fetches in this request and answers with what happened. A turned-off `send`
 * source stays off (`resumeRequired`); a turned-off `draft` source it turns back on is audited
 * as feed_source.resumed with the actor who checked.
 */
export async function checkSource(
  c: AppContext,
  actor: Actor,
  channelId: string,
  sourceId: string,
): Promise<FeedCheckResult> {
  const db = env(c).DB;
  await requireSource(db, channelId, sourceId);
  const outcome = await checkFeedSource(feedDeps(c), sourceId, Date.now(), { manual: true });
  if (!outcome) throw new ApiError('conflict', 'A check is already running. Try again shortly.');
  const { reactivated, ...result } = outcome;
  if (reactivated) {
    await appendAudit(
      db,
      actorAudit(actor, {
        action: 'feed_source.resumed',
        targetType: 'feed_source',
        targetId: sourceId,
        metadata: { channelId, by: 'check' },
      }),
    );
  }
  return { ...result, source: await getSource(c, channelId, sourceId) };
}

export async function listItems(
  c: AppContext,
  channelId: string,
  sourceId: string,
  status: FeedItemStatus | undefined,
): Promise<FeedItem[]> {
  const db = env(c).DB;
  await requireSource(db, channelId, sourceId);
  const rows = await all<FeedItemRow>(
    db,
    `SELECT * FROM feed_items WHERE feed_source_id = ?1 AND (?2 IS NULL OR status = ?2)
      ORDER BY id DESC LIMIT 100`,
    sourceId,
    status ?? null,
  );
  return rows.map(toFeedItem);
}

export async function previewSource(
  c: AppContext,
  channelId: string,
  sourceId: string,
): Promise<FeedPreview> {
  const db = env(c).DB;
  const row = await requireSource(db, channelId, sourceId);
  const preview = await previewFeedDispatch(feedDeps(c), row, Date.now());
  if (!preview) {
    throw new ApiError('conflict', 'Nothing to preview yet. Check the feed first.');
  }
  return preview;
}
