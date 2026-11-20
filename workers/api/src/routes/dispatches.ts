// Dispatches: drafts, revisions, the pre-send checklist, test sends, scheduling and sending.
// Content is the editor document; html and text are always rendered here, never by the client.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, roleAtLeast, run } from '@swarm/db';
import {
  ArchiveDispatchesSchema,
  ArchiveResultSchema,
  CreateDispatchSchema,
  DispatchRevisionDetailSchema,
  DispatchRevisionSchema,
  DispatchCountsSchema,
  DispatchListItemSchema,
  DispatchListStatusSchema,
  DispatchSchema,
  DispatchStartedBySchema,
  DispatchSummarySchema,
  EMPTY_DOCUMENT,
  NameRevisionSchema,
  PreflightSchema,
  SavedDispatchSchema,
  ScheduleDispatchSchema,
  SendDispatchSchema,
  SetPlannedDateSchema,
  TestSendSchema,
  UpdateDispatchSchema,
  idPattern,
  newId,
  type CoverImageRef,
  type Dispatch,
  type DispatchAudience,
  type EditorDecisionsUndone,
  type DispatchCounts,
  type DispatchListItem,
  type DispatchListStatus,
  type DispatchStartedBy,
  type UpdateDispatch,
  type WebVisibility,
} from '@swarm/domain';
import {
  AudienceError,
  PAST_ISSUE_NOT_SENT,
  SlugError,
  StartError,
  bumpCacheVersion,
  changeSlug,
  channelSiteOrigin,
  coverOf,
  dispatchWebUrl,
  isReservedSlug,
  loadAudienceRules,
  loadCoverMedia,
  parseAudience,
  preflight,
  previewHtml,
  publishToWeb,
  recordPlatformEvent,
  reindexDispatch,
  renderForWorkspace,
  smartBlockVisibility,
  splitsByEntitlement,
  startBroadcast,
  unpublishFromWeb,
  webUrlFor,
  type DispatchRow,
  teammateEmailSql,
  teammateNameSql,
} from '@swarm/engine';
import { RenderError, mayUseSnippets, personalize, type EmailVariant } from '@swarm/mail';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { actorAudit, sessionActor, type Actor } from '../lib/actor';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { mailer } from '../lib/mail';
import { containsPattern } from '../lib/members';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { checkRosterAudience } from '../lib/rosters';
import { SEND_TOTALS_SQL, sendRates, type SendTotals } from '../lib/sendRates';
import { flagEnabled, requireFlag } from '../lib/site';
import {
  checkCoverImage,
  checkBlockVisibility,
  checkSmartBlocks,
  checkSnippets,
  editorDecisionsUndone,
  engine,
  rawHtmlAllowed,
  requireOwned,
  sendFeatures,
  sendQueue,
  toDispatchSummary,
  undoEditorDecisions,
} from '../lib/send';

/** The workspace of the post `d` and of the revision `r`, for teammateEmailSql. */
const CHANNEL_WORKSPACE = '(SELECT c.workspace_id FROM channels c WHERE c.id = d.channel_id)';
const REVISION_WORKSPACE = `(SELECT c.workspace_id FROM dispatches dd JOIN channels c ON c.id = dd.channel_id
    WHERE dd.id = r.dispatch_id)`;

export const dispatches = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const dispatchParam = idParam('dispatchId', idPattern('dispatch'));
const revisionParams = dispatchParam.extend({
  revisionId: z
    .string()
    .regex(idPattern('dispatchRevision'))
    .openapi({ param: { name: 'revisionId', in: 'path' } }),
});

/** Autosaves by the same operator within this window update one revision instead of adding one. */
const COALESCE_MS = 30_000;
const MAX_CONTENT_BYTES = 512 * 1024;
const EDITABLE = new Set(['draft', 'scheduled']);
const ARCHIVE_OFF = 'The post archive is off for this publication.';
const CALENDAR_OFF = 'The content calendar is off for this publication.';
const BEST_TIME_OFF = 'Sending at each reader’s best time is off for this publication.';
/** A month grid shows six weeks at most; the limit includes the day added at each end. */
const CALENDAR_MAX_DAYS = 62;

const LATEST_BROADCAST = `(SELECT b.id FROM broadcasts b WHERE b.dispatch_id = d.id ORDER BY b.created_at DESC LIMIT 1) AS latest_broadcast_id`;
const CURRENT_SLUG = `(SELECT s.slug FROM dispatch_slugs s WHERE s.dispatch_id = d.id AND s.is_current = 1) AS slug`;

type LoadedDispatch = DispatchRow & {
  seo_title?: string | null;
  seo_description?: string | null;
  latest_broadcast_id: string | null;
  slug: string | null;
  kind: 'broadcast' | 'flow';
};

async function loadDispatch(db: D1Database, id: string): Promise<LoadedDispatch> {
  const row = await first<LoadedDispatch>(
    db,
    `SELECT d.*, ${LATEST_BROADCAST}, ${CURRENT_SLUG} FROM dispatches d WHERE d.id = ?1`,
    id,
  );
  if (!row) throw new ApiError('not_found', 'Post not found.');
  return row;
}

interface ChannelInfo {
  workspace_id: string;
  name: string;
  branding_json: string;
}

/** How the email links to the web: paid Dispatches stop at the gate and link to their page. */
interface WebOptions {
  visibility: WebVisibility;
  url: string | null;
}

/** The web options for rendering a Dispatch's email; the address is looked up only when paid. */
async function webOptions(
  c: AppContext,
  dispatch: Pick<DispatchRow, 'id' | 'channel_id' | 'subject'>,
  visibility: WebVisibility,
): Promise<WebOptions> {
  return {
    visibility,
    url: visibility === 'paid' ? await webUrlFor(env(c).DB, engine(c), dispatch) : null,
  };
}

/** What the email is rendered from; the cover image always travels with the document. */
interface RenderBody {
  preheader: string;
  content: unknown;
  cover: CoverImageRef | null;
}

async function render(
  c: AppContext,
  channelId: string,
  allowHtmlBlocks: boolean,
  body: RenderBody,
  web?: WebOptions,
  paidVariant?: EmailVariant,
) {
  const e = env(c);
  const channel = (await first<ChannelInfo>(
    e.DB,
    'SELECT workspace_id, name, branding_json FROM channels WHERE id = ?1',
    channelId,
  )) as ChannelInfo;
  const branding = JSON.parse(channel.branding_json) as { accentColor?: string | null };
  try {
    return await renderForWorkspace({
      db: e.DB,
      workspaceId: channel.workspace_id,
      channelId,
      channelName: channel.name,
      accentColor: branding.accentColor ?? null,
      ...body,
      mediaOrigin: engine(c).mediaOrigin,
      allowHtmlBlocks,
      ...(web ? { webVisibility: web.visibility, webUrl: web.url } : {}),
      ...(paidVariant ? { paidVariant } : {}),
    });
  } catch (error) {
    if (error instanceof RenderError) {
      throw new ApiError('invalid_input', error.message, [
        { path: 'content', message: error.message },
      ]);
    }
    throw error;
  }
}

/** The stored audience, without anything the engine keeps alongside it. */
function audienceOf(json: string | undefined): DispatchAudience {
  const { include, exclude, rosters } = parseAudience(json);
  return { include, exclude, ...(rosters ? { rosters } : {}) };
}

/** The API shape of a Dispatch's cover image; `url` is null once its media item is gone. */
async function coverImageOut(
  c: AppContext,
  row: Pick<LoadedDispatch, 'channel_id' | 'cover_media_id' | 'cover_alt'>,
): Promise<Dispatch['coverImage']> {
  const cover = coverOf(row);
  if (!cover) return null;
  const e = env(c);
  const channel = await first<{ workspace_id: string }>(
    e.DB,
    'SELECT workspace_id FROM channels WHERE id = ?1',
    row.channel_id,
  );
  const media = channel ? await loadCoverMedia(e.DB, channel.workspace_id, cover.mediaId) : null;
  return {
    ...cover,
    url: media ? `${engine(c).mediaOrigin}/media/${media.r2_key}` : null,
    width: media?.width ?? null,
    height: media?.height ?? null,
  };
}

