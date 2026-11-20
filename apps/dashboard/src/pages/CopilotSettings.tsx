// Settings → Copilot (Phase 8): usage of the platform key this month, the workspace's own model
// key (flag copilot_byok; checked, stored encrypted, shown as its last four characters), how
// requests are handled, and the metadata-only request log. Admins and owners only.
import type {
  CopilotAdapter,
  CopilotLogFeature,
  CopilotRequestLog,
  CopilotRequestStatus,
  CopilotSettings as CopilotSettingsData,
} from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  SelectField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import {
  copilotLogQuery,
  copilotSettingsQuery,
  useDeleteCopilotKey,
  useCopilotKeyCap,
  useSaveCopilotKey,
} from '../api/copilot';
import { useWorkspaceFlag } from '../channel';
import { useSession } from '../session';
import { Section, formatDateTime, numberFormat } from './common';

const FEATURE: Record<CopilotLogFeature, string> = {
  subject_lines: 'Subject lines',
  preview_text: 'Preview text',
  rewrite: 'Rewrite',
  fix_grammar: 'Fix grammar',
  translate: 'Translate',
  teaser: 'Teaser',
  social_posts: 'Social posts',
  actions: 'Ask Copilot to do it',
};

const PROVIDER: Record<CopilotAdapter, string> = {
  'workers-ai': 'Cloudflare Workers AI',
  anthropic: 'Anthropic',
  dev: 'Offline test model',
};

const STATUS: Record<
  CopilotRequestStatus,
  { label: string; tone: 'success' | 'neutral' | 'danger' | 'scheduled' }
> = {
  pending: { label: 'Running', tone: 'scheduled' },
  succeeded: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  canceled: { label: 'Stopped', tone: 'neutral' },
  refused: { label: 'Declined', tone: 'neutral' },
};

const TurnedOff = () => (
  <EmptyState title="Copilot is not turned on">
    Copilot is the writing assistant in the post editor. Ask a workspace owner if you’d like to use
    it.
  </EmptyState>
);

