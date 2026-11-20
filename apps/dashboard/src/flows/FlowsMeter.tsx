// Home: the current publication's live automations, each with a thin route meter (entered →
// completed). The list itself is shared with the sample states.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { flowsQuery } from '../api/flows';
import { useCurrentChannel } from '../channel';
import { totalRuns } from './status';

const number = new Intl.NumberFormat('en-US');

interface AutomationRow {
  id?: string;
  name: string;
  entered: number;
  completed: number;
}

export function AutomationList({ rows }: { rows: AutomationRow[] }) {
  return (
    <ul>
      {rows.map((row, i) => {
        const pct = row.entered ? Math.round((row.completed / row.entered) * 100) : 0;
        return (
          <li key={row.id ?? row.name} className={`py-3 ${i > 0 ? 'border-t border-line' : ''}`}>
            {row.id ? (
              <Link
                to="/flows/$flowId"
                params={{ flowId: row.id }}
                className="font-semibold text-ink no-underline hover:underline"
              >
                {row.name}
              </Link>
            ) : (
              <span className="font-semibold">{row.name}</span>
            )}
            <div
              role="meter"
              aria-label={`${row.name}: share of runs completed`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-valuetext={`${pct}% completed`}
              className="relative mt-3 mr-1 mb-1 h-0.5 rounded-[1px] bg-line"
            >
              <span
                className="absolute inset-y-0 left-0 rounded-[1px] bg-route after:absolute after:-top-[3px] after:-right-1 after:size-2 after:rounded-full after:bg-route"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="mt-0.5 text-[13px] text-sub">
              {number.format(row.entered)} entered · {number.format(row.completed)} completed
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export function FlowsMeter() {
  const { channel } = useCurrentChannel();
  const flows = useQuery({ ...flowsQuery(channel?.id ?? ''), enabled: !!channel });
  const live = (flows.data ?? []).filter((f) => f.status === 'live' || f.status === 'paused');

  if (!channel) return null;
  if (flows.isPending) {
    return (
      <p role="status" className="text-[13px] text-sub">
        Loading automations…
      </p>
    );
  }
  if (flows.error) return <p className="text-[13px] text-danger">{flows.error.message}</p>;
  if (live.length === 0) {
    return (
      <p className="max-w-[52ch] text-sub">
        <b className="mb-0.5 block font-semibold text-ink">None running yet.</b>A welcome series is
        the usual first one. It greets each new subscriber over their first week.{' '}
        <Link to="/flows" search={{ channel: channel.id }} className="font-semibold text-purple">
          Set one up
        </Link>
      </p>
    );
  }
  return (
    <AutomationList
      rows={live.slice(0, 4).map((flow) => ({
        id: flow.id,
        name: flow.name,
        entered: totalRuns(flow.runs),
        completed: flow.runs.completed,
      }))}
    />
  );
}
