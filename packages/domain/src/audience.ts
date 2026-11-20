// Members, profile fields, tags, Circle rules and Dispatch audiences (Phase 3).
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';
import { MemberEntitlementSchema } from './p5-levels';
import { MemberEngagementSchema } from './p8-engagement';
import { RosterAudienceSchema } from './p8-rosters';
import { EmailSchema } from './schemas';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

// ---------------------------------------------------------------------------------------------
// Member statuses and the transitions between them

export const MEMBER_STATUSES = [
  'pending',
  'active',
  'paused',
  'unsubscribed',
  'bounced',
  'complained',
] as const;
export const MemberStatusSchema = z.enum(MEMBER_STATUSES).openapi('MemberStatus');
export type MemberStatus = z.infer<typeof MemberStatusSchema>;

/** Who is asking for a change: a teammate, the Member themselves (signed link), or the system. */
type MemberActor = 'operator' | 'member' | 'system';

/**
 * Allowed transitions, by actor. Anything not listed is refused.
 * - Nobody moves a Member out of bounced or complained: the address is suppressed. The one way back
 *   from bounced is an admin removing the bounce suppression, which restores the status the Member
 *   had (members.bounced_from; @swarm/engine bounces.ts), outside these rules.
 * - Only the Member can come back from unsubscribed, and only by confirming (member → active).
 * - Operators can't confirm on someone's behalf (pending → active), so consent stays the Member's.
 */
const TRANSITIONS: Record<MemberActor, Partial<Record<MemberStatus, readonly MemberStatus[]>>> = {
  operator: {
    pending: ['unsubscribed'],
    active: ['paused', 'unsubscribed'],
    paused: ['active', 'unsubscribed'],
  },
  member: {
    pending: ['active', 'unsubscribed'],
    active: ['paused', 'unsubscribed'],
    paused: ['active', 'unsubscribed'],
    unsubscribed: ['active'],
  },
  system: {
    pending: ['active', 'unsubscribed', 'bounced', 'complained'],
    active: ['paused', 'unsubscribed', 'bounced', 'complained'],
    paused: ['active', 'unsubscribed', 'bounced', 'complained'],
    unsubscribed: ['bounced', 'complained'],
    bounced: ['complained'],
  },
};

export function canTransition(from: MemberStatus, to: MemberStatus, actor: MemberActor): boolean {
  if (from === to) return false;
  return TRANSITIONS[actor][from]?.includes(to) ?? false;
}

/** The statuses `actor` may move a Member to from `from`. */
export function nextStatuses(from: MemberStatus, actor: MemberActor): readonly MemberStatus[] {
  return TRANSITIONS[actor][from] ?? [];
}

// ---------------------------------------------------------------------------------------------
// Profile fields and tags

const FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'select', 'multi_select'] as const;
export const FieldTypeSchema = z.enum(FIELD_TYPES).openapi('FieldType');
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const FieldKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lowercase letters, digits and underscores.');

export const MemberFieldSchema = z
  .object({
    id: id('memberField'),
    channelId: id('channel'),
    key: FieldKeySchema,
    label: z.string(),
    type: FieldTypeSchema,
    options: z.array(z.string()),
    encrypted: z.boolean(),
    position: z.number().int(),
    createdAt: timestamp,
  })
  .openapi('MemberField');
export type MemberField = z.infer<typeof MemberFieldSchema>;

/** A field value as the API carries it. Dates are YYYY-MM-DD. */
export const FieldValueSchema = z
  .union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(200)).max(50)])
  .nullable()
  .openapi('FieldValue');
export type FieldValue = z.infer<typeof FieldValueSchema>;

export const TagSchema = z
  .object({
    id: id('tag'),
    channelId: id('channel'),
    name: z.string(),
    memberCount: z.number().int(),
    createdAt: timestamp,
  })
  .openapi('Tag');
export type Tag = z.infer<typeof TagSchema>;

export const TagNameSchema = z.string().trim().min(1, 'Name the tag.').max(60);

// ---------------------------------------------------------------------------------------------
// Members

export const DIGESTS = ['every', 'weekly', 'monthly'] as const;
export const DigestSchema = z.enum(DIGESTS).openapi('Digest');

/** Attribution captured at sign-up. Keys are fixed; values are short strings. */
export const SourceSchema = z
  .object({
    utm_source: z.string().max(200),
    utm_medium: z.string().max(200),
    utm_campaign: z.string().max(200),
    utm_term: z.string().max(200),
    utm_content: z.string().max(200),
    referrer: z.string().max(2048),
    first_url: z.string().max(2048),
    current_url: z.string().max(2048),
    form_id: z.string().max(40),
    ref: z.string().max(40),
    import_id: z.string().max(40),
  })
  .partial()
  .openapi('MemberSource');
