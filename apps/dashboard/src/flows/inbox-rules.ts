// Inbox rules in the dashboard: the plain sentences a held run shows, and the settings form's
// draft. Every sentence here is whole, with only a time filled in, so each can be translated.
import {
  INBOX_RULES_DEFAULT_MAX_HOLD_DAYS,
  INBOX_RULES_MAX_HOLD_DAYS,
  INBOX_RULES_MAX_HOURS_AROUND,
  INBOX_RULES_MAX_PER_DAY,
  INBOX_RULES_MAX_PER_WEEK,
  type FlowRunHold,
  type InboxHoldReason,
  type InboxRules,
} from '@swarm/domain';

function parts(iso: string, zone: string) {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hourCycle: 'h23',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const map = Object.fromEntries(
    format.formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    day: `${map.weekday} ${map.day} ${map.month}`,
    time: `${map.hour}:${map.minute}`,
  };
}

const safeZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
};

/** A time in the zone the rule was read in: "08:00" today, otherwise "Tue 3 Nov, 08:00". */
export function holdTime(iso: string, zone: string, now: number): string {
  const safe = safeZone(zone);
  const at = parts(iso, safe);
  return parts(new Date(now).toISOString(), safe).day === at.day
    ? at.time
    : `${at.day}, ${at.time}`;
}

const dated = (iso: string, zone: string) => {
  const at = parts(iso, safeZone(zone));
  return `${at.day}, ${at.time}`;
};

const WAITING: Record<InboxHoldReason, (until: string) => string> = {
  quiet_hours: (until) => `Held: quiet hours until ${until}.`,
  daily_limit: (until) => `Held: the daily email limit is reached until ${until}.`,
  weekly_limit: (until) => `Held: the weekly email limit is reached until ${until}.`,
  newsletter_day: (until) => `Held: newsletter day until ${until}.`,
  near_post: (until) => `Held: a post is close, so this email waits until ${until}.`,
  in_line: (until) => `Held: an earlier email goes first, so this one waits until ${until}.`,
};

/** Why an email waits until a time, whole, with the time filled in. */
export const waitingSentence = (reason: InboxHoldReason, until: string): string =>
  WAITING[reason](until);

/** Why an email is waiting right now. */
export const heldSentence = (hold: FlowRunHold, now: number = Date.now()): string =>
  new Date(hold.until).getTime() <= now
    ? 'The inbox rule has lifted, so this email goes out as soon as it can.'
    : WAITING[hold.reason](holdTime(hold.until, hold.zone, now));

/** What became of a hold that is over. No release time means the run ended some other way. */
export function heldEndedSentence(hold: FlowRunHold): string {
  const from = dated(hold.heldAt, hold.zone);
  if (!hold.releasedAt) return `Held from ${from}. The run ended before this email was sent.`;
  const to = dated(hold.releasedAt, hold.zone);
  switch (hold.outcome) {
    case 'sent':
      return `Held from ${from} until ${to}, then sent.`;
    case 'skipped':
      return `Held from ${from} until ${to}, then skipped because the subscriber already had this email.`;
    case 'expired':
      return `Held from ${from} until ${to}. The wait passed the publication’s limit, so this email was not sent.`;
    default:
      return `Held from ${from} until ${to}. The run ended before this email was sent.`;
  }
}

export interface RulesDraft {
  limitOn: boolean;
  perDay: string;
  perWeek: string;
  quietOn: boolean;
  quietStart: string;
  quietEnd: string;
  postDayOn: boolean;
  hoursAround: string;
  maxHoldDays: string;
  timezone: string;
}

/** The form for saved rules. Fields of a rule that is off start on sensible values. */
export const toDraft = (rules: InboxRules, timezone: string | null): RulesDraft => ({
  limitOn: rules.perDay !== null || rules.perWeek !== null,
  perDay: rules.perDay === null ? '' : String(rules.perDay),
  perWeek: rules.perWeek === null ? '' : String(rules.perWeek),
  quietOn: rules.quietHours !== null,
  quietStart: rules.quietHours?.start ?? '22:00',
  quietEnd: rules.quietHours?.end ?? '08:00',
  postDayOn: rules.newsletterDay !== null,
  hoursAround: String(rules.newsletterDay?.hoursAround ?? 0),
  maxHoldDays: String(rules.maxHoldDays ?? INBOX_RULES_DEFAULT_MAX_HOLD_DAYS),
  timezone: timezone ?? '',
});

type RulesProblems = Partial<Record<keyof RulesDraft, string>>;

const whole = (text: string) => (/^\d{1,4}$/.test(text.trim()) ? Number(text.trim()) : null);

/** What's wrong with the form, by field. Empty when it can be saved. */
export function rulesProblems(draft: RulesDraft): RulesProblems {
  const problems: RulesProblems = {};
  if (draft.limitOn) {
    const day = whole(draft.perDay);
    const week = whole(draft.perWeek);
    if (draft.perDay.trim() && (day === null || day < 1 || day > INBOX_RULES_MAX_PER_DAY)) {
      problems.perDay = `Use a number from 1 to ${INBOX_RULES_MAX_PER_DAY}.`;
    }
    if (draft.perWeek.trim() && (week === null || week < 1 || week > INBOX_RULES_MAX_PER_WEEK)) {
      problems.perWeek = `Use a number from 1 to ${INBOX_RULES_MAX_PER_WEEK}.`;
    }
    if (!draft.perDay.trim() && !draft.perWeek.trim()) {
      problems.perDay = 'Set a limit per day, per week or both.';
    }
  }
  if (draft.quietOn) {
    if (!draft.quietStart) problems.quietStart = 'Choose when quiet hours start.';
    if (!draft.quietEnd) problems.quietEnd = 'Choose when quiet hours end.';
    if (draft.quietStart && draft.quietStart === draft.quietEnd) {
      problems.quietEnd = 'Quiet hours need a start and an end that differ.';
    }
  }
  if (draft.postDayOn) {
    const hours = whole(draft.hoursAround);
    if (hours === null || hours > INBOX_RULES_MAX_HOURS_AROUND) {
      problems.hoursAround = `Use a number from 0 to ${INBOX_RULES_MAX_HOURS_AROUND}.`;
    }
  }
  const days = whole(draft.maxHoldDays);
  if (days === null || days < 1 || days > INBOX_RULES_MAX_HOLD_DAYS) {
    problems.maxHoldDays = `Use a number from 1 to ${INBOX_RULES_MAX_HOLD_DAYS}.`;
  }
  return problems;
}

/** The rules a valid form stands for. A rule that is off is saved as off. */
export const fromDraft = (draft: RulesDraft): InboxRules => ({
  perDay: draft.limitOn ? whole(draft.perDay) : null,
  perWeek: draft.limitOn ? whole(draft.perWeek) : null,
  quietHours: draft.quietOn ? { start: draft.quietStart, end: draft.quietEnd } : null,
  newsletterDay: draft.postDayOn ? { hoursAround: whole(draft.hoursAround) ?? 0 } : null,
  maxHoldDays: whole(draft.maxHoldDays) ?? INBOX_RULES_DEFAULT_MAX_HOLD_DAYS,
});

/** How many emails are held, as a whole sentence. */
export const heldNowSentence = (count: number): string =>
  count === 0
    ? 'No emails are held right now.'
    : count === 1
      ? 'One email is held right now.'
      : `${count.toLocaleString('en-GB')} emails are held right now.`;
