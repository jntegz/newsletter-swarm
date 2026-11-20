/**
 * The provider proxy: a caller hands the vault a request without credentials, and the vault
 * attaches the stored one and sends it, if the request is on the allowlist for that entrypoint,
 * credential and principal (RULES). Hosts come from the credential (Stripe's API, PayPal's for
 * the account's mode, the Shorthop connection's own base URL, Anthropic's), never from the caller
 * alone. A caller may not send its own credential headers, redirects are never followed, and the
 * provider's answer comes back as data.
 */
import { first } from '@swarm/db';
import { outboundUrlProblem } from '@swarm/engine';
import type {
  CredentialPrincipal,
  CredentialRef,
  Principal,
  PrincipalKind,
  VaultCaller,
  VaultRequest,
  VaultResponse,
  VaultStreamResponse,
} from '../api';
import { invalid, refuse, VaultRefusal, type VaultContext } from './context';
import {
  reachChannel,
  reachWorkspace,
  resolveCredential,
  resolveStored,
  verifyMemberLink,
  verifyReaderSession,
} from './principals';
import { take } from './ratelimit';
import { copilotKey, paypalAccount, shorthopConnection, stripeRoute } from './secrets';

/** What the principal turned out to be, for the rules' own checks. */
interface Acting {
  kind: PrincipalKind;
  memberId?: string;
  channelId?: string;
  task?: string;
}

interface Rule {
  callers: readonly VaultCaller[];
  credential: CredentialRef['kind'];
  principals: readonly PrincipalKind[];
  method: VaultRequest['method'];
  /** Matched against the path (without the query). */
  path: RegExp;
  /** Extra checks: the subscription or customer named is the Member's own, and so on. */
  check?: (ctx: VaultContext, acting: Acting, url: URL, body: string | undefined) => Promise<void>;
  /** The answer may stream back (providerStream); every other rule is providerFetch only. */
  stream?: true;
}

const CREDENTIALS: readonly PrincipalKind[] = ['operator-session', 'api-key', 'oauth'];
const STRIPE_ID = '[A-Za-z0-9_]{3,255}';
const PAYPAL_ID = '[A-Za-z0-9_-]{3,64}';

/** The Member owns the Stripe subscription in the path. */
const ownStripeSubscription: Rule['check'] = async (ctx, acting, url) => {
  const id = url.pathname.split('/')[3];
  const row = await first(
    ctx.db,
    'SELECT 1 FROM member_subscriptions WHERE member_id = ?1 AND channel_id = ?2 AND stripe_subscription_id = ?3',
    acting.memberId,
    acting.channelId,
    id,
  );
  if (!row) refuse('not the member subscription');
};

/** The `customer` parameter (query or form body) is the Member's own Stripe customer. */
const ownStripeCustomer: Rule['check'] = async (ctx, acting, url, body) => {
  const customer =
    url.searchParams.get('customer') ?? new URLSearchParams(body ?? '').get('customer');
  if (!customer) return refuse('no customer');
  const row = await first(
    ctx.db,
    `SELECT 1 FROM stripe_customers WHERE member_id = ?1 AND channel_id = ?2 AND stripe_customer_id = ?3
     UNION SELECT 1 FROM member_subscriptions WHERE member_id = ?1 AND channel_id = ?2 AND stripe_customer_id = ?3`,
    acting.memberId,
    acting.channelId,
    customer,
  );
  if (!row) refuse('not the member customer');
};

/** The Member owns the PayPal subscription in the path. */
const ownPayPalSubscription: Rule['check'] = async (ctx, acting, url) => {
  const id = url.pathname.split('/')[4];
  const row = await first(
    ctx.db,
    'SELECT 1 FROM member_subscriptions WHERE member_id = ?1 AND channel_id = ?2 AND paypal_subscription_id = ?3',
    acting.memberId,
    acting.channelId,
    id,
  );
  if (!row) refuse('not the member subscription');
};

const rule = (r: Rule) => r;

/**
 * Every allowed proxy call. What each caller does with each credential today (docs/security.md
 * "The vault"); anything else is refused.
 */
