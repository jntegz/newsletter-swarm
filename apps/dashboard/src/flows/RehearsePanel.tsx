// Rehearse: pick a subscriber or a segment, and see what the automation would do for them. Nothing is
// sent and nothing changes. What can't be known ahead of time is the writer's to choose, step by step.
import {
  triggersOf,
  type Flow,
  type FlowGraph,
  type FlowRehearsal,
  type FlowRehearsalAnswer,
  type FlowRehearsalResult,
  type FlowRehearsalStep,
} from '@swarm/domain';
import { Button, ErrorNotice, LoadingRows, TextField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useDebounced } from '../api/circles';
import { useRehearse } from '../api/flows';
import { membersQuery } from '../api/members';
import { STEP_INFO, type WorkingGraph } from './graph';
import type { Lookups } from './lookups';
import { endSentence, entrySentences, stepSentences } from './rehearse';
import { SelectField } from './Select';
import { StepIcon } from './StepIcon';
import { summarize } from './summary';

export interface RehearsalPath {
  nodes: Set<string>;
  edges: Set<string>;
}

/** What a rehearsal took, for the canvas to show. */
const pathOf = (rehearsal: FlowRehearsal): RehearsalPath => ({
  nodes: new Set(rehearsal.steps.map((s) => s.nodeId)),
  edges: new Set(
    rehearsal.steps.flatMap((s) => (s.outcome ? [`${s.nodeId}\u0000${s.outcome}`] : [])),
  ),
});

type Who = { kind: 'member'; id: string; email: string } | { kind: 'circle'; id: string };

