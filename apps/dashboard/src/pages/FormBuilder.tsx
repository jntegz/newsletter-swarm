// The Capture Form builder: settings on the left, a live preview with a trigger simulator on the
// right, then publish with version history, the embed code and daily stats.
import type { CaptureForm, Channel, MemberField, SeatRole } from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  SelectField,
  Tabs,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  captureFormQuery,
  captureSnippetQuery,
  captureStatsQuery,
  captureVersionsQuery,
  memberFieldsQuery,
  useDeleteCaptureForm,
  usePublishCaptureForm,
  useRestoreCaptureVersion,
  useSaveCaptureForm,
  type CaptureFormStats,
} from '../api/capture';
import { channelQuery, seatsQuery } from '../api/queries';
import {
  describeChanges,
  effectiveAccent,
  frequencySummary,
  placementLabel,
  triggerSummary,
  validateConfig,
  type Config,
} from '../capture/config';
import { buildPreviewHtml } from '../capture/preview';
import {
  frequencyExplainer,
  initialSim,
  previewState,
  simulate,
  triggerButtons,
  type SimAction,
} from '../capture/simulator';
import * as Icon from '../icons';
import { useSession } from '../session';
import { FormStatusPill } from './CaptureForms';
import { FormSettings } from './FormSettings';
import { PlacementSection } from '../capture/PlacementEditor';
import { Section, formatDateTime, numberFormat, percentFormat } from './common';

const AUTOSAVE_MS = 1200;
const RANK: Record<SeatRole, number> = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 };

export function FormBuilderPage({ formId }: { formId: string }) {
  const form = useQuery(captureFormQuery(formId));
  // Bumped when the draft is replaced on the server (a restored version), to reload the builder.
  const [generation, setGeneration] = useState(0);
  if (form.isPending) return <LoadingRows label="Loading signup form" rows={6} />;
  if (form.error) {
    return (
      <ErrorNotice
        title="Signup form not available"
        message={form.error.message}
        action={
          <Link to="/forms" className="btn-ghost">
            Back to signup forms
          </Link>
        }
      />
    );
  }
  return (
    <Builder
      key={`${formId}-${generation}`}
      initial={form.data}
      onReplaced={() => setGeneration((n) => n + 1)}
    />
  );
}

type SaveState = 'saved' | 'unsaved' | 'saving' | 'error' | 'invalid';
type Tab = 'build' | 'embed' | 'stats';

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'All changes saved',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  error: 'Not saved',
  invalid: 'Not saved: fix the highlighted settings',
};

