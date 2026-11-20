import { enqueueChannelCircleRefresh, jobQueue } from '@swarm/engine';
import { env, type AppContext } from './context';

/**
 * Member data changed: re-evaluate the Channel's Circles after the response. Coalesced, so a
 * burst of edits costs one evaluation per Circle; sends evaluate rules live and don't wait for it.
 */
export function refreshCircles(c: AppContext, channelId: string): void {
  const e = env(c);
  c.executionCtx.waitUntil(enqueueChannelCircleRefresh(e.DB, jobQueue(e.JOBS_QUEUE), channelId));
}
