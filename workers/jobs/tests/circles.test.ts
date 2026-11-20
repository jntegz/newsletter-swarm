import { env } from 'cloudflare:test';
import type { CircleRule } from '@swarm/domain';
import { newId } from '@swarm/domain';
import {
  CircleRuleError,
  compileCircle,
  enqueueChannelCircleRefresh,
  type JobMessage,
} from '@swarm/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseJobsEnv } from '../src/env';
import { refreshCircle, refreshDueCircles } from '../src/handlers/circles';
import { handleJob } from '../src/index';
import { expected, prng, randomRule, seedWorld, type RefWorld } from './circle-reference';

// Change the seed to explore; a failure message names the seed and rule to reproduce it.
const SEED = 20261027;

async function matching(world: RefWorld, rule: unknown): Promise<string[]> {
  const compiled = await compileCircle(env.DB, rule, world.channelId, world.now);
  const { results } = await env.DB.prepare(
    `SELECT m.id FROM members m WHERE m.channel_id = ?2 AND (${compiled.where}) ORDER BY m.id`,
  )
    .bind(...compiled.params, world.channelId)
    .all<{ id: string }>();
  return results.map((r) => r.id).sort();
}

let world: RefWorld;
let other: RefWorld;

beforeAll(async () => {
  world = await seedWorld(prng(SEED), 160);
  // A second Channel with the same tag names and field keys: its Members must never leak in.
  other = await seedWorld(prng(SEED + 1), 40, world.now);
});

describe('Circle compiler against the reference evaluator', () => {
  it('agrees on 600 random rules over random Members', async () => {
    const rng = prng(SEED + 2);
    let nonTrivial = 0;
    for (let i = 0; i < 600; i++) {
      const rule = randomRule(rng, world);
      const want = expected(world, rule);
      const got = await matching(world, rule);
      expect(got, `seed ${SEED}, rule ${i}: ${JSON.stringify(rule)}`).toEqual(want);
      if (want.length > 0 && want.length < world.members.length) nonTrivial++;
    }
    // The generator has to produce rules that actually split the list to mean anything.
    expect(nonTrivial).toBeGreaterThan(300);
  });

  it('agrees on deep rules up to the nesting limit', async () => {
    const rng = prng(SEED + 3);
    let deepest = 0;
    for (let tested = 0; tested < 40;) {
      const rule = randomRule(rng, world, 1, 20, 2);
      const { depth, leaves } = shape(rule);
      if (leaves > 100) continue;
      tested++;
      deepest = Math.max(deepest, depth);
      expect(await matching(world, rule), JSON.stringify(rule)).toEqual(expected(world, rule));
    }
    expect(deepest).toBeGreaterThanOrEqual(12);
  });

  it('agrees on every leaf alone and negated', async () => {
    const rng = prng(SEED + 4);
    for (let i = 0; i < 300; i++) {
      const rule = randomRule(rng, world, 20, 20);
      const negated: CircleRule = { op: 'not', children: [rule] };
      const yes = await matching(world, rule);
      const no = await matching(world, negated);
      expect(yes, JSON.stringify(rule)).toEqual(expected(world, rule));
      // Exact complement: no Member is lost to NULL logic.
      expect(yes.length + no.length).toBe(world.members.length);
    }
  });

  it('never counts machine opens, and stays inside the Channel', async () => {
    const opened = await matching(world, {
      field: 'opened_days',
      cmp: 'within_days',
      value: 3650,
    });
    expect(opened).toEqual(
      world.members
        .filter((m) => m.opens.length)
        .map((m) => m.id)
        .sort(),
    );
    const everyone = await matching(world, { field: 'email', cmp: 'is_set' });
    expect(everyone).toHaveLength(world.members.length);
    expect(everyone.some((id) => other.members.some((m) => m.id === id))).toBe(false);
  });

  it('circle and level leaves match nobody for another Channel’s ids', async () => {
    // Sanity: the leaves do match in their own Channel.
    expect(
      (await matching(world, { field: 'circle', cmp: 'eq', value: world.circleIds[0]! })).length,
    ).toBeGreaterThan(0);
    expect((await matching(world, { field: 'level', cmp: 'is_set' })).length).toBeGreaterThan(0);
    for (const rule of [
      { field: 'circle', cmp: 'eq', value: other.circleIds[0]! },
      { field: 'circle', cmp: 'in', value: other.circleIds.slice(0, 3) },
      { field: 'level', cmp: 'eq', value: other.levelIds[0]! },
      { field: 'level', cmp: 'in', value: other.levelIds },
      // The deleted Circle still has circle_members rows; it counts for nobody.
      { field: 'circle', cmp: 'eq', value: world.circleIds[3]! },
    ] as CircleRule[]) {
      expect(await matching(world, rule), JSON.stringify(rule)).toEqual([]);
    }
    expect(
      await matching(world, { field: 'circle', cmp: 'neq', value: other.circleIds[0]! }),
    ).toHaveLength(world.members.length);
  });

  it('refuses saving rules that name another Channel’s Circles or levels', async () => {
    const { checkCircleRuleRefs } = await import('@swarm/engine');
    await expect(
      checkCircleRuleRefs(env.DB, world.channelId, {
        op: 'and',
        children: [
          { field: 'circle', cmp: 'in', value: [world.circleIds[0]!] },
          { field: 'level', cmp: 'eq', value: world.levelIds[0]! },
        ],
      }),
    ).resolves.toBeUndefined();
    await expect(
      checkCircleRuleRefs(env.DB, world.channelId, {
        field: 'circle',
        cmp: 'eq',
        value: other.circleIds[0]!,
      }),
    ).rejects.toThrow(CircleRuleError);
    await expect(
      checkCircleRuleRefs(env.DB, world.channelId, {
        field: 'circle',
        cmp: 'eq',
        value: world.circleIds[3]!,
      }),
    ).rejects.toThrow(CircleRuleError);
    await expect(
      checkCircleRuleRefs(env.DB, world.channelId, {
        field: 'level',
        cmp: 'in',
        value: [world.levelIds[0]!, other.levelIds[0]!],
      }),
    ).rejects.toThrow(CircleRuleError);
  });
});

