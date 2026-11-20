import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DAILY_CRON, MINUTE_CRON } from '../src/crons';
import worker, { runScheduled } from '../src/index';
import { jobsEnv } from './helpers';

/** env.DB, except that a statement whose SQL contains `failing` throws; records what it ran. */
function failingDb(failing: string) {
  const prepared: string[] = [];
  const db = new Proxy(env.DB, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (key === 'prepare') {
        return (sql: string) => {
          if (sql.includes(failing)) throw new Error('D1_ERROR: boom');
          prepared.push(sql);
          return target.prepare(sql);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, prepared };
}

// Each failing string is the first statement of that step.
describe('a cron step that throws', () => {
  it.each([
    ['sweepFlows', 'FROM member_events WHERE processed_at IS NULL'],
    ['runChampions', "UPDATE referrals SET status = 'held'"],
    ['decideHoldBacks', 'FROM split_tests WHERE status'],
  ])('does not stop the minute cron when it is %s, and still fails the run', async (_, failing) => {
    const { db, prepared } = failingDb(failing);
    await expect(
      runScheduled({ ...jobsEnv().env, DB: db }, MINUTE_CRON, Date.now()),
    ).rejects.toThrow(/^Cron steps failed: /);
    // The last step: Reputation Ramp pause notices.
    expect(prepared.some((sql) => sql.includes('FROM reputation_ramps r'))).toBe(true);
  });

  it.each([
    ['pruneSiteEdge', 'DELETE FROM site_visitors'],
    ['maintainPlatform', 'DELETE FROM api_idempotency'],
    ['pruneAgentLog', 'UPDATE agent_approvals SET body_json = NULL'],
  ])('does not stop the daily cron when it is %s, and still fails the run', async (_, failing) => {
    const { db, prepared } = failingDb(failing);
    const run = runScheduled({ ...jobsEnv().env, DB: db }, DAILY_CRON, Date.now());
    await expect(run).rejects.toBeInstanceOf(AggregateError);
    await expect(run).rejects.toThrow(/^Cron steps failed: /);
    // The last step: old feed items.
    expect(prepared.some((sql) => sql.includes('DELETE FROM feed_items'))).toBe(true);
  });
});

describe('the scheduled handler', () => {
  it.each([
    // A retry would run every step again, and the next minute comes soon anyway.
    ['the minute cron', MINUTE_CRON, 'FROM member_events WHERE processed_at IS NULL', 1],
    // The daily housekeeping wouldn't run again for a day, so it keeps the platform's retry.
    ['the daily cron', DAILY_CRON, 'DELETE FROM site_visitors', 0],
  ])(
    'asks the platform not to retry a failed run of %s only when the next firing is soon',
    async (_, cron, failing, calls) => {
      const { db } = failingDb(failing);
      let noRetry = 0;
      const controller = {
        cron,
        scheduledTime: Date.now(),
        noRetry: () => {
          noRetry++;
        },
      } as ScheduledController;
      const work: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (promise: Promise<unknown>) => work.push(promise),
        passThroughOnException: () => undefined,
      } as unknown as ExecutionContext;
      await worker.scheduled(controller, { ...env, DB: db }, ctx);
      expect(work).toHaveLength(1);
      // The run still fails, so it shows as failed.
      await expect(work[0]).rejects.toThrow(/^Cron steps failed: /);
      expect(noRetry).toBe(calls);
    },
  );
});
