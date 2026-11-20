// Members: list and search, detail with profile fields, activity timeline, add, edit (with the
// member state machine), delete and counts. The writes live in lib/members.ts, shared with /v2.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, toIso } from '@swarm/db';
import {
  ACTIVITY_LIMIT,
  CreateMemberSchema,
  EngagementSummarySchema,
  MEMBER_STATUSES,
  MemberActivitySchema,
  MemberCountsSchema,
  MemberDetailSchema,
  MemberFlowHistorySchema,
  MemberListFieldsQuerySchema,
  MemberListItemSchema,
  MemberPatchSchema,
  idPattern,
  page,
  type MemberActivity,
  type MemberCounts,
  type MemberStatus,
} from '@swarm/domain';
import { engagementEnabled, engagementSummary, memberFlowHistory } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { sessionActor } from '../lib/actor';
import { createRouter, env } from '../lib/context';
import {
  createMember,
  deleteMember,
  listMembers,
  memberDetail,
  updateMember,
  withFieldColumns,
} from '../lib/members';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { requireOwned } from '../lib/send';

export const members = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const memberParam = idParam('memberId', idPattern('member'));

members.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/members',
    tags: ['Members'],
    summary: 'Members of a Channel, newest first',
    description:
      'Filter by status, tag name or Circle (`circle`, as of its last refresh), and search email, first and last name with `q`. `fields` adds profile field columns: each Member then carries those values (encrypted fields decrypted, as on the Member detail). An unknown key answers 400.',
    request: { params: channelParam, query: MemberListFieldsQuerySchema },
    responses: {
      200: ok(page(MemberListItemSchema), 'Members'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { fields, ...query } = c.req.valid('query');
    await requireChannel(c, channelId, 'viewer');
    const result = await listMembers(c, channelId, query);
    if (!fields) return c.json({ data: result }, 200);
    return c.json({ data: await withFieldColumns(c, channelId, result, fields) }, 200);
  },
);

members.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/members/counts',
    tags: ['Members'],
    summary: 'Member counts by status',
    request: { params: channelParam },
    responses: { 200: ok(MemberCountsSchema, 'Counts'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const rows = await all<{ status: MemberStatus; n: number }>(
      env(c).DB,
      'SELECT status, count(*) AS n FROM members WHERE channel_id = ?1 GROUP BY status',
      channelId,
    );
    const counts = Object.fromEntries(MEMBER_STATUSES.map((s) => [s, 0])) as MemberCounts;
    for (const row of rows) counts[row.status] = row.n;
    return c.json({ data: counts }, 200);
  },
);

members.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/members/engagement',
    tags: ['Members'],
    summary: 'How many Members are in each engagement band',
    description:
      'From the daily engagement score, which counts human opens and clicks only. Answers 404 feature_disabled while the score is off.',
    request: { params: channelParam },
    responses: {
      200: ok(EngagementSummarySchema, 'Bands'),
      ...errors('unauthorized', 'not_found', 'feature_disabled'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const db = env(c).DB;
    if (!(await engagementEnabled(db, channelId))) {
      throw new ApiError('feature_disabled', 'Engagement scores are off for this publication.');
    }
    return c.json({ data: await engagementSummary(db, channelId) }, 200);
  },
);

members.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/members',
    tags: ['Members'],
    summary: 'Add a Member',
    description:
      'With `consent: true` (the person asked to receive this Channel) the Member starts active. Otherwise they start pending and receive nothing until they confirm. Tags are given by name and created when missing; profile fields by key. An address erased through the Privacy Center is refused (409).',
    request: { params: channelParam, body: jsonBody(CreateMemberSchema) },
    responses: {
      201: ok(MemberDetailSchema, 'Added'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    const id = await createMember(c, sessionActor(c, access), channelId, input, 'operator');
    return c.json({ data: await memberDetail(c, id) }, 201);
  },
);

members.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/members/{memberId}',
    tags: ['Members'],
    summary: 'A Member with profile fields, attribution and referrals',
    description: 'Encrypted profile fields are returned decrypted to teammates with access.',
    request: { params: memberParam },
    responses: { 200: ok(MemberDetailSchema, 'Member'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { memberId } = c.req.valid('param');
    await requireOwned(c, 'member', memberId, 'viewer');
    return c.json({ data: await memberDetail(c, memberId) }, 200);
  },
);

interface ActivityRow {
  id: string;
  broadcast_id: string;
  subject: string;
  sent_at: number;
  opened_at: number | null;
  human_opened_at: number | null;
  bounced_at: number | null;
  complained_at: number | null;
  unsubscribed_at: number | null;
}

