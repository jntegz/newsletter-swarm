// Copilot actions in the editor panel (flag copilot_actions): "Ask Copilot to do it". The
// operator types a request; Copilot calls Swarm's API with the operator's own role on this
// Channel. Calls that wait are listed with the exact request that would run, and Confirm and
// Cancel: destructive calls and changes proposed after Copilot read workspace content always
// wait for the operator; calls the workspace's approval mode holds wait for an admin. Confirm
// sends back the digest of the request shown. What a waiting call acts on comes from the server
// (the post's subject, sender and audience, a Member's status), and the model's own closing text
// sits apart from it, below the calls and labelled as written by the model, so it can't pass for
// the system's description of a request. Contract: docs/copilot.md.
import type { AgentTarget, CopilotActionResult, CopilotActionStep } from '@swarm/domain';
import { Button, ErrorNotice, Pill, TextAreaField } from '@swarm/ui/components';
import { useState } from 'react';
import { ApiError } from '../api/client';
import { useCopilotActions, useDecideCopilotAction } from '../api/copilot';

const OUTCOME: Record<CopilotActionStep['outcome'], { label: string; tone: string }> = {
  ok: { label: 'Done', tone: 'success' },
  error: { label: 'Failed', tone: 'danger' },
  denied: { label: 'Not allowed', tone: 'danger' },
  unknown_tool: { label: 'Unknown', tone: 'neutral' },
  pending_approval: { label: 'Waiting', tone: 'scheduled' },
};

const STOP_NOTE: Partial<Record<CopilotActionResult['stop'], string>> = {
  max_steps: 'Copilot stopped after the most steps one request may take.',
  max_tokens: 'Copilot stopped at the most text one request may use.',
  refused: 'Copilot declined this request.',
  error: 'Copilot stopped because the model could not be reached.',
};

/** Tool names are snake_case operation ids: list_members → "list members". */
const toolLabel = (tool: string) => tool.replace(/_/g, ' ');

const text = (value: unknown) => (typeof value === 'string' ? value : null);

/** What a held call acts on, in words, from the server's lookup (never from the model). */
export function targetLabel(target: AgentTarget): string {
  switch (target.type) {
    case 'dispatch': {
      const parts = [
        `Post “${text(target.subject) || 'Untitled'}”`,
        `${text(target.status) ?? 'unknown'}, web ${text(target.webVisibility) ?? 'unknown'}`,
        text(target.sender) ? `from ${text(target.sender)}` : 'no sender chosen',
        `audience ${target.audience ? JSON.stringify(target.audience) : 'everyone'}`,
      ];
      return parts.join(' · ');
    }
    case 'member':
      return `Subscriber ${target.id} (${text(target.status) ?? 'unknown'})`;
    case 'feed_source':
      return `Feed ${text(target.url) ?? target.id} (${text(target.mode) ?? ''} mode, ${text(target.status) ?? ''})`;
    default:
      return `${target.type} ${target.id}`;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'rate_limited' && error.field('quota') === 'seat') {
      return 'Your role has used its share of this month’s Copilot requests. An editor or admin can still use Copilot.';
    }
    if (error.code === 'rate_limited' && error.field('quota') === 'month') {
      return 'This workspace has used this month’s Copilot requests. Admins can add their own model key in Settings → Copilot.';
    }
    if (error.code === 'feature_disabled') return 'Copilot actions are not available here.';
    return error.message;
  }
  return 'Something went wrong. Try again.';
}

type Decided = Record<string, { status: 'executed' | 'failed' | 'rejected'; message?: string }>;

export function CopilotActions({
  channelId,
  dispatchId,
}: {
  channelId: string;
  dispatchId: string;
}) {
  const [request, setRequest] = useState('');
  const ask = useCopilotActions(channelId);
  const decide = useDecideCopilotAction(channelId);
  const [decided, setDecided] = useState<Decided>({});
  const [decideError, setDecideError] = useState<string | null>(null);
  const result = ask.data;

  const submit = () => {
    if (!request.trim() || ask.isPending) return;
    setDecided({});
    setDecideError(null);
    ask.mutate({ request: request.trim(), dispatchId });
  };

  const onDecide = (
    approval: NonNullable<CopilotActionStep['approval']>,
    decision: 'confirm' | 'cancel',
  ) => {
    const approvalId = approval.id;
    setDecideError(null);
    decide.mutate(
      { approvalId, decision, requestDigest: approval.requestDigest },
      {
        onSuccess: (outcome) =>
          setDecided((current) => ({ ...current, [approvalId]: { status: outcome.status } })),
        onError: (error) => setDecideError(errorMessage(error)),
      },
    );
  };

  return (
    <div className="grid gap-2 border-t border-line-app pt-4">
      <h3 className="text-[14px] font-semibold">Ask Copilot to do it</h3>
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextAreaField
          label="What should Copilot do?"
          hint="Copilot works with your own role on this publication. Anything that deletes, sends, or changes data after Copilot read your content waits for you to confirm."
          value={request}
          maxLength={2000}
          placeholder="e.g. Tag every subscriber who joined this week as new"
          onChange={(e) => setRequest(e.target.value)}
        />
        <div>
          <Button type="submit" size="sm" loading={ask.isPending} disabled={!request.trim()}>
            Ask Copilot
          </Button>
        </div>
      </form>

      {ask.isError && <ErrorNotice message={errorMessage(ask.error)} />}

      {result && (
        <CopilotResult
          result={result}
          decided={decided}
          busy={decide.isPending}
          decideError={decideError}
          onDecide={onDecide}
        />
      )}
    </div>
  );
}

