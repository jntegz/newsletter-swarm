// Pure helpers for the Memberships pages: money in minor units, price and coupon form checks that
// mirror the API's schemas, and revenue shaping. Kept free of React so they can be unit tested.
import {
  MAX_BENEFITS,
  MAX_PRICE_AMOUNT,
  MIN_PRICE_AMOUNT,
  type Coupon,
  type CreateCoupon,
  type CreateLevelPrice,
  type CreateMembershipLevel,
  type GateDesign,
  type LevelPrice,
  type PriceInterval,
  type Revenue,
} from '@swarm/domain';

// ---- Money ---------------------------------------------------------------------------------

/** Currencies Stripe treats as having no minor unit (the site worker uses the same list). */
const ZERO_DECIMAL = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'ugx',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
]);

/** Digits after the decimal point for a currency: 0 for yen and friends, else 2. */
const decimals = (currency: string) => (ZERO_DECIMAL.has(currency.toLowerCase()) ? 0 : 2);

/** Minor units as a price: "$12.50", "$5", "¥500". */
export function formatMoney(amount: number, currency: string): string {
  const digits = decimals(currency);
  const major = amount / 10 ** digits;
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: Number.isInteger(major) ? 0 : digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    return `${major.toFixed(digits)} ${currency.toUpperCase()}`;
  }
}

/** Minor units as the value of a major-unit input ("12.50", "500"). */
export function majorValue(amount: number, currency: string): string {
  const digits = decimals(currency);
  const major = amount / 10 ** digits;
  return Number.isInteger(major) ? String(major) : major.toFixed(digits);
}

/**
 * A typed amount in major units ("12", "12.5", "1,200.00") as minor units, or null when it isn't
 * a non-negative amount the currency can hold.
 */
export function parseAmount(input: string, currency: string): number | null {
  const value = input.trim().replace(/,/g, '');
  const digits = decimals(currency);
  const pattern = digits === 0 ? /^\d{1,9}$/ : /^\d{1,9}(\.\d{1,2})?$/;
  if (!pattern.test(value)) return null;
  const [whole = '0', fraction = ''] = value.split('.');
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0');
  if (!Number.isSafeInteger(minor) || minor > MAX_PRICE_AMOUNT) return null;
  return minor;
}

/** Several currencies at once, as the revenue numbers come: "$120 · €40", or "—" for none. */
export function formatMoneyList(list: readonly { currency: string; amount: number }[]): string {
  const shown = list.filter((m) => m.amount !== 0);
  if (shown.length === 0) return list.length ? formatMoney(0, list[0]!.currency) : '—';
  return shown.map((m) => formatMoney(Math.round(m.amount), m.currency)).join(' · ');
}

/** MRR per currency, rounded to whole minor units (yearly plans are divided by 12 server-side). */
export const formatMrr = (mrr: Revenue['mrr']) =>
  mrr.length === 0 ? formatMoney(0, 'usd') : formatMoneyList(mrr);

export const INTERVAL_LABEL: Record<PriceInterval, string> = {
  month: 'Monthly',
  year: 'Yearly',
  lifetime: 'Lifetime',
};

/** How the plans page shows a price: "$5 a month", "$200 once", "From $3 a month". */
export function priceLabel(
  price: Pick<LevelPrice, 'amount' | 'currency' | 'interval' | 'customAmount' | 'minAmount'>,
): string {
  const base =
    price.customAmount && price.minAmount !== null
      ? `From ${formatMoney(price.minAmount, price.currency)}`
      : formatMoney(price.amount, price.currency);
  return price.interval === 'lifetime' ? `${base} once` : `${base} a ${price.interval}`;
}

// ---- Prices --------------------------------------------------------------------------------

export interface PriceDraft {
  interval: PriceInterval;
  enabled: boolean;
  /** Major units as typed. For pay what you want: the suggested amount. */
  amount: string;
  customAmount: boolean;
  /** Major units as typed; pay what you want only. */
  minAmount: string;
}

