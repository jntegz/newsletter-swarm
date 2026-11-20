import { env } from 'cloudflare:test';
import type {
  Broadcast,
  Dispatch,
  DispatchRevision,
  Member,
  Preflight,
  Ramp,
  SeatRole,
  SenderIdentity,
  SendingDomain,
} from '@swarm/domain';
import type { EngineConfig } from '@swarm/engine';
import { devProviderDomains } from '@swarm/mail';
import { beforeAll, describe, expect, it } from 'vitest';
import { isPlatformDomain } from '../src/lib/send';
import { call, createChannel, json, seatAs, signIn, uniqueEmail, type Session } from './helpers';

const doc = (...paragraphs: string[]) => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

async function data<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await json<{ data: T }>(res)).data;
}

async function newDispatch(s: Session, channelId: string, body: Record<string, unknown> = {}) {
  return data<Dispatch>(
    await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
      cookie: s.cookie,
      body: { subject: 'Issue 1', content: doc('Hello {{ first_name | there }}'), ...body },
    }),
    201,
  );
}

async function addMember(s: Session, channelId: string, email = uniqueEmail('member')) {
  return data<Member>(
    await call('POST', `/api/v1/channels/${channelId}/members`, {
      cookie: s.cookie,
      body: { email, firstName: 'Ada', consent: true },
    }),
    201,
  );
}

describe('members', () => {
  it('adds, lists, counts and deletes Members', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const a = await addMember(owner, channelId);
    await addMember(owner, channelId);
    const dup = await call('POST', `/api/v1/channels/${channelId}/members`, {
      cookie: owner.cookie,
      body: { email: a.email.toUpperCase() },
    });
    expect(dup.status).toBe(409);

    const page1 = await data<{ items: Member[]; nextCursor: string | null }>(
      await call('GET', `/api/v1/channels/${channelId}/members?limit=1`, { cookie: owner.cookie }),
    );
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await data<{ items: Member[] }>(
      await call(
        'GET',
        `/api/v1/channels/${channelId}/members?limit=1&cursor=${page1.nextCursor}`,
        { cookie: owner.cookie },
      ),
    );
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);
    expect(
      await data(
        await call('GET', `/api/v1/channels/${channelId}/members/counts`, { cookie: owner.cookie }),
      ),
    ).toEqual({
      pending: 0,
      active: 2,
      paused: 0,
      unsubscribed: 0,
      bounced: 0,
      complained: 0,
    });

    expect((await call('DELETE', `/api/v1/members/${a.id}`, { cookie: owner.cookie })).status).toBe(
      204,
    );
    expect((await call('DELETE', `/api/v1/members/${a.id}`, { cookie: owner.cookie })).status).toBe(
      404,
    );
  });
});

