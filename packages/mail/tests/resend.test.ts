import { describe, expect, it } from 'vitest';
import {
  IdentityExistsError,
  MailProviderError,
  ResendClient,
  ResendError,
  ResendMail,
  resendDomainStatus,
  resendIdentityRecords,
  resendRecordName,
} from '../src/index';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A ResendClient whose fetch answers with `respond` and records every call. */
function fake(
  respond: (call: Call) => Response | Promise<Response> = () => Response.json({ id: 'em_1' }),
  region = 'eu-west-1',
) {
  const calls: Call[] = [];
  const client = new ResendClient({
    apiKey: 're_test_key_123456',
    region,
    fetch: async (input, init) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      calls.push(call);
      return respond(call);
    },
  });
  return { client, calls };
}

const error = (status: number, name: string, headers: Record<string, string> = {}) =>
  Response.json({ statusCode: status, name, message: `${name} happened` }, { status, headers });

describe('ResendMail.send', () => {
  it('posts the email with headers, sanitised tags and an Idempotency-Key', async () => {
    const { client, calls } = fake();
    const mail = new ResendMail(client, 'mail.swarm.test');
    const sent = await mail.send({
      category: 'broadcast',
      from: { name: 'Field Notes', address: 'notes@news.example' },
      to: 'reader@example.org',
      replyTo: 'editor@example.org',
      subject: 'Hello',
      html: '<p>Hi</p>',
      text: 'Hi',
      messageId: 'dl_0192f3c4d5e67f8091a2b3c4d5e6f708@news.example',
      headers: {
        'List-Unsubscribe': '<https://link.example/u/x>, <mailto:unsub+x@u.example>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'Feedback-ID': 'bc_1:ch_1:broadcast:swarm',
        'X-Swarm-Delivery': 'dl_0192f3c4d5e67f8091a2b3c4d5e6f708',
      },
      tags: {
        broadcast: 'bc_1',
        delivery: 'dl_0192f3c4d5e67f8091a2b3c4d5e6f708',
        'bad tag!': 'v@lue',
      },
      configurationSet: 'ignored-by-resend',
    });
    expect(sent).toEqual({ messageId: 'em_1' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.method).toBe('POST');
    expect(call!.url).toBe('https://api.resend.com/emails');
    expect(call!.headers.authorization).toBe('Bearer re_test_key_123456');
    expect(call!.headers['idempotency-key']).toBe(
      'dl_0192f3c4d5e67f8091a2b3c4d5e6f708@news.example',
    );
    expect(call!.headers['user-agent']).toBeTruthy();
    expect(call!.body).toEqual({
      from: '"Field Notes" <notes@news.example>',
      to: ['reader@example.org'],
      subject: 'Hello',
      html: '<p>Hi</p>',
      text: 'Hi',
      reply_to: 'editor@example.org',
      headers: {
        'List-Unsubscribe': '<https://link.example/u/x>, <mailto:unsub+x@u.example>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'Feedback-ID': 'bc_1:ch_1:broadcast:swarm',
        'X-Swarm-Delivery': 'dl_0192f3c4d5e67f8091a2b3c4d5e6f708',
      },
      tags: [
        { name: 'category', value: 'broadcast' },
        { name: 'broadcast', value: 'bc_1' },
        // The delivery id must survive unchanged: webhooks are matched by it.
        { name: 'delivery', value: 'dl_0192f3c4d5e67f8091a2b3c4d5e6f708' },
        { name: 'bad_tag_', value: 'v_lue' },
      ],
    });
    expect(JSON.stringify(call!.body)).not.toContain('ignored-by-resend');
  });

  it('generates a Message-ID for the Idempotency-Key when none is given', async () => {
    const { client, calls } = fake();
    await new ResendMail(client, 'mail.swarm.test').send({
      category: 'quickpass',
      from: { address: 'hello@mail.swarm.test' },
      to: 'a@b.example',
      subject: 'S',
      html: 'h',
      text: 't',
    });
    expect(calls[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}@mail\.swarm\.test$/);
    expect(calls[0]!.body).toMatchObject({ from: 'hello@mail.swarm.test' });
    expect(calls[0]!.body).not.toHaveProperty('reply_to');
  });

  it('allows fewer requests in flight than SES', () => {
    expect(new ResendMail(fake().client, 'x.example').maxConcurrency).toBeLessThan(10);
  });
});

describe('ResendError classes', () => {
  const send = (response: Response) =>
    new ResendMail(fake(() => response).client, 'x.example').send({
      category: 'c',
      from: { address: 'a@x.example' },
      to: 'b@y.example',
      subject: 's',
      html: 'h',
      text: 't',
    });

  it('rate limits and server errors are retryable, with Retry-After', async () => {
    const limited = await send(error(429, 'rate_limit_exceeded', { 'retry-after': '7' })).catch(
      (e: unknown) => e,
    );
    expect(limited).toBeInstanceOf(ResendError);
    expect(limited).toBeInstanceOf(MailProviderError);
    expect(limited).toMatchObject({
      status: 429,
      code: 'rate_limit_exceeded',
      retryable: true,
      halting: false,
      retryAfterSeconds: 7,
    });
    await expect(send(error(500, 'internal_server_error'))).rejects.toMatchObject({
      retryable: true,
      halting: false,
    });
    await expect(send(new Response('Bad gateway', { status: 502 }))).rejects.toMatchObject({
      code: 'http_502',
      retryable: true,
    });
  });

  it('used-up quotas wait for the quota, and refused credentials or domains halt', async () => {
    for (const [name, quota] of [
      ['daily_quota_exceeded', 'day'],
      ['monthly_quota_exceeded', 'month'],
    ] as const) {
      await expect(send(error(429, name))).rejects.toMatchObject({
        quota,
        halting: false,
        retryable: false,
      });
    }
    await expect(send(error(429, 'rate_limit_exceeded'))).rejects.toMatchObject({
      quota: null,
      retryable: true,
    });
    await expect(send(error(401, 'missing_api_key'))).rejects.toMatchObject({ halting: true });
    await expect(send(error(403, 'validation_error'))).rejects.toMatchObject({
      halting: true,
      retryable: false,
    });
  });

  it('validation errors fail the one message', async () => {
    await expect(send(error(422, 'validation_error'))).rejects.toMatchObject({
      status: 422,
      halting: false,
      retryable: false,
    });
    await expect(send(error(400, 'invalid_idempotency_key'))).rejects.toMatchObject({
      halting: false,
      retryable: false,
    });
  });
});

const RECORDS = [
  {
    record: 'SPF',
    name: 'bounce',
    type: 'MX',
    ttl: 'Auto',
    status: 'verified',
    value: 'feedback-smtp.eu-west-1.amazonses.com',
    priority: 10,
  },
  {
    record: 'SPF',
    name: 'bounce.news.example',
    type: 'TXT',
    ttl: 'Auto',
    status: 'pending',
    value: '"v=spf1 include:amazonses.com ~all"',
  },
  {
    record: 'DKIM',
    name: 'resend._domainkey',
    type: 'TXT',
    ttl: 'Auto',
    status: 'verified',
    value: 'p=MIGfMA0GCSqGSIb3DQEB',
  },
  {
    record: 'Receiving',
    name: '@',
    type: 'MX',
    ttl: 'Auto',
    status: 'not_started',
    value: 'inbound-smtp.eu-west-1.amazonaws.com',
    priority: 10,
  },
  { record: 'Tracking', name: 'links', type: 'CNAME', status: 'not_started', value: 'x' },
];

describe('Resend domain records', () => {
  it('normalises relative names', () => {
    expect(resendRecordName('send', 'news.example')).toBe('send.news.example');
    expect(resendRecordName('resend._domainkey', 'news.example')).toBe(
      'resend._domainkey.news.example',
    );
    expect(resendRecordName('bounce.news.example.', 'news.example')).toBe('bounce.news.example');
    expect(resendRecordName('@', 'news.example')).toBe('news.example');
    expect(resendRecordName('rbounce.mail', 'mail.apibolt.com')).toBe('rbounce.mail.apibolt.com');
    // What real Resend sends for a subdomain: relative to the root domain, not to the subdomain.
    expect(resendRecordName('resend._domainkey.mail', 'mail.apibolt.com')).toBe(
      'resend._domainkey.mail.apibolt.com',
    );
    expect(resendRecordName('bounce.mail', 'mail.apibolt.com')).toBe('bounce.mail.apibolt.com');
    expect(resendRecordName('mail', 'mail.apibolt.com')).toBe('mail.apibolt.com');
    expect(resendRecordName('send', 'mail.apibolt.com')).toBe('send.mail.apibolt.com');
    expect(resendRecordName('resend._domainkey.news.mail', 'news.mail.example.co.uk')).toBe(
      'resend._domainkey.news.mail.example.co.uk',
    );
  });

  it('keeps DKIM and return-path records only, unquoted', () => {
    expect(resendIdentityRecords('news.example', RECORDS)).toEqual([
      {
        purpose: 'mail_from_mx',
        type: 'MX',
        name: 'bounce.news.example',
        value: 'feedback-smtp.eu-west-1.amazonses.com',
        priority: 10,
      },
      {
        purpose: 'mail_from_spf',
        type: 'TXT',
        name: 'bounce.news.example',
        value: 'v=spf1 include:amazonses.com ~all',
      },
      {
        purpose: 'dkim',
        type: 'TXT',
        name: 'resend._domainkey.news.example',
        value: 'p=MIGfMA0GCSqGSIb3DQEB',
      },
    ]);
  });

  it('maps statuses', () => {
    expect(resendDomainStatus({ id: 'd', name: 'n', status: 'pending', records: RECORDS })).toEqual(
      { verifiedForSending: false, dkimStatus: 'success', mailFromStatus: 'pending' },
    );
    const verified = RECORDS.map((r) => ({ ...r, status: 'verified' }));
    expect(
      resendDomainStatus({ id: 'd', name: 'n', status: 'verified', records: verified }),
    ).toEqual({ verifiedForSending: true, dkimStatus: 'success', mailFromStatus: 'success' });
    const failed = RECORDS.map((r) =>
      r.record === 'DKIM' ? { ...r, status: 'temporary_failure' } : r,
    );
    expect(
      resendDomainStatus({ id: 'd', name: 'n', status: 'partially_failed', records: failed }),
    ).toMatchObject({ verifiedForSending: false, dkimStatus: 'failed' });
    expect(resendDomainStatus({ id: 'd', name: 'n', status: 'not_started' })).toEqual({
      verifiedForSending: false,
      dkimStatus: 'not_started',
      mailFromStatus: 'not_started',
    });
  });
});

describe('ResendClient domains', () => {
  it('creates a domain with a bounce return path and tracking off, then asks to verify', async () => {
    const { client, calls } = fake((call) => {
      if (call.method === 'GET' && call.url.includes('/domains?'))
        return Response.json({ object: 'list', has_more: false, data: [] });
      if (call.method === 'POST' && call.url.endsWith('/domains'))
        return Response.json({
          id: 'dom_1',
          name: 'news.example',
          status: 'not_started',
          records: RECORDS,
        });
      if (call.url.endsWith('/verify')) return Response.json({ object: 'domain', id: 'dom_1' });
      return Response.json({ object: 'domain', id: 'dom_1' });
    });
    const created = await client.create('news.example', 'bounce.news.example');
    expect(created.providerRef).toBe('dom_1');
    expect(created.records.map((r) => r.purpose)).toEqual([
      'mail_from_mx',
      'mail_from_spf',
      'dkim',
    ]);
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.resend.com', '')}`)).toEqual([
      'GET /domains?limit=100',
      'POST /domains',
      'PATCH /domains/dom_1',
      'POST /domains/dom_1/verify',
    ]);
    expect(calls[1]!.body).toEqual({
      name: 'news.example',
      region: 'eu-west-1',
      custom_return_path: 'bounce',
      open_tracking: false,
      click_tracking: false,
    });
    expect(calls[2]!.body).toEqual({ open_tracking: false, click_tracking: false });
  });

  it('refuses a domain Resend already has instead of taking it over', async () => {
    const { client, calls } = fake((call) => {
      if (call.url.includes('/domains?'))
        return Response.json({
          object: 'list',
          has_more: false,
          data: [{ id: 'dom_9', name: 'News.Example', status: 'verified' }],
        });
      return Response.json({ object: 'domain', id: 'dom_9' });
    });
    await expect(client.create('news.example', 'bounce.news.example')).rejects.toBeInstanceOf(
      IdentityExistsError,
    );
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('never looks a domain up by name for its status', async () => {
    const { client, calls } = fake(() =>
      Response.json({
        object: 'list',
        has_more: false,
        data: [{ id: 'dom_9', name: 'news.example', status: 'verified' }],
      }),
    );
    expect(await client.status('news.example', null)).toMatchObject({ verifiedForSending: false });
    expect(calls).toEqual([]);
  });

  it('refuses a region Resend does not have', async () => {
    await expect(
      fake(undefined, 'us-west-2').client.create('a.example', 'bounce.a.example'),
    ).rejects.toThrow(/region/);
  });

  it('reads status by provider ref and nudges verification when not started', async () => {
    const { client, calls } = fake((call) =>
      call.method === 'GET'
        ? Response.json({
            id: 'dom_1',
            name: 'news.example',
            status: 'not_started',
            records: RECORDS,
          })
        : Response.json({ object: 'domain', id: 'dom_1' }),
    );
    expect(await client.status('news.example', 'dom_1')).toMatchObject({
      verifiedForSending: false,
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.resend.com/domains/dom_1',
      'POST https://api.resend.com/domains/dom_1/verify',
    ]);
  });

  it('removes a domain; one Resend no longer has is fine', async () => {
    const gone = fake(() => error(404, 'not_found'));
    await expect(gone.client.remove('news.example', 'dom_1')).resolves.toBeUndefined();
    expect(gone.calls[0]).toMatchObject({
      method: 'DELETE',
      url: 'https://api.resend.com/domains/dom_1',
    });
    const broken = fake(() => error(500, 'internal_server_error'));
    await expect(broken.client.remove('news.example', 'dom_1')).rejects.toBeInstanceOf(ResendError);
    // Without a ref Swarm never created it, so a domain of that name is left alone.
    const unowned = fake(() =>
      Response.json({
        object: 'list',
        has_more: false,
        data: [{ id: 'dom_9', name: 'news.example' }],
      }),
    );
    await unowned.client.remove('news.example', null);
    expect(unowned.calls).toEqual([]);
  });
});
