// Focus mode for writing: the rail and the top bar step away so only the post is on screen.
// The editor turns it on and off; the shell reads it. It never outlives the editor.
import { useSyncExternalStore } from 'react';

let on = false;
const listeners = new Set<() => void>();

export function setWritingFocus(next: boolean) {
  if (on === next) return;
  on = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Whether the shell is in focus mode. */
export function useWritingFocus(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => on,
    () => false,
  );
}