async function toDispatch(
  c: AppContext,
  row: LoadedDispatch,
  allowHtml: boolean,
): Promise<Dispatch> {
  const content = JSON.parse(row.content_json) as Dispatch['content'];
  const site = engine(c).site;
  const webUrl =
    row.slug && site
      ? dispatchWebUrl((await channelSiteOrigin(env(c).DB, site, row.channel_id)).origin, row.slug)
      : null;
  const coverImage = await coverImageOut(c, row);
  let warnings: string[] = [];
  let html = row.html;
  try {
    const template = await render(
      c,
      row.channel_id,
      allowHtml,
      { preheader: row.preheader, content, cover: coverOf(row) },
      { visibility: row.web_visibility, url: webUrl },
    );
    warnings = template.warnings;
    // The stored preview predates the deletion, or the latest edit of a snippet: show what the send
    // would do. A sent post keeps what it went out with.
    if (
      EDITABLE.has(row.status) &&
      ((coverImage && !coverImage.url) || mayUseSnippets(row.content_json))
    ) {
      html = previewHtml(template);
    }
  } catch (error) {
    // A stored document that no longer renders (say, the flag was turned off) shows why.
    if (!(error instanceof ApiError)) throw error;
    warnings = [error.message];
  }
  return {
    ...toDispatchSummary(row),
    content,
    coverImage,
    html,
    warnings,
    htmlBlocksAllowed: allowHtml,
    audience: audienceOf(row.audience_json),
    unopenedOf: parseAudience(row.audience_json).unopenedOf ?? null,
    seoTitle: row.seo_title ?? '',
    seoDescription: row.seo_description ?? '',
    internalNote: row.internal_note ?? '',
    sectionId: row.section_id,
    slug: row.slug,
    onSite: row.web_published_at !== null && row.web_visibility !== 'hidden',
    webUrl,
  };
}

async function addRevision(
  db: D1Database,
  row: Pick<
    DispatchRow,
    'id' | 'subject' | 'preheader' | 'content_json' | 'cover_media_id' | 'cover_alt'
  >,
  /** null for API callers: their saves never coalesce. */
  operatorId: string | null,
  options: { name?: string; coalesce: boolean },
): Promise<string> {
  const now = Date.now();
  if (options.coalesce && operatorId) {
    const updated = await first<{ id: string }>(
      db,
      `UPDATE dispatch_revisions SET subject = ?1, preheader = ?2, content_json = ?3, updated_at = ?4,
              cover_media_id = ?8, cover_alt = ?9
        WHERE id = (SELECT id FROM dispatch_revisions WHERE dispatch_id = ?5 ORDER BY created_at DESC LIMIT 1)
          AND created_by = ?6 AND name IS NULL AND created_at > ?7
       RETURNING id`,
      row.subject,
      row.preheader,
      row.content_json,
      now,
      row.id,
      operatorId,
      now - COALESCE_MS,
      row.cover_media_id ?? null,
      row.cover_alt ?? '',
    );
    if (updated) return updated.id;
  }
  const id = newId('dispatchRevision', now);
  await run(
    db,
    `INSERT INTO dispatch_revisions (id, dispatch_id, subject, preheader, content_json, name, created_by, created_at, updated_at,
       cover_media_id, cover_alt)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10)`,
    id,
    row.id,
    row.subject,
    row.preheader,
    row.content_json,
    options.name ?? null,
    operatorId,
    now,
    row.cover_media_id ?? null,
    row.cover_alt ?? '',
  );
  return id;
}

function contentJson(content: unknown): string {
  const json = JSON.stringify(content);
  if (new TextEncoder().encode(json).length > MAX_CONTENT_BYTES) {
    throw new ApiError(
      'invalid_input',
      'The post is too large. Split it or move images to the media library.',
    );
  }
  return json;
}

const slugTaken = () =>
  new ApiError('conflict', 'Another post of this publication uses that address.', [
    { path: 'slug', message: 'Another post of this publication uses that address.' },
  ]);

const slugReserved = () =>
  new ApiError('invalid_input', 'That address is reserved by the site.', [
    { path: 'slug', message: 'That address is reserved by the site.' },
  ]);

function startFailure(error: StartError): ApiError {
  return new ApiError(
    'conflict',
    error.message,
    error.checks.map((check) => ({ path: check.key, message: check.message })),
  );
}

/** A Dispatch of kind 'flow' belongs to a Flow: edited here, sent and published only by it. */
function refuseFlowEmail(row: Pick<LoadedDispatch, 'kind'>, action: string): void {
  if (row.kind === 'flow') {
    throw new ApiError(
      'conflict',
      `This is an automation email: its automation sends it, so it can't be ${action}.`,
    );
  }
}

/**
 * Inserts a draft Dispatch with its first revision and audits it. Shared with Flow emails
 * (kind 'flow', owned by `flowId`, hidden from the site) and the Template Library. With
 * `lenient`, content that doesn't render yet (a raw HTML block without raw_html_mode) is stored
 * with an empty preview; the checklist refuses to send it until it renders. The public API
 * passes a null operator and `via` (its key or token, recorded in the audit entry).
 */
