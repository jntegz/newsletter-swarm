// Self-hosting: instance-wide settings. Tables: migrations/0032_instance.sql (instance_settings,
// instance_admins). No 'signup' row means 'open'.
import { z } from '@hono/zod-openapi';
import { CursorQuerySchema } from './http';
import { DnsRecordSchema } from './send';

const SIGNUP_MODES = ['open', 'invite_only'] as const;
const SignupModeSchema = z.enum(SIGNUP_MODES).openapi('SignupMode', {
  description:
    '`open`: any verified email gets an account and a workspace. `invite_only`: only existing operators and addresses with a pending invite can sign in.',
});
export type SignupMode = z.infer<typeof SignupModeSchema>;

/** Public: what the sign-in page needs to know. */
export const InstanceInfoSchema = z.object({ signup: SignupModeSchema }).openapi('InstanceInfo');
export type InstanceInfo = z.infer<typeof InstanceInfoSchema>;

/** What DNS says about one record, beside what it should say. */
const RecordStateSchema = z
  .enum(['ok', 'missing', 'different', 'conflict', 'unknown'])
  .openapi({ description: 'unknown means DNS could not answer, not that the record is missing.' });
export type RecordState = z.infer<typeof RecordStateSchema>;

export const CheckedDnsRecordSchema = DnsRecordSchema.extend({
  state: RecordStateSchema,
  found: z.array(z.string()),
}).openapi('CheckedDnsRecord');
export type CheckedDnsRecord = z.infer<typeof CheckedDnsRecordSchema>;

const MailServiceKeySchema = z.enum(['ses', 'resend', 'mailgun', 'postmark', 'smtp', 'dev']);
export type MailServiceKey = z.infer<typeof MailServiceKeySchema>;

/** Instance admins only: the email service this Swarm sends through, and whether it's healthy. */
export const InstanceMailSchema = z
  .object({
    service: MailServiceKeySchema,
    region: z.string().nullable(),
    domain: z
      .string()
      .openapi({ description: 'The domain sign-in and system email is sent from.' }),
    records: z.array(CheckedDnsRecordSchema),
    /** False when the service could not be asked for its records, so some may be left out. */
    recordsComplete: z.boolean(),
    feedback: z
      .object({
        state: z.enum(['ok', 'silent', 'no_data', 'not_reported']),
        sent: z.number().int(),
        reported: z.number().int(),
      })
      .openapi({
        description:
          'Whether bounce and delivery reports are arriving. silent means recent email has had no reports at all.',
      }),
    ses: z
      .object({
        productionAccess: z.boolean(),
        sendingEnabled: z.boolean(),
        max24HourSend: z.number().nullable(),
        maxSendRate: z.number().nullable(),
        sentLast24Hours: z.number().nullable(),
      })
      .nullable()
      .openapi({ description: 'Null unless this is SES and its account could be read.' }),
    change: z
      .object({
        from: z.string(),
        to: z.string(),
        state: z.enum(['prepared', 'cut_over']),
        startedAt: z.string(),
        drainUntil: z.string().nullable(),
      })
      .nullable()
      .openapi({ description: 'A change of email service under way, if any.' }),
    checkedAt: z.string(),
  })
  .openapi('InstanceMail');
export type InstanceMail = z.infer<typeof InstanceMailSchema>;

/** Instance admins only. */
export const InstanceSettingsSchema = z
  .object({ signup: SignupModeSchema })
  .openapi('InstanceSettings');
export type InstanceSettings = z.infer<typeof InstanceSettingsSchema>;

export const UpdateInstanceSettingsSchema = z
  .object({ signup: SignupModeSchema })
  .openapi('UpdateInstanceSettings');
export type UpdateInstanceSettings = z.infer<typeof UpdateInstanceSettingsSchema>;

/**
 * Instance admins only: one feature for the whole Swarm, as stored in feature_flags at platform
 * scope. The key is a string here because @swarm/flags owns the list; the route checks it.
 */
export const InstanceFeatureSchema = z
  .object({
    key: z.string().openapi({ example: 'split_tests' }),
    enabled: z.boolean(),
    updatedBy: z.string().nullable().openapi({
      description:
        'The operator who last changed it. Null when the installer or the command line wrote it, or when nothing has been stored yet.',
    }),
    updatedAt: z.iso.datetime().nullable().openapi({
      description: 'Null when nothing has been stored yet, which reads as off.',
    }),
  })
  .openapi('InstanceFeature');
export type InstanceFeature = z.infer<typeof InstanceFeatureSchema>;

export const UpdateInstanceFeatureSchema = z
  .object({ enabled: z.boolean() })
  .openapi('UpdateInstanceFeature');
/**
 * Instance admins only: where website code may run on this install's own domain
 * (migrations/0065_site_code_rules.sql). Code always runs on a publication's own custom domain;
 * elsewhere only when allowed here. A workspace an instance admin makes is allowed when it is made.
 */
const InstanceSiteCodeWorkspaceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** An instance admin allowed this workspace: the only thing that lets its code run. */
    allowed: z.boolean(),
    /**
     * An owner of the workspace is an instance admin. For information only: it allows nothing by
     * itself, because any owner can make a teammate an owner.
     */
    ownedByInstanceAdmin: z.boolean(),
    /**
     * Its code was withheld when every workspace was allowed, so it stays off on this Swarm's
     * domain until an instance admin allows this workspace by itself.
     */
    held: z.boolean(),
  })
  .openapi('InstanceSiteCodeWorkspace');
export type InstanceSiteCodeWorkspace = z.infer<typeof InstanceSiteCodeWorkspaceSchema>;

export const InstanceSiteCodeSchema = z
  .object({
    /** Every workspace may add code to websites on this install's domain. */
    everyWorkspace: z.boolean(),
    workspaces: z.array(InstanceSiteCodeWorkspaceSchema).openapi({
      description: 'Every workspace on this Swarm, by name, up to the first 500.',
    }),
  })
  .openapi('InstanceSiteCode');
export type InstanceSiteCode = z.infer<typeof InstanceSiteCodeSchema>;

export const UpdateInstanceSiteCodeSchema = z
  .object({ everyWorkspace: z.boolean() })
  .openapi('UpdateInstanceSiteCode');

/** The install's own audit log: changes to install-wide settings, hash-chained (0113). */
export const InstanceAuditSchema = z
  .object({
    items: z.array(
      z.object({
        seq: z.number().int(),
        action: z.string(),
        actorEmail: z.string().nullable(),
        metadata: z.record(z.string(), z.unknown()),
        ipPrefix: z.string().nullable(),
        at: z.iso.datetime(),
      }),
    ),
    /** Pass as `cursor` for the next, older page; null on the last page. */
    nextCursor: z.string().nullable(),
    /** Whether every event, from the first, still matches its hash and the one before it. */
    verification: z.object({
      ok: z.boolean(),
      checked: z.number().int(),
      brokenAtSeq: z.number().int().nullable(),
    }),
  })
  .openapi('InstanceAudit');
export type InstanceAudit = z.infer<typeof InstanceAuditSchema>;

/** Newest first, 100 a page unless `limit` says fewer. */
export const InstanceAuditQuerySchema = CursorQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

export const UpdateInstanceSiteCodeWorkspaceSchema = z
  .object({ allowed: z.boolean() })
  .openapi('UpdateInstanceSiteCodeWorkspace');
