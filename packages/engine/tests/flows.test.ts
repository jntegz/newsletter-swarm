// Pure parts of the Flows engine: trigger matching, delay arithmetic, A/B arms, webhooks.
import { FlowTriggerConfigSchema } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  abArm,
  chooseStartEvent,
  delayUntil,
  matchesTrigger,
  nextWeekdayTime,
  webhookSignature,
  webhookUrlProblem,
} from '../src/index';

const trigger = (config: unknown) => FlowTriggerConfigSchema.parse(config);

describe('matchesTrigger', () => {
  it('honours each config field', () => {
    const joined = trigger({ event: 'member_joined' });
    expect(matchesTrigger(joined, 'member_joined', { source: 'form' })).toBe(true);
    expect(matchesTrigger(joined, 'member_joined', { source: 'import' })).toBe(false);
    expect(
      matchesTrigger(trigger({ event: 'member_joined', includeImports: true }), 'member_joined', {
        source: 'import',
      }),
    ).toBe(true);
    expect(matchesTrigger(joined, 'confirmed', {})).toBe(false);
    const click = trigger({ event: 'link_clicked', url: 'https://example.com/a' });
    expect(matchesTrigger(click, 'link_clicked', { url: 'https://example.com/a' })).toBe(true);
    expect(matchesTrigger(click, 'link_clicked', { url: 'https://example.com/b' })).toBe(false);
    // The email held the short link, and Swarm knows where it goes.
    expect(
      matchesTrigger(click, 'link_clicked', {
        url: 'https://go.example/abc',
        linkAddresses: ['https://go.example/abc', 'https://example.com/a'],
      }),
    ).toBe(true);
    expect(
      matchesTrigger(trigger({ event: 'unengaged', days: 30 }), 'unengaged', { days: 60 }),
    ).toBe(false);
    expect(
      matchesTrigger(trigger({ event: 'api_event', name: 'go' }), 'api_event', { name: 'go' }),
    ).toBe(true);
    const rosterId = `rs_${'0'.repeat(32)}`;
    const joinedRoster = trigger({ event: 'roster_joined', rosterId });
    expect(matchesTrigger(joinedRoster, 'roster_joined', { rosterId, source: 'form' })).toBe(true);
    expect(
      matchesTrigger(joinedRoster, 'roster_joined', { rosterId: `rs_${'1'.repeat(32)}` }),
    ).toBe(false);
    expect(matchesTrigger(joinedRoster, 'roster_left', { rosterId })).toBe(false);
    expect(
      matchesTrigger(trigger({ event: 'roster_left', rosterId }), 'roster_left', { rosterId }),
    ).toBe(true);
    expect(
      matchesTrigger(trigger({ event: 'referral_succeeded' }), 'referral_succeeded', {
        referralId: 'rf_1',
      }),
    ).toBe(true);
    const milestoneId = `cm_${'0'.repeat(32)}`;
    const anyMilestone = trigger({ event: 'referral_milestone' });
    const oneMilestone = trigger({ event: 'referral_milestone', milestoneId });
    expect(matchesTrigger(anyMilestone, 'referral_milestone', { milestoneId })).toBe(true);
    expect(matchesTrigger(oneMilestone, 'referral_milestone', { milestoneId })).toBe(true);
    expect(
      matchesTrigger(oneMilestone, 'referral_milestone', { milestoneId: `cm_${'1'.repeat(32)}` }),
    ).toBe(false);
    expect(matchesTrigger(oneMilestone, 'referral_succeeded', { milestoneId })).toBe(false);
  });
});

