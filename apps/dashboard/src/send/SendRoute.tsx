// The editor's send panel: three stops in a fixed order, Write → Who gets it → Check & send,
// as an exclusive accordion. The yellow marker sits on the first stop that isn't finished; the
// send button comes last, says why it is disabled, and confirms inline.
import type { Dispatch, Preflight, PreflightAdvice, PreflightCheck } from '@swarm/domain';
import { ErrorNotice } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import {
  preflightQuery,
  rampsQuery,
  sendersQuery,
  useSaveDispatch,
  useSchedule,
  useSendNow,
  useTestSend,
  useUnschedule,
} from '../api/send';
import { AudiencePicker, useCircleNames } from '../circles/AudiencePicker';
import { twoEmails } from '../editor/PreviewPane';
import * as Icon from '../icons';
import { formatDateTime, numberFormat } from '../pages/common';
import { describeRosters } from '../rosters/helpers';
import { useRosterNames } from '../rosters/RosterAudience';
import { useSession } from '../session';
import { HoldBackSummary } from './HoldBack';
import { audienceSummary, inboxAdvice, sendBlockedReason, writeIsDone } from './send-helpers';
import { WarmupCallout, rampOfDomain } from './WarmupCallout';
import { isServerWarmupWarning, sendWarmupNote } from './warmup-notes';

type Stop = 'write' | 'who' | 'check';

const WRITE_KEYS = new Set<PreflightCheck['key']>(['subject', 'content']);
const WHO_KEYS = new Set<PreflightCheck['key']>(['audience', 'sender']);

/** Which stop a pre-send check belongs to. */
const stopOf = (key: PreflightCheck['key']): Stop =>
  WRITE_KEYS.has(key) ? 'write' : WHO_KEYS.has(key) ? 'who' : 'check';

