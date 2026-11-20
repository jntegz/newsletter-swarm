import { env } from 'cloudflare:test';
import { confirmToken, leaveToken, REMINDER_AFTER_MS } from '@swarm/engine';
import { signToken } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import { legacyKeys, memberTokenFor, testLinks } from './links';
import { remind } from '../src/index';
import {
  addMember,
  call,
  confirmLink,
  daily,
  mailTo,
  member,
  seedChannel,
  seedForm,
  submitJson,
  uniqueEmail,
} from './helpers';

const keys = testLinks();

async function pendingMember() {
  const channel = await seedChannel();
  const form = await seedForm(channel);
  const email = uniqueEmail();
  await submitJson(form.id, { email });
  return { channel, form, email, link: await confirmLink(email) };
}

const requestOf = async (memberId: string) =>
  env.DB.prepare('SELECT * FROM confirm_requests WHERE member_id = ?1 ORDER BY created_at DESC')
    .bind(memberId)
    .first<{
      id: string;
      confirmed_at: number | null;
      reminded_at: number | null;
      last_sent_at: number;
    }>();

describe('confirm opt-in', () => {
  it('shows a Confirm button on GET and changes nothing', async () => {
    const { channel, email, link } = await pendingMember();
    for (let i = 0; i < 3; i++) {
      const res = await call(link);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<form method="post"><button type="submit">Confirm</button></form>');
      expect(res.headers.get('referrer-policy')).toBe('same-origin');
    }
    expect((await member(channel.channelId, email))!.status).toBe('pending');
  });

  it('confirms on POST, once', async () => {
    const { channel, form, email, link } = await pendingMember();
    const res = await call(link, { method: 'POST' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('You are in');
    expect(html).toMatch(/href="https:\/\/forms\.swarm\.test\/m\/v2\.member\./);
    const row = await member(channel.channelId, email);
    expect(row!.status).toBe('active');
    expect(row!.confirmed_at).not.toBeNull();
    expect(await daily(form.id)).toMatchObject({ confirmed: 1 });

    // A replay does nothing more.
    const again = await call(link, { method: 'POST' });
    expect(await again.text()).toContain('This link was already used');
    expect(await daily(form.id)).toMatchObject({ confirmed: 1 });
    expect((await member(channel.channelId, email))!.confirmed_at).toBe(row!.confirmed_at);
  });

  it('never brings back a subscriber who left, bounced or complained after asking', async () => {
    for (const later of ['unsubscribed', 'bounced', 'complained']) {
      const { channel, email, link } = await pendingMember();
      await env.DB.prepare('UPDATE members SET status = ?1 WHERE channel_id = ?2 AND email = ?3')
        .bind(later, channel.channelId, email)
        .run();
      const res = await call(link, { method: 'POST' });
      expect(await res.text()).toContain('This link was already used');
      expect((await member(channel.channelId, email))!.status).toBe(later);
    }
  });

  it('brings an unsubscribed subscriber back only through a "return" request', async () => {
    const channel = await seedChannel();
    const form = await seedForm(channel);
    const email = uniqueEmail();
    const id = await addMember(channel.channelId, email, 'unsubscribed');
    await submitJson(form.id, { email });
    const link = await confirmLink(email);
    expect((await member(channel.channelId, email))!.status).toBe('unsubscribed');
    await call(link, { method: 'POST' });
    expect((await member(channel.channelId, email))!.status).toBe('active');

    // A "subscribe" request can't do it: forge one for this Member and try.
    await env.DB.prepare(`UPDATE members SET status = 'unsubscribed' WHERE id = ?1`).bind(id).run();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO confirm_requests (id, member_id, channel_id, kind, last_sent_at, expires_at, created_at)
       VALUES ('cq_${'a'.repeat(32)}', ?1, ?2, 'subscribe', ?3, ?4, ?3)`,
    )
      .bind(id, channel.channelId, now, now + 86_400_000)
      .run();
    const forged = await confirmToken(
      keys,
      { requestId: `cq_${'a'.repeat(32)}`, channelId: channel.channelId },
      3600,
      now,
    );
    await call(`/v1/confirm/${forged}`, { method: 'POST' });
    expect((await member(channel.channelId, email))!.status).toBe('unsubscribed');
  });

  it('rejects tokens minted for another purpose', async () => {
    const { channel, email } = await pendingMember();
    const row = await member(channel.channelId, email);
    const request = await requestOf(row!.id);
    const asMember = await memberTokenFor(row!.id);
    const asLeave = await leaveToken(keys, { memberId: row!.id, channelId: channel.channelId });
    const asRef = await keys.sign('member-ref', { q: request!.id, c: channel.channelId });
    for (const token of [asMember, asLeave, asRef]) {
      expect((await call(`/v1/confirm/${token}`, { method: 'POST' })).status).toBe(404);
    }
    // And the other way round: a confirm token opens neither the Member Center nor leave.
    const asConfirm = await confirmToken(
      keys,
      { requestId: request!.id, channelId: channel.channelId },
      3600,
      Date.now(),
    );
    expect((await call(`/m/${asConfirm}`)).status).toBe(404);
    expect((await call(`/v1/leave/${asConfirm}`, { method: 'POST' })).status).toBe(404);
    expect((await member(channel.channelId, email))!.status).toBe('pending');
  });

  it('refuses a confirm or leave link that names another Channel', async () => {
    const { channel, email } = await pendingMember();
    const row = await member(channel.channelId, email);
    const request = await requestOf(row!.id);
    const other = await seedChannel();
    const elsewhere = { requestId: request!.id, channelId: other.channelId };
    const confirm = await confirmToken(keys, elsewhere, 3600, Date.now());
    expect((await call(`/v1/confirm/${confirm}`)).status).toBe(404);
    expect((await call(`/v1/confirm/${confirm}`, { method: 'POST' })).status).toBe(404);
    const leave = await leaveToken(keys, { memberId: row!.id, channelId: other.channelId });
    expect((await call(`/v1/leave/${leave}`, { method: 'POST' })).status).toBe(404);
    expect((await member(channel.channelId, email))!.status).toBe('pending');
  });

  it('takes a confirm link from before the cutover, and not one made after it', async () => {
    const { channel, email } = await pendingMember();
    const row = await member(channel.channelId, email);
    const request = await requestOf(row!.id);
    const v1 = (now: number) =>
      signToken(legacyKeys(), 'confirm', { q: request!.id }, { expiresInSeconds: 86_400, now });
    // Signed with MEMBER_KEYS after the cutover: nothing does that any more, so it is forged.
    const late = await v1(Date.now());
    expect((await call(`/v1/confirm/${late}`, { method: 'POST' })).status).toBe(404);
    const early = await v1(Number(env.LINK_LEGACY_CUTOFF) - 60_000);
    expect((await call(`/v1/confirm/${early}`, { method: 'POST' })).status).toBe(200);
    expect((await member(channel.channelId, email))!.status).toBe('active');
  });

  it('refuses an expired confirm link', async () => {
    const { channel, email } = await pendingMember();
    const row = await member(channel.channelId, email);
    const request = await requestOf(row!.id);
    const eightDaysAgo = Date.now() - 8 * 86_400_000;
    const old = await confirmToken(
      keys,
      { requestId: request!.id, channelId: channel.channelId },
      7 * 86_400,
      eightDaysAgo,
    );
    const res = await call(`/v1/confirm/${old}`, { method: 'POST' });
    expect(res.status).toBe(410);
    expect((await member(channel.channelId, email))!.status).toBe('pending');
    expect((await call(`/v1/confirm/${old}`)).status).toBe(410);
  });

  it('lets a pending subscriber leave with one click from the confirmation email', async () => {
    const { channel, email } = await pendingMember();
    const [mail] = await mailTo(email);
    const url = /<([^>]+)>/.exec(mail!.headers!['List-Unsubscribe']!)![1]!;
    const res = await call(new URL(url).pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Unsubscribed');
    const row = await member(channel.channelId, email);
    expect(row!.status).toBe('unsubscribed');
    // No reminder follows.
    await remind(env, Date.now() + REMINDER_AFTER_MS + 60_000);
    expect((await mailTo(email)).map((m) => m.category)).toEqual(['confirm']);
  });
});

describe('Gentle Reminders', () => {
  it('sends one reminder 48 hours after the last send, and only one', async () => {
    const { channel, email } = await pendingMember();
    const row = await member(channel.channelId, email);
    const sentAt = (await requestOf(row!.id))!.last_sent_at;

    // Every other open request in this shared database is aged the same way; count only ours.
    const mine = async () => (await mailTo(email)).filter((m) => m.category === 'confirm_reminder');
    await remind(env, sentAt + REMINDER_AFTER_MS - 60_000);
    expect(await mine()).toHaveLength(0);
    await remind(env, sentAt + REMINDER_AFTER_MS + 1);
    const reminders = await mine();
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.subject).toBe('Reminder: confirm your email for Field Notes');
    expect(reminders[0]!.headers!['List-Unsubscribe']).toContain('/v1/leave/');
    await remind(env, sentAt + 3 * REMINDER_AFTER_MS);
    expect(await mine()).toHaveLength(1);

    // The reminder's link confirms the same request.
    const link = /https:\/\/forms\.swarm\.test(\/v1\/confirm\/[A-Za-z0-9._-]+)/.exec(
      reminders[0]!.text,
    )![1]!;
    await call(link, { method: 'POST' });
    expect((await member(channel.channelId, email))!.status).toBe('active');
  });

  it('skips subscribers who confirmed in the meantime', async () => {
    const { channel, email, link } = await pendingMember();
    await call(link, { method: 'POST' });
    const row = await member(channel.channelId, email);
    const request = await requestOf(row!.id);
    await remind(env, request!.last_sent_at + REMINDER_AFTER_MS + 1);
    expect((await mailTo(email)).filter((m) => m.category === 'confirm_reminder')).toEqual([]);
  });
});
