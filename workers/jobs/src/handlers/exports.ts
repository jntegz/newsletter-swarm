// Export jobs: CSV or JSONL written to EXPORTS. (Phase 3, Members workstream.)
//
// The file is written as parts under the job's prefix: a header part, then one part per chunk of
// Members, named after the cursor the chunk starts from (the last Member id of the chunk before).
// Ids are time-ordered hex, so the parts sort in export order and the API streams them back as
// one file. A part is written before the cursor moves; a retried chunk rewrites the same key.
// Exports created with the rosters flag on (filter `rosters: true`) add each Member's subscribed
// Rosters, after the source columns, and may be limited to one Roster (`rosterId`).
//
// A bulk copy of subscriber data is finished only while someone with authority stands behind
// it: before each chunk (the last one included, which publishes the file) the job checks that
// whoever asked for it still has the admin role on the Channel and that the Channel is not
// deleted. Otherwise it stops as failed, says why, deletes the parts written so far and leaves
// an audit entry (docs/security.md "Standing feeds"). An admin can cancel a queued or running
// export the same way (routes/exports.ts).
import { EXPORT_TTL_HOURS, type FieldValue, type MemberSource } from '@swarm/domain';
import { all, appendAudit, first, run, toIso } from '@swarm/db';
import {
  FIELD_COLUMNS,
  csvLine,
  readFieldValues,
  toFieldDef,
  type ChannelField,
  type FieldRow,
} from '@swarm/engine';
import type { JobsEnv } from '../env';
import { fieldVault } from '../vault';

interface ExportJobRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  format: 'csv' | 'jsonl';
  filter_json: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  r2_key: string | null;
  cursor: string | null;
  created_at: number;
  created_by: string | null;
  /** Why the job may not go on: 'requester' (no admin role left) or 'channel' (deleted). */
  stop: 'requester' | 'channel' | null;
}

/** The requester's authority and the Channel's state, read with the job row. */
const STOP_SQL = `CASE
    WHEN EXISTS (SELECT 1 FROM channels ch WHERE ch.id = j.channel_id AND ch.deleted_at IS NOT NULL)
      THEN 'channel'
    WHEN j.created_by IS NULL OR NOT EXISTS (
      SELECT 1 FROM seats s WHERE s.workspace_id = j.workspace_id AND s.operator_id = j.created_by
         AND s.role IN ('owner', 'admin'))
      OR EXISTS (
      SELECT 1 FROM channel_roles cr WHERE cr.channel_id = j.channel_id AND cr.operator_id = j.created_by
         AND cr.role NOT IN ('owner', 'admin'))
      THEN 'requester'
    ELSE NULL END`;

const STOP_REASON = {
  requester: 'Stopped: whoever asked for this export no longer has the admin role here.',
  channel: 'Stopped: the publication was deleted.',
} as const;

/** Deletes every part an export wrote. */
async function deleteExportParts(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    if (listed.objects.length) {
      await bucket.delete(listed.objects.map((o) => o.key));
      deleted += listed.objects.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return deleted;
}

const stoppedMeanwhile = async (env: JobsEnv, jobId: string) =>
  (await first<{ status: string }>(env.DB, 'SELECT status FROM export_jobs WHERE id = ?1', jobId))
    ?.status === 'failed';

/** Ends a job that may not go on: failed with the reason, no parts left, an audit entry. */
async function stopExport(env: JobsEnv, job: ExportJobRow, why: 'requester' | 'channel') {
  const prefix = `ws/${job.workspace_id}/ch/${job.channel_id}/${job.id}/`;
  const stopped = await first(
    env.DB,
    `UPDATE export_jobs SET status = 'failed', error = ?1, completed_at = ?2
      WHERE id = ?3 AND status IN ('queued', 'running') RETURNING id`,
    STOP_REASON[why],
    Date.now(),
    job.id,
  );
  const parts = await deleteExportParts(env.EXPORTS, prefix);
  if (stopped) {
    await appendAudit(env.DB, {
      workspaceId: job.workspace_id,
      actorId: null,
      action: 'export.stopped',
      targetType: 'export',
      targetId: job.id,
      metadata: { channelId: job.channel_id, reason: why, requestedBy: job.created_by, parts },
      ipPrefix: null,
    });
  }
}

interface MemberExportRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: string;
  digest: string;
  tags_json: string;
  rosters_json: string | null;
  source_json: string;
  form_id: string | null;
  import_id: string | null;
  created_at: number;
  consent_at: number | null;
  confirmed_at: number | null;
  paused_until: number | null;
  unsubscribed_at: number | null;
}

