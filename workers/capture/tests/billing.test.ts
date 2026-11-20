import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { recomputeEntitlement } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { memberTokenFor } from './links';
import { addMember, call, mailTo, nextIp, ORIGIN, seedChannel, uniqueEmail } from './helpers';
import { stripe, type StripeCall } from './stripe';

const DAY = 24 * 60 * 60 * 1000;

interface Seeded {
  channelId: string;
  memberId: string;
  email: string;
  account: string;
  subscriptionId: string;
  stripeSubscriptionId: string;
  customerId: string;
  levels: { basic: string; plus: string };
  prices: { basicMonth: string; plusMonth: string; plusYear: string; euro: string };
  path: string;
  token: string;
}

/** A connected Channel with two levels, and a Member on Basic (monthly) through Stripe. */
async function seedPaying(
  options: { source?: 'stripe' | 'comp' | 'lifetime'; status?: string; periodEnd?: number } = {},
): Promise<Seeded> {
  const now = Date.now();
  const { workspaceId, channelId } = await seedChannel();
  const email = uniqueEmail('payer');
  const memberId = await addMember(channelId, email, 'active');
  const tag = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  const account = `acct_${tag}`;
  const levels = { basic: newId('membershipLevel'), plus: newId('membershipLevel') };
  const prices = {
    basicMonth: newId('levelPrice'),
    plusMonth: newId('levelPrice'),
    plusYear: newId('levelPrice'),
    euro: newId('levelPrice'),
  };
  const subscriptionId = newId('memberSubscription');
  const stripeSubscriptionId = `sub_${tag}`;
  const customerId = `cus_${tag}`;
  const source = options.source ?? 'stripe';
  const price = (id: string, level: string, interval: string, currency: string, amount: number) =>
    env.DB.prepare(
      `INSERT INTO level_prices (id, level_id, channel_id, interval, currency, amount, stripe_price_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(id, level, channelId, interval, currency, amount, `price_${id}`, now);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO stripe_accounts (channel_id, workspace_id, stripe_account_id, charges_enabled, connected_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    ).bind(channelId, workspaceId, account, now),
    env.DB.prepare(
      `INSERT INTO membership_levels (id, channel_id, name, position, created_at, updated_at)
       VALUES (?1, ?2, 'Basic', 0, ?3, ?3), (?4, ?2, 'Plus', 1, ?3, ?3)`,
    ).bind(levels.basic, channelId, now, levels.plus),
    price(prices.basicMonth, levels.basic, 'month', 'usd', 500),
    price(prices.plusMonth, levels.plus, 'month', 'usd', 1000),
    price(prices.plusYear, levels.plus, 'year', 'usd', 10000),
    // A different currency can't be switched to on the same subscription.
    price(prices.euro, levels.basic, 'year', 'eur', 9000),
    env.DB.prepare(
      `INSERT INTO member_subscriptions (id, channel_id, member_id, level_id, price_id, source, status,
         stripe_subscription_id, stripe_customer_id, interval, currency, amount, current_period_end,
         created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'usd', ?11, ?12, ?13, ?13)`,
    ).bind(
      subscriptionId,
      channelId,
      memberId,
      levels.basic,
      source === 'stripe' ? prices.basicMonth : null,
      source,
      options.status ?? (source === 'lifetime' ? 'lifetime' : 'active'),
      source === 'stripe' ? stripeSubscriptionId : null,
      source === 'stripe' ? customerId : null,
      source === 'stripe' ? 'month' : null,
      source === 'stripe' ? 500 : null,
      options.periodEnd === undefined ? now + 20 * DAY : options.periodEnd,
      now,
    ),
  ]);
  await recomputeEntitlement(env.DB, channelId, memberId);
  // A link the Member asked for at /m: a level change needs one opened soon after it was emailed.
  const token = await memberTokenFor(memberId, undefined, { emailed: true });
  return {
    channelId,
    memberId,
    email,
    account,
    subscriptionId,
    stripeSubscriptionId,
    customerId,
    levels,
    prices,
    path: `/m/${token}`,
    token,
  };
}

function post(path: string, fields: Record<string, string>) {
  return call(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cf-connecting-ip': nextIp(),
      origin: ORIGIN,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** Stripe answers: one subscription item, a preview invoice, a portal session, two invoices. */
function answerStripe(call: StripeCall): Response {
  const key = `${call.method} ${call.path}`;
  if (/^GET \/v1\/subscriptions\//.test(key)) {
    return Response.json({ id: call.path.split('/')[3], items: { data: [{ id: 'si_item1' }] } });
  }
  if (key === 'POST /v1/invoices/create_preview') {
    return Response.json({ amount_due: 512, currency: 'usd', next_payment_attempt: 1_900_000_000 });
  }
  if (key === 'POST /v1/billing_portal/sessions') {
    return Response.json({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/test_1' });
  }
  if (key === 'GET /v1/invoices') {
    return Response.json({
      data: [
        {
          id: 'in_2',
          status: 'paid',
          amount_paid: 500,
          amount_due: 500,
          currency: 'usd',
          created: 1_790_000_000,
          hosted_invoice_url: 'https://invoice.stripe.com/i/acct_x/in_2',
        },
        { id: 'in_draft', status: 'draft', amount_due: 500, currency: 'usd', created: 1 },
      ],
    });
  }
  return Response.json({ id: call.path.split('/')[3] ?? 'obj' });
}

async function subscriptionRow(id: string) {
  return env.DB.prepare(
    'SELECT level_id, price_id, amount, interval, cancel_at_period_end, cancel_at FROM member_subscriptions WHERE id = ?1',
  )
    .bind(id)
    .first<{
      level_id: string;
      price_id: string;
      amount: number;
      interval: string;
      cancel_at_period_end: number;
      cancel_at: number | null;
    }>();
}

describe('Subscriber settings billing', () => {
  it('shows the paid level, renewal date and invoices from the publication’s account', async () => {
    const paying = await seedPaying();
    stripe.answer = answerStripe;
    const res = await call(paying.path);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h2>Your paid subscription</h2>');
    expect(html).toContain('<strong>Basic</strong> · $5.00 a month');
    expect(html).toContain('Renews on ');
    expect(html).toContain('Cancel at the end of the period');
    expect(html).toContain('href="https://invoice.stripe.com/i/acct_x/in_2"');
    expect(html).not.toContain('in_draft');
    // Other levels in the same currency only, never the current price.
    expect(html).toContain(`value="${paying.prices.plusMonth}"`);
    expect(html).toContain(`value="${paying.prices.plusYear}"`);
    expect(html).not.toContain(`value="${paying.prices.euro}"`);
    expect(html).not.toContain(`value="${paying.prices.basicMonth}"`);
    expect(stripe.calls).toHaveLength(1);
    expect(stripe.calls[0]).toMatchObject({ method: 'GET', path: '/v1/invoices' });
    expect(stripe.calls[0]!.account).toBe(paying.account);
    expect(stripe.calls[0]!.params.get('customer')).toBe(paying.customerId);
    // The payment method button lands on Stripe's portal, so forms may redirect there.
    expect(res.headers.get('content-security-policy')).toContain(
      "form-action 'self' https://billing.stripe.com",
    );
  });

  it('still shows the page when Stripe can’t list invoices', async () => {
    const paying = await seedPaying();
    stripe.answer = () => Response.json({ error: { message: 'down' } }, { status: 500 });
    const html = await (await call(paying.path)).text();
    expect(html).toContain('<strong>Basic</strong>');
    expect(html).toContain('Invoices can’t be loaded right now.');
  });

  it('cancels at period end and resumes on the publication’s account', async () => {
    const paying = await seedPaying();
    stripe.answer = answerStripe;
    const cancel = await post(paying.path, { action: 'cancel_membership' });
    expect(cancel.status).toBe(303);
    expect(cancel.headers.get('location')).toBe(`${paying.path}?saved=cancel_membership`);
    const update = stripe.calls.find((c) => c.method === 'POST');
    expect(update).toMatchObject({
      path: `/v1/subscriptions/${paying.stripeSubscriptionId}`,
      account: paying.account,
    });
    expect(update!.params.get('cancel_at_period_end')).toBe('true');
    expect(await subscriptionRow(paying.subscriptionId)).toMatchObject({
      cancel_at_period_end: 1,
    });
    expect((await subscriptionRow(paying.subscriptionId))?.cancel_at).not.toBeNull();

    const page = await (await call(`${paying.path}?saved=cancel_membership`)).text();
    expect(page).toContain('Canceled. You keep access until ');
    expect(page).toContain('Keep my subscription');

    stripe.calls = [];
    const resume = await post(paying.path, { action: 'keep_membership' });
    expect(resume.status).toBe(303);
    expect(stripe.calls).toHaveLength(1);
    expect(stripe.calls[0]).toMatchObject({
      method: 'POST',
      path: `/v1/subscriptions/${paying.stripeSubscriptionId}`,
      account: paying.account,
    });
    expect(stripe.calls[0]!.params.get('cancel_at_period_end')).toBe('false');
    expect(await subscriptionRow(paying.subscriptionId)).toMatchObject({
      cancel_at_period_end: 0,
      cancel_at: null,
    });
  });

  it('acts only on the token’s subscriber, whatever the form says', async () => {
    const a = await seedPaying();
    const b = await seedPaying();
    stripe.answer = answerStripe;
    // Form fields naming B's subscription, customer or account are ignored.
    const res = await post(a.path, {
      action: 'cancel_membership',
      subscription: b.stripeSubscriptionId,
      subscriptionId: b.subscriptionId,
      customer: b.customerId,
      account: b.account,
    });
    expect(res.status).toBe(303);
    expect(stripe.calls.every((c) => c.account === a.account)).toBe(true);
    expect(stripe.calls.map((c) => c.path)).toEqual([
      `/v1/subscriptions/${a.stripeSubscriptionId}`,
    ]);
    expect((await subscriptionRow(a.subscriptionId))?.cancel_at_period_end).toBe(1);
    expect((await subscriptionRow(b.subscriptionId))?.cancel_at_period_end).toBe(0);

    // A price from B's Channel is not one of A's choices.
    stripe.calls = [];
    const change = await post(a.path, { action: 'change_level', price: b.prices.plusMonth });
    expect(change.status).toBe(400);
    // Only the page's own invoice list was read, on A's account.
    expect(stripe.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(stripe.calls.every((c) => c.account === a.account)).toBe(true);
    expect((await subscriptionRow(a.subscriptionId))?.level_id).toBe(a.levels.basic);
  });

  it('previews a level change with proration, then applies it', async () => {
    const paying = await seedPaying();
    stripe.answer = answerStripe;
    const preview = await post(paying.path, {
      action: 'preview_level',
      price: paying.prices.plusMonth,
    });
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain(
      'From <strong>Basic, $5.00 a month</strong> to <strong>Plus, $10.00 a month</strong>',
    );
    expect(html).toContain('<strong>$5.12</strong>');
    const proration = /name="proration" value="(\d+)"/.exec(html)?.[1];
    expect(proration).toBeDefined();
    const previewCall = stripe.calls.find((c) => c.path === '/v1/invoices/create_preview')!;
    expect(previewCall.account).toBe(paying.account);
    expect(Object.fromEntries(previewCall.params)).toMatchObject({
      customer: paying.customerId,
      subscription: paying.stripeSubscriptionId,
      'subscription_details[items][0][id]': 'si_item1',
      'subscription_details[items][0][price]': `price_${paying.prices.plusMonth}`,
      'subscription_details[proration_behavior]': 'create_prorations',
      'subscription_details[proration_date]': proration,
    });
    // Nothing changes until the Member confirms.
    expect((await subscriptionRow(paying.subscriptionId))?.level_id).toBe(paying.levels.basic);

    stripe.calls = [];
    const apply = await post(paying.path, {
      action: 'change_level',
      price: paying.prices.plusMonth,
      proration: proration!,
    });
    expect(apply.status).toBe(303);
    expect(apply.headers.get('location')).toBe(`${paying.path}?saved=change_level`);
    const update = stripe.calls.find(
      (c) => c.method === 'POST' && c.path === `/v1/subscriptions/${paying.stripeSubscriptionId}`,
    )!;
    expect(update.account).toBe(paying.account);
    expect(Object.fromEntries(update.params)).toMatchObject({
      'items[0][id]': 'si_item1',
      'items[0][price]': `price_${paying.prices.plusMonth}`,
      proration_behavior: 'create_prorations',
      proration_date: proration,
    });
    expect(await subscriptionRow(paying.subscriptionId)).toMatchObject({
      level_id: paying.levels.plus,
      price_id: paying.prices.plusMonth,
      amount: 1000,
      interval: 'month',
    });
    const cached = await env.DB.prepare(
      `SELECT level_id FROM member_entitlements WHERE member_id = ?1 AND kind = 'paid'`,
    )
      .bind(paying.memberId)
      .first<{ level_id: string }>();
    expect(cached?.level_id).toBe(paying.levels.plus);
  });

  it('needs a freshly emailed link to change level: a footer link only sends one', async () => {
    const paying = await seedPaying();
    stripe.answer = answerStripe;
    const footer = `/m/${await memberTokenFor(paying.memberId)}`;
    stripe.calls = [];
    for (const action of ['preview_level', 'change_level']) {
      const res = await post(footer, { action, price: paying.prices.plusMonth });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Check your inbox');
    }
    expect(stripe.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect((await subscriptionRow(paying.subscriptionId))?.level_id).toBe(paying.levels.basic);
    // Canceling at the end of the period stays one click from the footer link.
    expect((await post(footer, { action: 'cancel_membership' })).status).toBe(303);
  });

  it('never changes level from a footer link, even for a bounced or complained Member', async () => {
    for (const status of ['bounced', 'complained']) {
      const paying = await seedPaying();
      stripe.answer = answerStripe;
      await env.DB.prepare('UPDATE members SET status = ?1 WHERE id = ?2')
        .bind(status, paying.memberId)
        .run();
      const footer = `/m/${await memberTokenFor(paying.memberId)}`;
      stripe.calls = [];
      for (const action of ['preview_level', 'change_level']) {
        const res = await post(footer, { action, price: paying.prices.plusMonth });
        expect(res.status).toBe(409);
      }
      expect(stripe.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
      expect((await subscriptionRow(paying.subscriptionId))?.level_id).toBe(paying.levels.basic);
    }
  });

  it('sends the subscriber to a Billing Portal session to update the payment method', async () => {
    const paying = await seedPaying();
    stripe.answer = answerStripe;
    const res = await post(paying.path, { action: 'payment_method' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://billing.stripe.com/p/session/test_1');
    const session = stripe.calls.find((c) => c.path === '/v1/billing_portal/sessions')!;
    expect(session.account).toBe(paying.account);
    expect(session.params.get('customer')).toBe(paying.customerId);
    // The return address goes to Stripe, so it carries no Member Center token.
    expect(session.params.get('return_url')).toBe(`${ORIGIN}/m/back`);
    expect(session.params.get('return_url')).not.toContain(paying.token);
    expect((await call('/m/back')).status).toBe(200);
    // The address hears that the payment page was opened.
    const notice = (await mailTo(paying.email)).find((m) => m.category === 'member_change');
    expect(notice?.text).toContain('change the payment method');
  });

  it('keeps the portal, PayPal cancellation and invoices behind a fresh link', async () => {
    const paying = await seedPaying();
    stripe.answer = answerStripe;
    const footer = `/m/${await memberTokenFor(paying.memberId)}`;
    stripe.calls = [];
    // The footer page shows the plan, not the invoices.
    const html = await (await call(footer)).text();
    expect(html).toContain('<strong>Basic</strong>');
    expect(html).not.toContain('invoice.stripe.com');
    expect(html).toContain('To see your invoices, open a link we email you.');
    expect(stripe.calls).toHaveLength(0);
    for (const action of ['payment_method', 'invoices', 'cancel_paypal']) {
      const res = await post(footer, { action });
      expect(res.status, action).toBe(200);
      expect(await res.text(), action).toContain('needs a fresh link');
    }
    expect(stripe.calls).toHaveLength(0);
    expect(stripe.calls.some((c) => c.path === '/v1/billing_portal/sessions')).toBe(false);
  });

  it('tells the address when a footer link cancels, with a link that can keep it', async () => {
    const paying = await seedPaying();
    stripe.answer = answerStripe;
    const footer = `/m/${await memberTokenFor(paying.memberId)}`;
    expect((await post(footer, { action: 'cancel_membership' })).status).toBe(303);
    const notice = (await mailTo(paying.email)).find((m) => m.category === 'member_change');
    expect(notice?.text).toContain('set to end when the current period ends');
    expect(notice?.text).toContain('Keep my subscription');
    const link = /https:\/\/forms\.swarm\.test(\/m\/v2\.member\.[A-Za-z0-9._-]+)/.exec(
      notice?.text ?? '',
    )?.[1];
    expect(link).toBeDefined();
    expect((await post(link!, { action: 'keep_membership' })).status).toBe(303);
    expect((await subscriptionRow(paying.subscriptionId))?.cancel_at_period_end).toBe(0);
  });

  it('shows a comp grant’s end date with no actions and no Stripe calls', async () => {
    const end = Date.UTC(2031, 4, 17);
    const paying = await seedPaying({ source: 'comp', periodEnd: end });
    stripe.answer = answerStripe;
    const html = await (await call(paying.path)).text();
    expect(html).toContain('<strong>Basic</strong>');
    expect(html).toContain('Complimentary access, until 17 May 2031.');
    expect(html).not.toContain('Cancel at the end of the period');
    expect(html).not.toContain('Update payment method');
    expect(html).not.toContain('<h2>Invoices</h2>');
    const res = await post(paying.path, { action: 'cancel_membership' });
    expect(res.status).toBe(409);
    expect(stripe.calls).toHaveLength(0);
  });

  it('shows lifetime access as never ending', async () => {
    const paying = await seedPaying({ source: 'lifetime', periodEnd: 0 });
    const html = await (await call(paying.path)).text();
    expect(html).toContain('Lifetime access. It never ends.');
    expect(stripe.calls).toHaveLength(0);
  });

  it('leaves a free subscriber’s page as it was', async () => {
    const { channelId } = await seedChannel();
    const id = await addMember(channelId, uniqueEmail(), 'active');
    const path = `/m/${await memberTokenFor(id)}`;
    const res = await call(path);
    const html = await res.text();
    expect(html).not.toContain('Your paid subscription');
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self';");
    expect(stripe.calls).toHaveLength(0);
    const action = await post(path, { action: 'cancel_membership' });
    expect(action.status).toBe(409);
    expect(stripe.calls).toHaveLength(0);
  });
});
