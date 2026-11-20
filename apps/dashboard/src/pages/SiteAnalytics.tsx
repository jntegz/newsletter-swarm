// Site Studio → Analytics: first-party, cookieless page views from daily rollups.
import type { SiteAnalytics } from '@swarm/domain';
import {
  Button,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  SelectField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { siteAnalyticsQuery, type SiteAnalyticsFilter } from '../api/site';
import { dayOf, lastDays, niceMax, rangeProblem, tickIndexes } from '../site/helpers';
import { Section, numberFormat } from './common';
import { useSiteStudio } from './SiteStudio';

type Preset = '7' | '30' | '90' | 'custom';

const shortDay = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const formatDay = (day: string) => shortDay.format(new Date(`${day}T00:00:00Z`));

export function SiteAnalyticsPage() {
  const { channel } = useSiteStudio();
  const [today] = useState(() => dayOf(Date.now()));
  const [preset, setPreset] = useState<Preset>('30');
  const [custom, setCustom] = useState(lastDays(30, today));
  const [path, setPath] = useState<string | undefined>();
  const [source, setSource] = useState<string | undefined>();
  const range = preset === 'custom' ? custom : lastDays(Number(preset), today);
  const problem = preset === 'custom' ? rangeProblem(custom.from, custom.to) : null;
  const filter: SiteAnalyticsFilter = { ...range, path, source };
  const stats = useQuery({ ...siteAnalyticsQuery(channel.id, filter), enabled: !problem });
  const filtered = !!(path || source);

  return (
    <div className="grid gap-5">
      <section aria-label="Filters" className="card-app grid gap-4 p-5 sm:p-6">
        <div className="grid gap-4 sm:grid-cols-[220px_1fr] sm:items-start">
          <SelectField
            label="Date range"
            value={preset}
            onChange={(e) => setPreset(e.target.value as Preset)}
            options={[
              { value: '7', label: 'Last 7 days' },
              { value: '30', label: 'Last 30 days' },
              { value: '90', label: 'Last 90 days' },
              { value: 'custom', label: 'Custom range' },
            ]}
          />
          {preset === 'custom' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="From"
                type="date"
                value={custom.from}
                max={today}
                onChange={(e) => setCustom({ ...custom, from: e.target.value })}
                error={problem ?? undefined}
              />
              <TextField
                label="To"
                type="date"
                value={custom.to}
                max={today}
                onChange={(e) => setCustom({ ...custom, to: e.target.value })}
              />
            </div>
          )}
        </div>
        {filtered && (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-sub">Showing only</span>
            {path && <FilterChip label={`Path ${path}`} onClear={() => setPath(undefined)} />}
            {source && (
              <FilterChip label={`Source ${source}`} onClear={() => setSource(undefined)} />
            )}
          </div>
        )}
        <p className="text-[12.5px] text-sub">
          Counted at the edge without cookies or third-party scripts, in UTC days. A visitor on two
          days counts on both, so visitors are approximate.
        </p>
      </section>

      {stats.isPending && !problem && <LoadingRows label="Loading site analytics" rows={4} />}
      {stats.error && <ErrorNotice message={stats.error.message} />}
      {stats.data && stats.data.totals.views === 0 && !filtered && (
        <EmptyState title="No page views in this range">
          Views appear here once readers visit the website. Publish a post to the web and share its
          address to start.
        </EmptyState>
      )}
      {stats.data && (stats.data.totals.views > 0 || filtered) && (
        <Report
          stats={stats.data}
          refreshing={stats.isFetching}
          onPath={setPath}
          onSource={setSource}
        />
      )}
    </div>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-pill bg-lavender py-0.5 pr-1 pl-3 font-semibold text-purple-deep">
      <span className="font-mono text-[12.5px]">{label}</span>
      <Button variant="quiet" size="sm" aria-label={`Clear ${label}`} onClick={onClear}>
        Clear
      </Button>
    </span>
  );
}

function Kpi({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-card-app border border-line-app bg-surface p-4">
      <p className="text-[11px] text-sub">{label}</p>
      <p className="tabular mt-1 text-[25px] leading-tight font-bold tracking-[-0.03em]">{value}</p>
      {detail && <p className="tabular mt-1 text-[12px] text-sub">{detail}</p>}
    </div>
  );
}