export async function createDispatchRow(
  c: AppContext,
  access: {
    workspaceId: string;
    channelId: string;
    auth: { operatorId: string | null };
    via?: Actor['via'];
  },
  input: {
    subject?: string | undefined;
    preheader?: string | undefined;
    content?: unknown;
    coverImage?: CoverImageRef | null | undefined;
    allowHtml: boolean;
    kind?: 'broadcast' | 'flow';
    flowId?: string | null;
    lenient?: boolean;
    auditMetadata?: Record<string, unknown>;
    /** Who started it, for the dispatches list; unset = a teammate in the dashboard. */
    createdVia?: 'agent' | 'copilot' | 'api';
  },
): Promise<string> {
  const content = input.content ?? EMPTY_DOCUMENT;
  await checkSmartBlocks(c, access, content);
  await checkSnippets(c, access, content);
  await checkBlockVisibility(c, access, content);
  const cover = input.coverImage ?? null;
  // A template's cover was checked when it was saved; its image may have gone since.
  if (cover && !input.lenient) await checkCoverImage(c, access.workspaceId, cover.mediaId);
  const preheader = input.preheader ?? '';
  let preview = { html: '', text: '' };
  try {
    const template = await render(c, access.channelId, input.allowHtml, {
      preheader,
      content,
      cover,
    });
    preview = { html: previewHtml(template), text: template.text };
  } catch (error) {
    if (!(input.lenient && error instanceof ApiError && error.code === 'invalid_input'))
      throw error;
  }
  const e = env(c);
  const now = Date.now();
  const id = newId('dispatch', now);
  const kind = input.kind ?? 'broadcast';
  const row = {
    id,
    subject: input.subject ?? '',
    preheader,
    content_json: contentJson(content),
    cover_media_id: cover?.mediaId ?? null,
    cover_alt: cover?.alt ?? '',
  };
  await run(
    e.DB,
    `INSERT INTO dispatches (id, channel_id, subject, preheader, content_json, html, text, created_by, updated_by,
       created_at, updated_at, kind, flow_id, web_visibility, cover_media_id, cover_alt, created_via)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    id,
    access.channelId,
    row.subject,
    row.preheader,
    row.content_json,
    preview.html,
    preview.text,
    access.auth.operatorId,
    now,
    kind,
    input.flowId ?? null,
    // Flow emails never appear on the site.
    kind === 'flow' ? 'hidden' : 'public',
    row.cover_media_id,
    row.cover_alt,
    input.createdVia ?? null,
  );
  await addRevision(e.DB, row, access.auth.operatorId, { coalesce: false });
  await appendAudit(e.DB, {
    workspaceId: access.workspaceId,
    actorId: access.auth.operatorId,
    action: 'dispatch.created',
    targetType: 'dispatch',
    targetId: id,
    ...(input.auditMetadata || kind === 'flow' || access.via
      ? {
          metadata: {
            ...input.auditMetadata,
            ...(kind === 'flow' ? { flowId: input.flowId } : {}),
            ...(access.via ? { via: access.via } : {}),
          },
        }
      : {}),
    ipPrefix: ipPrefix(clientIp(c)),
  });
  return id;
}

/**
 * A draft copy of a sent Broadcast's Dispatch, for the people it reached who neither opened nor
 * clicked it. Asking again gives the same draft, so a double click can't make two sends. It stays
 * off the website, where the original already is.
 */
export async function createUnopenedDraft(
  c: AppContext,
  access: {
    workspaceId: string;
    channelId: string;
    auth: { operatorId: string | null };
    via?: Actor['via'];
  },
  broadcastId: string,
  createdVia?: 'agent' | 'copilot' | 'api',
): Promise<string> {
  const e = env(c);
  const broadcast = await first<{ dispatch_id: string; status: string; kind: string }>(
    e.DB,
    'SELECT dispatch_id, status, kind FROM broadcasts WHERE id = ?1 AND channel_id = ?2',
    broadcastId,
    access.channelId,
  );
  if (!broadcast) throw new ApiError('not_found', 'Send not found.');
  if (broadcast.kind !== 'broadcast' || !['sent', 'partially_failed'].includes(broadcast.status)) {
    throw new ApiError('conflict', 'Only a finished send can be sent again.');
  }
  const existing = await first<{ id: string }>(
    e.DB,
    `SELECT id FROM dispatches
      WHERE channel_id = ?1 AND json_extract(audience_json, '$.unopenedOf') = ?2 AND status <> 'canceled'`,
    access.channelId,
    broadcastId,
  );
  if (existing) return existing.id;

  const source = await loadDispatch(e.DB, broadcast.dispatch_id);
  // A Gate's teaser depends on the post staying 'paid', and that would also publish it again.
  // Hiding this copy would email the whole post to people the Gate keeps out.
  if (splitsByEntitlement(source)) {
    throw new ApiError('conflict', 'A post with a paywall can’t be sent again yet.');
  }
  const id = await createDispatchRow(c, access, {
    subject: source.subject,
    preheader: source.preheader,
    content: JSON.parse(source.content_json) as unknown,
    coverImage: coverOf(source),
    allowHtml: await rawHtmlAllowed(c, {
      workspaceId: access.workspaceId,
      channelId: access.channelId,
    }),
    auditMetadata: { unopenedOf: broadcastId },
    ...(createdVia ? { createdVia } : {}),
  });
  await run(
    e.DB,
    `UPDATE dispatches SET audience_json = ?1, sender_identity_id = ?2, web_visibility = 'hidden' WHERE id = ?3`,
    JSON.stringify({ ...audienceOf(source.audience_json), unopenedOf: broadcastId }),
    source.sender_identity_id,
    id,
  );
  return id;
}

/** The summary query of a Channel's Dispatches (the dashboard list and /v2 pages). */
export const DISPATCH_SUMMARY_COLUMNS = `d.id, d.channel_id, d.subject, d.preheader, d.status, d.sender_identity_id, d.publish_at, d.sent_at,
  d.created_at, d.updated_at, d.web_visibility, d.web_published_at, d.section_id, d.created_via, d.from_feed,
  d.archived_at, d.planned_date, d.imported_at, ${LATEST_BROADCAST}`;

/** The API shape of a Dispatch, read fresh. */
export async function dispatchOut(
  c: AppContext,
  id: string,
  allowHtml: boolean,
): Promise<Dispatch> {
  return toDispatch(c, await loadDispatch(env(c).DB, id), allowHtml);
}

/** The posts list's search and Started by filter, shared by the list and its counts. */
const ListFilterSchema = z.object({
  q: z.string().trim().max(100).optional().openapi({
    description: 'Only posts whose subject contains this, ignoring case',
  }),
  startedBy: DispatchStartedBySchema.optional(),
});
type ListFilter = z.infer<typeof ListFilterSchema>;

/** SQL conditions on `d` for the status chips; a past issue counts as sent, never as a draft. */
const STATUS_SQL: Record<DispatchListStatus, string> = {
  draft: `d.status = 'draft' AND d.imported_at IS NULL`,
  scheduled: `d.status = 'scheduled'`,
  sent: `(d.status IN ('sending', 'sent', 'canceled') OR d.imported_at IS NOT NULL)`,
};

const STARTED_BY_SQL: Record<DispatchStartedBy, string> = {
  people: 'd.from_feed = 0 AND d.created_via IS NULL',
  agents: 'd.from_feed = 0 AND d.created_via IS NOT NULL',
};

/** The WHERE conditions after the Channel's own (?1), with their values bound from ?2 on. */
function listConditions(filter: ListFilter): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (filter.q) {
    params.push(containsPattern(filter.q));
    parts.push(`d.subject LIKE ?${params.length + 1} ESCAPE '!'`);
  }
  if (filter.startedBy) parts.push(STARTED_BY_SQL[filter.startedBy]);
  return { sql: parts.map((part) => `AND ${part}`).join(' '), params };
}

type ListRow = DispatchRow & {
  latest_broadcast_id: string | null;
  created_by: string | null;
  author_name: string | null;
  author_email: string | null;
  t_sent?: number | null;
  t_delivered?: number | null;
  t_bounced?: number | null;
  t_human_opened?: number | null;
  t_human_clicked?: number | null;
};

/** The latest send's totals from a list row, in the shape sendRates reads. */
const totalsOf = (row: ListRow): SendTotals => ({
  sent: row.t_sent ?? 0,
  delivered: row.t_delivered ?? 0,
  bounced: row.t_bounced ?? 0,
  human_opened: row.t_human_opened ?? 0,
  human_clicked: row.t_human_clicked ?? 0,
});

dispatches.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/dispatches',
    tags: ['Dispatches'],
    summary: 'Dispatches in a Channel, most recently changed first',
    description:
      'At most 200. Archived ones are included unless `archived` says otherwise. `exclude` leaves them out while the post_archive flag is on, and `only` needs the flag. `q`, `status` and `startedBy` narrow the list. With `stats=latest`, each post also carries how its latest send did, counting people only: machine opens and clicks from privacy proxies and link scanners are left out, as on the send report.',
    request: {
      params: channelParam,
      query: ListFilterSchema.extend({
        archived: z.enum(['exclude', 'only']).optional(),
        status: DispatchListStatusSchema.optional(),
        stats: z.enum(['latest']).optional(),
      }),
    },
    responses: {
      200: ok(z.array(DispatchListItemSchema), 'Dispatches'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { archived, status, stats, ...filter } = c.req.valid('query');
    const access = await requireChannel(c, channelId, 'viewer');
    // With the flag off nothing can be restored, so a post archived earlier shows again.
    const archiveOn = archived ? await flagEnabled(c, access, 'post_archive') : false;
    if (archived === 'only' && !archiveOn) {
      throw new ApiError('feature_disabled', ARCHIVE_OFF);
    }
    const shelf = !archiveOn
      ? ''
      : archived === 'only'
        ? 'AND d.archived_at IS NOT NULL'
        : 'AND d.archived_at IS NULL';
    const where = listConditions(filter);
    const page = `SELECT ${DISPATCH_SUMMARY_COLUMNS}, d.created_by,
           ${teammateNameSql('o', CHANNEL_WORKSPACE)} AS author_name,
           ${teammateEmailSql('o', CHANNEL_WORKSPACE)} AS author_email
         FROM dispatches d LEFT JOIN operators o ON o.id = d.created_by
        WHERE d.channel_id = ?1 AND d.kind = 'broadcast' ${shelf} ${where.sql}
          ${status ? `AND ${STATUS_SQL[status]}` : ''}
        ORDER BY d.updated_at DESC LIMIT 200`;
    // Still one read with stats: the page, then the human totals of each post's latest send,
    // grouped in one pass over that send's deliveries.
    const sql = stats
      ? `WITH page AS (${page})
         SELECT page.*, t.sent AS t_sent, t.delivered AS t_delivered, t.bounced AS t_bounced,
                t.human_opened AS t_human_opened, t.human_clicked AS t_human_clicked
           FROM page LEFT JOIN (
             SELECT broadcast_id, ${SEND_TOTALS_SQL} FROM deliveries
              WHERE broadcast_id IN (SELECT latest_broadcast_id FROM page)
              GROUP BY broadcast_id
           ) t ON t.broadcast_id = page.latest_broadcast_id
          ORDER BY page.updated_at DESC`
      : page;
    const rows = await all<ListRow>(env(c).DB, sql, channelId, ...where.params);
    const data: DispatchListItem[] = rows.map((row) => {
      const item: DispatchListItem = {
        ...toDispatchSummary(row),
        author:
          row.created_by && row.author_email !== null
            ? { id: row.created_by, name: row.author_name, email: row.author_email }
            : null,
      };
      if (stats) {
        item.latestSend = row.latest_broadcast_id
          ? { broadcastId: row.latest_broadcast_id, ...sendRates(totalsOf(row)) }
          : null;
      }
      return item;
    });
    return c.json({ data }, 200);
  },
);

dispatches.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/dispatches/counts',
    tags: ['Dispatches'],
    summary: 'How many posts each filter of the posts list holds',
    description:
      'The counts behind the list’s status chips, narrowed by the same `q` and `startedBy`. While the post_archive flag is on, archived posts count only under `archived`.',
    request: { params: channelParam, query: ListFilterSchema },
    responses: {
      200: ok(DispatchCountsSchema, 'Counts'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const filter = c.req.valid('query');
    const access = await requireChannel(c, channelId, 'viewer');
    const archiveOn = await flagEnabled(c, access, 'post_archive');
    const shown = archiveOn ? 'd.archived_at IS NULL' : '1';
    const where = listConditions(filter);
    const row = await first<{
      shown: number;
      draft: number;
      scheduled: number;
      sent: number;
      archived: number;
    }>(
      env(c).DB,
      `SELECT coalesce(sum(${shown}), 0) AS shown,
              coalesce(sum(${shown} AND ${STATUS_SQL.draft}), 0) AS draft,
              coalesce(sum(${shown} AND ${STATUS_SQL.scheduled}), 0) AS scheduled,
              coalesce(sum(${shown} AND ${STATUS_SQL.sent}), 0) AS sent,
              coalesce(sum(d.archived_at IS NOT NULL), 0) AS archived
         FROM dispatches d WHERE d.channel_id = ?1 AND d.kind = 'broadcast' ${where.sql}`,
      channelId,
      ...where.params,
    );
    const data: DispatchCounts = {
      all: row?.shown ?? 0,
      draft: row?.draft ?? 0,
      scheduled: row?.scheduled ?? 0,
      sent: row?.sent ?? 0,
      archived: archiveOn ? (row?.archived ?? 0) : null,
    };
    return c.json({ data }, 200);
  },
);

dispatches.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/dispatches/calendar',
    tags: ['Dispatches'],
    summary: 'The posts on a range of days',
    description:
      'Scheduled and sent posts by when they send, drafts by their planned date, and past issues by their date on the website. The range is the days a calendar shows, so times are widened by a day each way for the reader to place in their own time zone. Needs the content_calendar flag.',
    request: {
      params: channelParam,
      query: z.object({ from: z.iso.date(), to: z.iso.date() }),
    },
    responses: {
      200: ok(z.array(DispatchSummarySchema), 'Posts'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { from, to } = c.req.valid('query');
    const access = await requireChannel(c, channelId, 'viewer');
    await requireFlag(c, access, 'content_calendar', CALENDAR_OFF);
    const start = Date.parse(`${from}T00:00:00.000Z`) - 86_400_000;
    const end = Date.parse(`${to}T00:00:00.000Z`) + 2 * 86_400_000;
    if (end <= start || end - start > CALENDAR_MAX_DAYS * 86_400_000) {
      throw new ApiError('invalid_input', 'Ask for up to two months at a time.');
    }
    const hideArchived = await flagEnabled(c, access, 'post_archive');
    const rows = await all<DispatchRow & { latest_broadcast_id: string | null }>(
      env(c).DB,
      `SELECT ${DISPATCH_SUMMARY_COLUMNS} FROM dispatches d
        WHERE d.channel_id = ?1 AND d.kind = 'broadcast' ${hideArchived ? 'AND d.archived_at IS NULL' : ''}
          AND ((d.status = 'scheduled' AND d.publish_at BETWEEN ?2 AND ?3)
            OR (d.status IN ('sending', 'sent') AND coalesce(d.sent_at, d.updated_at) BETWEEN ?2 AND ?3)
            OR (d.status = 'draft' AND d.imported_at IS NULL AND d.planned_date BETWEEN ?4 AND ?5)
            OR (d.status = 'draft' AND d.imported_at IS NOT NULL AND d.web_published_at BETWEEN ?2 AND ?3))
        LIMIT 500`,
      channelId,
      start,
      end,
      from,
      to,
    );
    return c.json({ data: rows.map(toDispatchSummary) }, 200);
  },
);

/** What a post's status says about why it can't be archived. */
function archiveRefusal(status: DispatchRow['status']): string {
  if (status === 'scheduled') return 'It’s scheduled to send. Unschedule it first.';
  if (status === 'draft') return 'It hasn’t been sent. You can delete a draft instead.';
  return 'It’s being sent. Try again when the send finishes.';
}

for (const action of ['archive', 'restore'] as const) {
  dispatches.openapi(
    createRoute({
      method: 'post',
      path: `/api/v1/channels/{channelId}/dispatches/${action}`,
      tags: ['Dispatches'],
      summary: action === 'archive' ? 'Archive posts' : 'Restore archived posts',
      description:
        'Moves posts in or out of the archive, which only tidies the dashboard’s list: stats, what was sent and the website stay as they are. Sent and canceled posts and past issues can be archived; a draft, or a post scheduled or being sent, can’t. Needs the post_archive flag.',
      request: { params: channelParam, body: jsonBody(ArchiveDispatchesSchema) },
      responses: {
        200: ok(ArchiveResultSchema, 'What changed, and why anything didn’t'),
        ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
      },
    }),
    async (c) => {
      const { channelId } = c.req.valid('param');
      const { dispatchIds } = c.req.valid('json');
      const access = await requireChannel(c, channelId, 'editor');
      await requireFlag(c, access, 'post_archive', ARCHIVE_OFF);
      const e = env(c);
      const ids = JSON.stringify(dispatchIds);
      // updated_at stays: filing a post away isn't an edit, and it keeps its place in the list.
      const changed =
        action === 'archive'
          ? await all<{ id: string }>(
              e.DB,
              `UPDATE dispatches SET archived_at = ?3
                WHERE channel_id = ?1 AND kind = 'broadcast' AND archived_at IS NULL
                  AND id IN (SELECT value FROM json_each(?2))
                  AND (status IN ('sent', 'canceled') OR (status = 'draft' AND imported_at IS NOT NULL))
                  AND NOT EXISTS (SELECT 1 FROM broadcasts b
                                   WHERE b.dispatch_id = dispatches.id AND b.status IN ('queued', 'sending'))
                RETURNING id`,
              channelId,
              ids,
              Date.now(),
            )
          : await all<{ id: string }>(
              e.DB,
              `UPDATE dispatches SET archived_at = NULL
                WHERE channel_id = ?1 AND kind = 'broadcast' AND archived_at IS NOT NULL
                  AND id IN (SELECT value FROM json_each(?2))
                RETURNING id`,
              channelId,
              ids,
            );
      const done = new Set(changed.map((row) => row.id));
      const rest = dispatchIds.filter((id) => !done.has(id));
      const known = rest.length
        ? await all<{ id: string; status: DispatchRow['status']; archived_at: number | null }>(
            e.DB,
            `SELECT id, status, archived_at FROM dispatches
              WHERE channel_id = ?1 AND kind = 'broadcast' AND id IN (SELECT value FROM json_each(?2))`,
            channelId,
            JSON.stringify(rest),
          )
        : [];
      const found = new Map(known.map((row) => [row.id, row]));
      // A post already where it was asked to go counts as done, so a repeated click is harmless.
      const refused = rest.flatMap((id) => {
        const row = found.get(id);
        if (!row) return [{ id, message: 'Post not found.' }];
        if (action === 'restore' || row.archived_at !== null) return [];
        return [{ id, message: archiveRefusal(row.status) }];
      });
      if (done.size > 0) {
        await appendAudit(e.DB, {
          workspaceId: access.workspaceId,
          actorId: access.auth.operatorId,
          action: action === 'archive' ? 'dispatch.archived' : 'dispatch.restored',
          targetType: 'channel',
          targetId: channelId,
          metadata: { dispatchIds: [...done] },
          ipPrefix: ipPrefix(clientIp(c)),
        });
      }
      return c.json({ data: { changed: [...done], refused } }, 200);
    },
  );
}

dispatches.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/dispatches/{dispatchId}/planned-date',
    tags: ['Dispatches'],
    summary: 'Set or clear a draft’s planned date',
    description:
      'The day a writer aims to send it, shown on the content calendar. It schedules nothing and has no effect on sending; use the schedule route for that. Needs the content_calendar flag.',
    request: { params: dispatchParam, body: jsonBody(SetPlannedDateSchema) },
    responses: {
      200: ok(DispatchSummarySchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const { plannedDate } = c.req.valid('json');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'author');
    await requireFlag(c, access, 'content_calendar', CALENDAR_OFF);
    const e = env(c);
    // updated_at stays: moving a plan isn't an edit of the post.
    const row = await first<{ id: string }>(
      e.DB,
      `UPDATE dispatches SET planned_date = ?1
        WHERE id = ?2 AND kind = 'broadcast' AND status = 'draft' AND imported_at IS NULL RETURNING id`,
      plannedDate,
      dispatchId,
    );
    if (!row) throw new ApiError('conflict', 'Only a draft can have a planned date.');
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'dispatch.planned_date_changed',
      targetType: 'dispatch',
      targetId: dispatchId,
      metadata: { plannedDate },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: toDispatchSummary(await loadDispatch(e.DB, dispatchId)) }, 200);
  },
);

dispatches.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/dispatches',
    tags: ['Dispatches'],
    summary: 'Start a Dispatch',
    request: { params: channelParam, body: jsonBody(CreateDispatchSchema) },
    responses: {
      201: ok(DispatchSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'author');
    const allowHtml = await rawHtmlAllowed(c, access);
    const id = await createDispatchRow(c, access, { ...input, allowHtml });
    const e = env(c);
    return c.json({ data: await toDispatch(c, await loadDispatch(e.DB, id), allowHtml) }, 201);
  },
);

dispatches.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/dispatches/{dispatchId}',
    tags: ['Dispatches'],
    summary: 'One Dispatch with its document, render and lint warnings',
    request: { params: dispatchParam },
    responses: { 200: ok(DispatchSchema, 'Dispatch'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'viewer');
    const row = await loadDispatch(env(c).DB, dispatchId);
    return c.json({ data: await toDispatch(c, row, await rawHtmlAllowed(c, access)) }, 200);
  },
);

dispatches.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/dispatches/{dispatchId}',
    tags: ['Dispatches'],
    summary: 'Save a Dispatch',
    description:
      'Every save is a revision. Saves by the same operator within 30 seconds update one revision, so autosave does not flood the history. Content, subject, sender and audience change only before sending (author role). Scheduling and publishing on the website are editor decisions: when an author changes the content, subject, sender or audience of a scheduled Dispatch, it goes back to draft (unscheduled: true), and when an author changes the text of a post on the website, it comes off the site (takenOffSite: true), until an editor schedules or publishes it again. The web fields (webVisibility, sectionId, slug) can change at any time and need the editor role; a new slug keeps the old one redirecting.',
    request: { params: dispatchParam, body: jsonBody(UpdateDispatchSchema) },
    responses: {
      200: ok(SavedDispatchSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'author');
    const undone = await updateDispatch(c, sessionActor(c, access), dispatchId, input);
    const saved = await dispatchOut(c, dispatchId, await rawHtmlAllowed(c, access));
    return c.json({ data: { ...saved, ...undone } }, 200);
  },
);

/**
 * Saves a Dispatch (shared with /v2). Every save is a revision; saves by the same teammate
 * within 30 seconds update one revision. Content, subject, sender and audience change only
 * before sending; the web fields can change at any time and need the editor role. Below editor,
 * such a change takes a scheduled Dispatch back to draft and a post off the site, in the same
 * write (undoEditorDecisions); the result says which.
 */
export async function updateDispatch(
  c: AppContext,
  actor: Actor,
  dispatchId: string,
  input: UpdateDispatch,
): Promise<EditorDecisionsUndone> {
  const e = env(c);
  const contentChange = (
    ['subject', 'preheader', 'content', 'coverImage', 'senderIdentityId', 'audience'] as const
  ).some((key) => input[key] !== undefined);
  // The sender and the audience are not on the page.
  const pageChange = (['subject', 'preheader', 'content', 'coverImage'] as const).some(
    (key) => input[key] !== undefined,
  );
  let undone: EditorDecisionsUndone = {};
  const webChange =
    input.webVisibility !== undefined || input.sectionId !== undefined || input.slug !== undefined;
  if (webChange && !roleAtLeast(actor.role, 'editor')) {
    throw new ApiError(
      'forbidden',
      'Changing how a post appears on the site needs the editor role or higher.',
    );
  }
  const current = await loadDispatch(e.DB, dispatchId);
  const scope = { workspaceId: actor.workspaceId, channelId: current.channel_id };
  if (webChange) refuseFlowEmail(current, 'shown on the site');
  if (contentChange && !EDITABLE.has(current.status)) {
    throw new ApiError('conflict', `A ${current.status} post can't be edited.`);
  }
  if (input.sectionId) {
    const section = await first(
      e.DB,
      'SELECT 1 FROM site_sections WHERE id = ?1 AND channel_id = ?2',
      input.sectionId,
      current.channel_id,
    );
    if (!section) throw new ApiError('not_found', 'Section not found.');
  }
  const slugChange = input.slug !== undefined && input.slug !== current.slug ? input.slug : null;
  if (slugChange !== null) {
    // Checked before anything is saved; changeSlug checks again when it writes.
    if (isReservedSlug(slugChange)) throw slugReserved();
    const taken = await first(
      e.DB,
      'SELECT 1 FROM dispatch_slugs WHERE channel_id = ?1 AND slug = ?2 AND dispatch_id <> ?3',
      current.channel_id,
      slugChange,
      dispatchId,
    );
    if (taken) throw slugTaken();
  }
  const allowHtml = await rawHtmlAllowed(c, scope);
  const visibility = input.webVisibility ?? current.web_visibility;

  if (contentChange) {
    if (input.content) {
      await checkSmartBlocks(c, scope, input.content);
      await checkSnippets(c, scope, input.content);
      await checkBlockVisibility(c, scope, input.content);
    }
    if (input.coverImage && input.coverImage.mediaId !== current.cover_media_id) {
      await checkCoverImage(c, actor.workspaceId, input.coverImage.mediaId);
    }
    if (input.senderIdentityId) {
      const owned = await first(
        e.DB,
        'SELECT 1 FROM sender_identities WHERE id = ?1 AND channel_id = ?2',
        input.senderIdentityId,
        current.channel_id,
      );
      if (!owned)
        throw new ApiError('invalid_input', 'That sender is not set up for this publication.');
    }
    if (input.audience) {
      // Rosters (Phase 8): the flag, and Rosters of this Channel; an empty part is dropped.
      const rosters = await checkRosterAudience(c, scope, input.audience.rosters);
      // A resend stays a resend. The editor only sends Circles and Rosters, and dropping this would
      // turn "people who didn't open" into everyone.
      const { unopenedOf } = parseAudience(current.audience_json);
      input.audience = {
        include: input.audience.include,
        exclude: input.audience.exclude,
        ...(rosters ? { rosters } : {}),
        ...(unopenedOf ? { unopenedOf } : {}),
      };
      // Every Circle must be live and in this Channel. Checked again when the send starts.
      try {
        await loadAudienceRules(e.DB, current.channel_id, input.audience);
      } catch (error) {
        if (!(error instanceof AudienceError)) throw error;
        throw new ApiError('invalid_input', 'Choose segments from this publication.', [
          { path: 'audience', message: 'Choose segments from this publication.' },
        ]);
      }
    }
  }
  // The stored preview follows the visibility too: a paid Dispatch's email stops at the gate.
  const rerender =
    contentChange || (input.webVisibility !== undefined && EDITABLE.has(current.status));
  if (rerender) {
    const content = input.content ?? (JSON.parse(current.content_json) as unknown);
    const preheader = input.preheader ?? current.preheader;
    const cover = input.coverImage === undefined ? coverOf(current) : input.coverImage;
    const template = await render(
      c,
      current.channel_id,
      allowHtml,
      { preheader, content, cover },
      await webOptions(c, { ...current, subject: input.subject ?? current.subject }, visibility),
    );
    // Guarded on status, so a save that races a send can't change what is being sent. Only what this
    // request carries is written: the sidebar saves its settings beside the editor's autosave, so
    // `current` may already be older than the stored text. A preview rendered from that older text
    // is dropped too. A preview can trail for a moment that way, and nothing sends it: a send
    // renders afresh from content_json (packages/engine/src/start.ts).
    type Saved = Pick<
      DispatchRow,
      'id' | 'subject' | 'preheader' | 'content_json' | 'cover_media_id' | 'cover_alt'
    >;
    const results = await e.DB.batch([
      ...undoEditorDecisions(e.DB, dispatchId, actor.role, {
        email: contentChange,
        page: pageChange,
      }),
      e.DB.prepare(
        `UPDATE dispatches SET subject = coalesce(?1, subject), preheader = coalesce(?2, preheader),
              content_json = coalesce(?3, content_json),
              html = CASE WHEN ?13 = 1 OR updated_at = ?14 THEN ?4 ELSE html END,
              text = CASE WHEN ?13 = 1 OR updated_at = ?14 THEN ?5 ELSE text END,
              sender_identity_id = CASE WHEN ?15 = 1 THEN ?6 ELSE sender_identity_id END,
              updated_by = ?7, updated_at = ?8, audience_json = coalesce(?10, audience_json),
              cover_media_id = CASE WHEN ?16 = 1 THEN ?11 ELSE cover_media_id END,
              cover_alt = CASE WHEN ?16 = 1 THEN ?12 ELSE cover_alt END
        WHERE id = ?9 AND status IN ('draft', 'scheduled')
        RETURNING id, subject, preheader, content_json, cover_media_id, cover_alt`,
      ).bind(
        input.subject ?? null,
        input.preheader ?? null,
        input.content ? contentJson(input.content) : null,
        previewHtml(template),
        template.text,
        input.senderIdentityId ?? null,
        actor.operatorId,
        Date.now(),
        dispatchId,
        input.audience ? JSON.stringify(input.audience) : null,
        cover?.mediaId ?? null,
        cover?.alt ?? '',
        input.content ? 1 : 0,
        current.updated_at,
        input.senderIdentityId === undefined ? 0 : 1,
        input.coverImage === undefined ? 0 : 1,
      ),
    ]);
    const saved = results.at(-1)?.results[0] as Saved | undefined;
    if (!saved)
      throw new ApiError('conflict', 'This post is being sent and can no longer be edited.');
    undone = await editorDecisionsUndone(e.DB, actor, dispatchId, results);
    if (contentChange) await addRevision(e.DB, saved, actor.operatorId, { coalesce: true });
  }

  if (webChange) {
    // Web fields can change after sending: they decide only how the site shows the Dispatch.
    await run(
      e.DB,
      `UPDATE dispatches SET web_visibility = coalesce(?1, web_visibility),
              section_id = CASE WHEN ?2 = 1 THEN ?3 ELSE section_id END,
              updated_by = ?4, updated_at = ?5
        WHERE id = ?6`,
      input.webVisibility ?? null,
      input.sectionId === undefined ? 0 : 1,
      input.sectionId ?? null,
      actor.operatorId,
      Date.now(),
      dispatchId,
    );
    if (slugChange !== null) {
      try {
        await changeSlug(e.DB, current, slugChange);
      } catch (error) {
        if (!(error instanceof SlugError)) throw error;
        throw error.code === 'taken' ? slugTaken() : slugReserved();
      }
    }
  }
  if (input.seoTitle !== undefined || input.seoDescription !== undefined) {
    await run(
      e.DB,
      `UPDATE dispatches SET seo_title = coalesce(?1, seo_title),
              seo_description = coalesce(?2, seo_description), updated_by = ?3, updated_at = ?4
        WHERE id = ?5`,
      input.seoTitle ?? null,
      input.seoDescription ?? null,
      actor.operatorId,
      Date.now(),
      dispatchId,
    );
    await reindexDispatch(e.DB, dispatchId);
  }
  if (input.internalNote !== undefined) {
    await run(
      e.DB,
      'UPDATE dispatches SET internal_note = ?1, updated_by = ?2, updated_at = ?3 WHERE id = ?4',
      input.internalNote,
      actor.operatorId,
      Date.now(),
      dispatchId,
    );
  }
  // A Dispatch on the web is re-indexed and the site cache moves on.
  await reindexDispatch(e.DB, dispatchId);
  return undone;
}