describe('dispatches', () => {
  let owner: Session;
  let channelId: string;
  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
  });

  it('renders on the server and refuses unsafe documents', async () => {
    const dispatch = await newDispatch(owner, channelId);
    expect(dispatch.status).toBe('draft');
    expect(dispatch.html).toContain('Hello {{ first_name | there }}');
    expect(dispatch.html).not.toContain('{{@');

    const script = await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
      cookie: owner.cookie,
      body: { content: { type: 'doc', content: [{ type: 'script', content: [] }] } },
    });
    expect(script.status).toBe(400);
    const html = await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
      cookie: owner.cookie,
      body: {
        content: { type: 'doc', content: [{ type: 'htmlBlock', attrs: { html: '<b>x</b>' } }] },
      },
    });
    expect(html.status).toBe(400);
    const long = await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
      cookie: owner.cookie,
      body: { subject: 'x'.repeat(201) },
    });
    expect(long.status).toBe(400);

    const badLink = await data<Dispatch>(
      await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
        cookie: owner.cookie,
        body: {
          content: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'x',
                    marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    expect(badLink.html).not.toContain('javascript:');
    expect(badLink.warnings.join(' ')).toMatch(/not a valid web address/);
  });

  it('coalesces autosaves into one revision, keeps named snapshots and restores', async () => {
    const dispatch = await newDispatch(owner, channelId);
    for (const subject of ['One', 'Two', 'Three']) {
      await data(
        await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
          cookie: owner.cookie,
          body: { subject },
        }),
      );
    }
    let revisions = await data<DispatchRevision[]>(
      await call('GET', `/api/v1/dispatches/${dispatch.id}/revisions`, { cookie: owner.cookie }),
    );
    // Creating and three quick saves by the same operator are one revision.
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.subject).toBe('Three');

    const named = await data<DispatchRevision>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/revisions`, {
        cookie: owner.cookie,
        body: { name: 'Before edits' },
      }),
      201,
    );
    await data(
      await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
        cookie: owner.cookie,
        body: { subject: 'Changed' },
      }),
    );
    revisions = await data<DispatchRevision[]>(
      await call('GET', `/api/v1/dispatches/${dispatch.id}/revisions`, { cookie: owner.cookie }),
    );
    expect(revisions.find((r) => r.id === named.id)?.subject).toBe('Three');
    expect(revisions[0]!.subject).toBe('Changed');

    const restored = await data<Dispatch>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/revisions/${named.id}/restore`, {
        cookie: owner.cookie,
      }),
    );
    expect(restored.subject).toBe('Three');
  });

  it('checks readiness with the exact recipient count', async () => {
    const dispatch = await newDispatch(owner, channelId, { subject: '' });
    let check = await data<Preflight>(
      await call('GET', `/api/v1/dispatches/${dispatch.id}/preflight`, { cookie: owner.cookie }),
    );
    expect(check.ready).toBe(false);
    expect(
      check.checks
        .filter((c) => !c.ok)
        .map((c) => c.key)
        .sort(),
    ).toEqual(['audience', 'subject']);

    const { id: other } = await createChannel(owner);
    const fresh = await newDispatch(owner, other);
    await addMember(owner, other);
    await addMember(owner, other);
    check = await data<Preflight>(
      await call('GET', `/api/v1/dispatches/${fresh.id}/preflight`, { cookie: owner.cookie }),
    );
    expect(check).toMatchObject({ ready: true, recipientCount: 2 });
    expect(check.from?.address).toMatch(/@mail\.swarm\.localhost$/);
  });

  it('sends tests to the team only, marked and untracked', async () => {
    const dispatch = await newDispatch(owner, channelId, {
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'Read',
                marks: [{ type: 'link', attrs: { href: 'https://essay.example/1' } }],
              },
            ],
          },
        ],
      },
    });
    const sent = await data<{ sentTo: string[] }>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/test`, {
        cookie: owner.cookie,
        body: {},
      }),
      202,
    );
    expect(sent.sentTo).toEqual([owner.email]);
    const mail = await data<{ subject: string; html: string; category: string }>(
      await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(owner.email)}`),
    );
    expect(mail.category).toBe('test');
    expect(mail.subject).toBe('[Test] Issue 1');
    expect(mail.html).toContain('href="https://essay.example/1"');

    const outsider = await call('POST', `/api/v1/dispatches/${dispatch.id}/test`, {
      cookie: owner.cookie,
      body: { to: ['stranger@example.org'] },
    });
    expect(outsider.status).toBe(400);
  });

  it('tests either email of a gated paid Dispatch and counts who gets which', async () => {
    const { id: ch } = await createChannel(owner);
    await addMember(owner, ch);
    const dispatch = await newDispatch(owner, ch, {
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Free part' }] },
          { type: 'gate' },
          { type: 'paragraph', content: [{ type: 'text', text: 'Paid part' }] },
        ],
      },
    });
    const saved = await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
      cookie: owner.cookie,
      body: { webVisibility: 'paid' },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);

    const latest = async () =>
      data<{ html: string }>(
        await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(owner.email)}`),
      );
    // Full by default: what Members the Gate admits receive.
    await data(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/test`, {
        cookie: owner.cookie,
        body: {},
      }),
      202,
    );
    expect((await latest()).html).toContain('Paid part');
    await data(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/test`, {
        cookie: owner.cookie,
        body: { variant: 'teaser' },
      }),
      202,
    );
    const teaser = await latest();
    expect(teaser.html).toContain('Free part');
    expect(teaser.html).not.toContain('Paid part');
    expect(teaser.html).toContain('for paid subscribers');

    const check = await data<Preflight>(
      await call('GET', `/api/v1/dispatches/${dispatch.id}/preflight`, { cookie: owner.cookie }),
    );
    expect(check).toMatchObject({ recipientCount: 1, split: { full: 0, teaser: 1 } });
    const plain = await newDispatch(owner, ch);
    expect(
      (
        await data<Preflight>(
          await call('GET', `/api/v1/dispatches/${plain.id}/preflight`, { cookie: owner.cookie }),
        )
      ).split,
    ).toBeNull();
  });

  it('sends once, then locks the Dispatch; Broadcasts list, report stats and cancel', async () => {
    const { id: ch } = await createChannel(owner);
    await addMember(owner, ch);
    const dispatch = await newDispatch(owner, ch);
    const { broadcastId } = await data<{ broadcastId: string }>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/send`, { cookie: owner.cookie }),
      202,
    );
    expect(
      (await call('POST', `/api/v1/dispatches/${dispatch.id}/send`, { cookie: owner.cookie }))
        .status,
    ).toBe(409);
    expect(
      (
        await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
          cookie: owner.cookie,
          body: { subject: 'Late edit' },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call('DELETE', `/api/v1/dispatches/${dispatch.id}`, { cookie: owner.cookie })).status,
    ).toBe(409);

    const list = await data<Broadcast[]>(
      await call('GET', `/api/v1/channels/${ch}/broadcasts`, { cookie: owner.cookie }),
    );
    expect(list.map((b) => b.id)).toEqual([broadcastId]);
    expect(list[0]!.status).toBe('queued');
    const stats = await data<{ sent: number; cost: { currency: string } }>(
      await call('GET', `/api/v1/broadcasts/${broadcastId}/stats`, { cookie: owner.cookie }),
    );
    expect(stats).toMatchObject({ sent: 0, cost: { currency: 'USD' } });

    const canceled = await data<Broadcast>(
      await call('POST', `/api/v1/broadcasts/${broadcastId}/cancel`, { cookie: owner.cookie }),
    );
    expect(canceled.status).toBe('canceled');
    expect(
      (await call('POST', `/api/v1/broadcasts/${broadcastId}/cancel`, { cookie: owner.cookie }))
        .status,
    ).toBe(409);
  });

  it('streams live progress over a WebSocket only to same-origin operators with access', async () => {
    const { id: ch } = await createChannel(owner);
    await addMember(owner, ch);
    const dispatch = await newDispatch(owner, ch);
    const { broadcastId } = await data<{ broadcastId: string }>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/send`, { cookie: owner.cookie }),
      202,
    );
    const path = `/api/v1/broadcasts/${broadcastId}/live`;
    const upgrade = { upgrade: 'websocket' };

    const socket = await call('GET', path, { cookie: owner.cookie, headers: upgrade });
    expect(socket.status).toBe(101);
    socket.webSocket!.accept();
    socket.webSocket!.close();

    // Cross-site WebSocket hijacking: the browser would send the cookie, the Origin gives it away.
    const foreign = await call('GET', path, {
      cookie: owner.cookie,
      headers: upgrade,
      origin: 'https://evil.example',
    });
    expect(foreign.status).toBe(403);
    expect((await call('GET', path, { cookie: owner.cookie })).status).toBe(400);
    const stranger = await signIn();
    expect((await call('GET', path, { cookie: stranger.cookie, headers: upgrade })).status).toBe(
      404,
    );
    expect((await call('GET', path, { headers: upgrade })).status).toBe(401);
  });

  it('explains why a Dispatch cannot be sent', async () => {
    const { id: empty } = await createChannel(owner);
    const dispatch = await newDispatch(owner, empty);
    const res = await call('POST', `/api/v1/dispatches/${dispatch.id}/send`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(409);
    const body = await json<{ error: { details: { path: string }[] } }>(res);
    expect(body.error.details.map((d) => d.path)).toContain('audience');
  });

  it('schedules in the future only, and unschedules', async () => {
    const { id: ch } = await createChannel(owner);
    await addMember(owner, ch);
    const dispatch = await newDispatch(owner, ch);
    const past = await call('POST', `/api/v1/dispatches/${dispatch.id}/schedule`, {
      cookie: owner.cookie,
      body: { publishAt: new Date(Date.now() - 1000).toISOString() },
    });
    expect(past.status).toBe(400);
    const at = new Date(Date.now() + 3600_000).toISOString();
    const scheduled = await data<Dispatch>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/schedule`, {
        cookie: owner.cookie,
        body: { publishAt: at },
      }),
    );
    expect(scheduled).toMatchObject({ status: 'scheduled', publishAt: at });
    const draft = await data<Dispatch>(
      await call('DELETE', `/api/v1/dispatches/${dispatch.id}/schedule`, { cookie: owner.cookie }),
    );
    expect(draft).toMatchObject({ status: 'draft', publishAt: null });
  });

  it('deletes drafts', async () => {
    const dispatch = await newDispatch(owner, channelId);
    expect(
      (await call('DELETE', `/api/v1/dispatches/${dispatch.id}`, { cookie: owner.cookie })).status,
    ).toBe(204);
    expect(
      (await call('GET', `/api/v1/dispatches/${dispatch.id}`, { cookie: owner.cookie })).status,
    ).toBe(404);
  });
});