export type MemberSource = z.infer<typeof SourceSchema>;

/** On a Member whose encrypted fields the vault could not open just now (fail closed). */
export const EncryptedUnavailableSchema = z.boolean().optional().openapi({
  description:
    'True when this Member has encrypted profile fields that could not be decrypted just now (the key service did not answer): they read as null in `fields` this time, but still hold their values. Try again shortly. Absent otherwise.',
});

export const MemberSchema = z
  .object({
    id: id('member'),
    channelId: id('channel'),
    email: z.email(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    status: MemberStatusSchema,
    digest: DigestSchema,
    tags: z.array(z.string()),
    createdAt: timestamp,
    confirmedAt: timestamp.nullable(),
    pausedUntil: timestamp.nullable(),
    unsubscribedAt: timestamp.nullable(),
    emailsOffAt: timestamp.nullable().openapi({
      description:
        'When they chose “Stop emails, keep my membership” in their subscriber settings: posts and automation emails skip them, while receipts, sign-in links and billing notices still go. Their status and paid access are unchanged. Null: they receive emails.',
    }),
  })
  .openapi('Member');
export type Member = z.infer<typeof MemberSchema>;

/** What a person was shown and agreed to when they joined. */
const MemberConsentSchema = z
  .object({
    /**
     * 'import': an operator attested that everyone on an imported list agreed. 'checkout': the
     * address was given when paying, which agrees to nothing more; it still has to confirm.
     */
    source: z.enum(['form', 'operator', 'api', 'import', 'checkout']),
    formId: id('captureForm').nullable(),
    formVersion: z.number().int().nullable(),
    /** The consent text as shown; null when the form showed none. */
    wording: z.string().nullable(),
    /** Whether the box was ticked; null when there was no box. */
    ticked: z.boolean().nullable(),
    /** Whether this signup had to confirm by email. */
    mustConfirm: z.boolean(),
    /**
     * Imports: who attested, as an operator id, or `key:<id>` / `oauth:<id>` for an import
     * through the API. Null for other sources.
     */
    attestedBy: z.string().nullable(),
    /**
     * Form signups: the host Swarm itself verified (the hostname Turnstile reported for a pass
     * solved for this form, or the forms address when the person answered Swarm's own question).
     * Null for other sources and for records made before it was kept.
     */
    verifiedHost: z.string().nullable(),
    /**
     * Form signups: the site the submission said the form was on. Anyone sending the form by hand
     * can say anything here, so it is a claim, never proof.
     */
    claimedOrigin: z.string().nullable(),
    at: timestamp,
  })
  .openapi('MemberConsent');
export const MemberDetailSchema = MemberSchema.extend({
  source: SourceSchema,
  consents: z.array(MemberConsentSchema),
  formId: id('captureForm').nullable(),
  referredBy: id('member').nullable(),
  referralCount: z.number().int(),
  unsubscribeReason: z.string().nullable(),
  /** By field key. Encrypted values are returned decrypted to operators with access. */
  fields: z.record(z.string(), FieldValueSchema),
  encryptedUnavailable: EncryptedUnavailableSchema,
  /** The paid access the Member holds now (Phase 5), or null for the free level. */
  membership: MemberEntitlementSchema.nullable(),
  /** The engagement score, or null when it is off or hasn't been worked out yet. */
  engagement: MemberEngagementSchema.nullable(),
}).openapi('MemberDetail');
export type MemberDetail = z.infer<typeof MemberDetailSchema>;

export const CreateMemberSchema = z
  .object({
    email: EmailSchema,
    firstName: z.string().trim().max(80).nullable().optional(),
    lastName: z.string().trim().max(80).nullable().optional(),
    /**
     * Without it the Member starts pending; send a confirmation with POST /members/{id}/confirmation.
     * A Channel that requires confirmation ignores it: the Member starts pending and is emailed.
     */
    consent: z.boolean().optional(),
    tags: z.array(TagNameSchema).max(50).optional(),
    fields: z.record(FieldKeySchema, FieldValueSchema).optional(),
  })
  .openapi('CreateMember');
export type CreateMember = z.infer<typeof CreateMemberSchema>;
export const MemberCountsSchema = z
  .object(
    Object.fromEntries(MEMBER_STATUSES.map((s) => [s, z.number().int()])) as {
      [K in MemberStatus]: z.ZodNumber;
    },
  )
  .openapi('MemberCounts');
export type MemberCounts = z.infer<typeof MemberCountsSchema>;

// ---------------------------------------------------------------------------------------------
// Circle rules: a nested tree compiled to parameterised SQL (packages/engine)

export const CIRCLE_MAX_DEPTH = 20;
export const CIRCLE_MAX_LEAVES = 100;

export const CIRCLE_COMPARATORS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'starts_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not_in',
  'is_set',
  'is_not_set',
  'before',
  'after',
  'within_days',
  'not_within_days',
] as const;
const CircleComparatorSchema = z.enum(CIRCLE_COMPARATORS).openapi('CircleComparator');
export type CircleComparator = z.infer<typeof CircleComparatorSchema>;

