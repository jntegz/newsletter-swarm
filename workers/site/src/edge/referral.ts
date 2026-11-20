// Champions referrals on the site (Phase 6).
//
// A visitor arrives with a Champion's code, either through the short link /r/<code> (routes/
// growth.ts) or the share link /?ref=<code>. The code is kept in a first-party cookie for 30 days
// (`__Host-swarm_ref`, unprefixed `swarm_ref` over plain http locally; HttpOnly, SameSite=Lax),
// and every inline subscribe form on a page gets it as a hidden `ref` input, which the capture
// worker passes to the sign-up. The input is added after the edge cache (HTMLRewriter on the way
// out), so cached pages never contain anyone's code and stay shared across visitors. Only the
// format is checked here; the capture worker resolves the code to a Champion of this Channel.
import { CHAMPION_CODE } from '@swarm/domain';
import { getCookie, setCookie } from 'hono/cookie';
import type { SiteContext } from '../context';
import { consentAllows, consentCookieName } from '../render/consent';
import { siteCode, siteFlags } from '../render/data';

const REF_COOKIE_SECURE = '__Host-swarm_ref';
const REF_COOKIE_LOCAL = 'swarm_ref';
const REF_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
/** Forms rendered by the site that sign people up carry this attribute. */
const SUBSCRIBE_FORM_ATTRIBUTE = 'data-swarm-subscribe';

const cookieName = (c: SiteContext) =>
  c.get('env').SITE_SCHEME === 'https' ? REF_COOKIE_SECURE : REF_COOKIE_LOCAL;

/** A well-formed code, lowercased, or null. */
export function cleanCode(value: string | null | undefined): string | null {
  const code = value?.trim().toLowerCase() ?? '';
  return CHAMPION_CODE.test(code) ? code : null;
}

export function setReferralCookie(c: SiteContext, code: string): void {
  setCookie(c, cookieName(c), code, {
    path: '/',
    secure: c.get('env').SITE_SCHEME === 'https',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: REF_COOKIE_MAX_AGE,
  });
}

/**
 * Adds the visitor's code to the subscribe forms of the response in `c.res`, and remembers a code
 * from ?ref= in the cookie. Does nothing without a code; only HTML is rewritten.
 */
/** With a cookie popup on, the referral cookie is set only for a reader who allowed marketing. */
export async function mayRememberReferral(c: SiteContext): Promise<boolean> {
  const code = await siteCode(c.get('env'), c.get('channel').id);
  if (!code?.consent?.enabled) return true;
  if (!(await siteFlags(c)).site_custom_code) return true;
  return consentAllows(getCookie(c, consentCookieName(c.get('env'))), 'marketing', code);
}

export async function carryReferral(c: SiteContext): Promise<void> {
  if (c.req.method !== 'GET') return;
  const fromQuery = cleanCode(c.req.query('ref'));
  const fromCookie = cleanCode(getCookie(c, cookieName(c)));
  const code = fromQuery ?? fromCookie;
  if (!code) return;
  const res = c.res;
  if ((res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html') && res.body) {
    c.res = new HTMLRewriter()
      .on(`form[${SUBSCRIBE_FORM_ATTRIBUTE}]`, {
        element(form) {
          form.append(`<input type="hidden" name="ref" value="${code}">`, { html: true });
        },
      })
      .transform(res);
    // The body grew; a stored length would cut it off.
    c.header('content-length', undefined);
  }
  // The form on this page still carries the code. The cookie that remembers it waits for consent.
  if (fromQuery && fromQuery !== fromCookie && (await mayRememberReferral(c))) {
    setReferralCookie(c, fromQuery);
  }
}
