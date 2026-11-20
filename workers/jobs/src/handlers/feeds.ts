// Feed Sync (Phase 8): the minute poll and release, and the daily item prune. The work itself is
// in @swarm/engine (feed-sync.ts); this wires it to the env and the flag service.
import { pruneFeedItems, runFeedSync, type FeedSyncRunDeps } from '@swarm/engine';
import { D1FlagStore, FlagService } from '@swarm/flags';
import { createLogger } from '@swarm/runtime';
import type { JobsEnv } from '../env';

const log = createLogger({ service: 'jobs' });

let injectedFetch: typeof fetch | undefined;

/** Tests answer feed requests here. Pass undefined to go back to the real fetch. */
export function useFeedFetchForTests(fetcher: typeof fetch | undefined): void {
  injectedFetch = fetcher;
}

function feedSyncDeps(env: JobsEnv): FeedSyncRunDeps {
  const flags = new FlagService(new D1FlagStore(env.DB, env.CACHE));
  return {
    db: env.DB,
    fetch: injectedFetch ?? ((input, init) => fetch(input, init)),
    environment: env.ENVIRONMENT,
    mediaOrigin: env.MEDIA_ORIGIN,
    enabled: (workspaceId, channelId) => flags.enabled('feed_sync', { workspaceId, channelId }),
    log: (message, fields) => log.warn(message, fields),
    logError: (message, fields) => log.error(message, fields),
  };
}

/** The minute cron: due feeds are checked, waiting items released within their caps. */
export async function runFeedsMinute(env: JobsEnv, now: number): Promise<void> {
  const result = await runFeedSync(feedSyncDeps(env), now);
  if (result.checked || result.dispatches) log.info('feed sync', result);
}

/** The daily cron: old items and the content of used ones. */
export async function pruneFeeds(env: JobsEnv, now: number): Promise<void> {
  log.info('feed items pruned', await pruneFeedItems(env.DB, now));
}
