// Who a post goes to: everyone, or subscribers in chosen segments, less any segments left out.
// With the rosters flag, also only subscribers on chosen rosters (rosters/RosterAudience.tsx).
// The editor's send route draws it bare (no card) and listens for the choice to move on.
import type { Circle, Dispatch, DispatchAudience } from '@swarm/domain';
import { ErrorNotice } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useMemo, useRef, useState } from 'react';
import { allCirclesQuery, audienceCountQuery } from '../api/circles';
import { useSaveDispatch } from '../api/send';
import { Section, numberFormat } from '../pages/common';
import { describeRosters } from '../rosters/helpers';
import { RosterAudience, useRosterNames } from '../rosters/RosterAudience';
import { describeAudience } from './rules';

/** Circle names by id, for describing an audience. */
export function useCircleNames(channelId: string): ReadonlyMap<string, string> {
  const circles = useQuery(allCirclesQuery(channelId));
  return useMemo(() => new Map((circles.data ?? []).map((c) => [c.id, c.name])), [circles.data]);
}

export function AudiencePicker({
  dispatch,
  canWrite,
  bare = false,
  undecided = false,
  onChoose,
}: {
  dispatch: Dispatch;
  canWrite: boolean;
  /** Without the card, for a panel that frames it already. */
  bare?: boolean;
  /** Shows neither option picked until the operator chooses (the send route's first visit). */
  undecided?: boolean;
  /** Called when the operator picks Everyone or Only some segments. */
  onChoose?: (mode: 'everyone' | 'circles') => void;
}) {
  const circles = useQuery(allCirclesQuery(dispatch.channelId));
  const save = useSaveDispatch(dispatch.id);
  // Shown while a change is saving, so the controls don't flicker back.
  const [draft, setDraft] = useState<DispatchAudience | null>(null);
  const audience = draft ?? dispatch.audience;
  const [choosing, setChoosing] = useState(audience.include.length > 0);
  const mode = audience.include.length > 0 || choosing ? 'circles' : 'everyone';
  const count = useQuery(audienceCountQuery(dispatch.id, dispatch.audience));
  const names = useMemo(
    () => new Map((circles.data ?? []).map((c) => [c.id, c.name])),
    [circles.data],
  );
  const modeName = useId();
  const rosterNames = useRosterNames(dispatch.channelId);
  const rosterText = describeRosters(audience.rosters, rosterNames);

  const latest = useRef(0);
  const commit = (next: DispatchAudience) => {
    const seq = ++latest.current;
    setDraft(next);
    // Only the newest save clears the draft, so quick changes in a row don't flicker.
    save.mutate({ audience: next }, { onSettled: () => seq === latest.current && setDraft(null) });
  };
  const toggle = (list: 'include' | 'exclude', id: string, on: boolean) => {
    const other = list === 'include' ? 'exclude' : 'include';
    commit({
      ...audience,
      [list]: on ? [...audience[list], id] : audience[list].filter((c) => c !== id),
      // A Circle can't be both included and left out.
      [other]: on ? audience[other].filter((c) => c !== id) : audience[other],
    } as DispatchAudience);
  };

  const list = circles.data ?? [];
  // Circles deleted since they were chosen stay listed, so they can be unticked.
  const missing = [...audience.include, ...audience.exclude].filter((id) => !names.has(id));
  // Not disabled while saving: that would drop keyboard focus mid-change.
  const disabled = !canWrite;

  const body = (
    <div className="grid gap-4">
      <fieldset className="grid gap-1.5" disabled={!canWrite}>
        <legend className="mb-1 text-[15px] font-semibold">Audience</legend>
        <label className="flex min-h-9 items-center gap-2 text-[13.5px]">
          <input
            type="radio"
            name={modeName}
            className="size-4 accent-purple"
            checked={!undecided && mode === 'everyone'}
            disabled={disabled}
            onChange={() => {
              setChoosing(false);
              if (audience.include.length) commit({ ...audience, include: [] });
              onChoose?.('everyone');
            }}
          />
          Everyone
        </label>
        <label className="flex min-h-9 items-center gap-2 text-[13.5px]">
          <input
            type="radio"
            name={modeName}
            className="size-4 accent-purple"
            checked={!undecided && mode === 'circles'}
            disabled={disabled || (list.length === 0 && audience.include.length === 0)}
            onChange={() => {
              setChoosing(true);
              onChoose?.('circles');
            }}
          />
          Only some segments
        </label>
      </fieldset>

      {circles.isPending && <p className="text-[13px] text-sub">Loading segments…</p>}
      {circles.error && <ErrorNotice message={circles.error.message} />}
      {circles.data && list.length === 0 && missing.length === 0 && (
        <div className="rounded-card-app bg-surface-alt px-3 py-3 text-[13px] text-sub">
          <p>To send to some subscribers only, gather them in a segment first.</p>
          <Link
            to="/circles/new"
            search={{ channel: dispatch.channelId, post: dispatch.id }}
            className="btn-ghost btn-sm mt-2.5"
          >
            Create a segment
          </Link>
          <p className="mt-1.5">You come back here with it chosen.</p>
        </div>
      )}

      {mode === 'circles' && (list.length > 0 || missing.length > 0) && (
        <CircleChecklist
          legend="Segments to send to"
          circles={list}
          missing={missing.filter((id) => audience.include.includes(id))}
          checked={audience.include}
          disabled={disabled}
          onToggle={(id, on) => toggle('include', id, on)}
        />
      )}
      {mode === 'circles' && audience.include.length === 0 && list.length > 0 && (
        <p className="text-[12.5px] text-sub">
          Tick at least one segment. Until then it goes to everyone.
        </p>
      )}

      {(list.length > 0 || missing.length > 0) && (
        <CircleChecklist
          legend="Leave out"
          circles={list}
          missing={missing.filter((id) => audience.exclude.includes(id))}
          checked={audience.exclude}
          disabled={disabled}
          onToggle={(id, on) => toggle('exclude', id, on)}
        />
      )}

      <RosterAudience
        channelId={dispatch.channelId}
        audience={audience}
        disabled={disabled}
        onChange={commit}
      />

      <div aria-live="polite" className="grid gap-1 rounded-card-app bg-surface-alt px-3 py-2.5">
        <p className="text-[13px]">
          {describeAudience(audience, names)}
          {rosterText ? `, ${rosterText}` : ''}
        </p>
        <p className="text-[13px] text-sub">
          {draft || count.isFetching ? (
            'Counting…'
          ) : count.error ? (
            'The count isn’t available right now.'
          ) : count.data?.problem ? (
            <span className="font-semibold text-danger">{count.data.problem}</span>
          ) : count.data ? (
            <>
              <b className="tabular text-ink">{numberFormat.format(count.data.recipientCount)}</b>{' '}
              active subscriber{count.data.recipientCount === 1 ? '' : 's'} right now
            </>
          ) : null}
        </p>
      </div>
      {save.error && <ErrorNotice title="Audience not saved" message={save.error.message} />}
    </div>
  );
  return bare ? (
    body
  ) : (
    <Section title="Audience" description="Posts go to active subscribers only.">
      {body}
    </Section>
  );
}

function CircleChecklist({
  legend,
  circles,
  missing,
  checked,
  disabled,
  onToggle,
}: {
  legend: string;
  circles: Circle[];
  missing: string[];
  checked: readonly string[];
  disabled: boolean;
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <fieldset className="grid gap-1" disabled={disabled}>
      <legend className="mb-1 text-[15px] font-semibold">{legend}</legend>
      <div className="grid max-h-56 gap-0.5 overflow-y-auto">
        {circles.map((circle) => (
          <label key={circle.id} className="flex min-h-9 items-center gap-2 text-[13.5px]">
            <input
              type="checkbox"
              className="size-4 shrink-0 accent-purple"
              checked={checked.includes(circle.id)}
              onChange={(e) => onToggle(circle.id, e.target.checked)}
            />
            <span className="min-w-0 flex-1 truncate">{circle.name}</span>
            <span className="tabular text-[12px] text-sub">
              {circle.status === 'ready' ? numberFormat.format(circle.memberCount) : 'updating'}
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
            A deleted segment
          </label>
        ))}
      </div>
    </fieldset>
  );
}
