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
import { mailgunToSesEvent } from '../src/feedback';
import { mailgunSignature, verifyMailgunSignature } from '../src/mailgun-webhook';

const KEY = 'test-only-mailgun-signing-key';
const NOW = 1_770_000_000_000;
const stamp = String(NOW / 1000);

const signed = async (key = KEY, timestamp = stamp, token = 'tok-1') => ({
  timestamp,
  token,
  signature: await mailgunSignature(key, timestamp, token),
});

describe('Mailgun signatures', () => {
  it('accepts its own signature, with the timestamp as a string or a number', async () => {
    const good = await signed();
    expect(await verifyMailgunSignature(KEY, good, NOW)).toEqual({ ok: true, token: 'tok-1' });
    expect(await verifyMailgunSignature(KEY, { ...good, timestamp: NOW / 1000 }, NOW)).toEqual({
      ok: true,
      token: 'tok-1',
    });
  });

  it('matches the documented algorithm: hex HMAC-SHA256 of timestamp + token', async () => {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(KEY),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${stamp}tok-1`));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(await mailgunSignature(KEY, stamp, 'tok-1')).toBe(hex);
  });

  it('refuses a wrong key, a changed token and an old timestamp', async () => {
    expect(await verifyMailgunSignature('another-key-another-key', await signed(), NOW)).toEqual({
      ok: false,
      reason: 'signature',
    });
    expect(await verifyMailgunSignature(KEY, { ...(await signed()), token: 'tok-2' }, NOW)).toEqual(
      { ok: false, reason: 'signature' },
    );
    const old = String(NOW / 1000 - 25 * 60 * 60);
    expect(await verifyMailgunSignature(KEY, await signed(KEY, old), NOW)).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('still accepts a retry from hours ago', async () => {
    const eightHours = String(NOW / 1000 - 8 * 60 * 60);
    expect((await verifyMailgunSignature(KEY, await signed(KEY, eightHours), NOW)).ok).toBe(true);
  });

  it('calls anything else malformed', async () => {
    for (const value of [
      undefined,
      null,
      'text',
      {},
      { timestamp: 'soon', token: 't', signature: 'a'.repeat(64) },
      { timestamp: stamp, token: '', signature: 'a'.repeat(64) },
      { timestamp: stamp, token: 't', signature: 'short' },
    ]) {
      expect(await verifyMailgunSignature(KEY, value, NOW)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });
});

const event = (fields: Record<string, unknown>) => ({
  id: 'ev1',
  timestamp: 1770918175.5,
  recipient: 'reader@example.org',
  message: { headers: { 'message-id': 'm1@mg.example' } },
  'user-variables': { delivery: 'dl_0192', channel: 'ch_1' },
  ...fields,
});

describe('mailgunToSesEvent', () => {
  it('maps a delivery, with the variables as tags', () => {
    expect(mailgunToSesEvent(event({ event: 'delivered' }))).toEqual({
      eventType: 'Delivery',
      mail: {
        messageId: 'm1@mg.example',
        tags: { delivery: ['dl_0192'], channel: ['ch_1'] },
        destination: ['reader@example.org'],
      },
      delivery: { timestamp: new Date(1770918175500).toISOString() },
    });
  });

  it('maps a permanent failure from the documented example', () => {
    const mapped = mailgunToSesEvent(
      event({
        event: 'failed',
        severity: 'permanent',
        reason: 'bounce',
        'delivery-status': { code: 550, message: '5.5.0 mailbox unavailable', description: null },
      }),
    );
    expect(mapped).toMatchObject({
      eventType: 'Bounce',
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'bounce',
        bouncedRecipients: [
          { emailAddress: 'reader@example.org', diagnosticCode: '5.5.0 mailbox unavailable' },
        ],
      },
    });
  });

  it('reads both names for a failure, and keeps a temporary one soft', () => {
    const bounceType = (fields: Record<string, unknown>) =>
      mailgunToSesEvent(event(fields))?.bounce?.bounceType;
    expect(bounceType({ event: 'failed', severity: 'temporary' })).toBe('Transient');
    expect(bounceType({ event: 'temporary_fail' })).toBe('Transient');
    expect(bounceType({ event: 'permanent_fail' })).toBe('Permanent');
    expect(bounceType({ event: 'failed' })).toBe('Undetermined');
  });

  it('maps a complaint', () => {
    expect(mailgunToSesEvent(event({ event: 'complained' }))).toMatchObject({
      eventType: 'Complaint',
      complaint: { complainedRecipients: [{ emailAddress: 'reader@example.org' }] },
    });
  });

  it('handles empty variables, which Mailgun sends as an array', () => {
    expect(mailgunToSesEvent(event({ event: 'delivered', 'user-variables': [] }))?.mail).toEqual({
      messageId: 'm1@mg.example',
      tags: {},
      destination: ['reader@example.org'],
    });
  });

  it('ignores other events and bad input', () => {
    for (const type of ['accepted', 'opened', 'clicked', 'unsubscribed']) {
      expect(mailgunToSesEvent(event({ event: type }))).toBeNull();
    }
    expect(mailgunToSesEvent(null)).toBeNull();
    expect(mailgunToSesEvent({})).toBeNull();
  });
});

describe('MAIL_ADAPTER=mailgun', () => {
  const schema = z
    .object({ ENVIRONMENT: z.string(), ...MailEnvFields })
    .superRefine((value, ctx) => checkMailEnv(value as MailEnv, ctx));
  const base = {
    ENVIRONMENT: 'production',
    MAIL_ADAPTER: 'mailgun',
    AWS_REGION: 'us-east-1',
    MAILGUN_API_KEY: 'test-only-mailgun-key',
    MAILGUN_REGION: 'eu',
  };
  const paths = (input: Record<string, unknown>) => {
    const result = schema.safeParse(input);
    return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
  };

  it('needs the key and the region', () => {
    expect(paths(base)).toEqual([]);
    expect(paths({ ...base, MAILGUN_API_KEY: undefined })).toEqual(['MAILGUN_API_KEY']);
    expect(paths({ ...base, MAILGUN_REGION: undefined })).toEqual(['MAILGUN_REGION']);
    expect(paths({ ...base, MAILGUN_REGION: 'asia' })).toEqual(['MAILGUN_REGION']);
  });

  it('sends and manages domains through Mailgun, with no SES-only features', () => {
    const env = base as MailEnv;
    expect(mailAdapter(env, 'm.test').constructor.name).toBe('MailgunMail');
    expect(domainIdentities(env).constructor.name).toBe('MailgunClient');
    expect(dedicatedSending(env)).toBeNull();
    expect(suppressionList(env)).toBeNull();
  });
});
