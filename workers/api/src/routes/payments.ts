// Settings → Payments (Phase 5): connecting a Channel's own Stripe account (Connect Standard via
// OAuth, 0% platform take), its settings, and the Connect webhook that keeps Member
// subscriptions in step with Stripe.
import { createRoute, z } from '@hono/zod-openapi';
import { channelAccess, first, roleAtLeast, run, toIso, workspaceRole } from '@swarm/db';
import {
  ConnectStripeKeySchema,
  ConnectUrlSchema,
  ErrorEnvelopeSchema,
  PaymentsStatusSchema,
  StripeWebhookAckSchema,
  UpdatePaymentsSchema,
  idPattern,
  type ConnectCallbackError,
  type PaymentsStatus,
} from '@swarm/domain';
import {
  HANDLED_STRIPE_EVENTS,
  HttpStripe,
  linksFor,
  OWN_KEY_READ_CHECKS,
  RESTRICTED_KEY,
  StripeError,
  STRIPE_API_VERSION,
  handleStripeEvent,
  stripeApi,
  stripeFor,
  stripeForKey,
  verifyStripeSignature,
  VAULT_HELD_KEY,
  type GoodsLinkMinter,
  type MemberLinkMinter,
  type StripeApi,
  type StripeEvent,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { vaultValue } from '@swarm/vault';
import { signToken, verifyToken } from '@swarm/tokens';
import type { ApiEnv } from '../env';
import { checkSessionReach, requireChannel } from '../lib/access';
import { platformStripe } from '../lib/levels';
import { createRouter, env, type AppContext } from '../lib/context';
import { mailer } from '../lib/mail';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';
import { flagOn } from '../lib/copilot';
import { audit, siteConfig } from '../lib/site';
import {
  apiVault,
  credentialFetch,
  credentialOf,
  privacyVault,
  providerFetch,
  vaultGoodsLinks,
  vaultMemberLinks,
  type PaymentEvent,
} from '../lib/vault';

export const payments = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));

const STATE_PURPOSE = 'stripe-connect';
/** Long enough to finish Stripe's onboarding forms, short enough to be useless when leaked. */
const STATE_TTL_SECONDS = 30 * 60;
/** Stripe events are well under this; anything bigger is not from Stripe. */
const MAX_WEBHOOK_BYTES = 512 * 1024;

const callbackUri = (e: ApiEnv) => `${e.APP_ORIGIN}/api/v1/payments/connect/callback`;

/** The Settings → Payments page the Connect callback returns to. */
const settingsUrl = (e: ApiEnv, channelId: string | null, params: Record<string, string>) => {
  const url = new URL('/settings/payments', e.APP_ORIGIN);
  if (channelId) url.searchParams.set('channel', channelId);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
};

function requireStripe(e: ApiEnv): StripeApi {
  const stripe = stripeApi(e);
  if (!stripe) throw new ApiError('unavailable', 'Payments are not available here.');
  return stripe;
}

/**
 * The Connect OAuth client id. The env schema requires it when PAYMENTS is "stripe"; the dev
 * fake (development and test only) never sends it anywhere, so it gets a placeholder.
 */
function connectClientId(e: ApiEnv): string {
  if (e.PAYMENTS === 'stripe' && e.STRIPE_CONNECT_CLIENT_ID) return e.STRIPE_CONNECT_CLIENT_ID;
  if (e.PAYMENTS === 'dev') return 'dev-fake';
  throw new ApiError('unavailable', 'Payments are not available here.');
}

interface AccountRow {
  channel_id: string;
  workspace_id: string;
  stripe_account_id: string;
  status: 'connected' | 'disconnected';
  charges_enabled: number;
  payouts_enabled: number;
  details_submitted: number;
  livemode: number;
  default_currency: string | null;
  tax_enabled: number;
  grace_days: number;
  connected_at: number;
  disconnected_at: number | null;
  own_key_enc: string | null;
  own_key_last4: string | null;
  webhook_endpoint_id: string | null;
  webhook_secret_enc: string | null;
}

const readAccount = (db: D1Database, channelId: string) =>
  first<AccountRow>(db, 'SELECT * FROM stripe_accounts WHERE channel_id = ?1', channelId);

const connectAvailable = (e: ApiEnv) =>
  e.PAYMENTS === 'dev' || (e.PAYMENTS === 'stripe' && !!e.STRIPE_CONNECT_CLIENT_ID);

