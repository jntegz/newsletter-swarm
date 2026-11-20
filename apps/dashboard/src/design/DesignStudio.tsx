// Website → Design: pick a template, style it, arrange and fill its sections, and (admins) edit its
// code, with the real page rendered from the draft beside it. The draft saves itself; Publish puts
// it live and keeps a version, now or at a scheduled time (Schedule.tsx). See docs/site-themes.md
// and DESIGN.md (Design studio).
import type { Problem } from '@swarm/site-themes';
import { designCss, isTesting, sectionsOf } from '@swarm/site-themes';
import { BUILT_IN_THEMES } from '@swarm/site-themes/themes';
import { Button, EmptyState, ErrorNotice, LoadingRows, TabPanel, Tabs } from '@swarm/ui/components';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { ApiError } from '../api/client';
import {
  designApi,
  designKeys,
  designQuery,
  designStatsQuery,
  type DesignSchedule,
  type PreviewAs,
  type PreviewVariant,
  type SiteDesignState,
  type StatsDays,
} from '../api/design';
import { useChannelFlag } from '../api/queries';
import { MOD, isShortcut, useStickyBarHeight } from '../editor/shortcuts';
import * as Icon from '../icons';
import { useSiteStudio } from '../pages/SiteStudio';
import { useTabStatus } from '../shell/tabStatus';
import { useToast } from '../shell/toast';
import { useUnsavedGuard } from '../shell/UnsavedBar';
import { useDisclosure } from '../shell/useDisclosure';
import { CodePanel } from './CodePanel';
import { sameDesign, whenSaved, type ThemeChoice } from './draft';
import { sortProblems } from './files';
import { addSiteFonts } from './fonts';
import { fontLookupOf, useUploadedFonts } from './uploadedFonts';
import { PreviewFrame, type PreviewWidth } from './PreviewFrame';
import { draftSummary, scheduleAround } from './scheduling';
import { PublishButton, ScheduleForm, ScheduleLine } from './Schedule';
import { SectionsPanel } from './SectionsPanel';
import {
  StudioContext,
  useStudio,
  type CodeTarget,
  type DesignSearch,
  type Panel,
  type StudioValue,
} from './studio';
import { StylePanel } from './StylePanel';
import { TemplatePanel } from './TemplatePanel';
import { useDesignDraft } from './useDesignDraft';
import { VersionsDialog } from './VersionsDialog';

const WIDE = '(min-width: 1020px)';

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', listener);
      return () => list.removeEventListener('change', listener);
    },
    () => window.matchMedia(query).matches,
    () => true,
  );
}

const PANEL_TABS: { id: Panel; label: string }[] = [
  { id: 'template', label: 'Template' },
  { id: 'style', label: 'Style' },
  { id: 'sections', label: 'Sections' },
  { id: 'code', label: 'Code' },
];

const AUDIENCE: Record<PreviewAs, string> = {
  visitor: 'a visitor',
  subscriber: 'a subscriber',
  paid: 'a paid subscriber',
};

/** Preview as: an audience, or a visitor shown variant B of every running A/B test. */
type PreviewChoice = PreviewAs | 'variant-b';

export default function SiteDesign({
  search,
  onSearch,
}: {
  search: DesignSearch;
  onSearch: (next: DesignSearch) => void;
}) {
  const { channel, settings, canEdit, canAdmin } = useSiteStudio();
  const flag = useChannelFlag(channel.id, 'site_templates');
  const design = useQuery({ ...designQuery(channel.id), enabled: flag === true });
  useEffect(addSiteFonts, []);

  if (flag === false) {
    return (
      <EmptyState title="Design isn’t on for this publication yet">
        Templates, style and sections arrive with website templates. The layout and branding
        settings still apply until then.
      </EmptyState>
    );
  }
  if (flag === undefined || design.isPending) {
    return <LoadingRows label="Loading the design" rows={5} />;
  }
  if (design.error || !design.data) {
    const disabled = design.error instanceof ApiError && design.error.code === 'feature_disabled';
    return (
      <ErrorNotice
        title={disabled ? 'Design isn’t on for this publication yet' : 'The design didn’t load'}
        message={design.error?.message ?? 'Try again in a moment.'}
        action={
          disabled ? undefined : (
            <Button variant="ghost" size="sm" onClick={() => void design.refetch()}>
              Try again
            </Button>
          )
        }
      />
    );
  }
  return (
    <Studio
      key={channel.id}
      channelId={channel.id}
      server={design.data}
      canEdit={canEdit}
      canAdmin={canAdmin}
      siteUrl={settings.url}
      search={search}
      onSearch={onSearch}
    />
  );
}

