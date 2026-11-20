// The minute cron: one Dispatch or one step that fails must not hold up the rest of the minute.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import worker, { startDue } from '../src/index';
import { parseSendEnv } from '../src/env';
import { completeRamp, seedChannel, seedDispatch } from './harness';

const START = Date.UTC(2026, 10, 4, 9, 20);

const bindings = {
  ...env,
  ENVIRONMENT: 'development',
  TRACK_ORIGIN: 'https://link.swarm.test',
  PLATFORM_MAIL_DOMAIN: 'mail.swarm.test',
  UNSUBSCRIBE_MAIL_DOMAIN: 'unsubscribe.swarm.test',
  MEDIA_ORIGIN: 'https://media.swarm.test',
  CAPTURE_ORIGIN: 'https://forms.swarm.test',
  MAIL_ADAPTER: 'dev',
  DNS_RESOLVER: 'dev',
  LINK_HOSTNAMES: 'dev',
};

const pause = (ms: number) => new Promise<false>((resolve) => setTimeout(() => resolve(false), ms));

const status = async (id: string) =>
  (await env.DB.prepare('SELECT status FROM dispatches WHERE id = ?1')
    .bind(id)
    .first<{ status: string }>())!.status;

/**
 * A database whose start batch fails with a plain Error for the Dispatches in `failing`, as a
 * platform limit might, or with `hang` never answers, as when the invocation runs out of time.
 * Only the statement that moves a Dispatch to 'sending' is watched; each refused start is
 * recorded in `attempts`, and everything else passes through.
 */
