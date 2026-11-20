import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { memberToken } from '@swarm/engine';
import { parseKeyring, signToken } from '@swarm/tokens';
import { createDownVault, useVaultForTests } from '@swarm/vault';
import { describe, expect, it } from 'vitest';
import { decrypt } from '@swarm/vault/testing';
import { cutoff, legacyKeys, memberTokenFor, testLinks } from './links';
import { installFakeVault } from './vault-fetch';
import {
  addMember,
  call,
  mailTo,
  member,
  nextIp,
  ORIGIN,
  seedChannel,
  uniqueEmail,
} from './helpers';

async function activeMember() {
  const channel = await seedChannel();
  const email = uniqueEmail();
  const id = await addMember(channel.channelId, email, 'active');
  // The link every email's footer carries, sent a minute ago.
  const token = await memberTokenFor(id, Date.now() - 60_000);
  // A link the Member asked for at /m, sent only to the address.
  const emailed = `/m/${await memberTokenFor(id, undefined, { emailed: true })}`;
  return { channel, email, id, path: `/m/${token}`, emailed };
}

/** A Member Center link in the newest mail to `email` with this category. */
async function linkIn(email: string, category: string): Promise<string> {
  const mail = (await mailTo(email)).filter((m) => m.category === category).at(-1);
  const match = /https:\/\/forms\.swarm\.test(\/m\/v2\.member\.[A-Za-z0-9._-]+)/.exec(
    mail?.text ?? '',
  );
  if (!match?.[1]) throw new Error(`no ${category} link for ${email}`);
  return match[1];
}

function post(
  path: string,
  fields: Record<string, string | string[]>,
  origin: string | null = ORIGIN,
) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) body.append(name, v);
  }
  return call(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cf-connecting-ip': nextIp(),
      ...(origin ? { origin } : {}),
    },
    body: body.toString(),
  });
}

