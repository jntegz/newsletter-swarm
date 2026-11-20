// Warm-up outside its own section: what Home, the import review, the send panel and the send
// report say about it, worked out from a ramp. Nothing here renders or fetches. Every number comes
// from the same projection the Warm-up plan uses (projectWarmup in @swarm/domain).
import {
  WARMUP_CADENCES,
  WARM_IMPORT_THRESHOLD,
  projectWarmup,
  type Ramp,
  type WarmupCadence,
  type WarmupPlan,
} from '@swarm/domain';
import {
  cadencePhrase,
  daysBetween,
  formatDay,
  pauseReason,
  planFor,
  ratePercent,
  relativeDay,
  subscribers,
  todaysLimit,
} from './warmup-helpers';

const number = new Intl.NumberFormat('en-US');

/** The id of the Warm-up section on the Sending page, for links from other pages. */
export const WARMUP_ANCHOR = 'warm-up';
export const warmupHref = (channelId: string) => `/channels/${channelId}/sending#${WARMUP_ANCHOR}`;

export interface WarmupNote {
  tone: 'info' | 'paused';
  title: string;
  body: string;
  /** Short, concrete things to do; a numbered list when paused. */
  tips: string[];
  /** The words of the link to the Warm-up section. */
  link: string;
}

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
/** "on Thu 19 Nov", or "today" and "tomorrow" without the "on". */
const onDay = (day: string, today: string) => {
  const when = relativeDay(day, today);
  return when === 'today' || when === 'tomorrow' ? when : `on ${when}`;
};

/** What a paused warm-up means and what to do, the same wherever it is said. */
function pausedNote(ramp: Ramp, waiting: string): WarmupNote {
  const reason = pauseReason(ramp);
  return {
    tone: 'paused',
    title: `Sending from ${ramp.domain} is paused`,
    body: `${reason.text} ${waiting}`,
    tips: reason.byHand
      ? ['An owner or admin can resume sending in Warm-up. Posts carry on from where they stopped.']
      : [
          'Open Deliverability and find the send the bounces or complaints came from.',
          'If they came from an import or an old list, remove those subscribers.',
          'Resume sending in Warm-up. Posts carry on from where they stopped, and nobody gets an email twice.',
        ],
    link: 'Open warm-up',
  };
}

/** How a post to `plan.audience` people goes out: over how many days, and when it is done. */
function spread(plan: WarmupPlan): string | null {
  if (!plan.sendDoneDay) return null;
  const span = daysBetween(plan.today, plan.sendDoneDay) + 1;
  return `goes out over ${days(span)}, most engaged readers first, and finishes ${onDay(plan.sendDoneDay, plan.today)}`;
}

/**
 * Home: says a domain is warming up, what that means for the next post and what helps. Null when
 * warm-up is complete or was skipped, because then there is nothing to know.
 */
export function homeWarmupNote(ramp: Ramp | null, cadence: WarmupCadence): WarmupNote | null {
  if (!ramp || ramp.status === 'complete') return null;
  if (ramp.status === 'paused') {
    return pausedNote(
      ramp,
      'Posts that were going out are waiting, and nothing new is sent from this domain until someone resumes it.',
    );
  }
  const plan = planFor(ramp, cadence);
  const { cap } = todaysLimit(ramp);
  const fits = plan.fullListDay !== null && plan.fullListDay <= plan.today;
  let body: string;
  if (plan.audience === 0) {
    body = `A new sending domain starts with a small daily limit, so mailbox providers learn to trust it. A post to more than ${number.format(cap)} people goes out over several days, most engaged readers first.`;
  } else if (fits) {
    body = `Your ${subscribers(plan.audience)} fit in today’s limit, so a post reaches everyone the day you send it. If your list grows past ${number.format(cap)}, a post goes out over several days.`;
  } else {
    const how = spread(plan);
    const full = plan.fullListDay
      ? `If you send to everyone ${cadencePhrase(cadence)}, the whole list fits in one day from ${formatDay(plan.fullListDay, plan.today)}.`
      : 'At this pace the whole list will not fit in one day within two years. Choose a faster pace.';
    body = `${how ? `A post to all ${subscribers(plan.audience)} ${how}. ` : ''}${full}`;
  }
  return {
    tone: 'info',
    title: `${ramp.domain} is warming up: up to ${number.format(cap)} emails today`,
    body,
    tips: [
      'Send on a regular schedule. The limit only grows after a day that used at least half of it.',
      `Clean your list before a big send. If more than ${ratePercent(ramp.bounceThreshold)} of a day’s emails bounce, sending pauses.`,
    ],
    link: 'See the warm-up plan',
  };
}

