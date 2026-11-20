/**
 * checkout.session.completed: the purchase a reader made on the Channel site. The only trusted
 * input is the signed client_reference_id (the checkout_sessions row it names, and whether that
 * row's Member made the checkout signed in); the session's metadata, which the owner of the
 * connected account could set to anything, is never read.
 *
 * The buyer becomes (or is linked to) a Member, but paying never stands in for confirming an
 * address: whoever pays can type any address. An existing Member keeps the status it has (a
 * pending one stays pending until its address confirms), and a new Member starts pending with
 * no consent or confirmation time, a consent record naming the checkout as its source, and the
 * usual confirmation email. The purchase is credited to that Member either way, and is usable
 * once its holder signs in, which needs a confirmed address. Someone who unsubscribed, bounced
 * or complained keeps that email status and still gets what they paid for.
 */
import { appendAudit } from '@swarm/db';
import type { MemberStatus } from '@swarm/domain';
import type { LinkSigner } from './links';
import { first, newIdFor, run } from './db';
import { sendConfirmation } from './confirm';
import { recordConsent } from './consents';
import { recordMemberEvents } from './events';
import {
  GIFT_CLAIM_DAYS,
  hashGiftClaimToken,
  newGiftClaimToken,
  sendGiftPassMail,
  sendGoodsLibraryMail,
} from './payments-mail';
import {
  DAY_MS,
  applyStripeSubscription,
  fetchSubscription,
  idOf,
  num,
  obj,
  recompute,
  recordPayment,
  str,
  type EventScope,
  type LedgerScope,
} from './payments-sync';
import { isErasedAddress } from './privacy';
import { readCheckoutClaims, signedCheckoutReference } from './stripe';
import { markGoodOrderPaid } from './goods';
import type { PaymentsMail } from './payments';

interface CheckoutRow {
  reference: string;
  stripe_session_id: string | null;
  channel_id: string;
  subject_id: string | null;
  level_id: string | null;
  price_id: string | null;
  member_id: string | null;
  email: string | null;
  intent: 'subscribe' | 'lifetime' | 'gift' | 'pledge' | 'tip' | 'good';
  status: 'open' | 'complete' | 'expired';
}

/** What choosing a buyer reads from a checkout row. */
export type BuyerRow = Pick<CheckoutRow, 'reference' | 'member_id' | 'email'>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function buyerEmail(session: Record<string, unknown>, row: CheckoutRow): string | null {
  const candidates = [
    str(obj(session, 'customer_details'), 'email'),
    str(session, 'customer_email'),
    row.email,
  ];
  for (const candidate of candidates) {
    const email = candidate?.trim().toLowerCase();
    if (email && email.length <= 254 && EMAIL.test(email)) return email;
  }
  return null;
}

const SUPPRESSED_STATUS: Record<string, MemberStatus> = {
  hard_bounce: 'bounced',
  soft_bounce: 'bounced',
  complaint: 'complained',
  manual: 'unsubscribed',
};

/**
 * The Member who bought: the row's Member, else the one with the buyer's email, else (when
 * `create`) a new pending Member. Null when there's no usable email, or it was erased (Privacy
 * Center). No existing Member's status changes here: a typed or provider-reported address proves
 * nothing about who paid. Buying a gift or a tip signs nobody up.
 */
export async function resolveBuyer(
  scope: LedgerScope,
  row: BuyerRow,
  email: string | null,
  create: boolean,
): Promise<string | null> {
  return (await findBuyer(scope, row, email, create))?.id ?? null;
}

