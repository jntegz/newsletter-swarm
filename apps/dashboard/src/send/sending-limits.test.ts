import { NO_SENDING_LIMITS, type SendWait } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  continuesAt,
  presetsFor,
  readDraft,
  toDraft,
  usageLine,
  waitCopy,
  waitNeed,
} from './sending-limits';

const now = Date.UTC(2026, 10, 16, 18);
const midnight = new Date(Date.UTC(2026, 10, 17)).toISOString();
const december = new Date(Date.UTC(2026, 11, 1)).toISOString();
const wait = (over: Partial<SendWait>): SendWait => ({
  reason: 'day',
  since: new Date(now - 3_600_000).toISOString(),
  until: midnight,
  left: 1240,
  detail: null,
  ...over,
});

describe('a waiting send', () => {
  it('says what it waits for, who is left and when it continues', () => {
    expect(waitCopy(wait({ reason: 'service_day' }), now).line).toBe(
      'Waiting for your email service’s daily limit: 1,240 left, continues at 00:00 UTC.',
    );
    expect(waitCopy(wait({}), now)).toMatchObject({
      line: 'Waiting for your email service’s daily limit: 1,240 left, continues at 00:00 UTC.',
      paused: false,
    });
    expect(waitCopy(wait({ reason: 'month', until: december }), now)).toMatchObject({
      line: 'Paused for your email service’s monthly limit: 1,240 left, continues on 1 December at 00:00 UTC.',
      paused: true,
    });
  });

  it('says a send held for its share of the capacity is waiting, and that nothing needs fixing', () => {
    const soon = new Date(now + 60_000).toISOString();
    expect(waitCopy(wait({ reason: 'share', until: soon }), now)).toMatchObject({
      line: 'Waiting for capacity: 1,240 left, asks again at 18:01 UTC.',
      detail: expect.stringMatching(
        /Other publications on this Swarm are sending too.*nothing needs fixing/,
      ),
      paused: false,
    });
  });

  it('asks a person to resume a send the email service stopped, and quotes it', () => {
    const copy = waitCopy(
      wait({
        reason: 'service_stopped',
        until: null,
        detail: 'invalid_api_key: API key is invalid',
      }),
      now,
    );
    expect(copy.line).toBe('Paused: your email service stopped accepting mail. 1,240 left.');
    expect(copy.detail).toMatch(/resume sending\. It said: invalid_api_key: API key is invalid$/);
    expect(copy.paused).toBe(true);
  });

  it('says Swarm tries a stopped email service again by itself, and when the send ends', () => {
    const since = new Date(Date.UTC(2026, 10, 16, 10)).toISOString();
    const stopped = wait({ reason: 'service_stopped', since, until: null });
    expect(waitCopy(stopped, now).detail).toMatch(
      /^Nobody was dropped\. Swarm tries the email service again by itself, less often as time goes on, and sends the rest once it takes mail\. If it still refuses mail on 23 November at 10:00 UTC, the send ends/,
    );
    expect(waitNeed('Issue 9', stopped, now).detail).toBe(
      '1,240 still to send. Swarm tries again by itself until 23 November at 10:00 UTC. Fix the email service, then resume sending from the send report.',
    );
  });

  it('tells Home while it lasts', () => {
    expect(waitNeed('Issue 9', wait({ reason: 'service_day' }), now)).toEqual({
      title: '“Issue 9” is waiting for your email service’s daily limit.',
      detail: '1,240 still to send. It continues at 00:00 UTC by itself.',
    });
    expect(waitNeed('', wait({ reason: 'service_stopped', until: null }), now).title).toBe(
      'An untitled post is paused: your email service stopped accepting mail.',
    );
  });

  it('writes times in UTC', () => {
    expect(continuesAt(new Date(Date.UTC(2026, 10, 16, 19)).toISOString(), now)).toBe(
      'at 19:00 UTC',
    );
  });
});

describe('the limits form', () => {
  it('reads empty fields as no limit, and keeps what was saved', () => {
    expect(readDraft(toDraft(NO_SENDING_LIMITS))).toEqual({
      limits: NO_SENDING_LIMITS,
      errors: null,
    });
    const limits = { perSecond: 0.5, perHour: null, perDay: 100, perMonth: 3000 };
    expect(readDraft(toDraft(limits))).toEqual({ limits, errors: null });
    expect(
      readDraft({ perSecond: '', perHour: '', perDay: '1,000', perMonth: '' }).limits?.perDay,
    ).toBe(1000);
  });

  it('says what is wrong with each field, as the server would', () => {
    const { errors } = readDraft({
      perSecond: '0.25',
      perHour: '500',
      perDay: '100',
      perMonth: 'x',
    });
    expect(errors).toEqual({
      perSecond: 'Use at most one decimal, such as 0.5 or 2.',
      perHour: 'An hour can’t allow more than the whole day.',
      perMonth: 'Enter a number, or leave it empty for no limit.',
    });
    expect(readDraft({ perSecond: '', perHour: '', perDay: '5', perMonth: '' }).errors).toEqual({
      perDay: 'Between 10 and 100,000,000.',
    });
  });

  it('offers the service’s plans, and an SES account’s own limits first', () => {
    expect(presetsFor({ service: 'resend', ses: null }).map((p) => p.key)).toEqual([
      'resend_free',
      'resend_paid',
    ]);
    const ses = presetsFor({
      service: 'ses',
      ses: {
        productionAccess: true,
        sendingEnabled: true,
        max24HourSend: 50000,
        maxSendRate: 14,
        sentLast24Hours: 120,
      },
    });
    expect(ses[0]).toEqual({
      key: 'ses_account',
      label: 'Your AWS account’s limits: 14 a second, 50,000 a day',
      limits: { perSecond: 14, perHour: null, perDay: 50000, perMonth: null },
    });
    expect(ses.map((p) => p.key)).toContain('ses_sandbox');
    expect(presetsFor({ service: 'smtp', ses: null })).toEqual([]);
  });

  it('shows today’s use against a limit', () => {
    expect(usageLine({ used: 412, limit: 100, forSends: 90, resetsAt: midnight }, now)).toBe(
      '412 of 100 · 90 for posts and automations · resets at 00:00 UTC',
    );
    expect(usageLine({ used: 7, limit: null, forSends: null, resetsAt: midnight }, now)).toBe(
      '7 sent · no limit · resets at 00:00 UTC',
    );
  });
});
