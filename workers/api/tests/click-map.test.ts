// The click map: a sent email on its report. Numbers agree with the stats, each email of a send gets
// its own map, old sends with missing data still work, and nothing in the HTML can fire.
import { env } from 'cloudflare:test';
import type { BroadcastClickMap, BroadcastStats } from '@swarm/domain';
import { newId } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, json, seatAs, signIn, type Session } from './helpers';

let owner: Session;
let channelId: string;

const EMAIL = `<!doctype html><html><head><title>x</title></head><body>
  <p>Hi {{ first_name | friend }}</p>
  <a href="{{@link:0}}">Top</a> <a href="{{@link:1}}">Mid</a> <a href="{{@link:0}}">Bottom</a>
  <a href="https://raw.example/">Raw</a>
  <a href="{{@unsubscribe}}">Unsubscribe</a>{{@pixel}}</body></html>`;

interface Options {
  html?: string;
  teaser?: string;
  status?: string;
}

async function seedBroadcast({ html = EMAIL, teaser, status = 'sent' }: Options = {}) {
  const at = Date.now();
  const dispatchId = newId('dispatch');
  const broadcastId = newId('broadcast');
  const links = [newId('linkTarget'), newId('linkTarget')];
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
       VALUES (?1, ?2, 'Issue', '{}', 'sent', ?3, ?3)`,
    ).bind(dispatchId, channelId, at),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text, teaser_html, teaser_text,
         from_name, from_address, track_opens, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'Issue', '', ?6, '', ?7, ?7, 'N', 'n@example.com', 1, ?8, ?8)`,
    ).bind(broadcastId, dispatchId, channelId, owner.workspaceId, status, html, teaser ?? null, at),
    ...links.map((id, position) =>
      env.DB.prepare(
        'INSERT INTO link_targets (id, broadcast_id, url, position) VALUES (?1, ?2, ?3, ?4)',
      ).bind(id, broadcastId, `https://example.com/${position}`, position),
    ),
  ]);
  return { dispatchId, broadcastId, links };
}

/** A reader who got this send, as `variant`, in `version`. Returns their delivery. */
async function reader(
  broadcastId: string,
  { variant = 'full', version = null }: { variant?: string; version?: string | null } = {},
) {
  const at = Date.now();
  const memberId = newId('member');
  const deliveryId = newId('delivery');
  const email = `${memberId}@example.com`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO members (id, channel_id, email, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', ?4, ?4)`,
    ).bind(memberId, channelId, email, at),
    env.DB.prepare(
      `INSERT INTO broadcast_recipients (broadcast_id, member_id, email, status, variant, split_variant_id) VALUES (?1, ?2, ?3, 'sent', ?4, ?5)`,
    ).bind(broadcastId, memberId, email, variant, version),
    env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(deliveryId, broadcastId, channelId, memberId, email, at),
  ]);
  return { memberId, deliveryId };
}

async function click(
  broadcastId: string,
  deliveryId: string,
  linkId: string,
  classification = 'human',
) {
  await env.DB.prepare(
    `INSERT INTO clicks (id, delivery_id, broadcast_id, link_target_id, classification, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(newId('click'), deliveryId, broadcastId, linkId, classification, Date.now())
    .run();
  // As recordClick does: the report's Clicked number reads this.
  if (classification === 'human') {
    await env.DB.prepare(
      'UPDATE deliveries SET human_clicked_at = coalesce(human_clicked_at, ?1) WHERE id = ?2',
    )
      .bind(Date.now(), deliveryId)
      .run();
  }
}

async function clickMap(broadcastId: string) {
  const res = await call('GET', `/api/v1/broadcasts/${broadcastId}/click-map`, {
    cookie: owner.cookie,
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json<{ data: BroadcastClickMap }>(res)).data;
}

async function stats(broadcastId: string) {
  const res = await call('GET', `/api/v1/broadcasts/${broadcastId}/stats`, {
    cookie: owner.cookie,
  });
  return (await json<{ data: BroadcastStats }>(res)).data;
}

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
     VALUES (?1, 'click_map', 'channel', ?2, 1, 1)`,
  )
    .bind(newId('featureFlag'), channelId)
    .run();
});

