// Sending a Dispatch to part of its audience first: a Split Test (flag split_tests) picks the
// best of 2–4 subject or content variants and sends it to the rest; Cohort Sampling (flag
// cohort_sampling) sends to a share and extends to everyone while the sample stays healthy. A
// Dispatch has at most one of the two. Also: the preflight line and the Broadcast results.
import {
  COHORT_SAMPLE_DEFAULTS,
  SPLIT_TEST_LABELS,
  SPLIT_TEST_MAX_VARIANTS,
  type CohortSample,
  type Dispatch,
  type DispatchDocument,
  type Preflight,
  type PutCohortSample,
  type SplitTest,
  type SplitTestGoal,
} from '@swarm/domain';
import { Button, Dialog, ErrorNotice, Pill, SelectField, TextField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useId, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import {
  cohortSampleQuery,
  isFeatureDisabled,
  isNotFound,
  splitTestQuery,
  useDeleteCohortSample,
  useDeleteSplitTest,
  usePutCohortSample,
  usePutSplitTest,
} from '../api/growth';
import { levelsQuery } from '../api/money';
import { dispatchExtensions } from '../editor/extensions';
import {
  formatMinutes,
  problemAt,
  splitTestBody,
  splitTestProblems,
  variantShare,
  withoutSmartBlocks,
  type Problem,
  type SplitTestDraft,
} from '../growth/helpers';
import { Section, numberFormat } from '../pages/common';
import { CohortPill } from './HoldBackResults';

type Mode = 'none' | 'split' | 'cohort';

const WINDOWS = [30, 60, 120, 240, 480, 720, 1440, 2880, 4320, 10_080];
const COHORT_WINDOWS = [30, 60, 120, 240, 480, 720, 1440, 2880];

/** Problems from an API error, so they show next to their fields. */
function serverProblems(error: unknown): Problem[] {
  if (!(error instanceof ApiError)) return [];
  return error.details.map((d) => ({ path: d.path, message: d.message }));
}

/** A run test or sample keeps its results and can't be changed. */
const pendingTest = (test: SplitTest | undefined) =>
  !test || test.status === 'draft' || test.status === 'canceled';
const pendingSample = (sample: CohortSample | undefined) =>
  !sample || sample.status === 'draft' || sample.status === 'canceled';

/**
 * The side-panel section. Hidden when both features are off for the Channel (the API answers
 * feature_disabled). `renderToolbar` draws the editor toolbar for content variants.
 */
export function HoldBackPanel({
  dispatch,
  canWrite,
  flush,
  renderToolbar,
}: {
  dispatch: Dispatch;
  canWrite: boolean;
  flush: () => Promise<unknown>;
  renderToolbar: (editor: Editor) => ReactNode;
}) {
  const split = useQuery(splitTestQuery(dispatch.id));
  const cohort = useQuery(cohortSampleQuery(dispatch.id));
  const splitOn = !isFeatureDisabled(split.error);
  const cohortOn = !isFeatureDisabled(cohort.error);
  const [chosen, setChosen] = useState<Mode | null>(null);
  const modeName = useId();

  // isPending comes back whenever a query with no data refetches; a save does that to the other
  // one, and leaving the page here would unmount the form and its "saved" message.
  if (!split.isFetched || !cohort.isFetched) return null;
  if (!splitOn && !cohortOn) return null;
  const otherError = [split.error, cohort.error].find(
    (e) => e && !isFeatureDisabled(e) && !isNotFound(e),
  );
  // After a removal the refetch answers not_found while the old data is still cached.
  const test = isNotFound(split.error) ? undefined : split.data;
  const sample = isNotFound(cohort.error) ? undefined : cohort.data;
  const existing: Mode = test ? 'split' : sample ? 'cohort' : 'none';
  const mode = chosen ?? existing;
  const editable = canWrite && pendingTest(test) && pendingSample(sample);

  const options: { value: Mode; label: string; on: boolean }[] = [
    { value: 'none', label: 'Send to everyone at once', on: true },
    { value: 'split', label: 'Split Test', on: splitOn },
    { value: 'cohort', label: 'Cohort Sampling', on: cohortOn },
  ];

  return (
    <Section
      title="Test before sending"
      description="Send to part of the audience first, then the rest."
    >
      {otherError && <ErrorNotice message={otherError.message} />}
      <fieldset className="mb-4 grid gap-1" disabled={!editable}>
        <legend className="sr-only">How it goes out</legend>
        {options
          .filter((o) => o.on)
          .map((o) => (
            <label key={o.value} className="flex min-h-9 items-center gap-2 text-[13.5px]">
              <input
                type="radio"
                name={modeName}
                className="size-4 accent-purple"
                checked={mode === o.value}
                onChange={() => setChosen(o.value)}
              />
              {o.label}
            </label>
          ))}
      </fieldset>
      {mode !== existing && existing !== 'none' ? (
        <SwitchNotice
          dispatchId={dispatch.id}
          existing={existing}
          onRemoved={() => setChosen(mode)}
        />
      ) : mode === 'split' ? (
        <SplitTestForm
          key="split"
          dispatch={dispatch}
          test={test}
          canWrite={editable}
          flush={flush}
          renderToolbar={renderToolbar}
          onRemoved={() => setChosen('none')}
        />
      ) : mode === 'cohort' ? (
        <CohortForm
          key="cohort"
          dispatchId={dispatch.id}
          sample={sample}
          canWrite={editable}
          onRemoved={() => setChosen('none')}
        />
      ) : (
        <p className="text-[13px] text-sub">
          Every subscriber in the audience gets it straight away.
        </p>
      )}
    </Section>
  );
}

/** Split Tests and Cohort Sampling can't be combined: one has to go first. */
function SwitchNotice({
  dispatchId,
  existing,
  onRemoved,
}: {
  dispatchId: string;
  existing: 'split' | 'cohort';
  onRemoved: () => void;
}) {
  const removeTest = useDeleteSplitTest(dispatchId);
  const removeSample = useDeleteCohortSample(dispatchId);
  const remove = existing === 'split' ? removeTest : removeSample;
  const name = existing === 'split' ? 'Split Test' : 'Cohort Sampling';
  return (
    <div className="grid gap-2 rounded-card-app bg-surface-alt px-3 py-3 text-[13px]">
      <p>
        A post can have a Split Test or Cohort Sampling, not both. Remove the {name} set up on this
        post first.
      </p>
      <div>
        <Button
          variant="ghost"
          size="sm"
          loading={remove.isPending}
          onClick={() => remove.mutate(undefined, { onSuccess: onRemoved })}
        >
          Remove the {name}
        </Button>
      </div>
      {remove.error && <ErrorNotice message={remove.error.message} />}
    </div>
  );
}

// ---- Split Test ----------------------------------------------------------------------------

function draftFrom(test: SplitTest | undefined): SplitTestDraft {
  if (!test) {
    return {
      variable: 'subject',
      variants: [{ subject: '', preheader: '', content: null }],
      testPercent: 20,
      metric: 'opens',
      windowMinutes: 120,
    };
  }
  return {
    variable: test.variable,
    variants: test.variants.slice(1).map((v) => ({
      subject: v.subject ?? '',
      preheader: v.preheader ?? '',
      content: v.content,
    })),
    testPercent: test.testPercent,
    metric: test.metric,
    windowMinutes: test.windowMinutes,
  };
}

const STATUS_PILL: Record<
  SplitTest['status'],
  { tone: 'brand' | 'scheduled' | 'success' | 'neutral'; label: string }
> = {
  draft: { tone: 'brand', label: 'Ready' },
  testing: { tone: 'scheduled', label: 'Testing' },
  promoted: { tone: 'success', label: 'Winner sent' },
  canceled: { tone: 'neutral', label: 'Canceled' },
};

function SplitTestForm({
  dispatch,
  test,
  canWrite,
  flush,
  renderToolbar,
  onRemoved,
}: {
  dispatch: Dispatch;
  test: SplitTest | undefined;
  canWrite: boolean;
  flush: () => Promise<unknown>;
  renderToolbar: (editor: Editor) => ReactNode;
  onRemoved: () => void;
}) {
  const put = usePutSplitTest(dispatch.id);
  const remove = useDeleteSplitTest(dispatch.id);
  const levels = useQuery(levelsQuery(dispatch.channelId));
  const [draft, setDraft] = useState<SplitTestDraft>(() => draftFrom(test));
  const [goal, setGoal] = useState<SplitTestGoal>(() => test?.goal ?? { event: 'level_purchased' });
  const [editing, setEditing] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [saved, setSaved] = useState(false);
  const local = splitTestProblems(draft);
  const problems = [...(submitted ? local : []), ...serverProblems(put.error)];
  const total = draft.variants.length + 1;
  const share = variantShare(draft.testPercent, total);

  const change = (patch: Partial<SplitTestDraft>) => {
    setSaved(false);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const changeVariant = (i: number, patch: Partial<SplitTestDraft['variants'][number]>) =>
    change({ variants: draft.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)) });

  const save = async () => {
    setSubmitted(true);
    if (local.length) return;
    // The test runs on the saved Dispatch, so save pending edits first. The page says if that fails.
    try {
      await flush();
    } catch {
      return;
    }
    const body = splitTestBody(draft);
    put.mutate(
      draft.metric === 'goal' ? { ...body, goal: cleanGoal(goal) } : { ...body, goal: null },
      { onSuccess: () => setSaved(true) },
    );
  };

  if (test && !pendingTest(test)) {
    return (
      <div className="grid gap-2 text-[13.5px]">
        <p>
          <Pill tone={STATUS_PILL[test.status].tone}>{STATUS_PILL[test.status].label}</Pill>{' '}
          {test.variants.length} variants on {test.testPercent}% of the audience.
        </p>
        <p className="text-[13px] text-sub">The results are on the send report.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <SelectField
        label="What to test"
        value={draft.variable}
        disabled={!canWrite}
        onChange={(e) => {
          const variable = e.target.value as SplitTestDraft['variable'];
          change({ variable });
        }}
        options={[
          { value: 'subject', label: 'Subject line and preview text' },
          { value: 'content', label: 'Content' },
        ]}
        error={problemAt(problems, 'variable')}
      />
      <ol className="grid gap-3" aria-label="Variants">
        <li className="rounded-card-app border border-line-app px-3 py-2.5 text-[13px]">
          <p className="font-semibold">Variant A</p>
          <p className="text-sub">
            The post as written
            {draft.variable === 'subject' && (
              <>
                : <span className="text-ink">{dispatch.subject || 'No subject yet'}</span>
              </>
            )}
          </p>
        </li>
        {draft.variants.map((variant, i) => {
          const label = SPLIT_TEST_LABELS[i + 1] ?? '?';
          const path = `variants.${i + 1}`;
          return (
            <li
              key={label}
              className="grid gap-2 rounded-card-app border border-line-app px-3 py-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13px] font-semibold">Variant {label}</p>
                {canWrite && draft.variants.length > 1 && (
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => change({ variants: draft.variants.filter((_, j) => j !== i) })}
                  >
                    Remove<span className="sr-only"> variant {label}</span>
                  </Button>
                )}
              </div>
              {draft.variable === 'subject' ? (
                <>
                  <TextField
                    label={`Variant ${label} subject`}
                    value={variant.subject}
                    maxLength={200}
                    readOnly={!canWrite}
                    onChange={(e) => changeVariant(i, { subject: e.target.value })}
                    error={problemAt(problems, `${path}.subject`)}
                  />
                  <TextField
                    label={`Variant ${label} preview text (optional)`}
                    value={variant.preheader}
                    maxLength={200}
                    readOnly={!canWrite}
                    onChange={(e) => changeVariant(i, { preheader: e.target.value })}
                    hint="Left empty, it keeps the post’s preview text."
                    error={problemAt(problems, `${path}.preheader`)}
                  />
                </>
              ) : (
                <div className="grid gap-1.5">
                  <p className="text-[13px] text-sub">
                    {variant.content ? 'Written.' : 'Not written yet.'}
                  </p>
                  <div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(i)}
                      disabled={!canWrite && !variant.content}
                    >
                      {canWrite ? `Edit variant ${label}` : `Read variant ${label}`}
                    </Button>
                  </div>
                  {problemAt(problems, `${path}.content`) && (
                    <p role="alert" className="text-[12.5px] font-semibold text-danger">
                      {problemAt(problems, `${path}.content`)}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {canWrite && total < SPLIT_TEST_MAX_VARIANTS && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              change({
                variants: [...draft.variants, { subject: '', preheader: '', content: null }],
              })
            }
          >
            Add variant {SPLIT_TEST_LABELS[total]}
          </Button>
        </div>
      )}
      {problemAt(problems, 'variants') && !problems.some((p) => p.path.startsWith('variants.')) && (
        <p role="alert" className="text-[12.5px] font-semibold text-danger">
          {problemAt(problems, 'variants')}
        </p>
      )}
      <TextField
        label="Test on (% of the audience)"
        type="number"
        inputMode="numeric"
        min={5}
        max={100}
        value={String(draft.testPercent)}
        readOnly={!canWrite}
        onChange={(e) => change({ testPercent: Number(e.target.value) })}
        hint={
          draft.testPercent >= 100
            ? 'Everyone gets one of the variants; the test only reports.'
            : `Each variant goes to about ${share}%. The other ${Math.max(0, 100 - draft.testPercent)}% get the winner.`
        }
        error={problemAt(problems, 'testPercent')}
      />
      <SelectField
        label="The winner has the most"
        value={draft.metric}
        disabled={!canWrite}
        onChange={(e) => change({ metric: e.target.value as SplitTestDraft['metric'] })}
        options={[
          { value: 'opens', label: 'Opens' },
          { value: 'clicks', label: 'Clicks' },
          { value: 'goal', label: 'Conversions (a goal)' },
        ]}
      />
      {draft.metric === 'goal' && (
        <GoalFields
          goal={goal}
          onChange={(g) => {
            setSaved(false);
            setGoal(g);
          }}
          levels={(levels.data?.items ?? []).map((l) => ({ value: l.id, label: l.name }))}
          readOnly={!canWrite}
          problems={problems}
        />
      )}
      <SelectField
        label="Pick the winner after"
        value={String(draft.windowMinutes)}
        disabled={!canWrite}
        onChange={(e) => change({ windowMinutes: Number(e.target.value) })}
        options={[
          ...(WINDOWS.includes(draft.windowMinutes) ? [] : [draft.windowMinutes]),
          ...WINDOWS,
        ].map((m) => ({ value: String(m), label: formatMinutes(m) }))}
        hint="Counted from when the test part has gone out."
        error={problemAt(problems, 'windowMinutes')}
      />
      {put.error && !(put.error instanceof ApiError && put.error.details.length) && (
        <ErrorNotice title="Split Test not saved" message={put.error.message} />
      )}
      {saved && (
        <p role="status" className="text-[13px] text-success">
          Split Test saved. It starts when you send.
        </p>
      )}
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={put.isPending} onClick={() => void save()}>
            Save Split Test
          </Button>
          {test && (
            <Button
              variant="quiet"
              size="sm"
              loading={remove.isPending}
              onClick={() => remove.mutate(undefined, { onSuccess: onRemoved })}
            >
              Remove
            </Button>
          )}
        </div>
      )}
      {remove.error && <ErrorNotice message={remove.error.message} />}
      {editing !== null && draft.variants[editing] && (
        <VariantContentDialog
          label={SPLIT_TEST_LABELS[editing + 1] ?? '?'}
          initial={draft.variants[editing].content ?? withoutSmartBlocks(dispatch.content)}
          readOnly={!canWrite}
          renderToolbar={renderToolbar}
          onSave={(content) => {
            changeVariant(editing, { content });
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function cleanGoal(goal: SplitTestGoal): SplitTestGoal {
  if (goal.event === 'level_purchased') {
    return { event: goal.event, ...(goal.levelId ? { levelId: goal.levelId } : {}) };
  }
  if (goal.event === 'api_event') {
    return { event: goal.event, ...(goal.name?.trim() ? { name: goal.name.trim() } : {}) };
  }
  return { event: goal.event, ...(goal.url?.trim() ? { url: goal.url.trim() } : {}) };
}

function GoalFields({
  goal,
  onChange,
  levels,
  readOnly,
  problems,
}: {
  goal: SplitTestGoal;
  onChange: (goal: SplitTestGoal) => void;
  levels: { value: string; label: string }[];
  readOnly: boolean;
  problems: Problem[];
}) {
  return (
    <div className="grid gap-3 rounded-card-app bg-surface-alt p-3">
      <SelectField
        label="A conversion is"
        value={goal.event}
        disabled={readOnly}
        onChange={(e) => onChange({ event: e.target.value as SplitTestGoal['event'] })}
        options={[
          { value: 'level_purchased', label: 'Buying a paid plan' },
          { value: 'link_clicked', label: 'Clicking a link' },
          { value: 'api_event', label: 'An event sent through the API' },
        ]}
        error={problemAt(problems, 'goal')}
      />
      {goal.event === 'level_purchased' && (
        <SelectField
          label="Paid plan"
          value={goal.levelId ?? ''}
          disabled={readOnly}
          onChange={(e) =>
            onChange({ event: goal.event, ...(e.target.value ? { levelId: e.target.value } : {}) })
          }
          options={[{ value: '', label: 'Any paid plan' }, ...levels]}
          error={problemAt(problems, 'goal.levelId')}
        />
      )}
      {goal.event === 'link_clicked' && (
        <TextField
          label="Link (optional)"
          type="url"
          value={goal.url ?? ''}
          placeholder="https://"
          readOnly={readOnly}
          onChange={(e) => onChange({ event: goal.event, url: e.target.value })}
          hint="Left empty, any link in the email counts."
          error={problemAt(problems, 'goal.url')}
        />
      )}
      {goal.event === 'api_event' && (
        <TextField
          label="Event name"
          value={goal.name ?? ''}
          maxLength={60}
          readOnly={readOnly}
          onChange={(e) => onChange({ event: goal.event, name: e.target.value })}
          error={problemAt(problems, 'goal.name')}
        />
      )}
    </div>
  );
}

function VariantContentDialog({
  label,
  initial,
  readOnly,
  renderToolbar,
  onSave,
  onClose,
}: {
  label: string;
  initial: DispatchDocument;
  readOnly: boolean;
  renderToolbar: (editor: Editor) => ReactNode;
  onSave: (content: DispatchDocument) => void;
  onClose: () => void;
}) {
  const editor = useEditor({
    extensions: dispatchExtensions({ placeholder: `Write variant ${label}…` }),
    content: initial,
    editable: !readOnly,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'dispatch-prose',
        'aria-label': `Variant ${label} body`,
        'aria-multiline': 'true',
        role: 'textbox',
      },
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Variant ${label}`}
      description="The subject and preview text stay the same; only the body changes. Smart blocks stay in variant A."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {!readOnly && (
            <Button
              disabled={!editor}
              onClick={() => editor && onSave(editor.getJSON() as DispatchDocument)}
            >
              Keep variant {label}
            </Button>
          )}
        </>
      }
    >
      <div className="overflow-hidden rounded-card-app border border-line-app">
        {editor && !readOnly && renderToolbar(editor)}
        <div className="max-h-[50vh] overflow-y-auto px-4 py-3">
          <EditorContent editor={editor} />
        </div>
      </div>
    </Dialog>
  );
}

// ---- Cohort Sampling -----------------------------------------------------------------------

/** A rate 0–1 as a percentage string for an input, and back. */
const toPercent = (rate: number | null) =>
  rate === null ? '' : String(Math.round(rate * 100_000) / 1000);
const fromPercent = (text: string) => (text.trim() === '' ? null : Number(text) / 100);

function CohortForm({
  dispatchId,
  sample,
  canWrite,
  onRemoved,
}: {
  dispatchId: string;
  sample: CohortSample | undefined;
  canWrite: boolean;
  onRemoved: () => void;
}) {
  const put = usePutCohortSample(dispatchId);
  const remove = useDeleteCohortSample(dispatchId);
  const base = sample ?? COHORT_SAMPLE_DEFAULTS;
  const [percent, setPercent] = useState(String(base.samplePercent));
  const [windowMinutes, setWindowMinutes] = useState(base.windowMinutes);
  const [openRate, setOpenRate] = useState(toPercent(base.minOpenRate));
  const [bounce, setBounce] = useState(toPercent(base.maxBounceRate));
  const [complaint, setComplaint] = useState(toPercent(base.maxComplaintRate));
  const [unsubscribe, setUnsubscribe] = useState(toPercent(base.maxUnsubscribeRate));
  const [saved, setSaved] = useState(false);
  const problems = serverProblems(put.error);

  const local: Problem[] = [];
  const pct = Number(percent);
  if (!Number.isInteger(pct) || pct < 1 || pct > 99) {
    local.push({ path: 'samplePercent', message: 'Sample 1% to 99% of the audience.' });
  }
  const checkRate = (path: string, text: string, optional: boolean) => {
    const value = fromPercent(text);
    if (value === null) {
      if (!optional) local.push({ path, message: 'Give a percentage.' });
      return;
    }
    if (!Number.isFinite(value) || value <= (optional ? -1 : 0) || value >= 1) {
      local.push({ path, message: 'Use a percentage above 0 and below 100.' });
    }
  };
  checkRate('minOpenRate', openRate, true);
  checkRate('maxBounceRate', bounce, false);
  checkRate('maxComplaintRate', complaint, false);
  checkRate('maxUnsubscribeRate', unsubscribe, false);
  const [submitted, setSubmitted] = useState(false);
  const shown = [...(submitted ? local : []), ...problems];

  if (sample && !pendingSample(sample)) {
    return (
      <p className="text-[13.5px]">
        <CohortPill status={sample.status} /> {sample.samplePercent}% sample. The health check is on
        the send report.
      </p>
    );
  }

  const save = () => {
    setSubmitted(true);
    if (local.length) return;
    const body: PutCohortSample = {
      samplePercent: pct,
      windowMinutes,
      minOpenRate: fromPercent(openRate),
      maxBounceRate: fromPercent(bounce) ?? COHORT_SAMPLE_DEFAULTS.maxBounceRate,
      maxComplaintRate: fromPercent(complaint) ?? COHORT_SAMPLE_DEFAULTS.maxComplaintRate,
      maxUnsubscribeRate: fromPercent(unsubscribe) ?? COHORT_SAMPLE_DEFAULTS.maxUnsubscribeRate,
    };
    put.mutate(body, { onSuccess: () => setSaved(true) });
  };
  const edit = (set: (value: string) => void) => (event: { target: { value: string } }) => {
    setSaved(false);
    set(event.target.value);
  };
  const rateField = (
    label: string,
    path: string,
    value: string,
    set: (v: string) => void,
    hint?: string,
  ) => (
    <TextField
      label={label}
      type="number"
      inputMode="decimal"
      step="any"
      min={0}
      max={100}
      value={value}
      readOnly={!canWrite}
      onChange={edit(set)}
      hint={hint}
      error={problemAt(shown, path)}
    />
  );

  return (
    <div className="grid gap-4">
      <TextField
        label="Send first to (% of the audience)"
        type="number"
        inputMode="numeric"
        min={1}
        max={99}
        value={percent}
        readOnly={!canWrite}
        onChange={edit(setPercent)}
        hint={`The other ${Number.isFinite(pct) ? Math.max(0, 100 - pct) : '—'}% get it once the sample looks healthy.`}
        error={problemAt(shown, 'samplePercent')}
      />
      <SelectField
        label="Check the sample after"
        value={String(windowMinutes)}
        disabled={!canWrite}
        onChange={(e) => {
          setSaved(false);
          setWindowMinutes(Number(e.target.value));
        }}
        options={[
          ...(COHORT_WINDOWS.includes(windowMinutes) ? [] : [windowMinutes]),
          ...COHORT_WINDOWS,
        ].map((m) => ({ value: String(m), label: formatMinutes(m) }))}
        error={problemAt(shown, 'windowMinutes')}
      />
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-[13px] font-semibold">
          Send the rest only if the sample stays within
        </legend>
        {rateField(
          'Lowest open rate (%, optional)',
          'minOpenRate',
          openRate,
          setOpenRate,
          'Left empty, opens are not checked.',
        )}
        {rateField('Highest bounce rate (%)', 'maxBounceRate', bounce, setBounce)}
        {rateField('Highest complaint rate (%)', 'maxComplaintRate', complaint, setComplaint)}
        {rateField(
          'Highest unsubscribe rate (%)',
          'maxUnsubscribeRate',
          unsubscribe,
          setUnsubscribe,
        )}
      </fieldset>
      <p className="text-[12.5px] text-sub">
        If the sample misses a threshold, the send stops, the rest stay unsent and owners and admins
        are emailed.
      </p>
      {put.error && !(put.error instanceof ApiError && put.error.details.length) && (
        <ErrorNotice title="Cohort Sampling not saved" message={put.error.message} />
      )}
      {saved && (
        <p role="status" className="text-[13px] text-success">
          Cohort Sampling saved. It starts when you send.
        </p>
      )}
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={put.isPending} onClick={save}>
            Save Cohort Sampling
          </Button>
          {sample && (
            <Button
              variant="quiet"
              size="sm"
              loading={remove.isPending}
              onClick={() => remove.mutate(undefined, { onSuccess: onRemoved })}
            >
              Remove
            </Button>
          )}
        </div>
      )}
      {remove.error && <ErrorNotice message={remove.error.message} />}
    </div>
  );
}

// ---- Preflight -----------------------------------------------------------------------------

/** The send dialog's line about who gets it first. */
export function HoldBackSummary({ holdBack }: { holdBack: Preflight['holdBack'] }) {
  if (!holdBack) return null;
  const test = numberFormat.format(holdBack.test);
  const held = numberFormat.format(holdBack.held);
  return (
    <p className="rounded-card-app bg-lavender px-3 py-2 text-[13.5px] text-purple-deep">
      {holdBack.kind === 'split_test' ? (
        <>
          <b>Split Test:</b> about <b className="tabular">{test}</b> subscribers get one of{' '}
          {holdBack.variants} variants first;{' '}
          {holdBack.held > 0 ? (
            <>
              about <b className="tabular">{held}</b> wait for the winner.
            </>
          ) : (
            'nobody is held back.'
          )}
        </>
      ) : (
        <>
          <b>Cohort Sampling:</b> about <b className="tabular">{test}</b> subscribers get it first;
          about <b className="tabular">{held}</b> get it if the sample stays healthy.
        </>
      )}
    </p>
  );
}
