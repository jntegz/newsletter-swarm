// Words for sending limits: a send waiting for one (the send report, the live monitor, Home) and
// the form under Settings → Instance. docs/self-hosting.md "Sending limits" says the same things.
import {
  SENDING_LIMIT_BOUNDS,
  SENDING_LIMIT_PRESETS,
  SERVICE_STOPPED_RETRY,
  type InstanceMail,
  type SendWait,
  type SendingLimits,
  type SendingWindowUsage,
} from '@swarm/domain';

const number = new Intl.NumberFormat('en-US');
const time = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});
const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });

/** "00:00 UTC" within a day; "on 1 December at 00:00 UTC" further off. */
export function continuesAt(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  const clock = `${time.format(at)} UTC`;
  return at - now < 86_400_000 ? `at ${clock}` : `on ${day.format(at)} at ${clock}`;
}

const LIMIT: Record<SendWait['reason'], string> = {
  hour: 'hourly limit',
  day: 'daily limit',
  month: 'monthly limit',
  service_day: 'daily limit',
  service_month: 'monthly limit',
  service_stopped: '',
  share: '',
};

interface WaitCopy {
  /** The headline: what the send waits for, how many are left, when it goes on. */
  line: string;
  /** Where the limit comes from, and what a person can do. */
  detail: string;
  /** A pause holds until it's resumed; the other waits end by themselves soon. */
  paused: boolean;
}

/** What a waiting send says, on its report and on the live monitor. */
export function waitCopy(wait: SendWait, now = Date.now()): WaitCopy {
  const left = `${number.format(wait.left)} left`;
  const until = wait.until ? `, continues ${continuesAt(wait.until, now)}` : '';
  const said = wait.detail ? ` It said: ${wait.detail}` : '';
  switch (wait.reason) {
    case 'hour':
    case 'day':
      return {
        line: `Waiting for your email service’s ${LIMIT[wait.reason]}: ${left}${until}.`,
        detail:
          'This is the limit set for this Swarm under Settings → Instance. Everyone still to get this post gets it once the limit allows. Nobody is dropped.',
        paused: false,
      };
    case 'month':
      return {
        line: `Paused for your email service’s monthly limit: ${left}${until}.`,
        detail:
          'This is the limit set for this Swarm under Settings → Instance. Sending goes on by itself when the month turns. If the limit is raised sooner, resume sending.',
        paused: true,
      };
    case 'service_day':
      return {
        line: `Waiting for your email service’s daily limit: ${left}${until}.`,
        detail: `Your email service said its daily quota is used up, so the rest waits for the next day.${said}`,
        paused: false,
      };
    case 'service_month':
      return {
        line: `Paused for your email service’s monthly limit: ${left}${until}.`,
        detail: `Your email service said its monthly quota is used up. Sending goes on by itself when the month turns, or resume it once your plan allows more.${said}`,
        paused: true,
      };
    case 'share':
      return {
        line: `Waiting for capacity: ${left}${until ? until.replace(', continues', ', asks again') : ''}.`,
        detail:
          'Other publications on this Swarm are sending too, or this send is large, so it goes out in parts and shares the sending capacity fairly. It continues by itself; nothing needs fixing. Nobody is dropped.',
        paused: false,
      };
    case 'service_stopped':
      return {
        line: `Paused: your email service stopped accepting mail. ${left}.`,
        detail: `Nobody was dropped. Swarm tries the email service again by itself, less often as time goes on, and sends the rest once it takes mail. If it still refuses mail ${stoppedSendEnds(wait, now)}, the send ends and the rest are not sent. To send sooner, fix the email service (its account, keys or domain), then resume sending.${said}`,
        paused: true,
      };
  }
}

/** When a send the email service stopped ends by itself: "on 24 November at 10:00 UTC". */
const stoppedSendEnds = (wait: SendWait, now: number) =>
  continuesAt(new Date(Date.parse(wait.since) + SERVICE_STOPPED_RETRY.giveUpMs).toISOString(), now);

/** Home's "Needs you" line for a waiting send. */
export function waitNeed(subject: string, wait: SendWait, now = Date.now()) {
  const name = subject ? `“${subject}”` : 'An untitled post';
  const left = `${number.format(wait.left)} still to send.`;
  if (wait.reason === 'service_stopped') {
    return {
      title: `${name} is paused: your email service stopped accepting mail.`,
      detail: `${left} Swarm tries again by itself until ${stoppedSendEnds(wait, now).replace(/^(on|at) /, '')}. Fix the email service, then resume sending from the send report.`,
    };
  }
  const paused = wait.reason === 'month' || wait.reason === 'service_month';
  return {
    title: `${name} is ${paused ? 'paused' : 'waiting'} for your email service’s ${LIMIT[wait.reason]}.`,
    detail: `${left}${wait.until ? ` It continues ${continuesAt(wait.until, now)} by itself.` : ''}`,
  };
}

