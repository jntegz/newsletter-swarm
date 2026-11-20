// Unsubscribe links of a Roster-targeted Broadcast (Phase 8, flag rosters; docs/rosters.md):
// the page offers leaving the Rosters or everything, and One-Click leaves the Rosters only.
import { SELF, env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { unsubscribeCode } from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';

const unsubscribeKeys = parseKeyring(env.UNSUBSCRIBE_KEYS);

async function seed(flag = true) {
  const now = Date.now();
  const ids = {
    workspace: newId('workspace'),
    channel: newId('channel'),
    member: newId('member'),
    dispatch: newId('dispatch'),
    broadcast: newId('broadcast'),
    delivery: newId('delivery'),
    roster: newId('roster'),
    other: newId('roster'),
  };
  const email = `reader-${crypto.randomUUID().slice(0, 8)}@example.org`;
  const audience = { include: [], exclude: [], rosters: { include: [ids.roster], exclude: [] } };
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
    ).bind(ids.workspace, 'W', now),
    env.DB.prepare(
      `INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, 'Field Notes', ?4, ?4)`,
    ).bind(ids.channel, ids.workspace, `ch-${crypto.randomUUID().slice(0, 8)}`, now),
    env.DB.prepare(
      `INSERT INTO members (id, channel_id, email, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', ?4, ?4)`,
    ).bind(ids.member, ids.channel, email, now),
    env.DB.prepare(
      `INSERT INTO rosters (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, 'Deals & offers', ?3, ?3), (?4, ?2, 'Events', ?3, ?3)`,
    ).bind(ids.roster, ids.channel, now, ids.other),
    env.DB.prepare(
      `INSERT INTO roster_members (roster_id, member_id, status, source, subscribed_at, created_at, updated_at)
       VALUES (?1, ?3, 'subscribed', 'form', ?4, ?4, ?4), (?2, ?3, 'subscribed', 'form', ?4, ?4, ?4)`,
    ).bind(ids.roster, ids.other, ids.member, now),
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at) VALUES (?1, ?2, 'S', '{"type":"doc","content":[]}', 'sent', ?3, ?3)`,
    ).bind(ids.dispatch, ids.channel, now),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text, from_name, from_address, track_opens, audience_json, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'S', '', '', '', 'F', 'f@mail.swarm.test', 1, ?5, ?6, ?6)`,
    ).bind(ids.broadcast, ids.dispatch, ids.channel, ids.workspace, JSON.stringify(audience), now),
    env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, 'sent', ?6)`,
    ).bind(ids.delivery, ids.broadcast, ids.channel, ids.member, email, now),
    ...(flag
      ? [
          env.DB.prepare(
            `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, 'rosters', 'channel', ?2, 1, 0)`,
          ).bind(newId('featureFlag'), ids.channel),
        ]
      : []),
  ]);
  return { ...ids, code: await unsubscribeCode(unsubscribeKeys, ids.delivery) };
}

const fetchTrack = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://link.swarm.test${path}`, { redirect: 'manual', ...init });

const memberStatus = async (id: string) =>
  (await env.DB.prepare('SELECT status FROM members WHERE id = ?1')
    .bind(id)
    .first<{ status: string }>())!.status;

async function rosterStatus(rosterId: string, memberId: string) {
  const row = await env.DB.prepare(
    'SELECT status, source FROM roster_members WHERE roster_id = ?1 AND member_id = ?2',
  )
    .bind(rosterId, memberId)
    .first<{ status: string; source: string }>();
  return row && [row.status, row.source];
}

describe('unsubscribing from a Roster-targeted Broadcast', () => {
  it('shows a page that names the Roster and offers leaving everything, changing nothing', async () => {
    const s = await seed();
    const res = await fetchTrack(`/u/${s.code}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Leave the Roster “Deals &amp; offers”');
    expect(html).toContain('<input type="hidden" name="scope" value="all">');
    expect(await rosterStatus(s.roster, s.member)).toEqual(['subscribed', 'form']);
  });

  it('leaves only the Roster on the RFC 8058 One-Click POST', async () => {
    const s = await seed();
    const res = await fetchTrack(`/u/${s.code}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(res.status).toBe(200);
    expect(await memberStatus(s.member)).toBe('active');
    expect(await rosterStatus(s.roster, s.member)).toEqual(['unsubscribed', 'unsubscribe']);
    expect(await rosterStatus(s.other, s.member)).toEqual(['subscribed', 'form']);
    const event = await env.DB.prepare(
      "SELECT payload_json FROM member_events WHERE member_id = ?1 AND type = 'roster_left'",
    )
      .bind(s.member)
      .first<{ payload_json: string }>();
    expect(JSON.parse(event!.payload_json)).toEqual({ rosterId: s.roster, source: 'unsubscribe' });
  });

  it('leaves everything with scope=all', async () => {
    const s = await seed();
    const left = await fetchTrack(`/u/${s.code}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    expect(await left.text()).toContain('You left the Roster');
    expect(await memberStatus(s.member)).toBe('active');
    const all = await fetchTrack(`/u/${s.code}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'scope=all',
    });
    expect(await all.text()).toContain('You are unsubscribed');
    expect(await memberStatus(s.member)).toBe('unsubscribed');
  });

  it('unsubscribes from the publication when the flag is off', async () => {
    const s = await seed(false);
    const page = await (await fetchTrack(`/u/${s.code}`)).text();
    expect(page).not.toContain('Roster');
    await fetchTrack(`/u/${s.code}`, { method: 'POST', body: 'List-Unsubscribe=One-Click' });
    expect(await memberStatus(s.member)).toBe('unsubscribed');
    expect(await rosterStatus(s.roster, s.member)).toEqual(['subscribed', 'form']);
  });
});
