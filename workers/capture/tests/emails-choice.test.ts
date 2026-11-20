// "Stop emails, keep my membership" in subscriber settings (security review
// S03-P5-G-paid-mail-choice): a mail choice apart from the status and paid access.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { memberTokenFor } from './links';
import { addMember, call, mailTo, nextIp, ORIGIN, seedChannel, uniqueEmail } from './helpers';

/** An active subscriber with a paid subscription and a signed-in browser on the website. */
async function payingMember() {
  const channel = await seedChannel();
  const email = uniqueEmail();
  const id = await addMember(channel.channelId, email, 'active');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at)
       VALUES (?1, ?2, 'paid', 'comp', ?3)`,
    ).bind(id, channel.channelId, now),
    env.DB.prepare(
      `INSERT INTO reader_sessions (id_hash, member_id, channel_id, created_at, last_seen_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5)`,
    ).bind(`h-${crypto.randomUUID()}`, id, channel.channelId, now, now + 86_400_000),
  ]);
  // The footer link every email carries: this is enough, since it only reduces mail.
  return { channel, email, id, path: `/m/${await memberTokenFor(id)}` };
}

const act = (path: string, action: string) =>
  call(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cf-connecting-ip': nextIp(),
      origin: ORIGIN,
    },
    body: new URLSearchParams({ action }).toString(),
  });

const state = (id: string) =>
  env.DB.prepare(
    `SELECT m.status, m.emails_off_at,
            (SELECT count(*) FROM member_entitlements me WHERE me.member_id = m.id) AS paid,
            (SELECT count(*) FROM reader_sessions rs WHERE rs.member_id = m.id) AS sessions
       FROM members m WHERE m.id = ?1`,
  )
    .bind(id)
    .first<{ status: string; emails_off_at: number | null; paid: number; sessions: number }>();

describe('stop emails, keep my membership', () => {
  it('is offered next to unsubscribing', async () => {
    const { path } = await payingMember();
    const html = await (await call(path)).text();
    expect(html).toContain('<h2>Stop emails, keep my membership</h2>');
    expect(html).toContain('name="action" value="emails_off"');
    expect(html).toContain('any paid subscription continues');
  });

  it('turns emails off with one click from a footer link, keeping status, paid access and sign-in', async () => {
    const { id, email, path } = await payingMember();
    const res = await act(path, 'emails_off');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${path}?saved=emails_off`);
    const after = await state(id);
    expect(after).toMatchObject({ status: 'active', paid: 1, sessions: 1 });
    expect(after?.emails_off_at).not.toBeNull();
    const html = await (await call(`${path}?saved=emails_off`)).text();
    expect(html).toContain('Emails are off. Your subscription stays as it is.');
    expect(html).toContain('name="action" value="emails_on"');
    // The address hears about it, with a way back: the notice is transactional.
    expect((await mailTo(email)).map((m) => m.category)).toContain('member_change');
  });

  it('turns emails back on', async () => {
    const { id, path } = await payingMember();
    await act(path, 'emails_off');
    const res = await act(path, 'emails_on');
    expect(res.status).toBe(303);
    expect(await state(id)).toMatchObject({ status: 'active', emails_off_at: null, paid: 1 });
    // Asking twice changes nothing more.
    expect((await act(path, 'emails_on')).status).toBe(409);
  });

  it('is not open to someone who is unsubscribed', async () => {
    const channel = await seedChannel();
    const id = await addMember(channel.channelId, uniqueEmail(), 'unsubscribed');
    const path = `/m/${await memberTokenFor(id)}`;
    expect((await act(path, 'emails_off')).status).toBe(409);
    expect((await state(id))?.emails_off_at).toBeNull();
  });
});
