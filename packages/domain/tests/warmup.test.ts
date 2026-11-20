import { describe, expect, it } from 'vitest';
import {
  RAMP_BOUNDS,
  RAMP_PACES,
  RAMP_PACE_KEYS,
  UpdateRampSchema,
  SkipRampSchema,
  RestartRampSchema,
  WARMUP_CADENCES,
  WARMUP_PLAN_MAX_DAYS,
  WarmupPlanSchema,
  nextRampCap,
  projectWarmup,
  rampCapAfterPaceChange,
  rampPaceOf,
  rampPaceProblem,
  type WarmupState,
} from '../src/index';

const fresh = (over: Partial<WarmupState> = {}): WarmupState => ({
  status: 'warming',
  day: '2026-11-12',
  capToday: 200,
  sentToday: 0,
  growth: 1.5,
  maxCap: 1_000_000,
  ...over,
});
const TODAY = '2026-11-12';

describe('warm-up paces', () => {
  it('names a ramp by its numbers, and calls anything else custom', () => {
    expect(rampPaceOf('custom', 200, 1.5)).toBe('standard');
    expect(rampPaceOf('custom', 50, 1.25)).toBe('careful');
    expect(rampPaceOf('custom', 500, 2)).toBe('fast');
    expect(rampPaceOf('custom', 200, 1.2)).toBe('custom');
    expect(rampPaceOf('shared', 100, 1.3)).toBe('standard');
    // The same numbers mean a different pace on the shared domain.
    expect(rampPaceOf('shared', 200, 1.5)).toBe('fast');
  });

  it('keeps every named pace inside the bounds of its kind, slowest first', () => {
    for (const kind of ['custom', 'shared'] as const) {
      let last = { startCap: 0, growth: 0 };
      for (const key of RAMP_PACE_KEYS) {
        const pace = RAMP_PACES[kind][key];
        expect(rampPaceProblem(kind, pace), `${kind} ${key}`).toBeNull();
        expect(pace.startCap).toBeGreaterThan(last.startCap);
        expect(pace.growth).toBeGreaterThan(last.growth);
        last = pace;
      }
    }
  });

  it('refuses custom numbers outside the bounds, and is stricter on the shared domain', () => {
    expect(rampPaceProblem('custom', { startCap: 5 })).toMatch(/between 10 and 100000/);
    expect(rampPaceProblem('custom', { startCap: 20_000, growth: 2.5 })).toBeNull();
    expect(rampPaceProblem('custom', { growth: 1 })).toMatch(/growth/i);
    expect(rampPaceProblem('shared', { startCap: RAMP_BOUNDS.shared.startCap.max + 1 })).toMatch(
      /shared domain/,
    );
    expect(rampPaceProblem('shared', { growth: 2 })).toMatch(/shared domain/);
    expect(rampPaceProblem('custom', {})).toBeNull();
  });

  it('validates the request bodies', () => {
    expect(UpdateRampSchema.safeParse({ pace: 'fast' }).success).toBe(true);
    expect(UpdateRampSchema.safeParse({ startCap: 1000, growth: 1.4 }).success).toBe(true);
    expect(UpdateRampSchema.safeParse({ pace: 'fast', startCap: 1000 }).success).toBe(false);
    expect(UpdateRampSchema.safeParse({ pace: 'custom' }).success).toBe(false);
    expect(UpdateRampSchema.safeParse({ startCap: 1.5 }).success).toBe(false);
    expect(UpdateRampSchema.safeParse({}).success).toBe(false);
    expect(SkipRampSchema.safeParse({ confirm: true, dailyVolume: 40_000 }).success).toBe(true);
    expect(SkipRampSchema.safeParse({ confirm: false }).success).toBe(false);
    expect(SkipRampSchema.safeParse({}).success).toBe(false);
    expect(RestartRampSchema.safeParse({ confirm: true, pace: 'careful' }).success).toBe(true);
    expect(RestartRampSchema.safeParse({ pace: 'careful' }).success).toBe(false);
  });
});

