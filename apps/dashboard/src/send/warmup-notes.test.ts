// Warm-up outside its own section: what Home, the import review, the send panel and the send
// report say, for each state of a ramp.
import { projectWarmup, rampPaceOf, type Ramp } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { WARM_UP_WELL } from './Warmup';
import { fullListSentence, planFor, todaysLimit, warmupSteps } from './warmup-helpers';
import {
  firstPostWarmupLine,
  homeWarmupNote,
  importWarmupNote,
  isServerWarmupWarning,
  reportWarmupNote,
  sendWarmupNote,
  warmupHref,
} from './warmup-notes';

const TODAY = '2026-11-12';
const AUDIENCE = 12_731;

function ramp(
  over: Partial<Omit<Ramp, 'plan' | 'pace' | 'skipped'>> = {},
  audience = AUDIENCE,
): Ramp {
  const base = {
    id: 'rr_1',
    sendingDomainId: 'sd_1' as string | null,
    domain: 'mail.fieldnotes.example',
    kind: 'custom' as const,
    status: 'warming' as const,
    skippedAt: null as string | null,
    startedDay: '2026-11-07',
    day: TODAY,
    capToday: 1520,
    sentToday: 412,
    startCap: 200,
    growth: 1.5,
    maxCap: 1_000_000,
    bounceThreshold: 0.02,
    complaintThreshold: 0.0008,
    pausedReason: null as string | null,
    pausedBy: null as 'system' | 'person' | null,
    days: [],
    ...over,
  };
  return {
    ...base,
    sharedOverride: false,
    skipped: base.status === 'complete' && base.skippedAt !== null,
    pace: rampPaceOf(base.kind, base.startCap, base.growth),
    plan: projectWarmup(base, audience, TODAY),
  };
}
const paused = () =>
  ramp({
    status: 'paused',
    pausedReason: 'Bounce rate 3.4% is over the 2.0% limit.',
    pausedBy: 'system',
  });
const complete = () => ramp({ status: 'complete', capToday: 1_000_000 });
const BANNED = /Reputation Ramp|Members?\b|Channel|Dispatch|Broadcast|\u2014/;

describe('the plan for how often you send', () => {
  it('names a later day for a weekly newsletter than for a daily one', () => {
    const r = ramp();
    expect(fullListSentence(planFor(r, 'daily'), 'daily')).toBe(
      'Your whole list of 12,731 subscribers fits in one day from Wed 18 Nov, if you send to everyone every day.',
    );
    expect(fullListSentence(planFor(r, 'weekly'), 'weekly')).toBe(
      'Your whole list of 12,731 subscribers fits in one day from Fri 27 Nov, if you send to everyone once a week.',
    );
    // A post sent today finishes on the same day whatever the rhythm.
    expect(planFor(r, 'weekly').sendDoneDay).toBe(r.plan.sendDoneDay);
    expect(warmupSteps(r, planFor(r, 'weekly'))[3]?.detail).toBe('Fri 27 Nov');
  });

  it('does not promise a ceiling a list cannot reach', () => {
    const fits = ramp({}, 300);
    expect(warmupSteps(fits, planFor(fits, 'weekly'))[4]?.detail).toBe(
      'Nothing is held back. The limit only reaches 1,000,000 a day if you send that much',
    );
  });

  it('reads today’s limit from a ramp left on an earlier day', () => {
    // Yesterday used the whole 1,013, so today it is 1,520 and nothing of it is used.
    const r = ramp({ day: '2026-11-11', capToday: 1013, sentToday: 1013 });
    expect(todaysLimit(r)).toEqual({ cap: 1520, left: 1520 });
    expect(todaysLimit(ramp())).toEqual({ cap: 1520, left: 1108 });
  });
});

