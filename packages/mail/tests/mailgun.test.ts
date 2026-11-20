import { describe, expect, it } from 'vitest';
import {
  IdentityExistsError,
  MailProviderError,
  MailgunClient,
  MailgunError,
  MailgunMail,
  mailgunBaseUrl,
  mailgunDomainStatus,
  mailgunIdentityRecords,
  mailgunResetSeconds,
} from '../src/index';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  form: FormData | null;
}

function fake(respond: (call: Call) => Response = () => Response.json({ id: '<m1@mg.example>' })) {
  const calls: Call[] = [];
  const client = new MailgunClient({
    apiKey: 'test-only-mailgun-key',
    region: 'eu',
    fetch: async (input, init) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        form: (init?.body as FormData | null) ?? null,
      };
      calls.push(call);
      return respond(call);
    },
  });
  return { client, calls };
}

const mail = {
  category: 'broadcast',
  from: { name: 'Field Notes', address: 'notes@news.example' },
  to: 'reader@example.org',
  subject: 'Hello',
  html: '<p>Hi</p>',
  text: 'Hi',
};

describe('MailgunMail.send', () => {
  it('posts a form to the sending domain with headers, variables and tracking off', async () => {
    const { client, calls } = fake();
    const sent = await new MailgunMail(client, 'mail.swarm.test').send({
      ...mail,
      replyTo: 'editor@example.org',
      messageId: 'dl_1@news.example',
      headers: {
        'List-Unsubscribe': '<https://link.example/u/x>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      tags: { delivery: 'dl_0192', channel: 'ch_1' },
      configurationSet: 'ignored-by-mailgun',
    });
    // Without the angle brackets, because webhooks carry the id that way.
    expect(sent).toEqual({ messageId: 'm1@mg.example' });
    const [call] = calls;
    expect(call!.method).toBe('POST');
    expect(call!.url).toBe('https://api.eu.mailgun.net/v3/news.example/messages');
    expect(call!.headers.authorization).toBe(`Basic ${btoa('api:test-only-mailgun-key')}`);
    const fields = Object.fromEntries(call!.form!.entries());
    expect(fields).toEqual({
      from: '"Field Notes" <notes@news.example>',
      to: 'reader@example.org',
      subject: 'Hello',
      text: 'Hi',
      html: '<p>Hi</p>',
      'o:tag': 'broadcast',
      'o:tracking': 'no',
      'o:tracking-clicks': 'no',
      'o:tracking-opens': 'no',
      'h:Message-Id': '<dl_1@news.example>',
      'h:Reply-To': 'editor@example.org',
      'h:List-Unsubscribe': '<https://link.example/u/x>',
      'h:List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'v:delivery': 'dl_0192',
      'v:channel': 'ch_1',
    });
  });

  it('classifies errors for the send pipeline', async () => {
    const send = (status: number, headers: Record<string, string> = {}) =>
      new MailgunMail(
        fake(() => Response.json({ message: 'nope' }, { status, headers })).client,
        'm.test',
      )
        .send(mail)
        .catch((error: unknown) => error as MailgunError);
    const unauthorized = (await send(401)) as MailgunError;
    expect(unauthorized).toBeInstanceOf(MailProviderError);
    expect([unauthorized.halting, unauthorized.retryable, unauthorized.message]).toEqual([
      true,
      false,
      'nope',
    ]);
    const limited = (await send(429, { 'x-ratelimit-reset': '5000' })) as MailgunError;
    expect([limited.halting, limited.retryable, limited.retryAfterSeconds]).toEqual([
      false,
      true,
      5,
    ]);
    expect(((await send(500)) as MailgunError).retryable).toBe(true);
    const rejected = (await send(400)) as MailgunError;
    expect([rejected.halting, rejected.retryable]).toEqual([false, false]);
  });

  it('refuses an answer without an id', async () => {
    const { client } = fake(() => Response.json({ message: 'Queued' }));
    await expect(new MailgunMail(client, 'm.test').send(mail)).rejects.toMatchObject({
      code: 'missing_id',
    });
  });
});

describe('Mailgun regions and rate limits', () => {
  it('has a base URL per region', () => {
    expect(mailgunBaseUrl('us')).toBe('https://api.mailgun.net');
    expect(mailgunBaseUrl('eu')).toBe('https://api.eu.mailgun.net');
  });

  it('reads the reset header as a duration or as a moment', () => {
    const now = 1_770_000_000_000;
    expect(mailgunResetSeconds('1500', now)).toBe(2);
    expect(mailgunResetSeconds(String(now + 10_000), now)).toBe(10);
    expect(mailgunResetSeconds(String(now - 10_000), now)).toBe(0);
    expect(mailgunResetSeconds(null, now)).toBeNull();
    expect(mailgunResetSeconds('soon', now)).toBeNull();
  });
});

const dns = (valid = 'unknown') => [
  { record_type: 'TXT', name: 'news.example', value: '"v=spf1 include:mailgun.org ~all"', valid },
  { record_type: 'TXT', name: 'k1._domainkey.news.example', value: 'k=rsa; p=ABC', valid },
  { record_type: 'CNAME', name: 'email.news.example', value: 'mailgun.org', valid },
];

describe('Mailgun domains', () => {
  it('keeps only the SPF and DKIM records, unquoted', () => {
    expect(mailgunIdentityRecords('news.example', dns())).toEqual([
      {
        purpose: 'mail_from_spf',
        type: 'TXT',
        name: 'news.example',
        value: 'v=spf1 include:mailgun.org ~all',
      },
      {
        purpose: 'dkim',
        type: 'TXT',
        name: 'k1._domainkey.news.example',
        value: 'k=rsa; p=ABC',
      },
    ]);
    expect(mailgunIdentityRecords('news.example', null)).toEqual([]);
  });

  it('counts a record DNS does not have yet as pending, not failed', () => {
    const domain = { state: 'unverified' };
    expect(mailgunDomainStatus({ domain, sending_dns_records: dns('invalid') })).toEqual({
      verifiedForSending: false,
      dkimStatus: 'pending',
      mailFromStatus: 'pending',
    });
    expect(
      mailgunDomainStatus({ domain: { state: 'active' }, sending_dns_records: dns('valid') }),
    ).toEqual({ verifiedForSending: true, dkimStatus: 'success', mailFromStatus: 'success' });
    expect(
      mailgunDomainStatus({
        domain: { state: 'active', is_disabled: true },
        sending_dns_records: dns('valid'),
      }).verifiedForSending,
    ).toBe(false);
  });

  it('creates a missing domain and refuses an existing one', async () => {
    const missing = fake((call) =>
      call.method === 'GET'
        ? Response.json({ message: 'Domain not found' }, { status: 404 })
        : Response.json({ domain: { state: 'unverified' }, sending_dns_records: dns() }),
    );
    const created = await missing.client.create('news.example');
    expect(created.providerRef).toBeNull();
    expect(created.records).toHaveLength(2);
    expect(missing.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /v4/domains/news.example',
      'POST /v4/domains',
    ]);
    expect(missing.calls[1]!.form!.get('name')).toBe('news.example');

    const existing = fake(() =>
      Response.json({ domain: { state: 'active' }, sending_dns_records: dns() }),
    );
    await expect(existing.client.create('news.example')).rejects.toBeInstanceOf(
      IdentityExistsError,
    );
    expect(existing.calls).toHaveLength(1);
  });

  it('asks Mailgun to check DNS only while the domain is not active', async () => {
    const pending = fake((call) =>
      Response.json({
        domain: { state: call.method === 'PUT' ? 'active' : 'unverified' },
        sending_dns_records: dns('valid'),
      }),
    );
    expect((await pending.client.status('news.example')).verifiedForSending).toBe(true);
    expect(pending.calls.map((c) => c.method)).toEqual(['GET', 'PUT']);

    const active = fake(() =>
      Response.json({ domain: { state: 'active' }, sending_dns_records: dns('valid') }),
    );
    await active.client.status('news.example');
    expect(active.calls.map((c) => c.method)).toEqual(['GET']);

    const gone = fake(() => Response.json({}, { status: 404 }));
    expect(await gone.client.status('news.example')).toEqual({
      verifiedForSending: false,
      dkimStatus: 'not_started',
      mailFromStatus: 'not_started',
    });
  });

  it('treats removing a missing domain as success, and other errors as errors', async () => {
    await expect(
      fake(() => Response.json({}, { status: 404 })).client.remove('news.example'),
    ).resolves.toBeUndefined();
    await expect(
      fake(() => Response.json({}, { status: 500 })).client.remove('news.example'),
    ).rejects.toBeInstanceOf(MailgunError);
  });
});