const RULES: readonly Rule[] = [
  // api: dashboard and /v2 payments work, and the webhook processing that follows an event.
  ...(['GET', 'POST', 'DELETE'] as const).map((method) =>
    rule({
      callers: ['api'],
      credential: 'stripe',
      principals: [...CREDENTIALS, 'payment-event'],
      method,
      path: /^\/v1\/[a-z_]+(\/[A-Za-z0-9_]+){0,3}$/,
    }),
  ),
  rule({
    callers: ['api'],
    credential: 'paypal',
    principals: CREDENTIALS,
    method: 'POST',
    path: /^\/v1\/notifications\/webhooks$/,
  }),
  rule({
    callers: ['api'],
    credential: 'paypal',
    principals: CREDENTIALS,
    method: 'DELETE',
    path: new RegExp(`^/v1/notifications/webhooks/${PAYPAL_ID}$`),
  }),
  // The PayPal webhook route asks PayPal whether a delivery is genuine before any event exists.
  rule({
    callers: ['api'],
    credential: 'paypal',
    principals: ['public-channel'],
    method: 'POST',
    path: /^\/v1\/notifications\/verify-webhook-signature$/,
  }),
  rule({
    callers: ['api', 'jobs'],
    credential: 'paypal',
    principals: ['payment-event', 'cron'],
    method: 'GET',
    path: new RegExp(`^/v1/billing/subscriptions/${PAYPAL_ID}$`),
  }),
  rule({
    callers: ['api', 'jobs'],
    credential: 'paypal',
    principals: ['payment-event', 'cron'],
    method: 'POST',
    path: new RegExp(`^/v1/billing/subscriptions/${PAYPAL_ID}/cancel$`),
  }),
  rule({
    callers: ['api'],
    credential: 'shorthop',
    principals: CREDENTIALS,
    method: 'POST',
    path: /^\/api\/mcp$/,
  }),
  rule({
    callers: ['api'],
    credential: 'copilot',
    principals: ['operator-session'],
    method: 'POST',
    path: /^(\/v1\/[^/]+\/[^/]+\/anthropic)?\/v1\/messages$/,
    stream: true,
  }),
  rule({
    callers: ['api'],
    credential: 'copilot',
    principals: ['operator-session'],
    method: 'GET',
    path: /^(\/v1\/[^/]+\/[^/]+\/anthropic)?\/v1\/models$/,
    stream: true,
  }),
  // capture: the Member Center's billing, for the link's own Member only.
  rule({
    callers: ['capture'],
    credential: 'stripe',
    principals: ['member-link'],
    method: 'GET',
    path: new RegExp(`^/v1/subscriptions/${STRIPE_ID}$`),
    check: ownStripeSubscription,
  }),
  rule({
    callers: ['capture'],
    credential: 'stripe',
    principals: ['member-link'],
    method: 'POST',
    path: new RegExp(`^/v1/subscriptions/${STRIPE_ID}$`),
    check: ownStripeSubscription,
  }),
  rule({
    callers: ['capture'],
    credential: 'stripe',
    principals: ['member-link'],
    method: 'POST',
    path: /^\/v1\/invoices\/create_preview$/,
    check: ownStripeCustomer,
  }),
  rule({
    callers: ['capture'],
    credential: 'stripe',
    principals: ['member-link'],
    method: 'GET',
    path: /^\/v1\/invoices$/,
    check: ownStripeCustomer,
  }),
  rule({
    callers: ['capture', 'site'],
    credential: 'stripe',
    principals: ['member-link', 'reader-session'],
    method: 'POST',
    path: /^\/v1\/billing_portal\/sessions$/,
    check: ownStripeCustomer,
  }),
  rule({
    callers: ['capture'],
    credential: 'paypal',
    principals: ['member-link'],
    method: 'POST',
    path: new RegExp(`^/v1/billing/subscriptions/${PAYPAL_ID}/cancel$`),
    check: ownPayPalSubscription,
  }),
  // capture: the signup address check (single opt-in forms).
  rule({
    callers: ['capture'],
    credential: 'debounce',
    principals: ['public-channel'],
    method: 'GET',
    path: /^\/v1\/$/,
  }),
  // site: Checkout for anyone on the Channel's site; PayPal plans and subscriptions likewise.
  rule({
    callers: ['site'],
    credential: 'stripe',
    principals: ['public-channel'],
    method: 'POST',
    path: /^\/v1\/checkout\/sessions$/,
  }),
  ...(
    [
      /^\/v1\/catalogs\/products$/,
      /^\/v1\/billing\/plans$/,
      /^\/v1\/billing\/subscriptions$/,
    ] as const
  ).map((path) =>
    rule({
      callers: ['site'],
      credential: 'paypal',
      principals: ['public-channel'],
      method: 'POST',
      path,
    }),
  ),
  // jobs: the payments lifecycle (plan migrations) and PayPal reconciliation.
  rule({
    callers: ['jobs'],
    credential: 'stripe',
    principals: ['cron'],
    method: 'GET',
    path: new RegExp(`^/v1/subscriptions/${STRIPE_ID}$`),
  }),
  rule({
    callers: ['jobs'],
    credential: 'stripe',
    principals: ['cron'],
    method: 'POST',
    path: new RegExp(`^/v1/subscriptions/${STRIPE_ID}$`),
  }),
];

