import { NO_INBOX_RULES, type FlowRunHold } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  fromDraft,
  heldEndedSentence,
  heldNowSentence,
  heldSentence,
  holdTime,
  rulesProblems,
  toDraft,
} from './inbox-rules';

const hold = (over: Partial<FlowRunHold> = {}): FlowRunHold => ({
  nodeId: 'email',
  reason: 'quiet_hours',
  until: '2026-11-03T07:00:00.000Z',
  zone: 'Europe/Prague',
  heldAt: '2026-11-02T22:00:00.000Z',
  releasedAt: null,
  outcome: null,
  ...over,
});

describe('the sentence a held run shows', () => {
  it('says the time in the zone the rule was read in, without the date on the same day', () => {
    const lateThatNight = Date.parse('2026-11-02T23:30:00.000Z');
    expect(heldSentence(hold(), lateThatNight)).toBe('Held: quiet hours until 08:00.');
    expect(heldSentence(hold(), Date.parse(hold().until))).toBe(
      'The inbox rule has lifted, so this email goes out as soon as it can.',
    );
  });

  it('adds the day when the time is on another day', () => {
    const before = Date.parse('2026-11-02T12:00:00.000Z');
    expect(holdTime(hold().until, 'Europe/Prague', before)).toBe('Tue 3 Nov, 08:00');
    expect(heldSentence(hold({ reason: 'daily_limit' }), before)).toBe(
      'Held: the daily email limit is reached until Tue 3 Nov, 08:00.',
    );
  });

  it('has a sentence for every reason', () => {
    const at = Date.parse('2026-11-03T06:00:00.000Z');
    for (const reason of [
      'quiet_hours',
      'daily_limit',
      'weekly_limit',
      'newsletter_day',
      'near_post',
      'in_line',
    ] as const) {
      expect(heldSentence(hold({ reason }), at)).toMatch(/^Held: .* until 08:00\.$/);
    }
  });

  it('survives a zone the browser does not know', () => {
    expect(holdTime(hold().until, 'Mars/Olympus', Date.parse('2026-11-03T06:00:00.000Z'))).toBe(
      '07:00',
    );
  });

  it('says what became of a hold that is over', () => {
    const over = { releasedAt: '2026-11-03T07:00:00.000Z' };
    expect(heldEndedSentence(hold({ ...over, outcome: 'sent' }))).toBe(
      'Held from Mon 2 Nov, 23:00 until Tue 3 Nov, 08:00, then sent.',
    );
    expect(heldEndedSentence(hold({ ...over, outcome: 'expired' }))).toContain('was not sent');
    expect(heldEndedSentence(hold({ ...over, outcome: 'left' }))).toContain('The run ended');
    expect(heldEndedSentence(hold())).toContain('The run ended');
  });
});

describe('the settings form', () => {
  it('starts with every rule off, and saving it unchanged keeps them off', () => {
    const draft = toDraft(NO_INBOX_RULES, null);
    expect(draft.limitOn || draft.quietOn || draft.postDayOn).toBe(false);
    expect(rulesProblems(draft)).toEqual({});
    expect(fromDraft(draft)).toEqual(NO_INBOX_RULES);
  });

  it('round-trips rules that are on', () => {
    const rules = {
      perDay: 2,
      perWeek: null,
      quietHours: { start: '21:30', end: '07:15' },
      newsletterDay: { hoursAround: 6 },
      maxHoldDays: 30,
    };
    expect(fromDraft(toDraft(rules, 'Europe/Prague'))).toEqual(rules);
    expect(toDraft(rules, 'Europe/Prague').timezone).toBe('Europe/Prague');
  });

  it('asks for a limit when the limit is on, and refuses numbers out of range', () => {
    const on = { ...toDraft(NO_INBOX_RULES, null), limitOn: true };
    expect(rulesProblems(on).perDay).toMatch(/per day, per week or both/);
    expect(rulesProblems({ ...on, perWeek: '3' })).toEqual({});
    expect(rulesProblems({ ...on, perDay: '0' }).perDay).toMatch(/1 to 50/);
    expect(rulesProblems({ ...on, perWeek: '1000' }).perWeek).toMatch(/1 to 200/);
  });

  it('refuses quiet hours that start and end together, and a wait out of range', () => {
    const base = toDraft(NO_INBOX_RULES, null);
    expect(
      rulesProblems({ ...base, quietOn: true, quietStart: '08:00', quietEnd: '08:00' }).quietEnd,
    ).toMatch(/differ/);
    expect(rulesProblems({ ...base, maxHoldDays: '0' }).maxHoldDays).toMatch(/1 to 90/);
    expect(rulesProblems({ ...base, postDayOn: true, hoursAround: '99' }).hoursAround).toMatch(
      /0 to 72/,
    );
  });

  it('counts held emails in whole sentences', () => {
    expect(heldNowSentence(0)).toBe('No emails are held right now.');
    expect(heldNowSentence(1)).toBe('One email is held right now.');
    expect(heldNowSentence(1200)).toBe('1,200 emails are held right now.');
  });
});