describe('Home', () => {
  it('says nothing once warm-up is complete or skipped, or before the ramps load', () => {
    expect(homeWarmupNote(complete(), 'weekly')).toBeNull();
    expect(
      homeWarmupNote(ramp({ status: 'complete', skippedAt: '2026-11-10T00:00:00.000Z' }), 'weekly'),
    ).toBeNull();
    expect(homeWarmupNote(null, 'weekly')).toBeNull();
  });

  it('says today’s limit, how a post goes out, when the list fits, and two tips', () => {
    const note = homeWarmupNote(ramp(), 'weekly')!;
    expect(note.tone).toBe('info');
    expect(note.title).toBe('mail.fieldnotes.example is warming up: up to 1,520 emails today');
    expect(note.body).toBe(
      'A post to all 12,731 subscribers goes out over 5 days, most engaged readers first, and finishes on Mon 16 Nov. If you send to everyone once a week, the whole list fits in one day from Fri 27 Nov.',
    );
    expect(note.tips).toHaveLength(2);
    expect(note.tips[1]).toContain('more than 2% of a day’s emails bounce');
    expect(homeWarmupNote(ramp(), 'daily')!.body).toContain('fits in one day from Wed 18 Nov');
  });

  it('is short when the list fits already or there is no list yet', () => {
    expect(homeWarmupNote(ramp({}, 300), 'weekly')!.body).toBe(
      'Your 300 subscribers fit in today’s limit, so a post reaches everyone the day you send it. If your list grows past 1,520, a post goes out over several days.',
    );
    expect(homeWarmupNote(ramp({}, 0), 'weekly')!.body).toContain(
      'A post to more than 1,520 people goes out over several days',
    );
  });

  it('says a pause first, with the reason and what to do', () => {
    const note = homeWarmupNote(paused(), 'weekly')!;
    expect(note.tone).toBe('paused');
    expect(note.title).toBe('Sending from mail.fieldnotes.example is paused');
    expect(note.body).toContain('Bounce rate 3.4% is over the 2.0% limit.');
    expect(note.tips).toHaveLength(3);
    expect(note.tips[2]).toContain('Resume sending in Warm-up');
    const byHand = homeWarmupNote(
      ramp({ status: 'paused', pausedReason: 'Paused by a teammate.', pausedBy: 'person' }),
      'weekly',
    )!;
    expect(byHand.tips).toEqual([
      'An owner or admin can resume sending in Warm-up. Posts carry on from where they stopped.',
    ]);
  });

  it('tells a first-time sender how far the first post gets', () => {
    expect(firstPostWarmupLine(ramp({ capToday: 200, sentToday: 0 }, 5_000))).toBe(
      'Your sending domain is warming up: sent today, it reaches 200 of your 5,000 subscribers on the first day (the limit is 200) and the rest over the following 6 days.',
    );
    expect(firstPostWarmupLine(ramp({ capToday: 200, sentToday: 0 }, 150))).toBeNull();
    expect(firstPostWarmupLine(complete())).toBeNull();
    expect(firstPostWarmupLine(paused())).toBeNull();
  });

  it('links to the Warm-up section', () => {
    expect(warmupHref('ch_1')).toBe('/channels/ch_1/sending#warm-up');
  });
});

describe('the send panel', () => {
  it('says who gets the post today and when the rest arrive', () => {
    const note = sendWarmupNote(ramp(), 12_731)!;
    expect(note.title).toBe('Warm-up: 1,108 of your 12,731 subscribers get this today');
    expect(note.body).toBe(
      'The rest go out over the next 4 days and finish on Mon 16 Nov. Most engaged readers go first. Nobody is skipped, and you do not need to send again.',
    );
    expect(note.confirm).toBe(
      'Warm-up: 1,108 get it today, the rest go out over the next 4 days and finish on Mon 16 Nov.',
    );
  });

  it('counts only this post’s audience, and says nothing when it fits', () => {
    expect(sendWarmupNote(ramp(), 1_108)).toBeNull();
    expect(sendWarmupNote(ramp(), 1_109)!.title).toBe(
      'Warm-up: 1,108 of your 1,109 subscribers get this today',
    );
    expect(sendWarmupNote(ramp(), 1_109)!.body).toContain('finish tomorrow');
    expect(sendWarmupNote(complete(), 50_000)).toBeNull();
    expect(sendWarmupNote(null, 50_000)).toBeNull();
    expect(sendWarmupNote(ramp(), 0)).toBeNull();
  });

  it('says so when today’s limit is used up', () => {
    const note = sendWarmupNote(ramp({ sentToday: 1520 }), 12_731)!;
    expect(note.title).toBe(
      'Warm-up: today’s limit of 1,520 is used up, so this starts going out tomorrow',
    );
    expect(note.body).toContain('All 12,731 subscribers get it over the next 4 days');
  });

  it('plans a scheduled post from its day, at today’s limit, and says "about"', () => {
    const note = sendWarmupNote(ramp(), 12_731, '2026-11-14')!;
    expect(note.title).toBe(
      'Warm-up: about 1,520 of your 12,731 subscribers get this on Sat 14 Nov',
    );
    expect(note.body).toContain('finish on Wed 18 Nov');
    expect(note.body).toContain('It can be higher by then if you send in between.');
    // A time later today is a send today.
    expect(sendWarmupNote(ramp(), 12_731, TODAY)!.title).toContain('1,108');
  });

  it('says a paused domain sends nothing', () => {
    const note = sendWarmupNote(paused(), 500)!;
    expect(note.tone).toBe('paused');
    expect(note.body).toContain('This post cannot go out until someone resumes sending');
  });

  it('knows the server’s own one-line warning, which it replaces', () => {
    expect(
      isServerWarmupWarning(
        "Today's warm-up allows 1,108 more messages; the rest will go out over the next days.",
      ),
    ).toBe(true);
    expect(isServerWarmupWarning('Preview text is empty.')).toBe(false);
  });
});

