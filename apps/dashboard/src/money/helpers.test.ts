import { describe, expect, it } from 'vitest';
import {
  couponInput,
  currenciesOf,
  designInput,
  designProblems,
  discountLabel,
  durationLabel,
  emptyPrice,
  formatMoney,
  formatMoneyList,
  formatMrr,
  levelInput,
  majorValue,
  parseAmount,
  priceChange,
  priceLabel,
  priceProblems,
  primaryCurrency,
  revenueIsEmpty,
  revenueSeries,
  scheduleProblem,
  sourceLabel,
  type CouponDraft,
  type LevelDraft,
} from './helpers';

const NOW = Date.parse('2026-10-27T12:00:00Z');

describe('money in minor units', () => {
  it('formats per currency, with and without minor units', () => {
    expect(formatMoney(500, 'usd')).toBe('$5');
    expect(formatMoney(450, 'usd')).toBe('$4.50');
    expect(formatMoney(1999, 'eur')).toBe('€19.99');
    expect(formatMoney(500, 'jpy')).toBe('¥500');
    expect(formatMoney(0, 'gbp')).toBe('£0');
  });

  it('falls back for a code Intl does not know', () => {
    expect(formatMoney(1234, 'zzz')).toMatch(/12\.34/);
  });

  it('reads typed amounts as minor units', () => {
    expect(parseAmount('5', 'usd')).toBe(500);
    expect(parseAmount('4.5', 'usd')).toBe(450);
    expect(parseAmount('1,200.00', 'usd')).toBe(120000);
    expect(parseAmount('500', 'jpy')).toBe(500);
    expect(parseAmount('5.5', 'jpy')).toBeNull();
    expect(parseAmount('4.555', 'usd')).toBeNull();
    expect(parseAmount('-3', 'usd')).toBeNull();
    expect(parseAmount('', 'usd')).toBeNull();
    expect(parseAmount('1000000', 'usd')).toBeNull();
  });

  it('writes minor units back as an input value', () => {
    expect(majorValue(500, 'usd')).toBe('5');
    expect(majorValue(450, 'usd')).toBe('4.50');
    expect(majorValue(500, 'jpy')).toBe('500');
  });

  it('shows MRR and several currencies together', () => {
    expect(formatMrr([])).toBe('$0');
    expect(formatMrr([{ currency: 'usd', amount: 41666.67 }])).toBe('$416.67');
    expect(
      formatMoneyList([
        { currency: 'usd', amount: 12000 },
        { currency: 'eur', amount: 4000 },
      ]),
    ).toBe('$120 · €40');
    expect(formatMoneyList([])).toBe('—');
    expect(formatMoneyList([{ currency: 'eur', amount: 0 }])).toBe('€0');
  });

  it('labels prices as the plans page does', () => {
    const base = { currency: 'usd', customAmount: false, minAmount: null };
    expect(priceLabel({ ...base, interval: 'month', amount: 500 })).toBe('$5 a month');
    expect(priceLabel({ ...base, interval: 'year', amount: 5000 })).toBe('$50 a year');
    expect(priceLabel({ ...base, interval: 'lifetime', amount: 20000 })).toBe('$200 once');
    expect(
      priceLabel({ ...base, interval: 'month', amount: 800, customAmount: true, minAmount: 300 }),
    ).toBe('From $3 a month');
  });
});

