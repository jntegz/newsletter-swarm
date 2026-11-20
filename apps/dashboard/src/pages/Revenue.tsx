// Memberships → Revenue: monthly recurring revenue, paid Members, churn and money in per day,
// from the payments Swarm records (Stripe stays the ledger of record).
import type { Revenue } from '@swarm/domain';
import { EmptyState, ErrorNotice, LoadingRows, SelectField, TextField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { revenueQuery } from '../api/money';
import {
  currenciesOf,
  formatMoney,
  formatMoneyList,
  formatMrr,
  revenueIsEmpty,
  revenueSeries,
} from '../money/helpers';
import { dayOf, lastDays, niceMax, rangeProblem, tickIndexes } from '../site/helpers';
import { Section, numberFormat, percentFormat } from './common';
import { useMemberships } from './Memberships';

type Preset = '7' | '30' | '90' | '365' | 'custom';

const shortDay = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const formatDay = (day: string) => shortDay.format(new Date(`${day}T00:00:00Z`));

export function RevenuePage() {
  const { channel } = useMemberships();
  const [today] = useState(() => dayOf(Date.now()));
  const [preset, setPreset] = useState<Preset>('30');
  const [custom, setCustom] = useState(lastDays(30, today));
  const range = preset === 'custom' ? custom : lastDays(Number(preset), today);
  const problem = preset === 'custom' ? rangeProblem(custom.from, custom.to) : null;
  const revenue = useQuery({ ...revenueQuery(channel.id, range), enabled: !problem });

  return (
    <div className="grid gap-5">
      <section aria-label="Date range" className="card-app grid gap-4 p-5 sm:p-6">
        <div className="grid gap-4 sm:grid-cols-[220px_1fr] sm:items-start">
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
        <p className="text-[12.5px] text-sub">
          MRR and subscriber counts are as of now; the rest covers the range, in UTC days. Stripe
          remains the record for payouts and tax.
        </p>
      </section>

      {revenue.isPending && !problem && <LoadingRows label="Loading revenue" rows={4} />}
      {revenue.error && <ErrorNotice message={revenue.error.message} />}
      {revenue.data && revenueIsEmpty(revenue.data) && (
        <EmptyState title="No revenue yet">
          Numbers appear here once readers buy a paid plan. Share the plans page, or put a paywall
          on a paid post.
        </EmptyState>
      )}
      {revenue.data && !revenueIsEmpty(revenue.data) && (
        <Report revenue={revenue.data} refreshing={revenue.isFetching} />
      )}
    </div>
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
      <p className="tabular mt-1 text-[25px] leading-tight font-bold tracking-[-0.03em] break-words">
        {value}
      </p>
      {detail && <p className="tabular mt-1 text-[12px] text-sub">{detail}</p>}
    </div>
  );
}

function Report({ revenue, refreshing }: { revenue: Revenue; refreshing: boolean }) {
  const currencies = currenciesOf(revenue);
  const [picked, setPicked] = useState<string | null>(null);
  const currency = picked && currencies.includes(picked) ? picked : (currencies[0] ?? 'usd');
  const series = revenueSeries(revenue, currency);
  const churn = revenue.churn;
  return (
    <div
      className={`grid gap-5 transition-opacity ${refreshing ? 'opacity-70' : ''}`}
      aria-busy={refreshing}
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Kpi
          label="MRR"
          value={formatMrr(revenue.mrr)}
          detail="Paying subscribers after coupons; yearly plans count as a twelfth"
        />
        <Kpi
          label="Active paid subscribers"
          value={numberFormat.format(revenue.activePaid)}
          detail={`${numberFormat.format(revenue.complimentary)} complimentary`}
        />
        <Kpi
          label="Trialing"
          value={numberFormat.format(revenue.trialing)}
          detail={
            revenue.trialMrr.length > 0
              ? `${formatMoneyList(revenue.trialMrr)} MRR if they convert`
              : undefined
          }
        />
        <Kpi
          label="Churn"
          value={churn.rate === null ? '—' : percentFormat.format(churn.rate)}
          detail={`${numberFormat.format(churn.canceled)} of ${numberFormat.format(churn.activeAtStart)} canceled`}
        />
        <Kpi
          label="New paid subscribers"
          value={numberFormat.format(revenue.newPaid)}
          detail={`${formatDay(revenue.from)} – ${formatDay(revenue.to)}`}
        />
        <Kpi label="Lifetime revenue" value={formatMoneyList(revenue.lifetimeRevenue)} />
      </div>

      <Section
        title="Revenue by day"
        description="Money in per UTC day, after refunds."
        action={
          currencies.length > 1 ? (
            <div className="w-36">
              <SelectField
                label="Currency"
                value={currency}
                onChange={(e) => setPicked(e.target.value)}
                options={currencies.map((c) => ({ value: c, label: c.toUpperCase() }))}
              />
            </div>
          ) : undefined
        }
      >
        <DayChart series={series} currency={currency} from={revenue.from} to={revenue.to} />
      </Section>

      <Section
        title="Conversion by source"
        description="Subscribers who joined in this range, by where they came from, and how many pay now."
      >
        {revenue.conversionBySource.length === 0 ? (
          <p className="text-[13px] text-sub">Nobody joined in this range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-[13px]">
              <caption className="sr-only">Conversion by source</caption>
              <thead>
                <tr className="table-head">
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Source
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    Joined
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    Paid
                  </th>
                  <th scope="col" className="py-2 pl-3 text-right font-semibold">
                    Conversion
                  </th>
                </tr>
              </thead>
              <tbody>
                {revenue.conversionBySource.map((row) => (
                  <tr key={row.source} className="border-t border-line">
                    <td className="py-2 pr-3">{row.source}</td>
                    <td className="tabular px-3 py-2 text-right">
                      {numberFormat.format(row.members)}
                    </td>
                    <td className="tabular px-3 py-2 text-right">
                      {numberFormat.format(row.paid)}
                    </td>
                    <td className="tabular py-2 pl-3 text-right font-semibold">
                      {percentFormat.format(row.rate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function DayChart({
  series,
  currency,
  from,
  to,
}: {
  series: { day: string; amount: number }[];
  currency: string;
  from: string;
  to: string;
}) {
  const peak = Math.max(0, ...series.map((d) => d.amount));
  const low = Math.min(0, ...series.map((d) => d.amount));
  const max = niceMax(peak);
  const min = low < 0 ? -niceMax(-low) : 0;
  const width = 720;
  const height = 180;
  const left = 56;
  const span = max - min;
  const y = (value: number) => height - ((value - min) / span) * height;
  const slot = (width - left) / Math.max(1, series.length);
  const bar = Math.max(2, Math.min(18, slot * 0.6));
  const ticks = new Set(tickIndexes(series.length));
  const total = series.reduce((sum, d) => sum + d.amount, 0);
  const gridValues = min < 0 ? [min, 0, max] : [0, max / 2, max];
  return (
    <figure>
      <svg
        viewBox={`0 0 ${width} ${height + 20}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Revenue per day in ${currency.toUpperCase()} from ${formatDay(from)} to ${formatDay(to)}: ${formatMoney(total, currency)} in total, peaking at ${formatMoney(peak, currency)}`}
      >
        {gridValues.map((value) => (
          <g key={value}>
            <line x1={left} x2={width} y1={y(value)} y2={y(value)} stroke="var(--chart-grid)" />
            <text
              x={left - 6}
              y={y(value) + 4}
              textAnchor="end"
              fontSize="10"
              fill="var(--text-muted)"
            >
              {formatMoney(Math.round(value), currency)}
            </text>
          </g>
        ))}
        {series.map((d, i) => {
          const x = left + i * slot + slot / 2;
          const top = y(Math.max(0, d.amount));
          const h = Math.abs(y(d.amount) - y(0));
          return (
            <g key={d.day}>
              <rect
                x={x - bar / 2}
                y={top}
                width={bar}
                height={h}
                rx={2}
                fill={d.amount < 0 ? 'var(--chart-3)' : 'var(--chart-1)'}
              >
                <title>{`${formatDay(d.day)}: ${formatMoney(d.amount, currency)}`}</title>
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
      </svg>
      <figcaption className="mt-1 flex gap-4 text-[11.5px] text-sub">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block size-2.5 rounded-[3px] bg-purple" />{' '}
          Money in
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-[3px] bg-[var(--chart-3)]"
          />{' '}
          Refunds larger than sales
        </span>
      </figcaption>
      <table className="sr-only">
        <caption>Revenue by day in {currency.toUpperCase()}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Revenue</th>
          </tr>
        </thead>
        <tbody>
          {series.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{formatMoney(d.amount, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
