import { SELF, env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { anonymiseExpiredEngagement, trackToken, unsubscribeCode } from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';

const trackKeys = parseKeyring(env.TRACK_KEYS);
const unsubscribeKeys = parseKeyring(env.UNSUBSCRIBE_KEYS);

async function seed(sentAgoMs = 60_000) {
  const now = Date.now();
  const ids = {
    workspace: newId('workspace'),
    channel: newId('channel'),
    member: newId('member'),
    dispatch: newId('dispatch'),
    broadcast: newId('broadcast'),
    delivery: newId('delivery'),
    link: newId('linkTarget'),
  };
  const email = `reader-${crypto.randomUUID().slice(0, 8)}@example.org`;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
    ).bind(ids.workspace, 'W', now),
    env.DB.prepare(
      `INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, 'Field Notes', ?4, ?4)`,
    ).bind(ids.channel, ids.workspace, `ch-${crypto.randomUUID().slice(0, 8)}`, now),
    env.DB.prepare(
      `INSERT INTO members (id, channel_id, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)`,
    ).bind(ids.member, ids.channel, email, now),
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at) VALUES (?1, ?2, 'S', '{"type":"doc","content":[]}', 'sent', ?3, ?3)`,
    ).bind(ids.dispatch, ids.channel, now),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text, from_name, from_address, track_opens, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'S', '', '', '', 'F', 'f@mail.swarm.test', 1, ?5, ?5)`,
    ).bind(ids.broadcast, ids.dispatch, ids.channel, ids.workspace, now),
    env.DB.prepare(
      `INSERT INTO link_targets (id, broadcast_id, url, position) VALUES (?1, ?2, 'https://essay.example/read?a=1', 0)`,
    ).bind(ids.link, ids.broadcast),
    env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, 'sent', ?6)`,
    ).bind(ids.delivery, ids.broadcast, ids.channel, ids.member, email, now - sentAgoMs),
  ]);
  return { ...ids, email };
}

const fetchTrack = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://link.swarm.test${path}`, { redirect: 'manual', ...init });

/** Recording runs in waitUntil, after the response; poll briefly for it. */
async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return read();
}

const chrome =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