export function CopilotSettings() {
  const { workspace, can } = useSession();
  const settings = useQuery({ ...copilotSettingsQuery(workspace.id), enabled: can('admin') });
  // The settings themselves answer for admins; everyone else can't read them.
  const flag = useWorkspaceFlag('copilot');

  if (!can('admin')) {
    if (flag === false) return <TurnedOff />;
    return (
      <EmptyState title="Admins only">
        Ask an owner or admin if you need to change how Copilot works in this workspace.
      </EmptyState>
    );
  }
  if (settings.isPending) return <LoadingRows label="Loading Copilot settings" rows={4} />;
  if (settings.error) {
    if (settings.error instanceof ApiError && settings.error.code === 'feature_disabled') {
      return <TurnedOff />;
    }
    return <ErrorNotice message={settings.error.message} />;
  }

  const data = settings.data;
  const share = data.usage.limit ? Math.min(1, data.usage.used / data.usage.limit) : 0;

  return (
    <div className="grid gap-6">
      <Section
        title="Copilot"
        description="The writing assistant in the post editor: subject lines, preview text, rewrites, grammar, translation, teasers and social posts."
      >
        <dl className="grid gap-3 text-[13.5px] sm:grid-cols-3">
          <div>
            <dt className="text-sub">Model</dt>
            <dd className="font-semibold break-all">
              {data.model}
              <span className="block font-normal text-sub">{PROVIDER[data.provider]}</span>
            </dd>
          </div>
          <div>
            <dt className="text-sub">Key in use</dt>
            <dd className="font-semibold">
              {data.keySource === 'workspace'
                ? 'Your workspace’s key'
                : data.keySource === 'platform'
                  ? 'Swarm’s key'
                  : 'None available'}
            </dd>
          </div>
          <div>
            <dt className="text-sub">This month on Swarm’s key ({data.usage.month})</dt>
            <dd className="tabular font-semibold">
              {numberFormat.format(data.usage.used)} of {numberFormat.format(data.usage.limit)}{' '}
              units
            </dd>
          </div>
        </dl>
        <div
          className="mt-3 h-2 overflow-hidden rounded-full bg-surface-alt"
          role="progressbar"
          aria-label="Requests used this month"
          aria-valuemin={0}
          aria-valuemax={data.usage.limit}
          aria-valuenow={data.usage.used}
        >
          <div className="h-full rounded-full bg-purple" style={{ width: `${share * 100}%` }} />
        </div>
        <p className="mt-2 text-[12.5px] text-sub">
          Each teammate can make {data.usage.perMinute} requests a minute on Swarm’s key. An editor
          request is one unit; an “Ask Copilot to do it” run is one unit per 25,000 tokens it uses.
          A viewer or author may use at most {numberFormat.format(data.usage.lowRoleLimit)} units a
          month, so one seat can’t use up what editors need.
          {data.keySource === 'workspace' &&
            ' Your own key has no Swarm allowance: set a monthly ceiling for it below if you want one.'}
        </p>
        {!data.platformKey && data.keySource === null && (
          <p className="mt-2 text-[12.5px] font-semibold text-danger">
            This server has no model key of its own. Add your workspace’s key to use Copilot.
          </p>
        )}
      </Section>

      {data.byokAvailable && <ModelKeySection workspaceId={workspace.id} settings={data} />}

      <Section title="How your text is handled">
        <ul className="grid list-disc gap-1.5 pl-5 text-[13.5px] leading-[1.55]">
          <li>
            Only the text you ask about is sent: the selection, or the post’s text and subject for
            subject lines, preview text and teasers. No subscriber data is sent.
          </li>
          <li>Swarm never stores that text or the result, and never writes them to its logs.</li>
          <li>
            On Swarm’s key, requests run on Cloudflare Workers AI, part of Cloudflare, which already
            hosts Swarm and does not train models on them. On your own key, requests go to Anthropic
            under your Anthropic account’s terms.
          </li>
          <li>Nothing in a post changes until someone accepts a suggestion.</li>
          {data.actionsAvailable && (
            <li>
              Ask Copilot to do it works with the asking teammate’s own role and is recorded in the
              agent log (Settings → Developers → Open Operator). The model sees what Swarm returns
              to it: by default subscribers’ addresses, names and field values are withheld from the
              model (Settings → Developers → Open Operator). Anything that deletes, sends, or
              changes data after Copilot read your content waits for that teammate to confirm.
            </li>
          )}
        </ul>
      </Section>

      <RequestLog workspaceId={workspace.id} />
    </div>
  );
}