describe('the send report', () => {
  it('explains a send that stopped for today, with the day it finishes', () => {
    const note = reportWarmupNote(ramp({ sentToday: 1520 }), 12_731, 3_658)!;
    expect(note.title).toBe('Warm-up: 3,658 of 12,731 sent so far, the rest follow');
    expect(note.body).toContain(
      'The other 9,073 go out over the next 3 days and finish on Sun 15 Nov, most engaged readers first.',
    );
  });

  it('says nothing while today still has room, when the send is done, or without a limit', () => {
    expect(reportWarmupNote(ramp(), 12_731, 400)).toBeNull();
    expect(reportWarmupNote(ramp({ sentToday: 1520 }), 12_731, 12_731)).toBeNull();
    expect(reportWarmupNote(complete(), 12_731, 400)).toBeNull();
    expect(reportWarmupNote(null, 12_731, 400)).toBeNull();
  });

  it('says a paused send is waiting', () => {
    const note = reportWarmupNote(paused(), 12_731, 3_658)!;
    expect(note.tone).toBe('paused');
    expect(note.body).toContain('3,658 of 12,731 have gone out. The other 9,073 are waiting.');
  });
});

describe('the import review', () => {
  it('says how long a post takes once the list is bigger than today’s limit', () => {
    const note = importWarmupNote(
      ramp(),
      { active: 12_731, added: 4_200, becomeActive: true },
      'weekly',
    )!;
    expect(note.title).toBe('After this import, a post takes 5 days to reach everyone');
    expect(note.body).toContain('today’s limit is 1,520 emails. With 16,931 subscribers');
    expect(note.tips[0]).toContain('Old addresses bounce');
  });

  it('says a large import starts a finished warm-up again, at the size of the list today', () => {
    const note = importWarmupNote(
      complete(),
      { active: 12_731, added: 25_000, becomeActive: true },
      'weekly',
    )!;
    expect(note.title).toBe('This import starts warm-up again');
    expect(note.body).toContain('becomes 12,731 emails, the size of your list today');
    expect(note.body).toContain(
      'Your next post to all 37,731 subscribers goes out over 3 days, most engaged readers first, and finishes on Sat 14 Nov.',
    );
    // A list smaller than the pace's first day starts at that first day (max(start_cap, active)).
    expect(
      importWarmupNote(complete(), { active: 50, added: 10_000, becomeActive: true }, 'weekly')!
        .body,
    ).toContain('becomes 200 emails, the first day of your pace');
  });

  it('says nothing when the import changes nothing about sending', () => {
    const quiet = { active: 100, added: 9_999, becomeActive: true };
    expect(importWarmupNote(complete(), quiet, 'weekly')).toBeNull();
    expect(
      importWarmupNote(ramp(), { active: 100, added: 1_000, becomeActive: true }, 'weekly'),
    ).toBeNull();
    expect(
      importWarmupNote(ramp(), { active: 100, added: 0, becomeActive: true }, 'weekly'),
    ).toBeNull();
    expect(importWarmupNote(null, quiet, 'weekly')).toBeNull();
  });

  it('says pending subscribers count once they confirm', () => {
    expect(
      importWarmupNote(ramp(), { active: 12_731, added: 4_200, becomeActive: false }, 'weekly')!
        .body,
    ).toContain('New subscribers stay pending until they confirm');
  });
});

describe('the words', () => {
  it('are plain everywhere: no internal names, no em dash', () => {
    const notes = [
      homeWarmupNote(ramp(), 'weekly'),
      homeWarmupNote(paused(), 'weekly'),
      sendWarmupNote(ramp(), 12_731),
      sendWarmupNote(ramp(), 12_731, '2026-11-14'),
      reportWarmupNote(ramp({ sentToday: 1520 }), 12_731, 3_658),
      importWarmupNote(ramp(), { active: 12_731, added: 4_200, becomeActive: true }, 'weekly'),
      importWarmupNote(complete(), { active: 12_731, added: 25_000, becomeActive: true }, 'few'),
    ];
    for (const note of notes) {
      expect(note).not.toBeNull();
      expect(JSON.stringify(note)).not.toMatch(BANNED);
    }
    expect(JSON.stringify(WARM_UP_WELL)).not.toMatch(BANNED);
    expect(WARM_UP_WELL).toHaveLength(7);
  });
});
