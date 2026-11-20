// Settings → Developers → Open Operator: the MCP endpoint and how to connect a client, MCP
// settings and the approval mode, calls waiting for approval (with the exact request), and the
// agent activity log with its chain check. Admins and owners only (the API refuses everyone else).
// The MCP server needs flag open_operator_mcp, and its destructive calls wait here. Calls Copilot
// held wait here too (flag copilot_actions), so with only that flag on the page keeps its approvals
// and log. With neither, it is turned off. Contract: docs/open-operator.md.
import {
  APPROVAL_TTL_HOURS,
  type AgentAction,
  type AgentApproval,
  type AgentOutcome,
  type AgentSettings,
  type ApprovalMode,
  type ApprovalStatus,
} from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  SelectField,
  TextAreaField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  agentActionsQuery,
  agentApprovalsQuery,
  agentLogVerificationQuery,
  agentSettingsQuery,
  useDecideApproval,
  useUpdateAgentSettings,
} from '../api/operator';
import { useWorkspaceFlag } from '../channel';
import { targetLabel } from '../editor/CopilotActions';
import { useSession } from '../session';
import { Section, formatDateTime } from './common';

const MODE_LABEL: Record<ApprovalMode, string> = {
  never: 'Never: agents act without asking',
  destructive: 'For destructive calls (sending, deleting, unsubscribing)',
  writes: 'For every change',
};

const OUTCOME: Record<
  AgentOutcome,
  { label: string; tone: 'success' | 'neutral' | 'danger' | 'scheduled' }
> = {
  ok: { label: 'Done', tone: 'success' },
  error: { label: 'Error', tone: 'danger' },
  denied: { label: 'Refused', tone: 'danger' },
  pending_approval: { label: 'Held for approval', tone: 'scheduled' },
};

const APPROVAL: Record<
  ApprovalStatus,
  { label: string; tone: 'success' | 'neutral' | 'danger' | 'scheduled' }
> = {
  pending: { label: 'Waiting', tone: 'scheduled' },
  approved: { label: 'Outcome unknown', tone: 'neutral' },
  executed: { label: 'Approved, ran', tone: 'success' },
  failed: { label: 'Approved, failed', tone: 'danger' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  canceled: { label: 'Canceled', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
};

const credentialLabel = (credential: AgentAction['credential']) =>
  credential.label ??
  (credential.kind === 'key' ? 'A deleted API key' : 'An OAuth app no longer authorised');

/** Per-client setup blocks, the same ones docs/open-operator.md documents. */
const CLIENTS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    note: 'Run this once; the server is then available as swarm.',
    language: 'bash',
    config: (url: string) =>
      `claude mcp add --transport http swarm ${url} \\\n  --header "Authorization: Bearer sk_live_…"`,
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop and claude.ai',
    note: 'Settings → Connectors → Add custom connector, with the URL below. OAuth clients that publish a Client ID Metadata Document need nothing else; otherwise give the connector your app’s client id under advanced settings.',
    language: 'text',
    config: (url: string) => url,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    note: '~/.cursor/mcp.json (or .cursor/mcp.json in a project):',
    language: 'json',
    config: (url: string) =>
      `${JSON.stringify(
        { mcpServers: { swarm: { url, headers: { Authorization: 'Bearer sk_live_…' } } } },
        null,
        2,
      )}`,
  },
  {
    id: 'vscode',
    label: 'VS Code',
    note: '.vscode/mcp.json — the key is asked for once and stored by the editor:',
    language: 'json',
    config: (url: string) =>
      `${JSON.stringify(
        {
          servers: {
            swarm: {
              type: 'http',
              url,
              headers: { Authorization: 'Bearer ${input:swarm-key}' },
            },
          },
          inputs: [
            {
              id: 'swarm-key',
              type: 'promptString',
              password: true,
              description: 'Swarm API key',
            },
          ],
        },
        null,
        2,
      )}`,
  },
  {
    id: 'curl',
    label: 'Any other client',
    note: 'Point it at the URL with a Bearer header. A quick check:',
    language: 'bash',
    config: (url: string) =>
      `curl ${url} \\\n  -H "Authorization: Bearer sk_live_…" \\\n  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \\\n  -H "MCP-Protocol-Version: 2026-07-28" -H "Mcp-Method: tools/list" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'`,
  },
] as const;