dispatches.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/dispatches/{dispatchId}',
    tags: ['Dispatches'],
    summary: 'Delete a Dispatch that was never sent',
    request: { params: dispatchParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found', 'conflict') },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'editor');
    const e = env(c);
    const deleted = await first<{ id: string }>(
      e.DB,
      `DELETE FROM dispatches WHERE id = ?1 AND status IN ('draft', 'scheduled')
         AND NOT EXISTS (SELECT 1 FROM broadcasts WHERE dispatch_id = ?1) RETURNING id`,
      dispatchId,
    );
    if (!deleted)
      throw new ApiError('conflict', 'A post that has been sent is kept for its history.');
    // The search index is kept by the application; a virtual table has no cascade.
    await run(e.DB, 'DELETE FROM dispatch_search WHERE dispatch_id = ?1', dispatchId);
    await bumpCacheVersion(e.DB, access.channelId);
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'dispatch.deleted',
      targetType: 'dispatch',
      targetId: dispatchId,
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.body(null, 204);
  },
);

// ---- Revisions ---------------------------------------------------------------------------

interface RevisionRow {
  id: string;
  name: string | null;
  subject: string;
  preheader: string;
  content_json?: string;
  cover_media_id?: string | null;
  cover_alt?: string;
  created_by: string | null;
  creator_email: string | null;
  created_at: number;
  updated_at: number;
}