describe('sending settings', () => {
  it('adds an email domain with real-shaped DNS records, verifies it and sends from it', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const name = `news-${crypto.randomUUID().slice(0, 8)}.example.com`;
    const domain = await data<SendingDomain>(
      await call('POST', `/api/v1/channels/${channelId}/sending-domains`, {
        cookie: owner.cookie,
        body: { domain: name.toUpperCase(), kind: 'email' },
      }),
      201,
    );
    expect(domain).toMatchObject({
      domain: name,
      status: 'pending',
      mailFromDomain: `bounce.${name}`,
    });
    const dkim = domain.records.filter((r) => r.purpose === 'dkim');
    expect(dkim).toHaveLength(3);
    expect(dkim[0]!.value).toMatch(/\.dkim\.amazonses\.com$/);
    expect(domain.records.find((r) => r.purpose === 'dmarc')?.value).toMatch(
      /^v=DMARC1; p=quarantine/,
    );
    expect(domain.records.find((r) => r.purpose === 'mail_from_mx')).toMatchObject({
      type: 'MX',
      priority: 10,
    });
    expect(
      (
        await call('POST', `/api/v1/channels/${channelId}/sending-domains`, {
          cookie: owner.cookie,
          body: { domain: name, kind: 'email' },
        })
      ).status,
    ).toBe(409);

    const verified = await data<SendingDomain>(
      await call('POST', `/api/v1/sending-domains/${domain.id}/verify`, { cookie: owner.cookie }),
    );
    expect(verified).toMatchObject({
      status: 'verified',
      dkimStatus: 'success',
      dmarcPolicy: 'quarantine',
    });

    const sender = await data<SenderIdentity>(
      await call('POST', `/api/v1/channels/${channelId}/sender-identities`, {
        cookie: owner.cookie,
        body: {
          fromName: 'Field Notes',
          fromLocal: 'hello',
          sendingDomainId: domain.id,
          replyTo: owner.email,
        },
      }),
      201,
    );
    expect(sender).toMatchObject({ fromAddress: `hello@${name}`, isDefault: true });

    await addMember(owner, channelId);
    const dispatch = await newDispatch(owner, channelId);
    const check = await data<Preflight>(
      await call('GET', `/api/v1/dispatches/${dispatch.id}/preflight`, { cookie: owner.cookie }),
    );
    expect(check.ready).toBe(true);
    expect(check.from?.address).toBe(`hello@${name}`);

    const ramps = await data<Ramp[]>(
      await call('GET', `/api/v1/channels/${channelId}/ramps`, { cookie: owner.cookie }),
    );
    expect(ramps.map((r) => r.domain)).toEqual(['mail.swarm.localhost', name]);
    expect(ramps[1]).toMatchObject({ capToday: 200, growth: 1.5, status: 'warming' });

    const paused = await data<Ramp>(
      await call('PATCH', `/api/v1/ramps/${ramps[1]!.id}`, {
        cookie: owner.cookie,
        body: { status: 'paused' },
      }),
    );
    expect(paused.status).toBe('paused');
    const blocked = await data<Preflight>(
      await call('GET', `/api/v1/dispatches/${dispatch.id}/preflight`, { cookie: owner.cookie }),
    );
    expect(blocked.checks.find((c) => c.key === 'ramp')?.ok).toBe(false);
    const resumed = await data<Ramp>(
      await call('PATCH', `/api/v1/ramps/${ramps[1]!.id}`, {
        cookie: owner.cookie,
        body: { status: 'warming', growth: 1.2 },
      }),
    );
    expect(resumed).toMatchObject({ status: 'warming', growth: 1.2, pausedReason: null });

    expect(
      (await call('DELETE', `/api/v1/sending-domains/${domain.id}`, { cookie: owner.cookie }))
        .status,
    ).toBe(204);
    const senders = await data<SenderIdentity[]>(
      await call('GET', `/api/v1/channels/${channelId}/sender-identities`, {
        cookie: owner.cookie,
      }),
    );
    expect(senders).toEqual([]);
  });

  it('refuses platform domains and keeps shared-domain senders on the Channel address', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    for (const domain of ['mail.swarm.localhost', 'x.unsubscribe.swarm.localhost']) {
      const res = await call('POST', `/api/v1/channels/${channel.id}/sending-domains`, {
        cookie: owner.cookie,
        body: { domain, kind: 'email' },
      });
      expect(res.status, domain).toBe(400);
    }
    const shared = await data<SenderIdentity>(
      await call('POST', `/api/v1/channels/${channel.id}/sender-identities`, {
        cookie: owner.cookie,
        body: { fromName: 'Notes', fromLocal: 'ceo', sendingDomainId: null },
      }),
      201,
    );
    expect(shared.fromAddress).toBe(`${channel.slug}@mail.swarm.localhost`);
  });

  it('keeps the free plan to its senders when many are added at once', async () => {
    const owner = await signIn();
    const channel = await createChannel(owner);
    const add = () =>
      call('POST', `/api/v1/channels/${channel.id}/sender-identities`, {
        cookie: owner.cookie,
        body: { fromName: 'Notes', fromLocal: 'hello', sendingDomainId: null },
      });
    expect((await add()).status).toBe(201);
    const results = await Promise.all(Array.from({ length: 6 }, add));
    const rows = await env.DB.prepare(
      'SELECT count(*) AS n, sum(is_default) AS defaults FROM sender_identities WHERE channel_id = ?1',
    )
      .bind(channel.id)
      .first<{ n: number; defaults: number }>();
    expect({
      added: results.filter((res) => res.status === 201).length,
      refused: results.filter((res) => res.status === 409).length,
      ...rows,
    }).toEqual({ added: 2, refused: 4, n: 3, defaults: 1 });
  });

  it('refuses the other environment’s platform mail domain too', () => {
    // Production is mail.D and staging staging-mail.D; both are identities at the mail service.
    // (Every test host is under the track host, localhost, so this is checked directly.)
    const production = {
      platformMailDomain: 'mail.example.com',
      unsubscribeMailDomain: 'unsubscribe.example.com',
      trackOrigin: 'https://link.example.com',
    } as EngineConfig;
    const staging = {
      platformMailDomain: 'staging-mail.example.com',
      unsubscribeMailDomain: 'staging-unsubscribe.example.com',
      trackOrigin: 'https://staging-link.example.com',
    } as EngineConfig;
    for (const config of [production, staging]) {
      for (const domain of [
        'mail.example.com',
        'staging-mail.example.com',
        'bounce.staging-mail.example.com',
        'x.unsubscribe.example.com',
        'staging-link.example.com',
      ]) {
        expect(isPlatformDomain(domain, config), domain).toBe(true);
      }
      expect(isPlatformDomain('news.example.com', config)).toBe(false);
    }
  });

  it('never takes over a domain the mail service already has', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const name = `operator-${crypto.randomUUID().slice(0, 8)}.example.com`;
    devProviderDomains.add(name);
    const res = await call('POST', `/api/v1/channels/${channelId}/sending-domains`, {
      cookie: owner.cookie,
      body: { domain: name, kind: 'email' },
    });
    expect(res.status).toBe(409);
    expect((await json<{ error: { message: string } }>(res)).error.message).toMatch(
      /mail service already has/,
    );
    expect(devProviderDomains.has(name)).toBe(true);
    devProviderDomains.delete(name);
  });

  it('leaves alone what this service has of a domain that is on another service', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const name = `held-${crypto.randomUUID().slice(0, 8)}.example.com`;
    const domain = await data<SendingDomain>(
      await call('POST', `/api/v1/channels/${channelId}/sending-domains`, {
        cookie: owner.cookie,
        body: { domain: name, kind: 'email' },
      }),
      201,
    );
    // A service change couldn't move it: it stays on Resend while email goes through this one,
    // which has a domain of that name that isn't the row's.
    await env.DB.prepare(`UPDATE sending_domains SET provider = 'resend' WHERE id = ?1`)
      .bind(domain.id)
      .run();
    devProviderDomains.add(name);
    const checked = await data<SendingDomain>(
      await call('POST', `/api/v1/sending-domains/${domain.id}/verify`, { cookie: owner.cookie }),
    );
    expect(checked.status).toBe('pending');
    expect(
      (await call('DELETE', `/api/v1/sending-domains/${domain.id}`, { cookie: owner.cookie }))
        .status,
    ).toBe(204);
    expect(devProviderDomains.has(name)).toBe(true);
    devProviderDomains.delete(name);
  });

  it('keeps a domain a service change has registered at the next service', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const domain = await data<SendingDomain>(
      await call('POST', `/api/v1/channels/${channelId}/sending-domains`, {
        cookie: owner.cookie,
        body: { domain: `moving-${crypto.randomUUID().slice(0, 8)}.example.com`, kind: 'email' },
      }),
      201,
    );
    await env.DB.prepare(
      `UPDATE sending_domains SET pending_provider = 'resend', pending_provider_ref = 'dom_1',
         pending_records_json = '[]' WHERE id = ?1`,
    )
      .bind(domain.id)
      .run();
    // This Worker can't reach that service, so removing now would leave its domain behind.
    const res = await call('DELETE', `/api/v1/sending-domains/${domain.id}`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(409);
    expect((await json<{ error: { message: string } }>(res)).error.message).toMatch(/resend/);
    const left = await env.DB.prepare('SELECT 1 AS n FROM sending_domains WHERE id = ?1')
      .bind(domain.id)
      .first();
    expect(left).not.toBeNull();
  });

  describe('a claim nobody has proven', () => {
    const DAY = 86_400_000;
    const add = (s: Session, channelId: string, domain: string, kind = 'email') =>
      call('POST', `/api/v1/channels/${channelId}/sending-domains`, {
        cookie: s.cookie,
        body: { domain, kind },
      });
    const age = (id: string, days: number) =>
      env.DB.prepare('UPDATE sending_domains SET created_at = created_at - ?1 WHERE id = ?2')
        .bind(days * DAY, id)
        .run();
    const exists = async (id: string) =>
      (await env.DB.prepare('SELECT 1 AS n FROM sending_domains WHERE id = ?1')
        .bind(id)
        .first()) !== null;
    /** The TXT record a refusal asks for, published in the dev resolver. */
    async function publishProof(res: Response) {
      expect(res.status).toBe(409);
      const { message } = (await json<{ error: { message: string } }>(res)).error;
      const name = /(_swarm-claim\.\S+?) /.exec(message)?.[1];
      const value = /(swarm-claim=[0-9a-f]+)/.exec(message)?.[1];
      expect(name && value, message).toBeTruthy();
      await env.CACHE.put(`dev:txt:${name}`, JSON.stringify([value]));
    }

    it('still needs the TXT proof once its re-check week has passed', async () => {
      const squatter = await signIn();
      const owner = await signIn();
      const theirs = await createChannel(squatter);
      const ours = await createChannel(owner);
      for (const kind of ['email', 'link']) {
        const name = `squat-${crypto.randomUUID().slice(0, 8)}.example.com`;
        const claimed = await data<SendingDomain>(await add(squatter, theirs.id, name, kind), 201);
        await age(claimed.id, 8);
        await publishProof(await add(owner, ours.id, name, kind));
        expect(await exists(claimed.id)).toBe(true);
        await data<SendingDomain>(await add(owner, ours.id, name, kind), 201);
        expect(await exists(claimed.id)).toBe(false);
      }
    });

    it('gives way within the week to the Channel that publishes the TXT proof', async () => {
      const squatter = await signIn();
      const owner = await signIn();
      const theirs = await createChannel(squatter);
      const ours = await createChannel(owner);
      const name = `proof-${crypto.randomUUID().slice(0, 8)}.example.com`;
      const claimed = await data<SendingDomain>(await add(squatter, theirs.id, name, 'link'), 201);
      await publishProof(await add(owner, ours.id, name, 'link'));
      const mine = await data<SendingDomain>(await add(owner, ours.id, name, 'link'), 201);
      expect(await exists(claimed.id)).toBe(false);
      // The record proves this Channel's claim, not anyone else's.
      expect((await add(squatter, theirs.id, name, 'link')).status).toBe(409);
      expect(await exists(mine.id)).toBe(true);
    });

    it('holds its domain for good once verified', async () => {
      const first = await signIn();
      const second = await signIn();
      const a = await createChannel(first);
      const b = await createChannel(second);
      const name = `kept-${crypto.randomUUID().slice(0, 8)}.example.com`;
      const claimed = await data<SendingDomain>(await add(first, a.id, name), 201);
      await data(
        await call('POST', `/api/v1/sending-domains/${claimed.id}/verify`, {
          cookie: first.cookie,
        }),
      );
      await age(claimed.id, 30);
      const res = await add(second, b.id, name);
      expect(res.status).toBe(409);
      expect((await json<{ error: { message: string } }>(res)).error.message).toBe(
        'That domain is already set up.',
      );
      expect(await exists(claimed.id)).toBe(true);
    });

    it('needs the TXT proof for a link domain whose CNAME already points at the platform', async () => {
      const owner = await signIn();
      const { id: channelId } = await createChannel(owner);
      // An earlier Channel removed its domain but its CNAME was left behind: the hostname service
      // would activate the name for whoever adds it next.
      const name = `left-${crypto.randomUUID().slice(0, 8)}.example.com`;
      // The track host here (TRACK_ORIGIN is http://localhost:8790).
      await env.CACHE.put(`dev:cname:${name}`, JSON.stringify(['localhost']));
      const refused = await add(owner, channelId, name, 'link');
      expect(refused.status).toBe(409);
      const { error } = await json<{
        error: { message: string; details: { path: string; message: string }[] };
      }>(refused.clone());
      expect(error.message).toBe(
        `${name} already points at Swarm, so we need to check it’s yours. Publish a TXT record named _swarm-claim.${name} with the value ${/swarm-claim=[0-9a-f]+/.exec(error.message)?.[0]}, then add it again.`,
      );
      expect(error.details).toEqual([
        { path: 'domain', message: expect.stringMatching(/^TXT _swarm-claim\.\S+ swarm-claim=/) },
      ]);
      await publishProof(refused);
      await data<SendingDomain>(await add(owner, channelId, name, 'link'), 201);
    });

    it('needs the TXT proof for a link domain whose CNAME chain reaches the platform', async () => {
      const owner = await signIn();
      const { id: channelId } = await createChannel(owner);
      // The name's own CNAME is the owner's alias; the alias was left pointing at the track host.
      const name = `chain-${crypto.randomUUID().slice(0, 8)}.example.com`;
      await env.CACHE.put(`dev:cname:${name}`, JSON.stringify([`alias.${name}.`]));
      await env.CACHE.put(`dev:cname:alias.${name}`, JSON.stringify(['localhost.']));
      const refused = await add(owner, channelId, name, 'link');
      expect(refused.status).toBe(409);
      expect((await json<{ error: { message: string } }>(refused.clone())).error.message).toMatch(
        /already points at Swarm/,
      );
      await publishProof(refused);
      await data<SendingDomain>(await add(owner, channelId, name, 'link'), 201);
    });

    it('needs the TXT proof for a link domain whose CNAME a web hostname left behind', async () => {
      const owner = await signIn();
      const { id: channelId } = await createChannel(owner);
      // Both are custom hostnames in the same zone: the site target activates a link domain too.
      const name = `site-${crypto.randomUUID().slice(0, 8)}.example.com`;
      await env.CACHE.put(`dev:cname:${name}`, JSON.stringify(['sites.site.localhost']));
      const refused = await add(owner, channelId, name, 'link');
      expect(refused.status).toBe(409);
      await publishProof(refused);
      await data<SendingDomain>(await add(owner, channelId, name, 'link'), 201);
    });

    it('refuses a link domain whose DNS cannot be checked', async () => {
      const owner = await signIn();
      const { id: channelId } = await createChannel(owner);
      const name = `fail-${crypto.randomUUID().slice(0, 8)}.example.com`;
      // The dev double fails the lookup for a non-list answer.
      await env.CACHE.put(`dev:cname:${name}`, JSON.stringify({ error: 'SERVFAIL' }));
      const res = await add(owner, channelId, name, 'link');
      expect(res.status).toBe(503);
      expect((await json<{ error: { message: string } }>(res)).error.message).toBe(
        `DNS for ${name} couldn’t be checked. Try again in a minute.`,
      );
    });

    it('needs no proof for a link domain whose DNS points elsewhere or nowhere yet', async () => {
      const owner = await signIn();
      const { id: channelId } = await createChannel(owner);
      const elsewhere = `own-${crypto.randomUUID().slice(0, 8)}.example.com`;
      await env.CACHE.put(`dev:cname:${elsewhere}`, JSON.stringify(['cdn.example.net']));
      await data<SendingDomain>(await add(owner, channelId, elsewhere, 'link'), 201);
      // A chain that ends at someone else's host, and one that loops, reach nothing of ours.
      const chained = `hop-${crypto.randomUUID().slice(0, 8)}.example.com`;
      await env.CACHE.put(`dev:cname:${chained}`, JSON.stringify([`alias.${chained}`]));
      await env.CACHE.put(`dev:cname:alias.${chained}`, JSON.stringify(['cdn.example.net']));
      await data<SendingDomain>(await add(owner, channelId, chained, 'link'), 201);
      const looped = `loop-${crypto.randomUUID().slice(0, 8)}.example.com`;
      await env.CACHE.put(`dev:cname:${looped}`, JSON.stringify([`alias.${looped}`]));
      await env.CACHE.put(`dev:cname:alias.${looped}`, JSON.stringify([looped]));
      await data<SendingDomain>(await add(owner, channelId, looped, 'link'), 201);
      const fresh = `new-${crypto.randomUUID().slice(0, 8)}.example.com`;
      await data<SendingDomain>(await add(owner, channelId, fresh, 'link'), 201);
    });
  });

  it('adds and verifies a link domain', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const domain = await data<SendingDomain>(
      await call('POST', `/api/v1/channels/${channelId}/sending-domains`, {
        cookie: owner.cookie,
        body: { domain: `links-${crypto.randomUUID().slice(0, 6)}.example.com`, kind: 'link' },
      }),
      201,
    );
    expect(domain.records).toEqual([
      expect.objectContaining({ purpose: 'link', type: 'CNAME', value: 'localhost' }),
    ]);
    expect(
      (
        await data<SendingDomain>(
          await call('POST', `/api/v1/sending-domains/${domain.id}/verify`, {
            cookie: owner.cookie,
          }),
        )
      ).status,
    ).toBe('verified');
  });
});

