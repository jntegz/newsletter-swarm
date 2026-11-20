// Settings → Sending → Warm-up: the words for each state, and the section in every state.
import { projectWarmup, rampPaceOf, type Ramp } from '@swarm/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WarmupView } from './Warmup';
import {
  customPaceProblem,
  dayNumber,
  formatDay,
  fullListSentence,
  paceOptions,
  pauseReason,
  planPreviewLength,
  previewPace,
  primaryRamp,
  ratePercent,
  relativeDay,
  resetTime,
  sendDoneSentence,
  warmupSteps,
} from './warmup-helpers';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/deliverability">{children}</a>,
}));

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
    days: [{ day: '2026-11-11', cap: 1013, sent: 1013, bounces: 2, complaints: 0 }],
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
const shared = (over: Parameters<typeof ramp>[0] = {}) =>
  ramp({
    id: 'rr_0',
    sendingDomainId: null,
    domain: 'mail.swarm.example',
    kind: 'shared',
    capToday: 100,
    sentToday: 0,
    startCap: 100,
    growth: 1.3,
    maxCap: 5000,
    days: [],
    ...over,
  });

const view = (props: Partial<Parameters<typeof WarmupView>[0]>) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <WarmupView
        channelId="ch_1"
        admin
        ramps={undefined}
        loading={false}
        error={null}
        onRetry={() => undefined}
        {...props}
      />
    </QueryClientProvider>,
  );

describe('warm-up words', () => {
  it('formats days on UTC, with the year only when it changes', () => {
    expect(formatDay('2026-11-19', TODAY)).toBe('Thu 19 Nov');
    expect(formatDay('2027-01-02', TODAY)).toBe('2 Jan 2027');
    expect(relativeDay(TODAY, TODAY)).toBe('today');
    expect(relativeDay('2026-11-13', TODAY)).toBe('tomorrow');
    expect(relativeDay('2026-11-19', TODAY)).toBe('Thu 19 Nov');
  });

  it('counts the day warm-up started as day 1', () => {
    expect(dayNumber(ramp())).toBe(6);
    expect(dayNumber(ramp({ startedDay: TODAY }))).toBe(1);
    expect(dayNumber(ramp({ startedDay: '2026-11-20' }))).toBe(1);
  });

  it('says when the whole list fits in a day', () => {
    expect(fullListSentence(ramp().plan)).toBe(
      'Your whole list of 12,731 subscribers fits in one day from Wed 18 Nov.',
    );
    expect(fullListSentence(ramp({}, 900).plan)).toBe(
      'Your whole list of 900 subscribers fits in one day already.',
    );
    expect(fullListSentence(ramp({}, 1).plan)).toMatch(/1 subscriber fits/);
    expect(fullListSentence(ramp({}, 0).plan)).toMatch(/no subscribers yet/);
    expect(fullListSentence(ramp({ growth: 1 }).plan)).toMatch(/Choose a faster pace/);
    expect(sendDoneSentence(ramp().plan)).toBe(
      'A post sent to everyone today finishes going out on Mon 16 Nov.',
    );
    expect(sendDoneSentence(ramp({}, 900).plan)).toBeNull();
    expect(sendDoneSentence(ramp({}, 3000).plan)).toMatch(/tomorrow\.$/);
  });

  it('does not round a 0.08% limit up to 0.1%', () => {
    expect(ratePercent(0.0008)).toBe('0.08%');
    expect(ratePercent(0.02)).toBe('2%');
  });

  it('names the reset time in UTC and in local time when they differ', () => {
    expect(resetTime(new Date('2026-11-12T10:00:00Z'))).toMatch(/^00:00 UTC/);
  });

  it('puts a pause by hand in plain words and keeps the engine’s reason otherwise', () => {
    expect(pauseReason({ pausedReason: 'Paused by a teammate.', pausedBy: 'person' })).toEqual({
      byHand: true,
      text: 'Someone on your team paused it by hand.',
    });
    expect(
      pauseReason({ pausedReason: 'Bounce rate 3.4% is over the 2.0% limit.', pausedBy: 'system' }),
    ).toEqual({
      byHand: false,
      text: 'Bounce rate 3.4% is over the 2.0% limit.',
    });
    expect(pauseReason({ pausedReason: null, pausedBy: 'system' }).byHand).toBe(false);
    // Who paused it decides, never the words: a reason that reads like a person's is not one.
    expect(pauseReason({ pausedReason: 'Paused by a teammate.', pausedBy: 'system' }).byHand).toBe(
      false,
    );
  });

  it('checks custom pace fields against the bounds of the domain', () => {
    expect(customPaceProblem('custom', '1000', '40').values).toEqual({
      startCap: 1000,
      growth: 1.4,
    });
    expect(customPaceProblem('custom', '5', '40').startCap).toMatch(/10 to 100,000/);
    expect(customPaceProblem('custom', '', '40').startCap).toBeDefined();
    expect(customPaceProblem('custom', '12.5', '40').startCap).toBeDefined();
    expect(customPaceProblem('custom', '1000', '300').growth).toMatch(/5 to 200/);
    expect(customPaceProblem('shared', '501', '60')).toMatchObject({
      startCap: expect.stringContaining('500'),
      growth: expect.stringContaining('50'),
    });
  });

  it('previews a pace with the server’s rule: a grown limit is never lowered', () => {
    const options = paceOptions(ramp());
    expect(options.map((o) => o.name)).toEqual(['Careful', 'Standard', 'Fast']);
    for (const option of options) expect(option.plan.days[0]?.cap).toBe(1520);
    expect(options[0]!.plan.fullListDay! > options[2]!.plan.fullListDay!).toBe(true);
    expect(previewPace(ramp(), { startCap: 5000, growth: 1.5 }).days[0]?.cap).toBe(5000);
    // Starting again goes back to the pace's first day.
    const again = paceOptions(ramp({ status: 'complete', capToday: 1_000_000 }), true);
    expect(again.map((o) => o.plan.days[0]?.cap)).toEqual([50, 200, 500]);
  });

  it('shows the plan up to the day the list fits, and at most eight rows first', () => {
    expect(planPreviewLength(ramp().plan)).toBe(7);
    expect(planPreviewLength(shared().plan)).toBe(8);
    expect(planPreviewLength(ramp({}, 900).plan)).toBe(3);
  });

  it('picks the default sender’s own domain first, then any own domain, then the shared one', () => {
    const own = ramp();
    const second = ramp({ id: 'rr_2', sendingDomainId: 'sd_2' });
    expect(primaryRamp([shared(), own, second], 'sd_2')?.id).toBe('rr_2');
    expect(primaryRamp([shared(), own, second], null)?.id).toBe('rr_1');
    expect(primaryRamp([shared()], null)?.id).toBe('rr_0');
    expect(primaryRamp([], null)).toBeNull();
  });
});

