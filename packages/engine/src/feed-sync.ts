/**
 * Feed Sync (Phase 8, flag feed_sync): fetching feeds through the outbound URL guard, storing
 * their items deduped by GUID, and releasing new items as Dispatches within the feed source's
 * frequency caps and quiet window. The jobs worker's minute cron runs `runFeedSync`; the API's
 * "Check now" runs `checkFeedSource`. Contract: docs/feed-sync.md.
 *
 * A Dispatch in `send` mode is created `scheduled` for now; the send worker's scheduler starts it
 * with the usual checklist, so Feed Sync never starts a Broadcast itself.
 */
import { appendAudit } from '@swarm/db';
import {
  FEED_ITEMS_PLACEHOLDER,
  FEED_SUBJECT_DEFAULTS,
  FEED_SYNC_LIMITS,
  type DispatchAudience,
  type FeedItem,
  type FeedPreview,
  type FeedSource,
} from '@swarm/domain';
import { RenderError } from '@swarm/mail';
import { toDispatchSummary } from './api-shapes';
import { parseAudience } from './circles';
import { all, first, newIdFor, run, toIso } from './db';
import {
  excerpt,
  hasImage,
  htmlToBlocks,
  htmlToText,
  type DocMark,
  type DocNode,
} from './feed-html';
import { FeedError, parseFeed, type ParsedFeed, type ParsedFeedItem } from './feed-parse';
import { nextWeekdayTime } from './flows-time';
import { outboundUrlProblem } from './outbound-url';
import { recordPlatformEvent } from './platform-events';
import { previewHtml, renderForWorkspace, type DispatchRow } from './start';

const MINUTE = 60_000;
const DAY = 86_400_000;
export const FEED_USER_AGENT = 'Swarm-FeedSync/1';
const ACCEPT =
  'application/rss+xml, application/atom+xml, application/feed+json, application/json;q=0.9, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1';
/** The minute cron's release pass: sources looked at per run, and at most this many per workspace. */
const RELEASES_PER_RUN = 25;
const RELEASES_PER_WORKSPACE = 5;
/** Digests stop adding full item content past this many bytes of document (the editor's 512 KB). */
const DIGEST_FULL_BYTES = 400 * 1024;

// ---- Rows and API shapes ---------------------------------------------------------------------

