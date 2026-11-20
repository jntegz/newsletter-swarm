// Privacy Center and incremental exports (Phase 7): request and response schemas for the
// dashboard API, the export link token the jobs and capture workers share, and the public
// compliance pages. DSR kinds, statuses and timers live in p7-platform.ts.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';
import { DSR_KINDS, DSR_STATUSES, FeedSuspensionSchema } from './p7-platform';
import { CursorQuerySchema } from './http';
import { FieldKeySchema } from './audience';
import { EmailSchema } from './schemas';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-28T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

// ---------------------------------------------------------------------------------------------
// Public pages

/** The subprocessor list (docs/subprocessors.md), linked from every Channel website footer. */
export const SUBPROCESSORS_URL =
  'https://github.com/jntegz/newsletter-swarm/blob/main/docs/subprocessors.md';
// ---------------------------------------------------------------------------------------------
// Data requests

/**
 * `member_center_unverified`: an erasure from a Member Center link that doesn't prove who holds it
 * (a footer link, which may have been forwarded). It waits for an admin, who should confirm with
 * the person another way. It becomes `member_center` if the person then asks from a verified link.
 */
/**
 * `address_form`: someone who need not be a subscriber asked from the publication's public page
 * (/privacy/<channelId> on the capture origin) and confirmed it from their inbox.
 */
const DSR_SOURCES = [
  'member_center',
  'member_center_unverified',
  'operator',
  'api',
  'address_form',
] as const;
export type DsrSource = (typeof DSR_SOURCES)[number];

/**
 * The export link mailed to the Member: purpose 'dsr-export', payload `{ r: requestId, w:
 * workspaceId }`, DSR_EXPORT_LINK_DAYS, signed with DSR_EXPORT_SIGNING_KEYS (jobs; capture checks
 * the public key). `/m/data/<token>` on the capture origin shows a
 * page; only its POST sends the file, so link scanners never download it.
 */
export const DSR_EXPORT_TOKEN_PURPOSE = 'dsr-export';
/**
 * The confirmation link an erasure from subscriber settings waits for: purpose 'dsr-confirm',
 * payload `{ c: dsr_confirmations.id, m: memberId, n: nonce }`, DSR_CONFIRM_LINK_HOURS, signed with
 * CAPTURE_KEYS, mailed to the address (the row keeps only the nonce's sha256). `/m/erase/<token>` shows a page; only its POST queues the
 * erasure, and a link works once.
 */
export const DSR_CONFIRM_TOKEN_PURPOSE = 'dsr-confirm';
export const DSR_CONFIRM_LINK_HOURS = 24;
/** A second confirmation email for the same subscriber is not sent within this many minutes. */
export const DSR_CONFIRM_RESEND_MINUTES = 10;
/** What an operator must send to approve an erasure (or a Member types nothing: they confirm). */
export const ERASE_CONFIRMATION = 'erase';
/** A request the jobs worker could not finish after this many runs is marked failed. */
export const DSR_MAX_ATTEMPTS = 3;

const DsrKindSchema = z.enum(DSR_KINDS).openapi('DsrKind');
const DsrStatusSchema = z.enum(DSR_STATUSES).openapi('DsrStatus');
const DsrSourceSchema = z.enum(DSR_SOURCES).openapi('DsrSource');

export const DsrRequestSchema = z
  .object({
    id: id('dsrRequest'),
    workspaceId: id('workspace'),
    /** The Channel the request came through (Member Center), or the one an operator named. */
    channelId: id('channel').nullable(),
    kind: DsrKindSchema,
    source: DsrSourceSchema,
    status: DsrStatusSchema,
    /** The Member while one exists; null after erasure (only the hash remains). */
    member: z.object({ id: id('member'), email: z.string(), channelId: id('channel') }).nullable(),
    /**
     * A short label for the address (12 hex digits of the workspace-keyed marker the request keeps),
     * to tell requests apart. It can't be computed from an address outside the workspace's data.
     */
    emailHash: z.string().regex(/^[0-9a-f]{12}$/),
    /** The SLA: export 24 hours, erasure 30 days from the request. */
    dueAt: timestamp,
    overdue: z.boolean(),
    note: z.string().nullable(),
    handledBy: z.object({ id: id('operator'), email: z.string() }).nullable(),
    /** Why the last run failed. */
    error: z.string().nullable(),
    attempts: z.number().int(),
    /** Exports: when the download link stops working. */
    exportExpiresAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp.nullable(),
  })
  .openapi('DsrRequest');
