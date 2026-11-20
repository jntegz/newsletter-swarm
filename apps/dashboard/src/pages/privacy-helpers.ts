// Pure helpers for the Privacy Center and export destination screens.
import type { DsrRequest } from '@swarm/domain';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** "3 h", "2 days": the larger unit once it is at least one, rounded down. */
export function span(ms: number): string {
  const abs = Math.abs(ms);
  if (abs >= 2 * DAY) return `${Math.floor(abs / DAY)} days`;
  if (abs >= HOUR) return `${Math.floor(abs / HOUR)} h`;
  return `${Math.max(1, Math.floor(abs / 60_000))} min`;
}

/** The SLA timer: "Due in 23 h", "Overdue by 2 days", or what happened for a closed request. */
export function dueLabel(
  request: Pick<DsrRequest, 'status' | 'dueAt' | 'overdue' | 'completedAt'>,
  now: number,
): string {
  const due = Date.parse(request.dueAt);
  if (request.status === 'completed') {
    const done = request.completedAt ? Date.parse(request.completedAt) : now;
    return done <= due ? 'Done in time' : `Done ${span(done - due)} late`;
  }
  if (request.status === 'rejected') return 'Closed';
  if (request.overdue || due < now) return `Overdue by ${span(now - due)}`;
  return `Due in ${span(due - now)}`;
}

/** Last run of an export destination, in words. */
export function lastRunLabel(lastRunAt: string | null, now: number): string {
  if (!lastRunAt) return 'Not run yet';
  return `${span(now - Date.parse(lastRunAt))} ago`;
}
