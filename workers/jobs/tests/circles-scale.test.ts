// Exit gate: live counts on a Circle over 100k Members, with the query plan checked for index use.
// Timings here are local workerd SQLite, a proxy for D1 (same engine, no network or replica hop).
import { env } from 'cloudflare:test';
import type { CircleRule } from '@swarm/domain';
import { newId } from '@swarm/domain';
import { compileCircle } from '@swarm/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseJobsEnv } from '../src/env';
import { refreshCircle } from '../src/handlers/circles';

const MEMBERS = 100_000;
const NOISE = 20_000;
const DAY = 86_400_000;
const now = Date.now();

let workspaceId: string;
let channelId: string;

async function seedChannel(count: number, prefix: string) {
  const ws = newId('workspace');
  const ch = newId('channel');
  const db = env.DB;
  const tags = { vip: newId('tag'), beta: newId('tag') };
  const fields = { plan: newId('memberField'), age: newId('memberField') };
  const dispatchId = newId('dispatch');
  const broadcastId = newId('broadcast');
  const n = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)`;
  const id = `'mb_${prefix}' || printf('%029d', i)`;
  await db.batch([
    db
      .prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)')
      .bind(ws, 'Scale', now),
    db
      .prepare(
        `INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, 'Scale', ?4, ?4)`,
      )
      .bind(ch, ws, `scale-${crypto.randomUUID().slice(0, 12)}`, now),
    db
      .prepare(
        `INSERT INTO tags (id, channel_id, name, created_at) VALUES (?1, ?3, 'VIP', 0), (?2, ?3, 'beta', 0)`,
      )
      .bind(tags.vip, tags.beta, ch),
    db
      .prepare(
        `INSERT INTO member_fields (id, channel_id, key, label, type, options_json, created_at, updated_at)
         VALUES (?1, ?3, 'plan', 'Plan', 'select', '["Free","Pro"]', 0, 0), (?2, ?3, 'age', 'Age', 'number', '[]', 0, 0)`,
      )
      .bind(fields.plan, fields.age, ch),
    db
      .prepare(
        `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
         VALUES (?1, ?2, 'Issue', '{}', 'sent', 0, 0)`,
      )
      .bind(dispatchId, ch),
    db
      .prepare(
        `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
           from_name, from_address, track_opens, created_at, last_progress_at)
         VALUES (?1, ?2, ?3, ?4, 'sent', 'Issue', '', '', '', 'Scale', 'scale@mail.test', 1, 0, 0)`,
      )
      .bind(broadcastId, dispatchId, ch, ws),
    db
      .prepare(
        `${n} INSERT INTO members (id, channel_id, email, first_name, status, source_json, created_at, updated_at)
         SELECT ${id}, ?2, 'm' || i || '@example.org',
                CASE i % 5 WHEN 0 THEN 'Ada' WHEN 1 THEN 'Grace' WHEN 2 THEN NULL WHEN 3 THEN 'Bob' ELSE 'Zoe' END,
                CASE WHEN i % 10 < 8 THEN 'active' WHEN i % 10 = 8 THEN 'unsubscribed' ELSE 'pending' END,
                json_object('utm_source', CASE i % 4 WHEN 0 THEN 'twitter' WHEN 1 THEN 'news' ELSE 'direct' END),
                ?3 - (i % 120) * ?4, ?3
           FROM n`,
      )
      .bind(count, ch, now, DAY),
    db
      .prepare(
        `${n} INSERT INTO member_tags (member_id, tag_id, created_at)
         SELECT ${id}, ?2, 0 FROM n WHERE i % 10 = 0
         UNION ALL SELECT ${id}, ?3, 0 FROM n WHERE i % 7 = 0`,
      )
      .bind(count, tags.vip, tags.beta),
    db
      .prepare(
        `${n} INSERT INTO member_field_values (member_id, field_id, value_text, value_num, updated_at)
         SELECT ${id}, ?2, CASE WHEN i % 6 = 0 THEN 'Pro' ELSE 'Free' END, NULL, 0 FROM n WHERE i % 3 = 0
         UNION ALL SELECT ${id}, ?3, NULL, i % 80, 0 FROM n WHERE i % 2 = 0`,
      )
      .bind(count, fields.plan, fields.age),
    db
      .prepare(
        `${n} INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at, opened_at, human_opened_at, human_clicked_at)
         SELECT 'dl_${prefix}' || printf('%029d', i), ?2, ?3, ${id}, 'm' || i || '@example.org', 'delivered', ?4 - (i % 90) * ?5,
                CASE WHEN i % 4 = 0 THEN ?4 - (i % 60) * ?5 END,
                CASE WHEN i % 6 = 0 THEN ?4 - (i % 60) * ?5 END,
                CASE WHEN i % 30 = 0 THEN ?4 - (i % 60) * ?5 END
           FROM n WHERE i % 2 = 0`,
      )
      .bind(count, broadcastId, ch, now, DAY),
    db
      .prepare(
        `${n} INSERT INTO referrals (id, channel_id, referrer_id, referred_id, created_at)
         SELECT 'rf_${prefix}' || printf('%029d', i), ?2, 'mb_${prefix}' || printf('%029d', i - 1), ${id}, 0
           FROM n WHERE i % 50 = 1 AND i > 1`,
      )
      .bind(count, ch),
  ]);
  return { workspaceId: ws, channelId: ch };
}

const RULES: Record<string, CircleRule> = {
  // A typical targeted Circle: active, VIP or on the Pro plan, engaged lately, not a test address.
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
  attribution: {
    op: 'and',
    children: [
      { field: 'source.utm_source', cmp: 'eq', value: 'twitter' },
      { field: 'created_at', cmp: 'within_days', value: 30 },
    ],
  },
  champions: { field: 'referral_count', cmp: 'gte', value: 1 },
  wide: {
    op: 'or',
    children: [
      { field: 'first_name', cmp: 'contains', value: 'ad' },
      { field: 'field:age', cmp: 'gt', value: 60 },
      { field: 'clicked_days', cmp: 'within_days', value: 14 },
      { field: 'tag', cmp: 'not_in', value: ['beta'] },
    ],
  },
};

async function timed<T>(run: () => Promise<T>): Promise<{ ms: number; result: T }> {
  const start = performance.now();
  const result = await run();
  return { ms: performance.now() - start, result };
}

async function plan(sql: string, params: unknown[]): Promise<string[]> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail);
}

beforeAll(async () => {
  // Another tenant in the same database, so the plan has to pick the Channel's rows out.
  const noise = await seedChannel(NOISE, 'n');
  // Plenty of other tags, so looking a name up by scanning tags would show in the plan.
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
     INSERT INTO tags (id, channel_id, name, created_at) SELECT 'tg_n' || printf('%029d', i), ?1, 'tag ' || i, 0 FROM n`,
  )
    .bind(noise.channelId)
    .run();
  ({ workspaceId, channelId } = await seedChannel(MEMBERS, 's'));
  await env.DB.prepare('ANALYZE').run();
}, 300_000);