export const emptyPrice = (interval: PriceInterval): PriceDraft => ({
  interval,
  enabled: interval === 'month',
  amount: '',
  customAmount: false,
  minAmount: '',
});

interface PriceProblems {
  amount?: string;
  minAmount?: string;
}

/** The problems with one price, mirroring the API's checkPrice. */
export function priceProblems(draft: PriceDraft, currency: string): PriceProblems {
  const problems: PriceProblems = {};
  const floor = formatMoney(MIN_PRICE_AMOUNT, currency);
  const amount = parseAmount(draft.amount, currency);
  if (amount === null) {
    problems.amount = draft.amount.trim() ? 'Enter an amount, like 5 or 4.50.' : 'Enter an amount.';
  }
  if (draft.customAmount) {
    const min = parseAmount(draft.minAmount, currency);
    if (min === null) problems.minAmount = 'Set the smallest amount.';
    else if (min < MIN_PRICE_AMOUNT)
      problems.minAmount = `The smallest amount is at least ${floor}.`;
    else if (amount !== null && amount < min) {
      problems.amount = 'The suggested amount is at least the smallest amount.';
    }
  } else if (amount !== null && amount < MIN_PRICE_AMOUNT) {
    problems.amount = `A price is at least ${floor}.`;
  }
  return problems;
}

/** A price draft as the API's PriceInput, or null when it has problems. */
function priceInput(draft: PriceDraft, currency: string) {
  if (Object.keys(priceProblems(draft, currency)).length) return null;
  const amount = parseAmount(draft.amount, currency) as number;
  return draft.customAmount
    ? {
        interval: draft.interval,
        amount,
        customAmount: true,
        minAmount: parseAmount(draft.minAmount, currency),
      }
    : { interval: draft.interval, amount, customAmount: false };
}

/** A scheduled change's day (YYYY-MM-DD) as the API's effectiveAt: midnight UTC that day. */
const effectiveAtOf = (day: string) => `${day}T00:00:00.000Z`;

/** The problem with a scheduled day, or null: from tomorrow to a year ahead, as the API allows. */
export function scheduleProblem(day: string, now = Date.now()): string | null {
  const at = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(at)) return 'Choose a day.';
  if (at <= now) return 'Choose a day after today.';
  if (at > now + 365 * 86_400_000) return 'Choose a day within a year.';
  return null;
}

export interface PriceChangeDraft {
  amount: string;
  customAmount: boolean;
  minAmount: string;
  when: 'now' | 'scheduled';
  day: string;
  existing: 'grandfather' | 'migrate';
}

/** A price change as the API's CreateLevelPrice, or the problems that stop it. */
export function priceChange(
  interval: PriceInterval,
  draft: PriceChangeDraft,
  currency: string,
  now = Date.now(),
): { input: CreateLevelPrice | null; problems: PriceProblems & { day?: string } } {
  const problems: PriceProblems & { day?: string } = priceProblems(
    { interval, enabled: true, ...draft },
    currency,
  );
  if (draft.when === 'scheduled') {
    const day = scheduleProblem(draft.day, now);
    if (day) problems.day = day;
  }
  const base = priceInput({ interval, enabled: true, ...draft }, currency);
  if (!base || Object.keys(problems).length) return { input: null, problems };
  const scheduled = draft.when === 'scheduled';
  return {
    input: {
      ...base,
      ...(scheduled ? { effectiveAt: effectiveAtOf(draft.day) } : {}),
      // Moving existing Members needs a scheduled change and a renewal.
      existing:
        scheduled && interval !== 'lifetime' && draft.existing === 'migrate'
          ? 'migrate'
          : 'grandfather',
    } as CreateLevelPrice,
    problems,
  };
}

// ---- Levels --------------------------------------------------------------------------------

/** Benefit lines as the API keeps them: trimmed, without blanks, at most MAX_BENEFITS. */
export const cleanBenefits = (lines: readonly string[]) =>
  lines.map((line) => line.trim()).filter(Boolean);

