// Import jobs: the dry-run analysis and the chunked import. (Phase 3, Members workstream.)
//
// Both read the uploaded CSV from R2 in byte ranges. The analysis walks the whole file once and
// writes a report; nothing touches Members. The import resumes from the job's byte cursor: each
// chunk's writes and the cursor move commit in one D1 batch, so a retried message picks up exactly
// where the last committed chunk ended.
//
// Every row lands in one class, decided by its email address in this order: invalid syntax,
// unsubscribed on the platform an export came from (counted as suppressed; Phase 7 migration
// shim, see the api worker's lib/imports.ts), duplicate (an earlier row had the same address),
// already suppressed in the workspace (an address erased through the Privacy Center counts as
// suppressed, matched by its hash), role
// account, disposable domain, then existing (updated or unchanged) or new. Only new and updated
// rows are written. A cell that doesn't fit its profile field is left out and counted; the rest of
// the row still imports.
//
// Columns of Roster names (Phase 8, rosters flag) join the Channel's live Rosters by name; an
// existing Member joins only Rosters they have never been on, so an import never re-adds anyone
// who left one (docs/rosters.md).
//
// Members created or updated by an import carry the tag `import:<id>`. That tag is also how a
// replayed or later duplicate row is recognised: a Member who already has it is skipped.
//
// "Check addresses during import" (flag email_verification, docs/email-verification.md): before
// the first chunk, the new rows' addresses go through an email check run (scope 'import'), which
// queues import_run again when it ends. New rows then follow the workspace's import rules for
// their colour: skipped (listed in the report), tagged, or imported as pending to confirm first.
import {
  EmailSchema,
  IMPORT_ATTESTATION_TEXT,
  emailCheckTag,
  type EmailCheckAction,
  type EmailCheckColour,
  IMPORT_CLASSES,
  WARM_IMPORT_THRESHOLD,
  newId,
  type FieldValue,
  type ImportClass,
  type ImportReport,
  type ImportTarget,
} from '@swarm/domain';
import {
  HEADER_PEEK_BYTES,
  FieldValueError,
  channelFields,
  consentForNewMemberStatement,
  csvLayout,
  ensureTags,
  erasedAddresses,
  fieldValueStatements,
  memberEventStatement,
  importTag,
  leftAddresses,
  isDisposableAddress,
  isRoleAddress,
  normalizeFieldValue,
  parseCsvChunk,
  readFieldValues,
  rosterChangeStatements,
  tagStatements,
  storedValue,
  type ChannelField,
  type CsvLayout,
  type PreparedValue,
  enqueueChannelCircleRefresh,
  jobQueue,
  createRun,
  emailCheckAvailability,
  loadRun,
  readChecks,
  readEmailCheckSettings,
  runFinal,
  type CandidateSource,
} from '@swarm/engine';
import { all, first, run } from '@swarm/db';
import type { JobsEnv } from '../env';
import { fieldVault, privacyVault, sealFieldsBulk } from '../vault';

interface ImportJobRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  status: string;
  r2_key: string;
  bytes: number;
  mapping_json: string;
  consent_attested: number;
  consent_attested_by: string | null;
  update_existing: number;
  cursor: number;
  check_addresses: number;
  email_check_run_id: string | null;
}

interface ImportOptions {
  /** Rows per chunk (one D1 batch). */
  chunkRows?: number;
  /** Chunks per invocation before handing over to a fresh message. */
  maxChunks?: number;
}

const CHUNK_ROWS = 250;
const MAX_CHUNKS = 40;
/**
 * The dry run has to hold its "seen" set, so it runs in one invocation. It writes nothing, so it
 * reads bigger chunks: a 50,000-row file costs about 300 D1 and R2 calls, not 1,200, well inside
 * what one Worker invocation may make.
 */
const ANALYZE_ROWS = 1000;
const READ_BYTES = 256 * 1024;
const MAX_ROW_BYTES = 1024 * 1024;
const SAMPLES = 5;
const MAX_TAGS_PER_ROW = 20;

class ImportFileError extends Error {}

async function loadJob(env: JobsEnv, jobId: string) {
  return first<ImportJobRow>(
    env.DB,
    `SELECT id, workspace_id, channel_id, status, r2_key, bytes, mapping_json, consent_attested,
            consent_attested_by, update_existing, cursor, check_addresses, email_check_run_id
       FROM import_jobs WHERE id = ?1`,
    jobId,
  );
}

