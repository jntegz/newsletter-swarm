// The plain sentences a subscriber's page says about each live automation. Every string is a whole
// sentence, so each one can be translated on its own.
import type { FlowEnrolDecision, MemberFlowHistory, MemberStatus } from '@swarm/domain';
import { TRIGGER_LABEL } from './graph';

type Run = NonNullable<MemberFlowHistory['run']>;

function stoppedSentence(run: Run, memberStatus: MemberStatus): string | null {
  if (run.status === 'running' || run.status === 'waiting') return 'Still in this automation.';
  if (run.status === 'completed') return 'Finished.';
  if (run.status === 'paused') {
    return run.exitReason === 'flow_paused'
      ? 'On hold: the automation is paused.'
      : 'On hold: a step failed.';
  }
  if (run.status === 'failed') return 'Stopped: a step kept failing.';
  switch (run.exitReason) {
    case 'exit_node':
      return 'Stopped: reached an exit step.';
    case 'member_inactive':
      switch (memberStatus) {
        case 'unsubscribed':
          return 'Stopped: unsubscribed.';
        case 'bounced':
          return 'Stopped: their address bounced.';
        case 'complained':
          return 'Stopped: they marked an email as spam.';
        case 'paused':
          return 'Stopped: their subscription was paused.';
        case 'pending':
          return 'Stopped: they had not confirmed.';
        case 'active':
          return 'Stopped: they were not active at the time.';
      }
      break;
    case 'suppressed':
      return 'Stopped: their address is on the do-not-send list.';
    case 'not_entitled':
      return 'Stopped: the next email is for paid subscribers.';
    case 'already_paid':
      return 'Stopped: the next email is for free subscribers.';
    case 'invalid_reference':
      return 'Stopped: something this automation uses was deleted.';
    case 'flow_archived':
      return 'Stopped: the automation was archived.';
    case 'operator':
      return 'Stopped: a teammate stopped it.';
    case 'migrated':
      return 'Stopped: moved to a newer version.';
    default:
      break;
  }
  return 'Stopped.';
}

function emailsSentence(run: Run): string | null {
  const { emailsReceived: got, emailsPossible: of } = run;
  if (of === 0) return null;
  if (of === 1) return got === 1 ? 'Got its one email.' : 'Has not got its one email.';
  return `Got ${got} of ${of} emails.`;
}

function decisionSentence(reason: FlowEnrolDecision, name: string, day: string): string {
  switch (reason) {
    case 'not_in_segment':
      return `Didn't enter ${name} on ${day}: not in the segment.`;
    case 'filter_miss':
      return `Didn't enter ${name} on ${day}: did not match the rule.`;
    case 'already_in':
      return `Skipped ${name} on ${day}: already in this automation.`;
    case 'already_ran_version':
      return `Skipped ${name} on ${day}: already went through this version.`;
    case 'already_ran_earlier':
      return `Skipped ${name} on ${day}: already went through an earlier version.`;
    case 'rate_limited':
      return `Skipped ${name} on ${day}: started too many times in the last hour.`;
  }
}

/** What happened with one live automation, as sentences in the order they happened. */
export function whySentences(
  item: MemberFlowHistory,
  memberStatus: MemberStatus,
  formatDay: (iso: string) => string,
): string[] {
  const { flowName: name, run, decision } = item;
  const sentences: string[] = [];
  if (run) {
    sentences.push(`Entered ${name} on ${formatDay(run.startedAt)}.`);
    sentences.push(
      run.startedBy
        ? `Start event: ${TRIGGER_LABEL[run.startedBy.event]}.`
        : 'Added by a teammate, another automation or the API.',
    );
    const emails = emailsSentence(run);
    if (emails) sentences.push(emails);
    const stopped = stoppedSentence(run, memberStatus);
    if (stopped) sentences.push(stopped);
  }
  if (decision) {
    sentences.push(decisionSentence(decision.reason, name, formatDay(decision.decidedAt)));
    sentences.push(`Start event: ${TRIGGER_LABEL[decision.event]}.`);
  }
  if (!run && !decision) {
    sentences.push(`Hasn't entered ${name}.`);
    sentences.push('No start event has been recorded for this subscriber.');
  }
  return sentences;
}
