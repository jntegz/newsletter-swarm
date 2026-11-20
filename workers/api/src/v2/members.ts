// /v2 Members of a Channel: list, lookup by email, get, create or upsert, edit, unsubscribe,
// delete, tags, profile field values and API events (members:read, members:write, flows:write);
// tags and profile fields (members:read, fields:read); bulk upsert as an import job with its
// dry run and confirm (imports:write). The writes are lib/members.ts and lib/imports.ts, shared
// with the dashboard.
import { z } from '@hono/zod-openapi';
import { all, first } from '@swarm/db';
import {
  ApiAcceptedSchema,
  ApiBulkUpsertSchema,
  ApiFieldValuesSchema,
  ApiMemberEventSchema,
  ApiMemberLookupQuerySchema,
  ApiTagsSchema,
  ApiUpsertMemberSchema,
  EngagementSummarySchema,
  ImportJobSchema,
  MemberDetailSchema,
  MemberFieldSchema,
  MemberListItemSchema,
  MemberListQuerySchema,
  MemberPatchSchema,
  TagSchema,
  idPattern,
  page,
  type ImportTarget,
} from '@swarm/domain';
import {
  FIELD_COLUMNS,
  channelFields,
  engagementEnabled,
  engagementSummary,
  recordMemberEvent,
  type FieldRow,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { apiActor } from '../lib/actor';
import {
  IMPORT_COLUMNS,
  TAG_COLUMNS,
  toImportJob,
  toMemberField,
  toTag,
  type ImportJobRow,
  type TagRow,
} from '../lib/audience';
import { createRouter, env, type AppContext } from '../lib/context';
import { jobsQueue } from '../lib/flows';
import {
  confirmImport,
  createImportJob,
  readImport,
  recordsToCsv,
  startImportAnalysis,
} from '../lib/imports';
import {
  createMember,
  deleteMember,
  listMembers,
  memberDetail,
  updateMember,
} from '../lib/members';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { internalApprover, internalPrincipal } from './internal';
import { decodeCursor, encodeCursor, guard, requireInChannel, v2Route } from './route';

export const v2Members = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const memberParams = channelParam.extend(idParam('memberId', idPattern('member')).shape);
const importParams = channelParam.extend(idParam('importId', idPattern('importJob')).shape);
const tagParams = memberParams.extend({
  tagName: z
    .string()
    .min(1)
    .max(60)
    .openapi({ param: { name: 'tagName', in: 'path' }, description: 'The tag name' }),
});
const notFound = errors('not_found');

/** The Member, after checking it is in the path's Channel. */
async function memberIn(c: AppContext, channelId: string, memberId: string) {
  await requireInChannel(c, 'members', memberId, channelId);
  return memberDetail(c, memberId);
}

// ---- Reads -----------------------------------------------------------------------------------

const listRoute = v2Route('members:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/members',
  operationId: 'listMembers',
  tags: ['Members'],
  summary: 'Members of a Channel, newest first',
  description:
    'Filter by status or tag name, and search email, first and last name with `q`. Pass `nextCursor` back as `cursor` for the next page.',
  request: { params: channelParam, query: MemberListQuerySchema },
  responses: {
    200: ok(page(MemberListItemSchema), 'Members'),
    ...errors('invalid_input', 'not_found'),
  },
});
v2Members.openapi(listRoute, async (c) => {
  await guard(c, listRoute);
  const { channelId } = c.req.valid('param');
  const query = c.req.valid('query');
  const cursor = decodeCursor(query.cursor);
  const result = await listMembers(c, channelId, { ...query, cursor });
  return c.json(
    { data: { items: result.items, nextCursor: encodeCursor(result.nextCursor) } },
    200,
  );
});

const engagementRoute = v2Route('members:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/members/engagement',
  operationId: 'getMemberEngagementSummary',
  tags: ['Members'],
  summary: 'How many Members are in each engagement band',
  description:
    'From the daily engagement score, which counts human opens and clicks only. Each Member also carries their own `engagement`. Answers 404 feature_disabled while the score is off.',
  request: { params: channelParam },
  responses: {
    200: ok(EngagementSummarySchema, 'Bands'),
    ...errors('not_found', 'feature_disabled'),
  },
});
v2Members.openapi(engagementRoute, async (c) => {
  await guard(c, engagementRoute);
  const { channelId } = c.req.valid('param');
  const db = env(c).DB;
  if (!(await engagementEnabled(db, channelId))) {
    throw new ApiError('feature_disabled', 'Engagement scores are off for this publication.');
  }
  return c.json({ data: await engagementSummary(db, channelId) }, 200);
});

