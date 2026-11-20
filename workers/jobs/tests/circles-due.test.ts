// The five-minute cron's Circle refresh queue: Circles whose refresh keeps failing must not keep
// every other Circle on the instance from being refreshed.
import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import type { JobMessage } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { refreshCircle, refreshDueCircles } from '../src/handlers/circles';
import { jobsEnv, seedChannel } from './helpers';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function addCircles(
  ws: { workspaceId: string; channelId: string },
  count: number,
  evaluatedAt: number,
): Promise<string[]> {
  const ids = Array.from({ length: count }, () => newId('circle'));
  await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare(
        `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, generation, status,
           evaluated_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'Test', '{"field":"email","cmp":"is_set"}', 1, 'ready', ?4, ?4, ?4)`,
      ).bind(id, ws.workspaceId, ws.channelId, evaluatedAt),
    ),
  );
  return ids;
}

/** A database whose batches fail, as a refresh that keeps throwing sees it. */
const brokenDb = new Proxy(env.DB, {
  get(target, key) {
    const value = Reflect.get(target, key) as unknown;
    if (key === 'batch') {
      return () => Promise.reject(new Error('D1_ERROR: internal error'));
    }
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

describe('Circle refresh cron', () => {
  it('still refreshes other workspaces while one workspace’s Circles keep failing', async () => {
    const now = Date.now() + 30 * 24 * HOUR;
    const busy = await seedChannel();
    const other = await seedChannel();
    // Enough failing Circles to fill every run's batch, evaluated longer ago than the healthy one.
    const failing = new Set(await addCircles(busy, 200, now - 3 * HOUR));
    const [healthy] = await addCircles(other, 1, now - 2 * HOUR);

    const { env: jobs, queue } = jobsEnv();
    let attempts = 0;
    // An hour of five-minute runs, each followed by the queue consumer.
    for (let t = now; t < now + HOUR; t += 5 * MINUTE) {
      const before = queue.items.length;
      await refreshDueCircles(jobs, t);
      for (const item of queue.items.slice(before)) {
        const message = item as Extract<JobMessage, { type: 'circle_refresh' }>;
        const fails = failing.has(message.circleId);
        if (fails) attempts++;
        await refreshCircle(
          fails ? { ...jobs, DB: brokenDb } : jobs,
          message.circleId,
          message.generation,
          t,
        ).catch(() => undefined);
      }
    }

    const row = await env.DB.prepare('SELECT status, evaluated_at FROM circles WHERE id = ?1')
      .bind(healthy)
      .first<{ status: string; evaluated_at: number }>();
    expect(row?.status).toBe('ready');
    expect(row?.evaluated_at).toBeGreaterThanOrEqual(now);
    // The failing Circles were tried, but not at the cost of everything else.
    expect(attempts).toBeGreaterThan(0);
  });

  it('waits longer after each lost refresh, and starts over once one finishes', async () => {
    const start = Date.now() + 60 * 24 * HOUR;
    const ws = await seedChannel();
    const [id] = await addCircles(ws, 1, start - 2 * HOUR);
    const { env: jobs, queue } = jobsEnv();
    const queued = async (t: number) => {
      const before = queue.items.length;
      await refreshDueCircles(jobs, t);
      return queue.items
        .slice(before)
        .some((item) => (item as { circleId?: string }).circleId === id);
    };
    const failures = async () =>
      (
        await env.DB.prepare('SELECT refresh_failures FROM circles WHERE id = ?1')
          .bind(id)
          .first<{ refresh_failures: number }>()
      )?.refresh_failures;

    expect(await queued(start)).toBe(true);
    await refreshCircle({ ...jobs, DB: brokenDb }, id!, 1, start).catch(() => undefined);
    // Lost once: queued again after 15 minutes.
    expect(await queued(start + 16 * MINUTE)).toBe(true);
    expect(await failures()).toBe(1);
    await refreshCircle({ ...jobs, DB: brokenDb }, id!, 1, start + 16 * MINUTE).catch(
      () => undefined,
    );
    // Lost twice: the next try waits 30 minutes.
    expect(await queued(start + 32 * MINUTE)).toBe(false);
    expect(await queued(start + 47 * MINUTE)).toBe(true);
    expect(await failures()).toBe(2);
    await refreshCircle(jobs, id!, 1, start + 47 * MINUTE);
    expect(await failures()).toBe(0);
  });
});