function Builder({ initial, onReplaced }: { initial: CaptureForm; onReplaced: () => void }) {
  const id = initial.id;
  const live = useQuery(captureFormQuery(id)).data ?? initial;
  const channel = useQuery(channelQuery(initial.channelId));
  const defs = useQuery(memberFieldsQuery(initial.channelId));
  const role = channel.data?.role ?? 'viewer';
  const canWrite = RANK[role] >= RANK.author;
  const canPublish = RANK[role] >= RANK.editor;

  const save = useSaveCaptureForm(id);
  const [name, setName] = useState(initial.name);
  const [config, setConfig] = useState<Config>(initial.draft);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const latest = useRef({ name: initial.name, config: initial.draft });
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const issues = useMemo(() => validateConfig(config), [config]);

  /** Saves the latest valid draft. Saves run one at a time, in order. */
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (!dirty.current) return queue.current;
    const { name: nextName, config: nextConfig } = latest.current;
    if (!nextName.trim() || validateConfig(nextConfig).length) {
      setSaveState('invalid');
      return queue.current;
    }
    dirty.current = false;
    setSaveState('saving');
    queue.current = queue.current
      .then(() => save.mutateAsync({ name: nextName.trim(), config: nextConfig }))
      .then(() => {
        setSaveError(null);
        setSaveState(dirty.current ? 'unsaved' : 'saved');
      })
      .catch((error: Error) => {
        dirty.current = true;
        setSaveState('error');
        setSaveError(error.message);
      });
    return queue.current;
  }, [save]);

  const changed = useCallback(() => {
    dirty.current = true;
    setSaveState('unsaved');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  }, [flush]);

  const editConfig = useCallback(
    (update: (config: Config) => Config) => {
      const next = update(latest.current.config);
      latest.current = { ...latest.current, config: next };
      setConfig(next);
      changed();
    },
    [changed],
  );

  const editName = (value: string) => {
    latest.current = { ...latest.current, name: value };
    setName(value);
    changed();
  };

  // Warn before leaving with unsaved work; save what we have when the page unmounts.
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty.current) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      void flush();
    };
  }, [flush]);

  const [tab, setTab] = useState<Tab>('build');
  const [publishing, setPublishing] = useState(false);
  const [history, setHistory] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [published, setPublished] = useState<number | null>(null);

  if (channel.isPending) return <LoadingRows label="Loading signup form" rows={6} />;
  if (channel.error) return <ErrorNotice message={channel.error.message} />;

  const invalid = issues.length > 0 || !name.trim();

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-[13px]">
        <Link
          to="/forms"
          search={{ channel: live.channelId }}
          className="text-sub no-underline hover:text-ink"
        >
          ← Signup forms
        </Link>
        <FormStatusPill form={live} />
        {live.version > 0 && <span className="tabular text-sub">Live: v{live.version}</span>}
        <span
          role="status"
          aria-live="polite"
          className={
            saveState === 'error' || saveState === 'invalid'
              ? 'font-semibold text-danger'
              : 'text-sub'
          }
        >
          {canWrite ? SAVE_LABEL[saveState] : 'Read only: your role can view this form'}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setHistory(true)}>
            Version history
          </Button>
          {canPublish && (
            <Button
              size="sm"
              disabled={invalid}
              onClick={() => {
                void flush();
                setPublishing(true);
              }}
            >
              Publish
            </Button>
          )}
        </div>
      </div>

      {saveError && (
        <div className="mb-4">
          <ErrorNotice
            title="Your latest changes are not saved"
            message={saveError}
            action={
              <Button variant="ghost" size="sm" onClick={() => void flush()}>
                Try again
              </Button>
            }
          />
        </div>
      )}
      {published !== null && (
        <p
          role="status"
          className="mb-4 rounded-card-app bg-success-soft px-4 py-3 text-[13.5px] text-success"
        >
          Version {published} is published. Copy the new embed code below.
        </p>
      )}

      <div className="mb-5">
        <label htmlFor="form-name" className="sr-only">
          Form name
        </label>
        <input
          id="form-name"
          value={name}
          maxLength={80}
          readOnly={!canWrite}
          placeholder="Form name"
          aria-invalid={!name.trim() || undefined}
          onChange={(e) => editName(e.target.value)}
          className="w-full bg-transparent text-[26px] leading-tight font-bold tracking-[-0.035em] text-ink outline-none placeholder:text-muted focus-visible:rounded-[8px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple"
        />
        {!name.trim() && (
          <p role="alert" className="mt-1 text-[12.5px] font-semibold text-danger">
            Name the form.
          </p>
        )}
      </div>

      <FormTabs tab={tab} onChange={setTab} />

      <div
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        tabIndex={0}
        className="mt-5 outline-none"
      >
        {tab === 'build' && (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <div className="min-w-0">
              {defs.error && (
                <div className="mb-4">
                  <ErrorNotice title="Profile fields not available" message={defs.error.message} />
                </div>
              )}
              {live.kind === 'prompt' && (
                <div className="mb-5">
                  <PlacementSection form={live} canWrite={canWrite} />
                </div>
              )}
              <FormSettings
                config={config}
                onChange={editConfig}
                issues={issues}
                defs={defs.data ?? []}
                channel={channel.data}
                readOnly={!canWrite}
              />
            </div>
            <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">
              <PreviewPanel config={config} defs={defs.data ?? []} channel={channel.data} />
            </div>
          </div>
        )}
        {tab === 'embed' && (
          <EmbedPanel
            form={live}
            canPublish={canPublish}
            onPublish={() => {
              void flush();
              setPublishing(true);
            }}
          />
        )}
        {tab === 'stats' && <StatsPanel form={live} />}
      </div>

      {canPublish && (
        <div className="mt-8">
          <Section
            title="Delete this form"
            description="The form stops showing on every site at once. Subscribers who joined through it keep it as their source."
          >
            <Button variant="danger" onClick={() => setDeleting(true)}>
              Delete form
            </Button>
          </Section>
        </div>
      )}

      {publishing && (
        <PublishDialog
          form={live}
          draft={config}
          flush={() => flush().then(() => !dirty.current)}
          onClose={() => setPublishing(false)}
          onPublished={(version) => {
            setPublishing(false);
            setPublished(version);
            setTab('embed');
          }}
        />
      )}
      {history && (
        <HistoryDialog
          form={live}
          canRestore={canWrite}
          flush={flush}
          onClose={() => setHistory(false)}
          onRestored={() => {
            setHistory(false);
            onReplaced();
          }}
        />
      )}
      {deleting && <DeleteDialog form={live} onClose={() => setDeleting(false)} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Tabs

const TABS: { id: Tab; label: string }[] = [
  { id: 'build', label: 'Build' },
  { id: 'embed', label: 'Embed' },
  { id: 'stats', label: 'Stats' },
];

function FormTabs({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  return (
    <Tabs
      label="Signup form"
      tabs={TABS}
      value={tab}
      onChange={onChange}
      idFor={(id) => `tab-${id}`}
      panelFor={(id) => `panel-${id}`}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Preview and trigger simulator

function PreviewPanel({
  config,
  defs,
  channel,
}: {
  config: Config;
  defs: readonly MemberField[];
  channel: Channel;
}) {
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  // The simulation starts over whenever the rules it models change.
  const rules = JSON.stringify([config.trigger, config.placement, config.frequency]);
  const [sim, setSim] = useState(() => ({ rules, state: initialSim(config) }));
  const state = sim.rules === rules ? sim.state : initialSim(config);
  if (sim.rules !== rules) setSim({ rules, state });
  const act = (action: SimAction) =>
    setSim((s) => ({
      rules,
      state: simulate(s.rules === rules ? s.state : state, action, config),
    }));

  const html = useMemo(
    () =>
      buildPreviewHtml({
        config,
        defs,
        accent: effectiveAccent(config, channel.branding.accentColor),
        state: previewState(state),
        scroll: state.scroll,
      }),
    [config, defs, channel.branding.accentColor, state],
  );

  const overlay = config.placement !== 'inline';
  const buttons = triggerButtons(config);
  const days = config.frequency.type === 'once_per_days' ? config.frequency.days : null;
  const status = state.shown
    ? state.joined
      ? 'The visitor joined. The form shows the success state.'
      : 'The form is showing.'
    : state.closed
      ? 'The visitor closed the form.'
      : `Waiting: shows ${triggerSummary(config.trigger).toLowerCase()}.`;

  return (
    <section aria-labelledby="preview-title" className="card-app grid gap-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="preview-title" className="text-[15px] font-semibold">
            Preview
          </h2>
          <p className="text-[12.5px] text-sub">
            The draft on a sample page: {placementLabel(config.placement).toLowerCase()},{' '}
            {config.layout} layout.
          </p>
        </div>
        <div role="group" aria-label="Preview width" className="flex gap-1">
          {(['desktop', 'mobile'] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={device === d}
              onClick={() => setDevice(d)}
              className={`min-h-9 rounded-pill px-3 text-[12.5px] font-semibold focus-visible:outline-2 focus-visible:outline-purple ${
                device === d ? 'bg-lavender text-purple-deep' : 'text-sub hover:text-ink'
              }`}
            >
              {d === 'desktop' ? 'Desktop' : 'Mobile'}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-card-app bg-surface-alt p-2">
        {/* No scripts, forms or same-origin access: a static picture of the form. */}
        <iframe
          title="Preview of the signup form on a sample page"
          sandbox=""
          srcDoc={html}
          className="mx-auto block h-[520px] rounded-[10px] border border-line-app bg-white"
          style={{ width: device === 'desktop' ? '100%' : 375, maxWidth: '100%' }}
        />
      </div>

      <div className="grid gap-3 border-t border-line pt-4">
        <div>
          <h3 className="text-[14px] font-semibold">Trigger simulator</h3>
          <p className="text-[12.5px] text-sub">
            Visit {state.visit}
            {state.day > 0 ? `, ${state.day} ${state.day === 1 ? 'day' : 'days'} later` : ''}.
            {config.trigger.type === 'scroll' && ` Scrolled ${state.scroll}%.`}
            {config.trigger.type === 'delay' && ` ${state.waited} s on the page.`}
          </p>
        </div>
        <p role="status" aria-live="polite" className="text-[13.5px]">
          <span className="font-semibold">{status}</span>
          {state.note && <span className="block text-sub">{state.note}</span>}
        </p>
        <div className="flex flex-wrap gap-2">
          {buttons.map((b) => (
            <Button key={b.label} variant="ghost" size="sm" onClick={() => act(b.action)}>
              {b.label}
            </Button>
          ))}
          {state.shown && !state.joined && (
            <Button variant="ghost" size="sm" onClick={() => act({ type: 'join' })}>
              Submit the form
            </Button>
          )}
          {state.shown && overlay && (
            <Button variant="ghost" size="sm" onClick={() => act({ type: 'close' })}>
              Close the form
            </Button>
          )}
          <Button variant="quiet" size="sm" onClick={() => act({ type: 'visit', afterDays: 0 })}>
            Visit again
          </Button>
          {days !== null && (
            <Button
              variant="quiet"
              size="sm"
              onClick={() => act({ type: 'visit', afterDays: days })}
            >
              Visit again in {days} {days === 1 ? 'day' : 'days'}
            </Button>
          )}
          <Button variant="quiet" size="sm" onClick={() => act({ type: 'reset' })}>
            Start over
          </Button>
        </div>
        <p className="rounded-control bg-surface-alt px-3 py-2 text-[12.5px] leading-[1.5] text-sub">
          <span className="font-semibold text-ink">{frequencySummary(config.frequency)}.</span>{' '}
          {frequencyExplainer(config)}
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Publish

function PublishDialog({
  form,
  draft,
  flush,
  onClose,
  onPublished,
}: {
  form: CaptureForm;
  draft: Config;
  /** Saves pending edits; resolves to whether the draft on the server is now current. */
  flush: () => Promise<boolean>;
  onClose: () => void;
  onPublished: (version: number) => void;
}) {
  const publish = usePublishCaptureForm(form.id);
  const [unsaved, setUnsaved] = useState(false);
  const changes = describeChanges(form.published, draft);
  const next = form.version + 1;
  const first = form.version === 0;
  return (
    <Dialog
      open
      onClose={onClose}
      title={first ? 'Publish this form?' : `Publish version ${next}?`}
      description={
        first
          ? 'The form goes live. Then paste its embed code into your site.'
          : `Version ${next} replaces version ${form.version}. Sites keep showing version ${form.version} until you paste the new embed code, because the code is pinned to a version.`
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={publish.isPending}
            disabled={!first && changes.length === 0}
            onClick={() =>
              // Publish exactly what is on screen: save pending edits first.
              void flush().then((saved) => {
                setUnsaved(!saved);
                if (saved) publish.mutate(undefined, { onSuccess: (f) => onPublished(f.version) });
              })
            }
          >
            {first ? 'Publish' : `Publish version ${next}`}
          </Button>
        </>
      }
    >
      <h3 className="text-[13px] font-semibold">{first ? 'What goes live' : 'What changes'}</h3>
      {changes.length ? (
        <ul className="mt-2 grid max-h-64 list-disc gap-1 overflow-y-auto pl-5 text-[13.5px]">
          {changes.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[13.5px] text-sub">
          The draft is the same as the live version. Nothing to publish.
        </p>
      )}
      {unsaved && (
        <div className="mt-3">
          <ErrorNotice
            title="Not published"
            message="Your latest changes could not be saved, so they would not go live. Fix the draft or try again."
          />
        </div>
      )}
      {publish.error && (
        <div className="mt-3">
          <ErrorNotice message={publish.error.message} />
        </div>
      )}
    </Dialog>
  );
}

function HistoryDialog({
  form,
  canRestore,
  flush,
  onClose,
  onRestored,
}: {
  form: CaptureForm;
  canRestore: boolean;
  flush: () => Promise<unknown>;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { workspace, me } = useSession();
  const versions = useQuery(captureVersionsQuery(form.id));
  const seats = useQuery(seatsQuery(workspace.id));
  const restore = useRestoreCaptureVersion(form.id);
  const publisher = (operatorId: string | null) => {
    if (!operatorId) return 'Unknown';
    if (operatorId === me.operator.id) return 'You';
    const seat = seats.data?.find((s) => s.operator.id === operatorId);
    return seat ? (seat.operator.name ?? seat.operator.email) : 'A former teammate';
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Version history"
      description="Every publish is kept. Restoring copies a version into the draft; publish it to make it live again."
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {versions.isPending && <LoadingRows label="Loading versions" rows={2} />}
      {versions.error && <ErrorNotice message={versions.error.message} />}
      {versions.data?.length === 0 && (
        <p className="text-[13.5px] text-sub">Nothing published yet. The draft is all there is.</p>
      )}
      {!!versions.data?.length && (
        <ul className="grid max-h-80 gap-1 overflow-y-auto text-[13px]">
          {versions.data.map((v) => (
            <li
              key={v.version}
              className="flex items-center justify-between gap-2 rounded-[10px] px-2 py-2 hover:bg-surface-alt"
            >
              <span className="min-w-0">
                <span className="flex items-center gap-2 font-semibold">
                  Version {v.version}
                  {v.version === form.version && <Pill tone="success">Live</Pill>}
                </span>
                <span className="block truncate text-[12px] text-sub">
                  {formatDateTime(v.publishedAt)} · {publisher(v.publishedBy)} ·{' '}
                  {placementLabel(v.config.placement)}
                </span>
              </span>
              {canRestore && (
                <Button
                  variant="quiet"
                  size="sm"
                  aria-label={`Restore to draft: version ${v.version}`}
                  loading={restore.isPending && restore.variables === v.version}
                  onClick={() =>
                    // Save pending edits first, so they can't overwrite the restored draft.
                    void flush().then(() => restore.mutate(v.version, { onSuccess: onRestored }))
                  }
                >
                  Restore to draft
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {restore.error && (
        <div className="mt-3">
          <ErrorNotice message={restore.error.message} />
        </div>
      )}
    </Dialog>
  );
}

function DeleteDialog({ form, onClose }: { form: CaptureForm; onClose: () => void }) {
  const navigate = useNavigate();
  const remove = useDeleteCaptureForm(form);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete ${form.name}?`}
      description="The form stops showing on every site at once, and this cannot be undone."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep form
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(undefined, {
                onSuccess: () =>
                  void navigate({ to: '/forms', search: { channel: form.channelId } }),
              })
            }
          >
            Delete form
          </Button>
        </>
      }
    >
      {remove.error && <ErrorNotice message={remove.error.message} />}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Embed code

function EmbedPanel({
  form,
  canPublish,
  onPublish,
}: {
  form: CaptureForm;
  canPublish: boolean;
  onPublish: () => void;
}) {
  const published = form.version > 0;
  const snippet = useQuery({ ...captureSnippetQuery(form.id), enabled: published });
  if (!published) {
    return (
      <EmptyState
        title="Publish to get the embed code"
        action={canPublish && <Button onClick={onPublish}>Publish</Button>}
      >
        {canPublish
          ? 'The code points at a published version, so it appears after the first publish.'
          : 'An editor publishes the form; the code appears here afterwards.'}
      </EmptyState>
    );
  }
  if (snippet.isPending) return <LoadingRows label="Loading the embed code" rows={3} />;
  if (snippet.error) {
    return (
      <ErrorNotice
        message={snippet.error.message}
        action={
          <Button variant="ghost" onClick={() => void snippet.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  const s = snippet.data;
  return (
    <div className="grid max-w-[860px] gap-5">
      {form.hasUnpublishedChanges && (
        <p className="rounded-card-app bg-scheduled-soft px-4 py-3 text-[13.5px] text-scheduled">
          The draft has changes that are not live. This code shows version {s.version}.
        </p>
      )}
      <Section
        title="Embed code"
        description={`For version ${s.version}. It carries an integrity hash of that exact version, so paste it again after each publish.`}
      >
        <CodeBlock label="embed code" code={s.script} />
        <ol className="mt-4 grid list-decimal gap-1.5 pl-5 text-[13.5px] leading-[1.55]">
          <li>Copy the code.</li>
          <li>
            {form.published?.placement === 'inline'
              ? 'Paste it into your page where the form should appear. To place it somewhere else, add an element with data-swarm-form="' +
                form.id +
                '" and the form goes inside it.'
              : 'Paste it anywhere in your page, for example just before </body>. The form opens over the page when its trigger fires.'}
          </li>
          <li>
            {form.published?.allowedOrigins.length
              ? `It only loads on ${form.published.allowedOrigins.join(', ')}. Add other sites under Allowed sites.`
              : 'It loads on any site. Limit it under Allowed sites.'}
          </li>
        </ol>
      </Section>
      <Section
        title="Form without JavaScript"
        description="A plain HTML form that works when JavaScript is off or a page can't load scripts. Paste it where the form should appear. It posts straight to Swarm, and visitors may be asked to pass a quick check first."
      >
        <CodeBlock label="HTML form" code={s.noscript} />
        <p className="mt-3 text-[13px] text-sub">
          It carries the email, name and consent fields. Profile fields need the embed code above.
        </p>
      </Section>
      <Section
        title="First-visit tracking (optional)"
        description="Paste this on every page of your site to remember where each visitor first came from. Subscribers who join later keep that source. Stored only in the visitor’s own browser."
      >
        <CodeBlock label="tracking code" code={s.attribution} />
      </Section>
    </div>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const copy = () => {
    const done = navigator.clipboard?.writeText(code);
    if (!done) {
      setCopied('failed');
      return;
    }
    done.then(
      () => setCopied('yes'),
      () => setCopied('failed'),
    );
    setTimeout(() => setCopied(null), 2000);
  };
  return (
    <div className="grid gap-2">
      <pre
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- it scrolls, so a keyboard has to reach it
        tabIndex={0}
        className="max-h-64 overflow-auto rounded-card-app border border-line-app bg-surface-alt p-3 font-mono text-[12.5px] leading-[1.6] break-all whitespace-pre-wrap"
      >
        <code>{code}</code>
      </pre>
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={copy}>
          {copied === 'yes' ? <Icon.Check size={14} /> : <Icon.Copy size={14} />}
          Copy {label}
        </Button>
        <span role="status" className="text-[12.5px] text-sub">
          {copied === 'yes'
            ? 'Copied.'
            : copied === 'failed'
              ? 'Copying is blocked here. Select the code and copy it by hand.'
              : ''}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Stats

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const dayLabel = (day: string) => dayFormat.format(new Date(`${day}T00:00:00Z`));

function StatsPanel({ form }: { form: CaptureForm }) {
  const [days, setDays] = useState(30);
  const stats = useQuery(captureStatsQuery(form.id, days));
  return (
    <div className="grid gap-5">
      <div className="max-w-[220px]">
        <SelectField
          label="Period"
          value={String(days)}
          onChange={(e) => setDays(Number(e.target.value))}
          options={[
            { value: '7', label: 'Last 7 days' },
            { value: '30', label: 'Last 30 days' },
            { value: '90', label: 'Last 90 days' },
          ]}
        />
      </div>
      {stats.isPending && <LoadingRows label="Loading stats" rows={3} />}
      {stats.error && <ErrorNotice message={stats.error.message} />}
      {stats.data && <Stats stats={stats.data} days={days} published={form.version > 0} />}
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-[16px] border border-line-app bg-surface p-4">
      <p className="text-[11.5px] font-semibold text-sub">{label}</p>
      <p className="tabular mt-1 text-[25px] font-bold tracking-[-0.03em]">{value}</p>
      {hint && <p className="text-[12px] text-sub">{hint}</p>}
    </div>
  );
}

const rate = (part: number, whole: number) => (whole ? percentFormat.format(part / whole) : '—');

function Stats({
  stats,
  days,
  published,
}: {
  stats: CaptureFormStats;
  days: number;
  published: boolean;
}) {
  const { totals } = stats;
  if (!published && totals.views === 0) {
    return (
      <EmptyState title="No numbers yet">
        Stats start once the form is published and shown on your site.
      </EmptyState>
    );
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Views" value={numberFormat.format(totals.views)} />
        <Kpi
          label="Submissions"
          value={numberFormat.format(totals.submissions)}
          hint={`${rate(totals.submissions, totals.views)} of views`}
        />
        <Kpi
          label="Confirmed"
          value={numberFormat.format(totals.confirmed)}
          hint={`${rate(totals.confirmed, totals.submissions)} of submissions`}
        />
        <Kpi
          label="Conversion"
          value={stats.conversion === null ? '—' : percentFormat.format(stats.conversion)}
          hint="Confirmed subscribers per view"
        />
      </div>
      <Section
        title="Per day"
        description={`Submissions and confirmed subscribers over the last ${days} days, in UTC.`}
      >
        <DailyChart stats={stats} />
        <details className="mt-4">
          <summary className="cursor-pointer text-[13px] font-semibold text-purple-deep">
            Show the numbers as a table
          </summary>
          <DailyTable stats={stats} />
        </details>
      </Section>
    </>
  );
}

/** Bars per day: submissions, with the confirmed share inside. Described in text for readers. */
function DailyChart({ stats }: { stats: CaptureFormStats }) {
  const titleId = useId();
  const max = Math.max(1, ...stats.days.map((d) => d.submissions));
  const best = stats.days.reduce<(typeof stats.days)[number] | null>(
    (top, d) => (!top || d.submissions > top.submissions ? d : top),
    null,
  );
  const width = 640;
  const height = 160;
  const gap = 2;
  const bar = Math.max(2, width / stats.days.length - gap);
  const summary = best?.submissions
    ? `${numberFormat.format(stats.totals.submissions)} submissions and ${numberFormat.format(stats.totals.confirmed)} confirmed in ${stats.days.length} days. Busiest day: ${dayLabel(best.day)} with ${numberFormat.format(best.submissions)}.`
    : `No submissions in ${stats.days.length} days.`;
  return (
    <figure className="m-0">
      <svg
        role="img"
        aria-labelledby={titleId}
        viewBox={`0 0 ${width} ${height + 20}`}
        className="h-auto w-full"
        preserveAspectRatio="none"
      >
        <title id={titleId}>{summary}</title>
        <line x1="0" x2={width} y1={height} y2={height} stroke="var(--chart-grid)" />
        <line x1="0" x2={width} y1={height / 2} y2={height / 2} stroke="var(--chart-grid)" />
        {stats.days.map((d, i) => {
          const x = i * (bar + gap);
          const h = (d.submissions / max) * (height - 8);
          const c = (d.confirmed / max) * (height - 8);
          return (
            <g key={d.day}>
              <rect x={x} y={height - h} width={bar} height={h} rx="2" fill="var(--chart-2)" />
              <rect x={x} y={height - c} width={bar} height={c} rx="2" fill="var(--chart-1)" />
            </g>
          );
        })}
        <text x="0" y={height + 16} fontSize="11" fill="var(--text-sub)">
          {stats.days[0] ? dayLabel(stats.days[0].day) : ''}
        </text>
        <text x={width} y={height + 16} fontSize="11" fill="var(--text-sub)" textAnchor="end">
          {stats.days.at(-1) ? dayLabel(stats.days.at(-1)!.day) : ''}
        </text>
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-4 text-[12.5px] text-sub">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 rounded-full bg-[var(--chart-2)]" />
          Submissions
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 rounded-full bg-purple" />
          Confirmed
        </span>
        <span>Busiest day peaks at {numberFormat.format(max)}.</span>
      </figcaption>
    </figure>
  );
}

function DailyTable({ stats }: { stats: CaptureFormStats }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-[13px]">
        <caption className="sr-only">Views, submissions and confirmed subscribers per day</caption>
        <thead>
          <tr className="table-head">
            <th scope="col" className="py-2 pr-3 font-semibold">
              Day
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              Views
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              Submissions
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              Confirmed
            </th>
            <th scope="col" className="py-2 pl-3 text-right font-semibold">
              Conversion
            </th>
          </tr>
        </thead>
        <tbody>
          {[...stats.days].reverse().map((d) => (
            <tr key={d.day} className="border-t border-line">
              <th scope="row" className="py-1.5 pr-3 font-normal">
                {dayLabel(d.day)}
              </th>
              <td className="tabular px-3 py-1.5 text-right">{numberFormat.format(d.views)}</td>
              <td className="tabular px-3 py-1.5 text-right">
                {numberFormat.format(d.submissions)}
              </td>
              <td className="tabular px-3 py-1.5 text-right">{numberFormat.format(d.confirmed)}</td>
              <td className="tabular py-1.5 pl-3 text-right">{rate(d.confirmed, d.views)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