members.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/members/{memberId}/activity',
    tags: ['Members'],
    summary: 'A Member’s timeline, newest first',
    description: `Deliveries, first opens, human clicks, bounces, complaints, unsubscribes and how they joined. The latest ${ACTIVITY_LIMIT} entries.`,
    request: { params: memberParam },
    responses: {
      200: ok(z.array(MemberActivitySchema), 'Activity'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { memberId } = c.req.valid('param');
    await requireOwned(c, 'member', memberId, 'viewer');
    const db = env(c).DB;
    const member = await first<{
      created_at: number;
      form_id: string | null;
      import_id: string | null;
    }>(db, 'SELECT created_at, form_id, import_id FROM members WHERE id = ?1', memberId);
    const deliveries = await all<ActivityRow>(
      db,
      `SELECT d.id, d.broadcast_id, b.subject, d.sent_at, d.opened_at, d.human_opened_at,
              d.bounced_at, d.complained_at, d.unsubscribed_at
         FROM deliveries d JOIN broadcasts b ON b.id = d.broadcast_id
        WHERE d.member_id = ?1 ORDER BY d.sent_at DESC LIMIT ?2`,
      memberId,
      ACTIVITY_LIMIT,
    );
    const clicks = deliveries.length
      ? await all<{ delivery_id: string; created_at: number; url: string }>(
          db,
          `SELECT c.delivery_id, c.created_at, lt.url FROM clicks c JOIN link_targets lt ON lt.id = c.link_target_id
            WHERE c.delivery_id IN (SELECT value FROM json_each(?1)) AND c.classification = 'human'
            ORDER BY c.created_at DESC LIMIT ?2`,
          JSON.stringify(deliveries.map((d) => d.id)),
          ACTIVITY_LIMIT,
        )
      : [];

    // Every time they sent a signup form, joining or not.
    const forms = await all<{ created_at: number; form_id: string | null; created: number | null }>(
      db,
      `SELECT created_at, json_extract(payload_json, '$.formId') AS form_id,
              json_extract(payload_json, '$.created') AS created
         FROM member_events WHERE member_id = ?1 AND type = 'form_submitted'
        ORDER BY seq DESC LIMIT ?2`,
      memberId,
      ACTIVITY_LIMIT,
    );
    const formIds = [
      ...new Set([member?.form_id, ...forms.map((f) => f.form_id)].filter((f) => f !== null)),
    ];
    const formNames = new Map(
      (
        await all<{ id: string; name: string }>(
          db,
          'SELECT id, name FROM capture_forms WHERE id IN (SELECT value FROM json_each(?1))',
          JSON.stringify(formIds),
        )
      ).map((f) => [f.id, f.name]),
    );
    const named = (formId: string | null | undefined) => ({
      formId: formId ?? null,
      formName: (formId && formNames.get(formId)) ?? null,
    });

    const items: (MemberActivity & { ms: number })[] = [];
    const push = (
      type: MemberActivity['type'],
      ms: number | null,
      extra: Partial<MemberActivity> = {},
    ) => {
      if (ms === null) return;
      items.push({
        type,
        ms,
        at: toIso(ms),
        broadcastId: null,
        subject: null,
        url: null,
        formId: null,
        formName: null,
        importId: null,
        ...extra,
      });
    };
    const bySubject = new Map(deliveries.map((d) => [d.id, d]));
    for (const d of deliveries) {
      const ref = { broadcastId: d.broadcast_id, subject: d.subject };
      push('delivery', d.sent_at, ref);
      push('open', d.human_opened_at ?? d.opened_at, ref);
      push('bounce', d.bounced_at, ref);
      push('complaint', d.complained_at, ref);
      push('unsubscribe', d.unsubscribed_at, ref);
    }
    for (const click of clicks) {
      const d = bySubject.get(click.delivery_id);
      push('click', click.created_at, {
        broadcastId: d?.broadcast_id ?? null,
        subject: d?.subject ?? null,
        url: click.url,
      });
    }
    if (member) {
      push('joined', member.created_at, { ...named(member.form_id), importId: member.import_id });
    }
    // The submission that created them is the "joined" entry above; later ones stand alone.
    for (const form of forms) {
      if (form.created !== 1) push('form', form.created_at, named(form.form_id));
    }
    items.sort((a, b) => b.ms - a.ms);
    return c.json(
      { data: items.slice(0, ACTIVITY_LIMIT).map(({ ms: _ms, ...item }) => item) },
      200,
    );
  },
);

members.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/members/{memberId}/flows',
    tags: ['Members'],
    summary: 'Every live Flow of the Channel, and this Member’s history with it',
    description:
      'For each live Flow: the Member’s latest run with its trigger and emails, and the latest start event that did not let them in. Only the latest of each is kept. Both are null when no start event has been recorded for them.',
    request: { params: memberParam },
    responses: {
      200: ok(z.array(MemberFlowHistorySchema), 'Flows'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { memberId } = c.req.valid('param');
    const access = await requireOwned(c, 'member', memberId, 'viewer');
    return c.json({ data: await memberFlowHistory(env(c).DB, access.channelId, memberId) }, 200);
  },
);

members.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/members/{memberId}',
    tags: ['Members'],
    summary: 'Edit a Member',
    description:
      'Teammates can pause (until `pausedUntil`, four weeks by default), resume or unsubscribe a Member. They can’t confirm a pending Member, bring back an unsubscribed one, or change a bounced or complained one: those answer 409.',
    request: { params: memberParam, body: jsonBody(MemberPatchSchema) },
    responses: {
      200: ok(MemberDetailSchema, 'Updated'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { memberId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireOwned(c, 'member', memberId, 'editor');
    await updateMember(c, sessionActor(c, access), memberId, input);
    return c.json({ data: await memberDetail(c, memberId) }, 200);
  },
);

members.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/members/{memberId}',
    tags: ['Members'],
    summary: 'Delete a Member',
    description:
      'Removes the Member. Their address is erased from delivery history, which keeps only counts and engagement.',
    request: { params: memberParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { memberId } = c.req.valid('param');
    const access = await requireOwned(c, 'member', memberId, 'editor');
    await deleteMember(c, sessionActor(c, access), memberId, access.channelId);
    return c.body(null, 204);
  },
);
