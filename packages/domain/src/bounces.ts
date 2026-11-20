// Bounce rules: what Swarm does when an email turns out undeliverable. One policy per workspace,
// because a bounce suppression is workspace-wide. Contract: docs/deliverability.md "Bounces";
// tables: migrations/0067_bounce_policy.sql. The classifier is @swarm/engine bounce-classifier.ts,
// the rules bounces.ts. Complaints are not part of the policy: the first one always stops mailing.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';

const timestamp = z.iso.datetime().openapi({ example: '2026-11-16T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));
const count = z.number().int().min(0);

/**
 * hard: the address will never work. soft: it may work later. blocked: the receiving server
 * refused because of the sender (reputation, a blocklist, content, authentication), not the
 * address. A blocked email never stops mailing anyone.
 */
const BOUNCE_KINDS = ['hard', 'soft', 'blocked'] as const;
export type BounceKind = (typeof BOUNCE_KINDS)[number];

/** Why an email bounced, as the classifier read it. Each cause belongs to one kind. */
const BOUNCE_CAUSES = [
  // hard
  'no_mailbox',
  'no_domain',
  'provider_list',
  'rejected',
  // soft
  'mailbox_full',
  'mailbox_unavailable',
  'too_large',
  'greylisted',
  'temporary',
  'unknown',
  // blocked
  'reputation',
  'blocklist',
  'content',
  'authentication',
  'rate_limited',
  'policy',
] as const;
export type BounceCause = (typeof BOUNCE_CAUSES)[number];

export const BOUNCE_CAUSE_KIND: Record<BounceCause, BounceKind> = {
  no_mailbox: 'hard',
  no_domain: 'hard',
  provider_list: 'hard',
  rejected: 'hard',
  mailbox_full: 'soft',
  mailbox_unavailable: 'soft',
  too_large: 'soft',
  greylisted: 'soft',
  temporary: 'soft',
  unknown: 'soft',
  reputation: 'blocked',
  blocklist: 'blocked',
  content: 'blocked',
  authentication: 'blocked',
  rate_limited: 'blocked',
  policy: 'blocked',
};

/**
 * Each cause in the dashboard's words. Shown on the subscriber's page, under Blocked addresses
 * and Needs your attention, and in the email to owners and admins.
 */
export const BOUNCE_CAUSE_TEXT: Record<BounceCause, string> = {
  no_mailbox: 'The address doesn’t exist',
  no_domain: 'The domain doesn’t exist or takes no email',
  provider_list: 'Your email service refuses the address after an earlier hard bounce',
  rejected: 'The receiving server refused the address for good',
  mailbox_full: 'The mailbox is full',
  mailbox_unavailable: 'The mailbox is turned off or not available for now',
  too_large: 'The email was too large for the mailbox',
  greylisted: 'The receiving server asked to try again later',
  temporary: 'A temporary problem at the receiving server',
  unknown: 'The email service gave no clear reason',
  reputation: 'Refused because of your sending reputation',
  blocklist: 'Refused because your domain or sending server is on a blocklist',
  content: 'Refused because of what was in the email',
  authentication: 'Refused because the email failed SPF, DKIM or DMARC',
  rate_limited: 'Refused because too much email arrived from you at once',
  policy: 'Refused by the receiving server’s own rules',
};

export const BOUNCE_KIND_LABEL: Record<BounceKind, string> = {
  hard: 'Hard bounce',
  soft: 'Soft bounce',
  blocked: 'Blocked',
};

/** Which rule stopped mailing an address (or would have, for a paid plan held for an admin). */
const BOUNCE_STOP_RULES = ['hard', 'hard_repeat', 'soft_streak', 'soft_window'] as const;
export type BounceStopRule = (typeof BOUNCE_STOP_RULES)[number];

export const BOUNCE_LIMITS = {
  softStreakMin: 2,
  softStreakMax: 10,
  softWindowCountMin: 2,
  softWindowCountMax: 10,
  softWindowDays: [7, 14, 30, 60, 90] as const,
  /** "After 2 hard bounces" counts hard bounces within this many days. */
  hardRepeatDays: 30,
  /** Bounce history is kept this long, for the rules, the preview and the subscriber's page. */
  historyDays: 90,
  /** Addresses "Apply to past bounces too" stops in one save; saving again does the rest. */
  applyBatch: 500,
  /** Bounces listed on a subscriber's page. */
  memberEvents: 10,
} as const;

/** "after 3 emails in a row bounced softly": what a rule counted, for the dashboard and notices. */
export function bounceRuleReason(
  rule: BounceStopRule,
  counted: number | null,
  days: number | null,
): string {
  switch (rule) {
    case 'hard':
      return 'a hard bounce';
    case 'hard_repeat':
      return `${counted ?? 2} hard bounces within ${days ?? BOUNCE_LIMITS.hardRepeatDays} days`;
    case 'soft_streak':
      return `${counted ?? BOUNCE_LIMITS.softStreakMin} emails in a row bounced softly`;
    case 'soft_window':
      return `${counted ?? BOUNCE_LIMITS.softWindowCountMin} soft bounces within ${days ?? 7} days`;
  }
}

// ---------------------------------------------------------------------------------------------
// The policy

const SoftStreakSchema = z
  .number()
  .int()
  .min(BOUNCE_LIMITS.softStreakMin, 'Pick 2 to 10 emails.')
  .max(BOUNCE_LIMITS.softStreakMax, 'Pick 2 to 10 emails.');

export const BouncePolicySchema = z
  .object({
    hardBounces: z
      .union([z.literal(1), z.literal(2)], { error: 'Pick 1 or 2 hard bounces.' })
      .openapi({
        type: 'integer',
        enum: [1, 2],
        description:
          '1: stop mailing an address at its first hard bounce. 2: only after a second hard bounce within 30 days.',
      }),
    softStreak: SoftStreakSchema.nullable().openapi({
      description:
        'Stop after this many emails in a row bounced softly (a delivered email starts the count again). Null: this rule is off.',
    }),
    softWindow: z
      .object({
        count: z
          .number()
          .int()
          .min(BOUNCE_LIMITS.softWindowCountMin, 'Pick 2 to 10 soft bounces.')
          .max(BOUNCE_LIMITS.softWindowCountMax, 'Pick 2 to 10 soft bounces.'),
        days: z
          .union([z.literal(7), z.literal(14), z.literal(30), z.literal(60), z.literal(90)], {
            error: 'Pick 7, 14, 30, 60 or 90 days.',
          })
          .openapi({ type: 'integer', enum: [...BOUNCE_LIMITS.softWindowDays] }),
      })
      .nullable()
      .openapi({
        description:
          'Also stop after this many soft bounces within this many days, delivered emails or not. Null: this rule is off. With both soft rules off, soft bounces never stop mailing.',
      }),
    askForPaid: z.boolean().openapi({
      description:
        'For a subscriber on a paid plan, list them for an admin and email the owners and admins instead of stopping.',
    }),
  })
  .openapi('BouncePolicy');
export type BouncePolicy = z.infer<typeof BouncePolicySchema>;

/** The recommended rules, and what a workspace that never chose has. */
export const DEFAULT_BOUNCE_POLICY: BouncePolicy = {
  hardBounces: 1,
  softStreak: 3,
  softWindow: null,
  askForPaid: true,
};

export const BouncePolicySettingsSchema = BouncePolicySchema.extend({
  /** When an admin last saved the rules; null while the workspace has the defaults. */
  updatedAt: timestamp.nullable(),
}).openapi('BouncePolicySettings');
export type BouncePolicySettings = z.infer<typeof BouncePolicySettingsSchema>;

export const UpdateBouncePolicySchema = BouncePolicySchema.extend({
  /** Also apply the new rules to stored bounce history now, not only from the next bounce. */
  applyToPast: z.boolean().default(false),
}).openapi('UpdateBouncePolicy');
export type UpdateBouncePolicy = z.input<typeof UpdateBouncePolicySchema>;

const ByRuleSchema = z.object({
  hard: count,
  hard_repeat: count,
  soft_streak: count,
  soft_window: count,
});

export const BouncePreviewSchema = z
  .object({
    /** Addresses still being mailed that these rules would stop now. */
    stopped: count,
    /** Of the addresses these rules match, those on a paid plan that would be listed instead. */
    held: count,
    byRule: ByRuleSchema,
  })
  .openapi('BouncePreview');
export type BouncePreview = z.infer<typeof BouncePreviewSchema>;

export const BouncePolicySavedSchema = BouncePolicySettingsSchema.extend({
  /** With applyToPast: what this save did. `remaining` addresses wait for the next save. */
  applied: z.object({ stopped: count, held: count, remaining: count }).nullable(),
}).openapi('BouncePolicySaved');
export type BouncePolicySaved = z.infer<typeof BouncePolicySavedSchema>;

// ---------------------------------------------------------------------------------------------
// Bounces of one address, holds and decisions

const BounceEventSchema = z
  .object({
    kind: z.enum(BOUNCE_KINDS),
    cause: z.enum(BOUNCE_CAUSES),
    /** The receiving server's status code, such as 5.1.1 or 452; null when none was given. */
    code: z.string().nullable(),
    /** What the receiving server said, as the email service passed it on. */
    detail: z.string().nullable(),
    at: timestamp,
  })
  .openapi('BounceEvent');
export type BounceEvent = z.infer<typeof BounceEventSchema>;

/** How a bounce stopped mailing an address, on a suppression made by the bounce rules. */
export const SuppressionBounceSchema = z
  .object({
    rule: z.enum(BOUNCE_STOP_RULES),
    cause: z.enum(BOUNCE_CAUSES).nullable(),
    counted: z.number().int().nullable(),
    days: z.number().int().nullable(),
  })
  .openapi('SuppressionBounce');

/**
 * A subscriber on a paid plan whose address the rules would stop: waiting for an admin, and still
 * being mailed.
 */
export const BounceHoldSchema = z
  .object({
    id: id('bounceState'),
    email: z.string(),
    /** The publication's subscriber with this address, when there is one. */
    memberId: id('member').nullable(),
    rule: z.enum(BOUNCE_STOP_RULES),
    counted: z.number().int().nullable(),
    days: z.number().int().nullable(),
    last: BounceEventSchema,
    heldAt: timestamp,
  })
  .openapi('BounceHold');
export type BounceHold = z.infer<typeof BounceHoldSchema>;

export const BounceHoldDecisionSchema = z
  .object({
    /** stop: stop mailing the address now. keep: keep mailing it and start the counts again. */
    decision: z.enum(['stop', 'keep']),
  })
  .openapi('BounceHoldDecision');
export type BounceHoldDecision = z.infer<typeof BounceHoldDecisionSchema>;

/** A subscriber's address as the bounce rules see it, for their page. */
export const MemberBouncesSchema = z
  .object({
    /** Emails in a row that bounced softly, counted since the last delivered one. */
    softStreak: count,
    /** Set while the address waits for an admin (a paid plan). */
    held: z
      .object({
        rule: z.enum(BOUNCE_STOP_RULES),
        counted: z.number().int().nullable(),
        days: z.number().int().nullable(),
        heldAt: timestamp,
      })
      .nullable(),
    /** The workspace-wide bounce suppression, when the rules stopped mailing the address. */
    stopped: z
      .object({
        suppressionId: id('suppression'),
        reason: z.enum(['hard_bounce', 'soft_bounce']),
        bounce: SuppressionBounceSchema.nullable(),
        detail: z.string().nullable(),
        createdAt: timestamp,
      })
      .nullable(),
    /** Newest first, at most BOUNCE_LIMITS.memberEvents, from the last 90 days. */
    events: z.array(BounceEventSchema),
  })
  .openapi('MemberBounces');
export type MemberBounces = z.infer<typeof MemberBouncesSchema>;
