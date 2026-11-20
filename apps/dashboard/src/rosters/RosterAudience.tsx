// The Roster part of a Dispatch's audience (flag rosters): Rosters to send to, Rosters to leave
// out, and the conflict policy for Members on both, with live counts. docs/rosters.md.
import type { DispatchAudience, Roster, RosterConflict } from '@swarm/domain';
import { ErrorNotice } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useMemo } from 'react';
import { useChannelFlag } from '../api/queries';
import { rosterOverlapQuery, rostersQuery } from '../api/rosters';
import { numberFormat } from '../pages/common';
import { hasConflictChoice, setConflict, toggleRoster } from './helpers';

/** Roster names by id, for describing an audience; empty while the flag is off. */
export function useRosterNames(channelId: string): ReadonlyMap<string, string> {
  const on = useChannelFlag(channelId, 'rosters') === true;
  const rosters = useQuery(rostersQuery(channelId, on));
  return useMemo(() => new Map((rosters.data ?? []).map((r) => [r.id, r.name])), [rosters.data]);
}

export function RosterAudience({
  channelId,
  audience,
  disabled,
  onChange,
}: {
  channelId: string;
  audience: DispatchAudience;
  disabled: boolean;
  onChange: (next: DispatchAudience) => void;
}) {
  const flag = useChannelFlag(channelId, 'rosters');
  const rosters = useQuery(rostersQuery(channelId, flag === true));
  const overlap = useQuery(rosterOverlapQuery(channelId, audience.rosters ?? null));
  const policyName = useId();
  const part = audience.rosters;
  // A stored Roster part stays visible (so it can be cleared) even if the flag was turned off.
  if (flag !== true && !part) return null;

  const list = rosters.data ?? [];
  const known = new Set(list.map((r) => r.id));
  const missing = [...(part?.include ?? []), ...(part?.exclude ?? [])].filter(
    (id) => !known.has(id),
  );
  const conflict = hasConflictChoice(part);
  const counts = overlap.data;

  return (
    <div className="grid gap-3 border-t border-line pt-4">
      <div>
        <p className="text-[13px] font-semibold">Rosters</p>
        <p className="text-[12.5px] text-sub">
          Limit the send to subscribers who joined a Roster. Combined with the segments above: a
          subscriber must match both, and gets the email once.
        </p>
      </div>
      {flag === false && part && (
        <ErrorNotice message="Rosters are off for this publication. Untick them so the emails can go out." />
      )}
      {rosters.isPending && flag === true && (
        <p className="text-[13px] text-sub">Loading Rosters…</p>
      )}
      {rosters.error && <ErrorNotice message={rosters.error.message} />}
      {rosters.data && list.length === 0 && !part && (
        <p className="rounded-card-app bg-surface-alt px-3 py-3 text-[13px] text-sub">
          No Rosters yet.{' '}
          <Link to="/rosters" search={{ channel: channelId }}>
            Create a Roster
          </Link>{' '}
          to send to the subscribers on it.
        </p>
      )}
      {(list.length > 0 || missing.length > 0) && (
        <>
          <RosterChecklist
            legend="Only subscribers on"
            rosters={list}
            missing={missing.filter((id) => part?.include.includes(id))}
            checked={part?.include ?? []}
            disabled={disabled}
            onToggle={(id, on) => onChange(toggleRoster(audience, 'include', id, on))}
          />
          <RosterChecklist
            legend="Leave out subscribers on"
            rosters={list}
            missing={missing.filter((id) => part?.exclude.includes(id))}
            checked={part?.exclude ?? []}
            disabled={disabled}
            onToggle={(id, on) => onChange(toggleRoster(audience, 'exclude', id, on))}
          />
        </>
      )}
      {conflict && part && (
        <fieldset
          className="grid gap-1.5 rounded-card-app bg-surface-alt px-3 py-2.5"
          disabled={disabled}
        >
          <legend className="sr-only">Subscribers on an included and an excluded Roster</legend>
          <p className="text-[13px]" aria-live="polite">
            {counts ? (
              <>
                <b className="tabular">{numberFormat.format(counts.conflicts)}</b> active subscriber
                {counts.conflicts === 1 ? ' is' : 's are'} on both an included and an excluded
                Roster.
              </>
            ) : (
              'Some subscribers may be on both an included and an excluded Roster.'
            )}
          </p>
          {(['exclude_wins', 'include_wins'] as RosterConflict[]).map((value) => (
            <label key={value} className="flex min-h-9 items-center gap-2 text-[13.5px]">
              <input
                type="radio"
                name={policyName}
                className="size-4 accent-purple"
                checked={part.conflict === value}
                onChange={() => onChange(setConflict(audience, value))}
              />
              {value === 'exclude_wins' ? 'Leave them out' : 'Send to them'}
            </label>
          ))}
        </fieldset>
      )}
      {counts && part && (
        <p className="text-[12.5px] text-sub" aria-live="polite">
          The Rosters let through{' '}
          <b className="tabular text-ink">{numberFormat.format(counts.recipients)}</b> active
          subscriber
          {counts.recipients === 1 ? '' : 's'}, before segments.
        </p>
      )}
      {overlap.error && <ErrorNotice message={overlap.error.message} />}
    </div>
  );
}

function RosterChecklist({
  legend,
  rosters,
  missing,
  checked,
  disabled,
  onToggle,
}: {
  legend: string;
  rosters: Roster[];
  missing: string[];
  checked: readonly string[];
  disabled: boolean;
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <fieldset className="grid gap-1" disabled={disabled}>
      <legend className="mb-1 text-[13px] font-semibold">{legend}</legend>
      <div className="grid max-h-56 gap-0.5 overflow-y-auto">
        {rosters.map((roster) => (
          <label key={roster.id} className="flex min-h-9 items-center gap-2 text-[13.5px]">
            <input
              type="checkbox"
              className="size-4 shrink-0 accent-purple"
              checked={checked.includes(roster.id)}
              onChange={(e) => onToggle(roster.id, e.target.checked)}
            />
            <span className="min-w-0 flex-1 truncate">{roster.name}</span>
            <span className="tabular text-[12px] text-sub">
              {numberFormat.format(roster.activeCount)}
            </span>
          </label>
        ))}
        {missing.map((id) => (
          <label key={id} className="flex min-h-9 items-center gap-2 text-[13.5px] text-danger">
            <input
              type="checkbox"
              className="size-4 shrink-0 accent-purple"
              checked
              onChange={(e) => onToggle(id, e.target.checked)}
            />
            A deleted Roster
          </label>
        ))}
      </div>
    </fieldset>
  );
}
