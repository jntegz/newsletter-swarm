// The plain sentences of a rehearsal and of Add people. Every string is a whole sentence with only a
// name, number or time filled in, so each one can be translated on its own.
import type {
  FlowEnrolDecision,
  FlowEnrolVerdict,
  FlowRehearsal,
  FlowRehearsalCondition,
  FlowRehearsalHold,
  FlowRehearsalStep,
  InboxHoldReason,
} from '@swarm/domain';
import { waitingSentence, holdTime } from './inbox-rules';
import { EDGE_LABEL } from './graph';
import { EXIT_REASON_LABEL } from './status';
import type { Names } from './summary';

const formatWhen = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso)) + ' UTC';

const quoted = (name: string | undefined, fallback: string) => (name ? `“${name}”` : fallback);

const isInboxReason = (reason: FlowRehearsalHold['reason']): reason is InboxHoldReason =>
  reason !== 'channel_paused' && reason !== 'ramp_full' && reason !== 'ramp_paused';

/** Why an email waited, in the words the Runs tab uses for a real hold. */
export function holdSentence(hold: FlowRehearsalHold, now: number): string {
  if (hold.reason === 'channel_paused') {
    return 'Held: the publication is paused. A rehearsal can’t know when it comes back, so it carries on as if it had.';
  }
  if (hold.reason === 'ramp_paused') {
    return 'Held: the warm-up is paused. A rehearsal can’t know when it comes back, so it carries on as if it had.';
  }
  const until = hold.until as string;
  if (hold.reason === 'ramp_full') {
    return `Held: today’s warm-up limit is reached, so this email waits until ${formatWhen(until)}.`;
  }
  if (!isInboxReason(hold.reason)) return 'Held.';
  const waiting = waitingSentence(hold.reason, holdTime(until, hold.zone ?? 'UTC', now));
  return hold.expired
    ? `${waiting} That is longer than the publication allows, so this email is not sent.`
    : waiting;
}

/** A condition of a branch, for this subscriber, as a sentence. */
export function conditionSentence(c: FlowRehearsalCondition): string {
  const value = Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '');
  switch (c.field) {
    case 'tag':
      if (c.cmp === 'is_set') return c.holds ? 'They have a tag.' : 'They have no tags.';
      return c.holds ? `They have the tag “${value}”.` : `They don’t have the tag “${value}”.`;
    case 'opened_days':
      if (c.cmp === 'not_within_days') {
        return c.holds
          ? `They haven’t opened an email in the last ${value} days.`
          : `They opened an email in the last ${value} days.`;
      }
      return c.holds
        ? `They opened an email in the last ${value} days.`
        : `They haven’t opened an email in the last ${value} days.`;
    case 'clicked_days':
      if (c.cmp === 'not_within_days') {
        return c.holds
          ? `They haven’t clicked in an email in the last ${value} days.`
          : `They clicked in an email in the last ${value} days.`;
      }
      return c.holds
        ? `They clicked in an email in the last ${value} days.`
        : `They haven’t clicked in an email in the last ${value} days.`;
    case 'level':
      return c.holds
        ? 'They are on a paid plan that fits.'
        : 'They aren’t on a paid plan that fits.';
    case 'circle':
      return c.holds ? 'They are in the segment.' : 'They aren’t in the segment.';
    case 'status':
      return c.holds ? `Their status fits: ${value}.` : `Their status doesn’t fit: ${value}.`;
    default: {
      const name = c.field.startsWith('field:') ? c.field.slice('field:'.length) : c.field;
      return c.holds
        ? `Their “${name}” matches the condition.`
        : `Their “${name}” doesn’t match the condition.`;
    }
  }
}

/** What one step would do, as sentences in order. */
export function stepSentences(step: FlowRehearsalStep, names: Names, now: number): string[] {
  const { detail } = step;
  switch (detail.kind) {
    case 'start':
      return step.status === 'skipped'
        ? ['Something this automation uses is outside this publication, so the run stops here.']
        : ['The run starts here.'];
    case 'email': {
      const holds = detail.holds.map((hold) => holdSentence(hold, now));
      const subject = quoted(detail.subject || undefined, 'this email');
      switch (detail.state) {
        case 'would_send':
          return [...holds, `Would send ${subject}.`];
        case 'already_sent':
          return [...holds, `Skips ${subject}: they already got it from this version.`];
        case 'already_received':
          return [...holds, `Skips ${subject}: they already got it from another version.`];
        case 'not_sent':
          return [...holds, `Doesn’t send ${subject}.`];
      }
      break;
    }
    case 'delay':
      return detail.until
        ? [`Waits until ${formatWhen(detail.until)}. The rehearsal jumps over the wait.`]
        : ['The time has already come, so it doesn’t wait.'];
    case 'wait': {
      const until = formatWhen(detail.until);
      if (detail.basis === 'already') {
        return [
          detail.event === 'open'
            ? 'They already opened this email, so they go straight on.'
            : 'They already clicked in this email, so they go straight on.',
        ];
      }
      if (detail.basis === 'no_email') {
        return [`No email reached them on this path, so the wait ends on ${until}.`];
      }
      if (detail.answer === 'yes') {
        return [
          detail.event === 'open'
            ? 'If they open the email, they go on at once.'
            : 'If they click in the email, they go on at once.',
        ];
      }
      return [
        detail.event === 'open'
          ? `If they don’t open the email, the wait ends on ${until}.`
          : `If they don’t click in the email, the wait ends on ${until}.`,
      ];
    }
    case 'branch': {
      const reasons = detail.because.map(conditionSentence);
      if (step.outcome === null) {
        return ['This condition can’t be read any more, so the run stops here.'];
      }
      const took = detail.matched ? `Took ${EDGE_LABEL.true}.` : `Took ${EDGE_LABEL.false}.`;
      return [took, ...reasons];
    }
    case 'split': {
      const path = detail.arm === 'a' ? EDGE_LABEL.a : EDGE_LABEL.b;
      return detail.picked
        ? [`Takes path ${path}, because you chose it.`]
        : [
            `Takes path ${path}. A real run draws this: ${detail.percentA}% go to A and ${100 - detail.percentA}% go to B.`,
          ];
    }
    case 'tag': {
      const tag = quoted(names.tag?.(detail.tagId), 'a tag');
      return [
        detail.action === 'add' ? `Would add the tag ${tag}.` : `Would remove the tag ${tag}.`,
      ];
    }
    case 'field':
      return [`Would change the profile field ${quoted(names.field?.(detail.fieldId), 'it')}.`];
    case 'level': {
      const level = quoted(names.level?.(detail.levelId), 'a paid plan');
      if (detail.unavailable) return [`Skips this step: ${level} isn’t available.`];
      return [
        detail.action === 'grant' ? `Would give them ${level}.` : `Would take away ${level}.`,
      ];
    }
    case 'enrol': {
      const flow = quoted(names.flow?.(detail.flowId), 'another automation');
      switch (detail.result) {
        case 'would_start':
          return [`Would start ${flow}. The rehearsal doesn’t follow what happens there.`];
        case 'not_eligible':
          return [`Skips this step: they can’t enter ${flow} right now.`];
        case 'not_live':
          return [`Skips this step: ${flow} isn’t live.`];
        default:
          return [`Skips this step: ${flow} can’t be used.`];
      }
    }
    case 'webhook':
      return ['Would call the webhook. The rehearsal doesn’t call it, and assumes it answers.'];
    case 'notify':
      return ['Would notify your team. The rehearsal doesn’t send the notice.'];
    case 'exit':
      return ['The run ends at this exit step.'];
  }
  return [];
}

