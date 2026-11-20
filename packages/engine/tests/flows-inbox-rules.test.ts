// The inbox rule decision: pure, so every case here is just facts in and an answer out.
import { NO_INBOX_RULES, type InboxRules } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { IN_LINE_GAP_MS, decideInboxRules, inQuietHours, type InboxRuleFacts } from '../src/flows';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const facts = (rules: Partial<InboxRules>, over: Partial<InboxRuleFacts> = {}): InboxRuleFacts => ({
  now: Date.UTC(2026, 10, 2, 12, 0),
  rules: { ...NO_INBOX_RULES, ...rules },
  zone: 'UTC',
  sendRegardless: false,
  recentSends: [],
  posts: [],
  heldSince: null,
  ahead: null,
  ...over,
});

describe('with no rule on', () => {
  it('sends, whatever the facts', () => {
    expect(
      decideInboxRules(
        facts({}, { recentSends: [Date.UTC(2026, 10, 2, 11, 0)], posts: [Date.UTC(2026, 10, 2)] }),
      ),
    ).toEqual({ action: 'send' });
  });
});

describe('quiet hours', () => {
  const quiet = { quietHours: { start: '22:00', end: '08:00' } };

  it('holds overnight until the end, across midnight', () => {
    expect(decideInboxRules(facts(quiet, { now: Date.UTC(2026, 10, 2, 23, 0) }))).toEqual({
      action: 'hold',
      reason: 'quiet_hours',
      until: Date.UTC(2026, 10, 3, 8, 0),
    });
    expect(decideInboxRules(facts(quiet, { now: Date.UTC(2026, 10, 3, 3, 0) }))).toEqual({
      action: 'hold',
      reason: 'quiet_hours',
      until: Date.UTC(2026, 10, 3, 8, 0),
    });
  });

  it('lets the end minute itself through, and holds from the start minute', () => {
    expect(decideInboxRules(facts(quiet, { now: Date.UTC(2026, 10, 3, 8, 0) })).action).toBe(
      'send',
    );
    expect(decideInboxRules(facts(quiet, { now: Date.UTC(2026, 10, 3, 22, 0) })).action).toBe(
      'hold',
    );
  });

  it('reads the times in the zone it is given', () => {
    // 21:30 UTC is 22:30 in Prague (CET in November) and 16:30 in New York.
    const now = Date.UTC(2026, 10, 2, 21, 30);
    expect(decideInboxRules(facts(quiet, { now, zone: 'Europe/Prague' }))).toEqual({
      action: 'hold',
      reason: 'quiet_hours',
      until: Date.UTC(2026, 10, 3, 7, 0),
    });
    expect(decideInboxRules(facts(quiet, { now, zone: 'America/New_York' })).action).toBe('send');
  });

  it('handles a range inside one day', () => {
    const daytime = { start: '09:00', end: '17:00' };
    expect(inQuietHours(Date.UTC(2026, 10, 2, 12, 0), daytime, 'UTC')).toBe(true);
    expect(inQuietHours(Date.UTC(2026, 10, 2, 17, 0), daytime, 'UTC')).toBe(false);
    expect(inQuietHours(Date.UTC(2026, 10, 2, 8, 59), daytime, 'UTC')).toBe(false);
  });

  it('ends in the future and out of quiet hours, across every clock change of the year', () => {
    for (const zone of ['America/New_York', 'Europe/Prague', 'Australia/Lord_Howe', 'Asia/Tokyo']) {
      for (const hours of [
        { start: '22:00', end: '08:00' },
        { start: '01:30', end: '02:30' }, // the hour that a spring change skips
        { start: '00:30', end: '03:00' },
      ]) {
        for (let hour = 0; hour < 365 * 24; hour += 5) {
          const now = Date.UTC(2026, 0, 1) + hour * HOUR;
          const decision = decideInboxRules(facts({ quietHours: hours }, { now, zone }));
          if (decision.action === 'send') continue;
          expect(decision.until).toBeGreaterThan(now);
          expect(decision.until - now).toBeLessThanOrEqual(2 * DAY);
          expect(inQuietHours(decision.until, hours, zone)).toBe(false);
        }
      }
    }
  });
});

