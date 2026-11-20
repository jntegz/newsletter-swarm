// Money on the site: amounts are stored in minor units (cents) with a lowercase ISO 4217
// currency, as Stripe uses. Readers type major units ("12" or "12.50").

/** Currencies Stripe treats as having no minor unit. */
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

/** Stripe's largest amount for one charge, in minor units. */
const MAX_AMOUNT = 99_999_999;

const decimals = (currency: string) => (ZERO_DECIMAL.has(currency.toLowerCase()) ? 0 : 2);

/** "$12.50", "€5", "¥500". */
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

/** A typed amount in major units as minor units, or null when it isn't a positive amount. */
export function parseAmount(input: string, currency: string): number | null {
  const value = input.trim().replace(/,/g, '');
  const digits = decimals(currency);
  const pattern = digits === 0 ? /^\d{1,9}$/ : /^\d{1,9}(\.\d{1,2})?$/;
  if (!pattern.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0');
  if (!Number.isSafeInteger(minor) || minor <= 0 || minor > MAX_AMOUNT) return null;
  return minor;
}

/** Minor units as the value of a major-unit input ("12.50", "500"). */
export function majorValue(amount: number, currency: string): string {
  const digits = decimals(currency);
  const major = amount / 10 ** digits;
  return Number.isInteger(major) ? String(major) : major.toFixed(digits);
}
