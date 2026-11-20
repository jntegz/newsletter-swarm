// Bulk actions over a selection of Members. (Phase 3, Members workstream.)
//
// The selection (picked ids, or a Circle's materialised members) is walked in id order. Each
// chunk's writes and the cursor move commit in one D1 batch, guarded on the old cursor, so a
// retried message resumes after the last committed chunk and progress counts each Member once.
// Every action is idempotent, so two racing messages applying the same chunk change nothing extra.
import type { BulkJob, FieldValue } from '@swarm/domain';
import { all, first, run } from '@swarm/db';
import {
  rememberLeftStatements,
  channelFields,
  enrolChunk,
  ensureTags,
  fieldValueStatements,
  statusList,
  tagStatements,
  storedValue,
  transitionSources,
  enqueueChannelCircleRefresh,
  jobQueue,
  memberDeletedStatement,
  memberUnsubscribedStatement,
} from '@swarm/engine';
import type { JobsEnv } from '../env';
import { privacyVault, sealFieldsBulk } from '../vault';

interface BulkJobRow {
  id: string;
  channel_id: string;
  action: BulkJob['action'];
  params_json: string;
  selection_json: string;
  status: BulkJob['status'];
  cursor: string | null;
}

interface BulkOptions {
  chunkSize?: number;
  maxChunks?: number;
}

const CHUNK = 100;
const MAX_CHUNKS = 50;
/** Adding people starts a run per Member, so one delivery does fewer chunks of it. */
const MAX_ENROL_CHUNKS = 3;
/** Operators may unsubscribe Members only from these statuses. */
const UNSUBSCRIBABLE_STATUSES = transitionSources('unsubscribed', 'operator');
const UNSUBSCRIBABLE = statusList(UNSUBSCRIBABLE_STATUSES);

async function selectionChunk(
  env: JobsEnv,
  job: BulkJobRow,
  after: string,
  size: number,
): Promise<string[]> {
  const selection = JSON.parse(job.selection_json) as { memberIds?: string[]; circleId?: string };
  const rows = selection.circleId
    ? await all<{ id: string }>(
        env.DB,
        `SELECT cm.member_id AS id FROM circle_members cm JOIN members m ON m.id = cm.member_id
          WHERE cm.circle_id = ?1 AND m.channel_id = ?2 AND cm.member_id > ?3
          ORDER BY cm.member_id LIMIT ?4`,
        selection.circleId,
        job.channel_id,
        after,
        size,
      )
    : await all<{ id: string }>(
        env.DB,
        `SELECT id FROM members WHERE channel_id = ?1 AND id > ?2
            AND id IN (SELECT value FROM json_each(?3)) ORDER BY id LIMIT ?4`,
        job.channel_id,
        after,
        JSON.stringify(selection.memberIds ?? []),
        size,
      );
  return rows.map((r) => r.id);
}

async function actionStatements(
  env: JobsEnv,
  job: BulkJobRow,
  ids: string[],
  now: number,
): Promise<D1PreparedStatement[]> {
  const params = JSON.parse(job.params_json) as {
    tag?: string;
    field?: string;
    value?: FieldValue;
  };
  if (job.action === 'flow_enrol') return []; // runEnrolChunk: it can't be one batch
  const list = JSON.stringify(ids);
  switch (job.action) {
    case 'tag': {
      const tagId = (await ensureTags(env.DB, job.channel_id, [params.tag as string], now))
        .values()
        .next().value as string;
      return ids.flatMap((id) => tagStatements(env.DB, id, [tagId], now));
    }
    case 'untag':
      return [
        // Flow trigger tag_removed (Phase 6), before the delete.
        env.DB.prepare(
          `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
           SELECT m.channel_id, m.id, 'tag_removed', json_object('tagId', t.id), ?4
             FROM members m JOIN member_tags mt ON mt.member_id = m.id
             JOIN tags t ON t.id = mt.tag_id AND t.channel_id = ?2 AND t.name = ?3
            WHERE m.id IN (SELECT value FROM json_each(?1))`,
        ).bind(list, job.channel_id, params.tag, now),
        env.DB.prepare(
          `DELETE FROM member_tags WHERE member_id IN (SELECT value FROM json_each(?1))
              AND tag_id IN (SELECT id FROM tags WHERE channel_id = ?2 AND name = ?3)`,
        ).bind(list, job.channel_id, params.tag),
      ];
    case 'set_field': {
      const field = (await channelFields(env.DB, job.channel_id)).get(params.field as string);
      if (!field) return []; // the field was removed after the job started
      const value = params.value ?? null;
      // An encrypted value is sealed by the vault for each Member's own row: one ciphertext
      // copied across the chunk would open nowhere in the row-bound format.
      const sealed =
        field.encrypted && value !== null
          ? await sealFieldsBulk(
              env,
              { kind: 'bulk-job', jobId: job.id },
              job.channel_id,
              ids.map((memberId) => ({ memberId, values: { [field.key]: value } })),
            )
          : {};
      return ids.flatMap((id) =>
        fieldValueStatements(
          env.DB,
          id,
          [{ field, value, stored: storedValue(field, value, sealed[id]?.[field.key]) }],
          now,
        ),
      );
    }
    case 'unsubscribe':
      return [
        // member.unsubscribed webhooks (Phase 7), before the update.
        memberUnsubscribedStatement(env.DB, ids, UNSUBSCRIBABLE_STATUSES, now),
        env.DB.prepare(
          `UPDATE members SET status = 'unsubscribed', unsubscribed_at = ?1, paused_until = NULL, updated_at = ?1
            WHERE id IN (SELECT value FROM json_each(?2)) AND status IN (${UNSUBSCRIBABLE})`,
        ).bind(now, list),
      ];
    case 'delete':
      return [
        ...(await rememberLeftStatements(env.DB, job.channel_id, ids, now, privacyVault(env))),
        // member.deleted webhooks (Phase 7), before the delete.
        memberDeletedStatement(env.DB, ids, now),
        // As with a single delete: the address is erased from delivery history.
        env.DB.prepare(
          "UPDATE deliveries SET email = 'deleted' WHERE member_id IN (SELECT value FROM json_each(?1))",
        ).bind(list),
        // Metered reads of signed-in readers are keyed by Member id, with no foreign key.
        env.DB.prepare(
          'DELETE FROM gate_meter_reads WHERE reader_key IN (SELECT value FROM json_each(?1))',
        ).bind(list),
        env.DB.prepare(
          'DELETE FROM members WHERE channel_id = ?1 AND id IN (SELECT value FROM json_each(?2))',
        ).bind(job.channel_id, list),
      ];
  }
}

