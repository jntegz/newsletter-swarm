// The deliverability check-up at the top of the Deliverability page: one verdict, then every
// finding with what it means, how to fix it and where. Contract: docs/deliverability.md; the
// guide for readers of this panel is docs/deliverability-guide.md.
import type {
  CheckupFinding,
  CheckupLinkTarget,
  CheckupSeverity,
  DeliverabilityCheckup,
} from '@swarm/domain';
import { Button, ErrorNotice, Skeleton } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, type ReactNode } from 'react';
import { checkupQuery } from '../api/deliverability';
import * as Icon from '../icons';
import {
  GROUP_COPY,
  SCORE_NOTE,
  SEVERITY_WORD,
  checkedAgo,
  findingKey,
  groupFindings,
  verdictCopy,
} from './checkup-helpers';

/** Where the page's own detail sections start, for findings that point at them. */
export const CHECKUP_DETAILS_ID = 'deliverability-details';

const TONE: Record<CheckupSeverity, { mark: string; icon: ReactNode }> = {
  problem: {
    mark: 'bg-danger-soft text-danger',
    icon: <Icon.Blocked size={15} />,
  },
  warning: {
    mark: 'bg-warn-soft text-warn',
    icon: <Icon.Alert size={15} />,
  },
  unknown: {
    mark: 'bg-surface-alt text-sub',
    icon: (
      <span aria-hidden="true" className="text-[13px] leading-none font-bold">
        ?
      </span>
    ),
  },
  good: {
    mark: 'bg-success-soft text-success',
    icon: <Icon.Check size={15} strokeWidth={2.5} />,
  },
};

const VERDICT_TONE = {
  danger: 'text-danger',
  warn: 'text-warn',
  success: 'text-success',
} as const;

