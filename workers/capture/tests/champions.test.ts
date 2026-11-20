import { env } from 'cloudflare:test';
import { CHAMPION_CODE, newId } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { memberTokenFor } from './links';
import {
  addMember,
  call,
  HOST,
  member,
  nextIp,
  ORIGIN,
  seedChannel,
  seedForm,
  submitForm,
  submitJson,
  uniqueEmail,
} from './helpers';

async function withCode(channelId: string, code: string) {
  const id = await addMember(channelId, uniqueEmail('champion'), 'active');
  await env.DB.prepare('UPDATE members SET champion_code = ?1 WHERE id = ?2').bind(code, id).run();
  return id;
}

async function referralOf(referredId: string) {
  return env.DB.prepare(
    'SELECT referrer_id, status, ip_prefix FROM referrals WHERE referred_id = ?1',
  )
    .bind(referredId)
    .first<{ referrer_id: string; status: string; ip_prefix: string }>();
}

describe('referrals at sign-up', () => {
  it('takes a champion code from the form frame and stores only the /24', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const champion = await withCode(channel.channelId, 'abcd2345');
    const friend = uniqueEmail('friend');
    const res = await submitJson(id, { email: friend, ref: 'ABCD2345' }, { ip: '198.51.100.23' });
    expect(res.status).toBe(200);
    const row = await member(channel.channelId, friend);
    expect(row!.referred_by).toBe(champion);
    expect(JSON.parse(row!.source_json).ref).toBe('abcd2345');
    expect(await referralOf(row!.id)).toEqual({
      referrer_id: champion,
      status: 'pending',
      ip_prefix: '198.51.100.0/24',
    });

    // A code of another Channel, or a malformed one, refers nobody.
    const elsewhere = await seedChannel();
    await withCode(elsewhere.channelId, 'wxyz6789');
    const stranger = uniqueEmail('stranger');
    await submitJson(id, { email: stranger, ref: 'wxyz6789' });
    await submitJson(id, { email: uniqueEmail('odd'), ref: 'not-a-code' });
    expect((await member(channel.channelId, stranger))!.referred_by).toBeNull();
  });

  it('takes the hidden ref input of the site’s no-JS form, through the challenge page', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, { allowedOrigins: [HOST] });
    const champion = await withCode(channel.channelId, 'hjkm2345');
    const email = uniqueEmail();
    const first = await submitForm(id, { email, website: '', ref: 'hjkm2345' });
    const html = await first.text();
    expect(html).toContain('<input type="hidden" name="ref" value="hjkm2345">');
    const challenge = /name="_challenge" value="([^"]+)"/.exec(html)![1]!;
    await submitForm(
      id,
      { email, website: '', ref: 'hjkm2345', _challenge: challenge, 'cf-turnstile-response': 'ok' },
      {
        origin: ORIGIN,
        referer: `${ORIGIN}/v1/${id}/subscribe`,
        'cf-connecting-ip': '2001:db8:9::5',
      },
    );
    const row = await member(channel.channelId, email);
    expect(row!.referred_by).toBe(champion);
    expect((await referralOf(row!.id))!.ip_prefix).toBe('2001:db8:9::/48');
  });
});

describe('Subscriber settings share link', () => {
  async function centerFor(enabled: boolean) {
    const channel = await seedChannel();
    if (enabled) {
      await env.DB.prepare(
        `INSERT INTO champion_settings (channel_id, enabled, share_text, updated_at) VALUES (?1, 1, 'Bring a friend', 0)`,
      )
        .bind(channel.channelId)
        .run();
      await env.DB.prepare(
        `INSERT INTO champion_milestones (id, channel_id, referrals_required, name, created_at, updated_at)
         VALUES (?1, ?2, 3, 'Three friends', 0, 0)`,
      )
        .bind(newId('championMilestone'), channel.channelId)
        .run();
    }
    const id = await addMember(channel.channelId, uniqueEmail(), 'active');
    return { channel, id, path: `/m/${await memberTokenFor(id)}` };
  }

  it('assigns the code on a POST only, then shows the link and progress', async () => {
    const { channel, id, path } = await centerFor(true);
    const before = await (await call(path)).text();
    expect(before).toContain('Get my share link');
    const code = () =>
      env.DB.prepare('SELECT champion_code FROM members WHERE id = ?1')
        .bind(id)
        .first<string>('champion_code');
    expect(await code()).toBeNull();

    const res = await call(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'cf-connecting-ip': nextIp(),
        origin: ORIGIN,
      },
      body: 'action=champion_link',
    });
    expect(res.status).toBe(303);
    const assigned = await code();
    expect(assigned).toMatch(CHAMPION_CODE);

    // One counted referral: two more to the milestone.
    const friend = await addMember(channel.channelId, uniqueEmail('friend'), 'active');
    await env.DB.prepare(
      `INSERT INTO referrals (id, channel_id, referrer_id, referred_id, created_at, status) VALUES (?1, ?2, ?3, ?4, 0, 'counted')`,
    )
      .bind(newId('referral'), channel.channelId, id, friend)
      .run();
    const html = await (await call(`${path}?saved=champion_link`)).text();
    expect(html).toContain(`value="http://${channel.slug}.swarm.test/r/${assigned}"`);
    expect(html).toContain('Bring a friend');
    expect(html).toContain('1 referral counted');
    expect(html).toContain('2 more to reach Three friends.');
  });

  it('shows nothing while referrers is off', async () => {
    const { path } = await centerFor(false);
    expect(await (await call(path)).text()).not.toContain('share link');
  });
});
