// Import jobs, shared by the dashboard upload (routes/imports.ts) and the public API's bulk upsert
// (v2/members.ts): storing the file, the suggested column mapping, the dry run and confirming.
//
// The migration shim (decision D2, import only) lives here too. An import's `source` says what
// the file is: a CSV (`csv`), or an export of another newsletter platform as CSV
// (`platform_csv`) or JSON (`platform_json`). Platform exports get extra column aliases (their
// field names onto Swarm's), and exclusion rules: people who had unsubscribed there, or whose
// email was turned off, are counted as suppressed in the dry run and never imported. JSON is
// turned into a CSV here, so the jobs worker only ever reads CSV.
import { first } from '@swarm/db';
import {
  IMPORT_JSON_MAX_BYTES,
  WARM_IMPORT_THRESHOLD,
  newId,
  type ImportJob,
  type ImportReport,
  type ImportSource,
  type ImportTarget,
} from '@swarm/domain';
import {
  HEADER_PEEK_BYTES,
  channelFields,
  csvLayout,
  parseCsvChunk,
  startWarmImport,
  type ChannelField,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { actorAudit, type Actor } from './actor';
import { IMPORT_COLUMNS, toImportJob, type ImportJobRow } from './audience';
import { appendAudit } from './audit';
import { env, type AppContext } from './context';

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A table's entry for a header name: own keys only, so "Constructor" is no alias. */
const entry = <T>(table: Record<string, T>, column: string): T | undefined => {
  const key = norm(column);
  return Object.hasOwn(table, key) ? table[key] : undefined;
};

const ALIASES: Record<string, ImportTarget> = {
  email: 'email',
  emailaddress: 'email',
  mail: 'email',
  firstname: 'first_name',
  first: 'first_name',
  givenname: 'first_name',
  fname: 'first_name',
  lastname: 'last_name',
  last: 'last_name',
  surname: 'last_name',
  familyname: 'last_name',
  lname: 'last_name',
  tags: 'tags',
  tag: 'tags',
  labels: 'tags',
};

/**
 * Column names in other platforms' subscriber exports (format identifiers, not product copy).
 * Their paid plan or tier becomes a tag, so a migrated list can be sorted into membership
 * levels afterwards; a full name goes to the first name.
 */
const PLATFORM_ALIASES: Record<string, ImportTarget> = {
  name: 'first_name',
  fullname: 'first_name',
  subscribername: 'first_name',
  subscriptiontier: 'tags',
  subscriptionpremiumtiernames: 'tags',
  plan: 'tags',
  tier: 'tags',
};

/** A row is left out (as suppressed) when a column holds one of these values (lowercased). */
interface ImportExclusion {
  column: string;
  values?: string[];
  /** Any non-empty value excludes the row. */
  nonEmpty?: boolean;
}

const PLATFORM_EXCLUSIONS: Record<string, Omit<ImportExclusion, 'column'>> = {
  status: { values: ['unsubscribed', 'inactive', 'deleted', 'disabled', 'cancelled', 'canceled'] },
  subscriptionstatus: { values: ['unsubscribed', 'inactive', 'deleted', 'disabled'] },
  emaildisabled: { values: ['true', 'yes', '1'] },
  unsubscribed: { values: ['true', 'yes', '1'] },
  unsubscribedat: { nonEmpty: true },
  unsubscribedate: { nonEmpty: true },
};

/** A first guess at where each column goes, by header name or, without a header, by content. */
function suggestMapping(
  columns: string[],
  firstRow: string[] | null,
  fields: Map<string, ChannelField>,
  source: ImportSource = 'csv',
): Record<string, ImportTarget> {
  const used = new Set<ImportTarget>();
  // No prototype: a column named "__proto__" is a key like any other.
  const mapping = Object.create(null) as Record<string, ImportTarget>;
  const claim = (column: string, target: ImportTarget) => {
    if (!target || (target !== 'tags' && used.has(target))) return false;
    used.add(target);
    mapping[column] = target;
    return true;
  };
  for (const column of columns) {
    mapping[column] = null;
    const field = [...fields.values()].find(
      (f) => norm(f.key) === norm(column) || norm(f.label) === norm(column),
    );
    claim(column, entry(ALIASES, column) ?? (field ? `field:${field.key}` : null));
  }
  // Platform names only fill what the usual names left open (a real first_name column wins).
  if (source !== 'csv') {
    for (const column of columns) {
      if (!mapping[column]) claim(column, entry(PLATFORM_ALIASES, column) ?? null);
    }
  }
  columns.forEach((column, i) => {
    if (!mapping[column] && firstRow && /@/.test(firstRow[i] ?? '')) claim(column, 'email');
  });
  return mapping;
}

/** The exclusion rules for a platform export's columns (none for a plain CSV). */
function exclusionsFor(columns: string[], source: ImportSource): ImportExclusion[] {
  if (source === 'csv') return [];
  return columns.flatMap((column) => {
    const rule = entry(PLATFORM_EXCLUSIONS, column);
    return rule ? [{ column, ...rule }] : [];
  });
}

// ---- JSON exports to CSV ---------------------------------------------------------------------

const csvCell = (value: string) =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

function scalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((v) => ['string', 'number'].includes(typeof v))) {
    return value.join(';');
  }
  return null;
}