async function statusOf(c: AppContext, channelId: string, workspaceId: string) {
  const e = env(c);
  const keyAvailable = await flagOn(c, 'stripe_own_key', { workspaceId, channelId });
  return toStatus(e, await readAccount(e.DB, channelId), keyAvailable);
}

function toStatus(e: ApiEnv, row: AccountRow | null, keyAvailable: boolean): PaymentsStatus {
  const connected = row?.status === 'connected';
  return {
    available: connectAvailable(e) || keyAvailable || (connected && !!row?.own_key_enc),
    connectAvailable: connectAvailable(e),
    keyAvailable,
    method: !connected ? null : row?.own_key_enc ? 'key' : 'connect',
    keyLast4: connected ? (row?.own_key_last4 ?? null) : null,
    connected: row?.status === 'connected',
    state: row ? row.status : 'not_connected',
    stripeAccountId: row?.stripe_account_id ?? null,
    chargesEnabled: row?.charges_enabled === 1,
    payoutsEnabled: row?.payouts_enabled === 1,
    detailsSubmitted: row?.details_submitted === 1,
    livemode: row?.livemode === 1,
    taxEnabled: row?.tax_enabled === 1,
    graceDays: row?.grace_days ?? 7,
    defaultCurrency: row?.default_currency ?? null,
    connectedAt: row ? toIso(row.connected_at) : null,
    disconnectedAt: row?.disconnected_at ? toIso(row.disconnected_at) : null,
  };
}

payments.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/payments',
    tags: ['Payments'],
    summary: 'Payments status',
    description:
      "The Channel's connected Stripe account: whether it can take charges and receive payouts, Stripe Tax and the grace period for failed payments.",
    request: { params: channelParam },
    responses: {
      200: ok(PaymentsStatusSchema, 'Status'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'viewer');
    return c.json({ data: await statusOf(c, channelId, access.workspaceId) }, 200);
  },
);

payments.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/payments/connect',
    tags: ['Payments'],
    summary: 'Start connecting Stripe',
    description:
      "Admin role. Returns Stripe's Connect page; the operator returns through the callback to Settings → Payments. A Channel with a connected account must disconnect it first.",
    request: { params: channelParam },
    responses: {
      200: ok(ConnectUrlSchema, 'Where to send the operator'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
      503: {
        description: 'unavailable',
        content: { 'application/json': { schema: ErrorEnvelopeSchema } },
      },
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'admin');
    const e = env(c);
    const stripe = requireStripe(e);
    const existing = await readAccount(e.DB, channelId);
    if (existing?.status === 'connected') {
      throw new ApiError('conflict', 'A Stripe account is already connected. Disconnect it first.');
    }
    const state = await signToken(
      e.AUTH_KEYS,
      STATE_PURPOSE,
      { c: channelId, o: access.auth.operatorId },
      { expiresInSeconds: STATE_TTL_SECONDS },
    );
    const url = stripe.connectUrl(connectClientId(e), state, callbackUri(e));
    return c.json({ data: { url } }, 200);
  },
);

