// Connecting Stripe with a publication's own restricted key: who may, which keys, how it is stored
// and what a webhook has to prove. docs/deployment.md.
import { SELF, env } from 'cloudflare:test';
import type { PaymentsStatus } from '@swarm/domain';
import { openAppKey, signStripePayload, stripeFor } from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { createDownVault, useVaultForTests, vaultClient, vaultFetch } from '@swarm/vault';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useStripeKeyFetchForTests } from '../src/routes/payments';
import { call, createChannel, seatAs, signIn } from './helpers';
import { installFakeVault, useVaultProviderFetch } from './vault-fetch';
import { data, enableFlag, errorCode, freshStripe } from './money-helpers';

const KEY = 'rk_test_0123456789abcd';
const keyPath = (id: string) => `/api/v1/channels/${id}/payments/stripe-key`;
const hook = (id: string) => `/api/v1/stripe/webhook/${id}`;

async function setUp() {
  const owner = await signIn();
  const channel = await createChannel(owner);
  await enableFlag('stripe_own_key', owner.workspaceId, channel.id);
  return { owner, channel };
}

const put = (cookie: string, id: string, apiKey = KEY) =>
  call('PUT', keyPath(id), { cookie, body: { apiKey } });

const row = (id: string) =>
  env.DB.prepare('SELECT * FROM stripe_accounts WHERE channel_id = ?1')
    .bind(id)
    .first<Record<string, string | null>>();

const testKeys = () => parseKeyring(`f1:${'f'.repeat(64)}`);

async function openSecret(channelId: string, workspaceId: string) {
  const sealed = (await row(channelId))!.webhook_secret_enc as string;
  return (await openAppKey(testKeys(), workspaceId, sealed)) as string;
}

beforeAll(() => {
  freshStripe();
});
afterEach(() => {
  useStripeKeyFetchForTests(null);
  useVaultProviderFetch(null);
});

describe('adding a restricted key', () => {
  it('is behind its switch', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    const res = await put(owner.cookie, channel.id);
    expect(await errorCode(res)).toBe('feature_disabled');
  });

  it('is for owners only', async () => {
    const { owner, channel } = await setUp();
    const admin = await seatAs(owner.workspaceId, 'admin');
    const res = await put(admin.cookie, channel.id);
    expect(res.status).toBe(403);
    expect(await row(channel.id)).toBeNull();
  });

  it.each(['sk_live_0123456789abcd', 'sk_test_0123456789abcd', 'pk_test_0123456789abcd'])(
    'refuses %s',
    async (bad) => {
      const { owner, channel } = await setUp();
      const res = await put(owner.cookie, channel.id, bad);
      expect(res.status).toBe(400);
      expect(await row(channel.id)).toBeNull();
    },
  );

  it('stores the key and secret sealed, and never gives the key back', async () => {
    const { owner, channel } = await setUp();
    const res = await put(owner.cookie, channel.id);
    const text = await res.clone().text();
    const status = await data<PaymentsStatus>(res);
    expect(status).toMatchObject({
      connected: true,
      method: 'key',
      keyLast4: 'abcd',
      chargesEnabled: true,
      livemode: false,
    });
    expect(text).not.toContain(KEY);
    const saved = await row(channel.id);
    expect(saved?.own_key_enc).toBeTruthy();
    expect(saved?.own_key_enc).not.toContain(KEY);
    expect(saved?.webhook_secret_enc).not.toContain('whsec');
    const read = await call('GET', `/api/v1/channels/${channel.id}/payments`, {
      cookie: owner.cookie,
    });
    expect(await read.text()).not.toContain(KEY);
  });

  it('only an owner removes it, and removing forgets the key and secret', async () => {
    const { owner, channel } = await setUp();
    await data(await put(owner.cookie, channel.id));
    const admin = await seatAs(owner.workspaceId, 'admin');
    const path = `/api/v1/channels/${channel.id}/payments/disconnect`;
    expect((await call('POST', path, { cookie: admin.cookie })).status).toBe(403);
    await data(await call('POST', path, { cookie: owner.cookie }));
    const saved = await row(channel.id);
    expect(saved).toMatchObject({
      status: 'disconnected',
      own_key_enc: null,
      own_key_last4: null,
      webhook_secret_enc: null,
    });
  });
});

describe('real Stripe answers for a key', () => {
  it('shows Stripe’s message when a permission is missing, and saves nothing', async () => {
    const { owner, channel } = await setUp();
    useStripeKeyFetchForTests(async () =>
      Response.json(
        { error: { message: 'The provided key does not have the required permissions' } },
        { status: 403 },
      ),
    );
    const res = await put(owner.cookie, channel.id);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/required permissions/);
    expect(await row(channel.id)).toBeNull();
  });

  it('asks Stripe for a webhook on this publication’s own address', async () => {
    const { owner, channel } = await setUp();
    const posted: string[] = [];
    useStripeKeyFetchForTests(async (input, init) => {
      if (init?.method === 'POST') {
        posted.push(String(init.body));
        return Response.json({ id: 'we_1', secret: 'whsec_real' });
      }
      return String(input).endsWith('/v1/account')
        ? Response.json({ id: `acct_${crypto.randomUUID().slice(0, 8)}`, charges_enabled: true })
        : Response.json({ data: [] });
    });
    await data(await put(owner.cookie, channel.id));
    expect(decodeURIComponent(posted[0]!)).toContain(`/api/v1/stripe/webhook/${channel.id}`);
    expect(await openSecret(channel.id, owner.workspaceId)).toBe('whsec_real');
  });
});