const toRevision = (row: RevisionRow) => ({
  id: row.id,
  name: row.name,
  subject: row.subject,
  preheader: row.preheader,
  createdBy:
    row.created_by && row.creator_email ? { id: row.created_by, email: row.creator_email } : null,
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
});

dispatches.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/dispatches/{dispatchId}/revisions',
    tags: ['Dispatches'],
    summary: 'Revision history, newest first',
    request: { params: dispatchParam },
    responses: {
      200: ok(z.array(DispatchRevisionSchema), 'Revisions'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    await requireOwned(c, 'dispatch', dispatchId, 'viewer');
    const rows = await all<RevisionRow>(
      env(c).DB,
      `SELECT r.id, r.name, r.subject, r.preheader, r.created_by, ${teammateEmailSql('o', REVISION_WORKSPACE)} AS creator_email, r.created_at, r.updated_at
         FROM dispatch_revisions r LEFT JOIN operators o ON o.id = r.created_by
        WHERE r.dispatch_id = ?1 ORDER BY r.created_at DESC LIMIT 200`,
      dispatchId,
    );
    return c.json({ data: rows.map(toRevision) }, 200);
  },
);

dispatches.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/dispatches/{dispatchId}/revisions/{revisionId}',
    tags: ['Dispatches'],
    summary: 'One revision with its document',
    request: { params: revisionParams },
    responses: {
      200: ok(DispatchRevisionDetailSchema, 'Revision'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { dispatchId, revisionId } = c.req.valid('param');
    await requireOwned(c, 'dispatch', dispatchId, 'viewer');
    const row = await first<RevisionRow & { content_json: string }>(
      env(c).DB,
      `SELECT r.id, r.name, r.subject, r.preheader, r.content_json, r.cover_media_id, r.cover_alt, r.created_by, ${teammateEmailSql('o', REVISION_WORKSPACE)} AS creator_email, r.created_at, r.updated_at
         FROM dispatch_revisions r LEFT JOIN operators o ON o.id = r.created_by
        WHERE r.id = ?1 AND r.dispatch_id = ?2`,
      revisionId,
      dispatchId,
    );
    if (!row) throw new ApiError('not_found', 'Revision not found.');
    return c.json(
      {
        data: {
          ...toRevision(row),
          content: JSON.parse(row.content_json),
          coverImage: coverOf(row),
        },
      },
      200,
    );
  },
);

