// Growth → Ask: polls and surveys. The list, the builder (a poll is one choice question; a survey
// has up to 20 choice or text questions, each optionally copied into a profile field so Circles
// can filter on it), and the results with a Circle filter, text answers and a CSV export.
import {
  ASK_MAX_OPTIONS,
  ASK_MAX_QUESTIONS,
  type Ask,
  type AskKind,
  type AskQuestionInput,
  type AskStatus,
  type CreateAsk,
  type MemberField,
} from '@swarm/domain';
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  SelectField,
  Tabs,
  TextAreaField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { allCirclesQuery, memberFieldsQuery } from '../api/circles';
import { ApiError } from '../api/client';
import {
  askAnswersQuery,
  askQuery,
  askResultsQuery,
  asksQuery,
  downloadFile,
  useCreateAsk,
  useDeleteAsk,
  useUpdateAsk,
} from '../api/growth';
import { Section, formatDateTime, formatDay, numberFormat, percentFormat } from '../pages/common';
import { formatRate, moveItem } from './helpers';
import { QueryState, useGrowth } from './Layout';

const STATUS_PILL: Record<AskStatus, { tone: 'brand' | 'success' | 'neutral'; label: string }> = {
  draft: { tone: 'brand', label: 'Draft' },
  open: { tone: 'success', label: 'Open' },
  closed: { tone: 'neutral', label: 'Closed' },
};

export const AskStatusPill = ({ status }: { status: AskStatus }) => (
  <Pill tone={STATUS_PILL[status].tone}>{STATUS_PILL[status].label}</Pill>
);

// ---- List ----------------------------------------------------------------------------------

