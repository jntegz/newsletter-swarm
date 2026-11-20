// Deliverability Center: DMARC alignment per sending domain, mailbox providers, complaints,
// Reputation Ramp history and dedicated sending, for one Channel. Contract: docs/deliverability.md.
import type {
  Channel,
  DedicatedSending,
  DeliverabilityOverview,
  DmarcDomainReport,
  DmarcDomainSummary,
  RampHistory,
} from '@swarm/domain';
import {
  Button,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  SelectField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { channelQuery } from '../api/queries';
import { DomainHealthSection, ReputationGuide } from './DomainHealth';
import {
  dedicatedQuery,
  deliverabilityQuery,
  dmarcQuery,
  useCheckDedicatedIp,
  useCreateConfigurationSet,
  useRequestDedicatedIp,
  type DayRange,
} from '../api/deliverability';
import {
  DEDICATED_IP_LABEL,
  GAUGE_MARKS,
  PROVIDER_LABEL,
  STANDING,
  alignmentPercent,
  formatRate,
  gaugePosition,
} from '../send/deliverability-helpers';
import { CHECKUP_DETAILS_ID, CheckupSection } from '../send/Checkup';
import { dayOf, lastDays, niceMax, tickIndexes } from '../site/helpers';
import { PageHeader } from './Channels';
import { Section, formatDateTime, numberFormat } from './common';
import { CopyButton } from './Sending';

type Preset = '7' | '30' | '90';

const shortDay = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const formatDay = (day: string) => shortDay.format(new Date(`${day}T00:00:00Z`));

/** Managed dedicated IPs are billed by AWS; the price is theirs, so we link it, not copy it. */
const SES_PRICING_URL = 'https://aws.amazon.com/ses/pricing/';

export function DeliverabilityPage({ channelId }: { channelId: string }) {
  const channel = useQuery(channelQuery(channelId));
  if (channel.isPending) return <LoadingRows label="Loading publication" rows={4} />;
  if (channel.error)
    return <ErrorNotice title="Publication not available" message={channel.error.message} />;
  return <Deliverability channel={channel.data} />;
}

function Deliverability({ channel }: { channel: Channel }) {
  const admin = channel.role === 'admin' || channel.role === 'owner';
  const [today] = useState(() => dayOf(Date.now()));
  const [preset, setPreset] = useState<Preset>('30');
  const range = lastDays(Number(preset), today);
  const overview = useQuery(deliverabilityQuery(channel.id, range));

  return (
    <>
      <PageHeader
        title="Deliverability"
        subtitle={`How mailbox providers see ${channel.name}.`}
        action={
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-[180px]">
              <SelectField
                label="Date range"
                value={preset}
                onChange={(e) => setPreset(e.target.value as Preset)}
                options={[
                  { value: '7', label: 'Last 7 days' },
                  { value: '30', label: 'Last 30 days' },
                  { value: '90', label: 'Last 90 days' },
                ]}
              />
            </div>
            <Link
              to="/channels/$channelId/sending"
              params={{ channelId: channel.id }}
              className="btn-ghost"
            >
              Sending settings
            </Link>
          </div>
        }
      />
      <div className="mb-5">
        <CheckupSection channelId={channel.id} />
      </div>
      {overview.isPending && <LoadingRows label="Loading deliverability" rows={5} />}
      {overview.error && <ErrorNotice message={overview.error.message} />}
      {overview.data && (
        <div
          id={CHECKUP_DETAILS_ID}
          className={`grid scroll-mt-4 grid-cols-1 gap-5 transition-opacity ${overview.isFetching ? 'opacity-70' : ''}`}
          aria-busy={overview.isFetching}
        >
          <DomainHealthSection domains={overview.data.domains} range={range} />
          <Dmarc channel={channel} domains={overview.data.domains} range={range} />
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[3fr_2fr]">
            <Providers overview={overview.data} />
            <Complaints overview={overview.data} />
          </div>
          <RampHistorySection ramps={overview.data.ramps} />
          <Dedicated channelId={channel.id} admin={admin} />
          <ReputationGuide channelId={channel.id} domains={overview.data.domains} />
        </div>
      )}
    </>
  );
}

function Kpi({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string | undefined;
}) {
  return (
    <div className="rounded-card-app border border-line-app bg-surface p-4">
      <p className="text-[11px] text-sub">{label}</p>
      <p className="tabular mt-1 text-[25px] leading-tight font-bold tracking-[-0.03em]">{value}</p>
      {detail && <p className="tabular mt-1 text-[12px] text-sub">{detail}</p>}
    </div>
  );
}

// ---- DMARC ---------------------------------------------------------------------------------

function Dmarc({
  channel,
  domains,
  range,
}: {
  channel: Channel;
  domains: DmarcDomainSummary[];
  range: DayRange;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const selected = domains.find((d) => d.sendingDomainId === picked) ?? domains[0];

  if (!selected) {
    return (
      <Section
        title="DMARC reports"
        description="Mailbox providers send daily reports of who sent mail as your domain and whether it passed."
      >
        <EmptyState
          title="No sending domain yet"
          action={
            <Link
              to="/channels/$channelId/sending"
              params={{ channelId: channel.id }}
              className="btn-ghost btn-sm"
            >
              Add a sending domain
            </Link>
          }
        >
          Reports need your own domain. Mail from the shared Swarm domain is covered by the
          platform’s own DMARC record.
        </EmptyState>
      </Section>
    );
  }

  return (
    <Section
      title="DMARC reports"
      description="Mailbox providers send daily reports of who sent mail as your domain and whether SPF or DKIM aligned with it."
      action={
        domains.length > 1 ? (
          <div className="w-[240px]">
            <SelectField
              label="Domain"
              value={selected.sendingDomainId}
              onChange={(e) => setPicked(e.target.value)}
              options={domains.map((d) => ({ value: d.sendingDomainId, label: d.domain }))}
            />
          </div>
        ) : undefined
      }
    >
      <DomainReport key={selected.sendingDomainId} summary={selected} range={range} />
    </Section>
  );
}

function DomainReport({ summary, range }: { summary: DmarcDomainSummary; range: DayRange }) {
  const report = useQuery(dmarcQuery(summary.sendingDomainId, range));
  if (report.isPending) return <LoadingRows label="Loading DMARC reports" rows={3} />;
  if (report.error) return <ErrorNotice message={report.error.message} />;
  const data = report.data;
  if (data.totals.messages === 0) return <NoReports report={data} />;
  const rate = alignmentPercent(data.totals.aligned, data.totals.messages);
  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi
          label="Aligned"
          value={rate === null ? '—' : `${rate}%`}
          detail="Passed DMARC through SPF or DKIM"
        />
        <Kpi label="Messages reported" value={numberFormat.format(data.totals.messages)} />
        <Kpi label="Failed DMARC" value={numberFormat.format(data.totals.failed)} />
        <Kpi
          label="Last report"
          value={data.lastReportAt ? formatDay(data.lastReportAt.slice(0, 10)) : '—'}
          detail={data.reporters.map((r) => r.orgName).join(', ') || undefined}
        />
      </div>
      {data.reportsConfigured === false && <RecordHint report={data} />}
      <AlignmentChart report={data} />
      <FailingSources report={data} />
    </div>
  );
}

function RecordHint({ report }: { report: DmarcDomainReport }) {
  return (
    <div className="rounded-card-app border border-line-app bg-surface-alt px-4 py-3 text-[13px]">
      <p>
        The DMARC record published for {report.domain} doesn’t send reports here any more. Replace
        it with this one to keep this page up to date:
      </p>
      <RecordLine name={report.recommendedRecord.name} value={report.recommendedRecord.value} />
    </div>
  );
}

function RecordLine({ name, value }: { name: string; value: string }) {
  return (
    <dl className="mt-2 grid gap-1 font-mono text-[12.5px] sm:grid-cols-[110px_1fr]">
      <dt className="font-sans text-sub">TXT name</dt>
      <dd className="flex items-start gap-1 break-all">
        {name}
        <CopyButton value={name} label="DMARC record name" />
      </dd>
      <dt className="font-sans text-sub">Value</dt>
      <dd className="flex items-start gap-1 break-all">
        {value}
        <CopyButton value={value} label="DMARC record value" />
      </dd>
    </dl>
  );
}

function NoReports({ report }: { report: DmarcDomainReport }) {
  return (
    <EmptyState title={`No reports for ${report.domain} in this range`}>
      <p>
        Gmail, Outlook, Yahoo and others send a report a day once your DMARC record asks for them.
        Publish this TXT record at your DNS provider (it replaces any _dmarc record you have now);
        the first reports arrive within a day or two of sending.
      </p>
      <div className="mt-3 text-left">
        <RecordLine name={report.recommendedRecord.name} value={report.recommendedRecord.value} />
      </div>
      {report.reportsConfigured === true && (
        <p className="mt-3">Your record already asks for reports. They will appear here.</p>
      )}
    </EmptyState>
  );
}

function AlignmentChart({ report }: { report: DmarcDomainReport }) {
  const days = report.byDay;
  const max = niceMax(Math.max(0, ...days.map((d) => d.aligned + d.failed)));
  const width = 720;
  const height = 160;
  const left = 40;
  const slot = (width - left) / Math.max(1, days.length);
  const bar = Math.max(2, Math.min(18, slot * 0.6));
  const ticks = new Set(tickIndexes(days.length));
  return (
    <figure>
      <svg
        viewBox={`0 0 ${width} ${height + 20}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Messages reported per day for ${report.domain}, aligned and failed`}
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={left}
              x2={width}
              y1={height - f * height}
              y2={height - f * height}
              stroke="var(--chart-grid)"
            />
            <text
              x={left - 6}
              y={height - f * height + 4}
              textAnchor="end"
              fontSize="10"
              fill="var(--text-muted)"
            >
              {numberFormat.format(Math.round(max * f))}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = left + i * slot + slot / 2;
          const alignedH = (d.aligned / max) * height;
          const failedH = (d.failed / max) * height;
          return (
            <g key={d.day}>
              <rect
                x={x - bar / 2}
                y={height - alignedH}
                width={bar}
                height={alignedH}
                fill="var(--chart-1)"
              />
              <rect
                x={x - bar / 2}
                y={height - alignedH - failedH}
                width={bar}
                height={failedH}
                fill="var(--chart-3)"
              >
                <title>{`${formatDay(d.day)}: ${numberFormat.format(d.aligned)} aligned, ${numberFormat.format(d.failed)} failed`}</title>
              </rect>
              {ticks.has(i) && (
                <text
                  x={x}
                  y={height + 14}
                  textAnchor="middle"
                  fontSize="10"
                  fill="var(--text-muted)"
                >
                  {formatDay(d.day)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 flex gap-4 text-[11.5px] text-sub">
        <Legend color="bg-[var(--chart-1)]" label="Aligned" />
        <Legend color="bg-[var(--chart-3)]" label="Failed DMARC" />
      </figcaption>
      <table className="sr-only">
        <caption>DMARC results by day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Aligned</th>
            <th scope="col">Failed</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{d.aligned}</td>
              <td>{d.failed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden="true" className={`inline-block size-2.5 rounded-[3px] ${color}`} /> {label}
    </span>
  );
}

const yesNo = (value: boolean) => (
  <Pill tone={value ? 'success' : 'danger'}>{value ? 'Aligned' : 'Not aligned'}</Pill>
);

function FailingSources({ report }: { report: DmarcDomainReport }) {
  if (!report.failingSources.length) {
    return (
      <p className="text-[13.5px] text-sub">
        Every reported source aligned SPF and DKIM in this range.
      </p>
    );
  }
  return (
    <div>
      <h3 className="mb-2 text-[14px] font-semibold">Sources with problems</h3>
      <p className="mb-3 text-[12.5px] text-sub">
        Servers that sent mail as {report.domain} without aligning SPF or DKIM. Unknown servers
        failing DMARC are often forwarding or spoofing; a service you use that fails needs its own
        DKIM set up.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-[12.5px]">
          <thead>
            <tr className="table-head">
              <th scope="col" className="py-1.5 pr-3 font-semibold">
                Source IP
              </th>
              <th scope="col" className="px-2 py-1.5 text-right font-semibold">
                Messages
              </th>
              <th scope="col" className="px-2 py-1.5 font-semibold">
                DMARC
              </th>
              <th scope="col" className="px-2 py-1.5 font-semibold">
                SPF
              </th>
              <th scope="col" className="px-2 py-1.5 font-semibold">
                DKIM
              </th>
              <th scope="col" className="px-2 py-1.5 font-semibold">
                Applied
              </th>
              <th scope="col" className="py-1.5 pl-2 font-semibold">
                Reported by
              </th>
            </tr>
          </thead>
          <tbody>
            {report.failingSources.map((s) => (
              <tr
                key={`${s.sourceIp}-${s.disposition}-${s.spfAligned}-${s.dkimAligned}-${s.headerFrom}`}
                className="border-t border-line align-top"
              >
                <td className="py-2 pr-3 font-mono break-all">{s.sourceIp}</td>
                <td className="tabular px-2 py-2 text-right">{numberFormat.format(s.count)}</td>
                <td className="px-2 py-2">
                  <Pill tone={s.dmarcPass ? 'success' : 'danger'}>
                    {s.dmarcPass ? 'Passed' : 'Failed'}
                  </Pill>
                </td>
                <td className="px-2 py-2">{yesNo(s.spfAligned)}</td>
                <td className="px-2 py-2">{yesNo(s.dkimAligned)}</td>
                <td className="px-2 py-2 capitalize">{s.disposition}</td>
                <td className="py-2 pl-2 text-sub">{s.reporters.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Mailbox providers and complaints ------------------------------------------------------

function Providers({ overview }: { overview: DeliverabilityOverview }) {
  const total = overview.providers.reduce((sum, p) => sum + p.sent, 0);
  return (
    <Section
      title="Mailbox providers"
      description={`Posts sent ${formatDay(overview.from)} – ${formatDay(overview.to)}, by where subscribers read them. Opens are human opens only.`}
    >
      {total === 0 ? (
        <p className="text-[13.5px] text-sub">Nothing was sent in this range.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-[12.5px]">
            <thead>
              <tr className="table-head">
                <th scope="col" className="py-1.5 pr-3 font-semibold">
                  Provider
                </th>
                <th scope="col" className="px-2 py-1.5 font-semibold">
                  Share of mail
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-semibold">
                  Delivered
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-semibold">
                  Bounced
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-semibold">
                  Complaints
                </th>
                <th scope="col" className="py-1.5 pl-2 text-right font-semibold">
                  Opened
                </th>
              </tr>
            </thead>
            <tbody>
              {overview.providers
                .filter((p) => p.sent > 0)
                .map((p) => (
                  <tr key={p.provider} className="border-t border-line">
                    <td className="py-2 pr-3 font-semibold">{PROVIDER_LABEL[p.provider]}</td>
                    <td className="px-2 py-2">
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="h-[5px] w-24 overflow-hidden rounded-pill bg-[var(--meter-track)]"
                        >
                          <span
                            className="block h-full rounded-pill bg-purple"
                            style={{ width: `${(p.sent / total) * 100}%` }}
                          />
                        </span>
                        <span className="tabular">{formatRate(p.sent / total)}</span>
                      </span>
                    </td>
                    <td className="tabular px-2 py-2 text-right">
                      {numberFormat.format(p.delivered)}
                    </td>
                    <td className="tabular px-2 py-2 text-right">{formatRate(p.bounceRate)}</td>
                    <td
                      className={`tabular px-2 py-2 text-right ${p.complaintStanding === 'over' ? 'font-semibold text-danger' : ''}`}
                    >
                      {formatRate(p.complaintRate)}
                    </td>
                    <td className="tabular py-2 pl-2 text-right">{formatRate(p.openRate)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Complaints({ overview }: { overview: DeliverabilityOverview }) {
  const { complaints } = overview;
  const standing = STANDING[complaints.standing];
  const position = gaugePosition(complaints.rate);
  return (
    <Section
      title="Complaint rate"
      description="Subscribers who marked a post as spam, out of everything delivered. Gmail asks bulk senders to stay below 0.1% and never reach 0.3%."
    >
      <div className="flex items-baseline gap-3">
        <p className="tabular text-[25px] leading-tight font-bold tracking-[-0.03em]">
          {formatRate(complaints.rate)}
        </p>
        {complaints.rate !== null && <Pill tone={standing.tone}>{standing.label}</Pill>}
      </div>
      <p className="tabular mt-1 text-[12px] text-sub">
        {numberFormat.format(complaints.complained)} of {numberFormat.format(complaints.delivered)}{' '}
        delivered
      </p>
      <div
        className="relative mt-5 mb-6"
        role="meter"
        aria-label="Complaint rate"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={complaints.rate ?? 0}
        aria-valuetext={formatRate(complaints.rate)}
      >
        <div className="h-[8px] overflow-hidden rounded-pill bg-[var(--meter-track)]">
          <div
            className={`h-full rounded-pill ${complaints.standing === 'over' ? 'bg-danger' : complaints.standing === 'watch' ? 'bg-scheduled' : 'bg-success'}`}
            style={{ width: `${position * 100}%` }}
          />
        </div>
        {GAUGE_MARKS.map((mark) => (
          <span
            key={mark.rate}
            aria-hidden="true"
            className="absolute top-[-4px] h-[16px] border-l border-dashed border-sub"
            style={{ left: `${gaugePosition(mark.rate) * 100}%` }}
          >
            <span className="absolute top-[18px] -translate-x-1/2 text-[10.5px] whitespace-nowrap text-sub">
              {mark.label}
            </span>
          </span>
        ))}
      </div>
      <ul className="grid gap-1 text-[12.5px]">
        {overview.providers
          .filter((p) => p.delivered > 0)
          .map((p) => (
            <li key={p.provider} className="flex justify-between gap-3">
              <span>{PROVIDER_LABEL[p.provider]}</span>
              <span
                className={`tabular ${p.complaintStanding === 'over' ? 'font-semibold text-danger' : 'text-sub'}`}
              >
                {formatRate(p.complaintRate)}
              </span>
            </li>
          ))}
      </ul>
    </Section>
  );
}

// ---- Reputation Ramp history ---------------------------------------------------------------

function RampHistorySection({ ramps }: { ramps: RampHistory[] }) {
  return (
    <Section
      title="Warm-up history"
      description="Each domain’s daily cap and what was sent against it. A dashed day was paused or over a limit."
    >
      {ramps.every((r) => r.days.length === 0) ? (
        <p className="text-[13.5px] text-sub">No sending in this range.</p>
      ) : (
        <div className="grid gap-5">
          {ramps
            .filter((r) => r.days.length > 0)
            .map((ramp) => (
              <div key={ramp.rampId}>
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13.5px] font-semibold">{ramp.domain}</span>
                  <Pill
                    tone={
                      ramp.status === 'paused'
                        ? 'danger'
                        : ramp.status === 'complete'
                          ? 'success'
                          : 'scheduled'
                    }
                  >
                    {ramp.status === 'complete'
                      ? 'Complete'
                      : ramp.status === 'paused'
                        ? 'Paused'
                        : 'Warming up'}
                  </Pill>
                </div>
                {ramp.pausedReason && (
                  <p className="text-[13px] text-danger">{ramp.pausedReason}</p>
                )}
                <RampHistoryChart ramp={ramp} />
              </div>
            ))}
        </div>
      )}
    </Section>
  );
}

function RampHistoryChart({ ramp }: { ramp: RampHistory }) {
  const days = ramp.days;
  const max = niceMax(Math.max(1, ...days.map((d) => Math.max(d.cap, d.sent))));
  const width = 720;
  const height = 120;
  const left = 40;
  const slot = (width - left) / Math.max(1, days.length);
  const bar = Math.max(2, Math.min(12, slot / 3));
  const ticks = new Set(tickIndexes(days.length));
  return (
    <figure className="mt-2">
      <svg
        viewBox={`0 0 ${width} ${height + 18}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Daily cap and messages sent for ${ramp.domain}`}
      >
        <line x1={left} x2={width} y1={height} y2={height} stroke="var(--chart-grid)" />
        <text x={left - 6} y={10} textAnchor="end" fontSize="10" fill="var(--text-muted)">
          {numberFormat.format(max)}
        </text>
        {days.map((d, i) => {
          const x = left + i * slot + slot / 2;
          const capH = (d.cap / max) * height;
          const sentH = (d.sent / max) * height;
          const troubled = (d.bounceRate ?? 0) > 0.02 || (d.complaintRate ?? 0) >= 0.003;
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
                stroke={troubled ? 'var(--danger)' : 'none'}
                strokeDasharray={troubled ? '3 2' : undefined}
              >
                <title>{`${formatDay(d.day)}: ${numberFormat.format(d.sent)} sent of ${numberFormat.format(d.cap)}; bounces ${formatRate(d.bounceRate)}, complaints ${formatRate(d.complaintRate)}`}</title>
              </rect>
              {ticks.has(i) && (
                <text
                  x={x}
                  y={height + 14}
                  textAnchor="middle"
                  fontSize="10"
                  fill="var(--text-muted)"
                >
                  {formatDay(d.day)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 flex gap-4 text-[11.5px] text-sub">
        <Legend color="bg-[var(--chart-2)]" label="Daily cap" />
        <Legend color="bg-[var(--chart-1)]" label="Sent" />
      </figcaption>
      <table className="sr-only">
        <caption>Warm-up by day for {ramp.domain}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Cap</th>
            <th scope="col">Sent</th>
            <th scope="col">Bounce rate</th>
            <th scope="col">Complaint rate</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{d.cap}</td>
              <td>{d.sent}</td>
              <td>{formatRate(d.bounceRate)}</td>
              <td>{formatRate(d.complaintRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

// ---- Dedicated sending ---------------------------------------------------------------------

function Dedicated({ channelId, admin }: { channelId: string; admin: boolean }) {
  const dedicated = useQuery(dedicatedQuery(channelId));
  return (
    <Section
      title="Dedicated sending"
      description="Keep this publication’s reputation its own: a configuration set on paid plans, and dedicated IP addresses from Pro."
    >
      {dedicated.isPending && <LoadingRows label="Loading dedicated sending" rows={2} />}
      {dedicated.error && <ErrorNotice message={dedicated.error.message} />}
      {dedicated.data && !dedicated.data.supported && (
        <p className="rounded-card-app border border-line-app px-4 py-3 text-[13px] text-sub">
          Dedicated sending needs Amazon SES. This Swarm sends through another email service, so
          every publication shares the account’s reputation.
        </p>
      )}
      {dedicated.data?.supported && (
        <div className="grid gap-4 md:grid-cols-2">
          <ConfigurationSetCard channelId={channelId} admin={admin} data={dedicated.data} />
          <DedicatedIpCard channelId={channelId} admin={admin} data={dedicated.data} />
        </div>
      )}
    </Section>
  );
}

function ConfigurationSetCard({
  channelId,
  admin,
  data,
}: {
  channelId: string;
  admin: boolean;
  data: DedicatedSending;
}) {
  const create = useCreateConfigurationSet(channelId);
  const { configurationSet } = data;
  return (
    <div className="rounded-card-app border border-line-app px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[14px] font-semibold">Configuration set</h3>
        <Pill tone={configurationSet.name ? 'success' : 'neutral'}>
          {configurationSet.name ? 'Own' : 'Shared'}
        </Pill>
      </div>
      <p className="mt-2 text-[13px] text-sub">
        {configurationSet.name ? (
          <>
            Sends go through <span className="font-mono">{configurationSet.name}</span>, so bounce
            and complaint metrics at the provider are this publication’s alone.
          </>
        ) : configurationSet.available ? (
          'Created on the next send, or now. Until then mail goes through the shared configuration set.'
        ) : (
          'Paid plans give each publication its own configuration set. On the free plan publications share one.'
        )}
      </p>
      {admin && configurationSet.available && !configurationSet.name && (
        <Button
          className="mt-3"
          variant="ghost"
          size="sm"
          loading={create.isPending}
          onClick={() => create.mutate()}
        >
          Create it now
        </Button>
      )}
      {create.error && <ErrorNotice message={create.error.message} />}
    </div>
  );
}

function DedicatedIpCard({
  channelId,
  admin,
  data,
}: {
  channelId: string;
  admin: boolean;
  data: DedicatedSending;
}) {
  const request = useRequestDedicatedIp(channelId);
  const check = useCheckDedicatedIp(channelId);
  const ip = data.dedicatedIp;
  return (
    <div className="rounded-card-app border border-line-app px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[14px] font-semibold">Dedicated IP</h3>
        <Pill
          tone={ip.status === 'active' ? 'success' : ip.status === 'none' ? 'neutral' : 'scheduled'}
        >
          {DEDICATED_IP_LABEL[ip.status]}
        </Pill>
      </div>
      {!ip.available && (
        <p className="mt-2 text-[13px] text-sub">
          Dedicated IPs are on the Pro plan and up. Shared IPs are the better choice below a few
          hundred thousand messages a month.
        </p>
      )}
      {ip.available && ip.status === 'none' && (
        <p className="mt-2 text-[13px] text-sub">
          Your own sending IPs, warmed up automatically over several weeks while mail keeps flowing.
          Best for steady volume of a few hundred thousand messages a month or more.
        </p>
      )}
      {ip.status === 'requested' && (
        <p className="mt-2 text-[13px] text-sub">
          Requested {formatDateTime(ip.requestedAt)}. Setting up the pool; this page updates once
          the provider confirms it.
        </p>
      )}
      {(ip.status === 'warming' || ip.status === 'active') && (
        <div className="mt-2">
          <p className="text-[13px] text-sub">
            Pool <span className="font-mono">{ip.pool}</span>
            {ip.checkedAt ? ` · checked ${formatDateTime(ip.checkedAt)}` : ''}
          </p>
          <div
            className="mt-2 h-[5px] overflow-hidden rounded-pill bg-[var(--meter-track)]"
            role="progressbar"
            aria-label="Warm-up"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={ip.warmupPercent ?? 0}
          >
            <div
              className="h-full rounded-pill bg-purple"
              style={{ width: `${ip.warmupPercent ?? 0}%` }}
            />
          </div>
          <p className="tabular mt-1 text-[12px] text-sub">
            {ip.status === 'active' ? 'Warm-up complete' : `Warm-up ${ip.warmupPercent ?? 0}%`}
          </p>
        </div>
      )}
      {ip.available && (
        <p className="mt-3 text-[12px] text-sub">
          Dedicated IPs are billed by AWS. Costs are passed through at AWS’s price, with no markup;
          see{' '}
          <a
            href={SES_PRICING_URL}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-purple-deep underline"
          >
            Amazon SES pricing
          </a>{' '}
          for the current monthly price per IP.
        </p>
      )}
      {admin && ip.available && (
        <div className="mt-3 flex gap-2">
          {ip.status === 'none' && (
            <Button
              variant="primary"
              size="sm"
              loading={request.isPending}
              onClick={() => request.mutate()}
            >
              Request a dedicated IP
            </Button>
          )}
          {(ip.status === 'requested' || ip.status === 'warming') && (
            <Button
              variant="ghost"
              size="sm"
              loading={check.isPending}
              onClick={() => check.mutate()}
            >
              Check now
            </Button>
          )}
        </div>
      )}
      {request.error && <ErrorNotice message={request.error.message} />}
      {check.error && <ErrorNotice message={check.error.message} />}
    </div>
  );
}