/** resolveBuyer, also saying whether this checkout created the Member. */
async function findBuyer(
  scope: LedgerScope,
  row: BuyerRow,
  email: string | null,
  create: boolean,
): Promise<{ id: string; created: boolean } | null> {
  const { db, now } = scope.ctx;
  if (row.member_id) {
    const own = await first<{ id: string }>(
      db,
      'SELECT id FROM members WHERE id = ?1 AND channel_id = ?2',
      row.member_id,
      scope.channelId,
    );
    if (own) return { id: own.id, created: false };
  }
  if (!email) return null;
  const existing = await first<{ id: string }>(
    db,
    'SELECT id FROM members WHERE channel_id = ?1 AND email = ?2',
    scope.channelId,
    email,
  );
  if (existing) return { id: existing.id, created: false };
  if (!create) return null;
  // An erased address (Privacy Center) never becomes a Member again.
  if (await isErasedAddress(db, scope.workspaceId, email, scope.ctx.fieldKeys)) return null;

  // A suppressed address gets its entitlement but is never mailed Broadcasts. Anyone else starts
  // pending: the address was typed, so its holder has agreed to nothing until they confirm.
  const suppression = await first<{ reason: string }>(
    db,
    `SELECT reason FROM suppressions WHERE workspace_id = ?1 AND email = ?2
        AND (channel_id IS NULL OR channel_id = ?3) ORDER BY channel_id IS NOT NULL LIMIT 1`,
    scope.workspaceId,
    email,
    scope.channelId,
  );
  const status: MemberStatus = suppression
    ? (SUPPRESSED_STATUS[suppression.reason] ?? 'unsubscribed')
    : 'pending';
  const id = newIdFor('member', now);
  const created = await first<{ id: string }>(
    db,
    `INSERT INTO members (id, channel_id, email, status, source_json, unsubscribed_at, created_at,
                          updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?7, ?6, ?6)
     ON CONFLICT (channel_id, email) DO NOTHING RETURNING id`,
    id,
    scope.channelId,
    email,
    status,
    JSON.stringify({ kind: 'checkout', reference: row.reference }),
    now,
    status === 'unsubscribed' ? now : null,
  );
  if (created) {
    // What happened: an address was given at a checkout, and it still has to be confirmed.
    await recordConsent(
      db,
      created.id,
      { source: 'checkout', formId: null, wording: null, ticked: null, mustConfirm: true },
      now,
    );
    await recordMemberEvents(
      db,
      [{ type: 'member_joined', memberId: created.id, payload: { source: 'checkout', status } }],
      now,
    );
    return { id: created.id, created: true };
  }
  const raced = await first<{ id: string }>(
    db,
    'SELECT id FROM members WHERE channel_id = ?1 AND email = ?2',
    scope.channelId,
    email,
  );
  return raced ? { id: raced.id, created: false } : null;
}

/**
 * After a purchase is credited to a pending Member, mails the usual confirmation to its address,
 * so the holder (whoever paid) can confirm and then sign in to use it. Never fails the payment
 * event: the Member can still confirm from any later confirmation mail.
 */
export async function askBuyerToConfirm(
  ctx: { db: D1Database; now: number; links: LinkSigner; mail?: PaymentsMail | undefined },
  memberId: string | null,
): Promise<void> {
  if (!memberId || !ctx.mail) return;
  const member = await first<{ status: string }>(
    ctx.db,
    'SELECT status FROM members WHERE id = ?1',
    memberId,
  );
  if (member?.status !== 'pending') return;
  await sendConfirmation(
    {
      db: ctx.db,
      mail: ctx.mail.adapter,
      links: ctx.links,
      captureOrigin: ctx.mail.captureOrigin,
      platformMailDomain: ctx.mail.platformMailDomain,
      now: () => ctx.now,
    },
    { memberId, kind: 'subscribe' },
  ).catch(() => undefined);
}

/**
 * Links the session's customer to the buyer, but to a Member who already existed only when that
 * Member made the checkout signed in: a typed email proves nothing, and the linked customer opens
 * the Member's billing portal and is reused by their later checkouts.
 */
async function linkCustomer(
  scope: EventScope,
  buyer: { id: string; created: boolean },
  ownCheckout: boolean,
  customerId: string | null,
) {
  if (!customerId?.startsWith('cus_')) return;
  if (!buyer.created && !ownCheckout) return;
  // First link wins: a Member keeps one customer per Channel, a customer one Member.
  await run(
    scope.ctx.db,
    `INSERT INTO stripe_customers (member_id, channel_id, stripe_customer_id, created_at)
     VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING`,
    buyer.id,
    scope.channelId,
    customerId,
    scope.ctx.now,
  );
}

