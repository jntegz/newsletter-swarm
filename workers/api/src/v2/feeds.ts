// /v2 Feed Sync (Phase 8, flag feed_sync): the dashboard's feed source operations for API keys
// and OAuth tokens. What Feed Sync makes is Dispatches, so it uses their scopes: reads need
// dispatches:read, changes and checks dispatches:write. Implementation: lib/feeds.ts.
import { z } from '@hono/zod-openapi';
import {
  CreateFeedSourceSchema,
  FeedCheckResultSchema,
  FeedItemSchema,
  FeedItemsQuerySchema,
  FeedSourceSchema,
  UpdateFeedSourceSchema,
  idPattern,
} from '@swarm/domain';
import { apiActor, type Actor } from '../lib/actor';
import { createRouter, type AppContext } from '../lib/context';
import {
  checkSource,
  createSource,
  deleteSource,
  getSource,
  listItems,
  listSources,
  requireFeedSync,
  updateSource,
} from '../lib/feeds';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { guard, v2Route } from './route';

export const v2Feeds = createRouter();

const PATH = '/v2/channels/{channelId}/feed-sources';
const channelParam = idParam('channelId', idPattern('channel'));
const sourceParams = channelParam.extend(idParam('feedSourceId', idPattern('feedSource')).shape);
const tags = ['Feed Sync'];

/** The principal as an actor, once the route's scope, the Channel and the flag are checked. */
async function actorFor(
  c: AppContext,
  route: Parameters<typeof guard>[1],
  channelId: string,
): Promise<Actor> {
  const principal = await guard(c, route);
  await requireFeedSync(c, { workspaceId: principal.workspaceId, channelId });
  return apiActor(c, principal);
}

const listRoute = v2Route('dispatches:read', {
  method: 'get',
  path: PATH,
  operationId: 'listFeedSources',
  tags,
  summary: 'Feeds a Channel follows',
  description: 'Needs the feed_sync flag on the Channel.',
  request: { params: channelParam },
  responses: { 200: ok(z.array(FeedSourceSchema), 'Feed sources'), ...errors('not_found') },
});
v2Feeds.openapi(listRoute, async (c) => {
  const { channelId } = c.req.valid('param');
  await actorFor(c, listRoute, channelId);
  return c.json({ data: await listSources(c, channelId) }, 200);
});

const createRouteDef = v2Route('dispatches:write', {
  method: 'post',
  path: PATH,
  operationId: 'createFeedSource',
  tags,
  summary: 'Follow a feed',
  description:
    'An https feed URL with a public host name. Items already in the feed at the first check are skipped; only new ones become Dispatches. At most 20 per Channel.',
  request: { params: channelParam, body: jsonBody(CreateFeedSourceSchema) },
  responses: {
    201: ok(FeedSourceSchema, 'Created'),
    ...errors('invalid_input', 'not_found', 'conflict'),
  },
});
v2Feeds.openapi(createRouteDef, async (c) => {
  const { channelId } = c.req.valid('param');
  const actor = await actorFor(c, createRouteDef, channelId);
  return c.json({ data: await createSource(c, actor, channelId, c.req.valid('json')) }, 201);
});

const getRoute = v2Route('dispatches:read', {
  method: 'get',
  path: `${PATH}/{feedSourceId}`,
  operationId: 'getFeedSource',
  tags,
  summary: 'A feed source',
  request: { params: sourceParams },
  responses: { 200: ok(FeedSourceSchema, 'Feed source'), ...errors('not_found') },
});
v2Feeds.openapi(getRoute, async (c) => {
  const { channelId, feedSourceId } = c.req.valid('param');
  await actorFor(c, getRoute, channelId);
  return c.json({ data: await getSource(c, channelId, feedSourceId) }, 200);
});

const updateRoute = v2Route('dispatches:write', {
  method: 'patch',
  path: `${PATH}/{feedSourceId}`,
  operationId: 'updateFeedSource',
  tags,
  summary: 'Change, pause or resume a feed source',
  request: { params: sourceParams, body: jsonBody(UpdateFeedSourceSchema) },
  responses: {
    200: ok(FeedSourceSchema, 'Saved'),
    ...errors('invalid_input', 'not_found', 'conflict'),
  },
});
v2Feeds.openapi(updateRoute, async (c) => {
  const { channelId, feedSourceId } = c.req.valid('param');
  const actor = await actorFor(c, updateRoute, channelId);
  const saved = await updateSource(c, actor, channelId, feedSourceId, c.req.valid('json'));
  return c.json({ data: saved }, 200);
});

const deleteRoute = v2Route('dispatches:write', {
  method: 'delete',
  path: `${PATH}/{feedSourceId}`,
  operationId: 'deleteFeedSource',
  tags,
  summary: 'Stop following a feed',
  description: 'Its items go with it; the Dispatches it made stay.',
  request: { params: sourceParams },
  responses: { 204: noContent, ...errors('not_found') },
});
v2Feeds.openapi(deleteRoute, async (c) => {
  const { channelId, feedSourceId } = c.req.valid('param');
  const actor = await actorFor(c, deleteRoute, channelId);
  await deleteSource(c, actor, channelId, feedSourceId);
  return c.body(null, 204);
});

const checkRoute = v2Route('dispatches:write', {
  method: 'post',
  path: `${PATH}/{feedSourceId}/check`,
  operationId: 'checkFeedSource',
  tags,
  summary: 'Check a feed now',
  description:
    'Fetches the feed in this request, stores new items and makes the Dispatch its caps allow (an active `send` source schedules it to go out). Works on paused and turned-off sources too, without sending from them: a turned-off `draft` source that fetches is turned back on; a turned-off `send` source stays off and answers `resumeRequired: true`, and only resuming it (update with status active, which approval holds for agents) lets it send again. A failed fetch answers 200 with the error.',
  request: { params: sourceParams },
  responses: { 200: ok(FeedCheckResultSchema, 'Checked'), ...errors('not_found', 'conflict') },
});
v2Feeds.openapi(checkRoute, async (c) => {
  const { channelId, feedSourceId } = c.req.valid('param');
  const actor = await actorFor(c, checkRoute, channelId);
  return c.json({ data: await checkSource(c, actor, channelId, feedSourceId) }, 200);
});

const itemsRoute = v2Route('dispatches:read', {
  method: 'get',
  path: `${PATH}/{feedSourceId}/items`,
  operationId: 'listFeedItems',
  tags,
  summary: 'Items seen in a feed, newest first',
  description: 'At most 100.',
  request: { params: sourceParams, query: FeedItemsQuerySchema },
  responses: {
    200: ok(z.array(FeedItemSchema), 'Items'),
    ...errors('invalid_input', 'not_found'),
  },
});
v2Feeds.openapi(itemsRoute, async (c) => {
  const { channelId, feedSourceId } = c.req.valid('param');
  await actorFor(c, itemsRoute, channelId);
  const { status } = c.req.valid('query');
  return c.json({ data: await listItems(c, channelId, feedSourceId, status) }, 200);
});