describe('today’s cap after a change of pace', () => {
  const ramp = {
    status: 'warming' as const,
    capToday: 200,
    sentToday: 0,
    startCap: 200,
    maxCap: 1_000_000,
  };
  it('takes the new start on a ramp that has not grown, but never under what today used', () => {
    expect(rampCapAfterPaceChange(ramp, 500)).toBe(500);
    expect(rampCapAfterPaceChange(ramp, 50)).toBe(50);
    expect(rampCapAfterPaceChange({ ...ramp, sentToday: 120 }, 50)).toBe(120);
    expect(rampCapAfterPaceChange({ ...ramp, maxCap: 300 }, 500)).toBe(300);
  });
  it('never lowers a ramp that has grown', () => {
    const grown = { ...ramp, capToday: 1520, sentToday: 900 };
    expect(rampCapAfterPaceChange(grown, 50)).toBe(1520);
    expect(rampCapAfterPaceChange(grown, 500)).toBe(1520);
    expect(rampCapAfterPaceChange(grown, 5000)).toBe(5000);
    for (const start of [10, 50, 200, 500, 1519, 1521, 100_000]) {
      expect(rampCapAfterPaceChange(grown, start)).toBeGreaterThanOrEqual(grown.capToday);
      expect(rampCapAfterPaceChange(grown, start)).toBeGreaterThanOrEqual(grown.sentToday);
    }
  });
  it('leaves a complete ramp alone', () => {
    expect(rampCapAfterPaceChange({ ...ramp, status: 'complete', capToday: 40_000 }, 50)).toBe(
      40_000,
    );
  });
});

