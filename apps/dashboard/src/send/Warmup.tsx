// Settings → Sending → Warm-up: what warm-up is, where each sending domain is on its way, the
// plan from today, and the choices an admin has (pace, pause, skip, start again).
import {
  WARMUP_CADENCES,
  WARM_IMPORT_THRESHOLD,
  projectWarmup,
  type Channel,
  type Ramp,
  type RampPaceKey,
  type RampPaceValues,
  type WarmupCadence,
  type WarmupPlan,
} from '@swarm/domain';
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { rampsQuery, sendersQuery, useRestartRamp, useSkipRamp, useUpdateRamp } from '../api/send';
import * as Icon from '../icons';
import { Section, numberFormat } from '../pages/common';
import { useCadence } from './useCadence';
import {
  CADENCE_OPTIONS,
  PACE_NAMES,
  cadencePhrase,
  customPaceProblem,
  dayNumber,
  formatDay,
  fullListSentence,
  paceOptions,
  paceSummary,
  pauseReason,
  planFor,
  planPreviewLength,
  previewPace,
  primaryRamp,
  ratePercent,
  resetTime,
  sendDoneSentence,
  subscribers,
  warmupSteps,
} from './warmup-helpers';

/** Where the Domains section sits on the Sending page, for "add your own domain" links. */
export const DOMAINS_ANCHOR = 'sending-domains';

export function WarmupSection({ channel, admin }: { channel: Channel; admin: boolean }) {
  const ramps = useQuery(rampsQuery(channel.id));
  const senders = useQuery(sendersQuery(channel.id));
  const defaultSender = senders.data?.find((s) => s.isDefault);
  return (
    <WarmupView
      channelId={channel.id}
      admin={admin}
      ramps={ramps.data}
      loading={ramps.isPending}
      error={ramps.error?.message ?? null}
      onRetry={() => void ramps.refetch()}
      defaultDomainId={defaultSender?.sendingDomainId}
    />
  );
}

export function WarmupView({
  channelId,
  admin,
  ramps,
  loading,
  error,
  onRetry,
  defaultDomainId,
}: {
  channelId: string;
  admin: boolean;
  ramps: Ramp[] | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  defaultDomainId?: string | null | undefined;
}) {
  const primary = ramps ? primaryRamp(ramps, defaultDomainId) : null;
  const others = ramps?.filter((r) => r.id !== primary?.id) ?? [];
  const inProgress = ramps?.some((r) => r.status !== 'complete') ?? true;
  return (
    <Section
      title="Warm-up"
      description="A new sending domain starts with a small daily limit. The limit grows every day your emails are welcome, until it no longer holds anything back."
    >
      <div className="line-band grid gap-5">
        <Explainer open={inProgress} />
        <WarmUpWell open={inProgress} channelId={channelId} />
        {loading && <LoadingRows label="Loading warm-up" rows={3} />}
        {error && (
          <ErrorNotice
            title="Warm-up could not be loaded"
            message={`${error} Your sending is not affected. Try again in a moment.`}
            action={
              <Button variant="ghost" size="sm" onClick={onRetry}>
                Try again
              </Button>
            }
          />
        )}
        {ramps && !primary && (
          <EmptyState
            title="No sending domain yet"
            action={
              <a href={`#${DOMAINS_ANCHOR}`} className="btn-primary btn-sm">
                Add a sending domain
              </a>
            }
          >
            Warm-up starts on its own when a sending domain is verified. Add your domain under
            Domains, and its plan shows up here.
          </EmptyState>
        )}
        {primary && <RampCard ramp={primary} channelId={channelId} admin={admin} />}
        {others.length > 0 && (
          <details className="group border-t border-line pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[14px] font-semibold [&::-webkit-details-marker]:hidden">
              <Icon.ChevronRight size={16} className="transition-transform group-open:rotate-90" />
              {others.length === 1
                ? `Other sending domain: ${others[0]?.domain ?? ''}`
                : `Other sending domains (${others.length})`}
            </summary>
            <p className="mt-2 text-[13px] text-sub">
              Each sending domain warms up on its own.{' '}
              {others.some((r) => r.kind === 'shared') &&
                'The shared domain is used by any sender that has no domain of its own.'}
            </p>
            <div className="mt-3 grid gap-4">
              {others.map((ramp) => (
                <RampCard key={ramp.id} ramp={ramp} channelId={channelId} admin={admin} compact />
              ))}
            </div>
          </details>
        )}
      </div>
    </Section>
  );
}

// ---- What warm-up is -----------------------------------------------------------------------

