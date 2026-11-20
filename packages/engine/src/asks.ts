/**
 * Ask (Phase 6): polls and surveys, shared by the api (results), the capture worker (one-tap
 * poll links and Signup Journey questions), the site (the survey page) and the send pipeline
 * (per-recipient poll links).
 *
 * CONTRACT
 * - One answer per Member per question (ask_responses UNIQUE(question_id, member_id)); a new
 *   answer replaces the old one while the Ask is open. A closed Ask (status 'closed', or past
 *   closes_at) and a draft refuse answers.
 * - Answers to a question with a field_id are copied into that profile field in the same batch
 *   (fieldValueStatements, which also emits field_changed), so Circles filter on them with an
 *   ordinary `field:<key>` leaf. Encrypted fields are refused when the question is saved.
 * - Every new or changed answer appends an ask_answered member event {askId, questionId,
 *   optionId?} in the same batch; an unchanged repeat appends nothing.
 * - Tokens: 'ask' {m, o, c} 90 days for one-tap links (send signs with ASK_SIGNING_KEYS, capture
 *   `/a/:token` verifies with the public keys), and 'ask-page' {m, a, c} 7 days for the site
 *   survey page (capture signs with ASK_PAGE_SIGNING_KEYS, site verifies). `c` is the Member's
 *   Channel, checked against the Ask's. Each is refused where the other belongs.
 */
import {
  ASK_PAGE_TOKEN_LIFETIME_DAYS,
  ASK_PAGE_TOKEN_PURPOSE,
  ASK_PLACEHOLDER,
  ASK_POLL_NODE,
  ASK_TOKEN_LIFETIME_DAYS,
  ASK_TOKEN_PURPOSE,
  type AskKind,
  type AskQuestionKind,
  type AskStatus,
  type AskSurface,
} from '@swarm/domain';
import { all, first, newIdFor } from './db';
import { memberEventStatement } from './events';
import { FieldValueError, normalizeFieldValue, toStored } from './fields';
import { sameTenant, type LinkSigner, type LinkVerifier } from './links';
import { FIELD_COLUMNS, fieldValueStatements, toFieldDef, type FieldRow } from './members';

const DAY_SECONDS = 86_400;
const MEMBER_ID = /^mb_[0-9a-f]{32}$/;
const OPTION_ID = /^ao_[0-9a-f]{32}$/;
const ASK_ID = /^ak_[0-9a-f]{32}$/;

export interface AskOption {
  id: string;
  label: string;
  position: number;
}

export interface AskQuestionDef {
  id: string;
  position: number;
  prompt: string;
  description: string | null;
  kind: AskQuestionKind;
  fieldId: string | null;
  required: boolean;
  options: AskOption[];
}

export interface LoadedAsk {
  id: string;
  channelId: string;
  kind: AskKind;
  title: string;
  description: string | null;
  status: AskStatus;
  resultsPublic: boolean;
  closesAt: number | null;
  createdAt: number;
  updatedAt: number;
  questions: AskQuestionDef[];
}

interface AskRow {
  id: string;
  channel_id: string;
  kind: AskKind;
  title: string;
  description: string | null;
  status: AskStatus;
  results_public: number;
  closes_at: number | null;
  created_at: number;
  updated_at: number;
}

export const ASK_COLUMNS =
  'id, channel_id, kind, title, description, status, results_public, closes_at, created_at, updated_at';