describe('roles and tenancy for Phase 2 routes', () => {
  const ROLES: SeatRole[] = ['viewer', 'author', 'editor', 'admin', 'owner'];
  let owner: Session;
  let outsider: Session;
  const seats = {} as Record<SeatRole, Session>;
  let ctx: {
    channelId: string;
    dispatchId: string;
    memberId: string;
    domainId: string;
    identityId: string;
    rampId: string;
    broadcastId: string;
  };

  beforeAll(async () => {
    owner = await signIn();
    seats.owner = owner;
    for (const role of ['viewer', 'author', 'editor', 'admin'] as const)
      seats[role] = await seatAs(owner.workspaceId, role);
    outsider = await signIn();
    const { id: channelId } = await createChannel(owner);
    const member = await addMember(owner, channelId);
    const dispatch = await newDispatch(owner, channelId);
    const sent = await newDispatch(owner, channelId);
    const { broadcastId } = await data<{ broadcastId: string }>(
      await call('POST', `/api/v1/dispatches/${sent.id}/send`, { cookie: owner.cookie }),
      202,
    );
    const domain = await data<SendingDomain>(
      await call('POST', `/api/v1/channels/${channelId}/sending-domains`, {
        cookie: owner.cookie,
        body: { domain: `t-${crypto.randomUUID().slice(0, 8)}.example.com`, kind: 'email' },
      }),
      201,
    );
    const identity = await data<SenderIdentity>(
      await call('POST', `/api/v1/channels/${channelId}/sender-identities`, {
        cookie: owner.cookie,
        body: { fromName: 'N', fromLocal: 'n', sendingDomainId: null },
      }),
      201,
    );
    const ramps = await data<Ramp[]>(
      await call('GET', `/api/v1/channels/${channelId}/ramps`, { cookie: owner.cookie }),
    );
    ctx = {
      channelId,
      dispatchId: dispatch.id,
      memberId: member.id,
      domainId: domain.id,
      identityId: identity.id,
      rampId: ramps[0]!.id,
      broadcastId,
    };
  });

  const ROUTES: { name: string; minimum: SeatRole; request: (s: Session) => Promise<Response> }[] =
    [
      {
        name: 'list members',
        minimum: 'viewer',
        request: (s) =>
          call('GET', `/api/v1/channels/${ctx.channelId}/members`, { cookie: s.cookie }),
      },
      {
        name: 'add member',
        minimum: 'editor',
        request: (s) =>
          call('POST', `/api/v1/channels/${ctx.channelId}/members`, {
            cookie: s.cookie,
            body: { email: uniqueEmail('m') },
          }),
      },
      {
        name: 'list dispatches',
        minimum: 'viewer',
        request: (s) =>
          call('GET', `/api/v1/channels/${ctx.channelId}/dispatches`, { cookie: s.cookie }),
      },
      {
        name: 'read dispatch',
        minimum: 'viewer',
        request: (s) => call('GET', `/api/v1/dispatches/${ctx.dispatchId}`, { cookie: s.cookie }),
      },
      {
        name: 'create dispatch',
        minimum: 'author',
        request: (s) =>
          call('POST', `/api/v1/channels/${ctx.channelId}/dispatches`, {
            cookie: s.cookie,
            body: {},
          }),
      },
      {
        // The owner's Dispatch: an author may save only their own (see below).
        name: 'save dispatch',
        minimum: 'editor',
        request: (s) =>
          call('PATCH', `/api/v1/dispatches/${ctx.dispatchId}`, {
            cookie: s.cookie,
            body: { subject: 'Saved' },
          }),
      },
      {
        name: 'revisions',
        minimum: 'viewer',
        request: (s) =>
          call('GET', `/api/v1/dispatches/${ctx.dispatchId}/revisions`, { cookie: s.cookie }),
      },
      {
        name: 'preflight',
        minimum: 'viewer',
        request: (s) =>
          call('GET', `/api/v1/dispatches/${ctx.dispatchId}/preflight`, { cookie: s.cookie }),
      },
      {
        name: 'list broadcasts',
        minimum: 'viewer',
        request: (s) =>
          call('GET', `/api/v1/channels/${ctx.channelId}/broadcasts`, { cookie: s.cookie }),
      },
      {
        name: 'broadcast stats',
        minimum: 'viewer',
        request: (s) =>
          call('GET', `/api/v1/broadcasts/${ctx.broadcastId}/stats`, { cookie: s.cookie }),
      },
      {
        name: 'list domains',
        minimum: 'viewer',
        request: (s) =>
          call('GET', `/api/v1/channels/${ctx.channelId}/sending-domains`, { cookie: s.cookie }),
      },
      {
        name: 'verify domain',
        minimum: 'admin',
        request: (s) =>
          call('POST', `/api/v1/sending-domains/${ctx.domainId}/verify`, { cookie: s.cookie }),
      },
      {
        name: 'list senders',
        minimum: 'viewer',
        request: (s) =>
          call('GET', `/api/v1/channels/${ctx.channelId}/sender-identities`, { cookie: s.cookie }),
      },
      {
        name: 'update sender',
        minimum: 'admin',
        request: (s) =>
          call('PATCH', `/api/v1/sender-identities/${ctx.identityId}`, {
            cookie: s.cookie,
            body: { fromName: 'Renamed' },
          }),
      },
      {
        name: 'list ramps',
        minimum: 'viewer',
        request: (s) =>
          call('GET', `/api/v1/channels/${ctx.channelId}/ramps`, { cookie: s.cookie }),
      },
      {
        name: 'tune ramp',
        minimum: 'admin',
        request: (s) =>
          call('PATCH', `/api/v1/ramps/${ctx.rampId}`, { cookie: s.cookie, body: { growth: 1.3 } }),
      },
    ];

  for (const route of ROUTES) {
    for (const role of ROLES) {
      const allowed = ROLES.indexOf(role) >= ROLES.indexOf(route.minimum);
      it(`${route.name}: ${role} is ${allowed ? 'allowed' : 'refused'}`, async () => {
        const res = await route.request(seats[role]);
        if (allowed) expect(res.status, await res.clone().text()).toBeLessThan(300);
        else expect(res.status).toBe(403);
      });
    }
    it(`${route.name}: another workspace's operator gets 404`, async () => {
      expect((await route.request(outsider)).status).toBe(404);
    });
  }

  it('hides other workspaces’ rows behind 404 for writes too', async () => {
    for (const [method, path, body] of [
      ['POST', `/api/v1/dispatches/${ctx.dispatchId}/send`, undefined],
      ['POST', `/api/v1/dispatches/${ctx.dispatchId}/test`, {}],
      ['POST', `/api/v1/broadcasts/${ctx.broadcastId}/cancel`, undefined],
      ['DELETE', `/api/v1/members/${ctx.memberId}`, undefined],
      ['DELETE', `/api/v1/sending-domains/${ctx.domainId}`, undefined],
      ['DELETE', `/api/v1/sender-identities/${ctx.identityId}`, undefined],
    ] as const) {
      const res = await call(method, path, { cookie: outsider.cookie, ...(body ? { body } : {}) });
      expect(res.status, path).toBe(404);
    }
  });

  it('only lets editors and above send', async () => {
    const res = await call('POST', `/api/v1/dispatches/${ctx.dispatchId}/send`, {
      cookie: seats.author.cookie,
    });
    expect(res.status).toBe(403);
  });

  it('lets an author work on their own Dispatches only', async () => {
    const author = seats.author;
    const own = await newDispatch(author, ctx.channelId);
    const revisions = await data<{ id: string }[]>(
      await call('GET', `/api/v1/dispatches/${own.id}/revisions`, { cookie: author.cookie }),
    );
    const theirs = await newDispatch(seats.editor, ctx.channelId);
    const theirRevisions = await data<{ id: string }[]>(
      await call('GET', `/api/v1/dispatches/${theirs.id}/revisions`, { cookie: author.cookie }),
    );
    const actions = (id: string, revisionId: string) =>
      [
        ['PATCH', `/api/v1/dispatches/${id}`, { subject: 'Mine now' }],
        ['POST', `/api/v1/dispatches/${id}/revisions`, { name: 'Checkpoint' }],
        ['POST', `/api/v1/dispatches/${id}/revisions/${revisionId}/restore`, undefined],
        ['POST', `/api/v1/dispatches/${id}/test`, {}],
        ['POST', `/api/v1/dispatches/${id}/save-as-template`, { name: 'Copy' }],
      ] as const;
    for (const [method, path, body] of actions(theirs.id, theirRevisions[0]!.id)) {
      const res = await call(method, path, { cookie: author.cookie, ...(body ? { body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // Reading someone else's Dispatch is still fine; changing your own is too.
    expect(
      (await call('GET', `/api/v1/dispatches/${theirs.id}`, { cookie: author.cookie })).status,
    ).toBe(200);
    for (const [method, path, body] of actions(own.id, revisions[0]!.id)) {
      const res = await call(method, path, { cookie: author.cookie, ...(body ? { body } : {}) });
      expect([403, 404], `${method} ${path}: ${await res.clone().text()}`).not.toContain(
        res.status,
      );
    }
    // Editors and up are not limited to their own.
    const edited = await call('PATCH', `/api/v1/dispatches/${own.id}`, {
      cookie: seats.editor.cookie,
      body: { subject: 'Edited by an editor' },
    });
    expect(edited.status).toBe(200);
  });
});

describe('an author changing what an editor scheduled or published', () => {
  type Saved = Dispatch & { unscheduled?: boolean; takenOffSite?: boolean };
  let owner: Session;
  let author: Session;
  let editor: Session;
  let channelId: string;

  beforeAll(async () => {
    owner = await signIn();
    author = await seatAs(owner.workspaceId, 'author');
    editor = await seatAs(owner.workspaceId, 'editor');
    channelId = (await createChannel(owner)).id;
    await addMember(owner, channelId);
  });

  const at = () => new Date(Date.now() + 3600_000).toISOString();
  async function scheduled(by = author) {
    const dispatch = await newDispatch(by, channelId);
    const publishAt = at();
    await data(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/schedule`, {
        cookie: editor.cookie,
        body: { publishAt },
      }),
    );
    return { ...dispatch, publishAt };
  }
  const audits = async (dispatchId: string, action: string) =>
    (
      await env.DB.prepare(
        'SELECT actor_operator_id, metadata_json FROM audit_events WHERE target_id = ?1 AND action = ?2',
      )
        .bind(dispatchId, action)
        .all<{ actor_operator_id: string; metadata_json: string }>()
    ).results;

  it('regression: takes a scheduled Dispatch back to draft when its author saves a change', async () => {
    for (const body of [
      { subject: 'Changed after scheduling' },
      { audience: { include: [], exclude: [] } },
    ]) {
      const dispatch = await scheduled();
      const saved = await data<Saved>(
        await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, { cookie: author.cookie, body }),
      );
      expect(saved, JSON.stringify(body)).toMatchObject({
        status: 'draft',
        publishAt: null,
        unscheduled: true,
      });
      const [entry] = await audits(dispatch.id, 'dispatch.unscheduled');
      expect(entry?.actor_operator_id).toBe(author.me.operator.id);
      expect(JSON.parse(entry!.metadata_json)).toMatchObject({ reason: 'changed_by_author' });
    }
  });

  it('regression: takes a scheduled Dispatch back to draft when its author restores a revision', async () => {
    const dispatch = await scheduled();
    const [revision] = await data<DispatchRevision[]>(
      await call('GET', `/api/v1/dispatches/${dispatch.id}/revisions`, { cookie: author.cookie }),
    );
    const restored = await data<Saved>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/revisions/${revision!.id}/restore`, {
        cookie: author.cookie,
      }),
    );
    expect(restored).toMatchObject({ status: 'draft', publishAt: null, unscheduled: true });
    expect(await audits(dispatch.id, 'dispatch.unscheduled')).toHaveLength(1);
  });

  it('keeps the schedule when an editor saves, or the author changes only the team note', async () => {
    const dispatch = await scheduled();
    const byEditor = await data<Saved>(
      await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
        cookie: editor.cookie,
        body: { subject: 'Edited by an editor' },
      }),
    );
    expect(byEditor).toMatchObject({ status: 'scheduled', publishAt: dispatch.publishAt });
    expect(byEditor.unscheduled).toBeUndefined();
    const note = await data<Saved>(
      await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
        cookie: author.cookie,
        body: { internalNote: 'Ready when you are' },
      }),
    );
    expect(note).toMatchObject({ status: 'scheduled', publishAt: dispatch.publishAt });
    expect(await audits(dispatch.id, 'dispatch.unscheduled')).toHaveLength(0);
  });

  it('regression: takes a post an editor put on the site off it when its author changes the text', async () => {
    const dispatch = await newDispatch(author, channelId);
    const published = await data<Saved>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/publish-web`, {
        cookie: editor.cookie,
      }),
    );
    expect(published.onSite).toBe(true);
    // The audience is not on the page, so it leaves the post where it is.
    const audience = await data<Saved>(
      await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
        cookie: author.cookie,
        body: { audience: { include: [], exclude: [] } },
      }),
    );
    expect(audience.onSite).toBe(true);
    const saved = await data<Saved>(
      await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
        cookie: author.cookie,
        body: { content: doc('Rewritten after publishing') },
      }),
    );
    expect(saved).toMatchObject({ onSite: false, takenOffSite: true, status: 'draft' });
    const search = await env.DB.prepare('SELECT 1 FROM dispatch_search WHERE dispatch_id = ?1')
      .bind(dispatch.id)
      .first();
    expect(search).toBeNull();
    expect(await audits(dispatch.id, 'dispatch.taken_off_site')).toHaveLength(1);
    // An editor puts it back, and their own edits leave it there.
    await data(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/publish-web`, {
        cookie: editor.cookie,
      }),
    );
    const byEditor = await data<Saved>(
      await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
        cookie: editor.cookie,
        body: { content: doc('Edited by an editor') },
      }),
    );
    expect(byEditor.onSite).toBe(true);
  });
});

