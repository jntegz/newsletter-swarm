// Imports: upload a CSV, map its columns, run a dry run, then confirm. The jobs worker does the
// analysis and the chunked import; see workers/jobs/src/handlers/imports.ts. Creating, analysing
// and confirming are in lib/imports.ts, shared with the public API's bulk upsert; so is the
// migration shim (`source`: exports of other newsletter platforms, CSV or JSON).
import { createRoute, z } from '@hono/zod-openapi';
import { all, first } from '@swarm/db';
import {
  IMPORT_MAX_BYTES,
  ImportJobSchema,
  ImportMappingSchema,
  ImportSourceSchema,
  WARM_IMPORT_THRESHOLD,
  idPattern,
  type ImportTarget,
} from '@swarm/domain';
import { channelFields } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { sessionActor } from '../lib/actor';
import { IMPORT_COLUMNS, requireRow, toImportJob, type ImportJobRow } from '../lib/audience';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { confirmImport, createImportJob, readImport, startImportAnalysis } from '../lib/imports';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';
import { requireRosters } from '../lib/rosters';

export const imports = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const importParam = idParam('importId', idPattern('importJob'));
const CSV_TYPES = new Set([
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
  '',
]);
const JSON_TYPES = new Set(['application/json', 'text/json', 'text/plain', '']);

imports.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/imports',
    tags: ['Imports'],
    summary: 'Upload a file to import',
    description:
      'Comma, semicolon or tab separated UTF-8, up to 50 MB. `source` says what the file is: a CSV (the default), or an export of another newsletter platform as CSV or JSON (up to 20 MB), whose column names are mapped for you and whose unsubscribed people are left out. The response lists the columns and a suggested mapping; set the mapping, then run the dry run.',
    request: {
      params: channelParam,
      body: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: z.object({
              file: z.any().openapi({ type: 'string', format: 'binary' }),
              source: ImportSourceSchema.optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: ok(ImportJobSchema, 'Uploaded'),
      ...errors(
        'invalid_input',
        'unauthorized',
        'forbidden',
        'not_found',
        'unsupported_media_type',
      ),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'editor');
    const form = await c.req.formData();
    const file = form.get('file');
    const source = ImportSourceSchema.safeParse(form.get('source') ?? 'csv');
    if (!source.success) throw new ApiError('invalid_input', 'Pick where the file comes from.');
    if (!(file instanceof File)) throw new ApiError('invalid_input', 'Attach a CSV file.');
    if (file.size === 0) throw new ApiError('invalid_input', 'The file is empty.');
    if (file.size > IMPORT_MAX_BYTES) {
      throw new ApiError('invalid_input', 'Import files can be up to 50 MB.');
    }
    const type = file.type.split(';')[0] ?? '';
    if (source.data === 'platform_json') {
      if (!/\.json$/i.test(file.name) || !JSON_TYPES.has(type)) {
        throw new ApiError('unsupported_media_type', 'Upload a JSON file.');
      }
    } else if (!/\.(csv|txt|tsv)$/i.test(file.name) || !CSV_TYPES.has(type)) {
      throw new ApiError('unsupported_media_type', 'Upload a CSV file.');
    }
    const id = await createImportJob(c, sessionActor(c, access), channelId, {
      fileName: file.name,
      file,
      source: source.data,
    });
    return c.json({ data: await readImport(c, id) }, 201);
  },
);

imports.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/imports',
    tags: ['Imports'],
    summary: 'Recent imports of a Channel',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(ImportJobSchema), 'Imports'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const rows = await all<ImportJobRow>(
      env(c).DB,
      `SELECT channel_id, ${IMPORT_COLUMNS} FROM import_jobs WHERE channel_id = ?1
        ORDER BY created_at DESC LIMIT 50`,
      channelId,
    );
    return c.json({ data: rows.map(toImportJob) }, 200);
  },
);

imports.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/imports/{importId}',
    tags: ['Imports'],
    summary: 'An import, with its dry-run report and progress',
    request: { params: importParam },
    responses: { 200: ok(ImportJobSchema, 'Import'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { importId } = c.req.valid('param');
    const { row } = await requireRow<ImportJobRow>(
      c,
      'import_jobs',
      IMPORT_COLUMNS,
      importId,
      'viewer',
    );
    return c.json({ data: toImportJob(row) }, 200);
  },
);

