// Settings → Payments (Phase 5): the Channel's connected Stripe account (Connect Standard, 0%
// platform take). Shared by the api worker and the dashboard.
import { z } from '@hono/zod-openapi';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });

/** Days a past_due subscription keeps access before it is downgraded. */
export const MAX_GRACE_DAYS = 30;
export const PaymentsStatusSchema = z
  .object({
    /** False when no way of connecting Stripe is open on this deployment. */
    available: z.boolean(),
    /** Connect is set up on this deployment. */
    connectAvailable: z.boolean(),
    /** Owners can connect with a restricted key (flag stripe_own_key). */
    keyAvailable: z.boolean(),
    /** How the account is connected, while it is. */
    method: z.enum(['connect', 'key']).nullable(),
    /** The end of the saved restricted key. The key itself is never returned. */
    keyLast4: z.string().nullable(),
    /** True while a Stripe account is connected to this Channel. */
    connected: z.boolean(),
    state: z.enum(['not_connected', 'connected', 'disconnected']),
    stripeAccountId: z.string().nullable().openapi({ example: 'acct_1Q2w3E4r5T6y7U8i' }),
    chargesEnabled: z.boolean(),
    payoutsEnabled: z.boolean(),
    detailsSubmitted: z.boolean(),
    livemode: z.boolean(),
    /** Stripe Tax on Checkout (automatic_tax). */
    taxEnabled: z.boolean(),
    graceDays: z.number().int().min(0).max(MAX_GRACE_DAYS),
    defaultCurrency: z.string().length(3).nullable(),
    connectedAt: timestamp.nullable(),
    disconnectedAt: timestamp.nullable(),
  })
  .openapi('PaymentsStatus');
export type PaymentsStatus = z.infer<typeof PaymentsStatusSchema>;

export const UpdatePaymentsSchema = z
  .object({
    taxEnabled: z.boolean().optional(),
    graceDays: z.number().int().min(0).max(MAX_GRACE_DAYS).optional(),
  })
  .strict()
  .refine((value) => value.taxEnabled !== undefined || value.graceDays !== undefined, {
    message: 'Send taxEnabled, graceDays or both.',
  })
  .openapi('UpdatePayments');
export type UpdatePayments = z.infer<typeof UpdatePaymentsSchema>;

export const ConnectUrlSchema = z
  .object({
    /** Where to send the operator: Stripe's Connect OAuth page. */
    url: z.url(),
  })
  .openapi('PaymentsConnectUrl');
export type ConnectUrl = z.infer<typeof ConnectUrlSchema>;

export const StripeWebhookAckSchema = z
  .object({
    received: z.literal(true),
    /** 'duplicate' for an event id already processed; 'ignored' for one that isn't ours. */
    outcome: z.enum(['processed', 'ignored', 'duplicate']),
  })
  .openapi('StripeWebhookAck');
/**
 * Error codes the Connect callback puts on the dashboard redirect
 * (`/settings/payments?channel=<id>&error=<code>`).
 */
export type ConnectCallbackError =
  'cancelled' | 'state' | 'forbidden' | 'exchange' | 'account_in_use';

export const ConnectStripeKeySchema = z
  .object({
    apiKey: z.string().trim().min(10).max(255),
  })
  .openapi('ConnectStripeKey');
export type ConnectStripeKey = z.infer<typeof ConnectStripeKeySchema>;

export const PayPalStatusSchema = z
  .object({
    /** Owners can connect PayPal here (flag paypal_memberships). */
    available: z.boolean(),
    connected: z.boolean(),
    mode: z.enum(['live', 'sandbox']).nullable(),
    clientId: z.string().nullable(),
    /** The end of the saved secret. The secret itself is never returned. */
    secretLast4: z.string().nullable(),
    connectedAt: z.string().nullable(),
    /**
     * PayPal events this Channel's webhook received that never finished: failed, or still
     * claimed after five minutes. PayPal's retries and the lifecycle job's reconciliation catch
     * them up; a number that stays above 0 needs a look.
     */
    unfinishedEvents: z.number().int(),
  })
  .openapi('PayPalStatus');
export type PayPalStatus = z.infer<typeof PayPalStatusSchema>;

export const ConnectPayPalSchema = z
  .object({
    mode: z.enum(['live', 'sandbox']),
    clientId: z.string().trim().min(10).max(255),
    secret: z.string().trim().min(10).max(255),
  })
  .openapi('ConnectPayPal');
export type ConnectPayPal = z.infer<typeof ConnectPayPalSchema>;
