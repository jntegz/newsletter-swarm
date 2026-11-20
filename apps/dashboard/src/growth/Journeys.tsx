// Growth → Signup Journeys (flag signup_journeys): up to three steps shown right after someone
// subscribes, an Ask, partner recommendations, an upsell to a paid level or a welcome page. A
// journey can split new Members across variants (A/B) and promote the one that does best.
import {
  SIGNUP_JOURNEY_MAX_STEPS,
  type SignupJourney,
  type SignupJourneyStatus,
  type SignupJourneyStep,
  type SignupJourneyVariants,
} from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  Pill,
  SelectField,
  TextAreaField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { captureFormsQuery } from '../api/capture';
import { ApiError } from '../api/client';
import {
  asksQuery,
  journeyQuery,
  journeyStatsQuery,
  journeysQuery,
  useCreateJourney,
  useDeleteJourney,
  usePromoteJourney,
  useUpdateJourney,
} from '../api/growth';
import { levelsQuery } from '../api/money';
import { Section, numberFormat } from '../pages/common';
import {
  formatRate,
  journeyProblems,
  moveItem,
  nextVariantKey,
  problemAt,
  weightShares,
} from './helpers';
import { OFF_TEXT, QueryState, useGrowth } from './Layout';

const OFF = { title: 'Signup journeys are off', text: OFF_TEXT };

const STATUS_PILL: Record<
  SignupJourneyStatus,
  { tone: 'brand' | 'success' | 'scheduled' | 'neutral'; label: string }
> = {
  draft: { tone: 'brand', label: 'Draft' },
  live: { tone: 'success', label: 'Live' },
  paused: { tone: 'scheduled', label: 'Paused' },
  archived: { tone: 'neutral', label: 'Archived' },
};

const JourneyPill = ({ status }: { status: SignupJourneyStatus }) => (
  <Pill tone={STATUS_PILL[status].tone}>{STATUS_PILL[status].label}</Pill>
);

const STEP_LABEL: Record<SignupJourneyStep['kind'], string> = {
  ask: 'A question (poll or survey)',
  recommendations: 'Recommended publications',
  upsell: 'Upgrade to a paid plan',
  welcome: 'Welcome page',
};

const variantName = (key: string) => `Variant ${key.toUpperCase()}`;

// ---- List ----------------------------------------------------------------------------------

