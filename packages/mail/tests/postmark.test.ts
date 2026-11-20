import { describe, expect, it } from 'vitest';
import {
  IdentityExistsError,
  MailProviderError,
  PostmarkClient,
  PostmarkError,
  PostmarkMail,
  postmarkDomainStatus,
  postmarkIdentityRecords,
  postmarkMetadata,
} from '../src/index';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

const OK = { To: 'reader@example.org', MessageID: 'pm-1', ErrorCode: 0, Message: 'OK' };

function fake(respond: (call: Call) => Response = () => Response.json(OK)) {
  const calls: Call[] = [];
  const client = new PostmarkClient({
    serverToken: 'test-only-server-token',
    accountToken: 'test-only-account-token',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const call: Call = {
        method: init?.method ?? 'GET',
        path: url.pathname + url.search,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
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

describe('PostmarkMail.send', () => {
  it('posts the email with headers, metadata and tracking off', async () => {
    const { client, calls } = fake();
    const sent = await new PostmarkMail(client, 'mail.swarm.test').send({
      ...mail,
      replyTo: 'editor@example.org',
      messageId: 'dl_1@news.example',
      headers: { 'List-Unsubscribe': '<https://link.example/u/x>' },
      tags: { delivery: 'dl_0192', channel: 'ch_1' },
      configurationSet: 'ignored-by-postmark',
    });
    expect(sent).toEqual({ messageId: 'pm-1' });
    const [call] = calls;
    expect(call!.method).toBe('POST');
    expect(call!.path).toBe('/email');
    expect(call!.headers['x-postmark-server-token']).toBe('test-only-server-token');
    expect(call!.headers['x-postmark-account-token']).toBeUndefined();
    expect(call!.body).toEqual({
      From: '"Field Notes" <notes@news.example>',
      To: 'reader@example.org',
      Subject: 'Hello',
      HtmlBody: '<p>Hi</p>',
      TextBody: 'Hi',
      ReplyTo: 'editor@example.org',
      Headers: [
        { Name: 'List-Unsubscribe', Value: '<https://link.example/u/x>' },
        { Name: 'Message-ID', Value: '<dl_1@news.example>' },
      ],
      Tag: 'broadcast',
      Metadata: { delivery: 'dl_0192', channel: 'ch_1' },
      MessageStream: 'broadcasts',
      TrackOpens: false,
      TrackLinks: 'None',
    });
  });

  it('keeps bulk and transactional mail on separate streams', async () => {
    const stream = async (category: string) => {
      const { client, calls } = fake();
      await new PostmarkMail(client, 'm.test').send({ ...mail, category });
      return calls[0]!.body!.MessageStream;
    };
    expect(await stream('broadcast')).toBe('broadcasts');
    for (const category of ['confirm', 'member_center', 'quickpass', 'privacy_export']) {
      expect(await stream(category)).toBe('outbound');
    }
  });

  it('classifies errors for the send pipeline', async () => {
    const send = (status: number, ErrorCode: number) =>
      new PostmarkMail(
        fake(() => Response.json({ ErrorCode, Message: 'nope' }, { status })).client,
        'm.test',
      )
        .send(mail)
        .catch((error: unknown) => error as PostmarkError);
    const classify = async (status: number, code: number) => {
      const error = (await send(status, code)) as PostmarkError;
      expect(error).toBeInstanceOf(MailProviderError);
      return [error.halting, error.retryable];
    };
    // A wrong token, an account pending approval or not approved stop the send.
    expect(await classify(401, 10)).toEqual([true, false]);
    expect(await classify(422, 412)).toEqual([true, false]);
    expect(await classify(422, 413)).toEqual([true, false]);
    // A deactivated recipient only fails that one email.
    expect(await classify(422, 406)).toEqual([false, false]);
    // Out of credits waits like a used-up monthly quota: neither stopped nor retried.
    expect(await classify(422, 405)).toEqual([false, false]);
    expect(((await send(422, 405)) as PostmarkError).quota).toBe('month');
    expect(((await send(422, 406)) as PostmarkError).quota).toBeNull();
    expect(await classify(429, 0)).toEqual([false, true]);
    expect(await classify(500, 101)).toEqual([false, true]);
  });

  it('treats an error inside a 200 answer as an error', async () => {
    const { client } = fake(() => Response.json({ ErrorCode: 300, Message: 'Bad address' }));
    await expect(new PostmarkMail(client, 'm.test').send(mail)).rejects.toMatchObject({
      errorCode: 300,
    });
  });

  it('refuses an answer without an id', async () => {
    const { client } = fake(() => Response.json({ ErrorCode: 0 }));
    await expect(new PostmarkMail(client, 'm.test').send(mail)).rejects.toBeInstanceOf(
      PostmarkError,
    );
  });
});

describe('postmarkMetadata', () => {
  it('leaves out what Postmark would refuse, and keeps the rest', () => {
    expect(
      postmarkMetadata({
        delivery: 'dl_1',
        'a-name-longer-than-twenty': 'x',
        long: 'x'.repeat(81),
      }),
    ).toEqual({ delivery: 'dl_1' });
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'v']));
    expect(Object.keys(postmarkMetadata(many))).toHaveLength(10);
    expect(postmarkMetadata()).toEqual({});
  });
});

const domain = {
  ID: 7,
  Name: 'news.example',
  DKIMVerified: false,
  DKIMPendingHost: 'p._domainkey.news.example',
  DKIMPendingTextValue: 'k=rsa;p=A',
  DKIMHost: '',
  DKIMTextValue: '',
  ReturnPathDomain: 'bounce.news.example',
  ReturnPathDomainVerified: false,
  ReturnPathDomainCNAMEValue: 'pm.mtasv.net',
};

describe('Postmark domains', () => {
  it('asks for the pending DKIM record and the return path', () => {
    expect(postmarkIdentityRecords(domain)).toEqual([
      { purpose: 'dkim', type: 'TXT', name: 'p._domainkey.news.example', value: 'k=rsa;p=A' },
      {
        purpose: 'mail_from_mx',
        type: 'CNAME',
        name: 'bounce.news.example',
        value: 'pm.mtasv.net',
      },
    ]);
  });

  it('falls back to the current DKIM record when none is pending', () => {
    expect(
      postmarkIdentityRecords({
        DKIMHost: 'c._domainkey.news.example',
        DKIMTextValue: 'k=rsa;p=C',
      }),
    ).toEqual([
      { purpose: 'dkim', type: 'TXT', name: 'c._domainkey.news.example', value: 'k=rsa;p=C' },
    ]);
  });

  it('counts unverified records as pending, and DKIM as enough to send', () => {
    expect(postmarkDomainStatus(domain)).toEqual({
      verifiedForSending: false,
      dkimStatus: 'pending',
      mailFromStatus: 'pending',
    });
    expect(postmarkDomainStatus({ ...domain, DKIMVerified: true })).toEqual({
      verifiedForSending: true,
      dkimStatus: 'success',
      mailFromStatus: 'pending',
    });
  });

  it('creates a missing domain with the account token, and refuses an existing one', async () => {
    const missing = fake((call) =>
      call.method === 'GET' ? Response.json({ Domains: [] }) : Response.json(domain),
    );
    const created = await missing.client.create('news.example', 'bounce.news.example');
    expect(created.providerRef).toBe('7');
    expect(created.records).toHaveLength(2);
    expect(missing.calls[1]!.body).toEqual({
      Name: 'news.example',
      ReturnPathDomain: 'bounce.news.example',
    });
    expect(missing.calls[1]!.headers['x-postmark-account-token']).toBe('test-only-account-token');

    const existing = fake((call) =>
      call.path.startsWith('/domains?')
        ? Response.json({ Domains: [{ ID: 7, Name: 'NEWS.example' }] })
        : Response.json(domain),
    );
    await expect(
      existing.client.create('news.example', 'bounce.news.example'),
    ).rejects.toBeInstanceOf(IdentityExistsError);
    expect(existing.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /domains?count=500&offset=0',
    ]);
    // Without a ref Swarm never created it: no lookup by name, for status or removal.
    expect(await existing.client.status('news.example', null)).toMatchObject({
      verifiedForSending: false,
    });
    await existing.client.remove('news.example', null);
    expect(existing.calls).toHaveLength(1);
  });

  it('asks Postmark to recheck only what is not verified yet', async () => {
    const pending = fake((call) =>
      Response.json({
        ...domain,
        DKIMVerified: call.method === 'PUT',
        ReturnPathDomainVerified: call.path.endsWith('verifyReturnPath'),
      }),
    );
    expect(await pending.client.status('news.example', '7')).toEqual({
      verifiedForSending: true,
      dkimStatus: 'success',
      mailFromStatus: 'success',
    });
    expect(pending.calls.map((c) => c.path)).toEqual([
      '/domains/7',
      '/domains/7/verifyDkim',
      '/domains/7/verifyReturnPath',
    ]);

    const done = fake(() =>
      Response.json({ ...domain, DKIMVerified: true, ReturnPathDomainVerified: true }),
    );
    await done.client.status('news.example', '7');
    expect(done.calls).toHaveLength(1);
  });

  it('keeps the last answer when a recheck fails', async () => {
    const { client } = fake((call) =>
      call.method === 'PUT'
        ? Response.json({ ErrorCode: 505, Message: 'not yet' }, { status: 422 })
        : Response.json(domain),
    );
    expect((await client.status('news.example', '7')).dkimStatus).toBe('pending');
  });

  it('treats an unknown domain as not started, and removing it as success', async () => {
    const { client } = fake(() => Response.json({ Domains: [] }));
    expect(await client.status('news.example', null)).toEqual({
      verifiedForSending: false,
      dkimStatus: 'not_started',
      mailFromStatus: 'not_started',
    });
    await expect(client.remove('news.example', null)).resolves.toBeUndefined();
    const gone = fake(() => Response.json({ ErrorCode: 510 }, { status: 404 }));
    await expect(gone.client.remove('news.example', '7')).resolves.toBeUndefined();
    const broken = fake(() => Response.json({ ErrorCode: 101 }, { status: 500 }));
    await expect(broken.client.remove('news.example', '7')).rejects.toBeInstanceOf(PostmarkError);
  });
});