describe('price checks mirror the API', () => {
  const price = { ...emptyPrice('month'), enabled: true };

  it('needs an amount of at least 0.50', () => {
    expect(priceProblems({ ...price, amount: '' }, 'usd').amount).toBe('Enter an amount.');
    expect(priceProblems({ ...price, amount: 'five' }, 'usd').amount).toMatch(/like 5/);
    expect(priceProblems({ ...price, amount: '0.40' }, 'usd').amount).toBe(
      'A price is at least $0.50.',
    );
    expect(priceProblems({ ...price, amount: '5' }, 'usd')).toEqual({});
  });

  it('checks pay what you want against its floor', () => {
    const pwyw = { ...price, customAmount: true };
    expect(priceProblems({ ...pwyw, amount: '5', minAmount: '' }, 'usd').minAmount).toBe(
      'Set the smallest amount.',
    );
    expect(priceProblems({ ...pwyw, amount: '5', minAmount: '0.2' }, 'usd').minAmount).toMatch(
      /at least \$0\.50/,
    );
    expect(priceProblems({ ...pwyw, amount: '2', minAmount: '3' }, 'usd').amount).toBe(
      'The suggested amount is at least the smallest amount.',
    );
    expect(priceProblems({ ...pwyw, amount: '5', minAmount: '3' }, 'usd')).toEqual({});
  });

  it('schedules a change between tomorrow and a year out', () => {
    expect(scheduleProblem('2026-10-27', NOW)).toBe('Choose a day after today.');
    expect(scheduleProblem('2026-11-01', NOW)).toBeNull();
    expect(scheduleProblem('2028-01-01', NOW)).toBe('Choose a day within a year.');
    expect(scheduleProblem('', NOW)).toBe('Choose a day.');
  });

  it('builds a price change: now keeps existing Members, a date may move them', () => {
    const draft = {
      amount: '7',
      customAmount: false,
      minAmount: '',
      when: 'now' as const,
      day: '2026-11-15',
      existing: 'migrate' as const,
    };
    expect(priceChange('month', draft, 'usd', NOW).input).toEqual({
      interval: 'month',
      amount: 700,
      customAmount: false,
      existing: 'grandfather',
    });
    expect(priceChange('month', { ...draft, when: 'scheduled' }, 'usd', NOW).input).toEqual({
      interval: 'month',
      amount: 700,
      customAmount: false,
      effectiveAt: '2026-11-15T00:00:00.000Z',
      existing: 'migrate',
    });
    // Lifetime purchases never renew, so nobody can be moved.
    expect(
      priceChange('lifetime', { ...draft, when: 'scheduled' }, 'usd', NOW).input?.existing,
    ).toBe('grandfather');
    expect(
      priceChange('month', { ...draft, when: 'scheduled', day: '2026-10-01' }, 'usd', NOW).problems
        .day,
    ).toBe('Choose a day after today.');
  });
});

describe('level form', () => {
  const draft = (patch: Partial<LevelDraft> = {}): LevelDraft => ({
    name: 'Supporter',
    description: '',
    benefits: ['Every Dispatch', '  ', 'The archive'],
    founding: false,
    visibility: 'public',
    trialDays: '0',
    currency: 'usd',
    prices: [
      { ...emptyPrice('month'), enabled: true, amount: '5' },
      { ...emptyPrice('year'), enabled: true, amount: '50' },
      emptyPrice('lifetime'),
    ],
    ...patch,
  });

  it('builds CreateMembershipLevel from the enabled prices', () => {
    expect(levelInput(draft()).input).toEqual({
      name: 'Supporter',
      description: null,
      benefits: ['Every Dispatch', 'The archive'],
      founding: false,
      visibility: 'public',
      trialDays: 0,
      currency: 'usd',
      prices: [
        { interval: 'month', amount: 500, customAmount: false },
        { interval: 'year', amount: 5000, customAmount: false },
      ],
    });
  });

  it('names the problems, field by field', () => {
    const { input, problems } = levelInput(
      draft({
        name: ' ',
        trialDays: '400',
        currency: 'us',
        prices: [{ ...emptyPrice('month'), enabled: true, amount: '0.1' }],
      }),
    );
    expect(input).toBeNull();
    expect(problems.name).toBe('Name the plan.');
    expect(problems.trialDays).toBe('Use 0 to 365 days.');
    expect(problems.currency).toMatch(/three-letter/);
    expect(problems.price.month?.amount).toMatch(/at least/);
  });

  it('needs a price, and a Founding Level has a fixed recurring one', () => {
    expect(levelInput(draft({ prices: [emptyPrice('year')] })).problems.prices).toBe(
      'Add at least one price.',
    );
    expect(
      levelInput(
        draft({
          founding: true,
          prices: [{ ...emptyPrice('lifetime'), enabled: true, amount: '500' }],
        }),
      ).problems.prices,
    ).toMatch(/founding plan/);
  });
});