describe('changing an account that has a key', () => {
  const stripeAnswers = (account: string) =>
    useStripeKeyFetchForTests(async (input, init) => {
      if (init?.method === 'POST') return Response.json({ id: 'we_1', secret: 'whsec_real' });
      return String(input).endsWith('/v1/account')
        ? Response.json({ id: account, charges_enabled: true })
        : Response.json({ data: [] });
    });

  it('refuses moving from a test key to a live one without disconnecting', async () => {
    const { owner, channel } = await setUp();
    stripeAnswers(`acct_${crypto.randomUUID().slice(0, 8)}`);
    await data(await put(owner.cookie, channel.id));
    const live = await put(owner.cookie, channel.id, 'rk_live_0123456789abcd');
    expect(await errorCode(live)).toBe('conflict');
    expect((await row(channel.id))!.livemode).toBe(0);
  });

  it('takes a new key of the same mode and keeps the webhook', async () => {
    const { owner, channel } = await setUp();
    stripeAnswers(`acct_${crypto.randomUUID().slice(0, 8)}`);
    await data(await put(owner.cookie, channel.id));
    const before = await row(channel.id);
    await data(await put(owner.cookie, channel.id, 'rk_test_9876543210wxyz'));
    const after = await row(channel.id);
    expect(after!.own_key_last4).toBe('wxyz');
    expect(after!.webhook_secret_enc).toBe(before!.webhook_secret_enc);
  });

  it('a Connect link started earlier can’t replace it', async () => {
    const { owner, channel } = await setUp();
    const start = await data<{ url: string }>(
      await call('POST', `/api/v1/channels/${channel.id}/payments/connect`, {
        cookie: owner.cookie,
      }),
    );
    stripeAnswers(`acct_${crypto.randomUUID().slice(0, 8)}`);
    await data(await put(owner.cookie, channel.id));
    const before = await row(channel.id);
    const state = new URL(start.url).searchParams.get('state') as string;
    const res = await call(
      'GET',
      `/api/v1/payments/connect/callback?${new URLSearchParams({ code: 'dev_acct_attacker1', state })}`,
      { cookie: owner.cookie },
    );
    expect(res.headers.get('location')).toContain('error=state');
    expect((await row(channel.id))!.stripe_account_id).toBe(before!.stripe_account_id);
  });
});

describe('routing money calls', () => {
  it('runs an own-key account on its key with no Stripe-Account header, through the vault', async () => {
    const { owner, channel } = await setUp();
    await data(await put(owner.cookie, channel.id));
    const account = (await row(channel.id))!.stripe_account_id as string;
    const seen: { auth: string | null; account: string | null; url: string }[] = [];
    // The api never holds the key: the vault attaches it on the way out.
    useVaultProviderFetch(async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        auth: headers.get('authorization'),
        account: headers.get('stripe-account'),
        url: String(input),
      });
      return new Response('{"id":"x"}');
    });
    const session = {
      kind: 'operator-session' as const,
      sessionToken: owner.cookie.slice(owner.cookie.indexOf('=') + 1),
    };
    const client = stripeFor({
      DB: env.DB,
      PAYMENTS: 'off',
      ENVIRONMENT: 'test',
      ownKeyFetch: (channelId) =>
        vaultFetch(vaultClient('api', null), session, { kind: 'stripe', channelId }),
    });
    await client!.request('GET', `/v1/accounts/${account}`, {}, { account });
    expect(seen[0]).toEqual({
      auth: `Bearer ${KEY}`,
      account: null,
      url: 'https://api.stripe.com/v1/account',
    });
  });

  it('refuses another account when this deployment has no Connect', async () => {
    const client = stripeFor({ DB: env.DB, PAYMENTS: 'off', ENVIRONMENT: 'test' });
    await expect(
      client!.request('GET', '/v1/customers', {}, { account: 'acct_someoneelse' }),
    ).rejects.toThrow(/not available/);
  });

  it('never reaches an own-key account without the vault', async () => {
    const { owner, channel } = await setUp();
    await data(await put(owner.cookie, channel.id));
    const account = (await row(channel.id))!.stripe_account_id as string;
    const client = stripeFor({ DB: env.DB, PAYMENTS: 'off', ENVIRONMENT: 'test' });
    await expect(client!.request('GET', '/v1/customers', {}, { account })).rejects.toThrow(
      /can’t be read/,
    );
  });
});

