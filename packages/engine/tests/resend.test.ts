import { DevMailbox, ResendError, ResendMail, SesError, SesMail } from '@swarm/mail';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DedicatedEnvFields,
  MailEnvFields,
  checkDedicatedEnv,
  checkMailEnv,
  classifySendError,
  dedicatedSending,
  domainIdentities,
  mailAdapter,
  resendTags,
  resendToSesEvent,
  suppressionList,
  svixSignature,
  verifySvix,
  type MailEnv,
} from '../src/index';

// ---- Svix -------------------------------------------------------------------------------------

const SECRET = `whsec_${btoa('a test signing key of some length!')}`;
const OTHER = `whsec_${btoa('another signing key entirely......')}`;

describe('verifySvix', () => {
  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'em_1' } });
  const now = 1_790_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const headers = async (secret = SECRET, timestamp = ts, extra = '') => ({
    id: 'msg_1',
    timestamp,
    signature: `${extra}v1,${await svixSignature(secret, 'msg_1', timestamp, body)}`,
  });

  it('accepts a valid signature', async () => {
    expect(await verifySvix(SECRET, await headers(), body, now)).toEqual({ ok: true });
  });

  it('accepts any one of several signatures (secret rotation)', async () => {
    const other = await svixSignature(OTHER, 'msg_1', ts, body);
    expect(
      await verifySvix(SECRET, await headers(SECRET, ts, `v1,${other} v2,abc `), body, now),
    ).toEqual({ ok: true });
  });

  it('rejects the wrong secret', async () => {
    expect(await verifySvix(SECRET, await headers(OTHER), body, now)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('rejects stale and future timestamps', async () => {
    const old = String(Math.floor(now / 1000) - 301);
    expect(await verifySvix(SECRET, await headers(SECRET, old), body, now)).toEqual({
      ok: false,
      reason: 'stale',
    });
    const future = String(Math.floor(now / 1000) + 301);
    expect(await verifySvix(SECRET, await headers(SECRET, future), body, now)).toMatchObject({
      ok: false,
    });
  });

  it('rejects a tampered body or id', async () => {
    const signed = await headers();
    expect(await verifySvix(SECRET, signed, body.replace('em_1', 'em_2'), now)).toMatchObject({
      ok: false,
      reason: 'signature',
    });
    expect(await verifySvix(SECRET, { ...signed, id: 'msg_2' }, body, now)).toMatchObject({
      ok: false,
    });
  });

  it('rejects missing headers', async () => {
    expect(
      await verifySvix(SECRET, { id: 'msg_1', timestamp: ts, signature: null }, body, now),
    ).toEqual({ ok: false, reason: 'malformed' });
  });
});

// ---- Adapters ---------------------------------------------------------------------------------

const schema = z
  .object({ ENVIRONMENT: z.string(), ...MailEnvFields, ...DedicatedEnvFields })
  .superRefine((env, ctx) => {
    checkMailEnv(env, ctx);
    checkDedicatedEnv(env, ctx);
  });
const paths = (input: Record<string, unknown>) => {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
};

describe('mail env rules', () => {
  const resend = {
    ENVIRONMENT: 'production',
    MAIL_ADAPTER: 'resend',
    AWS_REGION: 'eu-west-1',
    RESEND_API_KEY: 're_123456789_abcdef',
  };

  it('accepts Resend with a key and a Resend region, no AWS keys or topic', () => {
    expect(paths(resend)).toEqual([]);
  });

  it('requires the key, the re_ prefix and a Resend region', () => {
    expect(paths({ ...resend, RESEND_API_KEY: undefined })).toEqual(['RESEND_API_KEY']);
    expect(paths({ ...resend, RESEND_API_KEY: 'sk_live_123456789' })).toEqual(['RESEND_API_KEY']);
    expect(paths({ ...resend, AWS_REGION: 'us-west-2' })).toEqual(['AWS_REGION']);
  });

  it('keeps the SES rules', () => {
    expect(
      paths({ ENVIRONMENT: 'production', MAIL_ADAPTER: 'ses', AWS_REGION: 'eu-west-1' }).sort(),
    ).toEqual(
      [
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'SES_CONFIGURATION_SET',
        'SES_EVENT_TOPIC_ARN',
      ].sort(),
    );
    expect(paths({ ...resend, MAIL_ADAPTER: 'dev' })).toContain('MAIL_ADAPTER');
  });

  it('picks Resend for mail and domains, and no dedicated sending', () => {
    const env = schema.parse(resend) as MailEnv;
    const adapter = mailAdapter(env, 'mail.swarm.test');
    expect(adapter).toBeInstanceOf(ResendMail);
    expect(adapter.maxConcurrency).toBeLessThan(10);
    expect(domainIdentities(env).constructor.name).toBe('ResendClient');
    expect(dedicatedSending(env)).toBeNull();
    expect(suppressionList(env)).toBeNull();
  });

  it('still picks SES and the dev fakes', () => {
    const ses = {
      ENVIRONMENT: 'production',
      MAIL_ADAPTER: 'ses' as const,
      AWS_REGION: 'eu-west-1',
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 's'.repeat(40),
      SES_CONFIGURATION_SET: 'x',
    };
    expect(mailAdapter(ses, 'm.example')).toBeInstanceOf(SesMail);
    expect(dedicatedSending(ses)).not.toBeNull();
    expect(suppressionList(ses)).not.toBeNull();
    const dev = {
      ENVIRONMENT: 'test',
      MAIL_ADAPTER: 'dev' as const,
      AWS_REGION: 'us-east-1',
      DEV_MAILBOX: {} as R2Bucket,
    };
    expect(mailAdapter(dev, 'm.example')).toBeInstanceOf(DevMailbox);
    expect(dedicatedSending(dev)).not.toBeNull();
    expect(suppressionList(dev)).not.toBeNull();
  });
});

// ---- Pipeline classification ------------------------------------------------------------------

describe('classifySendError', () => {
  it('SES: halting codes stop, throttling retries, rejections fail', () => {
    expect(classifySendError(new SesError(400, 'AccountSuspendedException', 'x')).kind).toBe(
      'halt',
    );
    expect(classifySendError(new SesError(429, 'TooManyRequestsException', 'x'))).toMatchObject({
      kind: 'retry',
    });
    expect(classifySendError(new SesError(400, 'MessageRejected', 'x')).kind).toBe('failed');
  });

  it('SES: a used-up daily quota waits for it', () => {
    expect(
      classifySendError(
        new SesError(400, 'LimitExceededException', 'Daily message quota exceeded.'),
      ),
    ).toMatchObject({ kind: 'quota', quota: 'day' });
  });

  it('Resend: quotas wait, auth halts, rate limits retry with Retry-After, validation fails', () => {
    expect(classifySendError(new ResendError(429, 'daily_quota_exceeded', 'x'))).toEqual({
      kind: 'quota',
      quota: 'day',
      error: 'daily_quota_exceeded: x',
    });
    expect(classifySendError(new ResendError(429, 'monthly_quota_exceeded', 'x'))).toMatchObject({
      kind: 'quota',
      quota: 'month',
    });
    expect(classifySendError(new ResendError(403, 'validation_error', 'domain')).kind).toBe('halt');
    expect(classifySendError(new ResendError(401, 'missing_api_key', 'x')).kind).toBe('halt');
    expect(classifySendError(new ResendError(429, 'rate_limit_exceeded', 'x', 12))).toEqual({
      kind: 'retry',
      error: 'x',
      retryAfterSeconds: 12,
    });
    expect(classifySendError(new ResendError(503, 'internal_server_error', 'x')).kind).toBe(
      'retry',
    );
    expect(classifySendError(new ResendError(422, 'validation_error', 'bad to'))).toEqual({
      kind: 'failed',
      error: 'validation_error: bad to',
    });
  });

  it('anything else (a network error) is retried', () => {
    expect(classifySendError(new TypeError('fetch failed')).kind).toBe('retry');
  });
});

// ---- Resend webhooks --------------------------------------------------------------------------

const base = (type: string, data: Record<string, unknown>) => ({
  type,
  created_at: '2026-11-01T10:00:00.000Z',
  data: {
    email_id: 'em_123',
    created_at: '2026-11-01T09:59:00.000Z',
    from: 'Field Notes <notes@news.example>',
    to: ['reader@example.org'],
    subject: 'Hello',
    tags: { delivery: 'dl_0192f3c4d5e67f8091a2b3c4d5e6f708', channel: 'ch_1' },
    ...data,
  },
});

describe('resendToSesEvent', () => {
  it('maps a delivery, with tags as SES tag lists', () => {
    expect(resendToSesEvent(base('email.delivered', {}))).toEqual({
      eventType: 'Delivery',
      mail: {
        messageId: 'em_123',
        tags: { delivery: ['dl_0192f3c4d5e67f8091a2b3c4d5e6f708'], channel: ['ch_1'] },
      },
      delivery: { timestamp: '2026-11-01T09:59:00.000Z' },
    });
  });

  it('maps permanent, temporary and unknown bounces', () => {
    const permanent = resendToSesEvent(
      base('email.bounced', {
        bounce: { type: 'Permanent', subType: 'General', message: '550 no such user' },
      }),
    );
    expect(permanent).toMatchObject({
      eventType: 'Bounce',
      mail: { messageId: 'em_123' },
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        bouncedRecipients: [
          { emailAddress: 'reader@example.org', diagnosticCode: '550 no such user' },
        ],
      },
    });
    expect(
      resendToSesEvent(
        base('email.bounced', { bounce: { type: 'Temporary', subType: 'MailboxFull' } }),
      )?.bounce?.bounceType,
    ).toBe('Transient');
    expect(
      resendToSesEvent(base('email.bounced', { bounce: { type: 'Weird' } }))?.bounce?.bounceType,
    ).toBe('Undetermined');
    expect(
      resendToSesEvent(
        base('email.bounced', {
          bounce: { type: 'Permanent', diagnosticCode: ['smtp; 550 5.1.1'] },
        }),
      )?.bounce?.bouncedRecipients?.[0]?.diagnosticCode,
    ).toBe('smtp; 550 5.1.1');
  });

  it('maps a suppressed email as a permanent bounce', () => {
    expect(
      resendToSesEvent(
        base('email.suppressed', {
          suppressed: { type: 'OnAccountSuppressionList', message: 'on the list' },
        }),
      ),
    ).toMatchObject({
      eventType: 'Bounce',
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'Suppressed',
        bouncedRecipients: [{ emailAddress: 'reader@example.org', diagnosticCode: 'on the list' }],
      },
    });
  });

  it('maps a complaint', () => {
    expect(
      resendToSesEvent(base('email.complained', { to: ['Reader <Reader@Example.org>'] })),
    ).toEqual({
      eventType: 'Complaint',
      mail: expect.objectContaining({ messageId: 'em_123' }),
      complaint: { complainedRecipients: [{ emailAddress: 'Reader@Example.org' }] },
    });
  });

  it('ignores the rest', () => {
    for (const type of [
      'email.sent',
      'email.delivery_delayed',
      'email.opened',
      'email.clicked',
      'email.failed',
      'email.received',
      'domain.updated',
    ]) {
      expect(
        resendToSesEvent(base(type, { failed: { reason: 'reached_daily_quota' } })),
      ).toBeNull();
    }
    expect(resendToSesEvent(null)).toBeNull();
    expect(resendToSesEvent({ type: 'email.delivered' })).toBeNull();
  });

  it('reads tags as an object or an array', () => {
    expect(resendTags({ a: 'x', b: ['y', 'z'], c: 3, d: null })).toEqual({
      a: ['x'],
      b: ['y', 'z'],
      c: ['3'],
    });
    expect(
      resendTags([
        { name: 'delivery', value: 'dl_1' },
        { name: 'delivery', value: 'dl_2' },
        { nope: true },
      ]),
    ).toEqual({ delivery: ['dl_1', 'dl_2'] });
    expect(resendTags(undefined)).toEqual({});
  });

  it('keeps tags named like Object.prototype members as plain tags', () => {
    // Tag names come from the provider's payload; JSON.parse makes "__proto__" an own key.
    const tags = JSON.parse('{"constructor":"a","__proto__":"b","toString":"c"}') as unknown;
    expect({ ...resendTags(tags) }).toEqual({
      constructor: ['a'],
      ['__proto__']: ['b'],
      toString: ['c'],
    });
    expect(
      resendTags([
        { name: 'constructor', value: 'a' },
        { name: 'delivery', value: 'dl_1' },
      ]).delivery,
    ).toEqual(['dl_1']);
  });
});
