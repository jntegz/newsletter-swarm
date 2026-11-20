import { env } from 'cloudflare:test';
import {
  IMPORT_ATTESTATION_TEXT,
  IMPORT_PENDING_DAYS,
  newId,
  type ImportReport,
  type ImportTarget,
} from '@swarm/domain';
import { channelFields, emailHash, readFieldValues } from '@swarm/engine';
import { beforeEach, describe, expect, it } from 'vitest';
import { analyzeImport, runImport } from '../src/handlers/imports';
import { expirePendingImports } from '../src/handlers/maintenance';
import {
  addField,
  addMember,
  count,
  jobsEnv,
  one,
  seedChannel,
  seedImport,
  testFieldVault,
} from './helpers';

const COLUMNS = ['Email', 'First name', 'Plan', 'Tags', 'Secret'];
const MAP: Record<string, ImportTarget> = {
  Email: 'email',
  'First name': 'first_name',
  Plan: 'field:plan',
  Tags: 'tags',
  Secret: 'field:secret',
};
const CSV = [
  'Email,First name,Plan,Tags,Secret',
  'new1@example.com,Nia,weekly,vip;beta,s1', // new
  'NEW2@Example.com,,Monthly,,', // new (address normalised)
  'not-an-email,X,,,', // invalid
  ',Empty,,,', // invalid
  'info@example.com,,,,', // role
  'someone@mailinator.com,,,,', // disposable
  'suppressed@example.com,,,,', // suppressed
  'new1@example.com,Dup,,,', // duplicate
  'same@example.com,Ada,,,', // unchanged
  'differs@example.com,Grace,,,', // updated
  'badfield@example.com,,Yearly,,', // new, with a field error
  '',
].join('\r\n');

let seed: { workspaceId: string; channelId: string };

async function report(jobId: string): Promise<ImportReport> {
  const row = await one<{ report_json: string }>(
    'SELECT report_json FROM import_jobs WHERE id = ?1',
    jobId,
  );
  return JSON.parse(row!.report_json) as ImportReport;
}

beforeEach(async () => {
  seed = await seedChannel();
  await addField(seed.channelId, 'plan', 'select', { choices: ['Weekly', 'Monthly'] });
  await addField(seed.channelId, 'secret', 'text', { encrypted: true });
  await addMember(seed.channelId, 'same@example.com', { firstName: 'Ada' });
  await addMember(seed.channelId, 'differs@example.com', { firstName: 'Old' });
  await env.DB.prepare(
    "INSERT INTO suppressions (id, workspace_id, email, reason, created_at) VALUES (?1, ?2, 'Suppressed@Example.com', 'hard_bounce', 0)",
  )
    .bind(newId('suppression'), seed.workspaceId)
    .run();
});