payments.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/payments/connect/callback',
    tags: ['Payments'],
    summary: 'Finish connecting Stripe',
    description:
      "Stripe's OAuth redirect. Checks the signed state, that the signed-in operator started the flow and still has the admin role, exchanges the code and records the account. An account can be connected to one Channel only. Redirects to Settings → Payments with connected=1 or error=<code>.",
    request: {
      query: z.object({
        code: z.string().max(512).optional(),
        state: z.string().max(1024).optional(),
        error: z.string().max(200).optional(),
        error_description: z.string().max(1000).optional(),
      }),
    },
    responses: { 302: { description: 'Redirect to Settings → Payments' } },
  }),
  async (c) => {
    const e = env(c);
    const query = c.req.valid('query');
    const fail = (channelId: string | null, error: ConnectCallbackError) =>
      c.redirect(settingsUrl(e, channelId, { error }), 302);

    const verified = query.state
      ? await verifyToken<{ c?: unknown; o?: unknown }>(e.AUTH_KEYS, STATE_PURPOSE, query.state)
      : null;
    const channelId =
      verified?.ok && typeof verified.payload.c === 'string' ? verified.payload.c : null;
    const operatorId =
      verified?.ok && typeof verified.payload.o === 'string' ? verified.payload.o : null;
    if (!channelId || !operatorId) return fail(null, 'state');
    // The flow belongs to whoever started it: a link someone else started can't bind an account.
    const session = c.get('auth');
    if (!session || session.secondFactor !== 'ok' || session.operatorId !== operatorId) {
      return fail(channelId, 'state');
    }
    if (query.error || !query.code) return fail(channelId, 'cancelled');

    const access = await channelAccess(e.DB, operatorId, channelId);
    if (!access || access.deleted || !roleAtLeast(access.role, 'admin')) {
      return fail(null, 'forbidden');
    }
    // The same SSO reach rules as requireChannel (enforced SSO, a provider's own workspace).
    try {
      const seat = await workspaceRole(e.DB, operatorId, access.workspaceId);
      await checkSessionReach(c, session, access.workspaceId, seat ?? access.role);
    } catch {
      return fail(null, 'forbidden');
    }
    const stripe = platformStripe(c);
    if (!stripe) return fail(channelId, 'exchange');

    let accountId: string;
    let livemode: boolean;
    try {
      ({ accountId, livemode } = await stripe.connectExchange(query.code));
    } catch {
      return fail(channelId, 'exchange');
    }
    const bound = await first<{ channel_id: string; status: string; own_key_enc: string | null }>(
      e.DB,
      'SELECT channel_id, status, own_key_enc FROM stripe_accounts WHERE stripe_account_id = ?1',
      accountId,
    );
    // The exchange authorized the platform on the account. Refused, it is removed again, unless a
    // Channel is connected to that account through Connect: revoking would disconnect it too. No
    // other row holds an authorization: disconnecting revoked it, and a key needs none.
    const refuse = async (error: ConnectCallbackError) => {
      if (!(bound?.status === 'connected' && !bound.own_key_enc)) {
        try {
          await stripe.connectRevoke(connectClientId(e), accountId);
        } catch (revokeError) {
          c.get('log')?.warn('stripe connect revoke failed', {
            error: (revokeError as Error).message,
          });
        }
      }
      return fail(channelId, error);
    };
    if (bound && bound.channel_id !== channelId) return refuse('account_in_use');
    // Starting needs no account connected, but the link lasts 30 minutes: one may have arrived since,
    // and a key-connected account changes only through its owner.
    if ((await readAccount(e.DB, channelId))?.status === 'connected') {
      return refuse('state');
    }

    let account: Record<string, unknown> = {};
    try {
      account = await stripe.request('GET', `/v1/accounts/${encodeURIComponent(accountId)}`);
    } catch {
      // The flags arrive with account.updated anyway.
    }
    const flag = (key: string) => (account[key] === true ? 1 : 0);
    const currency =
      typeof account.default_currency === 'string' && account.default_currency.length === 3
        ? account.default_currency.toLowerCase()
        : null;
    const now = Date.now();
    await run(
      e.DB,
      `INSERT INTO stripe_accounts (channel_id, workspace_id, stripe_account_id, status, charges_enabled,
              payouts_enabled, details_submitted, livemode, default_currency, connected_by, connected_at,
              disconnected_at, updated_at)
       VALUES (?1, ?2, ?3, 'connected', ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?10)
       ON CONFLICT (channel_id) DO UPDATE SET
         stripe_account_id = excluded.stripe_account_id, status = 'connected',
         charges_enabled = excluded.charges_enabled, payouts_enabled = excluded.payouts_enabled,
         details_submitted = excluded.details_submitted, livemode = excluded.livemode,
         default_currency = excluded.default_currency, connected_by = excluded.connected_by,
         connected_at = excluded.connected_at, disconnected_at = NULL, updated_at = excluded.updated_at`,
      channelId,
      access.workspaceId,
      accountId,
      flag('charges_enabled'),
      flag('payouts_enabled'),
      flag('details_submitted'),
      livemode ? 1 : 0,
      currency,
      operatorId,
      now,
    );
    await audit(
      c,
      { workspaceId: access.workspaceId, auth: session },
      'payments.connected',
      'channel',
      channelId,
      {
        stripeAccountId: accountId,
        livemode,
      },
    );
    return c.redirect(settingsUrl(e, channelId, { connected: '1' }), 302);
  },
);

