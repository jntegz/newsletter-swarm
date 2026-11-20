// The check-up's decisions, apart from its rendering so they are tested without a browser.
import type { CheckupFinding, CheckupSeverity, DeliverabilityCheckup } from '@swarm/domain';

const SEVERITY_ORDER: readonly CheckupSeverity[] = ['problem', 'warning', 'unknown', 'good'];

/** What each group of findings is called, and the line under its heading. */
export const GROUP_COPY: Record<CheckupSeverity, { title: string; hint: string }> = {
  problem: {
    title: 'Fix these first',
    hint: 'These stop email from arriving or send it to spam.',
  },
  warning: {
    title: 'Worth improving',
    hint: 'Not urgent, but each one makes the inbox more likely.',
  },
  unknown: {
    title: 'Couldn’t check',
    hint: 'No result either way. This does not mean something is wrong.',
  },
  good: { title: 'Working well', hint: 'Nothing to do here.' },
};

/** For screen readers, before a finding's title. */
export const SEVERITY_WORD: Record<CheckupSeverity, string> = {
  problem: 'Problem',
  warning: 'Warning',
  unknown: 'Couldn’t check',
  good: 'Good',
};

interface FindingGroup {
  severity: CheckupSeverity;
  findings: CheckupFinding[];
}

/** Findings by severity, most serious group first, keeping the server's order inside each. */
export function groupFindings(findings: readonly CheckupFinding[]): FindingGroup[] {
  return SEVERITY_ORDER.map((severity) => ({
    severity,
    findings: findings.filter((finding) => finding.severity === severity),
  })).filter((group) => group.findings.length > 0);
}

const things = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The headline and the sentence under it. */
export function verdictCopy(checkup: Pick<DeliverabilityCheckup, 'verdict' | 'counts'>): {
  tone: 'danger' | 'warn' | 'success';
  headline: string;
  detail: string;
} {
  const { problem, warning, unknown } = checkup.counts;
  const unchecked = unknown
    ? ` ${things(unknown, 'check', 'checks')} couldn’t run, so ${unknown === 1 ? 'that is' : 'those are'} still open.`
    : '';
  if (checkup.verdict === 'problems') {
    return {
      tone: 'danger',
      headline: `${things(problem, 'problem', 'problems')} to fix`,
      detail: `${problem === 1 ? 'This is' : 'These are'} the most likely reason email is not arriving. Start at the top: the list is in order of what hurts most.${unchecked}`,
    };
  }
  if (checkup.verdict === 'warnings') {
    return {
      tone: 'warn',
      headline: `No problems, ${things(warning, 'thing', 'things')} to improve`,
      detail: `Nothing here stops your email. Each improvement makes the inbox more likely.${unchecked}`,
    };
  }
  return {
    tone: 'success',
    headline: unknown ? 'No problems found' : 'Everything checks out',
    detail: unknown
      ? `Every check that ran came back fine.${unchecked}`
      : 'Your setup, your numbers and your list all look healthy. Run this again after a big send or a change to your domain.',
  };
}

/** A finding's React key: the check, and what it is about when a check runs more than once. */
export const findingKey = (finding: Pick<CheckupFinding, 'id' | 'subject' | 'severity'>) =>
  `${finding.id}:${finding.subject ?? ''}:${finding.severity}`;

/** "just now", "5 minutes ago", then the clock time. */
export function checkedAgo(checkedAt: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(checkedAt)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/** How the score is worked out. Same rule as CHECKUP in @swarm/domain. */
export const SCORE_NOTE =
  'The score starts at 100. Each problem takes off 20 and each warning 5, and it never goes below 0. Checks that couldn’t run don’t change it.';
