// The Capture Form builder's settings panel. Controlled: it edits a config and reports issues
// from validateConfig() next to the control they belong to.
import type { Channel, FormField, MemberField } from '@swarm/domain';
import { Button, SelectField, TextAreaField, TextField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';
import { useChannelFlag } from '../api/queries';
import { rostersQuery } from '../api/rosters';
import {
  LAYOUTS,
  MAX_FIELDS,
  PLACEMENTS,
  STANDARD_FIELDS,
  SUCCESS_MAX,
  SWARM_INDIGO,
  TRIGGERS,
  addableProfileFields,
  issueAt,
  moveField,
  newField,
  normaliseOrigin,
  profileKey,
  triggerOfType,
  type Config,
  type Issue,
  type TriggerType,
} from '../capture/config';

interface SettingsProps {
  config: Config;
  onChange: (update: (config: Config) => Config) => void;
  issues: readonly Issue[];
  defs: readonly MemberField[];
  channel: Channel;
  readOnly: boolean;
}

const TYPE_LABEL: Record<MemberField['type'], string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  boolean: 'Yes or no',
  select: 'Single choice',
  multi_select: 'Multiple choice',
};

export function FormSettings(props: SettingsProps) {
  return (
    <fieldset disabled={props.readOnly} className="m-0 grid min-w-0 gap-4 border-0 p-0">
      <legend className="sr-only">Form settings</legend>
      <FieldsPanel {...props} />
      <LayoutPanel {...props} />
      <TriggerPanel {...props} />
      <SuccessPanel {...props} />
      <OptInPanel {...props} />
      <RostersPanel {...props} />
      <ThemePanel {...props} />
      <OriginsPanel {...props} />
      <CopyPanel {...props} />
    </fieldset>
  );
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="card-app grid gap-4 p-5">
      <div>
        <h2 id={id} className="text-[15px] font-semibold tracking-[-0.01em]">
          {title}
        </h2>
        {description && <p className="mt-1 text-[13px] leading-[1.5] text-sub">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** A radio group with a visible legend, one option per line with an optional hint. */
function Choice<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  srOnlyLegend = false,
}: {
  legend: string;
  name: string;
  value: T;
  options: { value: T; label: ReactNode; hint?: string }[];
  onChange: (value: T) => void;
  srOnlyLegend?: boolean;
}) {
  const id = useId();
  return (
    <fieldset className="m-0 grid gap-1.5 border-0 p-0">
      <legend className={srOnlyLegend ? 'sr-only' : 'mb-1.5 p-0 text-[13px] font-semibold'}>
        {legend}
      </legend>
      {options.map((option) => (
        <label
          key={option.value}
          className="flex min-h-10 cursor-pointer items-start gap-2.5 rounded-control border border-line-control px-3 py-2.5 text-[13.5px] has-checked:border-purple has-checked:bg-lavender/60 has-focus-visible:outline-2 has-focus-visible:outline-purple"
        >
          <input
            type="radio"
            name={`${name}-${id}`}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="mt-0.5 accent-purple"
          />
          <span className="min-w-0">
            <span className="block font-semibold">{option.label}</span>
            {option.hint && <span className="block text-[12.5px] text-sub">{option.hint}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function Check({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-[13.5px]">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 size-4 accent-purple"
      />
      <span>
        <span className="font-semibold">{label}</span>
        {hint && <span className="block text-[12.5px] text-sub">{hint}</span>}
      </span>
    </label>
  );
}

/** A number for inputs: empty while the operator clears the box, so validation can explain. */
const numberValue = (value: number) => (Number.isFinite(value) ? value : '');

// ---------------------------------------------------------------------------------------------
// Fields

function FieldsPanel({ config, onChange, issues, defs }: SettingsProps) {
  const [adding, setAdding] = useState('');
  const defsByKey = new Map(defs.map((d) => [d.key, d]));
  const used = new Set(config.fields.map((f) => f.key));
  const standard = STANDARD_FIELDS.filter((f) => !used.has(f.key));
  const profile = addableProfileFields(config, defs);
  const full = config.fields.length >= MAX_FIELDS;

  const setFields = (fields: FormField[]) => onChange((c) => ({ ...c, fields }));
  const update = (index: number, patch: Partial<FormField>) =>
    onChange((c) => ({
      ...c,
      fields: c.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    }));

  const add = () => {
    if (!adding) return;
    const std = STANDARD_FIELDS.find((f) => f.key === adding);
    const def = defs.find((d) => profileKey(d) === adding);
    if (std) setFields([...config.fields, newField(std.key, std.label)]);
    else if (def) setFields([...config.fields, newField(profileKey(def), def.label, def)]);
    setAdding('');
  };

  const consent = config.consent;
  return (
    <Panel
      title="Fields"
      description="Email is always asked for. Add a name or any profile field of this publication."
    >
      {issueAt(issues, 'fields') && (
        <p role="alert" className="text-[12.5px] font-semibold text-danger">
          {issueAt(issues, 'fields')}
        </p>
      )}
      <ol className="grid gap-3">
        {config.fields.map((field, index) => {
          const def = field.key.startsWith('field:')
            ? defsByKey.get(field.key.slice('field:'.length))
            : undefined;
          return (
            <li key={field.key} className="rounded-card-app border border-line-app p-3.5">
              <FieldRow
                field={field}
                def={def}
                index={index}
                count={config.fields.length}
                issues={issues}
                onUpdate={(patch) => update(index, patch)}
                onMove={(delta) => setFields(moveField(config.fields, index, delta))}
                onRemove={() => setFields(config.fields.filter((_, i) => i !== index))}
              />
            </li>
          );
        })}
      </ol>
      {(standard.length > 0 || profile.length > 0) && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[200px] flex-1">
            <SelectField
              label="Add a field"
              value={adding}
              disabled={full}
              hint={full ? `A form can have up to ${MAX_FIELDS} fields.` : undefined}
              onChange={(e) => setAdding(e.target.value)}
              options={[
                { value: '', label: 'Choose a field' },
                ...standard.map((f) => ({ value: f.key, label: f.label })),
                ...profile.map((d) => ({
                  value: profileKey(d),
                  label: `${d.label} (${TYPE_LABEL[d.type].toLowerCase()})`,
                })),
              ]}
            />
          </div>
          <Button variant="ghost" onClick={add} disabled={!adding || full} className="mb-0.5">
            Add field
          </Button>
        </div>
      )}
      {defs.length === 0 && (
        <p className="text-[12.5px] text-sub">
          This publication has no profile fields yet. Create them under Subscribers, Fields and
          tags, to ask for more than a name.
        </p>
      )}

      <div className="grid gap-3 border-t border-line pt-4">
        <Check
          label="Ask for consent"
          hint="A checkbox under the fields, such as agreeing to your privacy policy."
          checked={!!consent}
          onChange={(on) =>
            onChange((c) => ({
              ...c,
              consent: on
                ? { text: 'I agree to receive emails from this publication.', required: true }
                : null,
            }))
          }
        />
        {consent && (
          <>
            <TextAreaField
              label="Consent text"
              maxLength={1000}
              hint={
                'You can use <a href="…">, <b>, <strong>, <i>, <em> and <br>. Links open in a new window, for example: I agree to the <a href="https://example.com/privacy">privacy policy</a>.'
              }
              value={consent.text}
              onChange={(e) =>
                onChange((c) => ({
                  ...c,
                  consent: { text: e.target.value, required: consent.required },
                }))
              }
              error={issueAt(issues, 'consent.text')}
            />
            <Check
              label="Required to join"
              checked={consent.required}
              onChange={(required) =>
                onChange((c) => ({ ...c, consent: { text: consent.text, required } }))
              }
            />
          </>
        )}
      </div>
    </Panel>
  );
}

function FieldRow({
  field,
  def,
  index,
  count,
  issues,
  onUpdate,
  onMove,
  onRemove,
}: {
  field: FormField;
  def: MemberField | undefined;
  index: number;
  count: number;
  issues: readonly Issue[];
  onUpdate: (patch: Partial<FormField>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const email = field.key === 'email';
  const missing = field.key.startsWith('field:') && !def;
  const kind = email
    ? 'Email, always required'
    : def
      ? `Profile field · ${TYPE_LABEL[def.type]}`
      : missing
        ? 'This profile field no longer exists. Remove it to publish.'
        : 'Name';
  const takesPlaceholder = !def || def.type === 'text' || def.type === 'number';
  const name = field.label || field.key;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={`text-[12.5px] ${missing ? 'font-semibold text-danger' : 'text-sub'}`}>
          {kind}
        </p>
        <div className="flex gap-1">
          <Button
            variant="quiet"
            size="sm"
            aria-label={`Move ${name} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            ↑
          </Button>
          <Button
            variant="quiet"
            size="sm"
            aria-label={`Move ${name} down`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </Button>
          {!email && (
            <Button variant="quiet" size="sm" aria-label={`Remove ${name}`} onClick={onRemove}>
              Remove
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Label"
          maxLength={80}
          value={field.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
          error={issueAt(issues, `fields.${index}.label`)}
        />
        {takesPlaceholder && (
          <TextField
            label="Placeholder"
            maxLength={80}
            value={field.placeholder ?? ''}
            onChange={(e) => onUpdate({ placeholder: e.target.value })}
            error={issueAt(issues, `fields.${index}.placeholder`)}
          />
        )}
      </div>
      {def?.type === 'select' && (
        <Choice
          legend="Show the options as"
          name={`display-${field.key}`}
          value={field.display ?? 'dropdown'}
          onChange={(display) => onUpdate({ display })}
          options={[
            { value: 'dropdown', label: 'A dropdown' },
            { value: 'radio', label: 'Radio buttons', hint: 'Every option visible at once.' },
          ]}
        />
      )}
      {def?.type === 'multi_select' && (
        <p className="text-[12.5px] text-sub">Shown as checkboxes: {def.options.join(', ')}.</p>
      )}
      {!email && def?.type !== 'multi_select' && (
        <Check
          label="Required"
          checked={field.required}
          onChange={(required) => onUpdate({ required })}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Layout, placement

function LayoutPanel({ config, onChange }: SettingsProps) {
  return (
    <Panel title="Layout and placement">
      <Choice
        legend="Layout"
        name="layout"
        value={config.layout}
        onChange={(layout) => onChange((c) => ({ ...c, layout }))}
        options={LAYOUTS}
      />
      <Choice
        legend="Placement"
        name="placement"
        value={config.placement}
        onChange={(placement) => onChange((c) => ({ ...c, placement }))}
        options={PLACEMENTS}
      />
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Trigger and frequency

function TriggerPanel({ config, onChange, issues }: SettingsProps) {
  const t = config.trigger;
  const setTrigger = (trigger: Config['trigger']) => onChange((c) => ({ ...c, trigger }));
  const f = config.frequency;
  return (
    <Panel
      title="When it shows"
      description="Try each trigger with the simulator under the preview."
    >
      <SelectField
        label="Trigger"
        value={t.type}
        onChange={(e) => setTrigger(triggerOfType(e.target.value as TriggerType, t))}
        options={TRIGGERS}
      />
      {t.type === 'delay' && (
        <TextField
          label="Seconds on the page"
          type="number"
          inputMode="numeric"
          min={1}
          max={600}
          step={1}
          value={numberValue(t.seconds)}
          onChange={(e) => setTrigger({ type: 'delay', seconds: e.target.valueAsNumber })}
          error={issueAt(issues, 'trigger.seconds')}
        />
      )}
      {t.type === 'scroll' && (
        <TextField
          label="Share of the page scrolled, in %"
          type="number"
          inputMode="numeric"
          min={1}
          max={100}
          step={1}
          value={numberValue(t.percent)}
          onChange={(e) => setTrigger({ type: 'scroll', percent: e.target.valueAsNumber })}
          error={issueAt(issues, 'trigger.percent')}
        />
      )}
      {(t.type === 'element_visible' || t.type === 'click') && (
        <TextField
          label="CSS selector"
          hint={
            t.type === 'click'
              ? 'Clicking any element that matches shows the form, for example .open-form.'
              : 'The form shows when the first match scrolls into view, for example #comments.'
          }
          maxLength={200}
          spellCheck={false}
          className="font-mono"
          value={t.selector}
          onChange={(e) => setTrigger({ type: t.type, selector: e.target.value })}
          error={issueAt(issues, 'trigger.selector')}
        />
      )}
      {t.type === 'event' && (
        <TextField
          label="Event name"
          hint={`Your site fires it with window.dispatchEvent(new Event('${t.name || 'swarm:open'}')).`}
          maxLength={60}
          spellCheck={false}
          className="font-mono"
          value={t.name}
          onChange={(e) => setTrigger({ type: 'event', name: e.target.value })}
          error={issueAt(issues, 'trigger.name')}
        />
      )}
      {t.type === 'exit_intent' && (
        <p className="text-[12.5px] text-sub">
          Fires when the pointer leaves the top of the window. Touch screens have no pointer, so
          pair it with the scroll-back trigger on a second form for phones.
        </p>
      )}
      {t.type === 'scroll_velocity' && (
        <p className="text-[12.5px] text-sub">
          Predicts a leave: the reader has read at least a third of the page, then scrolls back up
          quickly. Works best on touch screens.
        </p>
      )}

      <Choice
        legend="How often"
        name="frequency"
        value={f.type}
        onChange={(type) =>
          onChange((c) => ({
            ...c,
            frequency: type === 'every_visit' ? { type } : { type, days: 7 },
          }))
        }
        options={[
          { value: 'every_visit', label: 'Every visit' },
          {
            value: 'once_per_days',
            label: 'Once every few days',
            hint: 'Remembered in the visitor’s browser.',
          },
        ]}
      />
      {f.type === 'once_per_days' && (
        <TextField
          label="Days between showings"
          type="number"
          inputMode="numeric"
          min={1}
          max={365}
          step={1}
          value={numberValue(f.days)}
          onChange={(e) =>
            onChange((c) => ({
              ...c,
              frequency: { type: 'once_per_days', days: e.target.valueAsNumber },
            }))
          }
          error={issueAt(issues, 'frequency.days')}
        />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Success

function SuccessPanel({ config, onChange, issues }: SettingsProps) {
  const s = config.success;
  const length = s.type === 'message' ? s.message.trim().length : 0;
  const left = SUCCESS_MAX - length;
  return (
    <Panel title="After someone joins">
      <Choice
        legend="Then"
        srOnlyLegend
        name="success"
        value={s.type}
        onChange={(type) =>
          onChange((c) => ({
            ...c,
            success:
              type === 'message'
                ? { type, message: 'Check your inbox to confirm.' }
                : { type, url: 'https://' },
          }))
        }
        options={[
          { value: 'message', label: 'Show a message' },
          { value: 'redirect', label: 'Send them to a page on your site' },
        ]}
      />
      {s.type === 'message' ? (
        <div className="grid gap-1">
          <TextField
            label="Message"
            maxLength={SUCCESS_MAX + 20}
            value={s.message}
            hint={`${length} of ${SUCCESS_MAX} characters`}
            onChange={(e) =>
              onChange((c) => ({ ...c, success: { type: 'message', message: e.target.value } }))
            }
            error={issueAt(issues, 'success.message')}
          />
          {/* Announced only near the limit, so typing isn't read out on every key. */}
          <p aria-live="polite" className="sr-only">
            {left <= 10 ? (left >= 0 ? `${left} characters left` : `${-left} characters over`) : ''}
          </p>
        </div>
      ) : (
        <TextField
          label="Page address"
          type="url"
          inputMode="url"
          spellCheck={false}
          maxLength={2048}
          value={s.url}
          hint="Must start with https://. The page receives a signed subscriber reference, never the email address."
          onChange={(e) =>
            onChange((c) => ({ ...c, success: { type: 'redirect', url: e.target.value } }))
          }
          error={issueAt(issues, 'success.url')}
        />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Double opt-in

function OptInPanel({ config, onChange, channel }: SettingsProps) {
  const value = config.doubleOptIn === null ? 'default' : config.doubleOptIn ? 'on' : 'off';
  if (channel.requireConfirmation) {
    return (
      <Panel
        title="Double opt-in"
        description={
          <>
            This publication requires every subscriber to confirm, so this form does too. Change it
            in{' '}
            <Link
              to="/channels/$channelId"
              params={{ channelId: channel.id }}
              className="text-purple-deep"
            >
              Publication settings
            </Link>
            .
          </>
        }
      />
    );
  }
  return (
    <Panel
      title="Double opt-in"
      description={
        <>
          With double opt-in, people confirm by email before they become active subscribers. Change
          the publication default in{' '}
          <Link
            to="/channels/$channelId"
            params={{ channelId: channel.id }}
            className="text-purple-deep"
          >
            Publication settings
          </Link>
          .
        </>
      }
    >
      <Choice
        legend="Double opt-in for this form"
        srOnlyLegend
        name="double-opt-in"
        value={value}
        onChange={(next) =>
          onChange((c) => ({
            ...c,
            doubleOptIn: next === 'default' ? null : next === 'on',
          }))
        }
        options={[
          {
            value: 'default',
            label: `Publication default (currently ${channel.doubleOptIn ? 'on' : 'off'})`,
            hint: 'Follows the publication setting, also when it changes later.',
          },
          { value: 'on', label: 'On', hint: 'Always ask people to confirm by email.' },
          {
            value: 'off',
            label: 'Off',
            hint: 'People become active subscribers as soon as they join.',
          },
        ]}
      />
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Rosters (flag rosters)

function RostersPanel({ config, onChange, channel, issues }: SettingsProps) {
  const flag = useChannelFlag(channel.id, 'rosters');
  const rosters = useQuery(rostersQuery(channel.id, flag === true));
  const chosen = config.rosterIds ?? [];
  if (flag !== true && !chosen.length) return null;
  const list = rosters.data ?? [];
  const known = new Set(list.map((r) => r.id));
  const toggle = (id: string, on: boolean) =>
    onChange((c) => {
      const next = on ? [...(c.rosterIds ?? []), id] : (c.rosterIds ?? []).filter((r) => r !== id);
      const { rosterIds: _old, ...rest } = c;
      return next.length ? { ...rest, rosterIds: next } : rest;
    });
  return (
    <Panel
      title="Rosters"
      description="People who join through this form are added to these Rosters, once they confirm when double opt-in is on. Existing subscribers choose theirs in the Subscriber settings."
    >
      {flag === false && (
        <p className="text-[13px] font-semibold text-danger">
          Rosters are off for this publication. Untick them to publish this form.
        </p>
      )}
      {rosters.data && list.length === 0 && (
        <p className="text-[13px] text-sub">
          No Rosters yet.{' '}
          <Link to="/rosters" search={{ channel: channel.id }} className="text-purple-deep">
            Create a Roster
          </Link>
          .
        </p>
      )}
      <div className="grid gap-2">
        {list.map((roster) => (
          <Check
            key={roster.id}
            label={roster.name}
            checked={chosen.includes(roster.id)}
            onChange={(on) => toggle(roster.id, on)}
            {...(roster.description ? { hint: roster.description } : {})}
          />
        ))}
        {chosen
          .filter((id) => !known.has(id))
          .map((id) => (
            <Check key={id} label="A deleted Roster" checked onChange={() => toggle(id, false)} />
          ))}
      </div>
      {issueAt(issues, 'rosterIds') && (
        <p role="alert" className="text-[12.5px] font-semibold text-danger">
          {issueAt(issues, 'rosterIds')}
        </p>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Theme

function ThemePanel({ config, onChange, issues, channel }: SettingsProps) {
  const channelAccent = channel.branding.accentColor;
  const own = config.theme.accentColor;
  const colourId = useId();
  return (
    <Panel title="Look">
      <Check
        label={`Use the publication’s accent colour (${channelAccent ?? SWARM_INDIGO})`}
        checked={own === null}
        onChange={(useChannel) =>
          onChange((c) => ({
            ...c,
            theme: { ...c.theme, accentColor: useChannel ? null : (channelAccent ?? SWARM_INDIGO) },
          }))
        }
      />
      {own !== null && (
        <div className="grid gap-1.5">
          <label htmlFor={colourId} className="text-[13px] font-semibold">
            Accent colour
          </label>
          <div className="flex items-center gap-3">
            <input
              id={colourId}
              type="color"
              value={own}
              onChange={(e) =>
                onChange((c) => ({ ...c, theme: { ...c.theme, accentColor: e.target.value } }))
              }
              className="h-11 w-14 cursor-pointer rounded-control border border-line-control bg-surface p-1"
            />
            <span className="font-mono text-[13px] text-sub">{own}</span>
          </div>
          {issueAt(issues, 'theme.accentColor') && (
            <p role="alert" className="text-[12.5px] font-semibold text-danger">
              {issueAt(issues, 'theme.accentColor')}
            </p>
          )}
        </div>
      )}
      <SelectField
        label="Colour scheme"
        value={config.theme.mode}
        onChange={(e) =>
          onChange((c) => ({
            ...c,
            theme: { ...c.theme, mode: e.target.value as Config['theme']['mode'] },
          }))
        }
        options={[
          { value: 'auto', label: 'Match the visitor’s device' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
      />
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Allowed origins

function OriginsPanel({ config, onChange, issues }: SettingsProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const list = config.allowedOrigins;

  const add = () => {
    const origin = normaliseOrigin(draft);
    if (!origin) {
      setError('Use a site origin such as https://example.com.');
      return;
    }
    if (list.includes(origin)) {
      setError(`${origin} is already on the list.`);
      return;
    }
    if (list.length >= 20) {
      setError('List at most 20 sites.');
      return;
    }
    onChange((c) => ({ ...c, allowedOrigins: [...c.allowedOrigins, origin] }));
    setDraft('');
    setError(undefined);
  };

  return (
    <Panel
      title="Allowed sites"
      description="Browsers load the form only on these sites, so nobody can show it inside their own page. It doesn't prove where a sign-up came from: a script can claim any site, so use double opt-in when the source matters. With the list empty, any site can show the form; the form always says which publication the reader is joining."
    >
      {list.length > 0 ? (
        <ul className="grid gap-1.5">
          {list.map((origin, index) => (
            <li
              key={origin}
              className="flex items-center justify-between gap-2 rounded-control border border-line-app px-3 py-1.5"
            >
              <span className="min-w-0 truncate font-mono text-[13px]">{origin}</span>
              {issueAt(issues, `allowedOrigins.${index}`) && (
                <span className="text-[12px] font-semibold text-danger">
                  {issueAt(issues, `allowedOrigins.${index}`)}
                </span>
              )}
              <Button
                variant="quiet"
                size="sm"
                aria-label={`Remove ${origin}`}
                onClick={() =>
                  onChange((c) => ({
                    ...c,
                    allowedOrigins: c.allowedOrigins.filter((o) => o !== origin),
                  }))
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-control bg-surface-alt px-3 py-2 text-[13px] text-sub">
          Any site can embed this form, inside wording of its own. Add your sites to stop that.
        </p>
      )}
      <form
        className="flex flex-wrap items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <div className="min-w-[220px] flex-1">
          <TextField
            label="Add a site"
            type="url"
            inputMode="url"
            spellCheck={false}
            placeholder="https://example.com"
            value={draft}
            hint="https:// addresses only; http://localhost works for testing."
            onChange={(e) => {
              setDraft(e.target.value);
              setError(undefined);
            }}
            error={error ?? issueAt(issues, 'allowedOrigins')}
          />
        </div>
        <Button type="submit" variant="ghost" className="mt-[26px]">
          Add site
        </Button>
      </form>
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Copy

function CopyPanel({ config, onChange, issues }: SettingsProps) {
  const set = (patch: Partial<Config['copy']>) =>
    onChange((c) => ({ ...c, copy: { ...c.copy, ...patch } }));
  const slim = config.layout === 'slim';
  return (
    <Panel
      title="Text"
      description={slim ? 'Slim forms show only the fields and the button.' : undefined}
    >
      <TextField
        label="Heading"
        maxLength={120}
        value={config.copy.heading}
        hint="Also names the form for screen readers on your site."
        onChange={(e) => set({ heading: e.target.value })}
        error={issueAt(issues, 'copy.heading')}
      />
      <TextAreaField
        label="Text under the heading"
        maxLength={300}
        value={config.copy.body}
        onChange={(e) => set({ body: e.target.value })}
        error={issueAt(issues, 'copy.body')}
      />
      <TextField
        label="Button"
        maxLength={40}
        value={config.copy.button}
        onChange={(e) => set({ button: e.target.value })}
        error={issueAt(issues, 'copy.button')}
      />
    </Panel>
  );
}