/**
 * A leaf. `field` names what is tested:
 *   email, first_name, last_name, status, digest, created_at, confirmed_at, form_id,
 *   source.<utm_source|utm_medium|utm_campaign|utm_term|utm_content|referrer|ref>,
 *   field:<key>, tag, opened_days, clicked_days, referral_count,
 *   circle (a Circle id), level (a Membership level id; Phase 6),
 *   engagement_score (0 to 100) and engagement_band (Phase 8; a Member with no score matches neither)
 * The compiler whitelists these; anything else is refused.
 */
export interface CircleLeaf {
  field: string;
  cmp: CircleComparator;
  value?: string | number | boolean | (string | number)[] | null | undefined;
}
export interface CircleGroup {
  op: 'and' | 'or' | 'not';
  children: CircleRule[];
}
export type CircleRule = CircleGroup | CircleLeaf;

const LeafSchema = z.object({
  field: z.string().min(1).max(60),
  cmp: CircleComparatorSchema,
  value: z
    .union([
      z.string().max(500),
      z.number(),
      z.boolean(),
      z.array(z.union([z.string().max(200), z.number()])).max(100),
    ])
    .nullable()
    .optional(),
});

const RuleSchema: z.ZodType<CircleRule> = z.lazy(() =>
  z.union([
    z.object({
      op: z.enum(['and', 'or', 'not']),
      children: z.array(RuleSchema).min(1).max(50),
    }),
    LeafSchema,
  ]),
);

function measure(rule: CircleRule, depth = 1): { depth: number; leaves: number; badNot: boolean } {
  if (!('op' in rule)) return { depth, leaves: 1, badNot: false };
  return rule.children.reduce(
    (acc, child) => {
      const m = measure(child, depth + 1);
      return {
        depth: Math.max(acc.depth, m.depth),
        leaves: acc.leaves + m.leaves,
        badNot: acc.badNot || m.badNot,
      };
    },
    { depth, leaves: 0, badNot: rule.op === 'not' && rule.children.length !== 1 },
  );
}

export const CircleRuleSchema = RuleSchema.superRefine((rule, ctx) => {
  const { depth, leaves, badNot } = measure(rule);
  if (depth > CIRCLE_MAX_DEPTH) {
    ctx.addIssue({ code: 'custom', message: `Nest groups at most ${CIRCLE_MAX_DEPTH} deep.` });
  }
  if (leaves > CIRCLE_MAX_LEAVES) {
    ctx.addIssue({ code: 'custom', message: `Use at most ${CIRCLE_MAX_LEAVES} conditions.` });
  }
  if (badNot) {
    ctx.addIssue({ code: 'custom', message: '"Not" takes exactly one condition or group.' });
  }
}).openapi('CircleRule', { type: 'object', description: 'A group or a condition' });

// ---------------------------------------------------------------------------------------------
// Dispatch audiences

/**
 * Active Members in any `include` Circle (everyone when empty), minus any in an `exclude` one.
 * With the rosters flag, `rosters` also limits it to Roster subscribers (docs/rosters.md).
 */
export const DispatchAudienceSchema = z
  .object({
    include: z.array(id('circle')).max(20),
    exclude: z.array(id('circle')).max(20),
    rosters: RosterAudienceSchema.optional(),
  })
  .refine((a) => !a.include.some((c) => a.exclude.includes(c)), {
    message: 'A segment can’t be both included and excluded.',
  })
  .openapi('DispatchAudience');
export type DispatchAudience = z.infer<typeof DispatchAudienceSchema>;

export const EVERYONE: DispatchAudience = { include: [], exclude: [] };
