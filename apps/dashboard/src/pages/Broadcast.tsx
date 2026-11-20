import type { BroadcastReport, BroadcastStats } from '@swarm/domain';
import { Button, Dialog, ErrorNotice, LoadingRows, Pill } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { channelQuery, useChannelFlag } from '../api/queries';
import {
  broadcastQuery,
  broadcastStatsQuery,
  useCancelBroadcast,
  useResendUnopened,
  useResumeBroadcast,
  useLiveBroadcast,
} from '../api/send';
import { ClickMap } from '../send/ClickMap';
import { HoldBackResults } from '../send/HoldBackResults';
import { waitCopy } from '../send/sending-limits';
import { ReportWarmup } from '../send/WarmupCallout';
import { PageHeader } from './Channels';
import {
  Bands,
  BroadcastPill,
  Section,
  formatDateTime,
  numberFormat,
  percentFormat,
} from './common';
import { useTabStatus } from '../shell/tabStatus';

const LIVE = new Set(['queued', 'sending']);

/** "1 person", "2 people". */
const count = (n: number, one: string, many: string) =>
  `${numberFormat.format(n)} ${n === 1 ? one : many}`;

export function BroadcastPage({ broadcastId }: { broadcastId: string }) {
  const [streaming, setStreaming] = useState(false);
  const broadcast = useQuery(broadcastQuery(broadcastId, streaming));
  if (broadcast.isPending) return <LoadingRows label="Loading send report" rows={4} />;
  if (broadcast.error) {
    return (
      <ErrorNotice
        title="Send report not available"
        message={broadcast.error.message}
        action={
          <Link to="/dispatches" className="btn-ghost">
            Back to posts
          </Link>
        }
      />
    );
  }
  return <BroadcastDetail broadcast={broadcast.data} onStreaming={setStreaming} />;
}

/**
 * A send waiting for a sending limit or the email service: what it waits for, who is left, when
 * it goes on, and Resume sending for the publication's admins.
 */
function Waiting({ broadcast, canResume }: { broadcast: BroadcastReport; canResume: boolean }) {
  const resume = useResumeBroadcast(broadcast.id);
  if (!broadcast.waiting) return null;
  const copy = waitCopy(broadcast.waiting);
  return (
    <div
      role="status"
      className="mb-3 grid gap-2 rounded-[8px] bg-warn-soft px-3.5 py-3 text-[13px] leading-[1.5]"
    >
      <p className="font-semibold text-ink">{copy.line}</p>
      <p className="text-sub">{copy.detail}</p>
      {canResume && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant={copy.paused ? 'primary' : 'ghost'}
            size="sm"
            loading={resume.isPending}
            onClick={() => resume.mutate()}
          >
            Resume sending
          </Button>
          {!copy.paused && (
            <span className="text-[12.5px] text-sub">
              Tries now; if the limit still holds, it waits again.
            </span>
          )}
        </div>
      )}
      {resume.error && <ErrorNotice message={resume.error.message} />}
    </div>
  );
}