dispatches.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/dispatches/{dispatchId}/revisions',
    tags: ['Dispatches'],
    summary: 'Save a named snapshot of the current version',
    request: { params: dispatchParam, body: jsonBody(NameRevisionSchema) },
    responses: {
      201: ok(DispatchRevisionSchema, 'Snapshot saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const { name } = c.req.valid('json');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'author');
    const e = env(c);
    const current = await loadDispatch(e.DB, dispatchId);
    const id = await addRevision(e.DB, current, access.auth.operatorId, { name, coalesce: false });
    const row = await first<RevisionRow>(
      e.DB,
      `SELECT r.id, r.name, r.subject, r.preheader, r.created_by, ${teammateEmailSql('o', REVISION_WORKSPACE)} AS creator_email, r.created_at, r.updated_at
         FROM dispatch_revisions r LEFT JOIN operators o ON o.id = r.created_by WHERE r.id = ?1`,
      id,
    );
    return c.json({ data: toRevision(row as RevisionRow) }, 201);
  },
);

dispatches.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/dispatches/{dispatchId}/revisions/{revisionId}/restore',
    tags: ['Dispatches'],
    summary: 'Restore a revision',
    description:
      'Copies the revision into the Dispatch as a new revision; history is never rewritten. Like a save, an author’s restore takes a scheduled Dispatch back to draft and a post off the website.',
    request: { params: revisionParams },
    responses: {
      200: ok(SavedDispatchSchema, 'Restored'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { dispatchId, revisionId } = c.req.valid('param');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'author');
    const e = env(c);
    const revision = await first<{
      subject: string;
      preheader: string;
      content_json: string;
      cover_media_id: string | null;
      cover_alt: string;
    }>(
      e.DB,
      'SELECT subject, preheader, content_json, cover_media_id, cover_alt FROM dispatch_revisions WHERE id = ?1 AND dispatch_id = ?2',
      revisionId,
      dispatchId,
    );
    if (!revision) throw new ApiError('not_found', 'Revision not found.');
    const restored: unknown = JSON.parse(revision.content_json);
    await checkSmartBlocks(c, access, restored);
    await checkSnippets(c, access, restored);
    await checkBlockVisibility(c, access, restored);
    const allowHtml = await rawHtmlAllowed(c, access);
    const current = await loadDispatch(e.DB, dispatchId);
    const template = await render(
      c,
      current.channel_id,
      allowHtml,
      {
        preheader: revision.preheader,
        content: JSON.parse(revision.content_json),
        cover: coverOf(revision),
      },
      await webOptions(c, { ...current, subject: revision.subject }, current.web_visibility),
    );
    // An author's restore changes what goes out like a save does (see updateDispatch).
    const results = await e.DB.batch([
      ...undoEditorDecisions(e.DB, dispatchId, access.role, { email: true, page: true }),
      e.DB.prepare(
        `UPDATE dispatches SET subject = ?1, preheader = ?2, content_json = ?3, html = ?4, text = ?5, updated_by = ?6, updated_at = ?7,
              cover_media_id = ?9, cover_alt = ?10
        WHERE id = ?8 AND status IN ('draft', 'scheduled') RETURNING id`,
      ).bind(
        revision.subject,
        revision.preheader,
        revision.content_json,
        previewHtml(template),
        template.text,
        access.auth.operatorId,
        Date.now(),
        dispatchId,
        revision.cover_media_id,
        revision.cover_alt,
      ),
    ]);
    if (!results.at(-1)?.results.length)
      throw new ApiError('conflict', 'Only drafts and scheduled posts can be restored.');
    const undone = await editorDecisionsUndone(e.DB, sessionActor(c, access), dispatchId, results);
    await addRevision(e.DB, { id: dispatchId, ...revision }, access.auth.operatorId, {
      coalesce: false,
    });
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'dispatch.revision_restored',
      targetType: 'dispatch',
      targetId: dispatchId,
      metadata: { revisionId },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    await reindexDispatch(e.DB, dispatchId);
    const out = await toDispatch(c, await loadDispatch(e.DB, dispatchId), allowHtml);
    return c.json({ data: { ...out, ...undone } }, 200);
  },
);