describe('import dry run', () => {
  it('puts every row in exactly one class, with samples, and writes nothing', async () => {
    const { env: jobs } = jobsEnv();
    const jobId = await seedImport(seed, CSV, COLUMNS, MAP, { update: true });
    await analyzeImport(jobs, jobId, { chunkRows: 3 });

    const job = await one<{ status: string; total_rows: number }>(
      'SELECT status, total_rows FROM import_jobs WHERE id = ?1',
      jobId,
    );
    expect(job).toEqual({ status: 'analyzed', total_rows: 11 });
    const r = await report(jobId);
    expect(r.counts).toEqual({
      new: 3,
      updated: 1,
      unchanged: 1,
      invalid: 2,
      role: 1,
      disposable: 1,
      suppressed: 1,
      duplicate: 1,
    });
    expect(r.total).toBe(11);
    expect(r.samples.new.map((s) => s.email)).toEqual([
      'new1@example.com',
      'new2@example.com',
      'badfield@example.com',
    ]);
    expect(r.samples.duplicate[0]).toMatchObject({ line: 9, email: 'new1@example.com' });
    expect(r.samples.invalid.map((s) => s.line)).toEqual([4, 5]);
    expect(r.samples.updated[0]!.email).toBe('differs@example.com');
    expect(r.fieldErrors).toBe(1);
    expect(r.fieldErrorSamples[0]!.reason).toContain('plan');
    expect(r.warmImport).toBe(false);
    expect(
      await count('SELECT count(*) AS n FROM members WHERE channel_id = ?1', seed.channelId),
    ).toBe(2);
  });

  it('counts existing Members as unchanged when updates are off', async () => {
    const { env: jobs } = jobsEnv();
    const jobId = await seedImport(seed, CSV, COLUMNS, MAP, { update: false });
    await analyzeImport(jobs, jobId);
    const r = await report(jobId);
    expect(r.counts.updated).toBe(0);
    expect(r.counts.unchanged).toBe(2);
  });

  it('skips columns named like Object.prototype members that the mapping leaves out', async () => {
    // Mappings stored before the API kept such columns have no entry for them.
    const { env: jobs } = jobsEnv();
    const columns = ['Email', 'constructor', '__proto__', 'toString'];
    const csv = 'Email,constructor,__proto__,toString\r\nnew1@example.com,a,b,c\r\n';
    const jobId = await seedImport(seed, csv, columns, { Email: 'email' });
    await analyzeImport(jobs, jobId);
    expect(await one('SELECT status, error FROM import_jobs WHERE id = ?1', jobId)).toEqual({
      status: 'analyzed',
      error: null,
    });
    expect((await report(jobId)).counts.new).toBe(1);
  });

  it('reads files without a header, with a BOM, semicolons and quoted newlines', async () => {
    const { env: jobs } = jobsEnv();
    const csv = '﻿a@example.com;"Line\nbreak"\r\nb@example.com;"Q ""x"""\r\n';
    const jobId = await seedImport(
      seed,
      csv,
      ['Column 1', 'Column 2'],
      {
        'Column 1': 'email',
        'Column 2': 'first_name',
      },
      { status: 'importing', consent: true },
    );
    await runImport(jobs, jobId);
    const names = await env.DB.prepare(
      'SELECT email, first_name FROM members WHERE channel_id = ?1 AND import_id = ?2 ORDER BY email',
    )
      .bind(seed.channelId, jobId)
      .all<{ email: string; first_name: string }>();
    expect(names.results).toEqual([
      { email: 'a@example.com', first_name: 'Line\nbreak' },
      { email: 'b@example.com', first_name: 'Q "x"' },
    ]);
  });

  it('fails cleanly when the file is gone', async () => {
    const { env: jobs } = jobsEnv();
    const jobId = await seedImport(seed, CSV, COLUMNS, MAP);
    const { r2_key } = (await one<{ r2_key: string }>(
      'SELECT r2_key FROM import_jobs WHERE id = ?1',
      jobId,
    ))!;
    await env.IMPORTS.delete(r2_key);
    await analyzeImport(jobs, jobId);
    expect(await one('SELECT status, error FROM import_jobs WHERE id = ?1', jobId)).toEqual({
      status: 'failed',
      error: 'The uploaded file is no longer available.',
    });
  });
});

