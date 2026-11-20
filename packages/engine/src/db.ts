import { newId, type IdKind } from '@swarm/domain';

export { all, first, run, toIso } from '@swarm/db';

export const newIdFor = (kind: IdKind, now?: number) => newId(kind, now);

/** Builds `?N, ?N+1, …` placeholders for an IN list. */
export function placeholders(count: number, start = 1): string {
  return Array.from({ length: count }, (_, i) => `?${start + i}`).join(', ');
}
