// The public plans page and the page Checkout returns to.
//
//   GET /subscribe          Membership levels: free (the Capture Form), paid levels with their
//                           benefits and prices (?interval=year for yearly, no JavaScript needed),
//                           lifetime, the Founding Level (flag founding_level), pay what you want
//                           (flag pay_what_you_want), the tip jar, Gift Passes (flag gift_passes),
//                           and pledges (flag pledges) while the Channel can't take payments yet.
//                           ?level=<id> also shows that hidden level (hidden levels are offered by
//                           link only); ?coupon= prefills the code; ?canceled=1 after Checkout.
//   GET /subscribe/thanks   ?ref=<checkout reference>: "You're in" once the webhook completed the
//                           checkout, else "Finishing up…" with a meta refresh (no script).
//
// The checkout and pledge forms carry Turnstile; the page's CSP allows it (edge/headers.ts).
import { GIFT_MONTHS, TURNSTILE_SCRIPT, payPalSellable } from '@swarm/engine';
import { Hono } from 'hono';
import type { SiteBindings, SiteContext } from '../context';
import { formatMoney, majorValue } from '../money/amounts';
import {
  activeLevels,
  memberById,
  paidAccount,
  paymentsOpen,
  paypalConnected,
  type Level,
  type LevelPrice,
} from '../money/data';
import { h, readerPage } from '../readers/pages';
import { siteFlags } from '../render/data';
import { loadChrome, renderPage, sendPage } from '../render/layout';
import { subscribeForm } from '../render/subscribe';
import { goodsThanks } from './goods';
import { SIGNOUT_FORM, buyerLine } from '../money/buyer';

export const plans = new Hono<SiteBindings>();

const LEVEL_ID = /^lv_[0-9a-f]{32}$/;
const COUPON = /^[A-Za-z0-9]{3,40}$/;

const priceFor = (level: Level, interval: LevelPrice['interval']) =>
  level.prices.find((p) => p.interval === interval);

/** A price the plans page and checkout can sell: fixed with a Stripe Price, or pay what you want. */
export function sellable(price: LevelPrice | undefined, pwyw: boolean): price is LevelPrice {
  if (!price) return false;
  return price.customAmount ? pwyw : price.stripePriceId !== null;
}

function priceLabel(price: LevelPrice): string {
  const amount = formatMoney(price.amount, price.currency);
  if (price.interval === 'lifetime') return `${amount} once`;
  return `${amount} a ${price.interval}`;
}

const turnstile = (c: SiteContext, action: string) =>
  `<div class="cf-turnstile" data-sitekey="${h(c.get('env').TURNSTILE_SITE_KEY)}" data-action="${action}"></div>`;

interface FormContext {
  c: SiteContext;
  signedIn: boolean;
  /**
   * The signed-in reader a purchase would be credited to. Every checkout form names them, with a
   * way to buy as someone else, and carries their id: only a checkout posted with it is credited
   * to them and reuses their saved payment details (checkout.ts).
   */
  buyer?: { memberId: string; email: string } | null;
  coupon: string;
  pwyw: boolean;
  /** A signup in steps already has the address: checkout reads it from this token. */
  joinToken?: string;
}

function emailInput(ctx: FormContext, required: boolean, label = 'Email'): string {
  if (ctx.signedIn) return ctx.buyer ? buyerLine(ctx.buyer) : '';
  if (ctx.joinToken) return `<input type="hidden" name="joinToken" value="${h(ctx.joinToken)}">`;
  return `<label>${h(label)} <input type="email" name="email" autocomplete="email" maxlength="254"${required ? ' required' : ''}></label>`;
}

function amountInput(price: LevelPrice, label = 'Amount'): string {
  const min = price.minAmount ?? 0;
  return `<label>${h(label)} (${h(price.currency.toUpperCase())}) <input type="text" name="amount" inputmode="decimal" required maxlength="12" value="${h(majorValue(price.amount, price.currency))}"></label>${min > 0 ? `<p class="sw-muted">At least ${h(formatMoney(min, price.currency))}.</p>` : ''}`;
}

function checkoutForm(ctx: FormContext, level: Level, price: LevelPrice): string {
  const custom = price.customAmount && ctx.pwyw;
  const trial = price.interval !== 'lifetime' && level.trialDays > 0;
  const button =
    price.interval === 'lifetime'
      ? `Buy lifetime for ${formatMoney(price.amount, price.currency)}`
      : trial
        ? `Start a ${level.trialDays}-day trial`
        : custom
          ? `Subscribe`
          : `Subscribe for ${priceLabel(price)}`;
  return `<form class="sw-plan-form" method="post" action="/_swarm/checkout">
<input type="hidden" name="levelId" value="${h(level.id)}">
<input type="hidden" name="interval" value="${price.interval}">
${emailInput(ctx, trial)}
${trial && !ctx.signedIn && !ctx.joinToken ? '<p class="sw-muted">A trial needs your email: one trial per address.</p>' : ''}
${custom ? amountInput(price) : ''}
${price.interval === 'lifetime' ? '' : `<label>Coupon code <input type="text" name="coupon" maxlength="40" autocomplete="off" value="${h(ctx.coupon)}"></label>`}
${turnstile(ctx.c, 'checkout')}
<button type="submit">${h(button)}</button>
</form>`;
}

