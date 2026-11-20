// Partner Exchange and Sponsor Match on the site: flags, safe redirects, counting, and bookings.
import { env } from 'cloudflare:test';
import { signSponsorReport } from '@swarm/engine';
import { signToken } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import { cutoff, legacyKeys, testLinks } from './links';
import { createSite, mountSite } from '../src/index';
import { BROWSER_UA, call, nextIp, seedChannel, uniqueEmail, type SeededChannel } from './helpers';
import { turnstile } from './turnstile';

const hex = () => crypto.randomUUID().replace(/-/g, '');
const site = createSite((s) => mountSite(s));

async function flag(ch: SeededChannel, key: string) {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, ?2, 'channel', ?3, 1, 0)`,
  )
    .bind(`ff_${hex()}`, key, ch.channelId)
    .run();
}

async function addPick(ch: SeededChannel, url = 'https://partner.example/news?x=1') {
  const id = `pc_${hex()}`;
  await env.DB.prepare(
    `INSERT INTO partner_picks (id, channel_id, name, description, url, created_at, updated_at)
     VALUES (?1, ?2, '<Partner>', 'Good reads', ?3, 0, 0)`,
  )
    .bind(id, ch.channelId, url)
    .run();
  return id;
}

const clicks = async (id: string) =>
  env.DB.prepare('SELECT site_clicks, signup_clicks FROM partner_picks WHERE id = ?1')
    .bind(id)
    .first<{ site_clicks: number; signup_clicks: number }>();

const browser = { headers: { 'user-agent': BROWSER_UA } };

describe('partner picks', () => {
  it('are hidden while the flag is off', async () => {
    const ch = await seedChannel();
    const id = await addPick(ch);
    expect((await call(site, `${ch.origin}/partners`)).status).toBe(404);
    expect((await call(site, `${ch.origin}/_swarm/partner/${id}`, browser)).status).toBe(404);
    expect(await (await call(site, `${ch.origin}/`)).text()).not.toContain('Partner');
  });

  it('show on the page and homepage, escaped, and only where asked', async () => {
    const ch = await seedChannel();
    await flag(ch, 'partner_exchange');
    const id = await addPick(ch);
    const page = await (await call(site, `${ch.origin}/partners`)).text();
    expect(page).toContain('&lt;Partner&gt;');
    expect(page).toContain(`/_swarm/partner/${id}?from=site`);
    expect(await (await call(site, `${ch.origin}/`)).text()).toContain('Publications we recommend');
    const quiet = await seedChannel();
    await flag(quiet, 'partner_exchange');
    const hidden = await addPick(quiet);
    await env.DB.prepare('UPDATE partner_picks SET on_site = 0 WHERE id = ?1').bind(hidden).run();
    expect(await (await call(site, `${quiet.origin}/partners`)).text()).not.toContain(
      '&lt;Partner',
    );
  });

  it('count a person’s click by where it came from, not a bot’s, and tag the link', async () => {
    const ch = await seedChannel();
    await flag(ch, 'partner_exchange');
    const id = await addPick(ch);
    const res = await call(site, `${ch.origin}/_swarm/partner/${id}?from=signup`, browser);
    expect(res.status).toBe(302);
    const target = new URL(res.headers.get('location')!);
    expect(target.origin).toBe('https://partner.example');
    expect(target.searchParams.get('x')).toBe('1');
    expect(target.searchParams.get('utm_medium')).toBe('partner_exchange');
    expect(await clicks(id)).toEqual({ site_clicks: 0, signup_clicks: 1 });
    await call(site, `${ch.origin}/_swarm/partner/${id}`, {
      headers: { 'user-agent': 'Googlebot/2.1' },
    });
    expect(await clicks(id)).toEqual({ site_clicks: 0, signup_clicks: 1 });
  });

  it('won’t lead through another publication’s address', async () => {
    const ch = await seedChannel();
    const other = await seedChannel();
    await flag(ch, 'partner_exchange');
    await flag(other, 'partner_exchange');
    const id = await addPick(other);
    const res = await call(site, `${ch.origin}/_swarm/partner/${id}`, browser);
    expect(res.status).toBe(404);
  });
});

interface Sponsor extends SeededChannel {
  slotId: string;
}

async function seedSponsor(accepting = true): Promise<Sponsor> {
  const ch = await seedChannel();
  await flag(ch, 'sponsor_match');
  const slotId = `sl_${hex()}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sponsor_settings (channel_id, accepting, headline, pitch, updated_at) VALUES (?1, ?2, 'Reach our readers', '', 0)`,
    ).bind(ch.channelId, accepting ? 1 : 0),
    env.DB.prepare(
      `INSERT INTO sponsor_slots (id, channel_id, name, amount, currency) VALUES (?1, ?2, 'Top of post', 25000, 'usd')`,
    ).bind(slotId, ch.channelId),
  ]);
  return { ...ch, slotId };
}

const FUTURE = '2099-01-15';
const request = (ch: Sponsor, over: Record<string, string> = {}) => {
  turnstile.pass = true;
  turnstile.action = 'sponsor';
  return call(site, `${ch.origin}/_swarm/sponsor`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ch.origin,
      'user-agent': BROWSER_UA,
      'cf-connecting-ip': nextIp(),
    },
    body: new URLSearchParams({
      slotId: ch.slotId,
      runOn: FUTURE,
      sponsorName: 'Acme',
      sponsorEmail: uniqueEmail('sponsor'),
      adTitle: 'Try Acme',
      adBody: 'It works.',
      adUrl: 'https://acme.example/',
      'cf-turnstile-response': 'ok',
      ...over,
    }).toString(),
  });
};

const bookings = (ch: Sponsor) =>
  env.DB.prepare('SELECT id, status FROM sponsor_bookings WHERE channel_id = ?1')
    .bind(ch.channelId)
    .all<{ id: string; status: string }>()
    .then((r) => r.results);

describe('the sponsor page', () => {
  it('is hidden with the flag off, or when not taking bookings', async () => {
    const off = await seedChannel();
    expect((await call(site, `${off.origin}/sponsor`)).status).toBe(404);
    const closed = await seedSponsor(false);
    expect((await call(site, `${closed.origin}/sponsor`)).status).toBe(404);
    expect((await request(closed)).status).toBe(404);
  });

  it('shows what’s on offer and allows the bot check', async () => {
    const ch = await seedSponsor();
    const res = await call(site, `${ch.origin}/sponsor`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Reach our readers');
    expect(html).toContain('$250');
    expect(res.headers.get('content-security-policy')).toContain('challenges.cloudflare.com');
  });

  it('takes a request, which runs nothing until accepted', async () => {
    const ch = await seedSponsor();
    expect((await request(ch)).status).toBe(200);
    const [booking] = await bookings(ch);
    expect(booking?.status).toBe('requested');
    const res = await call(site, `${ch.origin}/_swarm/sponsored/${booking!.id}`, browser);
    expect(res.headers.get('location')).not.toContain('acme.example');
  });

  it('refuses a bad link, a past date, a failed bot check and another publication’s slot', async () => {
    const ch = await seedSponsor();
    for (const adUrl of ['http://acme.example/', 'javascript:alert(1)', 'nonsense']) {
      expect((await request(ch, { adUrl })).status).toBe(400);
    }
    expect((await request(ch, { runOn: '2020-01-01' })).status).toBe(400);
    expect((await request(ch, { runOn: '2099-02-31' })).status).toBe(400);
    const other = await seedSponsor();
    expect((await request(ch, { slotId: other.slotId })).status).toBe(404);
    const blocked = request(ch);
    turnstile.pass = false;
    expect((await blocked).status).toBe(403);
    turnstile.pass = true;
    expect(await bookings(ch)).toEqual([]);
  });

  it('refuses a day that is already taken', async () => {
    const ch = await seedSponsor();
    await request(ch);
    const [booking] = await bookings(ch);
    await env.DB.prepare(`UPDATE sponsor_bookings SET status = 'accepted' WHERE id = ?1`)
      .bind(booking!.id)
      .run();
    expect((await request(ch)).status).toBe(409);
    expect((await request(ch, { runOn: '2099-01-16' })).status).toBe(200);
  });

  it('counts clicks once accepted, and shows them on the sponsor’s own report', async () => {
    const ch = await seedSponsor();
    await request(ch);
    const [booking] = await bookings(ch);
    await env.DB.prepare(`UPDATE sponsor_bookings SET status = 'accepted' WHERE id = ?1`)
      .bind(booking!.id)
      .run();
    const res = await call(site, `${ch.origin}/_swarm/sponsored/${booking!.id}`, browser);
    expect(res.headers.get('location')).toBe('https://acme.example/');
    await call(site, `${ch.origin}/_swarm/sponsored/${booking!.id}`, {
      headers: { 'user-agent': 'Googlebot/2.1' },
    });
    const token = await signSponsorReport(testLinks(), {
      bookingId: booking!.id,
      channelId: ch.channelId,
    });
    const report = await (await call(site, `${ch.origin}/_swarm/sponsor/report/${token}`)).text();
    expect(report).toContain('<strong>1</strong> click by people');
    expect((await call(site, `${ch.origin}/_swarm/sponsor/report/nonsense`)).status).toBe(404);
    const other = await seedSponsor();
    expect((await call(site, `${other.origin}/_swarm/sponsor/report/${token}`)).status).toBe(404);
    // Naming another Channel, even with this booking's id, opens nothing.
    const elsewhere = await signSponsorReport(testLinks(), {
      bookingId: booking!.id,
      channelId: other.channelId,
    });
    expect((await call(site, `${ch.origin}/_swarm/sponsor/report/${elsewhere}`)).status).toBe(404);
    // A year-long link from before the cutover still opens, for 90 days from it.
    const old = await signToken(
      legacyKeys(),
      'sponsor-report',
      { b: booking!.id },
      { expiresInSeconds: 365 * 86_400, now: cutoff() - 200 * 86_400_000 },
    );
    expect((await call(site, `${ch.origin}/_swarm/sponsor/report/${old}`)).status).toBe(200);
  });
});
