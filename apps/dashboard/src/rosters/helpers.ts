// Rosters in a post's audience (flag rosters): the sentence the audience panel and the send
// route show, and the edits the panel makes. docs/rosters.md.
import type { DispatchAudience, RosterAudience, RosterConflict } from '@swarm/domain';

const EMPTY_ROSTERS: RosterAudience = { include: [], exclude: [], conflict: 'exclude_wins' };

const orList = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;

/** The Roster part in words, or null when the audience names no Roster. */
export function describeRosters(
  rosters: RosterAudience | undefined,
  names: ReadonlyMap<string, string>,
): string | null {
  if (!rosters || (!rosters.include.length && !rosters.exclude.length)) return null;
  const name = (id: string) => names.get(id) ?? 'a deleted roster';
  const parts: string[] = [];
  if (rosters.include.length)
    parts.push(`only subscribers on ${orList(rosters.include.map(name))}`);
  if (rosters.exclude.length) {
    const out = `not on ${orList(rosters.exclude.map(name))}`;
    parts.push(
      rosters.include.length && rosters.conflict === 'include_wins'
        ? `${out}, unless they are also on an included roster`
        : out,
    );
  }
  return parts.join(', ');
}

/**
 * Ticks or unticks a Roster on one side. A Roster can't be on both sides, and a part that
 * names no Roster is dropped, so the saved audience stays as it was without Rosters.
 */
export function toggleRoster(
  audience: DispatchAudience,
  side: 'include' | 'exclude',
  rosterId: string,
  on: boolean,
): DispatchAudience {
  const current = audience.rosters ?? EMPTY_ROSTERS;
  const other = side === 'include' ? 'exclude' : 'include';
  const next: RosterAudience = {
    ...current,
    [side]: on ? [...current[side], rosterId] : current[side].filter((id) => id !== rosterId),
    [other]: on ? current[other].filter((id) => id !== rosterId) : current[other],
  };
  return withRosters(audience, next);
}

export function setConflict(
  audience: DispatchAudience,
  conflict: RosterConflict,
): DispatchAudience {
  return withRosters(audience, { ...(audience.rosters ?? EMPTY_ROSTERS), conflict });
}

function withRosters(audience: DispatchAudience, rosters: RosterAudience): DispatchAudience {
  const { rosters: _old, ...rest } = audience;
  return rosters.include.length || rosters.exclude.length ? { ...rest, rosters } : rest;
}

/** Whether the conflict policy matters: Rosters on both sides. */
export const hasConflictChoice = (rosters: RosterAudience | undefined) =>
  !!rosters && rosters.include.length > 0 && rosters.exclude.length > 0;