function Explainer({ open }: { open: boolean }) {
  return (
    <details open={open} className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[14px] font-semibold [&::-webkit-details-marker]:hidden">
        <Icon.ChevronRight size={16} className="transition-transform group-open:rotate-90" />
        How warm-up works
      </summary>
      <div className="mt-2 grid gap-4 text-[14px] leading-[1.55]">
        <p className="max-w-[72ch]">
          Mailbox providers such as Gmail and Outlook are wary of a domain they have never seen send
          email. If a new domain sends thousands of emails on its first day, they treat it like a
          spammer: the emails land in spam, or are refused. Warm-up sends a little more each day, so
          providers get to know you as someone whose emails people open.
        </p>
        <div className="grid gap-x-8 gap-y-4 @[760px]:grid-cols-2">
          <div>
            <h3 className="text-[14px] font-[650]">What Swarm does for you</h3>
            <ul className="mt-1.5 grid list-disc gap-1 pl-5 text-[13.5px] text-sub">
              <li>Sets a daily limit for each sending domain, and raises it after a good day.</li>
              <li>
                When a post goes to more people than today&rsquo;s limit, sends the rest over the
                following days. Nobody is skipped and you do not send again.
              </li>
              <li>Sends to your most engaged readers first. Their opens build trust fastest.</li>
              <li>Pauses sending if bounces or spam complaints spike.</li>
              <li>Emails the publication&rsquo;s owners and admins when that happens.</li>
            </ul>
          </div>
          <div>
            <h3 className="text-[14px] font-[650]">What it means for your posts</h3>
            <ul className="mt-1.5 grid list-disc gap-1 pl-5 text-[13.5px] text-sub">
              <li>
                On the first days a post to a large list reaches only part of it. The rest get the
                same post over the following days.
              </li>
              <li>
                The limit grows only after a day that used at least half of it. A day without a send
                leaves it where it is.
              </li>
              <li>
                The plan below shows each day&rsquo;s limit and the date your whole list fits in one
                day.
              </li>
            </ul>
          </div>
        </div>
      </div>
    </details>
  );
}

/**
 * The checklist. Each line is a rule of the engine (packages/engine/src/ramp.ts, pipeline.ts) in
 * plain words; change one and the other has to follow.
 */
export const WARM_UP_WELL: { title: string; text: string }[] = [
  {
    title: 'Keep a rhythm.',
    text: 'The limit grows after a day that used at least half of it. A post larger than the limit keeps going out day after day, and each of those days counts. Days with no send do no harm: the limit stays where it is. So a weekly newsletter gets there a little later than a daily one. Choose how often you send under the plan to see your dates.',
  },
  {
    title: 'Send to your whole list. Swarm picks who goes first.',
    text: 'Each post goes to readers who opened or clicked in the last 90 days first, then to new readers and readers Swarm knows little about, then to readers who have gone quiet. You do not need to build a segment for this.',
  },
  {
    title: 'Clean the list before the first big send.',
    text: 'Leave out addresses you have not emailed in a long time. An import already skips addresses that bounced or complained before, role addresses such as info@ and throwaway mailboxes.',
  },
  {
    title: 'Turn on double opt-in.',
    text: 'People confirm by email before they become subscribers, so mistyped and made-up addresses never get a post. Fewer bounces, fewer spam complaints. It is in Publication settings.',
  },
  {
    title: 'Do not import an old list in the middle of warm-up.',
    text: `Old addresses bounce, and bounces pause sending. Wait until your list fits in one day, or import it in parts. An import of ${numberFormat.format(WARM_IMPORT_THRESHOLD)} or more new addresses starts a finished warm-up again.`,
  },
  {
    title: 'If sending pauses, fix the cause first.',
    text: 'A pause means too many bounces or spam complaints in the last day. Posts wait where they are. Find the send they came from on Deliverability, remove those subscribers, then resume. Warm-up carries on at the same limit. Resume without a fix and the next bounce or complaint can pause it again.',
  },
  {
    title: 'Skip only for a domain that already sends this much.',
    text: 'If the domain sends about as many emails a day from another service, mailbox providers know it and you can skip. Never skip for a new domain: it is the quickest way to land in spam.',
  },
];

