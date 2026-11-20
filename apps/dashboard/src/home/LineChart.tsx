// A small hand-drawn line chart: night line, white dots, the last value labelled directly.
// The SVG is drawn at the container's real width so text never stretches.
import { useEffect, useRef, useState } from 'react';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function LineChart({
  values,
  min,
  max,
  ticks,
  format,
  lastLabel,
  xLabels,
  dots = true,
  label,
  height = 112,
}: {
  values: number[];
  min: number;
  max: number;
  ticks: number[];
  format: (value: number) => string;
  lastLabel: string;
  /** Labels under the x axis; empty strings are skipped. */
  xLabels?: string[];
  dots?: boolean;
  /** What the chart says, for screen readers. */
  label: string;
  height?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const n = values.length;
  const pl = 46;
  const pr = 58;
  const pt = 8;
  const pb = xLabels ? 26 : 8;
  const iw = Math.max(1, w - pl - pr);
  const ih = height - pt - pb;
  const X = (i: number) => pl + (n > 1 ? (i * iw) / (n - 1) : iw / 2);
  const Y = (v: number) => pt + ih - ((v - min) / (max - min || 1)) * ih;
  const lastValue = values[n - 1] ?? 0;

  return (
    <div ref={ref} style={{ height }}>
      {w > 0 && n > 0 && (
        <svg
          width={w}
          height={height}
          viewBox={`0 0 ${w} ${height}`}
          role="img"
          aria-label={label}
          className="block overflow-visible"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pl} x2={w - pr + 10} y1={Y(t)} y2={Y(t)} stroke="var(--chart-grid)" />
              <text
                x={pl - 10}
                y={Y(t)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-sub font-mono text-[11px]"
              >
                {format(t)}
              </text>
            </g>
          ))}
          <polyline
            points={values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}
            fill="none"
            stroke="var(--chart-1)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {values.map((v, i) =>
            dots || i === n - 1 ? (
              <circle
                key={i}
                cx={X(i)}
                cy={Y(v)}
                r={dots ? 3.5 : 4}
                fill={i === n - 1 ? 'var(--chart-1)' : 'var(--surface)'}
                stroke="var(--chart-1)"
                strokeWidth="2"
              />
            ) : null,
          )}
          <text
            x={X(n - 1) + 10}
            y={Y(lastValue)}
            dominantBaseline="middle"
            className="fill-ink text-[13px] font-[650]"
          >
            {lastLabel}
          </text>
          {xLabels?.map((l, i) =>
            l ? (
              <text
                key={i}
                x={X(i)}
                y={height - 6}
                textAnchor={!dots && i === 0 ? 'start' : !dots && i === n - 1 ? 'end' : 'middle'}
                className="fill-sub text-[12px]"
              >
                {l}
              </text>
            ) : null,
          )}
        </svg>
      )}
    </div>
  );
}

/** Round chart bounds around the data, so the line uses the height. */
export function chartScale(
  values: number[],
  step: number,
): { min: number; max: number; ticks: number[] } {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  let min = Math.floor(lo / step) * step;
  let max = Math.ceil(hi / step) * step;
  if (min === max) {
    min -= step;
    max += step;
  }
  const ticks = [min, (min + max) / 2, max];
  return { min, max, ticks };
}