/** A datetime-local value in the operator's time zone, an hour from now on the hour. */
function defaultLocalTime(now = Date.now()): string {
  const date = new Date(now + 3600_000);
  date.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const whenFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const fixCount = (n: number) => (n ? `${n} check${n === 1 ? '' : 's'} to fix` : 'Not ready yet');

const CHOSEN_KEY = (id: string) => `swarm:audience-chosen:${id}`;
function readChosen(id: string): boolean {
  try {
    return window.localStorage.getItem(CHOSEN_KEY(id)) === '1';
  } catch {
    return false;
  }
}
function storeChosen(id: string) {
  try {
    window.localStorage.setItem(CHOSEN_KEY(id), '1');
  } catch {
    // Storage can be blocked; the choice then lasts for this visit.
  }
}

export function SendRoute({
  dispatch,
  canWrite,
  canSend,
  flush,
  words,
  hasPaywall,
  onAddPreviewText,
}: {
  dispatch: Dispatch;
  canWrite: boolean;
  canSend: boolean;
  flush: () => Promise<unknown>;
  words: number;
  hasPaywall: boolean;
  /** Focuses the preview text field. */
  onAddPreviewText: () => void;
}) {
  const { me } = useSession();
  const navigate = useNavigate();
  const scheduled = dispatch.status === 'scheduled';
  // Runs all along: every save invalidates it, so it follows the autosave.
  const preflight = useQuery(preflightQuery(dispatch.id));
  const names = useCircleNames(dispatch.channelId);
  const rosterNames = useRosterNames(dispatch.channelId);
  const senders = useQuery(sendersQuery(dispatch.channelId));
  const ramps = useQuery(rampsQuery(dispatch.channelId));
  const saveSender = useSaveDispatch(dispatch.id);
  const schedule = useSchedule(dispatch.id);
  const unschedule = useUnschedule(dispatch.id);
  const sendNow = useSendNow(dispatch.id);
  const test = useTestSend(dispatch.id);

  // "Who gets it" needs a deliberate choice: sending to everyone is never the silent default.
  const include = dispatch.audience.include;
  const [picked, setPicked] = useState<'none' | 'everyone' | 'circles'>(() =>
    include.length > 0 ? 'circles' : scheduled || readChosen(dispatch.id) ? 'everyone' : 'none',
  );
  const [continued, setContinued] = useState(include.length > 0);
  const whoDone =
    picked === 'everyone' || (picked === 'circles' && include.length > 0 && continued);

  const checks = preflight.data?.checks ?? [];
  const failing = (stop: Stop) => checks.filter((c) => !c.ok && stopOf(c.key) === stop);
  const writeDone = writeIsDone(dispatch.subject, failing('write'));
  const first: Stop = !writeDone ? 'write' : !whoDone ? 'who' : 'check';
  // Until the operator opens a stop themselves, the open one follows the current stop (the checks
  // it depends on arrive after the first render).
  const [chosenOpen, setOpen] = useState<Stop | null | undefined>(undefined);
  const open = chosenOpen === undefined ? first : chosenOpen;

  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState(defaultLocalTime);
  const [bestTime, setBestTime] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notSaved, setNotSaved] = useState<string | null>(null);
  // Null while the flag is off, and the choice stays hidden. A test on the post rules it out.
  const bestTimeChoice = preflight.data?.bestTime ?? null;
  const usesBestTime = bestTime && !!bestTimeChoice?.available;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const chooseEveryone = () => {
    setPicked('everyone');
    storeChosen(dispatch.id);
    setOpen('check');
  };
  const continueFromWho = () => {
    setContinued(true);
    storeChosen(dispatch.id);
    setOpen('check');
  };

  const count = preflight.data?.recipientCount ?? 0;
  const atLabel = at ? whenFormat.format(new Date(at)) : '';
  const blocking = sendBlockedReason({
    canSend,
    canWrite,
    writeDone,
    writeProblem: failing('write')[0]?.message,
    whoDone,
    checking: preflight.isPending,
    checksError: preflight.error?.message ?? null,
    ready: !!preflight.data?.ready,
    firstProblem: checks.find((c) => !c.ok)?.message,
    needsTime: when === 'later' && !at,
  });
  const sendLabel =
    when === 'later'
      ? `Schedule for ${atLabel}`
      : `Send to ${numberFormat.format(count)} subscriber${count === 1 ? '' : 's'}`;

  const sender = senders.data?.find((s) => s.id === dispatch.senderIdentityId);
  const defaultSender = senders.data?.find((s) => s.isDefault);
  const fromAddress = preflight.data?.from?.address ?? (sender ?? defaultSender)?.fromAddress;

  // Warm-up: who gets this on the first day, and when the rest arrive. Worked out from the ramp
  // of the address the post comes from; until the ramps load, the server's one-line warning shows.
  const fromSender = sender ?? defaultSender;
  const ramp = senders.data ? rampOfDomain(ramps.data, fromSender?.sendingDomainId ?? null) : null;
  const sendsAt = scheduled ? dispatch.publishAt : when === 'later' && at ? at : null;
  const sendsAtMs = sendsAt ? new Date(sendsAt).getTime() : NaN;
  const warmup =
    preflight.data && whoDone
      ? sendWarmupNote(
          ramp,
          preflight.data.recipientCount,
          Number.isNaN(sendsAtMs) ? undefined : new Date(sendsAtMs).toISOString().slice(0, 10),
        )
      : null;

  const confirm = async () => {
    setNotSaved(null);
    // Never send or schedule anything but what is on the screen.
    try {
      await flush();
    } catch (error) {
      setNotSaved((error as Error).message);
      return;
    }
    if (when === 'later') {
      schedule.mutate(
        { publishAt: new Date(at).toISOString(), bestTime: usesBestTime },
        { onSuccess: () => setConfirming(false) },
      );
    } else {
      sendNow.mutate(usesBestTime ? { bestTime: true } : undefined, {
        onSuccess: ({ broadcastId }) =>
          void navigate({ to: '/broadcasts/$broadcastId', params: { broadcastId } }),
      });
    }
  };

  const scheduleError = schedule.error instanceof ApiError ? schedule.error : null;

  const stops: { id: Stop; title: string; summary: string; done: boolean; body: ReactNode }[] = [
    {
      id: 'write',
      title: 'Write',
      done: writeDone,
      summary: `${numberFormat.format(words)} word${words === 1 ? '' : 's'} · ${
        hasPaywall ? 'paywall break placed' : 'no paywall break'
      }`,
      body: (
        <>
          <p className="text-[13px] text-sub">
            Keep editing on the left; this summary follows along. Subject and preview text are
            checked in the last stop.
          </p>
          <CheckList checks={failing('write')} />
        </>
      ),
    },
    {
      id: 'who',
      title: 'Who gets it',
      done: whoDone,
      summary: audienceSummary({
        chosen: picked !== 'none',
        audience: dispatch.audience,
        names,
        rosters: describeRosters(dispatch.audience.rosters, rosterNames),
        count: preflight.data ? count : null,
      }),
      body: (
        <div className="grid gap-4">
          {dispatch.unopenedOf && (
            <p className="text-[13px] leading-[1.5] text-sub">
              This goes only to people who didn’t open or click the earlier send. Choosing a segment
              narrows that further. Some people read with a mail app that hides opens, so a few may
              get it twice.
            </p>
          )}
          <AudiencePicker
            dispatch={dispatch}
            canWrite={canWrite}
            bare
            undecided={picked === 'none'}
            onChoose={(mode) => {
              if (mode === 'everyone') chooseEveryone();
              else {
                setPicked('circles');
                setContinued(false);
              }
            }}
          />
          {picked === 'circles' && !continued && (
            <button
              type="button"
              className="btn-ghost btn-sm justify-self-start"
              disabled={include.length === 0}
              onClick={continueFromWho}
            >
              Continue to Check &amp; send
            </button>
          )}
          <CheckList checks={failing('who')} />
          <FromField
            dispatch={dispatch}
            canWrite={canWrite}
            senders={senders.data}
            pending={saveSender.isPending}
            onChange={(value) => saveSender.mutate({ senderIdentityId: value || null })}
            address={fromAddress}
          />
          {saveSender.error && (
            <ErrorNotice title="Sender not saved" message={saveSender.error.message} />
          )}
        </div>
      ),
    },
    {
      id: 'check',
      title: 'Check & send',
      done: scheduled,
      summary: scheduled
        ? `Scheduled for ${formatDateTime(dispatch.publishAt)}`
        : !whoDone
          ? 'Waiting on who gets it'
          : preflight.isPending
            ? 'Checking…'
            : preflight.data?.ready
              ? 'Ready to send'
              : fixCount(checks.filter((c) => !c.ok).length),
      body: (
        <div className="grid gap-5">
          {scheduled ? (
            <div className="grid gap-2">
              <p className="text-[15px]">
                Scheduled for <b>{formatDateTime(dispatch.publishAt)}</b>. The checks run again at
                send time; if something isn’t ready it goes back to draft and nothing is sent.
              </p>
              {dispatch.bestTime && (
                <p className="text-[13px] text-sub">
                  Each reader gets it at their best time, within 24 hours of then.
                </p>
              )}
              {canSend ? (
                <button
                  type="button"
                  className="btn-ghost btn-sm justify-self-start"
                  aria-busy={unschedule.isPending || undefined}
                  onClick={() => unschedule.mutate(undefined)}
                >
                  Unschedule
                </button>
              ) : (
                <p className="text-[13px] text-sub">An editor or admin can unschedule it.</p>
              )}
              {unschedule.error && <ErrorNotice message={unschedule.error.message} />}
            </div>
          ) : (
            <WhenField
              when={when}
              onWhen={setWhen}
              at={at}
              onAt={setAt}
              zone={zone}
              disabled={!canSend}
            />
          )}
          {!scheduled && bestTimeChoice && (
            <BestTimeField
              choice={bestTimeChoice}
              on={usesBestTime}
              onChange={setBestTime}
              chosen={when === 'later' ? 'the time you chose' : 'the moment you send'}
              disabled={!canSend}
            />
          )}
          <div>
            <p className="mb-1.5 text-[15px] font-semibold">Checks</p>
            {preflight.isPending && (
              <p role="status" className="text-[13px] text-sub">
                Checking the post…
              </p>
            )}
            {preflight.error && <ErrorNotice message={preflight.error.message} />}
            {preflight.data && (
              <ul aria-live="polite" className="grid gap-1.5">
                {!dispatch.preheader.trim() && (
                  <li className="flex items-start gap-2 rounded-control bg-warn-soft px-2.5 py-2 text-[13px] leading-[1.45] text-warn">
                    <Icon.Alert size={16} className="mt-px shrink-0" />
                    <span>
                      Preview text is empty. Inboxes will show the first line instead.{' '}
                      {canWrite && (
                        <button
                          type="button"
                          onClick={onAddPreviewText}
                          className="font-semibold text-warn underline underline-offset-[3px]"
                        >
                          Add preview text
                        </button>
                      )}
                    </span>
                  </li>
                )}
                {checks.map((c) => (
                  <CheckRow key={`${c.key}-${c.message}`} check={c} />
                ))}
                {[...new Set([...preflight.data.warnings, ...dispatch.warnings])]
                  .filter((w) => !(warmup && isServerWarmupWarning(w)))
                  .map((w) => (
                    <li
                      key={w}
                      className="flex items-start gap-2 rounded-control bg-warn-soft px-2.5 py-2 text-[13px] leading-[1.45] text-warn"
                    >
                      <Icon.Alert size={16} className="mt-px shrink-0" />
                      <span>{w}</span>
                    </li>
                  ))}
              </ul>
            )}
            {warmup && (
              <WarmupCallout
                note={warmup}
                channelId={dispatch.channelId}
                compact
                className="mt-2"
              />
            )}
            {preflight.data && <AdviceList advice={inboxAdvice(preflight.data.advice)} />}
            {preflight.data?.split && (
              <p className="mt-2 text-[13px] text-sub">
                <b className="text-ink">{numberFormat.format(preflight.data.split.full)}</b> get the
                whole post;{' '}
                <b className="text-ink">{numberFormat.format(preflight.data.split.teaser)}</b> get
                it up to the paywall break.
              </p>
            )}
            {preflight.data && (
              <div className="mt-2 text-[13px]">
                <HoldBackSummary holdBack={preflight.data.holdBack} />
              </div>
            )}
          </div>
          {canWrite && (
            <TestForm
              defaultTo={me.operator.email}
              split={twoEmails(dispatch)}
              pending={test.isPending}
              sentTo={test.data?.sentTo ?? null}
              error={test.error?.message ?? null}
              onSend={async (input) => {
                // A test of older text would mislead. The page says the save failed.
                try {
                  await flush();
                } catch {
                  return;
                }
                test.mutate(input);
              }}
            />
          )}
          {!scheduled && (
            <div className="border-t border-line-control pt-4">
              <button
                type="button"
                className="btn-primary w-full min-h-[42px]!"
                disabled={!!blocking}
                aria-describedby="send-why"
                onClick={() => setConfirming(true)}
              >
                <Icon.Send size={18} />
                {sendLabel}
              </button>
              <p id="send-why" className="mt-2 text-[13px] text-sub">
                {blocking ??
                  (when === 'later'
                    ? `To ${numberFormat.format(count)} subscribers.`
                    : 'You confirm before it goes.')}
              </p>
              {confirming && !blocking && (
                <div
                  role="group"
                  aria-labelledby="send-confirm"
                  className="mt-3 rounded-card border border-line-control bg-surface p-3.5"
                >
                  <p id="send-confirm" className="mb-3 font-semibold">
                    {when === 'later'
                      ? `Schedule for ${atLabel} to ${numberFormat.format(count)} ${count === 1 ? 'subscriber' : 'subscribers'}?`
                      : `Send now to ${numberFormat.format(count)} ${count === 1 ? 'subscriber' : 'subscribers'}? This can’t be undone.`}
                  </p>
                  {usesBestTime && (
                    <p className="mb-3 text-[13px] text-sub">
                      Readers get it over the next 24 hours from then, not all at once.
                    </p>
                  )}
                  {warmup && warmup.tone !== 'paused' && (
                    <p className="mb-3 text-[13px] font-semibold">{warmup.confirm}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      aria-busy={sendNow.isPending || schedule.isPending || undefined}
                      onClick={() => void confirm()}
                    >
                      {sendNow.isPending
                        ? 'Sending…'
                        : schedule.isPending
                          ? 'Scheduling…'
                          : 'Confirm'}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      onClick={() => setConfirming(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {sendNow.error && <ErrorNotice title="Not sent" message={sendNow.error.message} />}
              {notSaved && (
                <ErrorNotice
                  title="Not sent: your latest changes are not saved"
                  message={notSaved}
                />
              )}
              {scheduleError && (
                <ErrorNotice
                  title="Not scheduled"
                  message={
                    scheduleError.details.length
                      ? scheduleError.details.map((d) => d.message).join(' ')
                      : scheduleError.message
                  }
                />
              )}
            </div>
          )}
        </div>
      ),
    },
  ];

  return (
    <section aria-labelledby="send-route-title">
      <h2 id="send-route-title" className="text-[17px] font-[650]">
        Send
      </h2>
      <p className="mt-0.5 text-[13px] text-sub">
        Three stops, in order. The send button comes last.
      </p>
      <ol className="line-steps mt-[18px]">
        {stops.map((stop) => {
          const isOpen = open === stop.id;
          const state = stop.done ? 'is-done' : stop.id === first ? 'is-now' : '';
          const panelId = `send-stop-${stop.id}`;
          return (
            <li key={stop.id} className={state}>
              <h3>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => setOpen(isOpen ? null : stop.id)}
                  className="relative grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 rounded-control py-2 pr-1.5 pl-[34px] text-left transition-colors hover:bg-lavender"
                >
                  <span className="line-smk" aria-hidden="true">
                    {stop.done && <Icon.Check size={13} strokeWidth={3} />}
                  </span>
                  <span className="text-[17px] leading-[1.3] font-[650]">
                    {stop.title}
                    <span className="sr-only">
                      {stop.done ? ', done' : stop.id === first ? ', next step' : ''}
                    </span>
                  </span>
                  <span className="col-start-1 mt-px truncate text-[13px] text-sub">
                    {stop.summary}
                  </span>
                  <Icon.ChevronDown
                    className={`col-start-2 row-span-2 row-start-1 self-center text-sub transition-transform ${isOpen ? 'rotate-180' : ''}`}
                  />
                </button>
              </h3>
              <div id={panelId} hidden={!isOpen} className="pt-1.5 pb-3.5 pl-[34px]">
                {stop.body}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function CheckRow({ check }: { check: PreflightCheck }) {
  return check.ok ? (
    <li className="flex items-start gap-2 text-[13px] leading-[1.45]">
      <Icon.Check size={16} strokeWidth={2.5} className="mt-px shrink-0 text-success" />
      <span>
        <span className="sr-only">Passed: </span>
        {check.message}
      </span>
    </li>
  ) : (
    <li className="flex items-start gap-2 rounded-control bg-danger-soft px-2.5 py-2 text-[13px] leading-[1.45] font-semibold text-danger">
      <Icon.Blocked size={16} className="mt-px shrink-0" />
      <span>
        <span className="sr-only">Needs attention: </span>
        {check.message}
      </span>
    </li>
  );
}

/** Content advice: things spam filters and readers hold against an email. Never blocks. */
function AdviceList({ advice }: { advice: PreflightAdvice[] }) {
  const headingId = useId();
  if (!advice.length) return null;
  return (
    <div className="mt-3 rounded-control border border-line p-3">
      <p id={headingId} className="text-[13.5px] font-semibold">
        Inbox advice ({advice.length})
      </p>
      <p className="mt-0.5 text-[12.5px] leading-[1.45] text-sub">
        Spam filters and readers react to these. They are suggestions: you can send without changing
        anything.
      </p>
      <ul aria-labelledby={headingId} className="mt-2 grid gap-2">
        {advice.map((item) => (
          <li key={item.id} className="flex items-start gap-2 text-[13px] leading-[1.45]">
            <Icon.Alert size={16} className="mt-px shrink-0 text-warn" />
            <span>
              <span className="sr-only">Advice: </span>
              {item.message}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CheckList({ checks }: { checks: PreflightCheck[] }) {
  if (!checks.length) return null;
  return (
    <ul className="mt-2 grid gap-1.5">
      {checks.map((c) => (
        <CheckRow key={`${c.key}-${c.message}`} check={c} />
      ))}
    </ul>
  );
}

function FromField({
  dispatch,
  canWrite,
  senders,
  pending,
  onChange,
  address,
}: {
  dispatch: Dispatch;
  canWrite: boolean;
  senders: { id: string; fromName: string; fromAddress: string; isDefault: boolean }[] | undefined;
  pending: boolean;
  onChange: (value: string) => void;
  address: string | undefined;
}) {
  const id = useId();
  const defaultSender = senders?.find((s) => s.isDefault);
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[15px] font-semibold">
          From
        </label>
        <Link
          to="/channels/$channelId/sending"
          params={{ channelId: dispatch.channelId }}
          className="text-[13px] text-purple"
        >
          Manage senders
        </Link>
      </div>
      <select
        id={id}
        className="line-input"
        disabled={!canWrite || pending || !senders}
        value={dispatch.senderIdentityId ?? ''}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={`${id}-address`}
      >
        <option value="">
          {defaultSender
            ? `Default (${defaultSender.fromName})`
            : 'Publication name on the shared domain'}
        </option>
        {senders?.map((s) => (
          <option key={s.id} value={s.id}>
            {s.fromName}
          </option>
        ))}
      </select>
      <p id={`${id}-address`} className="mt-1.5 text-[13px] text-sub">
        {address ?? 'The address shows once the sender loads.'}
      </p>
    </div>
  );
}

function WhenField({
  when,
  onWhen,
  at,
  onAt,
  zone,
  disabled,
}: {
  when: 'now' | 'later';
  onWhen: (when: 'now' | 'later') => void;
  at: string;
  onAt: (value: string) => void;
  zone: string;
  disabled: boolean;
}) {
  const name = useId();
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-1.5 text-[15px] font-semibold">When</legend>
      {(
        [
          ['now', 'Send now'],
          ['later', 'Schedule'],
        ] as const
      ).map(([value, label]) => (
        <label key={value} className="flex cursor-pointer items-start gap-2.5 py-[7px]">
          <input
            type="radio"
            name={name}
            className="mt-[3px] size-4 shrink-0"
            checked={when === value}
            onChange={() => onWhen(value)}
          />
          <span>{label}</span>
        </label>
      ))}
      {when === 'later' && (
        <div className="mt-1 ml-[26px]">
          <label htmlFor={`${name}-at`} className="sr-only">
            Send date and time
          </label>
          <input
            id={`${name}-at`}
            type="datetime-local"
            className="line-input"
            value={at}
            onChange={(e) => onAt(e.target.value)}
          />
          <p className="mt-1.5 text-[13px] text-sub">Your time zone: {zone}</p>
        </div>
      )}
    </fieldset>
  );
}

function BestTimeField({
  choice,
  on,
  onChange,
  chosen,
  disabled,
}: {
  choice: NonNullable<Preflight['bestTime']>;
  on: boolean;
  onChange: (on: boolean) => void;
  chosen: string;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          className="mt-[3px] size-4 shrink-0"
          checked={on}
          disabled={disabled || !choice.available}
          aria-describedby={`${id}-how`}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>Send at each reader’s best time</span>
      </label>
      <p id={`${id}-how`} className="mt-1 ml-[26px] text-[13px] leading-[1.5] text-sub">
        {choice.reason ??
          `Over the 24 hours from ${chosen}, each reader gets this at the hour they most often opened or clicked in the last 90 days. It’s an estimate, and it leans toward when you’ve sent before. Readers with fewer than 3 posts opened or clicked get it at ${chosen}, and that includes people whose mail app hides opens.`}
      </p>
      {on && choice.note && (
        <p className="mt-1.5 ml-[26px] text-[13px] leading-[1.5] text-warn">{choice.note}</p>
      )}
    </div>
  );
}

function TestForm({
  defaultTo,
  split,
  pending,
  sentTo,
  error,
  onSend,
}: {
  defaultTo: string;
  split: boolean;
  pending: boolean;
  sentTo: string[] | null;
  error: string | null;
  onSend: (input: { to: string[]; variant?: 'full' | 'teaser' }) => Promise<void>;
}) {
  const id = useId();
  const [to, setTo] = useState(defaultTo);
  const [variant, setVariant] = useState<'full' | 'teaser'>('full');
  const addresses = to
    .split(/[\s,;]+/)
    .map((a) => a.trim())
    .filter(Boolean);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (addresses.length === 0 || addresses.length > 5) return;
        void onSend(split ? { to: addresses, variant } : { to: addresses });
      }}
    >
      <label htmlFor={id} className="mb-1.5 block text-[15px] font-semibold">
        Send a test
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          type="text"
          inputMode="email"
          autoComplete="email"
          className="line-input min-h-[34px]! text-[13px]"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-describedby={`${id}-hint`}
        />
        <button
          type="submit"
          className="btn-ghost btn-sm shrink-0"
          aria-busy={pending || undefined}
          disabled={addresses.length === 0 || addresses.length > 5}
        >
          {pending ? 'Sending…' : 'Send test'}
        </button>
      </div>
      {split && (
        <label className="mt-2 flex items-center gap-2 text-[13px]">
          <span className="text-sub">Which email</span>
          <select
            className="line-input min-h-[30px]! w-auto text-[13px]"
            value={variant}
            onChange={(e) => setVariant(e.target.value as 'full' | 'teaser')}
          >
            <option value="full">Full, as paid subscribers get it</option>
            <option value="teaser">Up to the paywall break</option>
          </select>
        </label>
      )}
      <p id={`${id}-hint`} className="mt-1.5 text-[13px] text-sub">
        Up to 5 team addresses. Links aren’t tracked and the subject starts with [Test].
      </p>
      {sentTo && (
        <p role="status" className="mt-1.5 text-[13px] text-success">
          Sent to {sentTo.join(', ')}.
        </p>
      )}
      {error && <ErrorNotice title="Test not sent" message={error} />}
    </form>
  );
}