describe('the warm-up plan', () => {
  it('grows the cap the way the engine does: multiplied, rounded up, never past the ceiling', () => {
    expect(nextRampCap(200, 1.5, 1_000_000)).toBe(300);
    expect(nextRampCap(100, 1.3, 5_000)).toBe(130);
    expect(nextRampCap(169, 1.3, 5_000)).toBe(220);
    expect(nextRampCap(4_000, 1.3, 5_000)).toBe(5_000);
    expect(nextRampCap(10, 1.05, 5_000)).toBe(11);
  });

  it('plans a new Standard ramp day by day', () => {
    const plan = projectWarmup(fresh(), 3_000, TODAY);
    expect(plan.days.slice(0, 5)).toEqual([
      { day: '2026-11-12', cap: 200, reach: 200 },
      { day: '2026-11-13', cap: 300, reach: 500 },
      { day: '2026-11-14', cap: 450, reach: 950 },
      { day: '2026-11-15', cap: 675, reach: 1625 },
      { day: '2026-11-16', cap: 1013, reach: 2638 },
    ]);
    // 200, 300, 450, 675, 1013, 1520, 2280, 3420: the eighth day's cap covers 3,000.
    expect(plan.fullListDay).toBe('2026-11-19');
    // A post sent today reaches everyone on the sixth day (2638 + 1520 >= 3000).
    expect(plan.sendDoneDay).toBe('2026-11-17');
    expect(plan.days.find((d) => d.day === '2026-11-17')?.reach).toBe(3_000);
    expect(plan.assumesResume).toBe(false);
    expect(plan.audience).toBe(3_000);
    expect(plan.today).toBe(TODAY);
  });

  it('never reports a reach above the audience, and reach never goes down', () => {
    const plan = projectWarmup(fresh(), 12_731, TODAY);
    let last = 0;
    for (const day of plan.days) {
      expect(day.reach).toBeLessThanOrEqual(12_731);
      expect(day.reach).toBeGreaterThanOrEqual(last);
      last = day.reach;
    }
    expect(last).toBe(12_731);
  });

  it('counts what today already used against a post sent today', () => {
    const plan = projectWarmup(fresh({ sentToday: 150 }), 3_000, TODAY);
    expect(plan.days[0]).toEqual({ day: TODAY, cap: 200, reach: 50 });
    expect(plan.days[1]).toEqual({ day: '2026-11-13', cap: 300, reach: 350 });
    // The caps and the day the list fits are the same; only the reach is behind.
    expect(plan.fullListDay).toBe('2026-11-19');
  });

  it('says today when the cap already covers the audience', () => {
    const plan = projectWarmup(fresh(), 150, TODAY);
    expect(plan.fullListDay).toBe(TODAY);
    expect(plan.sendDoneDay).toBe(TODAY);
    expect(plan.days[0]).toEqual({ day: TODAY, cap: 200, reach: 150 });
    expect(projectWarmup(fresh(), 0, TODAY).fullListDay).toBe(TODAY);
  });

  it('ends at the ceiling: the day the cap reaches it is the day the ramp completes', () => {
    const plan = projectWarmup(fresh({ capToday: 100, growth: 1.3, maxCap: 5_000 }), 20_000, TODAY);
    const last = plan.days.at(-1);
    expect(last?.cap).toBe(5_000);
    expect(plan.completeDay).toBe(last?.day);
    // A complete ramp limits nothing, so the whole list fits from that day although 5,000 < 20,000.
    expect(plan.fullListDay).toBe(plan.completeDay);
    expect(plan.sendDoneDay).toBe(plan.completeDay);
    expect(last?.reach).toBe(20_000);
    // 100 * 1.3^n reaches 5,000 on the 16th step.
    expect(plan.days).toHaveLength(16);
    expect(plan.truncated).toBe(false);
  });

  it('moves a ramp left on an earlier day to today first, as rollover would', () => {
    const halfUsed = projectWarmup(fresh({ day: '2026-11-10', sentToday: 100 }), 3_000, TODAY);
    expect(halfUsed.days[0]).toEqual({ day: TODAY, cap: 300, reach: 300 });
    const idle = projectWarmup(fresh({ day: '2026-11-10', sentToday: 99 }), 3_000, TODAY);
    expect(idle.days[0]).toEqual({ day: TODAY, cap: 200, reach: 200 });
  });

  it('plans a paused ramp as if it were resumed today, without growing it for the paused day', () => {
    const plan = projectWarmup(
      fresh({ status: 'paused', day: '2026-11-11', capToday: 450, sentToday: 450 }),
      3_000,
      TODAY,
    );
    expect(plan.assumesResume).toBe(true);
    expect(plan.days[0]).toEqual({ day: TODAY, cap: 450, reach: 450 });
    expect(plan.days[1]?.cap).toBe(675);
  });

  it('has no plan for a complete ramp: nothing is held back', () => {
    const plan = projectWarmup(fresh({ status: 'complete', capToday: 1_000_000 }), 3_000, TODAY);
    expect(plan.days).toEqual([]);
    expect(plan).toMatchObject({ fullListDay: TODAY, sendDoneDay: TODAY, completeDay: TODAY });
  });

  it('caps the list at 60 days but still works out the dates', () => {
    const plan = projectWarmup(
      fresh({ capToday: 10, growth: 1.05, maxCap: 10_000_000 }),
      5_000_000,
      TODAY,
    );
    expect(plan.days).toHaveLength(WARMUP_PLAN_MAX_DAYS);
    expect(plan.truncated).toBe(true);
    expect(plan.fullListDay).not.toBeNull();
    expect(plan.fullListDay! > plan.days.at(-1)!.day).toBe(true);
    expect(plan.completeDay! >= plan.fullListDay!).toBe(true);
    expect(projectWarmup(fresh(), 3_000, TODAY, 5).days).toHaveLength(5);
  });

  it('gives up on dates more than two years away', () => {
    // An older ramp with growth 1 never grows: the list never fits in a day.
    const flat = projectWarmup(fresh({ growth: 1 }), 100_000, TODAY);
    expect(flat.days).toHaveLength(1);
    expect(flat.fullListDay).toBeNull();
    expect(flat.completeDay).toBeNull();
    // A post still gets through at 200 a day: 500 days.
    expect(flat.sendDoneDay).toBe('2028-03-25');
    expect(projectWarmup(fresh({ growth: 1 }), 1_000_000, TODAY).sendDoneDay).toBeNull();
    expect(projectWarmup(fresh({ capToday: 0 }), 10, TODAY).sendDoneDay).toBeNull();
  });

  it('crosses month and year ends on UTC days', () => {
    const plan = projectWarmup(fresh({ day: '2026-12-30' }), 3_000, '2026-12-30');
    expect(plan.days.slice(0, 4).map((d) => d.day)).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
  });

  it('matches its API schema', () => {
    expect(WarmupPlanSchema.safeParse(projectWarmup(fresh(), 3_000, TODAY)).success).toBe(true);
  });
});