payments.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/channels/{channelId}/payments',
    tags: ['Payments'],
    summary: 'Change payment settings',
    description:
      'Admin role. Stripe Tax on Checkout, and the days a subscription with a failed payment keeps access (0 to 30).',
    request: { params: channelParam, body: jsonBody(UpdatePaymentsSchema) },
    responses: {
      200: ok(PaymentsStatusSchema, 'Updated'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const e = env(c);
    const before = await readAccount(e.DB, channelId);
    if (!before) throw new ApiError('not_found', 'Connect a Stripe account first.');
    await run(
      e.DB,
      `UPDATE stripe_accounts SET tax_enabled = coalesce(?1, tax_enabled),
              grace_days = coalesce(?2, grace_days), updated_at = ?3
        WHERE channel_id = ?4`,
      input.taxEnabled === undefined ? null : input.taxEnabled ? 1 : 0,
      input.graceDays ?? null,
      Date.now(),
      channelId,
    );
    await audit(c, access, 'payments.settings_changed', 'channel', channelId, {
      ...(input.taxEnabled === undefined
        ? {}
        : { taxEnabled: { from: before.tax_enabled === 1, to: input.taxEnabled } }),
      ...(input.graceDays === undefined
        ? {}
        : { graceDays: { from: before.grace_days, to: input.graceDays } }),
    });
    return c.json({ data: await statusOf(c, channelId, access.workspaceId) }, 200);
  },
);

payments.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/payments/disconnect',
    tags: ['Payments'],
    summary: 'Disconnect Stripe',
    description:
      'Admin role. Removes the platform from the Stripe account. Existing Member subscriptions keep their rows; Stripe stops sending their events, so new purchases are no longer possible.',
    request: { params: channelParam },
    responses: {
      200: ok(PaymentsStatusSchema, 'Disconnected'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'admin');
    const e = env(c);
    const row = await readAccount(e.DB, channelId);
    if (!row) throw new ApiError('not_found', 'No Stripe account is connected.');
    if (row.status !== 'connected') {
      throw new ApiError('conflict', 'The Stripe account is already disconnected.');
    }
    if (row.own_key_enc) {
      if (!roleAtLeast(access.role, 'owner')) {
        throw new ApiError('forbidden', 'Only an owner can remove a Stripe key.');
      }
      await removeOwnWebhook(c, row);
    } else {
      const stripe = requireStripe(e);
      await stripe.connectRevoke(connectClientId(e), row.stripe_account_id);
    }
    const now = Date.now();
    await run(
      e.DB,
      `UPDATE stripe_accounts SET status = 'disconnected', disconnected_at = ?1, updated_at = ?1,
              own_key_enc = NULL, own_key_last4 = NULL, webhook_endpoint_id = NULL,
              webhook_secret_enc = NULL
        WHERE channel_id = ?2`,
      now,
      channelId,
    );
    await refreshSitePages(e.DB, channelId);
    await audit(c, access, 'payments.disconnected', 'channel', channelId, {
      stripeAccountId: row.stripe_account_id,
    });
    return c.json({ data: await statusOf(c, channelId, access.workspaceId) }, 200);
  },
);

// ---------------------------------------------------------------------------------------------
// A publication's own restricted key

const stripeProblem = (error: unknown) =>
  error instanceof StripeError ? error.message : 'Stripe could not be reached. Try again.';

/** The plans page is cached and shows whether paid memberships are open. */
const refreshSitePages = (db: D1Database, channelId: string) =>
  run(
    db,
    `INSERT INTO site_settings (channel_id, cache_version, updated_at) VALUES (?1, 2, ?2)
       ON CONFLICT (channel_id) DO UPDATE SET cache_version = cache_version + 1, updated_at = ?2`,
    channelId,
    Date.now(),
  );

/** Best effort: the Owner can also delete the endpoint in Stripe, and its secret is forgotten. */
async function removeOwnWebhook(c: AppContext, row: AccountRow) {
  const e = env(c);
  if (!row.webhook_endpoint_id || !row.own_key_enc) return;
  try {
    // On the publication's own key, which only the vault holds and attaches.
    const own =
      e.PAYMENTS === 'dev'
        ? stripeForKey(e, VAULT_HELD_KEY)
        : new HttpStripe(
            VAULT_HELD_KEY,
            credentialFetch(c, { kind: 'stripe', channelId: row.channel_id }),
          );
    await own.request(
      'DELETE',
      `/v1/webhook_endpoints/${encodeURIComponent(row.webhook_endpoint_id)}`,
    );
  } catch (error) {
    c.get('log')?.warn('stripe webhook endpoint not removed', { reason: stripeProblem(error) });
  }
}