/** Questions and options for these Asks, in order. */
async function questionsFor(db: D1Database, askIds: string[]) {
  const ids = JSON.stringify(askIds);
  const [questions, options] = await Promise.all([
    all<{
      id: string;
      ask_id: string;
      position: number;
      prompt: string;
      description: string | null;
      kind: AskQuestionKind;
      field_id: string | null;
      required: number;
    }>(
      db,
      `SELECT id, ask_id, position, prompt, description, kind, field_id, required FROM ask_questions
        WHERE ask_id IN (SELECT value FROM json_each(?1)) ORDER BY position`,
      ids,
    ),
    all<{ id: string; question_id: string; label: string; position: number }>(
      db,
      `SELECT id, question_id, label, position FROM ask_options
        WHERE ask_id IN (SELECT value FROM json_each(?1)) ORDER BY position`,
      ids,
    ),
  ]);
  const byAsk = new Map<string, AskQuestionDef[]>();
  for (const q of questions) {
    const list = byAsk.get(q.ask_id) ?? [];
    list.push({
      id: q.id,
      position: q.position,
      prompt: q.prompt,
      description: q.description,
      kind: q.kind,
      fieldId: q.field_id,
      required: q.required === 1,
      options: options
        .filter((o) => o.question_id === q.id)
        .map((o) => ({ id: o.id, label: o.label, position: o.position })),
    });
    byAsk.set(q.ask_id, list);
  }
  return byAsk;
}

const toLoaded = (row: AskRow, questions: AskQuestionDef[]): LoadedAsk => ({
  id: row.id,
  channelId: row.channel_id,
  kind: row.kind,
  title: row.title,
  description: row.description,
  status: row.status,
  resultsPublic: row.results_public === 1,
  closesAt: row.closes_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  questions,
});

/** Asks (not deleted) with their questions; only of `channelId` when given. */
export async function loadAsks(
  db: D1Database,
  askIds: string[],
  channelId?: string,
): Promise<Map<string, LoadedAsk>> {
  const ids = [...new Set(askIds.filter((id) => ASK_ID.test(id)))].slice(0, 100);
  if (!ids.length) return new Map();
  const rows = await all<AskRow>(
    db,
    `SELECT ${ASK_COLUMNS} FROM asks
      WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL
        AND (?2 IS NULL OR channel_id = ?2)`,
    JSON.stringify(ids),
    channelId ?? null,
  );
  const questions = await questionsFor(
    db,
    rows.map((r) => r.id),
  );
  return new Map(rows.map((row) => [row.id, toLoaded(row, questions.get(row.id) ?? [])]));
}

export async function loadAsk(
  db: D1Database,
  askId: string,
  channelId?: string,
): Promise<LoadedAsk | null> {
  return (await loadAsks(db, [askId], channelId)).get(askId) ?? null;
}

/** The Ask, question and option an option id belongs to. */
export async function loadAskByOption(db: D1Database, optionId: string) {
  if (!OPTION_ID.test(optionId)) return null;
  const row = await first<{ ask_id: string }>(
    db,
    'SELECT ask_id FROM ask_options WHERE id = ?1',
    optionId,
  );
  const ask = row ? await loadAsk(db, row.ask_id) : null;
  if (!ask) return null;
  for (const question of ask.questions) {
    const option = question.options.find((o) => o.id === optionId);
    if (option) return { ask, question, option };
  }
  return null;
}

/** Open for answers: status 'open' and not past closes_at. */
export const askOpen = (ask: Pick<LoadedAsk, 'status' | 'closesAt'>, now = Date.now()) =>
  ask.status === 'open' && (ask.closesAt === null || ask.closesAt > now);

// ---- Tokens -----------------------------------------------------------------------------------

export function askToken(
  links: LinkSigner,
  member: { memberId: string; channelId: string },
  optionId: string,
  now?: number,
) {
  return links.sign(
    ASK_TOKEN_PURPOSE,
    { m: member.memberId, o: optionId, c: member.channelId },
    {
      expiresInSeconds: ASK_TOKEN_LIFETIME_DAYS * DAY_SECONDS,
      ...(now === undefined ? {} : { now }),
    },
  );
}

export type AskTokenRead =
  | {
      ok: true;
      memberId: string;
      optionId: string;
      /** The Member's Channel; null in a link from before the cutover, which named none. */
      channelId: string | null;
    }
  | { ok: false; reason: 'invalid' | 'expired' };

