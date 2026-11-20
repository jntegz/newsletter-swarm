import { database, type Ctx } from '../context';
import { hostnamesFor } from '../hostnames';
import { checkHealth, waitForHealth } from './postdeploy';
import type { Step } from './step';

export function healthHosts(ctx: Ctx): string[] {
  const zone = ctx.state.zone?.name;
  if (!zone) return [];
  const h = hostnamesFor(zone, ctx.env, ctx.state.choices?.addresses);
  const hosts = [h.app, h.forms, h.link, h.media, h.events];
  const slug = ctx.state.choices?.publication.slug;
  if (h.wildcard && slug) hosts.push(`${slug}.${zone}`);
  return hosts;
}

/** A jobs heartbeat older than this doesn't count: its minute cron records one every minute. */
const JOBS_HEARTBEAT_FRESH_MS = 10 * 60_000;
/** How long the health step waits for a first heartbeat from a jobs worker it just deployed. */
const JOBS_HEARTBEAT_WAIT_MS = 180_000;
/** What the health step and doctor call the jobs worker's check. */
const JOBS_HEARTBEAT = 'the jobs worker (vault heartbeat)';

interface JobsHeartbeat {
  checkedAt: number;
  ok: boolean;
  okAt: number | null;
}

/** The jobs worker's last vault heartbeat (worker_heartbeats), or null if it has none. */
export async function readJobsHeartbeat(ctx: Ctx): Promise<JobsHeartbeat | null> {
  const [set] = await database(ctx).run([
    {
      sql: "SELECT checked_at, ok, ok_at FROM worker_heartbeats WHERE worker = 'jobs'",
      params: [],
    },
  ]);
  const row = set?.results[0];
  if (!row) return null;
  return {
    checkedAt: Number(row.checked_at),
    ok: Number(row.ok) === 1,
    okAt: row.ok_at === null || row.ok_at === undefined ? null : Number(row.ok_at),
  };
}

/**
 * What is wrong with a heartbeat, or null when it shows jobs reaching the vault: a success in the
 * last ten minutes, and after `since` (this run's deploy of jobs) when there was one.
 */
export function heartbeatProblem(
  heartbeat: JobsHeartbeat | null,
  now: number,
  since?: number,
): string | null {
  if (!heartbeat) return 'it has not recorded a heartbeat yet';
  const minutes = (ms: number) => `${Math.max(0, Math.round((now - ms) / 60_000))} min ago`;
  if (heartbeat.okAt === null) return 'the vault has not answered it yet';
  if (since !== undefined && heartbeat.okAt < since) {
    return heartbeat.checkedAt >= since && !heartbeat.ok
      ? 'the vault does not answer it since this deploy'
      : 'no heartbeat yet since this deploy';
  }
  if (now - heartbeat.okAt > JOBS_HEARTBEAT_FRESH_MS) {
    return heartbeat.ok
      ? `its last heartbeat was ${minutes(heartbeat.checkedAt)}: its cron may not be running`
      : `the vault last answered it ${minutes(heartbeat.okAt)}`;
  }
  return null;
}

/** Checks the jobs worker's heartbeat; with `wait`, gives a just-deployed one time to record one. */
async function checkJobsHeartbeat(ctx: Ctx, wait: boolean): Promise<string | null> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const heartbeat = await readJobsHeartbeat(ctx).catch(() => null);
    const problem = heartbeatProblem(heartbeat, Date.now(), ctx.report.jobsDeployedAt);
    if (!problem || !wait || Date.now() - started > JOBS_HEARTBEAT_WAIT_MS || attempt > 36) {
      return problem;
    }
    await ctx.t.sleep(5_000);
  }
}

export async function healthCheck(ctx: Ctx, wait: boolean) {
  const failed: string[] = [];
  for (const host of healthHosts(ctx)) {
    const result = await ctx.ui.task(
      `Checking https://${host}/healthz`,
      () => (wait ? waitForHealth(ctx, host, 30_000) : checkHealth(ctx, host)),
      (r) => (r.ok ? 'ok' : `not ok (${r.problem ?? 'no answer'})`),
    );
    if (!result.ok) failed.push(host);
  }
  // jobs has no public host: its minute cron pings the vault and records the answer in D1.
  const problem = await ctx.ui.task(
    'Checking that the jobs worker reaches the vault',
    () => checkJobsHeartbeat(ctx, wait),
    (p) => (p ? `not ok (${p})` : 'ok'),
  );
  if (problem) failed.push(JOBS_HEARTBEAT);
  return failed;
}

export const health: Step = {
  id: 'health',
  title: 'Health checks',
  async run(ctx) {
    ctx.report.unhealthy = await healthCheck(ctx, true);
  },
};