/** How the run would end. */
export function endSentence(end: FlowRehearsal['end']): string {
  if (end.status === 'completed') return 'They finish the automation.';
  if (end.status === 'paused') {
    return end.problem
      ? `The run would pause here, because a step can’t go on. ${end.problem}`
      : 'The run would pause here, because a step can’t go on.';
  }
  return end.reason ? `The run ends: ${EXIT_REASON_LABEL[end.reason]}.` : 'The run ends.';
}

const REFUSED: Record<FlowEnrolDecision, string> = {
  not_in_segment: 'They wouldn’t enter now: they aren’t in the segment.',
  filter_miss: 'They wouldn’t enter now: they don’t match the rule.',
  already_in: 'They wouldn’t enter now: they are already in this automation.',
  already_ran_version: 'They wouldn’t enter now: they already went through this version.',
  already_ran_earlier: 'They wouldn’t enter now: they already went through an earlier version.',
  rate_limited: 'They wouldn’t enter now: they started it too many times in the last hour.',
};

/** Whether they would enter, and that the steps show what follows anyway. */
export function entrySentences(rehearsal: FlowRehearsal, flowStatus: string): string[] {
  const sentences: string[] = [];
  const { entry } = rehearsal;
  if (flowStatus !== 'live') {
    sentences.push('This automation isn’t live, so nobody enters it yet.');
  } else if (entry.allowed) {
    sentences.push('They would enter now.');
  } else if (entry.reason) {
    sentences.push(REFUSED[entry.reason]);
  } else {
    sentences.push('They wouldn’t enter now: they started it a moment ago.');
  }
  if (flowStatus === 'live' && !entry.allowed) {
    sentences.push('Here is what would happen if they did.');
  }
  return sentences;
}

const WHOLE = new Intl.NumberFormat('en-GB');

/** How many of a selection would be left out, and why. */
export function skippedSentence(reason: Exclude<FlowEnrolVerdict, 'enter'>, count: number): string {
  const n = WHOLE.format(count);
  const one = count === 1;
  switch (reason) {
    case 'unsubscribed':
      return one ? '1 has unsubscribed.' : `${n} have unsubscribed.`;
    case 'suppressed':
      return one ? '1 is on the do-not-send list.' : `${n} are on the do-not-send list.`;
    case 'not_active':
      return one ? '1 isn’t active.' : `${n} aren’t active.`;
    case 'already_in':
      return one ? '1 is already in this automation.' : `${n} are already in this automation.`;
    case 'already_ran_version':
      return one
        ? '1 already went through this version.'
        : `${n} already went through this version.`;
    case 'already_ran_earlier':
      return one
        ? '1 already went through an earlier version.'
        : `${n} already went through an earlier version.`;
    case 'rate_limited':
      return one
        ? '1 started it too many times in the last hour.'
        : `${n} started it too many times in the last hour.`;
    case 'not_in_segment':
      return one
        ? '1 isn’t in the segment it starts from.'
        : `${n} aren’t in the segment it starts from.`;
    case 'filter_miss':
      return one ? '1 doesn’t match its start rule.' : `${n} don’t match its start rule.`;
  }
}

/** The confirmation: the number, in a whole sentence. */
export const addButtonText = (count: number): string =>
  count === 1 ? 'Add 1 subscriber' : `Add ${WHOLE.format(count)} subscribers`;

export const enteringSentence = (count: number): string =>
  count === 0
    ? 'Nobody in this selection can enter.'
    : count === 1
      ? '1 subscriber would enter now.'
      : `${WHOLE.format(count)} subscribers would enter now.`;

export const addedSentence = (entered: number): string =>
  entered === 1 ? 'Added 1 subscriber.' : `Added ${WHOLE.format(entered)} subscribers.`;
