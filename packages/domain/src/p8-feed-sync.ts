// Feed Sync (Phase 8.2): Dispatches drafted or sent from RSS or Atom feeds, flag feed_sync.
// Tables: migrations/0020_feed_sync.sql. Docs: docs/feed-sync.md.
import { z } from '@hono/zod-openapi';
import { DispatchAudienceSchema } from './audience';
import { idPattern } from './ids';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-28T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

/** Limits of Feed Sync; docs/feed-sync.md explains each. */
export const FEED_SYNC_LIMITS = {
  sourcesPerChannel: 20,
  /** The body of one fetch, counted while it streams. */
  fetchBytes: 2 * 1024 * 1024,
  /** One fetch, redirects included. */
  fetchTimeoutMs: 10_000,
  redirects: 3,
  /** Items read from one fetch (the first ones in the document). */
  itemsPerFetch: 50,
  /** Items kept per feed for dedupe; older ones are pruned daily. */
  itemsKept: 500,
  /** Days item content is kept once the item has left `new`. */
  contentDays: 14,
  /** Blocks and bytes of editor document made from one item. */
  blocksPerItem: 300,
  itemDocumentBytes: 64 * 1024,
  /** Characters of text in `summary` content. */
  summaryChars: 400,
  /** Consecutive failed checks before a feed source is turned off. */
  failuresBeforeOff: 8,
  /** The longest wait between checks after failures. */
  maxBackoffMs: 24 * 3_600_000,
  /** The minute cron checks at most this many sources, this many at a time. */
  checksPerRun: 10,
  checkConcurrency: 3,
  /**
   * Of those, at most this many from one workspace, taken in turn across workspaces, so one
   * workspace with many due sources can't hold the run (security review
   * S02-P3-T-feed-scheduler-share).
   */
  checksPerWorkspacePerRun: 3,
  /**
   * Feed sources a workspace may have across its Channels. Existing workspaces above it keep
   * theirs; only new ones are refused. Owner decision: the right number for hosted installs.
   */
  sourcesPerWorkspace: 100,
  /** How long a check holds its source. */
  lockMs: 2 * 60_000,
} as const;

/** The default subject for each grouping. */
export const FEED_SUBJECT_DEFAULTS = {
  each: '{{item.title}}',
  digest: '{{feed.title}}: {{count}} new',
} as const;

/** The paragraph text a Template uses to say where the items go. */
export const FEED_ITEMS_PLACEHOLDER = '{{feed.items}}';

const FeedSourceStatusSchema = z
  .enum(['active', 'paused', 'disabled'])
  .openapi('FeedSourceStatus', {
    description:
      'active: checked on its interval; paused: by a teammate; disabled: turned off after repeated failures (lastError says why)',
  });
export type FeedSourceStatus = z.infer<typeof FeedSourceStatusSchema>;

const FeedModeSchema = z.enum(['draft', 'send']).openapi('FeedMode', {
  description: 'draft: Dispatches stay drafts; send: they are scheduled to go out on their own',
});
const FeedGroupingSchema = z.enum(['each', 'digest']).openapi('FeedGrouping', {
  description: 'each: one Dispatch per item; digest: one Dispatch with every new item',
});
const FeedContentModeSchema = z.enum(['full', 'summary']).openapi('FeedContentMode', {
  description: "full: the item's HTML; summary: a short excerpt with a link to the original",
});
const FeedFormatSchema = z.enum(['rss', 'atom', 'json']).openapi('FeedFormat');
export type FeedFormat = z.infer<typeof FeedFormatSchema>;

const FeedItemStatusSchema = z.enum(['new', 'dispatched', 'skipped']).openapi('FeedItemStatus', {
  description:
    'new: waiting for a Dispatch; dispatched: in one; skipped: already in the feed when it was added',
});
export type FeedItemStatus = z.infer<typeof FeedItemStatusSchema>;

const ClockSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time such as 22:00.')
  .openapi({ example: '22:00' });

