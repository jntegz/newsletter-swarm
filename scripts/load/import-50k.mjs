#!/usr/bin/env node
// Phase 3 exit gate, locally: uploads a 50,000-row CSV through the import API, checks the dry run
// counts every class exactly, confirms it, waits for the jobs worker to finish and checks what is
// in D1, including the Reputation Ramp going back to warming. See docs/load-testing.md.
//
//   pnpm load:import [--rows 50000] [--keep]
//
// Exit status: 0 pass, 1 fail. Local D1 only: this says nothing about Cloudflare's own timings.
import { parseArgs } from 'node:util';
import { sleep, stack } from './local-stack.mjs';

const { values } = parseArgs({
  options: {
    rows: { type: 'string', default: '50000' },
    keep: { type: 'boolean', default: false },
  },
});
const ROWS = Number(values.rows);
// Below this the file has fewer than 10,000 new Members, so no warm import is due.
if (!Number.isInteger(ROWS) || ROWS < 13_000) throw new Error('--rows is at least 13,000.');

// The classes the file is built from. Everything left over is plainly new.
const EXISTING_SAME = 200;
const EXISTING_CHANGED = 200;
const counts = {
  invalid: 500,
  role: 300,
  disposable: 300,
  suppressed: 300,
  duplicate: 500,
  unchanged: EXISTING_SAME,
  updated: EXISTING_CHANGED,
};
const FIELD_ERRORS = 100;
counts.new = ROWS - Object.values(counts).reduce((a, b) => a + b, 0);

/** Deterministic shuffle, so every chunk holds a mix of classes and a rerun is the same file. */
function shuffle(list) {
  let seed = 42;
  const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function buildCsv() {
  const rows = [];
  const add = (email, first = '', plan = '', tags = '') =>
    rows.push(`${email},${first},${plan},${tags}`);
  for (let i = 0; i < counts.new; i++) {
    const bad = i < FIELD_ERRORS;
    add(
      `new${i}@example.org`,
      `Reader${i}`,
      bad ? 'Yearly' : i % 2 ? 'Free' : 'Pro',
      `list${i % 5}`,
    );
  }
  for (let i = 0; i < counts.invalid; i++) add(i % 2 ? `not-an-email-${i}` : '', 'Bad');
  for (let i = 0; i < counts.role; i++) add(`info@role${i}.example.org`);
  for (let i = 0; i < counts.disposable; i++) add(`throwaway${i}@mailinator.com`);
  for (let i = 0; i < counts.suppressed; i++) add(`blocked${i}@example.org`);
  for (let i = 0; i < EXISTING_SAME; i++) add(`same${i}@example.org`, 'Same');
  for (let i = 0; i < EXISTING_CHANGED; i++) add(`changed${i}@example.org`, 'New name');
  shuffle(rows);
  // Duplicates go last, so an earlier row always has the address.
  for (let i = 0; i < counts.duplicate; i++) add(`new${i + FIELD_ERRORS}@example.org`, 'Again');
  return `Email,First name,Plan,Tags\r\n${rows.join('\r\n')}\r\n`;
}

const problems = [];
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) problems.push(name);
  console.log(
    `${pass ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${pass ? '' : ` (wanted ${JSON.stringify(expected)})`}`,
  );
}

