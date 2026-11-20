// Settings → Payments: a publication's own PayPal app for paid memberships, and its webhook.
// Contract: docs/deployment.md.
import { createRoute, z } from '@hono/zod-openapi';
import { first, run, toIso } from '@swarm/db';
import {
  ConnectPayPalSchema,
  PayPalStatusSchema,
  StripeWebhookAckSchema,
  idPattern,
  type PayPalStatus,
} from '@swarm/domain';
import {
  linksFor,
  PAYPAL_STUCK_EVENT_MS,
  PAYPAL_WEBHOOK_EVENTS,
  PayPalApi,
  PayPalError,
  admitPayPalVerification,
  handlePayPalEvent,
  payPalClient,
  payPalDeliveryProblem,
  readPayPalAccount,
  verifyPayPalWebhook,
  type PayPalEvent,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { vaultValue } from '@swarm/vault';
import { requireChannel } from '../lib/access';
import { createRouter, env, type AppContext } from '../lib/context';
import {
  apiVault,
  credentialFetch,
  credentialOf,
  privacyVault,
  providerFetch,
  vaultMemberLinks,
  type PaymentEvent,
} from '../lib/vault';
import { flagOn } from '../lib/copilot';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';
import { mailer } from '../lib/mail';
import { audit, siteConfig } from '../lib/site';

export const paypal = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const MAX_WEBHOOK_BYTES = 512 * 1024;

let injectedFetch: typeof fetch | null = null;
/** Lets a test answer for PayPal. */
export function usePayPalFetchForTests(fetcher: typeof fetch | null) {
  injectedFetch = fetcher;
}
const fetcher: typeof fetch = (input, init) => (injectedFetch ?? fetch)(input, init);

/** The plans page is cached and shows whether PayPal is on offer. */
const refreshSitePages = (db: D1Database, channelId: string) =>
  run(
    db,
    `INSERT INTO site_settings (channel_id, cache_version, updated_at) VALUES (?1, 2, ?2)
       ON CONFLICT (channel_id) DO UPDATE SET cache_version = cache_version + 1, updated_at = ?2`,
    channelId,
    Date.now(),
  );

async function statusOf(
  c: AppContext,
  channelId: string,
  workspaceId: string,
): Promise<PayPalStatus> {
  const row = await readPayPalAccount(env(c).DB, channelId);
  const unfinished = await first<{ n: number }>(
    env(c).DB,
    `SELECT count(*) AS n FROM paypal_events
      WHERE channel_id = ?1 AND (status = 'failed' OR (status = 'received' AND received_at < ?2))`,
    channelId,
    Date.now() - PAYPAL_STUCK_EVENT_MS,
  );
  return {
    available: await flagOn(c, 'paypal_memberships', { workspaceId, channelId }),
    connected: !!row,
    mode: row?.mode ?? null,
    clientId: row?.client_id ?? null,
    secretLast4: row?.secret_last4 ?? null,
    connectedAt: row ? toIso(row.connected_at) : null,
    unfinishedEvents: unfinished?.n ?? 0,
  };
}

paypal.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/payments/paypal',
    tags: ['Payments'],
    summary: 'PayPal status',
    request: { params: channelParam },
    responses: { 200: ok(PayPalStatusSchema, 'Status'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'viewer');
    return c.json({ data: await statusOf(c, channelId, access.workspaceId) }, 200);
  },
);

