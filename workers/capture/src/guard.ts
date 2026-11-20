// Bot defence for the public endpoints: Turnstile, sliding-window rate limits (a Durable Object
// in the realtime worker), and origin checks against a form's allowlist.
import { verifyTurnstilePass, type TurnstilePass } from '@swarm/engine';
import { createLogger } from '@swarm/runtime';
import { linksFor } from '@swarm/engine';
import { base64UrlDecode, base64UrlEncode } from '@swarm/tokens';
import { isLocal, originOf, type CaptureEnv } from './env';

const log = createLogger({ service: 'capture' });

/**
 * Verifies a Turnstile token (see @swarm/engine turnstile). Widgets only ever render on
 * capture-origin pages (the form frame and the challenge page), so that is the hostname; the
 * hostname is not checked in development. `scope` is what the widget was solved for (its
 * data-cdata: a form's id, or 'member-link'), so a pass on one form can't be spent on another.
 */
export async function verifyTurnstile(
  env: CaptureEnv,
  token: string | null | undefined,
  ip: string | undefined,
  scope: string,
): Promise<boolean> {
  return (await turnstilePass(env, token, ip, scope)) !== null;
}

/** verifyTurnstile, with what Cloudflare reported about an accepted pass (null when refused). */
export function turnstilePass(
  env: CaptureEnv,
  token: string | null | undefined,
  ip: string | undefined,
  scope: string,
): Promise<TurnstilePass | null> {
  return verifyTurnstilePass({
    secret: env.TURNSTILE_SECRET_KEY,
    token,
    ip,
    action: 'subscribe',
    hostname: isLocal(env) ? null : new URL(originOf(env)).hostname,
    cdata: scope,
  });
}

const CHALLENGE_SECONDS = 15 * 60;
const NUMBER_WORDS = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

const hmacKey = (raw: Uint8Array | ArrayBuffer, usages: ('sign' | 'verify')[]) =>
  crypto.subtle.importKey(
    'raw',
    raw as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );

/**
 * The key for the answer's MAC. A plain hash would let a script try the few possible sums against
 * the readable payload offline; this one can only be checked by the server. It is derived from
 * the CAPTURE_KEYS secret (MEMBER_KEYS before the cutover) under its own label, so the answer MAC
 * never shares a key with the tokens that secret signs.
 */
async function answerKey(secret: string): Promise<CryptoKey> {
  const root = await hmacKey(new TextEncoder().encode(secret), ['sign']);
  const label = new TextEncoder().encode('swarm capture challenge answer v1');
  return hmacKey(await crypto.subtle.sign('HMAC', root, label), ['sign', 'verify']);
}

const answerInput = (scope: string, salt: string, answer: string) =>
  new TextEncoder().encode(`challenge-answer:${scope}:${salt}:${answer.trim()}`);

/**
 * A challenge for a public form: signed, tied to one form (`scope`), short-lived, answered once,
 * and carrying a small question for browsers without JavaScript, where Turnstile can't run. The
 * answer travels only as an HMAC under a key derived from CAPTURE_KEYS. The question stops simple
 * form spam, not a determined bot, so a sign-up that passes this way always has to confirm by
 * email, and the rate limits still apply.
 */
export async function newChallenge(
  env: CaptureEnv,
  scope: string,
  hostOrigin: string | null,
  pageUrl: string | null,
): Promise<{ token: string; question: string }> {
  const [a = 0, b = 0, salt = 0] = crypto.getRandomValues(new Uint32Array(3));
  const first = a % NUMBER_WORDS.length;
  const second = b % NUMBER_WORDS.length;
  const saltText = salt.toString(36);
  const links = linksFor(env);
  const secret = links.secret('CAPTURE_KEYS');
  if (!secret) throw new Error('CAPTURE_KEYS is not set');
  const key = await answerKey(secret);
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    answerInput(scope, saltText, String(first + 2 + second + 2)),
  );
  const token = await links.sign(
    'challenge',
    {
      f: scope,
      o: hostOrigin,
      u: pageUrl,
      s: saltText,
      q: base64UrlEncode(new Uint8Array(mac)),
    },
    { expiresInSeconds: CHALLENGE_SECONDS },
  );
  return { token, question: `What is ${NUMBER_WORDS[first]} plus ${NUMBER_WORDS[second]}?` };
}