export type DsrRequest = z.infer<typeof DsrRequestSchema>;

export const DsrListQuerySchema = CursorQuerySchema.extend({
  status: DsrStatusSchema.optional(),
  kind: DsrKindSchema.optional(),
});

export const CreateDsrRequestSchema = z
  .object({
    /**
     * The person who asked. They need not be a Member: rows that hold the address without one are
     * covered too.
     */
    email: EmailSchema,
    kind: DsrKindSchema,
    /** Where they asked from, when it was one Channel. Every Channel of the workspace is covered. */
    channelId: id('channel').optional(),
    note: z.string().trim().max(500).optional(),
  })
  .openapi('CreateDsrRequest');
export type CreateDsrRequest = z.infer<typeof CreateDsrRequestSchema>;

export const ApproveDsrRequestSchema = z
  .object({
    note: z.string().trim().max(500).optional(),
    /** Required for an erasure, which cannot be undone: the literal "erase". */
    confirm: z.literal(ERASE_CONFIRMATION).optional(),
  })
  .openapi('ApproveDsrRequest');
export type ApproveDsrRequest = z.infer<typeof ApproveDsrRequestSchema>;

export const RejectDsrRequestSchema = z
  .object({ note: z.string().trim().min(1, 'Say why.').max(500) })
  .openapi('RejectDsrRequest');
// ---------------------------------------------------------------------------------------------
// Incremental exports to the operator's own bucket

const EXPORT_DESTINATION_KINDS = ['s3', 'r2'] as const;
const EXPORT_SCHEDULES = ['hourly', 'daily'] as const;
const EXPORT_DESTINATION_STATUSES = ['active', 'paused', 'failing'] as const;
export type ExportDestinationStatus = (typeof EXPORT_DESTINATION_STATUSES)[number];
/** Consecutive failed runs after which the workspace's owners and admins are emailed (once). */
export const EXPORT_DESTINATION_NOTIFY_AFTER = 3;
/** Rows changed this recently are left for the next run, so a slow writer is never skipped. */
export const EXPORT_SETTLE_MS = 60_000;

const ExportDestinationKindSchema = z
  .enum(EXPORT_DESTINATION_KINDS)
  .openapi('ExportDestinationKind');
const ExportScheduleSchema = z.enum(EXPORT_SCHEDULES).openapi('ExportSchedule');
const ExportDestinationStatusSchema = z
  .enum(EXPORT_DESTINATION_STATUSES)
  .openapi('ExportDestinationStatus');

/** What config_json holds. Credentials are sealed separately and never leave the server. */
export interface ExportDestinationConfig {
  /** https origin of an S3-compatible API (required for R2); empty for AWS S3. */
  endpoint: string | null;
  region: string;
  bucket: string;
  /** Key prefix, no leading slash; '' or ending in '/'. */
  prefix: string;
}

/**
 * What a destination sends. `members`: 'active' writes full lines for subscribed (active) Members
 * only, and a reduced line (id, status and dates) when someone is not or no longer subscribed, so
 * the copy still learns of a departure; 'all' writes everyone in full. `fields`: the profile
 * field keys whose values are included (decrypted), or 'all'; [] sends none. New destinations
 * default to EXPORT_SCOPE_DEFAULT. Destinations added before scopes existed keep sending
 * everything (`legacyScope`) until an admin narrows them.
 */
const EXPORT_MEMBER_SCOPES = ['active', 'all'] as const;
const ExportScopeSchema = z
  .object({
    members: z.enum(EXPORT_MEMBER_SCOPES),
    fields: z.union([z.literal('all'), z.array(FieldKeySchema).max(200)]),
  })
  .openapi('ExportScope');
export type ExportScope = z.infer<typeof ExportScopeSchema>;
export const EXPORT_SCOPE_DEFAULT: ExportScope = { members: 'active', fields: [] };

/** Whether `next` sends someone or something `current` does not. */
export function exportScopeWidens(current: ExportScope, next: ExportScope): boolean {
  if (current.members === 'active' && next.members === 'all') return true;
  if (current.fields === 'all') return false;
  if (next.fields === 'all') return true;
  const had = new Set(current.fields);
  return next.fields.some((key) => !had.has(key));
}

