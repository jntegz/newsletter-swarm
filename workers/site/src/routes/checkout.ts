// Payments on the site (Phase 5). Every Stripe call runs on the Channel's own connected account
// (Connect Standard); the platform never sets an application fee.
//
//   POST /_swarm/checkout            a Checkout Session for a Membership level, a Gift Pass or a
//                                    tip, then 303 to Stripe
//   POST /_swarm/pledge              a pledge (flag pledges) while the Channel can't take payments
//   POST /_swarm/portal              a Billing Portal session for the signed-in reader
//   GET  /_swarm/checkout/dev/:id    PAYMENTS=dev only: a fake Checkout page …
//   POST /_swarm/checkout/dev/:id    … whose button feeds synthetic events to handleStripeEvent
//
// Checkout, in order: same-site post, rate limit (CHECKOUT_LIMITER), Turnstile, payments on and
// the Channel's account connected with charges enabled, the level and price belong to this
// Channel and can be bought, then a checkout_sessions row is written BEFORE the session is
// created. client_reference_id is that row's reference, signed (purpose 'checkout-ref'); the
// webhook trusts the row, never metadata. The session is created with the reference as its
// idempotency key, and its id stored on the row.
//
// Rules:
// - Hidden levels can be bought (they are offered by link: /subscribe?level=<id>); archived
//   levels can't; Founding Levels need the founding_level flag.
// - Trials are card-required (Checkout always takes a card) and once per email per Channel: a
//   trial is offered only when the email is known up front and has no trial_claims row.
// - Pay what you want (flag pay_what_you_want): a custom_amount price takes the reader's amount,
//   at least min_amount, through price_data on the level's Stripe product.
// - Gift Passes (flag gift_passes): a one-time payment of months × the level's monthly price
//   (no discount, no coupon), for a gift_passes row in pending_payment; the webhook marks it paid
//   and mails the claim link.
// - Tips (flag pay_what_you_want): a one-time payment of any amount, no level.
import { EmailSchema, goodPath, newId } from '@swarm/domain';
import { first, run } from '@swarm/db';
import {
  GIFT_CLAIM_WINDOW_MS,
  GIFT_MONTHS,
  StripeError,
  checkoutReferenceParams,
  createLinkKeys,
  handleStripeEvent,
  isErasedAddress,
  mailAdapter,
  newCheckoutReference,
  signCheckoutReference,
  PayPalError,
  payPalClient,
  payPalSellable,
  linksFor,
  readPayPalAccount,
  startPayPalSubscription,
  subscribe,
  type LinkKeys,
  type PaymentsContext,
  type StripeApi,
  type StripeEvent,
  type StripeEventOutcome,
  type StripeParams,
} from '@swarm/engine';
import { createLogger, localRequest } from '@swarm/runtime';
import { publicKeyring } from '@swarm/tokens';
import { Hono } from 'hono';
import type { SiteBindings, SiteContext } from '../context';
import type { SiteEnv } from '../env';
import {
  openJoin,
  orderGoodsLinks,
  publicPayPal,
  publicStripe,
  readerStripe,
  siteMarkers,
} from '../vault';
import { readerToken } from '../readers/session';
import { formatMoney, parseAmount } from '../money/amounts';
import {
  activeLevels,
  couponBy,
  memberById,
  paidAccount,
  paymentsOpen,
  stripeCustomer,
  type Level,
  type LevelPrice,
  type PaidAccount,
} from '../money/data';
import {
  backToPlans,
  crossSite,
  field,
  refused,
  tooMany,
  turnstilePassed,
  underPaymentLimit,
} from '../money/guard';
import { later } from '../readers/later';
import { h, readerPage } from '../readers/pages';
import { siteFlags } from '../render/data';
import { sellable } from './plans';

const log = createLogger({ service: 'site' });

const LEVEL_ID = /^lv_[0-9a-f]{32}$/;
const COUPON = /^[A-Za-z0-9]{3,40}$/;
const SESSION_ID = /^cs_[A-Za-z0-9_]{1,200}$/;
/** The smallest one-time amount we take (a tip), in minor units. */
const MIN_ONE_TIME = 100;

export interface PaymentDeps {
  /** The Stripe client; tests pass a shared DevStripe to inspect calls. */
  stripe?: (env: SiteEnv) => StripeApi | null;
  /** Answers for PayPal in tests. */
  paypalFetch?: typeof fetch;
  /** The webhook processor the dev checkout page feeds; tests may pass a fake. */
  handleEvent?: (ctx: PaymentsContext, event: StripeEvent) => Promise<StripeEventOutcome>;
}

type CheckoutIntent = 'subscribe' | 'lifetime' | 'gift' | 'tip' | 'good';

/**
 * Where Checkout returns to, built with the URL API on the Channel's canonical origin (never by
 * string concatenation: the legacy cancel_url was).
 */
export function checkoutUrls(
  origin: string,
  reference: string,
): { success: string; cancel: string } {
  const success = new URL('/subscribe/thanks', origin);
  success.searchParams.set('ref', reference);
  const cancel = new URL('/subscribe', origin);
  cancel.searchParams.set('canceled', '1');
  return { success: success.toString(), cancel: cancel.toString() };
}