/** Reads a one-tap poll token. Any other purpose (a Member Center link, say) is invalid. */
export async function readAskToken(
  links: LinkVerifier,
  token: string,
  now?: number,
): Promise<AskTokenRead> {
  if (token.length > 512) return { ok: false, reason: 'invalid' };
  const result = await links.verify<{ m?: unknown; o?: unknown; c?: unknown }>(
    ASK_TOKEN_PURPOSE,
    token,
    now === undefined ? {} : { now },
  );
  if (!result.ok) return { ok: false, reason: result.reason === 'expired' ? 'expired' : 'invalid' };
  const { m, o, c } = result.payload;
  if (typeof m !== 'string' || !MEMBER_ID.test(m) || typeof o !== 'string' || !OPTION_ID.test(o)) {
    return { ok: false, reason: 'invalid' };
  }
  if (c !== undefined && typeof c !== 'string') return { ok: false, reason: 'invalid' };
  return { ok: true, memberId: m, optionId: o, channelId: c ?? null };
}

export function askPageToken(
  links: LinkSigner,
  member: { memberId: string; channelId: string },
  askId: string,
  now?: number,
) {
  return links.sign(
    ASK_PAGE_TOKEN_PURPOSE,
    { m: member.memberId, a: askId, c: member.channelId },
    {
      expiresInSeconds: ASK_PAGE_TOKEN_LIFETIME_DAYS * DAY_SECONDS,
      ...(now === undefined ? {} : { now }),
    },
  );
}

/** The Member a survey-page token names, only for this Ask and its Channel; null otherwise. */
export async function readAskPageToken(
  links: LinkVerifier,
  token: string,
  ask: { id: string; channelId: string },
  now?: number,
): Promise<string | null> {
  if (token.length > 512) return null;
  const result = await links.verify<{ m?: unknown; a?: unknown; c?: unknown }>(
    ASK_PAGE_TOKEN_PURPOSE,
    token,
    now === undefined ? {} : { now },
  );
  if (!result.ok || result.payload.a !== ask.id) return null;
  if (!sameTenant(result.payload.c, ask.channelId)) return null;
  const m = result.payload.m;
  return typeof m === 'string' && MEMBER_ID.test(m) ? m : null;
}

// ---- Answers ----------------------------------------------------------------------------------

export interface AskAnswer {
  questionId: string;
  optionId?: string | null;
  text?: string | null;
}

export type RecordAnswersResult =
  | { outcome: 'recorded'; changed: number }
  | { outcome: 'closed' }
  | { outcome: 'not_member' }
  | { outcome: 'invalid'; message: string };

/**
 * Records a Member's answers to one Ask. With `requireAll`, every required question needs an
 * answer (the survey page). Unknown questions or options are invalid; empty text is ignored.
 */