describe('the limit', () => {
  const now = Date.UTC(2026, 10, 10, 12, 0);

  it('holds until the oldest email in the day leaves the 24 hours', () => {
    const sends = [now - 20 * HOUR, now - HOUR];
    expect(decideInboxRules(facts({ perDay: 2 }, { now, recentSends: sends }))).toEqual({
      action: 'hold',
      reason: 'daily_limit',
      until: now + 4 * HOUR,
    });
    expect(decideInboxRules(facts({ perDay: 3 }, { now, recentSends: sends })).action).toBe('send');
    expect(
      decideInboxRules(facts({ perDay: 2 }, { now, recentSends: [now - 25 * HOUR, now - HOUR] }))
        .action,
    ).toBe('send');
  });

  it('waits long enough when exempt emails took it over the limit', () => {
    const sends = [now - 22 * HOUR, now - 10 * HOUR, now - HOUR];
    // Limit 1 with 3 in the window: only when the newest leaves is there room.
    expect(decideInboxRules(facts({ perDay: 1 }, { now, recentSends: sends }))).toEqual({
      action: 'hold',
      reason: 'daily_limit',
      until: now + 23 * HOUR,
    });
  });

  it('applies the weekly limit over any 7 days', () => {
    const sends = [now - 6 * DAY, now - 2 * DAY];
    expect(decideInboxRules(facts({ perWeek: 2 }, { now, recentSends: sends }))).toEqual({
      action: 'hold',
      reason: 'weekly_limit',
      until: now + DAY,
    });
  });

  it('checks both limits and waits for the later', () => {
    const sends = [now - 6 * DAY, now - HOUR];
    expect(decideInboxRules(facts({ perDay: 1, perWeek: 2 }, { now, recentSends: sends }))).toEqual(
      { action: 'hold', reason: 'weekly_limit', until: now + DAY },
    );
  });
});

describe('newsletter day', () => {
  const noon = Date.UTC(2026, 10, 2, 12, 0);

  it('holds until the next day when a post went or will go today', () => {
    const until = Date.UTC(2026, 10, 3);
    for (const post of [Date.UTC(2026, 10, 2, 6, 0), Date.UTC(2026, 10, 2, 18, 0)]) {
      expect(
        decideInboxRules(
          facts({ newsletterDay: { hoursAround: 0 } }, { now: noon, posts: [post] }),
        ),
      ).toEqual({ action: 'hold', reason: 'newsletter_day', until });
    }
  });

  it('reads the day in the subscriber’s zone', () => {
    const post = Date.UTC(2026, 10, 2, 23, 30); // 3 Nov in Tokyo, 2 Nov in New York.
    const rules = { newsletterDay: { hoursAround: 0 } };
    expect(
      decideInboxRules(facts(rules, { now: noon, posts: [post], zone: 'Asia/Tokyo' })),
    ).toEqual({ action: 'send' });
    expect(
      decideInboxRules(facts(rules, { now: noon, posts: [post], zone: 'America/New_York' })).action,
    ).toBe('hold');
  });

  it('ignores other days unless they fall within the hours around', () => {
    const tomorrow = Date.UTC(2026, 10, 3, 2, 0);
    expect(
      decideInboxRules(
        facts({ newsletterDay: { hoursAround: 0 } }, { now: noon, posts: [tomorrow] }),
      ),
    ).toEqual({ action: 'send' });
    // 14 hours before the post, inside a 15 hour margin: wait until the margin after it ends,
    // which is that later day, so the day rule then carries it to midnight.
    expect(
      decideInboxRules(
        facts({ newsletterDay: { hoursAround: 15 } }, { now: noon, posts: [tomorrow] }),
      ),
    ).toEqual({ action: 'hold', reason: 'newsletter_day', until: Date.UTC(2026, 10, 4) });
    expect(
      decideInboxRules(
        facts({ newsletterDay: { hoursAround: 13 } }, { now: noon, posts: [tomorrow] }),
      ),
    ).toEqual({ action: 'send' });
  });

  it('names the rule that holds a post from a few hours back', () => {
    const justAfterMidnight = Date.UTC(2026, 10, 3, 1, 0);
    const lateLastNight = Date.UTC(2026, 10, 2, 23, 0);
    expect(
      decideInboxRules(
        facts(
          { newsletterDay: { hoursAround: 6 } },
          { now: justAfterMidnight, posts: [lateLastNight] },
        ),
      ),
    ).toEqual({ action: 'hold', reason: 'near_post', until: Date.UTC(2026, 10, 3, 5, 0) });
  });
});

