// Imports, exports and bulk actions through the API. The jobs themselves are tested in
// workers/jobs; here: upload checks, mapping, state guards, warm-import routing, signed downloads.
import { env } from 'cloudflare:test';
import type { BulkJob, ExportJob, ImportJob } from '@swarm/domain';
import { newId } from '@swarm/domain';
import { parseKeyring, signToken } from '@swarm/tokens';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addField,
  addMember,
  csvForm,
  data,
  finishedExport,
  markAnalyzed,
  upload,
} from './audience-helpers';
import { call, createChannel, json, pngBytes, seatAs, signIn, type Session } from './helpers';

let owner: Session;
let channelId: string;

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
});

const mapping = (importId: string, body: Record<string, unknown>) =>
  call('PUT', `/api/v1/imports/${importId}/mapping`, {
    cookie: owner.cookie,
    body: { consentAttested: false, updateExisting: false, ...body },
  });

describe('import upload', () => {
  it('detects headers and suggests a mapping', async () => {
    await addField(owner, channelId, { key: 'city', label: 'Home city', type: 'text' });
    const job = await upload(
      owner,
      channelId,
      '﻿E-mail Address;First Name;Surname;Home City;Notes;Tags\r\nada@example.com;Ada;Lovelace;London;x;vip\r\n',
    );
    expect(job).toMatchObject({
      status: 'uploaded',
      columns: ['E-mail Address', 'First Name', 'Surname', 'Home City', 'Notes', 'Tags'],
      mapping: {
        'E-mail Address': 'email',
        'First Name': 'first_name',
        Surname: 'last_name',
        'Home City': 'field:city',
        Notes: null,
        Tags: 'tags',
      },
      consentAttested: false,
      report: null,
    });
    const stored = await env.IMPORTS.get(
      (await env.DB.prepare('SELECT r2_key FROM import_jobs WHERE id = ?1')
        .bind(job.id)
        .first<{ r2_key: string }>())!.r2_key,
    );
    expect(await stored?.text()).toContain('ada@example.com');
  });

  it('suggests nothing for columns named like Object.prototype members, and keeps them', async () => {
    // Header names come from the file; none of these may find a built-in or drop out.
    const job = await upload(
      owner,
      channelId,
      'Email,Constructor,__proto__,toString\r\nada@example.com,a,b,c\r\n',
    );
    expect(job.columns).toEqual(['Email', 'Constructor', '__proto__', 'toString']);
    expect(job.mapping).toEqual({
      Email: 'email',
      Constructor: null,
      ['__proto__']: null,
      toString: null,
    });
  });

  it('recognises a file without a header row', async () => {
    const job = await upload(owner, channelId, 'Ada,ada@example.com\nAlan,alan@example.com\n');
    expect(job.columns).toEqual(['Column 1', 'Column 2']);
    expect(job.mapping).toEqual({ 'Column 1': null, 'Column 2': 'email' });
  });

  it('refuses files that are not CSV, and empty files', async () => {
    const png = await call('POST', `/api/v1/channels/${channelId}/imports`, {
      cookie: owner.cookie,
      form: csvForm(new TextDecoder('latin1').decode(pngBytes()), 'image.csv'),
    });
    expect(png.status).toBe(415);
    const xlsx = await call('POST', `/api/v1/channels/${channelId}/imports`, {
      cookie: owner.cookie,
      form: csvForm(
        'email\n',
        'list.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    });
    expect(xlsx.status).toBe(415);
    const empty = await call('POST', `/api/v1/channels/${channelId}/imports`, {
      cookie: owner.cookie,
      form: csvForm(''),
    });
    expect(empty.status).toBe(400);
  });
});

describe('import mapping and steps', () => {
  it('validates the mapping', async () => {
    const job = await upload(owner, channelId, 'email,name,other\na@example.com,A,x\n');
    const noEmail = await mapping(job.id, { mapping: { email: null } });
    expect(noEmail.status).toBe(400);
    const unknownColumn = await mapping(job.id, {
      mapping: { email: 'email', nope: 'first_name' },
    });
    expect(unknownColumn.status).toBe(400);
    const unknownField = await mapping(job.id, {
      mapping: { email: 'email', name: 'field:missing' },
    });
    expect(unknownField.status).toBe(400);
    const twice = await mapping(job.id, {
      mapping: { email: 'email', name: 'first_name', other: 'first_name' },
    });
    expect(twice.status).toBe(400);
    const saved = await data<ImportJob>(
      await mapping(job.id, {
        mapping: { email: 'email', name: 'first_name' },
        consentAttested: true,
        updateExisting: true,
      }),
    );
    expect(saved).toMatchObject({
      mapping: { email: 'email', name: 'first_name', other: null },
      consentAttested: true,
      updateExisting: true,
    });
    // Who attested, for each imported subscriber's consent record.
    const attested = await env.DB.prepare(
      'SELECT consent_attested_by FROM import_jobs WHERE id = ?1',
    )
      .bind(job.id)
      .first<{ consent_attested_by: string | null }>();
    expect(attested?.consent_attested_by).toBe(owner.me.operator.id);
  });

  it('runs the dry run once at a time and only imports after it', async () => {
    const job = await upload(owner, channelId, 'email\na@example.com\n');
    const early = await call('POST', `/api/v1/imports/${job.id}/confirm`, { cookie: owner.cookie });
    expect(early.status).toBe(409);
    const analyzing = await data<ImportJob>(
      await call('POST', `/api/v1/imports/${job.id}/analyze`, { cookie: owner.cookie }),
      202,
    );
    expect(analyzing.status).toBe('analyzing');
    const again = await call('POST', `/api/v1/imports/${job.id}/analyze`, { cookie: owner.cookie });
    expect(again.status).toBe(409);
    expect((await mapping(job.id, { mapping: { email: 'email' } })).status).toBe(409);

    await markAnalyzed(job.id);
    // A new mapping makes the report stale.
    const remapped = await data<ImportJob>(await mapping(job.id, { mapping: { email: 'email' } }));
    expect(remapped).toMatchObject({ status: 'uploaded', report: null });

    await markAnalyzed(job.id);
    const importing = await data<ImportJob>(
      await call('POST', `/api/v1/imports/${job.id}/confirm`, { cookie: owner.cookie }),
      202,
    );
    expect(importing.status).toBe('importing');
    expect(
      (await call('POST', `/api/v1/imports/${job.id}/confirm`, { cookie: owner.cookie })).status,
    ).toBe(409);
  });

  it('cancels and deletes the file', async () => {
    const job = await upload(owner, channelId, 'email\na@example.com\n');
    const canceled = await data<ImportJob>(
      await call('POST', `/api/v1/imports/${job.id}/cancel`, { cookie: owner.cookie }),
    );
    expect(canceled.status).toBe('canceled');
    const { r2_key } = (await env.DB.prepare('SELECT r2_key FROM import_jobs WHERE id = ?1')
      .bind(job.id)
      .first<{ r2_key: string }>())!;
    expect(await env.IMPORTS.get(r2_key)).toBeNull();
    expect(
      (await call('POST', `/api/v1/imports/${job.id}/cancel`, { cookie: owner.cookie })).status,
    ).toBe(409);
  });

  it('routes 10,000+ new Members through a warm-import Reputation Ramp', async () => {
    const ch = (await createChannel(owner)).id;
    for (let i = 0; i < 3; i++) await addMember(owner, ch);
    const rampId = newId('reputationRamp');
    await env.DB.prepare(
      `INSERT INTO reputation_ramps (id, channel_id, status, day, cap_today, sent_today, start_cap, growth, max_cap,
         bounce_threshold, complaint_threshold, created_at, updated_at)
       VALUES (?1, ?2, 'complete', '2026-01-01', 5000, 12, 100, 1.3, 5000, 0.02, 0.0008, 0, 0)`,
    )
      .bind(rampId, ch)
      .run();

    const small = await upload(owner, ch, 'email\na@example.com\n');
    await markAnalyzed(small.id, 9_999);
    await data(
      await call('POST', `/api/v1/imports/${small.id}/confirm`, { cookie: owner.cookie }),
      202,
    );
    const untouched = await env.DB.prepare('SELECT status FROM reputation_ramps WHERE id = ?1')
      .bind(rampId)
      .first<{ status: string }>();
    expect(untouched?.status).toBe('complete');

    const big = await upload(owner, ch, 'email\na@example.com\n');
    await markAnalyzed(big.id, 20_000);
    await data(
      await call('POST', `/api/v1/imports/${big.id}/confirm`, { cookie: owner.cookie }),
      202,
    );
    const ramp = await env.DB.prepare(
      'SELECT status, cap_today, max_cap, sent_today, day FROM reputation_ramps WHERE id = ?1',
    )
      .bind(rampId)
      .first<{
        status: string;
        cap_today: number;
        max_cap: number;
        sent_today: number;
        day: string;
      }>();
    expect(ramp).toMatchObject({
      status: 'warming',
      cap_today: 100,
      max_cap: 20_003,
      sent_today: 0,
    });
    expect(ramp?.day).toBe(new Date().toISOString().slice(0, 10));
    const audit = await env.DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE action = 'members.import_confirmed' AND target_id = ?1",
    )
      .bind(big.id)
      .first<{ metadata_json: string }>();
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({ warmImport: true, rampIds: [rampId] });
  });
});

describe('exports', () => {
  it('queues an export and audits it; only a finished one has a link', async () => {
    const queued = await data<ExportJob>(
      await call('POST', `/api/v1/channels/${channelId}/exports`, {
        cookie: owner.cookie,
        body: { format: 'jsonl', status: 'active' },
      }),
      202,
    );
    expect(queued).toMatchObject({
      status: 'queued',
      downloadUrl: null,
      filter: { status: 'active' },
    });
    const audit = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_events WHERE action = 'members.export_created' AND target_id = ?1",
    )
      .bind(queued.id)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);

    const missingCircle = await call('POST', `/api/v1/channels/${channelId}/exports`, {
      cookie: owner.cookie,
      body: { format: 'csv', circleId: newId('circle') },
    });
    expect(missingCircle.status).toBe(404);
  });

  it('downloads through a signed link that also needs an admin session, and audits it', async () => {
    const exportId = await finishedExport(owner.workspaceId, channelId);
    const job = await data<ExportJob>(
      await call('GET', `/api/v1/exports/${exportId}`, { cookie: owner.cookie }),
    );
    expect(job.downloadUrl).toMatch(
      /^\/api\/v1\/exports\/ej_[0-9a-f]+\/download\?token=v1\.export\./,
    );

    const res = await call('GET', job.downloadUrl!, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="members-/);
    expect(await res.text()).toBe('id,email\r\nmb_1,a@example.com\r\n');
    const audit = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_events WHERE action = 'members.export_downloaded' AND target_id = ?1",
    )
      .bind(exportId)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);

    // The link alone is not enough: no session, or a role below admin, is refused.
    expect((await call('GET', job.downloadUrl!, { cookie: '' })).status).toBe(401);
    const editor = await seatAs(owner.workspaceId, 'editor');
    expect((await call('GET', job.downloadUrl!, { cookie: editor.cookie })).status).toBe(403);
  });

  it('refuses expired, cross-purpose and cross-export tokens', async () => {
    const keys = parseKeyring(env.AUTH_KEYS);
    const exportId = await finishedExport(owner.workspaceId, channelId);
    const otherId = await finishedExport(owner.workspaceId, channelId);
    const download = (token: string) =>
      call('GET', `/api/v1/exports/${exportId}/download?token=${token}`, { cookie: owner.cookie });

    const expired = await signToken(
      keys,
      'export',
      { exportId },
      {
        expiresInSeconds: 24 * 3600,
        now: Date.now() - 25 * 3600 * 1000,
      },
    );
    expect((await download(expired)).status).toBe(403);
    const wrongPurpose = await signToken(keys, 'confirm', { exportId }, { expiresInSeconds: 600 });
    expect((await download(wrongPurpose)).status).toBe(403);
    const otherExport = await signToken(
      keys,
      'export',
      { exportId: otherId },
      { expiresInSeconds: 600 },
    );
    expect((await download(otherExport)).status).toBe(403);
    expect((await download('garbage')).status).toBe(403);
    const valid = await signToken(keys, 'export', { exportId }, { expiresInSeconds: 600 });
    expect((await download(valid)).status).toBe(200);
  });

  it('stops offering a file once it has expired', async () => {
    const exportId = await finishedExport(owner.workspaceId, channelId, {
      expiresAt: Date.now() - 1,
    });
    const job = await data<ExportJob>(
      await call('GET', `/api/v1/exports/${exportId}`, { cookie: owner.cookie }),
    );
    expect(job.downloadUrl).toBeNull();
    const token = await signToken(
      parseKeyring(env.AUTH_KEYS),
      'export',
      { exportId },
      { expiresInSeconds: 600 },
    );
    const res = await call('GET', `/api/v1/exports/${exportId}/download?token=${token}`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(404);
  });
});

