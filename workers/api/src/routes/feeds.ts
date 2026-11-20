// Feed Sync (Phase 8, flag feed_sync): the feeds a Channel follows, their items, "Check now" and
// the preview of the next Dispatch. Viewers read; editors and above change (a feed in send mode
// sends Dispatches). The same operations are on /v2 (v2/feeds.ts); both call lib/feeds.ts.
// Contract: docs/feed-sync.md.
import { createRoute, z } from '@hono/zod-openapi';
import {
  CreateFeedSourceSchema,
  FeedCheckResultSchema,
  FeedItemSchema,
  FeedItemsQuerySchema,
  FeedPreviewSchema,
  FeedSourceSchema,
  UpdateFeedSourceSchema,
  idPattern,
  type SeatRole,
} from '@swarm/domain';
import { requireChannel } from '../lib/access';
import { sessionActor, type Actor } from '../lib/actor';
import { createRouter, type AppContext } from '../lib/context';
import {
  checkSource,
  createSource,
  deleteSource,
  getSource,
  listItems,
  listSources,
  previewSource,
  requireFeedSync,
  updateSource,
} from '../lib/feeds';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';

export const feeds = createRouter();

const BASE = '/api/v1/channels/{channelId}/feed-sources';
const channelParam = idParam('channelId', idPattern('channel'));
const sourceParams = channelParam.extend(idParam('feedSourceId', idPattern('feedSource')).shape);
const tags = ['Feed Sync'];
const FLAG = 'Needs the feed_sync flag.';

/** The tenancy check, the role and the flag, in that order. */
async function access(c: AppContext, channelId: string, role: SeatRole): Promise<Actor> {
  const result = await requireChannel(c, channelId, role);
  await requireFeedSync(c, result);
  return sessionActor(c, result);
}

feeds.openapi(
  createRoute({
    method: 'get',
    path: BASE,
    tags,
    summary: 'Feeds a Channel follows',
    description: `Viewer role. ${FLAG}`,
    request: { params: channelParam },
    responses: {
      200: ok(z.array(FeedSourceSchema), 'Feed sources'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await access(c, channelId, 'viewer');
    return c.json({ data: await listSources(c, channelId) }, 200);
  },
);

feeds.openapi(
  createRoute({
    method: 'post',
    path: BASE,
    tags,
    summary: 'Follow a feed',
    description: `Editor role. ${FLAG} The URL must be https with a public host name. The first check runs within a minute (or use check now); items already in the feed then are skipped, so only new ones become Dispatches. A Channel follows at most 20 feeds.`,
    request: { params: channelParam, body: jsonBody(CreateFeedSourceSchema) },
    responses: {
      201: ok(FeedSourceSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const actor = await access(c, channelId, 'editor');
    return c.json({ data: await createSource(c, actor, channelId, c.req.valid('json')) }, 201);
  },
);

feeds.openapi(
  createRoute({
    method: 'get',
    path: `${BASE}/{feedSourceId}`,
    tags,
    summary: 'A feed source',
    description: `Viewer role. ${FLAG}`,
    request: { params: sourceParams },
    responses: {
      200: ok(FeedSourceSchema, 'Feed source'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, feedSourceId } = c.req.valid('param');
    await access(c, channelId, 'viewer');
    return c.json({ data: await getSource(c, channelId, feedSourceId) }, 200);
  },
);

feeds.openapi(
  createRoute({
    method: 'patch',
    path: `${BASE}/{feedSourceId}`,
    tags,
    summary: 'Change, pause or resume a feed source',
    description: `Editor role. ${FLAG} Resuming clears failures and checks within a minute. A new URL is a new feed: its first check skips the items already there.`,
    request: { params: sourceParams, body: jsonBody(UpdateFeedSourceSchema) },
    responses: {
      200: ok(FeedSourceSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, feedSourceId } = c.req.valid('param');
    const actor = await access(c, channelId, 'editor');
    const saved = await updateSource(c, actor, channelId, feedSourceId, c.req.valid('json'));
    return c.json({ data: saved }, 200);
  },
);

feeds.openapi(
  createRoute({
    method: 'delete',
    path: `${BASE}/{feedSourceId}`,
    tags,
    summary: 'Stop following a feed',
    description: `Editor role. ${FLAG} Its items go with it; the Dispatches it made stay.`,
    request: { params: sourceParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { channelId, feedSourceId } = c.req.valid('param');
    const actor = await access(c, channelId, 'editor');
    await deleteSource(c, actor, channelId, feedSourceId);
    return c.body(null, 204);
  },
);

feeds.openapi(
  createRoute({
    method: 'post',
    path: `${BASE}/{feedSourceId}/check`,
    tags,
    summary: 'Check a feed now',
    description: `Editor role. ${FLAG} Fetches the feed in this request, stores new items and makes the Dispatch its caps allow. Works for paused and turned-off sources too (their items wait). A success turns a \`draft\` source that was turned off after failures back on; a turned-off \`send\` source stays off and answers \`resumeRequired: true\` until someone resumes it. A failed fetch answers 200 with the error.`,
    request: { params: sourceParams },
    responses: {
      200: ok(FeedCheckResultSchema, 'Checked'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, feedSourceId } = c.req.valid('param');
    const actor = await access(c, channelId, 'editor');
    return c.json({ data: await checkSource(c, actor, channelId, feedSourceId) }, 200);
  },
);

feeds.openapi(
  createRoute({
    method: 'get',
    path: `${BASE}/{feedSourceId}/items`,
    tags,
    summary: 'Items seen in a feed, newest first',
    description: `Viewer role. ${FLAG} At most 100.`,
    request: { params: sourceParams, query: FeedItemsQuerySchema },
    responses: {
      200: ok(z.array(FeedItemSchema), 'Items'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, feedSourceId } = c.req.valid('param');
    await access(c, channelId, 'viewer');
    const { status } = c.req.valid('query');
    return c.json({ data: await listItems(c, channelId, feedSourceId, status) }, 200);
  },
);

feeds.openapi(
  createRoute({
    method: 'get',
    path: `${BASE}/{feedSourceId}/preview`,
    tags,
    summary: 'Preview the next Dispatch',
    description: `Viewer role. ${FLAG} Renders what the next release would make, changing nothing. With nothing waiting it uses the newest item (sample: true); with no items yet it answers 409.`,
    request: { params: sourceParams },
    responses: {
      200: ok(FeedPreviewSchema, 'Preview'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, feedSourceId } = c.req.valid('param');
    await access(c, channelId, 'viewer');
    return c.json({ data: await previewSource(c, channelId, feedSourceId) }, 200);
  },
);