// ---- Sending -----------------------------------------------------------------------------

dispatches.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/dispatches/{dispatchId}/preflight',
    tags: ['Dispatches'],
    summary: 'Pre-send checklist and the exact recipient count',
    request: { params: dispatchParam },
    responses: { 200: ok(PreflightSchema, 'Checklist'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'viewer');
    const e = env(c);
    const result = await preflight(e.DB, engine(c), await loadDispatch(e.DB, dispatchId), {
      allowHtmlBlocks: await rawHtmlAllowed(c, access),
      features: await sendFeatures(c, access),
    });
    const { ready, recipientCount, from, checks, warnings, advice, holdBack, bestTime } = result;
    const { include, exclude, rosters } = result.audience;
    const audience = { include, exclude, ...(rosters ? { rosters } : {}) };
    const split = result.split ? { full: result.split.full, teaser: result.split.teaser } : null;
    return c.json(
      {
        data: {
          ready,
          recipientCount,
          from,
          checks,
          warnings,
          advice,
          audience,
          split,
          holdBack,
          bestTime,
        },
      },
      200,
    );
  },
);

dispatches.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/dispatches/{dispatchId}/test',
    tags: ['Dispatches'],
    summary: 'Send a test',
    description:
      'Renders the saved version and sends it to operators of this workspace only, optionally personalised as a Member. Links are not tracked and the subject starts with [Test]. Limited to 10 a minute.',
    request: { params: dispatchParam, body: jsonBody(TestSendSchema) },
    responses: {
      202: ok(z.object({ sentTo: z.array(z.string()) }), 'Sent'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'rate_limited'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'author');
    const sentTo = await testSendDispatch(c, sessionActor(c, access), dispatchId, input);
    return c.json({ data: { sentTo } }, 202);
  },
);

/**
 * The saved version of a Dispatch rendered and personalised as one reader would get it: as a
 * Member (their merge tags and Smart Blocks), or as `fallback` with every block shown. Links are
 * not tracked. Shared by test sends and the /v2 preview.
 */
export async function renderPersonalised(
  c: AppContext,
  workspaceId: string,
  dispatchId: string,
  input: { memberId?: string | undefined; variant?: EmailVariant | undefined },
  fallback: { email: string },
): Promise<{ subject: string; html: string; text: string; warnings: string[]; channelId: string }> {
  const e = env(c);
  const dispatch = await loadDispatch(e.DB, dispatchId);
  const template = await render(
    c,
    dispatch.channel_id,
    await rawHtmlAllowed(c, { workspaceId, channelId: dispatch.channel_id }),
    {
      preheader: dispatch.preheader,
      content: JSON.parse(dispatch.content_json),
      cover: coverOf(dispatch),
    },
    await webOptions(c, dispatch, dispatch.web_visibility),
    // A gated paid Dispatch: the operator picks which of its two emails to test.
    input.variant ?? 'full',
  );
  let member = {
    email: fallback.email,
    firstName: null as string | null,
    lastName: null as string | null,
  };
  // As a Member, the test shows that Member's Smart Blocks; otherwise every block.
  let smartBlocks: number[] | undefined;
  if (input.memberId) {
    const row = await first<{
      email: string;
      first_name: string | null;
      last_name: string | null;
    }>(
      e.DB,
      'SELECT email, first_name, last_name FROM members WHERE id = ?1 AND channel_id = ?2',
      input.memberId,
      dispatch.channel_id,
    );
    if (!row) throw new ApiError('invalid_input', 'That subscriber is not in this publication.');
    member = { email: row.email, firstName: row.first_name, lastName: row.last_name };
    if (template.smartBlocks?.length) {
      smartBlocks = await smartBlockVisibility(
        e.DB,
        dispatch.channel_id,
        input.memberId,
        JSON.parse(dispatch.content_json),
      );
    }
  }
  const filled = personalize(
    { html: template.html, text: template.text, subject: dispatch.subject || '(no subject)' },
    {
      ...(smartBlocks ? { smartBlocks } : {}),
      link: (n) => template.links[n] ?? '#',
      unsubscribeUrl: `${e.APP_ORIGIN}/#test-unsubscribe`,
      pixelUrl: null,
      member,
    },
  );
  return { ...filled, warnings: template.warnings, channelId: dispatch.channel_id };
}

/**
 * Sends a test of the saved version to teammates of this workspace only (shared with /v2),
 * optionally personalised as a Member. A teammate's test goes to them unless they name others;
 * API callers always name the addresses.
 */
export async function testSendDispatch(
  c: AppContext,
  actor: Actor,
  dispatchId: string,
  input: {
    to?: string[] | undefined;
    memberId?: string | undefined;
    variant?: EmailVariant | undefined;
  },
): Promise<string[]> {
  const e = env(c);
  const { success } = await e.TEST_SEND_LIMITER.limit({
    key: actor.operatorId ?? actor.via?.id ?? actor.workspaceId,
  });
  if (!success)
    throw new ApiError('rate_limited', 'Too many test sends. Wait a minute and try again.');

  const to = input.to ?? (actor.email ? [actor.email] : []);
  if (!to.length) throw new ApiError('invalid_input', 'Name who gets the test.');
  const seated = await all<{ email: string }>(
    e.DB,
    `SELECT o.email FROM operators o JOIN seats s ON s.operator_id = o.id
      WHERE s.workspace_id = ?1 AND o.email IN (${to.map((_, i) => `?${i + 2}`).join(', ')})`,
    actor.workspaceId,
    ...to,
  );
  const allowed = new Set(seated.map((row) => row.email.toLowerCase()));
  const outside = to.filter((address) => !allowed.has(address.toLowerCase()));
  if (outside.length) {
    throw new ApiError(
      'invalid_input',
      'Tests can only go to people on this workspace’s team.',
      outside.map(() => ({ path: 'to', message: 'Not on the team' })),
    );
  }

  const filled = await renderPersonalised(c, actor.workspaceId, dispatchId, input, {
    email: actor.email ?? (to[0] as string),
  });
  const sender = await first<{ name: string }>(
    e.DB,
    'SELECT name FROM channels WHERE id = ?1',
    filled.channelId,
  );
  const mail = mailer(e);
  for (const address of to) {
    await mail.send({
      category: 'test',
      from: { name: sender?.name ?? 'Test', address: e.MAIL_FROM },
      to: address,
      subject: `[Test] ${filled.subject}`,
      html: filled.html,
      text: filled.text,
    });
  }
  // The Member is recorded by id only; addresses never reach logs or the audit trail.
  await appendAudit(
    e.DB,
    actorAudit(actor, {
      action: 'dispatch.test_sent',
      targetType: 'dispatch',
      targetId: dispatchId,
      metadata: {
        recipients: to.length,
        asMember: input.memberId ?? null,
        variant: input.variant ?? 'full',
      },
    }),
  );
  return to;
}