function paypalForm(ctx: FormContext, level: Level, price: LevelPrice): string {
  return `<form class="sw-plan-form" method="post" action="/_swarm/checkout/paypal">
<input type="hidden" name="levelId" value="${h(level.id)}">
<input type="hidden" name="interval" value="${price.interval}">
${emailInput(ctx, false)}
${turnstile(ctx.c, 'checkout')}
<button type="submit" class="sw-ghost">Subscribe with PayPal</button>
</form>`;
}

function pledgeForm(ctx: FormContext, level: Level): string {
  const prices = level.prices.filter((p) => p.interval === 'month' || p.interval === 'year');
  const first = prices[0];
  if (!first) return '';
  const options = prices
    .map((p) => `<option value="${p.interval}">${h(priceLabel(p))}</option>`)
    .join('');
  return `<form class="sw-plan-form" method="post" action="/_swarm/pledge">
<input type="hidden" name="levelId" value="${h(level.id)}">
${emailInput(ctx, true)}
<label>Billing <select name="interval">${options}</select></label>
<label>Pledge (${h(first.currency.toUpperCase())}) <input type="text" name="amount" inputmode="decimal" required maxlength="12" value="${h(majorValue(first.amount, first.currency))}"></label>
${turnstile(ctx.c, 'pledge')}
<button type="submit">Pledge</button>
<p class="sw-muted">No card now. We'll email you when paid subscriptions open.</p>
</form>`;
}

function giftSection(ctx: FormContext, levels: Level[]): string {
  const giftable = levels.filter((l) => {
    const month = priceFor(l, 'month');
    return month && !month.customAmount;
  });
  if (giftable.length === 0) return '';
  const options = giftable
    .map((l) => {
      const month = priceFor(l, 'month')!;
      return `<option value="${h(l.id)}">${h(l.name)}, ${h(formatMoney(month.amount, month.currency))} a month</option>`;
    })
    .join('');
  const months = GIFT_MONTHS.map(
    (m) => `<option value="${m}">${m} month${m === 1 ? '' : 's'}</option>`,
  ).join('');
  return `<section class="sw-plans-extra" aria-labelledby="sw-gift-title">
<h2 id="sw-gift-title">Give a gift subscription</h2>
<p>Pay once for a set number of months; they get a link to claim it.</p>
<form class="sw-plan-form" method="post" action="/_swarm/checkout">
<input type="hidden" name="gift" value="1">
<input type="hidden" name="interval" value="month">
<label>Plan <select name="levelId">${options}</select></label>
<label>Length <select name="months">${months}</select></label>
${ctx.signedIn ? (ctx.buyer ? buyerLine(ctx.buyer) : '') : '<label>Your email <input type="email" name="email" autocomplete="email" maxlength="254" required></label>'}
<label>Their email <input type="email" name="recipientEmail" maxlength="254" required></label>
<label>Message (optional) <textarea name="message" maxlength="500" rows="3"></textarea></label>
${turnstile(ctx.c, 'checkout')}
<button type="submit">Buy a gift subscription</button>
</form>
</section>`;
}

function tipSection(ctx: FormContext, currency: string): string {
  return `<section class="sw-plans-extra" aria-labelledby="sw-tip-title">
<h2 id="sw-tip-title">Leave a tip</h2>
<p>A one-time thank-you, any amount.</p>
<form class="sw-plan-form" method="post" action="/_swarm/checkout">
<input type="hidden" name="tip" value="1">
<label>Amount (${h(currency.toUpperCase())}) <input type="text" name="amount" inputmode="decimal" required maxlength="12" value="5"></label>
${emailInput(ctx, false, 'Email (optional)')}
${turnstile(ctx.c, 'checkout')}
<button type="submit">Tip</button>
</form>
</section>`;
}