describe('import', () => {
  it('creates and updates Members, tags them and stores fields, encrypted where marked', async () => {
    const { env: jobs } = jobsEnv();
    const jobId = await seedImport(seed, CSV, COLUMNS, MAP, {
      update: true,
      consent: true,
      status: 'importing',
    });
    await runImport(jobs, jobId);

    const job = await one<{ status: string; processed_rows: number; report_json: string }>(
      'SELECT status, processed_rows, report_json FROM import_jobs WHERE id = ?1',
      jobId,
    );
    expect(job?.status).toBe('done');
    expect(job?.processed_rows).toBe(11);
    expect(JSON.parse(job!.report_json).result).toEqual({ created: 3, updated: 1, skipped: 7 });

    const nia = await one<{
      id: string;
      status: string;
      consent_at: number | null;
      import_id: string;
      source_json: string;
    }>(
      "SELECT id, status, consent_at, import_id, source_json FROM members WHERE email = 'new1@example.com' AND channel_id = ?1",
      seed.channelId,
    );
    expect(nia).toMatchObject({ status: 'active', import_id: jobId });
    expect(nia?.consent_at).not.toBeNull();
    expect(JSON.parse(nia!.source_json)).toEqual({ import_id: jobId });
    // The Flow trigger: a welcome Flow enrols imported Members only when it asks to.
    const joined = await one<{ payload_json: string }>(
      `SELECT payload_json FROM member_events WHERE member_id = ?1 AND type = 'member_joined'`,
      nia!.id,
    );
    expect(JSON.parse(joined!.payload_json)).toMatchObject({ source: 'import', importId: jobId });
    const tags = await env.DB.prepare(
      'SELECT t.name FROM member_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.member_id = ?1 ORDER BY t.name',
    )
      .bind(nia!.id)
      .all<{ name: string }>();
    expect(tags.results.map((t) => t.name)).toEqual(['beta', `import:${jobId}`, 'vip']);

    const fields = await channelFields(env.DB, seed.channelId);
    const stored = await one<{ value_text: string | null; value_enc: string | null }>(
      'SELECT value_text, value_enc FROM member_field_values WHERE member_id = ?1 AND field_id = ?2',
      nia!.id,
      fields.get('secret')!.id,
    );
    expect(stored?.value_text).toBeNull();
    expect(stored?.value_enc).toMatch(/^f1\./);
    const values = await readFieldValues(env.DB, [nia!.id], fields, testFieldVault(fields));
    expect(values.get(nia!.id)).toEqual({ plan: 'Weekly', secret: 's1' });

    // The bad cell was left out; the row still imported.
    const bad = await one<{ id: string }>(
      "SELECT id FROM members WHERE email = 'badfield@example.com' AND channel_id = ?1",
      seed.channelId,
    );
    expect(bad).not.toBeNull();
    expect(
      await count('SELECT count(*) AS n FROM member_field_values WHERE member_id = ?1', bad!.id),
    ).toBe(0);

    const grace = await one<{ first_name: string }>(
      "SELECT first_name FROM members WHERE email = 'differs@example.com' AND channel_id = ?1",
      seed.channelId,
    );
    expect(grace?.first_name).toBe('Grace');
    for (const email of ['info@example.com', 'someone@mailinator.com', 'suppressed@example.com']) {
      expect(
        await count(
          'SELECT count(*) AS n FROM members WHERE email = ?1 AND channel_id = ?2',
          email,
          seed.channelId,
        ),
      ).toBe(0);
    }
  });

  it('creates no tag for a row it skips', async () => {
    const { env: jobs } = jobsEnv();
    const csv = [
      'Email,First name,Plan,Tags,Secret',
      'kept@example.com,,,keep,',
      'not-an-email,,,ghost,',
      'info@example.com,,,ghost2,',
      '',
    ].join('\r\n');
    const jobId = await seedImport(seed, csv, COLUMNS, MAP, { consent: true, status: 'importing' });
    await runImport(jobs, jobId);
    const tags = await env.DB.prepare('SELECT name FROM tags WHERE channel_id = ?1 ORDER BY name')
      .bind(seed.channelId)
      .all<{ name: string }>();
    expect(tags.results.map((t) => t.name)).toEqual([`import:${jobId}`, 'keep']);
  });

  it('imports as pending anyone who unsubscribed and was then deleted, even when attested', async () => {
    const { env: jobs } = jobsEnv();
    const hash = await emailHash('came-back@example.com');
    await env.DB.prepare(
      'INSERT INTO left_addresses (channel_id, email_hash, left_at) VALUES (?1, ?2, 0)',
    )
      .bind(seed.channelId, hash)
      .run();
    const jobId = await seedImport(
      seed,
      'Email\r\ncame-back@example.com\r\nfresh@example.com\r\n',
      ['Email'],
      { Email: 'email' },
      { consent: true },
    );
    await env.DB.prepare("UPDATE import_jobs SET status = 'importing' WHERE id = ?1")
      .bind(jobId)
      .run();
    await runImport(jobs, jobId);
    const statusOf = (email: string) =>
      one<{ status: string }>('SELECT status FROM members WHERE email = ?1', email);
    expect(await statusOf('came-back@example.com')).toEqual({ status: 'pending' });
    expect(await statusOf('fresh@example.com')).toEqual({ status: 'active' });
  });

  it('records the attestation and who made it as each new subscriber’s consent record', async () => {
    const { env: jobs } = jobsEnv();
    const jobId = await seedImport(
      seed,
      'Email\r\nattested@example.com\r\nsame@example.com\r\n',
      ['Email'],
      { Email: 'email' },
      { consent: true, status: 'importing' },
    );
    await env.DB.prepare('UPDATE import_jobs SET consent_attested_by = ?1 WHERE id = ?2')
      .bind('op_0123456789abcdef0123456789abcdef', jobId)
      .run();
    await runImport(jobs, jobId);
    const consents = (email: string) =>
      env.DB.prepare(
        `SELECT k.source, k.wording, k.ticked, k.must_confirm, k.attested_by FROM member_consents k
           JOIN members m ON m.id = k.member_id WHERE m.email = ?1 AND m.channel_id = ?2`,
      )
        .bind(email, seed.channelId)
        .all();
    expect((await consents('attested@example.com')).results).toEqual([
      {
        source: 'import',
        wording: IMPORT_ATTESTATION_TEXT,
        ticked: 1,
        must_confirm: 0,
        attested_by: 'op_0123456789abcdef0123456789abcdef',
      },
    ]);
    // An existing subscriber the import didn't create gets no new record.
    expect((await consents('same@example.com')).results).toEqual([]);
  });

  it('imports as pending without a consent attestation', async () => {
    const { env: jobs } = jobsEnv();
    const jobId = await seedImport(
      seed,
      'email\nquiet@example.com\n',
      ['email'],
      { email: 'email' },
      {
        status: 'importing',
      },
    );
    await runImport(jobs, jobId);
    expect(
      await one(
        'SELECT status, consent_at FROM members WHERE email = ?1 AND channel_id = ?2',
        'quiet@example.com',
        seed.channelId,
      ),
    ).toEqual({ status: 'pending', consent_at: null });
  });

  it('runs in chunks, resumes from the byte cursor and is idempotent when replayed', async () => {
    const { env: jobs, queue } = jobsEnv();
    const rows = [
      'email',
      ...Array.from({ length: 7 }, (_, i) => `p${i}@example.com`),
      'p0@example.com',
    ];
    const jobId = await seedImport(
      seed,
      `${rows.join('\n')}\n`,
      ['email'],
      { email: 'email' },
      {
        status: 'importing',
        consent: true,
      },
    );

    await runImport(jobs, jobId, { chunkRows: 3, maxChunks: 1 });
    let job = await one<{ status: string; cursor: number; processed_rows: number }>(
      'SELECT status, cursor, processed_rows FROM import_jobs WHERE id = ?1',
      jobId,
    );
    expect(job).toMatchObject({ status: 'importing', processed_rows: 3 });
    expect(job!.cursor).toBeGreaterThan(0);
    expect(queue.items).toEqual([{ type: 'import_run', jobId }]);
    expect(await count('SELECT count(*) AS n FROM members WHERE import_id = ?1', jobId)).toBe(3);

    // A redelivered message for the same chunk finds the cursor already moved and continues.
    while (queue.items.length) {
      queue.items.shift();
      await runImport(jobs, jobId, { chunkRows: 3, maxChunks: 1 });
    }
    job = await one('SELECT status, cursor, processed_rows FROM import_jobs WHERE id = ?1', jobId);
    expect(job).toMatchObject({ status: 'done', processed_rows: 8 });
    expect(await count('SELECT count(*) AS n FROM members WHERE import_id = ?1', jobId)).toBe(7);

    // Replaying the whole file (as if every cursor move were lost) changes nothing.
    await env.DB.prepare("UPDATE import_jobs SET status = 'importing', cursor = 0 WHERE id = ?1")
      .bind(jobId)
      .run();
    await runImport(jobs, jobId, { chunkRows: 3 });
    expect(
      await count('SELECT count(*) AS n FROM members WHERE channel_id = ?1', seed.channelId),
    ).toBe(9);
    const result = JSON.parse(
      (await one<{ report_json: string }>(
        'SELECT report_json FROM import_jobs WHERE id = ?1',
        jobId,
      ))!.report_json,
    ).result;
    expect(result.created).toBe(7);
  });

  it('stops when the import is canceled', async () => {
    const { env: jobs } = jobsEnv();
    const jobId = await seedImport(
      seed,
      'email\nx@example.com\n',
      ['email'],
      { email: 'email' },
      {
        status: 'canceled',
      },
    );
    await runImport(jobs, jobId);
    expect(await count('SELECT count(*) AS n FROM members WHERE import_id = ?1', jobId)).toBe(0);
  });
});

