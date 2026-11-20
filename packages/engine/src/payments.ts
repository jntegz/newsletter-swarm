/**
 * Stripe webhook processing (Phase 5). The api worker verifies the signature and calls
 * `handleStripeEvent`; the site worker's dev checkout page calls it with synthetic events.
 *
 * Contract:
 * - idempotent: the event id is recorded in stripe_events first, keyed by the account it came
 *   through (one scope never claims, settles or suppresses another's); a duplicate in the same
 *   scope returns 'duplicate'.
 *   An event whose processing threw is stored as 'failed' and the error rethrown (the webhook
 *   answers 500 so Stripe retries); the retry reprocesses it. So does one stuck in 'received' for
 *   longer than STUCK_EVENT_MS (a worker that died mid-way).
 * - tenancy: a Connect event's `account` must map to a Channel in stripe_accounts, and every row it
 *   touches must belong to that Channel; anything else is 'ignored'. Platform events (no
 *   `account`) are ignored.
 * - checkout: only the checkout_sessions row named by the signed client_reference_id is trusted,
 *   never the session's metadata.
 * - out of order: a subscription event older than the row's stripe_updated_at changes nothing.
 * - after changing a Member's subscriptions it calls recomputeEntitlement.
 */
import type { MailAdapter } from '@swarm/mail';
import type { PrivacyKeys } from './vault-ports';
import type { SiteOriginConfig } from './config';
import type { GoodsLinkMinter, LinkKeys, MemberLinkMinter } from './links';
import { first, run } from './db';
import { handleCheckoutCompleted } from './payments-checkout';
import {
  handleAccountUpdated,
  handleChargeRefunded,
  handleDisputeCreated,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleSubscriptionEvent,
  handleTrialWillEnd,
  type EventScope,
} from './payments-sync';
import type { StripeApi, StripeEvent } from './stripe';

/** What Member-facing payment mail (Gift Pass claim links, trial notices) needs. */
export interface PaymentsMail {
  adapter: MailAdapter;
  /** Shared From domain for Channels without a verified sending domain. */
  platformMailDomain: string;
  /** Channel websites: the Gift Pass claim page lives on the Channel's platform address. */
  site: SiteOriginConfig;
  /** Public origin of the capture worker (Member Center links), without a trailing slash. */
  captureOrigin: string;
}

export interface PaymentsContext {
  db: D1Database;
  /** For follow-up reads on the connected account (subscription items, invoices). */
  stripe: StripeApi;
  /**
   * This worker's link keys: they verify the checkout reference (purpose 'checkout-ref') and sign
   * the confirmation a pending buyer is sent.
   */
  links: LinkKeys;
  /** Member Center links in payment mail; without it the mail links the page that sends one. */
  memberLinks?: MemberLinkMinter;
  /** Goods library links in the purchase mail; without it no library mail is sent. */
  goodsLinks?: GoodsLinkMinter;
  /** FIELD_KEYS, to recognise erased addresses (privacy.ts addressMarkers). */
  fieldKeys: PrivacyKeys;
  now: number;
  /**
   * Mail for Gift Pass claim links and trial notices. A paid Gift Pass can't be delivered without
   * it, so its checkout event fails (and is retried) when this is missing.
   */
  mail?: PaymentsMail;
}

export type StripeEventOutcome = 'processed' | 'ignored' | 'duplicate';

/** The event types the Connect webhook endpoint must be subscribed to. */
export const HANDLED_STRIPE_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'account.updated',
] as const;

/** An event left in 'received' this long is taken to have died mid-way and may be reprocessed. */
export const STUCK_EVENT_MS = 5 * 60 * 1000;

const EVENT_ID = /^evt_[A-Za-z0-9_]{1,250}$/;

