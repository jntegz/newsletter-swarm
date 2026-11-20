import type { InstanceMail } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  changeSteps,
  changeSummary,
  countMissing,
  mailNotices,
  serviceGuides,
} from './email-service';

const healthy: InstanceMail = {
  service: 'resend',
  region: 'eu-west-1',
  domain: 'mail.example.com',
  records: [],
  recordsComplete: true,
  feedback: { state: 'ok', sent: 100, reported: 90 },
  ses: null,
  change: null,
  checkedAt: '2026-11-04T00:00:00.000Z',
};
const ses = {
  productionAccess: true,
  sendingEnabled: true,
  max24HourSend: 50_000,
  maxSendRate: 14,
  sentLast24Hours: 10,
};

describe('the guides for changing service', () => {
  it('leaves out the service in use, and any development one', () => {
    const offered = serviceGuides('mail.example.com', 'resend').map((guide) => guide.service);
    expect(offered).toEqual(['ses', 'mailgun', 'postmark', 'smtp']);
    expect(serviceGuides('mail.example.com', 'dev').map((guide) => guide.service)).toHaveLength(5);
  });

  it('names records for the actual domain', () => {
    for (const guide of serviceGuides('mail.example.com', 'dev')) {
      expect(guide.records.length, guide.service).toBeGreaterThan(1);
      for (const record of guide.records) {
        expect(record.name, guide.service).toMatch(/mail\.example\.com$/);
      }
      expect(guide.records.at(-1)?.name, guide.service).toBe('_dmarc.mail.example.com');
    }
  });

  it('puts the bounce records where the adapters do', () => {
    const [sesGuide] = serviceGuides('mail.example.com', 'dev');
    expect(sesGuide?.records.filter((r) => r.name === 'bounce.mail.example.com')).toHaveLength(2);
  });
});

describe('explaining a change', () => {
  it('names the command for the chosen service', () => {
    expect(changeSteps('mailgun')[0]).toContain('pnpm swarm mail switch mailgun');
  });

  it('says the old service is still sending until the move', () => {
    expect(
      changeSummary({
        from: 'resend',
        to: 'ses',
        state: 'prepared',
        startedAt: '2026-11-04T00:00:00.000Z',
        drainUntil: null,
      }),
    ).toMatch(/Moving from Resend to Amazon SES\. Resend is still sending/);
  });

  it('says how long the old service’s reports keep coming after it', () => {
    expect(
      changeSummary({
        from: 'resend',
        to: 'ses',
        state: 'cut_over',
        startedAt: '2026-11-04T00:00:00.000Z',
        drainUntil: '2026-11-18T00:00:00.000Z',
      }),
    ).toMatch(/Email now goes through Amazon SES.*until 2026-11-18/);
  });
});

describe('what the page warns about', () => {
  it('stays quiet when all is well', () => {
    expect(mailNotices(healthy)).toEqual([]);
    expect(mailNotices({ ...healthy, service: 'ses', ses })).toEqual([]);
  });

  it('says so when reports have stopped, naming the service', () => {
    const [notice] = mailNotices({
      ...healthy,
      feedback: { state: 'silent', sent: 40, reported: 0 },
    });
    expect(notice?.tone).toBe('warn');
    expect(notice?.text).toMatch(/Resend hasn’t reported back on the last 40/);
  });

  it('does not treat having sent nothing yet as a problem', () => {
    expect(
      mailNotices({ ...healthy, feedback: { state: 'no_data', sent: 0, reported: 0 } }),
    ).toEqual([]);
  });

  it('explains the SES sandbox, and a paused account before it', () => {
    const notices = mailNotices({
      ...healthy,
      service: 'ses',
      ses: { ...ses, productionAccess: false, sendingEnabled: false },
    });
    expect(notices[0]?.text).toMatch(/paused sending/);
    expect(notices[1]?.text).toMatch(/sandbox/);
  });

  it('does not claim a sandbox when the SES account could not be read', () => {
    expect(mailNotices({ ...healthy, service: 'ses', ses: null })).toEqual([]);
  });

  it('says when the service could not be asked for its records', () => {
    expect(mailNotices({ ...healthy, recordsComplete: false })[0]?.text).toMatch(
      /couldn’t ask Resend/,
    );
  });
});

describe('counting records to fix', () => {
  const record = (state: InstanceMail['records'][number]['state']) => ({
    purpose: 'dkim' as const,
    type: 'TXT' as const,
    name: 'x',
    value: 'y',
    state,
    found: [],
  });

  it('counts what needs fixing, and not a check that could not finish', () => {
    expect(
      countMissing({
        ...healthy,
        records: [
          record('ok'),
          record('missing'),
          record('different'),
          record('conflict'),
          record('unknown'),
        ],
      }),
    ).toBe(3);
  });
});
