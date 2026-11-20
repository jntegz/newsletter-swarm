// Tracking choices and engagement retention (docs/privacy-controls.md). Tables:
// migrations/0063_tracking_choices.sql. The publication switches are on Channel (trackOpens,
// trackClicks, profileReaders); the subscriber's own choice is members.tracking_opt_out_at.
import { z } from '@hono/zod-openapi';

/**
 * The settings_json a new publication starts with: per-person open tracking, per-person click
 * tracking and reader profiles off (privacy by default; tracking pixels in email generally need
 * the reader's consent). A publisher turns them on in Sending & delivery > Tracking. Publications
 * made before this keep what they had: a switch is on unless settings_json says false.
 */
export const NEW_CHANNEL_SETTINGS = {
  trackOpens: false,
  trackClicks: false,
  profileReaders: false,
} as const;

/**
 * How long, in months, deliveries, opens, clicks and per-send copies of addresses stay tied to a
 * person. No "forever": every feature looks back 90 days at most, and a send report keeps its
 * numbers after the person is removed, so nothing needs the link for longer than a few years.
 */
export const ENGAGEMENT_RETENTION_MONTHS = [6, 13, 24, 36] as const;
export type EngagementRetentionMonths = (typeof ENGAGEMENT_RETENTION_MONTHS)[number];

const MonthsSchema = z
  .union([z.literal(6), z.literal(13), z.literal(24), z.literal(36)], {
    error: 'Pick 6, 13, 24 or 36 months.',
  })
  .openapi({ type: 'integer', enum: [...ENGAGEMENT_RETENTION_MONTHS] });

/** How long a departed subscriber's full profile is kept (packages/engine/src/lifetimes.ts). */
export const LEFT_MEMBER_RETENTION_MONTHS = [12, 24, 36, 60] as const;
export type LeftMemberRetentionMonths = (typeof LEFT_MEMBER_RETENTION_MONTHS)[number];

const LeftMonthsSchema = z
  .union([z.literal(12), z.literal(24), z.literal(36), z.literal(60)], {
    error: 'Pick 12, 24, 36 or 60 months.',
  })
  .openapi({ type: 'integer', enum: [...LEFT_MEMBER_RETENTION_MONTHS] });

/**
 * How long, in years after a payment, its provider reference (Stripe or PayPal payment id,
 * checkout session id) is kept once an erasure detached it from the person: only for the
 * publisher's accounting records, whose legal period differs by country.
 */
export const PAYMENT_RECORD_YEARS = [6, 7, 8, 10] as const;
export type PaymentRecordYears = (typeof PAYMENT_RECORD_YEARS)[number];

const PaymentYearsSchema = z
  .union([z.literal(6), z.literal(7), z.literal(8), z.literal(10)], {
    error: 'Pick 6, 7, 8 or 10 years.',
  })
  .openapi({ type: 'integer', enum: [...PAYMENT_RECORD_YEARS] });

/** How long a workspace's audit log is kept, on every plan (less where the plan keeps less). */
export const AUDIT_RETENTION_MONTHS = [12, 24, 36, 60] as const;
export type AuditRetentionMonths = (typeof AUDIT_RETENTION_MONTHS)[number];

const AuditMonthsSchema = z
  .union([z.literal(12), z.literal(24), z.literal(36), z.literal(60)], {
    error: 'Pick 12, 24, 36 or 60 months.',
  })
  .openapi({ type: 'integer', enum: [...AUDIT_RETENTION_MONTHS] });

export const EngagementRetentionSchema = z
  .object({
    months: MonthsSchema.openapi({
      description:
        'After this many months a delivery, its opens and clicks, and the per-send copy of the address no longer name the person. Counts on send reports stay.',
    }),
    leftMemberMonths: LeftMonthsSchema.openapi({
      description:
        'After this many months since someone unsubscribed, bounced or complained, their profile is reduced: names, profile fields, tags, source and activity events go; the address, status, dates and consent records stay so they are still not emailed. Default 24.',
    }),
    paymentRecordYears: PaymentYearsSchema.openapi({
      description:
        "After an erasure, a payment's provider id and a checkout's session id are kept for the publisher's accounting records, without the person, for this many years after the payment; then they are removed and the amounts stay. Choose your country's period for keeping accounting records. Default 10.",
    }),
    auditLogMonths: AuditMonthsSchema.openapi({
      description:
        "The audit log keeps entries for this many months (or less, where the workspace's plan keeps it for a shorter time), on every plan. Older entries are pruned and the rest of the hash chain still verifies. Default 24.",
    }),
  })
  .openapi('EngagementRetention');
export type EngagementRetention = z.infer<typeof EngagementRetentionSchema>;

export const UpdateEngagementRetentionSchema = z
  .object({
    months: MonthsSchema.optional(),
    leftMemberMonths: LeftMonthsSchema.optional(),
    paymentRecordYears: PaymentYearsSchema.optional(),
    auditLogMonths: AuditMonthsSchema.optional(),
  })
  .refine((v) => Object.values(v).some((value) => value !== undefined), {
    message: 'Say what to change.',
  })
  .openapi('UpdateEngagementRetention');
export type UpdateEngagementRetention = z.infer<typeof UpdateEngagementRetentionSchema>;

/**
 * Someone who appears in a workspace's records (its audit log or an accepted invitation) and no
 * longer holds a seat or publication role there. An owner can redact them: the workspace then
 * shows `email` as a placeholder (packages/engine/src/lifetimes.ts redactFormerTeammate).
 */
export const FormerTeammateSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    redacted: z.boolean(),
    lastActiveAt: z.string().nullable(),
  })
  .openapi('FormerTeammate');
export type FormerTeammate = z.infer<typeof FormerTeammateSchema>;