describe('Subscriber settings', () => {
  it('shows the subscriber their details on a link emailed on request', async () => {
    const { email, emailed } = await activeMember();
    const res = await call(emailed);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Subscriber settings</h1>');
    expect(html).toContain(`You receive Field Notes at ${email}.`);
    expect(html).toContain('name="firstName"');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('shows a footer link only a summary: a masked address and no profile values', async () => {
    const { channel, email, id, path } = await activeMember();
    const now = Date.now();
    const phone = newId('memberField');
    await env.DB.batch([
      env.DB.prepare('UPDATE members SET first_name = ?1, last_name = ?2 WHERE id = ?3').bind(
        'Grace',
        'Hopper',
        id,
      ),
      env.DB.prepare(
        `INSERT INTO member_fields (id, channel_id, key, label, type, created_at, updated_at)
         VALUES (?1, ?2, 'city', 'City', 'text', ?3, ?3)`,
      ).bind(phone, channel.channelId, now),
      env.DB.prepare(
        `INSERT INTO member_field_values (member_id, field_id, value_text, updated_at) VALUES (?1, ?2, ?3, ?4)`,
      ).bind(id, phone, 'Arlington', now),
    ]);
    const html = await (await call(path)).text();
    expect(html).toContain('<h1>Subscriber settings</h1>');
    expect(html).not.toContain(email);
    expect(html).toContain(`You receive Field Notes at ${email[0]}•••@example.org.`);
    expect(html).not.toContain('Grace');
    expect(html).not.toContain('Hopper');
    expect(html).not.toContain('Arlington');
    expect(html).not.toContain('name="firstName"');
    expect(html).toContain('To see or change your details, open a link we email you.');
  });

  it('turns off older links with a fresh link, and tells the address', async () => {
    const { email, path, emailed } = await activeMember();
    // From a footer link, turning links off needs a fresh link first.
    const asked = await post(path, { action: 'end_links' });
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain('Check your inbox');
    expect((await call(path)).status).toBe(200);

    const res = await post(emailed, { action: 'end_links' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${emailed}?saved=end_links`);
    // The footer link (issued before) stops working for GET and POST; the one in use doesn't.
    expect((await call(path)).status).toBe(404);
    expect((await post(path, { action: 'unsubscribe' })).status).toBe(404);
    expect((await call(emailed)).status).toBe(200);
    // The notice carries a fresh link, which works.
    const fresh = await linkIn(email, 'member_change');
    expect((await call(fresh)).status).toBe(200);
  });

  it('ignores a saved notice that is not one of its own', async () => {
    const { path } = await activeMember();
    for (const saved of ['constructor', 'toString', '__proto__']) {
      const res = await call(`${path}?saved=${saved}`);
      expect(res.status, saved).toBe(200);
    }
  });

  it('pauses for 2, 4 or 8 weeks, and resumes', async () => {
    const { channel, email, path } = await activeMember();
    const before = Date.now();
    const res = await post(path, { action: 'pause', weeks: '4' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${path}?saved=pause`);
    const paused = await member(channel.channelId, email);
    expect(paused!.status).toBe('paused');
    const weeks = (paused!.paused_until! - before) / (7 * 86_400_000);
    expect(weeks).toBeGreaterThan(3.99);
    expect(weeks).toBeLessThan(4.01);
    expect(await (await call(`${path}?saved=pause`)).text()).toContain('Paused until');

    expect((await post(path, { action: 'pause', weeks: '3' })).status).toBe(409);
    expect((await post(path, { action: 'resume' })).status).toBe(303);
    expect(await member(channel.channelId, email)).toMatchObject({
      status: 'active',
      paused_until: null,
    });
  });

  it('hides and refuses the digest choice while the digest flag is off', async () => {
    const { channel, email, path } = await activeMember();
    const html = await (await call(path)).text();
    expect(html).not.toContain('How often you hear from us');
    expect(html).not.toContain('name="digest"');
    expect((await post(path, { action: 'digest', digest: 'weekly' })).status).toBe(409);
    expect((await member(channel.channelId, email))!.digest).toBe('every');
  });

  it('sets the digest frequency when the digest flag is on', async () => {
    const { channel, email, path } = await activeMember();
    await env.DB.prepare(
      `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, 'digest', 'channel', ?2, 1, 0)`,
    )
      .bind(newId('featureFlag'), channel.channelId)
      .run();
    expect(await (await call(path)).text()).toContain('How often you hear from us');
    expect((await post(path, { action: 'digest', digest: 'weekly' })).status).toBe(303);
    expect((await member(channel.channelId, email))!.digest).toBe('weekly');
    expect((await post(path, { action: 'digest', digest: 'hourly' })).status).toBe(409);
    expect((await member(channel.channelId, email))!.digest).toBe('weekly');
  });

  it('unsubscribes with a reason, and offers a confirmed way back', async () => {
    const { channel, email, path } = await activeMember();
    expect((await post(path, { action: 'unsubscribe', reason: 'Too many emails' })).status).toBe(
      303,
    );
    const row = await member(channel.channelId, email);
    expect(row).toMatchObject({ status: 'unsubscribed', unsubscribe_reason: 'Too many emails' });
    const html = await (await call(path)).text();
    expect(html).toContain('is unsubscribed from Field Notes');
    // The address learns of it, with a way back.
    const notices = (await mailTo(email)).filter((m) => m.category === 'member_change');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain('You were unsubscribed');
    expect(notices[0]!.text).toContain('Join again');

    // Rejoining is only ever by confirming from the inbox.
    expect((await post(path, { action: 'rejoin' })).status).toBe(303);
    expect((await member(channel.channelId, email))!.status).toBe('unsubscribed');
    expect(
      (await mailTo(email)).filter((m) => m.category !== 'member_change').map((m) => m.subject),
    ).toEqual(['Welcome back to Field Notes: confirm to rejoin']);
    // And an unsubscribed Member can't pause their way back to active.
    expect((await post(path, { action: 'resume' })).status).toBe(409);
  });

  it('never changes the profile from a footer link: it emails a fresh link instead', async () => {
    const { channel, email, path } = await activeMember();
    const res = await post(path, { action: 'profile', firstName: 'Mallory' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Seeing or changing your details needs a fresh link.');
    expect(html).not.toContain(email);
    expect((await member(channel.channelId, email))!.first_name).toBeNull();
    expect((await mailTo(email)).map((m) => m.category)).toEqual(['member_center']);
  });

  it('lets a reader told they are inactive stay with one click, and says why after removal', async () => {
    const { channel, email, id, path } = await activeMember();
    expect(await (await call(path)).text()).not.toContain('Keep me subscribed');
    // Nothing to keep before a notice.
    expect((await post(path, { action: 'stay' })).status).toBe(409);
    await env.DB.prepare('UPDATE members SET sunset_notice_at = ?1 WHERE id = ?2')
      .bind(Date.now(), id)
      .run();
    expect(await (await call(path)).text()).toContain('Keep me subscribed');
    expect((await post(path, { action: 'stay' })).status).toBe(303);
    const kept = await env.DB.prepare(
      'SELECT status, sunset_notice_at, sunset_kept_at FROM members WHERE id = ?1',
    )
      .bind(id)
      .first<{ status: string; sunset_notice_at: number | null; sunset_kept_at: number | null }>();
    expect(kept).toMatchObject({ status: 'active', sunset_notice_at: null });
    expect(kept!.sunset_kept_at).toBeGreaterThan(0);

    await env.DB.prepare(
      "UPDATE members SET status = 'unsubscribed', unsubscribe_reason = ?1 WHERE id = ?2",
    )
      .bind('Automatic: inactive-reader rule (180 days): 6 emails with an open pixel.', id)
      .run();
    const html = await (await call(path)).text();
    expect(html).toContain('This happened automatically');
    expect(html).toContain('Join again');
    expect((await member(channel.channelId, email))!.status).toBe('unsubscribed');
  });

  it('updates name and profile fields, sealing encrypted ones', async () => {
    const { channel, email, id, emailed: path } = await activeMember();
    const now = Date.now();
    const topics = newId('memberField');
    const phone = newId('memberField');
    const kids = newId('memberField');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO member_fields (id, channel_id, key, label, type, options_json, created_at, updated_at)
         VALUES (?1, ?2, 'topics', 'Topics', 'multi_select', '["Birds","Bees","Trees"]', ?3, ?3)`,
      ).bind(topics, channel.channelId, now),
      env.DB.prepare(
        `INSERT INTO member_fields (id, channel_id, key, label, type, encrypted, created_at, updated_at)
         VALUES (?1, ?2, 'phone', 'Phone', 'text', 1, ?3, ?3)`,
      ).bind(phone, channel.channelId, now),
      env.DB.prepare(
        `INSERT INTO member_fields (id, channel_id, key, label, type, created_at, updated_at)
         VALUES (?1, ?2, 'kids', 'Children', 'number', ?3, ?3)`,
      ).bind(kids, channel.channelId, now),
    ]);

    const res = await post(path, {
      action: 'profile',
      firstName: ' Ada ',
      lastName: '',
      'f.topics': ['', 'trees', 'Birds'],
      'f.phone': '+44 20 7946 0000',
      'f.kids': '2',
    });
    expect(res.status).toBe(303);
    expect((await member(channel.channelId, email))!.first_name).toBe('Ada');
    const values = await env.DB.prepare(
      'SELECT field_id, value_text, value_num, value_enc FROM member_field_values WHERE member_id = ?1',
    )
      .bind(id)
      .all<{
        field_id: string;
        value_text: string | null;
        value_num: number | null;
        value_enc: string | null;
      }>();
    const byField = Object.fromEntries(values.results.map((v) => [v.field_id, v]));
    expect(byField[topics]!.value_text).toBe('["Birds","Trees"]');
    expect(byField[kids]!.value_num).toBe(2);
    expect(byField[phone]!.value_text).toBeNull();
    expect(await decrypt(parseKeyring(env.TEST_FIELD_KEYS), byField[phone]!.value_enc!)).toBe(
      '"+44 20 7946 0000"',
    );

    // The page shows the decrypted value back to its owner.
    expect(await (await call(path)).text()).toContain('value="+44 20 7946 0000"');
    // And the address is told that the details changed.
    const notice = (await mailTo(email)).find((m) => m.category === 'member_change');
    expect(notice?.text).toContain('Your name or profile details were changed.');

    const bad = await post(path, { action: 'profile', 'f.kids': 'two' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('Children: Enter a number.');

    // Clearing a field removes its value.
    await post(path, { action: 'profile', 'f.topics': [''] });
    const left = await env.DB.prepare(
      'SELECT count(*) AS n FROM member_field_values WHERE field_id = ?1',
    )
      .bind(topics)
      .first('n');
    expect(left).toBe(0);
  });

  it('refuses a link that names another Channel than its Member’s (S04-X-TR)', async () => {
    const { channel, email, id } = await activeMember();
    const other = await seedChannel();
    const token = await memberToken(testLinks(), { memberId: id, channelId: other.channelId });
    expect((await call(`/m/${token}`)).status).toBe(404);
    expect((await post(`/m/${token}`, { action: 'unsubscribe' })).status).toBe(404);
    expect((await member(channel.channelId, email))!.status).toBe('active');
  });

  it('opens a footer link from before the cutover for its window, and none made after it', async () => {
    const { id } = await activeMember();
    const v1 = (now: number) =>
      signToken(legacyKeys(), 'member', { m: id }, { expiresInSeconds: 30 * 86_400, now });
    expect((await call(`/m/${await v1(cutoff() - 86_400_000)}`)).status).toBe(200);
    expect((await call(`/m/${await v1(Date.now())}`)).status).toBe(404);
    // A link capture could not have made: one signed with its own HMAC keys in place of send's.
    const forged = await signToken(
      parseKeyring(`t1:${testLinks().secret('CAPTURE_KEYS')}`),
      'member',
      { m: id },
      { expiresInSeconds: 3600 },
    );
    expect((await call(`/m/${forged.replace(/^v1\./, 'v2.')}`)).status).toBe(404);
  });

  it('refuses a cross-site post and an expired or foreign token', async () => {
    const { channel, email, id, path } = await activeMember();
    expect((await post(path, { action: 'unsubscribe' }, 'https://evil.example')).status).toBe(404);
    expect((await member(channel.channelId, email))!.status).toBe('active');
    const old = await memberTokenFor(id, Date.now() - 31 * 86_400_000);
    expect((await call(`/m/${old}`)).status).toBe(404);
    expect((await call('/m/not-a-token')).status).toBe(404);
  });

  it('emails a fresh link on request, answering the same for unknown addresses', async () => {
    const { channel, email } = await activeMember();
    const stranger = uniqueEmail('stranger');
    const ask = (address: string) =>
      post('/m', {
        email: address,
        channel: channel.channelId,
        'cf-turnstile-response': 'token',
      });
    const known = await ask(email);
    const unknown = await ask(stranger);
    expect(known.status).toBe(200);
    expect(await known.text()).toBe(await unknown.text());
    const [mail] = await mailTo(email);
    expect(mail).toMatchObject({ category: 'member_center' });
    expect(mail!.text).toMatch(/https:\/\/forms\.swarm\.test\/m\/v2\.member\./);
    expect(await mailTo(stranger)).toEqual([]);
  });

  it('rate limits link requests per address', async () => {
    const { email } = await activeMember();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await post('/m', { email, 'cf-turnstile-response': 'token' })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(await mailTo(email)).toHaveLength(3);
  });
});

describe('the Member Center with the vault down', () => {
  it('shows a note instead of encrypted fields, and saving one answers 503', async () => {
    const { channel, id, emailed: path } = await activeMember();
    const now = Date.now();
    const phone = newId('memberField');
    await env.DB.prepare(
      `INSERT INTO member_fields (id, channel_id, key, label, type, encrypted, created_at, updated_at)
       VALUES (?1, ?2, 'phone', 'Phone', 'text', 1, ?3, ?3)`,
    )
      .bind(phone, channel.channelId, now)
      .run();
    expect((await post(path, { action: 'profile', 'f.phone': '+44 1' })).status).toBe(303);
    const up = await (await call(path)).text();
    expect(up).toContain('value="+44 1"');
    expect(up).not.toContain('can’t be shown right now');
    useVaultForTests('capture', createDownVault<'capture'>());
    try {
      const shown = await call(path);
      expect(shown.status).toBe(200);
      const html = await shown.text();
      expect(html).not.toContain('+44 1');
      // A note instead of an empty input that a save would clear the value with.
      expect(html).toContain('Some of your details can’t be shown right now.');
      expect(html).not.toContain('name="f.phone"');
      expect(html).toContain('name="firstName"');
      const saved = await post(path, { action: 'profile', 'f.phone': '+44 2' });
      expect(saved.status).toBe(503);
    } finally {
      await installFakeVault();
    }
    const kept = await env.DB.prepare(
      'SELECT value_enc FROM member_field_values WHERE member_id = ?1 AND field_id = ?2',
    )
      .bind(id, phone)
      .first<{ value_enc: string }>();
    expect(await decrypt(parseKeyring(env.TEST_FIELD_KEYS), kept!.value_enc)).toBe('"+44 1"');
  });
});