const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'Use a time zone such as Europe/Prague.');

const FeedUrlSchema = z.string().trim().min(1).max(2048).openapi({
  example: 'https://example.com/feed.xml',
  description: 'An https URL with a public host name',
});

const FeedDigestScheduleSchema = z
  .object({
    /** 0 = Sunday. */
    weekdays: z.array(z.number().int().min(0).max(6)).min(1, 'Pick at least one day.').max(7),
    /** HH:MM, 24 h, in the source's timezone. */
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:00.'),
  })
  .openapi('FeedDigestSchedule', {
    description: 'A digest goes out on these days at this time, in the source’s timezone',
  });
const FeedSourceFields = {
  url: FeedUrlSchema,
  /** A label for the team; the feed's own title is shown when empty. */
  name: z.string().trim().max(120).nullable(),
  mode: FeedModeSchema,
  grouping: FeedGroupingSchema,
  contentMode: FeedContentModeSchema,
  templateId: id('template').nullable(),
  senderIdentityId: id('senderIdentity').nullable(),
  audience: DispatchAudienceSchema,
  /** With {{item.title}}, {{feed.title}}, {{count}} and {{date}}; null uses the default. */
  subjectTemplate: z.string().trim().min(1).max(200).nullable(),
  intervalMinutes: z.number().int().min(15).max(1440),
  minGapMinutes: z.number().int().min(0).max(10_080),
  maxPerDay: z.number().int().min(1).max(48),
  /** Items in one digest; the rest wait for the next one. */
  digestLimit: z.number().int().min(1).max(30),
  /** Digests only. Null: whenever the caps allow. */
  digestSchedule: FeedDigestScheduleSchema.nullable(),
  quietStart: ClockSchema.nullable(),
  quietEnd: ClockSchema.nullable(),
  timezone: TimeZoneSchema,
};

const quietBothOrNeither = (value: {
  quietStart?: string | null | undefined;
  quietEnd?: string | null | undefined;
}) =>
  (value.quietStart === undefined) === (value.quietEnd === undefined) &&
  (value.quietStart === null) === (value.quietEnd === null);
const QUIET_MESSAGE = {
  message: 'Set both ends of the quiet window, or neither.',
  path: ['quietEnd'],
};

export const CreateFeedSourceSchema = z
  .object({
    url: FeedSourceFields.url,
    name: FeedSourceFields.name.optional(),
    mode: FeedSourceFields.mode.default('draft'),
    grouping: FeedSourceFields.grouping.default('each'),
    contentMode: FeedSourceFields.contentMode.default('full'),
    templateId: FeedSourceFields.templateId.optional(),
    senderIdentityId: FeedSourceFields.senderIdentityId.optional(),
    audience: FeedSourceFields.audience.optional(),
    subjectTemplate: FeedSourceFields.subjectTemplate.optional(),
    intervalMinutes: FeedSourceFields.intervalMinutes.default(60),
    minGapMinutes: FeedSourceFields.minGapMinutes.default(0),
    maxPerDay: FeedSourceFields.maxPerDay.default(3),
    digestLimit: FeedSourceFields.digestLimit.default(10),
    digestSchedule: FeedSourceFields.digestSchedule.optional(),
    quietStart: FeedSourceFields.quietStart.optional(),
    quietEnd: FeedSourceFields.quietEnd.optional(),
    timezone: FeedSourceFields.timezone.default('UTC'),
  })
  .refine(quietBothOrNeither, QUIET_MESSAGE)
  .openapi('CreateFeedSource');
export type CreateFeedSource = z.input<typeof CreateFeedSourceSchema>;

