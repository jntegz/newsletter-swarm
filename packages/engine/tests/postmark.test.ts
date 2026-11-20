import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MailEnvFields,
  checkMailEnv,
  dedicatedSending,
  domainIdentities,
  mailAdapter,
  suppressionList,
  type MailEnv,
} from '../src/adapters';
import { postmarkToSesEvent, postmarkUnsubscribedDelivery } from '../src/feedback';
import { verifyPostmarkAuth } from '../src/postmark-webhook';

const SECRET = 'test-only-postmark-webhook-secret';
const basic = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`;

describe('verifyPostmarkAuth', () => {
  it('accepts the password, whatever the username', async () => {
    expect(await verifyPostmarkAuth(basic('swarm', SECRET), SECRET)).toBe(true);
    expect(await verifyPostmarkAuth(basic('other', SECRET), SECRET)).toBe(true);
  });

  it('refuses everything else', async () => {
    for (const header of [
      undefined,
      null,
      '',
      'Bearer abc',
      'Basic !!!',
      `Basic ${btoa('no-colon')}`,
      basic('swarm', 'wrong'),
      basic('swarm', ''),
      basic('swarm', `${SECRET}x`),
      basic(SECRET, 'wrong'),
    ]) {
      expect(await verifyPostmarkAuth(header, SECRET)).toBe(false);
    }
  });
});

const meta = { Metadata: { delivery: 'dl_0192', channel: 'ch_1' }, MessageID: 'pm-1' };

describe('postmarkToSesEvent', () => {
  it('maps a delivery', () => {
    expect(
      postmarkToSesEvent({
        RecordType: 'Delivery',
        Recipient: 'reader@example.org',
        DeliveredAt: '2026-11-04T10:00:00Z',
        ...meta,
      }),
    ).toEqual({
      eventType: 'Delivery',
      mail: { messageId: 'pm-1', tags: { delivery: ['dl_0192'], channel: ['ch_1'] } },
      delivery: { timestamp: '2026-11-04T10:00:00Z' },
    });
  });

  const bounce = (fields: Record<string, unknown>) =>
    postmarkToSesEvent({
      RecordType: 'Bounce',
      Email: 'reader@example.org',
      Details: '550 no such user',
      Description: 'The server was unable to deliver',
      ...meta,
      ...fields,
    });

  it('maps a hard bounce with its details', () => {
    expect(bounce({ Type: 'HardBounce', TypeCode: 1, Inactive: true })).toMatchObject({
      eventType: 'Bounce',
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'HardBounce',
        bouncedRecipients: [
          { emailAddress: 'reader@example.org', diagnosticCode: '550 no such user' },
        ],
      },
    });
  });

  it('counts a bad address, or any bounce that deactivated it, as permanent', () => {
    const type = (fields: Record<string, unknown>) => bounce(fields)?.bounce?.bounceType;
    expect(type({ Type: 'BadEmailAddress' })).toBe('Permanent');
    expect(type({ Type: 'Blocked', Inactive: true })).toBe('Permanent');
  });

  it('counts other bounces as temporary', () => {
    const type = (fields: Record<string, unknown>) => bounce(fields)?.bounce?.bounceType;
    for (const kind of ['Transient', 'SoftBounce', 'DnsError', 'Blocked']) {
      expect(type({ Type: kind, Inactive: false })).toBe('Transient');
    }
  });

  it('maps a spam complaint, in either form', () => {
    for (const payload of [
      { RecordType: 'SpamComplaint', Type: 'SpamComplaint' },
      { RecordType: 'Bounce', Type: 'SpamComplaint' },
    ]) {
      expect(
        postmarkToSesEvent({ ...payload, Email: 'reader@example.org', ...meta }),
      ).toMatchObject({
        eventType: 'Complaint',
        complaint: { complainedRecipients: [{ emailAddress: 'reader@example.org' }] },
      });
    }
  });

  it('ignores other records and bad input', () => {
    for (const RecordType of ['Open', 'Click', 'SubscriptionChange']) {
      expect(postmarkToSesEvent({ RecordType, ...meta })).toBeNull();
    }
    expect(postmarkToSesEvent(null)).toBeNull();
    expect(postmarkToSesEvent({})).toBeNull();
  });
});

describe('postmarkUnsubscribedDelivery', () => {
  const delivery = `dl_${'a'.repeat(32)}`;
  const change = (fields: Record<string, unknown> = {}) => ({
    RecordType: 'SubscriptionChange',
    SuppressSending: true,
    SuppressionReason: 'ManualSuppression',
    Origin: 'Recipient',
    Metadata: { delivery },
    ...fields,
  });

  it('finds the delivery when a reader unsubscribed', () => {
    expect(postmarkUnsubscribedDelivery(change())).toBe(delivery);
  });

  it('ignores every other change', () => {
    for (const fields of [
      { RecordType: 'Bounce' },
      { SuppressSending: false },
      { SuppressionReason: 'HardBounce' },
      { SuppressionReason: 'SpamComplaint' },
      { Origin: 'Customer' },
      { Origin: 'Admin' },
      { Metadata: {} },
      { Metadata: { delivery: 'not-a-delivery' } },
    ]) {
      expect(postmarkUnsubscribedDelivery(change(fields))).toBeNull();
    }
    expect(postmarkUnsubscribedDelivery(null)).toBeNull();
  });
});

describe('MAIL_ADAPTER=postmark', () => {
  const schema = z
    .object({ ENVIRONMENT: z.string(), ...MailEnvFields })
    .superRefine((value, ctx) => checkMailEnv(value as MailEnv, ctx));
  const base = {
    ENVIRONMENT: 'production',
    MAIL_ADAPTER: 'postmark',
    AWS_REGION: 'us-east-1',
    POSTMARK_SERVER_TOKEN: 'test-only-server-token',
    POSTMARK_ACCOUNT_TOKEN: 'test-only-account-token',
  };
  const paths = (input: Record<string, unknown>) => {
    const result = schema.safeParse(input);
    return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
  };

  it('needs both tokens', () => {
    expect(paths(base)).toEqual([]);
    expect(paths({ ...base, POSTMARK_SERVER_TOKEN: undefined })).toEqual(['POSTMARK_SERVER_TOKEN']);
    expect(paths({ ...base, POSTMARK_ACCOUNT_TOKEN: undefined })).toEqual([
      'POSTMARK_ACCOUNT_TOKEN',
    ]);
  });

  it('sends and manages domains through Postmark, with no SES-only features', () => {
    const env = base as MailEnv;
    expect(mailAdapter(env, 'm.test').constructor.name).toBe('PostmarkMail');
    expect(domainIdentities(env).constructor.name).toBe('PostmarkClient');
    expect(dedicatedSending(env)).toBeNull();
    expect(suppressionList(env)).toBeNull();
  });
});