describe('coupon form', () => {
  const draft = (patch: Partial<CouponDraft> = {}): CouponDraft => ({
    code: 'LAUNCH20',
    name: '',
    kind: 'percent',
    value: '20',
    currency: 'usd',
    duration: 'once',
    months: '3',
    maxRedemptions: '',
    expires: '',
    levelIds: [],
    ...patch,
  });

  it('builds a percentage coupon', () => {
    expect(couponInput(draft(), NOW).input).toEqual({
      code: 'LAUNCH20',
      percentOff: 20,
      duration: 'once',
      levelIds: [],
    });
  });

  it('builds an amount coupon with months, limits and an end day', () => {
    expect(
      couponInput(
        draft({
          kind: 'amount',
          value: '2.50',
          currency: 'EUR',
          duration: 'repeating',
          months: '6',
          maxRedemptions: '100',
          expires: '2026-12-31',
          levelIds: ['lv_1'],
        }),
        NOW,
      ).input,
    ).toEqual({
      code: 'LAUNCH20',
      amountOff: 250,
      currency: 'eur',
      duration: 'repeating',
      durationMonths: 6,
      maxRedemptions: 100,
      expiresAt: '2026-12-31T23:59:59.000Z',
      levelIds: ['lv_1'],
    });
  });

  it('mirrors the API checks', () => {
    const { problems } = couponInput(
      draft({
        code: 'no',
        value: '120',
        duration: 'repeating',
        months: '40',
        expires: '2026-01-01',
      }),
      NOW,
    );
    expect(problems).toEqual({
      code: 'Use 3 to 40 letters and digits.',
      value: 'Use a whole percentage from 1 to 100.',
      months: 'Use 1 to 36 months.',
      expires: 'Choose a day from today on.',
    });
    expect(couponInput(draft({ maxRedemptions: '0' }), NOW).problems.maxRedemptions).toBeTruthy();
  });

  it('describes a coupon', () => {
    expect(discountLabel({ percentOff: 20, amountOff: null, currency: null })).toBe('20% off');
    expect(discountLabel({ percentOff: null, amountOff: 500, currency: 'usd' })).toBe('$5 off');
    expect(durationLabel({ duration: 'repeating', durationMonths: 3 })).toBe('For 3 months');
    expect(durationLabel({ duration: 'once', durationMonths: null })).toBe('First payment');
  });
});

describe('Gate design', () => {
  it('keeps only the filled-in parts', () => {
    expect(designInput({ headline: ' Hi ', body: '', ctaLabel: '', benefits: 'A\n\n B ' })).toEqual(
      {
        headline: 'Hi',
        benefits: ['A', 'B'],
      },
    );
    expect(designInput({ headline: '', body: '', ctaLabel: '', benefits: '' })).toEqual({});
  });

  it('checks lengths', () => {
    expect(
      designProblems({
        headline: 'x'.repeat(121),
        body: '',
        ctaLabel: 'y'.repeat(41),
        benefits: Array.from({ length: 11 }, (_, i) => `b${i}`).join('\n'),
      }),
    ).toEqual({
      headline: 'Keep it under 120 characters.',
      ctaLabel: 'Keep it under 40 characters.',
      benefits: 'Keep it to 10 benefits.',
    });
  });
});

describe('revenue', () => {
  const revenue = {
    from: '2026-10-01',
    to: '2026-10-04',
    mrr: [{ currency: 'usd', amount: 1000 }],
    trialMrr: [],
    activePaid: 2,
    trialing: 0,
    complimentary: 0,
    churn: { activeAtStart: 0, canceled: 0, rate: null },
    newPaid: 2,
    conversionBySource: [],
    revenueByDay: [
      { day: '2026-10-02', currency: 'usd', amount: 500 },
      { day: '2026-10-02', currency: 'eur', amount: 900 },
      { day: '2026-10-04', currency: 'usd', amount: -200 },
    ],
    lifetimeRevenue: [
      { currency: 'usd', amount: 300 },
      { currency: 'eur', amount: 900 },
    ],
  };

  it('fills the empty days for one currency', () => {
    expect(revenueSeries(revenue, 'usd')).toEqual([
      { day: '2026-10-01', amount: 0 },
      { day: '2026-10-02', amount: 500 },
      { day: '2026-10-03', amount: 0 },
      { day: '2026-10-04', amount: -200 },
    ]);
  });

  it('picks the currency with the most money first', () => {
    expect(primaryCurrency(revenue)).toBe('usd');
    expect(currenciesOf(revenue)).toEqual(['usd', 'eur']);
    expect(primaryCurrency({ lifetimeRevenue: [], mrr: [], revenueByDay: [] })).toBe('usd');
  });

  it('knows when nothing has happened yet', () => {
    expect(revenueIsEmpty(revenue)).toBe(false);
    expect(
      revenueIsEmpty({
        ...revenue,
        mrr: [],
        activePaid: 0,
        newPaid: 0,
        revenueByDay: [],
        lifetimeRevenue: [],
      }),
    ).toBe(true);
  });

  it('names where access comes from', () => {
    expect(sourceLabel('comp')).toBe('Complimentary access');
    expect(sourceLabel('gift')).toBe('Gift subscription');
    expect(sourceLabel('something')).toBe('Paid access');
  });
});