async function readLayout(env: JobsEnv, job: ImportJobRow): Promise<CsvLayout> {
  const object = await env.IMPORTS.get(job.r2_key, {
    range: { offset: 0, length: Math.min(HEADER_PEEK_BYTES, job.bytes) },
  });
  if (!object) throw new ImportFileError('The uploaded file is no longer available.');
  const layout = csvLayout(
    new Uint8Array(await object.arrayBuffer()),
    job.bytes <= HEADER_PEEK_BYTES,
  );
  if (!layout) throw new ImportFileError('The first row is longer than 64 KB.');
  return layout;
}

/** Up to `limit` complete records from `offset`, and the offset just past them. */
async function readRows(
  env: JobsEnv,
  job: ImportJobRow,
  layout: CsvLayout,
  offset: number,
  limit: number,
): Promise<{ rows: string[][]; next: number }> {
  let length = READ_BYTES;
  for (;;) {
    const want = Math.min(length, job.bytes - offset);
    const object = await env.IMPORTS.get(job.r2_key, { range: { offset, length: want } });
    if (!object) throw new ImportFileError('The uploaded file is no longer available.');
    const bytes = new Uint8Array(await object.arrayBuffer());
    const final = offset + want >= job.bytes;
    const { rows, consumed } = parseCsvChunk(bytes, {
      final,
      separator: layout.separator,
      limit,
    });
    if (consumed > 0 || final) return { rows, next: offset + consumed };
    if (length >= MAX_ROW_BYTES) throw new ImportFileError('A row is longer than 1 MB.');
    length *= 2;
  }
}

// ---- Rows to candidates -----------------------------------------------------------------------

interface Plan {
  email: number;
  firstName: number | null;
  lastName: number | null;
  tags: number[];
  /** Columns of Roster names (Phase 8, rosters flag; checked when the mapping was saved). */
  rosters: number[];
  fields: { index: number; field: ChannelField }[];
  /**
   * Exports of other newsletter platforms (Phase 7 migration shim): rows whose column holds one
   * of these values (or any value, with nonEmpty) unsubscribed there and are never imported.
   */
  exclude: { index: number; values: Set<string>; nonEmpty: boolean }[];
}

interface StoredExclusion {
  column: string;
  values?: string[];
  nonEmpty?: boolean;
}

function planFor(layout: CsvLayout, mappingJson: string, fields: Map<string, ChannelField>): Plan {
  const { map, exclude = [] } = JSON.parse(mappingJson) as {
    map: Record<string, ImportTarget>;
    exclude?: StoredExclusion[];
  };
  const plan: Plan = {
    email: -1,
    firstName: null,
    lastName: null,
    tags: [],
    rosters: [],
    fields: [],
    exclude: exclude.flatMap((rule) => {
      const index = layout.columns.indexOf(rule.column);
      return index < 0
        ? []
        : [{ index, values: new Set(rule.values ?? []), nonEmpty: rule.nonEmpty === true }];
    }),
  };
  layout.columns.forEach((column, index) => {
    // Own keys only: a column the stored mapping leaves out, such as "constructor", is skipped.
    const target = Object.hasOwn(map, column) ? map[column] : null;
    if (target === 'email') plan.email = index;
    else if (target === 'first_name') plan.firstName = index;
    else if (target === 'last_name') plan.lastName = index;
    else if (target === 'tags') plan.tags.push(index);
    else if (target === 'rosters') plan.rosters.push(index);
    else if (target?.startsWith('field:')) {
      const field = fields.get(target.slice(6));
      if (field) plan.fields.push({ index, field });
    }
  });
  if (plan.email < 0) throw new ImportFileError('No column is mapped to email.');
  return plan;
}

interface Candidate {
  line: number;
  email: string;
  invalid: string | null;
  firstName: string | undefined;
  lastName: string | undefined;
  tags: string[];
  /** Roster names, lowercased; names that are no live Roster of the Channel are ignored. */
  rosters: string[];
  values: { field: ChannelField; value: FieldValue }[];
  fieldErrors: string[];
  /** Unsubscribed on the platform the file was exported from. */
  excluded: boolean;
}

const cellText = (row: string[], index: number | null) =>
  index === null ? undefined : (row[index] ?? '').trim().slice(0, 80) || undefined;