export function JourneysPage() {
  const { channel, canEdit } = useGrowth();
  const journeys = useQuery(journeysQuery(channel.id));
  const forms = useQuery(captureFormsQuery(channel.id));
  const [creating, setCreating] = useState(false);
  const formName = (id: string | null) =>
    id ? (forms.data?.find((f) => f.id === id)?.name ?? 'A deleted form') : 'Every form';
  const newButton = (label: string) =>
    canEdit && (
      <Button size="sm" onClick={() => setCreating(true)}>
        {label}
      </Button>
    );

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[65ch] text-[13.5px] text-sub">
          What new subscribers see right after they subscribe: a question, an upgrade offer or a
          welcome page. One live journey per form.
        </p>
        {!!journeys.data?.length && newButton('New signup journey')}
      </div>
      <QueryState query={journeys} label="Loading signup journeys" off={OFF}>
        {journeys.data?.length === 0 ? (
          <EmptyState title="No signup journeys yet" action={newButton('Create a signup journey')}>
            Without one, new subscribers see the usual “Check your inbox” page.
          </EmptyState>
        ) : (
          <div className="card-app overflow-x-auto">
            <table className="w-full min-w-[620px] text-left text-[13.5px]">
              <thead>
                <tr className="table-head">
                  <th scope="col" className="px-5 py-3 font-semibold">
                    Name
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Shown after
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="px-5 py-3 font-semibold">
                    Variants
                  </th>
                </tr>
              </thead>
              <tbody>
                {journeys.data?.map((j) => (
                  <tr key={j.id} className="border-t border-line hover:bg-surface-alt">
                    <td className="px-5 py-3.5">
                      <Link
                        to="/growth/$channelId/journeys/$journeyId"
                        params={{ channelId: channel.id, journeyId: j.id }}
                        className="font-semibold text-ink no-underline hover:underline"
                      >
                        {j.name}
                      </Link>
                    </td>
                    <td className="px-3 py-3.5 text-sub">{formName(j.formId)}</td>
                    <td className="px-3 py-3.5">
                      <JourneyPill status={j.status} />
                    </td>
                    <td className="px-5 py-3.5 text-sub">
                      {j.winnerKey
                        ? `${variantName(j.winnerKey)} for everyone`
                        : j.variants.length === 1
                          ? 'One variant'
                          : `${j.variants.length} variants, split`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>
      {creating && <CreateJourneyDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateJourneyDialog({ onClose }: { onClose: () => void }) {
  const { channel } = useGrowth();
  const navigate = useNavigate();
  const create = useCreateJourney(channel.id);
  const forms = useQuery(captureFormsQuery(channel.id));
  const [name, setName] = useState('');
  const [formId, setFormId] = useState('');
  const error = create.error instanceof ApiError ? create.error : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      {
        name: name.trim(),
        formId: formId || null,
        variants: [{ key: 'a', weight: 100, steps: [{ kind: 'upsell' }] }],
      },
      {
        onSuccess: (journey) =>
          void navigate({
            to: '/growth/$channelId/journeys/$journeyId',
            params: { channelId: channel.id, journeyId: journey.id },
          }),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Create a signup journey"
      description="It starts as a draft with one upgrade step. Nothing changes for new subscribers until you make it live."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="create-journey" loading={create.isPending}>
            Create
          </Button>
        </>
      }
    >
      <form id="create-journey" className="grid gap-4" onSubmit={submit}>
        <TextField
          label="Name"
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={error?.field('name')}
        />
        <SelectField
          label="Shown after"
          value={formId}
          onChange={(e) => setFormId(e.target.value)}
          options={[
            { value: '', label: 'Every form without a journey of its own' },
            ...(forms.data ?? [])
              .filter((f) => f.kind === 'form')
              .map((f) => ({ value: f.id, label: f.name })),
          ]}
          error={error?.field('formId')}
        />
        {error && !error.details.length && <ErrorNotice message={error.message} />}
      </form>
    </Dialog>
  );
}

// ---- Editor --------------------------------------------------------------------------------

export function JourneyPage({ journeyId }: { journeyId: string }) {
  const journey = useQuery(journeyQuery(journeyId));
  return (
    <QueryState query={journey} label="Loading the signup journey" off={OFF}>
      {journey.data && (
        <div className="grid gap-5">
          <JourneyEditor key={journey.data.id} journey={journey.data} />
          <JourneyStats journey={journey.data} />
        </div>
      )}
    </QueryState>
  );
}

function JourneyEditor({ journey }: { journey: SignupJourney }) {
  const { channel, canEdit } = useGrowth();
  const navigate = useNavigate();
  const update = useUpdateJourney(journey);
  const promote = usePromoteJourney(journey);
  const remove = useDeleteJourney(journey);
  const forms = useQuery(captureFormsQuery(channel.id));
  const [name, setName] = useState(journey.name);
  const [formId, setFormId] = useState(journey.formId ?? '');
  const [variants, setVariants] = useState<SignupJourneyVariants>(journey.variants);
  const [submitted, setSubmitted] = useState(false);
  const [saved, setSaved] = useState(false);
  const local = journeyProblems(variants);
  const error = update.error instanceof ApiError ? update.error : null;
  const problems = [
    ...(submitted ? local : []),
    ...(error?.details.map((d) => ({ path: d.path, message: d.message })) ?? []),
  ];
  const shares = weightShares(variants);
  const readOnly = !canEdit;

  const setVariant = (i: number, patch: Partial<SignupJourneyVariants[number]>) => {
    setSaved(false);
    setVariants((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (local.length || !name.trim()) return;
    update.mutate(
      { name: name.trim(), formId: formId || null, variants },
      { onSuccess: () => setSaved(true) },
    );
  };

  const setStatus = (status: SignupJourneyStatus) => update.mutate({ status });

  return (
    <form className="grid gap-5" onSubmit={save}>
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <Link
          to="/growth/$channelId/journeys"
          params={{ channelId: channel.id }}
          className="text-sub no-underline hover:text-ink"
        >
          ← Signup journeys
        </Link>
        <JourneyPill status={journey.status} />
        {canEdit && (
          <span className="ml-auto flex flex-wrap gap-2">
            {journey.status !== 'live' && journey.status !== 'archived' && (
              <Button size="sm" loading={update.isPending} onClick={() => setStatus('live')}>
                Make live
              </Button>
            )}
            {journey.status === 'live' && (
              <Button
                variant="ghost"
                size="sm"
                loading={update.isPending}
                onClick={() => setStatus('paused')}
              >
                Pause
              </Button>
            )}
            {journey.status !== 'archived' && (
              <Button
                variant="quiet"
                size="sm"
                loading={update.isPending}
                onClick={() => setStatus('archived')}
              >
                Archive
              </Button>
            )}
            {journey.status === 'archived' && (
              <Button
                variant="ghost"
                size="sm"
                loading={update.isPending}
                onClick={() => setStatus('draft')}
              >
                Back to draft
              </Button>
            )}
          </span>
        )}
      </div>

      <Section title="Journey">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Name"
            required
            maxLength={80}
            readOnly={readOnly}
            value={name}
            onChange={(e) => {
              setSaved(false);
              setName(e.target.value);
            }}
            error={error?.field('name')}
          />
          <SelectField
            label="Shown after"
            value={formId}
            disabled={readOnly}
            onChange={(e) => {
              setSaved(false);
              setFormId(e.target.value);
            }}
            options={[
              { value: '', label: 'Every form without a journey of its own' },
              ...(forms.data ?? [])
                .filter((f) => f.kind === 'form' || f.id === formId)
                .map((f) => ({ value: f.id, label: f.name })),
            ]}
            error={error?.field('formId')}
          />
        </div>
        {journey.winnerKey && (
          <p className="mt-4 rounded-card-app bg-success-soft px-3 py-2 text-[13.5px] text-success">
            {variantName(journey.winnerKey)} was promoted: every new subscriber gets it.
          </p>
        )}
      </Section>

      <ol className="grid gap-4" aria-label="Variants">
        {variants.map((variant, i) => (
          <li key={variant.key} className="card-app grid gap-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[15px] font-semibold">
                {variantName(variant.key)}{' '}
                {variants.length > 1 && (
                  <span className="tabular font-normal text-sub">
                    · {shares[i]}% of new subscribers
                  </span>
                )}{' '}
                {journey.winnerKey === variant.key && <Pill tone="success">Promoted</Pill>}
              </h3>
              {canEdit && (
                <span className="flex flex-wrap gap-2">
                  {variants.length > 1 && journey.winnerKey !== variant.key && (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={promote.isPending && promote.variables === variant.key}
                      onClick={() => promote.mutate(variant.key)}
                    >
                      Promote to everyone
                    </Button>
                  )}
                  {variants.length > 1 && (
                    <Button
                      variant="quiet"
                      size="sm"
                      onClick={() => {
                        setSaved(false);
                        setVariants((vs) => vs.filter((_, j) => j !== i));
                      }}
                    >
                      Remove<span className="sr-only"> {variantName(variant.key)}</span>
                    </Button>
                  )}
                </span>
              )}
            </div>
            {variants.length > 1 && (
              <TextField
                label="Weight"
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                readOnly={readOnly}
                value={String(variant.weight)}
                onChange={(e) => setVariant(i, { weight: Number(e.target.value) })}
                hint="Relative: two variants weighted 1 and 3 get a quarter and three quarters."
                error={problemAt(problems, `variants.${i}.weight`)}
              />
            )}
            <StepsEditor
              steps={variant.steps}
              readOnly={readOnly}
              problems={problems}
              path={`variants.${i}.steps`}
              onChange={(steps) => setVariant(i, { steps })}
            />
          </li>
        ))}
      </ol>
      {canEdit && variants.length < 4 && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSaved(false);
              const first = variants[0];
              setVariants((vs) => [
                ...vs,
                {
                  key: nextVariantKey(vs.map((v) => v.key)),
                  weight: 50,
                  steps: first ? first.steps : [{ kind: 'upsell' }],
                },
              ]);
            }}
          >
            Add a variant to test
          </Button>
        </div>
      )}
      {problemAt(problems, 'variants') && (
        <p role="alert" className="text-[12.5px] font-semibold text-danger">
          {problemAt(problems, 'variants')}
        </p>
      )}
      {(error && !error.details.length) || promote.error ? (
        <ErrorNotice
          title="Not saved"
          message={(error?.details.length ? null : error?.message) ?? promote.error?.message ?? ''}
        />
      ) : null}
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={update.isPending}>
            Save journey
          </Button>
          {saved && (
            <span role="status" className="text-[13px] text-success">
              Saved.
            </span>
          )}
          <Button
            variant="quiet"
            className="ml-auto"
            loading={remove.isPending}
            onClick={() => {
              if (window.confirm(`Delete “${journey.name}”?`)) {
                remove.mutate(undefined, {
                  onSuccess: () =>
                    void navigate({
                      to: '/growth/$channelId/journeys',
                      params: { channelId: channel.id },
                    }),
                });
              }
            }}
          >
            Delete journey
          </Button>
        </div>
      ) : (
        <p className="text-[12.5px] text-sub">An editor or admin changes signup journeys.</p>
      )}
      {remove.error && <ErrorNotice title="Not deleted" message={remove.error.message} />}
    </form>
  );
}

function newStep(kind: SignupJourneyStep['kind']): SignupJourneyStep {
  switch (kind) {
    case 'ask':
      return { kind, askId: '' };
    case 'welcome':
      return { kind, headline: 'Welcome aboard', optOutText: 'No thanks' };
    default:
      return { kind };
  }
}

function StepsEditor({
  steps,
  readOnly,
  problems,
  path,
  onChange,
}: {
  steps: SignupJourneyStep[];
  readOnly: boolean;
  problems: { path: string; message: string }[];
  path: string;
  onChange: (steps: SignupJourneyStep[]) => void;
}) {
  const { channel } = useGrowth();
  const asks = useQuery(asksQuery(channel.id));
  const levels = useQuery(levelsQuery(channel.id));
  const set = (i: number, step: SignupJourneyStep) =>
    onChange(steps.map((s, j) => (j === i ? step : s)));
  return (
    <div className="grid gap-3">
      <ol className="grid gap-3" aria-label="Steps">
        {steps.map((step, i) => (
          <li key={i} className="grid gap-3 rounded-card-app border border-line-app p-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <SelectField
                  label={`Step ${i + 1}`}
                  value={step.kind}
                  disabled={readOnly}
                  onChange={(e) => set(i, newStep(e.target.value as SignupJourneyStep['kind']))}
                  options={(Object.keys(STEP_LABEL) as SignupJourneyStep['kind'][]).map((k) => ({
                    value: k,
                    label: STEP_LABEL[k],
                  }))}
                />
              </div>
              {!readOnly && (
                <span className="flex gap-1 pb-0.5">
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={i === 0}
                    onClick={() => onChange(moveItem(steps, i, i - 1))}
                  >
                    Up<span className="sr-only"> step {i + 1}</span>
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={i === steps.length - 1}
                    onClick={() => onChange(moveItem(steps, i, i + 1))}
                  >
                    Down<span className="sr-only"> step {i + 1}</span>
                  </Button>
                  {steps.length > 1 && (
                    <Button
                      variant="quiet"
                      size="sm"
                      onClick={() => onChange(steps.filter((_, j) => j !== i))}
                    >
                      Remove<span className="sr-only"> step {i + 1}</span>
                    </Button>
                  )}
                </span>
              )}
            </div>
            {step.kind === 'ask' && (
              <SelectField
                label="Poll or survey"
                value={step.askId}
                disabled={readOnly}
                onChange={(e) => set(i, { kind: 'ask', askId: e.target.value })}
                options={[
                  {
                    value: '',
                    label: asks.isPending
                      ? 'Loading polls and surveys…'
                      : 'Choose a poll or survey',
                  },
                  ...(asks.data ?? [])
                    .filter((a) => a.status !== 'closed' || a.id === step.askId)
                    .map((a) => ({ value: a.id, label: a.title })),
                ]}
                hint="Its questions show one after another. Needs the reader survey option for this publication."
                error={problemAt(problems, `${path}.${i}.askId`)}
              />
            )}
            {step.kind === 'recommendations' && (
              <p className="text-[12.5px] text-sub">
                Shows the publications you recommend under Partners. It’s skipped if you have none.
              </p>
            )}
            {step.kind === 'upsell' && (
              <SelectField
                label="Plan to offer"
                value={step.levelId ?? ''}
                disabled={readOnly}
                onChange={(e) =>
                  set(i, {
                    kind: 'upsell',
                    ...(e.target.value ? { levelId: e.target.value } : {}),
                  })
                }
                options={[
                  { value: '', label: 'Every paid plan' },
                  ...(levels.data?.items ?? []).map((l) => ({ value: l.id, label: l.name })),
                ]}
              />
            )}
            {step.kind === 'welcome' && (
              <>
                <TextField
                  label="Headline"
                  maxLength={120}
                  readOnly={readOnly}
                  value={step.headline}
                  onChange={(e) => set(i, { ...step, headline: e.target.value })}
                  error={problemAt(problems, `${path}.${i}.headline`)}
                />
                <TextAreaField
                  label="Text (optional)"
                  rows={3}
                  maxLength={2000}
                  readOnly={readOnly}
                  value={step.body ?? ''}
                  onChange={(e) => set(i, { ...step, body: e.target.value })}
                />
                <TextField
                  label="Opt-out link text"
                  maxLength={80}
                  readOnly={readOnly}
                  value={step.optOutText ?? ''}
                  onChange={(e) => set(i, { ...step, optOutText: e.target.value })}
                  hint="For example “No thanks”. Needs the welcome page option for this publication."
                />
              </>
            )}
          </li>
        ))}
      </ol>
      {problemAt(problems, path) && !problems.some((p) => p.path.startsWith(`${path}.`)) && (
        <p role="alert" className="text-[12.5px] font-semibold text-danger">
          {problemAt(problems, path)}
        </p>
      )}
      {!readOnly && steps.length < SIGNUP_JOURNEY_MAX_STEPS && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange([...steps, newStep('welcome')])}
          >
            Add a step
          </Button>
        </div>
      )}
    </div>
  );
}

// ---- Stats ---------------------------------------------------------------------------------

function JourneyStats({ journey }: { journey: SignupJourney }) {
  const [days, setDays] = useState(30);
  const stats = useQuery(journeyStatsQuery(journey.id, days));
  const views = stats.data?.variants.reduce((sum, v) => sum + (v.steps[0]?.views ?? 0), 0) ?? 0;
  return (
    <Section
      title="How it is doing"
      description="Views, completions and skips per step, for each variant."
      action={
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
      }
    >
      <QueryState query={stats} label="Loading stats">
        {stats.data && views === 0 ? (
          <EmptyState title="No views yet">
            {journey.status === 'live'
              ? 'Numbers appear once new subscribers sign up.'
              : 'Make the journey live to start counting.'}
          </EmptyState>
        ) : (
          <div className="grid gap-5">
            {stats.data?.variants.map((v) => (
              <div key={v.key} className="overflow-x-auto">
                <h3 className="mb-2 text-[13.5px] font-semibold">
                  {variantName(v.key)}{' '}
                  <span className="font-normal text-sub">
                    · {formatRate(v.completionRate)} finish every step
                  </span>
                </h3>
                {v.steps.length === 0 ? (
                  <p className="text-[13px] text-sub">No views of this variant yet.</p>
                ) : (
                  <table className="w-full min-w-[440px] text-left text-[13px]">
                    <thead>
                      <tr className="table-head">
                        <th scope="col" className="py-2 pr-3 font-semibold">
                          Step
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-semibold">
                          Views
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-semibold">
                          Completed
                        </th>
                        <th scope="col" className="py-2 pl-3 text-right font-semibold">
                          Skipped
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {v.steps.map((s) => {
                        const step = journey.variants.find((x) => x.key === v.key)?.steps[s.step];
                        return (
                          <tr key={s.step} className="border-t border-line">
                            <td className="py-2 pr-3">
                              {s.step + 1}. {step ? STEP_LABEL[step.kind] : 'Removed step'}
                            </td>
                            <td className="tabular px-3 py-2 text-right">
                              {numberFormat.format(s.views)}
                            </td>
                            <td className="tabular px-3 py-2 text-right">
                              {numberFormat.format(s.completions)}{' '}
                              <span className="text-sub">
                                ({formatRate(s.views ? s.completions / s.views : null)})
                              </span>
                            </td>
                            <td className="tabular py-2 pl-3 text-right">
                              {numberFormat.format(s.skips)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        )}
      </QueryState>
    </Section>
  );
}
