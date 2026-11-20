import { parseKeyring } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import {
  bounceCode,
  classifyClick,
  classifyOpen,
  judge,
  lookupDmarc,
  parseDmarc,
  parseSnsMessage,
  readBounceCode,
  readTrackToken,
  readUnsubscribeCode,
  spkiFromPem,
  stringToSign,
  trackToken,
  uaFamily,
  unsubscribeCode,
  verifySnsMessage,
  type SnsMessage,
} from '../src/index';
import { cert, signingKey } from './fixtures/sns-test-keys';

const ring = parseKeyring(`k1:${'a'.repeat(40)}`);
const otherRing = parseKeyring(`k2:${'b'.repeat(40)}`);
const delivery = 'dl_0192f3c4d5e67f8091a2b3c4d5e6f708';
const link = 'lt_0192f3c4d5e67f8091a2b3c4d5e6f709';

describe('tracking tokens', () => {
  it('round-trips ids and never carries a URL', async () => {
    const token = await trackToken(ring, { d: delivery, l: link });
    expect(token).not.toMatch(/https?/);
    expect(await readTrackToken(ring, token)).toEqual({ d: delivery, l: link });
    expect(await readTrackToken(otherRing, token)).toBeNull();
    expect(await readTrackToken(ring, token.slice(0, -2) + 'xx')).toBeNull();
  });

  it('expires', async () => {
    const old = await trackToken(ring, { d: delivery }, Date.now() - 401 * 86_400_000);
    expect(await readTrackToken(ring, old)).toBeNull();
  });
});

describe('unsubscribe codes', () => {
  it('fit in a mailto local part and survive case folding', async () => {
    const code = await unsubscribeCode(ring, delivery);
    expect(`unsub+${code}`.length).toBeLessThanOrEqual(64);
    expect(code).toMatch(/^[0-9a-f]{32}-[0-9a-f]{20}$/);
    expect(await readUnsubscribeCode(ring, code.toUpperCase())).toBe(delivery);
  });

  it('reject forgeries and verify with a rotated-out key', async () => {
    const code = await unsubscribeCode(ring, delivery);
    expect(await readUnsubscribeCode(otherRing, code)).toBeNull();
    const forged = code.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    expect(await readUnsubscribeCode(ring, forged)).toBeNull();
    const rotated = parseKeyring(`k2:${'b'.repeat(40)},k1:${'a'.repeat(40)}`);
    expect(await readUnsubscribeCode(rotated, code)).toBe(delivery);
  });

  it('are not bounce codes, nor the other way round', async () => {
    const unsubscribe = await unsubscribeCode(ring, delivery);
    const bounce = await bounceCode(ring, delivery);
    expect(`bounce+${bounce}`.length).toBeLessThanOrEqual(64);
    expect(bounce).not.toBe(unsubscribe);
    expect(await readBounceCode(ring, bounce.toUpperCase())).toBe(delivery);
    expect(await readBounceCode(ring, unsubscribe)).toBeNull();
    expect(await readUnsubscribeCode(ring, bounce)).toBeNull();
  });
});

describe('bot classification', () => {
  const chrome =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  const base = { method: 'GET', userAgent: chrome, asn: 3320, asOrganization: 'Deutsche Telekom' };
  const later = { sentAt: 0, now: 60_000, clicksInLastSecond: 0 };

  it.each([
    ['a person in a browser', base, 'human'],
    [
      'Apple Mail Privacy Protection',
      { ...base, userAgent: 'Mozilla/5.0', asn: 714, asOrganization: 'Apple Inc.' },
      'machine_open',
    ],
    [
      'Gmail image proxy',
      {
        ...base,
        userAgent:
          'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)',
        asn: 15169,
      },
      'human',
    ],
    ['a HEAD request', { ...base, method: 'HEAD' }, 'bot'],
    ['no user agent', { ...base, userAgent: null }, 'bot'],
    ['curl', { ...base, userAgent: 'curl/8.4.0' }, 'bot'],
  ] as const)('opens: %s', (_, signals, expected) => {
    expect(classifyOpen(signals)).toBe(expected);
  });

  it.each([
    ['a person, a minute after delivery', base, later, 'human'],
    [
      'within 2 seconds of delivery',
      base,
      { sentAt: 0, now: 1500, clicksInLastSecond: 0 },
      'scanner',
    ],
    ['several links in the same second', base, { ...later, clicksInLastSecond: 2 }, 'scanner'],
    ['Microsoft Safe Links', { ...base, asn: 8075, asOrganization: 'Microsoft' }, later, 'scanner'],
    ['Proofpoint by user agent', { ...base, userAgent: 'Proofpoint URL Defense' }, later, 'bot'],
    ['a HEAD request', { ...base, method: 'HEAD' }, later, 'bot'],
  ] as const)('clicks: %s', (_, signals, context, expected) => {
    expect(classifyClick(signals, context)).toBe(expected);
  });

  it('stores user agents as a family only', () => {
    expect(uaFamily(chrome)).toBe('chrome');
    expect(
      uaFamily(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      ),
    ).toBe('apple_mail');
  });
});

