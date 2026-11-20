// Ask: polls and surveys. Viewers read Asks and results; editors create, edit, open, close and
// delete them; admins export the answers (they carry addresses). Answers come in through the
// capture worker (one-tap email links, Signup Journeys) and the site's survey page.
//
// A question with a profile field copies its answers into that field, so Circles can filter on
// them: a choice question needs a select field whose choices include every option label, a text
// question a text field. Encrypted fields are refused (Circles can only test them for presence).
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, toIso } from '@swarm/db';
import {
  AskResultsSchema,
  AskSchema,
  AskTextAnswersSchema,
  CreateAskSchema,
  UpdateAskSchema,
  idPattern,
  newId,
  type Ask,
  type AskQuestionInput,
  type AskStatus,
  type SeatRole,
} from '@swarm/domain';
import { askResults, csvLine, loadAsk, loadAsks, type LoadedAsk } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { createRouter, env, type AppContext } from '../lib/context';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { audit } from '../lib/site';

export const asks = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const askParam = idParam('askId', idPattern('ask'));
const MAX_ASKS = 500;
const EXPORT_ROWS = 50_000;

const iso = (ms: number | null) => (ms === null ? null : toIso(ms));
const ms = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null ? null : Date.parse(value);

async function respondents(db: D1Database, askIds: string[]): Promise<Map<string, number>> {
  if (!askIds.length) return new Map();
  const rows = await all<{ ask_id: string; n: number }>(
    db,
    `SELECT ask_id, count(DISTINCT member_id) AS n FROM ask_responses
      WHERE ask_id IN (SELECT value FROM json_each(?1)) GROUP BY ask_id`,
    JSON.stringify(askIds),
  );
  return new Map(rows.map((r) => [r.ask_id, r.n]));
}

function toAsk(ask: LoadedAsk, count: number): Ask {
  return {
    id: ask.id,
    channelId: ask.channelId,
    kind: ask.kind,
    title: ask.title,
    description: ask.description,
    status: ask.status,
    resultsPublic: ask.resultsPublic,
    closesAt: iso(ask.closesAt),
    questions: ask.questions.map((q) => ({
      id: q.id,
      position: q.position,
      prompt: q.prompt,
      description: q.description,
      kind: q.kind,
      fieldId: q.fieldId,
      required: q.required,
      options: q.options,
    })),
    respondents: count,
    surveyPath: `/_swarm/ask/${ask.id}`,
    createdAt: toIso(ask.createdAt),
    updatedAt: toIso(ask.updatedAt),
  };
}

/** The Ask and the operator's access to its Channel; 404 for another tenant's Ask. */
async function requireAsk(c: AppContext, askId: string, minimum: SeatRole) {
  const notFound = new ApiError('not_found', 'Poll or survey not found.');
  const ask = await loadAsk(env(c).DB, askId);
  if (!ask) throw notFound;
  try {
    return { ask, access: await requireChannel(c, ask.channelId, minimum) };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not_found') throw notFound;
    throw error;
  }
}

/** Profile fields the questions copy into: this Channel's, unencrypted, of the right type. */
async function checkQuestionFields(
  db: D1Database,
  channelId: string,
  questions: AskQuestionInput[],
) {
  const ids = questions.map((q) => q.fieldId).filter((id): id is string => !!id);
  if (!ids.length) return;
  const rows = await all<{ id: string; type: string; options_json: string; encrypted: number }>(
    db,
    `SELECT id, type, options_json, encrypted FROM member_fields
      WHERE channel_id = ?1 AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?2))`,
    channelId,
    JSON.stringify(ids),
  );
  questions.forEach((q, i) => {
    if (!q.fieldId) return;
    const path = `questions.${i}.fieldId`;
    const fail = (message: string): never => {
      throw new ApiError('invalid_input', message, [{ path, message }]);
    };
    const field = rows.find((r) => r.id === q.fieldId);
    if (!field) fail('That profile field is not in this publication.');
    if (field!.encrypted) fail('Answers can’t be copied into an encrypted profile field.');
    if (q.kind === 'text' && field!.type !== 'text') fail('A text question needs a text field.');
    if (q.kind === 'choice') {
      if (field!.type !== 'select') fail('A choice question needs a single-choice field.');
      const choices = (JSON.parse(field!.options_json) as string[]).map((o) => o.toLowerCase());
      const missing = q.options.find((o) => !choices.includes(o.label.toLowerCase()));
      if (missing) fail(`Add “${missing.label}” to the field’s choices first.`);
    }
  });
}

