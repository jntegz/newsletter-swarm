/**
 * Stripe for Membership levels (Phase 5). Every Channel connects its own Stripe account (Connect
 * Standard) and every money call runs on that account (`Stripe-Account` header). The platform
 * never sets an application fee: the take is 0%.
 *
 * - `verifyStripeSignature`: the webhook check. Every `v1` signature in the header is compared
 *   against every configured secret, in constant time, with a 300-second timestamp tolerance.
 * - `StripeApi`: the few REST calls we make, form-encoded over fetch. `HttpStripe` talks to Stripe;
 *   `DevStripe` is the development and test fake (no network, deterministic ids, checkout URLs
 *   that point back at the site's dev checkout page).
 * - Checkout references: a signed token (purpose 'checkout-ref', CHECKOUT_SIGNING_KEYS: the site
 *   signs, the api verifies with the public keys) holding only the random reference of a
 *   `checkout_sessions` row we wrote first. The webhook trusts that row, never what else the
 *   session says, which the owner of a connected account could set to anything. An Ed25519 token
 *   is longer than Stripe's 200 characters for `client_reference_id`, so it travels in the
 *   session's metadata (`swarm_ref`, up to 500); a v1 token from before the cutover fits there too.
 */
import { base64UrlEncode } from '@swarm/tokens';
import { z } from 'zod';
import type { LinkSigner, LinkVerifier } from './links';

/** Pinned. Since 2025-03-31.basil, current_period_end lives on subscription items, not the subscription. */
export const STRIPE_API_VERSION = '2025-09-30.clover';
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;
const API = 'https://api.stripe.com';
const CONNECT = 'https://connect.stripe.com';

// ---------------------------------------------------------------------------------------------
// Env

export const PaymentsEnvFields = {
  /** Who handles payments: Stripe, the dev fake, or nobody (Membership levels off). */
  PAYMENTS: z.enum(['stripe', 'dev', 'off']),
  /** The platform's secret key (sk_live_… / sk_test_…), used with Stripe-Account for Connect. */
  STRIPE_SECRET_KEY: z.string().min(10).optional(),
  /** Connect OAuth client id (ca_…). */
  STRIPE_CONNECT_CLIENT_ID: z.string().min(3).optional(),
  /**
   * Signing secrets of the Connect webhook endpoint, comma-separated (whsec_…). More than one
   * during a rotation: a signature matching any of them is accepted.
   */
  STRIPE_WEBHOOK_SECRETS: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .optional(),
};

export interface PaymentsEnv {
  ENVIRONMENT: string;
  PAYMENTS: 'stripe' | 'dev' | 'off';
  STRIPE_SECRET_KEY?: string | undefined;
  STRIPE_CONNECT_CLIENT_ID?: string | undefined;
  STRIPE_WEBHOOK_SECRETS?: string[] | undefined;
}

/**
 * Use inside a worker env schema's superRefine. `needs` lists what this worker uses: the api
 * worker verifies webhooks and runs Connect; the site worker only creates Checkout Sessions.
 */
export function checkPaymentsEnv(
  env: PaymentsEnv,
  ctx: z.RefinementCtx,
  needs: { webhook?: boolean; connect?: boolean; viaVault?: boolean } = {},
): void {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  const local = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
  if (env.PAYMENTS === 'dev' && !local) {
    issue('PAYMENTS', 'the dev payments fake is only allowed in development and test');
  }
  if (env.PAYMENTS !== 'stripe') return;
  // A worker whose Stripe calls go through the vault (capture, site) holds no key.
  if (!needs.viaVault && !env.STRIPE_SECRET_KEY?.startsWith('sk_')) {
    issue('STRIPE_SECRET_KEY', 'required when PAYMENTS is "stripe" (sk_…)');
  }
  if (needs.connect && !env.STRIPE_CONNECT_CLIENT_ID?.startsWith('ca_')) {
    issue('STRIPE_CONNECT_CLIENT_ID', 'required when PAYMENTS is "stripe" (ca_…)');
  }
  if (needs.webhook) {
    const secrets = env.STRIPE_WEBHOOK_SECRETS;
    if (
      !secrets ||
      secrets.length === 0 ||
      secrets.some((s) => !s.startsWith('whsec_') || s.length < 16)
    ) {
      issue('STRIPE_WEBHOOK_SECRETS', 'one or more whsec_ secrets are required');
    }
  }
}

