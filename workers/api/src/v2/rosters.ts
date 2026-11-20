// /v2 Rosters (Phase 8, flag rosters): the "lists" resource. Reads need rosters:read, changes
// rosters:write. Every route answers feature_disabled (404) while the flag is off for the
// Channel. Implementation: lib/rosters.ts, shared with the dashboard. Contract: docs/rosters.md.
import {
  CreateRosterSchema,
  CursorQuerySchema,
  MemberRostersSchema,
  RosterListSchema,
  RosterMemberSchema,
  RosterSchema,
  RosterStatusSchema,
  UpdateRosterSchema,
  idPattern,
  page,
} from '@swarm/domain';
import { memberRosters } from '@swarm/engine';
import { apiActor } from '../lib/actor';
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
import { decodeCursor, encodeCursor, guard, requireInChannel, v2Route } from './route';

export const v2Rosters = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const rosterParams = channelParam.extend(idParam('rosterId', idPattern('roster')).shape);
const memberParams = channelParam.extend(idParam('memberId', idPattern('member')).shape);
const membershipParams = rosterParams.extend(idParam('memberId', idPattern('member')).shape);
const TAGS = ['Rosters'];
const FLAG = 'Needs the rosters flag on the Channel (404 feature_disabled otherwise).';
const read = errors('not_found');
const write = errors('invalid_input', 'not_found', 'conflict');

/** The principal, after the route's scope and Channel checks, with the flag checked too. */
async function enter(c: AppContext, route: Parameters<typeof guard>[1], channelId: string) {
  const principal = await guard(c, route);
  await requireRosters(c, { workspaceId: principal.workspaceId, channelId });
  return principal;
}

const listRoute = v2Route('rosters:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/rosters',
  operationId: 'listRosters',
  tags: TAGS,
  summary: 'Rosters of a Channel, by name',
  description: FLAG,
  request: { params: channelParam },
  responses: { 200: ok(RosterListSchema, 'Rosters'), ...read },
});
v2Rosters.openapi(listRoute, async (c) => {
  const { channelId } = c.req.valid('param');
  await enter(c, listRoute, channelId);
  return c.json({ data: { items: await listRosters(env(c).DB, channelId) } }, 200);
});

const createRoute = v2Route('rosters:write', {
  method: 'post',
  path: '/v2/channels/{channelId}/rosters',
  operationId: 'createRoster',
  tags: TAGS,
  summary: 'Create a Roster',
  description: `${FLAG} Names are unique per Channel, ignoring case; at most 100 Rosters.`,
  request: { params: channelParam, body: jsonBody(CreateRosterSchema) },
  responses: { 201: ok(RosterSchema, 'Created'), ...write },
});
v2Rosters.openapi(createRoute, async (c) => {
  const { channelId } = c.req.valid('param');
  const principal = await enter(c, createRoute, channelId);
  const roster = await createRoster(
    env(c).DB,
    apiActor(c, principal),
    channelId,
    c.req.valid('json'),
  );
  return c.json({ data: roster }, 201);
});

const getRoute = v2Route('rosters:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/rosters/{rosterId}',
  operationId: 'getRoster',
  tags: TAGS,
  summary: 'One Roster',
  description: FLAG,
  request: { params: rosterParams },
  responses: { 200: ok(RosterSchema, 'Roster'), ...read },
});
v2Rosters.openapi(getRoute, async (c) => {
  const { channelId, rosterId } = c.req.valid('param');
  await enter(c, getRoute, channelId);
  return c.json({ data: await requireRoster(env(c).DB, channelId, rosterId) }, 200);
});

const updateRoute = v2Route('rosters:write', {
  method: 'patch',
  path: '/v2/channels/{channelId}/rosters/{rosterId}',
  operationId: 'updateRoster',
  tags: TAGS,
  summary: 'Rename or describe a Roster, or show or hide it in the Member Center',
  description: FLAG,
  request: { params: rosterParams, body: jsonBody(UpdateRosterSchema) },
  responses: { 200: ok(RosterSchema, 'Saved'), ...write },
});
v2Rosters.openapi(updateRoute, async (c) => {
  const { channelId, rosterId } = c.req.valid('param');
  const principal = await enter(c, updateRoute, channelId);
  const roster = await updateRoster(
    env(c).DB,
    apiActor(c, principal),
    channelId,
    rosterId,
    c.req.valid('json'),
  );
  return c.json({ data: roster }, 200);
});