// Wall-clock budget for one query. The plan assertions are what guarantee index use; the budget
// only catches a regression by an order of magnitude, with room for a machine busy running the
// whole repo's suites in parallel (where 1.5 s was exceeded with an unchanged plan).
const BUDGET_MS = 3000;

describe(`Circles over ${MEMBERS.toLocaleString('en-US')} Members`, () => {
  for (const [name, rule] of Object.entries(RULES)) {
    it(`counts "${name}" within the budget using indexes`, async () => {
      const compiled = await compileCircle(env.DB, rule, channelId, now);
      const sql = `SELECT count(*) AS n FROM members m WHERE m.channel_id = ?2 AND (${compiled.where})`;
      const params = [...compiled.params, channelId];
      const runs: number[] = [];
      let n = 0;
      for (let i = 0; i < 3; i++) {
        const { ms, result } = await timed(() =>
          env.DB.prepare(sql)
            .bind(...params)
            .first<{ n: number }>(),
        );
        runs.push(ms);
        n = result?.n ?? 0;
      }
      const steps = await plan(sql, params);
      console.log(
        `[circle scale] ${name}: ${n} of ${MEMBERS} matched; count ${runs.map((t) => t.toFixed(0)).join(' / ')} ms\n  ${steps.join('\n  ')}`,
      );
      expect(Math.min(...runs)).toBeLessThan(BUDGET_MS);
      // The Channel's Members come from an index, never a full scan of every tenant.
      expect(steps.some((s) => /^SCAN m\b(?!.*USING)/.test(s))).toBe(false);
      expect(steps.some((s) => /SEARCH m USING (COVERING )?INDEX/.test(s))).toBe(true);
      // Every subquery reads through an index.
      for (const step of steps) {
        if (/^SCAN (mt|v|t|d|r)\b/.test(step)) expect(step).toMatch(/USING/);
      }
    });
  }

  it('picks the right index for each kind of condition', async () => {
    const compiled = await compileCircle(env.DB, RULES.typical!, channelId, now);
    const steps = (
      await plan(`SELECT count(*) FROM members m WHERE m.channel_id = ?2 AND (${compiled.where})`, [
        ...compiled.params,
        channelId,
      ])
    ).join('\n');
    expect(steps).toMatch(/deliveries_human_opened_by_channel/);
    expect(steps).toMatch(
      /SEARCH v USING INDEX member_field_values_text \(field_id=\? AND value_text=\?\)/,
    );
    expect(steps).toMatch(/member_tags_by_tag|sqlite_autoindex_member_tags/);
  });

  it('samples 25 newest Members quickly', async () => {
    const compiled = await compileCircle(env.DB, RULES.typical!, channelId, now);
    const sql = `SELECT m.id FROM members m WHERE m.channel_id = ?2 AND (${compiled.where})
                  ORDER BY m.created_at DESC, m.id DESC LIMIT 25`;
    const { ms, result } = await timed(() =>
      env.DB.prepare(sql)
        .bind(...compiled.params, channelId)
        .all(),
    );
    console.log(
      `[circle scale] sample: ${ms.toFixed(0)} ms\n  ${(await plan(sql, [...compiled.params, channelId])).join('\n  ')}`,
    );
    expect(result.results).toHaveLength(25);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('materialises 100k Members in one atomic refresh', async () => {
    const jobs = parseJobsEnv({ ...env, JOBS_QUEUE: { send: async () => {} } } as unknown as Record<
      string,
      unknown
    >);
    for (const [name, rule] of [
      ['everyone', RULES.everyone!],
      ['typical', RULES.typical!],
    ] as const) {
      const id = newId('circle');
      await env.DB.prepare(
        `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, generation, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, 'pending', ?6, ?6)`,
      )
        .bind(id, workspaceId, channelId, name, JSON.stringify(rule), now)
        .run();
      const first = await timed(() => refreshCircle(jobs, id, 1, now));
      const again = await timed(() => refreshCircle(jobs, id, 1, now));
      const row = await env.DB.prepare('SELECT member_count, status FROM circles WHERE id = ?1')
        .bind(id)
        .first<{ member_count: number; status: string }>();
      console.log(
        `[circle scale] refresh ${name}: ${row?.member_count} Members, first ${first.ms.toFixed(0)} ms, unchanged ${again.ms.toFixed(0)} ms`,
      );
      expect(row?.status).toBe('ready');
      if (name === 'everyone') expect(row?.member_count).toBe(MEMBERS);
    }
  });
});
