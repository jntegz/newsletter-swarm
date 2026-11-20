import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { fieldValueStatements, parseCsv, prepareFieldValues, channelFields } from '@swarm/engine';
import { beforeEach, describe, expect, it } from 'vitest';
import { runExport } from '../src/handlers/exports';
import { maintainMembers } from '../src/handlers/maintenance';
import {
  addField,
  addMember,
  count,
  jobsEnv,
  one,
  seedChannel,
  seedFeedAdmin,
  testFieldVault,
} from './helpers';

let seed: { workspaceId: string; channelId: string };

async function exportJob(
  format: 'csv' | 'jsonl',
  filter: Record<string, string> = {},
  requester?: string,
) {
  const id = newId('exportJob');
  // Asked for by an admin of the workspace: an export runs only while one stands behind it.
  const by = requester ?? (await seedFeedAdmin(seed.workspaceId));
  await env.DB.prepare(
    `INSERT INTO export_jobs (id, workspace_id, channel_id, format, filter_json, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(id, seed.workspaceId, seed.channelId, format, JSON.stringify(filter), by, Date.now())
    .run();
  return id;
}

/** The parts joined in key order, as the download route streams them. */
async function file(jobId: string): Promise<string> {
  const { r2_key } = (await one<{ r2_key: string }>(
    'SELECT r2_key FROM export_jobs WHERE id = ?1',
    jobId,
  ))!;
  const listed = await env.EXPORTS.list({ prefix: r2_key });
  let text = '';
  for (const key of listed.objects.map((o) => o.key).sort()) {
    text += await (await env.EXPORTS.get(key))!.text();
  }
  return text;
}

beforeEach(async () => {
  seed = await seedChannel();
  await addField(seed.channelId, 'secret', 'text', { encrypted: true });
  const fields = await channelFields(env.DB, seed.channelId);
  for (let i = 0; i < 5; i++) {
    const id = await addMember(seed.channelId, `e${i}@example.com`, {
      firstName: i === 0 ? '=cmd()' : `N${i}`,
      status: i === 4 ? 'unsubscribed' : 'active',
    });
    const values = await prepareFieldValues(
      fields,
      { secret: `s${i}` },
      testFieldVault(fields),
      id,
    );
    await env.DB.batch(fieldValueStatements(env.DB, id, values, Date.now()));
  }
});

describe('exports', () => {
  it('writes CSV in resumable chunks, with decrypted fields and formulas neutralised', async () => {
    const { env: jobs, queue } = jobsEnv();
    const jobId = await exportJob('csv');
    await runExport(jobs, jobId, { chunkSize: 2, maxChunks: 2 });
    expect(queue.items).toEqual([{ type: 'export', jobId }]);
    expect(await one('SELECT status, row_count FROM export_jobs WHERE id = ?1', jobId)).toEqual({
      status: 'running',
      row_count: 2,
    });
    await runExport(jobs, jobId, { chunkSize: 2 });
    const job = await one<{ status: string; row_count: number; expires_at: number }>(
      'SELECT status, row_count, expires_at FROM export_jobs WHERE id = ?1',
      jobId,
    );
    expect(job).toMatchObject({ status: 'done', row_count: 5 });
    expect(job!.expires_at).toBeGreaterThan(Date.now());

    const rows = parseCsv(await file(jobId));
    expect(rows[0]).toContain('field:secret');
    expect(rows).toHaveLength(6);
    const secret = rows[0]!.indexOf('field:secret');
    // Ids order the file; members made in the same millisecond may sort either way.
    const byEmail = new Map(rows.slice(1).map((r) => [r[1], r]));
    expect([...byEmail.keys()].sort()).toEqual([0, 1, 2, 3, 4].map((i) => `e${i}@example.com`));
    expect(rows.slice(1).map((r) => r[0])).toEqual(
      rows
        .slice(1)
        .map((r) => r[0])
        .sort(),
    );
    for (let i = 0; i < 5; i++) expect(byEmail.get(`e${i}@example.com`)![secret]).toBe(`s${i}`);
    expect(byEmail.get('e0@example.com')![2]).toBe("'=cmd()");
  });

  it('writes JSONL, filtered by status', async () => {
    const { env: jobs } = jobsEnv();
    const jobId = await exportJob('jsonl', { status: 'unsubscribed' });
    await runExport(jobs, jobId);
    const lines = (await file(jobId))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      email: 'e4@example.com',
      status: 'unsubscribed',
      fields: { secret: 's4' },
    });
  });

  it('leaves a field named like an Object.prototype member empty for Members without it', async () => {
    // "constructor" is a valid field key; nobody here has a value for it.
    await addField(seed.channelId, 'constructor', 'text');
    const { env: jobs } = jobsEnv();
    const csvId = await exportJob('csv');
    await runExport(jobs, csvId);
    const rows = parseCsv(await file(csvId));
    const column = rows[0]!.indexOf('field:constructor');
    expect(column).toBeGreaterThan(0);
    expect(rows.slice(1).map((r) => r[column])).toEqual(['', '', '', '', '']);

    const jsonlId = await exportJob('jsonl');
    await runExport(jobs, jsonlId);
    const lines = (await file(jsonlId))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { fields: Record<string, unknown> });
    for (const line of lines) expect(line.fields).toMatchObject({ constructor: null });
  });

  it('filters by Circle and still downloads when empty', async () => {
    const { env: jobs } = jobsEnv();
    const circleId = newId('circle');
    await env.DB.prepare(
      `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Empty', '{}', 0, 0)`,
    )
      .bind(circleId, seed.workspaceId, seed.channelId)
      .run();
    const jobId = await exportJob('csv', { circleId });
    await runExport(jobs, jobId);
    const rows = parseCsv(await file(jobId));
    expect(rows).toHaveLength(1); // the header
  });
});