/** One paid level's card on the plans page, or on the plan step of a signup in steps. */
export function levelCard(
  ctx: FormContext,
  level: Level,
  state: {
    interval: 'month' | 'year';
    open: boolean;
    paypal: boolean;
    pledging: boolean;
    founding: boolean;
  },
): string {
  const reader = ctx.c.get('reader');
  const recurring = priceFor(level, state.interval);
  const lifetime = priceFor(level, 'lifetime');
  const shown = sellable(recurring, ctx.pwyw) ? recurring : lifetime;
  const current = reader.class === 'paid' && reader.levelId === level.id;
  const founding = level.founding && state.founding;
  const forms: string[] = [];
  if (current) {
    forms.push('<p class="sw-muted">This is your plan.</p>');
  } else if (state.open) {
    if (sellable(recurring, ctx.pwyw)) forms.push(checkoutForm(ctx, level, recurring));
    if (sellable(lifetime, ctx.pwyw)) forms.push(checkoutForm(ctx, level, lifetime));
  } else if (state.pledging) {
    forms.push(pledgeForm(ctx, level));
  }
  if (!current && state.paypal && recurring && payPalSellable(recurring, level.trialDays)) {
    forms.push(paypalForm(ctx, level, recurring));
  }
  if (!current && forms.length === 0) {
    forms.push('<p class="sw-muted">Paid subscriptions open soon.</p>');
  }
  return `<li class="sw-plan${founding ? ' sw-plan-founding' : ''}">
${founding ? '<span class="sw-badge">Founding plan</span>' : ''}<h2>${h(level.name)}</h2>
${shown ? `<p class="sw-plan-price">${h(shown.customAmount && ctx.pwyw ? `From ${formatMoney(shown.minAmount ?? shown.amount, shown.currency)}` : priceLabel(shown))}</p>` : ''}
${level.trialDays > 0 && state.open ? `<p class="sw-muted">${level.trialDays}-day free trial for new subscribers, card required.</p>` : ''}
${level.description ? `<p>${h(level.description)}</p>` : ''}
${level.benefits.length ? `<ul class="sw-plan-benefits">${level.benefits.map((b) => `<li>${h(b)}</li>`).join('')}</ul>` : ''}
${forms.join('\n')}
</li>`;
}

plans.get('/subscribe', async (c) => {
  const env = c.get('env');
  const channel = c.get('channel');
  const reader = c.get('reader');
  const [chrome, flags, account, all] = await Promise.all([
    loadChrome(c),
    siteFlags(c),
    paidAccount(env, channel.id),
    activeLevels(env, channel.id),
  ]);
  const interval = c.req.query('interval') === 'year' ? 'year' : 'month';
  const directLevel = c.req.query('level') ?? '';
  const couponParam = c.req.query('coupon') ?? '';
  const coupon = COUPON.test(couponParam) ? couponParam : '';
  const open = account !== null && account.chargesEnabled && paymentsOpen(env, account);
  const paypal = await paypalConnected(env, channel.id);
  const pledging = !open && !paypal && flags.pledges;
  const pwyw = flags.pay_what_you_want;
  const signedIn = reader.class !== 'anonymous';
  const member =
    signedIn && reader.memberId ? await memberById(env, channel.id, reader.memberId) : null;
  const buyer = member ? { memberId: member.id, email: member.email } : null;
  const ctx: FormContext = { c, signedIn, coupon, pwyw, buyer };

  const levels = all
    .filter(
      (l) => l.visibility === 'public' || (LEVEL_ID.test(directLevel) && l.id === directLevel),
    )
    // Founding Levels are a flagged option; without the flag they aren't offered at all.
    .filter((l) => !l.founding || flags.founding_level)
    .sort((a, b) => Number(b.founding) - Number(a.founding));
  const hasYear = levels.some((l) => sellable(priceFor(l, 'year'), pwyw));

  const cards: string[] = [];
  cards.push(`<li class="sw-plan"><h2>Free</h2>
<p class="sw-plan-price">${h(formatMoney(0, levels[0]?.prices[0]?.currency ?? 'usd'))}</p>
<ul class="sw-plan-benefits"><li>Public posts by email</li><li>Subscriber-only posts on the site</li></ul>
${signedIn ? '<p class="sw-muted">You are a subscriber.</p>' : `<div class="sw-subscribe">${subscribeForm(env, chrome.form)}</div>`}
</li>`);
  for (const level of levels) {
    cards.push(
      levelCard(ctx, level, {
        interval,
        open,
        paypal,
        pledging,
        founding: flags.founding_level,
      }),
    );
  }

  const query = (next: string) => {
    const params = new URLSearchParams();
    if (next === 'year') params.set('interval', 'year');
    if (LEVEL_ID.test(directLevel)) params.set('level', directLevel);
    if (coupon) params.set('coupon', coupon);
    const text = params.toString();
    return `/subscribe${text ? `?${text}` : ''}`;
  };
  const tabs = hasYear
    ? `<nav class="sw-tabs" aria-label="Billing"><a href="${h(query('month'))}"${interval === 'month' ? ' aria-current="page"' : ''}>Monthly</a><a href="${h(query('year'))}"${interval === 'year' ? ' aria-current="page"' : ''}>Yearly</a></nav>`
    : '';
  // Tips are charged in the account's default currency (as /_swarm/checkout does).
  const currency = account?.defaultCurrency?.toLowerCase() || 'usd';
  const extras = [
    open && flags.gift_passes ? giftSection(ctx, levels) : '',
    open && pwyw ? tipSection(ctx, currency) : '',
  ].join('\n');
  const billing = signedIn
    ? `<form class="sw-billing" method="post" action="/_swarm/portal"><button type="submit" class="sw-ghost">Manage billing</button></form>
<form class="sw-billing" method="post" action="/_swarm/reader/signout"><input type="hidden" name="everywhere" value="1"><button type="submit" class="sw-ghost">Sign out on every device</button></form>`
    : '';
  const notice =
    c.req.query('canceled') === '1'
      ? '<p class="sw-notice" role="status">Checkout was canceled. Nothing was charged.</p>'
      : '';
  const usesTurnstile = open || pledging || paypal;

  const body = `<header class="sw-pagehead"><h1>Plans</h1><p>${h(`Support ${channel.name} and read every post.`)}</p></header>
${notice}${tabs}
<ul class="sw-plans">${cards.join('\n')}</ul>
${extras}
${billing}
${buyer ? SIGNOUT_FORM : ''}
${usesTurnstile ? `<script nonce="${h(c.get('nonce'))}" src="${TURNSTILE_SCRIPT}" async defer></script>` : ''}`;
  const html = renderPage(c, chrome, {
    meta: {
      title: 'Plans',
      description: `Plans for ${channel.name}.`,
      path: '/subscribe',
      ...(LEVEL_ID.test(directLevel) || c.req.query('canceled') ? { noindex: true } : {}),
    },
    body,
    subscribe: false,
  });
  // It names the signed-in reader, so it is never cached for anyone else.
  return sendPage(c, html, { cache: signedIn ? 'private' : 'public' });
});