export async function handleStripeEvent(
  ctx: PaymentsContext,
  event: StripeEvent,
): Promise<StripeEventOutcome> {
  if (
    typeof event.id !== 'string' ||
    !EVENT_ID.test(event.id) ||
    typeof event.type !== 'string' ||
    event.type.length > 120
  ) {
    return 'ignored';
  }
  const { db, now } = ctx;
  const account = typeof event.account === 'string' ? event.account : null;
  const created = Number.isFinite(event.created) ? event.created * 1000 : now;

  // Claim the event in its own scope (the account it came through): a new id, or one whose
  // earlier attempt in that scope failed or died. Another account's row is never touched, so a
  // tenant that can sign events for its own endpoint can't take over or settle someone else's.
  const scopeKey = account ?? '';
  const claimed = await first<{ event_id: string }>(
    db,
    `INSERT INTO stripe_events (event_id, stripe_account_id, type, livemode, status, created_at, received_at)
     VALUES (?1, ?2, ?3, ?4, 'received', ?5, ?6)
     ON CONFLICT (stripe_account_id, event_id) DO UPDATE SET status = 'received', error = NULL,
                                         processed_at = NULL, received_at = excluded.received_at
      WHERE stripe_events.status = 'failed'
         OR (stripe_events.status = 'received' AND stripe_events.received_at < ?7)
     RETURNING event_id`,
    event.id,
    scopeKey,
    event.type,
    event.livemode ? 1 : 0,
    created,
    now,
    now - STUCK_EVENT_MS,
  );
  if (!claimed) return 'duplicate';

  let channelId: string | null = null;
  try {
    const scope = await resolveScope(ctx, event, account, created);
    channelId = scope?.channelId ?? null;
    // The claim names its Channel before the work: it is the authority (a payment event) the
    // vault checks for the links and the own-key calls this event's handling needs.
    if (channelId) {
      await run(
        db,
        'UPDATE stripe_events SET channel_id = ?1 WHERE event_id = ?2 AND stripe_account_id = ?3',
        channelId,
        event.id,
        scopeKey,
      );
    }
    const outcome = scope ? await dispatch(scope) : 'ignored';
    await run(
      db,
      `UPDATE stripe_events SET status = ?1, channel_id = ?2, processed_at = ?3
        WHERE event_id = ?4 AND stripe_account_id = ?5`,
      outcome,
      channelId,
      ctx.now,
      event.id,
      scopeKey,
    );
    return outcome;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    await run(
      db,
      `UPDATE stripe_events SET status = 'failed', error = ?1, channel_id = ?2
        WHERE event_id = ?3 AND stripe_account_id = ?4`,
      message,
      channelId,
      event.id,
      scopeKey,
    ).catch(() => undefined);
    throw error;
  }
}

async function resolveScope(
  ctx: PaymentsContext,
  event: StripeEvent,
  account: string | null,
  eventAt: number,
): Promise<EventScope | null> {
  if (!account) return null;
  const row = await first<{
    channel_id: string;
    workspace_id: string;
    grace_days: number;
    livemode: number;
  }>(
    ctx.db,
    'SELECT channel_id, workspace_id, grace_days, livemode FROM stripe_accounts WHERE stripe_account_id = ?1',
    account,
  );
  // A test-mode event never changes a live account, nor the other way round.
  if (!row || row.livemode !== (event.livemode ? 1 : 0)) return null;
  const object = event.data?.object;
  if (!object || typeof object !== 'object') return null;
  return {
    ctx,
    event,
    object,
    accountId: account,
    channelId: row.channel_id,
    workspaceId: row.workspace_id,
    graceDays: row.grace_days,
    eventAt,
  };
}

async function dispatch(scope: EventScope): Promise<'processed' | 'ignored'> {
  switch (scope.event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(scope);
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return handleSubscriptionEvent(scope, false);
    case 'customer.subscription.deleted':
      return handleSubscriptionEvent(scope, true);
    case 'customer.subscription.trial_will_end':
      return handleTrialWillEnd(scope);
    case 'invoice.paid':
      return handleInvoicePaid(scope);
    case 'invoice.payment_failed':
      return handleInvoicePaymentFailed(scope);
    case 'charge.refunded':
      return handleChargeRefunded(scope);
    case 'charge.dispute.created':
      return handleDisputeCreated(scope);
    case 'account.updated':
      return handleAccountUpdated(scope);
    default:
      return 'ignored';
  }
}
