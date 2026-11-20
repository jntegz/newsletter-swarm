import { describe, expect, it } from 'vitest';
import {
  BillingError,
  DevStripe,
  billingPortalUrl,
  findChoice,
  formatMoney,
  gateAdmits,
  listInvoices,
  normalizeLevelIds,
  previewLevelChange,
  splitsByEntitlement,
  usableProrationDate,
  type MemberBilling,
} from '../src/index';

const now = 1_790_000_000_000;

function billing(overrides: Partial<MemberBilling> = {}): MemberBilling {
  return {
    subscription: {
      id: 'ms_1',
      channelId: 'ch_1',
      memberId: 'mb_1',
      levelId: 'lv_basic',
      levelName: 'Basic',
      priceId: 'lp_basic',
      source: 'stripe',
      status: 'active',
      interval: 'month',
      currency: 'usd',
      amount: 500,
      currentPeriodEnd: now + 1000,
      trialEnd: null,
      cancelAt: null,
      cancelAtPeriodEnd: false,
      stripeSubscriptionId: 'sub_1',
      paypalSubscriptionId: null,
      stripeCustomerId: 'cus_1',
    },
    account: 'acct_1',
    manageable: true,
    choices: [
      {
        priceId: 'lp_plus',
        levelId: 'lv_plus',
        levelName: 'Plus',
        interval: 'month',
        currency: 'usd',
        amount: 1000,
        stripePriceId: 'price_plus',
      },
    ],
    ...overrides,
  };
}

describe('previewLevelChange', () => {
  it('asks Stripe for the prorated upcoming invoice on the connected account', async () => {
    const stripe = new DevStripe();
    stripe.respond(/^GET \/v1\/subscriptions\/sub_1$/, { items: { data: [{ id: 'si_1' }] } });
    stripe.respond(/^POST \/v1\/invoices\/create_preview$/, {
      amount_due: 250,
      currency: 'usd',
      next_payment_attempt: 1_790_100_000,
    });
    const b = billing();
    const preview = await previewLevelChange({ db: null as never, stripe, now }, b, b.choices[0]!);
    expect(preview).toEqual({
      amountDue: 250,
      currency: 'usd',
      prorationDate: now / 1000,
      nextPaymentAt: 1_790_100_000_000,
    });
    expect(stripe.calls.map((c) => c.options.account)).toEqual(['acct_1', 'acct_1']);
    expect(stripe.calls[1]?.params).toEqual({
      customer: 'cus_1',
      subscription: 'sub_1',
      subscription_details: {
        items: [{ id: 'si_1', price: 'price_plus' }],
        proration_behavior: 'create_prorations',
        proration_date: now / 1000,
      },
    });
  });

  it('refuses a subscription with more than one item', async () => {
    const stripe = new DevStripe();
    stripe.respond(/^GET /, { items: { data: [{ id: 'si_1' }, { id: 'si_2' }] } });
    const b = billing();
    await expect(
      previewLevelChange({ db: null as never, stripe, now }, b, b.choices[0]!),
    ).rejects.toBeInstanceOf(BillingError);
  });

  it('refuses anything that is not a live Stripe subscription', async () => {
    const stripe = new DevStripe();
    const comp = billing({ manageable: false });
    await expect(billingPortalUrl(stripe, comp, 'https://forms.test/m/x')).rejects.toBeInstanceOf(
      BillingError,
    );
    expect(stripe.calls).toHaveLength(0);
  });
});

describe('billingPortalUrl', () => {
  it('opens a portal session for the customer on the connected account', async () => {
    const stripe = new DevStripe();
    stripe.respond(/billing_portal/, { url: 'https://billing.stripe.com/p/session/1' });
    expect(await billingPortalUrl(stripe, billing(), 'https://forms.test/m/x')).toBe(
      'https://billing.stripe.com/p/session/1',
    );
    expect(stripe.calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/billing_portal/sessions',
      params: { customer: 'cus_1', return_url: 'https://forms.test/m/x' },
      options: { account: 'acct_1' },
    });
  });

  it('refuses a session URL that is not a web address', async () => {
    const stripe = new DevStripe();
    stripe.respond(/billing_portal/, { url: 'javascript:alert(1)' });
    await expect(billingPortalUrl(stripe, billing(), 'https://forms.test/m/x')).rejects.toThrow(
      BillingError,
    );
  });
});