function BroadcastDetail({
  broadcast,
  onStreaming,
}: {
  broadcast: BroadcastReport;
  onStreaming: (streaming: boolean) => void;
}) {
  const live = LIVE.has(broadcast.status);
  const streaming = useLiveBroadcast(broadcast.id, live);
  useEffect(() => onStreaming(streaming), [onStreaming, streaming]);
  const stats = useQuery(broadcastStatsQuery(broadcast.id, live));
  const channel = useQuery(channelQuery(broadcast.channelId));
  const cancel = useCancelBroadcast(broadcast.id);
  const resend = useResendUnopened(broadcast.id);
  const navigate = useNavigate();
  const resendOn = useChannelFlag(broadcast.channelId, 'resend_unopens') === true;
  const clickMapOn = useChannelFlag(broadcast.channelId, 'click_map') === true;
  const canResend =
    resendOn &&
    (broadcast.status === 'sent' || broadcast.status === 'partially_failed') &&
    ['editor', 'admin', 'owner'].includes(channel.data?.role ?? 'viewer');
  const [confirming, setConfirming] = useState(false);
  const canCancel = live && ['editor', 'admin', 'owner'].includes(channel.data?.role ?? 'viewer');
  const canResume = live && ['admin', 'owner'].includes(channel.data?.role ?? 'viewer');
  const waiting = broadcast.waiting ? waitCopy(broadcast.waiting) : null;
  const handled = broadcast.sentCount + broadcast.failedCount;
  const progress = broadcast.recipientCount ? handled / broadcast.recipientCount : 0;
  // A send in progress shows in the tab, so it can be followed from another one.
  useTabStatus(
    broadcast.status === 'sending'
      ? `Sending ${percentFormat.format(progress)}`
      : broadcast.status === 'queued'
        ? 'Queued'
        : null,
  );

  return (
    <>
      <PageHeader
        title={broadcast.subject || 'Untitled post'}
        subtitle={`From ${broadcast.from.name} <${broadcast.from.address}> · started ${formatDateTime(broadcast.createdAt)}`}
        action={
          <div className="flex flex-wrap items-center gap-3">
            <BroadcastPill status={broadcast.status} />
            {waiting && <Pill tone="neutral">{waiting.paused ? 'Paused' : 'Waiting'}</Pill>}
            <Link
              to="/dispatches/$dispatchId"
              params={{ dispatchId: broadcast.dispatchId }}
              className="btn-ghost"
            >
              Open post
            </Link>
            {canResend && (
              <Button
                variant="ghost"

                loading={resend.isPending}
                onClick={() =>
                  resend.mutate(undefined, {
                    onSuccess: ({ dispatchId }) =>
                      void navigate({ to: '/dispatches/$dispatchId', params: { dispatchId } }),
                  })
                }
              >
                Send again to people who didn’t open
              </Button>
            )}
            {canCancel && (
              <Button variant="danger" onClick={() => setConfirming(true)}>
                Stop sending
              </Button>
            )}
          </div>
        }
      />

      {/* Bands, not boxes; the Links table scrolls in its own box instead of widening a phone's page. */}
      <Bands ruled>
        <Section
          title={live ? 'Sending' : 'Delivery'}
          description={
            live
              ? broadcast.status === 'queued'
                ? `Working out who receives this. ${streaming ? 'Progress updates live.' : 'Progress updates every few seconds.'}`
                : `${broadcast.bestTime?.personal ? 'Readers get this at their best time, for up to 24 hours from the start.' : 'Messages go out in batches within the warm-up limits.'} ${streaming ? 'Progress updates live.' : 'Progress updates every few seconds.'}`
              : broadcast.completedAt
                ? `Finished ${formatDateTime(broadcast.completedAt)}.`
                : undefined
          }
        >
          {broadcast.failureReason && (
            <ErrorNotice title="Sending stopped" message={broadcast.failureReason} />
          )}
          <Waiting broadcast={broadcast} canResume={canResume} />
          <div className="mt-1">
            <div className="flex items-baseline justify-between text-[13px]">
              <span className="tabular font-semibold">
                {numberFormat.format(handled)} of {numberFormat.format(broadcast.recipientCount)}
              </span>
              <span className="tabular text-sub">{percentFormat.format(progress)}</span>
            </div>
            <div
              role="progressbar"
              aria-label="Messages handed to the mail provider"
              aria-valuemin={0}
              aria-valuemax={broadcast.recipientCount}
              aria-valuenow={handled}
              className="mt-2 h-2 overflow-hidden rounded-pill bg-surface-alt"
            >
              <div
                className="h-full rounded-pill bg-purple transition-[width]"
                style={{ width: `${Math.min(100, progress * 100)}%` }}
              />
            </div>
            {broadcast.failedCount > 0 && (
              <p className="mt-2 text-[12.5px] text-danger">
                {numberFormat.format(broadcast.failedCount)} could not be sent (the mail provider
                refused the address).
              </p>
            )}
            {broadcast.bestTime && broadcast.recipientCount > 0 && (
              <p className="mt-2 text-[13px] text-sub">
                {broadcast.bestTime.limitedByWarmUp
                  ? 'Today’s warm-up limit couldn’t reach everyone, so everyone got the chosen time, most engaged first.'
                  : `${numberFormat.format(broadcast.bestTime.personal)} ${broadcast.bestTime.personal === 1 ? 'reader' : 'readers'} got a personal time; ${numberFormat.format(broadcast.bestTime.chosenTime)} got the chosen time.`}
              </p>
            )}
            {broadcast.status === 'sending' && (
              <ReportWarmup
                channelId={broadcast.channelId}
                fromAddress={broadcast.from.address}
                total={broadcast.recipientCount}
                handled={handled}
              />
            )}
          </div>
        </Section>

        <HoldBackResults broadcast={broadcast} />

        {stats.error && <ErrorNotice message={stats.error.message} />}
        {stats.data && <Stats stats={stats.data} />}
        {clickMapOn && <ClickMap broadcastId={broadcast.id} live={live} />}
      </Bands>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Stop this send?"
        description="Messages already handed to the mail provider can't be recalled. Nobody else receives it, and the post can't be sent again."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep sending
            </Button>
            <Button
              variant="danger"
              loading={cancel.isPending}
              onClick={() => cancel.mutate(undefined, { onSuccess: () => setConfirming(false) })}
            >
              Stop sending
            </Button>
          </>
        }
      >
        {cancel.error && <ErrorNotice message={cancel.error.message} />}
      </Dialog>
    </>
  );
}