function ModelKeySection({
  workspaceId,
  settings,
}: {
  workspaceId: string;
  settings: CopilotSettingsData;
}) {
  const save = useSaveCopilotKey(workspaceId);
  const remove = useDeleteCopilotKey(workspaceId);
  const [apiKey, setApiKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const cap = useCopilotKeyCap(workspaceId);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      { provider: 'anthropic', apiKey: apiKey.trim() },
      {
        onSuccess: () => {
          setApiKey('');
          setReplacing(false);
        },
      },
    );
  };
  const error = save.error instanceof ApiError ? save.error : null;
  const key = settings.key;

  return (
    <Section
      title="Your model key"
      description="Use your own Anthropic API key instead of Swarm’s. Requests then run under your Anthropic account and its terms, without Swarm’s monthly allowance."
    >
      {key && !replacing ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13.5px]">
            Anthropic key ending in <b className="font-mono">{key.last4}</b>
            <span className="text-sub"> · checked {formatDateTime(key.validatedAt)}</span>
            <span className="block text-[12.5px] text-sub">
              {numberFormat.format(key.used)} units this month
              {key.monthlyUnitCap !== null
                ? ` of a ${numberFormat.format(key.monthlyUnitCap)} ceiling`
                : ', no ceiling'}
              . The request log below shows who used them.
            </span>
          </p>
          <div className="flex gap-2">
            <SelectField
              label="Monthly ceiling"
              value={key.monthlyUnitCap === null ? '' : String(key.monthlyUnitCap)}
              disabled={cap.isPending}
              onChange={(e) => cap.mutate(e.target.value ? Number(e.target.value) : null)}
              options={[
                { value: '', label: 'No ceiling' },
                ...[100, 500, 2000, 10_000].map((n) => ({
                  value: String(n),
                  label: `${numberFormat.format(n)} units`,
                })),
              ]}
            />
            <Button variant="ghost" size="sm" onClick={() => setReplacing(true)}>
              Replace
            </Button>
            <Button variant="danger" size="sm" onClick={() => setRemoving(true)}>
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="grid max-w-[520px] gap-3">
          <TextField
            label="Anthropic API key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            hint="Checked with Anthropic before it is saved. Stored encrypted; only its last four characters are shown again."
            error={error?.field('apiKey')}
          />
          {save.error && !error?.field('apiKey') && <ErrorNotice message={save.error.message} />}
          <div className="flex gap-2">
            <Button type="submit" loading={save.isPending} disabled={apiKey.trim().length < 20}>
              Check and save
            </Button>
            {key && (
              <Button variant="ghost" onClick={() => setReplacing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}

      <Dialog
        open={removing}
        onClose={() => setRemoving(false)}
        title="Remove your model key?"
        description="Copilot goes back to Swarm’s key and this plan’s monthly allowance."
        actions={
          <>
            <Button variant="ghost" onClick={() => setRemoving(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => remove.mutate(undefined, { onSuccess: () => setRemoving(false) })}
            >
              Remove key
            </Button>
          </>
        }
      >
        {remove.error && <ErrorNotice message={remove.error.message} />}
      </Dialog>
    </Section>
  );
}

function RequestLog({ workspaceId }: { workspaceId: string }) {
  const log = useQuery(copilotLogQuery(workspaceId));
  return (
    <section aria-labelledby="copilot-log-title" className="card-app overflow-x-auto">
      <div className="px-5 pt-5">
        <h2 id="copilot-log-title" className="text-[16px] font-semibold">
          Recent requests
        </h2>
        <p className="text-[13px] text-sub">
          Who asked for what, and what it used. The text itself is never kept.
        </p>
      </div>
      {log.isPending && (
        <div className="p-5">
          <LoadingRows label="Loading requests" rows={3} />
        </div>
      )}
      {log.error && (
        <div className="p-5">
          <ErrorNotice message={log.error.message} />
        </div>
      )}
      {log.data && log.data.length === 0 && (
        <div className="p-5">
          <EmptyState title="No requests yet">
            Open a post and use the Copilot panel next to the editor.
          </EmptyState>
        </div>
      )}
      {log.data && log.data.length > 0 && (
        <table className="mt-4 w-full text-left text-[13.5px]">
          <thead>
            <tr className="table-head">
              <th scope="col" className="px-5 py-2.5 font-semibold">
                When
              </th>
              <th scope="col" className="px-3 py-2.5 font-semibold">
                What
              </th>
              <th scope="col" className="px-3 py-2.5 font-semibold max-sm:hidden">
                Who
              </th>
              <th scope="col" className="px-3 py-2.5 font-semibold">
                Status
              </th>
              <th scope="col" className="px-5 py-2.5 font-semibold max-sm:hidden">
                Tokens · time
              </th>
            </tr>
          </thead>
          <tbody>
            {log.data.map((row) => (
              <LogRow key={row.id} row={row} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function LogRow({ row }: { row: CopilotRequestLog }) {
  const tokens =
    row.inputTokens === null && row.outputTokens === null
      ? '—'
      : `${numberFormat.format(row.inputTokens ?? 0)} in / ${numberFormat.format(row.outputTokens ?? 0)} out`;
  return (
    <tr className="border-t border-line">
      <td className="tabular px-5 py-3 whitespace-nowrap text-sub">
        {formatDateTime(row.createdAt)}
      </td>
      <td className="px-3 py-3">
        {FEATURE[row.feature]}
        {row.keySource === 'workspace' && <span className="text-sub"> · your key</span>}
      </td>
      <td className="max-w-[220px] truncate px-3 py-3 text-sub max-sm:hidden">
        {row.operator?.email ?? 'A former teammate'}
      </td>
      <td className="px-3 py-3">
        <Pill tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Pill>
      </td>
      <td className="tabular px-5 py-3 whitespace-nowrap text-sub max-sm:hidden">
        {tokens}
        {row.latencyMs !== null && ` · ${(row.latencyMs / 1000).toFixed(1)} s`}
      </td>
    </tr>
  );
}