/** Null when payments are off for this deployment. */
export function stripeApi(
  env: PaymentsEnv,
  // Wrapped: workerd refuses a bare fetch called as a method of another object.
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): StripeApi | null {
  if (env.PAYMENTS === 'off') return null;
  if (env.PAYMENTS === 'dev') return new DevStripe();
  return new HttpStripe(env.STRIPE_SECRET_KEY as string, fetcher);
}

// ---------------------------------------------------------------------------------------------
// Webhook signatures

export type SignatureResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: 'missing' | 'malformed' | 'too_old' | 'mismatch' | 'no_secret' };

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Checks a `Stripe-Signature` header (`t=<unix>,v1=<hex>[,v1=<hex>…][,v0=…]`) over the raw body.
 * Accepts when any v1 signature matches any secret and the timestamp is within the tolerance in
 * either direction. An empty secret list never verifies.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null | undefined,
  secrets: readonly string[] | undefined,
  now: number = Date.now(),
  toleranceSeconds: number = STRIPE_SIGNATURE_TOLERANCE_SECONDS,
): Promise<SignatureResult> {
  const usable = (secrets ?? []).filter((secret) => secret.length > 0);
  if (usable.length === 0) return { ok: false, reason: 'no_secret' };
  if (!header) return { ok: false, reason: 'missing' };
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return { ok: false, reason: 'malformed' };
  if (Math.abs(Math.floor(now / 1000) - timestamp) > toleranceSeconds) {
    return { ok: false, reason: 'too_old' };
  }
  for (const secret of usable) {
    const expected = await hmacHex(secret, `${timestamp}.${payload}`);
    if (signatures.some((signature) => timingSafeEqual(signature, expected))) {
      return { ok: true, timestamp };
    }
  }
  return { ok: false, reason: 'mismatch' };
}

/** Builds a valid header, for tests and the dev fake. */
export async function signStripePayload(
  payload: string,
  secret: string,
  now: number = Date.now(),
): Promise<string> {
  const timestamp = Math.floor(now / 1000);
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${payload}`)}`;
}

/** The parts of a Stripe event we read. `account` is set for Connect events. */
export interface StripeEvent {
  id: string;
  type: string;
  account?: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown>; previous_attributes?: Record<string, unknown> };
}

// ---------------------------------------------------------------------------------------------
// Checkout references

const CHECKOUT_PURPOSE = 'checkout-ref';
/** Covers Stripe's webhook retries (up to 3 days) with room to spare. */
const CHECKOUT_REF_TTL_SECONDS = 30 * 24 * 60 * 60;

export function newCheckoutReference(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(18)));
}

/** The Checkout Session metadata key that carries the signed reference. */
export const CHECKOUT_REF_METADATA = 'swarm_ref';
/** Stripe's limit for client_reference_id. */
const CLIENT_REFERENCE_MAX = 200;

/**
 * The signed reference for a checkout_sessions row. `signedIn` says the row's Member made this
 * checkout signed in: only then may the webhook link the session's Stripe customer to a Member who
 * already existed (a typed email proves nothing).
 */
export async function signCheckoutReference(
  links: LinkSigner,
  reference: string,
  now: number = Date.now(),
  options: { signedIn?: boolean } = {},
): Promise<string> {
  return links.sign(
    CHECKOUT_PURPOSE,
    options.signedIn ? { r: reference, s: 1 } : { r: reference },
    { expiresInSeconds: CHECKOUT_REF_TTL_SECONDS, now },
  );
}

/**
 * Where a signed reference goes on a Checkout Session: always in metadata. A v1 one (signed before
 * the cutover, which fits) also goes in client_reference_id, where an api from before the cutover
 * reads it; otherwise that holds the bare reference, for people reading the Stripe dashboard.
 */
export function checkoutReferenceParams(reference: string, signed: string) {
  const v1 = signed.startsWith('v1.') && signed.length <= CLIENT_REFERENCE_MAX;
  return {
    client_reference_id: v1 ? signed : reference,
    metadata: { [CHECKOUT_REF_METADATA]: signed },
  };
}

