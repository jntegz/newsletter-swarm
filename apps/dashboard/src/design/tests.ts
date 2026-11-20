// A/B tests on a section and the numbers beside each section (docs/site-themes.md): starting and
// ending a test as a change to the draft, and saying results in words. Pure, so it is tested on
// its own; the rates and confidence come from @swarm/site-themes, as the API's do.
import type { SectionInstance, TestResult, Variant } from '@swarm/site-themes';
import { MAX_RUNNING_TESTS, isTesting } from '@swarm/site-themes';
import type { DesignStats, SectionCounts } from '../api/design';

const number = new Intl.NumberFormat('en');
const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

export const formatCount = (n: number) => number.format(n);

/** "3.2%": one decimal, "0%" for nothing. */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '0%';
  return `${(rate * 100).toFixed(1)}%`;
}

export const formatDay = (iso: string) => dayFormat.format(new Date(iso));

/** Why a test can't start on this section now, or null. */
export function testProblem(sections: readonly SectionInstance[], id: string): string | null {
  const section = sections.find((s) => s.id === id);
  if (!section) return 'This section isn’t on the page.';
  if (isTesting(section)) return 'A test is already running here.';
  const running = sections.filter(isTesting).length;
  if (running >= MAX_RUNNING_TESTS)
    return `${MAX_RUNNING_TESTS} tests are running. End one to start another.`;
  return null;
}

/** A new test id: short, unique enough per section, and a valid id for the engine. */
const newTestId = (now: number) => `t${now.toString(36)}`;

/** The section with a test started: B starts as a copy of A. An ended test is replaced. */
export function startTest(
  sections: readonly SectionInstance[],
  id: string,
  now = Date.now(),
): SectionInstance[] {
  return sections.map((s) =>
    s.id === id
      ? {
          ...s,
          experiment: {
            id: newTestId(now),
            status: 'running',
            variantB: structuredClone(s.settings),
            startedAt: new Date(now).toISOString(),
          },
        }
      : s,
  );
}

/**
 * The test ended with a winner: B's settings become the section's own ("Use B"), or A's stay
 * ("Keep A"). The test stays on the section with its dates, so its results can still be read.
 */
export function endTest(
  sections: readonly SectionInstance[],
  id: string,
  winner: Variant,
  now = Date.now(),
): SectionInstance[] {
  return sections.map((s) => {
    if (s.id !== id || !s.experiment) return s;
    return {
      ...s,
      settings: winner === 'b' ? structuredClone(s.experiment.variantB) : s.settings,
      experiment: {
        ...s.experiment,
        status: 'ended',
        endedAt: new Date(now).toISOString(),
        winner,
      },
    };
  });
}

/** One variant's settings changed: A is the section's own, B the test's. */
export function withVariantSettings(
  sections: readonly SectionInstance[],
  id: string,
  variant: Variant,
  change: (settings: Record<string, unknown>) => Record<string, unknown>,
): SectionInstance[] {
  return sections.map((s) => {
    if (s.id !== id) return s;
    if (variant === 'b' && s.experiment)
      return { ...s, experiment: { ...s.experiment, variantB: change(s.experiment.variantB) } };
    return { ...s, settings: change(s.settings) };
  });
}

/** A section's numbers over the period, both variants together; null without any row. */
export function sectionCounts(
  stats: DesignStats | undefined,
  sectionId: string,
): SectionCounts | null {
  const rows = stats?.sections.filter((r) => r.sectionId === sectionId) ?? [];
  if (!rows.length) return null;
  return rows.reduce(
    (sum, r) => ({ reached: sum.reached + r.reached, signups: sum.signups + r.signups }),
    { reached: 0, signups: 0 },
  );
}

/**
 * The line under a section in the list: "1,204 reached · 38 signups · 3.2%". A section with no
 * signup form says how many it reached only.
 */
export function countsLine(counts: SectionCounts | null, hasForm: boolean, days: number): string {
  if (!counts || counts.reached === 0) {
    return counts?.signups
      ? `${formatCount(counts.signups)} ${counts.signups === 1 ? 'signup' : 'signups'}`
      : `Not reached in the last ${days} days`;
  }
  const reached = `${formatCount(counts.reached)} reached`;
  if (!hasForm && counts.signups === 0) return reached;
  const signups = `${formatCount(counts.signups)} ${counts.signups === 1 ? 'signup' : 'signups'}`;
  return `${reached} · ${signups} · ${formatRate(counts.signups / counts.reached)}`;
}

/** How sure, in whole percent, never rounded up to a level it hasn't reached. */
const surePercent = (confidence: number) => Math.min(99, Math.floor(confidence * 100));

/**
 * A result in words: "B is ahead: 4.1% against 3.2%, 96% sure", or "Not enough yet: about
 * 1,800 more views to tell".
 */
export function resultInWords(result: TestResult): string {
  const { a, b } = result;
  if (a.reached + b.reached === 0) return 'No views yet. Results show once the page is visited.';
  if (result.decided && result.leader) {
    const [lead, other] = result.leader === 'b' ? [b, a] : [a, b];
    return `${result.leader.toUpperCase()} is ahead: ${formatRate(lead.rate)} against ${formatRate(other.rate)}, ${surePercent(result.confidence)}% sure`;
  }
  if (result.viewsNeeded && result.viewsNeeded > 0)
    return `Not enough yet: about ${formatCount(result.viewsNeeded)} more views to tell`;
  if (a.signups + b.signups === 0) return 'Not enough yet: no signups from either variant so far';
  return 'Not enough yet: both variants sign up at the same rate so far';
}
