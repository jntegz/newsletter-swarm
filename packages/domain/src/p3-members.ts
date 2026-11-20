// Phase 3 schemas: Members workstream (member management, profile fields, tags, imports,
// exports and bulk actions). Member, field and tag basics live in audience.ts.
import { z } from '@hono/zod-openapi';
import {
  DigestSchema,
  EncryptedUnavailableSchema,
  FieldKeySchema,
  FieldTypeSchema,
  FieldValueSchema,
  MemberSchema,
  MemberStatusSchema,
  TagNameSchema,
} from './audience';
import { EmailCheckStateSchema, MemberEmailCheckSchema } from './email-checks';
import { MemberEngagementSchema } from './p8-engagement';
import { CursorQuerySchema } from './http';
import { idPattern } from './ids';
import { ImportSourceSchema } from './p7-api';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

// ---------------------------------------------------------------------------------------------
// Members

export const MemberListQuerySchema = CursorQuerySchema.extend({
  status: MemberStatusSchema.optional(),
  tag: z.string().trim().min(1).max(60).optional().openapi({ description: 'A tag name' }),
  q: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .openapi({ description: 'Search email, first and last name' }),
  /** Email checks (flag email_verification): a colour, or `unchecked`. */
  emailCheck: EmailCheckStateSchema.optional(),
  /** Email checks: one result code (1 to 8), for a reason. */
  emailCheckCode: z.coerce.number().int().min(1).max(8).optional(),
});

/** The most profile field columns one Member list page can carry. */
export const MAX_LIST_FIELDS = 20;

/** The dashboard's Member list: the filters, a Circle, and profile field columns. */
export const MemberListFieldsQuerySchema = MemberListQuerySchema.extend({
  circle: id('circle').optional().openapi({ description: 'Only Members of this Circle' }),
  fields: z
    .string()
    .trim()
    .max(1300)
    .optional()
    .openapi({
      description: `Profile field keys, comma-separated (up to ${MAX_LIST_FIELDS}), to return on each Member as \`fields\``,
    }),
});

/** A Member in the list, with the profile field values asked for (encrypted ones decrypted). */
export const MemberListItemSchema = MemberSchema.extend({
  fields: z.record(z.string(), FieldValueSchema).optional(),
  encryptedUnavailable: EncryptedUnavailableSchema,
  /** The engagement score, or null when it is off or hasn't been worked out yet. */
  engagement: MemberEngagementSchema.nullable().optional(),
  /** The address's email check in this workspace, or null when it has none. */
  emailCheck: MemberEmailCheckSchema.nullable().optional(),
}).openapi('MemberListItem');
export type MemberListItem = z.infer<typeof MemberListItemSchema>;

/** Default pause when an operator pauses a Member without a date. */
export const DEFAULT_PAUSE_DAYS = 28;
/** The longest pause an operator can set. */
export const MAX_PAUSE_DAYS = 366;