payments.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/channels/{channelId}/payments/stripe-key',
    tags: ['Payments'],
    summary: 'Connect Stripe with a restricted key',
    description:
      'Owner role, flag stripe_own_key. Takes a restricted key (rk_…) only. Swarm checks it, creates a webhook endpoint for this publication and stores the key and the signing secret encrypted. The key is never returned. A new key for the same Stripe account replaces the old one.',
    request: { params: channelParam, body: jsonBody(ConnectStripeKeySchema) },
    responses: {
      200: ok(PaymentsStatusSchema, 'Connected'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { apiKey } = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'owner');
    const e = env(c);
    if (!(await flagOn(c, 'stripe_own_key', { workspaceId: access.workspaceId, channelId }))) {
      throw new ApiError('feature_disabled', 'Connecting with a key is not turned on here.');
    }
    const refuse = (message: string) => {
      throw new ApiError('invalid_input', message, [{ path: 'apiKey', message }]);
    };
    if (!RESTRICTED_KEY.test(apiKey)) {
      refuse(
        apiKey.startsWith('sk_')
          ? 'This is a full secret key. Create a restricted key (rk_…) in Stripe instead, so Swarm holds only the access it needs.'
          : 'Use a restricted key from Stripe. It starts with rk_live_ or rk_test_.',
      );
    }

    const candidate = testFetch ? new HttpStripe(apiKey, testFetch) : stripeForKey(e, apiKey);
    let account: Record<string, unknown> = {};
    try {
      for (const path of OWN_KEY_READ_CHECKS) {
        const answer = await candidate.request<Record<string, unknown>>(
          'GET',
          path,
          path === '/v1/account' ? {} : { limit: 1 },
        );
        if (path === '/v1/account') account = answer;
      }
    } catch (error) {
      refuse(`Stripe refused this key: ${stripeProblem(error)}`);
    }
    const accountId = typeof account.id === 'string' ? account.id : '';
    if (!accountId.startsWith('acct_')) refuse('Stripe did not say which account this key is for.');

    const current = await readAccount(e.DB, channelId);
    const connected = current?.status === 'connected' ? current : null;
    if (connected && (!connected.own_key_enc || connected.stripe_account_id !== accountId)) {
      throw new ApiError('conflict', 'Disconnect the current Stripe account first.');
    }
    // Stripe keeps test and live webhooks apart, so a kept endpoint would never hear of live sales.
    if (connected && connected.livemode !== (apiKey.startsWith('rk_live_') ? 1 : 0)) {
      throw new ApiError(
        'conflict',
        'Moving between test and live needs a new webhook. Disconnect Stripe, then add this key.',
      );
    }
    const bound = await first<{ channel_id: string }>(
      e.DB,
      'SELECT channel_id FROM stripe_accounts WHERE stripe_account_id = ?1',
      accountId,
    );
    if (bound && bound.channel_id !== channelId) {
      throw new ApiError('conflict', 'That Stripe account is connected to another publication.');
    }

    // A replacement key keeps the endpoint and its secret, so no event is lost in between.
    let endpointId = connected?.webhook_endpoint_id ?? null;
    let secretEnc = connected?.webhook_secret_enc ?? null;
    let createdEndpoint: string | null = null;
    if (!endpointId || !secretEnc) {
      try {
        const endpoint = await candidate.request<{ id?: unknown; secret?: unknown }>(
          'POST',
          '/v1/webhook_endpoints',
          {
            url: `${e.APP_ORIGIN}/api/v1/stripe/webhook/${channelId}`,
            enabled_events: [...HANDLED_STRIPE_EVENTS],
            api_version: STRIPE_API_VERSION,
            description: 'Swarm',
          },
        );
        if (typeof endpoint.id !== 'string' || typeof endpoint.secret !== 'string') {
          throw new StripeError('Stripe did not return a webhook secret.', 502, null, null);
        }
        endpointId = createdEndpoint = endpoint.id;
        secretEnc = await sealStripeSecret(c, 'stripe-webhook', channelId, endpoint.secret);
      } catch (error) {
        refuse(`Stripe refused to add the webhook: ${stripeProblem(error)}`);
      }
    }

    const flag = (key: string) => (account[key] === true ? 1 : 0);
    const currency =
      typeof account.default_currency === 'string' && account.default_currency.length === 3
        ? account.default_currency.toLowerCase()
        : null;
    const now = Date.now();
    try {
      await run(
        e.DB,
        `INSERT INTO stripe_accounts (channel_id, workspace_id, stripe_account_id, status, charges_enabled,
                payouts_enabled, details_submitted, livemode, default_currency, connected_by, connected_at,
                disconnected_at, updated_at, own_key_enc, own_key_last4, webhook_endpoint_id, webhook_secret_enc)
         VALUES (?1, ?2, ?3, 'connected', ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT (channel_id) DO UPDATE SET
           stripe_account_id = excluded.stripe_account_id, status = 'connected',
           charges_enabled = excluded.charges_enabled, payouts_enabled = excluded.payouts_enabled,
           details_submitted = excluded.details_submitted, livemode = excluded.livemode,
           default_currency = excluded.default_currency, connected_by = excluded.connected_by,
           connected_at = excluded.connected_at, disconnected_at = NULL, updated_at = excluded.updated_at,
           own_key_enc = excluded.own_key_enc, own_key_last4 = excluded.own_key_last4,
           webhook_endpoint_id = excluded.webhook_endpoint_id,
           webhook_secret_enc = excluded.webhook_secret_enc`,
        channelId,
        access.workspaceId,
        accountId,
        flag('charges_enabled'),
        flag('payouts_enabled'),
        flag('details_submitted'),
        apiKey.startsWith('rk_live_') ? 1 : 0,
        currency,
        access.auth.operatorId,
        now,
        await sealStripeSecret(c, 'stripe-own', channelId, apiKey),
        apiKey.slice(-4),
        endpointId,
        secretEnc,
      );
    } catch (error) {
      // Don't leave Stripe sending events to a publication that never saved the secret.
      if (createdEndpoint) {
        await candidate
          .request('DELETE', `/v1/webhook_endpoints/${encodeURIComponent(createdEndpoint)}`)
          .catch(() => undefined);
      }
      throw error;
    }
    await refreshSitePages(e.DB, channelId);
    await audit(c, access, 'payments.stripe_key_saved', 'channel', channelId, {
      stripeAccountId: accountId,
      keyLast4: apiKey.slice(-4),
    });
    return c.json({ data: await statusOf(c, channelId, access.workspaceId) }, 200);
  },
);

