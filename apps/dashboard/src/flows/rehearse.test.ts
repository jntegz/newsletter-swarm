import type { FlowRehearsal, FlowRehearsalStep } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  addButtonText,
  conditionSentence,
  endSentence,
  enteringSentence,
  entrySentences,
  holdSentence,
  skippedSentence,
  stepSentences,
} from './rehearse';

const NOW = Date.UTC(2026, 10, 2, 23, 0, 0);
const step = (detail: FlowRehearsalStep['detail'], over: Partial<FlowRehearsalStep> = {}) =>
  ({
    nodeId: 'n',
    type: 'send_email',
    status: 'done',
    outcome: 'default',
    at: new Date(NOW).toISOString(),
    detail,
    ...over,
  }) as FlowRehearsalStep;

describe('rehearsal sentences', () => {
  it('says why a branch went its way', () => {
    expect(
      stepSentences(
        step(
          {
            kind: 'branch',
            matched: false,
            because: [{ field: 'opened_days', cmp: 'within_days', value: 30, holds: false }],
          },
          { outcome: 'false' },
        ),
        {},
        NOW,
      ),
    ).toEqual(['Took No.', 'They haven’t opened an email in the last 30 days.']);
    expect(conditionSentence({ field: 'tag', cmp: 'eq', value: 'red', holds: true })).toBe(
      'They have the tag “red”.',
    );
  });

  it('shows the inbox rule that holds an email, then the email', () => {
    const holds = [
      {
        reason: 'quiet_hours' as const,
        until: '2026-11-03T08:00:00.000Z',
        expired: false,
        zone: 'UTC',
      },
    ];
    expect(
      stepSentences(
        step({ kind: 'email', state: 'would_send', subject: 'Hello', previewText: '', holds }),
        {},
        NOW,
      ),
    ).toEqual(['Held: quiet hours until Tue 3 Nov, 08:00.', 'Would send “Hello”.']);
  });

  it('says when a wait is too long', () => {
    expect(
      holdSentence(
        {
          reason: 'weekly_limit',
          until: '2026-11-03T08:00:00.000Z',
          expired: true,
          zone: 'UTC',
        },
        NOW,
      ),
    ).toContain('so this email is not sent');
  });

  it('says what it can’t know about a paused publication', () => {
    expect(
      holdSentence({ reason: 'channel_paused', until: null, expired: false, zone: null }, NOW),
    ).toContain('can’t know when it comes back');
  });

  it('words a wait by the answer it assumed', () => {
    const wait = {
      kind: 'wait' as const,
      event: 'open' as const,
      url: null,
      until: '2026-11-04T08:00:00.000Z',
      basis: 'assumed' as const,
    };
    expect(stepSentences(step({ ...wait, answer: 'yes' }), {}, NOW)).toEqual([
      'If they open the email, they go on at once.',
    ]);
    expect(stepSentences(step({ ...wait, answer: 'no' }), {}, NOW)[0]).toContain(
      'If they don’t open the email, the wait ends on',
    );
    expect(stepSentences(step({ ...wait, basis: 'no_email', answer: 'no' }), {}, NOW)[0]).toContain(
      'No email reached them',
    );
  });

  it('says how it ends and whether they would enter', () => {
    expect(endSentence({ status: 'completed', reason: null, problem: null })).toBe(
      'They finish the automation.',
    );
    expect(endSentence({ status: 'exited', reason: 'hold_expired', problem: null })).toContain(
      'Held too long',
    );
    const rehearsal = {
      entry: { allowed: false, startEvent: null, reason: 'already_in' },
    } as FlowRehearsal;
    expect(entrySentences(rehearsal, 'live')).toEqual([
      'They wouldn’t enter now: they are already in this automation.',
      'Here is what would happen if they did.',
    ]);
    expect(entrySentences(rehearsal, 'draft')[0]).toContain('isn’t live');
  });
});

describe('Add people sentences', () => {
  it('names the number', () => {
    expect(addButtonText(1)).toBe('Add 1 subscriber');
    expect(addButtonText(1200)).toBe('Add 1,200 subscribers');
    expect(enteringSentence(0)).toBe('Nobody in this selection can enter.');
    expect(enteringSentence(2)).toBe('2 subscribers would enter now.');
  });

  it('says why people are left out, singular and plural', () => {
    expect(skippedSentence('unsubscribed', 1)).toBe('1 has unsubscribed.');
    expect(skippedSentence('unsubscribed', 3)).toBe('3 have unsubscribed.');
    expect(skippedSentence('suppressed', 2)).toBe('2 are on the do-not-send list.');
    expect(skippedSentence('already_in', 1)).toBe('1 is already in this automation.');
  });
});