describe('bulk actions', () => {
  it('counts the selection and validates the action', async () => {
    const a = await addMember(owner, channelId);
    const b = await addMember(owner, channelId);
    const otherChannel = (await createChannel(owner)).id;
    const stranger = await addMember(owner, otherChannel);
    const job = await data<BulkJob>(
      await call('POST', `/api/v1/channels/${channelId}/bulk-jobs`, {
        cookie: owner.cookie,
        body: { selection: { memberIds: [a.id, b.id, b.id, stranger.id] }, action: 'unsubscribe' },
      }),
      202,
    );
    expect(job).toMatchObject({
      status: 'queued',
      total: 2,
      processed: 0,
      selection: { kind: 'members' },
    });
    const progress = await data<BulkJob>(
      await call('GET', `/api/v1/bulk-jobs/${job.id}`, { cookie: owner.cookie }),
    );
    expect(progress.id).toBe(job.id);

    const tooMany = await call('POST', `/api/v1/channels/${channelId}/bulk-jobs`, {
      cookie: owner.cookie,
      body: {
        selection: { memberIds: Array.from({ length: 1001 }, () => newId('member')) },
        action: 'delete',
      },
    });
    expect(tooMany.status).toBe(400);
    const noTag = await call('POST', `/api/v1/channels/${channelId}/bulk-jobs`, {
      cookie: owner.cookie,
      body: { selection: { memberIds: [a.id] }, action: 'tag' },
    });
    expect(noTag.status).toBe(400);
    await addField(owner, channelId, {
      key: 'size',
      label: 'Size',
      type: 'select',
      options: ['S', 'M'],
    });
    const badValue = await call('POST', `/api/v1/channels/${channelId}/bulk-jobs`, {
      cookie: owner.cookie,
      body: { selection: { memberIds: [a.id] }, action: 'set_field', field: 'size', value: 'XL' },
    });
    expect(badValue.status).toBe(400);
    const good = await data<BulkJob>(
      await call('POST', `/api/v1/channels/${channelId}/bulk-jobs`, {
        cookie: owner.cookie,
        body: { selection: { memberIds: [a.id] }, action: 'set_field', field: 'size', value: 'm' },
      }),
      202,
    );
    expect(good.params).toEqual({ field: 'size', value: 'M' });
    const foreignCircle = await call('POST', `/api/v1/channels/${channelId}/bulk-jobs`, {
      cookie: owner.cookie,
      body: { selection: { circleId: newId('circle') }, action: 'delete' },
    });
    expect(foreignCircle.status).toBe(404);
    expect((await json<{ error: { message: string } }>(foreignCircle)).error.message).toBe(
      'Segment not found.',
    );
  });
});