async function auditGrant(
  scope: EventScope,
  subscriptionId: string,
  memberId: string,
  detail: Record<string, unknown>,
) {
  await appendAudit(scope.ctx.db, {
    workspaceId: scope.workspaceId,
    actorId: null,
    action: 'member_subscription.granted',
    targetType: 'member_subscription',
    targetId: subscriptionId,
    metadata: { memberId, stripeEvent: scope.event.id, ...detail },
  });
}

async function periodFallback(scope: EventScope, row: CheckoutRow): Promise<number> {
  const price = row.price_id
    ? await first<{ interval: string }>(
        scope.ctx.db,
        'SELECT interval FROM level_prices WHERE id = ?1 AND channel_id = ?2',
        row.price_id,
        scope.channelId,
      )
    : null;
  return scope.ctx.now + (price?.interval === 'year' ? 365 : 31) * DAY_MS;
}

async function completeSubscribe(
  scope: EventScope,
  session: Record<string, unknown>,
  row: CheckoutRow,
  memberId: string,
  email: string | null,
): Promise<boolean> {
  const stripeSubId = idOf(session, 'subscription');
  if (!stripeSubId?.startsWith('sub_')) return false;
  const hint = { memberId, levelId: row.level_id, priceId: row.price_id };
  const fresh = await fetchSubscription(scope, stripeSubId);
  let subscriptionId: string | null = null;
  let trialing = false;
  if (fresh) {
    const result = await applyStripeSubscription(scope, fresh, scope.ctx.now, { hint });
    if (result.applied) subscriptionId = result.subscriptionId;
    trialing = str(fresh, 'status') === 'trialing' || num(fresh, 'trial_end') !== null;
  } else {
    // The dev fake answers without a subscription body: grant one period from the checkout row.
    const existing = await first<{ id: string; channel_id: string }>(
      scope.ctx.db,
      'SELECT id, channel_id FROM member_subscriptions WHERE stripe_subscription_id = ?1',
      stripeSubId,
    );
    if (existing && existing.channel_id !== scope.channelId) return false;
    if (!existing) {
      subscriptionId = newIdFor('memberSubscription', scope.ctx.now);
      const price = row.price_id
        ? await first<{ interval: string; currency: string; amount: number }>(
            scope.ctx.db,
            'SELECT interval, currency, amount FROM level_prices WHERE id = ?1 AND channel_id = ?2',
            row.price_id,
            scope.channelId,
          )
        : null;
      await run(
        scope.ctx.db,
        `INSERT INTO member_subscriptions (id, channel_id, member_id, level_id, price_id, source, status,
                stripe_subscription_id, stripe_customer_id, interval, currency, amount,
                current_period_end, stripe_updated_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'stripe', 'active', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?12)`,
        subscriptionId,
        scope.channelId,
        memberId,
        row.level_id,
        row.price_id,
        stripeSubId,
        idOf(session, 'customer'),
        price?.interval === 'year' || price?.interval === 'month' ? price.interval : null,
        price?.currency ?? null,
        price?.amount ?? null,
        await periodFallback(scope, row),
        scope.ctx.now,
      );
    } else {
      subscriptionId = existing.id;
    }
  }
  if (trialing && email) {
    // One trial per email per Channel; the site checks this before offering one.
    await run(
      scope.ctx.db,
      `INSERT INTO trial_claims (channel_id, email, level_id, created_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT DO NOTHING`,
      scope.channelId,
      email,
      row.level_id,
      scope.ctx.now,
    );
  }
  if (subscriptionId) {
    await auditGrant(scope, subscriptionId, memberId, { intent: 'subscribe', trialing });
  }
  return subscriptionId !== null;
}

async function completeLifetime(
  scope: EventScope,
  session: Record<string, unknown>,
  row: CheckoutRow,
  memberId: string,
): Promise<void> {
  const { db, now } = scope.ctx;
  const id = newIdFor('memberSubscription', now);
  const currency = str(session, 'currency');
  const amount = num(session, 'amount_total');
  await run(
    db,
    `INSERT INTO member_subscriptions (id, channel_id, member_id, level_id, price_id, source, status,
            stripe_customer_id, interval, currency, amount, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'lifetime', 'lifetime', ?6, 'lifetime', ?7, ?8, ?9, ?9)`,
    id,
    scope.channelId,
    memberId,
    row.level_id,
    row.price_id,
    idOf(session, 'customer'),
    currency && currency.length === 3 ? currency.toLowerCase() : null,
    amount,
    now,
  );
  if (amount !== null && amount > 0) {
    await recordPayment(scope, {
      memberId,
      subscriptionId: id,
      kind: 'one_time',
      // The payment intent, so a refund of its charge finds this row.
      stripeObjectId: idOf(session, 'payment_intent') ?? (str(session, 'id') as string),
      currency,
      amount,
      occurredAt: now,
    });
  }
  await auditGrant(scope, id, memberId, { intent: 'lifetime' });
}