export async function recordAskAnswers(
  db: D1Database,
  input: {
    ask: LoadedAsk;
    memberId: string;
    surface: AskSurface;
    answers: AskAnswer[];
    requireAll?: boolean;
    now?: number;
  },
): Promise<RecordAnswersResult> {
  const { ask, memberId } = input;
  const now = input.now ?? Date.now();
  if (!askOpen(ask, now)) return { outcome: 'closed' };
  const member = await first<{ id: string }>(
    db,
    'SELECT id FROM members WHERE id = ?1 AND channel_id = ?2',
    memberId,
    ask.channelId,
  );
  if (!member) return { outcome: 'not_member' };

  const chosen = new Map<string, { optionId: string | null; text: string | null }>();
  for (const answer of input.answers) {
    const question = ask.questions.find((q) => q.id === answer.questionId);
    if (!question) return { outcome: 'invalid', message: 'That question is not in this poll.' };
    if (question.kind === 'choice') {
      if (!answer.optionId) continue;
      if (!question.options.some((o) => o.id === answer.optionId)) {
        return { outcome: 'invalid', message: 'That answer is not one of the options.' };
      }
      chosen.set(question.id, { optionId: answer.optionId, text: null });
    } else {
      const text = (answer.text ?? '').trim();
      if (!text) continue;
      if (text.length > 2000) {
        return { outcome: 'invalid', message: 'Keep answers under 2,000 characters.' };
      }
      chosen.set(question.id, { optionId: null, text });
    }
  }
  if (input.requireAll) {
    const missing = ask.questions.find((q) => q.required && !chosen.has(q.id));
    if (missing) return { outcome: 'invalid', message: `Answer “${missing.prompt}”.` };
  }
  if (!chosen.size) return { outcome: 'recorded', changed: 0 };

  const existing = await all<{
    question_id: string;
    option_id: string | null;
    text: string | null;
  }>(
    db,
    `SELECT question_id, option_id, text FROM ask_responses
      WHERE member_id = ?1 AND question_id IN (SELECT value FROM json_each(?2))`,
    memberId,
    JSON.stringify([...chosen.keys()]),
  );
  const fieldIds = ask.questions
    .filter((q) => chosen.has(q.id) && q.fieldId)
    .map((q) => q.fieldId as string);
  const fields = fieldIds.length
    ? await all<FieldRow>(
        db,
        `SELECT ${FIELD_COLUMNS} FROM member_fields
          WHERE channel_id = ?1 AND deleted_at IS NULL AND encrypted = 0
            AND id IN (SELECT value FROM json_each(?2))`,
        ask.channelId,
        JSON.stringify(fieldIds),
      )
    : [];

  const statements: D1PreparedStatement[] = [];
  let changed = 0;
  for (const question of ask.questions) {
    const answer = chosen.get(question.id);
    if (!answer) continue;
    const before = existing.find((e) => e.question_id === question.id);
    if (before && before.option_id === answer.optionId && before.text === answer.text) continue;
    changed++;
    statements.push(
      memberEventStatement(
        db,
        {
          type: 'ask_answered',
          memberId,
          channelId: ask.channelId,
          payload: {
            askId: ask.id,
            questionId: question.id,
            ...(answer.optionId ? { optionId: answer.optionId } : {}),
          },
        },
        now,
      ),
      db
        .prepare(
          `INSERT INTO ask_responses (id, ask_id, question_id, channel_id, member_id, option_id, text, surface, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
           ON CONFLICT (question_id, member_id) DO UPDATE SET option_id = excluded.option_id,
             text = excluded.text, surface = excluded.surface, updated_at = excluded.updated_at`,
        )
        .bind(
          newIdFor('askResponse', now),
          ask.id,
          question.id,
          ask.channelId,
          memberId,
          answer.optionId,
          answer.text,
          input.surface,
          now,
        ),
    );
    const fieldRow = question.fieldId ? fields.find((f) => f.id === question.fieldId) : undefined;
    if (fieldRow) {
      const field = toFieldDef(fieldRow);
      const raw =
        question.kind === 'choice'
          ? question.options.find((o) => o.id === answer.optionId)?.label
          : answer.text;
      try {
        const value = normalizeFieldValue(field, raw);
        statements.push(
          ...fieldValueStatements(
            db,
            memberId,
            [{ field, value, stored: await toStored(field, value) }],
            now,
          ),
        );
      } catch (error) {
        // The field changed since the question was saved (an option renamed): keep the answer.
        if (!(error instanceof FieldValueError)) throw error;
      }
    }
  }
  if (statements.length) await db.batch(statements);
  return { outcome: 'recorded', changed };
}

/** The Member's current answers to an Ask, by question id. */
export async function memberAnswers(
  db: D1Database,
  askId: string,
  memberId: string,
): Promise<Map<string, { optionId: string | null; text: string | null }>> {
  const rows = await all<{ question_id: string; option_id: string | null; text: string | null }>(
    db,
    'SELECT question_id, option_id, text FROM ask_responses WHERE ask_id = ?1 AND member_id = ?2',
    askId,
    memberId,
  );
  return new Map(rows.map((r) => [r.question_id, { optionId: r.option_id, text: r.text }]));
}

// ---- Results ----------------------------------------------------------------------------------

export interface AskResultCounts {
  respondents: number;
  questions: {
    questionId: string;
    prompt: string;
    kind: AskQuestionKind;
    answers: number;
    options: { optionId: string; label: string; count: number }[];
  }[];
}