export interface FeedSourceRow {
  id: string;
  channel_id: string;
  url: string;
  name: string | null;
  title: string | null;
  format: 'rss' | 'atom' | 'json' | null;
  mode: 'draft' | 'send';
  grouping: 'each' | 'digest';
  content_mode: 'full' | 'summary';
  template_id: string | null;
  sender_identity_id: string | null;
  audience_json: string;
  subject_template: string | null;
  interval_minutes: number;
  min_gap_minutes: number;
  max_per_day: number;
  digest_limit: number;
  digest_weekdays_json: string | null;
  digest_time: string | null;
  digest_since: number | null;
  quiet_start: number | null;
  quiet_end: number | null;
  timezone: string;
  status: 'active' | 'paused' | 'disabled';
  etag: string | null;
  last_modified: string | null;
  next_check_at: number | null;
  last_checked_at: number | null;
  last_success_at: number | null;
  failure_count: number;
  last_error: string | null;
  lock_until: number | null;
  /** When the minute cron last looked at it for a release (rotates the release window). */
  release_checked_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface FeedItemRow {
  id: string;
  feed_source_id: string;
  key_hash: string;
  guid: string | null;
  link: string | null;
  title: string;
  published_at: number | null;
  content_json: string | null;
  status: 'new' | 'dispatched' | 'skipped';
  dispatch_id: string | null;
  dispatched_at: number | null;
  created_at: number;
  updated_at: number;
}

/** What is kept of an item: its sanitised blocks, a text summary and an image enclosure. */
export interface FeedItemContent {
  blocks: DocNode[];
  summary: string;
  image: string | null;
}

const iso = (ms: number | null) => (ms === null ? null : toIso(ms));

/** 'HH:MM' ↔ minutes after midnight. */
export const clockToMinutes = (clock: string) =>
  Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
export const minutesToClock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * The audience a Dispatch made from this source gets: its Circles and, when it has one, its
 * Roster part (include, exclude, conflict policy; docs/rosters.md). The API checked the flag and
 * the Rosters when the source was saved; the Dispatch's preflight checks both again before a
 * send, so a Roster part is never silently dropped.
 */
export function feedAudience(row: Pick<FeedSourceRow, 'audience_json'>): DispatchAudience {
  const { include, exclude, rosters } = parseAudience(row.audience_json);
  return { include, exclude, ...(rosters ? { rosters } : {}) };
}

export function toFeedSource(
  row: FeedSourceRow,
  extra: { pending: number; lastDispatchAt: number | null },
): FeedSource {
  return {
    id: row.id,
    channelId: row.channel_id,
    url: row.url,
    name: row.name,
    title: row.title,
    format: row.format,
    mode: row.mode,
    grouping: row.grouping,
    contentMode: row.content_mode,
    templateId: row.template_id,
    senderIdentityId: row.sender_identity_id,
    audience: feedAudience(row),
    subjectTemplate: row.subject_template,
    intervalMinutes: row.interval_minutes,
    minGapMinutes: row.min_gap_minutes,
    maxPerDay: row.max_per_day,
    digestLimit: row.digest_limit,
    digestSchedule:
      row.digest_weekdays_json && row.digest_time
        ? { weekdays: JSON.parse(row.digest_weekdays_json) as number[], time: row.digest_time }
        : null,
    quietStart: row.quiet_start === null ? null : minutesToClock(row.quiet_start),
    quietEnd: row.quiet_end === null ? null : minutesToClock(row.quiet_end),
    timezone: row.timezone,
    status: row.status,
    lastCheckedAt: iso(row.last_checked_at),
    lastSuccessAt: iso(row.last_success_at),
    nextCheckAt: row.status === 'active' ? iso(row.next_check_at) : null,
    failureCount: row.failure_count,
    lastError: row.last_error,
    pendingItems: extra.pending,
    lastDispatchAt: iso(extra.lastDispatchAt),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** API shapes for source rows, with their waiting items and last Dispatch in one query. */
export async function toFeedSources(db: D1Database, rows: FeedSourceRow[]): Promise<FeedSource[]> {
  if (!rows.length) return [];
  const stats = await all<{ feed_source_id: string; pending: number; last: number | null }>(
    db,
    `SELECT feed_source_id, sum(status = 'new') AS pending, max(dispatched_at) AS last
       FROM feed_items WHERE feed_source_id IN (SELECT value FROM json_each(?1))
      GROUP BY feed_source_id`,
    JSON.stringify(rows.map((r) => r.id)),
  );
  const byId = new Map(stats.map((s) => [s.feed_source_id, s]));
  return rows.map((row) =>
    toFeedSource(row, {
      pending: byId.get(row.id)?.pending ?? 0,
      lastDispatchAt: byId.get(row.id)?.last ?? null,
    }),
  );
}

export const toFeedItem = (row: FeedItemRow): FeedItem => ({
  id: row.id,
  feedSourceId: row.feed_source_id,
  title: row.title,
  link: row.link,
  guid: row.guid,
  publishedAt: iso(row.published_at),
  status: row.status,
  dispatchId: row.dispatch_id,
  dispatchedAt: iso(row.dispatched_at),
  firstSeenAt: toIso(row.created_at),
});

// ---- Fetching --------------------------------------------------------------------------------

export interface FeedSyncDeps {
  db: D1Database;
  fetch: typeof fetch;
  /** 'development' allows plain http feeds (local tunnels), as for webhooks. */
  environment: string;
  /** Where Media is served, for the stored preview of a Dispatch whose Template has images. */
  mediaOrigin: string;
}

/** Why a feed URL may not be fetched, or null when it may (the outbound URL guard). */
export function feedUrlProblem(url: string, environment: string): string | null {
  const problem = outboundUrlProblem(url, { allowHttp: environment === 'development' });
  if (problem === 'webhooks must use https') return 'feeds must use https';
  return problem;
}

export type FeedFetchResult =
  | { notModified: true }
  | { notModified: false; body: string; etag: string | null; lastModified: string | null };

/** The body, at most FEED_SYNC_LIMITS.fetchBytes, counted while it streams. */
async function readLimited(response: Response, deadline: number): Promise<Uint8Array> {
  const limit = FEED_SYNC_LIMITS.fetchBytes;
  const tooLarge = () => new FeedError('The feed is larger than 2 MB.');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const timedOut = () => new FeedError('The feed did not answer within 10 seconds.');
  for (;;) {
    if (Date.now() > deadline) {
      await reader.cancel();
      throw timedOut();
    }
    let read: ReadableStreamReadResult<Uint8Array>;
    try {
      read = await reader.read();
    } catch (error) {
      // A body that resets or stalls past the fetch's timeout is the feed's failure, like an
      // error status, so the source backs off instead of being retried every minute.
      const name = (error as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw timedOut();
      throw new FeedError(`The feed stopped sending (${(error as Error).message}).`);
    }
    const { done, value } = read;
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Decodes with the charset of the content type or the XML declaration, else UTF-8. */
function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const label =
    /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1] ??
    /^\s*<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * One conditional GET of a feed. Every URL (the first and each redirect target) goes through the
 * outbound URL guard; redirects are followed by hand, at most FEED_SYNC_LIMITS.redirects; the
 * whole fetch has FEED_SYNC_LIMITS.fetchTimeoutMs. Throws FeedError with a message for the
 * operator on anything but 200 or 304.
 */
export async function fetchFeed(
  url: string,
  validators: { etag: string | null; lastModified: string | null },
  deps: Pick<FeedSyncDeps, 'fetch' | 'environment'>,
): Promise<FeedFetchResult> {
  const deadline = Date.now() + FEED_SYNC_LIMITS.fetchTimeoutMs;
  let current = url;
  for (let hop = 0; ; hop++) {
    const problem = feedUrlProblem(current, deps.environment);
    if (problem) {
      throw new FeedError(
        hop
          ? `The feed redirected to an address that is not allowed (${problem}).`
          : `The feed address is not allowed (${problem}).`,
      );
    }
    const headers = new Headers({ accept: ACCEPT, 'user-agent': FEED_USER_AGENT });
    if (validators.etag) headers.set('if-none-match', validators.etag);
    if (validators.lastModified) headers.set('if-modified-since', validators.lastModified);
    let response: Response;
    try {
      response = await deps.fetch(current, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new FeedError('The feed did not answer within 10 seconds.');
      }
      throw new FeedError(`The feed could not be reached (${(error as Error).message}).`);
    }
    if (response.status === 304) {
      await response.body?.cancel();
      return { notModified: true };
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location)
        throw new FeedError(`The feed answered ${response.status} without a Location.`);
      if (hop >= FEED_SYNC_LIMITS.redirects)
        throw new FeedError('The feed redirected too many times.');
      try {
        current = new URL(location, current).href;
      } catch {
        throw new FeedError('The feed redirected to an address that is not a URL.');
      }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new FeedError(`The feed answered ${response.status}.`);
    }
    const bytes = await readLimited(response, deadline);
    const header = (name: string) => response.headers.get(name)?.slice(0, 500) ?? null;
    return {
      notModified: false,
      body: decodeBody(bytes, response.headers.get('content-type')),
      etag: header('etag'),
      lastModified: header('last-modified'),
    };
  }
}

// ---- Items -----------------------------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The dedupe key: the GUID, else the link and title. */
export const feedItemKey = (item: Pick<ParsedFeedItem, 'guid' | 'link' | 'title'>) =>
  sha256Hex(item.guid ? `guid:${item.guid}` : `link:${item.link ?? ''}\n${item.title}`);

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Sanitises an item once, when it is first seen. */
export function feedItemContent(item: ParsedFeedItem, feedUrl: string): FeedItemContent {
  const base = item.link ?? feedUrl;
  const content: FeedItemContent = {
    blocks: item.html ? htmlToBlocks(item.html, base) : [],
    summary: excerpt(htmlToText(item.summary ?? item.html ?? ''), FEED_SYNC_LIMITS.summaryChars),
    image: item.image,
  };
  while (content.blocks.length && byteLength(content) > FEED_SYNC_LIMITS.itemDocumentBytes) {
    content.blocks = content.blocks.slice(0, Math.floor(content.blocks.length * 0.75));
  }
  return content;
}

/**
 * Stores the items not seen before. On a source's first successful fetch they are `skipped`, so
 * adding a feed never sends its backlog. Returns how many new (`new`) items were stored.
 */
async function storeItems(
  db: D1Database,
  source: FeedSourceRow,
  feed: ParsedFeed,
  now: number,
): Promise<number> {
  const keyed = await Promise.all(
    // Feeds list newest first: storing oldest first keeps ids in publication order.
    [...feed.items].reverse().map(async (item) => ({ item, key: await feedItemKey(item) })),
  );
  if (!keyed.length) return 0;
  const known = new Set(
    (
      await all<{ key_hash: string }>(
        db,
        `SELECT key_hash FROM feed_items
          WHERE feed_source_id = ?1 AND key_hash IN (SELECT value FROM json_each(?2))`,
        source.id,
        JSON.stringify(keyed.map((k) => k.key)),
      )
    ).map((r) => r.key_hash),
  );
  const fresh = keyed.filter(({ key }) => {
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  if (!fresh.length) return 0;
  const status = source.last_success_at === null ? 'skipped' : 'new';
  const results = await db.batch<{ id: string }>(
    fresh.map(({ item, key }, index) =>
      db
        .prepare(
          `INSERT INTO feed_items (id, feed_source_id, key_hash, guid, link, title, published_at, content_json,
             status, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
           ON CONFLICT (feed_source_id, key_hash) DO NOTHING RETURNING id`,
        )
        .bind(
          // UUIDv7 orders by millisecond only: one per item keeps them in feed order.
          newIdFor('feedItem', now + index),
          source.id,
          key,
          item.guid,
          item.link,
          item.title,
          item.publishedAt,
          JSON.stringify(feedItemContent(item, source.url)),
          status,
          now,
        ),
    ),
  );
  const inserted = results.reduce((n, r) => n + (r.results?.length ?? 0), 0);
  return status === 'new' ? inserted : 0;
}

// ---- Building a Dispatch ---------------------------------------------------------------------

export interface FeedDispatchItem {
  title: string;
  link: string | null;
  content: FeedItemContent | null;
}

export interface FeedDispatchInput {
  grouping: 'each' | 'digest';
  contentMode: 'full' | 'summary';
  subjectTemplate: string | null;
  /** The name shown for {{feed.title}}. */
  feedTitle: string;
  timezone: string;
  /** The Template's editor document, or null. */
  template: unknown;
  items: FeedDispatchItem[];
  now: number;
}

const paragraph = (text: string, marks?: DocMark[]): DocNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text, ...(marks ? { marks } : {}) }],
});

function itemBlocks(item: FeedDispatchItem, grouping: 'each' | 'digest', mode: 'full' | 'summary') {
  const out: DocNode[] = [];
  if (grouping === 'digest' && item.title) {
    out.push({
      type: 'heading',
      attrs: { level: 2 },
      content: [
        {
          type: 'text',
          text: item.title,
          ...(item.link ? { marks: [{ type: 'link', attrs: { href: item.link } }] } : {}),
        },
      ],
    });
  }
  const content = item.content;
  let body: DocNode[] =
    mode === 'full' && content?.blocks.length
      ? content.blocks
      : content?.summary
        ? [paragraph(content.summary)]
        : [];
  if (content?.image && !hasImage(body)) {
    body = [{ type: 'image', attrs: { src: content.image, alt: item.title } }, ...body];
  }
  out.push(...body);
  if (grouping === 'each' && item.link) {
    out.push({ type: 'button', attrs: { href: item.link, label: 'Read the original' } });
  }
  return out;
}

function plainText(node: DocNode): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(plainText).join('');
}

const isEmptyParagraph = (node: DocNode) => node.type === 'paragraph' && !plainText(node).trim();

/** The Template's blocks with the items at {{feed.items}}, or after its content. */
function mergeTemplate(template: unknown, blocks: DocNode[]): DocNode {
  const doc = template as DocNode | null;
  const base =
    doc && typeof doc === 'object' && doc.type === 'doc' && Array.isArray(doc.content)
      ? (structuredClone(doc.content) as DocNode[])
      : [];
  const at = base.findIndex(
    (node) => node.type === 'paragraph' && plainText(node).trim() === FEED_ITEMS_PLACEHOLDER,
  );
  if (at >= 0) base.splice(at, 1, ...blocks);
  else {
    while (base.length && isEmptyParagraph(base[base.length - 1]!)) base.pop();
    base.push(...blocks);
  }
  return { type: 'doc', content: base.length ? base : [{ type: 'paragraph' }] };
}

function formatDay(now: number, zone: string): string {
  const options = { day: 'numeric', month: 'short', year: 'numeric' } as const;
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: zone }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(now);
  }
}

