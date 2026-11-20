// The Flow builder (lazy-loaded with React Flow): the canvas, step palette and inspector, with an
// autosaved draft, inline issues, publish, pause and resume, archive, delete, test runs, Rehearse and
// Add people; plus the Stats and Runs tabs.
import type { Channel, Flow, FlowDraftPending, FlowEdgeLabel, FlowGraph } from '@swarm/domain';
import {
  Button,
  Checkbox,
  Dialog,
  ErrorNotice,
  LoadingRows,
  TextField,
} from '@swarm/ui/components';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { ApiError } from '../api/client';
import {
  flowKeys,
  flowQuery,
  saveDraftGraph,
  useArchiveFlow,
  useDeleteFlow,
  usePauseFlow,
  usePublishFlow,
  useResumeFlow,
  useTestRun,
} from '../api/flows';
import { membersQuery } from '../api/members';
import { channelQuery } from '../api/queries';
import { useDebounced } from '../api/circles';
import { AddPeopleDialog } from '../flows/AddPeopleDialog';
import { FlowCanvas } from '../flows/Canvas';
import {
  PALETTE,
  STEP_INFO,
  addStep,
  connectionProblem,
  issuesByNode,
  layoutGraph,
  localIssues,
  mergeIssues,
  removeNode,
  setOutcome,
  toSavable,
  toWorking,
  withPositions,
  type ActionType,
  type Issue,
  type WorkingGraph,
  type WorkingNode,
} from '../flows/graph';
import { Inspector } from '../flows/Inspector';
import { RehearsePanel, type RehearsalPath } from '../flows/RehearsePanel';
import { useLookups, type Lookups } from '../flows/lookups';
import { FlowPill, openRuns } from '../flows/status';
import { StepIcon } from '../flows/StepIcon';
import { summarize } from '../flows/summary';
import { FlowRunsView } from '../flows/FlowRuns';
import { FlowStatsView } from '../flows/FlowStats';
import { useSession } from '../session';
import { PageHeader } from './Channels';
import { ShareRecipeButton } from './CommunityRecipes';

export type FlowTab = 'build' | 'stats' | 'runs';

const RANK = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 } as const;

export function FlowBuilderPage({ flowId, tab }: { flowId: string; tab: FlowTab }) {
  const flow = useQuery(flowQuery(flowId));
  const channel = useQuery({ ...channelQuery(flow.data?.channelId ?? ''), enabled: !!flow.data });
  if (flow.isPending || (flow.data && channel.isPending)) {
    return <LoadingRows label="Loading the automation" rows={6} />;
  }
  const error = flow.error ?? channel.error;
  if (error || !flow.data || !channel.data) {
    return (
      <ErrorNotice
        title="Automation not available"
        message={error?.message ?? 'This automation could not be loaded.'}
        action={
          <Link to="/flows" className="btn-ghost">
            Back to automations
          </Link>
        }
      />
    );
  }
  return <FlowScreen key={flowId} flow={flow.data} channel={channel.data} tab={tab} />;
}

