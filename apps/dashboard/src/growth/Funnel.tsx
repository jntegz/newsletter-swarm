// Growth → Funnel Explorer: visits → form views → sign-ups → confirmed → first open → paid, by
// UTC day, cut by source, UTM tag, capture form or Champion. The free plan looks back 30 days;
// the API moves an earlier start forward and says so (`clamped`).
import {
  FUNNEL_QUERY_CUTS,
  FUNNEL_STAGES,
  type Funnel,
  type FunnelCounts,
  type FunnelQueryCut,
} from '@swarm/domain';
import { Button, EmptyState, SelectField, TextField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { captureFormsQuery } from '../api/capture';
import { funnelQuery, type FunnelParams } from '../api/growth';
import { Section, numberFormat } from '../pages/common';
import { dayOf, lastDays, niceMax, rangeProblem, tickIndexes } from '../site/helpers';
import { FUNNEL_STAGE_LABEL, formatRate, funnelIsEmpty, stageCount, stageWidths } from './helpers';
import { QueryState, useGrowth } from './Layout';

type Preset = '7' | '30' | '90' | '365' | 'custom';
type FilterKey = keyof FunnelParams['filters'];

const CUT_LABEL: Record<FunnelQueryCut, string> = {
  source: 'Source',
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  form: 'Signup form',
  champion: 'Referrer',
};

/** The filter that narrows to one value of a cut. */
const CUT_FILTER: Record<FunnelQueryCut, FilterKey> = {
  source: 'source',
  utm_source: 'utmSource',
  utm_medium: 'utmMedium',
  utm_campaign: 'utmCampaign',
  form: 'formId',
  champion: 'championId',
};

const FILTER_CUT = Object.fromEntries(
  Object.entries(CUT_FILTER).map(([cut, filter]) => [filter, cut]),
) as Record<FilterKey, FunnelQueryCut>;

const shortDay = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const formatDay = (day: string) => shortDay.format(new Date(`${day}T00:00:00Z`));

export function FunnelPage() {
  const { channel } = useGrowth();
  const forms = useQuery(captureFormsQuery(channel.id));
  const [today] = useState(() => dayOf(Date.now()));
  const [preset, setPreset] = useState<Preset>('30');
  const [custom, setCustom] = useState(lastDays(30, today));
  const [cut, setCut] = useState<FunnelQueryCut>('source');
  const [filters, setFilters] = useState<FunnelParams['filters']>({});
  const range = preset === 'custom' ? custom : lastDays(Number(preset), today);
  const problem = preset === 'custom' ? rangeProblem(custom.from, custom.to) : null;
  const funnel = useQuery({
    ...funnelQuery(channel.id, { ...range, cut, filters }),
    enabled: !problem,
  });
  const active = Object.entries(filters).filter(([, v]) => v !== undefined) as [
    FilterKey,
    string,
  ][];
  const formName = (id: string) => forms.data?.find((f) => f.id === id)?.name ?? id;

  const filterLabel = (key: FilterKey, value: string) => {
    const shown = value === '' ? 'none' : key === 'formId' ? formName(value) : value;
    return `${CUT_LABEL[FILTER_CUT[key]]}: ${shown}`;
  };

  return (
    <div className="grid gap-5">
      <section aria-label="What to show" className="card-app grid gap-4 p-5 sm:p-6">
        <div className="grid gap-4 sm:grid-cols-[220px_220px_1fr] sm:items-start">
          <SelectField
            label="Date range"
            value={preset}
            onChange={(e) => setPreset(e.target.value as Preset)}
            options={[
              { value: '7', label: 'Last 7 days' },
              { value: '30', label: 'Last 30 days' },
              { value: '90', label: 'Last 90 days' },
              { value: '365', label: 'Last 12 months' },
              { value: 'custom', label: 'Custom range' },
            ]}
          />
          <SelectField
            label="Break down by"
            value={cut}
            onChange={(e) => setCut(e.target.value as FunnelQueryCut)}
            options={FUNNEL_QUERY_CUTS.map((c) => ({ value: c, label: CUT_LABEL[c] }))}
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
        <FilterAdder
          forms={(forms.data ?? []).map((f) => ({ value: f.id, label: f.name }))}
          onAdd={(key, value) => setFilters((f) => ({ ...f, [key]: value }))}
        />
        {active.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Filters">
            {active.map(([key, value]) => (
              <li key={key}>
                <button
                  type="button"
                  onClick={() =>
                    setFilters((f) => {
                      const next = { ...f };
                      delete next[key];
                      return next;
                    })
                  }
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-pill bg-lavender px-3 text-[12.5px] font-semibold text-purple-deep hover:bg-lavender-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple"
                >
                  {filterLabel(key, value)}
                  <span aria-hidden="true">×</span>
                  <span className="sr-only">(remove filter)</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[12.5px] text-sub">
          UTC days. Sign-ups and later stages count each subscriber once, credited to how they first
          arrived. Imported subscribers aren’t counted.
        </p>
      </section>

      {!problem && (
        <QueryState query={funnel} label="Loading the funnel">
          {funnel.data && (
            <FunnelReport
              funnel={funnel.data}
              refreshing={funnel.isFetching}
              filtered={active.length > 0}
              onFilter={(value) => setFilters((f) => ({ ...f, [CUT_FILTER[cut]]: value }))}
              formName={formName}
            />
          )}
        </QueryState>
      )}
    </div>
  );
}

function FilterAdder({
  forms,
  onAdd,
}: {
  forms: { value: string; label: string }[];
  onAdd: (key: FilterKey, value: string) => void;
}) {
  const [key, setKey] = useState<FilterKey | ''>('');
  const [value, setValue] = useState('');
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="w-full sm:w-[220px]">
        <SelectField
          label="Filter"
          value={key}
          onChange={(e) => {
            setKey(e.target.value as FilterKey | '');
            setValue('');
          }}
          options={[
            { value: '', label: 'Add a filter' },
            ...(Object.keys(FILTER_CUT) as FilterKey[]).map((k) => ({
              value: k,
              label: CUT_LABEL[FILTER_CUT[k]],
            })),
          ]}
        />
      </div>
      {key === 'formId' ? (
        <div className="w-full sm:w-[260px]">
          <SelectField
            label="Signup form"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            options={[{ value: '', label: 'None (no form)' }, ...forms]}
          />
        </div>
      ) : (
        key && (
          <div className="w-full sm:w-[260px]">
            <TextField
              label="Is exactly"
              value={value}
              maxLength={120}
              onChange={(e) => setValue(e.target.value)}
              hint="Leave empty for “none”."
            />
          </div>
        )
      )}
      {key && (
        <Button
          variant="ghost"
          size="sm"
          className="mb-0.5"
          onClick={() => {
            onAdd(key, value.trim());
            setKey('');
            setValue('');
          }}
        >
          Apply filter
        </Button>
      )}
    </div>
  );
}

function FunnelReport({
  funnel,
  refreshing,
  filtered,
  onFilter,
  formName,
}: {
  funnel: Funnel;
  refreshing: boolean;
  filtered: boolean;
  onFilter: (value: string) => void;
  formName: (id: string) => string;
}) {
  const counts = FUNNEL_STAGES.map((stage) => stageCount(funnel.totals, stage));
  const widths = stageWidths(counts);
  const valueLabel = (row: Funnel['breakdown'][number]) => {
    if (row.other) return 'Everything else';
    if (row.value === '') return '(none)';
    return row.label ?? (funnel.cut === 'form' && row.value ? formName(row.value) : row.value);
  };

  return (
    <>
      {funnel.clamped && (
        <p
          role="status"
          className="rounded-card-app bg-scheduled-soft px-4 py-3 text-[13.5px] text-scheduled"
        >
          The free plan shows the last {funnel.lookbackDays} days, so this starts on{' '}
          {formatDay(funnel.from)}. Paid plans see the whole history.
        </p>
      )}
      {funnelIsEmpty(funnel.totals) ? (
        <EmptyState title={filtered ? 'Nothing matches these filters' : 'No traffic yet'}>
          {filtered
            ? 'Remove a filter or pick a longer range.'
            : 'Numbers appear once people visit your website or see a signup form. Counts are rolled up every few minutes.'}
        </EmptyState>
      ) : (
        <>
          <Section
            title="Funnel"
            description={`${formatDay(funnel.from)} to ${formatDay(funnel.to)}${refreshing ? ' · updating…' : ''}`}
          >
            <ol className="grid gap-3">
              {FUNNEL_STAGES.map((stage, i) => {
                const row = funnel.stages.find((s) => s.stage === stage);
                return (
                  <li key={stage} className="grid gap-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2 text-[13.5px]">
                      <span className="font-semibold">{FUNNEL_STAGE_LABEL[stage]}</span>
                      <span className="tabular text-sub">
                        <b className="text-ink">{numberFormat.format(counts[i] ?? 0)}</b>
                        {i > 0 && (
                          <>
                            {' '}
                            · {formatRate(row?.fromPrevious)} of{' '}
                            {FUNNEL_STAGE_LABEL[FUNNEL_STAGES[i - 1] ?? 'visits'].toLowerCase()}
                          </>
                        )}
                        {i > 1 && <> · {formatRate(row?.fromVisits)} of visits</>}
                      </span>
                    </div>
                    <div
                      aria-hidden="true"
                      className="h-3 overflow-hidden rounded-pill bg-surface-alt"
                    >
                      <div
                        className="h-full rounded-pill bg-purple"
                        style={{ width: `${widths[i] ?? 0}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          </Section>

          <Section
            title="Sign-ups by day"
            description="New subscribers and confirmations per UTC day."
          >
            <DayChart days={funnel.byDay} />
          </Section>

          <Section
            title={`By ${CUT_LABEL[funnel.cut].replace(/^[A-Z]/, (c) => c.toLowerCase())}`}
            description="Top values by sign-ups. Choose one to filter the whole report to it."
          >
            {funnel.breakdown.length === 0 ? (
              <p className="text-[13.5px] text-sub">Nothing to break down in this range.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-[13px]">
                  <thead>
                    <tr className="table-head">
                      <th scope="col" className="py-2 pr-3 font-semibold">
                        {CUT_LABEL[funnel.cut]}
                      </th>
                      {FUNNEL_STAGES.map((stage) => (
                        <th key={stage} scope="col" className="px-2 py-2 text-right font-semibold">
                          {FUNNEL_STAGE_LABEL[stage]}
                        </th>
                      ))}
                      <th scope="col" className="py-2 pl-2 text-right font-semibold">
                        Sign-up rate
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {funnel.breakdown.map((row) => (
                      <tr
                        key={row.other ? '__other' : (row.value ?? '')}
                        className="border-t border-line"
                      >
                        <th scope="row" className="py-2 pr-3 font-normal">
                          {row.other || row.value === null ? (
                            <span className="text-sub">{valueLabel(row)}</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => onFilter(row.value ?? '')}
                              className="max-w-[24ch] truncate text-left font-semibold text-purple-deep hover:underline focus-visible:outline-2 focus-visible:outline-purple"
                              title={`Filter to ${valueLabel(row)}`}
                            >
                              {valueLabel(row)}
                            </button>
                          )}
                        </th>
                        {FUNNEL_STAGES.map((stage) => (
                          <td key={stage} className="tabular px-2 py-2 text-right">
                            {numberFormat.format(stageCount(row.counts, stage))}
                          </td>
                        ))}
                        <td className="tabular py-2 pl-2 text-right">
                          {formatRate(signupRate(row.counts))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </>
  );
}

/** Sign-ups over form views, or over visits when no form was seen. */
const signupRate = (c: FunnelCounts) =>
  c.formViews > 0 ? c.subscribes / c.formViews : c.visits > 0 ? c.subscribes / c.visits : null;

function DayChart({ days }: { days: Funnel['byDay'] }) {
  const peak = Math.max(0, ...days.map((d) => d.subscribes));
  const max = niceMax(Math.max(1, peak));
  const width = 720;
  const height = 160;
  const left = 40;
  const y = (v: number) => height - (v / max) * height;
  const slot = (width - left) / Math.max(1, days.length);
  const bar = Math.max(2, Math.min(18, slot * 0.6));
  const ticks = new Set(tickIndexes(days.length));
  const total = days.reduce((sum, d) => sum + d.subscribes, 0);
  return (
    <figure>
      <svg
        viewBox={`0 0 ${width} ${height + 20}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Sign-ups per day: ${numberFormat.format(total)} in total, at most ${numberFormat.format(peak)} in a day`}
      >
        {[0, max / 2, max].map((value) => (
          <g key={value}>
            <line x1={left} x2={width} y1={y(value)} y2={y(value)} stroke="var(--chart-grid)" />
            <text
              x={left - 6}
              y={y(value) + 4}
              textAnchor="end"
              fontSize="10"
              fill="var(--text-sub)"
            >
              {numberFormat.format(Math.round(value))}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = left + i * slot + slot / 2;
          return (
            <g key={d.day}>
              <rect
                x={x - bar / 2}
                y={y(d.subscribes)}
                width={bar}
                height={height - y(d.subscribes)}
                rx={2}
                fill="var(--chart-2)"
              >
                <title>{`${formatDay(d.day)}: ${numberFormat.format(d.subscribes)} sign-ups`}</title>
              </rect>
              <rect
                x={x - bar / 2}
                y={y(d.confirms)}
                width={bar}
                height={height - y(d.confirms)}
                rx={2}
                fill="var(--chart-1)"
              >
                <title>{`${formatDay(d.day)}: ${numberFormat.format(d.confirms)} confirmed`}</title>
              </rect>
              {ticks.has(i) && (
                <text
                  x={x}
                  y={height + 15}
                  textAnchor="middle"
                  fontSize="10"
                  fill="var(--text-sub)"
                >
                  {formatDay(d.day)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 flex gap-4 text-[11.5px] text-sub">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-[3px] bg-[var(--chart-2)]"
          />
          Sign-ups
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block size-2.5 rounded-[3px] bg-purple" />
          Confirmed
        </span>
      </figcaption>
      <table className="sr-only">
        <caption>Funnel by day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {FUNNEL_STAGES.map((stage) => (
              <th key={stage} scope="col">
                {FUNNEL_STAGE_LABEL[stage]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              {FUNNEL_STAGES.map((stage) => (
                <td key={stage}>{stageCount(d, stage)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