/** Counts per option (and answers per question), optionally only Members of a Circle. */
export async function askResults(
  db: D1Database,
  ask: LoadedAsk,
  circleId: string | null = null,
): Promise<AskResultCounts> {
  const circle = `(?2 IS NULL OR member_id IN (SELECT member_id FROM circle_members WHERE circle_id = ?2))`;
  const [counts, respondents] = await Promise.all([
    all<{ question_id: string; option_id: string | null; n: number }>(
      db,
      `SELECT question_id, option_id, count(*) AS n FROM ask_responses
        WHERE ask_id = ?1 AND ${circle} GROUP BY question_id, option_id`,
      ask.id,
      circleId,
    ),
    first<{ n: number }>(
      db,
      `SELECT count(DISTINCT member_id) AS n FROM ask_responses WHERE ask_id = ?1 AND ${circle}`,
      ask.id,
      circleId,
    ),
  ]);
  return {
    respondents: respondents?.n ?? 0,
    questions: ask.questions.map((q) => {
      const rows = counts.filter((c) => c.question_id === q.id);
      return {
        questionId: q.id,
        prompt: q.prompt,
        kind: q.kind,
        answers: rows.reduce((sum, r) => sum + r.n, 0),
        options: q.options.map((o) => ({
          optionId: o.id,
          label: o.label,
          count: rows.find((r) => r.option_id === o.id)?.n ?? 0,
        })),
      };
    }),
  };
}

// ---- Email poll blocks ------------------------------------------------------------------------

/** What the email and web renderers need to draw an `askPoll` block. */
export interface AskBlock {
  askId: string;
  questionId: string;
  title: string;
  description: string | null;
  prompt: string;
  status: AskStatus;
  options: { id: string; label: string }[];
}

/** The `askPoll` blocks of a document (top level), as {askId, questionId}. */
export function collectAskBlocks(document: unknown): { askId: string; questionId: string }[] {
  const doc = document as { content?: unknown } | null;
  const blocks = Array.isArray(doc?.content) ? (doc.content as unknown[]) : [];
  const out: { askId: string; questionId: string }[] = [];
  for (const node of blocks.slice(0, 500)) {
    const n = node as { type?: unknown; attrs?: { askId?: unknown; questionId?: unknown } } | null;
    if (n?.type !== ASK_POLL_NODE) continue;
    const { askId, questionId } = n.attrs ?? {};
    if (typeof askId === 'string' && typeof questionId === 'string')
      out.push({ askId, questionId });
  }
  return out;
}

/** The Asks a document's poll blocks point at, keyed `askId:questionId`; only this Channel's. */
export async function askBlocksFor(
  db: D1Database,
  channelId: string,
  document: unknown,
): Promise<Map<string, AskBlock>> {
  const refs = collectAskBlocks(document);
  if (!refs.length) return new Map();
  const asks = await loadAsks(
    db,
    refs.map((r) => r.askId),
    channelId,
  );
  const out = new Map<string, AskBlock>();
  for (const ref of refs) {
    const ask = asks.get(ref.askId);
    const question = ask?.questions.find((q) => q.id === ref.questionId);
    if (!ask || !question || question.kind !== 'choice') continue;
    out.set(`${ask.id}:${question.id}`, {
      askId: ask.id,
      questionId: question.id,
      title: ask.title,
      description: ask.description,
      prompt: question.prompt,
      status: ask.status,
      options: question.options.map((o) => ({ id: o.id, label: o.label })),
    });
  }
  return out;
}

/** The option ids of `{{@ask:<optionId>}}` placeholders in a rendered template. */
export function askOptionIds(...parts: string[]): string[] {
  const ids = new Set<string>();
  for (const part of parts) for (const match of part.matchAll(ASK_PLACEHOLDER)) ids.add(match[1]!);
  return [...ids];
}

/** One-tap links for one recipient, by option id: `<captureOrigin>/a/<token>`. */
export async function askLinks(
  links: LinkSigner,
  captureOrigin: string,
  member: { memberId: string; channelId: string },
  optionIds: string[],
  now?: number,
): Promise<Map<string, string>> {
  const tokens = await Promise.all(optionIds.map((o) => askToken(links, member, o, now)));
  return new Map(optionIds.map((o, i) => [o, `${captureOrigin}/a/${tokens[i]}`]));
}
