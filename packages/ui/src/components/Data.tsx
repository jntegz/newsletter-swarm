// Data display: KPI cards, line and bar charts, the donut and the progress meter (DESIGN.md
// "Charts & data"). Colors come from the chart tokens; every chart has a caption or legend and a
// text alternative, and numbers use tabular figures.
import { useId, type ReactNode } from 'react';
import { ErrorNotice, Skeleton } from './Feedback';

/** Series colors in DESIGN.md order: indigo, lavender, apricot. */
const SERIES_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'] as const;

/** A linear map from `domain` onto `range`. A zero-width domain maps to the middle. */
export function scaleLinear(
  domain: readonly [number, number],
  range: readonly [number, number],
): (value: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  if (d1 === d0) return () => (r0 + r1) / 2;
  return (value) => r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);
}

/**
 * A domain that fits every value with a little room above and below. Bars start at zero, so a
 * chart never exaggerates a small difference by cutting the axis.
 */
export function chartDomain(
  values: readonly number[],
  options: { zero?: boolean } = {},
): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [0, 1];
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (options.zero) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  if (min === max) return [min - 1, max + 1];
  const pad = (max - min) * 0.1;
  return [options.zero && min === 0 ? 0 : min - pad, max + pad];
}

/** The SVG path through the points; gaps (null or non-finite values) break the line. */
export function linePath(
  values: readonly (number | null)[],
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  let path = '';
  let pen = false;
  values.forEach((value, i) => {
    if (value === null || !Number.isFinite(value)) {
      pen = false;
      return;
    }
    path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(value).toFixed(1)} `;
    pen = true;
  });
  return path.trim();
}

/** Share of a whole, clamped to 0..1. A zero or missing total is 0. */
export function share(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, value / total));
}

/** The stroke dash for a donut arc of `fraction` (0..1) on a circle of `radius`. */
export function donutDash(fraction: number, radius: number): { length: number; gap: number } {
  const circumference = 2 * Math.PI * radius;
  const length = circumference * Math.min(1, Math.max(0, fraction));
  return { length, gap: circumference - length };
}

// ---- KPI -----------------------------------------------------------------------------------

interface KpiProps {
  label: string;
  value: ReactNode;
  /** Change since the previous period. `good` says whether the direction is good news. */
  delta?: { label: string; direction: 'up' | 'down'; good?: boolean } | undefined;
  hint?: ReactNode;
  loading?: boolean;
  /** When set, the card shows a dash and this line instead of a value. */
  empty?: string | undefined;
}

/** A KPI card: muted label, a 25px tabular value, an optional delta pill and a hint. */
export function Kpi({ label, value, delta, hint, loading = false, empty }: KpiProps) {
  const good = delta ? (delta.good ?? delta.direction === 'up') : true;
  return (
    <div className="card-app p-4 sm:p-5" aria-busy={loading || undefined}>
      <p className="text-[12px] text-sub">{label}</p>
      {loading ? (
        <>
          <Skeleton className="mt-2 h-6 w-24" />
          <span className="sr-only">Loading {label}</span>
        </>
      ) : empty !== undefined ? (
        <>
          <p className="mt-1.5 text-[25px] leading-none font-bold text-[var(--chart-marker)]">
            <span aria-hidden="true">—</span>
            <span className="sr-only">No data yet</span>
          </p>
          <p className="mt-1.5 text-[11.5px] text-sub">{empty}</p>
        </>
      ) : (
        <>
          <p className="tabular mt-1.5 flex flex-wrap items-baseline gap-2">
            <b className="text-[25px] leading-none tracking-[-0.02em]">{value}</b>
            {delta && (
              <span
                className={`rounded-pill px-1.5 py-0.5 text-[10.5px] font-semibold ${
                  good ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'
                }`}
              >
                <span aria-hidden="true">{delta.direction === 'up' ? '↑' : '↓'}</span>
                <span className="sr-only">{delta.direction === 'up' ? 'Up' : 'Down'}</span>{' '}
                {delta.label}
              </span>
            )}
          </p>
          {hint && <p className="mt-1.5 text-[11.5px] text-sub">{hint}</p>}
        </>
      )}
    </div>
  );
}

// ---- Charts --------------------------------------------------------------------------------

interface ChartSeries {
  label: string;
  values: readonly (number | null)[];
}

interface ChartProps {
  title: string;
  subtitle?: string;
  /** One label per point (x axis). */
  labels: readonly string[];
  series: readonly ChartSeries[];
  format?: (value: number) => string;
  loading?: boolean;
  error?: string | null | undefined;
  /** Shown when there are no values to plot. */
  empty?: ReactNode;
}

const W = 600;
const H = 140;

function hasValues(series: readonly ChartSeries[]): boolean {
  return series.some((s) => s.values.some((v) => v !== null && Number.isFinite(v)));
}

/** The text alternative: every value of every series, in order. */
export function describeChart(
  labels: readonly string[],
  series: readonly ChartSeries[],
  format: (value: number) => string = String,
): string {
  return series
    .map(
      (s) =>
        `${s.label}: ${s.values
          .map((v, i) => `${labels[i] ?? i + 1} ${v === null ? 'no data' : format(v)}`)
          .join(', ')}`,
    )
    .join('. ');
}

function ChartFrame({
  title,
  subtitle,
  series,
  children,
}: {
  title: string;
  subtitle?: string | undefined;
  series: readonly ChartSeries[];
  children: ReactNode;
}) {
  const id = useId();
  return (
    <figure aria-labelledby={`${id}-title`} className="grid gap-3">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span>
          <span id={`${id}-title`} className="block text-[15px] font-semibold tracking-[-0.02em]">
            {title}
          </span>
          {subtitle && <span className="block text-[12.5px] text-sub">{subtitle}</span>}
        </span>
        {series.length > 0 && (
          <span className="flex flex-wrap gap-3 text-[12px] text-sub">
            {series.map((s, i) => (
              <span key={s.label} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-pill"
                  style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
                />
                {s.label}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      {children}
    </figure>
  );
}

function ChartState({
  loading,
  error,
  empty,
  ready,
  children,
}: {
  loading: boolean;
  error: string | null | undefined;
  empty: ReactNode;
  ready: boolean;
  children: ReactNode;
}) {
  if (error) return <ErrorNotice message={error} />;
  if (loading)
    return (
      <div role="status" aria-label="Loading chart">
        <Skeleton className="h-[140px]" />
      </div>
    );
  if (!ready)
    return (
      <div className="grid min-h-[140px] place-items-center rounded-[14px] border border-dashed border-lavender-line bg-surface-alt px-6 text-center text-[13px] text-sub">
        {empty}
      </div>
    );
  return <>{children}</>;
}

function XLabels({ labels }: { labels: readonly string[] }) {
  return (
    <div className="flex justify-between text-[11.5px] text-sub" aria-hidden="true">
      {labels.map((label, i) => (
        <span key={`${label}-${i}`} className="tabular">
          {label}
        </span>
      ))}
    </div>
  );
}

/** A line chart, one line per series, with a dot on each point. */
export function LineChart({
  title,
  subtitle,
  labels,
  series,
  format = String,
  loading = false,
  error,
  empty = 'No data yet.',
}: ChartProps) {
  const domain = chartDomain(
    series.flatMap((s) => s.values.filter((v): v is number => v !== null)),
  );
  const x = scaleLinear([0, Math.max(1, labels.length - 1)], [0, W]);
  const y = scaleLinear(domain, [H, 0]);
  return (
    <ChartFrame title={title} subtitle={subtitle} series={series}>
      <ChartState loading={loading} error={error} empty={empty} ready={hasValues(series)}>
        <svg
          role="img"
          aria-label={describeChart(labels, series, format)}
          viewBox={`-6 -8 ${W + 12} ${H + 16}`}
          className="w-full"
        >
          {[0, 0.5, 1].map((t) => (
            <line key={t} x1="0" x2={W} y1={H * t} y2={H * t} stroke="var(--chart-grid)" />
          ))}
          {series.map((s, si) => {
            const color = SERIES_COLORS[si % SERIES_COLORS.length];
            return (
              <g key={s.label}>
                <path
                  d={linePath(s.values, x, y)}
                  fill="none"
                  stroke={color}
                  strokeWidth="2.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {s.values.map((v, i) =>
                  v === null || !Number.isFinite(v) ? null : (
                    <circle
                      key={i}
                      cx={x(i)}
                      cy={y(v)}
                      r="3"
                      fill="var(--surface)"
                      stroke={color}
                      strokeWidth="2"
                    >
                      <title>{`${s.label}, ${labels[i] ?? i + 1}: ${format(v)}`}</title>
                    </circle>
                  ),
                )}
              </g>
            );
          })}
        </svg>
        <XLabels labels={labels} />
      </ChartState>
    </ChartFrame>
  );
}

/** A bar chart from zero; several series sit side by side in each group. */
export function BarChart({
  title,
  subtitle,
  labels,
  series,
  format = String,
  loading = false,
  error,
  empty = 'No data yet.',
}: ChartProps) {
  const domain = chartDomain(
    series.flatMap((s) => s.values.filter((v): v is number => v !== null)),
    { zero: true },
  );
  const y = scaleLinear(domain, [H, 0]);
  const group = W / Math.max(1, labels.length);
  const bar = Math.min(28, (group * 0.7) / Math.max(1, series.length));
  return (
    <ChartFrame title={title} subtitle={subtitle} series={series}>
      <ChartState loading={loading} error={error} empty={empty} ready={hasValues(series)}>
        <svg
          role="img"
          aria-label={describeChart(labels, series, format)}
          viewBox={`0 -8 ${W} ${H + 8}`}
          className="w-full"
        >
          {[0, 0.5, 1].map((t) => (
            <line key={t} x1="0" x2={W} y1={H * t} y2={H * t} stroke="var(--chart-grid)" />
          ))}
          {labels.map((label, i) => {
            const start = i * group + (group - bar * series.length) / 2;
            return series.map((s, si) => {
              const v = s.values[i];
              if (v === null || v === undefined || !Number.isFinite(v)) return null;
              const top = Math.min(y(v), y(0));
              return (
                <rect
                  key={`${label}-${s.label}`}
                  x={start + si * bar}
                  y={top}
                  width={Math.max(1, bar - 3)}
                  height={Math.max(1, Math.abs(y(0) - y(v)))}
                  rx="4"
                  fill={SERIES_COLORS[si % SERIES_COLORS.length]}
                >
                  <title>{`${s.label}, ${label}: ${format(v)}`}</title>
                </rect>
              );
            });
          })}
        </svg>
        <XLabels labels={labels} />
      </ChartState>
    </ChartFrame>
  );
}

// ---- Donut and progress --------------------------------------------------------------------

interface DonutProps {
  /** Names what the donut measures, e.g. "Opened". */
  label: string;
  value: number;
  total: number;
  /** The center text; the rounded percentage when absent. */
  center?: string;
  size?: number;
  loading?: boolean;
}

/** A donut: 16px stroke on a light track with rounded caps and a label in the middle. */
export function Donut({ label, value, total, center, size = 132, loading = false }: DonutProps) {
  const stroke = 16;
  const radius = (size - stroke) / 2;
  const fraction = share(value, total);
  const { length, gap } = donutDash(fraction, radius);
  const text = center ?? `${Math.round(fraction * 100)}%`;
  if (loading) {
    return (
      <div role="status" aria-label={`Loading ${label}`}>
        <span
          aria-hidden="true"
          className="block animate-pulse rounded-pill bg-surface-alt"
          style={{ width: size, height: size }}
        />
      </div>
    );
  }
  return (
    <figure className="grid justify-items-center gap-2">
      <svg
        role="img"
        aria-label={`${label}: ${text} (${value} of ${total})`}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--chart-track)"
          strokeWidth={stroke}
        />
        {length > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--chart-1)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${length} ${gap}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          className="tabular fill-ink text-[20px] font-bold"
        >
          {text}
        </text>
      </svg>
      <figcaption className="text-[12.5px] text-sub">{label}</figcaption>
    </figure>
  );
}

interface ProgressProps {
  label: string;
  value: number;
  max: number;
  /** The meta row under the meter, e.g. "120 triggered · 80 completed". */
  meta?: ReactNode;
  /** How the value reads aloud and on screen; "value of max" when absent. */
  valueText?: string;
}

/** A progress meter: 5px track, indigo fill, label and value above, meta below. */
export function Progress({ label, value, max, meta, valueText }: ProgressProps) {
  const id = useId();
  const fraction = share(value, max);
  const text = valueText ?? `${value} of ${max}`;
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span id={id} className="font-semibold">
          {label}
        </span>
        <span className="tabular text-sub">{text}</span>
      </div>
      <div
        role="progressbar"
        aria-labelledby={id}
        aria-valuemin={0}
        aria-valuemax={max > 0 ? max : 1}
        aria-valuenow={Math.min(Math.max(0, value), max > 0 ? max : 1)}
        aria-valuetext={text}
        className="h-[5px] overflow-hidden rounded-pill bg-[var(--meter-track)]"
      >
        <div
          className="h-full rounded-pill bg-purple transition-[width] duration-300"
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
      {meta && <p className="tabular text-[12px] text-sub">{meta}</p>}
    </div>
  );
}
