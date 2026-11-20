/**
 * Cloudflare Turnstile verification, shared by the capture worker (sign-up forms) and the site
 * worker (checkout and pledge forms on the plans page).
 *
 * Fails closed: a network error, a failed challenge, another or a missing action, or a token issued
 * on another hostname (when the caller names one) is a no. Only in development (hostname null,
 * where Cloudflare's test keys may answer without an action) is a missing action accepted.
 */

export const TURNSTILE_SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/** Cloudflare's published Turnstile test keys: fine locally, refused anywhere else. */
export const TEST_TURNSTILE_KEY = /^[123]x0{20,}A{1,2}$/;

export interface TurnstileCheck {
  secret: string;
  token: string | null | undefined;
  ip?: string | undefined;
  /** The widget's data-action; a token for another action is refused. */
  action: string;
  /** The hostname the widget must have rendered on; null skips the check (development only). */
  hostname: string | null;
  /**
   * The widget's data-cdata (what it was solved for, such as one form's id): a token solved for
   * something else is refused. Checked with the hostname, so not in development.
   */
  cdata?: string;
  fetcher?: typeof fetch;
}

/** What Cloudflare said about a pass that was accepted. */
export interface TurnstilePass {
  /** The hostname the widget was solved on, as Cloudflare reported it. */
  hostname: string | null;
  /** The widget's data-cdata, as Cloudflare reported it. */
  cdata: string | null;
}

export async function verifyTurnstileToken(check: TurnstileCheck): Promise<boolean> {
  return (await verifyTurnstilePass(check)) !== null;
}

/** verifyTurnstileToken, keeping what Cloudflare reported for an accepted pass; null when refused. */
export async function verifyTurnstilePass(check: TurnstileCheck): Promise<TurnstilePass | null> {
  const { token } = check;
  if (!token || token.length > 4096) return null;
  const form = new FormData();
  form.set('secret', check.secret);
  form.set('response', token);
  form.set('idempotency_key', crypto.randomUUID());
  if (check.ip) form.set('remoteip', check.ip);
  let result: { success: boolean; hostname?: string; action?: string; cdata?: string };
  try {
    const res = await (check.fetcher ?? fetch)(TURNSTILE_SITEVERIFY, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) return null;
    result = await res.json();
  } catch {
    return null;
  }
  if (!result.success) return null;
  if (result.action !== check.action && !(check.hostname === null && !result.action)) return null;
  if (check.hostname !== null && result.hostname !== check.hostname) return null;
  if (check.hostname !== null && check.cdata !== undefined && result.cdata !== check.cdata) {
    return null;
  }
  return {
    hostname: typeof result.hostname === 'string' ? result.hostname : null,
    cdata: typeof result.cdata === 'string' ? result.cdata : null,
  };
}