describe('the warm-up plan for a publication’s own rhythm', () => {
  const day = (n: number) =>
    new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const weekly = (audience: number, over: Partial<WarmupState> = {}) =>
    projectWarmup(fresh(over), audience, TODAY, undefined, WARMUP_CADENCES.weekly);

  it('follows a weekly newsletter with 5,000 subscribers at the Standard pace', () => {
    const plan = weekly(5_000);
    // The first post keeps going out day after day, and each of those days grows the cap. Its
    // last day sends 842 of 2,280, under half, so the cap stands still until the next post.
    expect(plan.days.slice(0, 8).map((d) => d.cap)).toEqual([
      200, 300, 450, 675, 1013, 1520, 2280, 2280,
    ]);
    expect(plan.days.slice(0, 7).map((d) => d.reach)).toEqual([
      200, 500, 950, 1625, 2638, 4158, 5000,
    ]);
    expect(plan.sendDoneDay).toBe(day(6));
    // The second post (day 8) takes two days: 2,280, then 2,720 of 3,420. That grows the cap to
    // 5,130, so the third post is the first to go out in one day.
    expect(plan.days[8]).toMatchObject({ day: day(8), cap: 3420 });
    expect(plan.days[9]).toMatchObject({ day: day(9), cap: 5130 });
    expect(plan.fullListDay).toBe(day(9));
    // A day later than a publication that fills the cap every day.
    expect(projectWarmup(fresh(), 5_000, TODAY).fullListDay).toBe(day(8));
  });

  it('never ends at a ceiling the list cannot reach: the cap stops over twice the list', () => {
    const plan = weekly(5_000);
    expect(plan.completeDay).toBeNull();
    const last = plan.days.at(-1)!;
    expect(last.cap).toBe(11543);
    expect(last.cap).toBeGreaterThan(2 * 5_000);
    expect(plan.truncated).toBe(false);
    // The plan that assumes every day is half used does name a day, which only a publication
    // sending 500,000 emails a day would see.
    expect(projectWarmup(fresh(), 5_000, TODAY).completeDay).not.toBeNull();
  });

  it('leaves the cap alone on days with nothing to send', () => {
    // 1,000 subscribers: the first post is done on day 4 with 50 emails, far under half of 675.
    const plan = weekly(1_000);
    expect(plan.days.slice(0, 9).map((d) => d.cap)).toEqual([
      200, 300, 450, 675, 675, 675, 675, 675, 1013,
    ]);
    expect(plan.sendDoneDay).toBe(day(3));
    expect(plan.fullListDay).toBe(day(8));
    expect(projectWarmup(fresh(), 1_000, TODAY).fullListDay).toBe(day(4));
  });

  it('is slowest for a weekly newsletter on the shared domain', () => {
    const shared = { capToday: 100, growth: 1.3, maxCap: 5_000 };
    expect(projectWarmup(fresh(shared), 1_000, TODAY).fullListDay).toBe(day(9));
    expect(weekly(1_000, shared).fullListDay).toBe(day(22));
    // A list at the ceiling: the ramp completes a week later than the fastest plan says.
    expect(projectWarmup(fresh(shared), 5_000, TODAY).completeDay).toBe(day(15));
    expect(weekly(5_000, shared).completeDay).toBe(day(22));
  });

  it('gives a daily sender of a large list the same dates as the fastest plan', () => {
    const fastest = projectWarmup(fresh(), 50_000, TODAY);
    const daily = projectWarmup(fresh(), 50_000, TODAY, undefined, WARMUP_CADENCES.daily);
    expect(daily.fullListDay).toBe(fastest.fullListDay);
    expect(daily.sendDoneDay).toBe(fastest.sendDoneDay);
    expect(daily.days.map((d) => d.cap)).toEqual(
      fastest.days.slice(0, daily.days.length).map((d) => d.cap),
    );
  });

  it('counts what today already used, and holds a list that already fits', () => {
    // 150 of 200 used: 50 go today. 150 is over half, so tomorrow's cap is 300.
    const used = weekly(1_000, { sentToday: 150 });
    expect(used.days.slice(0, 2)).toEqual([
      { day: day(0), cap: 200, reach: 50 },
      { day: day(1), cap: 300, reach: 350 },
    ]);
    const small = weekly(80);
    expect(small).toMatchObject({ fullListDay: TODAY, sendDoneDay: TODAY, completeDay: null });
    expect(small.days).toHaveLength(1);
    expect(weekly(0).days).toHaveLength(1);
  });

  it('plans a paused ramp as resumed today, and matches the API schema', () => {
    const plan = weekly(3_000, { status: 'paused', capToday: 450, sentToday: 450 });
    expect(plan.assumesResume).toBe(true);
    expect(plan.days[0]).toEqual({ day: TODAY, cap: 450, reach: 0 });
    expect(WarmupPlanSchema.safeParse(plan).success).toBe(true);
    expect(WarmupPlanSchema.safeParse(weekly(5_000)).success).toBe(true);
  });
});