const lookupRoute = v2Route('members:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/members/lookup',
  operationId: 'lookupMember',
  tags: ['Members'],
  summary: 'Find a Member by email address',
  request: { params: channelParam, query: ApiMemberLookupQuerySchema },
  responses: { 200: ok(MemberDetailSchema, 'Member'), ...errors('invalid_input', 'not_found') },
});
v2Members.openapi(lookupRoute, async (c) => {
  await guard(c, lookupRoute);
  const { channelId } = c.req.valid('param');
  const row = await first<{ id: string }>(
    env(c).DB,
    'SELECT id FROM members WHERE channel_id = ?1 AND email = ?2',
    channelId,
    c.req.valid('query').email,
  );
  if (!row) throw new ApiError('not_found', 'Subscriber not found.');
  return c.json({ data: await memberDetail(c, row.id) }, 200);
});

const getRoute = v2Route('members:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/members/{memberId}',
  operationId: 'getMember',
  tags: ['Members'],
  summary: 'A Member with profile fields, attribution and membership',
  request: { params: memberParams },
  responses: { 200: ok(MemberDetailSchema, 'Member'), ...notFound },
});
v2Members.openapi(getRoute, async (c) => {
  await guard(c, getRoute);
  const { channelId, memberId } = c.req.valid('param');
  return c.json({ data: await memberIn(c, channelId, memberId) }, 200);
});

const tagsRoute = v2Route('members:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/tags',
  operationId: 'listTags',
  tags: ['Members'],
  summary: 'Tags of a Channel, by name, with Member counts',
  request: { params: channelParam },
  responses: { 200: ok(z.array(TagSchema), 'Tags'), ...notFound },
});
v2Members.openapi(tagsRoute, async (c) => {
  await guard(c, tagsRoute);
  const rows = await all<TagRow>(
    env(c).DB,
    `SELECT channel_id, ${TAG_COLUMNS} FROM tags WHERE channel_id = ?1 ORDER BY name LIMIT 2000`,
    c.req.valid('param').channelId,
  );
  return c.json({ data: rows.map(toTag) }, 200);
});

const fieldsRoute = v2Route('fields:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/member-fields',
  operationId: 'listMemberFields',
  tags: ['Members'],
  summary: 'Profile fields of a Channel, in display order',
  request: { params: channelParam },
  responses: { 200: ok(z.array(MemberFieldSchema), 'Profile fields'), ...notFound },
});
v2Members.openapi(fieldsRoute, async (c) => {
  await guard(c, fieldsRoute);
  const rows = await all<FieldRow>(
    env(c).DB,
    `SELECT ${FIELD_COLUMNS} FROM member_fields WHERE channel_id = ?1 AND deleted_at IS NULL
      ORDER BY position, created_at`,
    c.req.valid('param').channelId,
  );
  return c.json({ data: rows.map(toMemberField) }, 200);
});

// ---- Writes ----------------------------------------------------------------------------------

const createRouteDef = v2Route('members:write', {
  method: 'post',
  path: '/v2/channels/{channelId}/members',
  operationId: 'createMember',
  tags: ['Members'],
  summary: 'Add a Member, or update one with upsert',
  description:
    'With `consent: true` (the person asked to receive this Channel) the Member starts active; otherwise pending, and they receive nothing until they confirm. Through an agent tool call, `consent: true` makes the Member active only when a person approved the call; otherwise the Member starts pending, and the consent record names the credential that asserted it. An address that is already a Member answers 409, unless `upsert` is true: then names and fields are updated, tags are added, and the answer is 200. An address erased through the Privacy Center is refused (409).',
  request: { params: channelParam, body: jsonBody(ApiUpsertMemberSchema) },
  responses: {
    201: ok(MemberDetailSchema, 'Added'),
    200: ok(MemberDetailSchema, 'Updated (upsert)'),
    ...errors('invalid_input', 'not_found', 'conflict'),
  },
});
v2Members.openapi(createRouteDef, async (c) => {
  const principal = await guard(c, createRouteDef);
  const { channelId } = c.req.valid('param');
  const { upsert, ...input } = c.req.valid('json');
  const actor = apiActor(c, principal);
  const existing = await first<{ id: string }>(
    env(c).DB,
    'SELECT id FROM members WHERE channel_id = ?1 AND email = ?2',
    channelId,
    input.email,
  );
  if (existing && upsert) {
    await updateMember(c, actor, existing.id, {
      ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
      ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
      ...(input.fields ? { fields: input.fields } : {}),
      ...(input.tags?.length ? { addTags: input.tags } : {}),
    });
    return c.json({ data: await memberDetail(c, existing.id) }, 200);
  }
  // An agent's call (in-process): its consent claim is recorded as the credential's, and makes
  // the Member active only when a person approved the call.
  const agent = internalPrincipal(c.req.raw)
    ? {
        credential: `${principal.kind}:${principal.id}`,
        approvedBy: internalApprover(c.req.raw),
      }
    : undefined;
  const id = await createMember(c, actor, channelId, input, 'api', agent);
  return c.json({ data: await memberDetail(c, id) }, 201);
});