interface ExportOptions {
  chunkSize?: number;
  maxChunks?: number;
}

const CHUNK = 1000;
const MAX_CHUNKS = 20;
const SOURCE_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'referrer', 'ref'] as const;
const BASE_COLUMNS = [
  'id',
  'email',
  'first_name',
  'last_name',
  'status',
  'digest',
  'tags',
  'created_at',
  'consent_at',
  'confirmed_at',
  'paused_until',
  'unsubscribed_at',
  'form_id',
  'import_id',
  ...SOURCE_KEYS,
];

const iso = (ms: number | null) => (ms === null ? null : toIso(ms));

/** The fields as they were when the export was requested, so every chunk has the same columns. */
async function exportFields(env: JobsEnv, job: ExportJobRow): Promise<Map<string, ChannelField>> {
  const rows = await all<FieldRow>(
    env.DB,
    `SELECT ${FIELD_COLUMNS} FROM member_fields
      WHERE channel_id = ?1 AND created_at <= ?2 AND (deleted_at IS NULL OR deleted_at > ?2)
      ORDER BY position, created_at`,
    job.channel_id,
    job.created_at,
  );
  return new Map(rows.map((row) => [row.key, toFieldDef(row)]));
}

function cellValue(value: FieldValue | undefined): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? value.join('; ') : value;
}

interface ExportFilter {
  status?: string;
  circleId?: string;
  rosterId?: string;
  /** The rosters flag was on when the export was requested: add the rosters column. */
  rosters?: boolean;
}

const filterOf = (job: ExportJobRow) => JSON.parse(job.filter_json) as ExportFilter;

function render(
  job: ExportJobRow,
  rows: MemberExportRow[],
  fields: Map<string, ChannelField>,
  values: Map<string, Record<string, FieldValue>>,
): string {
  const keys = [...fields.keys()];
  const withRosters = filterOf(job).rosters === true;
  return rows
    .map((row) => {
      const tags = (JSON.parse(row.tags_json) as string[]).sort();
      const source = JSON.parse(row.source_json) as MemberSource;
      const own = values.get(row.id) ?? {};
      const rosters = withRosters ? (JSON.parse(row.rosters_json ?? '[]') as string[]).sort() : [];
      if (job.format === 'jsonl') {
        return `${JSON.stringify({
          id: row.id,
          email: row.email,
          firstName: row.first_name,
          lastName: row.last_name,
          status: row.status,
          digest: row.digest,
          tags,
          createdAt: iso(row.created_at),
          consentAt: iso(row.consent_at),
          confirmedAt: iso(row.confirmed_at),
          pausedUntil: iso(row.paused_until),
          unsubscribedAt: iso(row.unsubscribed_at),
          formId: row.form_id,
          importId: row.import_id,
          source,
          ...(withRosters ? { rosters } : {}),
          fields: Object.fromEntries(keys.map((k) => [k, own[k] ?? null])),
        })}\n`;
      }
      return csvLine([
        row.id,
        row.email,
        row.first_name,
        row.last_name,
        row.status,
        row.digest,
        tags.join('; '),
        iso(row.created_at),
        iso(row.consent_at),
        iso(row.confirmed_at),
        iso(row.paused_until),
        iso(row.unsubscribed_at),
        row.form_id,
        row.import_id,
        ...SOURCE_KEYS.map((k) => source[k] ?? null),
        ...(withRosters ? [rosters.join('; ')] : []),
        ...keys.map((k) => cellValue(own[k])),
      ]);
    })
    .join('');
}