/** Headers a caller may set; any other is dropped. Credential headers are refused outright. */
const PASS_HEADERS = new Set([
  'accept',
  'content-type',
  'idempotency-key',
  'stripe-version',
  'paypal-request-id',
  'prefer',
  'anthropic-version',
  'anthropic-beta',
  'cf-aig-collect-log',
  'cf-aig-skip-cache',
]);
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'stripe-account',
  'cookie',
  'proxy-authorization',
]);
const RETURN_HEADERS = new Set(['content-type', 'request-id', 'paypal-debug-id', 'retry-after']);

const MAX_BODY = 1_000_000;
const MAX_RESPONSE = 8_000_000;
const TIMEOUT_MS = 30_000;
/** A streamed answer may take as long as the Copilot provider allows a reply (its SDK timeout). */
const STREAM_TIMEOUT_MS = 120_000;

const PAYPAL_HOSTS = { live: 'api-m.paypal.com', sandbox: 'api-m.sandbox.paypal.com' } as const;
const ANTHROPIC_HOSTS = new Set(['api.anthropic.com', 'gateway.ai.cloudflare.com']);

const paypalTokens = new Map<string, { token: string; until: number }>();

/** Drops the PayPal access tokens this isolate holds (tests; credentials changed). */
export function forgetProviderTokens(): void {
  paypalTokens.clear();
}