const patchRoute = v2Route('members:write', {
  method: 'patch',
  path: '/v2/channels/{channelId}/members/{memberId}',
  operationId: 'updateMember',
  tags: ['Members'],
  summary: 'Edit a Member',
  description:
    'Pause (until `pausedUntil`, four weeks by default), resume or unsubscribe; names, digest, tags (replaced) and fields (merged). A pending Member can’t be confirmed this way, an unsubscribed one can’t be brought back, and a bounced or complained one can’t be changed: those answer 409.',
  request: { params: memberParams, body: jsonBody(MemberPatchSchema) },
  responses: {
    200: ok(MemberDetailSchema, 'Updated'),
    ...errors('invalid_input', 'not_found', 'conflict'),
  },
});
v2Members.openapi(patchRoute, async (c) => {
  const principal = await guard(c, patchRoute);
  const { channelId, memberId } = c.req.valid('param');
  await requireInChannel(c, 'members', memberId, channelId);
  await updateMember(c, apiActor(c, principal), memberId, c.req.valid('json'));
  return c.json({ data: await memberDetail(c, memberId) }, 200);
});

const unsubscribeRoute = v2Route('members:write', {
  method: 'post',
  path: '/v2/channels/{channelId}/members/{memberId}/unsubscribe',
  operationId: 'unsubscribeMember',
  tags: ['Members'],
  summary: 'Unsubscribe a Member',
  description: 'They stop receiving Broadcasts and can only come back by confirming from an email.',
  request: { params: memberParams },
  responses: {
    200: ok(MemberDetailSchema, 'Unsubscribed'),
    ...errors('not_found', 'conflict'),
  },
});
v2Members.openapi(unsubscribeRoute, async (c) => {
  const principal = await guard(c, unsubscribeRoute);
  const { channelId, memberId } = c.req.valid('param');
  await requireInChannel(c, 'members', memberId, channelId);
  await updateMember(c, apiActor(c, principal), memberId, { status: 'unsubscribed' });
  return c.json({ data: await memberDetail(c, memberId) }, 200);
});

const deleteRoute = v2Route('members:write', {
  method: 'delete',
  path: '/v2/channels/{channelId}/members/{memberId}',
  operationId: 'deleteMember',
  tags: ['Members'],
  summary: 'Delete a Member',
  description:
    'Removes the Member. Their address is erased from delivery history, which keeps only counts. To stop sending but keep the record, unsubscribe instead.',
  request: { params: memberParams },
  responses: { 204: noContent, ...notFound },
});
v2Members.openapi(deleteRoute, async (c) => {
  const principal = await guard(c, deleteRoute);
  const { channelId, memberId } = c.req.valid('param');
  await requireInChannel(c, 'members', memberId, channelId);
  await deleteMember(c, apiActor(c, principal), memberId, channelId);
  return c.body(null, 204);
});

const addTagsRoute = v2Route('members:write', {
  method: 'post',
  path: '/v2/channels/{channelId}/members/{memberId}/tags',
  operationId: 'addMemberTags',
  tags: ['Members'],
  summary: 'Add tags to a Member',
  description: 'Tags are given by name and created when missing. Tags the Member has stay.',
  request: { params: memberParams, body: jsonBody(ApiTagsSchema) },
  responses: { 200: ok(MemberDetailSchema, 'Tagged'), ...errors('invalid_input', 'not_found') },
});
v2Members.openapi(addTagsRoute, async (c) => {
  const principal = await guard(c, addTagsRoute);
  const { channelId, memberId } = c.req.valid('param');
  await requireInChannel(c, 'members', memberId, channelId);
  await updateMember(c, apiActor(c, principal), memberId, { addTags: c.req.valid('json').tags });
  return c.json({ data: await memberDetail(c, memberId) }, 200);
});