describe('rules together', () => {
  it('finds the first moment every rule agrees, and names the rule that set it', () => {
    // 23:00: quiet until 08:00, but tomorrow is a post day, then quiet again until 08:00 after it.
    const decision = decideInboxRules(
      facts(
        { quietHours: { start: '22:00', end: '08:00' }, newsletterDay: { hoursAround: 0 } },
        { now: Date.UTC(2026, 10, 2, 23, 0), posts: [Date.UTC(2026, 10, 3, 9, 0)] },
      ),
    );
    expect(decision).toEqual({
      action: 'hold',
      reason: 'quiet_hours',
      until: Date.UTC(2026, 10, 4, 8, 0),
    });
  });
});

describe('send regardless', () => {
  it('is never held, by any rule', () => {
    expect(
      decideInboxRules(
        facts(
          { perDay: 1, quietHours: { start: '00:00', end: '23:59' } },
          {
            sendRegardless: true,
            recentSends: [Date.UTC(2026, 10, 2, 11, 0)],
            ahead: Date.UTC(2026, 10, 3),
          },
        ),
      ),
    ).toEqual({ action: 'send' });
  });
});

describe('a line of held emails', () => {
  const now = Date.UTC(2026, 10, 2, 12, 0);

  it('keeps an email behind the one in front even when no rule stops it', () => {
    expect(decideInboxRules(facts({ perDay: 5 }, { now, ahead: now - 1000 }))).toEqual({
      action: 'hold',
      reason: 'in_line',
      until: now + IN_LINE_GAP_MS,
    });
    expect(decideInboxRules(facts({ perDay: 5 }, { now, ahead: now + HOUR }))).toEqual({
      action: 'hold',
      reason: 'in_line',
      until: now + HOUR + IN_LINE_GAP_MS,
    });
  });

  it('keeps the reason of a rule that stops it too', () => {
    expect(
      decideInboxRules(facts({ perDay: 1 }, { now, recentSends: [now - HOUR], ahead: now })),
    ).toEqual({ action: 'hold', reason: 'daily_limit', until: now + 23 * HOUR });
  });
});

describe('a wait that goes stale', () => {
  const now = Date.UTC(2026, 10, 20, 12, 0);

  it('holds up to the limit and exits past it, counting from when the wait began', () => {
    const sends = [now - HOUR];
    const rules = { perWeek: 1, maxHoldDays: 14 };
    expect(decideInboxRules(facts(rules, { now, recentSends: sends })).action).toBe('hold');
    expect(
      decideInboxRules(facts(rules, { now, recentSends: sends, heldSince: now - 7 * DAY })).action,
    ).toBe('hold');
    expect(
      decideInboxRules(facts(rules, { now, recentSends: sends, heldSince: now - 8 * DAY })),
    ).toEqual({ action: 'expire', reason: 'weekly_limit', until: now + 7 * DAY - HOUR });
  });

  it('exits at once when even the first wait is too long', () => {
    expect(
      decideInboxRules(facts({ perWeek: 1, maxHoldDays: 1 }, { now, recentSends: [now - HOUR] }))
        .action,
    ).toBe('expire');
  });

  it('never exits an email that may go now, however long it waited', () => {
    expect(
      decideInboxRules(facts({ perDay: 1, maxHoldDays: 1 }, { now, heldSince: now - 30 * DAY })),
    ).toEqual({ action: 'send' });
  });
});
