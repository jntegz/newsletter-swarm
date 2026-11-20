import { signToken } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DevStripe,
  HttpStripe,
  PaymentsEnvFields,
  checkPaymentsEnv,
  checkoutReferenceParams,
  encodeStripeForm,
  newCheckoutReference,
  readCheckoutClaims,
  signCheckoutReference,
  signedCheckoutReference,
  signStripePayload,
  verifyStripeSignature,
} from '../src/index';
import { memberKeys, workerLinks } from './link-keys';

const secret = 'whsec_test_0123456789abcdef';
const payload = '{"id":"evt_1","type":"checkout.session.completed"}';
const now = 1_790_000_000_000;

describe('verifyStripeSignature', () => {
  it('accepts a valid signature', async () => {
    const header = await signStripePayload(payload, secret, now);
    expect(await verifyStripeSignature(payload, header, [secret], now)).toEqual({
      ok: true,
      timestamp: Math.floor(now / 1000),
    });
  });

  it('rejects a missing header, an empty secret list and empty secrets', async () => {
    const header = await signStripePayload(payload, secret, now);
    expect(await verifyStripeSignature(payload, null, [secret], now)).toMatchObject({
      reason: 'missing',
    });
    expect(await verifyStripeSignature(payload, header, [], now)).toMatchObject({
      reason: 'no_secret',
    });
    expect(await verifyStripeSignature(payload, header, [''], now)).toMatchObject({
      reason: 'no_secret',
    });
  });

  it('rejects a wrong signature, a changed body and a malformed header', async () => {
    const header = await signStripePayload(payload, 'whsec_other_0123456789', now);
    expect(await verifyStripeSignature(payload, header, [secret], now)).toMatchObject({
      reason: 'mismatch',
    });
    const good = await signStripePayload(payload, secret, now);
    expect(await verifyStripeSignature(`${payload} `, good, [secret], now)).toMatchObject({
      reason: 'mismatch',
    });
    expect(await verifyStripeSignature(payload, 'v1=abc', [secret], now)).toMatchObject({
      reason: 'malformed',
    });
  });

  it('rejects old and far-future timestamps (300 s tolerance)', async () => {
    const header = await signStripePayload(payload, secret, now - 301_000);
    expect(await verifyStripeSignature(payload, header, [secret], now)).toMatchObject({
      reason: 'too_old',
    });
    const future = await signStripePayload(payload, secret, now + 301_000);
    expect(await verifyStripeSignature(payload, future, [secret], now)).toMatchObject({
      reason: 'too_old',
    });
    const edge = await signStripePayload(payload, secret, now - 299_000);
    expect((await verifyStripeSignature(payload, edge, [secret], now)).ok).toBe(true);
  });

  it('accepts when any of several v1 signatures matches, and any secret during rotation', async () => {
    const good = await signStripePayload(payload, secret, now);
    const t = good.split(',')[0];
    const v1 = good.split(',')[1];
    const header = `${t},v1=${'0'.repeat(64)},${v1},v0=${'1'.repeat(64)}`;
    expect((await verifyStripeSignature(payload, header, [secret], now)).ok).toBe(true);
    expect(
      (await verifyStripeSignature(payload, good, ['whsec_old_000000000000', secret], now)).ok,
    ).toBe(true);
  });
});

describe('checkout references', () => {
  const site = workerLinks('site');
  const api = workerLinks('api');
  const read = async (value: unknown) => (await readCheckoutClaims(api, value, now))?.reference;

  it('round-trip from the site to the api, and refuse tampering', async () => {
    const reference = newCheckoutReference();
    const signed = await signCheckoutReference(site, reference, now);
    expect(await read(signed)).toBe(reference);
    expect(await read(`${signed}x`)).toBeUndefined();
    expect(await read('')).toBeUndefined();
    expect(await read('ch_x:')).toBeUndefined();
    // The api holds only the public key: it can't make one.
    await expect(signCheckoutReference(api, reference, now)).rejects.toThrow(
      /CHECKOUT_SIGNING_KEYS/,
    );
  });

  it('travel in metadata, since an Ed25519 one is longer than client_reference_id may be', async () => {
    const reference = newCheckoutReference();
    const signed = await signCheckoutReference(site, reference, now, { signedIn: true });
    expect(signed.length).toBeGreaterThan(200);
    const params = checkoutReferenceParams(reference, signed);
    expect(params).toEqual({ client_reference_id: reference, metadata: { swarm_ref: signed } });
    const session = { client_reference_id: params.client_reference_id, metadata: params.metadata };
    expect(await readCheckoutClaims(api, signedCheckoutReference(session), now)).toEqual({
      reference,
      signedIn: true,
    });
  });

  it('still read a v1 reference from before the cutover in client_reference_id', async () => {
    const reference = newCheckoutReference();
    const old = await signToken(
      memberKeys,
      'checkout-ref',
      { r: reference },
      {
        expiresInSeconds: 30 * 86_400,
        now: Date.now() - 2 * 86_400_000,
      },
    );
    expect(old.length).toBeLessThanOrEqual(200);
    expect(checkoutReferenceParams(reference, old).client_reference_id).toBe(old);
    expect(
      await readCheckoutClaims(api, signedCheckoutReference({ client_reference_id: old })),
    ).toEqual({ reference, signedIn: false });
  });
});

