// A subscriber's page: every live automation, and in plain sentences whether they entered it and
// why or why not.
import type { MemberStatus } from '@swarm/domain';
import { ErrorNotice, LoadingRows } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { memberFlowsQuery } from '../api/members';
import { whySentences } from './why';

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const formatDay = (iso: string) => dayFormat.format(new Date(iso));

export function MemberFlowsList({
  memberId,
  memberStatus,
}: {
  memberId: string;
  memberStatus: MemberStatus;
}) {
  const flows = useQuery(memberFlowsQuery(memberId));
  if (flows.isPending) return <LoadingRows label="Loading automations" rows={2} />;
  if (flows.error) return <ErrorNotice message={flows.error.message} />;
  if (!flows.data.length) {
    return <p className="text-[13.5px] text-sub">This publication has no live automations.</p>;
  }
  return (
    <ul className="grid gap-2.5">
      {flows.data.map((item) => (
        <li key={item.flowId} className="text-[13.5px]">
          {whySentences(item, memberStatus, formatDay).join(' ')}
        </li>
      ))}
    </ul>
  );
}