describe('listInvoices', () => {
  it('lists finalized invoices with safe links', async () => {
    const stripe = new DevStripe();
    stripe.respond(/^GET \/v1\/invoices$/, {
      data: [
        {
          id: 'in_1',
          number: 'A-1',
          status: 'paid',
          amount_paid: 500,
          amount_due: 500,
          currency: 'usd',
          created: 1_790_000_000,
          hosted_invoice_url: 'https://invoice.stripe.com/i/1',
        },
        { id: 'in_2', status: 'open', amount_due: 700, currency: 'usd', created: 1_790_000_100 },
        { id: 'in_3', status: 'draft', amount_due: 700, currency: 'usd', created: 1 },
        {
          id: 'in_4',
          status: 'paid',
          amount_paid: 1,
          currency: 'usd',
          created: 1,
          hosted_invoice_url: 'javascript:alert(1)',
        },
      ],
    });
    const invoices = await listInvoices(stripe, billing());
    expect(invoices.map((i) => [i.id, i.amount, i.url])).toEqual([
      ['in_1', 500, 'https://invoice.stripe.com/i/1'],
      ['in_2', 700, null],
      ['in_4', 1, null],
    ]);
    expect(stripe.calls[0]).toMatchObject({
      params: { customer: 'cus_1', limit: 12 },
      options: { account: 'acct_1' },
    });
  });
});

describe('helpers', () => {
  it('finds only the Member’s own choices', () => {
    expect(findChoice(billing(), 'lp_plus')?.stripePriceId).toBe('price_plus');
    expect(findChoice(billing(), 'lp_other')).toBeNull();
    expect(findChoice(billing(), ['lp_plus'])).toBeNull();
  });

  it('honours a recent proration date only', () => {
    const seconds = String(Math.floor(now / 1000) - 60);
    expect(usableProrationDate(seconds, now)).toBe(Number(seconds));
    expect(usableProrationDate(String(Math.floor(now / 1000) - 3600), now)).toBeNull();
    expect(usableProrationDate(String(Math.floor(now / 1000) + 60), now)).toBeNull();
    expect(usableProrationDate('1e9', now)).toBeNull();
    expect(usableProrationDate(undefined, now)).toBeNull();
  });

  it('formats money in minor units', () => {
    expect(formatMoney(500, 'usd')).toBe('$5.00');
    expect(formatMoney(500, 'jpy')).toBe('¥500');
    expect(formatMoney(1999, 'eur')).toBe('€19.99');
  });

  it('admits through a Gate', () => {
    expect(gateAdmits([], 'lv_1')).toBe(true);
    expect(gateAdmits([], null)).toBe(true);
    expect(gateAdmits([], undefined)).toBe(false);
    expect(gateAdmits(['lv_1'], 'lv_1')).toBe(true);
    expect(gateAdmits(['lv_1'], 'lv_2')).toBe(false);
    expect(gateAdmits(['lv_1'], null)).toBe(false);
  });

  it('reads stored level lists defensively', () => {
    expect(normalizeLevelIds('["lv_1","lv_1",2,null,"lv_2"]')).toEqual(['lv_1', 'lv_2']);
    expect(normalizeLevelIds('{}')).toEqual([]);
    expect(normalizeLevelIds('nope')).toEqual([]);
    expect(normalizeLevelIds(null)).toEqual([]);
  });

  it('splits only paid Dispatches with a gate divider', () => {
    const gated = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph' }, { type: 'gate' }],
    });
    const plain = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(splitsByEntitlement({ web_visibility: 'paid', content_json: gated })).toBe(true);
    expect(splitsByEntitlement({ web_visibility: 'paid', content_json: plain })).toBe(false);
    expect(splitsByEntitlement({ web_visibility: 'members', content_json: gated })).toBe(false);
    expect(splitsByEntitlement({ web_visibility: 'paid', content_json: '{' })).toBe(false);
  });
});
