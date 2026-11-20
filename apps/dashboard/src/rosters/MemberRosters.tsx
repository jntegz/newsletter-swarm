// A Member's Rosters in the member drawer (flag rosters). Editors subscribe and unsubscribe; a
// Roster the Member left themselves stays off here, because only they can rejoin it.
import { MEMBER_LEFT_SOURCES } from '@swarm/domain';
import { ErrorNotice } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { useChannelFlag } from '../api/queries';
import { memberRostersQuery, rostersQuery, useSetMemberRoster } from '../api/rosters';

export function MemberRostersPanel({
  channelId,
  memberId,
  canEdit,
}: {
  channelId: string;
  memberId: string;
  canEdit: boolean;
}) {
  const on = useChannelFlag(channelId, 'rosters') === true;
  const rosters = useQuery(rostersQuery(channelId, on));
  const memberships = useQuery(memberRostersQuery(channelId, memberId, on));
  const save = useSetMemberRoster(channelId, memberId);
  const id = useId();
  if (!on) return null;
  const byRoster = new Map((memberships.data ?? []).map((m) => [m.rosterId, m]));
  const list = rosters.data ?? [];

  return (
    <section aria-labelledby={id} className="border-t border-line pt-4">
      <h3 id={id} className="mb-3 text-[14px] font-semibold">
        Rosters
      </h3>
      {(rosters.isPending || memberships.isPending) && (
        <p className="text-[13px] text-sub">Loading Rosters…</p>
      )}
      {(rosters.error ?? memberships.error) && (
        <ErrorNotice message={(rosters.error ?? memberships.error)?.message ?? ''} />
      )}
      {rosters.data && list.length === 0 && (
        <p className="text-[13px] text-sub">This publication has no Rosters yet.</p>
      )}
      {memberships.data && list.length > 0 && (
        <fieldset className="grid gap-0.5" disabled={!canEdit}>
          <legend className="sr-only">Rosters this subscriber is on</legend>
          {list.map((roster) => {
            const membership = byRoster.get(roster.id);
            const subscribed = membership?.status === 'subscribed';
            const leftThemselves =
              membership?.status === 'unsubscribed' &&
              MEMBER_LEFT_SOURCES.includes(membership.source);
            return (
              <label key={roster.id} className="flex min-h-9 items-center gap-2 text-[13.5px]">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-purple"
                  checked={subscribed}
                  disabled={leftThemselves || save.isPending}
                  onChange={(e) =>
                    save.mutate({
                      rosterId: roster.id,
                      status: e.target.checked ? 'subscribed' : 'unsubscribed',
                    })
                  }
                />
                <span className="min-w-0 flex-1 truncate">{roster.name}</span>
                {leftThemselves && <span className="text-[12px] text-sub">Left themselves</span>}
              </label>
            );
          })}
        </fieldset>
      )}
      {save.error && <ErrorNotice message={save.error.message} />}
    </section>
  );
}