describe('the warm-up route', () => {
  const states = (r: Ramp) => warmupSteps(r).map((s) => s.state);
  it('is on Warming up while the list does not fit in a day', () => {
    const steps = warmupSteps(ramp());
    expect(steps.map((s) => s.title)).toEqual([
      'Domain verified',
      'Pace chosen',
      'Warming up',
      'Whole list in one day',
      'Complete',
    ]);
    expect(states(ramp())).toEqual(['done', 'done', 'now', 'ahead', 'ahead']);
    expect(steps[1]?.detail).toBe('Standard: starts at 200 a day, grows 50% a day');
    expect(steps[2]?.detail).toBe('Day 6: 412 of 1,520 sent today');
    expect(steps[3]?.detail).toBe('Wed 18 Nov');
  });

  it('moves on to Complete once the list fits', () => {
    const small = ramp({}, 900);
    expect(states(small)).toEqual(['done', 'done', 'done', 'done', 'now']);
    expect(warmupSteps(small)[3]?.detail).toBe('900 subscribers fit in one day');
  });

  it('stays on Warming up when paused, and says what a resume would give', () => {
    const paused = ramp({
      status: 'paused',
      pausedReason: 'Bounce rate 3.4% is over the 2.0% limit.',
    });
    expect(states(paused)).toEqual(['done', 'done', 'now', 'ahead', 'ahead']);
    expect(warmupSteps(paused)[2]?.detail).toBe('Paused on day 6');
    expect(warmupSteps(paused)[3]?.detail).toMatch(/^If you resume today: /);
  });

  it('is all done when complete, and says so differently when skipped', () => {
    const complete = ramp({ status: 'complete' });
    expect(states(complete)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(warmupSteps(complete)[4]?.detail).toBe('No daily limit');
    const skipped = ramp({ status: 'complete', skippedAt: '2026-11-10T09:00:00.000Z' });
    expect(warmupSteps(skipped)[2]?.detail).toBe('Skipped');
    expect(warmupSteps(skipped)[4]?.detail).toBe('Skipped on 10 Nov 2026');
  });

  it('never has more than one current step', () => {
    for (const r of [
      ramp(),
      ramp({}, 0),
      shared(),
      ramp({ status: 'paused' }),
      ramp({ growth: 1 }),
    ]) {
      expect(states(r).filter((s) => s === 'now').length).toBeLessThanOrEqual(1);
    }
  });
});

describe('the Warm-up section', () => {
  it('explains warm-up in every state, in plain words', () => {
    const html = view({ loading: true });
    expect(html).toContain('How warm-up works');
    expect(html).toContain('What Swarm does for you');
    expect(html).toContain('What it means for your posts');
    expect(html).toContain('How to warm up well');
    expect(html).toContain('Loading warm-up');
    expect(html).not.toMatch(/Reputation Ramp|Members?\b|Channel|Dispatch|Broadcast|\u2014/);
  });

  it('shows an error with a way to try again', () => {
    const html = view({ error: 'Something went wrong on our side.' });
    expect(html).toContain('Warm-up could not be loaded');
    expect(html).toContain('Try again');
    expect(html).not.toContain('Loading warm-up');
  });

  it('points to Domains when there is no sending domain', () => {
    const html = view({ ramps: [] });
    expect(html).toContain('No sending domain yet');
    expect(html).toContain('href="#sending-domains"');
  });

  it('says what the shared domain is, where its warm-up ends and how to get your own', () => {
    const html = view({ ramps: [shared()] });
    expect(html).toContain('Shared domain ready');
    expect(html).toContain('This is the shared domain of this Swarm install.');
    expect(html).toContain('Warm-up here ends when the daily limit reaches 5,000.');
    expect(html).toContain('the step up to your 12,731 subscribers is a sudden one');
    expect(html).toContain('href="#sending-domains"');
    expect(html).toContain('Add your own domain');
    expect(html).toContain('An instance admin of this install can raise the ceiling');
    expect(html).toContain('Change pace');
    expect(html).not.toContain('Raise the ceiling');
    expect(html).not.toContain('My domain already sends this much mail');
  });

  it('offers an instance admin the ceiling and the skip on the shared domain', () => {
    const html = view({ ramps: [{ ...shared(), sharedOverride: true }] });
    expect(html).toContain('You are an instance admin');
    expect(html).toContain('Raise the ceiling');
    expect(html).toContain('My domain already sends this much mail');
    // Not to someone who is an instance admin but not an admin of this publication.
    const viewer = view({ ramps: [{ ...shared(), sharedOverride: true }], admin: false });
    expect(viewer).not.toContain('>Raise the ceiling</button>');
    expect(viewer).not.toContain('My domain already sends this much mail');
  });

  it('shows where a warming domain is, its plan and its actions', () => {
    const html = view({ ramps: [shared(), ramp()], defaultDomainId: 'sd_1' });
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('Day 6: 412 of 1,520 sent today');
    expect(html).toContain('The plan from today');
    // Once a week unless the teammate says otherwise: later than the fastest plan (Wed 18 Nov).
    expect(html).toContain('How often do you send?');
    expect(html).toContain(
      'Your whole list of 12,731 subscribers fits in one day from Fri 27 Nov, if you send to everyone once a week.',
    );
    expect(html).toContain('again once a week');
    expect(html).toContain('Whole list fits');
    expect(html).toContain('0.08%');
    expect(html).toContain('Change pace');
    expect(html).toContain('Pause sending');
    expect(html).toContain('My domain already sends this much mail');
    expect(html).toContain('Other sending domain: mail.swarm.example');
    // One route on the page: the other domain is listed without one.
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
  });

  it('shows the reason for a pause and what to do next', () => {
    const html = view({
      ramps: [ramp({ status: 'paused', pausedReason: 'Bounce rate 3.4% is over the 2.0% limit.' })],
    });
    expect(html).toContain('Sending from this domain is paused');
    expect(html).toContain('Bounce rate 3.4% is over the 2.0% limit.');
    expect(html).toContain('What to do next');
    expect(html).toContain('Resume sending');
    expect(html).toContain('The plan if you resume today');
    expect(html).not.toContain('Pause sending');
  });

  it('leaves resuming the shared domain to an instance admin when it paused itself', () => {
    const own = (pausedBy: 'system' | 'person', pausedReason: string) =>
      view({ ramps: [shared({ status: 'paused', pausedBy, pausedReason })] });
    // A reason that reads like a person's does not make it one: pausedBy decides.
    const automatic = own('system', 'Paused by a teammate.');
    expect(automatic).toContain('Only an instance admin can resume sending');
    expect(automatic).not.toContain('Resume sending</button>');
    const byHand = own('person', 'Paused by a teammate.');
    expect(byHand).toContain('Someone on your team paused it by hand.');
    expect(byHand).not.toContain('Only an instance admin can resume sending');
  });

  it('shows complete and skipped domains with a way to start again', () => {
    const complete = view({ ramps: [ramp({ status: 'complete' })] });
    expect(complete).toContain('Warm-up is finished.');
    expect(complete).toContain('Start warm-up again');
    expect(complete).not.toContain('The plan from today');
    expect(complete).not.toContain('Change pace');
    const skipped = view({
      ramps: [ramp({ status: 'complete', skippedAt: '2026-11-10T09:00:00.000Z' })],
    });
    expect(skipped).toContain('Warm-up was skipped for this domain.');
    expect(skipped).toContain('Skipped on 10 Nov 2026');
    expect(skipped).toContain('Start warm-up again');
  });

  it('is read-only for people who are not admins', () => {
    const html = view({ ramps: [ramp()], admin: false });
    expect(html).toContain('Only owners and admins can change warm-up.');
    expect(html).not.toContain('Change pace');
    expect(html).not.toContain('Skip warm-up');
    const paused = view({ ramps: [ramp({ status: 'paused' })], admin: false });
    expect(paused).toContain('An owner or admin can resume sending.');
    expect(paused).not.toContain('Resume sending</button>');
  });
});
