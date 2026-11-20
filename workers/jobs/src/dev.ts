// Development only: moves Flow time forward for the end-to-end tests. POST /__dev/flows/advance
// with `{ channelId, at? }` does what the minute cron's Flows sweep does (pending member events
// enrol Members and wake waits), then runs the Channel's steps that are due as of `at` (default
// now) on the spot, as of `at`, so a delay of days ends at once. Outside development and test, or
// on any host but a local one (localRequest), it answers 404, like the api's dev mailbox; wrangler
// dev runs no crons, so this is also how local enrolment happens.
import { enrollFromEvents, runDueFlowSteps, type FlowsEnv } from '@swarm/engine';
import { ApiError, localRequest, type RuntimeVariables } from '@swarm/runtime';
import type { Hono } from 'hono';
import { z } from 'zod';
import { parseJobsEnv, type JobsEnv } from './env';

const AdvanceSchema = z.object({
  channelId: z.string().regex(/^ch_[0-9a-f]{32}$/),
  at: z.number().int().positive().optional(),
});

export function mountDev(
  app: Hono<{ Variables: RuntimeVariables }>,
  flowsEnv: (env: JobsEnv) => FlowsEnv,
): void {
  app.use('/__dev/*', async (c, next) => {
    const { ENVIRONMENT } = parseJobsEnv(c.env);
    // Two gates, so one configuration value saying development is not enough on its own.
    if ((ENVIRONMENT !== 'development' && ENVIRONMENT !== 'test') || !localRequest(c.req.url)) {
      throw new ApiError('not_found', 'Not found.');
    }
    await next();
  });

  app.post('/__dev/flows/advance', async (c) => {
    // JSON only: a cross-site form post can't send it without a preflight, which is never allowed.
    if (!c.req.header('content-type')?.startsWith('application/json')) {
      throw new ApiError('invalid_input', 'Send JSON.');
    }
    const { channelId, at } = AdvanceSchema.parse(await c.req.json());
    const env = flowsEnv(parseJobsEnv(c.env));
    const now = Date.now();
    const events = await enrollFromEvents(env, now);
    const steps = await runDueFlowSteps(env, channelId, Math.max(now, at ?? now));
    return c.json({ data: { enrolled: events, steps } });
  });
}
