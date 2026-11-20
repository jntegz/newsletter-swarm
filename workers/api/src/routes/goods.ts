// Goods (flag goods; docs/goods.md): products and their orders, for the dashboard.
import { createRoute, z } from '@hono/zod-openapi';
import {
  CreateGoodSchema,
  CursorQuerySchema,
  GoodOrderSchema,
  GoodSchema,
  UpdateGoodSchema,
  idPattern,
  page,
} from '@swarm/domain';
import { StripeError, endGoodOrder, stripeFor } from '@swarm/engine';
import { first } from '@swarm/db';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { createRouter, env, type AppContext } from '../lib/context';
import { credentialFetch } from '../lib/vault';
import {
  createGood,
  getGood,
  getOrder,
  listGoods,
  listOrders,
  requireGoods,
  updateGood,
} from '../lib/goods';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';
import { audit } from '../lib/site';

export const goods = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const goodParams = channelParam.extend(idParam('goodId', idPattern('good')).shape);
const orderParams = channelParam.extend(idParam('orderId', idPattern('goodOrder')).shape);
const TAGS = ['Goods'];

async function enter(c: AppContext, channelId: string, role: Parameters<typeof requireChannel>[2]) {
  const access = await requireChannel(c, channelId, role);
  await requireGoods(c, access);
  return access;
}

goods.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/goods',
    tags: TAGS,
    summary: 'Products of a publication',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(GoodSchema), 'Products'),
      ...errors('unauthorized', 'not_found', 'feature_disabled'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await enter(c, channelId, 'viewer');
    return c.json({ data: await listGoods(c, channelId) }, 200);
  },
);

goods.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/goods',
    tags: TAGS,
    summary: 'Create a product',
    description: 'It starts as a draft. Files must be PDFs in this publication’s media library.',
    request: { params: channelParam, body: jsonBody(CreateGoodSchema) },
    responses: {
      201: ok(GoodSchema, 'Created'),
      ...errors(
        'invalid_input',
        'unauthorized',
        'forbidden',
        'not_found',
        'conflict',
        'feature_disabled',
      ),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await enter(c, channelId, 'editor');
    const good = await createGood(c, channelId, c.req.valid('json'));
    await audit(c, access, 'good.created', 'good', good.id);
    return c.json({ data: good }, 201);
  },
);

goods.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/goods/{goodId}',
    tags: TAGS,
    summary: 'A product',
    request: { params: goodParams },
    responses: {
      200: ok(GoodSchema, 'Product'),
      ...errors('unauthorized', 'not_found', 'feature_disabled'),
    },
  }),
  async (c) => {
    const { channelId, goodId } = c.req.valid('param');
    await enter(c, channelId, 'viewer');
    return c.json({ data: await getGood(c, channelId, goodId) }, 200);
  },
);

goods.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/channels/{channelId}/goods/{goodId}',
    tags: TAGS,
    summary: 'Change a product',
    description:
      'Set `status` to `published` to put it on sale (it needs a price and a file), or `archived` to stop selling it. Buyers keep their files either way.',
    request: { params: goodParams, body: jsonBody(UpdateGoodSchema) },
    responses: {
      200: ok(GoodSchema, 'Changed'),
      ...errors(
        'invalid_input',
        'unauthorized',
        'forbidden',
        'not_found',
        'conflict',
        'feature_disabled',
      ),
    },
  }),
  async (c) => {
    const { channelId, goodId } = c.req.valid('param');
    const access = await enter(c, channelId, 'editor');
    const good = await updateGood(c, channelId, goodId, c.req.valid('json'));
    await audit(c, access, 'good.updated', 'good', good.id);
    return c.json({ data: good }, 200);
  },
);

goods.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/good-orders',
    tags: TAGS,
    summary: 'Orders, newest first',
    description:
      'Abandoned checkouts are left out. Admins only: orders hold buyers’ addresses and license keys.',
    request: { params: channelParam, query: CursorQuerySchema },
    responses: {
      200: ok(page(GoodOrderSchema), 'Orders'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'feature_disabled'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await enter(c, channelId, 'admin');
    const query = c.req.valid('query');
    return c.json({ data: await listOrders(c, channelId, query) }, 200);
  },
);

goods.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/good-orders/{orderId}/refund',
    tags: TAGS,
    summary: 'Refund an order in full',
    description:
      'Refunds through the publication’s Stripe account. The buyer loses access to the files and any license key stops working.',
    request: { params: orderParams },
    responses: {
      200: ok(GoodOrderSchema, 'Refunded'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict', 'feature_disabled'),
    },
  }),
  async (c) => {
    const { channelId, orderId } = c.req.valid('param');
    const access = await enter(c, channelId, 'admin');
    const e = env(c);
    const { order, paymentIntentId } = await getOrder(c, channelId, orderId);
    if (order.status !== 'paid' || !paymentIntentId) {
      throw new ApiError('conflict', 'Only a paid order can be refunded.');
    }
    const account = await first<{ stripe_account_id: string }>(
      e.DB,
      'SELECT stripe_account_id FROM stripe_accounts WHERE channel_id = ?1',
      channelId,
    );
    const stripe = stripeFor({
      ...e,
      ownKeyFetch: (id) => credentialFetch(c, { kind: 'stripe', channelId: id }),
    });
    if (!stripe || !account) {
      throw new ApiError('conflict', 'This publication has no Stripe account connected.');
    }
    try {
      await stripe.request(
        'POST',
        '/v1/refunds',
        { payment_intent: paymentIntentId },
        { account: account.stripe_account_id, idempotencyKey: `refund-${orderId}` },
      );
    } catch (error) {
      if (error instanceof StripeError) {
        throw new ApiError('conflict', `Stripe refused the refund: ${error.message}`);
      }
      throw error;
    }
    // Stripe's charge.refunded event finds this order already ended, and only records the money.
    await endGoodOrder(e.DB, {
      channelId,
      workspaceId: access.workspaceId,
      orderId,
      status: 'refunded',
      now: Date.now(),
    });
    await audit(c, access, 'good.refunded', 'good_order', orderId);
    return c.json({ data: (await getOrder(c, channelId, orderId)).order }, 200);
  },
);