/** The first-post step on Home, when the first post will not reach everyone on its first day. */
export function firstPostWarmupLine(ramp: Ramp | null): string | null {
  if (!ramp || ramp.status !== 'warming') return null;
  const { plan } = ramp;
  const { cap, left } = todaysLimit(ramp);
  if (plan.audience <= left || !plan.sendDoneDay) return null;
  const more = daysBetween(plan.today, plan.sendDoneDay);
  return `Your sending domain is warming up: sent today, it reaches ${number.format(Math.min(left, plan.audience))} of your ${subscribers(plan.audience)} on the first day (the limit is ${number.format(cap)}) and the rest over the following ${days(more)}.`;
}

// ---- The send panel ------------------------------------------------------------------------

interface SendWarmupNote extends WarmupNote {
  /** One line for the confirm box. */
  confirm: string;
}

/**
 * The send panel: who gets this post on the first day and when the rest arrive. Null when the
 * whole audience fits in what is left of the day's limit, or warm-up no longer limits anything.
 *
 * `sendDay` is the UTC day of a scheduled send. The limit of that day is today's limit, unless
 * another post uses it first and it grows before then, so the numbers are "about".
 */
export function sendWarmupNote(
  ramp: Ramp | null,
  recipients: number,
  sendDay?: string,
): SendWarmupNote | null {
  if (!ramp || ramp.status === 'complete' || recipients <= 0) return null;
  if (ramp.status === 'paused') {
    const note = pausedNote(
      ramp,
      'This post cannot go out until someone resumes sending from this domain.',
    );
    return { ...note, confirm: note.title };
  }
  const today = ramp.plan.today;
  const later = !!sendDay && sendDay > today;
  const { cap, left } = todaysLimit(ramp);
  const first = Math.min(recipients, later ? cap : left);
  if (first >= recipients) return null;
  const plan = projectWarmup(
    {
      status: 'warming',
      day: later ? sendDay : ramp.day,
      capToday: later ? cap : ramp.capToday,
      sentToday: later ? 0 : ramp.sentToday,
      growth: ramp.growth,
      maxCap: ramp.maxCap,
    },
    recipients,
    later ? sendDay : today,
  );
  const everyone = subscribers(recipients);
  const done = plan.sendDoneDay;
  const span = done ? daysBetween(plan.today, done) : null;
  const rest =
    done && span !== null
      ? `the rest go out over the next ${days(span)} and finish ${onDay(done, today)}`
      : 'the rest go out over the following days';
  const about = later ? 'about ' : '';
  const when = later ? `on ${formatDay(sendDay, today)}` : 'today';
  const title =
    first === 0
      ? `Warm-up: today’s limit of ${number.format(cap)} is used up, so this starts going out tomorrow`
      : `Warm-up: ${about}${number.format(first)} of your ${everyone} get this ${when}`;
  const body =
    first === 0
      ? `All ${everyone} get it over the next ${days(span ?? 1)}${done ? `, finishing ${onDay(done, today)}` : ''}. Most engaged readers go first. Nobody is skipped, and you do not need to send again.`
      : `${rest.charAt(0).toUpperCase()}${rest.slice(1)}. Most engaged readers go first. Nobody is skipped, and you do not need to send again.`;
  return {
    tone: 'info',
    title,
    body: later
      ? `${body} These numbers are for today’s limit of ${number.format(cap)}. It can be higher by then if you send in between.`
      : body,
    tips: [],
    link: 'See the warm-up plan',
    confirm:
      first === 0
        ? `Warm-up: nobody gets it today. It goes out from tomorrow${done ? ` and finishes ${onDay(done, today)}` : ''}.`
        : `Warm-up: ${about}${number.format(first)} get it ${when}, ${rest}.`,
  };
}

/** The server's own one-line warm-up warning, which the note above replaces. */
export const isServerWarmupWarning = (warning: string) =>
  warning.startsWith('Today’s warm-up allows') || warning.startsWith("Today's warm-up allows");

// ---- The send report -----------------------------------------------------------------------

/**
 * The send report of a post that is still going out: why it stopped for today and when the rest
 * arrive. Null while today's limit still has room, and once the send is done.
 */
export function reportWarmupNote(
  ramp: Ramp | null,
  total: number,
  handled: number,
): WarmupNote | null {
  const remaining = total - handled;
  if (!ramp || ramp.status === 'complete' || remaining <= 0) return null;
  if (ramp.status === 'paused') {
    return pausedNote(
      ramp,
      `${number.format(handled)} of ${number.format(total)} have gone out. The other ${number.format(remaining)} are waiting.`,
    );
  }
  const { cap, left } = todaysLimit(ramp);
  if (left > 0) return null;
  const today = ramp.plan.today;
  const plan = projectWarmup(
    {
      status: 'warming',
      day: ramp.day,
      capToday: ramp.capToday,
      sentToday: ramp.sentToday,
      growth: ramp.growth,
      maxCap: ramp.maxCap,
    },
    remaining,
    today,
  );
  const done = plan.sendDoneDay;
  const span = done ? daysBetween(today, done) : null;
  return {
    tone: 'info',
    title: `Warm-up: ${number.format(handled)} of ${number.format(total)} sent so far, the rest follow`,
    body: `Today’s limit of ${number.format(cap)} emails for ${ramp.domain} is used up. The other ${number.format(remaining)} go out ${
      done && span !== null
        ? `over the next ${days(span)} and finish ${onDay(done, today)}`
        : 'over the following days'
    }, most engaged readers first. Nobody is skipped, and you do not need to send again. Another post sent in the meantime shares the same daily limit.`,
    tips: [],
    link: 'See the warm-up plan',
  };
}