function failingStarts(failing: Set<string>, attempts: string[] = [], hang = false): D1Database {
  const bound = new WeakMap<object, unknown[]>();
  return new Proxy(env.DB, {
    get(target, key) {
      if (key === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes(`SET status = 'sending'`)) return statement;
          return new Proxy(statement, {
            get(inner, name) {
              if (name === 'bind') {
                return (...args: unknown[]) => {
                  const result = inner.bind(...args);
                  bound.set(result, args);
                  return result;
                };
              }
              const value: unknown = Reflect.get(inner, name);
              return typeof value === 'function' ? (value as () => unknown).bind(inner) : value;
            },
          });
        };
      }
      if (key === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const id = statements
            .flatMap((s) => bound.get(s) ?? [])
            .find((arg): arg is string => typeof arg === 'string' && failing.has(arg));
          if (id) {
            attempts.push(id);
            if (hang) return new Promise<never>(() => {});
            throw new Error('batch rejected');
          }
          return target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

describe('the minute cron', () => {
  // Every test shares the database, so nothing a test leaves scheduled may come due in the next.
  afterEach(async () => {
    await env.DB.prepare(`UPDATE dispatches SET status = 'draft' WHERE status = 'scheduled'`).run();
  });

  it('regression: Dispatches that keep failing to start do not hold up other workspaces', async () => {
    const a = await seedChannel({ members: 1 });
    await completeRamp(a.channelId);
    const b = await seedChannel({ members: 1 });
    await completeRamp(b.channelId);
    // 25 of A's posts, all due before B's, fail inside the start batch every time.
    const failing = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const row = await seedDispatch(a.channelId, {
        status: 'scheduled',
        publish_at: START - 100 + i,
      });
      failing.add(row.id);
    }
    const later = await seedDispatch(b.channelId, { status: 'scheduled', publish_at: START - 1 });
    const tries: string[] = [];
    const sendEnv = parseSendEnv({ ...bindings, DB: failingStarts(failing, tries) });
    let firstMinute = 0;
    for (let k = 0; k < 5; k++) {
      await startDue(sendEnv, START + k * 60_000);
      if (k === 0) firstMinute = tries.length;
    }
    expect(await status(later.id)).toBe('sending');
    // One workspace fills at most 10 places in a minute, and A's posts are still waiting to retry.
    expect(firstMinute).toBe(10);
    expect(new Set(tries).size).toBe(25);
    const left = await env.DB.prepare(
      `SELECT count(*) AS n FROM dispatches WHERE channel_id = ?1 AND status = 'scheduled'`,
    )
      .bind(a.channelId)
      .first<{ n: number }>();
    expect(left?.n).toBe(25);
  });

  it('regression: backs off a Dispatch that keeps failing to start, then takes it back to draft', async () => {
    const { channelId, workspaceId } = await seedChannel({ members: 1 });
    await completeRamp(channelId);
    const row = await seedDispatch(channelId, { status: 'scheduled', publish_at: START - 1 });
    const attempts: number[] = [];
    let minute = 0;
    const tries: string[] = [];
    const sendEnv = parseSendEnv({ ...bindings, DB: failingStarts(new Set([row.id]), tries) });
    for (; minute <= 70; minute++) {
      const before = tries.length;
      await startDue(sendEnv, START + minute * 60_000);
      if (tries.length > before) attempts.push(minute);
    }
    // Tried at once, then after 2, 4, 8 and 16 minutes, and 32 more before giving up.
    expect(attempts).toEqual([0, 2, 6, 14, 30, 62]);
    const after = await env.DB.prepare(
      'SELECT status, publish_at, start_attempts, start_retry_at FROM dispatches WHERE id = ?1',
    )
      .bind(row.id)
      .first();
    expect(after).toEqual({
      status: 'draft',
      publish_at: null,
      start_attempts: 0,
      start_retry_at: null,
    });
    const audit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_events WHERE workspace_id = ?1 AND action = 'dispatch.schedule_failed' AND target_id = ?2`,
    )
      .bind(workspaceId, row.id)
      .all<{ metadata_json: string }>();
    expect(audit.results.map((r) => JSON.parse(r.metadata_json) as unknown)).toEqual([
      { reason: 'Swarm could not start this Dispatch after 6 tries.', attempts: 6, checks: [] },
    ]);
  });

  it('regression: backs off a Dispatch whose start never finishes, so later ones still start', async () => {
    const { channelId, workspaceId } = await seedChannel({ members: 1 });
    await completeRamp(channelId);
    const stuck = await seedDispatch(channelId, { status: 'scheduled', publish_at: START - 2 });
    const tries: string[] = [];
    const sendEnv = parseSendEnv({
      ...bindings,
      DB: failingStarts(new Set([stuck.id]), tries, true),
    });
    // Each minute's start of the stuck Dispatch never returns: the invocation is cut off there.
    const abandon = async (minute: number) => {
      const before = tries.length;
      const run = startDue(sendEnv, START + minute * 60_000);
      for (let i = 0; i < 200 && tries.length === before; i++) {
        if (await Promise.race([run.then(() => true), pause(5)])) return false;
      }
      return tries.length > before;
    };
    expect(await abandon(0)).toBe(true);
    // A later post comes due; the next minute starts it instead of waiting on the stuck one again.
    const later = await seedDispatch(channelId, {
      status: 'scheduled',
      publish_at: START + 30_000,
    });
    expect(await abandon(1)).toBe(false);
    expect(await status(later.id)).toBe('sending');
    expect(tries).toEqual([stuck.id]);
    expect(
      await env.DB.prepare('SELECT start_attempts, start_retry_at FROM dispatches WHERE id = ?1')
        .bind(stuck.id)
        .first(),
    ).toEqual({ start_attempts: 1, start_retry_at: START + 2 * 60_000 });
    // Its tries that never finished count too: after the sixth it goes back to draft.
    const attempts = [0];
    for (let minute = 2; minute <= 130; minute++) {
      if (await abandon(minute)) attempts.push(minute);
    }
    expect(attempts).toEqual([0, 2, 6, 14, 30, 62]);
    expect(await status(stuck.id)).toBe('draft');
    const audit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_events WHERE workspace_id = ?1 AND action = 'dispatch.schedule_failed' AND target_id = ?2`,
    )
      .bind(workspaceId, stuck.id)
      .all<{ metadata_json: string }>();
    expect(audit.results.map((r) => JSON.parse(r.metadata_json) as unknown)).toEqual([
      { reason: 'Swarm could not start this Dispatch after 6 tries.', attempts: 6, checks: [] },
    ]);
  });

  it('regression: starts the other due Dispatches when one fails unexpectedly', async () => {
    const { channelId } = await seedChannel({ members: 2 });
    await completeRamp(channelId);
    const first = await seedDispatch(channelId, { status: 'scheduled', publish_at: START - 2 });
    const second = await seedDispatch(channelId, { status: 'scheduled', publish_at: START - 1 });
    // The queue refuses the first snapshot: an outage, not a StartError.
    let refused = 0;
    const queue = {
      send: async (message: unknown) => {
        if (refused++ === 0) throw new Error('Queue send failed');
        await env.SEND_QUEUE.send(message as never);
      },
      sendBatch: (messages: never) => env.SEND_QUEUE.sendBatch(messages),
    };
    const started = await startDue(parseSendEnv({ ...bindings, SEND_QUEUE: queue }), START);
    expect(started).toHaveLength(1);
    const broadcast = await env.DB.prepare('SELECT dispatch_id FROM broadcasts WHERE id = ?1')
      .bind(started[0])
      .first<{ dispatch_id: string }>();
    expect(broadcast?.dispatch_id).toBe(second.id);
    // The first is frozen and queued; the reaper picks it up, so nothing else is needed here.
    expect(await status(first.id)).toBe('sending');
  });

  it('regression: runs the later steps when starting due Dispatches fails', async () => {
    const seen: string[] = [];
    // A database that fails the due-Dispatch query and passes everything else through.
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === 'prepare') {
          return (sql: string) => {
            seen.push(sql);
            if (sql.includes(`FROM dispatches WHERE status = 'scheduled'`)) {
              throw new Error('D1 is unavailable');
            }
            return target.prepare(sql);
          };
        }
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const ctx = createExecutionContext();
    const waiting: Promise<unknown>[] = [];
    const recording = {
      waitUntil: (promise: Promise<unknown>) => {
        waiting.push(promise);
        ctx.waitUntil(promise);
      },
      passThroughOnException: () => ctx.passThroughOnException(),
    } as unknown as ExecutionContext;
    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: START, noRetry: () => undefined },
      { ...bindings, DB: db },
      recording,
    );
    await expect(Promise.all(waiting)).resolves.toBeDefined();
    await waitOnExecutionContext(ctx);
    // verifyDomains, the step after the reaper and best-time slots, still read its domains.
    expect(seen.some((sql) => sql.includes('FROM sending_domains'))).toBe(true);
  });
});