export const UpdateFeedSourceSchema = z
  .object({
    url: FeedSourceFields.url.optional(),
    name: FeedSourceFields.name.optional(),
    mode: FeedSourceFields.mode.optional(),
    grouping: FeedSourceFields.grouping.optional(),
    contentMode: FeedSourceFields.contentMode.optional(),
    templateId: FeedSourceFields.templateId.optional(),
    senderIdentityId: FeedSourceFields.senderIdentityId.optional(),
    audience: FeedSourceFields.audience.optional(),
    subjectTemplate: FeedSourceFields.subjectTemplate.optional(),
    intervalMinutes: FeedSourceFields.intervalMinutes.optional(),
    minGapMinutes: FeedSourceFields.minGapMinutes.optional(),
    maxPerDay: FeedSourceFields.maxPerDay.optional(),
    digestLimit: FeedSourceFields.digestLimit.optional(),
    digestSchedule: FeedSourceFields.digestSchedule.optional(),
    quietStart: FeedSourceFields.quietStart.optional(),
    quietEnd: FeedSourceFields.quietEnd.optional(),
    timezone: FeedSourceFields.timezone.optional(),
    /** Pause or resume. Resuming a source turned off after failures clears them. */
    status: z.enum(['active', 'paused']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .refine(quietBothOrNeither, QUIET_MESSAGE)
  .openapi('UpdateFeedSource');
export type UpdateFeedSource = z.input<typeof UpdateFeedSourceSchema>;

export const FeedSourceSchema = z
  .object({
    id: id('feedSource'),
    channelId: id('channel'),
    ...FeedSourceFields,
    /** The feed's own title, from the last successful fetch. */
    title: z.string().nullable(),
    format: FeedFormatSchema.nullable(),
    status: FeedSourceStatusSchema,
    lastCheckedAt: timestamp.nullable(),
    lastSuccessAt: timestamp.nullable(),
    nextCheckAt: timestamp.nullable(),
    /** Failed checks in a row. */
    failureCount: z.number().int(),
    /** Why the last check failed; null after a success. */
    lastError: z.string().nullable(),
    /** Items waiting for a Dispatch. */
    pendingItems: z.number().int(),
    lastDispatchAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('FeedSource');
export type FeedSource = z.infer<typeof FeedSourceSchema>;

export const FeedItemSchema = z
  .object({
    id: id('feedItem'),
    feedSourceId: id('feedSource'),
    title: z.string(),
    link: z.string().nullable(),
    guid: z.string().nullable(),
    publishedAt: timestamp.nullable(),
    status: FeedItemStatusSchema,
    dispatchId: id('dispatch').nullable(),
    dispatchedAt: timestamp.nullable(),
    firstSeenAt: timestamp,
  })
  .openapi('FeedItem');
export type FeedItem = z.infer<typeof FeedItemSchema>;

export const FeedItemsQuerySchema = z.object({
  status: FeedItemStatusSchema.optional().openapi({ param: { name: 'status', in: 'query' } }),
});

export const FeedCheckResultSchema = z
  .object({
    source: FeedSourceSchema,
    /** The feed answered 304 Not Modified. */
    notModified: z.boolean(),
    /** Items seen for the first time in this check. */
    newItems: z.number().int(),
    /** Dispatches made by the release that followed. */
    dispatchIds: z.array(id('dispatch')),
    /** Why the check failed; null on success. */
    error: z.string().nullable(),
    /**
     * A `send` source turned off after failures fetched successfully but stays off: resume it
     * (status active) to send again. A check never turns a `send` source back on.
     */
    resumeRequired: z.boolean(),
  })
  .openapi('FeedCheckResult');
export type FeedCheckResult = z.infer<typeof FeedCheckResultSchema>;

export const FeedPreviewSchema = z
  .object({
    subject: z.string(),
    preheader: z.string(),
    /** The rendered email, links unwrapped; for a sandboxed frame. */
    html: z.string(),
    items: z.array(FeedItemSchema.pick({ id: true, title: true, link: true })),
    /** Nothing is waiting: the preview uses the newest item instead. */
    sample: z.boolean(),
    warnings: z.array(z.string()),
  })
  .openapi('FeedPreview');
export type FeedPreview = z.infer<typeof FeedPreviewSchema>;