// ---- Importing subscribers -----------------------------------------------------------------

/**
 * The import review: what the import does to the next posts. Null when it changes nothing (the
 * larger list still fits in a day, or nobody new is added).
 *
 * - A finished warm-up starts again when the import adds WARM_IMPORT_THRESHOLD or more people:
 *   today's limit becomes the number of active subscribers before the import (startWarmImport).
 * - A warm-up still going is left as it is, so a larger list simply takes longer to reach.
 */
export function importWarmupNote(
  ramp: Ramp | null,
  input: { active: number; added: number; becomeActive: boolean },
  cadence: WarmupCadence,
): WarmupNote | null {
  const { active, added, becomeActive } = input;
  if (!ramp || added <= 0) return null;
  const restarts = added >= WARM_IMPORT_THRESHOLD;
  const after = active + added;
  const pendingNote = becomeActive
    ? ''
    : ' New subscribers stay pending until they confirm, so this applies as they do.';

  if (ramp.status === 'complete') {
    if (!restarts) return null;
    const cap = Math.max(ramp.startCap, active);
    const plan = projectWarmup(
      {
        status: 'warming',
        day: ramp.plan.today,
        capToday: cap,
        sentToday: ramp.day === ramp.plan.today ? ramp.sentToday : 0,
        growth: ramp.growth,
        maxCap: Math.max(ramp.startCap + 1, after),
      },
      after,
      ramp.plan.today,
      undefined,
      WARMUP_CADENCES[cadence],
    );
    const how = spread(plan);
    return {
      tone: 'info',
      title: 'This import starts warm-up again',
      body: `It adds ${number.format(added)} new addresses, and ${number.format(WARM_IMPORT_THRESHOLD)} or more put a finished warm-up back to warming. The daily limit for ${ramp.domain} becomes ${number.format(cap)} emails, ${active >= ramp.startCap ? 'the size of your list today, so the readers you already have keep getting every post' : 'the first day of your pace'}. ${
        how ? `Your next post to all ${subscribers(after)} ${how}.` : ''
      }${
        plan.fullListDay && plan.fullListDay > plan.today
          ? ` If you send to everyone ${cadencePhrase(cadence)}, the whole list fits in one day from ${formatDay(plan.fullListDay, plan.today)}.`
          : ''
      }${pendingNote}`,
      tips: [
        `Leave out addresses you have not emailed in a long time. If more than ${ratePercent(ramp.bounceThreshold)} of a day’s emails bounce, sending pauses.`,
      ],
      link: 'See the warm-up plan',
    };
  }

  // Warming or paused: the import does not change the limit. It changes how long a post takes.
  const plan = planFor(ramp, cadence, after);
  const { cap } = todaysLimit(ramp);
  if (after <= cap) return null;
  const how = spread(plan);
  const before =
    ramp.status === 'paused'
      ? `Sending from ${ramp.domain} is paused, and its daily limit is ${number.format(cap)} emails.`
      : `${ramp.domain} is still warming up: today’s limit is ${number.format(cap)} emails.`;
  return {
    tone: 'info',
    title: `After this import, a post takes ${plan.sendDoneDay ? days(daysBetween(plan.today, plan.sendDoneDay) + 1) : 'several days'} to reach everyone`,
    body: `${before} With ${subscribers(after)} on the list, ${
      how
        ? `your next post to everyone ${how}${ramp.status === 'paused' ? ' once sending is resumed' : ''}.`
        : 'your next post to everyone goes out over many days.'
    }${
      plan.fullListDay && plan.fullListDay > plan.today
        ? ` If you send to everyone ${cadencePhrase(cadence)}, the whole list fits in one day from ${formatDay(plan.fullListDay, plan.today)}.`
        : ''
    }${pendingNote}`,
    tips: [
      `Leave out addresses you have not emailed in a long time. Old addresses bounce, and if more than ${ratePercent(ramp.bounceThreshold)} of a day’s emails bounce, sending pauses.`,
      'Readers who opened recently get each post first. New addresses come after them.',
    ],
    link: 'See the warm-up plan',
  };
}