function Studio({
  channelId,
  server: initial,
  canEdit,
  canAdmin,
  siteUrl,
  search,
  onSearch,
}: {
  channelId: string;
  server: SiteDesignState;
  canEdit: boolean;
  canAdmin: boolean;
  siteUrl: string;
  search: DesignSearch;
  onSearch: (next: DesignSearch) => void;
}) {
  // The draft lives here once loaded; later reads of the query only bring the published side.
  const live = useQuery(designQuery(channelId));
  const server = live.data ?? initial;
  const themes = useMemo<ThemeChoice[]>(
    () => (initial.themes?.length ? initial.themes : Object.values(BUILT_IN_THEMES)),
    [initial.themes],
  );
  const draft = useDesignDraft(channelId, initial, themes);
  const client = useQueryClient();
  const toast = useToast();
  const wide = useMediaQuery(WIDE);
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  useStickyBarHeight(rootRef, barRef);

  const panel: Panel = search.panel ?? 'template';
  const selected = panel === 'sections' ? (search.section ?? null) : null;
  const [reveal, setReveal] = useState(0);
  const [codeTarget, setCodeTarget] = useState<CodeTarget | null>(null);
  const [previewChoice, setPreviewChoice] = useState<PreviewChoice>('visitor');
  // A section's settings open on variant B: the preview shows that section's B.
  const [editingB, setEditingB] = useState<string | null>(null);
  const [statsDays, setStatsDays] = useState<StatsDays>(30);
  const stats = useQuery({
    ...designStatsQuery(channelId, statsDays),
    placeholderData: keepPreviousData,
  });
  // A phone gets a phone-width preview to start with; anything wider, the desktop.
  const [width, setWidth] = useState<PreviewWidth>(() =>
    window.matchMedia(WIDE).matches ? 'desktop' : 'phone',
  );
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  // The scheduled publish: the form under the bar (a new key each time it opens), and its calls.
  const schedule = server.schedule ?? null;
  const [scheduleForm, setScheduleForm] = useState<{ key: number; initial: Date | null } | null>(
    null,
  );
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const go = useCallback(
    (next: DesignSearch) => {
      const clean: DesignSearch = {};
      if (next.panel) clean.panel = next.panel;
      if (next.section) clean.section = next.section;
      if (next.file) clean.file = next.file;
      onSearch(clean);
    },
    [onSearch],
  );

  const sections = useMemo(
    () => (draft.theme ? sectionsOf(draft.theme, draft.design) : (draft.design.sections ?? [])),
    [draft.theme, draft.design],
  );
  const hasTests = sections.some((s) => isTesting(s) && !s.hidden);
  const choice: PreviewChoice =
    previewChoice === 'variant-b' && !hasTests ? 'visitor' : previewChoice;
  const previewAs: PreviewAs = choice === 'variant-b' ? 'visitor' : choice;
  const editingTest = editingB !== null && sections.some((s) => s.id === editingB && isTesting(s));
  const previewVariant: PreviewVariant | null =
    choice === 'variant-b'
      ? { variant: 'b' }
      : editingTest && editingB
        ? { variant: 'b', section: editingB }
        : null;
  const variantKey = previewVariant
    ? `${previewVariant.variant}:${previewVariant.section ?? ''}`
    : '';

  const value: StudioValue = {
    channelId,
    canEdit,
    canAdmin,
    themes,
    draft,
    server,
    sections,
    panel,
    setPanel: (next) => go({ ...search, panel: next }),
    selected,
    select: (id, options) => {
      const next: DesignSearch = { ...search, panel: 'sections' };
      if (id) next.section = id;
      else delete next.section;
      go(next);
      if (id && options?.reveal) setReveal((n) => n + 1);
    },
    file: search.file ?? null,
    setFile: (path) => go({ ...search, file: path }),
    codeTarget,
    stats: stats.data,
    statsError: stats.isError,
    retryStats: () => void stats.refetch(),
    statsDays,
    setStatsDays,
    setEditingB,
    openProblem: (problem: Problem) => {
      const files = draft.design.files ?? themes.find((t) => t.id === draft.design.theme)?.files;
      if (files && problem.file in files && canAdmin) {
        go({ ...search, panel: 'code', file: problem.file });
        setCodeTarget((t) => ({
          file: problem.file,
          line: problem.line,
          column: problem.column,
          n: (t?.n ?? 0) + 1,
        }));
      } else if (problem.message.startsWith('Theme setting')) {
        go({ ...search, panel: 'style' });
      } else {
        go({ ...search, panel: 'sections' });
      }
    },
  };

  // Ctrl/⌘ S saves now, from anywhere in the studio.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isShortcut(event, 's')) return;
      event.preventDefault();
      if (canEdit) void draft.flush().catch(() => undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, canEdit]);

  useUnsavedGuard(draft.save.state !== 'saved');
  useTabStatus(draft.save.state === 'error' ? 'Not saved' : null);

  // The preview: a fresh address after every stored draft, and for each audience.
  const [preview, setPreview] = useState<{ url: string | null; error: string | null }>({
    url: null,
    error: null,
  });
  const [previewTry, setPreviewTry] = useState(0);
  useEffect(() => {
    // Previews of the draft are for the people who can change it.
    if (!canEdit) return;
    let current = true;
    designApi.preview(channelId, previewAs, previewVariant).then(
      (answer) => current && setPreview({ url: answer.url, error: null }),
      (error: unknown) =>
        current &&
        setPreview((p) => ({
          url: p.url,
          error: error instanceof Error ? error.message : 'The preview didn’t load.',
        })),
    );
    return () => {
      current = false;
    };
    // previewVariant is read through variantKey, which says when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, canEdit, previewAs, variantKey, draft.revision, previewTry]);

  // The studio's own copy of the design's CSS, for a preview on this origin: with the uploaded
  // fonts the draft uses, at the /media/ path the site serves them from.
  const uploadedFonts = useUploadedFonts(channelId);
  const liveCss = useMemo(
    () =>
      draft.theme
        ? designCss(
            draft.theme,
            { settings: draft.design.settings },
            undefined,
            fontLookupOf(uploadedFonts.data),
          )
        : null,
    [draft.theme, draft.design.settings, uploadedFonts.data],
  );

  const problems = sortProblems(draft.problems);
  const errors = problems.filter((p) => p.severity === 'error').length;
  const published = sameDesign(draft.design, server.published);

  const publish = async () => {
    setPublishing(true);
    setPublishError(null);
    try {
      await draft.flush();
      await designApi.publish(channelId);
      await client.fetchQuery({ ...designQuery(channelId), staleTime: 0 });
      void client.invalidateQueries({
        queryKey: ['channels', channelId, 'site', 'design', 'versions'],
      });
      void client.invalidateQueries({
        queryKey: ['channels', channelId, 'site', 'design', 'stats'],
      });
      // Publishing by hand leaves a waiting schedule alone; the toast asks whether to keep it.
      const waiting = schedule?.status === 'scheduled' ? schedule : null;
      toast.show(
        waiting
          ? {
              message: `Published. The home page shows the new design now. The design scheduled for ${scheduleAround(new Date(waiting.at))} still publishes then.`,
              action: { label: 'Cancel schedule', onAction: () => void cancelSchedule(waiting) },
              duration: 12_000,
            }
          : { message: 'Published. The home page shows the new design now.' },
      );
    } catch (error) {
      setPublishError(error instanceof Error ? error.message : 'Not published. Try again.');
    } finally {
      setPublishing(false);
    }
  };

  const setSchedule = (next: DesignSchedule | null) =>
    client.setQueryData<SiteDesignState>(designKeys.all(channelId), (old) =>
      old ? { ...old, schedule: next } : old,
    );
  const openSchedule = (initial: Date | null) => {
    setScheduleError(null);
    setScheduleForm((form) => ({ key: (form?.key ?? 0) + 1, initial }));
  };

  const scheduleAt = async (at: Date) => {
    setScheduling(true);
    setScheduleError(null);
    try {
      // The snapshot is what the server has, so the draft on the screen goes first.
      await draft.flush();
      const made = await designApi.schedule(channelId, at);
      setSchedule(made);
      setScheduleForm(null);
      toast.show({
        message: `Scheduled for ${scheduleAround(new Date(made.at))}. Edits from now on stay in the draft.`,
      });
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : 'Try again in a moment.');
    } finally {
      setScheduling(false);
    }
  };

  const restoreSchedule = async () => {
    try {
      setSchedule(await designApi.restoreSchedule(channelId));
      toast.show({ message: 'The schedule is back.' });
    } catch (error) {
      toast.show({
        message: `The schedule couldn’t be put back: ${error instanceof Error ? error.message : 'try again.'}`,
      });
    }
  };

  const cancelSchedule = async (was: DesignSchedule) => {
    setCancelling(true);
    try {
      await designApi.cancelSchedule(channelId);
      setSchedule(null);
      setScheduleForm(null);
      toast.show({
        message:
          was.status === 'failed'
            ? 'Dismissed.'
            : `Schedule cancelled. Nothing publishes on ${scheduleAround(new Date(was.at))}.`,
        action: { label: 'Undo', onAction: () => void restoreSchedule() },
      });
    } catch (error) {
      // Gone already (published, or cancelled elsewhere): show what is true now.
      void live.refetch();
      toast.show({
        message: `Not cancelled: ${error instanceof Error ? error.message : 'try again.'}`,
      });
    } finally {
      setCancelling(false);
    }
  };

  // While a schedule waits, look again soon after its time (the cron can be up to five minutes
  // late), then every minute until it has gone live or failed.
  const scheduledAt = schedule?.status === 'scheduled' ? schedule.at : null;
  useEffect(() => {
    if (!scheduledAt) return;
    const due = Date.parse(scheduledAt) - Date.now();
    const wait = due > 0 ? due + 5_000 : 60_000;
    // setTimeout holds at most about 24 days; a later schedule is looked at again then.
    const timer = setTimeout(() => void live.refetch(), Math.min(wait, 2 ** 31 - 1));
    return () => clearTimeout(timer);
    // live.dataUpdatedAt re-arms the timer after each look.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduledAt, live.dataUpdatedAt]);
  // Say so when a schedule goes live while the page is open.
  const lastSchedule = useRef(scheduledAt);
  useEffect(() => {
    const before = lastSchedule.current;
    lastSchedule.current = scheduledAt;
    if (
      before &&
      !schedule &&
      server.publishedAt &&
      Date.parse(server.publishedAt) >= Date.parse(before)
    ) {
      toast.show({ message: 'The scheduled design is live now.' });
      void client.invalidateQueries({ queryKey: designKeys.versions(channelId) });
    }
  }, [scheduledAt, schedule, server.publishedAt, toast, client, channelId]);

  const themeName =
    draft.design.files === null
      ? (themes.find((t) => t.id === draft.design.theme)?.name ?? null)
      : (draft.theme?.name ?? null);
  const summary = draftSummary(themeName, sections.filter((s) => !s.hidden).length);

  const publishBlocked = !canEdit
    ? null
    : errors > 0
      ? `Fix ${errors === 1 ? 'the problem' : `${errors} problems`} to publish`
      : !draft.compiles
        ? 'Checking the theme…'
        : draft.save.state === 'error'
          ? 'Waiting for the draft to save'
          : published && draft.save.state === 'saved'
            ? 'Nothing new to publish'
            : null;

  const previewPane = !canEdit ? (
    <div className="grid h-full place-items-center p-6">
      <p className="max-w-[44ch] text-center text-[13.5px] leading-[1.55] text-sub">
        The preview of the draft is for editors and admins. The live site shows what is published.{' '}
        <a
          href={siteUrl}
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-purple-deep"
        >
          View site<span className="sr-only"> (opens in a new tab)</span>
        </a>
      </p>
    </div>
  ) : (
    <PreviewPane
      url={preview.url}
      error={preview.error}
      onRetry={() => setPreviewTry((n) => n + 1)}
      width={width}
      audience={`${AUDIENCE[previewAs]}${previewVariant ? ', variant B' : ''}`}
      selected={selected}
      reveal={reveal}
      onSelect={(id) => {
        value.select(id);
        if (!wide) setPreviewOpen(false);
      }}
      liveCss={liveCss}
    />
  );

  return (
    <StudioContext.Provider value={value}>
      <div ref={rootRef} className="-mx-4 -mt-6 -mb-12 sm:-mx-8">
        <div
          ref={barRef}
          className="z-20 flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-line bg-surface px-4 py-2.5 sm:px-6 min-[1020px]:sticky min-[1020px]:top-14"
        >
          <DraftStatus server={server} published={published} />
          <div className="flex flex-1 flex-wrap items-center justify-end gap-x-2.5 gap-y-2">
            {wide && canEdit && (
              <PreviewControls
                choice={choice}
                onChoice={setPreviewChoice}
                hasTests={hasTests}
                width={width}
                onWidth={setWidth}
              />
            )}
            {!wide && canEdit && (
              <Button variant="ghost" onClick={() => setPreviewOpen(true)}>
                <Icon.Eye size={16} /> Preview
              </Button>
            )}
            <Button variant="ghost" onClick={() => setVersionsOpen(true)}>
              <Icon.History size={16} /> Versions
            </Button>
            {problems.length > 0 && <ProblemsMenu problems={problems} />}
            {canEdit && (
              <div className="flex items-center gap-2">
                {/* With errors, the problems button beside it says why. */}
                <span
                  id="publish-why"
                  className={errors > 0 ? 'sr-only' : 'text-[13px] text-sub empty:hidden'}
                >
                  {publishBlocked}
                </span>
                <PublishButton
                  blocked={publishBlocked}
                  publishing={publishing}
                  onPublish={() => void publish()}
                  onSchedule={() => openSchedule(null)}
                />
              </div>
            )}
          </div>
          {publishError && (
            <p role="alert" className="basis-full text-[13px] font-semibold text-danger">
              Not published: {publishError}
            </p>
          )}
          {schedule && (
            <ScheduleLine
              schedule={schedule}
              canEdit={canEdit}
              busy={cancelling}
              onChange={() => openSchedule(new Date(schedule.at))}
              onCancel={() => void cancelSchedule(schedule)}
            />
          )}
          {canEdit && scheduleForm && (
            <ScheduleForm
              key={scheduleForm.key}
              initial={scheduleForm.initial}
              summary={summary}
              replacing={!!schedule}
              pending={scheduling}
              error={scheduleError}
              onSubmit={(at) => void scheduleAt(at)}
              onClose={() => setScheduleForm(null)}
            />
          )}
        </div>

        <div
          className={`min-[1020px]:grid ${
            panel === 'code' && canAdmin
              ? 'min-[1020px]:grid-cols-[minmax(560px,54%)_minmax(0,1fr)]'
              : 'min-[1020px]:grid-cols-[380px_minmax(0,1fr)]'
          }`}
        >
          <div className="min-w-0 border-line min-[1020px]:border-r">
            <PanelTabs panel={panel} onPanel={value.setPanel} />
          </div>
          {wide && (
            <div className="sticky top-[calc(56px+var(--editor-bar,0px))] h-[calc(100dvh-56px-var(--editor-bar,0px))] min-w-0 bg-surface-alt">
              {previewPane}
            </div>
          )}
        </div>
      </div>
      {!wide && (
        <PreviewDialog open={previewOpen} onClose={() => setPreviewOpen(false)}>
          <div className="grid gap-2 border-b border-line bg-surface px-4 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[15px] font-semibold">Preview</h2>
              <Button
                variant="ghost"
                size="sm"
                // Opening the preview puts focus on the way back out.
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                onClick={() => setPreviewOpen(false)}
              >
                <Icon.Close size={16} /> Close preview
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <PreviewControls
                choice={choice}
                onChoice={setPreviewChoice}
                hasTests={hasTests}
                width={width}
                onWidth={setWidth}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 bg-surface-alt">{previewOpen && previewPane}</div>
        </PreviewDialog>
      )}
      <VersionsDialog open={versionsOpen} onClose={() => setVersionsOpen(false)} />
    </StudioContext.Provider>
  );
}

function DraftStatus({ server, published }: { server: SiteDesignState; published: boolean }) {
  const { draft, canEdit } = useStudio();
  const { state, savedAt, error } = draft.save;
  const stored = savedAt ?? (server.draftUpdatedAt ? new Date(server.draftUpdatedAt) : null);
  const saveText =
    state === 'saving'
      ? 'Saving…'
      : state === 'unsaved'
        ? 'Unsaved changes'
        : state === 'error'
          ? 'Not saved. Trying again…'
          : stored
            ? `Draft saved ${whenSaved(stored)}`
            : 'Draft saved';
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[13px] whitespace-nowrap">
      {published && state === 'saved' ? (
        <span className="inline-flex items-center gap-1.5 font-semibold text-route">
          <Icon.Check size={14} />
          Published{' '}
          {server.publishedAt && (
            <span className="font-normal text-sub">{whenSaved(new Date(server.publishedAt))}</span>
          )}
        </span>
      ) : (
        <span className="status-pill text-scheduled">Unpublished changes</span>
      )}
      {canEdit && (
        <span
          role="status"
          title={error ?? `The draft saves by itself; ${MOD} S saves it now`}
          className={`inline-flex items-center gap-1 ${state === 'error' ? 'font-semibold text-danger' : 'text-sub'}`}
        >
          {state === 'saved' && <Icon.Check size={14} className="text-route" />}
          {saveText}
        </span>
      )}
    </div>
  );
}

function PreviewControls({
  choice,
  onChoice,
  hasTests,
  width,
  onWidth,
}: {
  choice: PreviewChoice;
  onChoice: (choice: PreviewChoice) => void;
  /** The draft runs an A/B test, so "Variant B" is a choice. */
  hasTests: boolean;
  width: PreviewWidth;
  onWidth: (width: PreviewWidth) => void;
}) {
  const id = useId();
  return (
    <>
      <label
        htmlFor={id}
        className="flex items-center gap-2 text-[13px] whitespace-nowrap text-sub"
      >
        Preview as
        <select
          id={id}
          className="line-input min-h-[36px]! w-[150px] text-[13px]"
          value={choice}
          onChange={(e) => onChoice(e.target.value as PreviewChoice)}
        >
          <option value="visitor">Visitor</option>
          <option value="subscriber">Subscriber</option>
          <option value="paid">Paid subscriber</option>
          {hasTests && <option value="variant-b">Variant B</option>}
        </select>
      </label>
      <fieldset className="inline-flex rounded-control border border-line bg-surface-alt p-[3px]">
        <legend className="sr-only">Preview width</legend>
        {(
          [
            { id: 'desktop', label: 'Desktop', icon: Icon.Desktop },
            { id: 'phone', label: 'Phone', icon: Icon.Phone },
          ] as const
        ).map((option) => {
          const checked = width === option.id;
          const OptionIcon = option.icon;
          return (
            <label
              key={option.id}
              title={option.label}
              className={`inline-flex h-[28px] cursor-pointer items-center gap-1.5 rounded-[6px] px-2 text-[13px] whitespace-nowrap transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-purple ${
                checked
                  ? 'bg-surface font-semibold text-ink shadow-[0_0_0_1px_var(--line-control)]'
                  : 'text-sub hover:text-ink'
              }`}
            >
              <input
                type="radio"
                name={`${id}-width`}
                className="sr-only"
                checked={checked}
                onChange={() => onWidth(option.id)}
              />
              <OptionIcon size={16} />
              <span className="max-[1279px]:sr-only">{option.label}</span>
            </label>
          );
        })}
      </fieldset>
    </>
  );
}

function ProblemsMenu({ problems }: { problems: Problem[] }) {
  const { openProblem } = useStudio();
  const menu = useDisclosure();
  const errors = problems.filter((p) => p.severity === 'error').length;
  const warnings = problems.length - errors;
  const label = [
    errors ? `${errors} ${errors === 1 ? 'problem' : 'problems'}` : '',
    warnings ? `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <div className="relative">
      <button
        type="button"
        {...menu.buttonProps}
        className={`btn-ghost ${errors ? 'text-danger!' : 'text-warn!'}`}
      >
        <Icon.Alert size={16} /> {label}
      </button>
      <div
        {...menu.panelProps}
        className="line-menu absolute top-[calc(100%+6px)] right-0 max-h-[60vh] w-[min(420px,calc(100vw-32px))] overflow-y-auto"
      >
        <p className="px-2.5 pt-1.5 pb-1 text-[13px] text-sub">
          {errors ? 'Fix these to publish' : 'Worth a look before publishing'}
        </p>
        {problems.map((problem, i) => (
          <button
            key={`${problem.file}-${problem.line}-${i}`}
            type="button"
            className="line-menu-item items-start"
            onClick={() => {
              menu.close();
              openProblem(problem);
            }}
          >
            <span
              className={`mt-0.5 shrink-0 text-[12px] font-semibold ${problem.severity === 'error' ? 'text-danger' : 'text-warn'}`}
            >
              {problem.severity === 'error' ? 'Error' : 'Warning'}
            </span>
            <span className="min-w-0">
              {problem.file !== 'design' && (
                <span className="block font-mono text-[12.5px] text-sub">
                  {problem.file}:{problem.line}:{problem.column}
                </span>
              )}
              <span className="block text-[13px]">{problem.message}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PanelTabs({ panel, onPanel }: { panel: Panel; onPanel: (panel: Panel) => void }) {
  const { canEdit } = useStudio();
  const id = useId();
  return (
    <>
      <div className="z-10 bg-surface px-4 pt-2 sm:px-6 min-[1020px]:sticky min-[1020px]:top-[calc(56px+var(--editor-bar,0px))]">
        <Tabs
          label="Design"
          tabs={PANEL_TABS}
          value={panel}
          onChange={onPanel}
          idFor={(tab) => `${id}-${tab}`}
          panelFor={(tab) => `${id}-${tab}-panel`}
          compact
          className="border-line"
        />
      </div>
      <TabPanel
        id={`${id}-${panel}-panel`}
        labelledBy={`${id}-${panel}`}
        className="px-4 pt-5 pb-16 focus-visible:outline-none sm:px-6"
      >
        {!canEdit && (
          <p className="mb-5 rounded-control bg-surface-alt px-3 py-2.5 text-[13px] text-sub">
            You can look around. An editor or admin changes the design.
          </p>
        )}
        {panel === 'template' && <TemplatePanel />}
        {panel === 'style' && <StylePanel />}
        {panel === 'sections' && <SectionsPanel />}
        {panel === 'code' && <CodePanel />}
      </TabPanel>
    </>
  );
}

function PreviewPane({
  url,
  error,
  onRetry,
  width,
  audience,
  selected,
  reveal,
  onSelect,
  liveCss,
}: {
  url: string | null;
  error: string | null;
  onRetry: () => void;
  width: PreviewWidth;
  audience: string;
  selected: string | null;
  reveal: number;
  onSelect: (id: string) => void;
  liveCss: string | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && (
        <div className="p-4">
          <ErrorNotice
            title="The preview didn’t load"
            message={error}
            action={
              <Button variant="ghost" size="sm" onClick={onRetry}>
                Try again
              </Button>
            }
          />
        </div>
      )}
      {!url && !error && (
        <div className="grid flex-1 place-items-center text-[13px] text-sub">
          <p role="status">Drawing the preview…</p>
        </div>
      )}
      {url && (
        <div className="min-h-0 flex-1">
          <PreviewFrame
            url={url}
            width={width}
            audience={audience}
            selected={selected}
            revealSelected={reveal}
            onSelect={onSelect}
            liveCss={liveCss}
          />
        </div>
      )}
    </div>
  );
}

/** The preview on a phone or a small window: the whole screen, in a modal dialog. */
function PreviewDialog({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label="Preview"
      onClose={onClose}
      className="m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-surface p-0 text-ink backdrop:bg-transparent"
    >
      <div className="flex h-full flex-col">{children}</div>
    </dialog>
  );
}
