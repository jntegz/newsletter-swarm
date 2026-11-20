// Scheduled publishing in the design studio's bar (docs/site-themes.md, "Draft, preview, publish";
// DESIGN.md, Design studio): Publish as a split button whose menu has Schedule…, the inline form
// it opens, and the line that says what is scheduled (or why it didn't publish).
import type { Problem } from '@swarm/site-themes';
import { Button } from '@swarm/ui/components';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { DesignSchedule } from '../api/design';
import * as Icon from '../icons';
import { useDisclosure } from '../shell/useDisclosure';
import {
  SCHEDULE_MAX_MS,
  SCHEDULE_MIN_MS,
  defaultScheduleTime,
  fromLocalInput,
  quickPicks,
  scheduleAround,
  scheduleTimeProblem,
  scheduleTimeShort,
  scheduleWhen,
  timeZoneName,
  toLocalInput,
} from './scheduling';

/** Publish now, and a chevron whose menu offers Schedule…. Both wait for the same reasons. */
export function PublishButton({
  blocked,
  publishing,
  onPublish,
  onSchedule,
}: {
  /** Why publishing can't happen now; it is shown beside the button. */
  blocked: string | null;
  publishing: boolean;
  onPublish: () => void;
  onSchedule: () => void;
}) {
  const menu = useDisclosure();
  const off = !!blocked;
  return (
    <div className="relative">
      <div className="btn-split">
        <Button
          loading={publishing}
          disabled={off}
          aria-describedby={off ? 'publish-why' : undefined}
          title={blocked ?? undefined}
          onClick={onPublish}
        >
          Publish
        </Button>
        <button
          type="button"
          className="btn-primary"
          aria-label="More ways to publish"
          disabled={off || publishing}
          title={blocked ?? 'More ways to publish'}
          {...menu.buttonProps}
        >
          <Icon.ChevronDown size={16} />
        </button>
      </div>
      <div
        {...menu.panelProps}
        className="line-menu absolute top-[calc(100%+6px)] right-0 w-[min(280px,calc(100vw-32px))]"
      >
        <button
          type="button"
          className="line-menu-item"
          onClick={() => {
            menu.close();
            onSchedule();
          }}
        >
          <Icon.Clock size={16} />
          <span>
            <span className="block">Schedule…</span>
            <span className="block text-[13px] text-sub">
              Publish the draft as it is now, later
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}

/** Under the bar: when to publish, quick picks, and what will go live. */
export function ScheduleForm({
  initial,
  summary,
  replacing,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  initial: Date | null;
  /** "The draft as it is now: Launch theme, 7 sections". */
  summary: string;
  /** A schedule exists: this one takes its place. */
  replacing: boolean;
  pending: boolean;
  error: string | null;
  onSubmit: (at: Date) => void;
  onClose: () => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(() => toLocalInput(initial ?? defaultScheduleTime()));
  const [tried, setTried] = useState(false);
  const [now] = useState(() => Date.now());
  const picks = quickPicks(new Date(now));
  const at = fromLocalInput(value);
  const problem = scheduleTimeProblem(at);
  const shown = tried ? problem : null;
  const zone = timeZoneName();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  // Esc inside the form closes it.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !formRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (!problem && at) onSubmit(at);
  };

  return (
    <form
      aria-labelledby={`${id}-title`}
      ref={formRef}
      noValidate
      onSubmit={submit}
      className="grid basis-full gap-3 border-t border-line pt-3 pb-1"
    >
      <div>
        <h2 id={`${id}-title`} className="text-[15px] font-semibold">
          {replacing ? 'Change the scheduled publish' : 'Schedule the draft'}
        </h2>
        <p className="mt-0.5 text-[13px] text-sub">
          {summary}. Later edits to the draft stay in the draft.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div>
          <label htmlFor={`${id}-at`} className="mb-1 block text-[13px] font-semibold">
            Publish at
          </label>
          <input
            ref={inputRef}
            id={`${id}-at`}
            type="datetime-local"
            className="line-input w-[230px] max-w-full"
            value={value}
            min={toLocalInput(new Date(now + SCHEDULE_MIN_MS))}
            max={toLocalInput(new Date(now + SCHEDULE_MAX_MS))}
            aria-describedby={`${id}-zone${shown ? ` ${id}-problem` : ''}`}
            aria-invalid={shown ? true : undefined}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <div role="group" aria-label="Quick picks" className="flex flex-wrap gap-2">
          {picks.map((pick) => (
            <button
              key={pick.label}
              type="button"
              className="btn-ghost btn-sm aria-pressed:border-purple aria-pressed:bg-surface-alt"
              aria-pressed={value === toLocalInput(pick.at)}
              onClick={() => setValue(toLocalInput(pick.at))}
            >
              {pick.label}
            </button>
          ))}
        </div>
      </div>
      <p id={`${id}-zone`} className="-mt-1 text-[13px] text-sub">
        In your time zone, {zone}. It goes live within five minutes of the time.
      </p>
      {shown && (
        <p id={`${id}-problem`} className="text-[13px] font-semibold text-danger">
          {shown}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[13px] font-semibold text-danger">
          Not scheduled: {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" loading={pending}>
          {at && !problem ? `Schedule for ${scheduleWhen(at)}` : 'Schedule'}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** What is scheduled, or why it didn't publish; editors get Change and Cancel or Dismiss. */
export function ScheduleLine({
  schedule,
  canEdit,
  busy,
  onChange,
  onCancel,
}: {
  schedule: DesignSchedule;
  canEdit: boolean;
  busy: boolean;
  onChange: () => void;
  onCancel: () => void;
}) {
  const at = new Date(schedule.at);
  if (schedule.status === 'failed') {
    const first = schedule.problems.find((p) => p.severity === 'error') ?? schedule.problems[0];
    return (
      <div className="flex basis-full flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        <p className="inline-flex min-w-0 items-start gap-1.5 text-danger">
          <Icon.Alert size={14} className="mt-[3px] shrink-0" />
          <span>
            <b className="font-semibold">
              Didn’t publish at {scheduleTimeShort(at)}
              {first ? ':' : '.'}
            </b>
            {first ? ` ${first.message}` : ''}
          </span>
        </p>
        <span className="inline-flex flex-wrap items-center gap-1">
          {schedule.problems.length > 0 && <FailedProblems problems={schedule.problems} />}
          {canEdit && (
            <Button
              variant="quiet"
              size="sm"
              loading={busy}
              aria-label="Dismiss the failed schedule"
              onClick={onCancel}
            >
              Dismiss
            </Button>
          )}
        </span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-1 gap-y-1 text-[13px]">
      <span className="inline-flex items-center gap-1.5 pr-1">
        <Icon.Clock size={14} className="shrink-0 text-sub" />
        <span>
          Scheduled for <b className="font-semibold">{scheduleAround(at)}</b>
        </span>
      </span>
      {canEdit && (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          {/* On a phone the actions wrap under the words, so they start without a dot. */}
          <span aria-hidden="true" className="text-muted max-sm:hidden">
            ·
          </span>
          <Button variant="quiet" size="sm" aria-label="Change schedule" onClick={onChange}>
            Change
          </Button>
          <span aria-hidden="true" className="text-muted">
            ·
          </span>
          <Button
            variant="quiet"
            size="sm"
            loading={busy}
            aria-label="Cancel schedule"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </span>
      )}
    </div>
  );
}

function FailedProblems({ problems }: { problems: Problem[] }) {
  const menu = useDisclosure();
  return (
    <span className="relative">
      <button type="button" className="btn-quiet btn-sm" {...menu.buttonProps}>
        See problems
      </button>
      <div
        {...menu.panelProps}
        className="line-menu absolute top-[calc(100%+6px)] left-0 max-h-[60vh] w-[min(420px,calc(100vw-32px))] overflow-y-auto"
      >
        <p className="px-2.5 pt-1.5 pb-1 text-[13px] text-sub">
          What stopped the scheduled design. Fix them in the draft, then schedule again.
        </p>
        <ul className="grid">
          {problems.map((problem, i) => (
            <li key={`${problem.file}-${problem.line}-${i}`} className="flex gap-2.5 px-2.5 py-2">
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
            </li>
          ))}
        </ul>
      </div>
    </span>
  );
}