async function paypalToken(
  ctx: VaultContext,
  account: { mode: 'live' | 'sandbox'; clientId: string; secret: string },
): Promise<string> {
  const cacheKey = `${account.mode}\n${account.clientId}\n${account.secret}`;
  const cached = paypalTokens.get(cacheKey);
  if (cached && cached.until > ctx.now()) return cached.token;
  const response = await ctx.fetch(`https://${PAYPAL_HOSTS[account.mode]}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${account.clientId}:${account.secret}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
  } | null;
  // PayPal busy or down: the vault is unavailable for this call (the caller retries), not refused.
  if (response.status === 429 || response.status >= 500) {
    throw new Error(`PayPal token answered ${response.status}`);
  }
  if (!response.ok || typeof json?.access_token !== 'string') refuse('paypal token');
  const seconds = typeof json?.expires_in === 'number' ? json.expires_in : 300;
  paypalTokens.set(cacheKey, {
    token: json?.access_token as string,
    until: ctx.now() + Math.max(0, seconds - 60) * 1000,
  });
  return json?.access_token as string;
}

/** Who the principal is, checked for the credential's own tenant. */
async function actingFor(
  ctx: VaultContext,
  principal: Principal,
  credential: CredentialRef,
): Promise<Acting> {
  const channelOf = () =>
    'channelId' in credential ? (credential as { channelId: string }).channelId : null;
  switch (principal.kind) {
    case 'operator-session':
    case 'api-key':
    case 'oauth': {
      const resolved = await resolveCredential(ctx, principal as CredentialPrincipal);
      if (credential.kind === 'copilot') {
        await reachWorkspace(ctx, resolved, credential.workspaceId, {
          role: 'viewer',
          scope: null,
        });
      } else if (credential.kind === 'shorthop') {
        const row = await first<{ workspace_id: string }>(
          ctx.db,
          'SELECT workspace_id FROM app_connections WHERE id = ?1',
          credential.connectionId,
        );
        if (!row) refuse('connection');
        await reachWorkspace(ctx, resolved, (row as { workspace_id: string }).workspace_id, {
          role: 'author',
          scope: null,
        });
      } else {
        await reachChannel(ctx, resolved, channelOf() as string, { role: 'editor', scope: null });
      }
      return { kind: principal.kind };
    }
    case 'payment-event': {
      const reach = await resolveStored(ctx, principal);
      if (reach.channelId !== channelOf()) refuse('event of another channel');
      return { kind: principal.kind, channelId: reach.channelId as string };
    }
    case 'member-link': {
      const link = await verifyMemberLink(ctx, principal.token);
      if (link.channelId !== channelOf()) refuse('member of another channel');
      if (!(await take(ctx, 'proxy:member', link.memberId))) {
        throw new VaultRefusal('rate_limited');
      }
      return { kind: principal.kind, memberId: link.memberId, channelId: link.channelId };
    }
    case 'reader-session': {
      if (principal.channelId !== channelOf()) refuse('reader of another channel');
      const reader = await verifyReaderSession(ctx, principal.token, principal.channelId);
      if (!(await take(ctx, 'proxy:member', reader.memberId))) {
        throw new VaultRefusal('rate_limited');
      }
      return { kind: principal.kind, memberId: reader.memberId, channelId: reader.channelId };
    }
    case 'public-channel': {
      if (principal.channelId !== channelOf()) refuse('another channel');
      const channel = await first(
        ctx.db,
        'SELECT 1 FROM channels WHERE id = ?1 AND deleted_at IS NULL',
        principal.channelId,
      );
      if (!channel) refuse('channel');
      if (!(await take(ctx, 'proxy:public', `${ctx.caller}:${principal.channelId}`))) {
        throw new VaultRefusal('rate_limited');
      }
      return { kind: principal.kind, channelId: principal.channelId };
    }
    case 'cron':
      if (ctx.caller !== 'jobs') refuse('cron');
      return { kind: 'cron', task: principal.task };
    default:
      return refuse('principal');
  }
}

/** The credential's origin and the headers (or query) that carry it. */
async function attach(
  ctx: VaultContext,
  credential: CredentialRef,
  url: URL,
): Promise<{ origin: string[]; headers: Record<string, string>; path?: string }> {
  switch (credential.kind) {
    case 'stripe': {
      const route = await stripeRoute(ctx, credential.channelId);
      const headers: Record<string, string> = { authorization: `Bearer ${route.key}` };
      if (route.account) headers['stripe-account'] = route.account;
      // An own key acts as its account: the account path names itself (stripe-own-key.ts).
      const path =
        !route.account && /^\/v1\/accounts\/[^/]+$/.test(url.pathname) ? '/v1/account' : undefined;
      return { origin: ['https://api.stripe.com'], headers, ...(path ? { path } : {}) };
    }
    case 'paypal': {
      const account = await paypalAccount(ctx, credential.channelId);
      return {
        origin: [`https://${PAYPAL_HOSTS[account.mode]}`],
        headers: { authorization: `Bearer ${await paypalToken(ctx, account)}` },
      };
    }
    case 'shorthop': {
      const connection = await shorthopConnection(ctx, credential.connectionId);
      // The api's rule for connecting one (engine shorthopUrlProblem): any address in
      // development, such as a Shorthop on the developer's machine; a public https host elsewhere.
      if (!ctx.config.development && outboundUrlProblem(connection.baseUrl)) {
        refuse('connection url');
      }
      return {
        origin: [new URL(connection.baseUrl).origin],
        headers: { authorization: `Bearer ${connection.key}` },
      };
    }
    case 'copilot': {
      const key = await copilotKey(ctx, credential.workspaceId);
      if (!ANTHROPIC_HOSTS.has(url.hostname)) refuse('host');
      return { origin: [`https://${url.hostname}`], headers: { 'x-api-key': key } };
    }
    case 'debounce': {
      const key = ctx.secrets.debounceApiKey;
      if (!key) return refuse('debounce off');
      url.searchParams.set('api', key);
      return { origin: ['https://api.debounce.io'], headers: {} };
    }
    default:
      return invalid('credential');
  }
}

/**
 * Checks one provider request against the allowlist, the principal and the rule's own checks,
 * and builds it with its credential attached. `stream` keeps to the rules marked to stream.
 */
