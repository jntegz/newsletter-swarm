// Checks shared by the payment posts (checkout, pledge, portal, gifts): same-site posts only, a
// per-IP rate limit, and Turnstile.
import { verifyTurnstileToken } from '@swarm/engine';
import type { SiteContext } from '../context';
import { readerPage } from '../readers/pages';
import { crossSite } from '../routes/reader';

export { crossSite };

const local = (c: SiteContext) =>
  c.get('env').ENVIRONMENT === 'development' || c.get('env').ENVIRONMENT === 'test';

/** CHECKOUT_LIMITER: 10 posts a minute per client IP; fails closed outside development. */
export async function underPaymentLimit(c: SiteContext, kind: string): Promise<boolean> {
  const limiter = c.get('env').CHECKOUT_LIMITER;
  if (!limiter) return local(c);
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const { success } = await limiter.limit({ key: `${kind}:${ip}` });
  return success;
}

/**
 * Verifies the form's Turnstile token for `action`. The widget renders on this site, so outside
 * development the token must have been issued on this request's hostname.
 */
export function turnstilePassed(
  c: SiteContext,
  form: Record<string, unknown>,
  action: string,
): Promise<boolean> {
  const token = form['cf-turnstile-response'];
  return verifyTurnstileToken({
    secret: c.get('env').TURNSTILE_SECRET_KEY,
    token: typeof token === 'string' ? token : null,
    ip: c.req.header('cf-connecting-ip'),
    action,
    hostname: local(c) ? null : new URL(c.req.url).hostname,
  });
}

/**
 * Whether a post was made by script rather than by the reader submitting a form: browsers mark
 * fetch() and XMLHttpRequest with a Sec-Fetch-Mode other than navigate, and a form aimed at a
 * frame with a Sec-Fetch-Dest other than document, and page script can set neither. Reader
 * actions whose answer is a secret (a gift link) refuse these, so code running on one of the
 * site's pages can't take the answer for itself. Clients that send neither header are not
 * browsers running page code.
 */
export function scriptedRequest(c: SiteContext): boolean {
  const mode = c.req.header('sec-fetch-mode');
  const dest = c.req.header('sec-fetch-dest');
  return (mode !== undefined && mode !== 'navigate') || (dest !== undefined && dest !== 'document');
}

export function field(form: Record<string, unknown>, name: string, max = 500): string {
  const value = form[name];
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export const refused = (c: SiteContext) =>
  readerPage(c, 'Not sent', '<h1>This form must be sent from this site</h1>', 403);

export function tooMany(c: SiteContext): Response {
  c.header('retry-after', '60');
  return readerPage(
    c,
    'Too many attempts',
    '<h1>Too many attempts</h1><p>Wait a minute, then try again.</p>',
    429,
  );
}

export const backToPlans = '<p><a href="/subscribe">Back to plans</a></p>';