type DecideHandler = (
  approval: NonNullable<CopilotActionStep['approval']>,
  decision: 'confirm' | 'cancel',
) => void;

/** One request's outcome: notes, the calls (with what waits), then the model's own text. */
export function CopilotResult({
  result,
  decided,
  busy,
  decideError,
  onDecide,
}: {
  result: CopilotActionResult;
  decided: Decided;
  busy: boolean;
  decideError: string | null;
  onDecide: DecideHandler;
}) {
  return (
    <div
      className="grid gap-3 rounded-card-app border border-line-app bg-surface-alt p-4"
      aria-live="polite"
    >
      {STOP_NOTE[result.stop] && <p className="text-[12px] text-sub">{STOP_NOTE[result.stop]}</p>}
      {result.readWorkspaceContent && result.steps.some((s) => s.approval) && (
        <p className="rounded-control bg-warn-soft px-3 py-2 text-[12px] text-warn" role="note">
          Copilot read content from this workspace during this request. Text that other people wrote
          can try to steer it: check each waiting call against what you asked for.
        </p>
      )}
      {result.steps.length > 0 ? (
        <ul className="grid gap-2">
          {result.steps.map((step) => (
            <StepRow
              key={step.actionId}
              step={step}
              decided={step.approval ? decided[step.approval.id] : undefined}
              busy={busy}
              onDecide={onDecide}
            />
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-sub">Copilot made no calls.</p>
      )}
      {decideError && <ErrorNotice message={decideError} />}
      {result.text && (
        <figure className="grid gap-1 border-l-2 border-line-app pl-3">
          <figcaption className="text-[11.5px] text-sub">
            Copilot’s message (written by the model; the calls above are what would run)
          </figcaption>
          <blockquote className="text-[13px] leading-[1.55] break-words whitespace-pre-wrap text-sub">
            {result.text}
          </blockquote>
        </figure>
      )}
      {result.remaining !== null && (
        <p className="text-[12px] text-sub">
          {result.remaining} Copilot request{result.remaining === 1 ? '' : 's'} left this month.
        </p>
      )}
    </div>
  );
}

export function StepRow({
  step,
  decided,
  busy,
  onDecide,
}: {
  step: CopilotActionStep;
  decided: Decided[string] | undefined;
  busy: boolean;
  onDecide: (
    approval: NonNullable<CopilotActionStep['approval']>,
    decision: 'confirm' | 'cancel',
  ) => void;
}) {
  const outcome = decided
    ? decided.status === 'executed'
      ? { label: 'Done', tone: 'success' }
      : decided.status === 'rejected'
        ? { label: 'Canceled', tone: 'neutral' }
        : { label: 'Failed', tone: 'danger' }
    : OUTCOME[step.outcome];
  const waiting = step.outcome === 'pending_approval' && step.approval && !decided;
  const destructive = step.risk === 'destructive';
  return (
    <li className="grid gap-2 rounded-[10px] bg-surface px-3 py-2 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 font-medium break-words">
          {toolLabel(step.tool)}
          {destructive && <span className="ml-1.5 text-[12px] text-danger">· destructive</span>}
        </span>
        <Pill tone={outcome.tone as 'success'}>{outcome.label}</Pill>
      </div>
      {waiting && step.approval && (
        <>
          {/* What Confirm runs: the request itself, never only the tool's name. */}
          <div className="grid gap-1">
            {step.approval.target && (
              <p className="text-[12.5px] break-words">
                <span className="text-sub">Acts on: </span>
                {targetLabel(step.approval.target)}
              </p>
            )}
            <p className="font-mono text-[12px] break-all">
              {step.approval.request.method} {step.approval.request.path}
            </p>
            {step.approval.request.body === null && (
              <p className="text-[12px] text-sub">
                No request body: it acts on{' '}
                {step.approval.target ? 'the target above' : 'the path above'} as it is when you
                confirm.
              </p>
            )}
            {step.approval.request.body !== null && (
              <pre className="max-h-40 overflow-auto rounded-control bg-surface-alt p-2 font-mono text-[11.5px] break-words whitespace-pre-wrap">
                {JSON.stringify(step.approval.request.body, null, 2)}
              </pre>
            )}
          </div>
          <p className="text-[12px] text-sub">
            {step.approval.reason}
            {step.approval.afterReading && ' Copilot proposed it after reading workspace content.'}
            {step.approval.decider === 'admin' &&
              ' If you are not an admin, an admin approves it in Settings → Developers → Open Operator.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={destructive ? 'danger' : 'primary'}
              disabled={busy}
              onClick={() => onDecide(step.approval!, 'confirm')}
            >
              {destructive ? 'Confirm and run' : 'Confirm'}
            </Button>
            <Button
              size="sm"
              variant="quiet"
              disabled={busy}
              onClick={() => onDecide(step.approval!, 'cancel')}
            >
              Cancel
            </Button>
          </div>
        </>
      )}
    </li>
  );
}
