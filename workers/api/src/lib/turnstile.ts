import type { ApiEnv } from '../env';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

interface SiteverifyResult {
  success: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
}

/**
 * Verifies a Turnstile token server-side. Fails closed: any network error, a failed
 * challenge, a different or missing action, or (outside development) a different hostname
 * is a no.
 */
export async function verifyTurnstile(
  env: ApiEnv,
  token: string,
  ip: string | undefined,
  action: string,
): Promise<boolean> {
  const form = new FormData();
  form.set('secret', env.TURNSTILE_SECRET_KEY);
  form.set('response', token);
  form.set('idempotency_key', crypto.randomUUID());
  if (ip) form.set('remoteip', ip);

  let result: SiteverifyResult;
  try {
    const res = await fetch(SITEVERIFY, { method: 'POST', body: form });
    if (!res.ok) return false;
    result = await res.json<SiteverifyResult>();
  } catch {
    return false;
  }
  if (!result.success) return false;

  // Cloudflare's always-pass test keys report a placeholder hostname and may leave the action
  // empty, so those two are relaxed only where test keys are allowed. Elsewhere a token without
  // an action is refused like a token for another one.
  const local = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
  if (result.action !== action && !(local && !result.action)) return false;
  if (!local && result.hostname !== new URL(env.APP_ORIGIN).hostname) return false;
  return true;
}
