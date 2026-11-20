// The node inspector: a form per step type, where each outcome leads, and the step's issues.
// With nothing selected it shows the Flow's own settings.
import {
  FLOW_MAX_TRIGGERS,
  FLOW_REENTRY_MAX_PER_HOUR,
  FLOW_TRIGGER_TYPES,
  defaultSendRegardless,
  type Channel,
  type CircleGroup,
  type Flow,
  type FlowEdgeLabel,
  type FlowTriggerType,
} from '@swarm/domain';
import { Button, Checkbox, ErrorNotice, TextAreaField, TextField } from '@swarm/ui/components';
import { Link } from '@tanstack/react-router';
import { useId, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { SelectField } from './Select';
import { ApiError } from '../api/client';
import { useCreateFlowEmail, useRotateWebhookSecret, useUpdateFlow } from '../api/flows';
import { RuleEditor } from '../circles/RuleEditor';
import { asRootGroup, fieldCatalogue, newCondition, validateRule } from '../circles/rules';
import { FieldInput } from '../pages/MemberFieldInput';
import { fromDraft, toDraft } from '../pages/members-helpers';
import {
  EDGE_LABEL,
  STEP_INFO,
  TRIGGER_LABEL,
  connectionProblem,
  outputsOf,
  type Issue,
  type WorkingGraph,
  type WorkingNode,
} from './graph';
import type { Lookups } from './lookups';
import { StepIcon } from './StepIcon';
import { WEEKDAY_SHORT } from './summary';

type Config = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const int = (text: string): number | undefined => {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isInteger(n) ? n : undefined;
};
const numText = (v: unknown) => (typeof v === 'number' ? String(v) : '');

/** Drops keys whose value is undefined, so optional ids disappear from the config. */
function clean(config: Config): Config {
  return Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
}

interface InspectorProps extends StepProps {
  headingRef: RefObject<HTMLHeadingElement | null>;
}

/** Everything the per-step forms get (no refs, so they can be read while rendering). */
interface StepProps {
  flow: Flow;
  channel: Channel;
  graph: WorkingGraph;
  node: WorkingNode | null;
  lookups: Lookups;
  issues: Issue[];
  readOnly: boolean;
  canAdmin: boolean;
  onChange: (node: WorkingNode) => void;
  onOutcome: (from: string, label: FlowEdgeLabel, to: string | null) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onBeforeLeave: () => void;
}

export function Inspector({ headingRef, ...props }: InspectorProps) {
  const { node } = props;
  if (!node) return <FlowSettings {...props} headingRef={headingRef} />;
  const info = STEP_INFO[node.type];
  const set = (patch: Config) =>
    props.onChange({ ...node, config: clean({ ...node.config, ...patch }) });
  const replace = (config: Config) => props.onChange({ ...node, config: clean(config) });

  return (
    <section
      aria-labelledby="flow-inspector-title"
      id="flow-inspector"
      className="card-app grid content-start gap-4 p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-[10px] bg-lavender text-purple-deep">
            <StepIcon type={node.type} />
          </span>
          <div>
            <h2
              id="flow-inspector-title"
              ref={headingRef}
              tabIndex={-1}
              className="text-[16px] font-semibold tracking-[-0.02em] outline-none"
            >
              {node.name || info.label}
            </h2>
            <p className="text-[12.5px] text-sub">{info.description}</p>
          </div>
        </div>
        <Button variant="quiet" size="sm" onClick={props.onClose}>
          Close
        </Button>
      </div>

      {props.issues.length > 0 && (
        <ul className="grid gap-1 rounded-card-app bg-danger-soft px-3 py-2 text-[12.5px] font-semibold text-danger">
          {props.issues.map((issue, i) => (
            <li key={`${issue.code}-${i}`}>{issue.message}</li>
          ))}
        </ul>
      )}

      <fieldset disabled={props.readOnly} className="grid gap-4">
        <legend className="sr-only">Step settings</legend>
        <TextField
          label="Label on the canvas"
          hint="Optional."
          maxLength={80}
          value={node.name ?? ''}
          onChange={(e) => {
            const { name: _name, ...rest } = node;
            props.onChange(e.target.value ? { ...rest, name: e.target.value } : rest);
          }}
        />
        <StepForm {...props} node={node} set={set} replace={replace} />
      </fieldset>

      {outputsOf(node.type).length > 0 && <Outcomes {...props} node={node} />}

      {node.type !== 'trigger' && !props.readOnly && (
        <div className="border-t border-line pt-4">
          <Button variant="danger" size="sm" onClick={() => props.onDelete(node.id)}>
            Remove step
          </Button>
        </div>
      )}
    </section>
  );
}

// ---- Outcomes --------------------------------------------------------------------------------

function Outcomes({ graph, node, readOnly, onOutcome }: StepProps & { node: WorkingNode }) {
  const outputs = outputsOf(node.type);
  const titleOf = (n: WorkingNode) => n.name || STEP_INFO[n.type].label;
  return (
    <fieldset disabled={readOnly} className="grid gap-3 border-t border-line pt-4">
      <legend className="mb-2 text-[13px] font-semibold">Then</legend>
      {outputs.map((label) => {
        const current = graph.edges.find((e) => e.from === node.id && e.label === label)?.to ?? '';
        const options = graph.nodes.filter(
          (n) => n.id === current || connectionProblem(graph, node.id, n.id, label) === null,
        );
        return (
          <SelectField
            key={label}
            label={outputs.length === 1 ? 'Next step' : `${EDGE_LABEL[label]}: next step`}
            value={current}
            onChange={(e) => onOutcome(node.id, label, e.target.value || null)}
          >
            <option value="">End the run here</option>
            {options.map((n) => (
              <option key={n.id} value={n.id}>
                {titleOf(n)} ({n.id})
              </option>
            ))}
          </SelectField>
        );
      })}
    </fieldset>
  );
}

// ---- Per-type forms --------------------------------------------------------------------------

type FormProps = StepProps & {
  node: WorkingNode;
  set: (patch: Config) => void;
  replace: (config: Config) => void;
};

function StepForm(props: FormProps) {
  switch (props.node.type) {
    case 'trigger':
      return <TriggerForm {...props} />;
    case 'send_email':
      return <SendEmailForm {...props} />;
    case 'delay':
      return <DelayForm {...props} />;
    case 'add_tag':
    case 'remove_tag':
      return (
        <Picker
          label="Tag"
          value={str(props.node.config.tagId)}
          options={props.lookups.tags.map((t) => [t.id, t.name])}
          empty="Choose a tag"
          onChange={(tagId) => props.set({ tagId: tagId || undefined })}
          hint={
            props.lookups.tags.length
              ? undefined
              : 'This publication has no tags yet. Add one on a subscriber first.'
          }
        />
      );
    case 'update_field':
      return <UpdateFieldForm {...props} />;
    case 'change_level':
      return <ChangeLevelForm {...props} />;
    case 'enrol_flow':
      return (
        <Picker
          label="Automation to start"
          value={str(props.node.config.flowId)}
          options={props.lookups.flows.map((f) => [f.id, f.name])}
          empty="Choose an automation"
          hint="Subscribers enrol only while that automation is live."
          onChange={(flowId) => props.set({ flowId: flowId || undefined })}
        />
      );
    case 'branch':
      return <BranchForm {...props} />;
    case 'ab_split':
      return <SplitForm {...props} />;
    case 'wait_for_event':
      return <WaitForm {...props} />;
    case 'webhook_call':
      return <WebhookForm {...props} />;
    case 'notify_author':
      return <NotifyForm {...props} />;
    case 'exit':
      return (
        <p className="text-[13px] text-sub">
          The run ends here and the subscriber leaves the automation.
        </p>
      );
    default:
      return null;
  }
}

function Picker({
  label,
  value,
  options,
  empty,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  empty: string;
  hint?: ReactNode;
  onChange: (value: string) => void;
}) {
  return (
    <SelectField label={label} value={value} hint={hint} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {options.map(([id, name]) => (
        <option key={id} value={id}>
          {name}
        </option>
      ))}
    </SelectField>
  );
}

function RuleField({
  legend,
  rule,
  lookups,
  readOnly,
  onChange,
}: {
  legend: string;
  rule: unknown;
  lookups: Lookups;
  readOnly: boolean;
  onChange: (rule: CircleGroup) => void;
}) {
  const catalogue = useMemo(
    () =>
      fieldCatalogue(lookups.fields, lookups.tags, { engagementScores: lookups.engagementScores }),
    [lookups],
  );
  const root = asRootGroup(rule as CircleGroup | undefined);
  const errors = useMemo(() => validateRule(root, catalogue), [root, catalogue]);
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-[13px] font-semibold">{legend}</legend>
      <RuleEditor
        root={root}
        catalogue={catalogue}
        errors={errors}
        readOnly={readOnly}
        onChange={onChange}
      />
    </fieldset>
  );
}