function WarmUpWell({ open, channelId }: { open: boolean; channelId: string }) {
  return (
    <details open={open} className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[14px] font-semibold [&::-webkit-details-marker]:hidden">
        <Icon.ChevronRight size={16} className="transition-transform group-open:rotate-90" />
        How to warm up well
      </summary>
      <ol className="mt-2 grid max-w-[76ch] list-decimal gap-2 pl-5 text-[13.5px] leading-[1.55]">
        {WARM_UP_WELL.map((item) => (
          <li key={item.title}>
            <span className="font-[650]">{item.title}</span>{' '}
            <span className="text-sub">{item.text}</span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-[13px] text-sub">
        Bounces and complaints by send are on{' '}
        <Link
          to="/channels/$channelId/deliverability"
          params={{ channelId }}
          className="font-semibold underline underline-offset-2"
        >
          Deliverability
        </Link>
        .
      </p>
    </details>
  );
}

// ---- One domain ----------------------------------------------------------------------------

function StatusPill({ ramp }: { ramp: Ramp }) {
  if (ramp.skipped) return <Pill tone="neutral">Skipped</Pill>;
  if (ramp.status === 'complete') return <Pill tone="success">Complete</Pill>;
  if (ramp.status === 'paused') return <Pill tone="danger">Paused</Pill>;
  return <Pill tone="scheduled">Warming up</Pill>;
}

function RampCard({
  ramp,
  channelId,
  admin,
  compact = false,
}: {
  ramp: Ramp;
  channelId: string;
  admin: boolean;
  /** Without the route: for the domains under "Other sending domains". */
  compact?: boolean;
}) {
  const update = useUpdateRamp(channelId);
  const [cadence, setCadence] = useCadence(channelId);
  const [dialog, setDialog] = useState<'pace' | 'skip' | 'restart' | 'ceiling' | null>(null);
  const titleId = useId();
  const complete = ramp.status === 'complete';
  const paused = ramp.status === 'paused';

  return (
    <article
      aria-labelledby={titleId}
      className="min-w-0 rounded-card-app border border-line-app px-4 py-4 sm:px-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 id={titleId} className="font-mono text-[14px] font-semibold break-all">
            {ramp.domain}
          </h3>
          <StatusPill ramp={ramp} />
          {ramp.kind === 'shared' && <Pill tone="neutral">Shared domain</Pill>}
        </div>
        {compact && !complete && (
          <p className="tabular text-[13px] text-sub">
            Day {dayNumber(ramp)}: {numberFormat.format(Math.min(ramp.sentToday, ramp.capToday))} of{' '}
            {numberFormat.format(ramp.capToday)} sent today
          </p>
        )}
      </div>

      {!compact && <Route ramp={ramp} cadence={cadence} />}

      {ramp.kind === 'shared' && <SharedDomainNote ramp={ramp} />}

      {paused && (
        <PausedNotice
          ramp={ramp}
          channelId={channelId}
          admin={admin}
          resuming={update.isPending}
          onResume={() => update.mutate({ rampId: ramp.id, status: 'warming' })}
        />
      )}

      {complete ? (
        <p className="mt-4 max-w-[72ch] text-[14px] leading-[1.55]">
          {ramp.skipped
            ? 'Warm-up was skipped for this domain. Nothing limits how much it sends in a day.'
            : 'Warm-up is finished. Nothing limits how much this domain sends in a day.'}{' '}
          <span className="text-sub">
            Sending stops pausing on its own once warm-up ends, so keep an eye on bounces and
            complaints on the Deliverability page. A large import starts warm-up again by itself.
          </span>
        </p>
      ) : (
        <Plan ramp={ramp} cadence={cadence} onCadence={setCadence} />
      )}

      {!compact && !complete && ramp.days.length > 0 && <History ramp={ramp} />}

      {!complete && (
        <p className="mt-4 text-[12.5px] leading-[1.5] text-sub">
          Sending pauses if more than {ratePercent(ramp.bounceThreshold)} of a day&rsquo;s emails
          bounce, or more than {ratePercent(ramp.complaintThreshold)} are marked as spam. Each
          day&rsquo;s limit starts over at {resetTime()}.
        </p>
      )}

      {admin ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {complete ? (
            <Button variant="ghost" size="sm" onClick={() => setDialog('restart')}>
              Start warm-up again
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => setDialog('pace')}>
                Change pace
              </Button>
              {!paused && (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={update.isPending}
                  onClick={() => update.mutate({ rampId: ramp.id, status: 'paused' })}
                >
                  Pause sending
                </Button>
              )}
              {ramp.sharedOverride && (
                <Button variant="ghost" size="sm" onClick={() => setDialog('ceiling')}>
                  Raise the ceiling
                </Button>
              )}
              {(ramp.kind === 'custom' || ramp.sharedOverride) && (
                <Button variant="quiet" size="sm" onClick={() => setDialog('skip')}>
                  My domain already sends this much mail
                </Button>
              )}
            </>
          )}
        </div>
      ) : (
        <p className="mt-4 border-t border-line pt-3 text-[12.5px] text-sub">
          Only owners and admins can change warm-up.
        </p>
      )}
      {update.error && (
        <div className="mt-3">
          <ErrorNotice title="That change was not saved" message={update.error.message} />
        </div>
      )}

      {admin && !complete && (
        <PaceDialog
          ramp={ramp}
          channelId={channelId}
          open={dialog === 'pace'}
          onClose={() => setDialog(null)}
        />
      )}
      {admin && !complete && ramp.sharedOverride && (
        <CeilingDialog
          ramp={ramp}
          channelId={channelId}
          open={dialog === 'ceiling'}
          onClose={() => setDialog(null)}
        />
      )}
      {admin && !complete && (ramp.kind === 'custom' || ramp.sharedOverride) && (
        <SkipDialog
          ramp={ramp}
          channelId={channelId}
          open={dialog === 'skip'}
          onClose={() => setDialog(null)}
        />
      )}
      {admin && complete && (
        <RestartDialog
          ramp={ramp}
          channelId={channelId}
          open={dialog === 'restart'}
          onClose={() => setDialog(null)}
        />
      )}
    </article>
  );
}

/**
 * The install's shared domain: where its warm-up ends, the way to a warm-up of your own, and what
 * an instance admin may do here.
 */
function SharedDomainNote({ ramp }: { ramp: Ramp }) {
  const complete = ramp.status === 'complete';
  return (
    <div className="mt-4 rounded-card-app border border-line-app bg-surface-alt px-4 py-3 text-[13.5px] leading-[1.55]">
      <p>
        <span className="font-semibold">This is the shared domain of this Swarm install.</span>{' '}
        Every publication without a sending domain of its own sends from it, so they share one
        reputation.{' '}
        {!complete && (
          <>
            Warm-up here ends when the daily limit reaches {numberFormat.format(ramp.maxCap)}. After
            that nothing is held back
            {ramp.plan.audience > ramp.maxCap
              ? `, so the step up to your ${subscribers(ramp.plan.audience)} is a sudden one.`
              : '.'}
          </>
        )}
      </p>
      <p className="mt-2">
        With your own sending domain, readers see your name in the address and the publication gets
        a warm-up of its own, sized to its list.{' '}
        <a href={`#${DOMAINS_ANCHOR}`} className="font-semibold underline underline-offset-2">
          Add your own domain
        </a>
      </p>
      {!complete && (
        <p className="mt-2 text-sub">
          {ramp.sharedOverride
            ? 'You are an instance admin, and on your own install this domain’s reputation is yours. You can raise the ceiling so warm-up carries on up to your list size, or skip warm-up if the domain already sends this much mail.'
            : 'An instance admin of this install can raise the ceiling, or skip warm-up on this domain.'}
        </p>
      )}
    </div>
  );
}

function Route({ ramp, cadence }: { ramp: Ramp; cadence: WarmupCadence }) {
  const steps = warmupSteps(ramp, planFor(ramp, cadence));
  const current = steps.findIndex((s) => s.state === 'now');
  return (
    <ol
      className="line-route line-route-warmup mt-5"
      aria-label={`Warm-up steps for ${ramp.domain}`}
    >
      {steps.map((step, i) => {
        const state =
          step.state === 'done' ? 'is-done' : step.state === 'now' ? 'is-now' : 'is-future';
        return (
          <li
            key={step.id}
            className={`${state} ${current !== -1 && i >= current ? 'is-ahead' : ''}`}
            aria-current={step.state === 'now' ? 'step' : undefined}
          >
            <span className="line-mk" aria-hidden="true">
              {step.state === 'done' && <Icon.Check size={13} strokeWidth={3} />}
            </span>
            <p
              className={`text-[14px] leading-[1.35] font-[650] ${step.state === 'ahead' ? 'text-sub' : ''}`}
            >
              {step.title}
              <span className="sr-only">
                {step.state === 'done' ? ' (done)' : step.state === 'now' ? ' (now)' : ' (to come)'}
              </span>
            </p>
            <p
              className={`tabular mt-0.5 text-[13px] leading-[1.45] text-sub ${step.id === 'verified' ? 'font-mono text-[12.5px] break-all' : ''}`}
            >
              {step.detail}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function PausedNotice({
  ramp,
  channelId,
  admin,
  resuming,
  onResume,
}: {
  ramp: Ramp;
  channelId: string;
  admin: boolean;
  resuming: boolean;
  onResume: () => void;
}) {
  const reason = pauseReason(ramp);
  // A pause the shared domain made itself affects every publication on the install, so only an
  // instance admin may lift it (the server enforces this too).
  const needsInstanceAdmin = ramp.kind === 'shared' && !reason.byHand && !ramp.sharedOverride;
  return (
    <div
      role="status"
      className="mt-4 rounded-card-app border border-danger bg-danger-soft px-4 py-3.5 text-[13.5px] leading-[1.55]"
    >
      <p className="flex items-center gap-1.5 font-semibold text-danger-ink">
        <Icon.Alert size={16} /> Sending from this domain is paused
      </p>
      <p className="mt-1 text-danger-ink">{reason.text}</p>
      <p className="mt-2 text-ink">
        Posts that were going out are waiting. They carry on from where they stopped when you
        resume, and nobody gets an email twice.
      </p>
      {!reason.byHand && (
        <>
          <p className="mt-3 font-semibold text-ink">What to do next</p>
          <ol className="mt-1 grid list-decimal gap-1 pl-5 text-ink">
            <li>
              Open{' '}
              <Link
                to="/channels/$channelId/deliverability"
                params={{ channelId }}
                className="font-semibold underline underline-offset-2"
              >
                Deliverability
              </Link>{' '}
              and look at which send the bounces or complaints came from.
            </li>
            <li>
              If they came from an import or an old list, remove those subscribers. Addresses that
              bounced are already blocked.
            </li>
            <li>
              {needsInstanceAdmin
                ? 'Ask an instance admin to resume. Every publication on this install sends from the shared domain, so they decide.'
                : 'Resume. Warm-up carries on at today’s limit.'}
            </li>
          </ol>
        </>
      )}
      {needsInstanceAdmin ? (
        <p className="mt-3 text-ink">
          Only an instance admin can resume sending from the install&rsquo;s shared domain.
        </p>
      ) : admin ? (
        <div className="mt-3">
          <Button size="sm" loading={resuming} onClick={onResume}>
            Resume sending
          </Button>
        </div>
      ) : (
        <p className="mt-3 text-ink">An owner or admin can resume sending.</p>
      )}
    </div>
  );
}

// ---- The plan ------------------------------------------------------------------------------

function CadenceChoice({
  value,
  onChange,
}: {
  value: WarmupCadence;
  onChange: (cadence: WarmupCadence) => void;
}) {
  const name = useId();
  return (
    <fieldset className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <legend className="float-left mr-3 text-[13px] font-semibold">How often do you send?</legend>
      <div className="inline-flex max-w-full min-w-0 flex-wrap rounded-control border border-line bg-surface-alt p-[3px]">
        {CADENCE_OPTIONS.map((option) => {
          const checked = option.key === value;
          return (
            <label
              key={option.key}
              className={`inline-flex h-[30px] cursor-pointer items-center rounded-[6px] px-2.5 text-[13px] whitespace-nowrap transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-purple ${
                checked
                  ? 'bg-surface font-semibold text-ink shadow-[0_0_0_1px_var(--line-control)]'
                  : 'text-sub hover:text-ink'
              }`}
            >
              <input
                type="radio"
                name={name}
                className="sr-only"
                checked={checked}
                onChange={() => onChange(option.key)}
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function PlanRow({
  day,
  plan,
  first,
}: {
  day: WarmupPlan['days'][number];
  plan: WarmupPlan;
  first: boolean;
}) {
  return (
    <tr className="border-b border-line-soft">
      <th scope="row" className="py-1.5 pr-3 font-normal whitespace-nowrap">
        {first ? 'Today' : formatDay(day.day, plan.today)}
        {day.day === plan.fullListDay && !first && (
          <span className="ml-2 font-semibold text-success">Whole list fits</span>
        )}
      </th>
      <td className="py-1.5 pr-3 text-right whitespace-nowrap">
        {day.day === plan.completeDay ? 'No limit' : numberFormat.format(day.cap)}
      </td>
      <td className="py-1.5 text-right whitespace-nowrap">
        {numberFormat.format(day.reach)}
        <span className="hidden text-sub sm:inline"> of {numberFormat.format(plan.audience)}</span>
      </td>
    </tr>
  );
}

function Plan({
  ramp,
  cadence,
  onCadence,
}: {
  ramp: Ramp;
  cadence: WarmupCadence;
  onCadence: (cadence: WarmupCadence) => void;
}) {
  const plan = planFor(ramp, cadence);
  const [all, setAll] = useState(false);
  const preview = planPreviewLength(plan);
  const rows = all ? plan.days : plan.days.slice(0, preview);
  // The day the list fits is always in sight, even when the short list stops before it.
  const fullAt = plan.days.findIndex((d) => d.day === plan.fullListDay);
  const later = !all && fullAt >= preview ? plan.days[fullAt] : undefined;
  const sendDone = sendDoneSentence(plan);
  const waits = plan.fullListDay !== null && plan.fullListDay > plan.today;
  return (
    <div className="mt-5">
      <h4 className="text-[14px] font-[650]">
        {plan.assumesResume ? 'The plan if you resume today' : 'The plan from today'}
      </h4>
      {plan.audience > 0 && <CadenceChoice value={cadence} onChange={onCadence} />}
      <p className="mt-2 max-w-[72ch] text-[14px] leading-[1.55]" aria-live="polite">
        {fullListSentence(plan, waits ? cadence : undefined)} {sendDone}
      </p>
      {plan.days.length > 0 && plan.audience > 0 && (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="tabular w-full max-w-[640px] border-collapse text-left text-[13px]">
              <caption className="sr-only">
                Daily limit for {ramp.domain}, day by day from today
              </caption>
              <thead>
                <tr className="border-b border-line text-sub">
                  <th scope="col" className="py-1.5 pr-3 font-semibold">
                    Day
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-semibold">
                    Daily limit
                  </th>
                  <th scope="col" className="py-1.5 text-right font-semibold">
                    Reached<span className="hidden sm:inline"> if you send today</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((day, i) => (
                  <PlanRow key={day.day} day={day} plan={plan} first={i === 0} />
                ))}
                {later && (
                  <>
                    <tr className="border-b border-line-soft text-sub">
                      <td colSpan={3} className="py-1.5">
                        <span aria-hidden="true">&hellip;</span>
                        <span className="sr-only">Days in between are left out</span>
                      </td>
                    </tr>
                    <PlanRow day={later} plan={plan} first={false} />
                  </>
                )}
              </tbody>
            </table>
          </div>
          {plan.days.length > preview && (
            <button
              type="button"
              className="btn-quiet btn-sm mt-2 -ml-2"
              aria-expanded={all}
              onClick={() => setAll(!all)}
            >
              {all
                ? 'Show fewer days'
                : `Show all ${plan.days.length} days${plan.truncated ? ' of the plan so far' : ''}`}
            </button>
          )}
          <p className="mt-2 max-w-[72ch] text-[12.5px] leading-[1.5] text-sub">
            &ldquo;Reached&rdquo; is how many of your {subscribers(plan.audience)} a post sent to
            everyone today has reached by the end of that day. The plan assumes you send a post to
            your whole list today and again {cadencePhrase(cadence)}, and that every day goes well.
            The limit grows after a day that used at least half of it, so it stands still on days
            with little or nothing to send, and it stops growing once it is more than twice your
            list. Sending to a small segment uses less of the limit, and the dates move back.
          </p>
        </>
      )}
    </div>
  );
}

/** Limit and sent per day as paired bars; today is the last pair. With a table for screen readers. */
function History({ ramp }: { ramp: Ramp }) {
  const days = [
    ...ramp.days,
    ...(ramp.days.at(-1)?.day === ramp.day
      ? []
      : [{ day: ramp.day, cap: ramp.capToday, sent: ramp.sentToday, bounces: 0, complaints: 0 }]),
  ].slice(-21);
  const max = Math.max(1, ...days.map((d) => Math.max(d.cap, d.sent)));
  const width = 560;
  const height = 96;
  const slot = width / Math.max(days.length, 8);
  const bar = Math.max(3, Math.min(14, slot / 3));
  return (
    <figure className="mt-5 max-w-[640px]">
      <figcaption className="text-[14px] font-[650]">So far</figcaption>
      <svg
        viewBox={`0 0 ${width} ${height + 18}`}
        className="mt-2 h-auto w-full"
        role="img"
        aria-label={`Daily limit and emails sent over the last ${days.length} days`}
      >
        <line x1="0" x2={width} y1={height} y2={height} stroke="var(--chart-grid)" />
        {days.map((d, i) => {
          const x = i * slot + slot / 2;
          const capH = (d.cap / max) * (height - 4);
          const sentH = (d.sent / max) * (height - 4);
          return (
            <g key={d.day}>
              <rect
                x={x - bar - 1}
                y={height - capH}
                width={bar}
                height={capH}
                rx={2}
                fill="var(--chart-2)"
              />
              <rect
                x={x + 1}
                y={height - sentH}
                width={bar}
                height={sentH}
                rx={2}
                fill="var(--chart-1)"
              />
              {(i === days.length - 1 || i % Math.ceil(days.length / 6) === 0) && (
                <text
                  x={x}
                  y={height + 14}
                  textAnchor="middle"
                  fontSize="10"
                  fill="var(--text-muted)"
                >
                  {d.day.slice(8)}/{d.day.slice(5, 7)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex gap-4 text-[12px] text-sub">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-[3px] bg-[var(--chart-2)]"
          />{' '}
          Daily limit
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-[3px] bg-[var(--chart-1)]"
          />{' '}
          Sent
        </span>
      </div>
      <table className="sr-only">
        <caption>Warm-up so far, by day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Daily limit</th>
            <th scope="col">Sent</th>
            <th scope="col">Bounces</th>
            <th scope="col">Complaints</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{d.cap}</td>
              <td>{d.sent}</td>
              <td>{d.bounces}</td>
              <td>{d.complaints}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

// ---- Dialogs -------------------------------------------------------------------------------

interface DialogProps {
  ramp: Ramp;
  channelId: string;
  open: boolean;
  onClose: () => void;
}

function PaceChoice({
  name,
  checked,
  onChange,
  title,
  summary,
  hint,
  result,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  summary: string;
  hint?: string;
  result?: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-control border px-3.5 py-3 transition-colors ${
        checked ? 'border-purple bg-lavender' : 'border-line-control hover:bg-surface-alt'
      }`}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="mt-1 size-4 accent-purple"
      />
      <span className="grid gap-0.5 text-[13.5px] leading-[1.45]">
        <span className="font-semibold">{title}</span>
        <span>{summary}</span>
        {hint && <span className="text-sub">{hint}</span>}
        {result && <span className="tabular font-semibold">{result}</span>}
      </span>
    </label>
  );
}

function PaceDialog({ ramp, channelId, open, onClose }: DialogProps) {
  const update = useUpdateRamp(channelId);
  const group = useId();
  const [cadence] = useCadence(channelId);
  const [choice, setChoice] = useState<RampPaceKey | 'custom'>(ramp.pace);
  const [startCap, setStartCap] = useState(String(ramp.startCap));
  const [growthPct, setGrowthPct] = useState(String(Math.round((ramp.growth - 1) * 100)));
  const options = paceOptions(ramp, false, cadence);
  const custom = customPaceProblem(ramp.sharedOverride ? 'custom' : ramp.kind, startCap, growthPct);
  const chosen: RampPaceValues | undefined =
    choice === 'custom' ? custom.values : options.find((o) => o.key === choice)?.values;
  const same = !!chosen && chosen.startCap === ramp.startCap && chosen.growth === ramp.growth;
  const grown = ramp.capToday > ramp.startCap;

  const close = () => {
    update.reset();
    onClose();
  };
  const save = () => {
    if (!chosen || same) return;
    update.mutate(
      choice === 'custom'
        ? { rampId: ramp.id, startCap: chosen.startCap, growth: chosen.growth }
        : { rampId: ramp.id, pace: choice },
      { onSuccess: close },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Choose a pace"
      description={
        <>
          How fast the daily limit for <span className="font-mono">{ramp.domain}</span> grows.
          Faster reaches your whole list sooner. Slower gives mailbox providers more time to trust
          you.
        </>
      }
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button loading={update.isPending} disabled={!chosen || same} onClick={save}>
            {same ? 'This is the current pace' : `Use ${PACE_NAMES[choice]} pace`}
          </Button>
        </>
      }
    >
      <fieldset className="grid gap-2">
        <legend className="sr-only">Pace</legend>
        {options.map((option) => (
          <PaceChoice
            key={option.key}
            name={group}
            checked={choice === option.key}
            onChange={() => setChoice(option.key)}
            title={option.name}
            summary={paceSummary(option.values)}
            hint={option.hint}
            result={fullListSentence(option.plan, cadence)}
          />
        ))}
        <PaceChoice
          name={group}
          checked={choice === 'custom'}
          onChange={() => setChoice('custom')}
          title="Custom"
          summary="Set the first day and the daily growth yourself."
          {...(choice === 'custom' && custom.values
            ? {
                result: fullListSentence(previewPace(ramp, custom.values, false, cadence), cadence),
              }
            : {})}
        />
        {choice === 'custom' && (
          <div className="grid gap-3 pl-7 sm:grid-cols-2">
            <TextField
              label="Emails on the first day"
              inputMode="numeric"
              value={startCap}
              onChange={(e) => setStartCap(e.target.value)}
              error={custom.startCap}
            />
            <TextField
              label="Growth after a good day (%)"
              inputMode="decimal"
              value={growthPct}
              onChange={(e) => setGrowthPct(e.target.value)}
              error={custom.growth}
            />
          </div>
        )}
      </fieldset>
      {grown && (
        <p className="mt-3 text-[13px] leading-[1.5] text-sub">
          Today&rsquo;s limit of {numberFormat.format(ramp.capToday)} is never lowered by a change
          of pace. What changes is how fast it grows from here.
        </p>
      )}
      {update.error && (
        <div className="mt-3">
          <ErrorNotice title="The pace was not changed" message={update.error.message} />
        </div>
      )}
    </Dialog>
  );
}

function CeilingDialog({ ramp, channelId, open, onClose }: DialogProps) {
  const update = useUpdateRamp(channelId);
  const [cadence] = useCadence(channelId);
  const audience = ramp.plan.audience;
  const [value, setValue] = useState(String(Math.max(ramp.maxCap, audience)));
  const ceiling = Number(value);
  const valid =
    value.trim() !== '' && Number.isInteger(ceiling) && ceiling >= 100 && ceiling <= 10_000_000;
  const preview = valid
    ? projectWarmup(
        {
          status: ramp.status,
          day: ramp.day,
          capToday: ramp.capToday,
          sentToday: ramp.sentToday,
          growth: ramp.growth,
          maxCap: ceiling,
        },
        audience,
        ramp.plan.today,
        undefined,
        WARMUP_CADENCES[cadence],
      )
    : null;
  const close = () => {
    update.reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Raise the ceiling"
      description={
        <>
          Warm-up on <span className="font-mono">{ramp.domain}</span> ends when the daily limit
          reaches the ceiling, now {numberFormat.format(ramp.maxCap)}. Set it to at least your list
          size, so the limit keeps growing step by step until one day covers everyone. This changes
          the ceiling for this publication only.
        </>
      }
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            loading={update.isPending}
            disabled={!valid || ceiling === ramp.maxCap}
            onClick={() =>
              update.mutate({ rampId: ramp.id, maxCap: ceiling }, { onSuccess: close })
            }
          >
            Save ceiling
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <TextField
          label="Ceiling, in emails a day"
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={valid ? undefined : 'Enter a whole number from 100 to 10,000,000.'}
          hint={`Your list has ${subscribers(audience)}.`}
        />
        {preview && (
          <p className="tabular text-[13.5px] leading-[1.5] font-semibold">
            {fullListSentence(preview, cadence)}
          </p>
        )}
        {valid && ceiling < audience && (
          <p className="rounded-control border border-line-app bg-warn-soft px-3.5 py-2.5 text-[13px] leading-[1.5] text-warn">
            That is below your list size. Warm-up would end before one day covers everyone.
          </p>
        )}
        {update.error && (
          <ErrorNotice title="The ceiling was not changed" message={update.error.message} />
        )}
      </div>
    </Dialog>
  );
}

function SkipDialog({ ramp, channelId, open, onClose }: DialogProps) {
  const skip = useSkipRamp(channelId);
  const update = useUpdateRamp(channelId);
  const [volume, setVolume] = useState('');
  const [understood, setUnderstood] = useState(false);
  const daily = Number(volume);
  const valid = volume.trim() !== '' && Number.isInteger(daily) && daily >= 0;
  const audience = ramp.plan.audience;
  const tooLow = valid && daily < audience;
  // What the domain already sends is a safe place to start from, when it is more than today's limit.
  const startAt = Math.min(100_000, daily);
  const canStartThere = tooLow && startAt >= 10 && startAt > ramp.capToday;
  const why = !valid
    ? 'Enter how many emails this domain sends on a normal day.'
    : !understood
      ? 'Tick the box to confirm.'
      : null;

  const close = () => {
    skip.reset();
    update.reset();
    setVolume('');
    setUnderstood(false);
    onClose();
  };
  const error = skip.error ?? update.error;

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Skip warm-up for this domain?"
      description={
        <>
          Skip only if <span className="font-mono">{ramp.domain}</span> already sends email
          regularly from somewhere else, so mailbox providers know it. For a domain that is new to
          sending, skipping is the quickest way to land in spam.
        </>
      }
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Keep warming up
          </Button>
          <Button
            variant="danger"
            loading={skip.isPending}
            disabled={!!why}
            onClick={() =>
              skip.mutate(
                { rampId: ramp.id, confirm: true, dailyVolume: daily },
                { onSuccess: close },
              )
            }
          >
            Skip warm-up
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <TextField
          label="Emails this domain already sends on a normal day"
          inputMode="numeric"
          placeholder="For example 5000"
          value={volume}
          onChange={(e) => setVolume(e.target.value)}
          error={volume.trim() !== '' && !valid ? 'Enter a whole number.' : undefined}
          hint="Your best estimate. It is kept in the audit log with your name."
        />
        {tooLow && (
          <div className="rounded-control border border-line-app bg-warn-soft px-3.5 py-3 text-[13.5px] leading-[1.5] text-warn">
            <p>
              That is less than your list of {subscribers(audience)}. Sending to everyone at once
              would be a jump mailbox providers notice.
              {canStartThere &&
                ` A safer choice is to keep warming up, starting from ${numberFormat.format(startAt)} a day.`}
            </p>
            {canStartThere && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                loading={update.isPending}
                onClick={() =>
                  update.mutate({ rampId: ramp.id, startCap: startAt }, { onSuccess: close })
                }
              >
                Start from {numberFormat.format(startAt)} a day instead
              </Button>
            )}
          </div>
        )}
        <Checkbox
          label="I understand that Swarm will stop limiting how much this domain sends each day"
          hint="It will also stop pausing on its own when bounces or complaints spike. You can start warm-up again at any time."
          checked={understood}
          onChange={setUnderstood}
        />
        {why && <p className="text-[12.5px] text-sub">{why}</p>}
        {error && <ErrorNotice title="Warm-up was not changed" message={error.message} />}
      </div>
    </Dialog>
  );
}

function RestartDialog({ ramp, channelId, open, onClose }: DialogProps) {
  const restart = useRestartRamp(channelId);
  const group = useId();
  const [cadence] = useCadence(channelId);
  const options = paceOptions(ramp, true, cadence);
  const [choice, setChoice] = useState<RampPaceKey>(
    ramp.pace === 'custom' ? 'standard' : ramp.pace,
  );
  const close = () => {
    restart.reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Start warm-up again?"
      description={
        <>
          The daily limit for <span className="font-mono">{ramp.domain}</span> goes back to the
          first day and grows from there. Posts to more people than the limit go out over several
          days. This helps after a long break from sending, or when emails have started landing in
          spam.
        </>
      }
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            loading={restart.isPending}
            onClick={() =>
              restart.mutate({ rampId: ramp.id, confirm: true, pace: choice }, { onSuccess: close })
            }
          >
            Start warm-up again
          </Button>
        </>
      }
    >
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-[13px] font-semibold">Pace</legend>
        {options.map((option) => (
          <PaceChoice
            key={option.key}
            name={group}
            checked={choice === option.key}
            onChange={() => setChoice(option.key)}
            title={option.name}
            summary={paceSummary(option.values)}
            result={fullListSentence(option.plan, cadence)}
          />
        ))}
      </fieldset>
      {ramp.sentToday > 0 && ramp.day === ramp.plan.today && (
        <p className="mt-3 text-[13px] leading-[1.5] text-sub">
          The {numberFormat.format(ramp.sentToday)} emails already sent today count towards
          today&rsquo;s limit, so the next emails go out tomorrow.
        </p>
      )}
      {restart.error && (
        <div className="mt-3">
          <ErrorNotice title="Warm-up was not started" message={restart.error.message} />
        </div>
      )}
    </Dialog>
  );
}