function toCandidate(row: string[], line: number, plan: Plan): Candidate {
  const raw = (row[plan.email] ?? '').trim();
  const parsed = EmailSchema.safeParse(raw);
  const tags = plan.tags
    .flatMap((i) => (row[i] ?? '').split(/[;,|]/))
    .map((t) => t.trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, MAX_TAGS_PER_ROW);
  const rosters = plan.rosters
    .flatMap((i) => (row[i] ?? '').split(/[;,|]/))
    .map((r) => r.trim().toLowerCase().slice(0, 80))
    .filter(Boolean)
    .slice(0, MAX_TAGS_PER_ROW);
  const values: Candidate['values'] = [];
  const fieldErrors: string[] = [];
  for (const { index, field } of plan.fields) {
    const cell = (row[index] ?? '').trim();
    if (!cell) continue;
    try {
      const value = normalizeFieldValue(field, cell);
      if (value !== null) values.push({ field, value });
    } catch (error) {
      if (!(error instanceof FieldValueError)) throw error;
      fieldErrors.push(`${field.key}: ${error.message}`);
    }
  }
  return {
    line,
    email: parsed.success ? parsed.data : raw.toLowerCase().slice(0, 254),
    invalid: parsed.success ? null : raw ? 'Not a valid email address.' : 'No email address.',
    firstName: cellText(row, plan.firstName),
    lastName: cellText(row, plan.lastName),
    tags,
    rosters,
    values,
    fieldErrors,
    excluded: plan.exclude.some(({ index, values: hits, nonEmpty }) => {
      const cell = (row[index] ?? '').trim().toLowerCase();
      return nonEmpty ? cell !== '' : hits.has(cell);
    }),
  };
}

/** The Channel's live Rosters by lowercased name, when a column maps to Roster names. */
async function channelRosters(
  env: JobsEnv,
  channelId: string,
  plan: Plan,
): Promise<Map<string, string>> {
  if (!plan.rosters.length) return new Map();
  const rows = await all<{ id: string; name: string }>(
    env.DB,
    'SELECT id, lower(name) AS name FROM rosters WHERE channel_id = ?1 AND deleted_at IS NULL',
    channelId,
  );
  return new Map(rows.map((r) => [r.name, r.id]));
}

/** Joins Rosters as an import does: only ones the Member has never been on (source 'import'). */
const importRosterStatements = (env: JobsEnv, memberId: string, ids: string[], now: number) =>
  ids.flatMap((rosterId) =>
    rosterChangeStatements(
      env.DB,
      { rosterId, memberId, status: 'subscribed', source: 'import', mode: 'new_only' },
      now,
    ),
  );

// ---- Classification ---------------------------------------------------------------------------

interface Existing {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  touched: number;
}

interface Classified {
  candidate: Candidate;
  cls: ImportClass;
  reason: string | null;
  existing: Existing | null;
  /** For updates: tag names the Member doesn't have yet, and values that differ. */
  newTags: string[];
  /** For updates: ids of Rosters the Member has never been on. */
  newRosters: string[];
  changedValues: Candidate['values'];
}