// ---- Injection --------------------------------------------------------------------------------

const HOSTILE = [
  "'; DROP TABLE members; --",
  "' OR '1'='1",
  '" OR ""="',
  "') OR 1=1 --",
  'Robert"); DELETE FROM circles; --',
  '%',
  '_',
  '%_%',
  '\\',
  "\\'",
  '$[0]',
  "$.utm_source') --",
  '?1',
  '?2 OR 1',
  ':name',
  '@p',
  '*/ SELECT 1 /*',
  '\u0000',
  'line\nbreak',
  'tab\there',
  '😀 emoji',
  'ünïcödé',
  'x'.repeat(200),
  'json_extract(m.source_json, $.ref)',
  '{"a":1}',
  '[1,2]',
  'NULL',
  "' UNION SELECT id FROM operators --",
];

describe('Circle compiler under hostile input', () => {
  let target: RefWorld;
  beforeAll(async () => {
    target = await seedWorld(prng(SEED + 5), 10);
    // Store some hostile strings verbatim, so matching them exactly is tested too.
    const field = target.fields.find((f) => f.key === 'company')!;
    const tags = HOSTILE.slice(0, 6).map((name) => ({ id: newId('tag'), name }));
    await env.DB.batch([
      ...tags.map((t) =>
        env.DB.prepare(
          'INSERT INTO tags (id, channel_id, name, created_at) VALUES (?1, ?2, ?3, 0)',
        ).bind(t.id, target.channelId, t.name),
      ),
      ...target.members.slice(0, 6).flatMap((m, i) => {
        m.first_name = HOSTILE[i]!;
        m.fields.company = HOSTILE[i + 6]!;
        m.source.utm_source = HOSTILE[i]!;
        m.tags.push(tags[i]!.name);
        return [
          env.DB.prepare('UPDATE members SET first_name = ?1, source_json = ?2 WHERE id = ?3').bind(
            m.first_name,
            JSON.stringify(m.source),
            m.id,
          ),
          env.DB.prepare(
            `INSERT INTO member_field_values (member_id, field_id, value_text, updated_at) VALUES (?1, ?2, ?3, 0)
             ON CONFLICT (member_id, field_id) DO UPDATE SET value_text = excluded.value_text`,
          ).bind(m.id, field.id, m.fields.company),
          env.DB.prepare(
            'INSERT INTO member_tags (member_id, tag_id, created_at) VALUES (?1, ?2, 0)',
          ).bind(m.id, tags[i]!.id),
        ];
      }),
    ]);
  });

  it('binds hostile values, never splices them, and matches them literally', async () => {
    const before = await env.DB.prepare('SELECT count(*) AS n FROM members').first<{ n: number }>();
    for (const value of HOSTILE) {
      const rules: CircleRule[] = [
        { field: 'first_name', cmp: 'eq', value },
        { field: 'first_name', cmp: 'contains', value },
        { field: 'last_name', cmp: 'starts_with', value },
        { field: 'email', cmp: 'not_in', value: [value, 'Ada'] },
        { field: 'source.utm_source', cmp: 'eq', value },
        { field: 'field:company', cmp: 'contains', value },
        { field: 'field:company', cmp: 'in', value: [value] },
        { field: 'tag', cmp: 'eq', value },
        { field: 'tag', cmp: 'not_in', value: [value, 'VIP'] },
        { op: 'not', children: [{ field: 'tag', cmp: 'neq', value }] },
      ];
      for (const rule of rules) {
        const compiled = await compileCircle(env.DB, rule, target.channelId, target.now);
        // The SQL text doesn't depend on the value at all: the same rule with a harmless value
        // compiles to exactly the same statement.
        const benign = await compileCircle(
          env.DB,
          withValues(rule, (v) => (v === value ? 'benign' : v)),
          target.channelId,
          target.now,
        );
        expect(compiled.where).toBe(benign.where);
        if (value.length >= 6) expect(compiled.where).not.toContain(value);
        expect(compiled.where).not.toContain(target.channelId);
        expect(JSON.parse(compiled.params[0])).toContainEqual(
          Array.isArray((rule as { value?: unknown }).value) ? expect.anything() : value,
        );
        expect(await matching(target, rule), `${JSON.stringify(rule)}`).toEqual(
          expected(target, rule),
        );
      }
    }
    // Hostile values matched their own rows exactly, and nothing was changed or dropped.
    expect(await matching(target, { field: 'first_name', cmp: 'eq', value: '%' })).toEqual([
      target.members[5]!.id,
    ]);
    expect(await matching(target, { field: 'tag', cmp: 'eq', value: '_' })).toHaveLength(0);
    const after = await env.DB.prepare('SELECT count(*) AS n FROM members').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it('refuses hostile field names, paths and shapes with a typed error', async () => {
    const refused: unknown[] = [
      { field: "field:x'); DROP TABLE members; --", cmp: 'is_set' },
      { field: 'field:a b', cmp: 'is_set' },
      { field: 'field:../../etc', cmp: 'is_set' },
      { field: 'field:', cmp: 'is_set' },
      { field: 'field:nope', cmp: 'is_set' },
      { field: "source.utm_source') OR 1=1 --", cmp: 'eq', value: 'x' },
      { field: 'source.first_url', cmp: 'eq', value: 'x' },
      { field: 'source.__proto__', cmp: 'eq', value: 'x' },
      { field: '__proto__', cmp: 'eq', value: 'x' },
      { field: 'constructor', cmp: 'eq', value: 'x' },
      { field: 'hasOwnProperty', cmp: 'eq', value: 'x' },
      { field: 'm.id', cmp: 'eq', value: 'x' },
      { field: 'members.email', cmp: 'eq', value: 'x' },
      { field: 'email; --', cmp: 'eq', value: 'x' },
      { field: 'unsubscribe_reason', cmp: 'eq', value: 'x' },
      { field: 'email', cmp: 'gt', value: 'x' },
      { field: 'email', cmp: 'eq' },
      { field: 'email', cmp: 'eq', value: 5 },
      { field: 'email', cmp: 'in', value: [] },
      { field: 'status', cmp: 'eq', value: "active' OR 1=1 --" },
      { field: 'created_at', cmp: 'before', value: "2026-01-01' --" },
      { field: 'created_at', cmp: 'within_days', value: 1e9 },
      { field: 'opened_days', cmp: 'within_days', value: -1 },
      { field: 'referral_count', cmp: 'gt', value: 1.5 },
      { field: 'field:secret', cmp: 'eq', value: 'Acme' },
      { field: 'field:age', cmp: 'contains', value: '1' },
      { field: 'field:vip', cmp: 'eq', value: 'true' },
      { field: 'field:birthday', cmp: 'before', value: '2026-02-30' },
      { op: 'xor', children: [{ field: 'email', cmp: 'is_set' }] },
      { op: 'not', children: [] },
      {
        op: 'not',
        children: [
          { field: 'email', cmp: 'is_set' },
          { field: 'email', cmp: 'is_set' },
        ],
      },
      { field: 'email', cmp: 'eq', value: { $gt: '' } },
      { field: 'email', cmp: 'drop', value: 'x' },
      nest(21),
      null,
      'email',
    ];
    for (const rule of refused) {
      await expect(
        compileCircle(env.DB, rule, target.channelId, target.now),
        JSON.stringify(rule)?.slice(0, 120),
      ).rejects.toBeInstanceOf(CircleRuleError);
    }
    // The limit itself is fine.
    await expect(compileCircle(env.DB, nest(20), target.channelId)).resolves.toBeTruthy();
  });

  it('does not resolve another Channel’s profile fields', async () => {
    const foreign = newId('memberField');
    await env.DB.prepare(
      `INSERT INTO member_fields (id, channel_id, key, label, type, created_at, updated_at)
       VALUES (?1, ?2, 'elsewhere', 'Elsewhere', 'text', 0, 0)`,
    )
      .bind(foreign, other.channelId)
      .run();
    await expect(
      compileCircle(env.DB, { field: 'field:elsewhere', cmp: 'is_set' }, target.channelId),
    ).rejects.toBeInstanceOf(CircleRuleError);
  });
});

/** The rule with every leaf value (and list item) passed through `map`. */
function withValues(rule: CircleRule, map: (value: unknown) => unknown): CircleRule {
  if ('op' in rule) return { ...rule, children: rule.children.map((c) => withValues(c, map)) };
  const value = Array.isArray(rule.value) ? rule.value.map(map) : map(rule.value);
  return { ...rule, value } as CircleRule;
}

function shape(rule: CircleRule, depth = 1): { depth: number; leaves: number } {
  if (!('op' in rule)) return { depth, leaves: 1 };
  return rule.children.reduce(
    (acc, child) => {
      const s = shape(child, depth + 1);
      return { depth: Math.max(acc.depth, s.depth), leaves: acc.leaves + s.leaves };
    },
    { depth, leaves: 0 },
  );
}

function nest(depth: number): CircleRule {
  let rule: CircleRule = { field: 'email', cmp: 'is_set' };
  for (let i = 1; i < depth; i++) rule = { op: 'and', children: [rule] };
  return rule;
}

// ---- Materialisation --------------------------------------------------------------------------

class MemoryJobs {
  readonly sent: { body: JobMessage; delaySeconds: number }[] = [];
  async send(body: JobMessage, options?: { delaySeconds?: number }) {
    this.sent.push({ body, delaySeconds: options?.delaySeconds ?? 0 });
  }
  async sendBatch() {}
}

function jobsEnv(queue = new MemoryJobs()) {
  return {
    queue,
    env: parseJobsEnv({ ...env, JOBS_QUEUE: queue } as unknown as Record<string, unknown>),
  };
}

async function addCircle(w: RefWorld, rule: CircleRule, generation = 1) {
  const id = newId('circle');
  await env.DB.prepare(
    `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, generation, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Test', ?4, ?5, 'pending', ?6, ?6)`,
  )
    .bind(id, w.workspaceId, w.channelId, JSON.stringify(rule), generation, w.now)
    .run();
  return id;
}

async function circleState(id: string) {
  const row = await env.DB.prepare(
    'SELECT status, member_count, generation, error, evaluated_at FROM circles WHERE id = ?1',
  )
    .bind(id)
    .first<{
      status: string;
      member_count: number;
      generation: number;
      error: string | null;
      evaluated_at: number | null;
    }>();
  const { results } = await env.DB.prepare(
    'SELECT member_id FROM circle_members WHERE circle_id = ?1 ORDER BY member_id',
  )
    .bind(id)
    .all<{ member_id: string }>();
  return { ...row!, members: results.map((r) => r.member_id) };
}

describe('Circle refresh', () => {
  it('waits out a busy database instead of waiting for the queue to try again', async () => {
    const { env: jobs } = jobsEnv();
    const rule: CircleRule = { field: 'status', cmp: 'eq', value: 'active' };
    const id = await addCircle(world, rule);
    let failures = 2;
    const db = new Proxy(env.DB, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (key === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (failures-- > 0) throw new Error('D1_ERROR: database is locked: SQLITE_BUSY');
            return target.batch(statements);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await handleJob({ ...jobs, DB: db }, { type: 'circle_refresh', circleId: id, generation: 1 });
    expect(failures).toBe(-1);
    const state = await circleState(id);
    expect(state.status).toBe('ready');
    expect(state.members).toEqual(expected(world, rule));
  });

  it('materialises the rule and swaps in a new result as a diff', async () => {
    const { env: jobs } = jobsEnv();
    const rule: CircleRule = { field: 'status', cmp: 'eq', value: 'active' };
    const id = await addCircle(world, rule);
    await refreshCircle(jobs, id, 1, world.now);
    const first = await circleState(id);
    expect(first.status).toBe('ready');
    expect(first.members).toEqual(expected(world, rule));
    expect(first.member_count).toBe(first.members.length);

    // Data changes: one active Member leaves, one paused one becomes active.
    const leaving = world.members.find((m) => m.status === 'active')!;
    const joining = world.members.find((m) => m.status === 'paused')!;
    await env.DB.batch([
      env.DB.prepare(`UPDATE members SET status = 'paused' WHERE id = ?1`).bind(leaving.id),
      env.DB.prepare(`UPDATE members SET status = 'active' WHERE id = ?1`).bind(joining.id),
    ]);
    leaving.status = 'paused';
    joining.status = 'active';
    await refreshCircle(jobs, id, 1, world.now);
    const second = await circleState(id);
    expect(second.members).toEqual(expected(world, rule));
    expect(second.members).toContain(joining.id);
    expect(second.members).not.toContain(leaving.id);
  });

  it('ignores a refresh for an older generation and a deleted Circle', async () => {
    const { env: jobs } = jobsEnv();
    const id = await addCircle(world, { field: 'tag', cmp: 'eq', value: 'VIP' }, 2);
    await refreshCircle(jobs, id, 1, world.now);
    expect(await circleState(id)).toMatchObject({ status: 'pending', members: [] });
    await refreshCircle(jobs, id, 2, world.now);
    const ready = await circleState(id);
    expect(ready.status).toBe('ready');

    // The rule changes (generation 3) after a refresh for generation 2 was queued: the late
    // message must not overwrite anything.
    await env.DB.prepare(
      `UPDATE circles SET rule_json = ?1, generation = 3, status = 'pending' WHERE id = ?2`,
    )
      .bind(JSON.stringify({ field: 'tag', cmp: 'eq', value: 'beta' }), id)
      .run();
    await refreshCircle(jobs, id, 2, world.now);
    expect((await circleState(id)).members).toEqual(ready.members);
    await refreshCircle(jobs, id, 3, world.now);
    expect((await circleState(id)).members).toEqual(
      expected(world, { field: 'tag', cmp: 'eq', value: 'beta' }),
    );

    const settled = await circleState(id);
    await env.DB.prepare('UPDATE circles SET deleted_at = 1 WHERE id = ?1').bind(id).run();
    await refreshCircle(jobs, id, 3, world.now + 1000);
    expect(await circleState(id)).toEqual(settled);
  });

  it('marks a rule that no longer compiles as failed, without retrying', async () => {
    const { env: jobs } = jobsEnv();
    const id = await addCircle(world, { field: 'field:gone', cmp: 'is_set' });
    await refreshCircle(jobs, id, 1, world.now);
    const state = await circleState(id);
    expect(state.status).toBe('failed');
    expect(state.error).toMatch(/gone/);
  });

  it('queues due and stuck Circles from cron, and channel refreshes once per burst', async () => {
    const w = await seedWorld(prng(SEED + 6), 5);
    const fresh = await addCircle(w, { field: 'email', cmp: 'is_set' });
    const stale = await addCircle(w, { field: 'email', cmp: 'is_set' });
    const { env: jobs, queue } = jobsEnv();
    await refreshCircle(jobs, fresh, 1, w.now);
    await refreshCircle(jobs, stale, 1, w.now - 2 * 60 * 60 * 1000);
    const queued = await refreshDueCircles(jobs, w.now);
    expect(queued).toBeGreaterThanOrEqual(1);
    expect(queue.sent.map((m) => m.body)).toContainEqual({
      type: 'circle_refresh',
      circleId: stale,
      generation: 1,
    });
    expect(queue.sent.map((m) => (m.body as { circleId: string }).circleId)).not.toContain(fresh);

    const events = new MemoryJobs();
    expect(await enqueueChannelCircleRefresh(env.DB, events, w.channelId)).toBe(1);
    // Already pending: a second change in the same burst queues nothing more.
    expect(await enqueueChannelCircleRefresh(env.DB, events, w.channelId)).toBe(0);
    expect(events.sent).toHaveLength(1);
    expect(events.sent[0]!.delaySeconds).toBeGreaterThan(0);
  });
});