dispatches.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/dispatches/{dispatchId}/schedule',
    tags: ['Dispatches'],
    summary: 'Schedule a Dispatch',
    description:
      'The checklist must pass now; it runs again when the time comes, and a Dispatch that fails it then goes back to draft.',
    request: { params: dispatchParam, body: jsonBody(ScheduleDispatchSchema) },
    responses: {
      200: ok(DispatchSchema, 'Scheduled'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const body = c.req.valid('json');
    const publishAt = Date.parse(body.publishAt);
    const access = await requireOwned(c, 'dispatch', dispatchId, 'editor');
    await scheduleDispatch(c, sessionActor(c, access), dispatchId, publishAt, body.bestTime);
    return c.json({ data: await dispatchOut(c, dispatchId, await rawHtmlAllowed(c, access)) }, 200);
  },
);

/**
 * Schedules a Dispatch (shared with /v2). The checklist must pass now; it runs again when the
 * time comes, and a Dispatch that fails it then goes back to draft.
 */
export async function scheduleDispatch(
  c: AppContext,
  actor: Actor,
  dispatchId: string,
  publishAt: number,
  /** Left out, a Dispatch being moved keeps what it had. */
  bestTime?: boolean,
): Promise<void> {
  const now = Date.now();
  if (publishAt < now + 60_000)
    throw new ApiError('invalid_input', 'Pick a time at least a minute from now.');
  if (publishAt > now + 366 * 86_400_000)
    throw new ApiError('invalid_input', 'Pick a time within a year.');
  const e = env(c);
  const toSchedule = await loadDispatch(e.DB, dispatchId);
  const scope = { workspaceId: actor.workspaceId, channelId: toSchedule.channel_id };
  refuseFlowEmail(toSchedule, 'scheduled');
  if (toSchedule.imported_at != null) throw new ApiError('conflict', PAST_ISSUE_NOT_SENT);
  const features = await sendFeatures(c, scope);
  if (bestTime && !features.bestTime) throw new ApiError('feature_disabled', BEST_TIME_OFF);
  const check = await preflight(e.DB, engine(c), toSchedule, {
    allowHtmlBlocks: await rawHtmlAllowed(c, scope),
    features,
    bestTime: bestTime ?? toSchedule.best_time === 1,
  });
  if (!check.ready)
    throw startFailure(
      new StartError(
        'not_ready',
        'The post is not ready to send.',
        check.checks.filter((x) => !x.ok),
      ),
    );
  const row = await first<{ id: string }>(
    e.DB,
    `UPDATE dispatches SET status = 'scheduled', publish_at = ?1, updated_by = ?2, updated_at = ?3,
            best_time = coalesce(?5, best_time), start_attempts = 0, start_retry_at = NULL
      WHERE id = ?4 AND status IN ('draft', 'scheduled') RETURNING id`,
    publishAt,
    actor.operatorId,
    now,
    dispatchId,
    bestTime === undefined ? null : bestTime ? 1 : 0,
  );
  if (!row) throw new ApiError('conflict', 'Only drafts can be scheduled.');
  await appendAudit(
    e.DB,
    actorAudit(actor, {
      action: 'dispatch.scheduled',
      targetType: 'dispatch',
      targetId: dispatchId,
      metadata: { publishAt: new Date(publishAt).toISOString() },
    }),
  );
  const scheduled = await loadDispatch(e.DB, dispatchId);
  // Event Webhooks (Phase 7).
  await recordPlatformEvent(e.DB, {
    type: 'dispatch.scheduled',
    workspaceId: actor.workspaceId,
    channelId: scheduled.channel_id,
    payload: toDispatchSummary(scheduled),
  });
}

dispatches.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/dispatches/{dispatchId}/schedule',
    tags: ['Dispatches'],
    summary: 'Unschedule a Dispatch',
    request: { params: dispatchParam },
    responses: {
      200: ok(DispatchSchema, 'Back to draft'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'editor');
    const e = env(c);
    const row = await first<{ id: string }>(
      e.DB,
      `UPDATE dispatches SET status = 'draft', publish_at = NULL, best_time = 0, updated_by = ?1, updated_at = ?2
        WHERE id = ?3 AND status = 'scheduled' RETURNING id`,
      access.auth.operatorId,
      Date.now(),
      dispatchId,
    );
    if (!row) throw new ApiError('conflict', 'This post is not scheduled.');
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'dispatch.unscheduled',
      targetType: 'dispatch',
      targetId: dispatchId,
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json(
      {
        data: await toDispatch(
          c,
          await loadDispatch(e.DB, dispatchId),
          await rawHtmlAllowed(c, access),
        ),
      },
      200,
    );
  },
);

dispatches.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/dispatches/{dispatchId}/send',
    tags: ['Dispatches'],
    summary: 'Send now',
    description:
      'Runs the checklist, freezes the render and starts a Broadcast. Sending happens on queues; this returns as soon as the Broadcast is queued. A Dispatch can only have one live Broadcast.',
    request: {
      params: dispatchParam,
      body: { ...jsonBody(SendDispatchSchema), required: false },
    },
    responses: {
      202: ok(z.object({ broadcastId: z.string().regex(idPattern('broadcast')) }), 'Queued'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'editor');
    const e = env(c);
    const toSend = await loadDispatch(e.DB, dispatchId);
    refuseFlowEmail(toSend, 'sent on its own');
    const { bestTime = false } = c.req.valid('json');
    const features = await sendFeatures(c, access);
    if (bestTime && !features.bestTime) throw new ApiError('feature_disabled', BEST_TIME_OFF);
    let broadcastId: string;
    try {
      ({ broadcastId } = await startBroadcast(e.DB, sendQueue(c), engine(c), {
        dispatch: toSend,
        operatorId: access.auth.operatorId,
        allowHtmlBlocks: await rawHtmlAllowed(c, access),
        features,
        bestTime,
      }));
    } catch (error) {
      if (error instanceof StartError) throw startFailure(error);
      throw error;
    }
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'broadcast.started',
      targetType: 'broadcast',
      targetId: broadcastId,
      metadata: { dispatchId, ...(bestTime ? { bestTime } : {}) },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: { broadcastId } }, 202);
  },
);

// ---- Web publication ---------------------------------------------------------------------

dispatches.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/dispatches/{dispatchId}/publish-web',
    tags: ['Dispatches'],
    summary: 'Publish on the website without sending',
    description:
      'Puts the Dispatch on the Channel website now: it gets its web address (from the subject, unless one was chosen) and appears in the archive, feeds and search. No email is sent. Sending later keeps the same address. Publishing a Dispatch that is already on the web changes nothing.',
    request: { params: dispatchParam },
    responses: {
      200: ok(DispatchSchema, 'On the web'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'editor');
    const e = env(c);
    const current = await loadDispatch(e.DB, dispatchId);
    refuseFlowEmail(current, 'published on the site');
    if (current.status === 'canceled') {
      throw new ApiError('conflict', 'A canceled post can’t be published.');
    }
    if (current.web_visibility === 'hidden') {
      throw new ApiError(
        'conflict',
        'This post is hidden from the website. Choose who can read it there first.',
      );
    }
    if (current.web_published_at === null && !current.subject.trim()) {
      throw new ApiError('invalid_input', 'Add a subject before publishing.', [
        { path: 'subject', message: 'Add a subject.' },
      ]);
    }
    const { slug } = await publishToWeb(e.DB, dispatchId);
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'dispatch.published_web',
      targetType: 'dispatch',
      targetId: dispatchId,
      metadata: { slug },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json(
      {
        data: await toDispatch(
          c,
          await loadDispatch(e.DB, dispatchId),
          await rawHtmlAllowed(c, access),
        ),
      },
      200,
    );
  },
);

dispatches.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/dispatches/{dispatchId}/unpublish-web',
    tags: ['Dispatches'],
    summary: 'Take a Dispatch off the website',
    description:
      'Hides the Dispatch on the website and removes it from site search. Its address is kept, so publishing it again (choose who can read it) brings it back at the same place.',
    request: { params: dispatchParam },
    responses: {
      200: ok(DispatchSchema, 'Hidden'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { dispatchId } = c.req.valid('param');
    const access = await requireOwned(c, 'dispatch', dispatchId, 'editor');
    const e = env(c);
    await unpublishFromWeb(e.DB, dispatchId);
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'dispatch.unpublished_web',
      targetType: 'dispatch',
      targetId: dispatchId,
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json(
      {
        data: await toDispatch(
          c,
          await loadDispatch(e.DB, dispatchId),
          await rawHtmlAllowed(c, access),
        ),
      },
      200,
    );
  },
);