/**
 * Statements that make the Ask's questions match `questions`. Ids that are passed must already
 * belong to this Ask; questions and options that are left out are removed, unless they have
 * answers (409). Positions follow the order given.
 */
async function questionStatements(
  db: D1Database,
  ask: LoadedAsk | null,
  askId: string,
  questions: AskQuestionInput[],
): Promise<D1PreparedStatement[]> {
  const old = ask?.questions ?? [];
  const keptQuestions = new Set<string>();
  const keptOptions = new Set<string>();
  questions.forEach((q, i) => {
    if (q.id) {
      const before = old.find((o) => o.id === q.id);
      if (!before || keptQuestions.has(q.id)) {
        throw new ApiError('invalid_input', 'A question id is not part of this poll or survey.', [
          { path: `questions.${i}.id`, message: 'Unknown question' },
        ]);
      }
      if (before.kind !== q.kind) {
        throw new ApiError('invalid_input', 'A question’s kind can’t change. Add a new one.', [
          { path: `questions.${i}.kind`, message: 'Kind is fixed' },
        ]);
      }
      keptQuestions.add(q.id);
    }
    for (const option of q.options) {
      if (!option.id) continue;
      const owner = old.find((o) => o.id === q.id);
      if (!owner?.options.some((o) => o.id === option.id) || keptOptions.has(option.id)) {
        throw new ApiError('invalid_input', 'An option id is not part of this question.', [
          { path: `questions.${i}.options`, message: 'Unknown option' },
        ]);
      }
      keptOptions.add(option.id);
    }
  });
  const removedQuestions = old.filter((q) => !keptQuestions.has(q.id)).map((q) => q.id);
  const removedOptions = old
    .flatMap((q) => q.options)
    .filter((o) => !keptOptions.has(o.id))
    .map((o) => o.id);
  if (removedQuestions.length || removedOptions.length) {
    const used = await first<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM ask_responses WHERE ask_id = ?1
         AND (question_id IN (SELECT value FROM json_each(?2)) OR option_id IN (SELECT value FROM json_each(?3)))`,
      askId,
      JSON.stringify(removedQuestions),
      JSON.stringify(removedOptions),
    );
    if (used?.n) {
      throw new ApiError(
        'conflict',
        'Some questions or options you removed already have answers. Keep them, or close this one and start a new one.',
      );
    }
  }

  const statements: D1PreparedStatement[] = [];
  if (ask) {
    // Out of the way of the UNIQUE positions while they are rewritten.
    statements.push(
      db.prepare('UPDATE ask_questions SET position = -1 - position WHERE ask_id = ?1').bind(askId),
      db.prepare('UPDATE ask_options SET position = -1 - position WHERE ask_id = ?1').bind(askId),
      db
        .prepare('DELETE FROM ask_options WHERE id IN (SELECT value FROM json_each(?1))')
        .bind(JSON.stringify(removedOptions)),
      db
        .prepare('DELETE FROM ask_questions WHERE id IN (SELECT value FROM json_each(?1))')
        .bind(JSON.stringify(removedQuestions)),
    );
  }
  questions.forEach((q, position) => {
    const questionId = q.id ?? newId('askQuestion');
    statements.push(
      db
        .prepare(
          `INSERT INTO ask_questions (id, ask_id, position, prompt, description, kind, field_id, required)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT (id) DO UPDATE SET position = excluded.position, prompt = excluded.prompt,
             description = excluded.description, field_id = excluded.field_id, required = excluded.required`,
        )
        .bind(
          questionId,
          askId,
          position,
          q.prompt,
          q.description ?? null,
          q.kind,
          q.fieldId ?? null,
          q.required ? 1 : 0,
        ),
    );
    q.options.forEach((option, index) => {
      statements.push(
        db
          .prepare(
            `INSERT INTO ask_options (id, ask_id, question_id, label, position) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (id) DO UPDATE SET label = excluded.label, position = excluded.position`,
          )
          .bind(option.id ?? newId('askOption'), askId, questionId, option.label, index),
      );
    });
  });
  return statements;
}

asks.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/asks',
    tags: ['Ask'],
    summary: 'Polls and surveys of a Channel, newest first',
    request: { params: channelParam },
    responses: { 200: ok(z.array(AskSchema), 'Asks'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const db = env(c).DB;
    const ids = await all<{ id: string }>(
      db,
      `SELECT id FROM asks WHERE channel_id = ?1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?2`,
      channelId,
      MAX_ASKS,
    );
    const loaded = await loadAsks(
      db,
      ids.map((r) => r.id),
      channelId,
    );
    const counts = await respondents(db, [...loaded.keys()]);
    return c.json(
      {
        data: ids
          .map((r) => loaded.get(r.id))
          .filter((a): a is LoadedAsk => !!a)
          .map((a) => toAsk(a, counts.get(a.id) ?? 0)),
      },
      200,
    );
  },
);

asks.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/asks',
    tags: ['Ask'],
    summary: 'Create a poll or survey',
    description:
      'Editor role. Starts as a draft; open it to take answers. A poll has exactly one choice question. A question with fieldId copies answers into that profile field (choice: a select field listing every option label; text: a text field; never an encrypted field).',
    request: { params: channelParam, body: jsonBody(CreateAskSchema) },
    responses: {
      201: ok(AskSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    const db = env(c).DB;
    const count = await first<{ n: number }>(
      db,
      'SELECT count(*) AS n FROM asks WHERE channel_id = ?1 AND deleted_at IS NULL',
      channelId,
    );
    if ((count?.n ?? 0) >= MAX_ASKS) {
      throw new ApiError('conflict', `A publication can have up to ${MAX_ASKS} polls and surveys.`);
    }
    await checkQuestionFields(db, channelId, input.questions);
    const now = Date.now();
    const id = newId('ask', now);
    await db.batch([
      db
        .prepare(
          `INSERT INTO asks (id, channel_id, kind, title, description, results_public, closes_at, created_by, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
        )
        .bind(
          id,
          channelId,
          input.kind,
          input.title,
          input.description ?? null,
          input.resultsPublic ? 1 : 0,
          ms(input.closesAt) ?? null,
          access.auth.operatorId,
          now,
        ),
      ...(await questionStatements(db, null, id, input.questions)),
    ]);
    await audit(c, access, 'ask.created', 'ask', id, { kind: input.kind });
    return c.json({ data: toAsk((await loadAsk(db, id)) as LoadedAsk, 0) }, 201);
  },
);