interface ClassifyContext {
  env: JobsEnv;
  job: ImportJobRow;
  fields: Map<string, ChannelField>;
  /** Addresses seen in earlier rows. */
  seen: Set<string>;
  /** The import tag's id, once it exists (the import has started). */
  importTagId: string | null;
  /** The Channel's live Rosters by lowercased name (empty without a rosters column). */
  rosterIds: Map<string, string>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function classify(ctx: ClassifyContext, candidates: Candidate[]): Promise<Classified[]> {
  const { env, job } = ctx;
  const emails = [...new Set(candidates.filter((c) => !c.invalid).map((c) => c.email))];
  const list = JSON.stringify(emails);
  const suppressed = new Set(
    (
      await all<{ email: string }>(
        env.DB,
        `SELECT lower(email) AS email FROM suppressions WHERE workspace_id = ?1
            AND (channel_id IS NULL OR channel_id = ?3) AND email IN (SELECT value FROM json_each(?2))`,
        job.workspace_id,
        list,
        job.channel_id,
      )
    ).map((r) => r.email),
  );
  // Erased addresses (Privacy Center) are kept only as a hash and can never be imported again.
  const erased = await erasedAddresses(env.DB, job.workspace_id, emails, privacyVault(env));
  const existing = new Map(
    (
      await all<Existing>(
        env.DB,
        `SELECT m.id, lower(m.email) AS email, m.first_name, m.last_name,
                EXISTS (SELECT 1 FROM member_tags mt WHERE mt.member_id = m.id AND mt.tag_id = ?3) AS touched
           FROM members m WHERE m.channel_id = ?1 AND m.email IN (SELECT value FROM json_each(?2))`,
        job.channel_id,
        list,
        ctx.importTagId,
      )
    ).map((r) => [r.email, r]),
  );

  // What existing Members hold today, to tell updated from unchanged.
  const existingIds = [...existing.values()].map((m) => m.id);
  const update = job.update_existing === 1 && existingIds.length > 0;
  const tagsOf = new Map<string, Set<string>>();
  const rostersOf = new Map<string, Set<string>>();
  let valuesOf = new Map<string, Record<string, FieldValue>>();
  if (update) {
    const rows = await all<{ member_id: string; name: string }>(
      env.DB,
      `SELECT mt.member_id, lower(t.name) AS name FROM member_tags mt JOIN tags t ON t.id = mt.tag_id
        WHERE mt.member_id IN (SELECT value FROM json_each(?1))`,
      JSON.stringify(existingIds),
    );
    for (const r of rows) {
      if (!tagsOf.has(r.member_id)) tagsOf.set(r.member_id, new Set());
      tagsOf.get(r.member_id)?.add(r.name);
    }
    // Opened by the vault under this import (analyzing or importing), compared here on plaintext.
    valuesOf = await readFieldValues(
      env.DB,
      existingIds,
      ctx.fields,
      fieldVault(env, { kind: 'import-job', jobId: job.id }, job.channel_id),
    );
    if (ctx.rosterIds.size) {
      // Any row, subscribed or not: an import never re-adds a Member who left a Roster.
      const held = await all<{ member_id: string; roster_id: string }>(
        env.DB,
        'SELECT member_id, roster_id FROM roster_members WHERE member_id IN (SELECT value FROM json_each(?1))',
        JSON.stringify(existingIds),
      );
      for (const r of held) {
        if (!rostersOf.has(r.member_id)) rostersOf.set(r.member_id, new Set());
        rostersOf.get(r.member_id)?.add(r.roster_id);
      }
    }
  }

  return candidates.map((candidate) => {
    const out = (cls: ImportClass, reason: string | null = null): Classified => ({
      candidate,
      cls,
      reason,
      existing: null,
      newTags: [],
      newRosters: [],
      changedValues: [],
    });
    if (candidate.invalid) return out('invalid', candidate.invalid);
    if (candidate.excluded) return out('suppressed', 'Unsubscribed on the previous platform.');
    if (ctx.seen.has(candidate.email)) return out('duplicate', 'An earlier row has this address.');
    ctx.seen.add(candidate.email);
    if (erased.has(candidate.email))
      return out('suppressed', 'Erased at the person’s request; it can’t be added again.');
    if (suppressed.has(candidate.email))
      return out('suppressed', 'Bounced, complained or blocked before.');
    if (isRoleAddress(candidate.email)) return out('role', 'Reaches a team, not a person.');
    if (isDisposableAddress(candidate.email))
      return out('disposable', 'A throwaway mailbox provider.');
    const member = existing.get(candidate.email);
    if (!member) return out('new');
    if (member.touched)
      return { ...out('duplicate', 'Already imported by this job.'), existing: member };
    if (job.update_existing !== 1)
      return { ...out('unchanged', 'Already a subscriber.'), existing: member };
    const held = tagsOf.get(member.id) ?? new Set<string>();
    const values = valuesOf.get(member.id) ?? {};
    const newTags = candidate.tags.filter((t) => !held.has(t.toLowerCase()));
    const changedValues = candidate.values.filter((v) => !same(values[v.field.key], v.value));
    const onRosters = rostersOf.get(member.id) ?? new Set<string>();
    const newRosters = [
      ...new Set(
        candidate.rosters
          .map((name) => ctx.rosterIds.get(name))
          .filter((id): id is string => !!id && !onRosters.has(id)),
      ),
    ];
    const changed =
      (candidate.firstName !== undefined && candidate.firstName !== member.first_name) ||
      (candidate.lastName !== undefined && candidate.lastName !== member.last_name) ||
      newTags.length > 0 ||
      newRosters.length > 0 ||
      changedValues.length > 0;
    return {
      candidate,
      cls: changed ? 'updated' : 'unchanged',
      reason: null,
      existing: member,
      newTags,
      newRosters,
      changedValues,
    };
  });
}

// ---- Dry run ----------------------------------------------------------------------------------

function emptyReport(): ImportReport {
  const zero = Object.fromEntries(IMPORT_CLASSES.map((k) => [k, 0])) as ImportReport['counts'];
  const lists = Object.fromEntries(
    IMPORT_CLASSES.map((k) => [k, []]),
  ) as unknown as ImportReport['samples'];
  return {
    total: 0,
    counts: zero,
    samples: lists,
    fieldErrors: 0,
    fieldErrorSamples: [],
    warmImport: false,
  };
}

async function fail(env: JobsEnv, jobId: string, error: unknown): Promise<void> {
  if (!(error instanceof ImportFileError)) throw error;
  await run(
    env.DB,
    `UPDATE import_jobs SET status = 'failed', error = ?1, updated_at = ?2, completed_at = ?2
      WHERE id = ?3 AND status IN ('analyzing', 'importing')`,
    error.message,
    Date.now(),
    jobId,
  );
}

export async function analyzeImport(
  env: JobsEnv,
  jobId: string,
  options: ImportOptions = {},
): Promise<void> {
  const job = await loadJob(env, jobId);
  if (!job || job.status !== 'analyzing') return;
  try {
    const layout = await readLayout(env, job);
    const fields = await channelFields(env.DB, job.channel_id);
    const plan = planFor(layout, job.mapping_json, fields);
    const report = emptyReport();
    const ctx: ClassifyContext = {
      env,
      job,
      fields,
      seen: new Set(),
      importTagId: null,
      rosterIds: await channelRosters(env, job.channel_id, plan),
    };
    let offset = layout.dataOffset;
    let line = layout.headerless ? 0 : 1;
    while (offset < job.bytes) {
      const { rows, next } = await readRows(
        env,
        job,
        layout,
        offset,
        options.chunkRows ?? ANALYZE_ROWS,
      );
      offset = next;
      const candidates = rows.map((row) => toCandidate(row, ++line, plan));
      for (const item of await classify(ctx, candidates)) {
        report.total++;
        report.counts[item.cls]++;
        const samples = report.samples[item.cls];
        if (samples.length < SAMPLES) {
          samples.push({
            line: item.candidate.line,
            email: item.candidate.email,
            reason: item.reason,
          });
        }
        if ((item.cls === 'new' || item.cls === 'updated') && item.candidate.fieldErrors.length) {
          report.fieldErrors += item.candidate.fieldErrors.length;
          if (report.fieldErrorSamples.length < SAMPLES) {
            report.fieldErrorSamples.push({
              line: item.candidate.line,
              email: item.candidate.email,
              reason: item.candidate.fieldErrors.join(' '),
            });
          }
        }
      }
    }
    report.warmImport = report.counts.new >= WARM_IMPORT_THRESHOLD;
    await run(
      env.DB,
      `UPDATE import_jobs SET status = 'analyzed', report_json = ?1, total_rows = ?2, updated_at = ?3
        WHERE id = ?4 AND status = 'analyzing'`,
      JSON.stringify(report),
      report.total,
      Date.now(),
      jobId,
    );
  } catch (error) {
    await fail(env, jobId, error);
  }
}

// ---- Import -----------------------------------------------------------------------------------

/** Storage for a Member's values, with what the vault sealed for that Member's own rows. */
function prepared(
  values: Candidate['values'],
  sealed: Record<string, string> | undefined,
): PreparedValue[] {
  return values.map(({ field, value }) => ({
    field,
    value,
    stored: storedValue(field, value, sealed?.[field.key]),
  }));
}

/** The encrypted ones among a Member's values, to seal for that Member. */
function encryptedOf(values: Candidate['values']): Record<string, FieldValue> | null {
  const out: Record<string, FieldValue> = {};
  for (const { field, value } of values)
    if (field.encrypted && value !== null) out[field.key] = value;
  return Object.keys(out).length ? out : null;
}

export async function runImport(
  env: JobsEnv,
  jobId: string,
  options: ImportOptions = {},
): Promise<void> {
  const initial = await loadJob(env, jobId);
  if (!initial || initial.status !== 'importing') return;
  const checking = await emailCheckGate(env, initial);
  if (checking === 'wait') return;
  try {
    const layout = await readLayout(env, initial);
    const fields = await channelFields(env.DB, initial.channel_id);
    const plan = planFor(layout, initial.mapping_json, fields);
    const rosterIds = await channelRosters(env, initial.channel_id, plan);
    const tag = importTag(jobId);

    for (let n = 0; n < (options.maxChunks ?? MAX_CHUNKS); n++) {
      const job = n === 0 ? initial : await loadJob(env, jobId);
      if (!job || job.status !== 'importing') return;
      const offset = job.cursor === 0 ? layout.dataOffset : job.cursor;
      const now = Date.now();
      if (offset >= job.bytes) {
        await run(
          env.DB,
          `UPDATE import_jobs SET status = 'done', updated_at = ?1, completed_at = ?1
            WHERE id = ?2 AND status = 'importing'`,
          now,
          jobId,
        );
        await enqueueChannelCircleRefresh(env.DB, jobQueue(env.JOBS_QUEUE), job.channel_id);
        return;
      }

      const { rows, next } = await readRows(
        env,
        job,
        layout,
        offset,
        options.chunkRows ?? CHUNK_ROWS,
      );
      const candidates = rows.map((row, i) => toCandidate(row, i, plan));
      const importTagId = (await ensureTags(env.DB, job.channel_id, [tag], now)).get(
        tag.toLowerCase(),
      ) as string;
      // Duplicates within this chunk are caught by `seen`; across chunks by the import tag.
      const classified = await classify(
        { env, job, fields, seen: new Set(), importTagId, rosterIds },
        candidates,
      );
      // Only rows that are written bring their tags: a skipped row leaves no empty tag behind.
      const tagIds = await ensureTags(
        env.DB,
        job.channel_id,
        classified
          .filter((item) => item.cls === 'new' || item.cls === 'updated')
          .flatMap((item) => item.candidate.tags),
        now,
      );

      // New Members' ids, and every encrypted value of the chunk sealed by the vault in one call,
      // each for its own Member's row (never one ciphertext copied across rows).
      const newIds = new Map<Classified, string>();
      const toSeal: { memberId: string; values: Record<string, FieldValue> }[] = [];
      for (const item of classified) {
        if (item.cls === 'new') {
          const id = newId('member', now);
          newIds.set(item, id);
          const values = encryptedOf(item.candidate.values);
          if (values) toSeal.push({ memberId: id, values });
        } else if (item.cls === 'updated' && item.existing) {
          const values = encryptedOf(item.changedValues);
          if (values) toSeal.push({ memberId: item.existing.id, values });
        }
      }
      const sealed = await sealFieldsBulk(
        env,
        { kind: 'import-job', jobId },
        job.channel_id,
        toSeal,
      );

      const statements: D1PreparedStatement[] = [];
      let created = 0;
      let updated = 0;
      const attested = job.consent_attested === 1;
      // The email check's verdict for each new address, when the import asked for one.
      const verdicts = checking
        ? await importVerdicts(
            env,
            job,
            classified.filter((item) => item.cls === 'new').map((item) => item.candidate.email),
            checking,
            now,
          )
        : null;
      const checkTally = { skipped: 0, tagged: 0, confirm: 0, samples: [] as ImportSample[] };
      // Someone who unsubscribed and was then deleted comes back only through their own confirmation.
      const left = attested
        ? await leftAddresses(
            env.DB,
            job.channel_id,
            classified.filter((item) => item.cls === 'new').map((item) => item.candidate.email),
            privacyVault(env),
          )
        : new Set<string>();
      for (const item of classified) {
        const c = item.candidate;
        const rosterIdsOf = (names: string[]) => [
          ...new Set(names.map((n) => rosterIds.get(n)).filter((id): id is string => !!id)),
        ];
        const ids = (names: string[]) =>
          [importTagId, ...names.map((t) => tagIds.get(t.toLowerCase()))].filter(
            (id): id is string => !!id,
          );
        const verdict = item.cls === 'new' ? verdicts?.get(c.email) : undefined;
        if (verdict?.action === 'refuse') {
          checkTally.skipped++;
          if (checkTally.samples.length < SAMPLES) {
            checkTally.samples.push({ line: c.line, email: c.email, reason: verdict.reason });
          }
          continue;
        }
        if (verdict?.action === 'tag') checkTally.tagged++;
        if (verdict?.action === 'confirm') checkTally.confirm++;
        if (item.cls === 'new') {
          created++;
          const id = newIds.get(item) as string;
          const status =
            attested && !left.has(c.email) && verdict?.action !== 'confirm' ? 'active' : 'pending';
          statements.push(
            env.DB.prepare(
              `INSERT INTO members (id, channel_id, email, first_name, last_name, status, source_json,
                 import_id, consent_at, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, json_object('import_id', ?7), ?7, ?8, ?9, ?9)
               ON CONFLICT (channel_id, email) DO NOTHING`,
            ).bind(
              id,
              job.channel_id,
              c.email,
              c.firstName ?? null,
              c.lastName ?? null,
              status,
              jobId,
              status === 'active' ? now : null,
              now,
            ),
            // No row (the address raced in) means no event: the append selects the new Member.
            memberEventStatement(
              env.DB,
              {
                type: 'member_joined',
                memberId: id,
                payload: { source: 'import', importId: jobId, status },
              },
              now,
            ),
            ...tagStatements(
              env.DB,
              id,
              [...ids(c.tags), ...(verdict?.tagId ? [verdict.tagId] : [])],
              now,
            ),
            ...fieldValueStatements(env.DB, id, prepared(c.values, sealed[id]), now),
            ...importRosterStatements(env, id, rosterIdsOf(c.rosters), now),
          );
          // The consent record: what the operator attested and who. Written only if the insert
          // above created this Member.
          if (attested) {
            statements.push(
              consentForNewMemberStatement(
                env.DB,
                id,
                {
                  source: 'import',
                  wording: IMPORT_ATTESTATION_TEXT,
                  ticked: true,
                  mustConfirm: status === 'pending',
                  attestedBy: job.consent_attested_by,
                },
                now,
              ),
            );
          }
        } else if (item.cls === 'updated' && item.existing) {
          updated++;
          const id = item.existing.id;
          statements.push(
            env.DB.prepare(
              `UPDATE members SET first_name = coalesce(?1, first_name), last_name = coalesce(?2, last_name),
                      updated_at = ?3 WHERE id = ?4`,
            ).bind(c.firstName ?? null, c.lastName ?? null, now, id),
            ...tagStatements(env.DB, id, ids(item.newTags), now),
            ...fieldValueStatements(env.DB, id, prepared(item.changedValues, sealed[id]), now),
            ...importRosterStatements(env, id, item.newRosters, now),
          );
        }
      }
      const skipped = classified.length - created - updated;
      if (checking && (checkTally.skipped || checkTally.tagged || checkTally.confirm)) {
        statements.push(await checkReportStatement(env, job, checkTally));
      }
      // The cursor moves in the same transaction as the writes, guarded on where it was.
      statements.push(
        env.DB.prepare(
          `UPDATE import_jobs SET cursor = ?1, processed_rows = processed_rows + ?2, updated_at = ?3,
                  report_json = json_set(coalesce(report_json, '{}'), '$.result', json_object(
                    'created', coalesce(json_extract(report_json, '$.result.created'), 0) + ?4,
                    'updated', coalesce(json_extract(report_json, '$.result.updated'), 0) + ?5,
                    'skipped', coalesce(json_extract(report_json, '$.result.skipped'), 0) + ?6))
            WHERE id = ?7 AND cursor = ?8 AND status = 'importing'`,
        ).bind(next, rows.length, now, created, updated, skipped, jobId, job.cursor),
      );
      await env.DB.batch(statements);
    }
    // Hand over to a fresh invocation, so no single run holds the consumer for long.
    await env.JOBS_QUEUE.send({ type: 'import_run', jobId });
  } catch (error) {
    await fail(env, jobId, error);
  }
}

// ---- Email checks during an import ------------------------------------------------------------

type ImportSample = NonNullable<ImportReport['emailCheck']>['samples'][number];

/**
 * Before the first chunk of an import that asked for an email check: starts the check (or waits
 * for it), then hands the import the workspace's import rules. Null when no check applies (not
 * asked, or DeBounce is no longer available: the import goes on unchecked).
 */
async function emailCheckGate(
  env: JobsEnv,
  job: ImportJobRow,
): Promise<'wait' | Awaited<ReturnType<typeof readEmailCheckSettings>> | null> {
  if (job.check_addresses !== 1) return null;
  if (!job.email_check_run_id) {
    if (job.cursor > 0) return null;
    const availability = await emailCheckAvailability(
      env.DB,
      env,
      job.workspace_id,
      job.channel_id,
    );
    if (!availability.available) return null;
    const now = Date.now();
    const runId = await createRun(
      env.DB,
      {
        workspaceId: job.workspace_id,
        scope: 'import',
        channelId: job.channel_id,
        importId: job.id,
        createdBy: null,
      },
      now,
    );
    const set = await first(
      env.DB,
      `UPDATE import_jobs SET email_check_run_id = ?1, updated_at = ?2
        WHERE id = ?3 AND email_check_run_id IS NULL RETURNING id`,
      runId,
      now,
      job.id,
    );
    if (set) await env.JOBS_QUEUE.send({ type: 'email_check_plan', runId });
    else await run(env.DB, 'DELETE FROM email_check_runs WHERE id = ?1', runId);
    return 'wait';
  }
  const check = await loadRun(env.DB, job.email_check_run_id);
  if (check && !runFinal(check.status)) return 'wait';
  return readEmailCheckSettings(env.DB, job.workspace_id);
}

/** What the import does with each new address, from its colour and the import rules. */
async function importVerdicts(
  env: JobsEnv,
  job: ImportJobRow,
  emails: string[],
  settings: Awaited<ReturnType<typeof readEmailCheckSettings>>,
  now: number,
): Promise<Map<string, { action: EmailCheckAction; reason: string; tagId: string | null }>> {
  const checks = await readChecks(env.DB, job.workspace_id, emails, settings.validMonths, now);
  const tagNames = new Set<string>();
  for (const check of checks.values()) {
    if (settings.import[check.state] === 'tag') tagNames.add(emailCheckTag(check.state));
  }
  const tagIds = await ensureTags(env.DB, job.channel_id, [...tagNames], now);
  const out = new Map<string, { action: EmailCheckAction; reason: string; tagId: string | null }>();
  for (const [email, check] of checks) {
    const colour: EmailCheckColour = check.state;
    const action = settings.import[colour];
    out.set(email, {
      action,
      reason: `Email check: ${check.reason}.`,
      tagId: action === 'tag' ? (tagIds.get(emailCheckTag(colour)) ?? null) : null,
    });
  }
  return out;
}

/** Adds this chunk's email check counts to the import report. */
async function checkReportStatement(
  env: JobsEnv,
  job: ImportJobRow,
  tally: { skipped: number; tagged: number; confirm: number; samples: ImportSample[] },
): Promise<D1PreparedStatement> {
  const row = await first<{ ec: string | null }>(
    env.DB,
    "SELECT json_extract(report_json, '$.emailCheck') AS ec FROM import_jobs WHERE id = ?1",
    job.id,
  );
  const before = (row?.ec ? JSON.parse(row.ec) : null) as typeof tally | null;
  const next = {
    skipped: (before?.skipped ?? 0) + tally.skipped,
    tagged: (before?.tagged ?? 0) + tally.tagged,
    confirm: (before?.confirm ?? 0) + tally.confirm,
    samples: [...(before?.samples ?? []), ...tally.samples].slice(0, SAMPLES),
  };
  return env.DB.prepare(
    `UPDATE import_jobs SET report_json = json_set(coalesce(report_json, '{}'), '$.emailCheck', json(?1))
      WHERE id = ?2 AND cursor = ?3 AND status = 'importing'`,
  ).bind(JSON.stringify(next), job.id, job.cursor);
}

/**
 * The addresses of an import's new rows, for its email check run: the file from a byte offset (the
 * run's cursor), classified as the import will classify them.
 */
export function importCheckCandidates(env: JobsEnv): CandidateSource {
  return async (row, cursor) => {
    const job = row.import_id ? await loadJob(env, row.import_id) : null;
    if (!job) return { emails: [], cursor: null };
    const layout = await readLayout(env, job);
    const fields = await channelFields(env.DB, job.channel_id);
    const plan = planFor(layout, job.mapping_json, fields);
    const offset = cursor ? Number(cursor) : layout.dataOffset;
    if (offset >= job.bytes) return { emails: [], cursor: null };
    const { rows, next } = await readRows(env, job, layout, offset, ANALYZE_ROWS);
    const classified = await classify(
      {
        env,
        job,
        fields,
        seen: new Set(),
        importTagId: null,
        rosterIds: await channelRosters(env, job.channel_id, plan),
      },
      rows.map((r, i) => toCandidate(r, i, plan)),
    );
    return {
      emails: classified.filter((item) => item.cls === 'new').map((item) => item.candidate.email),
      cursor: next >= job.bytes ? null : String(next),
    };
  };
}
