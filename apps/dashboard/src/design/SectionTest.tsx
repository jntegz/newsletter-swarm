// Section analytics and A/B tests in the Sections panel (docs/site-themes.md): the period the
// numbers are for, the A | B switch on a section with a running test, and the test's results
// card with Use B and Keep A. The rates and how sure they are come from the API, which computes
// them with @swarm/site-themes testResult; a test the API doesn't know yet starts at zero.
import type { SectionExperiment, SectionInstance, TestResult, Variant } from '@swarm/site-themes';
import { testResult } from '@swarm/site-themes';
import { Button } from '@swarm/ui/components';
import { useId } from 'react';
import { STATS_DAYS, type StatsDays } from '../api/design';
import { formatCount, formatDay, formatRate, resultInWords } from './tests';
import { useStudio } from './studio';

/** A segmented control, like the studio's other 2 to 4 choices. */
function Segmented<T extends string | number>({
  legend,
  options,
  value,
  onChange,
  disabled = false,
  hideLegend = false,
}: {
  legend: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  hideLegend?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="grid grid-cols-[minmax(0,1fr)] gap-1.5" disabled={disabled}>
      <legend className={hideLegend ? 'sr-only' : 'mb-1.5 text-[13px] font-semibold'}>
        {legend}
      </legend>
      <div className="flex rounded-control border border-line bg-surface-alt p-[3px]">
        {options.map((option) => {
          const checked = value === option.value;
          return (
            <label
              key={String(option.value)}
              className={`inline-flex min-h-[30px] flex-1 cursor-pointer items-center justify-center rounded-[6px] px-2 text-center text-[13px] whitespace-nowrap transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-purple ${
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
                onChange={() => onChange(option.value)}
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

const PERIODS = STATS_DAYS.map((days) => ({ value: days, label: `${days} days` }));

/** The period the numbers beside the sections are for, and what they count. */
export function StatsPeriod() {
  const { statsDays, setStatsDays, statsError, retryStats } = useStudio();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <Segmented<StatsDays>
        legend="Numbers for the last"
        options={PERIODS}
        value={statsDays}
        onChange={setStatsDays}
      />
      {statsError ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-danger">
          The numbers didn’t load.
          <Button variant="ghost" size="sm" onClick={retryStats}>
            Try again
          </Button>
        </p>
      ) : (
        <p className="text-[13px] leading-[1.55] text-sub">
          Views of the live home page that reached each section, and signups through its form.
        </p>
      )}
    </div>
  );
}

const VARIANTS = [
  { value: 'a' as const, label: 'A, the original' },
  { value: 'b' as const, label: 'B, the variant' },
];

/** Which variant's settings the form below edits. */
export function VariantSwitch({
  value,
  onChange,
}: {
  value: Variant;
  onChange: (variant: Variant) => void;
}) {
  return (
    <Segmented<Variant>
      legend="Edit variant"
      options={VARIANTS}
      value={value}
      onChange={onChange}
    />
  );
}

/** Two horizontal bars on one scale: each variant's signup rate, with its figures beside it. */
function RateBars({ result }: { result: TestResult }) {
  const top = Math.max(result.a.rate, result.b.rate);
  const rows = [
    { variant: 'A', ...result.a },
    { variant: 'B', ...result.b },
  ];
  return (
    <ul className="grid gap-2.5" aria-label="Signup rate by variant">
      {rows.map((row) => {
        const width = top > 0 ? Math.max(2, (row.rate / top) * 100) : 0;
        const words = `${formatRate(row.rate)}, ${formatCount(row.signups)} ${row.signups === 1 ? 'signup' : 'signups'} of ${formatCount(row.reached)} reached`;
        return (
          <li
            key={row.variant}
            className="grid grid-cols-[20px_minmax(0,1fr)] items-center gap-x-2 gap-y-1"
          >
            <span className="text-[13px] font-semibold">{row.variant}</span>
            <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
              <span
                className="block h-2.5 min-w-0"
                aria-hidden="true"
                title={`${row.variant}: ${words}`}
              >
                {width > 0 && (
                  <span
                    className="block h-full rounded-r-[4px] bg-[var(--chart-1)]"
                    style={{ width: `${width}%` }}
                  />
                )}
              </span>
              <span className="text-[13px] font-semibold tabular-nums">{formatRate(row.rate)}</span>
            </span>
            <span className="col-start-2 text-[12.5px] text-sub">
              <span className="sr-only">Variant {row.variant}: </span>
              {formatCount(row.signups)} {row.signups === 1 ? 'signup' : 'signups'} of{' '}
              {formatCount(row.reached)} reached
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A section's A/B test: how it stands in words and as two bars, Use B and Keep A while it runs,
 * and what the numbers count.
 */
export function TestResults({
  section,
  experiment,
  hasForm,
  onEnd,
}: {
  section: SectionInstance;
  experiment: SectionExperiment;
  hasForm: boolean;
  onEnd: (winner: Variant) => void;
}) {
  const { stats, server, canEdit } = useStudio();
  const known = stats?.tests.find(
    (t) => t.sectionId === section.id && t.experimentId === experiment.id,
  );
  const result: TestResult =
    known ?? testResult({ reached: 0, signups: 0 }, { reached: 0, signups: 0 });
  const live = (server.published?.sections ?? []).some(
    (s) =>
      s.id === section.id &&
      s.experiment?.id === experiment.id &&
      s.experiment.status === 'running',
  );
  const running = experiment.status === 'running';
  const headingId = useId();
  const status = running
    ? live
      ? `Running since ${formatDay(experiment.startedAt)}`
      : 'Not published yet'
    : `Ended${experiment.endedAt ? ` ${formatDay(experiment.endedAt)}` : ''}${experiment.winner ? `, ${experiment.winner === 'b' ? 'B used' : 'A kept'}` : ''}`;
  return (
    <section
      aria-labelledby={headingId}
      className="grid grid-cols-[minmax(0,1fr)] gap-3 rounded-card border border-line p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 id={headingId} className="text-[15px] font-semibold">
          A/B test
        </h3>
        <span className="text-[13px] text-sub">{status}</span>
      </div>
      <p className="text-[14px] font-semibold" aria-live="polite">
        {stats || !running ? resultInWords(result) : 'Loading the results…'}
      </p>
      {result.a.reached + result.b.reached > 0 && (
        <figure className="grid gap-2">
          <RateBars result={result} />
          <figcaption className="text-[12.5px] text-sub">
            Signup rate of each variant since the test started on {formatDay(experiment.startedAt)}.
          </figcaption>
        </figure>
      )}
      {!hasForm && (
        <p className="text-[13px] text-warn">
          This section has no signup form of its own, so its signups stay at 0.
        </p>
      )}
      {running && !live && (
        <p className="text-[13px] text-sub">
          Publish to start the test. Until then the site shows A to everyone.
        </p>
      )}
      {!running && (
        <p className="text-[13px] text-sub">
          Its settings are in the draft. Publish to put them live.
        </p>
      )}
      <p className="text-[12.5px] leading-[1.55] text-sub">
        These count views, not people: the site sets no cookies, so a reader who comes back may see
        the other variant.
      </p>
      {running && canEdit && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <Button variant="ghost" size="sm" onClick={() => onEnd('b')}>
            Use B
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onEnd('a')}>
            Keep A
          </Button>
          <p className="basis-full text-[12.5px] text-sub">
            Either ends the test. Use B makes B’s settings the section’s own.
          </p>
        </div>
      )}
    </section>
  );
}
