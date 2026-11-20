import { createLogger } from '@swarm/runtime';
import type { SiteContext } from '../context';

const log = createLogger({ service: 'site' });

/** Runs work after the response, logging instead of failing the request. */
export function later(c: SiteContext, work: Promise<unknown>): void {
  const guarded = work.catch((error: Error) =>
    log.error('background work failed', { error: error.message }),
  );
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // No execution context (unit tests): the promise still runs.
  }
}