asks.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/asks/{askId}',
    tags: ['Ask'],
    summary: 'One poll or survey',
    request: { params: askParam },
    responses: { 200: ok(AskSchema, 'Ask'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { ask } = await requireAsk(c, c.req.valid('param').askId, 'viewer');
    const counts = await respondents(env(c).DB, [ask.id]);
    return c.json({ data: toAsk(ask, counts.get(ask.id) ?? 0) }, 200);
  },
);

const canMove = (from: AskStatus, to: AskStatus, answered: boolean) =>
  from === to || to !== 'draft' || !answered;

asks.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/asks/{askId}',
    tags: ['Ask'],
    summary: 'Edit, open or close a poll or survey',
    description:
      'Editor role. status moves between draft, open and closed; an Ask with answers can’t go back to draft. Replacing questions keeps those passed with their ids; removing a question or option that has answers answers 409.',
    request: { params: askParam, body: jsonBody(UpdateAskSchema) },
    responses: {
      200: ok(AskSchema, 'Updated'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { askId } = c.req.valid('param');
    const input = c.req.valid('json');
    const { ask, access } = await requireAsk(c, askId, 'editor');
    const db = env(c).DB;
    const answered = ((await respondents(db, [askId])).get(askId) ?? 0) > 0;
    if (input.status && !canMove(ask.status, input.status, answered)) {
      throw new ApiError(
        'conflict',
        'This poll or survey has answers, so it can’t go back to draft.',
      );
    }
    const statements: D1PreparedStatement[] = [];
    if (input.questions) {
      const kind = ask.kind;
      if (
        kind === 'poll' &&
        (input.questions.length !== 1 || input.questions[0]?.kind !== 'choice')
      ) {
        throw new ApiError('invalid_input', 'A poll has exactly one choice question.', [
          { path: 'questions', message: 'One choice question' },
        ]);
      }
      await checkQuestionFields(db, ask.channelId, input.questions);
      statements.push(...(await questionStatements(db, ask, askId, input.questions)));
    }
    const closesAt = ms(input.closesAt);
    statements.unshift(
      db
        .prepare(
          `UPDATE asks SET title = ?1, description = ?2, status = ?3, results_public = ?4, closes_at = ?5, updated_at = ?6
            WHERE id = ?7 AND deleted_at IS NULL`,
        )
        .bind(
          input.title ?? ask.title,
          input.description === undefined ? ask.description : input.description,
          input.status ?? ask.status,
          (input.resultsPublic ?? ask.resultsPublic) ? 1 : 0,
          closesAt === undefined ? ask.closesAt : closesAt,
          Date.now(),
          askId,
        ),
    );
    await db.batch(statements);
    await audit(c, access, 'ask.updated', 'ask', askId, {
      fields: Object.keys(input),
      ...(input.status ? { status: input.status } : {}),
    });
    const counts = await respondents(db, [askId]);
    return c.json(
      { data: toAsk((await loadAsk(db, askId)) as LoadedAsk, counts.get(askId) ?? 0) },
      200,
    );
  },
);

