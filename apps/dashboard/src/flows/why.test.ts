import { FLOW_ENROL_DECISIONS, type MemberFlowHistory } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { whySentences } from './why';

const day = (iso: string) => iso.slice(0, 10);

const run = (over: Partial<NonNullable<MemberFlowHistory['run']>> = {}) => ({
  id: 'fr_1',
  version: 1,
  status: 'completed' as const,
  exitReason: null,
  startedBy: { index: 0, event: 'confirmed' as const, details: {} },
  emailsReceived: 3,
  emailsPossible: 3,
  startedAt: '2026-05-03T10:00:00.000Z',
  endedAt: '2026-05-09T10:00:00.000Z',
  ...over,
});

const item = (over: Partial<MemberFlowHistory> = {}): MemberFlowHistory => ({
  flowId: 'fl_1',
  flowName: 'Welcome',
  run: null,
  decision: null,
  ...over,
});

describe('whySentences', () => {
  it('tells the whole story of a run that stopped', () => {
    const sentences = whySentences(
      item({
        run: run({
          status: 'exited',
          exitReason: 'member_inactive',
          emailsReceived: 2,
          emailsPossible: 3,
        }),
      }),
      'unsubscribed',
      day,
    );
    expect(sentences).toEqual([
      'Entered Welcome on 2026-05-03.',
      'Start event: Confirmed opt-in.',
      'Got 2 of 3 emails.',
      'Stopped: unsubscribed.',
    ]);
  });

  it('says why they left in the words of their status', () => {
    const stopped = (status: Parameters<typeof whySentences>[1]) =>
      whySentences(
        item({ run: run({ status: 'exited', exitReason: 'member_inactive' }) }),
        status,
        day,
      ).at(-1);
    expect(stopped('bounced')).toBe('Stopped: their address bounced.');
    expect(stopped('complained')).toBe('Stopped: they marked an email as spam.');
    expect(stopped('active')).toBe('Stopped: they were not active at the time.');
  });

  it('says a run is still going, or finished', () => {
    expect(
      whySentences(item({ run: run({ status: 'waiting', endedAt: null }) }), 'active', day).at(-1),
    ).toBe('Still in this automation.');
    expect(whySentences(item({ run: run() }), 'active', day).at(-1)).toBe('Finished.');
  });

  it('handles one email and none', () => {
    const emails = (received: number, possible: number) =>
      whySentences(
        item({ run: run({ emailsReceived: received, emailsPossible: possible }) }),
        'active',
        day,
      );
    expect(emails(1, 1)).toContain('Got its one email.');
    expect(emails(0, 1)).toContain('Has not got its one email.');
    expect(emails(0, 0).join(' ')).not.toContain('email');
  });

  it('says who entered without a start event', () => {
    expect(whySentences(item({ run: run({ startedBy: null }) }), 'active', day)).toContain(
      'Added by a teammate, another automation or the API.',
    );
  });

  it('has a sentence for every reason a start event let nobody in', () => {
    const said = FLOW_ENROL_DECISIONS.map(
      (reason) =>
        whySentences(
          item({
            decision: {
              reason,
              version: 2,
              event: 'tag_added',
              decidedAt: '2026-06-01T00:00:00.000Z',
            },
          }),
          'active',
          day,
        )[0],
    );
    expect(said).toEqual([
      "Didn't enter Welcome on 2026-06-01: not in the segment.",
      "Didn't enter Welcome on 2026-06-01: did not match the rule.",
      'Skipped Welcome on 2026-06-01: already in this automation.',
      'Skipped Welcome on 2026-06-01: already went through this version.',
      'Skipped Welcome on 2026-06-01: already went through an earlier version.',
      'Skipped Welcome on 2026-06-01: started too many times in the last hour.',
    ]);
  });

  it('tells a later skip after the run it follows', () => {
    const sentences = whySentences(
      item({
        run: run(),
        decision: {
          reason: 'already_ran_version',
          version: 1,
          event: 'confirmed',
          decidedAt: '2026-06-01T00:00:00.000Z',
        },
      }),
      'active',
      day,
    );
    expect(sentences.at(-2)).toBe(
      'Skipped Welcome on 2026-06-01: already went through this version.',
    );
    expect(sentences[0]).toBe('Entered Welcome on 2026-05-03.');
  });

  it('is plain about having nothing on record', () => {
    expect(whySentences(item(), 'active', day)).toEqual([
      "Hasn't entered Welcome.",
      'No start event has been recorded for this subscriber.',
    ]);
  });
});
