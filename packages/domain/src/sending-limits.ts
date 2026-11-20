// Sending limits for the whole install: how much the email service lets this Swarm send. The
// service is shared by every workspace, so its limits are too. Edited under Settings > Instance by
// instance admins; table sending_limits (migrations/0066_sending_limits.sql). Every email takes
// its share from the realtime worker's SendPacer (packages/engine/src/sending-limits.ts asks it),
// so the limits hold across posts, automations, Direct Send and sign-in mail together.
// Contract: docs/self-hosting.md "Sending limits", docs/architecture.md "Pacing".
import { z } from '@hono/zod-openapi';
import type { MailServiceKey } from './instance';

export * from './limit-windows';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });

export const SENDING_LIMIT_BOUNDS = {
  perSecond: { min: 0.1, max: 1000 },
  window: { min: 10, max: 100_000_000 },
} as const;

const perSecond = z
  .number()
  .min(SENDING_LIMIT_BOUNDS.perSecond.min)
  .max(SENDING_LIMIT_BOUNDS.perSecond.max)
  .nullable();
const perWindow = z
  .number()
  .int()
  .min(SENDING_LIMIT_BOUNDS.window.min)
  .max(SENDING_LIMIT_BOUNDS.window.max)
  .nullable();

/** Null means no limit of that kind. */
const SendingLimitsSchema = z
  .object({
    perSecond: perSecond.openapi({
      description: 'Emails a second, from 0.1 to 1,000 with at most one decimal; null: no limit.',
      example: 2,
    }),
    perHour: perWindow.openapi({ description: 'Emails per UTC clock hour; null: no limit.' }),
    perDay: perWindow.openapi({
      description: 'Emails per UTC calendar day; null: no limit.',
      example: 100,
    }),
    perMonth: perWindow.openapi({
      description: 'Emails per UTC calendar month; null: no limit.',
      example: 3000,
    }),
  })
  .openapi('SendingLimits');
export type SendingLimits = z.infer<typeof SendingLimitsSchema>;

export const NO_SENDING_LIMITS: SendingLimits = {
  perSecond: null,
  perHour: null,
  perDay: null,
  perMonth: null,
};

