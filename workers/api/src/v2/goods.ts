// /v2 Goods (flag goods): products, orders and license checks, read-only (goods:read). Every route
// answers feature_disabled (404) while the flag is off. Writes stay in the dashboard for now.
import { z } from '@hono/zod-openapi';
import {
  CursorQuerySchema,
  GoodLicenseSchema,
  GoodOrderSchema,
  GoodSchema,
  idPattern,
  page,
} from '@swarm/domain';
import { checkLicense } from '@swarm/engine';
import { createRouter, env, type AppContext } from '../lib/context';
import { listGoods, listOrders, requireGoods } from '../lib/goods';
import { errors, idParam, ok } from '../lib/openapi';
import { decodeCursor, encodeCursor, guard, v2Route } from './route';

export const v2Goods = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const TAGS = ['Goods'];
const FLAG = 'Needs the goods flag on the Channel (404 feature_disabled otherwise).';
const read = errors('invalid_input', 'not_found', 'feature_disabled');

async function enter(c: AppContext, route: Parameters<typeof guard>[1], channelId: string) {
  const principal = await guard(c, route);
  await requireGoods(c, { workspaceId: principal.workspaceId, channelId });
}

const listRoute = v2Route('goods:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/goods',
  operationId: 'listGoods',
  tags: TAGS,
  summary: 'Products of a Channel',
  description: FLAG,
  request: { params: channelParam },
  responses: { 200: ok(z.object({ items: z.array(GoodSchema) }), 'Products'), ...read },
});
v2Goods.openapi(listRoute, async (c) => {
  const { channelId } = c.req.valid('param');
  await enter(c, listRoute, channelId);
  return c.json({ data: { items: await listGoods(c, channelId) } }, 200);
});

const ordersRoute = v2Route('goods:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/good-orders',
  operationId: 'listGoodOrders',
  tags: TAGS,
  summary: 'Orders of a Channel, newest first',
  description: `${FLAG} Abandoned checkouts are left out.`,
  request: { params: channelParam, query: CursorQuerySchema },
  responses: { 200: ok(page(GoodOrderSchema), 'Orders'), ...read },
});
v2Goods.openapi(ordersRoute, async (c) => {
  const { channelId } = c.req.valid('param');
  await enter(c, ordersRoute, channelId);
  const query = c.req.valid('query');
  const result = await listOrders(c, channelId, {
    limit: query.limit,
    cursor: decodeCursor(query.cursor),
  });
  return c.json(
    { data: { items: result.items, nextCursor: encodeCursor(result.nextCursor) } },
    200,
  );
});

const licenseRoute = v2Route('goods:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/license-keys/{licenseKey}',
  operationId: 'checkLicenseKey',
  tags: TAGS,
  summary: 'Check a license key',
  description: `${FLAG} \`valid\` is false for an unknown key, and for one whose order was refunded or disputed. For a publisher’s own app to call from its server.`,
  request: {
    params: channelParam.extend({ licenseKey: z.string().min(1).max(64) }),
  },
  responses: { 200: ok(GoodLicenseSchema, 'License'), ...read },
});
v2Goods.openapi(licenseRoute, async (c) => {
  const { channelId, licenseKey } = c.req.valid('param');
  await enter(c, licenseRoute, channelId);
  return c.json({ data: await checkLicense(env(c).DB, channelId, licenseKey) }, 200);
});