imports.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/imports/{importId}/mapping',
    tags: ['Imports'],
    summary: 'Set the column mapping and consent',
    description:
      'Map exactly one column to email. `consentAttested` confirms these people agreed to hear from this Channel; without it they import as pending. `updateExisting` updates names, fields and tags of current Members. Changing the mapping clears an earlier dry run.',
    request: { params: importParam, body: jsonBody(ImportMappingSchema) },
    responses: {
      200: ok(ImportJobSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { importId } = c.req.valid('param');
    const input = c.req.valid('json');
    const { row, access } = await requireRow<ImportJobRow>(
      c,
      'import_jobs',
      IMPORT_COLUMNS,
      importId,
      'editor',
    );
    if (row.status !== 'uploaded' && row.status !== 'analyzed') {
      throw new ApiError('conflict', 'This import can no longer be changed.');
    }
    const e = env(c);
    // The source and its exclusion rules stay with the file; only the mapping changes.
    const { columns, ...kept } = JSON.parse(row.mapping_json) as {
      columns: string[];
      map?: unknown;
      source?: string;
      exclude?: unknown;
    };
    delete kept.map;
    const fields = await channelFields(e.DB, row.channel_id);
    const problems: { path: string; message: string }[] = [];
    const map: Record<string, ImportTarget> = Object.fromEntries(columns.map((col) => [col, null]));
    const seen = new Set<string>();
    for (const [column, target] of Object.entries(input.mapping)) {
      const path = `mapping.${column}`;
      if (!columns.includes(column)) {
        problems.push({ path, message: 'There is no column with this name.' });
        continue;
      }
      if (target?.startsWith('field:') && !fields.has(target.slice(6))) {
        problems.push({ path, message: 'There is no profile field with this key.' });
      }
      if (target && target !== 'tags' && target !== 'rosters' && seen.has(target)) {
        problems.push({ path, message: 'Another column already goes here.' });
      }
      if (target) seen.add(target);
      map[column] = target;
    }
    if (!seen.has('email')) problems.push({ path: 'mapping', message: 'Pick the email column.' });
    // Rosters (Phase 8): columns of Roster names need the flag.
    if (seen.has('rosters')) await requireRosters(c, access);
    if (problems.length) {
      throw new ApiError('invalid_input', problems[0]?.message ?? 'Check the mapping.', problems);
    }
    const now = Date.now();
    await e.DB.prepare(
      `UPDATE import_jobs SET mapping_json = ?1, consent_attested = ?2, update_existing = ?3,
              status = 'uploaded', report_json = NULL, total_rows = 0, updated_at = ?4,
              consent_attested_by = ?6
        WHERE id = ?5 AND status IN ('uploaded', 'analyzed')`,
    )
      .bind(
        JSON.stringify({ columns, map, ...kept }),
        input.consentAttested ? 1 : 0,
        input.updateExisting ? 1 : 0,
        now,
        importId,
        // Who attested, for each imported subscriber's consent record.
        input.consentAttested ? access.auth.operatorId : null,
      )
      .run();
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'members.import_mapped',
      targetType: 'import_job',
      targetId: importId,
      metadata: { consentAttested: input.consentAttested, updateExisting: input.updateExisting },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: await readImport(c, importId) }, 200);
  },
);

imports.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/imports/{importId}/analyze',
    tags: ['Imports'],
    summary: 'Run the dry run',
    description:
      'Queues the analysis. When the status reaches `analyzed`, the report counts every row as new, updated, unchanged, invalid, role account, disposable domain, already suppressed or duplicate, with samples. Nothing is written to Members.',
    request: { params: importParam },
    responses: {
      202: ok(ImportJobSchema, 'Queued'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict', 'invalid_input'),
    },
  }),
  async (c) => {
    const { importId } = c.req.valid('param');
    const { row } = await requireRow<ImportJobRow>(
      c,
      'import_jobs',
      IMPORT_COLUMNS,
      importId,
      'editor',
    );
    await startImportAnalysis(c, row);
    return c.json({ data: await readImport(c, importId) }, 202);
  },
);

imports.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/imports/{importId}/confirm',
    tags: ['Imports'],
    summary: 'Import, after the dry run',
    description: `Queues the import, which runs in chunks and resumes after interruptions. Imported Members are tagged \`import:<id>\`. When ${WARM_IMPORT_THRESHOLD.toLocaleString('en-US')} or more are new, the Channel’s Reputation Ramp goes back to warming so the new addresses are introduced gradually.`,
    request: { params: importParam },
    responses: {
      202: ok(ImportJobSchema, 'Queued'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { importId } = c.req.valid('param');
    const { row, access } = await requireRow<ImportJobRow>(
      c,
      'import_jobs',
      IMPORT_COLUMNS,
      importId,
      'editor',
    );
    await confirmImport(c, sessionActor(c, access), row);
    return c.json({ data: await readImport(c, importId) }, 202);
  },
);

imports.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/imports/{importId}/cancel',
    tags: ['Imports'],
    summary: 'Cancel an import',
    description:
      'Stops the import and deletes the uploaded file. Members already imported stay. A finished import can’t be canceled.',
    request: { params: importParam },
    responses: {
      200: ok(ImportJobSchema, 'Canceled'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { importId } = c.req.valid('param');
    const { row, access } = await requireRow<ImportJobRow>(
      c,
      'import_jobs',
      IMPORT_COLUMNS,
      importId,
      'editor',
    );
    const e = env(c);
    const now = Date.now();
    const canceled = await first<{ id: string }>(
      e.DB,
      `UPDATE import_jobs SET status = 'canceled', updated_at = ?1, completed_at = ?1
        WHERE id = ?2 AND status IN ('uploaded', 'analyzing', 'analyzed', 'importing') RETURNING id`,
      now,
      importId,
    );
    if (!canceled) throw new ApiError('conflict', 'This import has already finished.');
    await e.IMPORTS.delete(row.r2_key);
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'members.import_canceled',
      targetType: 'import_job',
      targetId: importId,
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: await readImport(c, importId) }, 200);
  },
);
