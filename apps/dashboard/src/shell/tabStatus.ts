// What the browser tab says, ahead of the page's name, while something is happening that matters
// from another tab: a send in progress ("Sending 42%"), or a post that didn't save ("Not saved").
import { useEffect, useSyncExternalStore } from 'react';

let status: string | null = null;
const listeners = new Set<() => void>();

function set(next: string | null) {
  if (status === next) return;
  status = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Puts `text` at the front of the tab's title while the caller is mounted and it isn't null. */
export function useTabStatus(text: string | null) {
  useEffect(() => {
    set(text);
    return () => set(null);
  }, [text]);
}

export function useTabStatusValue(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => status,
    () => null,
  );
}

/** The tab's title: status, page, publication, then the product, without repeats. */
export function tabTitle(parts: {
  status: string | null;
  page: string | null;
  place: string | null;
}): string {
  const seen = new Set<string>();
  return [parts.status, parts.page, parts.place, 'Swarm']
    .filter((part): part is string => !!part && !seen.has(part) && !!seen.add(part))
    .join(' · ');
}