/** Subject, preheader and document for a Dispatch made of `items` (pure; the tests use it). */
export function buildFeedDispatch(input: FeedDispatchInput): {
  subject: string;
  preheader: string;
  content: DocNode;
} {
  const { items, grouping } = input;
  const blocks: DocNode[] = [];
  let size = 0;
  items.forEach((item, index) => {
    if (grouping === 'digest' && index > 0) blocks.push({ type: 'horizontalRule' });
    // A long digest switches to summaries rather than outgrow the editor's limit.
    const mode = grouping === 'digest' && size > DIGEST_FULL_BYTES ? 'summary' : input.contentMode;
    const own = itemBlocks(item, grouping, mode);
    size += byteLength(own);
    blocks.push(...own);
  });
  const first = items[0];
  const vars: Record<string, string> = {
    'item.title': first?.title ?? '',
    'feed.title': input.feedTitle,
    count: String(items.length),
    date: formatDay(input.now, input.timezone),
  };
  const subject = (input.subjectTemplate ?? FEED_SUBJECT_DEFAULTS[grouping])
    .replace(/\{\{\s*(item\.title|feed\.title|count|date)\s*\}\}/g, (_, key: string) => vars[key]!)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  const preheader =
    grouping === 'each'
      ? excerpt(first?.content?.summary ?? '', 200)
      : excerpt(
          items
            .map((i) => i.title)
            .filter(Boolean)
            .join(' · '),
          200,
        );
  return { subject, preheader, content: mergeTemplate(input.template, blocks) };
}