describe('encodeStripeForm', () => {
  it('uses bracket notation for nested objects and arrays', () => {
    expect(
      encodeStripeForm({
        mode: 'subscription',
        line_items: [{ price: 'price_1', quantity: 1 }],
        metadata: { channel: 'ch_1' },
        skip: undefined,
      }),
    ).toBe(
      'mode=subscription&line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Bchannel%5D=ch_1',
    );
  });
});

describe('HttpStripe', () => {
  it('sends the connected account, idempotency key and pinned version', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetcher = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ id: 'prod_1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const stripe = new HttpStripe('sk_test_123', fetcher);
    await stripe.request(
      'POST',
      '/v1/products',
      { name: 'Paid' },
      {
        account: 'acct_1',
        idempotencyKey: 'k-1',
      },
    );
    const headers = (seen as unknown as { init: RequestInit }).init.headers as Record<
      string,
      string
    >;
    expect(headers['stripe-account']).toBe('acct_1');
    expect(headers['idempotency-key']).toBe('k-1');
    expect(headers['stripe-version']).toMatch(/^\d{4}-\d{2}-\d{2}\./);
    expect(headers.authorization).toBe('Bearer sk_test_123');
  });

  it('throws StripeError with the API message', async () => {
    const fetcher = (async () =>
      new Response(
        JSON.stringify({ error: { message: 'No such price', type: 'invalid_request_error' } }),
        {
          status: 404,
        },
      )) as unknown as typeof fetch;
    await expect(
      new HttpStripe('sk_test_1', fetcher).request('GET', '/v1/prices/x'),
    ).rejects.toThrow('No such price');
  });
});

describe('DevStripe', () => {
  it('points Checkout at the site dev page and records calls', async () => {
    const stripe = new DevStripe();
    const session = await stripe.request<{ id: string; url: string }>(
      'POST',
      '/v1/checkout/sessions',
      { success_url: 'http://notes.site.localhost:8792/subscribe/thanks' },
      { account: 'acct_1' },
    );
    expect(session.id).toMatch(/^cs_/);
    expect(session.url).toBe(`http://notes.site.localhost:8792/_swarm/checkout/dev/${session.id}`);
    expect(stripe.calls[0]?.options.account).toBe('acct_1');
  });

  it('completes Connect OAuth locally, with an account tests can name', async () => {
    const stripe = new DevStripe();
    const url = new URL(stripe.connectUrl('ca_dev', 'state-token-123', 'http://localhost/cb'));
    expect(url.searchParams.get('state')).toBe('state-token-123');
    const code = url.searchParams.get('code') as string;
    expect((await stripe.connectExchange(code)).accountId).toMatch(/^acct_dev/);
    expect((await stripe.connectExchange('dev_acct_Named123')).accountId).toBe('acct_Named123');
    await expect(stripe.connectExchange('ac_real')).rejects.toThrow('Unknown code');
  });
});

describe('checkPaymentsEnv', () => {
  const schema = (needs: { webhook?: boolean; connect?: boolean }) =>
    z
      .object({ ENVIRONMENT: z.string(), ...PaymentsEnvFields })
      .superRefine((env, ctx) => checkPaymentsEnv(env, ctx, needs));

  it('refuses the dev fake outside development and test', () => {
    expect(schema({}).safeParse({ ENVIRONMENT: 'production', PAYMENTS: 'dev' }).success).toBe(
      false,
    );
    expect(schema({}).safeParse({ ENVIRONMENT: 'test', PAYMENTS: 'dev' }).success).toBe(true);
  });

  it('requires the key, client id and webhook secrets for Stripe', () => {
    const base = { ENVIRONMENT: 'production', PAYMENTS: 'stripe' };
    expect(schema({ webhook: true, connect: true }).safeParse(base).success).toBe(false);
    expect(
      schema({ webhook: true, connect: true }).safeParse({
        ...base,
        STRIPE_SECRET_KEY: 'sk_live_123456',
        STRIPE_CONNECT_CLIENT_ID: 'ca_123',
        STRIPE_WEBHOOK_SECRETS: '',
      }).success,
    ).toBe(false);
    expect(
      schema({ webhook: true, connect: true }).safeParse({
        ...base,
        STRIPE_SECRET_KEY: 'sk_live_123456',
        STRIPE_CONNECT_CLIENT_ID: 'ca_123',
        STRIPE_WEBHOOK_SECRETS: `${secret}, whsec_second_0123456789`,
      }).success,
    ).toBe(true);
    expect(schema({}).safeParse({ ...base, STRIPE_SECRET_KEY: 'sk_live_123456' }).success).toBe(
      true,
    );
  });
});