/** Bucket names as S3 and R2 accept them (3–63 lowercase letters, digits, dots, hyphens). */
const BucketSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    'Use the bucket’s name: lowercase letters, digits, dots and hyphens.',
  );
const PrefixSchema = z
  .string()
  .trim()
  .max(200)
  .regex(
    /^(?:[A-Za-z0-9!_.*'()-]+\/)*$/,
    'Use path segments ending in a slash, like swarm/exports/.',
  );
const RegionSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]{2,32}$/, 'Use the region code, like eu-west-1, or auto for R2.');
const EndpointSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^https:\/\/[^/?#\s]+$/, 'Use the https origin of the storage API, with no path.');

export const ExportDestinationSchema = z
  .object({
    id: id('exportDestination'),
    channelId: id('channel'),
    kind: ExportDestinationKindSchema,
    endpoint: z.string().nullable(),
    region: z.string(),
    bucket: z.string(),
    prefix: z.string(),
    schedule: ExportScheduleSchema,
    status: ExportDestinationStatusSchema,
    lastRunAt: timestamp.nullable(),
    lastError: z.string().nullable(),
    /** Members and events exported so far: the cursor's positions, for display. */
    exportedThrough: timestamp.nullable(),
    /** Who and which profile fields it sends. */
    scope: ExportScopeSchema,
    /** Added before scopes existed: sends everyone with every field until an admin narrows it. */
    legacyScope: z.boolean(),
    /** Why it exports nothing while active; null when someone with current authority stands
     *  behind it. An admin confirms it (POST …/confirm) to adopt it. */
    suspendedReason: FeedSuspensionSchema.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('ExportDestination');
export type ExportDestination = z.infer<typeof ExportDestinationSchema>;

const credentials = {
  /** Write-only. Stored sealed with FIELD_KEYS; never returned. */
  accessKeyId: z.string().trim().min(8).max(128),
  /** Write-only. Stored sealed with FIELD_KEYS; never returned. */
  secretAccessKey: z.string().trim().min(16).max(256),
};

export const CreateExportDestinationSchema = z
  .object({
    kind: ExportDestinationKindSchema,
    endpoint: EndpointSchema.optional(),
    region: RegionSchema,
    bucket: BucketSchema,
    prefix: PrefixSchema.default(''),
    schedule: ExportScheduleSchema.default('daily'),
    /** Defaults to subscribed Members only, with no profile fields. */
    scope: ExportScopeSchema.default(EXPORT_SCOPE_DEFAULT),
    ...credentials,
  })
  .refine((value) => value.kind !== 'r2' || !!value.endpoint, {
    path: ['endpoint'],
    message:
      'R2 needs the account’s S3 endpoint, like https://<account id>.r2.cloudflarestorage.com.',
  })
  .openapi('CreateExportDestination');
export type CreateExportDestination = z.infer<typeof CreateExportDestinationSchema>;

export const ExportDestinationPatchSchema = z
  .object({
    endpoint: EndpointSchema.nullable().optional(),
    region: RegionSchema.optional(),
    bucket: BucketSchema.optional(),
    prefix: PrefixSchema.optional(),
    schedule: ExportScheduleSchema.optional(),
    /** Pause or resume. A failing destination is resumed by setting it active. */
    status: z.enum(['active', 'paused']).optional(),
    /** Sending more people or fields than before needs a fresh second factor, like a new bucket. */
    scope: ExportScopeSchema.optional(),
    accessKeyId: credentials.accessKeyId.optional(),
    secretAccessKey: credentials.secretAccessKey.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .refine((value) => !!value.accessKeyId === !!value.secretAccessKey, {
    path: ['secretAccessKey'],
    message: 'Replace both keys together.',
  })
  .openapi('ExportDestinationPatch');
export type ExportDestinationPatch = z.infer<typeof ExportDestinationPatchSchema>;

export const ExportDestinationTestSchema = z
  .object({
    ok: z.boolean(),
    /** The storage API's HTTP status, when it answered. */
    status: z.number().int().nullable(),
    message: z.string(),
  })
  .openapi('ExportDestinationTest');
export type ExportDestinationTest = z.infer<typeof ExportDestinationTestSchema>;