// ---- Caps and quiet windows ------------------------------------------------------------------

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** Minutes after local midnight in `zone` (UTC when the zone is unknown). */
export function minuteOfDay(ms: number, zone: string): number {
  let formatter = clockFormatters.get(zone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return Math.floor((ms % DAY) / MINUTE);
    }
    clockFormatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(ms).map((p) => [p.type, p.value]));
  return (Number(parts.hour) % 24) * 60 + Number(parts.minute);
}

/** Whether `now` falls in the window [start, end), which may cross midnight. */
export function inQuietWindow(
  now: number,
  window: { start: number | null; end: number | null; zone: string },
): boolean {
  const { start, end } = window;
  if (start === null || end === null || start === end) return false;
  const minute = minuteOfDay(now, window.zone);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/**
 * How long after its slot a scheduled digest can still go. A feed may be checked only once a day,
 * and a quiet window or an outage can hold a slot back; later than this waits for the next slot, so
 * a post that appears on Saturday doesn't make a "Friday" digest on Saturday.
 */
const DIGEST_SLOT_GRACE = DAY;

/** Whether a scheduled digest is due: a slot has just passed, and nothing has gone since it. */
export function digestSlotDue(
  now: number,
  schedule: { weekdays: readonly number[]; time: string; zone: string; since: number },
  lastDispatchAt: number | null,
): boolean {
  let slot: number | null = null;
  let cursor = now - 8 * DAY;
  for (;;) {
    const next = nextWeekdayTime(cursor, schedule.weekdays, schedule.time, schedule.zone);
    if (next > now) break;
    slot = next;
    cursor = next;
  }
  if (slot === null || now - slot > DIGEST_SLOT_GRACE) return false;
  return slot > schedule.since && (lastDispatchAt === null || lastDispatchAt < slot);
}

/** Why the source may not release a Dispatch now, or null when it may. */
async function releaseBlocked(
  db: D1Database,
  source: FeedSourceRow,
  now: number,
): Promise<string | null> {
  const caps = await first<{ last: number | null; today: number }>(
    db,
    `SELECT max(dispatched_at) AS last, count(DISTINCT CASE WHEN dispatched_at > ?2 THEN dispatched_at END) AS today
       FROM feed_items WHERE feed_source_id = ?1 AND dispatched_at IS NOT NULL`,
    source.id,
    now - DAY,
  );
  if (source.grouping === 'digest' && source.digest_weekdays_json && source.digest_time) {
    const due = digestSlotDue(
      now,
      {
        weekdays: JSON.parse(source.digest_weekdays_json) as number[],
        time: source.digest_time,
        zone: source.timezone,
        since: source.digest_since ?? 0,
      },
      caps?.last ?? null,
    );
    if (!due) return 'not its day';
  }
  if ((caps?.today ?? 0) >= source.max_per_day) return 'daily cap';
  if (caps?.last && now - caps.last < Math.max(1, source.min_gap_minutes) * MINUTE) return 'gap';
  if (
    source.mode === 'send' &&
    inQuietWindow(now, { start: source.quiet_start, end: source.quiet_end, zone: source.timezone })
  ) {
    return 'quiet window';
  }
  return null;
}

// ---- Releasing -------------------------------------------------------------------------------

interface ChannelInfo {
  workspace_id: string;
  name: string;
  branding_json: string;
}

const loadChannel = (db: D1Database, channelId: string) =>
  first<ChannelInfo>(
    db,
    'SELECT workspace_id, name, branding_json FROM channels WHERE id = ?1',
    channelId,
  );

/** The source's Template document, if it still exists, is a Dispatch template and is visible. */
async function templateDocument(
  db: D1Database,
  source: FeedSourceRow,
  workspaceId: string,
): Promise<unknown> {
  if (!source.template_id) return null;
  const row = await first<{ content_json: string }>(
    db,
    `SELECT content_json FROM templates WHERE id = ?1 AND deleted_at IS NULL AND kind = 'dispatch'
       AND workspace_id = ?2 AND (channel_id IS NULL OR channel_id = ?3)`,
    source.template_id,
    workspaceId,
    source.channel_id,
  );
  return row ? (JSON.parse(row.content_json) as unknown) : null;
}

const waitingItems = (db: D1Database, source: FeedSourceRow) =>
  all<FeedItemRow>(
    db,
    `SELECT * FROM feed_items WHERE feed_source_id = ?1 AND status = 'new'
      ORDER BY published_at IS NULL, published_at, id LIMIT ?2`,
    source.id,
    source.grouping === 'each' ? 1 : source.digest_limit,
  );

const displayTitle = (source: Pick<FeedSourceRow, 'name' | 'title' | 'url'>) =>
  source.name || source.title || new URL(source.url).hostname;

function dispatchInput(
  source: FeedSourceRow,
  template: unknown,
  items: FeedItemRow[],
  now: number,
): FeedDispatchInput {
  return {
    grouping: source.grouping,
    contentMode: source.content_mode,
    subjectTemplate: source.subject_template,
    feedTitle: displayTitle(source),
    timezone: source.timezone,
    template,
    now,
    items: items.map((item) => ({
      title: item.title,
      link: item.link,
      content: item.content_json ? (JSON.parse(item.content_json) as FeedItemContent) : null,
    })),
  };
}

/** Renders for the stored preview; a document that doesn't render yet is stored without one. */
async function renderPreview(
  deps: Pick<FeedSyncDeps, 'db' | 'mediaOrigin'>,
  source: FeedSourceRow,
  channel: ChannelInfo,
  built: { preheader: string; content: DocNode },
) {
  const branding = JSON.parse(channel.branding_json) as { accentColor?: string | null };
  try {
    const template = await renderForWorkspace({
      db: deps.db,
      workspaceId: channel.workspace_id,
      channelId: source.channel_id,
      channelName: channel.name,
      accentColor: branding.accentColor ?? null,
      preheader: built.preheader,
      content: built.content,
      mediaOrigin: deps.mediaOrigin,
      // Feed items never become raw HTML blocks; a Template's would need raw_html_mode, which
      // the send worker checks when the Dispatch starts.
      allowHtmlBlocks: false,
    });
    return { html: previewHtml(template), text: template.text, warnings: template.warnings };
  } catch (error) {
    if (!(error instanceof RenderError)) throw error;
    return { html: '', text: '', warnings: [error.message] };
  }
}

/**
 * Makes at most one Dispatch from the source's waiting items, if its caps and quiet window allow
 * it now. The caller holds the source's lock. Returns the Dispatch id.
 */
async function releaseOne(
  deps: Pick<FeedSyncDeps, 'db' | 'mediaOrigin'>,
  source: FeedSourceRow,
  channel: ChannelInfo,
  now: number,
): Promise<string | null> {
  const { db } = deps;
  if (source.status !== 'active') return null;
  if (await releaseBlocked(db, source, now)) return null;
  const items = await waitingItems(db, source);
  if (!items.length) return null;
  const template = await templateDocument(db, source, channel.workspace_id);
  const built = buildFeedDispatch(dispatchInput(source, template, items, now));
  const preview = await renderPreview(deps, source, channel, built);
  const id = newIdFor('dispatch', now);
  const scheduled = source.mode === 'send';
  const contentJson = JSON.stringify(built.content);
  const audienceJson = JSON.stringify(feedAudience(source));
  const itemIds = JSON.stringify(items.map((i) => i.id));
  const [, , claimed] = await db.batch([
    db
      .prepare(
        `INSERT INTO dispatches (id, channel_id, subject, preheader, content_json, html, text, status, publish_at,
           sender_identity_id, audience_json, created_by, updated_by, created_at, updated_at, kind, web_visibility, from_feed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, NULL, ?12, ?12, 'broadcast', 'public', 1)`,
      )
      .bind(
        id,
        source.channel_id,
        built.subject,
        built.preheader,
        contentJson,
        preview.html,
        preview.text,
        scheduled ? 'scheduled' : 'draft',
        scheduled ? now : null,
        source.sender_identity_id,
        audienceJson,
        now,
      ),
    db
      .prepare(
        `INSERT INTO dispatch_revisions (id, dispatch_id, subject, preheader, content_json, name, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, ?6)`,
      )
      .bind(
        newIdFor('dispatchRevision', now),
        id,
        built.subject,
        built.preheader,
        contentJson,
        now,
      ),
    db
      .prepare(
        `UPDATE feed_items SET status = 'dispatched', dispatch_id = ?1, dispatched_at = ?2, updated_at = ?2
          WHERE id IN (SELECT value FROM json_each(?3)) AND status = 'new'`,
      )
      .bind(id, now, itemIds),
  ]);
  if (!claimed?.meta.changes) {
    // The lock makes this unreachable; never leave an empty Dispatch behind if it happens.
    await run(db, `DELETE FROM dispatches WHERE id = ?1 AND status IN ('draft', 'scheduled')`, id);
    return null;
  }
  await appendAudit(db, {
    workspaceId: channel.workspace_id,
    actorId: null,
    action: 'dispatch.created',
    targetType: 'dispatch',
    targetId: id,
    metadata: {
      feedSourceId: source.id,
      items: items.length,
      ...(scheduled ? { scheduled: true } : {}),
    },
  });
  if (scheduled) {
    const row = await first<DispatchRow>(db, 'SELECT * FROM dispatches WHERE id = ?1', id);
    // Event Webhooks (Phase 7), as when a teammate schedules a Dispatch.
    if (row) {
      await recordPlatformEvent(db, {
        type: 'dispatch.scheduled',
        workspaceId: channel.workspace_id,
        channelId: source.channel_id,
        payload: toDispatchSummary(row),
      });
    }
  }
  return id;
}

// ---- Checking --------------------------------------------------------------------------------

/** Holds a source for one check or release. Null when another one holds it. */
async function claimSource(
  db: D1Database,
  sourceId: string,
  now: number,
  manual: boolean,
): Promise<FeedSourceRow | null> {
  return first<FeedSourceRow>(
    db,
    `UPDATE feed_sources SET lock_until = ?2
      WHERE id = ?1 AND (lock_until IS NULL OR lock_until <= ?3) AND (?4 = 1 OR status = 'active')
     RETURNING *`,
    sourceId,
    now + FEED_SYNC_LIMITS.lockMs,
    now,
    manual ? 1 : 0,
  );
}

const unlock = (db: D1Database, sourceId: string) =>
  run(db, 'UPDATE feed_sources SET lock_until = NULL WHERE id = ?1', sourceId);

/** The wait before the next check after `failures` failures in a row. */
export const feedBackoffMs = (intervalMinutes: number, failures: number) =>
  Math.min(
    FEED_SYNC_LIMITS.maxBackoffMs,
    intervalMinutes * MINUTE * 2 ** Math.max(0, failures - 1),
  );

export interface FeedCheckOutcome {
  notModified: boolean;
  newItems: number;
  dispatchIds: string[];
  error: string | null;
  /**
   * A `send` source that was turned off after failures fetched successfully but stays turned
   * off: sending again is a separate decision (resuming it, status active).
   */
  resumeRequired: boolean;
  /** A `draft` source that was turned off after failures was turned back on by this check. */
  reactivated: boolean;
}

/**
 * Fetches a feed, stores its new items and releases what its caps allow. Returns null when the
 * source is held by another check (or, for a scheduled check, is no longer active). A manual
 * check ("Check now") also runs for paused and turned-off sources. One that succeeds turns a
 * `draft` source that was turned off after failures back on (it only ever makes drafts); a
 * turned-off `send` source stays off and releases nothing (`resumeRequired`), because sending
 * Dispatches built from someone else's feed again must go through the same decision as resuming
 * it (update, which agents' approval mode holds), never as a side effect of a check. Its new
 * items wait. A FeedError (the feed's answer) counts as a failure. Any other error (ours: a
 * parser bug, D1) is thrown after the lock is released; it backs the source off first (a manual
 * check's failure to store items excepted), but never counts towards turning it off, so a bug of
 * ours can't turn every source off.
 */
export async function checkFeedSource(
  deps: FeedSyncDeps,
  sourceId: string,
  now: number,
  options: { manual?: boolean } = {},
): Promise<FeedCheckOutcome | null> {
  const { db } = deps;
  const source = await claimSource(db, sourceId, now, options.manual ?? false);
  if (!source) return null;
  try {
    const channel = await loadChannel(db, source.channel_id);
    if (!channel) return null;
    let fetched: FeedFetchResult;
    let feed: ParsedFeed | null = null;
    try {
      fetched = await fetchFeed(
        source.url,
        { etag: source.etag, lastModified: source.last_modified },
        deps,
      );
      if (!fetched.notModified) feed = parseFeed(fetched.body, source.url);
    } catch (error) {
      if (!(error instanceof FeedError)) {
        // Ours, not the feed's (a stream that breaks off is a FeedError already): wait longer
        // each time, so the source can't hold the head of the due window, but don't count it.
        await backOff(db, source, now);
        throw error;
      }
      await recordFailure(db, source, channel, error.message, now);
      return {
        notModified: false,
        newItems: 0,
        dispatchIds: [],
        error: error.message,
        resumeRequired: false,
        reactivated: false,
      };
    }
    let newItems = 0;
    try {
      if (feed) newItems = await storeItems(db, source, feed, now);
    } catch (error) {
      // As above: a scheduled check backs off, so the source can't stay at the head of the due
      // window (and hold other workspaces' checks) while storing keeps failing.
      if (!options.manual) await backOff(db, source, now);
      throw error;
    }
    const turnedOff = source.status === 'disabled';
    const reactivated = turnedOff && source.mode !== 'send';
    const status = reactivated ? 'active' : source.status;
    await run(
      db,
      `UPDATE feed_sources SET title = COALESCE(?2, title), format = COALESCE(?3, format),
         etag = CASE WHEN ?4 = 1 THEN ?5 ELSE etag END, last_modified = CASE WHEN ?4 = 1 THEN ?6 ELSE last_modified END,
         last_checked_at = ?7, last_success_at = ?7, failure_count = 0, last_error = NULL,
         next_check_at = ?7 + interval_minutes * 60000, status = ?8
       WHERE id = ?1`,
      source.id,
      feed?.title ?? null,
      feed?.format ?? null,
      fetched.notModified ? 0 : 1,
      fetched.notModified ? null : fetched.etag,
      fetched.notModified ? null : fetched.lastModified,
      now,
      status,
    );
    const released =
      status === 'active'
        ? await releaseOne(deps, { ...source, status, last_success_at: now }, channel, now)
        : null;
    return {
      notModified: fetched.notModified,
      newItems,
      dispatchIds: released ? [released] : [],
      error: null,
      resumeRequired: turnedOff && !reactivated,
      reactivated,
    };
  } finally {
    await unlock(db, source.id);
  }
}

/**
 * Pushes the next check out after an error that is not the feed's, twice as far as the last
 * wait (at least the interval, at most the longest backoff), without counting a failure.
 */
async function backOff(db: D1Database, source: FeedSourceRow, now: number): Promise<void> {
  await run(
    db,
    `UPDATE feed_sources SET last_checked_at = ?2,
       next_check_at = ?2 + MIN(?3, MAX(interval_minutes * 60000,
         2 * COALESCE(next_check_at - last_checked_at, 0)))
     WHERE id = ?1`,
    source.id,
    now,
    FEED_SYNC_LIMITS.maxBackoffMs,
  );
}

async function recordFailure(
  db: D1Database,
  source: FeedSourceRow,
  channel: ChannelInfo,
  message: string,
  now: number,
): Promise<void> {
  const failures = source.failure_count + 1;
  const turnOff = source.status === 'active' && failures >= FEED_SYNC_LIMITS.failuresBeforeOff;
  await run(
    db,
    `UPDATE feed_sources SET failure_count = ?2, last_error = ?3, last_checked_at = ?4, next_check_at = ?5,
       status = CASE WHEN ?6 = 1 THEN 'disabled' ELSE status END
     WHERE id = ?1`,
    source.id,
    failures,
    message.slice(0, 500),
    now,
    now + feedBackoffMs(source.interval_minutes, failures),
    turnOff ? 1 : 0,
  );
  if (turnOff) {
    await appendAudit(db, {
      workspaceId: channel.workspace_id,
      actorId: null,
      action: 'feed_source.paused',
      targetType: 'feed_source',
      targetId: source.id,
      metadata: { reason: message.slice(0, 500), failures },
    });
  }
}

// ---- Preview ---------------------------------------------------------------------------------

/**
 * The Dispatch the next release would make, rendered, without changing anything. Uses the
 * newest item when nothing is waiting (`sample`); null when the feed has no items yet.
 */
export async function previewFeedDispatch(
  deps: Pick<FeedSyncDeps, 'db' | 'mediaOrigin'>,
  source: FeedSourceRow,
  now: number,
): Promise<FeedPreview | null> {
  const { db } = deps;
  const channel = await loadChannel(db, source.channel_id);
  if (!channel) return null;
  let items = await waitingItems(db, source);
  const sample = items.length === 0;
  if (sample) {
    items = await all<FeedItemRow>(
      db,
      'SELECT * FROM feed_items WHERE feed_source_id = ?1 ORDER BY id DESC LIMIT 1',
      source.id,
    );
  }
  if (!items.length) return null;
  const template = await templateDocument(db, source, channel.workspace_id);
  const built = buildFeedDispatch(dispatchInput(source, template, items, now));
  const rendered = await renderPreview(deps, source, channel, built);
  return {
    subject: built.subject,
    preheader: built.preheader,
    html: rendered.html,
    items: items.map((i) => ({ id: i.id, title: i.title, link: i.link })),
    sample,
    warnings: rendered.warnings,
  };
}

// ---- The cron --------------------------------------------------------------------------------

export interface FeedSyncRunDeps extends FeedSyncDeps {
  /** Whether feed_sync is on for the Channel (the jobs worker asks the flag service). */
  enabled: (workspaceId: string, channelId: string) => Promise<boolean>;
  log?: (message: string, fields: Record<string, unknown>) => void;
  /** Errors that are not the feed's (bugs, D1), which need someone to look at them. */
  logError?: (message: string, fields: Record<string, unknown>) => void;
}

async function inPool<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) await work(next);
    }),
  );
}