export function benefitsProblem(lines: readonly string[]): string | null {
  const benefits = cleanBenefits(lines);
  if (benefits.length > MAX_BENEFITS) return `Keep it to ${MAX_BENEFITS} benefits.`;
  if (benefits.some((b) => b.length > 120)) return 'Keep each benefit under 120 characters.';
  return null;
}

export interface LevelDraft {
  name: string;
  description: string;
  benefits: string[];
  founding: boolean;
  visibility: 'public' | 'hidden';
  trialDays: string;
  currency: string;
  prices: PriceDraft[];
}

interface LevelProblems {
  name?: string;
  description?: string;
  benefits?: string;
  trialDays?: string;
  currency?: string;
  prices?: string;
  price: Partial<Record<PriceInterval, PriceProblems>>;
}

const hasProblems = (p: LevelProblems) =>
  Object.keys(p).some((k) => k !== 'price') || Object.keys(p.price).length > 0;

/** Checks a new level the way CreateMembershipLevelSchema does and builds its input. */
export function levelInput(draft: LevelDraft): {
  input: CreateMembershipLevel | null;
  problems: LevelProblems;
} {
  const problems: LevelProblems = { price: {} };
  const name = draft.name.trim();
  if (!name) problems.name = 'Name the plan.';
  else if (name.length > 60) problems.name = 'Keep the name under 60 characters.';
  if (draft.description.trim().length > 500) {
    problems.description = 'Keep the description under 500 characters.';
  }
  const benefits = benefitsProblem(draft.benefits);
  if (benefits) problems.benefits = benefits;
  const trial = Number(draft.trialDays || '0');
  if (!/^\d{1,3}$/.test(draft.trialDays || '0') || trial > 365) {
    problems.trialDays = 'Use 0 to 365 days.';
  }
  const currency = draft.currency.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) problems.currency = 'Use a three-letter code, like usd.';
  const enabled = draft.prices.filter((p) => p.enabled);
  if (enabled.length === 0) problems.prices = 'Add at least one price.';
  for (const price of enabled) {
    const found = priceProblems(price, currency || 'usd');
    if (Object.keys(found).length) problems.price[price.interval] = found;
  }
  if (draft.founding && enabled.some((p) => p.interval === 'lifetime' || p.customAmount)) {
    problems.prices = 'A founding plan has a fixed monthly or yearly price.';
  }
  if (hasProblems(problems)) return { input: null, problems };
  return {
    input: {
      name,
      description: draft.description.trim() || null,
      benefits: cleanBenefits(draft.benefits),
      founding: draft.founding,
      visibility: draft.visibility,
      trialDays: trial,
      currency,
      prices: enabled.map((p) => priceInput(p, currency)!) as CreateMembershipLevel['prices'],
    },
    problems,
  };
}

/** The level's active price for an interval, and the scheduled change waiting for it. */
export function pricesFor(prices: readonly LevelPrice[], interval: PriceInterval) {
  return {
    active: prices.find((p) => p.interval === interval && p.status === 'active') ?? null,
    scheduled: prices.find((p) => p.interval === interval && p.status === 'scheduled') ?? null,
  };
}

// ---- Coupons -------------------------------------------------------------------------------

export interface CouponDraft {
  code: string;
  name: string;
  kind: 'percent' | 'amount';
  value: string;
  currency: string;
  duration: 'once' | 'repeating' | 'forever';
  months: string;
  maxRedemptions: string;
  expires: string;
  levelIds: string[];
}

type CouponProblems = Partial<Record<keyof CouponDraft, string>>;