const removeTagRoute = v2Route('members:write', {
  method: 'delete',
  path: '/v2/channels/{channelId}/members/{memberId}/tags/{tagName}',
  operationId: 'removeMemberTag',
  tags: ['Members'],
  summary: 'Remove a tag from a Member',
  description: 'By name (URL-encoded); removing a tag the Member doesn’t have does nothing.',
  request: { params: tagParams },
  responses: { 200: ok(MemberDetailSchema, 'Untagged'), ...notFound },
});
v2Members.openapi(removeTagRoute, async (c) => {
  const principal = await guard(c, removeTagRoute);
  const { channelId, memberId, tagName } = c.req.valid('param');
  await requireInChannel(c, 'members', memberId, channelId);
  await updateMember(c, apiActor(c, principal), memberId, { removeTags: [tagName.trim()] });
  return c.json({ data: await memberDetail(c, memberId) }, 200);
});

const fieldValuesRoute = v2Route('members:write', {
  method: 'patch',
  path: '/v2/channels/{channelId}/members/{memberId}/fields',
  operationId: 'setMemberFields',
  tags: ['Members'],
  summary: 'Set profile field values',
  description:
    'By field key; null clears a value and fields not named are left alone. Values must fit the field type (dates are YYYY-MM-DD).',
  request: { params: memberParams, body: jsonBody(ApiFieldValuesSchema) },
  responses: { 200: ok(MemberDetailSchema, 'Saved'), ...errors('invalid_input', 'not_found') },
});
v2Members.openapi(fieldValuesRoute, async (c) => {
  const principal = await guard(c, fieldValuesRoute);
  const { channelId, memberId } = c.req.valid('param');
  await requireInChannel(c, 'members', memberId, channelId);
  await updateMember(c, apiActor(c, principal), memberId, { fields: c.req.valid('json').fields });
  return c.json({ data: await memberDetail(c, memberId) }, 200);
});

const eventRoute = v2Route('flows:write', {
  method: 'post',
  path: '/v2/channels/{channelId}/members/{memberId}/events',
  operationId: 'sendMemberEvent',
  tags: ['Flows'],
  summary: 'Send an API event for a Member',
  description:
    'Live Flows whose trigger is an API event with this `name` enrol the Member (subject to their filter and re-entry rule). Properties are kept with the event for the Flow run.',
  request: { params: memberParams, body: jsonBody(ApiMemberEventSchema) },
  responses: { 202: ok(ApiAcceptedSchema, 'Recorded'), ...errors('invalid_input', 'not_found') },
});
v2Members.openapi(eventRoute, async (c) => {
  await guard(c, eventRoute);
  const { channelId, memberId } = c.req.valid('param');
  await requireInChannel(c, 'members', memberId, channelId);
  const { name, properties } = c.req.valid('json');
  await recordMemberEvent(env(c).DB, {
    type: 'api_event',
    memberId,
    channelId,
    payload: { name, ...(properties ? { properties } : {}) },
  });
  // Enrolment runs from the event log; nudge it now rather than at the next sweep.
  await jobsQueue(c).send({ type: 'flow_events' });
  return c.json({ data: { accepted: true as const } }, 202);
});

// ---- Bulk upsert (an import job) ---------------------------------------------------------------

/** The bulk body as a CSV file plus the mapping for it. */
async function bulkFile(
  c: AppContext,
  channelId: string,
  input: z.infer<typeof ApiBulkUpsertSchema>,
): Promise<{
  file: Blob;
  mapping?: Record<string, ImportTarget>;
  source: 'csv' | 'platform_csv' | 'platform_json';
}> {
  if (input.source === 'platform_csv') {
    return { file: new Blob([input.csv as string], { type: 'text/csv' }), source: 'platform_csv' };
  }
  if (input.source === 'platform_json') {
    // Converted by createImportJob, as for an uploaded JSON file.
    return {
      file: new Blob([JSON.stringify(input.records)], { type: 'application/json' }),
      source: 'platform_json',
    };
  }
  const fields = await channelFields(env(c).DB, channelId);
  const keys = [...new Set((input.members ?? []).flatMap((m) => Object.keys(m.fields ?? {})))];
  const unknown = keys.filter((key) => !fields.has(key));
  if (unknown.length) {
    throw new ApiError(
      'invalid_input',
      'There is no profile field with this key.',
      unknown.map((key) => ({ path: `members.fields.${key}`, message: 'No such profile field.' })),
    );
  }
  const records = (input.members ?? []).map((member) => ({
    email: member.email,
    first_name: member.firstName ?? '',
    last_name: member.lastName ?? '',
    tags: (member.tags ?? []).join(';'),
    ...Object.fromEntries(keys.map((key) => [`field:${key}`, member.fields?.[key] ?? ''])),
  }));
  const mapping: Record<string, ImportTarget> = {
    email: 'email',
    first_name: 'first_name',
    last_name: 'last_name',
    tags: 'tags',
    ...Object.fromEntries(keys.map((key) => [`field:${key}`, `field:${key}` as ImportTarget])),
  };
  return {
    file: new Blob([recordsToCsv(records)], { type: 'text/csv' }),
    mapping,
    source: 'csv',
  };
}