/** Lets a test answer for Stripe on keys it checks. */
let testFetch: typeof fetch | null = null;
export function useStripeKeyFetchForTests(fetcher: typeof fetch | null) {
  testFetch = fetcher;
}

// ---------------------------------------------------------------------------------------------
// Webhook

const StripeEventSchema = z.object({
  id: z.string().min(1).max(255),
  type: z.string().min(1).max(120),
  account: z.string().max(255).optional(),
  created: z.number().int(),
  livemode: z.boolean(),
  data: z.object({
    object: z.record(z.string(), z.unknown()),
    previous_attributes: z.record(z.string(), z.unknown()).optional(),
  }),
});

/** A key or signing secret of the Channel's Stripe, sealed by the vault for its row. */
async function sealStripeSecret(
  c: AppContext,
  kind: 'stripe-own' | 'stripe-webhook',
  channelId: string,
  plaintext: string,
): Promise<string> {
  return vaultValue(
    await apiVault(c).sealCredential(credentialOf(c), { ref: { kind, channelId }, plaintext }),
  );
}

/**
 * What handling one verified event needs. The recorded event (stripe_events, named for its
 * Channel once resolved) is the vault's authority for the Member Center and goods links in its
 * mail and for calls on a publication's own key.
 */
function paymentsContext(c: AppContext, stripe: StripeApi, eventId: string) {
  const e = env(c);
  const event = (channelId: string): PaymentEvent => ({
    kind: 'payment-event',
    provider: 'stripe',
    channelId,
    eventId,
  });
  const memberLinks: MemberLinkMinter = {
    memberToken: (member, options) =>
      vaultMemberLinks(c, event(member.channelId)).memberToken(member, options),
  };
  const goodsLinks: GoodsLinkMinter = {
    libraryToken: (input) => vaultGoodsLinks(c, event(input.channelId)).libraryToken(input),
    orderToken: (input) => vaultGoodsLinks(c, event(input.channelId)).orderToken(input),
  };
  return {
    db: e.DB,
    stripe,
    links: linksFor(e),
    memberLinks,
    goodsLinks,
    fieldKeys: privacyVault(c),
    now: Date.now(),
    mail: {
      adapter: mailer(e),
      platformMailDomain: e.PLATFORM_MAIL_DOMAIN,
      site: siteConfig(c),
      captureOrigin: e.CAPTURE_ORIGIN,
    },
  };
}

