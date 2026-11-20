// Event Webhooks: endpoints, the delivery log and redrive (Settings → Developers) (Phase 7).
// Workspace-level, admin and above, audited. The same operations are on /v2 (v2/webhooks.ts);
// both call lib/webhooks.ts. Receivers' guide: docs/webhooks.md.
import { createRoute, z } from '@hono/zod-openapi';
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
} from '@swarm/domain';
import { requireWorkspace } from '../lib/access';
import { clientIp, createRouter, env, type AppContext, type AuthContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { loadFactors, requireFreshFactor } from '../lib/mfa';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import {
  confirmEndpoint,
  createEndpoint,
  deleteEndpoint,
  getDelivery,
  listDeliveries,
  listEndpoints,
  redriveDelivery,
  redriveFailedSince,
  repointsEndpoint,
  requireEndpoint,
  rotateSecret,
  sendTest,
  toWebhookEndpoint,
  updateEndpoint,
  type WebhookActor,
} from '../lib/webhooks';
import { NO_STORE } from '../v2/idempotency';

export const webhooks = createRouter();

const BASE = '/api/v1/workspaces/{workspaceId}/webhooks';
const workspaceParam = idParam('workspaceId', idPattern('workspace'));
const endpointParams = workspaceParam.extend(
  idParam('endpointId', idPattern('webhookEndpoint')).shape,
);
const deliveryParams = endpointParams.extend(
  idParam('deliveryId', idPattern('webhookDelivery')).shape,
);

/** Every webhook route needs the admin role in the workspace. */
async function actorFor(
  c: AppContext,
  workspaceId: string,
): Promise<WebhookActor & { operatorId: string; auth: AuthContext }> {
  const { auth } = await requireWorkspace(c, workspaceId, 'admin');
  return {
    workspaceId,
    operatorId: auth.operatorId,
    principalId: null,
    principalKind: null,
    email: auth.email,
    channelIds: null,
    ipPrefix: ipPrefix(clientIp(c)),
    auth,
  };
}

/** A new target for the workspace's data: a fresh check with a factor of the operator's own. */
async function requireFeedStepUp(c: AppContext, auth: AuthContext): Promise<void> {
  requireFreshFactor(auth, await loadFactors(env(c), auth.operatorId));
}

const STEP_UP =
  'Needs a second factor of your own proved in the last 10 minutes (403 `secondFactor: step_up_required`, or `factor_required` without one); the other owners and admins are emailed with the URL.';

const tags = ['Webhooks'];

webhooks.openapi(
  createRoute({
    method: 'get',
    path: BASE,
    tags,
    summary: 'Webhook endpoints',
    request: { params: workspaceParam },
    responses: {
      200: ok(z.array(WebhookEndpointSchema), 'Endpoints'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    return c.json({ data: await listEndpoints(c, await actorFor(c, workspaceId)) }, 200);
  },
);

webhooks.openapi(
  createRoute({
    method: 'post',
    path: BASE,
    tags,
    summary: 'Add a webhook endpoint',
    description: `Returns the signing secret once. URLs must be https (http only in development) and use a public host name: IP addresses and private hosts are refused. The plan sets how many endpoints a workspace may have. ${STEP_UP} The endpoint runs while you keep the admin role here.`,
    request: { params: workspaceParam, body: jsonBody(CreateWebhookEndpointSchema) },
    responses: {
      201: ok(WebhookEndpointWithSecretSchema, 'Created, with the secret'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const actor = await actorFor(c, workspaceId);
    await requireFeedStepUp(c, actor.auth);
    return c.json({ data: await createEndpoint(c, actor, c.req.valid('json')) }, 201, NO_STORE);
  },
);

webhooks.openapi(
  createRoute({
    method: 'get',
    path: `${BASE}/{endpointId}`,
    tags,
    summary: 'A webhook endpoint',
    request: { params: endpointParams },
    responses: {
      200: ok(WebhookEndpointSchema, 'Endpoint'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, endpointId } = c.req.valid('param');
    const actor = await actorFor(c, workspaceId);
    return c.json({ data: toWebhookEndpoint(await requireEndpoint(c, actor, endpointId)) }, 200);
  },
);

webhooks.openapi(
  createRoute({
    method: 'patch',
    path: `${BASE}/{endpointId}`,
    tags,
    summary: 'Change, pause or resume a webhook endpoint',
    description: `Resuming an endpoint that was turned off after failing clears its failures. Events that happen while an endpoint is paused are not sent to it. Changing its URL or publication is like adding it: ${STEP_UP}`,
    request: { params: endpointParams, body: jsonBody(UpdateWebhookEndpointSchema) },
    responses: {
      200: ok(WebhookEndpointSchema, 'Updated'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, endpointId } = c.req.valid('param');
    const actor = await actorFor(c, workspaceId);
    const input = c.req.valid('json');
    if (repointsEndpoint(await requireEndpoint(c, actor, endpointId), input)) {
      await requireFeedStepUp(c, actor.auth);
    }
    return c.json({ data: await updateEndpoint(c, actor, endpointId, input) }, 200);
  },
);

webhooks.openapi(
  createRoute({
    method: 'post',
    path: `${BASE}/{endpointId}/confirm`,
    tags,
    summary: 'Confirm or adopt a webhook endpoint',
    description: `An endpoint an API key or app proposed through /v2 receives nothing until an admin confirms it, and one whose admin no longer has the role stops until an admin adopts it. Either way it then runs on your authority. ${STEP_UP}`,
    request: { params: endpointParams },
    responses: {
      200: ok(WebhookEndpointSchema, 'Confirmed'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, endpointId } = c.req.valid('param');
    const actor = await actorFor(c, workspaceId);
    await requireFeedStepUp(c, actor.auth);
    return c.json({ data: await confirmEndpoint(c, actor, endpointId) }, 200);
  },
);

webhooks.openapi(
  createRoute({
    method: 'delete',
    path: `${BASE}/{endpointId}`,
    tags,
    summary: 'Delete a webhook endpoint',
    description: 'Its delivery log goes with it.',
    request: { params: endpointParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { workspaceId, endpointId } = c.req.valid('param');
    await deleteEndpoint(c, await actorFor(c, workspaceId), endpointId);
    return c.body(null, 204);
  },
);

webhooks.openapi(
  createRoute({
    method: 'post',
    path: `${BASE}/{endpointId}/rotate-secret`,
    tags,
    summary: 'Rotate the signing secret',
    description:
      'Returns the new secret once. For 24 hours requests carry two v1= signatures, one per secret, so receivers can switch without dropping events.',
    request: { params: endpointParams },
    responses: {
      200: ok(WebhookEndpointWithSecretSchema, 'Rotated, with the new secret'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, endpointId } = c.req.valid('param');
    return c.json(
      { data: await rotateSecret(c, await actorFor(c, workspaceId), endpointId) },
      200,
      NO_STORE,
    );
  },
);

webhooks.openapi(
  createRoute({
    method: 'post',
    path: `${BASE}/{endpointId}/test`,
    tags,
    summary: 'Send a test event',
    description:
      'Queues one event with sample data (the endpoint’s first event type unless `type` is given). Test events are sent whatever the endpoint’s status and never count towards turning it off.',
    request: { params: endpointParams, body: jsonBody(SendTestWebhookSchema) },
    responses: {
      202: ok(WebhookDeliverySchema, 'Queued'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, endpointId } = c.req.valid('param');
    const actor = await actorFor(c, workspaceId);
    return c.json({ data: await sendTest(c, actor, endpointId, c.req.valid('json').type) }, 202);
  },
);

webhooks.openapi(
  createRoute({
    method: 'get',
    path: `${BASE}/{endpointId}/deliveries`,
    tags,
    summary: 'The delivery log of an endpoint',
    description: 'Newest first. Finished deliveries are kept for 30 days.',
    request: { params: endpointParams, query: WebhookDeliveriesQuerySchema },
    responses: {
      200: ok(page(WebhookDeliverySchema), 'Deliveries'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, endpointId } = c.req.valid('param');
    const actor = await actorFor(c, workspaceId);
    return c.json({ data: await listDeliveries(c, actor, endpointId, c.req.valid('query')) }, 200);
  },
);

webhooks.openapi(
  createRoute({
    method: 'get',
    path: `${BASE}/{endpointId}/deliveries/{deliveryId}`,
    tags,
    summary: 'One delivery: payload, headers, response and attempts',
    request: { params: deliveryParams },
    responses: {
      200: ok(WebhookDeliveryDetailSchema, 'Delivery'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, endpointId, deliveryId } = c.req.valid('param');
    const actor = await actorFor(c, workspaceId);
    return c.json({ data: await getDelivery(c, actor, endpointId, deliveryId) }, 200);
  },
);

webhooks.openapi(
  createRoute({
    method: 'post',
    path: `${BASE}/{endpointId}/deliveries/{deliveryId}/redrive`,
    tags,
    summary: 'Send a delivery again',
    description:
      'Same event id and body, with a fresh set of retries. A delivery that is already waiting to be sent is left as it is.',
    request: { params: deliveryParams },
    responses: {
      202: ok(WebhookDeliverySchema, 'Queued (or already queued)'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId, endpointId, deliveryId } = c.req.valid('param');
    const actor = await actorFor(c, workspaceId);
    return c.json({ data: await redriveDelivery(c, actor, endpointId, deliveryId) }, 202);
  },
);

webhooks.openapi(
  createRoute({
    method: 'post',
    path: `${BASE}/{endpointId}/redrive`,
    tags,
    summary: 'Send every failed delivery since a time again',
    description:
      'Failed and canceled deliveries created at or after `since`, up to 1,000 per call.',
    request: { params: endpointParams, body: jsonBody(RedriveWebhookDeliveriesSchema) },
    responses: {
      202: ok(RedriveResultSchema, 'Queued'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId, endpointId } = c.req.valid('param');
    const actor = await actorFor(c, workspaceId);
    return c.json(
      { data: await redriveFailedSince(c, actor, endpointId, c.req.valid('json').since) },
      202,
    );
  },
);
