// Event Webhooks, pure parts: the signature against the documented verifier (the TypeScript
// sample in docs/webhooks.md is this file's import), rotation, event ids, the URL check, the
// retry schedule and the sample data of test events.
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_DATA,
  WEBHOOK_MAX_ATTEMPTS,
  WebhookEnvelopeSchema,
  idPattern,
  webhookBackoffSeconds,
} from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import sample from '../../../docs/examples/verify-webhook.ts?raw';
import guide from '../../../docs/webhooks.md?raw';
import { verifySwarmSignature } from '../../../docs/examples/verify-webhook';
import {
  envelopeFor,
  newWebhookSecret,
  outboundUrlProblem,
  sampleData,
  signWebhook,
  webhookEndpointUrlProblem,
  webhookEventId,
} from '../src/index';

const lf = (text: string) => text.replace(/\r\n/g, '\n');
const now = Math.floor(Date.UTC(2026, 9, 28, 12) / 1000);

describe('webhook signature', () => {
  it('the guide shows the verifier the tests run', () => {
    expect(lf(guide)).toContain('```ts\n' + lf(sample).trimEnd() + '\n```');
  });

  it('matches t=<seconds>,v1=<hex HMAC-SHA256(secret, "t.body")>', async () => {
    const secret = newWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const body = JSON.stringify({ id: 'ev_1', data: { name: 'Zoë' } });
    const header = await signWebhook([secret], now, body);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(header.startsWith(`t=${now},`)).toBe(true);
    expect(await verifySwarmSignature(secret, header, body, 300, now)).toBe(true);
    // Independent HMAC over the documented signed payload.
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${now}.${body}`));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(header).toBe(`t=${now},v1=${hex}`);
  });

  it('refuses a changed body, another secret and a timestamp outside the window', async () => {
    const secret = newWebhookSecret();
    const header = await signWebhook([secret], now, '{"a":1}');
    expect(await verifySwarmSignature(secret, header, '{"a":2}', 300, now)).toBe(false);
    expect(await verifySwarmSignature(newWebhookSecret(), header, '{"a":1}', 300, now)).toBe(false);
    expect(await verifySwarmSignature(secret, header, '{"a":1}', 300, now + 301)).toBe(false);
    expect(await verifySwarmSignature(secret, header, '{"a":1}', 300, now - 301)).toBe(false);
    expect(await verifySwarmSignature(secret, header, '{"a":1}', 300, now + 300)).toBe(true);
    expect(await verifySwarmSignature(secret, 'v1=abc', '{"a":1}', 300, now)).toBe(false);
  });

  it('signs with both secrets during a rotation, either verifies', async () => {
    const current = newWebhookSecret();
    const previous = newWebhookSecret();
    const header = await signWebhook([current, previous], now, 'body');
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
    expect(await verifySwarmSignature(current, header, 'body', 300, now)).toBe(true);
    expect(await verifySwarmSignature(previous, header, 'body', 300, now)).toBe(true);
    expect(await verifySwarmSignature(newWebhookSecret(), header, 'body', 300, now)).toBe(false);
  });
});

describe('webhook event ids', () => {
  it('are stable per source event and differ between sources', async () => {
    const a = await webhookEventId('member_events', 42);
    expect(a).toMatch(idPattern('webhookEvent'));
    expect(await webhookEventId('member_events', 42)).toBe(a);
    expect(await webhookEventId('member_events', 43)).not.toBe(a);
    expect(await webhookEventId('platform_events', 42)).not.toBe(a);
  });
});

describe('outbound URL check (SSRF)', () => {
  it('refuses http, credentials, private hosts and IP literals', () => {
    for (const url of [
      'http://hooks.example.com/in',
      'https://user:pw@hooks.example.com/in',
      'https://localhost/in',
      'https://app.localhost/in',
      'https://printer.local/in',
      'https://db.internal/in',
      'https://router.home.arpa/in',
      'https://intranet/in',
      'https://127.0.0.1/in',
      'https://10.0.0.8/in',
      'https://169.254.169.254/latest/meta-data',
      'https://8.8.8.8/in',
      'https://2130706433/in',
      'https://0x7f.0.0.1/in',
      'https://[::1]/in',
      'https://[fd00::1]/in',
      'https://[2606:4700::1111]/in',
      'https://localhost./in',
      'https://localhost../in',
      'https://db.internal../in',
      'ftp://hooks.example.com/in',
      'not a url',
    ]) {
      expect(outboundUrlProblem(url), url).not.toBeNull();
    }
    expect(outboundUrlProblem('https://hooks.example.com/in?x=1')).toBeNull();
    expect(outboundUrlProblem('https://hooks.example.com:8443/in')).toBeNull();
  });

  it('checks a host with a long run of dots in linear time', () => {
    // A feed's redirect Location is a third party's; a trailing-dot regex was quadratic on a
    // long run of dots that is not at the end.
    const started = performance.now();
    outboundUrlProblem(`https://a${'.'.repeat(100_000)}b/in`);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(outboundUrlProblem('https://hooks.example.com.../in')).toBeNull();
  });

  it('allows plain http in development only', () => {
    expect(webhookEndpointUrlProblem('http://hooks.example.com/in', 'development')).toBeNull();
    expect(webhookEndpointUrlProblem('http://hooks.example.com/in', 'production')).toMatch(/https/);
    expect(webhookEndpointUrlProblem('http://localhost:3000/in', 'development')).not.toBeNull();
  });
});

describe('retry schedule', () => {
  it('is 30 s × 4ⁿ capped at 12 hours, 8 retries', () => {
    expect(
      Array.from({ length: WEBHOOK_MAX_ATTEMPTS - 1 }, (_, i) => webhookBackoffSeconds(i + 1)),
    ).toEqual([30, 120, 480, 1920, 7680, 30720, 43200, 43200]);
  });
});

describe('test event data', () => {
  it('matches the documented data schema of every event type', () => {
    const at = now * 1000;
    for (const type of WEBHOOK_EVENTS) {
      const data = sampleData(type, 'ch_0192f3a4b5c67d8e9f0a1b2c3d4e5f61', at);
      const parsed = WEBHOOK_EVENT_DATA[type].safeParse(data);
      expect(parsed.success, `${type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      const envelope = envelopeFor(
        'ev_0192f3a4b5c67d8e9f0a1b2c3d4e5f6a',
        {
          type,
          createdAt: at,
          workspaceId: 'ws_0192f3a4b5c67d8e9f0a1b2c3d4e5f60',
          channelId: null,
        },
        data,
      );
      expect(WebhookEnvelopeSchema.safeParse(envelope).success).toBe(true);
    }
  });
});
