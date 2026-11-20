// Rosters (Phase 8, flag rosters): opt-in lists inside a Channel. Viewers read, editors change.
// Every route answers feature_disabled (404) while the flag is off. Implementation:
// lib/rosters.ts, shared with /v2. Contract: docs/rosters.md.
import { createRoute } from '@hono/zod-openapi';
import { first } from '@swarm/db';
import {
  CreateRosterSchema,
  MemberRostersSchema,
  RosterAudienceSchema,
  RosterListSchema,
  RosterMemberSchema,
  RosterMembersQuerySchema,
  RosterOverlapSchema,
  RosterSchema,
  SetRosterMembershipSchema,
  UpdateRosterSchema,
  idPattern,
  page,
} from '@swarm/domain';
import { memberRosters, rosterOverlap } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { sessionActor } from '../lib/actor';
import { createRouter, env, type AppContext } from '../lib/context';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import {
  createRoster,
  deleteRoster,
  listRosters,
  requireRoster,
  requireRosters,
  rosterMembers,
  setMembership,
  updateRoster,
} from '../lib/rosters';

export const rosters = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const rosterParams = channelParam.extend(idParam('rosterId', idPattern('roster')).shape);
const memberParams = channelParam.extend(idParam('memberId', idPattern('member')).shape);
const membershipParams = memberParams.extend(idParam('rosterId', idPattern('roster')).shape);
const TAG = ['Rosters'];
const FLAG = 'Needs the rosters flag.';

async function access(c: AppContext, channelId: string, role: 'viewer' | 'editor') {
  const result = await requireChannel(c, channelId, role);
  await requireRosters(c, result);
  return result;
}

async function requireMemberIn(db: D1Database, channelId: string, memberId: string) {
  const row = await first(
    db,
    'SELECT 1 FROM members WHERE id = ?1 AND channel_id = ?2',
    memberId,
    channelId,
  );
  if (!row) throw new ApiError('not_found', 'Subscriber not found.');
}

rosters.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/rosters',
    tags: TAG,
    summary: 'Rosters of a Channel, by name, with how many Members are on each',
    description: FLAG,
    request: { params: channelParam },
    responses: { 200: ok(RosterListSchema, 'Rosters'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await access(c, channelId, 'viewer');
    return c.json({ data: { items: await listRosters(env(c).DB, channelId) } }, 200);
  },
);

rosters.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/rosters',
    tags: TAG,
    summary: 'Create a Roster',
    description: `Editor role. ${FLAG} Names are unique per Channel, ignoring case; at most 100 Rosters.`,
    request: { params: channelParam, body: jsonBody(CreateRosterSchema) },
    responses: {
      201: ok(RosterSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const result = await access(c, channelId, 'editor');
    const roster = await createRoster(
      env(c).DB,
      sessionActor(c, result),
      channelId,
      c.req.valid('json'),
    );
    return c.json({ data: roster }, 201);
  },
);

rosters.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/rosters/overlap',
    tags: TAG,
    summary: 'Counts for the Roster part of an audience',
    description: `${FLAG} Among active, unsuppressed Members right now: subscribed to an included Roster, to an excluded one, to both (the conflicts the policy decides), and who the Roster part lets through. Changes nothing.`,
    request: { params: channelParam, body: jsonBody(RosterAudienceSchema) },
    responses: {
      200: ok(RosterOverlapSchema, 'Counts'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const result = await access(c, channelId, 'viewer');
    const counts = await rosterOverlap(
      env(c).DB,
      channelId,
      result.workspaceId,
      c.req.valid('json'),
    );
    return c.json({ data: counts }, 200);
  },
);

rosters.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/rosters/{rosterId}',
    tags: TAG,
    summary: 'One Roster',
    description: FLAG,
    request: { params: rosterParams },
    responses: { 200: ok(RosterSchema, 'Roster'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId, rosterId } = c.req.valid('param');
    await access(c, channelId, 'viewer');
    return c.json({ data: await requireRoster(env(c).DB, channelId, rosterId) }, 200);
  },
);

rosters.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/channels/{channelId}/rosters/{rosterId}',
    tags: TAG,
    summary: 'Rename or describe a Roster, or show or hide it in the Member Center',
    description: `Editor role. ${FLAG}`,
    request: { params: rosterParams, body: jsonBody(UpdateRosterSchema) },
    responses: {
      200: ok(RosterSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, rosterId } = c.req.valid('param');
    const result = await access(c, channelId, 'editor');
    const roster = await updateRoster(
      env(c).DB,
      sessionActor(c, result),
      channelId,
      rosterId,
      c.req.valid('json'),
    );
    return c.json({ data: roster }, 200);
  },
);

rosters.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}/rosters/{rosterId}',
    tags: TAG,
    summary: 'Delete a Roster',
    description: `Editor role. ${FLAG} A Broadcast already sending to it finishes; Dispatches that still name it fail preflight until their audience is chosen again.`,
    request: { params: rosterParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { channelId, rosterId } = c.req.valid('param');
    const result = await access(c, channelId, 'editor');
    await deleteRoster(env(c).DB, sessionActor(c, result), channelId, rosterId);
    return c.body(null, 204);
  },
);

rosters.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/rosters/{rosterId}/members',
    tags: TAG,
    summary: 'Who is on a Roster, most recently changed first',
    description: `${FLAG} \`status\` filters to subscribed or unsubscribed; \`cursor\` is the previous page's nextCursor.`,
    request: { params: rosterParams, query: RosterMembersQuerySchema },
    responses: {
      200: ok(page(RosterMemberSchema), 'Memberships'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, rosterId } = c.req.valid('param');
    const { status, cursor, limit } = c.req.valid('query');
    await access(c, channelId, 'viewer');
    const db = env(c).DB;
    await requireRoster(db, channelId, rosterId);
    const { items, next } = await rosterMembers(db, rosterId, { status, after: cursor, limit });
    return c.json({ data: { items, nextCursor: next } }, 200);
  },
);

rosters.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/members/{memberId}/rosters',
    tags: TAG,
    summary: 'A Member’s Rosters',
    description: `${FLAG} Every live Roster the Member has joined, subscribed or not.`,
    request: { params: memberParams },
    responses: { 200: ok(MemberRostersSchema, 'Rosters'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId, memberId } = c.req.valid('param');
    await access(c, channelId, 'viewer');
    const db = env(c).DB;
    await requireMemberIn(db, channelId, memberId);
    return c.json({ data: { items: await memberRosters(db, memberId) } }, 200);
  },
);

rosters.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/channels/{channelId}/members/{memberId}/rosters/{rosterId}',
    tags: TAG,
    summary: 'Subscribe or unsubscribe a Member',
    description: `Editor role. ${FLAG} Idempotent. A Member who left the Roster themselves can't be subscribed again by a teammate (409).`,
    request: { params: membershipParams, body: jsonBody(SetRosterMembershipSchema) },
    responses: {
      200: ok(MemberRostersSchema, 'The Member’s Rosters'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, memberId, rosterId } = c.req.valid('param');
    const result = await access(c, channelId, 'editor');
    const db = env(c).DB;
    await requireMemberIn(db, channelId, memberId);
    await setMembership(
      db,
      sessionActor(c, result),
      channelId,
      rosterId,
      memberId,
      c.req.valid('json').status,
    );
    return c.json({ data: { items: await memberRosters(db, memberId) } }, 200);
  },
);