asks.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/asks/{askId}',
    tags: ['Ask'],
    summary: 'Delete a poll or survey',
    description:
      'Editor role. Poll links stop working at once. Answers already copied into profile fields stay there.',
    request: { params: askParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { askId } = c.req.valid('param');
    const { access } = await requireAsk(c, askId, 'editor');
    const now = Date.now();
    await env(c)
      .DB.prepare(
        `UPDATE asks SET deleted_at = ?1, status = 'closed', updated_at = ?1 WHERE id = ?2`,
      )
      .bind(now, askId)
      .run();
    await audit(c, access, 'ask.deleted', 'ask', askId);
    return c.body(null, 204);
  },
);

asks.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/asks/{askId}/results',
    tags: ['Ask'],
    summary: 'Answer counts per option',
    description: 'With circleId, only Members currently in that Circle are counted.',
    request: {
      params: askParam,
      query: z.object({ circleId: z.string().regex(idPattern('circle')).optional() }),
    },
    responses: { 200: ok(AskResultsSchema, 'Results'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { askId } = c.req.valid('param');
    const { circleId } = c.req.valid('query');
    const { ask } = await requireAsk(c, askId, 'viewer');
    const db = env(c).DB;
    if (circleId) {
      const circle = await first<{ id: string }>(
        db,
        'SELECT id FROM circles WHERE id = ?1 AND channel_id = ?2 AND deleted_at IS NULL',
        circleId,
        ask.channelId,
      );
      if (!circle) throw new ApiError('not_found', 'Segment not found.');
    }
    const results = await askResults(db, ask, circleId ?? null);
    return c.json({ data: { askId, circleId: circleId ?? null, ...results } }, 200);
  },
);