async function completeGood(
  scope: EventScope,
  session: Record<string, unknown>,
  row: CheckoutRow,
  email: string | null,
): Promise<boolean> {
  const { db, now } = scope.ctx;
  if (!row.subject_id) return false;
  // Buying doesn't sign anyone up; an existing Member is linked.
  const member = await resolveBuyer(scope, row, email, false);
  const paymentIntentId = idOf(session, 'payment_intent');
  const order = await markGoodOrderPaid(db, {
    orderId: row.subject_id,
    channelId: scope.channelId,
    workspaceId: scope.workspaceId,
    memberId: member,
    sessionId: str(session, 'id'),
    paymentIntentId,
    now,
  });
  // Already handled: Stripe sent the event again.
  if (!order) return true;
  const amount = num(session, 'amount_total');
  if (amount !== null && amount > 0) {
    await recordPayment(scope, {
      memberId: order.memberId,
      subscriptionId: null,
      kind: 'one_time',
      stripeObjectId: paymentIntentId ?? (str(session, 'id') as string),
      currency: str(session, 'currency'),
      amount,
      occurredAt: now,
    });
  }
  const good = await first<{ name: string }>(
    db,
    'SELECT name FROM goods WHERE id = ?1',
    order.goodId,
  );
  // The buyer paid either way, and the thank-you page and the library can both give the link again.
  await sendGoodsLibraryMail(scope.ctx, {
    channelId: scope.channelId,
    to: order.email,
    orderId: order.id,
    goodName: good?.name ?? null,
  }).catch(() => undefined);
  return true;
}

async function completeGift(
  scope: EventScope,
  session: Record<string, unknown>,
  row: CheckoutRow,
  email: string | null,
): Promise<boolean> {
  const { db, now } = scope.ctx;
  if (!row.subject_id) return false;
  const pass = await first<{
    id: string;
    level_id: string | null;
    months: number;
    purchaser_email: string;
    recipient_email: string | null;
    message: string | null;
  }>(
    db,
    `SELECT id, level_id, months, purchaser_email, recipient_email, message FROM gift_passes
      WHERE id = ?1 AND channel_id = ?2 AND status = 'pending_payment'`,
    row.subject_id,
    scope.channelId,
  );
  if (!pass) return false;
  const token = newGiftClaimToken();
  const claimBy = now + GIFT_CLAIM_DAYS * DAY_MS;
  // The buyer is linked when already a Member; buying a gift doesn't sign anyone up.
  const purchaser = await resolveBuyer(scope, row, email, false);
  const updated = await first<{ id: string }>(
    db,
    `UPDATE gift_passes SET status = 'paid', claim_token_hash = ?1, claim_by = ?2,
            checkout_session_id = ?3, purchaser_member_id = coalesce(purchaser_member_id, ?4)
      WHERE id = ?5 AND channel_id = ?6 AND status = 'pending_payment' RETURNING id`,
    await hashGiftClaimToken(token),
    claimBy,
    str(session, 'id'),
    purchaser,
    pass.id,
    scope.channelId,
  );
  if (!updated) return false;
  const amount = num(session, 'amount_total');
  if (amount !== null && amount > 0) {
    await recordPayment(scope, {
      memberId: purchaser,
      subscriptionId: null,
      kind: 'one_time',
      stripeObjectId: idOf(session, 'payment_intent') ?? (str(session, 'id') as string),
      currency: str(session, 'currency'),
      amount,
      occurredAt: now,
    });
  }
  try {
    await sendGiftPassMail(scope.ctx, {
      channelId: scope.channelId,
      giftPassId: pass.id,
      to: pass.recipient_email ?? pass.purchaser_email,
      toRecipient: !!pass.recipient_email,
      purchaserEmail: pass.purchaser_email,
      months: pass.months,
      levelId: pass.level_id,
      message: pass.message,
      token,
      claimBy,
    });
  } catch (error) {
    // Only the hash is stored, so an undelivered link is lost: put the pass back so Stripe's
    // retry of this event pays it out again with a new link.
    await run(
      db,
      `UPDATE gift_passes SET status = 'pending_payment', claim_token_hash = NULL, claim_by = NULL
        WHERE id = ?1 AND channel_id = ?2`,
      pass.id,
      scope.channelId,
    );
    throw error;
  }
  return true;
}