describe('pending imported subscribers', () => {
  it('are deleted after the waiting period unless they confirmed or a confirmation is open', async () => {
    const { env: jobs } = jobsEnv();
    const jobId = await seedImport(
      seed,
      'email\nstale@example.com\nwaiting@example.com\nrecent@example.com\nconfirmed@example.com\n',
      ['email'],
      { email: 'email' },
      { status: 'importing' },
    );
    await runImport(jobs, jobId);
    const now = Date.now();
    const old = now - (IMPORT_PENDING_DAYS + 1) * 86_400_000;
    const idOf = async (email: string) =>
      (await one<{ id: string }>(
        'SELECT id FROM members WHERE email = ?1 AND channel_id = ?2',
        email,
        seed.channelId,
      ))!.id;
    for (const email of ['stale@example.com', 'waiting@example.com', 'confirmed@example.com']) {
      await env.DB.prepare('UPDATE members SET created_at = ?1 WHERE id = ?2')
        .bind(old, await idOf(email))
        .run();
    }
    // One was sent a confirmation that is still open; one confirmed and is active.
    await env.DB.prepare(
      `INSERT INTO confirm_requests (id, member_id, channel_id, last_sent_at, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?4)`,
    )
      .bind(
        newId('confirmRequest'),
        await idOf('waiting@example.com'),
        seed.channelId,
        now,
        now + 86_400_000,
      )
      .run();
    await env.DB.prepare("UPDATE members SET status = 'active', confirmed_at = ?1 WHERE id = ?2")
      .bind(now, await idOf('confirmed@example.com'))
      .run();
    // A subscriber added another way is never touched by this.
    const manual = await addMember(seed.channelId, 'manual-pending@example.com', {
      status: 'pending',
    });
    await env.DB.prepare('UPDATE members SET created_at = ?1 WHERE id = ?2')
      .bind(old, manual)
      .run();
    const staleId = await idOf('stale@example.com');

    expect(await expirePendingImports(jobs, now)).toBe(1);
    const left = async (email: string) =>
      count(
        'SELECT count(*) AS n FROM members WHERE email = ?1 AND channel_id = ?2',
        email,
        seed.channelId,
      );
    expect(await left('stale@example.com')).toBe(0);
    expect(await left('waiting@example.com')).toBe(1);
    expect(await left('recent@example.com')).toBe(1);
    expect(await left('confirmed@example.com')).toBe(1);
    expect(await left('manual-pending@example.com')).toBe(1);
    // A member.deleted event for webhooks, and one audit entry for the Channel.
    expect(
      await count(
        "SELECT count(*) AS n FROM platform_events WHERE type = 'member.deleted' AND json_extract(payload_json, '$.id') = ?1",
        staleId,
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_events WHERE action = 'members.pending_imports_deleted' AND target_id = ?1",
        seed.channelId,
      ),
    ).toBe(1);
    // Nothing more on a second run.
    expect(await expirePendingImports(jobs, now)).toBe(0);
  });
});