export async function runExport(
  env: JobsEnv,
  jobId: string,
  options: ExportOptions = {},
): Promise<void> {
  const size = options.chunkSize ?? CHUNK;
  let fields: Map<string, ChannelField> | null = null;
  for (let n = 0; n < (options.maxChunks ?? MAX_CHUNKS); n++) {
    const job = await first<ExportJobRow>(
      env.DB,
      `SELECT j.id, j.workspace_id, j.channel_id, j.format, j.filter_json, j.status, j.r2_key,
              j.cursor, j.created_at, j.created_by, ${STOP_SQL} AS stop
         FROM export_jobs j WHERE j.id = ?1`,
      jobId,
    );
    if (!job || job.status === 'done' || job.status === 'failed') return;
    if (job.stop) return stopExport(env, job, job.stop);
    const now = Date.now();
    const prefix = `ws/${job.workspace_id}/ch/${job.channel_id}/${job.id}/`;
    fields ??= await exportFields(env, job);

    if (job.cursor === null) {
      // First chunk: the header part (CSV) or an empty one (JSONL), so even an empty export downloads.
      const header =
        job.format === 'csv'
          ? csvLine([
              ...BASE_COLUMNS,
              ...(filterOf(job).rosters === true ? ['rosters'] : []),
              ...[...fields.keys()].map((k) => `field:${k}`),
            ])
          : '';
      await env.EXPORTS.put(`${prefix}0-header`, header, {
        customMetadata: { workspace: job.workspace_id },
      });
      const started = await first(
        env.DB,
        "UPDATE export_jobs SET status = 'running', r2_key = ?1, cursor = '' WHERE id = ?2 AND cursor IS NULL AND status = 'queued' RETURNING id",
        prefix,
        jobId,
      );
      if (!started && (await stoppedMeanwhile(env, jobId))) {
        await deleteExportParts(env.EXPORTS, prefix);
        return;
      }
      continue;
    }

    const filter = filterOf(job);
    const rows = await all<MemberExportRow>(
      env.DB,
      `SELECT m.id, m.email, m.first_name, m.last_name, m.status, m.digest, m.source_json, m.form_id,
              m.import_id, m.created_at, m.consent_at, m.confirmed_at, m.paused_until, m.unsubscribed_at,
              (SELECT json_group_array(t.name) FROM member_tags mt JOIN tags t ON t.id = mt.tag_id
                WHERE mt.member_id = m.id) AS tags_json,
              CASE WHEN ?6 = 1 THEN
                (SELECT json_group_array(r.name) FROM roster_members rm JOIN rosters r ON r.id = rm.roster_id
                  WHERE rm.member_id = m.id AND rm.status = 'subscribed' AND r.deleted_at IS NULL)
              END AS rosters_json
         FROM members m
        WHERE m.channel_id = ?1 AND m.id > ?2 AND (?3 IS NULL OR m.status = ?3)
          AND (?4 IS NULL OR EXISTS (SELECT 1 FROM circle_members cm WHERE cm.circle_id = ?4 AND cm.member_id = m.id))
          AND (?7 IS NULL OR EXISTS (SELECT 1 FROM roster_members rm
                                      WHERE rm.roster_id = ?7 AND rm.member_id = m.id AND rm.status = 'subscribed'))
        ORDER BY m.id LIMIT ?5`,
      job.channel_id,
      job.cursor,
      filter.status ?? null,
      filter.circleId ?? null,
      size,
      filter.rosters === true ? 1 : 0,
      filter.rosterId ?? null,
    );
    if (!rows.length) {
      await run(
        env.DB,
        `UPDATE export_jobs SET status = 'done', completed_at = ?1, expires_at = ?2
          WHERE id = ?3 AND status = 'running'`,
        now,
        now + EXPORT_TTL_HOURS * 3_600_000,
        jobId,
      );
      return;
    }
    // Opened by the vault while this export runs and its creator is still an admin there.
    const values = await readFieldValues(
      env.DB,
      rows.map((r) => r.id),
      fields,
      fieldVault(env, { kind: 'export-job', jobId }, job.channel_id),
    );
    await env.EXPORTS.put(`${prefix}1-${job.cursor}`, render(job, rows, fields, values), {
      customMetadata: { workspace: job.workspace_id },
    });
    const moved = await first(
      env.DB,
      `UPDATE export_jobs SET cursor = ?1, row_count = row_count + ?2
        WHERE id = ?3 AND cursor = ?4 AND status = 'running' RETURNING id`,
      rows.at(-1)?.id,
      rows.length,
      jobId,
      job.cursor,
    );
    // Canceled or stopped while this chunk was written: nothing of it may stay behind.
    if (!moved && (await stoppedMeanwhile(env, jobId))) {
      await deleteExportParts(env.EXPORTS, prefix);
      return;
    }
  }
  await env.JOBS_QUEUE.send({ type: 'export', jobId });
}