describe('the publication’s webhook', () => {
  const event = (id: string, account?: string) =>
    JSON.stringify({
      id: `evt_${id}`,
      type: 'account.updated',
      ...(account ? { account } : {}),
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object: { id: 'acct_x', charges_enabled: false } },
    });
  const post = (id: string, body: string, signature?: string) =>
    SELF.fetch(`http://localhost${hook(id)}`, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        ...(signature ? { 'stripe-signature': signature } : {}),
      },
    });

  it('refuses no signature, a forged one and an unknown publication alike', async () => {
    const { owner, channel } = await setUp();
    await data(await put(owner.cookie, channel.id));
    const body = event('forged');
    expect((await post(channel.id, body)).status).toBe(400);
    const forged = await signStripePayload(body, 'whsec_wrong');
    expect((await post(channel.id, body, forged)).status).toBe(400);
    expect((await post('ch_00000000000000000000', body, forged)).status).toBe(400);
  });

  it('a bad signature is refused by the vault before the own key is used', async () => {
    const { owner, channel } = await setUp();
    await data(await put(owner.cookie, channel.id));
    const outbound: string[] = [];
    useVaultProviderFetch(async (input) => {
      outbound.push(String(input));
      return new Response('{}');
    });
    const body = event('badsig');
    const forged = await signStripePayload(body, 'whsec_wrong');
    expect((await post(channel.id, body, forged)).status).toBe(400);
    expect(outbound).toEqual([]);
    const refused = await env.DB.prepare(
      "SELECT count(*) AS n FROM vault_audit WHERE op = 'verifyStripeWebhook' AND channel_id = ?1",
    )
      .bind(channel.id)
      .first<{ n: number }>();
    expect(refused!.n).toBeGreaterThan(0);
  });

  it('answers 500 while the vault is down, so Stripe retries', async () => {
    const { owner, channel } = await setUp();
    await data(await put(owner.cookie, channel.id));
    const secret = await openSecret(channel.id, owner.workspaceId);
    const body = event(`down${Date.now()}`);
    const signed = await signStripePayload(body, secret);
    useVaultForTests('api', createDownVault<'api'>());
    try {
      expect((await post(channel.id, body, signed)).status).toBe(500);
    } finally {
      await installFakeVault();
    }
  });

  it('signed with another publication’s secret is refused', async () => {
    const a = await setUp();
    const b = await setUp();
    await data(await put(a.owner.cookie, a.channel.id));
    await data(await put(b.owner.cookie, b.channel.id));
    const secretOfA = await openSecret(a.channel.id, a.owner.workspaceId);
    const body = event('crossed');
    const signed = await signStripePayload(body, secretOfA);
    expect((await post(b.channel.id, body, signed)).status).toBe(400);
  });

  it('belongs to this publication whatever account the body claims', async () => {
    const victim = await setUp();
    const attacker = await setUp();
    await data(await put(victim.owner.cookie, victim.channel.id));
    await data(await put(attacker.owner.cookie, attacker.channel.id));
    const victimAccount = (await row(victim.channel.id))!.stripe_account_id as string;
    const secret = await openSecret(attacker.channel.id, attacker.owner.workspaceId);
    const body = event(`claim${Date.now()}`, victimAccount);
    const res = await post(attacker.channel.id, body, await signStripePayload(body, secret));
    expect(res.status).toBe(200);
    expect((await row(victim.channel.id))!.charges_enabled).toBe(1);
  });
});

describe('the payments ledger across publications', () => {
  const paid = (invoiceId: string, amount: number) =>
    JSON.stringify({
      id: `evt_${crypto.randomUUID().replaceAll('-', '')}`,
      type: 'invoice.paid',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object: { id: invoiceId, amount_paid: amount, currency: 'usd' } },
    });
  const send = async (channelId: string, workspaceId: string, body: string) =>
    SELF.fetch(`http://localhost${hook(channelId)}`, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': await signStripePayload(body, await openSecret(channelId, workspaceId)),
      },
    });
  const amounts = async (channelId: string, objectId: string) =>
    (
      await env.DB.prepare(
        'SELECT amount FROM payments WHERE channel_id = ?1 AND stripe_object_id = ?2',
      )
        .bind(channelId, objectId)
        .all<{ amount: number }>()
    ).results.map((r) => r.amount);

  it("can't be pre-claimed by another publication's event for the same object", async () => {
    const attacker = await setUp();
    const victim = await setUp();
    await data(await put(attacker.owner.cookie, attacker.channel.id));
    await data(await put(victim.owner.cookie, victim.channel.id));
    const invoiceId = `in_shared${crypto.randomUUID().slice(0, 8)}`;
    const a = attacker.channel.id;
    const v = victim.channel.id;
    expect((await send(a, attacker.owner.workspaceId, paid(invoiceId, 500))).status).toBe(200);
    expect((await send(v, victim.owner.workspaceId, paid(invoiceId, 700))).status).toBe(200);
    // A redelivery within one publication still adds nothing.
    expect((await send(v, victim.owner.workspaceId, paid(invoiceId, 700))).status).toBe(200);
    expect(await amounts(a, invoiceId)).toEqual([500]);
    expect(await amounts(v, invoiceId)).toEqual([700]);
  });
});
