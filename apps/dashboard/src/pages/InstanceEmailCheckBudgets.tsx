// Settings → Instance: how much of this Swarm's DeBounce credits each workspace may spend
// (docs/email-verification.md "Each workspace's share"). Single checks are counted per UTC day,
// checks of a list per calendar month; an empty field goes back to the install's default.
import type { InstanceEmailChecks } from '@swarm/domain';
import { Button, ErrorNotice, LoadingRows, TextField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { instanceEmailChecksQuery, useInstanceEmailChecks } from '../api/emailChecks';
import { useSession } from '../session';
import { numberFormat } from './common';

type Workspace = InstanceEmailChecks['workspaces'][number];

/** A whole number from a field, or null for an empty one (the default); undefined when invalid. */
function parseCount(value: string, max: number): number | null | undefined {
  const text = value.trim().replace(/[\s,]/g, '');
  if (!text) return null;
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return n <= max ? n : undefined;
}

function BudgetRow({
  workspace,
  defaults,
}: {
  workspace: Workspace;
  defaults: InstanceEmailChecks['defaults'];
}) {
  const change = useInstanceEmailChecks();
  const [daily, setDaily] = useState(
    workspace.customDailyChecks ? String(workspace.dailyChecks) : '',
  );
  const [list, setList] = useState(workspace.customListChecks ? String(workspace.listChecks) : '');
  const [saved, setSaved] = useState(false);
  const dailyValue = parseCount(daily, 1_000_000);
  const listValue = parseCount(list, 100_000_000);
  const n = numberFormat.format;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (dailyValue === undefined || listValue === undefined) return;
    setSaved(false);
    change.budget.mutate(
      {
        id: workspace.id,
        allowed: workspace.allowed,
        dailyChecks: dailyValue,
        listChecks: listValue,
      },
      { onSuccess: () => setSaved(true) },
    );
  };
  return (
    <li className="border-t border-line py-3.5">
      <form onSubmit={submit} className="grid gap-2.5" aria-label={`Credits for ${workspace.name}`}>
        <p className="text-[13.5px] font-semibold text-ink">{workspace.name}</p>
        <div className="grid gap-2.5 sm:grid-cols-2">
          <TextField
            label="Single checks a day"
            inputMode="numeric"
            placeholder={`Default (${n(defaults.dailyChecks)})`}
            value={daily}
            onChange={(e) => setDaily(e.target.value)}
            error={dailyValue === undefined ? 'A whole number up to 1,000,000.' : undefined}
            hint={`${n(workspace.usedToday)} used today (UTC).`}
          />
          <TextField
            label="List checks a month"
            inputMode="numeric"
            placeholder={`Default (${n(defaults.listChecks)})`}
            value={list}
            onChange={(e) => setList(e.target.value)}
            error={listValue === undefined ? 'A whole number up to 100,000,000.' : undefined}
            hint={`${n(workspace.listUsedThisMonth)} used this month (UTC).`}
          />
        </div>
        {change.budget.error && change.budget.variables?.id === workspace.id && (
          <ErrorNotice message={`Not saved. ${change.budget.error.message}`} />
        )}
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            size="sm"
            variant="ghost"
            loading={change.budget.isPending && change.budget.variables?.id === workspace.id}
            disabled={dailyValue === undefined || listValue === undefined}
          >
            Save
          </Button>
          <p role="status" className="text-[13px] text-success">
            {saved ? 'Saved.' : ''}
          </p>
        </div>
      </form>
    </li>
  );
}

export function InstanceEmailCheckBudgets() {
  const { me } = useSession();
  const instance = useQuery(instanceEmailChecksQuery(me.instanceAdmin));
  if (!me.instanceAdmin) return null;
  if (instance.isPending) return <LoadingRows label="Loading DeBounce credits" rows={2} />;
  if (instance.error) return <ErrorNotice message={instance.error.message} />;
  if (!instance.data.keySet) return null;
  const workspaces = instance.data.everyWorkspace
    ? instance.data.workspaces
    : instance.data.workspaces.filter((w) => w.allowed);
  return (
    <section aria-labelledby="debounce-budgets-title" className="grid max-w-[560px] gap-4">
      <div>
        <h2 id="debounce-budgets-title" className="text-[16px] font-semibold">
          DeBounce credits per workspace
        </h2>
        <p className="mt-1 text-[13px] text-sub">
          Every workspace that may use DeBounce spends your credits. Single checks (signups, people
          added by hand, Check again) are counted per day; checks of a list and imports that check
          their addresses, per month. A check of a list that needs more than a workspace has left
          doesn’t start. Leave a field empty for the default. Choose who may use DeBounce on its
          card under Apps.
        </p>
      </div>
      {workspaces.length ? (
        <ul className="border-b border-line">
          {workspaces.map((w) => (
            <BudgetRow key={w.id} workspace={w} defaults={instance.data.defaults} />
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-sub">No workspace may use DeBounce yet.</p>
      )}
    </section>
  );
}