/** The signed reference a Checkout Session carries: in metadata, else client_reference_id. */
export function signedCheckoutReference(session: Record<string, unknown>): unknown {
  const metadata = session.metadata;
  const signed =
    metadata && typeof metadata === 'object'
      ? (metadata as Record<string, unknown>)[CHECKOUT_REF_METADATA]
      : undefined;
  return typeof signed === 'string' ? signed : session.client_reference_id;
}

/** What a signed reference says, or null when it doesn't verify. */
export async function readCheckoutClaims(
  links: LinkVerifier,
  value: unknown,
  now: number = Date.now(),
): Promise<{ reference: string; signedIn: boolean } | null> {
  if (typeof value !== 'string' || value.length > 500) return null;
  const verified = await links.verify<{ r?: unknown; s?: unknown }>(CHECKOUT_PURPOSE, value, {
    now,
  });
  if (!verified.ok || typeof verified.payload.r !== 'string') return null;
  return { reference: verified.payload.r, signedIn: verified.payload.s === 1 };
}

// ---------------------------------------------------------------------------------------------
// REST client

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'StripeError';
  }
}

export type StripeParams = Record<string, unknown>;

export interface StripeRequestOptions {
  /** The connected account (acct_…) the call runs on. */
  account?: string;
  /** Makes a retried POST safe: Stripe returns the first result for the same key. */
  idempotencyKey?: string;
}

export interface StripeApi {
  request<T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params?: StripeParams,
    options?: StripeRequestOptions,
  ): Promise<T>;
  /** Connect OAuth: the URL to send an operator to. */
  connectUrl(clientId: string, state: string, redirectUri: string): string;
  /** Connect OAuth: exchanges the code for the connected account id. */
  connectExchange(code: string): Promise<{ accountId: string; livemode: boolean }>;
  /** Disconnects a Standard account from the platform. */
  connectRevoke(clientId: string, accountId: string): Promise<void>;
}

/** Stripe's bracket form encoding: { a: { b: [1, 2] } } → a[b][0]=1&a[b][1]=2. */
export function encodeStripeForm(params: StripeParams): string {
  const out: string[] = [];
  const walk = (prefix: string, value: unknown) => {
    if (value === undefined) return;
    if (value === null) {
      out.push(`${encodeURIComponent(prefix)}=`);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => walk(`${prefix}[${index}]`, item));
    } else if (typeof value === 'object') {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        walk(prefix ? `${prefix}[${key}]` : key, inner);
      }
    } else {
      out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
    }
  };
  walk('', params);
  return out.join('&');
}

