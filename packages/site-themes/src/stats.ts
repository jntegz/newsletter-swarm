// A/B test results on a section (docs/site-themes.md): the signup rate of each variant, how sure
// the difference is (a two-proportion z-test) and about how many more views would settle it. Pure,
// so the API and the dashboard compute the same numbers.
import type { Variant } from './theme';

interface VariantCounts {
  /** Views that reached the section (its beacon loaded). */
  reached: number;
  /** Signups through the section's form. */
  signups: number;
}

interface VariantRate extends VariantCounts {
  /** signups / reached, 0 before any view, at most 1. */
  rate: number;
}

export interface TestResult {
  a: VariantRate;
  b: VariantRate;
  /** B's rate minus A's (0.009 is 0.9 percentage points). */
  difference: number;
  /**
   * How sure it is that the rates really differ: 1 minus the two-sided p-value of a two-proportion
   * z-test. 0 when there is nothing to compare yet.
   */
  confidence: number;
  /** The variant with the higher rate, or null while they are level. */
  leader: Variant | null;
  /** At least 95% sure, with enough views on each side. */
  decided: boolean;
  /**
   * About how many more views (both variants together) it takes to be 95% sure, if the rates
   * stay as they are: 0 once decided, null while there is no difference to measure.
   */
  viewsNeeded: number | null;
}

/** How sure a result must be before the dashboard calls it. */
const CONFIDENCE_GOAL = 0.95;
/** Views each variant needs before a result is called, however sure the test looks. */
const MIN_VIEWS_PER_VARIANT = 100;
/** The z score of a two-sided 95% test. */
const Z_GOAL = 1.959963984540054;

const count = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export function withRate(counts: VariantCounts): VariantRate {
  const reached = count(counts.reached);
  const signups = count(counts.signups);
  return { reached, signups, rate: reached > 0 ? Math.min(1, signups / reached) : 0 };
}

/** erf, Abramowitz and Stegun 7.1.26 (error under 1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}

/** The standard normal distribution function. */
export const normalCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

/** Up to two significant figures, rounding up: 1,734 is "about 1,800". */
export function roundUpViews(n: number): number {
  if (n <= 0) return 0;
  if (n <= 100) return Math.ceil(n / 10) * 10;
  const step = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.ceil(n / step) * step;
}

/** The result of a test from each variant's counts. */
export function testResult(a: VariantCounts, b: VariantCounts): TestResult {
  const ra = withRate(a);
  const rb = withRate(b);
  const difference = rb.rate - ra.rate;
  const leader: Variant | null = difference > 0 ? 'b' : difference < 0 ? 'a' : null;
  const views = ra.reached + rb.reached;
  const pooled = views > 0 ? Math.min(1, (ra.signups + rb.signups) / views) : 0;
  const spread = pooled * (1 - pooled);

  let confidence = 0;
  if (ra.reached > 0 && rb.reached > 0 && spread > 0) {
    const se = Math.sqrt(spread * (1 / ra.reached + 1 / rb.reached));
    const z = Math.abs(difference) / se;
    confidence = Math.max(0, Math.min(1, 2 * normalCdf(z) - 1));
  }
  const enoughViews = ra.reached >= MIN_VIEWS_PER_VARIANT && rb.reached >= MIN_VIEWS_PER_VARIANT;
  const decided = enoughViews && confidence >= CONFIDENCE_GOAL;

  let viewsNeeded: number | null = null;
  if (decided) viewsNeeded = 0;
  else if (leader && spread > 0) {
    // Equal views on each side: z grows with the square root of the views per variant.
    const perVariant = (2 * spread * Z_GOAL ** 2) / difference ** 2;
    const total = Math.max(2 * perVariant, 2 * MIN_VIEWS_PER_VARIANT);
    viewsNeeded = roundUpViews(Math.max(total - views, MIN_VIEWS_PER_VARIANT / 10));
  }
  return { a: ra, b: rb, difference, confidence, leader, decided, viewsNeeded };
}