payments.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/stripe/webhook',
    tags: ['Payments'],
    summary: 'Stripe Connect webhook',
    description:
      'Called by Stripe, not the dashboard. The raw body must carry a valid Stripe-Signature (any v1 signature against any configured secret, within 300 seconds); anything else is refused with 400. Each event id is processed once. A processing error answers 500 so Stripe retries the event.',
    responses: {
      200: ok(StripeWebhookAckSchema, 'Received'),
      ...errors('invalid_input'),
      500: { description: 'Processing failed; Stripe retries' },
    },
  }),
  async (c) => {
    const e = env(c);
    const stripe = stripeApi(e);
    if (!stripe) throw new ApiError('feature_disabled', 'Payments are off.');
    const payload = await c.req.text();
    if (payload.length > MAX_WEBHOOK_BYTES) {
      throw new ApiError('invalid_input', 'The event is too large.');
    }
    const signature = await verifyStripeSignature(
      payload,
      c.req.header('stripe-signature'),
      e.STRIPE_WEBHOOK_SECRETS,
    );
    if (!signature.ok) {
      c.get('log')?.warn('stripe webhook refused', { reason: signature.reason });
      throw new ApiError('invalid_input', 'The signature check failed.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new ApiError('invalid_input', 'The event is not JSON.');
    }
    const event = StripeEventSchema.safeParse(parsed);
    if (!event.success) throw new ApiError('invalid_input', 'The event is malformed.');
    const outcome = await handleStripeEvent(
      paymentsContext(c, stripe, event.data.id),
      event.data as StripeEvent,
    );
    return c.json({ data: { received: true as const, outcome } }, 200);
  },
);

payments.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/stripe/webhook/{channelId}',
    tags: ['Payments'],
    summary: 'Stripe webhook of a publication with its own key',
    description:
      'Called by Stripe. Checked only against the signing secret of this publication, which also decides whose event it is: an `account` field in the body is ignored.',
    request: { params: channelParam },
    responses: {
      200: ok(StripeWebhookAckSchema, 'Received'),
      ...errors('invalid_input'),
      500: { description: 'Processing failed; Stripe retries' },
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const e = env(c);
    const payload = await c.req.text();
    if (payload.length > MAX_WEBHOOK_BYTES) {
      throw new ApiError('invalid_input', 'The event is too large.');
    }
    const row = await readAccount(e.DB, channelId);
    // The same answer as a bad signature: nothing here says which publications exist.
    if (row?.status !== 'connected' || !row.webhook_secret_enc) {
      throw new ApiError('invalid_input', 'The signature check failed.');
    }
    // The vault checks the signature against the stored secret, before anything is parsed or the
    // own key is used; the secret never comes here. A vault that is down answers 500 (Stripe
    // retries), never a weaker check.
    const verified = await apiVault(c).verifyStripeWebhook({
      channelId,
      payload,
      signature: c.req.header('stripe-signature') ?? '',
    });
    if (!verified.ok && verified.reason !== 'unavailable') {
      c.get('log')?.warn('stripe webhook refused', { reason: verified.reason });
      throw new ApiError('invalid_input', 'The signature check failed.');
    }
    if (!verified.ok) throw new Error('The vault could not check the signature.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new ApiError('invalid_input', 'The event is not JSON.');
    }
    const event = StripeEventSchema.safeParse(parsed);
    if (!event.success) throw new ApiError('invalid_input', 'The event is malformed.');
    const eventId = event.data.id;
    // Calls on the own key go through the vault, under this recorded event.
    const stripe = stripeFor({
      ...e,
      ownKeyFetch: (id) =>
        providerFetch(
          c,
          { kind: 'payment-event', provider: 'stripe', channelId: id, eventId },
          { kind: 'stripe', channelId: id },
        ),
    });
    if (!stripe) throw new ApiError('invalid_input', 'The signature check failed.');
    const outcome = await handleStripeEvent(paymentsContext(c, stripe, eventId), {
      ...event.data,
      account: row.stripe_account_id,
    } as StripeEvent);
    return c.json({ data: { received: true as const, outcome } }, 200);
  },
);