const deleteRoute = v2Route('rosters:write', {
  method: 'delete',
  path: '/v2/channels/{channelId}/rosters/{rosterId}',
  operationId: 'deleteRoster',
  tags: TAGS,
  summary: 'Delete a Roster',
  description: `${FLAG} A Broadcast already sending to it finishes.`,
  request: { params: rosterParams },
  responses: { 204: noContent, ...read },
});
v2Rosters.openapi(deleteRoute, async (c) => {
  const { channelId, rosterId } = c.req.valid('param');
  const principal = await enter(c, deleteRoute, channelId);
  await deleteRoster(env(c).DB, apiActor(c, principal), channelId, rosterId);
  return c.body(null, 204);
});

const membersQuery = CursorQuerySchema.extend({ status: RosterStatusSchema.optional() });

const membersRoute = v2Route('rosters:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/rosters/{rosterId}/members',
  operationId: 'listRosterMembers',
  tags: TAGS,
  summary: 'Who is on a Roster, most recently changed first',
  description: `${FLAG} \`status\` filters to subscribed or unsubscribed.`,
  request: { params: rosterParams, query: membersQuery },
  responses: {
    200: ok(page(RosterMemberSchema), 'Memberships'),
    ...errors('invalid_input', 'not_found'),
  },
});
v2Rosters.openapi(membersRoute, async (c) => {
  const { channelId, rosterId } = c.req.valid('param');
  const { status, cursor, limit } = c.req.valid('query');
  await enter(c, membersRoute, channelId);
  const db = env(c).DB;
  await requireRoster(db, channelId, rosterId);
  const { items, next } = await rosterMembers(db, rosterId, {
    status,
    after: decodeCursor(cursor),
    limit,
  });
  return c.json({ data: { items, nextCursor: encodeCursor(next) } }, 200);
});

const subscribeRoute = v2Route('rosters:write', {
  method: 'put',
  path: '/v2/channels/{channelId}/rosters/{rosterId}/members/{memberId}',
  operationId: 'subscribeRosterMember',
  tags: TAGS,
  summary: 'Subscribe a Member to a Roster',
  description: `${FLAG} Idempotent. A Member who left the Roster themselves can't be subscribed again (409).`,
  request: { params: membershipParams },
  responses: { 200: ok(MemberRostersSchema, 'The Member’s Rosters'), ...write },
});
v2Rosters.openapi(subscribeRoute, async (c) => {
  const { channelId, rosterId, memberId } = c.req.valid('param');
  const principal = await enter(c, subscribeRoute, channelId);
  await requireInChannel(c, 'members', memberId, channelId);
  const db = env(c).DB;
  await setMembership(db, apiActor(c, principal), channelId, rosterId, memberId, 'subscribed');
  return c.json({ data: { items: await memberRosters(db, memberId) } }, 200);
});

const unsubscribeRoute = v2Route('rosters:write', {
  method: 'delete',
  path: '/v2/channels/{channelId}/rosters/{rosterId}/members/{memberId}',
  operationId: 'unsubscribeRosterMember',
  tags: TAGS,
  summary: 'Unsubscribe a Member from a Roster',
  description: `${FLAG} Idempotent. The Member stays a Member of the Channel.`,
  request: { params: membershipParams },
  responses: { 200: ok(MemberRostersSchema, 'The Member’s Rosters'), ...read },
});
v2Rosters.openapi(unsubscribeRoute, async (c) => {
  const { channelId, rosterId, memberId } = c.req.valid('param');
  const principal = await enter(c, unsubscribeRoute, channelId);
  await requireInChannel(c, 'members', memberId, channelId);
  const db = env(c).DB;
  await setMembership(db, apiActor(c, principal), channelId, rosterId, memberId, 'unsubscribed');
  return c.json({ data: { items: await memberRosters(db, memberId) } }, 200);
});

const memberRoute = v2Route('rosters:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/members/{memberId}/rosters',
  operationId: 'listMemberRosters',
  tags: TAGS,
  summary: 'A Member’s Rosters',
  description: `${FLAG} Every live Roster the Member has joined, subscribed or not.`,
  request: { params: memberParams },
  responses: { 200: ok(MemberRostersSchema, 'Rosters'), ...read },
});
v2Rosters.openapi(memberRoute, async (c) => {
  const { channelId, memberId } = c.req.valid('param');
  await enter(c, memberRoute, channelId);
  await requireInChannel(c, 'members', memberId, channelId);
  return c.json({ data: { items: await memberRosters(env(c).DB, memberId) } }, 200);
});