const TRIGGER_DEFAULTS: Partial<Record<FlowTriggerType, Config>> = {
  member_joined: { includeImports: false },
  unengaged: { days: 60 },
};

const ROSTER_TRIGGERS = new Set<FlowTriggerType>(['roster_joined', 'roster_left']);

/** What "Add another start event" starts from: the first of these not in use yet. */
const NEW_START_EVENTS: FlowTriggerType[] = [
  'confirmed',
  'member_joined',
  'form_submitted',
  'referral_succeeded',
];

/** The first start event is the node's config; the others are in its alsoStartOn. */
function TriggerForm({ node, replace, lookups, readOnly }: FormProps) {
  const { alsoStartOn, ...first } = node.config;
  const events: Config[] = [
    first,
    ...(Array.isArray(alsoStartOn) ? (alsoStartOn as Config[]) : []),
  ];
  const save = (next: Config[]) => {
    const [head, ...rest] = next;
    replace({ ...head, ...(rest.length ? { alsoStartOn: rest } : {}) });
  };
  const add = () => {
    const used = new Set(events.map((e) => e.event));
    const event = NEW_START_EVENTS.find((e) => !used.has(e)) ?? 'confirmed';
    save([...events, { event, ...TRIGGER_DEFAULTS[event] }]);
  };
  const many = events.length > 1;
  return (
    <>
      {events.map((config, index) => {
        const form = (
          <StartEventForm
            config={config}
            lookups={lookups}
            readOnly={readOnly}
            onChange={(next) => save(events.map((e, i) => (i === index ? clean(next) : e)))}
          />
        );
        if (!many)
          return (
            <div key={index} className="grid gap-4">
              {form}
            </div>
          );
        return (
          <fieldset key={index} className="grid gap-4 border-t border-line pt-4">
            <legend className="text-[13px] font-semibold">Start event {index + 1}</legend>
            {form}
            {!readOnly && (
              <Button
                variant="quiet"
                size="sm"
                className="w-fit"
                aria-label={`Remove start event ${index + 1}`}
                onClick={() => save(events.filter((_, i) => i !== index))}
              >
                Remove this start event
              </Button>
            )}
          </fieldset>
        );
      })}
      {!readOnly && (
        <div className="grid gap-1.5 border-t border-line pt-4">
          <Button
            variant="ghost"
            size="sm"
            className="w-fit"
            disabled={events.length >= FLOW_MAX_TRIGGERS}
            onClick={add}
          >
            Add another start event
          </Button>
          <p className="text-[12.5px] text-sub">
            {events.length >= FLOW_MAX_TRIGGERS
              ? `An automation can have up to ${FLOW_MAX_TRIGGERS} start events.`
              : 'Each start event can have its own rule. Someone who matches two at once enters once.'}
          </p>
        </div>
      )}
    </>
  );
}