async function prepare(
  ctx: VaultContext,
  principal: Principal,
  credential: CredentialRef,
  request: VaultRequest,
  stream: boolean,
): Promise<{ url: string; init: RequestInit }> {
  if (!credential || typeof credential !== 'object') return invalid('credential');
  if (!principal || typeof principal !== 'object') return invalid('principal');
  if (!request || typeof request.url !== 'string' || typeof request.method !== 'string') {
    return invalid('request');
  }
  if (
    request.body !== undefined &&
    (typeof request.body !== 'string' || request.body.length > MAX_BODY)
  ) {
    invalid('body');
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return invalid('url');
  }
  if (url.username || url.password || url.hash) invalid('url');
  const caller = ctx.caller as VaultCaller;
  const allowed = RULES.filter(
    (r) =>
      r.callers.includes(caller) &&
      r.credential === credential.kind &&
      r.principals.includes(principal.kind) &&
      r.method === request.method &&
      r.path.test(url.pathname) &&
      (!stream || r.stream === true),
  );
  if (!allowed.length) refuse('not on the allowlist');
  const acting = await actingFor(ctx, principal, credential);
  const matched = allowed.find((r) => r.principals.includes(acting.kind));
  if (!matched) return refuse('not on the allowlist');
  await matched.check?.(ctx, acting, url, request.body);

  const headers: Record<string, string> = {};
  for (const entry of request.headers ?? []) {
    if (!Array.isArray(entry) || entry.length !== 2) invalid('header');
    const [rawName, value] = entry as [unknown, unknown];
    if (typeof rawName !== 'string' || typeof value !== 'string') return invalid('header');
    const name = rawName.toLowerCase();
    if (CREDENTIAL_HEADERS.has(name)) refuse('credential header from the caller');
    if (PASS_HEADERS.has(name)) headers[name] = value;
  }
  const attached = await attach(ctx, credential, url);
  if (!attached.origin.includes(url.origin)) refuse('host');
  if (attached.path) url.pathname = attached.path;
  Object.assign(headers, attached.headers);
  return {
    url: url.toString(),
    init: {
      method: request.method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(stream ? STREAM_TIMEOUT_MS : TIMEOUT_MS),
      ...(request.body !== undefined ? { body: request.body } : {}),
    },
  };
}

const returnHeaders = (response: Response): [string, string][] =>
  [...response.headers.entries()].filter(([name]) => RETURN_HEADERS.has(name));

/** Sends one allowed provider request with its credential attached. */
export async function providerFetch(
  ctx: VaultContext,
  principal: Principal,
  credential: CredentialRef,
  request: VaultRequest,
): Promise<VaultResponse> {
  const { url, init } = await prepare(ctx, principal, credential, request, false);
  const response = await ctx.fetch(url, init);
  const text = await response.text();
  if (text.length > MAX_RESPONSE) refuse('response too large');
  return { status: response.status, headers: returnHeaders(response), body: text };
}

/**
 * providerFetch for a rule marked to stream: the answer's body is handed back as it arrives, cut
 * off with an error past MAX_RESPONSE bytes (or STREAM_TIMEOUT_MS), never read whole first.
 */
export async function providerStream(
  ctx: VaultContext,
  principal: Principal,
  credential: CredentialRef,
  request: VaultRequest,
): Promise<VaultStreamResponse> {
  const { url, init } = await prepare(ctx, principal, credential, request, true);
  const response = await ctx.fetch(url, init);
  let bytes = 0;
  const limit = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE) controller.error(new Error('response too large'));
      else controller.enqueue(chunk);
    },
  });
  return {
    status: response.status,
    headers: returnHeaders(response),
    body: response.body ? response.body.pipeThrough(limit) : null,
  };
}

/**
 * Whether a stored Copilot key opens for this principal, on the same rules as the calls that
 * would use it; nothing is sent.
 */
export async function checkCredential(
  ctx: VaultContext,
  principal: Principal,
  credential: CredentialRef,
): Promise<true> {
  if (!credential || typeof credential !== 'object' || credential.kind !== 'copilot') {
    return invalid('credential');
  }
  if (!principal || typeof principal !== 'object') return invalid('principal');
  const caller = ctx.caller as VaultCaller;
  const usable = RULES.some(
    (r) =>
      r.callers.includes(caller) &&
      r.credential === credential.kind &&
      r.principals.includes(principal.kind),
  );
  if (!usable) refuse('not on the allowlist');
  await actingFor(ctx, principal, credential);
  await copilotKey(ctx, credential.workspaceId);
  return true;
}