const bulkRoute = v2Route('imports:write', {
  method: 'post',
  path: '/v2/channels/{channelId}/members/bulk',
  operationId: 'bulkUpsertMembers',
  tags: ['Imports'],
  summary: 'Add or update many Members (an import job)',
  description:
    'Up to 10,000 Members per call, in Swarm’s shape (`members`), or an export of another newsletter platform (`records` for JSON, `csv` for its CSV), whose people who had unsubscribed there are left out. Starts the dry run; poll the import until it is `analyzed`, read the report, then confirm it. `consentAttested` confirms these people agreed to hear from this Channel; without it they import as pending.',
  request: { params: channelParam, body: jsonBody(ApiBulkUpsertSchema) },
  responses: {
    202: ok(ImportJobSchema, 'Dry run queued'),
    ...errors('invalid_input', 'not_found', 'unsupported_media_type'),
  },
});
v2Members.openapi(bulkRoute, async (c) => {
  const principal = await guard(c, bulkRoute);
  const { channelId } = c.req.valid('param');
  const input = c.req.valid('json');
  const { file, mapping, source } = await bulkFile(c, channelId, input);
  const actor = apiActor(c, principal);
  const id = await createImportJob(c, actor, channelId, {
    fileName: `api-${new Date().toISOString().slice(0, 10)}.${source === 'platform_json' ? 'json' : 'csv'}`,
    file,
    source,
    ...(mapping ? { mapping } : {}),
  });
  const e = env(c);
  await e.DB.prepare(
    'UPDATE import_jobs SET consent_attested = ?1, update_existing = ?2, consent_attested_by = ?4 WHERE id = ?3',
  )
    .bind(
      input.consentAttested ? 1 : 0,
      input.updateExisting ? 1 : 0,
      id,
      // Who attested, for each imported subscriber's consent record: the key or the app.
      input.consentAttested ? (actor.operatorId ?? `${principal.kind}:${principal.id}`) : null,
    )
    .run();
  const row = await first<ImportJobRow>(
    e.DB,
    `SELECT channel_id, ${IMPORT_COLUMNS} FROM import_jobs WHERE id = ?1`,
    id,
  );
  await startImportAnalysis(c, row as ImportJobRow);
  return c.json({ data: await readImport(c, id) }, 202);
});

async function importIn(c: AppContext, channelId: string, importId: string) {
  await requireInChannel(c, 'import_jobs', importId, channelId);
  return (await first<ImportJobRow>(
    env(c).DB,
    `SELECT channel_id, ${IMPORT_COLUMNS} FROM import_jobs WHERE id = ?1`,
    importId,
  )) as ImportJobRow;
}

const getImportRoute = v2Route('imports:read', {
  method: 'get',
  path: '/v2/channels/{channelId}/imports/{importId}',
  operationId: 'getImport',
  tags: ['Imports'],
  summary: 'An import, with its dry-run report and progress',
  request: { params: importParams },
  responses: { 200: ok(ImportJobSchema, 'Import'), ...notFound },
});
v2Members.openapi(getImportRoute, async (c) => {
  await guard(c, getImportRoute);
  const { channelId, importId } = c.req.valid('param');
  return c.json({ data: toImportJob(await importIn(c, channelId, importId)) }, 200);
});

const confirmImportRoute = v2Route('imports:write', {
  method: 'post',
  path: '/v2/channels/{channelId}/imports/{importId}/confirm',
  operationId: 'confirmImport',
  tags: ['Imports'],
  summary: 'Import, after the dry run',
  description:
    'Queues the import, which runs in chunks. Imported Members are tagged `import:<id>`. Large lists of new addresses put the Channel’s Reputation Ramp back to warming.',
  request: { params: importParams },
  responses: { 202: ok(ImportJobSchema, 'Queued'), ...errors('not_found', 'conflict') },
});
v2Members.openapi(confirmImportRoute, async (c) => {
  const principal = await guard(c, confirmImportRoute);
  const { channelId, importId } = c.req.valid('param');
  await confirmImport(c, apiActor(c, principal), await importIn(c, channelId, importId));
  return c.json({ data: await readImport(c, importId) }, 202);
});