function StartEventForm({
  config: c,
  lookups,
  readOnly,
  onChange,
}: {
  config: Config;
  lookups: Lookups;
  readOnly: boolean;
  onChange: (config: Config) => void;
}) {
  const set = (patch: Config) => onChange({ ...c, ...patch });
  const replace = onChange;
  const event = str(c.event) as FlowTriggerType;
  const filterId = useId();
  const forms: [string, string][] = lookups.forms.map((f) => [f.id, f.name]);
  const dispatches: [string, string][] = lookups.dispatches.map((d) => [
    d.id,
    d.subject || 'Untitled post',
  ]);
  const ask = lookups.asks.find((a) => a.id === c.askId);
  return (
    <>
      <SelectField
        label="Starts when"
        value={event}
        onChange={(e) => {
          const next = e.target.value as FlowTriggerType;
          replace({
            event: next,
            ...TRIGGER_DEFAULTS[next],
            ...(c.filter ? { filter: c.filter } : {}),
          });
        }}
      >
        {FLOW_TRIGGER_TYPES.filter(
          // Roster triggers need the rosters flag; a saved one stays visible so it can be changed.
          (t) => lookups.rostersOn || !ROSTER_TRIGGERS.has(t) || t === event,
        ).map((t) => (
          <option key={t} value={t}>
            {TRIGGER_LABEL[t]}
          </option>
        ))}
      </SelectField>

      {(event === 'member_joined' || event === 'form_submitted' || event === 'confirmed') && (
        <Picker
          label="Signup form"
          value={str(c.formId)}
          options={forms}
          empty="Any form or source"
          onChange={(formId) => set({ formId: formId || undefined })}
        />
      )}
      {event === 'member_joined' && (
        <Check
          label="Include imported subscribers"
          hint="Off by default, so an import doesn't flood the automation."
          checked={c.includeImports === true}
          onChange={(includeImports) => set({ includeImports })}
        />
      )}
      {(event === 'circle_entered' || event === 'circle_exited') && (
        <Picker
          label="Segment"
          value={str(c.circleId)}
          options={lookups.circles.map((x) => [x.id, x.name])}
          empty="Choose a segment"
          onChange={(circleId) => set({ circleId: circleId || undefined })}
        />
      )}
      {(event === 'tag_added' || event === 'tag_removed') && (
        <Picker
          label="Tag"
          value={str(c.tagId)}
          options={lookups.tags.map((t) => [t.id, t.name])}
          empty="Choose a tag"
          onChange={(tagId) => set({ tagId: tagId || undefined })}
        />
      )}
      {ROSTER_TRIGGERS.has(event) && (
        <Picker
          label="Roster"
          value={str(c.rosterId)}
          options={lookups.rosters.map((r) => [r.id, r.name])}
          empty="Choose a Roster"
          onChange={(rosterId) => set({ rosterId: rosterId || undefined })}
        />
      )}
      {event === 'field_changed' && (
        <Picker
          label="Profile field"
          value={str(c.fieldId)}
          options={lookups.fields.map((f) => [f.id, f.label || f.key])}
          empty="Choose a field"
          onChange={(fieldId) => set({ fieldId: fieldId || undefined })}
        />
      )}
      {(event === 'level_purchased' || event === 'level_canceled') && (
        <Picker
          label="Paid plan"
          value={str(c.levelId)}
          options={lookups.levels.map((l) => [l.id, l.name])}
          empty="Any paid plan"
          onChange={(levelId) => set({ levelId: levelId || undefined })}
        />
      )}
      {event === 'ask_answered' && (
        <>
          <Picker
            label="Poll or survey"
            value={str(c.askId)}
            options={lookups.asks.map((a) => [a.id, a.title])}
            empty="Choose a poll or survey"
            onChange={(askId) => set({ askId: askId || undefined, optionId: undefined })}
          />
          {ask && (
            <Picker
              label="Answer"
              value={str(c.optionId)}
              options={ask.questions.flatMap((q) =>
                q.options.map((o) => [o.id, o.label] as [string, string]),
              )}
              empty="Any answer"
              onChange={(optionId) => set({ optionId: optionId || undefined })}
            />
          )}
        </>
      )}
      {event === 'unengaged' && (
        <TextField
          label="Days without an open or click"
          type="number"
          min={7}
          max={365}
          value={numText(c.days)}
          onChange={(e) => set({ days: int(e.target.value) })}
        />
      )}
      {(event === 'link_clicked' || event === 'gate_hit') && (
        <Picker
          label="Post"
          value={str(c.dispatchId)}
          options={dispatches}
          empty="Any post"
          onChange={(dispatchId) => set({ dispatchId: dispatchId || undefined })}
        />
      )}
      {event === 'link_clicked' && (
        <TextField
          label="Link URL"
          hint="Optional. Only this link, by its address or its short link; any link when empty."
          type="url"
          value={str(c.url)}
          onChange={(e) => set({ url: e.target.value.trim() || undefined })}
        />
      )}
      {event === 'referral_succeeded' && (
        <p className="text-[12.5px] text-sub">
          Starts for the subscriber who made the referral. A referral succeeds when the person they
          referred has confirmed and opened an email, or when a teammate approves it.
        </p>
      )}
      {event === 'referral_milestone' && (
        <Picker
          label="Milestone"
          value={str(c.milestoneId)}
          options={lookups.milestones.map((m) => [m.id, m.name])}
          empty="Any milestone"
          hint="Starts for the subscriber who reached it. Milestones are reached only while referrals are turned on."
          onChange={(milestoneId) => set({ milestoneId: milestoneId || undefined })}
        />
      )}
      {event === 'api_event' && (
        <TextField
          label="Event name"
          hint="Lowercase letters, digits, dots and underscores, such as course.completed."
          value={str(c.name)}
          onChange={(e) => set({ name: e.target.value.trim() || undefined })}
        />
      )}

      <div className="grid gap-3 border-t border-line pt-4">
        <Check
          id={filterId}
          label="Only subscribers who match a rule"
          checked={!!c.filter}
          onChange={(on) =>
            set({
              filter: on
                ? {
                    op: 'and',
                    children: [newCondition(fieldCatalogue(lookups.fields, lookups.tags), 'tag')],
                  }
                : undefined,
            })
          }
        />
        {!!c.filter && (
          <RuleField
            legend="Enrol subscribers who match"
            rule={c.filter}
            lookups={lookups}
            readOnly={readOnly}
            onChange={(filter) => set({ filter })}
          />
        )}
      </div>
    </>
  );
}