paypal.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/channels/{channelId}/payments/paypal',
    tags: ['Payments'],
    summary: 'Connect PayPal',
    description:
      'Owner role, flag paypal_memberships. Checks the client ID and secret, creates a webhook for this publication and stores the secret encrypted. The secret is never returned.',
    request: { params: channelParam, body: jsonBody(ConnectPayPalSchema) },
    responses: {
      200: ok(PayPalStatusSchema, 'Connected'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { mode, clientId, secret } = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'owner');
    const e = env(c);
    if (!(await flagOn(c, 'paypal_memberships', { workspaceId: access.workspaceId, channelId }))) {
      throw new ApiError('feature_disabled', 'PayPal is not turned on here.');
    }
    if (await readPayPalAccount(e.DB, channelId)) {
      throw new ApiError('conflict', 'Disconnect the current PayPal account first.');
    }
    const api = new PayPalApi(mode, clientId, secret, fetcher);
    let webhookId: string;
    try {
      const webhook = await api.request<{ id?: unknown }>('POST', '/v1/notifications/webhooks', {
        url: `${e.APP_ORIGIN}/api/v1/paypal/webhook/${channelId}`,
        event_types: PAYPAL_WEBHOOK_EVENTS.map((name) => ({ name })),
      });
      if (typeof webhook.id !== 'string') throw new PayPalError('PayPal sent no webhook.', 502);
      webhookId = webhook.id;
    } catch (error) {
      if (!(error instanceof PayPalError)) throw error;
      throw new ApiError('invalid_input', `PayPal refused this: ${error.message}`, [
        { path: 'secret', message: error.message },
      ]);
    }
    const now = Date.now();
    await run(
      e.DB,
      `INSERT INTO paypal_accounts (channel_id, workspace_id, mode, client_id, secret_enc, secret_last4,
              webhook_id, connected_by, connected_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
      channelId,
      access.workspaceId,
      mode,
      clientId,
      // Sealed by the vault for this Channel's account; it never leaves the vault again.
      vaultValue(
        await apiVault(c).sealCredential(credentialOf(c), {
          ref: { kind: 'paypal', channelId },
          plaintext: secret,
        }),
      ),
      secret.slice(-4),
      webhookId,
      access.auth.operatorId,
      now,
    );
    await refreshSitePages(e.DB, channelId);
    await audit(c, access, 'payments.paypal_connected', 'channel', channelId, { mode, clientId });
    return c.json({ data: await statusOf(c, channelId, access.workspaceId) }, 200);
  },
);

paypal.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}/payments/paypal',
    tags: ['Payments'],
    summary: 'Disconnect PayPal',
    description:
      'Owner role. Deletes the webhook and forgets the secret. Existing subscriptions keep charging in PayPal until they are canceled there.',
    request: { params: channelParam },
    responses: {
      200: ok(PayPalStatusSchema, 'Disconnected'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'owner');
    const e = env(c);
    const row = await readPayPalAccount(e.DB, channelId);
    if (!row) throw new ApiError('not_found', 'PayPal isn’t connected.');
    try {
      const api = await payPalClient(
        { fetchFor: (id) => credentialFetch(c, { kind: 'paypal', channelId: id }) },
        row,
      );
      await api?.request(
        'DELETE',
        `/v1/notifications/webhooks/${encodeURIComponent(row.webhook_id)}`,
      );
    } catch (error) {
      c.get('log')?.warn('paypal webhook not removed', { reason: (error as Error).message });
    }
    await e.DB.batch([
      e.DB.prepare('DELETE FROM paypal_accounts WHERE channel_id = ?1').bind(channelId),
      // Plans belong to the PayPal account that made them.
      e.DB.prepare('UPDATE level_prices SET paypal_plan_id = NULL WHERE channel_id = ?1').bind(
        channelId,
      ),
    ]);
    await refreshSitePages(e.DB, channelId);
    await audit(c, access, 'payments.paypal_disconnected', 'channel', channelId, {});
    return c.json({ data: await statusOf(c, channelId, access.workspaceId) }, 200);
  },
);

const PayPalEventSchema = z.object({
  id: z.string().min(1).max(255),
  event_type: z.string().min(1).max(120),
  resource: z.record(z.string(), z.unknown()),
});

paypal.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/paypal/webhook/{channelId}',
    tags: ['Payments'],
    summary: 'PayPal webhook of a publication',
    description:
      'Called by PayPal. Every delivery is checked with PayPal’s signature check against this publication’s webhook before its body is acted on. Free local checks (the signature headers, a transmission time within four days, a PayPal certificate host, a well-formed event of a handled type) come first, and each publication may ask PayPal for a bounded number of checks a minute, so an anonymous post can’t spend its PayPal credentials without limit. A processing error, PayPal being unreachable during the check, or a used-up check budget answers 5xx, so PayPal delivers it again.',
    request: { params: channelParam },
    responses: {
      200: ok(StripeWebhookAckSchema, 'Received'),
      ...errors('invalid_input'),
      500: { description: 'Processing failed; PayPal retries' },
      503: { description: 'PayPal could not be asked, or too many checks; PayPal retries' },
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const e = env(c);
    const raw = await c.req.text();
    if (raw.length > MAX_WEBHOOK_BYTES) {
      throw new ApiError('invalid_input', 'The event is too large.');
    }
    const refused = () => new ApiError('invalid_input', 'The signature check failed.');
    const now = Date.now();
    // Everything that costs nothing first: no database read and no call to PayPal before these.
    if (payPalDeliveryProblem(c.req.raw.headers, now)) throw refused();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw refused();
    }
    const shape = PayPalEventSchema.safeParse(parsed);
    if (!shape.success) throw refused();
    const account = await readPayPalAccount(e.DB, channelId);
    if (!account) throw refused();
    // A type Swarm doesn't handle changes nothing, so it isn't worth a check on the tenant's key.
    if (!(PAYPAL_WEBHOOK_EVENTS as readonly string[]).includes(shape.data.event_type)) {
      return c.json({ data: { received: true as const, outcome: 'ignored' as const } }, 200);
    }
    if (!(await admitPayPalVerification(e.DB, channelId, now))) {
      c.get('log')?.warn('paypal webhook over its check budget', { channelId });
      c.header('retry-after', '60');
      throw new ApiError('unavailable', 'Too many deliveries to check. Send it again later.');
    }
    // Asked through the vault, which attaches the account's own credentials: anonymous traffic for
    // this Channel may only ask PayPal's signature check there.
    const checker = await payPalClient(
      {
        fetchFor: (id) =>
          providerFetch(
            c,
            { kind: 'public-channel', channelId: id },
            { kind: 'paypal', channelId: id },
          ),
      },
      account,
    );
    if (!checker) throw refused();
    const verified = await verifyPayPalWebhook(checker, account.webhook_id, c.req.raw.headers, raw);
    if (verified === 'unavailable') {
      c.get('log')?.warn('paypal webhook check unavailable', { channelId });
      throw new ApiError(
        'unavailable',
        'PayPal could not check this delivery. Send it again later.',
      );
    }
    if (verified !== 'verified') {
      c.get('log')?.warn('paypal webhook refused', { channelId });
      throw refused();
    }
    // What follows runs under the recorded event (paypal_events), the vault's authority for it.
    const event: PaymentEvent = {
      kind: 'payment-event',
      provider: 'paypal',
      channelId,
      eventId: shape.data.id,
    };
    const api = await payPalClient(
      { fetchFor: (id) => providerFetch(c, event, { kind: 'paypal', channelId: id }) },
      account,
    );
    if (!api) throw refused();
    const outcome = await handlePayPalEvent(
      {
        db: e.DB,
        api,
        account,
        now,
        fieldKeys: privacyVault(c),
        notices: {
          links: linksFor(e),
          memberLinks: vaultMemberLinks(c, event),
          mail: {
            adapter: mailer(e),
            platformMailDomain: e.PLATFORM_MAIL_DOMAIN,
            site: siteConfig(c),
            captureOrigin: e.CAPTURE_ORIGIN,
          },
        },
      },
      shape.data as PayPalEvent,
    );
    return c.json({ data: { received: true as const, outcome } }, 200);
  },
);