const CURSOR = /^(\d{1,15})_(ar_[0-9a-f]{32})$/;

asks.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/asks/{askId}/questions/{questionId}/answers',
    tags: ['Ask'],
    summary: 'Text answers to a question, newest first',
    request: {
      params: askParam.extend({
        questionId: z
          .string()
          .regex(idPattern('askQuestion'))
          .openapi({ param: { name: 'questionId', in: 'path' } }),
      }),
      query: z.object({
        cursor: z.string().regex(CURSOR).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    },
    responses: {
      200: ok(AskTextAnswersSchema, 'Answers'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { askId, questionId } = c.req.valid('param');
    const { cursor, limit } = c.req.valid('query');
    const { ask } = await requireAsk(c, askId, 'viewer');
    if (!ask.questions.some((q) => q.id === questionId)) {
      throw new ApiError('not_found', 'Question not found.');
    }
    const after = cursor ? CURSOR.exec(cursor) : null;
    const rows = await all<{
      id: string;
      member_id: string;
      text: string;
      surface: 'email' | 'page' | 'journey';
      updated_at: number;
    }>(
      env(c).DB,
      `SELECT id, member_id, text, surface, updated_at FROM ask_responses
        WHERE ask_id = ?1 AND question_id = ?2 AND text IS NOT NULL
          AND (?3 IS NULL OR updated_at < ?3 OR (updated_at = ?3 AND id < ?4))
        ORDER BY updated_at DESC, id DESC LIMIT ?5`,
      askId,
      questionId,
      after ? Number(after[1]) : null,
      after ? after[2] : null,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return c.json(
      {
        data: {
          items: page.map((r) => ({
            memberId: r.member_id,
            text: r.text,
            surface: r.surface,
            answeredAt: toIso(r.updated_at),
          })),
          nextCursor: rows.length > limit && last ? `${last.updated_at}_${last.id}` : null,
        },
      },
      200,
    );
  },
);

asks.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/asks/{askId}/export',
    tags: ['Ask'],
    summary: 'Download every answer as CSV',
    description: `Admin role (the file has email addresses). Up to ${EXPORT_ROWS.toLocaleString('en')} answers; cells a spreadsheet would run as a formula are escaped.`,
    request: { params: askParam },
    responses: {
      200: { description: 'The file', content: { 'text/csv': { schema: z.string() } } },
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { askId } = c.req.valid('param');
    const { ask, access } = await requireAsk(c, askId, 'admin');
    const rows = await all<{
      email: string;
      question_id: string;
      option_id: string | null;
      text: string | null;
      surface: string;
      updated_at: number;
    }>(
      env(c).DB,
      `SELECT m.email, r.question_id, r.option_id, r.text, r.surface, r.updated_at
         FROM ask_responses r JOIN members m ON m.id = r.member_id
        WHERE r.ask_id = ?1 ORDER BY r.updated_at LIMIT ?2`,
      askId,
      EXPORT_ROWS,
    );
    const questions = new Map(ask.questions.map((q) => [q.id, q]));
    let csv = csvLine(['email', 'question', 'answer', 'surface', 'answered_at']);
    for (const row of rows) {
      const question = questions.get(row.question_id);
      const answer = row.option_id
        ? (question?.options.find((o) => o.id === row.option_id)?.label ?? '')
        : (row.text ?? '');
      csv += csvLine([
        row.email,
        question?.prompt ?? '',
        answer,
        row.surface,
        toIso(row.updated_at),
      ]);
    }
    await audit(c, access, 'ask.exported', 'ask', askId, { rows: rows.length });
    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="ask-${askId}.csv"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  },
);