function Check({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id?: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const fallback = useId();
  const inputId = id ?? fallback;
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 accent-purple"
        aria-describedby={hint ? `${inputId}-hint` : undefined}
      />
      <div>
        <label htmlFor={inputId} className="text-[13.5px] font-semibold">
          {label}
        </label>
        {hint && (
          <p id={`${inputId}-hint`} className="text-[12.5px] text-sub">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

function Radios<T extends string>({
  legend,
  value,
  options,
  onChange,
}: {
  legend: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <fieldset>
      <legend className="mb-1.5 text-[13px] font-semibold">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {options.map(([v, label]) => (
          <label key={v} className="flex min-h-8 items-center gap-2 text-[13.5px]">
            <input
              type="radio"
              name={name}
              checked={value === v}
              onChange={() => onChange(v)}
              className="size-4 accent-purple"
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SendEmailForm({ flow, node, set, lookups, graph, readOnly, onBeforeLeave }: FormProps) {
  const create = useCreateFlowEmail(flow.id);
  const dispatchId = str(node.config.dispatchId);
  const usedElsewhere = new Set(
    graph.nodes
      .filter((n) => n.id !== node.id && n.type === 'send_email')
      .map((n) => str(n.config.dispatchId)),
  );
  return (
    <>
      <Picker
        label="Email"
        value={dispatchId}
        options={lookups.emails.map((e) => [
          e.dispatchId,
          `${e.subject || 'Untitled email'}${usedElsewhere.has(e.dispatchId) ? ' (used by another step)' : ''}`,
        ])}
        empty="Choose an email"
        onChange={(id) => set({ dispatchId: id || undefined })}
      />
      <div className="flex flex-wrap gap-2">
        {!readOnly && (
          <Button
            variant="ghost"
            size="sm"
            loading={create.isPending}
            onClick={() =>
              create.mutate({}, { onSuccess: (dispatch) => set({ dispatchId: dispatch.id }) })
            }
          >
            Write a new email
          </Button>
        )}
        {dispatchId && (
          <Link
            to="/dispatches/$dispatchId"
            params={{ dispatchId }}
            search={{ flow: flow.id }}
            onClick={onBeforeLeave}
            className="btn-ghost btn-sm"
          >
            {readOnly ? 'View email' : 'Edit email'}
          </Link>
        )}
      </div>
      {create.error && (
        <ErrorNotice title="The email was not created" message={create.error.message} />
      )}
      <Radios
        legend="Send to"
        value={(str(node.config.audience) || 'any') as 'any' | 'paid' | 'free'}
        options={[
          ['any', 'Every subscriber'],
          ['paid', 'Paying subscribers only'],
          ['free', 'Free subscribers only'],
        ]}
        onChange={(audience) => set({ audience })}
      />
      <Checkbox
        label="Send regardless of inbox rules"
        checked={
          typeof node.config.sendRegardless === 'boolean'
            ? node.config.sendRegardless
            : defaultSendRegardless(graph, node.id)
        }
        disabled={readOnly}
        hint="Inbox rules never hold this email, and it still counts toward the limit. Use it for welcome and confirmation emails. The first email starts out marked when confirming or joining is the only way into this automation."
        onChange={(sendRegardless) => set({ sendRegardless })}
      />
    </>
  );
}

const TIMEZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Europe/London', 'Europe/Prague', 'America/New_York', 'America/Los_Angeles'];
  }
})();

function DelayForm({ node, replace, set }: FormProps) {
  const c = node.config;
  const mode = c.mode === 'until' ? 'until' : 'duration';
  const weekdays = Array.isArray(c.weekdays) ? (c.weekdays as number[]) : [];
  return (
    <>
      <Radios
        legend="Wait"
        value={mode}
        options={[
          ['duration', 'For a while'],
          ['until', 'Until a day and time'],
        ]}
        onChange={(next) =>
          replace(
            next === 'duration'
              ? { mode: 'duration', amount: 1, unit: 'days' }
              : { mode: 'until', weekdays: [1], time: '09:00', timezone: 'member' },
          )
        }
      />
      {mode === 'duration' ? (
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Amount"
            type="number"
            min={1}
            value={numText(c.amount)}
            onChange={(e) => set({ amount: int(e.target.value) })}
          />
          <SelectField
            label="Unit"
            value={str(c.unit) || 'days'}
            onChange={(e) => set({ unit: e.target.value })}
          >
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
            <option value="days">Days</option>
          </SelectField>
        </div>
      ) : (
        <>
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-semibold">On</legend>
            <div className="flex flex-wrap gap-2">
              {WEEKDAY_SHORT.map((label, day) => (
                <label key={label} className="flex min-h-8 items-center gap-1.5 text-[13px]">
                  <input
                    type="checkbox"
                    className="size-4 accent-purple"
                    checked={weekdays.includes(day)}
                    onChange={(e) =>
                      set({
                        weekdays: e.target.checked
                          ? [...weekdays, day].sort()
                          : weekdays.filter((d) => d !== day),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <TextField
            label="At"
            type="time"
            value={str(c.time)}
            onChange={(e) => set({ time: e.target.value })}
          />
          <SelectField
            label="Timezone"
            value={str(c.timezone) || 'member'}
            onChange={(e) => set({ timezone: e.target.value })}
          >
            <option value="member">The subscriber’s timezone</option>
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </SelectField>
        </>
      )}
    </>
  );
}

function UpdateFieldForm({ node, set, lookups }: FormProps) {
  const field = lookups.fields.find((f) => f.id === node.config.fieldId);
  return (
    <>
      <Picker
        label="Profile field"
        value={str(node.config.fieldId)}
        options={lookups.fields.map((f) => [f.id, f.label || f.key])}
        empty="Choose a field"
        onChange={(fieldId) => set({ fieldId: fieldId || undefined, value: undefined })}
      />
      {field && (
        <FieldInput
          field={{ ...field, label: 'New value' }}
          value={toDraft(field.type, node.config.value as Parameters<typeof toDraft>[1])}
          onChange={(draft) => set({ value: fromDraft(field.type, draft) })}
        />
      )}
    </>
  );
}

function ChangeLevelForm({ node, set, replace, lookups }: FormProps) {
  const c = node.config;
  const action = c.action === 'revoke' ? 'revoke' : 'grant';
  return (
    <>
      <Radios
        legend="Change"
        value={action}
        options={[
          ['grant', 'Grant complimentary access'],
          ['revoke', 'Revoke access this automation granted'],
        ]}
        onChange={(next) =>
          replace(
            next === 'grant'
              ? { action: 'grant', levelId: c.levelId, days: null }
              : { action: 'revoke', levelId: c.levelId },
          )
        }
      />
      <Picker
        label="Paid plan"
        value={str(c.levelId)}
        options={lookups.levels.map((l) => [l.id, l.name])}
        empty="Choose a plan"
        onChange={(levelId) => set({ levelId: levelId || undefined })}
      />
      {action === 'grant' && (
        <TextField
          label="For how many days"
          hint="Leave empty for no end date."
          type="number"
          min={1}
          max={3650}
          value={numText(c.days)}
          onChange={(e) => set({ days: int(e.target.value) ?? null })}
        />
      )}
    </>
  );
}

function BranchForm({ node, set, lookups, readOnly }: FormProps) {
  return (
    <RuleField
      legend="Go down “Yes” when the subscriber matches"
      rule={node.config.condition}
      lookups={lookups}
      readOnly={readOnly}
      onChange={(condition) => set({ condition })}
    />
  );
}

function SplitForm({ node, set }: FormProps) {
  const c = node.config;
  const promote = (c.autoPromote ?? null) as Config | null;
  const a = typeof c.percentA === 'number' ? c.percentA : undefined;
  return (
    <>
      <TextField
        label="Share down path A (%)"
        hint={a ? `${100 - a}% go down path B.` : 'Between 1 and 99.'}
        type="number"
        min={1}
        max={99}
        value={numText(c.percentA)}
        onChange={(e) => set({ percentA: int(e.target.value) })}
      />
      <Check
        label="Pick a winner automatically"
        hint="Compares the emails right after A and B, then sends everyone down the better path."
        checked={!!promote}
        onChange={(on) =>
          set({
            autoPromote: on ? { metric: 'opens', minPerVariant: 100, afterHours: 24 } : undefined,
          })
        }
      />
      {promote && (
        <div className="grid gap-3 sm:grid-cols-3">
          <SelectField
            label="Winner by"
            value={str(promote.metric) || 'opens'}
            onChange={(e) => set({ autoPromote: { ...promote, metric: e.target.value } })}
          >
            <option value="opens">Opens</option>
            <option value="clicks">Clicks</option>
          </SelectField>
          <TextField
            label="Emails per path"
            type="number"
            min={1}
            value={numText(promote.minPerVariant)}
            onChange={(e) =>
              set({ autoPromote: clean({ ...promote, minPerVariant: int(e.target.value) }) })
            }
          />
          <TextField
            label="After hours"
            type="number"
            min={1}
            max={720}
            value={numText(promote.afterHours)}
            onChange={(e) =>
              set({ autoPromote: clean({ ...promote, afterHours: int(e.target.value) }) })
            }
          />
        </div>
      )}
    </>
  );
}

function WaitForm({ node, set, graph }: FormProps) {
  const c = node.config;
  const sends = graph.nodes.filter((n) => n.type === 'send_email');
  return (
    <>
      <Radios
        legend="Wait for"
        value={c.event === 'click' ? 'click' : 'open'}
        options={[
          ['open', 'An open'],
          ['click', 'A click'],
        ]}
        onChange={(event) => set({ event, ...(event === 'open' ? { url: undefined } : {}) })}
      />
      <Picker
        label="Of the email"
        value={str(c.sendNodeId)}
        options={sends.map((n) => [n.id, `${n.name || 'Send email'} (${n.id})`])}
        empty="The most recent one sent"
        onChange={(sendNodeId) => set({ sendNodeId: sendNodeId || undefined })}
      />
      {c.event === 'click' && (
        <TextField
          label="Link URL"
          hint="Optional. This link, by its address or its short link; any link when empty."
          type="url"
          value={str(c.url)}
          onChange={(e) => set({ url: e.target.value.trim() || undefined })}
        />
      )}
      <TextField
        label="Give up after (hours)"
        hint="Then the run takes the “Timed out” path."
        type="number"
        min={1}
        value={numText(c.timeoutHours)}
        onChange={(e) => set({ timeoutHours: int(e.target.value) })}
      />
    </>
  );
}

function WebhookForm({ flow, node, set, canAdmin, readOnly }: FormProps) {
  const rotate = useRotateWebhookSecret(flow);
  const [secret, setSecret] = useState<string | null>(null);
  return (
    <>
      <TextField
        label="URL"
        hint="https only. Requests are signed with the Swarm-Signature header."
        type="url"
        placeholder="https://"
        value={str(node.config.url)}
        onChange={(e) => set({ url: e.target.value.trim() || undefined })}
      />
      <Check
        label="Include profile fields"
        checked={node.config.includeFields === true}
        onChange={(includeFields) => set({ includeFields })}
      />
      <div className="grid gap-2 rounded-card-app bg-surface-alt p-3 text-[13px]">
        <p className="font-semibold">Signing secret</p>
        <p className="text-sub">
          {flow.webhookSecretSet
            ? 'A secret is set. Rotating it replaces it straight away.'
            : 'No secret yet. Webhook steps need one to sign their requests.'}
        </p>
        {secret && (
          <TextField
            label="New secret (shown once)"
            readOnly
            value={secret}
            onFocus={(e) => e.target.select()}
            hint="Copy it now. It will not be shown again."
          />
        )}
        {canAdmin && !readOnly ? (
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-start"
            loading={rotate.isPending}
            onClick={() => rotate.mutate(undefined, { onSuccess: (r) => setSecret(r.secret) })}
          >
            {flow.webhookSecretSet ? 'Rotate secret' : 'Create secret'}
          </Button>
        ) : (
          !canAdmin && <p className="text-sub">An admin can create or rotate the secret.</p>
        )}
        {rotate.error && <ErrorNotice message={rotate.error.message} />}
      </div>
    </>
  );
}

function NotifyForm({ node, set, lookups }: FormProps) {
  const chosen = Array.isArray(node.config.operatorIds)
    ? (node.config.operatorIds as string[])
    : [];
  return (
    <>
      <TextAreaField
        label="Message"
        maxLength={500}
        rows={3}
        value={str(node.config.message)}
        onChange={(e) => set({ message: e.target.value })}
      />
      {lookups.seats.length > 0 && (
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-semibold">Who gets it</legend>
          <p className="mb-2 text-[12.5px] text-sub">
            The publication’s owners and admins when nobody is chosen.
          </p>
          <div className="grid gap-1.5">
            {lookups.seats.map((seat) => (
              <label key={seat.id} className="flex min-h-8 items-center gap-2 text-[13.5px]">
                <input
                  type="checkbox"
                  className="size-4 accent-purple"
                  checked={chosen.includes(seat.operator.id)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...chosen, seat.operator.id]
                      : chosen.filter((id) => id !== seat.operator.id);
                    set({ operatorIds: next.length ? next : undefined });
                  }}
                />
                {seat.operator.name ?? seat.operator.email}
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </>
  );
}

// ---- Flow settings (nothing selected) --------------------------------------------------------

function FlowSettings({
  flow,
  readOnly,
  headingRef,
}: StepProps & { headingRef: RefObject<HTMLHeadingElement | null> }) {
  const update = useUpdateFlow(flow.id);
  const [name, setName] = useState(flow.name);
  const [description, setDescription] = useState(flow.description ?? '');
  const [reentry, setReentry] = useState(flow.reentry);
  const [saved, setSaved] = useState(false);
  const dirty =
    name !== flow.name || description !== (flow.description ?? '') || reentry !== flow.reentry;
  const error = update.error instanceof ApiError ? update.error : null;
  return (
    <section
      aria-labelledby="flow-inspector-title"
      id="flow-inspector"
      className="card-app grid content-start gap-4 p-5"
    >
      <div>
        <h2
          id="flow-inspector-title"
          ref={headingRef}
          tabIndex={-1}
          className="text-[16px] font-semibold tracking-[-0.02em] outline-none"
        >
          Automation settings
        </h2>
        <p className="text-[12.5px] text-sub">Select a step on the canvas to set it up.</p>
      </div>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          update.mutate(
            { name: name.trim(), description: description.trim() || null, reentry },
            { onSuccess: () => setSaved(true) },
          );
        }}
      >
        <fieldset disabled={readOnly} className="grid gap-4">
          <legend className="sr-only">Automation settings</legend>
          <TextField
            label="Name"
            required
            maxLength={80}
            value={name}
            error={error?.field('name')}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
          />
          <TextAreaField
            label="Description"
            rows={2}
            maxLength={280}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setSaved(false);
            }}
          />
          <SelectField
            label="Can a subscriber go through it again?"
            value={reentry}
            hint={
              reentry === 'after_exit'
                ? `Up to ${FLOW_REENTRY_MAX_PER_HOUR} times an hour for each subscriber.`
                : undefined
            }
            onChange={(e) => {
              setReentry(e.target.value as typeof reentry);
              setSaved(false);
            }}
          >
            <option value="never">No, once only</option>
            <option value="after_exit">Yes, after their last run ended</option>
          </SelectField>
          {!readOnly && (
            <div className="flex items-center gap-3">
              <Button
                type="submit"
                size="sm"
                disabled={!dirty || !name.trim()}
                loading={update.isPending}
              >
                Save settings
              </Button>
              {saved && !dirty && (
                <span role="status" className="text-[13px] text-success">
                  Saved
                </span>
              )}
            </div>
          )}
          {update.error && (
            <ErrorNotice title="Settings not saved" message={update.error.message} />
          )}
        </fieldset>
      </form>
    </section>
  );
}
