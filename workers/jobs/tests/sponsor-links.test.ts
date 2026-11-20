// Sponsor report links after the link cutover: the 365-day ones from before end 90 days after it,
// so each sponsor whose booking still runs or ran within 90 days before it is emailed a new one,
// once, signed for the site with the api's and jobs' key.
import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { runSponsorLinkReissue } from '../src/handlers/sponsor-links';
import { jobsEnv, seedChannel } from './helpers';
import { testLinks } from './links';

const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function booking(
  channelId: string,
  input: { runOn: string; status?: string; createdAt: number; email?: string },
) {
  const now = Date.now();
  const slot = newId('sponsorSlot', now);
  const id = newId('sponsorBooking', now);
  const email = input.email ?? `sponsor-${crypto.randomUUID().slice(0, 8)}@acme.example`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sponsor_slots (id, channel_id, name, amount, currency) VALUES (?1, ?2, 'Top', 100, 'usd')`,
    ).bind(slot, channelId),
    env.DB.prepare(
      `INSERT INTO sponsor_bookings (id, channel_id, slot_id, run_on, sponsor_name, sponsor_email,
         ad_title, ad_url, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'Acme', ?5, 'Try Acme', 'https://acme.example/', ?6, ?7, ?7)`,
    ).bind(id, channelId, slot, input.runOn, email, input.status ?? 'accepted', input.createdAt),
  ]);
  return { id, email };
}

async function reportMails(to: string) {
  const listing = await env.DEV_MAILBOX.list({ prefix: 'mail/', include: ['customMetadata'] });
  const keys = listing.objects
    .filter((o) => o.customMetadata?.to === to && o.customMetadata?.category === 'sponsor_report')
    .map((o) => o.key);
  return Promise.all(
    keys.map(async (key) => (await env.DEV_MAILBOX.get(key))!.json<{ text: string }>()),
  );
}

describe('sponsor report links after the cutover', () => {
  it('emails a new link once to each sponsor whose report would end early, and nobody else', async () => {
    const { env: jobs } = jobsEnv();
    const cutoff = Number(env.LINK_LEGACY_CUTOFF);
    const { channelId } = await seedChannel();
    const before = cutoff - 400 * DAY;
    const running = await booking(channelId, { runOn: day(cutoff + 10 * DAY), createdAt: before });
    const recent = await booking(channelId, { runOn: day(cutoff - 30 * DAY), createdAt: before });
    // Ran more than 90 days before the cutover, never ran, or made after it (its link is new).
    const old = await booking(channelId, { runOn: day(cutoff - 120 * DAY), createdAt: before });
    const declined = await booking(channelId, {
      runOn: day(cutoff + 5 * DAY),
      status: 'declined',
      createdAt: before,
    });
    const fresh = await booking(channelId, { runOn: day(cutoff + 5 * DAY), createdAt: cutoff + 1 });

    await runSponsorLinkReissue(jobs, Date.now());
    for (const sent of [running, recent]) {
      const mails = await reportMails(sent.email);
      expect(mails, sent.email).toHaveLength(1);
      const token = /\/_swarm\/sponsor\/report\/([A-Za-z0-9._-]+)/.exec(mails[0]!.text)![1]!;
      expect(await testLinks().verify('sponsor-report', token)).toMatchObject({
        ok: true,
        payload: { b: sent.id, c: channelId },
      });
      expect(mails[0]!.text).toContain('stops working on');
    }
    for (const skipped of [old, declined, fresh]) {
      expect(await reportMails(skipped.email), skipped.email).toHaveLength(0);
    }

    // Once each: the next run mails nobody again.
    await runSponsorLinkReissue(jobs, Date.now() + 60_000);
    expect(await reportMails(running.email)).toHaveLength(1);
    expect(await reportMails(recent.email)).toHaveLength(1);
  });

  it('does nothing before the cutover, nor once the old links have ended anyway', async () => {
    const cutoff = Number(env.LINK_LEGACY_CUTOFF);
    const { channelId } = await seedChannel();
    const due = await booking(channelId, {
      runOn: day(cutoff + DAY),
      createdAt: cutoff - 10 * DAY,
    });
    const v1 = jobsEnv().env;
    await runSponsorLinkReissue(
      { ...v1, LINK_SIGNING_MODE: 'v1', LINK_LEGACY_CUTOFF: undefined } as typeof v1,
      Date.now(),
    );
    expect(await reportMails(due.email)).toHaveLength(0);
    await runSponsorLinkReissue(v1, cutoff + 90 * DAY);
    expect(await reportMails(due.email)).toHaveLength(0);
  });
});