/**
 * The minute cron: checks due sources (a bounded batch, a few at a time), then releases waiting
 * items of the other active sources, so caps and quiet windows end on time even when a feed is
 * quiet. Sources of Channels without the flag wait for their next interval.
 */
export async function runFeedSync(
  deps: FeedSyncRunDeps,
  now: number,
): Promise<{ checked: number; failed: number; dispatches: number }> {
  const { db } = deps;
  const tally = { checked: 0, failed: 0, dispatches: 0 };
  const flagCache = new Map<string, Promise<boolean>>();
  const enabled = (workspaceId: string, channelId: string) => {
    let result = flagCache.get(channelId);
    if (!result) {
      result = deps.enabled(workspaceId, channelId);
      flagCache.set(channelId, result);
    }
    return result;
  };

  // Oldest due first within each workspace, and workspaces in turn: a workspace's first due
  // source comes before anyone's second, and none takes more than checksPerWorkspacePerRun.
  const due = await all<{ id: string; channel_id: string; workspace_id: string }>(
    db,
    `WITH due AS (
       SELECT fs.id, fs.channel_id, c.workspace_id, COALESCE(fs.next_check_at, 0) AS at,
              row_number() OVER (PARTITION BY c.workspace_id
                                 ORDER BY COALESCE(fs.next_check_at, 0), fs.id) AS n
         FROM feed_sources fs JOIN channels c ON c.id = fs.channel_id
        WHERE fs.status = 'active' AND COALESCE(fs.next_check_at, 0) <= ?1
          AND (fs.lock_until IS NULL OR fs.lock_until <= ?1) AND c.deleted_at IS NULL)
     SELECT id, channel_id, workspace_id FROM due WHERE n <= ?3 ORDER BY n, at, id LIMIT ?2`,
    now,
    FEED_SYNC_LIMITS.checksPerRun,
    FEED_SYNC_LIMITS.checksPerWorkspacePerRun,
  );
  const checked = new Set<string>();
  await inPool(due, FEED_SYNC_LIMITS.checkConcurrency, async (row) => {
    checked.add(row.id);
    try {
      if (!(await enabled(row.workspace_id, row.channel_id))) {
        await run(
          db,
          'UPDATE feed_sources SET next_check_at = ?2 + interval_minutes * 60000 WHERE id = ?1',
          row.id,
          now,
        );
        return;
      }
      const outcome = await checkFeedSource(deps, row.id, now);
      if (!outcome) return;
      tally.checked++;
      if (outcome.error) tally.failed++;
      tally.dispatches += outcome.dispatchIds.length;
    } catch (error) {
      (deps.logError ?? deps.log)?.('feed check failed', {
        feedSourceId: row.id,
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
      // Whatever went wrong, the source waits at least an interval (never less than a backoff
      // already set), so it can't stay first in the due window and starve other workspaces.
      await run(
        db,
        `UPDATE feed_sources SET next_check_at = MAX(COALESCE(next_check_at, 0), ?2 + interval_minutes * 60000)
          WHERE id = ?1`,
        row.id,
        now,
      ).catch(() => undefined);
    }
  });

  // Least recently looked at first, and a few per workspace: sources whose items are held back
  // (quiet window, caps, digest day) stay eligible, and would otherwise take the same window
  // every minute while other sources' items wait.
  const waiting = await all<{ id: string; channel_id: string; workspace_id: string }>(
    db,
    `WITH waiting AS (
       SELECT fs.id, fs.channel_id, c.workspace_id, COALESCE(fs.release_checked_at, 0) AS visited,
              row_number() OVER (PARTITION BY c.workspace_id
                                 ORDER BY COALESCE(fs.release_checked_at, 0), fs.id) AS n
         FROM feed_sources fs JOIN channels c ON c.id = fs.channel_id
        WHERE fs.status = 'active' AND (fs.lock_until IS NULL OR fs.lock_until <= ?1) AND c.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM feed_items fi WHERE fi.feed_source_id = fs.id AND fi.status = 'new'))
     SELECT id, channel_id, workspace_id FROM waiting WHERE n <= ?3 ORDER BY visited, id LIMIT ?2`,
    now,
    RELEASES_PER_RUN,
    RELEASES_PER_WORKSPACE,
  );
  if (waiting.length) {
    await run(
      db,
      'UPDATE feed_sources SET release_checked_at = ?2 WHERE id IN (SELECT value FROM json_each(?1))',
      JSON.stringify(waiting.map((row) => row.id)),
      now,
    );
  }
  for (const row of waiting) {
    if (checked.has(row.id)) continue;
    try {
      if (!(await enabled(row.workspace_id, row.channel_id))) continue;
      const source = await claimSource(db, row.id, now, false);
      if (!source) continue;
      try {
        const channel = await loadChannel(db, source.channel_id);
        if (channel && (await releaseOne(deps, source, channel, now))) tally.dispatches++;
      } finally {
        await unlock(db, source.id);
      }
    } catch (error) {
      deps.log?.('feed release failed', { feedSourceId: row.id, error: (error as Error).message });
    }
  }
  return tally;
}

/**
 * The daily cron: keeps the newest FEED_SYNC_LIMITS.itemsKept items per feed (items still
 * waiting are never dropped) and clears the content of used items after contentDays.
 */
export async function pruneFeedItems(
  db: D1Database,
  now: number,
): Promise<{ deleted: number; cleared: number }> {
  const deleted = await db
    .prepare(
      `DELETE FROM feed_items WHERE id IN (
         SELECT id FROM (
           SELECT id, status, row_number() OVER (PARTITION BY feed_source_id ORDER BY id DESC) AS position
             FROM feed_items)
          WHERE position > ?1 AND status <> 'new' LIMIT 5000)`,
    )
    .bind(FEED_SYNC_LIMITS.itemsKept)
    .run();
  const cleared = await db
    .prepare(
      `UPDATE feed_items SET content_json = NULL
        WHERE status <> 'new' AND content_json IS NOT NULL AND updated_at < ?1`,
    )
    .bind(now - FEED_SYNC_LIMITS.contentDays * DAY)
    .run();
  return { deleted: deleted.meta.changes ?? 0, cleared: cleared.meta.changes ?? 0 };
}