/**
 * One chunk of Add people. Each Member's run starts on its own, not in one batch with the cursor; a
 * retried chunk finds the runs this job already started, so nobody starts twice and the count holds.
 * False when the Flow stopped being live: the job ends there, and nobody else is added.
 */
async function runEnrolChunk(
  env: JobsEnv,
  job: BulkJobRow,
  ids: string[],
  now: number,
): Promise<boolean> {
  const { flowId } = JSON.parse(job.params_json) as { flowId: string };
  const queues = { DB: env.DB, JOBS_QUEUE: env.JOBS_QUEUE, SEND_QUEUE: env.SEND_QUEUE };
  const result = await enrolChunk(queues, {
    jobId: job.id,
    flowId,
    channelId: job.channel_id,
    memberIds: ids,
    now,
  });
  if ('stopped' in result) {
    await run(
      env.DB,
      `UPDATE bulk_jobs SET status = 'failed', error = ?1, completed_at = ?2 WHERE id = ?3`,
      'The automation is no longer live.',
      now,
      job.id,
    );
    return false;
  }
  await run(
    env.DB,
    `UPDATE bulk_jobs SET cursor = ?1, processed = processed + ?2, entered = entered + ?3
      WHERE id = ?4 AND ifnull(cursor, '') = ?5`,
    ids.at(-1),
    ids.length,
    result.entered,
    job.id,
    job.cursor ?? '',
  );
  return true;
}

export async function runBulk(
  env: JobsEnv,
  jobId: string,
  options: BulkOptions = {},
): Promise<void> {
  const size = options.chunkSize ?? CHUNK;
  for (let n = 0; ; n++) {
    const job = await first<BulkJobRow>(
      env.DB,
      'SELECT id, channel_id, action, params_json, selection_json, status, cursor FROM bulk_jobs WHERE id = ?1',
      jobId,
    );
    if (!job || job.status === 'done' || job.status === 'failed') return;
    const enrol = job.action === 'flow_enrol';
    if (n >= (options.maxChunks ?? (enrol ? MAX_ENROL_CHUNKS : MAX_CHUNKS))) break;
    const now = Date.now();
    if (job.status === 'queued') {
      await run(
        env.DB,
        "UPDATE bulk_jobs SET status = 'running' WHERE id = ?1 AND status = 'queued'",
        jobId,
      );
    }
    const ids = await selectionChunk(env, job, job.cursor ?? '', size);
    if (!ids.length) {
      await run(
        env.DB,
        "UPDATE bulk_jobs SET status = 'done', completed_at = ?1 WHERE id = ?2 AND status IN ('queued', 'running')",
        now,
        jobId,
      );
      if (!enrol) {
        await enqueueChannelCircleRefresh(env.DB, jobQueue(env.JOBS_QUEUE), job.channel_id);
      }
      return;
    }
    if (enrol) {
      if (!(await runEnrolChunk(env, job, ids, now))) return;
      continue;
    }
    await env.DB.batch([
      ...(await actionStatements(env, job, ids, now)),
      env.DB.prepare(
        `UPDATE bulk_jobs SET cursor = ?1, processed = processed + ?2
          WHERE id = ?3 AND ifnull(cursor, '') = ?4`,
      ).bind(ids.at(-1), ids.length, jobId, job.cursor ?? ''),
    ]);
  }
  await env.JOBS_QUEUE.send({ type: 'bulk', jobId });
}