function FlowScreen({ flow, channel, tab }: { flow: Flow; channel: Channel; tab: FlowTab }) {
  const { workspace } = useSession();
  const role = RANK[channel.role];
  const canEdit = role >= RANK.editor;
  const canAdmin = role >= RANK.admin;
  const readOnly = !canEdit || flow.status === 'archived';
  const lookups = useLookups(channel.id, workspace.id, flow);
  const [dialog, setDialog] = useState<'publish' | 'test' | 'people' | 'archive' | 'delete' | null>(
    null,
  );
  const flushRef = useRef<() => Promise<unknown>>(() => Promise.resolve());
  const issuesRef = useRef<Issue[]>(flow.issues);

  const pause = usePauseFlow(flow);
  const resume = useResumeFlow(flow);
  const lifecycleError = pause.error ?? resume.error;

  const tabs: { id: FlowTab; label: string }[] = [
    { id: 'build', label: 'Build' },
    { id: 'stats', label: 'Stats' },
    { id: 'runs', label: 'Runs' },
  ];

  return (
    <>
      <div className="mb-2 text-[13px]">
        <Link
          to="/flows"
          search={{ channel: channel.id }}
          className="text-sub no-underline hover:text-ink"
        >
          ← Automations
        </Link>
      </div>
      <PageHeader
        title={flow.name}
        subtitle={
          flow.liveVersion
            ? `Version ${flow.liveVersion} is ${flow.status === 'live' ? 'live' : flow.status}. ${openRuns(flow.runs)} runs in progress.`
            : 'Not published yet. Subscribers enrol once it is live.'
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <FlowPill status={flow.status} />
            {canEdit && flow.status !== 'archived' && (
              <>
                {flow.liveVersion !== null && (
                  <Button variant="ghost" onClick={() => setDialog('test')}>
                    Test run
                  </Button>
                )}
                {flow.status === 'live' && (
                  <Button variant="ghost" onClick={() => setDialog('people')}>
                    Add people
                  </Button>
                )}
                {flow.status === 'live' && (
                  <Button
                    variant="ghost"

                    loading={pause.isPending}
                    onClick={() => pause.mutate(undefined)}
                  >
                    Pause
                  </Button>
                )}
                {flow.status === 'paused' && (
                  <Button
                    variant="ghost"

                    loading={resume.isPending}
                    onClick={() => resume.mutate(undefined)}
                  >
                    Resume
                  </Button>
                )}
                <ShareRecipeButton flow={flow} />
                <Button variant="ghost" onClick={() => setDialog('archive')}>
                  Archive
                </Button>
                <Button
                  onClick={() => {
                    void flushRef.current();
                    setDialog('publish');
                  }}
                >
                  {flow.liveVersion ? 'Publish changes' : 'Publish'}
                </Button>
              </>
            )}
            {canEdit && (flow.liveVersion === null || flow.status === 'archived') && (
              <Button variant="danger" onClick={() => setDialog('delete')}>
                Delete
              </Button>
            )}
          </div>
        }
      />
      {lifecycleError && (
        <div className="mb-4">
          <ErrorNotice message={lifecycleError.message} />
        </div>
      )}
      {!canEdit && (
        <p className="mb-4 rounded-card-app border border-line-app bg-surface-alt px-4 py-3 text-[13.5px]">
          You can view this automation. Editors can change and publish it.
        </p>
      )}
      {flow.status === 'archived' && (
        <p className="mb-4 rounded-card-app border border-line-app bg-surface-alt px-4 py-3 text-[13.5px]">
          This automation is archived. It no longer enrols subscribers and can’t be changed.
        </p>
      )}

      <nav
        aria-label="Automation sections"
        className="mb-5 flex gap-1 overflow-x-auto border-b border-line-app"
      >
        {tabs.map((t) => (
          <Link
            key={t.id}
            to="/flows/$flowId"
            params={{ flowId: flow.id }}
            search={t.id === 'build' ? {} : { tab: t.id }}
            className={`-mb-px border-b-2 px-3 pb-3 text-[13.5px] whitespace-nowrap no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple ${
              tab === t.id
                ? 'border-purple font-semibold text-ink'
                : 'border-transparent text-sub hover:text-ink'
            }`}
            aria-current={tab === t.id ? 'page' : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === 'build' && (
        <BuildTab
          flow={flow}
          channel={channel}
          lookups={lookups}
          readOnly={readOnly}
          canAdmin={canAdmin}
          flushRef={flushRef}
          issuesRef={issuesRef}
        />
      )}
      {tab === 'stats' && <FlowStatsView flow={flow} lookups={lookups} />}
      {tab === 'runs' && <FlowRunsView flow={flow} canEdit={canEdit} lookups={lookups} />}

      {dialog === 'publish' && (
        <PublishDialog
          flow={flow}
          flush={() => flushRef.current()}
          issues={() => issuesRef.current}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'test' && <TestRunDialog flow={flow} onClose={() => setDialog(null)} />}
      {dialog === 'people' && (
        <AddPeopleDialog flow={flow} lookups={lookups} onClose={() => setDialog(null)} />
      )}
      {dialog === 'archive' && <ArchiveDialog flow={flow} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <DeleteDialog flow={flow} onClose={() => setDialog(null)} />}
    </>
  );
}

// ---- Build -----------------------------------------------------------------------------------

type SaveState = 'saved' | 'unsaved' | 'saving' | 'error' | 'blocked';
const AUTOSAVE_MS = 800;

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'All changes saved',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  error: 'Not saved',
  blocked: 'Finish the trigger to save',
};

/** Debounced PATCH of the savable part of the working graph, one request at a time. */
function useAutosave(flow: Flow, graph: WorkingGraph, enabled: boolean) {
  const client = useQueryClient();
  const savable = useMemo(() => {
    const { graph: draft, pending } = toSavable(graph);
    return { draft, pending };
  }, [graph]);
  const json = useMemo(() => JSON.stringify(savable), [savable]);
  const blocked = !savable.draft.nodes.some((n) => n.type === 'trigger');
  const [lastSaved, setLastSaved] = useState(json);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [apiIssues, setApiIssues] = useState<Issue[]>(flow.issues);
  const latest = useRef<{
    graph: { draft: FlowGraph; pending: FlowDraftPending | null };
    json: string;
    blocked: boolean;
  }>({
    graph: savable,
    json,
    blocked,
  });
  /** The JSON of the request in flight or last sent, so the same graph is not sent twice. */
  const sent = useRef<string | null>(json);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const next = latest.current;
    if (next.blocked || next.json === sent.current) return queue.current;
    sent.current = next.json;
    setSaving(true);
    queue.current = queue.current
      .then(() => saveDraftGraph(flow.id, next.graph.draft, next.graph.pending))
      .then((saved) => {
        client.setQueryData(flowKeys.flow(flow.id), saved);
        setLastSaved(next.json);
        setApiIssues(saved.issues);
        setError(null);
      })
      .catch((e: Error) => {
        if (sent.current === next.json) sent.current = null;
        setError(e);
      })
      .finally(() => setSaving(false));
    return queue.current;
  }, [client, flow.id]);

  useEffect(() => {
    latest.current = { graph: savable, json, blocked };
    if (!enabled || blocked || json === sent.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  }, [savable, json, blocked, enabled, flush]);

  // Save what is left when the builder unmounts (leaving for the email editor, say).
  useEffect(() => () => void flush(), [flush]);

  const state: SaveState = blocked
    ? 'blocked'
    : saving
      ? 'saving'
      : error
        ? 'error'
        : json !== lastSaved
          ? 'unsaved'
          : 'saved';
  /** Try again after an error: forget the failed request so it is sent again. */
  const retry = useCallback(() => {
    sent.current = null;
    return flush();
  }, [flush]);
  return { state, error, apiIssues, flush, retry };
}

function BuildTab({
  flow,
  channel,
  lookups,
  readOnly,
  canAdmin,
  flushRef,
  issuesRef,
}: {
  flow: Flow;
  channel: Channel;
  lookups: Lookups;
  readOnly: boolean;
  canAdmin: boolean;
  flushRef: MutableRefObject<() => Promise<unknown>>;
  issuesRef: MutableRefObject<Issue[]>;
}) {
  const [graph, setGraph] = useState<WorkingGraph>(() =>
    withPositions(toWorking(flow.draftGraph, flow.draftPending)),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rehearsing, setRehearsing] = useState(false);
  const [path, setPath] = useState<RehearsalPath | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const save = useAutosave(flow, graph, !readOnly);
  useEffect(() => {
    flushRef.current = save.flush;
  }, [flushRef, save.flush]);

  const local = useMemo(() => localIssues(graph), [graph]);
  const issues = useMemo(() => {
    if (save.state !== 'saved') return local;
    const incomplete = local.some((i) => i.code === 'incomplete');
    return mergeIssues(
      save.apiIssues.filter((i) => !(incomplete && i.code === 'unreachable')),
      local,
    );
  }, [local, save.apiIssues, save.state]);
  useEffect(() => {
    issuesRef.current = issues;
  }, [issuesRef, issues]);
  const byNode = useMemo(() => issuesByNode(issues), [issues]);
  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null;

  const focusInspector = () => requestAnimationFrame(() => headingRef.current?.focus());

  const update = (node: WorkingNode) =>
    setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === node.id ? node : n)) }));

  const add = (type: ActionType) => {
    const result = addStep(graph, type, selectedId ?? undefined);
    setGraph(result.graph);
    setSelectedId(result.id);
    setNotice(`${STEP_INFO[type].label} added${selectedId ? ' after the selected step' : ''}.`);
    focusInspector();
  };

  const remove = (id: string) => {
    setGraph((g) => removeNode(g, id));
    setSelectedId(null);
    setConfirmDelete(null);
    setNotice('Step removed.');
  };

  const connect = (from: string, label: FlowEdgeLabel, to: string) => {
    const problem = connectionProblem(graph, from, to, label);
    if (problem) {
      setNotice(problem);
      return;
    }
    setGraph((g) => setOutcome(g, from, label, to));
  };

  const tidy = () => {
    const positions = layoutGraph(graph);
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) => ({
        ...n,
        position: positions[n.id] ?? n.position ?? { x: 0, y: 0 },
      })),
    }));
  };

  const pendingDelete = graph.nodes.find((n) => n.id === confirmDelete);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        {!readOnly && (
          <span
            role="status"
            className={
              save.state === 'error' || save.state === 'blocked'
                ? 'font-semibold text-danger'
                : 'text-sub'
            }
          >
            {SAVE_LABEL[save.state]}
          </span>
        )}
        <span role="status" aria-live="polite" className="text-sub">
          {notice}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {!readOnly && (
            <Button variant="ghost" size="sm" onClick={() => setRehearsing((on) => !on)}>
              {rehearsing ? 'Close rehearsal' : 'Rehearse'}
            </Button>
          )}
          <Button variant="quiet" size="sm" onClick={tidy} disabled={readOnly}>
            Tidy layout
          </Button>
        </span>
      </div>
      {save.error && (
        <ErrorNotice
          title="Your latest changes are not saved"
          message={
            save.error instanceof ApiError && save.error.details.length
              ? `${save.error.message} ${save.error.details.map((d) => d.message).join(' ')}`
              : save.error.message
          }
          action={
            <Button variant="ghost" size="sm" onClick={() => void save.retry()}>
              Try again
            </Button>
          }
        />
      )}

      <div className="grid gap-4 xl:grid-cols-[180px_minmax(0,1fr)_340px]">
        {!readOnly ? (
          <section aria-labelledby="palette-title" className="card-app content-start p-3">
            <h2 id="palette-title" className="px-1 pb-1 text-[13px] font-semibold">
              Add a step
            </h2>
            <p className="px-1 pb-2 text-[11.5px] text-sub">
              {selected
                ? 'Connects after the selected step.'
                : 'Select a step first to connect it.'}
            </p>
            <ul className="grid grid-cols-2 gap-1 sm:grid-cols-3 xl:grid-cols-1">
              {PALETTE.map((type) => (
                <li key={type}>
                  <button
                    type="button"
                    onClick={() => add(type)}
                    className="flex min-h-10 w-full items-center gap-2 rounded-[10px] px-2 text-left text-[13px] text-ink hover:bg-surface-alt focus-visible:outline-2 focus-visible:outline-purple"
                  >
                    <span className="text-purple-deep">
                      <StepIcon type={type} size={15} />
                    </span>
                    <span>
                      <span className="sr-only">Add </span>
                      {STEP_INFO[type].label}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <div className="hidden xl:block" />
        )}

        <div className="min-w-0">
          <FlowCanvas
            graph={graph}
            names={lookups.names}
            issues={byNode}
            selectedId={selectedId}
            readOnly={readOnly}
            path={path}
            label="Automation steps"
            onSelect={setSelectedId}
            onOpenInspector={focusInspector}
            onMove={(id, position) =>
              setGraph((g) => ({
                ...g,
                nodes: g.nodes.map((n) => (n.id === id ? { ...n, position } : n)),
              }))
            }
            onConnect={connect}
            onDeleteRequest={(id) => {
              if (graph.nodes.find((n) => n.id === id)?.type !== 'trigger') setConfirmDelete(id);
            }}
          />
          <p className="mt-2 text-[12px] text-sub">
            Tab to a step and press Enter to edit it, or Delete to remove it. Drag from a step’s
            bottom handle to connect it, or choose the next step in the inspector.
          </p>
        </div>

        <Inspector
          flow={flow}
          channel={channel}
          graph={graph}
          node={selected}
          lookups={lookups}
          issues={selected ? (byNode.get(selected.id) ?? []) : []}
          readOnly={readOnly}
          canAdmin={canAdmin}
          headingRef={headingRef}
          onChange={update}
          onOutcome={(from, label, to) => setGraph((g) => setOutcome(g, from, label, to))}
          onDelete={(id) => setConfirmDelete(id)}
          onClose={() => setSelectedId(null)}
          onBeforeLeave={() => void save.flush()}
        />
      </div>

      {rehearsing && (
        <RehearsePanel
          flow={flow}
          graph={graph}
          lookups={lookups}
          flush={save.flush}
          onPath={setPath}
          onClose={() => setRehearsing(false)}
        />
      )}

      <IssuesAndSteps
        graph={graph}
        issues={issues}
        lookups={lookups}
        onSelect={(id) => {
          setSelectedId(id);
          focusInspector();
        }}
      />

      <Dialog
        open={!!pendingDelete}
        onClose={() => setConfirmDelete(null)}
        title="Remove this step?"
        description={
          pendingDelete
            ? `“${pendingDelete.name || STEP_INFO[pendingDelete.type].label}” and its connections will be removed. Runs already past it are not affected.`
            : undefined
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={() => confirmDelete && remove(confirmDelete)}>
              Remove step
            </Button>
          </>
        }
      />
    </div>
  );
}

function IssuesAndSteps({
  graph,
  issues,
  lookups,
  onSelect,
}: {
  graph: WorkingGraph;
  issues: Issue[];
  lookups: Lookups;
  onSelect: (id: string) => void;
}) {
  const title = (id: string | undefined) => {
    const n = graph.nodes.find((x) => x.id === id);
    return n ? n.name || STEP_INFO[n.type].label : null;
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section aria-labelledby="issues-title" className="card-app p-5">
        <h2 id="issues-title" className="text-[15px] font-semibold">
          {issues.length
            ? `${issues.length === 1 ? '1 issue' : `${issues.length} issues`} to fix before publishing`
            : 'Ready to publish'}
        </h2>
        {issues.length === 0 ? (
          <p className="mt-1 text-[13px] text-sub">Every step is set up and connected.</p>
        ) : (
          <ul className="mt-3 grid gap-2 text-[13px]">
            {issues.map((issue, i) => (
              <li
                key={`${issue.code}-${issue.nodeId ?? ''}-${i}`}
                className="flex items-start justify-between gap-3"
              >
                <span>
                  {title(issue.nodeId) && (
                    <span className="font-semibold">{title(issue.nodeId)}: </span>
                  )}
                  {issue.message}
                </span>
                {issue.nodeId && graph.nodes.some((n) => n.id === issue.nodeId) && (
                  <Button variant="quiet" size="sm" onClick={() => onSelect(issue.nodeId!)}>
                    Show<span className="sr-only"> {title(issue.nodeId)}</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="steps-title" className="card-app p-5">
        <h2 id="steps-title" className="text-[15px] font-semibold">
          Steps
        </h2>
        <ol className="mt-3 grid gap-1.5 text-[13px]">
          {graph.nodes.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => onSelect(n.id)}
                className="flex min-h-9 w-full items-center gap-2 rounded-[10px] px-2 text-left hover:bg-surface-alt focus-visible:outline-2 focus-visible:outline-purple"
              >
                <span className="text-purple-deep">
                  <StepIcon type={n.type} size={14} />
                </span>
                <span className="font-semibold">{n.name || STEP_INFO[n.type].label}</span>
                <span className="truncate text-sub">{summarize(n, lookups.names)}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

// ---- Dialogs ---------------------------------------------------------------------------------

function PublishDialog({
  flow,
  flush,
  issues,
  onClose,
}: {
  flow: Flow;
  flush: () => Promise<unknown>;
  issues: () => Issue[];
  onClose: () => void;
}) {
  const publish = usePublishFlow(flow);
  const [migrate, setMigrate] = useState(false);
  const [resend, setResend] = useState<string[]>([]);
  const [done, setDone] = useState<number | null>(null);
  const [flushed, setFlushed] = useState(false);
  useEffect(() => {
    void flush().then(() => setFlushed(true));
  }, [flush]);
  const current = flushed ? issues() : [];
  const next = Math.max(0, ...flow.versions.map((v) => v.version)) + 1;
  const open = openRuns(flow.runs);
  const error = publish.error instanceof ApiError ? publish.error : null;
  const emailSteps = flow.draftGraph.nodes.flatMap((n) =>
    n.type === 'send_email'
      ? [
          {
            id: n.id,
            label:
              flow.emails.find((e) => e.dispatchId === n.config.dispatchId)?.subject ||
              n.name ||
              STEP_INFO.send_email.label,
          },
        ]
      : [],
  );

  if (done !== null) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={`Version ${done} is live`}
        description="Subscribers who match the trigger now enrol in this version."
        actions={<Button onClick={onClose}>Done</Button>}
      />
    );
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Publish version ${next}?`}
      description={
        flow.liveVersion
          ? `Version ${flow.liveVersion} is replaced for new enrolments. Each email step is frozen as it is now.`
          : 'The automation goes live and starts enrolling subscribers. Each email step is frozen as it is now.'
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!flushed || current.length > 0}
            loading={publish.isPending || !flushed}
            onClick={() =>
              publish.mutate(
                { migrateRuns: migrate, resendNodeIds: resend },
                { onSuccess: (r) => setDone(r.version) },
              )
            }
          >
            Publish version {next}
          </Button>
        </>
      }
    >
      {flushed && current.length > 0 && (
        <div className="rounded-card-app bg-danger-soft px-3 py-2 text-[13px] text-danger">
          <p className="font-semibold">Fix these first:</p>
          <ul className="mt-1 list-disc pl-5">
            {current.slice(0, 6).map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}
      {flow.liveVersion !== null && open > 0 && (
        <label className="flex items-start gap-2.5 text-[13.5px]">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-purple"
            checked={migrate}
            onChange={(e) => setMigrate(e.target.checked)}
          />
          <span className="font-semibold">
            Move the {open} runs in progress to the new version
            <span className="block text-[12.5px] font-normal text-sub">
              They continue at the step with the same id. Otherwise they finish on their own
              version.
            </span>
          </span>
        </label>
      )}
      {flow.liveVersion !== null && emailSteps.length > 0 && (
        <fieldset className="mt-3 grid gap-2">
          <legend className="text-[13.5px] font-semibold">Send an email again</legend>
          <p className="text-[12.5px] text-sub">
            Subscribers who already got an email from this automation don’t get it again from the
            new version. Tick an email to let it reach them again if they get to that step.
          </p>
          <div className="grid max-h-40 gap-2 overflow-y-auto">
            {emailSteps.map((step) => (
              <Checkbox
                key={step.id}
                label={step.label}
                checked={resend.includes(step.id)}
                onChange={(on) =>
                  setResend((list) =>
                    on ? [...list, step.id] : list.filter((id) => id !== step.id),
                  )
                }
              />
            ))}
          </div>
        </fieldset>
      )}
      {publish.error && (
        <div className="mt-3">
          <ErrorNotice
            title="Not published"
            message={
              error?.details.length
                ? `${error.message} ${error.details.map((d) => d.message).join(' ')}`
                : publish.error.message
            }
          />
        </div>
      )}
    </Dialog>
  );
}

function TestRunDialog({ flow, onClose }: { flow: Flow; onClose: () => void }) {
  const [q, setQ] = useState('');
  const search = useDebounced(q, 300);
  const members = useQuery(membersQuery(flow.channelId, { q: search }));
  const [memberId, setMemberId] = useState<string | null>(null);
  const start = useTestRun(flow.id);
  const navigate = useNavigate();
  const chosen = members.data?.items.find((m) => m.id === memberId);

  if (start.data) {
    return (
      <Dialog
        open
        onClose={onClose}
        title="Test run started"
        description={`${start.data.memberEmail ?? 'The subscriber'} is going through version ${start.data.version}. Test runs send real emails and are left out of stats. They don’t use up this subscriber’s real emails.`}
        actions={
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button
              onClick={() => {
                onClose();
                void navigate({
                  to: '/flows/$flowId',
                  params: { flowId: flow.id },
                  search: { tab: 'runs' },
                });
              }}
            >
              See runs
            </Button>
          </>
        }
      />
    );
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Start a test run"
      description={`Runs live version ${flow.liveVersion} for one subscriber. Emails really send, with the usual checks.`}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!memberId}
            loading={start.isPending}
            onClick={() => memberId && start.mutate(memberId)}
          >
            {chosen ? `Start for ${chosen.email}` : 'Start test run'}
          </Button>
        </>
      }
    >
      <TextField
        label="Find a subscriber"
        type="search"
        placeholder="Email or name"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="mt-3 max-h-56 overflow-y-auto">
        {members.isPending && <LoadingRows label="Loading subscribers" rows={2} />}
        {members.error && <ErrorNotice message={members.error.message} />}
        {members.data?.items.length === 0 && (
          <p className="text-[13px] text-sub">
            No subscribers match. Add yourself as a subscriber to test.
          </p>
        )}
        {!!members.data?.items.length && (
          <fieldset>
            <legend className="sr-only">Subscriber</legend>
            <ul className="grid gap-1">
              {members.data.items.map((m) => (
                <li key={m.id}>
                  <label className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-[10px] px-2 text-[13.5px] hover:bg-surface-alt">
                    <input
                      type="radio"
                      name="test-member"
                      className="size-4 accent-purple"
                      checked={memberId === m.id}
                      onChange={() => setMemberId(m.id)}
                    />
                    <span className="min-w-0 truncate">{m.email}</span>
                    <span className="ml-auto text-[12px] text-sub">{m.status}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
      </div>
      {start.error && (
        <div className="mt-3">
          <ErrorNotice title="The test run did not start" message={start.error.message} />
        </div>
      )}
    </Dialog>
  );
}

function ArchiveDialog({ flow, onClose }: { flow: Flow; onClose: () => void }) {
  const archive = useArchiveFlow(flow);
  const open = openRuns(flow.runs);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Archive this automation?"
      description={`It stops for good: no one new enrols${open ? `, and the ${open} runs in progress end` : ''}. You can delete it afterwards. This can’t be undone.`}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="danger"
            loading={archive.isPending}
            onClick={() => archive.mutate(undefined, { onSuccess: onClose })}
          >
            Archive automation
          </Button>
        </>
      }
    >
      {archive.error && <ErrorNotice message={archive.error.message} />}
    </Dialog>
  );
}

function DeleteDialog({ flow, onClose }: { flow: Flow; onClose: () => void }) {
  const del = useDeleteFlow(flow);
  const navigate = useNavigate();
  return (
    <Dialog
      open
      onClose={onClose}
      title="Delete this automation?"
      description="The automation and its draft are removed. This can’t be undone."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="danger"
            loading={del.isPending}
            onClick={() =>
              del.mutate(undefined, {
                onSuccess: () =>
                  void navigate({ to: '/flows', search: { channel: flow.channelId } }),
              })
            }
          >
            Delete automation
          </Button>
        </>
      }
    >
      {del.error && <ErrorNotice message={del.error.message} />}
    </Dialog>
  );
}