export const UpdateSendingLimitsSchema = SendingLimitsSchema.superRefine((limits, ctx) => {
  const issue = (path: keyof SendingLimits, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if (
    limits.perSecond !== null &&
    Math.abs(limits.perSecond * 10 - Math.round(limits.perSecond * 10)) > 1e-9
  ) {
    issue('perSecond', 'Use at most one decimal, such as 0.5 or 2.');
  }
  if (limits.perHour !== null && limits.perDay !== null && limits.perHour > limits.perDay) {
    issue('perHour', 'An hour can’t allow more than the whole day.');
  }
  if (limits.perDay !== null && limits.perMonth !== null && limits.perDay > limits.perMonth) {
    issue('perDay', 'A day can’t allow more than the whole month.');
  }
  if (limits.perHour !== null && limits.perMonth !== null && limits.perHour > limits.perMonth) {
    issue('perHour', 'An hour can’t allow more than the whole month.');
  }
}).openapi('UpdateSendingLimits');
export type UpdateSendingLimits = z.infer<typeof UpdateSendingLimitsSchema>;

const SendingWindowUsageSchema = z
  .object({
    used: z.number().int().openapi({ description: 'Emails counted in this window so far' }),
    limit: z.number().int().nullable(),
    forSends: z.number().int().nullable().openapi({
      description:
        'What posts, automations and one-off Direct Sends may use; the rest is kept for email someone is waiting for. Null without a limit.',
    }),
    resetsAt: timestamp,
  })
  .openapi('SendingWindowUsage');
export type SendingWindowUsage = z.infer<typeof SendingWindowUsageSchema>;

/** The email service itself said its daily or monthly quota is used up. */
const ServiceQuotaWaitSchema = z
  .object({ window: z.enum(['day', 'month']), until: timestamp })
  .openapi('ServiceQuotaWait');

/** Instance admins only. */
export const InstanceSendingLimitsSchema = z
  .object({
    limits: SendingLimitsSchema,
    ceiling: z.number().nullable().openapi({
      description:
        'MAIL_MAX_PER_SECOND as the send worker last reported it. The lower of it and perSecond applies.',
    }),
    usage: z
      .object({
        hour: SendingWindowUsageSchema,
        day: SendingWindowUsageSchema,
        month: SendingWindowUsageSchema,
      })
      .nullable()
      .openapi({ description: 'Null when the counter could not be reached.' }),
    service: ServiceQuotaWaitSchema.nullable().openapi({
      description: 'Set while sends wait because the email service said its quota is used up.',
    }),
    waitingSends: z.number().int().openapi({
      description: 'Sends on this Swarm waiting for a limit, a quota or a person to resume them.',
    }),
    updatedBy: z.string().nullable(),
    updatedAt: timestamp.nullable(),
  })
  .openapi('InstanceSendingLimits');
export type InstanceSendingLimits = z.infer<typeof InstanceSendingLimitsSchema>;

/**
 * Starting points for the form. Each is a service's documented limit for a plan when this was
 * written, so the dashboard labels every one "check your plan".
 */
interface SendingLimitPreset {
  key: string;
  service: MailServiceKey;
  label: string;
  limits: SendingLimits;
}

export const SENDING_LIMIT_PRESETS: readonly SendingLimitPreset[] = [
  {
    key: 'resend_free',
    service: 'resend',
    label: 'Resend free plan: 2 a second, 100 a day, 3,000 a month',
    limits: { perSecond: 2, perHour: null, perDay: 100, perMonth: 3000 },
  },
  {
    key: 'resend_paid',
    service: 'resend',
    label: 'Resend paid plans: 2 a second, no daily limit',
    limits: { perSecond: 2, perHour: null, perDay: null, perMonth: null },
  },
  {
    key: 'ses_sandbox',
    service: 'ses',
    label: 'Amazon SES sandbox: 1 a second, 200 a day',
    limits: { perSecond: 1, perHour: null, perDay: 200, perMonth: null },
  },
  {
    key: 'mailgun_free',
    service: 'mailgun',
    label: 'Mailgun free plan: 100 a day',
    limits: { perSecond: null, perHour: null, perDay: 100, perMonth: null },
  },
  {
    key: 'postmark_free',
    service: 'postmark',
    label: 'Postmark free plan: 100 a month',
    limits: { perSecond: null, perHour: null, perDay: null, perMonth: 100 },
  },
];

// ---------------------------------------------------------------------------------------------
// A send waiting for a limit (broadcasts.waiting_for, 0066_sending_limits.sql)

/**
 * hour, day, month: this Swarm's own sending limits. service_day, service_month: the email
 * service said its own quota is used up. service_stopped: the service stopped accepting mail
 * (a suspended account, refused credentials, an unverified domain); Swarm tries it again by
 * itself (SERVICE_STOPPED_RETRY) and a person can resume sooner.
 */
export const SEND_WAIT_REASONS = [
  'hour',
  'day',
  'month',
  'service_day',
  'service_month',
  'service_stopped',
] as const;
export type SendWaitReason = (typeof SEND_WAIT_REASONS)[number];

/** Waits that hold the send until it is resumed (by the reaper at `until`, or by a person). */
export const PAUSING_WAITS: readonly SendWaitReason[] = [
  'month',
  'service_month',
  'service_stopped',
];

/**
 * A send the email service stopped (service_stopped) is tried again by itself with one email: the
 * first time after `firstMs`, then each time after as long as it has been stopped so far (so the
 * wait doubles), at most `maxMs` apart. When the service takes mail again, the whole send goes
 * on. After `giveUpMs` from when it stopped, it ends: a post's send is failed (partially failed
 * if some went), and an automation email's standing send stays open for the next subscribers.
 * Either way everyone still waiting is recorded as failed. docs/writing-and-sending.md.
 */
export const SERVICE_STOPPED_RETRY = {
  firstMs: 5 * 60_000,
  maxMs: 6 * 3_600_000,
  giveUpMs: 7 * 86_400_000,
} as const;

export const SendWaitSchema = z
  .object({
    reason: z.enum([...SEND_WAIT_REASONS, 'share']).openapi({
      description:
        'share: held for its workspace’s share of this Swarm’s sending capacity, because other workspaces are sending too or a very large send is admitted in parts. It goes on by itself; nothing needs fixing.',
    }),
    since: timestamp,
    until: timestamp.nullable().openapi({
      description:
        'When sending continues by itself; for service_stopped, when Swarm next tries the email service again. Null when a person must resume it.',
    }),
    left: z.number().int().openapi({ description: 'Recipients not sent yet' }),
    detail: z.string().nullable().openapi({
      description: 'What the email service said, for the service_ reasons; null otherwise.',
    }),
  })
  .openapi('SendWait');
export type SendWait = z.infer<typeof SendWaitSchema>;