/** Checks a coupon the way CreateCouponSchema does and builds its input. */
export function couponInput(
  draft: CouponDraft,
  now = Date.now(),
): { input: CreateCoupon | null; problems: CouponProblems } {
  const problems: CouponProblems = {};
  const code = draft.code.trim();
  if (!/^[A-Za-z0-9]{3,40}$/.test(code)) problems.code = 'Use 3 to 40 letters and digits.';
  if (draft.name.trim().length > 60) problems.name = 'Keep the name under 60 characters.';
  const currency = draft.currency.trim().toLowerCase();
  let percentOff: number | undefined;
  let amountOff: number | undefined;
  if (draft.kind === 'percent') {
    const value = Number(draft.value);
    if (!/^\d{1,3}$/.test(draft.value.trim()) || value < 1 || value > 100) {
      problems.value = 'Use a whole percentage from 1 to 100.';
    } else percentOff = value;
  } else {
    if (!/^[a-z]{3}$/.test(currency)) problems.currency = 'Use a three-letter code, like usd.';
    const value = parseAmount(draft.value, currency || 'usd');
    if (value === null || value < 1) problems.value = 'Enter an amount off, like 5 or 2.50.';
    else amountOff = value;
  }
  let months: number | undefined;
  if (draft.duration === 'repeating') {
    const value = Number(draft.months);
    if (!/^\d{1,2}$/.test(draft.months.trim()) || value < 1 || value > 36) {
      problems.months = 'Use 1 to 36 months.';
    } else months = value;
  }
  let maxRedemptions: number | undefined;
  if (draft.maxRedemptions.trim()) {
    const value = Number(draft.maxRedemptions);
    if (!/^\d{1,7}$/.test(draft.maxRedemptions.trim()) || value < 1 || value > 1_000_000) {
      problems.maxRedemptions = 'Use a number from 1 to 1,000,000, or leave it empty.';
    } else maxRedemptions = value;
  }
  let expiresAt: string | undefined;
  if (draft.expires) {
    // The coupon works through the chosen day (UTC).
    const at = Date.parse(`${draft.expires}T23:59:59Z`);
    if (Number.isNaN(at) || at <= now) problems.expires = 'Choose a day from today on.';
    else expiresAt = new Date(at).toISOString();
  }
  if (Object.keys(problems).length) return { input: null, problems };
  return {
    input: {
      code,
      ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
      ...(percentOff !== undefined ? { percentOff } : {}),
      ...(amountOff !== undefined ? { amountOff, currency } : {}),
      duration: draft.duration,
      ...(months !== undefined ? { durationMonths: months } : {}),
      ...(maxRedemptions !== undefined ? { maxRedemptions } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      levelIds: draft.levelIds,
    },
    problems,
  };
}

/** "20% off", "$5 off". */
export function discountLabel(coupon: Pick<Coupon, 'percentOff' | 'amountOff' | 'currency'>) {
  if (coupon.percentOff !== null) return `${coupon.percentOff}% off`;
  return `${formatMoney(coupon.amountOff ?? 0, coupon.currency ?? 'usd')} off`;
}

/** "Once", "For 3 months", "Forever". */
export function durationLabel(coupon: Pick<Coupon, 'duration' | 'durationMonths'>) {
  if (coupon.duration === 'once') return 'First payment';
  if (coupon.duration === 'forever') return 'Every payment';
  const months = coupon.durationMonths ?? 1;
  return `For ${months} month${months === 1 ? '' : 's'}`;
}

// ---- Gates ---------------------------------------------------------------------------------

export interface GateDesignDraft {
  headline: string;
  body: string;
  ctaLabel: string;
  benefits: string;
}

export const designDraft = (design: GateDesign): GateDesignDraft => ({
  headline: design.headline ?? '',
  body: design.body ?? '',
  ctaLabel: design.ctaLabel ?? '',
  benefits: (design.benefits ?? []).join('\n'),
});

/** A Gate design as the API keeps it: only the parts that are filled in. */
export function designInput(draft: GateDesignDraft): GateDesign {
  const benefits = cleanBenefits(draft.benefits.split('\n'));
  return {
    ...(draft.headline.trim() ? { headline: draft.headline.trim() } : {}),
    ...(draft.body.trim() ? { body: draft.body.trim() } : {}),
    ...(draft.ctaLabel.trim() ? { ctaLabel: draft.ctaLabel.trim() } : {}),
    ...(benefits.length ? { benefits } : {}),
  };
}

export function designProblems(
  draft: GateDesignDraft,
): Partial<Record<keyof GateDesignDraft, string>> {
  const problems: Partial<Record<keyof GateDesignDraft, string>> = {};
  if (draft.headline.trim().length > 120) problems.headline = 'Keep it under 120 characters.';
  if (draft.body.trim().length > 600) problems.body = 'Keep it under 600 characters.';
  if (draft.ctaLabel.trim().length > 40) problems.ctaLabel = 'Keep it under 40 characters.';
  const benefits = cleanBenefits(draft.benefits.split('\n'));
  if (benefits.length > 10) problems.benefits = 'Keep it to 10 benefits.';
  else if (benefits.some((b) => b.length > 120)) {
    problems.benefits = 'Keep each benefit under 120 characters.';
  }
  return problems;
}

// ---- Revenue -------------------------------------------------------------------------------

/** The currency the revenue chart shows first: the one with the most lifetime revenue. */
export function primaryCurrency(
  revenue: Pick<Revenue, 'lifetimeRevenue' | 'mrr' | 'revenueByDay'>,
) {
  const totals = new Map<string, number>();
  for (const m of [...revenue.lifetimeRevenue, ...revenue.mrr]) {
    totals.set(m.currency, (totals.get(m.currency) ?? 0) + Math.abs(m.amount));
  }
  for (const d of revenue.revenueByDay) totals.set(d.currency, totals.get(d.currency) ?? 0);
  return [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'usd';
}

/** Every currency in the revenue numbers, most money first. */
export function currenciesOf(revenue: Pick<Revenue, 'lifetimeRevenue' | 'mrr' | 'revenueByDay'>) {
  const first = primaryCurrency(revenue);
  const all = new Set([
    first,
    ...revenue.lifetimeRevenue.map((m) => m.currency),
    ...revenue.mrr.map((m) => m.currency),
    ...revenue.revenueByDay.map((d) => d.currency),
  ]);
  return [...all];
}

/** Net revenue per UTC day in one currency, with the empty days filled in. */
export function revenueSeries(
  revenue: Pick<Revenue, 'from' | 'to' | 'revenueByDay'>,
  currency: string,
): { day: string; amount: number }[] {
  const byDay = new Map<string, number>();
  for (const d of revenue.revenueByDay) {
    if (d.currency === currency) byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.amount);
  }
  const out: { day: string; amount: number }[] = [];
  const end = Date.parse(`${revenue.to}T00:00:00Z`);
  for (let at = Date.parse(`${revenue.from}T00:00:00Z`); at <= end; at += 86_400_000) {
    const day = new Date(at).toISOString().slice(0, 10);
    out.push({ day, amount: byDay.get(day) ?? 0 });
    if (out.length > 400) break;
  }
  return out;
}

/** True when nothing has happened yet: no paid Members, no money in, ever. */
export const revenueIsEmpty = (revenue: Revenue) =>
  revenue.activePaid === 0 &&
  revenue.trialing === 0 &&
  revenue.complimentary === 0 &&
  revenue.newPaid === 0 &&
  revenue.churn.activeAtStart === 0 &&
  revenue.revenueByDay.length === 0 &&
  revenue.lifetimeRevenue.every((m) => m.amount === 0);

// ---- Membership ----------------------------------------------------------------------------

const SOURCE_LABEL: Record<string, string> = {
  stripe: 'Paid subscription',
  lifetime: 'Lifetime purchase',
  gift: 'Gift subscription',
  comp: 'Complimentary access',
};

/** Where a Member's access comes from, in words. */
export const sourceLabel = (source: string) => SOURCE_LABEL[source] ?? 'Paid access';