// ---- The form -------------------------------------------------------------------------------

export type LimitField = keyof SendingLimits;

export const LIMIT_FIELDS: { key: LimitField; label: string; hint: string }[] = [
  {
    key: 'perSecond',
    label: 'Emails a second',
    hint: 'From 0.1 to 1,000. 0.5 is one every two seconds.',
  },
  { key: 'perHour', label: 'Emails an hour', hint: 'Each UTC clock hour, from :00.' },
  { key: 'perDay', label: 'Emails a day', hint: 'Each UTC day, from 00:00.' },
  { key: 'perMonth', label: 'Emails a month', hint: 'Each UTC calendar month, from the 1st.' },
];

export type LimitDraft = Record<LimitField, string>;

export const toDraft = (limits: SendingLimits): LimitDraft => ({
  perSecond: limits.perSecond === null ? '' : String(limits.perSecond),
  perHour: limits.perHour === null ? '' : String(limits.perHour),
  perDay: limits.perDay === null ? '' : String(limits.perDay),
  perMonth: limits.perMonth === null ? '' : String(limits.perMonth),
});

/** The draft as limits, or the first problem with each field (the server checks the same). */
export function readDraft(
  draft: LimitDraft,
):
  | { limits: SendingLimits; errors: null }
  | { limits: null; errors: Partial<Record<LimitField, string>> } {
  const errors: Partial<Record<LimitField, string>> = {};
  const value = (key: LimitField): number | null => {
    const text = draft[key].replace(/[,\s]/g, '');
    if (text === '') return null;
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      errors[key] = 'Enter a number, or leave it empty for no limit.';
      return null;
    }
    if (key === 'perSecond') {
      const { min, max } = SENDING_LIMIT_BOUNDS.perSecond;
      if (parsed < min || parsed > max) errors[key] = 'Between 0.1 and 1,000 a second.';
      else if (Math.abs(parsed * 10 - Math.round(parsed * 10)) > 1e-9) {
        errors[key] = 'Use at most one decimal, such as 0.5 or 2.';
      }
    } else {
      const { min, max } = SENDING_LIMIT_BOUNDS.window;
      if (!Number.isInteger(parsed)) errors[key] = 'Use a whole number.';
      else if (parsed < min || parsed > max) {
        errors[key] = `Between ${number.format(min)} and ${number.format(max)}.`;
      }
    }
    return parsed;
  };
  const limits: SendingLimits = {
    perSecond: value('perSecond'),
    perHour: value('perHour'),
    perDay: value('perDay'),
    perMonth: value('perMonth'),
  };
  const over = (a: LimitField, b: LimitField, message: string) => {
    const small = limits[a];
    const large = limits[b];
    if (!errors[a] && !errors[b] && small !== null && large !== null && small > large) {
      errors[a] = message;
    }
  };
  over('perHour', 'perDay', 'An hour can’t allow more than the whole day.');
  over('perDay', 'perMonth', 'A day can’t allow more than the whole month.');
  over('perHour', 'perMonth', 'An hour can’t allow more than the whole month.');
  return Object.keys(errors).length ? { limits: null, errors } : { limits, errors: null };
}

interface PresetChoice {
  key: string;
  label: string;
  limits: SendingLimits;
}

/**
 * Starting points for this Swarm's email service, with "Your AWS account's limits" first when
 * SES could be read. Every one is labelled "check your plan" where it is shown.
 */
export function presetsFor(
  mail: Pick<InstanceMail, 'service' | 'ses'> | undefined,
): PresetChoice[] {
  const service = mail?.service;
  const own: PresetChoice[] = [];
  const ses = mail?.ses;
  if (service === 'ses' && ses && ses.maxSendRate !== null && ses.max24HourSend !== null) {
    const perSecond = Math.max(0.1, Math.min(1000, Math.round(ses.maxSendRate * 10) / 10));
    const perDay = Math.max(
      10,
      Math.min(SENDING_LIMIT_BOUNDS.window.max, Math.floor(ses.max24HourSend)),
    );
    own.push({
      key: 'ses_account',
      label: `Your AWS account’s limits: ${number.format(perSecond)} a second, ${number.format(perDay)} a day`,
      limits: { perSecond, perHour: null, perDay, perMonth: null },
    });
  }
  const listed = SENDING_LIMIT_PRESETS.filter((preset) => preset.service === service);
  return [...own, ...listed.map(({ key, label, limits }) => ({ key, label, limits }))];
}

/** "412 of 90 for sends (100 in all) · resets at 00:00 UTC", or a count with no limit. */
export function usageLine(window: SendingWindowUsage, now = Date.now()): string {
  const resets = `resets ${continuesAt(window.resetsAt, now)}`;
  if (window.limit === null) return `${number.format(window.used)} sent · no limit · ${resets}`;
  return `${number.format(window.used)} of ${number.format(window.limit)} · ${number.format(window.forSends ?? window.limit)} for posts and automations · ${resets}`;
}