async function until(read, done, what, seconds = 1500) {
  const start = performance.now();
  for (;;) {
    const value = await read();
    if (done(value)) return { value, ms: performance.now() - start };
    if (performance.now() - start > seconds * 1000)
      throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

const local = stack();
try {
  await local.start();
  const stamp = Date.now().toString(36);
  const me = await local.signIn(`load-${stamp}@example.com`);
  const { workspaceId, channelId } = await local.channel(me, stamp);
  await local.call('POST', `/api/v1/channels/${channelId}/member-fields`, {
    key: 'plan',
    label: 'Plan',
    type: 'select',
    options: ['Free', 'Pro'],
  });
  await local.stop();

  // Seeded with the workers stopped: Members who already exist, suppressed addresses and a
  // Reputation Ramp that has finished warming, the case a large import must send back to warming.
  const now = Date.now();
  const db = local.openDb();
  db.exec('BEGIN');
  const id = (prefix, i) => `${prefix}_${i.toString(16).padStart(32, '0')}`;
  const member = db.prepare(
    `INSERT INTO members (id, channel_id, email, first_name, status, consent_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
  );
  for (let i = 0; i < EXISTING_SAME; i++) {
    member.run(id('mb', i + 1), channelId, `same${i}@example.org`, 'Same', now, now, now);
  }
  for (let i = 0; i < EXISTING_CHANGED; i++) {
    member.run(id('mb', 1000 + i), channelId, `changed${i}@example.org`, 'Old name', now, now, now);
  }
  const suppress = db.prepare(
    `INSERT INTO suppressions (id, workspace_id, email, reason, created_at) VALUES (?, ?, ?, 'hard_bounce', ?)`,
  );
  for (let i = 0; i < counts.suppressed; i++) {
    suppress.run(id('sp', i + 1), workspaceId, `blocked${i}@example.org`, now);
  }
  const rampId = id('rr', 1);
  db.prepare(
    `INSERT INTO reputation_ramps (id, channel_id, status, day, cap_today, sent_today, start_cap, growth, max_cap,
       bounce_threshold, complaint_threshold, created_at, updated_at)
     VALUES (?, ?, 'complete', '2026-01-01', 5000, 12, 100, 1.3, 5000, 0.02, 0.0008, ?, ?)`,
  ).run(rampId, channelId, now, now);
  db.exec('COMMIT');
  db.close();
  await local.start();

  const csv = buildCsv();
  console.log(`[import] ${ROWS.toLocaleString('en-US')} rows, ${(csv.length / 1e6).toFixed(1)} MB`);

  const form = new FormData();
  form.set('file', new File([csv], 'load.csv', { type: 'text/csv' }));
  let start = performance.now();
  const job = await local.call('POST', `/api/v1/channels/${channelId}/imports`, form);
  const uploadMs = performance.now() - start;
  await local.call('PUT', `/api/v1/imports/${job.id}/mapping`, {
    mapping: { Email: 'email', 'First name': 'first_name', Plan: 'field:plan', Tags: 'tags' },
    consentAttested: true,
    updateExisting: true,
  });

  await local.call('POST', `/api/v1/imports/${job.id}/analyze`);
  const analyzed = await until(
    () => local.call('GET', `/api/v1/imports/${job.id}`),
    (j) => j.status === 'analyzed' || j.status === 'failed',
    'the dry run',
  );
  check('dry run status', analyzed.value.status, 'analyzed');
  const report = analyzed.value.report;
  check('dry run total', report.total, ROWS);
  for (const key of Object.keys(counts).sort()) {
    check(`dry run ${key}`, report.counts[key], counts[key]);
  }
  check('dry run field errors', report.fieldErrors, FIELD_ERRORS);
  check('dry run calls for a warm import', report.warmImport, true);

  const read = local.openDb({ readOnly: true });
  const countMembers = () =>
    read.prepare('SELECT count(*) AS n FROM members WHERE channel_id = ?').get(channelId).n;
  check('dry run wrote no Members', countMembers(), EXISTING_SAME + EXISTING_CHANGED);

  start = performance.now();
  await local.call('POST', `/api/v1/imports/${job.id}/confirm`);
  const ramp = () =>
    read
      .prepare('SELECT status, cap_today, max_cap, sent_today FROM reputation_ramps WHERE id = ?')
      .get(rampId);
  const existing = EXISTING_SAME + EXISTING_CHANGED;
  // Read straight after confirming: the cap is the audience from before the import.
  check('ramp back to warming, capped at the old audience', ramp(), {
    status: 'warming',
    cap_today: existing,
    max_cap: existing + counts.new,
    sent_today: 0,
  });

  let last = 0;
  const finished = await until(
    () => local.call('GET', `/api/v1/imports/${job.id}`),
    (j) => {
      if (j.processedRows !== last && j.processedRows % 10_000 < 250) {
        console.log(
          `[import] ${j.processedRows} rows after ${((performance.now() - start) / 1000).toFixed(0)} s`,
        );
      }
      last = j.processedRows;
      return ['done', 'failed', 'canceled'].includes(j.status);
    },
    'the import',
  );
  const importMs = performance.now() - start;
  check('import status', finished.value.status, 'done');
  check('rows processed', finished.value.processedRows, ROWS);
  check('result', finished.value.report.result, {
    created: counts.new,
    updated: counts.updated,
    skipped: ROWS - counts.new - counts.updated,
  });

  const value = (sql, ...args) => read.prepare(sql).get(...args).n;
  check('Members in the Channel', countMembers(), existing + counts.new);
  check(
    'new Members are active, as attested',
    value(
      "SELECT count(*) AS n FROM members WHERE channel_id = ? AND import_id = ? AND status = 'active'",
      channelId,
      job.id,
    ),
    counts.new,
  );
  check(
    'every written Member carries the import tag',
    value(
      `SELECT count(*) AS n FROM member_tags mt JOIN tags t ON t.id = mt.tag_id
        WHERE t.channel_id = ? AND t.name = ?`,
      channelId,
      `import:${job.id}`,
    ),
    counts.new + counts.updated,
  );
  check(
    'no row for rejected addresses',
    value(
      `SELECT count(*) AS n FROM members WHERE channel_id = ? AND (email LIKE 'info@%' OR email LIKE 'blocked%'
         OR email LIKE '%@mailinator.com' OR email LIKE 'not-an-email%')`,
      channelId,
    ),
    0,
  );
  check(
    'updated Members have the new name',
    value(
      `SELECT count(*) AS n FROM members WHERE channel_id = ? AND email LIKE 'changed%' AND first_name = 'New name'`,
      channelId,
    ),
    counts.updated,
  );
  check(
    'field values stored, the bad ones left out',
    value(
      `SELECT count(*) AS n FROM member_field_values v JOIN member_fields f ON f.id = v.field_id
        WHERE f.channel_id = ? AND f.key = 'plan'`,
      channelId,
    ),
    counts.new - FIELD_ERRORS,
  );
  read.close();

  console.log(
    JSON.stringify(
      {
        where: 'local D1 (workerd SQLite on this machine), not Cloudflare D1',
        rows: ROWS,
        uploadMs: Math.round(uploadMs),
        dryRunMs: Math.round(analyzed.ms),
        importMs: Math.round(importMs),
        rowsPerSecond: Math.round(ROWS / (importMs / 1000)),
        report: report.counts,
        passed: problems.length === 0,
      },
      null,
      2,
    ),
  );
} finally {
  await local.stop();
  if (!values.keep) local.remove();
}
if (problems.length) {
  console.error(`Failed: ${problems.join('; ')}`);
  process.exit(1);
}
