// /v2 Event Webhooks (Phase 7): the dashboard's webhook operations for API keys and OAuth
// tokens, workspace-level (the principal's workspace). Reads need webhooks:read, changes
// webhooks:write. A principal limited to some Channels sees and manages only endpoints filtered
// to one of them. Implementation: lib/webhooks.ts.
import { z } from '@hono/zod-openapi';
import {
  CreateWebhookEndpointSchema,
  RedriveResultSchema,
  RedriveWebhookDeliveriesSchema,
  SendTestWebhookSchema,
  UpdateWebhookEndpointSchema,
  WebhookDeliveriesQuerySchema,
  WebhookDeliveryDetailSchema,
  WebhookDeliverySchema,
  WebhookEndpointSchema,
  WebhookEndpointWithSecretSchema,
  idPattern,
  page,
  type ApiScope,
} from '@swarm/domain';
import { clientIp, createRouter, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import {
  createEndpoint,
  deleteEndpoint,
  getDelivery,
  listDeliveries,
  listEndpoints,
  redriveDelivery,
  redriveFailedSince,
  requireEndpoint,
  rotateSecret,
  sendTest,
  toWebhookEndpoint,
  updateEndpoint,
  type WebhookActor,
} from '../lib/webhooks';
import { requireScope } from './context';
import { NO_STORE } from './idempotency';
import { v2Route } from './route';

export const webhooksV2 = createRouter();

const endpointParams = idParam('endpointId', idPattern('webhookEndpoint'));
const deliveryParams = endpointParams.extend(
  idParam('deliveryId', idPattern('webhookDelivery')).shape,
);

function actorFor(c: AppContext, scope: ApiScope): WebhookActor {
  const principal = requireScope(c, scope);
  return {
    workspaceId: principal.workspaceId,
    operatorId: null,
    principalId: principal.id,
    principalKind: principal.kind === 'oauth' ? 'oauth' : 'key',
    channelIds: principal.channelIds,
    ipPrefix: ipPrefix(clientIp(c)),
  };
}

const tags = ['Webhooks'];
const read = errors('unauthorized', 'forbidden', 'not_found', 'rate_limited');
const write = errors(
  'invalid_input',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
);

webhooksV2.openapi(
  v2Route('webhooks:read', {
    method: 'get',
    path: '/v2/webhooks',
    operationId: 'listWebhookEndpoints',
    tags,
    summary: 'Webhook endpoints',
    description: 'Scope: webhooks:read.',
    responses: { 200: ok(z.array(WebhookEndpointSchema), 'Endpoints'), ...read },
  }),
  async (c) => c.json({ data: await listEndpoints(c, actorFor(c, 'webhooks:read')) }, 200),
);

webhooksV2.openapi(
  v2Route('webhooks:write', {
    method: 'post',
    path: '/v2/webhooks',
    operationId: 'createWebhookEndpoint',
    tags,
    summary: 'Add a webhook endpoint',
    description:
      'Scope: webhooks:write. Returns the signing secret once. URLs must be https with a public host name. A key or app can only propose an endpoint: it receives nothing (`suspendedReason: unconfirmed`) until an admin confirms it in the dashboard, and the workspace’s owners and admins are emailed. It also stops if the key or app is revoked.',
    request: { body: jsonBody(CreateWebhookEndpointSchema) },
    responses: { 201: ok(WebhookEndpointWithSecretSchema, 'Created, with the secret'), ...write },
  }),
  async (c) =>
    c.json(
      { data: await createEndpoint(c, actorFor(c, 'webhooks:write'), c.req.valid('json')) },
      201,
      NO_STORE,
    ),
);

webhooksV2.openapi(
  v2Route('webhooks:read', {
    method: 'get',
    path: '/v2/webhooks/{endpointId}',
    operationId: 'getWebhookEndpoint',
    tags,
    summary: 'A webhook endpoint',
    description: 'Scope: webhooks:read.',
    request: { params: endpointParams },
    responses: { 200: ok(WebhookEndpointSchema, 'Endpoint'), ...read },
  }),
  async (c) => {
    const actor = actorFor(c, 'webhooks:read');
    const endpoint = await requireEndpoint(c, actor, c.req.valid('param').endpointId);
    return c.json({ data: toWebhookEndpoint(endpoint) }, 200);
  },
);

webhooksV2.openapi(
  v2Route('webhooks:write', {
    method: 'patch',
    path: '/v2/webhooks/{endpointId}',
    operationId: 'updateWebhookEndpoint',
    tags,
    summary: 'Change, pause or resume a webhook endpoint',
    description:
      'Scope: webhooks:write. Changing the URL or publication makes it a proposal again: it receives nothing until an admin confirms it in the dashboard.',
    request: { params: endpointParams, body: jsonBody(UpdateWebhookEndpointSchema) },
    responses: { 200: ok(WebhookEndpointSchema, 'Updated'), ...write },
  }),
  async (c) => {
    const actor = actorFor(c, 'webhooks:write');
    const { endpointId } = c.req.valid('param');
    return c.json({ data: await updateEndpoint(c, actor, endpointId, c.req.valid('json')) }, 200);
  },
);

webhooksV2.openapi(
  v2Route('webhooks:write', {
    method: 'delete',
    path: '/v2/webhooks/{endpointId}',
    operationId: 'deleteWebhookEndpoint',
    tags,
    summary: 'Delete a webhook endpoint',
    description: 'Scope: webhooks:write.',
    request: { params: endpointParams },
    responses: { 204: noContent, ...read },
  }),
  async (c) => {
    await deleteEndpoint(c, actorFor(c, 'webhooks:write'), c.req.valid('param').endpointId);
    return c.body(null, 204);
  },
);

webhooksV2.openapi(
  v2Route('webhooks:write', {
    method: 'post',
    path: '/v2/webhooks/{endpointId}/rotate-secret',
    operationId: 'rotateWebhookSecret',
    tags,
    summary: 'Rotate the signing secret',
    description:
      'Scope: webhooks:write. Returns the new secret once; the previous one also signs for 24 hours.',
    request: { params: endpointParams },
    responses: { 200: ok(WebhookEndpointWithSecretSchema, 'Rotated'), ...read },
  }),
  async (c) =>
    c.json(
      {
        data: await rotateSecret(c, actorFor(c, 'webhooks:write'), c.req.valid('param').endpointId),
      },
      200,
      NO_STORE,
    ),
);

webhooksV2.openapi(
  v2Route('webhooks:write', {
    method: 'post',
    path: '/v2/webhooks/{endpointId}/test',
    operationId: 'sendWebhookTest',
    tags,
    summary: 'Send a test event',
    description: 'Scope: webhooks:write.',
    request: { params: endpointParams, body: jsonBody(SendTestWebhookSchema) },
    responses: { 202: ok(WebhookDeliverySchema, 'Queued'), ...write },
  }),
  async (c) => {
    const actor = actorFor(c, 'webhooks:write');
    const { endpointId } = c.req.valid('param');
    return c.json({ data: await sendTest(c, actor, endpointId, c.req.valid('json').type) }, 202);
  },
);

webhooksV2.openapi(
  v2Route('webhooks:read', {
    method: 'get',
    path: '/v2/webhooks/{endpointId}/deliveries',
    operationId: 'listWebhookDeliveries',
    tags,
    summary: 'The delivery log of an endpoint',
    description: 'Scope: webhooks:read. Newest first.',
    request: { params: endpointParams, query: WebhookDeliveriesQuerySchema },
    responses: { 200: ok(page(WebhookDeliverySchema), 'Deliveries'), ...read },
  }),
  async (c) => {
    const actor = actorFor(c, 'webhooks:read');
    const { endpointId } = c.req.valid('param');
    return c.json({ data: await listDeliveries(c, actor, endpointId, c.req.valid('query')) }, 200);
  },
);

webhooksV2.openapi(
  v2Route('webhooks:read', {
    method: 'get',
    path: '/v2/webhooks/{endpointId}/deliveries/{deliveryId}',
    operationId: 'getWebhookDelivery',
    tags,
    summary: 'One delivery: payload, headers, response and attempts',
    description: 'Scope: webhooks:read.',
    request: { params: deliveryParams },
    responses: { 200: ok(WebhookDeliveryDetailSchema, 'Delivery'), ...read },
  }),
  async (c) => {
    const actor = actorFor(c, 'webhooks:read');
    const { endpointId, deliveryId } = c.req.valid('param');
    return c.json({ data: await getDelivery(c, actor, endpointId, deliveryId) }, 200);
  },
);

webhooksV2.openapi(
  v2Route('webhooks:write', {
    method: 'post',
    path: '/v2/webhooks/{endpointId}/deliveries/{deliveryId}/redrive',
    operationId: 'redriveWebhookDelivery',
    tags,
    summary: 'Send a delivery again',
    description: 'Scope: webhooks:write. Idempotent: a delivery already waiting is left alone.',
    request: { params: deliveryParams },
    responses: { 202: ok(WebhookDeliverySchema, 'Queued (or already queued)'), ...write },
  }),
  async (c) => {
    const actor = actorFor(c, 'webhooks:write');
    const { endpointId, deliveryId } = c.req.valid('param');
    return c.json({ data: await redriveDelivery(c, actor, endpointId, deliveryId) }, 202);
  },
);

webhooksV2.openapi(
  v2Route('webhooks:write', {
    method: 'post',
    path: '/v2/webhooks/{endpointId}/redrive',
    operationId: 'redriveWebhookDeliveries',
    tags,
    summary: 'Send every failed delivery since a time again',
    description: 'Scope: webhooks:write. Up to 1,000 per call.',
    request: { params: endpointParams, body: jsonBody(RedriveWebhookDeliveriesSchema) },
    responses: { 202: ok(RedriveResultSchema, 'Queued'), ...write },
  }),
  async (c) => {
    const actor = actorFor(c, 'webhooks:write');
    const { endpointId } = c.req.valid('param');
    return c.json(
      { data: await redriveFailedSince(c, actor, endpointId, c.req.valid('json').since) },
      202,
    );
  },
);
