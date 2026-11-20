// Partner Exchange and Sponsor Match through the dashboard API: flags, roles and ownership.
import { env } from 'cloudflare:test';
import type { PartnerPick, SponsorBooking, SponsorSettings } from '@swarm/domain';
import { DevMailbox } from '@swarm/mail';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, seatAs, signIn, type Session } from './helpers';
import { testLinks } from './links';
import { data, enableFlag, errorCode } from './money-helpers';

let owner: Session;
let channelId: string;
const picks = (channel = channelId) => `/api/v1/channels/${channel}/partner-picks`;
const settings = (channel = channelId) => `/api/v1/channels/${channel}/sponsor-settings`;
const bookings = (channel = channelId) => `/api/v1/channels/${channel}/sponsor-bookings`;
const hex = () => crypto.randomUUID().replace(/-/g, '');
const slot = { name: 'Top of post', amount: 25000, currency: 'usd' };

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
});

async function addBooking(
  slotId: string,
  runOn = '2099-01-15',
  channel = channelId,
  email = 'ads@acme.example',
) {
  const id = `bk_${hex()}`;
  await env.DB.prepare(
    `INSERT INTO sponsor_bookings (id, channel_id, slot_id, run_on, sponsor_name, sponsor_email, ad_title, ad_url, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'Acme', ?5, 'Try Acme', 'https://acme.example/', 0, 0)`,
  )
    .bind(id, channel, slotId, runOn, email)
    .run();
  return id;
}

describe('partner picks', () => {
  it('are behind their flag', async () => {
    const res = await call('GET', picks(), { cookie: owner.cookie });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('feature_disabled');
    await enableFlag('partner_exchange', owner.workspaceId, channelId);
  });

  it('can be added, changed and removed, and only with a web address', async () => {
    const pick = await data<PartnerPick>(
      await call('POST', picks(), {
        cookie: owner.cookie,
        body: { name: 'Friends', url: 'https://friends.example/' },
      }),
      201,
    );
    expect(pick).toMatchObject({ onSite: true, onSignup: true, siteClicks: 0 });
    const bad = await call('POST', picks(), {
      cookie: owner.cookie,
      body: { name: 'Bad', url: 'javascript:alert(1)' },
    });
    expect(bad.status).toBe(400);
    const changed = await data<PartnerPick>(
      await call('PATCH', `${picks()}/${pick.id}`, {
        cookie: owner.cookie,
        body: { onSite: false },
      }),
    );
    expect(changed).toMatchObject({ onSite: false, onSignup: true, name: 'Friends' });
    const url = `${picks()}/${pick.id}`;
    expect((await call('DELETE', url, { cookie: owner.cookie })).status).toBe(204);
    expect((await call('DELETE', url, { cookie: owner.cookie })).status).toBe(404);
  });

  it('can’t be reached through another publication', async () => {
    const other = await createChannel(owner);
    await enableFlag('partner_exchange', owner.workspaceId, other.id);
    const pick = await data<PartnerPick>(
      await call('POST', picks(other.id), {
        cookie: owner.cookie,
        body: { name: 'Theirs', url: 'https://theirs.example/' },
      }),
      201,
    );
    const res = await call('PATCH', `${picks()}/${pick.id}`, {
      cookie: owner.cookie,
      body: { name: 'Stolen' },
    });
    expect(res.status).toBe(404);
  });
});