plans.get('/subscribe/thanks', async (c) => {
  const ref = c.req.query('ref') ?? '';
  const row = /^[A-Za-z0-9_-]{16,64}$/.test(ref)
    ? await c
        .get('env')
        .DB.prepare(
          `SELECT status, intent, email, member_id, subject_id FROM checkout_sessions
            WHERE reference = ?1 AND channel_id = ?2`,
        )
        .bind(ref, c.get('channel').id)
        .first<{
          status: 'open' | 'complete' | 'expired';
          intent: string;
          email: string | null;
          member_id: string | null;
          subject_id: string | null;
        }>()
    : null;
  if (!row || row.status === 'expired') {
    return readerPage(
      c,
      'Checkout not found',
      `<h1>We couldn't find this checkout</h1><p>If you were charged, you'll get a receipt by email.</p><p><a href="/subscribe">Back to plans</a></p>`,
      404,
    );
  }
  if (row.status === 'open') {
    return readerPage(
      c,
      'Finishing up',
      `<h1>Finishing up…</h1><p>We're confirming your payment with Stripe. This page refreshes by itself.</p><p class="small"><a href="/subscribe/thanks?ref=${h(encodeURIComponent(ref))}">Refresh now</a></p>`,
      200,
      { head: '<meta http-equiv="refresh" content="3">' },
    );
  }
  if (row.intent === 'good') {
    return goodsThanks(c, { email: row.email, memberId: row.member_id, orderId: row.subject_id });
  }
  const what =
    row.intent === 'gift'
      ? '<h1>Your gift subscription is on its way</h1><p>We emailed the claim link to the address you gave. Thank you!</p>'
      : row.intent === 'tip'
        ? '<h1>Thank you!</h1><p>Your tip went through.</p>'
        : `<h1>You're in</h1><p>Thank you for supporting ${h(c.get('channel').name)}. Your receipt is on its way by email.</p>`;
  const anonymous = c.get('reader').class === 'anonymous';
  // Paying doesn't confirm an address: a buyer who wasn't signed in confirms it before reading.
  const pending =
    anonymous && row.member_id && row.intent !== 'tip' && row.intent !== 'gift'
      ? await c
          .get('env')
          .DB.prepare(
            `SELECT 1 AS one FROM members WHERE id = ?1 AND channel_id = ?2 AND status = 'pending'`,
          )
          .bind(row.member_id, c.get('channel').id)
          .first<{ one: number }>()
      : null;
  const signin = pending
    ? '<p>Check your inbox: we sent a link to confirm your email address. Once it is confirmed, <a href="/_swarm/reader/signin">sign in to read</a> with that address.</p>'
    : anonymous && row.intent !== 'tip' && row.intent !== 'gift'
      ? '<p><a href="/_swarm/reader/signin">Sign in to read</a> with the email you paid with.</p>'
      : '<p><a href="/">Start reading</a></p>';
  return readerPage(c, 'Thank you', `${what}${signin}`);
});