export class HttpStripe implements StripeApi {
  constructor(
    private readonly secretKey: string,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: StripeParams = {},
    options: StripeRequestOptions = {},
  ): Promise<T> {
    const form = encodeStripeForm(params);
    const url = method === 'POST' || !form ? `${API}${path}` : `${API}${path}?${form}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.secretKey}`,
      'stripe-version': STRIPE_API_VERSION,
    };
    if (options.account) headers['stripe-account'] = options.account;
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    if (method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await this.fetcher(url, {
      method,
      headers,
      ...(method === 'POST' ? { body: form } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; type?: string; code?: string };
    };
    if (!res.ok) {
      throw new StripeError(
        body.error?.message ?? `Stripe answered ${res.status}`,
        res.status,
        body.error?.type ?? null,
        body.error?.code ?? null,
      );
    }
    return body as T;
  }

  connectUrl(clientId: string, state: string, redirectUri: string): string {
    const url = new URL('/oauth/authorize', CONNECT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('scope', 'read_write');
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', redirectUri);
    return url.toString();
  }

  async connectExchange(code: string): Promise<{ accountId: string; livemode: boolean }> {
    const res = await this.fetcher(`${CONNECT}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: encodeStripeForm({
        grant_type: 'authorization_code',
        code,
        client_secret: this.secretKey,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      stripe_user_id?: string;
      livemode?: boolean;
      error_description?: string;
    };
    if (!res.ok || !body.stripe_user_id?.startsWith('acct_')) {
      throw new StripeError(body.error_description ?? 'Connect failed', res.status, null, null);
    }
    return { accountId: body.stripe_user_id, livemode: body.livemode === true };
  }

  async connectRevoke(clientId: string, accountId: string): Promise<void> {
    const res = await this.fetcher(`${CONNECT}/oauth/deauthorize`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: encodeStripeForm({ client_id: clientId, stripe_user_id: accountId }),
    });
    // Already disconnected is fine.
    if (!res.ok && res.status !== 401) {
      throw new StripeError(`Stripe answered ${res.status}`, res.status, null, null);
    }
  }
}

/**
 * Development and test fake. No network: it records each call and answers with plausible objects
 * whose ids are derived from a counter. Checkout Sessions get the URL
 * `<success_url origin>/_swarm/checkout/dev/<cs_id>`, where the site worker shows a page that
 * completes the purchase by feeding a signed event to the webhook processor. Tests can push
 * canned answers with `respond`.
 */
export class DevStripe implements StripeApi {
  readonly calls: {
    method: string;
    path: string;
    params: StripeParams;
    options: StripeRequestOptions;
  }[] = [];
  private readonly canned: { match: RegExp; body: Record<string, unknown> }[] = [];
  private counter = 0;

  respond(match: RegExp, body: Record<string, unknown>): void {
    this.canned.push({ match, body });
  }

  private id(prefix: string): string {
    this.counter += 1;
    const random = base64UrlEncode(crypto.getRandomValues(new Uint8Array(9))).replace(/[-_]/g, 'x');
    return `${prefix}_dev${this.counter}${random}`;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: StripeParams = {},
    options: StripeRequestOptions = {},
  ): Promise<T> {
    this.calls.push({ method, path, params, options });
    const canned = this.canned.find((entry) => entry.match.test(`${method} ${path}`));
    if (canned) return canned.body as T;
    const kind = path.split('/')[2] ?? '';
    const prefixes: Record<string, string> = {
      products: 'prod',
      prices: 'price',
      customers: 'cus',
      coupons: 'coupon',
      promotion_codes: 'promo',
      subscriptions: 'sub',
      refunds: 're',
      accounts: 'acct',
    };
    if (kind === 'accounts' && method === 'GET') {
      // A connected dev account is ready to sell, so the local Connect flow ends somewhere usable.
      return {
        id: path.split('/')[3] ?? this.id('acct'),
        object: 'account',
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        default_currency: 'usd',
      } as T;
    }
    if (kind === 'account') {
      return {
        id: this.id('acct'),
        object: 'account',
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        default_currency: 'usd',
      } as T;
    }
    if (kind === 'webhook_endpoints' && method === 'POST') {
      return { id: this.id('we'), object: 'webhook_endpoint', secret: this.id('whsec') } as T;
    }
    if (kind === 'checkout') {
      const id = this.id('cs');
      const success = typeof params.success_url === 'string' ? params.success_url : '';
      const origin = success ? new URL(success).origin : 'http://localhost';
      return { id, object: 'checkout.session', url: `${origin}/_swarm/checkout/dev/${id}` } as T;
    }
    if (kind === 'billing_portal') {
      const back = typeof params.return_url === 'string' ? params.return_url : 'http://localhost/';
      return { id: this.id('bps'), url: back } as T;
    }
    const existing = path.split('/')[3];
    const id =
      existing && method !== 'POST' ? existing : (existing ?? this.id(prefixes[kind] ?? 'obj'));
    return { id, object: kind.replace(/s$/, ''), deleted: method === 'DELETE', ...params } as T;
  }

  connectUrl(_clientId: string, state: string, redirectUri: string): string {
    const url = new URL(redirectUri);
    url.searchParams.set('code', `dev_${state.slice(0, 12)}`);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async connectExchange(code: string): Promise<{ accountId: string; livemode: boolean }> {
    if (!code.startsWith('dev_')) throw new StripeError('Unknown code', 400, null, null);
    // Tests name the account to connect with a dev_acct_… code.
    const named = /^dev_(acct_[A-Za-z0-9]{1,64})$/.exec(code)?.[1];
    return { accountId: named ?? this.id('acct'), livemode: false };
  }

  async connectRevoke(): Promise<void> {}
}