/** The address of a signup in steps, from the plan step's token; null for anything else. */
async function joinAddress(c: SiteContext, form: Record<string, unknown>): Promise<string | null> {
  const token = field(form, 'joinToken', 4096);
  if (!token) return null;
  // Opened by the vault, which alone holds the keys of join tokens.
  const read = await openJoin(c.get('env'), token, c.get('channel').id);
  return read?.email ?? null;
}

const fail = (
  c: SiteContext,
  title: string,
  message: string,
  status: 400 | 402 | 403 | 404 | 409 | 502 | 503 = 400,
) => readerPage(c, title, `<h1>${h(title)}</h1><p>${h(message)}</p>${backToPlans}`, status);

const notOpen = (c: SiteContext) =>
  fail(
    c,
    'Paid subscriptions are not open yet',
    `${c.get('channel').name} is not taking payments on this site yet. Check back soon.`,
    409,
  );

/** Whether a trial can be offered to this email: once per email per Channel. */
async function trialAvailable(env: SiteEnv, channelId: string, email: string | null) {
  if (!email) return false;
  const claimed = await first(
    env.DB,
    'SELECT 1 FROM trial_claims WHERE channel_id = ?1 AND email = ?2',
    channelId,
    email,
  );
  return !claimed;
}

export function checkoutRoutes(deps: PaymentDeps = {}): Hono<SiteBindings> {
  const routes = new Hono<SiteBindings>();
  // Through the vault, which attaches the Channel's own key or the platform key with its account:
  // anyone may only open Checkout here, and only a signed-in reader their own Billing Portal.
  const stripeOf = (env: SiteEnv, channelId: string, readerToken?: string) =>
    deps.stripe
      ? deps.stripe(env)
      : readerToken
        ? readerStripe(env, channelId, readerToken)
        : publicStripe(env, channelId);

  routes.post('/_swarm/checkout/paypal', async (c) => {
    if (crossSite(c)) return refused(c);
    if (!(await underPaymentLimit(c, 'checkout'))) return tooMany(c);
    const form = await c.req.parseBody();
    if (!(await turnstilePassed(c, form, 'checkout'))) {
      return fail(
        c,
        'Please try again',
        'We could not confirm you are a person. Go back, wait for the check to finish, and send the form again.',
        403,
      );
    }
    const env = c.get('env');
    const channel = c.get('channel');
    const reader = c.get('reader');
    const now = Date.now();
    const account = await readPayPalAccount(env.DB, channel.id);
    // Through the vault, which gets the account's token: plans and subscriptions only.
    const api = account
      ? await payPalClient(
          deps.paypalFetch
            ? { fetchFor: () => deps.paypalFetch as typeof fetch }
            : publicPayPal(env),
          account,
        )
      : null;
    if (!api) return notOpen(c);

    const levelId = field(form, 'levelId', 40);
    const [level] = LEVEL_ID.test(levelId) ? await activeLevels(env, channel.id, levelId) : [];
    const flags = await siteFlags(c);
    const price = level?.prices.find((p) => p.interval === field(form, 'interval', 10));
    if (
      !level ||
      !price ||
      (level.founding && !flags.founding_level) ||
      !payPalSellable(price, level.trialDays)
    ) {
      return fail(c, 'Plan not found', 'This plan is not available.', 404);
    }

    let email: string | null = null;
    let memberId: string | null = null;
    // Only a form that named the signed-in reader buys for them (money/buyer.ts).
    if (reader.memberId && field(form, 'buyer', 40) === reader.memberId) {
      const member = await memberById(env, channel.id, reader.memberId);
      if (member) {
        email = member.email.toLowerCase();
        memberId = member.id;
      }
    }
    if (!email) {
      const typed = ((await joinAddress(c, form)) ?? field(form, 'email', 254))
        .trim()
        .toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed)) email = typed;
    }
    const reference = newCheckoutReference();
    const urls = checkoutUrls(channel.origin, reference);
    try {
      const approve = await startPayPalSubscription(env.DB, api, {
        channelId: channel.id,
        levelId: level.id,
        priceId: price.id,
        memberId,
        email,
        reference,
        returnUrl: urls.success,
        cancelUrl: urls.cancel,
        now,
      });
      c.header('cache-control', 'no-store');
      return c.redirect(approve, 303);
    } catch (error) {
      if (!(error instanceof PayPalError)) throw error;
      return fail(c, 'PayPal is not available', 'Nothing was charged. Please try again soon.', 502);
    }
  });

  routes.post('/_swarm/checkout', async (c) => {
    if (crossSite(c)) return refused(c);
    if (!(await underPaymentLimit(c, 'checkout'))) return tooMany(c);
    const form = await c.req.parseBody();
    if (!(await turnstilePassed(c, form, 'checkout'))) {
      return fail(
        c,
        'Please try again',
        'We could not confirm you are a person. Go back, wait for the check to finish, and send the form again.',
        403,
      );
    }
    const env = c.get('env');
    const channel = c.get('channel');
    const reader = c.get('reader');
    const now = Date.now();
    const stripe = stripeOf(env, channel.id);
    const [flags, account] = await Promise.all([siteFlags(c), paidAccount(env, channel.id)]);
    if (!stripe || !account || !account.chargesEnabled || !paymentsOpen(env, account)) {
      return notOpen(c);
    }

    const gift = field(form, 'gift') === '1';
    const tip = field(form, 'tip') === '1';

    // Who is buying: the signed-in reader when the form named them (money/buyer.ts), else the
    // email they typed (optional). A session alone, which a gift link can plant in a browser,
    // never credits a purchase to its Member or reuses their saved payment details.
    let email: string | null = null;
    let memberId: string | null = null;
    if (reader.memberId && field(form, 'buyer', 40) === reader.memberId) {
      const member = await memberById(env, channel.id, reader.memberId);
      if (member) {
        email = member.email.toLowerCase();
        memberId = member.id;
      }
    }
    const given = email ? '' : ((await joinAddress(c, form)) ?? field(form, 'email', 254));
    if (!email && given) {
      const parsed = EmailSchema.safeParse(given);
      if (!parsed.success) return fail(c, 'Check your email', 'Enter a valid email address.');
      email = parsed.data;
      // An address erased through the Privacy Center can't be used again in this workspace.
      if (await isErasedAddress(env.DB, channel.workspaceId, email, siteMarkers(env))) {
        return fail(c, 'Check your email', 'This address can’t be used here. Enter another one.');
      }
      const match = await first<{ id: string }>(
        env.DB,
        'SELECT id FROM members WHERE channel_id = ?1 AND email = ?2',
        channel.id,
        email,
      );
      memberId = match?.id ?? null;
    }

    let plan: Plan | Response;
    if (tip) {
      plan = tipPlan(c, form, account, flags.pay_what_you_want);
    } else if (field(form, 'good', 40)) {
      plan = await goodPlan(c, form, email, now, flags.goods);
    } else {
      const levelId = field(form, 'levelId', 40);
      const [level] = LEVEL_ID.test(levelId) ? await activeLevels(env, channel.id, levelId) : [];
      if (!level || (level.founding && !flags.founding_level)) {
        return fail(c, 'Plan not found', 'This plan is not available.', 404);
      }
      plan = gift
        ? await giftPlan(c, form, level, email, flags.gift_passes, now)
        : await levelPlan(c, form, level, email, flags.pay_what_you_want, now);
    }
    if (plan instanceof Response) return plan;

    // A typed email proves nothing, so only a signed-in reader's own Member reuses its Stripe
    // customer, and only their checkout may link a new one to it (signed into the reference).
    // Anyone else gets customer_email; the webhook links a customer only to a Member it creates.
    const signedIn = !!memberId && memberId === reader.memberId;
    const reference = newCheckoutReference();
    const signedReference = await signCheckoutReference(linksFor(env), reference, now, {
      signedIn,
    });
    const urls = checkoutUrls(channel.origin, reference);
    const customer = signedIn && memberId ? await stripeCustomer(env, channel.id, memberId) : null;

    // The row first: the webhook only ever trusts what it says.
    const statements = [
      env.DB.prepare(
        `INSERT INTO checkout_sessions (reference, channel_id, subject_id, coupon_id, custom_amount,
           level_id, price_id, member_id, email, intent, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'open', ?11)`,
      ).bind(
        reference,
        channel.id,
        plan.gift?.id ?? plan.good?.orderId ?? null,
        plan.couponId,
        plan.customAmount,
        plan.levelId,
        plan.priceId,
        memberId,
        email,
        plan.intent,
        now,
      ),
    ];
    if (plan.gift) {
      statements.unshift(
        env.DB.prepare(
          `INSERT INTO gift_passes (id, channel_id, level_id, months, purchaser_email,
             purchaser_member_id, recipient_email, message, status, claim_by, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending_payment', ?9, ?10)`,
        ).bind(
          plan.gift.id,
          channel.id,
          plan.levelId,
          plan.gift.months,
          email,
          memberId,
          plan.gift.recipientEmail,
          plan.gift.message,
          now + GIFT_CLAIM_WINDOW_MS,
          now,
        ),
      );
    }
    if (plan.good) {
      // goodPlan refuses a checkout without an address, so email is set here.
      statements.unshift(
        env.DB.prepare(
          `INSERT INTO good_orders (id, channel_id, good_id, price_id, member_id, email, amount, currency, status, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9)`,
        ).bind(
          plan.good.orderId,
          channel.id,
          plan.good.goodId,
          plan.good.priceId,
          memberId,
          email,
          plan.good.amount,
          plan.good.currency,
          now,
        ),
      );
    }
    await env.DB.batch(statements);

    const signed = checkoutReferenceParams(reference, signedReference);
    const params: StripeParams = {
      mode: plan.mode,
      line_items: [plan.lineItem],
      success_url: urls.success,
      cancel_url: plan.good ? new URL(plan.good.path, channel.origin).toString() : urls.cancel,
      // The signed reference, in metadata (and client_reference_id while it fits). The channel
      // and plain reference are for people reading the Stripe dashboard; the webhook never reads them.
      client_reference_id: signed.client_reference_id,
      metadata: { channel: channel.id, reference, ...signed.metadata },
      ...(customer ? { customer } : email ? { customer_email: email } : {}),
      ...(plan.mode === 'payment' && !customer ? { customer_creation: 'always' } : {}),
      ...(plan.promotionCode
        ? { discounts: [{ promotion_code: plan.promotionCode }] }
        : plan.allowPromotionCodes
          ? { allow_promotion_codes: true }
          : {}),
      ...(account.taxEnabled
        ? {
            automatic_tax: { enabled: true },
            ...(customer ? { customer_update: { address: 'auto' } } : {}),
          }
        : {}),
      ...(plan.mode === 'subscription'
        ? {
            subscription_data: {
              metadata: { channel: channel.id, reference },
              ...(plan.trialDays > 0 ? { trial_period_days: plan.trialDays } : {}),
            },
          }
        : {}),
    };

    let session: { id?: unknown; url?: unknown };
    try {
      session = await stripe.request<{ id?: unknown; url?: unknown }>(
        'POST',
        '/v1/checkout/sessions',
        params,
        { account: account.stripeAccountId, idempotencyKey: reference },
      );
    } catch (error) {
      log.error('checkout session failed', {
        channel: channel.id,
        error: error instanceof StripeError ? error.message : (error as Error).message,
      });
      await run(
        env.DB,
        `UPDATE checkout_sessions SET status = 'expired' WHERE reference = ?1`,
        reference,
      );
      return fail(
        c,
        'Checkout is unavailable',
        'Stripe could not start the checkout. Nothing was charged. Try again in a moment.',
        502,
      );
    }
    const sessionId = typeof session.id === 'string' ? session.id : '';
    const url = typeof session.url === 'string' ? session.url : '';
    if (!SESSION_ID.test(sessionId) || !/^https?:\/\//.test(url)) {
      return fail(
        c,
        'Checkout is unavailable',
        'Stripe answered unexpectedly. Nothing was charged.',
        502,
      );
    }
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE checkout_sessions SET stripe_session_id = ?1 WHERE reference = ?2',
      ).bind(sessionId, reference),
      ...(plan.gift
        ? [
            env.DB.prepare('UPDATE gift_passes SET checkout_session_id = ?1 WHERE id = ?2').bind(
              sessionId,
              plan.gift.id,
            ),
          ]
        : []),
    ]);
    c.header('cache-control', 'no-store');
    return c.redirect(url, 303);
  });

  routes.post('/_swarm/pledge', async (c) => {
    if (crossSite(c)) return refused(c);
    if (!(await underPaymentLimit(c, 'pledge'))) return tooMany(c);
    const env = c.get('env');
    const channel = c.get('channel');
    const flags = await siteFlags(c);
    if (!flags.pledges) return c.notFound();
    const form = await c.req.parseBody();
    if (!(await turnstilePassed(c, form, 'pledge'))) {
      return fail(c, 'Please try again', 'We could not confirm you are a person.', 403);
    }
    const account = await paidAccount(env, channel.id);
    if (account?.chargesEnabled && paymentsOpen(env, account)) {
      // Paid Memberships are open: buy instead of pledging.
      c.header('cache-control', 'no-store');
      return c.redirect('/subscribe', 303);
    }
    const levelId = field(form, 'levelId', 40);
    const [level] = LEVEL_ID.test(levelId) ? await activeLevels(env, channel.id, levelId) : [];
    if (!level || (level.founding && !flags.founding_level)) {
      return fail(c, 'Plan not found', 'This plan is not available.', 404);
    }
    const interval = field(form, 'interval') === 'year' ? 'year' : 'month';
    const price = level.prices.find((p) => p.interval === interval);
    if (!price) return fail(c, 'Choose a billing period', 'This plan has no such price.');
    const amount = parseAmount(field(form, 'amount', 20), price.currency);
    if (amount === null) return fail(c, 'Check the amount', 'Enter an amount, like 5 or 12.50.');

    const reader = c.get('reader');
    const typed = EmailSchema.safeParse(field(form, 'email', 254));
    if (!reader.memberId && !typed.success) {
      return fail(c, 'Check your email', 'Enter a valid email address.');
    }
    const email = typed.success ? typed.data : null;
    const now = Date.now();
    // Everything that depends on whether the address is a Member happens after the response.
    later(
      c,
      (async () => {
        let memberId = reader.memberId;
        if (!memberId && email) {
          // The usual sign-up: a new address becomes a pending Member with a confirmation email.
          const result = await subscribe(
            {
              db: env.DB,
              mail: mailAdapter(env, env.PLATFORM_MAIL_DOMAIN),
              links: linksFor(env),
              captureOrigin: env.CAPTURE_ORIGIN.replace(/\/$/, ''),
              platformMailDomain: env.PLATFORM_MAIL_DOMAIN,
              // No profile fields are submitted; the vault's markers keep an erased address out.
              fieldKeys: siteMarkers(env),
            },
            {
              channelId: channel.id,
              workspaceId: channel.workspaceId,
              formId: null,
              email,
              doubleOptIn: true,
            },
          );
          memberId = result.memberId;
        }
        if (!memberId) return;
        await run(
          env.DB,
          `INSERT INTO pledges (id, channel_id, member_id, level_id, interval, currency, amount, status, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8)
           ON CONFLICT (channel_id, member_id) DO UPDATE SET level_id = excluded.level_id,
             interval = excluded.interval, currency = excluded.currency, amount = excluded.amount
           WHERE pledges.status IN ('open', 'notified')`,
          newId('pledge', now),
          channel.id,
          memberId,
          level.id,
          interval,
          price.currency,
          amount,
          now,
        );
      })(),
    );
    return readerPage(
      c,
      'Thank you',
      `<h1>Thank you for your pledge</h1><p>We'll email you when paid subscriptions open, so you can turn your pledge of ${h(formatMoney(amount, price.currency))} a ${interval} into a paid subscription. No card was taken.</p>${reader.memberId ? '' : '<p class="small">New here? Confirm your email address with the link we sent you.</p>'}<p><a href="/">Back to the site</a></p>`,
    );
  });

  routes.post('/_swarm/portal', async (c) => {
    if (crossSite(c)) return refused(c);
    const reader = c.get('reader');
    if (!reader.memberId) {
      return readerPage(
        c,
        'Sign in first',
        `<h1>Sign in first</h1><p>Sign in to manage your billing.</p><p><a href="/_swarm/reader/signin?return=%2Fsubscribe">Sign in</a></p>`,
        403,
      );
    }
    if (!(await underPaymentLimit(c, 'portal'))) return tooMany(c);
    const env = c.get('env');
    const channel = c.get('channel');
    const stripe = stripeOf(env, channel.id, readerToken(c) ?? '');
    const [account, customer] = await Promise.all([
      paidAccount(env, channel.id),
      stripeCustomer(env, channel.id, reader.memberId),
    ]);
    if (!stripe || !account || !customer || !paymentsOpen(env, account)) {
      return readerPage(
        c,
        'No billing yet',
        `<h1>No billing to manage</h1><p>You have no paid subscription with ${h(channel.name)} yet, so there are no payment details or invoices here.</p>${backToPlans}`,
      );
    }
    let session: { url?: unknown };
    try {
      session = await stripe.request<{ url?: unknown }>(
        'POST',
        '/v1/billing_portal/sessions',
        { customer, return_url: new URL('/subscribe', channel.origin).toString() },
        { account: account.stripeAccountId },
      );
    } catch (error) {
      log.error('billing portal failed', { channel: channel.id, error: (error as Error).message });
      return fail(
        c,
        'Billing is unavailable',
        'Stripe could not open billing. Try again soon.',
        502,
      );
    }
    const url = typeof session.url === 'string' ? session.url : '';
    if (!/^https?:\/\//.test(url)) {
      return fail(c, 'Billing is unavailable', 'Stripe answered unexpectedly.', 502);
    }
    c.header('cache-control', 'no-store');
    return c.redirect(url, 303);
  });

  // The dev checkout page: only with the DevStripe fake (PAYMENTS=dev, development and tests).
  routes.get('/_swarm/checkout/dev/:id', async (c) => {
    const row = await devSession(c);
    if (!row) return c.notFound();
    const what =
      row.intent === 'good'
        ? 'a product'
        : row.intent === 'tip'
          ? 'a tip'
          : row.intent === 'gift'
            ? `a gift subscription for ${row.level_name ?? 'a plan'}`
            : (row.level_name ?? 'a plan');
    return readerPage(
      c,
      'Test checkout',
      `<h1>Test checkout</h1><p>This is the development stand-in for Stripe Checkout. No money moves.</p>
<p>Buying ${h(what)}${row.email ? ` as ${h(row.email)}` : ''}.</p>
<form method="post" action="/_swarm/checkout/dev/${h(row.stripe_session_id)}"><button type="submit">Complete test purchase</button></form>
<p class="small"><a href="/subscribe?canceled=1">Cancel</a></p>`,
    );
  });

  routes.post('/_swarm/checkout/dev/:id', async (c) => {
    if (crossSite(c)) return refused(c);
    const row = await devSession(c);
    if (!row) return c.notFound();
    const env = c.get('env');
    const now = Date.now();
    const account = await paidAccount(env, c.get('channel').id);
    if (!account) return notOpen(c);
    // As in POST /_swarm/checkout: only the row's Member, signed in, reuses its customer.
    const signedIn = !!row.member_id && row.member_id === c.get('reader').memberId;
    const customer =
      (signedIn && row.member_id
        ? await stripeCustomer(env, row.channel_id, row.member_id)
        : null) ?? `cus_dev${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const trial =
      row.intent === 'subscribe' && row.trial_days > 0
        ? await trialAvailable(env, row.channel_id, row.email)
        : false;
    const events = devCheckoutEvents({
      session: {
        id: row.stripe_session_id,
        reference: row.reference,
        intent: row.intent,
        email: row.email,
        customAmount: row.custom_amount,
        channelId: row.channel_id,
      },
      signedReference: await signCheckoutReference(linksFor(env), row.reference, now, {
        signedIn,
      }),
      account: account.stripeAccountId,
      customer,
      price:
        row.intent === 'good'
          ? await devGoodPrice(env, row.subject_id)
          : row.stripe_price_id || row.price_amount !== null
            ? {
                stripePriceId: row.stripe_price_id,
                interval: row.price_interval ?? 'month',
                currency: row.price_currency ?? 'usd',
                amount: row.price_amount ?? 0,
              }
            : null,
      trialDays: trial ? row.trial_days : 0,
      now,
    });
    const handle = deps.handleEvent ?? handleStripeEvent;
    const stripe = stripeOf(env, row.channel_id);
    // `mail` lets the processor email Gift Pass claim links and trial notices.
    const context: PaymentsContext = {
      db: env.DB,
      stripe: stripe!,
      // The site holds the checkout signing key, so it checks its own references with the public
      // half; it holds no Member key, so payment mail links the page that emails one.
      links: await devCheckoutLinks(env),
      goodsLinks: orderGoodsLinks(env),
      fieldKeys: siteMarkers(env),
      now,
      mail: {
        adapter: mailAdapter(env, env.PLATFORM_MAIL_DOMAIN),
        platformMailDomain: env.PLATFORM_MAIL_DOMAIN,
        site: { scheme: env.SITE_SCHEME, platformDomain: env.PLATFORM_SITE_DOMAIN },
        captureOrigin: env.CAPTURE_ORIGIN.replace(/\/$/, ''),
      },
    };
    try {
      for (const event of events) {
        await handle(context, event);
      }
    } catch (error) {
      return fail(
        c,
        'The test purchase failed',
        `The webhook processor refused the events: ${(error as Error).message}`,
        502,
      );
    }
    c.header('cache-control', 'no-store');
    return c.redirect(checkoutUrls(c.get('channel').origin, row.reference).success, 303);
  });

  return routes;
}

async function devGoodPrice(env: SiteEnv, orderId: string | null) {
  const order = await first<{ amount: number; currency: string }>(
    env.DB,
    'SELECT amount, currency FROM good_orders WHERE id = ?1',
    orderId,
  );
  return order
    ? {
        stripePriceId: null,
        interval: 'lifetime' as const,
        currency: order.currency,
        amount: order.amount,
      }
    : null;
}

interface DevRow {
  subject_id: string | null;
  reference: string;
  stripe_session_id: string;
  channel_id: string;
  intent: CheckoutIntent;
  email: string | null;
  member_id: string | null;
  custom_amount: number | null;
  level_name: string | null;
  trial_days: number;
  stripe_price_id: string | null;
  price_interval: 'month' | 'year' | 'lifetime' | null;
  price_currency: string | null;
  price_amount: number | null;
}

async function devSession(c: SiteContext): Promise<DevRow | null> {
  const env = c.get('env');
  // PAYMENTS=dev alone is one value; the fake checkout also needs a local host name.
  if (env.PAYMENTS !== 'dev' || !localRequest(c.req.url)) return null;
  const id = c.req.param('id') ?? '';
  if (!SESSION_ID.test(id)) return null;
  return first<DevRow>(
    env.DB,
    `SELECT cs.reference, cs.stripe_session_id, cs.channel_id, cs.intent, cs.email, cs.member_id,
            cs.subject_id, cs.custom_amount, l.name AS level_name, COALESCE(l.trial_days, 0) AS trial_days,
            p.stripe_price_id, p.interval AS price_interval, p.currency AS price_currency,
            p.amount AS price_amount
       FROM checkout_sessions cs
       LEFT JOIN membership_levels l ON l.id = cs.level_id
       LEFT JOIN level_prices p ON p.id = cs.price_id
      WHERE cs.stripe_session_id = ?1 AND cs.channel_id = ?2 AND cs.status = 'open'`,
    id,
    c.get('channel').id,
  );
}

interface DevEventsInput {
  session: {
    id: string;
    reference: string;
    intent: CheckoutIntent;
    email: string | null;
    customAmount: number | null;
    channelId: string;
  };
  signedReference: string;
  account: string;
  customer: string;
  price: {
    stripePriceId: string | null;
    interval: 'month' | 'year' | 'lifetime';
    currency: string;
    amount: number;
  } | null;
  trialDays: number;
  now: number;
}

/**
 * The link keys of the development checkout, which runs the payment webhook here: the site's own,
 * plus the public half of its checkout key, to check the reference as the api would.
 */
async function devCheckoutLinks(env: SiteEnv): Promise<LinkKeys> {
  return createLinkKeys({
    mode: linksFor(env).mode,
    memberKeys: env.MEMBER_KEYS,
    rings: {
      CONFIRM_KEYS: env.CONFIRM_KEYS,
      CHECKOUT_VERIFY_KEYS: await publicKeyring('CHECKOUT_SIGNING_KEYS', env.CHECKOUT_SIGNING_KEYS),
    },
  });
}

const devId = (prefix: string) =>
  `${prefix}_dev${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

/**
 * The events Stripe would send for a completed Checkout Session: checkout.session.completed, and
 * customer.subscription.created for subscriptions (current_period_end on the subscription item,
 * as in API versions since 2025-03-31.basil).
 */
export function devCheckoutEvents(input: DevEventsInput): StripeEvent[] {
  const { session, price, now } = input;
  const created = Math.floor(now / 1000);
  const subscription = session.intent === 'subscribe';
  const subscriptionId = subscription ? devId('sub') : null;
  const amount = session.customAmount ?? price?.amount ?? 0;
  const currency = price?.currency ?? 'usd';
  const trialEnd = input.trialDays > 0 ? created + input.trialDays * 86_400 : null;
  const reference = checkoutReferenceParams(session.reference, input.signedReference);
  const event = (type: string, object: Record<string, unknown>): StripeEvent => ({
    id: devId('evt'),
    type,
    account: input.account,
    created,
    livemode: false,
    data: { object },
  });
  const events = [
    event('checkout.session.completed', {
      id: session.id,
      object: 'checkout.session',
      mode: subscription ? 'subscription' : 'payment',
      status: 'complete',
      payment_status: trialEnd ? 'no_payment_required' : 'paid',
      client_reference_id: reference.client_reference_id,
      customer: input.customer,
      customer_email: session.email,
      customer_details: { email: session.email },
      subscription: subscriptionId,
      payment_intent: subscription ? null : devId('pi'),
      amount_total: trialEnd ? 0 : amount,
      currency,
      metadata: {
        channel: session.channelId,
        reference: session.reference,
        ...reference.metadata,
      },
    }),
  ];
  if (subscriptionId && price && price.interval !== 'lifetime') {
    const periodEnd = trialEnd ?? created + (price.interval === 'year' ? 365 : 30) * 86_400;
    events.push(
      event('customer.subscription.created', {
        id: subscriptionId,
        object: 'subscription',
        customer: input.customer,
        status: trialEnd ? 'trialing' : 'active',
        cancel_at_period_end: false,
        cancel_at: null,
        canceled_at: null,
        created,
        trial_end: trialEnd,
        metadata: { channel: session.channelId, reference: session.reference },
        items: {
          object: 'list',
          data: [
            {
              id: devId('si'),
              object: 'subscription_item',
              current_period_start: created,
              current_period_end: periodEnd,
              price: {
                id: price.stripePriceId ?? devId('price'),
                object: 'price',
                currency,
                unit_amount: amount,
                recurring: { interval: price.interval },
              },
            },
          ],
        },
      }),
    );
  }
  return events;
}

// ---------------------------------------------------------------------------------------------
// Plans: what a checkout buys

interface Plan {
  intent: CheckoutIntent;
  mode: 'subscription' | 'payment';
  lineItem: StripeParams;
  levelId: string | null;
  priceId: string | null;
  customAmount: number | null;
  couponId: string | null;
  promotionCode: string | null;
  allowPromotionCodes: boolean;
  trialDays: number;
  gift?: { id: string; months: number; recipientEmail: string; message: string | null };
  good?: {
    orderId: string;
    goodId: string;
    priceId: string;
    amount: number;
    currency: string;
    path: string;
  };
}

function productFor(level: Level, name: string): StripeParams {
  return level.stripeProductId ? { product: level.stripeProductId } : { product_data: { name } };
}

async function levelPlan(
  c: SiteContext,
  form: Record<string, unknown>,
  level: Level,
  email: string | null,
  pwyw: boolean,
  now: number,
): Promise<Plan | Response> {
  const env = c.get('env');
  const channel = c.get('channel');
  const raw = field(form, 'interval');
  const interval = raw === 'year' || raw === 'lifetime' ? raw : raw === 'month' ? 'month' : null;
  const price: LevelPrice | undefined = interval
    ? level.prices.find((p) => p.interval === interval)
    : undefined;
  if (!interval || !sellable(price, pwyw)) {
    return fail(c, 'Choose a price', 'This plan has no such price.', 404);
  }
  const lifetime = interval === 'lifetime';

  let customAmount: number | null = null;
  let lineItem: StripeParams;
  if (price.customAmount) {
    customAmount = parseAmount(field(form, 'amount', 20), price.currency);
    const min = Math.max(price.minAmount ?? 0, 1);
    if (customAmount === null || customAmount < min) {
      return fail(c, 'Check the amount', `Enter at least ${formatMoney(min, price.currency)}.`);
    }
    lineItem = {
      price_data: {
        currency: price.currency,
        unit_amount: customAmount,
        ...productFor(level, level.name),
        ...(lifetime ? {} : { recurring: { interval } }),
      },
      quantity: 1,
    };
  } else {
    lineItem = { price: price.stripePriceId, quantity: 1 };
  }

  let couponId: string | null = null;
  let promotionCode: string | null = null;
  const code = field(form, 'coupon', 60);
  if (code) {
    const coupon = COUPON.test(code) ? await couponBy(env, channel.id, { code }, now) : null;
    if (
      !coupon ||
      !coupon.stripePromotionCodeId ||
      (coupon.levelIds.length > 0 && !coupon.levelIds.includes(level.id))
    ) {
      return fail(c, 'Coupon not valid', `The code ${code} can't be used for ${level.name}.`);
    }
    couponId = coupon.id;
    promotionCode = coupon.stripePromotionCodeId;
  }

  const trialDays =
    !lifetime && level.trialDays > 0 && (await trialAvailable(env, channel.id, email))
      ? level.trialDays
      : 0;
  return {
    intent: lifetime ? 'lifetime' : 'subscribe',
    mode: lifetime ? 'payment' : 'subscription',
    lineItem,
    levelId: level.id,
    priceId: price.id,
    customAmount,
    couponId,
    promotionCode,
    allowPromotionCodes: !promotionCode,
    trialDays,
  };
}

async function giftPlan(
  c: SiteContext,
  form: Record<string, unknown>,
  level: Level,
  email: string | null,
  enabled: boolean,
  now: number,
): Promise<Plan | Response> {
  if (!enabled)
    return fail(
      c,
      'Gift subscriptions are not available',
      'This publication does not sell gift subscriptions.',
      404,
    );
  if (!email) return fail(c, 'Check your email', 'Enter your email address for the receipt.');
  const recipient = EmailSchema.safeParse(field(form, 'recipientEmail', 254));
  if (!recipient.success) {
    return fail(c, 'Check their email', "Enter the email address of the person you're gifting.");
  }
  if (
    await isErasedAddress(
      c.get('env').DB,
      c.get('channel').workspaceId,
      recipient.data,
      siteMarkers(c.get('env')),
    )
  ) {
    return fail(c, 'Check their email', 'This address can’t be used here. Enter another one.');
  }
  const months = Number(field(form, 'months', 4));
  if (!(GIFT_MONTHS as readonly number[]).includes(months)) {
    return fail(c, 'Choose a length', 'Choose how many months to give.');
  }
  const monthly = level.prices.find((p) => p.interval === 'month');
  if (!monthly || monthly.customAmount) {
    return fail(
      c,
      'Gift subscriptions are not available',
      `${level.name} can't be given as a gift.`,
      404,
    );
  }
  const message = field(form, 'message', 500) || null;
  // A Gift Pass costs months × the monthly price, paid once (no discounts).
  return {
    intent: 'gift',
    mode: 'payment',
    lineItem: {
      price_data: {
        currency: monthly.currency,
        unit_amount: monthly.amount * months,
        product_data: {
          name: `${level.name} gift subscription, ${months} month${months === 1 ? '' : 's'}`,
        },
      },
      quantity: 1,
    },
    levelId: level.id,
    priceId: monthly.id,
    customAmount: null,
    couponId: null,
    promotionCode: null,
    allowPromotionCodes: false,
    trialDays: 0,
    gift: { id: newId('giftPass', now), months, recipientEmail: recipient.data, message },
  };
}

/** A product at one of its prices. Delivery needs an address, so it is required here. */
async function goodPlan(
  c: SiteContext,
  form: Record<string, unknown>,
  email: string | null,
  now: number,
  enabled: boolean,
): Promise<Plan | Response> {
  if (!enabled) return c.notFound();
  const env = c.get('env');
  const price = await first<{
    id: string;
    name: string;
    amount: number;
    currency: string;
    good_id: string;
    good_name: string;
    slug: string;
  }>(
    env.DB,
    `SELECT p.id, p.name, p.amount, p.currency, g.id AS good_id, g.name AS good_name, g.slug
       FROM good_prices p JOIN goods g ON g.id = p.good_id
      WHERE p.id = ?1 AND g.id = ?2 AND g.channel_id = ?3 AND g.status = 'published'
        AND p.archived_at IS NULL`,
    field(form, 'price', 40),
    field(form, 'good', 40),
    c.get('channel').id,
  );
  if (!price) return fail(c, 'Product not found', 'This product is not for sale.', 404);
  if (!email) {
    return fail(c, 'Check your email', 'Enter your email address, so we can send you the files.');
  }
  return {
    intent: 'good',
    mode: 'payment',
    lineItem: {
      price_data: {
        currency: price.currency,
        unit_amount: price.amount,
        product_data: { name: `${price.good_name} (${price.name})` },
      },
      quantity: 1,
    },
    levelId: null,
    priceId: null,
    customAmount: price.amount,
    couponId: null,
    promotionCode: null,
    allowPromotionCodes: false,
    trialDays: 0,
    good: {
      orderId: newId('goodOrder', now),
      goodId: price.good_id,
      priceId: price.id,
      amount: price.amount,
      currency: price.currency,
      path: goodPath(price.slug),
    },
  };
}

function tipPlan(
  c: SiteContext,
  form: Record<string, unknown>,
  account: PaidAccount,
  enabled: boolean,
): Plan | Response {
  if (!enabled)
    return fail(c, 'Tips are not available', 'This publication does not take tips.', 404);
  const currency = account.defaultCurrency?.toLowerCase() || 'usd';
  const amount = parseAmount(field(form, 'amount', 20), currency);
  if (amount === null || amount < MIN_ONE_TIME) {
    return fail(c, 'Check the amount', `Enter at least ${formatMoney(MIN_ONE_TIME, currency)}.`);
  }
  return {
    intent: 'tip',
    mode: 'payment',
    lineItem: {
      price_data: {
        currency,
        unit_amount: amount,
        product_data: { name: `Tip for ${c.get('channel').name}` },
      },
      quantity: 1,
    },
    levelId: null,
    priceId: null,
    customAmount: amount,
    couponId: null,
    promotionCode: null,
    allowPromotionCodes: false,
    trialDays: 0,
  };
}