const EXAMPLE_PROMPTS = [
  'Read the publication context, then draft next week’s issue from the Feed Sync items about one theme.',
  'Which posts got the most human opens last quarter, and what did they share?',
  'Find the subscribers tagged “beta”, add the tag “early-reader” to each, and draft a short note for them.',
  'Start a draft post titled “What readers asked this month” and leave it for review.',
];

function ConnectAgent({ mcpUrl }: { mcpUrl: string }) {
  const [clientId, setClientId] = useState<(typeof CLIENTS)[number]['id']>('claude-code');
  const [copied, setCopied] = useState(false);
  const client = CLIENTS.find((c) => c.id === clientId) ?? CLIENTS[0];
  const config = client.config(mcpUrl);

  return (
    <div className="mt-4 grid gap-3 text-[13px]">
      <p className="text-sub leading-[1.5]">
        Create an API key under API keys with only the scopes the agent needs, then add the server
        with that key as a Bearer token. Agents see only the operations the key allows.
      </p>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,220px)_1fr]">
        <SelectField
          label="Client"
          value={clientId}
          onChange={(e) => {
            setClientId(e.target.value as (typeof CLIENTS)[number]['id']);
            setCopied(false);
          }}
          options={CLIENTS.map((c) => ({ value: c.id, label: c.label }))}
        />
        <div className="min-w-0">
          <p className="mb-1.5 text-sub leading-[1.5]">{client.note}</p>
          <div className="relative">
            <pre className="overflow-x-auto rounded-control bg-surface-alt p-3 pe-20 font-mono text-[12.5px] text-ink">
              {config}
            </pre>
            <Button
              variant="ghost"
              size="sm"
              className="absolute top-2 right-2"
              onClick={() =>
                void navigator.clipboard?.writeText(config).then(() => setCopied(true))
              }
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer font-semibold">Prompts that work well</summary>
        <ul className="mt-2 grid list-disc gap-1.5 pl-5 text-sub leading-[1.5]">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <li key={prompt}>{prompt}</li>
          ))}
        </ul>
        <p className="mt-2 text-sub leading-[1.5]">
          Point an agent at the publication context first: the <code>get_channel_context</code> tool
          gives it the style guide, the audience by numbers and the recent posts.
        </p>
      </details>
    </div>
  );
}

const TurnedOff = () => (
  <EmptyState title="Open Operator is not turned on">
    Open Operator lets AI agents work in this workspace through the API. Ask a workspace owner if
    you’d like to use it.
  </EmptyState>
);

export function OpenOperatorSettings() {
  const { workspace, can } = useSession();
  const settings = useQuery({ ...agentSettingsQuery(workspace.id), enabled: can('admin') });
  // The settings themselves answer for admins; everyone else can't read them.
  const mcpFlag = useWorkspaceFlag('open_operator_mcp');
  const actionsFlag = useWorkspaceFlag('copilot_actions');

  if (!can('admin')) {
    if (mcpFlag === false && actionsFlag === false) return <TurnedOff />;
    return (
      <EmptyState title="Admins only">
        Ask an owner or admin if you need to manage agent access.
      </EmptyState>
    );
  }
  if (settings.isPending) return <LoadingRows label="Loading Open Operator" rows={4} />;
  if (settings.error) return <ErrorNotice message={settings.error.message} />;

  const { openOperatorMcp, copilotActions } = settings.data.flags;
  if (!openOperatorMcp && !copilotActions) return <TurnedOff />;

  return (
    <div className="grid gap-5">
      {openOperatorMcp && <Connection settings={settings.data} />}
      <Approvals />
      <Activity />
    </div>
  );
}

