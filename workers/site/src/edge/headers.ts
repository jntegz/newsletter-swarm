// Response headers for site pages.
//
// The shared runtime (useRuntime) sets HSTS, nosniff, X-Frame-Options, a strict referrer policy
// and same-origin CORP on everything, overwriting whatever a route set. On the site a header a
// route sets explicitly wins: reader pages send `Referrer-Policy: no-referrer`, public media sends
// `Cross-Origin-Resource-Policy: cross-origin`. So the worker records a route's own values on the
// way out (keepRouteHeaders, inside the runtime) and puts them back after the runtime has run
// (siteHeaders, registered before it), which also adds the site CSP and Permissions-Policy.
import { TURNSTILE_ORIGIN } from '@swarm/engine';
import type { MiddlewareHandler } from 'hono';
import type { SiteBindings } from '../context';
import type { SiteEnv } from '../env';

/** Headers the runtime overwrites; a value a route set itself is kept. */
const RUNTIME_HEADERS = [
  'referrer-policy',
  'x-frame-options',
  'cross-origin-resource-policy',
  'cross-origin-opener-policy',
  'x-content-type-options',
] as const;

const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()';

/**
 * Pages with payment forms: only the plans page. Its checkout, gift, tip and pledge forms carry a
 * Turnstile widget, and its checkout and billing posts answer with a redirect to Stripe, which
 * form-action must allow (browsers apply it to the redirect too). Decided by path, not by the
 * route, so a cached copy gets the same policy on a hit.
 */
const PAYMENT_PAGE_PATHS = new Set(['/subscribe', '/sponsor']);

/** The pages whose forms lead to payment, by path, so a cached copy gets the same policy. */
export const isPaymentPath = (path: string) =>
  PAYMENT_PAGE_PATHS.has(path) || path.startsWith('/goods/') || path.startsWith('/_swarm/join/');

/** Where checkout and billing posts redirect to. */
const STRIPE_FORM_TARGETS =
  'https://checkout.stripe.com https://billing.stripe.com https://www.paypal.com https://www.sandbox.paypal.com';

/**
 * The CSP for site HTML. Raw HTML blocks render in `<iframe sandbox srcdoc>`: a srcdoc document
 * inherits this policy and loads nothing itself, so they need no exception (frame-src does not
 * apply to srcdoc); inline styles and third-party images inside them stay blocked.
 *
 * With `payments` (the plans page), Cloudflare's challenge script and frame
 * (challenges.cloudflare.com) are allowed, and forms may lead to Stripe Checkout, the Billing
 * Portal and PayPal's approval page; nothing else changes.
 *
 * With `players` (a page showing an embed that can play), frame-src also names those players'
 * origins, so a reader's click can load one. Owner code's frame-src already covers them.
 */
export function siteCsp(
  env: Pick<SiteEnv, 'MEDIA_ORIGIN' | 'CAPTURE_ORIGIN'>,
  nonce: string,
  options: { payments?: boolean; ownerCode?: boolean; players?: readonly string[] } = {},
) {
  const media = new URL(env.MEDIA_ORIGIN).origin;
  const capture = new URL(env.CAPTURE_ORIGIN).origin;
  const challenge = options.payments ? ` ${TURNSTILE_ORIGIN}` : '';
  const stripe = options.payments ? ` ${STRIPE_FORM_TARGETS}` : '';
  const players = (options.players ?? []).map((origin) => ` ${origin}`).join('');
  return [
    "default-src 'none'",
    // Owner code loads what it needs, so scripts a nonce'd script starts may run; 'strict-dynamic'
    // ignores host sources, which is why the Turnstile tags carry the nonce too.
    `script-src 'nonce-${nonce}'${options.ownerCode ? " 'strict-dynamic'" : ''}${challenge}`,
    // A nonce here would switch 'unsafe-inline' off, and tools add their own inline styles.
    options.ownerCode
      ? "style-src 'self' 'unsafe-inline' https:"
      : `style-src 'self' 'nonce-${nonce}'`,
    // Dispatches may show images from any https address (the web renderer allows them).
    `img-src 'self' ${media} https: data:`,
    options.ownerCode ? "font-src 'self' https: data:" : "font-src 'self'",
    options.ownerCode ? "connect-src 'self' https:" : "connect-src 'self'",
    "manifest-src 'self'",
    `form-action 'self' ${capture}${stripe}`,
    options.ownerCode ? "frame-src 'self' https:" : `frame-src 'self'${challenge}${players}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** For HTML answered before the Channel or the env is known (unknown hosts, invalid env). */
const FALLBACK_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const isHtml = (res: Response) =>
  (res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html');

/** Inside the runtime: records the security headers a route set itself. */
export const keepRouteHeaders: MiddlewareHandler<SiteBindings> = async (c, next) => {
  await next();
  const kept: Record<string, string> = {};
  for (const name of RUNTIME_HEADERS) {
    const value = c.res.headers.get(name);
    if (value !== null) kept[name] = value;
  }
  c.set('routeHeaders', kept);
};

/** Outside the runtime: restores route headers, then adds the CSP and Permissions-Policy. */
export const siteHeaders: MiddlewareHandler<SiteBindings> = async (c, next) => {
  await next();
  const headers = c.res.headers;
  for (const [name, value] of Object.entries(c.get('routeHeaders') ?? {})) {
    headers.set(name, value);
  }
  if (isHtml(c.res) && !headers.has('content-security-policy')) {
    const env = c.get('env') as SiteEnv | undefined;
    const nonce = c.get('nonce') as string | undefined;
    const path = new URL(c.req.url).pathname;
    const payments = isPaymentPath(path);
    headers.set(
      'content-security-policy',
      env && nonce ? siteCsp(env, nonce, { payments }) : FALLBACK_CSP,
    );
  }
  // A page the route lets another origin frame (a design preview, for the dashboard) says so with
  // frame-ancestors; X-Frame-Options can't name an origin, so it goes.
  const ancestors = /frame-ancestors ([^;]+)/.exec(headers.get('content-security-policy') ?? '');
  if (ancestors && ancestors[1]?.trim() !== "'none'") headers.delete('x-frame-options');
  if (!headers.has('permissions-policy')) headers.set('permissions-policy', PERMISSIONS_POLICY);
};