/** The records of a JSON export: an array, or an array under `data`/`subscriptions`/…. */
function jsonRecords(text: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError('invalid_input', 'The file is not valid JSON.');
  }
  const list = Array.isArray(parsed)
    ? parsed
    : ['data', 'subscriptions', 'subscribers', 'members', 'results']
        .map((key) => (parsed as Record<string, unknown> | null)?.[key])
        .find(Array.isArray);
  if (!list) throw new ApiError('invalid_input', 'The JSON file has no list of people in it.');
  return list.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null);
}

/**
 * A CSV from export records: scalar keys become columns (arrays joined with `;`), custom field
 * lists ([{ name, value }]) become a column per field, and a full `name` is split into first and
 * last name when the record has neither.
 */
export function recordsToCsv(records: Record<string, unknown>[]): string {
  const columns: string[] = [];
  const index = new Map<string, number>();
  const rows: Map<number, string>[] = [];
  const put = (row: Map<number, string>, column: string, value: string | null) => {
    if (value === null || column.length === 0 || column.length > 200) return;
    let at = index.get(column);
    if (at === undefined) {
      if (columns.length >= 200) return;
      at = columns.push(column) - 1;
      index.set(column, at);
    }
    row.set(at, value);
  };
  for (const record of records) {
    const row = new Map<number, string>();
    const name = scalar(record.name);
    const split = !!name && record.first_name === undefined && record.last_name === undefined;
    if (split) {
      const [given = '', ...rest] = (name as string).trim().split(/\s+/);
      put(row, 'first_name', given);
      put(row, 'last_name', rest.join(' ') || null);
    }
    for (const [key, value] of Object.entries(record)) {
      if (split && key === 'name') continue;
      if ((key === 'custom_fields' || key === 'customFields') && Array.isArray(value)) {
        for (const item of value as Record<string, unknown>[]) {
          const name = scalar(item?.name ?? item?.key);
          if (name) put(row, name, scalar(item?.value));
        }
        continue;
      }
      put(row, key, scalar(value));
    }
    rows.push(row);
  }
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(columns.map((_, i) => csvCell(row.get(i) ?? '')).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ---- Creating a job -----------------------------------------------------------------------------

export async function readImport(c: AppContext, id: string): Promise<ImportJob> {
  const row = await first<ImportJobRow>(
    env(c).DB,
    `SELECT channel_id, ${IMPORT_COLUMNS} FROM import_jobs WHERE id = ?1`,
    id,
  );
  return toImportJob(row as ImportJobRow);
}

interface NewImport {
  fileName: string;
  /** CSV bytes, or for `platform_json` the JSON text. */
  file: Blob;
  source: ImportSource;
  /** A mapping set by the caller (the API's own shape); otherwise the suggestion is used. */
  mapping?: Record<string, ImportTarget>;
}

/**
 * Checks and stores an import file and creates its job (status `uploaded`), with a suggested
 * mapping and, for platform exports, the exclusion rules. Returns the job id.
 */
export async function createImportJob(
  c: AppContext,
  actor: Actor,
  channelId: string,
  input: NewImport,
): Promise<string> {
  let file = input.file;
  if (input.source === 'platform_json') {
    if (file.size > IMPORT_JSON_MAX_BYTES) {
      throw new ApiError('invalid_input', 'JSON files can be up to 20 MB. Export a CSV instead.');
    }
    file = new Blob([recordsToCsv(jsonRecords(await file.text()))], { type: 'text/csv' });
  }
  const notCsv = () => new ApiError('unsupported_media_type', 'Upload a CSV file.');
  const head = new Uint8Array(await file.slice(0, HEADER_PEEK_BYTES).arrayBuffer());
  // Text, not a spreadsheet or binary renamed .csv: valid UTF-8 and no NUL bytes.
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(head, { stream: true });
  } catch {
    throw notCsv();
  }
  if (head.includes(0)) throw notCsv();
  const layout = csvLayout(head, file.size <= HEADER_PEEK_BYTES);
  if (!layout) throw new ApiError('invalid_input', 'The first row is longer than 64 KB.');
  if (layout.columns.length > 200) {
    throw new ApiError('invalid_input', 'Files can have up to 200 columns.');
  }

  const e = env(c);
  const fields = await channelFields(e.DB, channelId);
  const firstRow = layout.headerless ? layout.columns.map(() => '') : null;
  if (layout.headerless) {
    const peek = parseCsvChunk(head.subarray(layout.dataOffset), {
      final: file.size <= HEADER_PEEK_BYTES,
      separator: layout.separator,
      limit: 1,
    }).rows[0];
    peek?.forEach((cell, i) => {
      if (firstRow && i < firstRow.length) firstRow[i] = cell;
    });
  }
  const map = input.mapping ?? suggestMapping(layout.columns, firstRow, fields, input.source);
  const exclude = exclusionsFor(layout.columns, input.source);

  const now = Date.now();
  const id = newId('importJob', now);
  const key = `ws/${actor.workspaceId}/ch/${channelId}/${id}.csv`;
  await e.IMPORTS.put(key, file, {
    httpMetadata: { contentType: 'text/csv' },
    customMetadata: { workspace: actor.workspaceId },
  });
  await e.DB.prepare(
    `INSERT INTO import_jobs (id, workspace_id, channel_id, file_name, r2_key, bytes, mapping_json, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
  )
    .bind(
      id,
      actor.workspaceId,
      channelId,
      input.fileName.slice(0, 200),
      key,
      file.size,
      JSON.stringify({
        columns: layout.columns,
        map,
        source: input.source,
        ...(exclude.length ? { exclude } : {}),
      }),
      actor.operatorId,
      now,
    )
    .run();
  await appendAudit(
    e.DB,
    actorAudit(actor, {
      action: 'members.import_uploaded',
      targetType: 'import_job',
      targetId: id,
      metadata: { channelId, bytes: file.size, source: input.source },
    }),
  );
  return id;
}

/** Queues the dry run of an import whose mapping names the email column. */
export async function startImportAnalysis(c: AppContext, row: ImportJobRow): Promise<void> {
  const { map } = JSON.parse(row.mapping_json) as { map: Record<string, ImportTarget> };
  if (!Object.values(map).includes('email')) {
    throw new ApiError('invalid_input', 'Pick the email column first.');
  }
  const e = env(c);
  const queued = await first<{ id: string }>(
    e.DB,
    `UPDATE import_jobs SET status = 'analyzing', report_json = NULL, error = NULL, updated_at = ?1
      WHERE id = ?2 AND status IN ('uploaded', 'analyzed') RETURNING id`,
    Date.now(),
    row.id,
  );
  if (!queued) throw new ApiError('conflict', 'This import is already past the dry run.');
  await e.JOBS_QUEUE.send({ type: 'import_analyze', jobId: row.id });
}

/** Queues the import after its dry run, starting a warm import for large lists. */
export async function confirmImport(c: AppContext, actor: Actor, row: ImportJobRow): Promise<void> {
  const e = env(c);
  const now = Date.now();
  const started = await first<{ id: string }>(
    e.DB,
    `UPDATE import_jobs SET status = 'importing', cursor = 0, processed_rows = 0, updated_at = ?1
      WHERE id = ?2 AND status = 'analyzed' AND report_json IS NOT NULL RETURNING id`,
    now,
    row.id,
  );
  if (!started) throw new ApiError('conflict', 'Run the dry run before importing.');
  const report = JSON.parse(row.report_json as string) as ImportReport;
  let rampIds: string[] = [];
  if (report.counts.new >= WARM_IMPORT_THRESHOLD) {
    rampIds = await startWarmImport(e.DB, row.channel_id, report.counts.new, now);
  }
  await e.JOBS_QUEUE.send({ type: 'import_run', jobId: row.id });
  await appendAudit(
    e.DB,
    actorAudit(actor, {
      action: 'members.import_confirmed',
      targetType: 'import_job',
      targetId: row.id,
      metadata: {
        new: report.counts.new,
        updated: report.counts.updated,
        consentAttested: row.consent_attested === 1,
        warmImport: report.counts.new >= WARM_IMPORT_THRESHOLD,
        rampIds,
      },
    }),
  );
}