/** A figure in a ruled row: the label, the number, and what it is made of. */
function Figure({
  label,
  value,
  detail,
  small = false,
}: {
  label: string;
  value: string;
  detail?: string;
  small?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-sub">{label}</dt>
      <dd
        className={`tabular mt-1 leading-[1.1] font-semibold tracking-[-0.01em] ${small ? 'text-[20px]' : 'text-[28px]'}`}
      >
        {value}
      </dd>
      {detail && <dd className="tabular mt-1 text-[13px] text-sub">{detail}</dd>}
    </div>
  );
}

function Stats({ stats }: { stats: BroadcastStats }) {
  const cost = stats.cost.amountMicros / 1_000_000;
  const { tracking } = stats;
  return (
    <>
      <Section
        title="Results"
        description="Opens and clicks count people, never privacy proxies or link scanners."
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
          <Figure
            label="Delivered"
            value={numberFormat.format(stats.delivered)}
            detail={`${numberFormat.format(stats.sent)} sent`}
          />
          {tracking.opens ? (
            <Figure
              label="Opened by people"
              value={percentFormat.format(stats.openRate)}
              detail={`${count(stats.humanOpens, 'person', 'people')} · ${count(stats.machineOpens, 'privacy proxy', 'privacy proxies')}`}
            />
          ) : (
            <Figure label="Opened by people" value="Not tracked" detail="Open tracking was off" />
          )}
          {tracking.clicks ? (
            <Figure
              label="Clicked"
              value={numberFormat.format(stats.humanClicks)}
              detail={`${percentFormat.format(stats.clickToOpenRate)} of openers · ${count(stats.uniqueClicks - stats.humanClicks, 'scanner', 'scanners')}`}
            />
          ) : (
            <Figure label="Clicked" value="Not tracked" detail="Click tracking was off" />
          )}
          <Figure label="Unsubscribed" value={numberFormat.format(stats.unsubscribed)} />
        </dl>
        {tracking.untracked > 0 && (tracking.opens || tracking.clicks) && (
          <p className="mt-4 rounded-control bg-surface-alt px-3 py-2.5 text-[13px] leading-[1.5]">
            {count(tracking.untracked, 'subscriber', 'subscribers')} asked not to be tracked. Their
            emails had no tracking, so their opens and clicks aren’t counted and the open rate is
            worked out from everyone else.
          </p>
        )}
        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-line pt-5 md:grid-cols-4">
          <Figure
            small
            label="Bounce rate"
            value={percentFormat.format(stats.bounceRate)}
            detail={`${numberFormat.format(stats.bounced)} bounced`}
          />
          <Figure
            small
            label="Complaint rate"
            value={percentFormat.format(stats.complaintRate)}
            detail={`${numberFormat.format(stats.complained)} marked as spam`}
          />
          <Figure small label="Failed" value={numberFormat.format(stats.failed)} />
          <Figure
            small
            label="Sending cost"
            value={`$${cost < 0.01 && cost > 0 ? cost.toFixed(4) : cost.toFixed(2)}`}
            detail="At $0.10 per 1,000 messages"
          />
        </dl>
      </Section>
      <Section
        title="Links"
        description={
          tracking.clicks
            ? 'People counts each person once, and their clicks count every time they clicked. All clicks adds link scanners and bots. Each link redirects through your link domain.'
            : 'Click tracking was off for this send: links went straight to their address, so there are no clicks to count.'
        }
      >
        {stats.links.length === 0 ? (
          <p className="text-[13.5px] text-sub">This post had no links.</p>
        ) : !tracking.clicks ? null : (
          // A region you can reach with Tab, so the keyboard can scroll it on a phone.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region
          <div className="overflow-x-auto" role="region" aria-label="Links table" tabIndex={0}>
            <table className="w-full min-w-[480px] text-left text-[13.5px]">
              <thead>
                <tr className="table-head">
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Link
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    People
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    Their clicks
                  </th>
                  <th scope="col" className="py-2 pl-3 text-right font-semibold">
                    All clicks
                  </th>
                </tr>
              </thead>
              <tbody>
                {stats.links.map((link) => (
                  <tr key={link.position} className="border-t border-line">
                    <td
                      className="max-w-[420px] truncate py-2.5 pr-3 font-mono text-[12.5px]"
                      title={link.url}
                    >
                      {link.destination ?? link.url}
                      {link.destination && (
                        <span className="block truncate text-[11.5px] text-sub">{link.url}</span>
                      )}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right font-semibold">
                      {numberFormat.format(link.humanPeople)}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">
                      {numberFormat.format(link.humanClicks)}
                    </td>
                    <td className="tabular py-2.5 pl-3 text-right text-sub">
                      {numberFormat.format(link.clicks)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
