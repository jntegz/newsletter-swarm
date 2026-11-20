#!/usr/bin/env node
// Phase 3 exit gate, locally: live counts on a Circle over 100,000 Members. Seeds a large Channel
// (and a smaller tenant beside it), then times the real preview route over HTTP, the one the
// segment builder calls, and checks each query's plan with EXPLAIN QUERY PLAN through
// /__dev/circles/explain, which reads the same SQL. See docs/load-testing.md.
//
//   pnpm load:circles [--members 120000] [--runs 5] [--budget 1500] [--analyze] [--keep]
//
// No ANALYZE by default: nothing in Swarm runs it, so that is the planner production gets.
// Exit status: 0 pass, 1 fail. Local D1 only: this says nothing about Cloudflare's own timings.
import { parseArgs } from 'node:util';
import { median, stack } from './local-stack.mjs';

const { values } = parseArgs({
  options: {
    members: { type: 'string', default: '120000' },
    runs: { type: 'string', default: '5' },
    budget: { type: 'string', default: '1500' },
    analyze: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
});
const MEMBERS = Number(values.members);
const RUNS = Number(values.runs);
const BUDGET = Number(values.budget);
const NOISE = 20_000;
const DAY = 86_400_000;

/** Everything a Channel needs for the rules below, in SQL, with the same shape as real data. */
function seedChannel(db, { channelId, workspaceId, prefix, count, now }) {
  const id = `'mb_${prefix}' || printf('%029d', i)`;
  const n = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})`;
  const tag = { vip: `tg_${prefix}${'0'.repeat(28)}1`, beta: `tg_${prefix}${'0'.repeat(28)}2` };
  const field = {
    plan: `mf_${prefix}${'0'.repeat(28)}1`,
    age: `mf_${prefix}${'0'.repeat(28)}2`,
  };
  const dispatch = `dp_${prefix}${'0'.repeat(28)}1`;
  const broadcast = `bc_${prefix}${'0'.repeat(28)}1`;
  const form = `cf_${prefix === 's' ? 'a' : 'b'}${'0'.repeat(30)}1`;
  db.prepare(
    `INSERT INTO tags (id, channel_id, name, created_at) VALUES (?, ?, 'VIP', 0), (?, ?, 'beta', 0)`,
  ).run(tag.vip, channelId, tag.beta, channelId);
  db.prepare(
    `INSERT INTO member_fields (id, channel_id, key, label, type, options_json, created_at, updated_at)
     VALUES (?, ?, 'plan', 'Plan', 'select', '["Free","Pro"]', 0, 0),
            (?, ?, 'age', 'Age', 'number', '[]', 0, 0)`,
  ).run(field.plan, channelId, field.age, channelId);
  db.prepare(
    `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
     VALUES (?, ?, 'Issue', '{}', 'sent', 0, 0)`,
  ).run(dispatch, channelId);
  db.prepare(
    `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
       from_name, from_address, track_opens, created_at, last_progress_at)
     VALUES (?, ?, ?, ?, 'sent', 'Issue', '', '', '', 'Load', 'load@mail.test', 1, 0, 0)`,
  ).run(broadcast, dispatch, channelId, workspaceId);
  db.exec(`${n} INSERT INTO members (id, channel_id, email, first_name, status, form_id, source_json, created_at, updated_at)
    SELECT ${id}, '${channelId}', 'm' || i || '@example.org',
           CASE i % 5 WHEN 0 THEN 'Ada' WHEN 1 THEN 'Grace' WHEN 2 THEN NULL WHEN 3 THEN 'Bob' ELSE 'Zoe' END,
           CASE WHEN i % 10 < 8 THEN 'active' WHEN i % 10 = 8 THEN 'unsubscribed' ELSE 'pending' END,
           CASE WHEN i % 9 = 0 THEN '${form}' END,
           json_object('utm_source', CASE i % 4 WHEN 0 THEN 'twitter' WHEN 1 THEN 'news' ELSE 'direct' END),
           ${now} - (i % 120) * ${DAY}, ${now}
      FROM n`);
  db.exec(`${n} INSERT INTO member_tags (member_id, tag_id, created_at)
    SELECT ${id}, '${tag.vip}', 0 FROM n WHERE i % 10 = 0
    UNION ALL SELECT ${id}, '${tag.beta}', 0 FROM n WHERE i % 7 = 0`);
  db.exec(`${n} INSERT INTO member_field_values (member_id, field_id, value_text, value_num, updated_at)
    SELECT ${id}, '${field.plan}', CASE WHEN i % 6 = 0 THEN 'Pro' ELSE 'Free' END, NULL, 0 FROM n WHERE i % 3 = 0
    UNION ALL SELECT ${id}, '${field.age}', NULL, i % 80, 0 FROM n WHERE i % 2 = 0`);
  db.exec(`${n} INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at, opened_at, human_opened_at, human_clicked_at)
    SELECT 'dl_${prefix}' || printf('%029d', i), '${broadcast}', '${channelId}', ${id}, 'm' || i || '@example.org', 'delivered',
           ${now} - (i % 90) * ${DAY},
           CASE WHEN i % 4 = 0 THEN ${now} - (i % 60) * ${DAY} END,
           CASE WHEN i % 6 = 0 THEN ${now} - (i % 60) * ${DAY} END,
           CASE WHEN i % 30 = 0 THEN ${now} - (i % 60) * ${DAY} END
      FROM n WHERE i % 2 = 0`);
  db.exec(`${n} INSERT INTO referrals (id, channel_id, referrer_id, referred_id, created_at)
    SELECT 'rf_${prefix}' || printf('%029d', i), '${channelId}', 'mb_${prefix}' || printf('%029d', i - 1), ${id}, 0
      FROM n WHERE i % 50 = 1 AND i > 1`);
  return { form };
}

/** One rule per kind of condition the compiler knows, plus the heavy shapes a builder makes. */
const rules = ({ form }) => ({
  typical: {
    op: 'and',
    children: [
      { field: 'status', cmp: 'eq', value: 'active' },
      {
        op: 'or',
        children: [
          { field: 'tag', cmp: 'eq', value: 'VIP' },
          { field: 'field:plan', cmp: 'eq', value: 'Pro' },
        ],
      },
      { op: 'not', children: [{ field: 'email', cmp: 'contains', value: 'test' }] },
      { field: 'opened_days', cmp: 'within_days', value: 30 },
    ],
  },
  everyone: { field: 'email', cmp: 'is_set' },
  status: { field: 'status', cmp: 'eq', value: 'active' },
  tag: { field: 'tag', cmp: 'eq', value: 'VIP' },
  tagAbsent: { field: 'tag', cmp: 'not_in', value: ['beta'] },
  attribution: {
    op: 'and',
    children: [
      { field: 'source.utm_source', cmp: 'eq', value: 'twitter' },
      { field: 'created_at', cmp: 'within_days', value: 30 },
    ],
  },
  emailSearch: { field: 'email', cmp: 'contains', value: '999' },
  profileNumber: { field: 'field:age', cmp: 'gt', value: 60 },
  profileText: { field: 'field:plan', cmp: 'eq', value: 'Pro' },
  opened: { field: 'opened_days', cmp: 'within_days', value: 14 },
  clicked: { field: 'clicked_days', cmp: 'within_days', value: 14 },
  notOpened: { field: 'opened_days', cmp: 'not_within_days', value: 14 },
  champions: { field: 'referral_count', cmp: 'gte', value: 1 },
  form: { field: 'form_id', cmp: 'eq', value: form },
  wide: {
    op: 'or',
    children: [
      { field: 'first_name', cmp: 'contains', value: 'ad' },
      { field: 'field:age', cmp: 'gt', value: 60 },
      { field: 'clicked_days', cmp: 'within_days', value: 14 },
      { field: 'tag', cmp: 'not_in', value: ['beta'] },
    ],
  },
});

const local = stack({ port: 18797, inspector: 19250 });
const results = [];
const failures = [];
try {
  await local.start();
  const stamp = Date.now().toString(36);
  const me = await local.signIn(`counts-${stamp}@example.com`);
  const big = await local.channel(me, stamp);
  const noise = await local.channel(me, `${stamp}-n`);
  await local.stop();

  const now = Date.now();
  // No foreign key checks: the form id is only a value here, there is no such form to load.
  const db = local.openDb({ enableForeignKeyConstraints: false });
  let seededIn = performance.now();
  db.exec('BEGIN');
  seedChannel(db, { ...noise, prefix: 'n', count: NOISE, now });
  const seeded = seedChannel(db, { ...big, prefix: 's', count: MEMBERS, now });
  db.exec('COMMIT');
  if (values.analyze) db.exec('ANALYZE');
  db.close();
  seededIn = performance.now() - seededIn;
  console.log(
    `[circles] seeded ${MEMBERS.toLocaleString('en-US')} Members plus ${NOISE.toLocaleString('en-US')} in another Channel in ${(seededIn / 1000).toFixed(1)} s; ANALYZE ${values.analyze ? 'run' : 'not run'}`,
  );
  await local.start();

  const path = `/api/v1/channels/${big.channelId}/circles/preview`;
  for (const [name, rule] of Object.entries(rules(seeded))) {
    const runs = [];
    let count = 0;
    for (let i = 0; i < RUNS; i++) {
      const start = performance.now();
      const preview = await local.call('POST', path, { rule });
      runs.push(performance.now() - start);
      count = preview.count;
      if (preview.sample.length !== Math.min(25, count)) failures.push(`${name}: sample size`);
    }
    const { statements } = await local.call('POST', '/__dev/circles/explain', {
      channelId: big.channelId,
      rule,
    });
    const steps = statements.flatMap((s) => s.plan);
    const scans = steps.filter(
      // SCAN j is json_each over the rule's own values, not a table.
      (step) => /^SCAN /.test(step) && !/USING|CONSTANT ROW|VIRTUAL TABLE/.test(step),
    );
    const slowest = Math.max(...runs);
    if (slowest >= BUDGET) failures.push(`${name}: ${slowest.toFixed(0)} ms`);
    if (scans.length) failures.push(`${name}: full scan (${scans.join('; ')})`);
    results.push({
      rule: name,
      matched: count,
      fastestMs: Math.round(Math.min(...runs)),
      medianMs: Math.round(median(runs)),
      slowestMs: Math.round(slowest),
      fullScans: scans.length,
    });
    console.log(
      `[circles] ${name}: ${count} match; ${runs.map((t) => t.toFixed(0)).join(' / ')} ms\n  ${[...new Set(steps)].join('\n  ')}`,
    );
  }
  console.table(results);
  console.log(
    JSON.stringify({
      where: 'local D1 (workerd SQLite on this machine), not Cloudflare D1',
      members: MEMBERS,
      analyzed: values.analyze,
      budgetMs: BUDGET,
      slowestMs: Math.max(...results.map((r) => r.slowestMs)),
      passed: failures.length === 0,
    }),
  );
} finally {
  await local.stop();
  if (!values.keep) local.remove();
}
if (failures.length) {
  console.error(`Failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