function Connection({ settings }: { settings: AgentSettings }) {
  const { workspace } = useSession();
  const update = useUpdateAgentSettings(workspace.id);
  const [copied, setCopied] = useState(false);

  return (
    <Section
      title="MCP server"
      description="AI agents and assistants that speak the Model Context Protocol can use the public API here, with an API key or an OAuth app. They get only the scopes you give the key."
    >
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded-control bg-surface-alt px-3 py-1.5 font-mono text-[13px] break-all">
          {settings.mcpUrl}
        </code>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void navigator.clipboard?.writeText(settings.mcpUrl).then(() => setCopied(true))
          }
        >
          {copied ? 'Copied' : 'Copy URL'}
        </Button>
      </div>

      <ConnectAgent mcpUrl={settings.mcpUrl} />

      <div className="mt-5 grid gap-4 border-t border-line pt-4">
        <label className="flex min-h-10 items-center gap-2 text-[13.5px]">
          <input
            type="checkbox"
            className="accent-purple"
            checked={settings.mcpEnabled}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ mcpEnabled: e.target.checked })}
          />
          Allow agents to connect to this workspace
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Ask a person to approve"
            value={settings.approvalMode}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ approvalMode: e.target.value as ApprovalMode })}
            options={(Object.keys(MODE_LABEL) as ApprovalMode[]).map((mode) => ({
              value: mode,
              label: MODE_LABEL[mode],
            }))}
          />
          <SelectField
            label="A held call expires after"
            value={String(settings.approvalTtlHours)}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ approvalTtlHours: Number(e.target.value) })}
            options={[1, 4, 12, 24, 48, APPROVAL_TTL_HOURS.max].map((hours) => ({
              value: String(hours),
              label: hours === 1 ? '1 hour' : `${hours} hours`,
            }))}
          />
          <SelectField
            label="After an agent reads subscriber or feed text, hold its changes for"
            value={String(settings.exposedHoldMinutes)}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ exposedHoldMinutes: Number(e.target.value) })}
            options={[0, 15, 60, 240, 1440].map((minutes) => ({
              value: String(minutes),
              label:
                minutes === 0
                  ? 'Don’t hold'
                  : minutes < 60
                    ? `${minutes} minutes`
                    : `${minutes / 60} hour${minutes === 60 ? '' : 's'}`,
            }))}
          />
          <SelectField
            label="Copilot sees subscribers"
            value={settings.copilotMemberDetail}
            disabled={update.isPending}
            onChange={(e) =>
              update.mutate({
                copilotMemberDetail: e.target.value as AgentSettings['copilotMemberDetail'],
              })
            }
            options={[
              { value: 'masked', label: 'Without addresses, names or field values' },
              { value: 'full', label: 'In full (sent to the model provider)' },
            ]}
          />
        </div>
        <label className="flex min-h-10 items-center gap-2 text-[13.5px]">
          <input
            type="checkbox"
            className="accent-purple"
            checked={settings.separateApprover}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ separateApprover: e.target.checked })}
          />
          Need a second person: whoever caused a held call (asked Copilot, created the key or
          approved the app) can’t approve it. Leave off if this workspace has one admin.
        </label>
        {update.error && <ErrorNotice message={update.error.message} />}
      </div>
    </Section>
  );
}

