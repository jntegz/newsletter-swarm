// Runs of a Flow: a filterable table and a drawer with one run's steps, exit reason and a way
// for editors to stop it.
import { FLOW_RUN_STATUSES, type Flow, type FlowRun, type FlowRunStatus } from '@swarm/domain';
import { Button, EmptyState, ErrorNotice, LoadingRows, Pill } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { SelectField } from './Select';
import { flowRunQuery, flowRunsQuery, useExitRun } from '../api/flows';
import { formatDateTime, formatDay } from '../pages/common';
import { EDGE_LABEL, STEP_INFO } from './graph';
import { heldEndedSentence, heldSentence } from './inbox-rules';
import type { Lookups } from './lookups';
import { EXIT_REASON_LABEL, RUN_STATUS_LABEL, RunPill } from './status';
import { summarize, type Names } from './summary';

/** Which start event started a run, in the words the canvas uses for it. */
function startedByText(run: FlowRun, names: Names): string {
  if (run.test) return 'Test run';
  if (!run.startedBy) return 'A teammate, another automation or the API';
  const { event, details } = run.startedBy;
  return summarize({ id: 'trigger', type: 'trigger', config: { ...details, event } }, names);
}

export function FlowRunsView({
  flow,
  canEdit,
  lookups,
}: {
  flow: Flow;
  canEdit: boolean;
  lookups: Lookups;
}) {
  const [status, setStatus] = useState<FlowRunStatus | undefined>();
  const [version, setVersion] = useState<number | undefined>();
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const runs = useQuery(flowRunsQuery(flow.id, { status, version, cursor }));
  const [openRun, setOpenRun] = useState<string | null>(null);

  const stepTitle = (id: string | null) => {
    if (!id) return '—';
    const n = flow.draftGraph.nodes.find((x) => x.id === id);
    return n ? n.name || STEP_INFO[n.type].label : id;
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44">
          <SelectField
            label="Status"
            value={status ?? ''}
            onChange={(e) => {
              setStatus((e.target.value || undefined) as FlowRunStatus | undefined);
              setCursors([null]);
            }}
          >
            <option value="">Any status</option>
            {FLOW_RUN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {RUN_STATUS_LABEL[s]}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="w-44">
          <SelectField
            label="Version"
            value={version ? String(version) : ''}
            onChange={(e) => {
              setVersion(e.target.value ? Number(e.target.value) : undefined);
              setCursors([null]);
            }}
          >
            <option value="">Every version</option>
            {flow.versions.map((v) => (
              <option key={v.version} value={v.version}>
                Version {v.version}
              </option>
            ))}
          </SelectField>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void runs.refetch()}>
          Refresh
        </Button>
      </div>

      {runs.isPending && <LoadingRows label="Loading runs" />}
      {runs.error && (
        <ErrorNotice
          message={runs.error.message}
          action={
            <Button variant="ghost" onClick={() => void runs.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {runs.data?.items.length === 0 && (
        <EmptyState title={status || version ? 'No runs match' : 'No runs yet'}>
          {flow.liveVersion
            ? 'Runs appear here when subscribers enrol, or when you start a test run.'
            : 'Publish the automation, then start a test run with a subscriber to see it here.'}
        </EmptyState>
      )}
      {!!runs.data?.items.length && (
        <div className="card-app overflow-x-auto">
          <table className="w-full min-w-[880px] text-left text-[13px]">
            <caption className="sr-only">Runs</caption>
            <thead>
              <tr className="table-head">
                <th scope="col" className="px-5 py-3 font-semibold">
                  Subscriber
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Status
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Version
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Started by
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Current step
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Started
                </th>
                <th scope="col" className="px-5 py-3 font-semibold">
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.data.items.map((run) => (
                <tr key={run.id} className="border-t border-line hover:bg-surface-alt">
                  <td className="px-5 py-3">
                    {run.memberEmail ?? 'Deleted subscriber'}
                    {run.test && (
                      <span className="ml-2">
                        <Pill tone="neutral">Test</Pill>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <RunPill status={run.status} />
                    {run.hold && (
                      <p className="mt-1 max-w-[34ch] text-[12px] text-sub">
                        {heldSentence(run.hold)}
                      </p>
                    )}
                  </td>
                  <td className="tabular px-3 py-3">v{run.version}</td>
                  <td className="px-3 py-3 text-sub">{startedByText(run, lookups.names)}</td>
                  <td className="px-3 py-3">{stepTitle(run.currentNodeId)}</td>
                  <td className="tabular px-3 py-3 text-sub">{formatDay(run.startedAt)}</td>
                  <td className="px-5 py-3 text-right">
                    <Button variant="quiet" size="sm" onClick={() => setOpenRun(run.id)}>
                      View
                      <span className="sr-only"> run for {run.memberEmail ?? 'subscriber'}</span>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(cursors.length > 1 || runs.data?.nextCursor) && (
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={cursors.length === 1}
            onClick={() => setCursors((list) => list.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!runs.data?.nextCursor}
            onClick={() => {
              const next = runs.data?.nextCursor;
              if (next) setCursors((list) => [...list, next]);
            }}
          >
            Next
          </Button>
        </div>
      )}
      <RunDrawer
        flow={flow}
        runId={openRun}
        canEdit={canEdit}
        stepTitle={stepTitle}
        names={lookups.names}
        onClose={() => setOpenRun(null)}
      />
    </div>
  );
}

function RunDrawer({
  flow,
  runId,
  canEdit,
  stepTitle,
  names,
  onClose,
}: {
  flow: Flow;
  runId: string | null;
  canEdit: boolean;
  stepTitle: (id: string | null) => string;
  names: Names;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const open = runId !== null;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="fixed inset-y-0 right-0 left-auto m-0 h-full max-h-none w-[min(520px,100vw)] max-w-none overflow-y-auto border-0 border-l border-line-app bg-surface p-0 text-ink shadow-card backdrop:bg-[rgba(15,15,18,0.32)]"
    >
      {runId && (
        <RunDetail
          key={runId}
          flow={flow}
          runId={runId}
          canEdit={canEdit}
          titleId={titleId}
          stepTitle={stepTitle}
          names={names}
          onClose={onClose}
        />
      )}
    </dialog>
  );
}

function RunDetail({
  flow,
  runId,
  canEdit,
  titleId,
  stepTitle,
  names,
  onClose,
}: {
  flow: Flow;
  runId: string;
  canEdit: boolean;
  titleId: string;
  stepTitle: (id: string | null) => string;
  names: Names;
  onClose: () => void;
}) {
  const run = useQuery(flowRunQuery(flow.id, runId));
  const exit = useExitRun(flow.id);
  const [confirming, setConfirming] = useState(false);
  const isOpen = run.data && ['running', 'waiting', 'paused'].includes(run.data.status);

  return (
    <div className="grid gap-5 p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id={titleId} className="text-[19px] font-semibold tracking-[-0.025em]">
            {run.data ? `Run for ${run.data.memberEmail ?? 'a deleted subscriber'}` : 'Run'}
          </h2>
          {run.data && (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-sub">
              <RunPill status={run.data.status} />
              Version {run.data.version}
              {run.data.test && <Pill tone="neutral">Test</Pill>}
            </p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      {run.isPending && <LoadingRows label="Loading the run" rows={3} />}
      {run.error && <ErrorNotice message={run.error.message} />}
      {run.data && (
        <>
          <dl className="grid grid-cols-2 gap-3 text-[13px]">
            <div>
              <dt className="text-sub">Started</dt>
              <dd className="tabular">{formatDateTime(run.data.startedAt)}</dd>
            </div>
            <div>
              <dt className="text-sub">{run.data.endedAt ? 'Ended' : 'Next step at'}</dt>
              <dd className="tabular">{formatDateTime(run.data.endedAt ?? run.data.nextAt)}</dd>
            </div>
            <div>
              <dt className="text-sub">Started by</dt>
              <dd>{startedByText(run.data, names)}</dd>
            </div>
            <div>
              <dt className="text-sub">Current step</dt>
              <dd>{stepTitle(run.data.currentNodeId)}</dd>
            </div>
            {run.data.hold && (
              <div className="col-span-2">
                <dt className="text-sub">Why it is waiting</dt>
                <dd>{heldSentence(run.data.hold)}</dd>
              </div>
            )}
            {run.data.exitReason && (
              <div>
                <dt className="text-sub">
                  {run.data.status === 'paused' ? 'Paused because' : 'Exit reason'}
                </dt>
                <dd>{EXIT_REASON_LABEL[run.data.exitReason]}</dd>
              </div>
            )}
          </dl>

          <section aria-labelledby={`${titleId}-steps`}>
            <h3 id={`${titleId}-steps`} className="text-[15px] font-semibold">
              Steps
            </h3>
            {run.data.steps.length === 0 ? (
              <p className="mt-1 text-[13px] text-sub">No steps have run yet.</p>
            ) : (
              <ol className="mt-3 grid gap-3 border-l-2 border-lavender-line pl-4">
                {run.data.steps.map((step) => (
                  <li key={`${step.nodeId}-${step.attempt}`} className="text-[13px]">
                    <p className="font-semibold">
                      {stepTitle(step.nodeId)}
                      {step.attempt > 1 && (
                        <span className="font-normal text-sub"> · attempt {step.attempt}</span>
                      )}
                    </p>
                    <p className="text-sub">
                      {step.status === 'done'
                        ? `Done${step.outcome && step.outcome !== 'default' ? `: ${EDGE_LABEL[step.outcome as keyof typeof EDGE_LABEL] ?? step.outcome}` : ''}`
                        : step.status === 'pending'
                          ? 'In progress'
                          : step.status === 'skipped'
                            ? 'Skipped'
                            : 'Failed'}
                      {' · '}
                      <span className="tabular">
                        {formatDateTime(step.finishedAt ?? step.startedAt)}
                      </span>
                    </p>
                    {step.error && <p className="mt-0.5 text-danger">{step.error}</p>}
                    {run.data.holds
                      .filter((hold) => hold.nodeId === step.nodeId && step.status !== 'failed')
                      .map((hold) => (
                        <p key={hold.heldAt} className="mt-0.5 text-sub">
                          {hold.releasedAt === null && isOpen
                            ? heldSentence(hold)
                            : heldEndedSentence(hold)}
                        </p>
                      ))}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {canEdit && isOpen && (
            <div className="border-t border-line pt-4">
              {confirming ? (
                <div className="grid gap-3">
                  <p className="text-[13.5px]">
                    Stop this run? Nothing more is sent to this subscriber from this automation.
                  </p>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                      Keep running
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      loading={exit.isPending}
                      onClick={() =>
                        exit.mutate(runId, {
                          onSuccess: () => {
                            setConfirming(false);
                            void run.refetch();
                          },
                        })
                      }
                    >
                      Stop run
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
                  Stop this run
                </Button>
              )}
              {exit.error && (
                <div className="mt-3">
                  <ErrorNotice message={exit.error.message} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