describe('maintenance', () => {
  it('resumes ended pauses and deletes expired exports and old import files', async () => {
    const now = Date.now();
    const ended = await addMember(seed.channelId, 'ended@example.com', {
      status: 'paused',
      pausedUntil: now - 1,
    });
    const later = await addMember(seed.channelId, 'later@example.com', {
      status: 'paused',
      pausedUntil: now + 60_000,
    });

    const { env: jobs } = jobsEnv();
    const jobId = await exportJob('csv');
    await runExport(jobs, jobId);
    const { r2_key } = (await one<{ r2_key: string }>(
      'SELECT r2_key FROM export_jobs WHERE id = ?1',
      jobId,
    ))!;
    await env.DB.prepare('UPDATE export_jobs SET expires_at = ?1 WHERE id = ?2')
      .bind(now - 1, jobId)
      .run();

    const importId = newId('importJob');
    const importKey = `imports-test/${importId}.csv`;
    await env.IMPORTS.put(importKey, 'email\n');
    await env.DB.prepare(
      `INSERT INTO import_jobs (id, workspace_id, channel_id, status, file_name, r2_key, bytes, created_at, updated_at, completed_at)
       VALUES (?1, ?2, ?3, 'done', 'a.csv', ?4, 6, 0, 0, ?5)`,
    )
      .bind(importId, seed.workspaceId, seed.channelId, importKey, now - 8 * 86_400_000)
      .run();

    await maintainMembers(jobs, now);
    expect(await one('SELECT status, paused_until FROM members WHERE id = ?1', ended)).toEqual({
      status: 'active',
      paused_until: null,
    });
    expect(
      await one<{ status: string }>('SELECT status FROM members WHERE id = ?1', later),
    ).toEqual({
      status: 'paused',
    });
    expect((await env.EXPORTS.list({ prefix: r2_key })).objects).toHaveLength(0);
    expect(
      await count('SELECT count(*) AS n FROM export_jobs WHERE id = ?1 AND r2_key IS NULL', jobId),
    ).toBe(1);
    expect(await env.IMPORTS.get(importKey)).toBeNull();
  });
});

describe('an export after its requester loses authority (S04-P1-V-export-authority-loss)', () => {
  const parts = async (jobId: string) =>
    (await env.EXPORTS.list({ prefix: `ws/${seed.workspaceId}/ch/${seed.channelId}/${jobId}/` }))
      .objects.length;
  const state = (jobId: string) =>
    one<{ status: string; error: string | null; expires_at: number | null }>(
      'SELECT status, error, expires_at FROM export_jobs WHERE id = ?1',
      jobId,
    );

  async function stoppedAfterFirstChunk(change: (requester: string) => Promise<void>) {
    const requester = await seedFeedAdmin(seed.workspaceId);
    const id = await exportJob('csv', {}, requester);
    const { env: jobs } = jobsEnv();
    // The header and one chunk, as a run that is cut short would leave them.
    await runExport(jobs, id, { chunkSize: 2, maxChunks: 2 });
    expect(await parts(id)).toBeGreaterThan(0);
    await change(requester);
    await runExport(jobs, id, { chunkSize: 2 });
    return id;
  }

  it('stops, says why and leaves no part when the requester’s seat is removed', async () => {
    const id = await stoppedAfterFirstChunk((op) =>
      env.DB.prepare('DELETE FROM seats WHERE operator_id = ?1')
        .bind(op)
        .run()
        .then(() => {}),
    );
    expect(await state(id)).toMatchObject({ status: 'failed', expires_at: null });
    expect((await state(id))?.error).toContain('no longer has the admin role');
    expect(await parts(id)).toBe(0);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM audit_events WHERE target_id = ?1 AND action = 'export.stopped'",
        id,
      ),
    ).toBe(1);
  });

  it('stops when the requester is demoted below admin', async () => {
    const id = await stoppedAfterFirstChunk((op) =>
      env.DB.prepare("UPDATE seats SET role = 'editor' WHERE operator_id = ?1")
        .bind(op)
        .run()
        .then(() => {}),
    );
    expect((await state(id))?.status).toBe('failed');
    expect(await parts(id)).toBe(0);
  });

  it('stops when the Channel is deleted', async () => {
    const id = await stoppedAfterFirstChunk(async () => {
      await env.DB.prepare('UPDATE channels SET deleted_at = ?1 WHERE id = ?2')
        .bind(Date.now(), seed.channelId)
        .run();
    });
    expect((await state(id))?.error).toContain('publication was deleted');
    expect(await parts(id)).toBe(0);
  });

  it('an export whose requester keeps the role finishes as before', async () => {
    const id = await exportJob('csv');
    const { env: jobs } = jobsEnv();
    await runExport(jobs, id, { chunkSize: 2 });
    expect((await state(id))?.status).toBe('done');
    expect(await parts(id)).toBeGreaterThan(1);
  });
});