describe('clicks', () => {
  it('redirects to the stored target and records a human click with a truncated IP', async () => {
    const s = await seed();
    const token = await trackToken(trackKeys, { d: s.delivery, l: s.link });
    const res = await fetchTrack(`/c/${token}`, {
      headers: { 'user-agent': chrome, 'cf-connecting-ip': '203.0.113.77' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://essay.example/read?a=1');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const click = await eventually(
      () =>
        env.DB.prepare(
          'SELECT classification, ip_prefix, ua_family FROM clicks WHERE delivery_id = ?1',
        )
          .bind(s.delivery)
          .first<{ classification: string; ip_prefix: string; ua_family: string }>(),
      (row) => row !== null,
    );
    expect(click).toEqual({
      classification: 'human',
      ip_prefix: '203.0.113.0/24',
      ua_family: 'chrome',
    });
    const delivery = await env.DB.prepare(
      'SELECT human_clicked_at, human_opened_at FROM deliveries WHERE id = ?1',
    )
      .bind(s.delivery)
      .first<Record<string, number | null>>();
    expect(delivery?.human_clicked_at).not.toBeNull();
    expect(delivery?.human_opened_at).not.toBeNull();
  });

  it('marks a click right after delivery as a scanner, and HEAD as a bot, without dropping them', async () => {
    const s = await seed(500);
    const token = await trackToken(trackKeys, { d: s.delivery, l: s.link });
    expect((await fetchTrack(`/c/${token}`, { headers: { 'user-agent': chrome } })).status).toBe(
      302,
    );
    expect(
      (await fetchTrack(`/c/${token}`, { method: 'HEAD', headers: { 'user-agent': chrome } }))
        .status,
    ).toBe(302);
    const rows = await eventually(
      async () =>
        (
          await env.DB.prepare(
            'SELECT classification FROM clicks WHERE delivery_id = ?1 ORDER BY created_at',
          )
            .bind(s.delivery)
            .all<{ classification: string }>()
        ).results,
      (r) => r.length === 2,
    );
    expect(rows.map((r) => r.classification).sort()).toEqual(['bot', 'scanner']);
    const delivery = await env.DB.prepare('SELECT human_clicked_at FROM deliveries WHERE id = ?1')
      .bind(s.delivery)
      .first<{ human_clicked_at: number | null }>();
    expect(delivery?.human_clicked_at).toBeNull();
  });

  it('redirects on a publication’s link domain only for that publication’s emails', async () => {
    const ours = await seed();
    const theirs = await seed();
    const domain = `links-${crypto.randomUUID().slice(0, 8)}.example.net`;
    await env.DB.prepare(
      `INSERT INTO sending_domains (id, workspace_id, channel_id, domain, kind, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'link', 'verified', ?5, ?5)`,
    )
      .bind(newId('sendingDomain'), theirs.workspace, theirs.channel, domain, Date.now())
      .run();
    const on = (host: string, token: string) =>
      SELF.fetch(`https://${host}/c/${token}`, {
        redirect: 'manual',
        headers: { 'user-agent': chrome },
      });
    const foreign = await trackToken(trackKeys, { d: ours.delivery, l: ours.link });
    // Another workspace's token on this publication's branded domain: no redirect.
    const refused = await on(domain, foreign);
    expect(refused.status).toBe(404);
    expect(refused.headers.get('location')).toBeNull();
    // Its own token there, and any token on the shared link host, still redirect.
    const own = await trackToken(trackKeys, { d: theirs.delivery, l: theirs.link });
    expect((await on(domain, own)).status).toBe(302);
    expect((await on('link.swarm.test', foreign)).status).toBe(302);
  });

  it('never redirects on a bad token or a link from another Broadcast', async () => {
    const s = await seed();
    const other = await seed();
    const token = await trackToken(trackKeys, { d: s.delivery, l: s.link });
    for (const path of [
      `/c/${token.slice(0, -3)}abc`,
      `/c/${await trackToken(trackKeys, { d: s.delivery, l: other.link })}`,
      `/c/${await trackToken(trackKeys, { d: s.delivery })}`,
      '/c/https%3A%2F%2Fevil.example',
      `/c/${await trackToken(parseKeyring(`zz:${'z'.repeat(40)}`), { d: s.delivery, l: s.link })}`,
    ]) {
      const res = await fetchTrack(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('location'), path).toBeNull();
      expect(await res.text()).toContain('This link does not work');
    }
  });
});

describe('opens', () => {
  it('returns an uncached GIF and records the open', async () => {
    const s = await seed();
    const token = await trackToken(trackKeys, { d: s.delivery });
    const res = await fetchTrack(`/o/${token}`, {
      headers: { 'user-agent': chrome, 'cf-connecting-ip': '2001:db8:1234:5678::1' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 6))).toBe('GIF89a');
    const open = await eventually(
      () =>
        env.DB.prepare('SELECT classification, ip_prefix FROM opens WHERE delivery_id = ?1')
          .bind(s.delivery)
          .first<{ classification: string; ip_prefix: string }>(),
      (row) => row !== null,
    );
    expect(open).toEqual({ classification: 'human', ip_prefix: '2001:db8:1234::/48' });
  });

  it('still returns a pixel for a bad token', async () => {
    const res = await fetchTrack('/o/nonsense');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
  });
});

describe('unsubscribe', () => {
  const status = async (memberId: string) =>
    (
      await env.DB.prepare('SELECT status FROM members WHERE id = ?1')
        .bind(memberId)
        .first<{ status: string }>()
    )?.status;

  it('shows a confirm page on GET without changing anything', async () => {
    const s = await seed();
    const code = await unsubscribeCode(unsubscribeKeys, s.delivery);
    const res = await fetchTrack(`/u/${code}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form method="post">');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await status(s.member)).toBe('active');
  });

  it('unsubscribes on the RFC 8058 One-Click POST', async () => {
    const s = await seed();
    const code = await unsubscribeCode(unsubscribeKeys, s.delivery);
    const res = await fetchTrack(`/u/${code}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(res.status).toBe(200);
    expect(await status(s.member)).toBe('unsubscribed');
    const delivery = await env.DB.prepare('SELECT unsubscribed_at FROM deliveries WHERE id = ?1')
      .bind(s.delivery)
      .first<{ unsubscribed_at: number | null }>();
    expect(delivery?.unsubscribed_at).not.toBeNull();
    // Idempotent.
    expect(
      (await fetchTrack(`/u/${code}`, { method: 'POST', body: 'List-Unsubscribe=One-Click' }))
        .status,
    ).toBe(200);
  });

  it('confirms in the browser after the form POST', async () => {
    const s = await seed();
    const code = await unsubscribeCode(unsubscribeKeys, s.delivery);
    const res = await fetchTrack(`/u/${code}`, { method: 'POST' });
    const html = await res.text();
    expect(html).toContain('You are unsubscribed');
    expect(html).toContain('Field Notes');
    // Anyone with a forwarded copy holds the code: the answer never shows whose address it was.
    expect(html).not.toContain(s.email);
    expect(await status(s.member)).toBe('unsubscribed');
  });

  it('still unsubscribes from an email past engagement retention', async () => {
    const s = await seed(14 * 2_629_746_000);
    await anonymiseExpiredEngagement(env.DB, Date.now());
    const delivery = await env.DB.prepare('SELECT member_id FROM deliveries WHERE id = ?1')
      .bind(s.delivery)
      .first<{ member_id: string | null }>();
    expect(delivery?.member_id).toBeNull();
    const code = await unsubscribeCode(unsubscribeKeys, s.delivery);
    expect(await (await fetchTrack(`/u/${code}`)).text()).toContain('<form method="post">');
    const res = await fetchTrack(`/u/${code}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(res.status).toBe(200);
    expect(await status(s.member)).toBe('unsubscribed');
  });

  it('offers no dead button once an old email no longer finds anyone', async () => {
    const s = await seed(14 * 2_629_746_000);
    await anonymiseExpiredEngagement(env.DB, Date.now());
    // The withdrawal reference has run out (or the person was deleted).
    await env.DB.prepare('DELETE FROM unsubscribe_refs WHERE delivery_id = ?1')
      .bind(s.delivery)
      .run();
    const code = await unsubscribeCode(unsubscribeKeys, s.delivery);
    const page = await fetchTrack(`/u/${code}`);
    expect(page.status).toBe(410);
    const html = await page.text();
    expect(html).not.toContain('<form');
    expect(html).toContain('Manage your subscription');
    const oneClick = await fetchTrack(`/u/${code}`, {
      method: 'POST',
      body: 'List-Unsubscribe=One-Click',
    });
    // Not reported as done, because nothing was.
    expect(oneClick.status).toBe(410);
    expect(await status(s.member)).toBe('active');
  });

  it('refuses a forged code', async () => {
    const s = await seed();
    const code = await unsubscribeCode(unsubscribeKeys, s.delivery);
    const forged = code.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    expect(
      (await fetchTrack(`/u/${forged}`, { method: 'POST', body: 'List-Unsubscribe=One-Click' }))
        .status,
    ).toBe(404);
    expect(await status(s.member)).toBe('active');
  });
});
