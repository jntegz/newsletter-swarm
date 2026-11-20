// Settings → Instance: how much the email service lets this Swarm send, and what has been counted
// so far (docs/self-hosting.md "Sending limits"). The page shows it to instance admins only.
import type { InstanceSendingLimits, SendingWindowUsage } from '@swarm/domain';
import {
  Button,
  ErrorNotice,
  LoadingRows,
  Progress,
  SelectField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { instanceMailQuery, sendingLimitsQuery, useSaveSendingLimits } from '../api/instance';
import {
  LIMIT_FIELDS,
  continuesAt,
  presetsFor,
  readDraft,
  toDraft,
  usageLine,
  type LimitDraft,
  type LimitField,
} from '../send/sending-limits';
import { formatDateTime, numberFormat } from './common';

const WINDOWS = [
  { key: 'hour', label: 'This hour' },
  { key: 'day', label: 'Today' },
  { key: 'month', label: 'This month' },
] as const;

function Meter({ label, window }: { label: string; window: SendingWindowUsage }) {
  if (window.limit === null) {
    return (
      <div className="grid gap-1 text-[13px]">
        <span className="font-semibold">{label}</span>
        <span className="tabular text-[12px] text-sub">{usageLine(window)}</span>
      </div>
    );
  }
  return (
    <Progress
      label={label}
      value={window.used}
      max={window.limit}
      valueText={`${numberFormat.format(window.used)} of ${numberFormat.format(window.limit)}`}
      meta={usageLine(window)}
    />
  );
}

function Usage({ data }: { data: InstanceSendingLimits }) {
  return (
    <div className="grid gap-4">
      <h3 className="text-[14px] font-semibold">Sent so far</h3>
      {data.usage ? (
        <div className="grid gap-4 sm:grid-cols-3">
          {WINDOWS.map((window) => (
            <Meter key={window.key} label={window.label} window={data.usage![window.key]} />
          ))}
        </div>
      ) : (
        <p className="text-[13px] text-sub">
          The counter can’t be reached right now, so there are no numbers to show. Email still goes
          out, keeping to the per-second limit.
        </p>
      )}
      {data.service && (
        <p className="rounded-[8px] bg-warn-soft px-3.5 py-3 text-[13px]">
          Your email service said its {data.service.window === 'day' ? 'daily' : 'monthly'} limit is
          used up. Posts and automations wait, and continue {continuesAt(data.service.until)}.
          Sign-in links and other email people wait for are still tried.
        </p>
      )}
      {data.waitingSends > 0 && (
        <p className="text-[13px] text-sub">
          {data.waitingSends === 1
            ? '1 send is'
            : `${numberFormat.format(data.waitingSends)} sends are`}{' '}
          waiting for a limit now. Each publication sees it on its send report.
        </p>
      )}
    </div>
  );
}

function LimitsForm({ data }: { data: InstanceSendingLimits }) {
  const save = useSaveSendingLimits();
  const mail = useQuery(instanceMailQuery);
  const [draft, setDraft] = useState<LimitDraft>(() => toDraft(data.limits));
  const [errors, setErrors] = useState<Partial<Record<LimitField, string>>>({});
  const [preset, setPreset] = useState('');
  const [saved, setSaved] = useState(false);
  const presets = presetsFor(mail.data);

  const change = (key: LimitField, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setPreset('');
    setSaved(false);
  };
  const choose = (key: string) => {
    setPreset(key);
    setSaved(false);
    const chosen = presets.find((p) => p.key === key);
    if (!chosen) return;
    setDraft(toDraft(chosen.limits));
    setErrors({});
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    const read = readDraft(draft);
    if (!read.limits) {
      setErrors(read.errors);
      return;
    }
    save.mutate(read.limits, {
      onSuccess: (next) => {
        setDraft(toDraft(next.limits));
        setSaved(true);
      },
    });
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-5 border-t border-line pt-5">
      <h3 className="text-[14px] font-semibold">Limits</h3>
      {presets.length > 0 && (
        <SelectField
          label="Start from your plan"
          value={preset}
          onChange={(event) => choose(event.target.value)}
          options={[
            { value: '', label: 'Choose a plan to fill in its limits' },
            ...presets.map((p) => ({ value: p.key, label: p.label })),
          ]}
          hint="Each is what the service published for that plan. Check your plan: services change their limits, and a paid plan usually allows more."
        />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {LIMIT_FIELDS.map((field) => (
          <TextField
            key={field.key}
            label={field.label}
            inputMode={field.key === 'perSecond' ? 'decimal' : 'numeric'}
            placeholder="No limit"
            value={draft[field.key]}
            onChange={(event) => change(field.key, event.target.value)}
            hint={field.hint}
            error={errors[field.key]}
          />
        ))}
      </div>
      {data.ceiling !== null && (
        <p className="text-[13px] text-sub">
          This install also sets a ceiling of {numberFormat.format(data.ceiling)}{' '}
          {data.ceiling === 1 ? 'email' : 'emails'} a second (MAIL_MAX_PER_SECOND on the send
          worker). The lower of the two applies.
        </p>
      )}
      <p className="text-[13px] text-sub">
        Warm-up is separate: while a sending domain warms up, it has its own daily limit. Each day
        the lower of the two wins.
      </p>
      {save.error && <ErrorNotice message={save.error.message} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={save.isPending}>
          Save limits
        </Button>
        <p role="status" className="text-[13px] text-success">
          {saved ? 'Saved. Every part of Swarm uses the new limits within 30 seconds.' : ''}
        </p>
      </div>
      {data.updatedAt && (
        <p className="text-[12px] text-sub">Last changed {formatDateTime(data.updatedAt)}.</p>
      )}
    </form>
  );
}

/** Settings → Instance → Sending limits. */
export function SendingLimits() {
  const limits = useQuery(sendingLimitsQuery);
  return (
    <section
      aria-labelledby="sending-limits-title"
      className="grid max-w-[760px] min-w-0 grid-cols-[minmax(0,1fr)] gap-6"
    >
      <div>
        <h2 id="sending-limits-title" className="text-[16px] font-semibold">
          Sending limits
        </h2>
        <p className="mt-1 text-[13px] text-sub">
          How much your email service lets this Swarm send. Every email counts against the same
          limits: posts, automations, the API and sign-in links. Email someone is waiting for, such
          as a sign-in link or a receipt, may use the last tenth of each hour, day and month, so a
          big send never holds it up. Over a limit nothing is lost: the rest waits and goes out as
          soon as the limit allows.
        </p>
      </div>
      {limits.isPending && <LoadingRows label="Loading sending limits" rows={3} />}
      {limits.error && <ErrorNotice message={limits.error.message} />}
      {limits.data && (
        <div className="card-app grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 p-6">
          <Usage data={limits.data} />
          <LimitsForm data={limits.data} />
        </div>
      )}
    </section>
  );
}