describe('chooseStartEvent', () => {
  const circle = { field: 'circle', cmp: 'eq', value: 'cl_1' } as const;
  const start = (index: number, config: unknown) => ({ index, config: trigger(config) });
  const tagged = { event: 'tag_added', tagId: `tg_${'0'.repeat(32)}` };
  const payload = { tagId: tagged.tagId };

  it('says nothing about an event no start event matches', async () => {
    const none = await chooseStartEvent([start(0, tagged)], 'confirmed', {}, async () => true);
    expect(none).toBeNull();
  });

  it('takes the first start event whose filter lets them in', async () => {
    const triggers = [
      start(0, { ...tagged, filter: circle }),
      start(1, { ...tagged, filter: { field: 'email', cmp: 'contains', value: 'a' } }),
      start(2, tagged),
    ];
    expect(
      await chooseStartEvent(triggers, 'tag_added', payload, async (_, index) => index === 1),
    ).toEqual({ index: 1 });
    expect(await chooseStartEvent(triggers, 'tag_added', payload, async () => false)).toEqual({
      index: 2,
    });
  });

  it('calls a miss a segment only when the filter just asks for one', async () => {
    const reason = async (filter: unknown) =>
      await chooseStartEvent(
        [start(0, { ...tagged, filter })],
        'tag_added',
        payload,
        async () => false,
      );
    expect(await reason(circle)).toEqual({ reason: 'not_in_segment' });
    expect(await reason({ op: 'and', children: [circle] })).toEqual({ reason: 'not_in_segment' });
    expect(await reason({ op: 'not', children: [circle] })).toEqual({ reason: 'filter_miss' });
    expect(await reason({ field: 'email', cmp: 'contains', value: 'a' })).toEqual({
      reason: 'filter_miss',
    });
  });
});

describe('delays', () => {
  it('adds durations', () => {
    expect(delayUntil({ mode: 'duration', amount: 3, unit: 'hours' }, 1000, 'UTC')).toBe(
      1000 + 3 * 3_600_000,
    );
  });

  it('finds the next weekday and time across DST changes', () => {
    // Wednesday 2026-10-28 12:00 UTC; next Friday 09:00 New York (EDT, UTC-4).
    const wed = Date.UTC(2026, 9, 28, 12);
    expect(nextWeekdayTime(wed, [5], '09:00', 'America/New_York')).toBe(Date.UTC(2026, 9, 30, 13));
    // After New York leaves DST on 2026-11-01: Monday 09:00 EST is 14:00 UTC.
    expect(nextWeekdayTime(wed, [1], '09:00', 'America/New_York')).toBe(Date.UTC(2026, 10, 2, 14));
    // Same day, later time.
    expect(nextWeekdayTime(wed, [3], '13:30', 'UTC')).toBe(Date.UTC(2026, 9, 28, 13, 30));
    // Same day, time passed: a week later.
    expect(nextWeekdayTime(wed, [3], '11:00', 'UTC')).toBe(Date.UTC(2026, 10, 4, 11));
    // An unknown zone in the config falls back to UTC.
    expect(
      delayUntil(
        { mode: 'until', weekdays: [3], time: '13:00', timezone: 'Mars/Base' },
        wed,
        'UTC',
      ),
    ).toBe(Date.UTC(2026, 9, 28, 13));
  });
});

describe('A/B arms', () => {
  it('are deterministic per run and roughly follow percentA', async () => {
    expect(await abArm('fr_1', 'split', 50)).toBe(await abArm('fr_1', 'split', 50));
    let a = 0;
    for (let i = 0; i < 1000; i++) if ((await abArm(`fr_${i}`, 'split', 30)) === 'a') a++;
    expect(a).toBeGreaterThan(240);
    expect(a).toBeLessThan(360);
  });
});

describe('webhooks', () => {
  it('signs t.body with HMAC-SHA256', async () => {
    const signature = await webhookSignature('secret', 1700000000, '{"a":1}');
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('1700000000.{"a":1}')),
    );
    const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(signature).toBe(`t=1700000000,v1=${hex}`);
  });

  it('refuses non-https and private hosts', () => {
    expect(webhookUrlProblem('http://example.com')).not.toBeNull();
    expect(webhookUrlProblem('https://user:pw@example.com')).not.toBeNull();
    expect(webhookUrlProblem('https://172.20.0.1/x')).not.toBeNull();
    expect(webhookUrlProblem('https://[fd00::1]/x')).not.toBeNull();
    expect(webhookUrlProblem('https://example.com/x')).toBeNull();
  });
});