export function AsksPage() {
  const { channel, canEdit } = useGrowth();
  const asks = useQuery(asksQuery(channel.id));
  const newLink = (label: string) =>
    canEdit && (
      <Link
        to="/growth/$channelId/ask/new"
        params={{ channelId: channel.id }}
        className="btn-primary btn-sm"
      >
        {label}
      </Link>
    );
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[65ch] text-[13.5px] text-sub">
          Polls go in a post as one-tap buttons; surveys live on your website. Answers can fill a
          profile field, so segments can use them.
        </p>
        {!!asks.data?.length && newLink('New poll or survey')}
      </div>
      <QueryState query={asks} label="Loading polls and surveys">
        {asks.data?.length === 0 ? (
          <EmptyState title="No polls or surveys yet" action={newLink('Create a poll or survey')}>
            Ask subscribers a quick question in a post, or a few on a survey page.
          </EmptyState>
        ) : (
          <div className="card-app overflow-x-auto">
            <table className="w-full min-w-[620px] text-left text-[13.5px]">
              <thead>
                <tr className="table-head">
                  <th scope="col" className="px-5 py-3 font-semibold">
                    Title
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Kind
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-semibold">
                    Respondents
                  </th>
                  <th scope="col" className="px-5 py-3 font-semibold">
                    Closes
                  </th>
                </tr>
              </thead>
              <tbody>
                {asks.data?.map((ask) => (
                  <tr key={ask.id} className="border-t border-line hover:bg-surface-alt">
                    <td className="px-5 py-3.5">
                      <Link
                        to="/growth/$channelId/ask/$askId"
                        params={{ channelId: channel.id, askId: ask.id }}
                        className="font-semibold text-ink no-underline hover:underline"
                      >
                        {ask.title}
                      </Link>
                    </td>
                    <td className="px-3 py-3.5 text-sub">
                      {ask.kind === 'poll' ? 'Poll' : 'Survey'}
                    </td>
                    <td className="px-3 py-3.5">
                      <AskStatusPill status={ask.status} />
                    </td>
                    <td className="tabular px-3 py-3.5 text-right">
                      {numberFormat.format(ask.respondents)}
                    </td>
                    <td className="tabular px-5 py-3.5 text-sub">{formatDay(ask.closesAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>
    </div>
  );
}

// ---- Builder -------------------------------------------------------------------------------

interface QuestionDraft {
  key: string;
  id?: string;
  prompt: string;
  description: string;
  kind: 'choice' | 'text';
  fieldId: string;
  required: boolean;
  options: { key: string; id?: string; label: string }[];
}

let nextKey = 0;
const key = () => `k${(nextKey += 1)}`;

const emptyQuestion = (kind: 'choice' | 'text' = 'choice'): QuestionDraft => ({
  key: key(),
  prompt: '',
  description: '',
  kind,
  fieldId: '',
  required: false,
  options:
    kind === 'choice'
      ? [
          { key: key(), label: '' },
          { key: key(), label: '' },
        ]
      : [],
});

function questionsFrom(ask: Ask | undefined): QuestionDraft[] {
  if (!ask) return [emptyQuestion()];
  return ask.questions.map((q) => ({
    key: key(),
    id: q.id,
    prompt: q.prompt,
    description: q.description ?? '',
    kind: q.kind,
    fieldId: q.fieldId ?? '',
    required: q.required,
    options: q.options.map((o) => ({ key: key(), id: o.id, label: o.label })),
  }));
}

/** A datetime-local value for an ISO time, in the operator's zone. */
function localValue(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function NewAskPage() {
  return <AskBuilder ask={undefined} />;
}

export function AskPage({ askId }: { askId: string }) {
  const ask = useQuery(askQuery(askId));
  const [tab, setTab] = useState<'build' | 'results'>('build');
  const tabsId = useId();
  return (
    <QueryState query={ask} label="Loading the poll or survey">
      {ask.data && (
        <div className="grid gap-4">
          <Tabs
            label="Poll or survey"
            tabs={[
              { id: 'build', label: 'Questions' },
              { id: 'results', label: 'Results' },
            ]}
            value={tab}
            onChange={setTab}
            idFor={(id) => `${tabsId}-${id}`}
            panelFor={() => `${tabsId}-panel`}
          />
          <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`}>
            {tab === 'build' ? (
              <AskBuilder key={ask.data.id} ask={ask.data} />
            ) : (
              <AskResultsView ask={ask.data} />
            )}
          </div>
        </div>
      )}
    </QueryState>
  );
}

function AskBuilder({ ask }: { ask: Ask | undefined }) {
  const { channel, canEdit } = useGrowth();
  const navigate = useNavigate();
  const create = useCreateAsk(channel.id);
  const update = useUpdateAsk({ id: ask?.id ?? 'ak_', channelId: channel.id });
  const remove = useDeleteAsk({ id: ask?.id ?? 'ak_', channelId: channel.id });
  const fields = useQuery(memberFieldsQuery(channel.id));
  const [kind, setKind] = useState<AskKind>(ask?.kind ?? 'poll');
  const [title, setTitle] = useState(ask?.title ?? '');
  const [description, setDescription] = useState(ask?.description ?? '');
  const [resultsPublic, setResultsPublic] = useState(ask?.resultsPublic ?? true);
  const [closesAt, setClosesAt] = useState(localValue(ask?.closesAt ?? null));
  const [questions, setQuestions] = useState<QuestionDraft[]>(() => questionsFrom(ask));
  const [saved, setSaved] = useState(false);
  const mutation = ask ? update : create;
  const error = mutation.error instanceof ApiError ? mutation.error : null;
  const readOnly = !canEdit;
  const kindName = useId();

  const setQuestion = (i: number, patch: Partial<QuestionDraft>) => {
    setSaved(false);
    setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  };

  const fieldsBody = (): Omit<CreateAsk, 'kind'> => ({
    title: title.trim(),
    description: description.trim() || null,
    resultsPublic,
    closesAt: closesAt ? new Date(closesAt).toISOString() : null,
    questions: questions.map((q): AskQuestionInput => ({
      ...(q.id ? { id: q.id } : {}),
      prompt: q.prompt.trim(),
      description: q.description.trim() || null,
      kind: q.kind,
      fieldId: q.fieldId || null,
      required: q.required,
      options:
        q.kind === 'choice'
          ? q.options.map((o) => ({ ...(o.id ? { id: o.id } : {}), label: o.label.trim() }))
          : [],
    })),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ask) {
      update.mutate(fieldsBody(), {
        onSuccess: (savedAsk) => {
          // New questions and options now have ids; keep them so the next save updates them.
          setQuestions(questionsFrom(savedAsk));
          setSaved(true);
        },
      });
    } else {
      create.mutate(
        { kind, ...fieldsBody() },
        {
          onSuccess: (created) =>
            void navigate({
              to: '/growth/$channelId/ask/$askId',
              params: { channelId: channel.id, askId: created.id },
            }),
        },
      );
    }
  };

  const setStatus = (status: AskStatus) => update.mutate({ status });

  return (
    <form className="grid gap-5" onSubmit={submit}>
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <Link
          to="/growth/$channelId/ask"
          params={{ channelId: channel.id }}
          className="text-sub no-underline hover:text-ink"
        >
          ← Polls & surveys
        </Link>
        {ask && <AskStatusPill status={ask.status} />}
        {ask && (
          <span className="tabular text-sub">
            {numberFormat.format(ask.respondents)} respondent{ask.respondents === 1 ? '' : 's'}
          </span>
        )}
        {ask && canEdit && (
          <span className="ml-auto flex flex-wrap gap-2">
            {ask.status === 'draft' && (
              <Button size="sm" loading={update.isPending} onClick={() => setStatus('open')}>
                Open it
              </Button>
            )}
            {ask.status === 'open' && (
              <Button
                variant="ghost"
                size="sm"
                loading={update.isPending}
                onClick={() => setStatus('closed')}
              >
                Close it
              </Button>
            )}
            {ask.status === 'closed' && (
              <Button
                variant="ghost"
                size="sm"
                loading={update.isPending}
                onClick={() => setStatus('open')}
              >
                Reopen
              </Button>
            )}
          </span>
        )}
      </div>

      <Section
        title={ask ? `About this ${ask.kind === 'poll' ? 'poll' : 'survey'}` : 'New poll or survey'}
      >
        <div className="grid gap-4">
          {!ask && (
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 text-[13px] font-semibold">Kind</legend>
              {(
                [
                  ['poll', 'Poll', 'One choice question. Goes in a post as one-tap buttons.'],
                  ['survey', 'Survey', 'Up to 20 questions on a page of your website.'],
                ] as const
              ).map(([value, label, hint]) => (
                <label key={value} className="flex items-start gap-2 text-[13.5px]">
                  <input
                    type="radio"
                    name={kindName}
                    className="mt-1 size-4 accent-purple"
                    checked={kind === value}
                    onChange={() => {
                      setKind(value);
                      if (value === 'poll') {
                        setQuestions((qs) => [
                          qs[0]?.kind === 'choice' ? qs[0] : emptyQuestion('choice'),
                        ]);
                      }
                    }}
                  />
                  <span className="font-semibold">
                    {label} <span className="font-normal text-sub">{hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <TextField
            label="Title"
            required
            maxLength={200}
            readOnly={readOnly}
            value={title}
            onChange={(e) => {
              setSaved(false);
              setTitle(e.target.value);
            }}
            error={error?.field('title')}
          />
          <TextAreaField
            label="Description (optional)"
            rows={2}
            maxLength={1000}
            readOnly={readOnly}
            value={description}
            onChange={(e) => {
              setSaved(false);
              setDescription(e.target.value);
            }}
            error={error?.field('description')}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Closes at (optional)"
              type="datetime-local"
              readOnly={readOnly}
              value={closesAt}
              onChange={(e) => {
                setSaved(false);
                setClosesAt(e.target.value);
              }}
              hint={`Your time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}
              error={error?.field('closesAt')}
            />
            <div className="pt-6">
              <Checkbox
                label="Show results to people who answer"
                checked={resultsPublic}
                disabled={readOnly}
                onChange={(v) => {
                  setSaved(false);
                  setResultsPublic(v);
                }}
              />
            </div>
          </div>
          {ask && (
            <p className="text-[12.5px] text-sub">
              Survey page on your website: <span className="font-mono">{ask.surveyPath}</span>
            </p>
          )}
        </div>
      </Section>

      <ol className="grid gap-4" aria-label="Questions">
        {questions.map((q, i) => (
          <QuestionEditor
            key={q.key}
            index={i}
            total={questions.length}
            question={q}
            poll={kind === 'poll'}
            fields={fields.data ?? []}
            readOnly={readOnly}
            error={error}
            onChange={(patch) => setQuestion(i, patch)}
            onMove={(to) => {
              setSaved(false);
              setQuestions((qs) => moveItem(qs, i, to));
            }}
            onRemove={() => {
              setSaved(false);
              setQuestions((qs) => qs.filter((_, j) => j !== i));
            }}
          />
        ))}
      </ol>
      {kind === 'survey' && !readOnly && questions.length < ASK_MAX_QUESTIONS && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setQuestions((qs) => [...qs, emptyQuestion('choice')])}
          >
            Add a choice question
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setQuestions((qs) => [...qs, emptyQuestion('text')])}
          >
            Add a text question
          </Button>
        </div>
      )}
      {error?.field('questions') && (
        <p role="alert" className="text-[12.5px] font-semibold text-danger">
          {error.field('questions')}
        </p>
      )}
      {error && !error.details.length && <ErrorNotice title="Not saved" message={error.message} />}
      {error && error.details.length > 0 && (
        <ErrorNotice title="Not saved" message={error.details.map((d) => d.message).join(' ')} />
      )}
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={mutation.isPending}>
            {ask ? 'Save changes' : kind === 'poll' ? 'Create poll' : 'Create survey'}
          </Button>
          {saved && (
            <span role="status" className="text-[13px] text-success">
              Saved.
            </span>
          )}
          {ask && (
            <Button
              variant="quiet"
              className="ml-auto"
              loading={remove.isPending}
              onClick={() => {
                if (window.confirm(`Delete “${ask.title}” and its answers?`)) {
                  remove.mutate(undefined, {
                    onSuccess: () =>
                      void navigate({
                        to: '/growth/$channelId/ask',
                        params: { channelId: channel.id },
                      }),
                  });
                }
              }}
            >
              Delete {ask.kind === 'poll' ? 'poll' : 'survey'}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-[12.5px] text-sub">An editor or admin changes polls and surveys.</p>
      )}
      {remove.error && <ErrorNotice title="Not deleted" message={remove.error.message} />}
    </form>
  );
}

function QuestionEditor({
  index,
  total,
  question,
  poll,
  fields,
  readOnly,
  error,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  total: number;
  question: QuestionDraft;
  poll: boolean;
  fields: MemberField[];
  readOnly: boolean;
  error: ApiError | null;
  onChange: (patch: Partial<QuestionDraft>) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const path = `questions.${index}`;
  const fitting = fields.filter(
    (f) => !f.encrypted && (question.kind === 'choice' ? f.type === 'select' : f.type === 'text'),
  );
  const setOption = (j: number, label: string) =>
    onChange({ options: question.options.map((o, k) => (k === j ? { ...o, label } : o)) });

  return (
    <li className="card-app grid gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[14px] font-semibold">
          {poll ? 'The question' : `Question ${n}`}{' '}
          <span className="font-normal text-sub">
            · {question.kind === 'choice' ? 'Choice' : 'Text answer'}
          </span>
        </h3>
        {!readOnly && !poll && (
          <span className="flex gap-1">
            <Button
              variant="quiet"
              size="sm"
              disabled={index === 0}
              onClick={() => onMove(index - 1)}
            >
              Move up<span className="sr-only"> question {n}</span>
            </Button>
            <Button
              variant="quiet"
              size="sm"
              disabled={index === total - 1}
              onClick={() => onMove(index + 1)}
            >
              Move down<span className="sr-only"> question {n}</span>
            </Button>
            {total > 1 && (
              <Button variant="quiet" size="sm" onClick={onRemove}>
                Remove<span className="sr-only"> question {n}</span>
              </Button>
            )}
          </span>
        )}
      </div>
      <TextField
        label="Question"
        required
        maxLength={300}
        readOnly={readOnly}
        value={question.prompt}
        onChange={(e) => onChange({ prompt: e.target.value })}
        error={error?.field(`${path}.prompt`)}
      />
      {!poll && (
        <TextField
          label="Help text (optional)"
          maxLength={1000}
          readOnly={readOnly}
          value={question.description}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      )}
      {question.kind === 'choice' && (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[13px] font-semibold">Options</legend>
          {question.options.map((o, j) => (
            <div key={o.key} className="flex items-center gap-2">
              <label className="sr-only" htmlFor={`${o.key}-label`}>
                Option {j + 1}
              </label>
              <input
                id={`${o.key}-label`}
                value={o.label}
                maxLength={120}
                readOnly={readOnly}
                placeholder={`Option ${j + 1}`}
                onChange={(e) => setOption(j, e.target.value)}
                className="min-h-10 min-w-0 flex-1 rounded-control border border-line-control px-3 text-[14px] hover:border-line-control-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-purple"
              />
              {!readOnly && question.options.length > 2 && (
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => onChange({ options: question.options.filter((_, k) => k !== j) })}
                >
                  Remove<span className="sr-only"> option {j + 1}</span>
                </Button>
              )}
            </div>
          ))}
          {error?.field(`${path}.options`) && (
            <p role="alert" className="text-[12.5px] font-semibold text-danger">
              {error.field(`${path}.options`)}
            </p>
          )}
          {!readOnly && question.options.length < ASK_MAX_OPTIONS && (
            <div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  onChange({ options: [...question.options, { key: key(), label: '' }] })
                }
              >
                Add option
              </Button>
            </div>
          )}
        </fieldset>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Copy answers into a profile field"
          value={question.fieldId}
          disabled={readOnly}
          onChange={(e) => onChange({ fieldId: e.target.value })}
          options={[
            { value: '', label: 'No' },
            ...fitting.map((f) => ({ value: f.id, label: f.label || f.key })),
          ]}
          hint={
            question.kind === 'choice'
              ? 'A select field whose choices include every option. Segments can then filter on it.'
              : 'A text field. Segments can then filter on it.'
          }
          error={error?.field(`${path}.fieldId`)}
        />
        {!poll && (
          <div className="pt-6">
            <Checkbox
              label="An answer is required"
              checked={question.required}
              disabled={readOnly}
              onChange={(v) => onChange({ required: v })}
            />
          </div>
        )}
      </div>
    </li>
  );
}

// ---- Results -------------------------------------------------------------------------------

function AskResultsView({ ask }: { ask: Ask }) {
  const { channel, canAdmin } = useGrowth();
  const circles = useQuery(allCirclesQuery(channel.id));
  const [circleId, setCircleId] = useState('');
  const results = useQuery(askResultsQuery(ask.id, circleId || null));
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-xs">
          <SelectField
            label="Answers from"
            value={circleId}
            onChange={(e) => setCircleId(e.target.value)}
            options={[
              { value: '', label: 'Every subscriber' },
              ...(circles.data ?? []).map((c) => ({ value: c.id, label: `Segment: ${c.name}` })),
            ]}
          />
        </div>
        {canAdmin && (
          <Button
            variant="ghost"
            size="sm"
            loading={exporting}
            onClick={() => {
              setExporting(true);
              setExportError(null);
              downloadFile(`/api/v1/asks/${ask.id}/export`, `ask-${ask.id}.csv`)
                .catch((error: Error) => setExportError(error.message))
                .finally(() => setExporting(false));
            }}
          >
            Download answers (CSV)
          </Button>
        )}
      </div>
      {exportError && <ErrorNotice title="Not downloaded" message={exportError} />}
      <QueryState query={results} label="Loading results">
        {results.data && results.data.respondents === 0 ? (
          <EmptyState title="No answers yet">
            {ask.status === 'draft'
              ? 'Open it, then put the poll in a post or share the survey page.'
              : circleId
                ? 'Nobody in this segment has answered yet.'
                : 'Answers appear here as subscribers respond.'}
          </EmptyState>
        ) : (
          results.data && (
            <>
              <p className="text-[13.5px]">
                <b className="tabular">{numberFormat.format(results.data.respondents)}</b>{' '}
                respondent{results.data.respondents === 1 ? '' : 's'}
                {results.isFetching && <span className="text-sub"> · updating…</span>}
              </p>
              {results.data.questions.map((q) => (
                <Section
                  key={q.questionId}
                  title={q.prompt}
                  description={`${numberFormat.format(q.answers)} answer${q.answers === 1 ? '' : 's'}`}
                >
                  {q.kind === 'choice' ? (
                    <OptionBars options={q.options} answers={q.answers} />
                  ) : (
                    <TextAnswers askId={ask.id} questionId={q.questionId} />
                  )}
                </Section>
              ))}
            </>
          )
        )}
      </QueryState>
    </div>
  );
}

function OptionBars({
  options,
  answers,
}: {
  options: { optionId: string; label: string; count: number }[];
  answers: number;
}) {
  return (
    <ul className="grid gap-3">
      {options.map((o) => {
        const share = answers > 0 ? o.count / answers : 0;
        return (
          <li key={o.optionId} className="grid gap-1">
            <div className="flex items-baseline justify-between gap-3 text-[13.5px]">
              <span className="min-w-0">{o.label}</span>
              <span className="tabular shrink-0 text-sub">
                {numberFormat.format(o.count)} · {formatRate(answers > 0 ? share : null)}
              </span>
            </div>
            <div
              role="img"
              aria-label={`${o.label}: ${percentFormat.format(share)}`}
              className="h-2 overflow-hidden rounded-pill bg-surface-alt"
            >
              <div className="h-full rounded-pill bg-purple" style={{ width: `${share * 100}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function TextAnswers({ askId, questionId }: { askId: string; questionId: string }) {
  const [stack, setStack] = useState<(string | null)[]>([null]);
  const cursor = stack[stack.length - 1] ?? null;
  const answers = useQuery(askAnswersQuery(askId, questionId, cursor));
  if (answers.isPending) return <LoadingRows label="Loading answers" rows={2} />;
  if (answers.error) return <ErrorNotice message={answers.error.message} />;
  if (answers.data.items.length === 0)
    return <p className="text-[13.5px] text-sub">No answers yet.</p>;
  return (
    <>
      <ul className="grid gap-2">
        {answers.data.items.map((a) => (
          <li
            key={`${a.memberId}-${a.answeredAt}`}
            className="rounded-card-app bg-surface-alt px-3 py-2 text-[13.5px]"
          >
            <p className="whitespace-pre-wrap">{a.text}</p>
            <p className="mt-1 text-[12px] text-sub">
              {formatDateTime(a.answeredAt)} ·{' '}
              {a.surface === 'email'
                ? 'from a post'
                : a.surface === 'journey'
                  ? 'after signing up'
                  : 'on the website'}
            </p>
          </li>
        ))}
      </ul>
      {(stack.length > 1 || answers.data.nextCursor) && (
        <nav aria-label="Answer pages" className="mt-3 flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={stack.length === 1}
            onClick={() => setStack((s) => s.slice(0, -1))}
          >
            Newer
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!answers.data.nextCursor}
            onClick={() => {
              const next = answers.data.nextCursor;
              if (next) setStack((s) => [...s, next]);
            }}
          >
            Older
          </Button>
        </nav>
      )}
    </>
  );
}