function Report({
  stats,
  refreshing,
  onPath,
  onSource,
}: {
  stats: SiteAnalytics;
  refreshing: boolean;
  onPath: (path: string) => void;
  onSource: (source: string) => void;
}) {
  const days = stats.byDay.length;
  const perDay = days ? stats.totals.views / days : 0;
  return (
    <div
      className={`grid gap-5 transition-opacity ${refreshing ? 'opacity-70' : ''}`}
      aria-busy={refreshing}
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Page views" value={numberFormat.format(stats.totals.views)} />
        <Kpi
          label="Visitors"
          value={numberFormat.format(stats.totals.visitors)}
          detail="Approximate"
        />
        <Kpi
          label="Views per day"
          value={numberFormat.format(Math.round(perDay))}
          detail={`${formatDay(stats.from)} – ${formatDay(stats.to)}`}
        />
        <Kpi
          label="Views per visitor"
          value={
            stats.totals.visitors ? (stats.totals.views / stats.totals.visitors).toFixed(1) : '—'
          }
        />
      </div>

      <Section title="Views by day" description="Page views and visitors per UTC day.">
        <DayChart stats={stats} />
      </Section>

      <div className="grid gap-5 lg:grid-cols-2">
        <TopTable
          title="Top pages"
          column="Path"
          rows={stats.topPaths.map((r) => ({ key: r.path, ...r }))}
          mono
          onPick={onPath}
          pickLabel="Show only"
        />
        <TopTable
          title="Sources"
          column="Source"
          rows={stats.topSources.map((r) => ({ key: r.source, ...r }))}
          onPick={onSource}
          pickLabel="Show only"
        />
        <TopTable
          title="Devices"
          column="Device"
          rows={stats.devices.map((r) => ({ key: r.device, ...r }))}
        />
        <TopTable
          title="Countries"
          column="Country"
          rows={stats.countries.map((r) => ({ key: r.country, ...r }))}
        />
      </div>
    </div>
  );
}

function DayChart({ stats }: { stats: SiteAnalytics }) {
  const days = stats.byDay;
  const max = niceMax(Math.max(0, ...days.map((d) => d.views)));
  const width = 720;
  const height = 180;
  const left = 36;
  const slot = (width - left) / Math.max(1, days.length);
  const bar = Math.max(2, Math.min(18, slot * 0.6));
  const ticks = new Set(tickIndexes(days.length));
  const visitorPoints = days
    .map((d, i) => `${left + i * slot + slot / 2},${height - (d.visitors / max) * height}`)
    .join(' ');
  return (
    <figure>
      <svg
        viewBox={`0 0 ${width} ${height + 20}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Page views per day from ${formatDay(stats.from)} to ${formatDay(stats.to)}, peaking at ${numberFormat.format(Math.max(0, ...days.map((d) => d.views)))}`}
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
          const h = (d.views / max) * height;
          return (
            <g key={d.day}>
              <rect
                x={x - bar / 2}
                y={height - h}
                width={bar}
                height={h}
                rx={2}
                fill="var(--chart-1)"
              >
                <title>{`${formatDay(d.day)}: ${numberFormat.format(d.views)} views, ${numberFormat.format(d.visitors)} visitors`}</title>
              </rect>
              {ticks.has(i) && (
                <text
                  x={x}
                  y={height + 15}
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
        <polyline
          points={visitorPoints}
          fill="none"
          stroke="var(--chart-3)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </svg>
      <figcaption className="mt-1 flex gap-4 text-[11.5px] text-sub">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block size-2.5 rounded-[3px] bg-purple" /> Page
          views
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-0.5 w-3 bg-[var(--chart-3)]" />{' '}
          Visitors
        </span>
      </figcaption>
      <table className="sr-only">
        <caption>Page views and visitors by day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Views</th>
            <th scope="col">Visitors</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{d.views}</td>
              <td>{d.visitors}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function TopTable({
  title,
  column,
  rows,
  mono,
  onPick,
  pickLabel,
}: {
  title: string;
  column: string;
  rows: { key: string; views: number; visitors: number }[];
  mono?: boolean;
  onPick?: (key: string) => void;
  pickLabel?: string;
}) {
  const top = rows[0]?.views ?? 0;
  return (
    <Section title={title}>
      {rows.length === 0 ? (
        <p className="text-[13px] text-sub">Nothing recorded.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[320px] text-left text-[13px]">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="table-head">
                <th scope="col" className="py-2 pr-3 font-semibold">
                  {column}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  Views
                </th>
                <th scope="col" className="py-2 pl-3 text-right font-semibold">
                  Visitors
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-line">
                  <td className="max-w-[260px] py-2 pr-3">
                    <span className="relative block">
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-0 left-0 rounded-[6px] bg-lavender"
                        style={{ width: `${top ? (row.views / top) * 100 : 0}%` }}
                      />
                      {onPick ? (
                        <button
                          type="button"
                          onClick={() => onPick(row.key)}
                          aria-label={`${pickLabel ?? 'Show only'} ${row.key || '(none)'}`}
                          className={`relative block w-full truncate px-1.5 py-0.5 text-left hover:text-purple-deep focus-visible:outline-2 focus-visible:outline-purple ${mono ? 'font-mono text-[12.5px]' : ''}`}
                        >
                          {row.key || '(none)'}
                        </button>
                      ) : (
                        <span
                          className={`relative block truncate px-1.5 py-0.5 ${mono ? 'font-mono text-[12.5px]' : ''}`}
                        >
                          {row.key || 'Unknown'}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="tabular px-3 py-2 text-right font-semibold">
                    {numberFormat.format(row.views)}
                  </td>
                  <td className="tabular py-2 pl-3 text-right text-sub">
                    {numberFormat.format(row.visitors)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