function Choice({
  legend,
  name,
  options,
  value,
  onChange,
}: {
  legend: string;
  name: string;
  options: { value: FlowRehearsalAnswer; label: string }[];
  value: FlowRehearsalAnswer | null;
  onChange: (value: FlowRehearsalAnswer) => void;
}) {
  return (
    <fieldset className="mt-1.5">
      <legend className="sr-only">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {options.map((option) => (
          <label key={option.value} className="flex min-h-8 items-center gap-1.5 text-[13px]">
            <input
              type="radio"
              name={name}
              className="size-4 accent-purple"
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function StepRow({
  step,
  graph,
  lookups,
  answers,
  onAnswer,
  now,
}: {
  step: FlowRehearsalStep;
  graph: WorkingGraph;
  lookups: Lookups;
  answers: Record<string, FlowRehearsalAnswer>;
  onAnswer: (nodeId: string, answer: FlowRehearsalAnswer) => void;
  now: number;
}) {
  const node = graph.nodes.find((n) => n.id === step.nodeId);
  const title = node?.name || STEP_INFO[step.type].label;
  const { detail } = step;
  return (
    <li className="flex gap-3 border-t border-line py-2.5 first:border-t-0">
      <span className="mt-0.5 text-purple-deep">
        <StepIcon type={step.type} size={15} />
      </span>
      <div className="min-w-0">
        <p className="text-[13.5px] font-semibold">{title}</p>
        {stepSentences(step, lookups.names, now).map((sentence, i) => (
          <p key={i} className="text-[13px] text-sub">
            {sentence}
          </p>
        ))}
        {detail.kind === 'wait' && detail.basis === 'assumed' && (
          <Choice
            legend={`What happens at ${title}`}
            name={`answer-${step.nodeId}`}
            value={answers[step.nodeId] ?? detail.answer}
            onChange={(answer) => onAnswer(step.nodeId, answer)}
            options={
              detail.event === 'open'
                ? [
                    { value: 'yes', label: 'If they open' },
                    { value: 'no', label: 'If they don’t' },
                  ]
                : [
                    { value: 'yes', label: 'If they click' },
                    { value: 'no', label: 'If they don’t' },
                  ]
            }
          />
        )}
        {detail.kind === 'split' && (
          <Choice
            legend={`Which path to follow at ${title}`}
            name={`answer-${step.nodeId}`}
            value={answers[step.nodeId] ?? detail.arm}
            onChange={(answer) => onAnswer(step.nodeId, answer)}
            options={[
              { value: 'a', label: 'Follow A' },
              { value: 'b', label: 'Follow B' },
            ]}
          />
        )}
      </div>
    </li>
  );
}

export function RehearsePanel({
  flow,
  graph,
  lookups,
  flush,
  onPath,
  onClose,
}: {
  flow: Flow;
  graph: WorkingGraph;
  lookups: Lookups;
  flush: () => Promise<unknown>;
  onPath: (path: RehearsalPath | null) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<'draft' | 'live'>(
    flow.liveVersion !== null ? 'live' : 'draft',
  );
  const [mode, setMode] = useState<'member' | 'circle'>('member');
  const [q, setQ] = useState('');
  const search = useDebounced(q, 300);
  const members = useQuery(membersQuery(flow.channelId, { q: search }));
  const [who, setWho] = useState<Who | null>(null);
  const [startEvent, setStartEvent] = useState(0);
  const [answers, setAnswers] = useState<Record<string, FlowRehearsalAnswer>>({});
  const [person, setPerson] = useState(0);
  const [result, setResult] = useState<FlowRehearsalResult | null>(null);
  const [askedAt, setAskedAt] = useState(() => Date.now());
  const rehearse = useRehearse(flow.id);

  const starts = triggersOf(flow.draftGraph as FlowGraph);
  const go = async (next: Record<string, FlowRehearsalAnswer> = answers) => {
    if (!who) return;
    // A draft rehearses what is saved, so whatever was just changed is saved first.
    if (source === 'draft') await flush();
    const asked = await rehearse.mutateAsync({
      source,
      ...(who.kind === 'member' ? { memberId: who.id } : { circleId: who.id }),
      startEvent,
      answers: next,
    });
    setAskedAt(Date.now());
    setResult(asked);
    setPerson((p) => (p < asked.people.length ? p : 0));
  };

  const shown = result?.people[person] ?? null;
  useEffect(() => {
    onPath(shown ? pathOf(shown) : null);
  }, [shown, onPath]);
  useEffect(() => () => onPath(null), [onPath]);

  const answer = (nodeId: string, value: FlowRehearsalAnswer) => {
    const next = { ...answers, [nodeId]: value };
    setAnswers(next);
    void go(next);
  };

  return (
    <section aria-labelledby="rehearse-title" className="card-app p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="rehearse-title" className="text-[15px] font-semibold">
            Rehearse
          </h2>
          <p className="mt-0.5 text-[13px] text-sub">
            See what would happen to a subscriber. Nothing is sent and nothing changes.
          </p>
        </div>
        <Button variant="quiet" size="sm" onClick={onClose}>
          Close rehearsal
        </Button>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="grid content-start gap-3">
          {flow.liveVersion !== null && (
            <SelectField
              label="What to rehearse"
              value={source}
              onChange={(e) => setSource(e.target.value as 'draft' | 'live')}
            >
              <option value="live">Live version {flow.liveVersion}</option>
              <option value="draft">The draft you are editing</option>
            </SelectField>
          )}
          {starts.length > 1 && (
            <SelectField
              label="Start event to imagine"
              value={startEvent}
              onChange={(e) => setStartEvent(Number(e.target.value))}
            >
              {starts.map((config, index) => (
                <option key={index} value={index}>
                  {summarize({ id: 'trigger', type: 'trigger', config }, lookups.names)}
                </option>
              ))}
            </SelectField>
          )}
          <SelectField
            label="Who"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as 'member' | 'circle');
              setWho(null);
            }}
          >
            <option value="member">One subscriber</option>
            <option value="circle">A sample of a segment</option>
          </SelectField>
          {mode === 'circle' ? (
            <SelectField
              label="Segment"
              value={who?.kind === 'circle' ? who.id : ''}
              onChange={(e) =>
                setWho(e.target.value ? { kind: 'circle', id: e.target.value } : null)
              }
            >
              <option value="">Choose a segment</option>
              {lookups.circles.map((circle) => (
                <option key={circle.id} value={circle.id}>
                  {circle.name}
                </option>
              ))}
            </SelectField>
          ) : (
            <div>
              <TextField
                label="Find a subscriber"
                type="search"
                placeholder="Email or name"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <div className="mt-2 max-h-44 overflow-y-auto">
                {members.isPending && <LoadingRows label="Loading subscribers" rows={2} />}
                {members.error && <ErrorNotice message={members.error.message} />}
                {members.data?.items.length === 0 && (
                  <p className="text-[13px] text-sub">No subscribers match.</p>
                )}
                {!!members.data?.items.length && (
                  <fieldset>
                    <legend className="sr-only">Subscriber</legend>
                    <ul className="grid gap-0.5">
                      {members.data.items.map((m) => (
                        <li key={m.id}>
                          <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-[10px] px-2 text-[13px] hover:bg-surface-alt">
                            <input
                              type="radio"
                              name="rehearse-member"
                              className="size-4 accent-purple"
                              checked={who?.kind === 'member' && who.id === m.id}
                              onChange={() => setWho({ kind: 'member', id: m.id, email: m.email })}
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
            </div>
          )}
          <div>
            <Button disabled={!who} loading={rehearse.isPending} onClick={() => void go()}>
              Rehearse
            </Button>
          </div>
          <div className="rounded-card-app bg-surface-alt px-3 py-2 text-[12.5px] text-sub">
            <p className="font-semibold text-ink">What a rehearsal can’t know</p>
            <ul className="mt-1 grid list-disc gap-0.5 pl-4">
              <li>Whether someone will open or click. You choose, at each wait.</li>
              <li>Whether a webhook will answer. It assumes that it does.</li>
              <li>When a paused publication or warm-up comes back. It assumes that it does.</li>
              <li>
                What else happens along the way, such as a new post, an unsubscribe or another
                automation they enter.
              </li>
            </ul>
          </div>
        </div>

        <div role="status" aria-live="polite" className="min-w-0">
          {rehearse.error && (
            <ErrorNotice title="The rehearsal did not run" message={rehearse.error.message} />
          )}
          {!result && !rehearse.error && (
            <p className="text-[13px] text-sub">Choose who to rehearse, and the steps show here.</p>
          )}
          {result && result.people.length === 0 && (
            <p className="text-[13px] text-sub">This segment has nobody in it yet.</p>
          )}
          {result && result.circleSize !== null && result.people.length > 0 && (
            <SelectField
              label={`A random sample from ${result.circleSize} subscribers`}
              value={person}
              onChange={(e) => setPerson(Number(e.target.value))}
            >
              {result.people.map((p, index) => (
                <option key={p.member.id} value={index}>
                  {p.member.email}
                </option>
              ))}
            </SelectField>
          )}
          {shown && (
            <div className="mt-1">
              <p className="text-[13.5px] font-semibold">{shown.member.email}</p>
              {entrySentences(shown, result?.flowStatus ?? flow.status).map((sentence, i) => (
                <p key={i} className="text-[13px] text-sub">
                  {sentence}
                </p>
              ))}
              {!!result?.pendingSteps && (
                <p className="mt-1 text-[13px] text-sub">
                  {result.pendingSteps === 1
                    ? 'One step isn’t set up yet, so it isn’t part of this rehearsal.'
                    : `${result.pendingSteps} steps aren’t set up yet, so they aren’t part of this rehearsal.`}
                </p>
              )}
              <ol className="mt-2">
                {shown.steps.map((step) => (
                  <StepRow
                    key={step.nodeId}
                    step={step}
                    graph={graph}
                    lookups={lookups}
                    answers={answers}
                    onAnswer={answer}
                    now={askedAt}
                  />
                ))}
              </ol>
              <p className="border-t border-line pt-2.5 text-[13.5px] font-semibold">
                {endSentence(shown.end)}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
