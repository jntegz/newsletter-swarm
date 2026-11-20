// "Don't track my opens and clicks" in subscriber settings (docs/privacy-controls.md).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { memberTokenFor } from './links';
import { addMember, call, mailTo, nextIp, ORIGIN, seedChannel, uniqueEmail } from './helpers';

async function activeMember() {
  const channel = await seedChannel();
  const email = uniqueEmail();
  const id = await addMember(channel.channelId, email, 'active');
  return {
    channel,
    email,
    id,
    path: `/m/${await memberTokenFor(id)}`,
    emailed: `/m/${await memberTokenFor(id, undefined, { emailed: true })}`,
  };
}

function post(path: string, values: string[], origin: string | null = ORIGIN) {
  const body = new URLSearchParams({ action: 'tracking' });
  for (const value of values) body.append('tracking', value);
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

const optedOut = async (id: string) =>
  (await env.DB.prepare('SELECT tracking_opt_out_at FROM members WHERE id = ?1')
    .bind(id)
    .first<{ tracking_opt_out_at: number | null }>())!.tracking_opt_out_at;

describe('the tracking choice', () => {
  it('is offered, unticked, on the page', async () => {
    const { path } = await activeMember();
    const html = await (await call(path)).text();
    expect(html).toContain('<h2>Tracking</h2>');
    expect(html).toContain('name="tracking" value="off">');
    expect(html).toContain('Don’t track my opens and clicks');
  });

  it('needs a fresh link to turn tracking off, since that deletes the history', async () => {
    const { id, email, path } = await activeMember();
    await env.DB.prepare(
      `INSERT INTO member_engagement (member_id, channel_id, band, sent_count, opened_count, clicked_count, computed_at)
       SELECT ?1, channel_id, 'engaged', 3, 2, 1, ?2 FROM members WHERE id = ?1`,
    )
      .bind(id, Date.now())
      .run();
    const res = await post(path, ['on', 'off']);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Turning tracking off needs a fresh link.');
    expect(await optedOut(id)).toBeNull();
    const kept = await env.DB.prepare(
      'SELECT count(*) AS n FROM member_engagement WHERE member_id = ?1',
    )
      .bind(id)
      .first<{ n: number }>();
    expect(kept?.n).toBe(1);
    expect((await mailTo(email)).map((m) => m.category)).toEqual(['member_center']);
  });

  it('is saved on a POST from the page, and can be undone', async () => {
    const { id, email, emailed: path } = await activeMember();
    const res = await post(path, ['on', 'off']);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${path}?saved=tracking`);
    expect(await optedOut(id)).not.toBeNull();
    const html = await (await call(`${path}?saved=tracking`)).text();
    expect(html).toContain('Your choice is saved.');
    expect(html).toContain('name="tracking" value="off" checked>');
    expect(html).toContain('We deleted the opens and clicks we had recorded for you.');

    expect((await post(path, ['on'])).status).toBe(303);
    expect(await optedOut(id)).toBeNull();
    // Each change is mailed to the address.
    const notices = (await mailTo(email)).filter((m) => m.category === 'member_change');
    expect(notices.map((m) => m.text.includes('turned off'))).toContain(true);
    expect(notices.map((m) => m.text.includes('turned back on'))).toContain(true);
  });

  it('changes nothing on a GET or from another site', async () => {
    const { id, path } = await activeMember();
    await call(`${path}?action=tracking&tracking=off`);
    expect(await optedOut(id)).toBeNull();
    const res = await post(path, ['on', 'off'], 'https://evil.example');
    expect(res.status).toBe(404);
    expect(await optedOut(id)).toBeNull();
  });
});
