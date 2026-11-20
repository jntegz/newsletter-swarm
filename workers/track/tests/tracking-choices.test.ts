// What the tracking worker may record (docs/privacy-controls.md): nothing for someone who asked not
// to be tracked, for a kind of tracking the publication turned off, or for a delivery that no longer
// names anyone. Links keep redirecting either way.
import { SELF, env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import {
  MAX_CLICK_ROWS_PER_LINK,
  MAX_OPEN_ROWS_PER_DELIVERY,
  recordClick,
  recordOpen,
  trackToken,
} from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';

const trackKeys = parseKeyring(env.TRACK_KEYS);
const chrome =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const signals = {
  method: 'GET',
  userAgent: chrome,
  asn: 64500,
  asOrganization: null,
  ip: '203.0.113.7',
};

async function seed(settings: Record<string, unknown> = {}) {
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
      `INSERT INTO channels (id, workspace_id, slug, name, settings_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Field Notes', ?4, ?5, ?5)`,
    ).bind(
      ids.channel,
      ids.workspace,
      `ch-${crypto.randomUUID().slice(0, 8)}`,
      JSON.stringify(settings),
      now,
    ),
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
      `INSERT INTO link_targets (id, broadcast_id, url, position) VALUES (?1, ?2, 'https://essay.example/read', 0)`,
    ).bind(ids.link, ids.broadcast),
    env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, 'sent', ?6)`,
    ).bind(ids.delivery, ids.broadcast, ids.channel, ids.member, email, now - 600_000),
  ]);
  return ids;
}

const recorded = async (deliveryId: string) => {
  const row = await env.DB.prepare(
    `SELECT (SELECT count(*) FROM opens WHERE delivery_id = ?1) AS opens,
            (SELECT count(*) FROM clicks WHERE delivery_id = ?1) AS clicks,
            (SELECT opened_at FROM deliveries WHERE id = ?1) AS opened_at`,
  )
    .bind(deliveryId)
    .first<{ opens: number; clicks: number; opened_at: number | null }>();
  return row!;
};

const click = (s: Awaited<ReturnType<typeof seed>>) =>
  recordClick(
    env.DB,
    { deliveryId: s.delivery, linkTargetId: s.link, broadcastId: s.broadcast, sentAt: 0 },
    signals,
  );

describe('recording opens and clicks', () => {
  it('records both by default', async () => {
    const s = await seed();
    expect(await recordOpen(env.DB, s.delivery, signals)).toBe('human');
    expect(await click(s)).toBe('human');
    expect(await recorded(s.delivery)).toMatchObject({ opens: 1, clicks: 1 });
  });

  it('records nothing for someone who asked not to be tracked, and still redirects', async () => {
    const s = await seed();
    await env.DB.prepare('UPDATE members SET tracking_opt_out_at = ?1 WHERE id = ?2')
      .bind(Date.now(), s.member)
      .run();
    expect(await recordOpen(env.DB, s.delivery, signals)).toBeNull();
    expect(await click(s)).toBeNull();
    expect(await recorded(s.delivery)).toEqual({ opens: 0, clicks: 0, opened_at: null });
    const token = await trackToken(trackKeys, { d: s.delivery, l: s.link });
    const res = await SELF.fetch(`https://link.swarm.test/c/${token}`, {
      redirect: 'manual',
      headers: { 'user-agent': chrome },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://essay.example/read');
  });

  it('follows what the publication tracks now, for emails already sent', async () => {
    const noOpens = await seed({ trackOpens: false });
    expect(await recordOpen(env.DB, noOpens.delivery, signals)).toBeNull();
    expect(await click(noOpens)).toBe('human');
    const noClicks = await seed({ trackClicks: false });
    expect(await click(noClicks)).toBeNull();
    expect(await recordOpen(env.DB, noClicks.delivery, signals)).toBe('human');
  });

  it('records nothing for a delivery that no longer names anyone', async () => {
    const s = await seed();
    await env.DB.prepare("UPDATE deliveries SET member_id = NULL, email = 'erased' WHERE id = ?1")
      .bind(s.delivery)
      .run();
    expect(await recordOpen(env.DB, s.delivery, signals)).toBeNull();
    expect(await click(s)).toBeNull();
  });
});

describe('replaying one tracked link', () => {
  const at = (s: Awaited<ReturnType<typeof seed>>, now: number, ua = signals) =>
    recordClick(
      env.DB,
      { deliveryId: s.delivery, linkTargetId: s.link, broadcastId: s.broadcast, sentAt: 0 },
      ua,
      now,
    );
  const events = async (memberId: string) =>
    (await env.DB.prepare(
      `SELECT count(*) AS n FROM member_events WHERE member_id = ?1 AND type = 'link_clicked'`,
    )
      .bind(memberId)
      .first<{ n: number }>())!.n;

  it('stores a bounded number of rows and one link_clicked event, whatever the hits', async () => {
    const s = await seed();
    const start = Date.now();
    // Human-looking hits two seconds apart, then HEAD (bot) hits.
    for (let i = 0; i < MAX_CLICK_ROWS_PER_LINK + 5; i++) await at(s, start + i * 2000);
    for (let i = 0; i < 5; i++) {
      await at(s, start + 100_000 + i * 2000, { ...signals, method: 'HEAD' });
    }
    expect((await recorded(s.delivery)).clicks).toBe(MAX_CLICK_ROWS_PER_LINK);
    expect(await events(s.member)).toBe(1);
    for (let i = 0; i < MAX_OPEN_ROWS_PER_DELIVERY + 5; i++) {
      await recordOpen(env.DB, s.delivery, signals, start + i * 1000);
    }
    expect((await recorded(s.delivery)).opens).toBe(MAX_OPEN_ROWS_PER_DELIVERY);
  });

  it('classifies hits in the same second as scanners, even when they arrive together', async () => {
    const s = await seed();
    const now = Date.now();
    const results = await Promise.all([at(s, now), at(s, now + 1), at(s, now + 2), at(s, now + 3)]);
    expect(results.filter((r) => r === 'human')).toHaveLength(1);
    const human = await env.DB.prepare(
      `SELECT count(*) AS n FROM clicks WHERE delivery_id = ?1 AND classification = 'human'`,
    )
      .bind(s.delivery)
      .first<{ n: number }>();
    expect(human?.n).toBe(1);
    expect(await events(s.member)).toBe(1);
  });
});