describe('DMARC', () => {
  it('parses policies', () => {
    expect(parseDmarc('v=DMARC1; p=quarantine; rua=mailto:x@y')).toBe('quarantine');
    expect(parseDmarc('v=DMARC1;p=REJECT')).toBe('reject');
    expect(parseDmarc('v=DMARC1; p=none')).toBe('none');
    expect(parseDmarc('v=spf1 include:x')).toBeNull();
    expect(parseDmarc('v=DMARC1; p=reject; sp=none', true)).toBe('none');
  });

  it('falls back to the organisational domain for subdomains', async () => {
    const records: Record<string, string[]> = {
      '_dmarc.example.com': ['v=DMARC1; p=reject; sp=quarantine'],
    };
    const resolver = { txt: async (name: string) => records[name] ?? [] };
    expect(await lookupDmarc(resolver, 'news.example.com')).toBe('quarantine');
    expect(await lookupDmarc(resolver, 'example.com')).toBe('reject');
    expect(await lookupDmarc(resolver, 'other.org')).toBeNull();
  });
});

describe('ramp health', () => {
  const ramp = { bounce_threshold: 0.02, complaint_threshold: 0.0008 };
  it('ignores small samples and flags high rates', () => {
    expect(judge(ramp, { sent: 50, bounces: 20, complaints: 0 })).toBeNull();
    expect(judge(ramp, { sent: 1000, bounces: 10, complaints: 0 })).toBeNull();
    expect(judge(ramp, { sent: 1000, bounces: 30, complaints: 0 })).toMatch(/Bounce rate 3\.0%/);
    expect(judge(ramp, { sent: 10_000, bounces: 0, complaints: 9 })).toMatch(/Complaint rate/);
  });
});

describe('SNS verification', () => {
  const certUrl = 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem';
  const topic = 'arn:aws:sns:eu-west-1:123456789012:swarm-ses-events';

  async function signed(overrides: Partial<SnsMessage> = {}): Promise<SnsMessage> {
    const message: SnsMessage = {
      Type: 'Notification',
      MessageId: 'm-1',
      TopicArn: topic,
      Message: JSON.stringify({ eventType: 'Bounce' }),
      Timestamp: new Date().toISOString(),
      SignatureVersion: '2',
      Signature: '',
      SigningCertURL: certUrl,
      ...overrides,
    };
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      signingKey,
      new TextEncoder().encode(stringToSign(message)),
    );
    return { ...message, Signature: btoa(String.fromCharCode(...new Uint8Array(signature))) };
  }

  const options = { allowedTopics: [topic], fetchCert: async () => cert };

  it('extracts the public key from the certificate', () => {
    expect(spkiFromPem(cert)[0]).toBe(0x30);
  });

  it('accepts a correctly signed message', async () => {
    const message = parseSnsMessage(JSON.stringify(await signed()));
    expect(message).not.toBeNull();
    expect(await verifySnsMessage(message!, options)).toEqual({ ok: true });
  });

  it('rejects a forged or altered message', async () => {
    const message = await signed();
    expect(
      await verifySnsMessage({ ...message, Message: '{"eventType":"Complaint"}' }, options),
    ).toEqual({ ok: false, reason: 'signature' });
    expect(
      await verifySnsMessage(
        { ...message, SigningCertURL: 'https://evil.example/sns.pem' },
        options,
      ),
    ).toEqual({ ok: false, reason: 'cert_url' });
    expect(
      await verifySnsMessage(
        { ...message, SigningCertURL: 'https://sns.eu-west-1.amazonaws.com.evil.example/x.pem' },
        options,
      ),
    ).toEqual({ ok: false, reason: 'cert_url' });
    expect(await verifySnsMessage({ ...message, SignatureVersion: '1' }, options)).toEqual({
      ok: false,
      reason: 'version',
    });
    expect(await verifySnsMessage(message, { ...options, allowedTopics: ['arn:other'] })).toEqual({
      ok: false,
      reason: 'topic',
    });
  });

  it('rejects stale messages', async () => {
    const message = await signed({
      Timestamp: new Date(Date.now() - 2 * 3600_000).toISOString(),
    });
    expect(await verifySnsMessage(message, options)).toEqual({ ok: false, reason: 'stale' });
  });
});