describe('Idempotency-Key on dashboard writes', () => {
  it('replays a retried write and refuses the key for a different one', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const create = (subject: string, cookie = owner.cookie) =>
      call('POST', `/api/v1/channels/${channelId}/dispatches`, {
        cookie,
        body: { subject, content: doc('Hi') },
        headers: { 'idempotency-key': 'create-issue-1' },
      });
    const first = await create('Issue 1');
    expect(first.status).toBe(201);
    const again = await create('Issue 1');
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect((await json<{ data: Dispatch }>(again)).data.id).toBe(
      (await json<{ data: Dispatch }>(first)).data.id,
    );
    expect((await create('Issue 2')).status).toBe(409);

    // Keys belong to one operator: a teammate's same key is a new request.
    const editor = await seatAs(owner.workspaceId, 'editor');
    const theirs = await create('Issue 1', editor.cookie);
    expect(theirs.status).toBe(201);
    expect(theirs.headers.get('idempotent-replayed')).toBeNull();
  });
});

describe('env', () => {
  it('refuses the dev mailbox and dev DNS outside development', async () => {
    const { parseApiEnv } = await import('../src/env');
    const base = { ...env, ENVIRONMENT: 'production', APP_ORIGIN: 'https://app.example' };
    expect(() => parseApiEnv({ ...base })).toThrow(/MAIL_ADAPTER|DNS_RESOLVER|LINK_HOSTNAMES/);
    expect(() =>
      parseApiEnv({ ...base, MAIL_ADAPTER: 'ses', DNS_RESOLVER: 'doh', LINK_HOSTNAMES: 'off' }),
    ).toThrow(/AWS_ACCESS_KEY_ID/);
  });

  it('accepts Resend with a key and a Resend region, and no SES settings', async () => {
    const { parseApiEnv } = await import('../src/env');
    // Test env: the other dev fakes stay allowed; only the mail rules are under test.
    const base = {
      ...env,
      MAIL_ADAPTER: 'resend',
      AWS_REGION: 'eu-west-1',
    };
    expect(() => parseApiEnv({ ...base })).toThrow(/RESEND_API_KEY/);
    expect(() =>
      parseApiEnv({ ...base, RESEND_API_KEY: 're_123456789', AWS_REGION: 'us-west-2' }),
    ).toThrow(/AWS_REGION/);
    const parsed = parseApiEnv({ ...base, RESEND_API_KEY: 're_123456789' });
    expect(parsed.MAIL_ADAPTER).toBe('resend');
    expect(parsed.SES_DIRECT_CONFIGURATION_SET).toBeUndefined();
    expect(parsed.SES_EVENT_TOPIC_ARN).toBeUndefined();
  });
});