export const MemberPatchSchema = z
  .object({
    firstName: z.string().trim().max(80).nullable().optional(),
    lastName: z.string().trim().max(80).nullable().optional(),
    /** Operators may pause, resume or unsubscribe; see `canTransition`. */
    status: MemberStatusSchema.optional(),
    /** With status "paused": when the pause ends. Defaults to four weeks. */
    pausedUntil: timestamp.optional(),
    digest: DigestSchema.optional(),
    /** Replaces the Member's tags. Missing tags are created. */
    tags: z.array(TagNameSchema).max(50).optional(),
    /** Sets the given fields; null clears one. Fields not named are left alone. */
    fields: z.record(FieldKeySchema, FieldValueSchema).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('MemberPatch');
export type MemberPatch = z.infer<typeof MemberPatchSchema>;

const ACTIVITY_TYPES = [
  'joined',
  'form',
  'delivery',
  'open',
  'click',
  'bounce',
  'complaint',
  'unsubscribe',
] as const;

export const MemberActivitySchema = z
  .object({
    type: z.enum(ACTIVITY_TYPES),
    at: timestamp,
    broadcastId: id('broadcast').nullable(),
    subject: z.string().nullable(),
    /** The link, for clicks. */
    url: z.string().nullable(),
    /** The Capture form, for "joined" and "form". */
    formId: id('captureForm').nullable(),
    /** That form's name; null when it has been deleted. */
    formName: z.string().nullable(),
    /** The import, for "joined". */
    importId: id('importJob').nullable(),
  })
  .openapi('MemberActivity');
export type MemberActivity = z.infer<typeof MemberActivitySchema>;

/** The most recent entries returned by the activity timeline. */
export const ACTIVITY_LIMIT = 100;

// ---------------------------------------------------------------------------------------------
// Profile fields

const FIELD_OPTION_LIMIT = 100;
const OptionsSchema = z
  .array(z.string().trim().min(1, 'Choices can’t be empty.').max(200))
  .max(FIELD_OPTION_LIMIT)
  .refine(
    (options) => new Set(options.map((o) => o.toLowerCase())).size === options.length,
    'Each choice must be different.',
  );

export const CreateMemberFieldSchema = z
  .object({
    key: FieldKeySchema,
    label: z.string().trim().min(1, 'Add a label.').max(80),
    type: FieldTypeSchema,
    options: OptionsSchema.optional(),
    encrypted: z.boolean().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .superRefine((value, ctx) => {
    const choice = value.type === 'select' || value.type === 'multi_select';
    if (choice && !value.options?.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Add at least one choice.' });
    }
    if (!choice && value.options?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Only choice fields have choices.',
      });
    }
  })
  .openapi('CreateMemberField');
export type CreateMemberField = z.infer<typeof CreateMemberFieldSchema>;

/** Type and encryption are fixed at creation; sending a different value is refused. */
export const UpdateMemberFieldSchema = z
  .object({
    label: z.string().trim().min(1, 'Add a label.').max(80).optional(),
    options: OptionsSchema.optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    type: FieldTypeSchema.optional(),
    encrypted: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateMemberField');
export type UpdateMemberField = z.infer<typeof UpdateMemberFieldSchema>;

// ---------------------------------------------------------------------------------------------
// Tags

export const CreateTagSchema = z.object({ name: TagNameSchema }).openapi('CreateTag');
export const UpdateTagSchema = z.object({ name: TagNameSchema }).openapi('UpdateTag');

// ---------------------------------------------------------------------------------------------
// Saved views: a named set of Member list filters, shared by everyone on the Channel

/** The built-in Member list columns, in table order. A profile field column is `field:<key>`. */
export const MEMBER_LIST_COLUMNS = [
  'name',
  'status',
  'tags',
  'digest',
  'joined',
  'confirmed',
  'pausedUntil',
  'engagement',
] as const;
/** The most saved views one Channel keeps. */
export const MAX_MEMBER_VIEWS = 50;

const ViewColumnSchema = z
  .string()
  .regex(
    new RegExp(`^(${MEMBER_LIST_COLUMNS.join('|')}|field:[a-z][a-z0-9_]{0,39})$`),
    'Not a column of the list.',
  );

export const MemberViewFiltersSchema = z
  .object({
    status: MemberStatusSchema.optional(),
    tag: TagNameSchema.optional().openapi({ description: 'A tag name' }),
    q: z.string().trim().min(1).max(100).optional().openapi({ description: 'The search' }),
    circleId: id('circle').optional().openapi({ description: 'Only Members of this Circle' }),
    columns: z
      .array(ViewColumnSchema)
      .max(MEMBER_LIST_COLUMNS.length + MAX_LIST_FIELDS)
      .optional()
      .openapi({ description: 'The columns shown, in order. Absent: leave the columns alone.' }),
  })
  .strict()
  .openapi('MemberViewFilters');
export type MemberViewFilters = z.infer<typeof MemberViewFiltersSchema>;

const ViewNameSchema = z.string().trim().min(1, 'Name the view.').max(60);

export const MemberViewSchema = z
  .object({
    id: z.string(),
    channelId: z.string(),
    name: z.string(),
    filters: MemberViewFiltersSchema,
    createdBy: z.string().nullable().openapi({ description: 'The Operator who saved it' }),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('MemberView');
export type MemberView = z.infer<typeof MemberViewSchema>;

export const CreateMemberViewSchema = z
  .object({ name: ViewNameSchema, filters: MemberViewFiltersSchema })
  .openapi('CreateMemberView');
export type CreateMemberView = z.infer<typeof CreateMemberViewSchema>;

export const UpdateMemberViewSchema = z
  .object({ name: ViewNameSchema.optional(), filters: MemberViewFiltersSchema.optional() })
  .refine(
    (value) => value.name !== undefined || value.filters !== undefined,
    'Change the name or the filters.',
  )
  .openapi('UpdateMemberView');
export type UpdateMemberView = z.infer<typeof UpdateMemberViewSchema>;

// ---------------------------------------------------------------------------------------------
// Bulk actions

export const BULK_MAX_MEMBERS = 1000;
const BULK_ACTIONS = ['tag', 'untag', 'set_field', 'unsubscribe', 'delete'] as const;
/** A job's action. Adding people to a Flow has its own route, so CreateBulkJob doesn't offer it. */
const BULK_JOB_ACTIONS = [...BULK_ACTIONS, 'flow_enrol'] as const;
const BulkActionSchema = z.enum(BULK_ACTIONS).openapi('BulkAction');

export const BulkSelectionSchema = z
  .union([
    z.object({ memberIds: z.array(id('member')).min(1).max(BULK_MAX_MEMBERS) }).strict(),
    z.object({ circleId: id('circle') }).strict(),
  ])
  .openapi('BulkSelection');
export type BulkSelection = z.infer<typeof BulkSelectionSchema>;

export const CreateBulkJobSchema = z
  .object({
    selection: BulkSelectionSchema,
    action: BulkActionSchema,
    /** For tag and untag. */
    tag: TagNameSchema.optional(),
    /** For set_field: the field key and its value (null clears it). */
    field: FieldKeySchema.optional(),
    value: FieldValueSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.action === 'tag' || value.action === 'untag') && !value.tag) {
      ctx.addIssue({ code: 'custom', path: ['tag'], message: 'Name the tag.' });
    }
    if (value.action === 'set_field' && (!value.field || value.value === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['field'], message: 'Pick a field and a value.' });
    }
  })
  .openapi('CreateBulkJob');
export type CreateBulkJob = z.infer<typeof CreateBulkJobSchema>;

const JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
const JobStatusSchema = z.enum(JOB_STATUSES).openapi('JobStatus');

export const BulkJobSchema = z
  .object({
    id: id('bulkJob'),
    channelId: id('channel'),
    action: z.enum(BULK_JOB_ACTIONS),
    params: z.object({
      tag: z.string().optional(),
      field: z.string().optional(),
      value: FieldValueSchema.optional(),
      /** flow_enrol: the Flow people are added to. */
      flowId: z.string().optional(),
    }),
    selection: z.object({ kind: z.enum(['members', 'circle']), circleId: id('circle').nullable() }),
    status: JobStatusSchema,
    total: z.number().int(),
    processed: z.number().int(),
    /** flow_enrol: how many of `processed` started a run; the rest the enrolment rules left out. */
    entered: z.number().int(),
    error: z.string().nullable(),
    createdAt: timestamp,
    completedAt: timestamp.nullable(),
  })
  .openapi('BulkJob');
export type BulkJob = z.infer<typeof BulkJobSchema>;

// ---------------------------------------------------------------------------------------------
// Imports

/**
 * Imported people who start pending (no attestation) and never confirm are deleted this many days
 * after the import, unless a confirmation email sent to them is still open (jobs worker, daily).
 */
export const IMPORT_PENDING_DAYS = 30;

/**
 * The attestation an import's "Everyone on this list agreed" checkbox stands for. It is stored as
 * the wording of each imported subscriber's consent record (source 'import').
 */
export const IMPORT_ATTESTATION_TEXT = 'Everyone on this list agreed to receive this publication';

export const IMPORT_MAX_BYTES = 50 * 1024 * 1024;
/** Lists with at least this many new Members start a warm import on the Reputation Ramp. */
export const WARM_IMPORT_THRESHOLD = 10_000;

const IMPORT_STATUSES = [
  'uploaded',
  'analyzing',
  'analyzed',
  'importing',
  'done',
  'failed',
  'canceled',
] as const;
const ImportStatusSchema = z.enum(IMPORT_STATUSES).openapi('ImportStatus');

/**
 * Where a column goes: a Member column, a profile field (`field:<key>`), tags, Roster names
 * (`rosters`, rosters flag), or nowhere.
 */
const ImportTargetSchema = z
  .union([
    z.enum(['email', 'first_name', 'last_name', 'tags', 'rosters']),
    z.string().regex(/^field:[a-z][a-z0-9_]{0,39}$/),
  ])
  .nullable()
  .openapi('ImportTarget');
export type ImportTarget = z.infer<typeof ImportTargetSchema>;

export const ImportMappingSchema = z
  .object({
    mapping: z.record(z.string().max(200), ImportTargetSchema),
    consentAttested: z.boolean(),
    updateExisting: z.boolean(),
  })
  .openapi('ImportMapping');
export type ImportMapping = z.infer<typeof ImportMappingSchema>;

export const IMPORT_CLASSES = [
  'new',
  'updated',
  'unchanged',
  'invalid',
  'role',
  'disposable',
  'suppressed',
  'duplicate',
] as const;
export type ImportClass = (typeof IMPORT_CLASSES)[number];

const ImportSampleSchema = z.object({
  line: z.number().int(),
  email: z.string(),
  reason: z.string().nullable(),
});

const ImportReportSchema = z
  .object({
    /** Every data row lands in exactly one class. */
    total: z.number().int(),
    counts: z.object(
      Object.fromEntries(IMPORT_CLASSES.map((k) => [k, z.number().int()])) as {
        [K in ImportClass]: z.ZodNumber;
      },
    ),
    samples: z.object(
      Object.fromEntries(IMPORT_CLASSES.map((k) => [k, z.array(ImportSampleSchema)])) as {
        [K in ImportClass]: z.ZodArray<typeof ImportSampleSchema>;
      },
    ),
    /** Cells left out because they don't fit their field (the rest of the row still imports). */
    fieldErrors: z.number().int(),
    fieldErrorSamples: z.array(ImportSampleSchema),
    /** New Members arrive on a warm-import Reputation Ramp. */
    warmImport: z.boolean(),
    /** Filled in as the import runs. */
    result: z
      .object({ created: z.number().int(), updated: z.number().int(), skipped: z.number().int() })
      .optional(),
    /** With "Check addresses during import": what the email check changed, filled in as it runs. */
    emailCheck: z
      .object({
        /** Red (or whichever colour the workspace skips) and left out. */
        skipped: z.number().int(),
        tagged: z.number().int(),
        /** Imported as pending: they confirm by email first. */
        confirm: z.number().int(),
        samples: z.array(ImportSampleSchema),
      })
      .optional(),
  })
  .openapi('ImportReport');
export type ImportReport = z.infer<typeof ImportReportSchema>;

export const ImportJobSchema = z
  .object({
    id: id('importJob'),
    channelId: id('channel'),
    status: ImportStatusSchema,
    fileName: z.string(),
    bytes: z.number().int(),
    /** Column names in file order, from the header row (or "Column 1"… when there is none). */
    columns: z.array(z.string()),
    mapping: z.record(z.string(), ImportTargetSchema),
    consentAttested: z.boolean(),
    updateExisting: z.boolean(),
    /** What the file is: a CSV, or an export of another newsletter platform (Phase 7). */
    source: ImportSourceSchema,
    report: ImportReportSchema.nullable(),
    totalRows: z.number().int(),
    processedRows: z.number().int(),
    /** Addresses are checked with DeBounce before they are imported (flag email_verification). */
    checkAddresses: z.boolean(),
    /** That check, while it runs and after. */
    emailCheckRunId: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: timestamp,
    completedAt: timestamp.nullable(),
  })
  .openapi('ImportJob');
export type ImportJob = z.infer<typeof ImportJobSchema>;

// ---------------------------------------------------------------------------------------------
// Exports

/** How long a finished export stays downloadable. */
export const EXPORT_TTL_HOURS = 72;
/** How long one signed download link works. */
export const EXPORT_LINK_HOURS = 24;

export const CreateExportSchema = z
  .object({
    format: z.enum(['csv', 'jsonl']),
    status: MemberStatusSchema.optional(),
    circleId: id('circle').optional(),
    /** Members subscribed to this Roster (rosters flag). */
    rosterId: id('roster').optional(),
  })
  .openapi('CreateExport');
export type CreateExport = z.infer<typeof CreateExportSchema>;

export const ExportJobSchema = z
  .object({
    id: id('exportJob'),
    channelId: id('channel'),
    format: z.enum(['csv', 'jsonl']),
    filter: z.object({
      status: MemberStatusSchema.optional(),
      circleId: id('circle').optional(),
      rosterId: id('roster').optional(),
    }),
    status: JobStatusSchema,
    rowCount: z.number().int(),
    error: z.string().nullable(),
    createdAt: timestamp,
    completedAt: timestamp.nullable(),
    expiresAt: timestamp.nullable(),
    /** A signed link valid for 24 hours, while the file is available. Needs a session too. */
    downloadUrl: z.string().nullable(),
  })
  .openapi('ExportJob');
export type ExportJob = z.infer<typeof ExportJobSchema>;