describe('click map', () => {
  it('is refused while the flag is off', async () => {
    const other = await signIn();
    const { id } = await createChannel(other);
    const dispatchId = newId('dispatch');
    const broadcastId = newId('broadcast');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at) VALUES (?1, ?2, 'I', '{}', 'sent', 1, 1)`,
      ).bind(dispatchId, id),
      env.DB.prepare(
        `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text, from_name, from_address, track_opens, created_at, last_progress_at)
         VALUES (?1, ?2, ?3, ?4, 'sent', 'I', '', '<p>x</p>', '', 'N', 'n@example.com', 1, 1, 1)`,
      ).bind(broadcastId, dispatchId, id, other.workspaceId),
    ]);
    const res = await call('GET', `/api/v1/broadcasts/${broadcastId}/click-map`, {
      cookie: other.cookie,
    });
    expect(res.status).toBe(404);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('feature_disabled');
  });

  it('lets a viewer read it and keeps it from other workspaces', async () => {
    const { broadcastId } = await seedBroadcast();
    const viewer = await seatAs(owner.workspaceId, 'viewer');
    expect(
      (await call('GET', `/api/v1/broadcasts/${broadcastId}/click-map`, { cookie: viewer.cookie }))
        .status,
    ).toBe(200);
    const stranger = await signIn();
    expect(
      (
        await call('GET', `/api/v1/broadcasts/${broadcastId}/click-map`, {
          cookie: stranger.cookie,
        })
      ).status,
    ).toBe(404);
  });

  it('agrees with the links table, counts people once and leaves scanners out', async () => {
    const { broadcastId, links } = await seedBroadcast();
    const a = await reader(broadcastId);
    const b = await reader(broadcastId);
    await click(broadcastId, a.deliveryId, links[0]!);
    await click(broadcastId, a.deliveryId, links[0]!); // The same person again.
    await click(broadcastId, b.deliveryId, links[0]!);
    await click(broadcastId, b.deliveryId, links[1]!);
    await click(broadcastId, b.deliveryId, links[1]!, 'scanner');
    await click(broadcastId, b.deliveryId, links[0]!, 'bot');

    const map = await clickMap(broadcastId);
    const table = await stats(broadcastId);
    expect(map.views).toHaveLength(1);
    const [view] = map.views;
    expect(view).toMatchObject({ label: 'The email', totalPeople: 2, totalClicks: 4 });
    expect(view!.links.map((l) => [l.number, l.people, l.clicks, l.share, l.occurrences])).toEqual([
      [1, 2, 3, 0.75, 2],
      [2, 1, 1, 0.25, 1],
    ]);
    for (const link of view!.links) {
      const row = table.links.find((r) => r.position === link.position)!;
      expect(link.people).toBe(row.humanPeople);
      expect(link.clicks).toBe(row.humanClicks);
      expect(link.url).toBe(row.url);
    }
    // Scanners stay in the table's own column, and never reach the map.
    expect(table.links.find((r) => r.position === 1)!.clicks).toBe(2);
    expect(table.humanClicks).toBe(view!.totalPeople);

    const html = view!.html!;
    expect(html).toContain('#1 · 2 people · 75% · shared count');
    expect(html.match(/shared count/g)).toHaveLength(2);
    expect(html).toContain('#2 · 1 person · 25%');
    expect(html).toContain('Hi friend');
    expect(html).toContain('Not counted');
    expect(view!.uncountedLinks).toBe(1);
    expect(html).not.toContain('{{');
    expect(html).not.toContain('raw.example');
    expect(html).not.toContain('example.com');
    for (const member of [a, b]) expect(html).not.toContain(member.memberId);
    expect(JSON.stringify(map)).not.toContain('@example.com');
    expect(JSON.stringify(map)).not.toContain(a.deliveryId);
  });

  it('shows empty counts before any click, and lists a link with none', async () => {
    const { broadcastId } = await seedBroadcast({ status: 'sending' });
    const [view] = (await clickMap(broadcastId)).views;
    expect(view).toMatchObject({ totalPeople: 0, totalClicks: 0 });
    expect(view!.links.map((l) => [l.people, l.level])).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it('gives the full email and the teaser a map each, adding up to the table', async () => {
    const { broadcastId, links } = await seedBroadcast({
      html: '<a href="{{@link:0}}">Shared</a><a href="{{@link:1}}">Paid only</a>',
      teaser: '<a href="{{@link:0}}">Shared</a>',
    });
    const paid = await reader(broadcastId);
    const free = await reader(broadcastId, { variant: 'teaser' });
    await click(broadcastId, paid.deliveryId, links[0]!);
    await click(broadcastId, paid.deliveryId, links[1]!);
    await click(broadcastId, free.deliveryId, links[0]!);
    await click(broadcastId, free.deliveryId, links[0]!);

    const map = await clickMap(broadcastId);
    expect(map.views.map((v) => v.label)).toEqual(['Full email', 'Teaser']);
    const [full, teaser] = map.views;
    expect(full!.links.map((l) => [l.position, l.people, l.clicks])).toEqual([
      [0, 1, 1],
      [1, 1, 1],
    ]);
    expect(full!.html).toContain('Paid only');
    expect(teaser!.links.map((l) => [l.position, l.people, l.clicks, l.share])).toEqual([
      [0, 1, 2, 1],
    ]);
    expect(teaser!.html).not.toContain('Paid only');
    const table = await stats(broadcastId);
    const row = table.links.find((r) => r.position === 0)!;
    expect(full!.links[0]!.clicks + teaser!.links[0]!.clicks).toBe(row.humanClicks);
    expect(full!.links[0]!.people + teaser!.links[0]!.people).toBe(row.humanPeople);
  });

  async function splitTest(dispatchId: string, broadcastId: string) {
    const testId = newId('splitTest');
    const a = newId('splitTestVariant');
    const b = newId('splitTestVariant');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO split_tests (id, channel_id, dispatch_id, broadcast_id, variable, test_percent, metric, window_minutes, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'content', 50, 'clicks', 60, 'promoted', 1, 1)`,
      ).bind(testId, channelId, dispatchId, broadcastId),
      env.DB.prepare(
        `INSERT INTO split_test_variants (id, split_test_id, label, created_at) VALUES (?1, ?2, 'A', 1)`,
      ).bind(a, testId),
      env.DB.prepare(
        `INSERT INTO split_test_variants (id, split_test_id, label, subject, html, text, created_at)
         VALUES (?1, ?2, 'B', 'Other subject', '<a href="{{@link:1}}">Only B</a>', '', 1)`,
      ).bind(b, testId),
      env.DB.prepare('UPDATE broadcasts SET split_test_id = ?1 WHERE id = ?2').bind(
        testId,
        broadcastId,
      ),
    ]);
    return { testId, a, b };
  }

  it('gives each split test version a map, and says what it can no longer place', async () => {
    const { dispatchId, broadcastId, links } = await seedBroadcast({
      html: '<a href="{{@link:0}}">Only A</a>',
    });
    const { a, b } = await splitTest(dispatchId, broadcastId);
    const inA = await reader(broadcastId, { version: a });
    const inB = await reader(broadcastId, { version: b });
    // Sent before the test was decided or after it was canceled: the Broadcast's own email, A's.
    const noVersion = await reader(broadcastId);
    const gone = await reader(broadcastId, { version: b });
    await click(broadcastId, inA.deliveryId, links[0]!);
    await click(broadcastId, noVersion.deliveryId, links[0]!);
    await click(broadcastId, inB.deliveryId, links[1]!);
    await click(broadcastId, gone.deliveryId, links[1]!);
    // Deleting a Member keeps their Delivery and clicks and drops who they were.
    await env.DB.prepare('DELETE FROM members WHERE id = ?1').bind(gone.memberId).run();

    const map = await clickMap(broadcastId);
    expect(map.views.map((v) => [v.label, v.subject, v.totalPeople])).toEqual([
      ['Version A', 'Issue', 2],
      ['Version B', 'Other subject', 1],
    ]);
    expect(map.views[0]!.html).toContain('Only A');
    expect(map.views[1]!.html).toContain('Only B');
    expect(map.views[0]!.links.map((l) => [l.position, l.people])).toEqual([[0, 2]]);
    expect(map.views[1]!.links.map((l) => [l.position, l.people])).toEqual([[1, 1]]);
    expect(map.unplaced).toEqual({ people: 1, clicks: 1 });
    const table = await stats(broadcastId);
    const sum = map.views.flatMap((v) => v.links).reduce((n, l) => n + l.clicks, 0);
    expect(sum + map.unplaced.clicks).toBe(table.links.reduce((n, l) => n + l.humanClicks, 0));
  });

  it('counts a deleted person in a single-email map, so it still matches the table', async () => {
    const { broadcastId, links } = await seedBroadcast();
    const gone = await reader(broadcastId);
    await click(broadcastId, gone.deliveryId, links[0]!);
    await env.DB.prepare('DELETE FROM members WHERE id = ?1').bind(gone.memberId).run();
    const map = await clickMap(broadcastId);
    expect(map.unplaced).toEqual({ people: 0, clicks: 0 });
    expect(map.views[0]!.links[0]).toMatchObject({ people: 1, clicks: 1 });
    expect((await stats(broadcastId)).links.find((r) => r.position === 0)).toMatchObject({
      humanPeople: 1,
      humanClicks: 1,
    });
  });

  it('still works with no stored copy of the email, and with old HTML', async () => {
    const empty = await seedBroadcast({ html: '' });
    const reader1 = await reader(empty.broadcastId);
    await click(empty.broadcastId, reader1.deliveryId, empty.links[1]!);
    const [view] = (await clickMap(empty.broadcastId)).views;
    expect(view!.html).toBeNull();
    expect(view!.links.map((l) => [l.position, l.clicks, l.occurrences])).toEqual([
      [0, 0, 0],
      [1, 1, 0],
    ]);
    const old = await seedBroadcast({
      html: '<p>An old email with <a href="{{@link:7}}">a link</a>',
    });
    const [oldView] = (await clickMap(old.broadcastId)).views;
    expect(oldView!.uncountedLinks).toBe(1);
    expect(oldView!.html).not.toContain('{{');
  });
});
