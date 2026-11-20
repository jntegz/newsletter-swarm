import type { Circle, CircleStatus, Member, MemberStatus } from '@swarm/domain';
import { Pill } from '@swarm/ui/components';
import { formatDateTime, formatDay } from '../pages/common';

const CIRCLE_PILL: Record<
  CircleStatus,
  { tone: 'success' | 'scheduled' | 'neutral' | 'danger'; label: string }
> = {
  pending: { tone: 'scheduled', label: 'Pending' },
  refreshing: { tone: 'scheduled', label: 'Refreshing' },
  ready: { tone: 'success', label: 'Ready' },
  failed: { tone: 'danger', label: 'Failed' },
};

export function CirclePill({ status }: { status: CircleStatus }) {
  const pill = CIRCLE_PILL[status];
  return <Pill tone={pill.tone}>{pill.label}</Pill>;
}

/** One line on where the Circle's membership stands. */
export function evaluationNote(circle: Circle): string {
  if (circle.status === 'failed') {
    return `The last evaluation failed: ${circle.error ?? 'no reason was given.'}`;
  }
  if (circle.status === 'pending' || circle.status === 'refreshing') {
    return circle.evaluatedAt
      ? `Updating. Last evaluated ${formatDateTime(circle.evaluatedAt)}.`
      : 'Working out who is in it. This usually takes a few seconds.';
  }
  return `Last evaluated ${formatDateTime(circle.evaluatedAt)}.`;
}

const MEMBER_STATUS: Record<MemberStatus, string> = {
  pending: 'Pending',
  active: 'Active',
  paused: 'Paused',
  unsubscribed: 'Unsubscribed',
  bounced: 'Bounced',
  complained: 'Complained',
};

/** A compact table of Members: the builder's sample and a Circle's member list. */
export function MemberRows({ members, caption }: { members: Member[]; caption: string }) {
  return (
    <div className="card-app overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-[13.5px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="table-head">
            <th scope="col" className="px-5 py-3 font-semibold">
              Email
            </th>
            <th scope="col" className="px-3 py-3 font-semibold">
              Name
            </th>
            <th scope="col" className="px-3 py-3 font-semibold">
              Status
            </th>
            <th scope="col" className="px-5 py-3 font-semibold">
              Joined
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.id} className="border-t border-line">
              <td className="px-5 py-3 font-medium break-all">{member.email}</td>
              <td className="px-3 py-3 text-sub">
                {[member.firstName, member.lastName].filter(Boolean).join(' ') || '—'}
              </td>
              <td className="px-3 py-3">
                <Pill tone={member.status === 'active' ? 'success' : 'neutral'}>
                  {MEMBER_STATUS[member.status]}
                </Pill>
              </td>
              <td className="tabular px-5 py-3 text-sub">{formatDay(member.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
