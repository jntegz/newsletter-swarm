import type { FlowExitReason, FlowRunCounts, FlowRunStatus, FlowStatus } from '@swarm/domain';
import { Pill } from '@swarm/ui/components';

type Tone = 'success' | 'scheduled' | 'brand' | 'neutral' | 'danger';

const FLOW_PILL: Record<FlowStatus, { tone: Tone; label: string }> = {
  draft: { tone: 'brand', label: 'Draft' },
  live: { tone: 'success', label: 'Live' },
  paused: { tone: 'scheduled', label: 'Paused' },
  archived: { tone: 'neutral', label: 'Archived' },
};

export function FlowPill({ status }: { status: FlowStatus }) {
  const pill = FLOW_PILL[status];
  return <Pill tone={pill.tone}>{pill.label}</Pill>;
}

const RUN_PILL: Record<FlowRunStatus, { tone: Tone; label: string }> = {
  running: { tone: 'scheduled', label: 'Running' },
  waiting: { tone: 'brand', label: 'Waiting' },
  paused: { tone: 'scheduled', label: 'Paused' },
  completed: { tone: 'success', label: 'Completed' },
  exited: { tone: 'neutral', label: 'Exited' },
  failed: { tone: 'danger', label: 'Failed' },
};

export const RUN_STATUS_LABEL = Object.fromEntries(
  Object.entries(RUN_PILL).map(([k, v]) => [k, v.label]),
) as Record<FlowRunStatus, string>;

export function RunPill({ status }: { status: FlowRunStatus }) {
  const pill = RUN_PILL[status];
  return <Pill tone={pill.tone}>{pill.label}</Pill>;
}

export const EXIT_REASON_LABEL: Record<FlowExitReason, string> = {
  exit_node: 'Reached an exit step',
  member_inactive: 'Subscriber is no longer active',
  suppressed: 'Address is suppressed',
  not_entitled: 'Not a paying subscriber',
  already_paid: 'Already a paying subscriber',
  invalid_reference: 'A step refers to something that no longer exists',
  flow_archived: 'Automation was archived',
  operator: 'Stopped by a teammate',
  migrated: 'Moved to a newer version',
  hold_expired: 'Held too long, so the email was not sent',
  step_failed: 'A step failed and the run is paused',
  flow_paused: 'Automation is paused',
};

/** Runs that have not ended yet. */
export const openRuns = (runs: FlowRunCounts) => runs.running + runs.waiting + runs.paused;
export const totalRuns = (runs: FlowRunCounts) =>
  openRuns(runs) + runs.completed + runs.exited + runs.failed;