export async function handleCheckoutCompleted(scope: EventScope): Promise<'processed' | 'ignored'> {
  const session = scope.object;
  const sessionId = str(session, 'id');
  if (!sessionId?.startsWith('cs_')) return 'ignored';
  // Legacy B6: an empty or forged reference never reaches a row.
  const claims = await readCheckoutClaims(
    scope.ctx.links,
    signedCheckoutReference(session),
    scope.ctx.now,
  );
  if (!claims) return 'ignored';
  const row = await first<CheckoutRow>(
    scope.ctx.db,
    'SELECT * FROM checkout_sessions WHERE reference = ?1 AND channel_id = ?2',
    claims.reference,
    scope.channelId,
  );
  if (!row || row.status === 'complete') return 'ignored';
  if (row.stripe_session_id && row.stripe_session_id !== sessionId) return 'ignored';
  const paymentStatus = str(session, 'payment_status');
  if (paymentStatus === 'unpaid' && row.intent !== 'subscribe') return 'ignored';

  const email = buyerEmail(session, row);
  const customerId = idOf(session, 'customer');
  // The row's Member made this checkout signed in (the site signs that into the reference).
  const ownCheckout = (buyer: { id: string }) => claims.signedIn && buyer.id === row.member_id;
  let memberId: string | null = null;
  let done = false;
  switch (row.intent) {
    case 'subscribe':
    case 'lifetime': {
      const buyer = await findBuyer(scope, row, email, true);
      if (!buyer) return 'ignored';
      memberId = buyer.id;
      await linkCustomer(scope, buyer, ownCheckout(buyer), customerId);
      if (row.intent === 'subscribe') {
        done = await completeSubscribe(scope, session, row, memberId, email);
      } else {
        await completeLifetime(scope, session, row, memberId);
        done = true;
      }
      break;
    }
    case 'gift':
      done = await completeGift(scope, session, row, email);
      break;
    case 'tip': {
      const buyer = await findBuyer(scope, row, email, false);
      memberId = buyer?.id ?? null;
      if (buyer) await linkCustomer(scope, buyer, ownCheckout(buyer), customerId);
      const amount = num(session, 'amount_total');
      if (amount !== null && amount > 0) {
        await recordPayment(scope, {
          memberId,
          subscriptionId: null,
          kind: 'one_time',
          stripeObjectId: idOf(session, 'payment_intent') ?? sessionId,
          currency: str(session, 'currency'),
          amount,
          occurredAt: scope.ctx.now,
        });
      }
      done = true;
      break;
    }
    case 'good':
      done = await completeGood(scope, session, row, email);
      memberId = done ? row.member_id : null;
      break;
    case 'pledge':
      // Pledges take no card; a checkout for one is not ours.
      return 'ignored';
  }
  if (!done) return 'ignored';
  await run(
    scope.ctx.db,
    `UPDATE checkout_sessions SET status = 'complete', completed_at = ?1,
            stripe_session_id = coalesce(stripe_session_id, ?2), member_id = coalesce(member_id, ?3)
      WHERE reference = ?4 AND channel_id = ?5`,
    scope.ctx.now,
    sessionId,
    memberId,
    row.reference,
    scope.channelId,
  );
  await recompute(scope, memberId);
  if (row.intent === 'subscribe' || row.intent === 'lifetime') {
    await askBuyerToConfirm(scope.ctx, memberId);
  }
  return 'processed';
}
