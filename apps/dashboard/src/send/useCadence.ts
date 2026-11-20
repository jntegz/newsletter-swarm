// How often the publication sends, as its teammate last said on the Warm-up plan. Kept in this
// browser only: it changes which dates the dashboard shows, never what the server does.
import { WARMUP_CADENCES, type WarmupCadence } from '@swarm/domain';
import { useCallback, useSyncExternalStore } from 'react';

/** Once a week unless told otherwise: the usual newsletter, and the dates nobody misses. */
const DEFAULT_CADENCE: WarmupCadence = 'weekly';

const KEY = (channelId: string) => `swarm:warmup-cadence:${channelId}`;
const listeners = new Set<() => void>();
/** The choices made on this visit, for when storage is blocked. */
const chosen = new Map<string, WarmupCadence>();

function read(channelId: string): WarmupCadence {
  const kept = chosen.get(channelId);
  if (kept) return kept;
  try {
    const value = window.localStorage.getItem(KEY(channelId));
    return value && value in WARMUP_CADENCES ? (value as WarmupCadence) : DEFAULT_CADENCE;
  } catch {
    return DEFAULT_CADENCE;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The saved rhythm for a publication and a way to change it, shared by every place that shows a plan. */
export function useCadence(channelId: string): [WarmupCadence, (cadence: WarmupCadence) => void] {
  const cadence = useSyncExternalStore(
    subscribe,
    () => read(channelId),
    () => DEFAULT_CADENCE,
  );
  const set = useCallback(
    (next: WarmupCadence) => {
      chosen.set(channelId, next);
      try {
        window.localStorage.setItem(KEY(channelId), next);
      } catch {
        // Storage can be blocked; the choice then lasts for this visit.
      }
      for (const listener of listeners) listener();
    },
    [channelId],
  );
  return [cadence, set];
}