describe('sponsors', () => {
  it('is behind its flag', async () => {
    const res = await call('GET', settings(), { cookie: owner.cookie });
    expect(res.status).toBe(404);
    await enableFlag('sponsor_match', owner.workspaceId, channelId);
  });

  it('won’t take bookings without a placement, and keeps a placement’s id', async () => {
    const empty = await call('PUT', settings(), {
      cookie: owner.cookie,
      body: { accepting: true, headline: '', pitch: '', slots: [] },
    });
    expect(empty.status).toBe(400);
    const saved = await data<SponsorSettings>(
      await call('PUT', settings(), {
        cookie: owner.cookie,
        body: { accepting: true, headline: 'Hi', pitch: '', slots: [slot] },
      }),
    );
    expect(saved.url).toContain('/sponsor');
    const again = await data<SponsorSettings>(
      await call('PUT', settings(), {
        cookie: owner.cookie,
        body: {
          accepting: true,
          headline: 'Hi',
          pitch: '',
          slots: [{ ...slot, id: saved.slots[0]!.id, amount: 30000 }],
        },
      }),
    );
    expect(again.slots).toMatchObject([{ id: saved.slots[0]!.id, amount: 30000 }]);
  });

  it('accepts one sponsor per placement and day, with a click link and report', async () => {
    const { slots } = await data<SponsorSettings>(
      await call('GET', settings(), { cookie: owner.cookie }),
    );
    const slotId = slots[0]!.id;
    const first = await addBooking(slotId);
    const second = await addBooking(slotId);
    const accepted = await data<SponsorBooking>(
      await call('PATCH', `${bookings()}/${first}`, {
        cookie: owner.cookie,
        body: { status: 'accepted' },
      }),
    );
    expect(accepted.clickUrl).toContain(`/_swarm/sponsored/${first}`);
    expect(accepted.reportUrl).toContain('/_swarm/sponsor/report/');
    const clash = await call('PATCH', `${bookings()}/${second}`, {
      cookie: owner.cookie,
      body: { status: 'accepted' },
    });
    expect(clash.status).toBe(409);
    const list = await data<{ items: SponsorBooking[] }>(
      await call('GET', bookings(), { cookie: owner.cookie }),
    );
    expect(list.items.map((b) => b.id).sort()).toEqual([first, second].sort());
  });

  it('emails the sponsor a new report link for their Channel, at most every ten minutes', async () => {
    const { slots } = await data<SponsorSettings>(
      await call('GET', settings(), { cookie: owner.cookie }),
    );
    const email = `sponsor-${hex().slice(0, 8)}@acme.example`;
    const id = await addBooking(slots[0]!.id, '2099-03-01', channelId, email);
    const path = `${bookings()}/${id}/report-link`;
    const editor = await seatAs(owner.workspaceId, 'editor');
    expect((await call('POST', path, { cookie: editor.cookie })).status).toBe(403);
    expect(await data<{ sent: true }>(await call('POST', path, { cookie: owner.cookie }))).toEqual({
      sent: true,
    });
    const [mail] = await new DevMailbox(env.DEV_MAILBOX).list({ to: email, limit: 1 });
    expect(mail?.subject).toContain('Your sponsorship report');
    const token = /\/_swarm\/sponsor\/report\/([A-Za-z0-9._-]+)/.exec(mail!.text)![1]!;
    // Signed with the api's key for the site, naming the booking and its Channel, for 90 days.
    const read = await testLinks().verify<{ b: string; c: string }>('sponsor-report', token);
    expect(read).toMatchObject({ ok: true, payload: { b: id, c: channelId } });
    expect(read.ok && read.payload.exp! - read.payload.iat).toBe(90 * 86_400);
    const again = await call('POST', path, { cookie: owner.cookie });
    expect(again.status).toBe(429);
    const missing = await call('POST', `${bookings()}/bk_${hex()}/report-link`, {
      cookie: owner.cookie,
    });
    expect(missing.status).toBe(404);
  });

  it('refuses an ad link that isn’t https, and a booking from elsewhere', async () => {
    const other = await createChannel(owner);
    await enableFlag('sponsor_match', owner.workspaceId, other.id);
    const saved = await data<SponsorSettings>(
      await call('PUT', settings(other.id), {
        cookie: owner.cookie,
        body: { accepting: true, headline: '', pitch: '', slots: [slot] },
      }),
    );
    const theirs = await addBooking(saved.slots[0]!.id, '2099-03-01', other.id);
    const res = await call('PATCH', `${bookings()}/${theirs}`, {
      cookie: owner.cookie,
      body: { status: 'accepted' },
    });
    expect(res.status).toBe(404);
    const insecure = await call('PATCH', `${bookings(other.id)}/${theirs}`, {
      cookie: owner.cookie,
      body: { adUrl: 'javascript:alert(1)' },
    });
    expect(insecure.status).toBe(400);
  });
});