export function CheckupSection({ channelId }: { channelId: string }) {
  const titleId = useId();
  const checkup = useQuery(checkupQuery(channelId));
  const running = checkup.isFetching;

  return (
    <section aria-labelledby={titleId} className="card-app p-5 sm:p-6" aria-busy={running}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={titleId} className="text-[16px] font-semibold tracking-[-0.01em]">
            Check-up
          </h2>
          <p className="mt-1 text-[13px] leading-[1.5] text-sub">
            Everything that decides whether your email reaches the inbox, checked in one go.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {checkup.data && (
            <span className="text-[12.5px] text-muted" role="status">
              {running ? 'Checking…' : `Checked ${checkedAgo(checkup.data.checkedAt)}`}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon.Refresh size={15} />}
            loading={running && !checkup.isPending}
            disabled={checkup.isPending}
            onClick={() => void checkup.refetch()}
          >
            Run again
          </Button>
        </div>
      </div>

      <div className="mt-4">
        {checkup.isPending && (
          <div role="status" aria-label="Running the check-up" className="grid gap-2.5">
            <Skeleton className="h-[72px]" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <p className="text-[13px] text-sub">
              Reading your DNS records and your last 30 days of sending. This takes a few seconds.
            </p>
          </div>
        )}
        {checkup.error && !checkup.data && (
          <ErrorNotice
            title="The check-up didn’t run"
            message={`${checkup.error.message} Nothing was changed. The sections below still show your numbers.`}
            action={
              <Button variant="ghost" size="sm" onClick={() => void checkup.refetch()}>
                Try again
              </Button>
            }
          />
        )}
        {checkup.data && (
          <div className={`transition-opacity ${running ? 'opacity-70' : ''}`}>
            {checkup.error && (
              <div className="mb-3">
                <ErrorNotice
                  title="Couldn’t run it again"
                  message={`${checkup.error.message} Showing the last result.`}
                />
              </div>
            )}
            <Verdict checkup={checkup.data} />
            <Findings checkup={checkup.data} channelId={channelId} />
          </div>
        )}
      </div>
    </section>
  );
}

function Verdict({ checkup }: { checkup: DeliverabilityCheckup }) {
  const verdict = verdictCopy(checkup);
  const { counts } = checkup;
  return (
    <div className="grid gap-4 rounded-[14px] bg-surface-alt p-4 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-5 sm:p-5">
      <div className="flex items-baseline gap-1.5 sm:block sm:text-center">
        <p className="text-[40px] leading-none font-semibold tracking-[-0.02em] tabular-nums">
          <span className="sr-only">Score: </span>
          {checkup.score}
          <span className="text-[15px] font-medium text-muted" aria-hidden="true">
            {' '}
            / 100
          </span>
          <span className="sr-only"> out of 100</span>
        </p>
      </div>
      <div className="min-w-0">
        <p className={`text-[17px] font-semibold tracking-[-0.01em] ${VERDICT_TONE[verdict.tone]}`}>
          {verdict.headline}
        </p>
        <p className="mt-1 max-w-[70ch] text-[13.5px] leading-[1.5] text-sub">{verdict.detail}</p>
        <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-sub">
          <Count n={counts.problem} one="problem" many="problems" severity="problem" />
          <Count n={counts.warning} one="warning" many="warnings" severity="warning" />
          <Count n={counts.unknown} one="couldn’t check" many="couldn’t check" severity="unknown" />
          <Count n={counts.good} one="good" many="good" severity="good" />
        </ul>
        <details className="mt-2 text-[12.5px] text-sub">
          <summary className="cursor-pointer underline underline-offset-[3px]">
            How the score works
          </summary>
          <p className="mt-1.5 max-w-[70ch] leading-[1.5]">
            {SCORE_NOTE} It is a quick way to see progress, not a promise from any mailbox provider.
            {checkup.from && (
              <>
                {' '}
                Checked for your default sender, <b className="break-all">{checkup.from.address}</b>
                .
              </>
            )}
          </p>
        </details>
      </div>
    </div>
  );
}

function Mark({ severity }: { severity: CheckupSeverity }) {
  return (
    <span
      aria-hidden="true"
      className={`grid size-[22px] shrink-0 place-items-center rounded-full ${TONE[severity].mark}`}
    >
      {TONE[severity].icon}
    </span>
  );
}

function Count({
  n,
  one,
  many,
  severity,
}: {
  n: number;
  one: string;
  many: string;
  severity: CheckupSeverity;
}) {
  return (
    <li className={`flex items-center gap-1.5 ${n === 0 ? 'opacity-60' : ''}`}>
      <Mark severity={severity} />
      <span>
        <b className="text-ink tabular-nums">{n}</b> {n === 1 ? one : many}
      </span>
    </li>
  );
}

function Findings({ checkup, channelId }: { checkup: DeliverabilityCheckup; channelId: string }) {
  const groups = groupFindings(checkup.findings);
  return (
    <div className="mt-5 grid gap-6">
      {groups.map((group) => {
        const copy = GROUP_COPY[group.severity];
        const heading = (
          <>
            <span className="text-[14.5px] font-semibold">{copy.title}</span>{' '}
            <span className="text-[13px] text-muted tabular-nums">({group.findings.length})</span>
          </>
        );
        // What is fine stays folded away: it is reassurance, not a to-do list.
        if (group.severity === 'good') {
          return (
            <details key={group.severity} className="group border-t border-line pt-4">
              <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
                <Icon.ChevronRight
                  size={16}
                  className="shrink-0 text-sub transition-transform group-open:rotate-90"
                />
                <h3>{heading}</h3>
              </summary>
              <ul className="mt-3 grid gap-2.5">
                {group.findings.map((finding) => (
                  <li key={findingKey(finding)} className="flex items-start gap-2.5">
                    <Mark severity="good" />
                    <div className="min-w-0">
                      <p className="text-[13.5px] font-medium break-words">
                        <span className="sr-only">{SEVERITY_WORD.good}: </span>
                        {finding.title}
                      </p>
                      <p className="mt-0.5 max-w-[80ch] text-[12.5px] leading-[1.5] text-sub">
                        {finding.meaning}
                      </p>
                      <FindingLinks finding={finding} channelId={channelId} quiet />
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          );
        }
        return (
          <div key={group.severity}>
            <h3>{heading}</h3>
            <p className="mt-0.5 text-[12.5px] text-sub">{copy.hint}</p>
            <ol className="mt-3 grid gap-3">
              {group.findings.map((finding) => (
                <li key={findingKey(finding)}>
                  <FindingCard finding={finding} channelId={channelId} />
                </li>
              ))}
            </ol>
          </div>
        );
      })}
    </div>
  );
}

function FindingCard({ finding, channelId }: { finding: CheckupFinding; channelId: string }) {
  return (
    <article className="rounded-[14px] border border-line p-4">
      <div className="flex items-start gap-2.5">
        <div className="mt-px">
          <Mark severity={finding.severity} />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-[14.5px] leading-[1.4] font-semibold break-words">
            <span className="sr-only">{SEVERITY_WORD[finding.severity]}: </span>
            {finding.title}
          </h4>
          <p className="mt-1 max-w-[80ch] text-[13.5px] leading-[1.55] break-words text-sub">
            {finding.meaning}
          </p>
          {finding.fix.length > 0 && (
            <div className="mt-3">
              <p className="text-[12.5px] font-semibold text-muted">
                {finding.fix.length === 1 ? 'What to do' : 'How to fix it'}
              </p>
              {finding.fix.length === 1 ? (
                <p className="mt-1 max-w-[80ch] text-[13.5px] leading-[1.55] break-words">
                  {finding.fix[0]}
                </p>
              ) : (
                <ol className="mt-1 grid max-w-[80ch] list-decimal gap-1 pl-5 text-[13.5px] leading-[1.55] marker:text-muted">
                  {finding.fix.map((step) => (
                    <li key={step} className="break-words">
                      {step}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
          <FindingLinks finding={finding} channelId={channelId} />
        </div>
      </div>
    </article>
  );
}

function FindingLinks({
  finding,
  channelId,
  quiet = false,
}: {
  finding: CheckupFinding;
  channelId: string;
  quiet?: boolean;
}) {
  if (!finding.link && !finding.external.length) return null;
  const inside = quiet
    ? 'text-[12.5px] font-semibold underline underline-offset-[3px]'
    : 'btn-ghost btn-sm';
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${quiet ? 'mt-1' : 'mt-3'}`}>
      {finding.link && (
        <DashboardLink to={finding.link.to} channelId={channelId} className={inside}>
          {finding.link.label}
        </DashboardLink>
      )}
      {finding.external.map((link) => (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[13px] font-semibold break-words underline underline-offset-[3px]"
        >
          {link.label}
          <span className="sr-only"> (opens in a new tab)</span>
          <span aria-hidden="true"> ↗</span>
        </a>
      ))}
    </div>
  );
}

function DashboardLink({
  to,
  channelId,
  className,
  children,
}: {
  to: CheckupLinkTarget;
  channelId: string;
  className: string;
  children: ReactNode;
}) {
  switch (to) {
    case 'sending':
      return (
        <Link to="/channels/$channelId/sending" params={{ channelId }} className={className}>
          {children}
        </Link>
      );
    case 'publication':
      return (
        <Link to="/channels/$channelId" params={{ channelId }} className={className}>
          {children}
        </Link>
      );
    case 'forms':
      return (
        <Link to="/forms" search={{ channel: channelId }} className={className}>
          {children}
        </Link>
      );
    case 'subscribers':
      return (
        <Link to="/members" search={{ channel: channelId }} className={className}>
          {children}
        </Link>
      );
    case 'deliverability':
      return (
        <a href={`#${CHECKUP_DETAILS_ID}`} className={className}>
          {children}
        </a>
      );
    case 'email_check':
      return (
        <Link to="/apps" search={{ app: 'debounce' }} className={className}>
          {children}
        </Link>
      );
  }
}