function Approvals() {
  const { workspace } = useSession();
  const [status, setStatus] = useState<ApprovalStatus | 'all'>('pending');
  const approvals = useQuery(agentApprovalsQuery(workspace.id, status));
  const [open, setOpen] = useState<AgentApproval | null>(null);

  return (
    <Section
      title="Waiting for approval"
      description="Calls an agent made that a person must approve before they run. Approving runs the exact request shown, once."
      action={
        <SelectField
          label="Show"
          value={status}
          onChange={(e) => setStatus(e.target.value as ApprovalStatus | 'all')}
          options={[
            { value: 'pending', label: 'Waiting' },
            { value: 'all', label: 'All' },
            { value: 'executed', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'expired', label: 'Expired' },
          ]}
        />
      }
    >
      {approvals.isPending && <LoadingRows label="Loading approvals" rows={2} />}
      {approvals.error && <ErrorNotice message={approvals.error.message} />}
      {approvals.data?.items.length === 0 && (
        <EmptyState title={status === 'pending' ? 'Nothing is waiting' : 'No approvals'}>
          When an agent asks to send, delete or unsubscribe, the call waits here.
        </EmptyState>
      )}
      {approvals.data && approvals.data.items.length > 0 && (
        <ul className="divide-y divide-line border-y border-line">
          {approvals.data.items.map((approval) => (
            <li key={approval.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[13px] font-semibold">{approval.tool}</p>
                <p className="text-[12.5px] text-sub">
                  {credentialLabel(approval.credential)}
                  {approval.client.name ? ` · client says “${approval.client.name}”` : ''} ·{' '}
                  {formatDateTime(approval.createdAt)}
                </p>
              </div>
              <Pill tone={APPROVAL[approval.status].tone}>{APPROVAL[approval.status].label}</Pill>
              <Button variant="ghost" size="sm" onClick={() => setOpen(approval)}>
                {approval.status === 'pending' ? 'Review' : 'Details'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ApprovalDialog approval={open} onClose={() => setOpen(null)} />
    </Section>
  );
}

function ApprovalDialog({
  approval,
  onClose,
}: {
  approval: AgentApproval | null;
  onClose: () => void;
}) {
  const { workspace } = useSession();
  const decide = useDecideApproval(workspace.id);
  const [reason, setReason] = useState('');
  const pending = approval?.status === 'pending';
  const close = () => {
    decide.reset();
    setReason('');
    onClose();
  };

  return (
    <Dialog
      open={approval !== null}
      onClose={close}
      title={pending ? 'Approve this call?' : 'Held call'}
      description={
        approval && (
          <>
            {credentialLabel(approval.credential)} asked to run <code>{approval.tool}</code>
            {pending ? `. It expires ${formatDateTime(approval.expiresAt)}.` : '.'}
          </>
        )
      }
      actions={
        pending && approval ? (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="quiet"
              loading={decide.isPending && decide.variables?.decision === 'reject'}
              onClick={() =>
                decide.mutate(
                  { id: approval.id, decision: 'reject', reason: reason.trim() },
                  { onSuccess: close },
                )
              }
            >
              Reject
            </Button>
            <Button
              variant="danger"
              loading={decide.isPending && decide.variables?.decision === 'approve'}
              onClick={() =>
                decide.mutate({ id: approval.id, decision: 'approve' }, { onSuccess: close })
              }
            >
              Approve and run
            </Button>
          </>
        ) : approval?.status === 'approved' && !approval.result ? (
          <>
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
            <Button
              variant="quiet"
              loading={decide.isPending}
              onClick={() =>
                decide.mutate({ id: approval.id, decision: 'resolve' }, { onSuccess: close })
              }
            >
              Find out what happened
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
        )
      }
    >
      {approval && (
        <div className="grid gap-3 text-[13px]">
          {approval.target && (
            <p className="break-words">
              <span className="text-sub">Acts on (looked up when it was held): </span>
              {targetLabel(approval.target)}
            </p>
          )}
          {approval.holdReason && <p className="text-sub">Held because: {approval.holdReason}</p>}
          {approval.status === 'approved' && !approval.result && (
            <p className="text-sub">
              Its run was interrupted, so nobody knows yet whether it took effect. “Find out what
              happened” asks the API about the first attempt under the same key, and runs the call
              only if that attempt never reached the API.
            </p>
          )}
          {approval.client.name && (
            <p className="text-sub">
              The client calls itself “{approval.client.name}
              {approval.client.version ? ` ${approval.client.version}` : ''}”. That name is not
              verified; the credential above is.
            </p>
          )}
          {pending && approval.target?.type === 'dispatch' && (
            <p className="text-sub">
              Approving runs only if the post still has this subject, content, sender and audience.
            </p>
          )}
          {approval.request ? (
            <>
              <p className="font-mono text-[12.5px] break-all">
                {approval.request.method} {approval.request.path}
              </p>
              {approval.request.body !== null && (
                <pre className="max-h-60 overflow-auto rounded-control bg-surface-alt p-3 font-mono text-[12px]">
                  {JSON.stringify(approval.request.body, null, 2)}
                </pre>
              )}
            </>
          ) : (
            <pre className="max-h-60 overflow-auto rounded-control bg-surface-alt p-3 font-mono text-[12px]">
              {JSON.stringify(approval.arguments, null, 2)}
            </pre>
          )}
          {approval.decidedBy && (
            <p className="text-sub">
              Decided by {approval.decidedBy.email} on {formatDateTime(approval.decidedAt)}
              {approval.reason ? `: ${approval.reason}` : ''}
            </p>
          )}
          {approval.result && (
            <p className="text-sub">
              Result: {approval.result.statusCode ?? 'not run'}
              {approval.result.statusCode === null && approval.reason
                ? ` (${approval.reason})`
                : ''}
            </p>
          )}
          {pending && (
            <TextAreaField
              label="Reason for rejecting (optional)"
              value={reason}
              maxLength={500}
              rows={2}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
          {decide.error && <ErrorNotice message={decide.error.message} />}
        </div>
      )}
    </Dialog>
  );
}

function Activity() {
  const { workspace } = useSession();
  const [outcome, setOutcome] = useState<AgentOutcome | ''>('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const actions = useQuery(agentActionsQuery(workspace.id, outcome, cursor));
  const chain = useQuery(agentLogVerificationQuery(workspace.id));

  return (
    <Section
      title="Agent activity"
      description="Every tool call an agent made, on every plan. Arguments are stored with personal data removed. Each entry is chained to the one before, so a changed or deleted entry shows."
      action={
        <SelectField
          label="Outcome"
          value={outcome}
          onChange={(e) => {
            setOutcome(e.target.value as AgentOutcome | '');
            setCursors([null]);
          }}
          options={[
            { value: '', label: 'All' },
            ...(Object.keys(OUTCOME) as AgentOutcome[]).map((key) => ({
              value: key,
              label: OUTCOME[key].label,
            })),
          ]}
        />
      }
    >
      {chain.data && (
        <p className="mb-3 text-[12.5px]">
          {chain.data.ok ? (
            <Pill tone="success">Chain verified</Pill>
          ) : (
            <Pill tone="danger">Chain broken at entry {chain.data.brokenAtSeq}</Pill>
          )}
        </p>
      )}
      {actions.isPending && <LoadingRows label="Loading agent activity" rows={3} />}
      {actions.error && <ErrorNotice message={actions.error.message} />}
      {actions.data?.items.length === 0 && (
        <EmptyState title="No agent activity yet">
          Calls appear here as soon as an agent uses the MCP server.
        </EmptyState>
      )}
      {actions.data && actions.data.items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="table-head">
                <th scope="col" className="py-2 pr-3 font-semibold">
                  When
                </th>
                <th scope="col" className="py-2 pr-3 font-semibold">
                  Tool
                </th>
                <th scope="col" className="py-2 pr-3 font-semibold">
                  Credential and client
                </th>
                <th scope="col" className="py-2 pr-3 font-semibold">
                  Outcome
                </th>
                <th scope="col" className="py-2 font-semibold">
                  Time
                </th>
              </tr>
            </thead>
            <tbody>
              {actions.data.items.map((action) => (
                <tr key={action.id} className="border-t border-line align-top">
                  <td className="tabular py-2.5 pr-3 whitespace-nowrap text-sub">
                    {formatDateTime(action.createdAt)}
                  </td>
                  <td className="py-2.5 pr-3">
                    <details>
                      <summary className="cursor-pointer font-mono text-[12.5px] font-semibold">
                        {action.tool}
                        {action.source === 'approval' && ' (approved)'}
                      </summary>
                      <pre className="mt-1 max-w-[360px] overflow-auto rounded-control bg-surface-alt p-2 font-mono text-[11.5px]">
                        {JSON.stringify(action.arguments, null, 2)}
                      </pre>
                    </details>
                  </td>
                  <td className="py-2.5 pr-3 text-sub">
                    {credentialLabel(action.credential)}
                    {action.client.name && (
                      <span className="block">client says “{action.client.name}”</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-3">
                    <Pill tone={OUTCOME[action.outcome].tone}>{OUTCOME[action.outcome].label}</Pill>
                    {action.errorCode && (
                      <span className="mt-0.5 block font-mono text-[11.5px] text-sub">
                        {action.statusCode} {action.errorCode}
                      </span>
                    )}
                  </td>
                  <td className="tabular py-2.5 whitespace-nowrap text-sub">
                    {action.latencyMs} ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(cursors.length > 1 || actions.data?.nextCursor) && (
        <div className="mt-3 flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={cursors.length === 1}
            onClick={() => setCursors((list) => list.slice(0, -1))}
          >
            Newer
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!actions.data?.nextCursor}
            loading={actions.isFetching}
            onClick={() => {
              const next = actions.data?.nextCursor;
              if (next) setCursors((list) => [...list, next]);
            }}
          >
            Older
          </Button>
        </div>
      )}
    </Section>
  );
}