/** A challenge issued for `scope`, or null when it is forged, expired or for something else. */
export async function readChallenge(env: CaptureEnv, scope: string, token: string) {
  const links = linksFor(env);
  const read = await links.verify<{
    f?: unknown;
    o?: unknown;
    u?: unknown;
    s?: unknown;
    q?: unknown;
  }>('challenge', token);
  if (!read.ok || read.payload.f !== scope) return null;
  const { o, u, s, q } = read.payload;
  // The answer key comes from the key that signed this challenge: MEMBER_KEYS for one from before.
  const secret = links.secret('CAPTURE_KEYS', { kid: read.kid, legacy: read.legacy });
  return {
    hostOrigin: typeof o === 'string' ? o : null,
    pageUrl: typeof u === 'string' ? u : null,
    /**
     * Whether `answer` is the answer to this challenge's question. Any answer, right or wrong,
     * uses the challenge up: there are only about 15 sums, so a question that survived a wrong
     * answer could be guessed, and a solved one replayed for more sign-ups. A wrong answer gets
     * a new question.
     */
    solved: async (answer: string | null) => {
      if (answer === null || typeof s !== 'string' || typeof q !== 'string' || !secret) {
        return false;
      }
      if ((await rateLimit(env, [[await hashKey(token), 'challengeUse']])) !== 0) return false;
      let mac: Uint8Array<ArrayBuffer>;
      try {
        mac = base64UrlDecode(q);
      } catch {
        return false;
      }
      const key = await answerKey(secret);
      // crypto.subtle.verify compares in constant time.
      return crypto.subtle.verify('HMAC', key, mac, answerInput(scope, s, answer));
    },
  };
}

interface RateLimiterStub {
  hit(
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }>;
}

/** Limits per key, as [hits, window ms]. */
const LIMITS = {
  /** Form submissions from one IP, across forms. */
  subscribeIp: [10, 10 * 60_000],
  /** Form submissions to one form, from everywhere: a flood guard. */
  subscribeForm: [600, 10 * 60_000],
  /** Member Center link requests from one IP, and for one address. */
  linkIp: [5, 60 * 60_000],
  linkEmail: [3, 60 * 60_000],
  /** Requests from the public data request page, from one IP and for one address. */
  rightsIp: [5, 60 * 60_000],
  rightsEmail: [3, 24 * 60 * 60_000],
  /** Confirm, leave and Member Center actions from one IP. */
  actionIp: [30, 10 * 60_000],
  /**
   * Notices of a change made through a Member Center link, per Member: enough for real use, few
   * enough that someone repeating changes with a forwarded link can't flood the inbox.
   */
  changeNotice: [6, 60 * 60_000],
  /** A no-JS challenge takes one answer, for as long as it is valid. */
  challengeUse: [1, CHALLENGE_SECONDS * 1000],
} as const satisfies Record<string, readonly [number, number]>;

/**
 * Counts a hit against each key and returns the longest retry wait, or 0 when every key allowed
 * it. A limiter that can't be reached refuses (fails closed), except in development.
 */
export async function rateLimit(
  env: CaptureEnv,
  checks: [key: string, limit: keyof typeof LIMITS][],
): Promise<number> {
  let wait = 0;
  for (const [key, name] of checks) {
    const [limit, windowMs] = LIMITS[name];
    try {
      const stub = env.RATE_LIMITER.get(
        env.RATE_LIMITER.idFromName(`${name}:${key}`),
      ) as unknown as RateLimiterStub;
      const result = await stub.hit(limit, windowMs);
      if (!result.allowed) wait = Math.max(wait, result.retryAfterSeconds);
    } catch (error) {
      log.error('rate limiter unavailable', { error: (error as Error).message });
      if (env.ENVIRONMENT !== 'development') return 60;
    }
  }
  return wait;
}

/** A stable, non-reversible key for an address, so limiter names never hold emails. */
export async function hashKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** The origin of a URL-ish header value, or null. */
export function originFrom(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** True when `origin` may embed or post to a form with this allowlist (empty = any site). */
export function originAllowed(allowlist: readonly string[], origin: string | null): boolean {
  if (allowlist.length === 0) return true;
  return origin !== null && allowlist.includes(origin);
}
