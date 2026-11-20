// Tracking choices and engagement retention against real D1 (docs/privacy-controls.md): asking not
// to be tracked, the publication switches in the rollup and the inactive-reader cleanup, and the
// retention job. Send report numbers must not move.
import { env } from 'cloudflare:test';
import { newId, type MemberStatus } from '@swarm/domain';
import {
  localMemberLinks,
  MONTH_MS,
  UNSUBSCRIBE_REF_MONTHS,
  anonymiseExpiredEngagement,
  broadcastStats,
  engagementEnabled,
  readMemberEngagement,
  runEngagementRollup,
  setMemberTracking,
  sunsetInactiveMembers,
  unsubscribeDelivery,
  type AudienceDeps,
} from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { addMember, count, one, seedChannel } from './helpers';
import { testLinks } from './links';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 4, 12);

/** The cleanup's mail goes nowhere: these tests read only what it changed. */
const sunsetDeps = (): AudienceDeps => ({
  db: env.DB,
  mail: { send: async () => ({ messageId: 'test' }) },
  links: testLinks(),
  memberLinks: localMemberLinks(testLinks()),
  captureOrigin: 'https://capture.example.test',
  platformMailDomain: 'mail.example.test',
});
let serial = 0;

async function turnOnScores(channelId: string) {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
     VALUES (?1, 'engagement_scores', 'channel', ?2, 1, 0)`,
  )
    .bind(`ff_${crypto.randomUUID().replace(/-/g, '')}`, channelId)
    .run();
}

const setSettings = (channelId: string, settings: Record<string, unknown>) =>
  env.DB.prepare('UPDATE channels SET settings_json = ?1 WHERE id = ?2')
    .bind(JSON.stringify(settings), channelId)
    .run();

async function post(
  world: { channelId: string; workspaceId: string },
  at: number,
  kind: 'broadcast' | 'flow' = 'broadcast',
) {
  const dispatchId = newId('dispatch');
  const id = newId('broadcast');
  const link = newId('linkTarget');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
       VALUES (?1, ?2, 'Post', '{}', 'sent', ?3, ?3)`,
    ).bind(dispatchId, world.channelId, at),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
         from_name, from_address, track_opens, kind, created_at, last_progress_at, completed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'Post', '', '', '', 'A', 'a@example.com', 1, ?6, ?7, ?7, ?8)`,
    ).bind(
      id,
      dispatchId,
      world.channelId,
      world.workspaceId,
      kind === 'flow' ? 'sending' : 'sent',
      kind,
      at,
      kind === 'flow' ? null : at,
    ),
    env.DB.prepare(
      `INSERT INTO link_targets (id, broadcast_id, url, position) VALUES (?1, ?2, 'https://a.example/', 0)`,
    ).bind(link, id),
  ]);
  return { id, link };
}

/** A delivery to the Member, opened and clicked by a person when `engaged`. */
async function deliver(
  world: { channelId: string },
  send: { id: string; link: string },
  memberId: string,
  at: number,
  engaged: boolean,
) {
  const id = newId('delivery');
  const email = (await one<{ email: string }>('SELECT email FROM members WHERE id = ?1', memberId))!
    .email;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, provider_message_id,
         status, sent_at, opened_at, human_opened_at, clicked_at, human_clicked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'delivered', ?7, ?8, ?8, ?8, ?8)`,
    ).bind(
      id,
      send.id,
      world.channelId,
      memberId,
      email,
      `pm-${id}`,
      at,
      engaged ? at + 60_000 : null,
    ),
    env.DB.prepare(
      `INSERT INTO broadcast_recipients (broadcast_id, member_id, email, first_name, status, claimed_at)
       VALUES (?1, ?2, ?3, 'Ada', 'sent', ?4)`,
    ).bind(send.id, memberId, email, at),
    ...(engaged
      ? [
          env.DB.prepare(
            `INSERT INTO opens (id, delivery_id, broadcast_id, classification, ua_family, ip_prefix, asn, created_at)
             VALUES (?1, ?2, ?3, 'human', 'Firefox', '203.0.113.0/24', 64500, ?4)`,
          ).bind(newId('open'), id, send.id, at + 60_000),
          env.DB.prepare(
            `INSERT INTO clicks (id, delivery_id, broadcast_id, link_target_id, classification, ua_family, ip_prefix, asn, created_at)
             VALUES (?1, ?2, ?3, ?4, 'human', 'Firefox', '203.0.113.0/24', 64500, ?5)`,
          ).bind(newId('click'), id, send.id, send.link, at + 60_000),
          env.DB.prepare(
            `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
             VALUES (?1, ?2, 'link_clicked', '{}', ?3)`,
          ).bind(world.channelId, memberId, at + 60_000),
        ]
      : []),
  ]);
  return id;
}

const person = (channelId: string, status: MemberStatus = 'active') =>
  addMember(channelId, `t${++serial}@example.com`, { status });

describe("a subscriber's choice not to be tracked", () => {
  it('deletes their opens and clicks and keeps send report numbers', async () => {
    const world = await seedChannel();
    const send = await post(world, now - 3 * DAY);
    const asked = await person(world.channelId);
    const other = await person(world.channelId);
    const theirs = await deliver(world, send, asked, now - 3 * DAY, true);
    await deliver(world, send, other, now - 3 * DAY, true);
    await env.DB.prepare(
      `INSERT INTO member_send_hours (member_id, channel_id, best_hour_utc, samples, computed_at)
       VALUES (?1, ?2, 9, 3, ?3)`,
    )
      .bind(asked, world.channelId, now)
      .run();
    const before = await broadcastStats(env.DB, send.id);

    expect(await setMemberTracking(env.DB, asked, false, now)).toBe(true);
    // A second request changes nothing (the carried counts are not added twice).
    await setMemberTracking(env.DB, asked, false, now);

    const after = await broadcastStats(env.DB, send.id);
    expect(after).toEqual(before);
    expect(after.humanOpens).toBe(2);
    expect(after.links[0]?.humanPeople).toBe(2);
    expect(await count('SELECT count(*) AS n FROM opens WHERE delivery_id = ?1', theirs)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM clicks WHERE delivery_id = ?1', theirs)).toBe(0);
    const delivery = await one<{ member_id: string; opened_at: number | null }>(
      'SELECT member_id, opened_at FROM deliveries WHERE id = ?1',
      theirs,
    );
    expect(delivery).toEqual({ member_id: asked, opened_at: null });
    expect(
      await count(
        "SELECT count(*) AS n FROM member_events WHERE member_id = ?1 AND type = 'link_clicked'",
        asked,
      ),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS n FROM member_send_hours WHERE member_id = ?1', asked),
    ).toBe(0);
    // The other reader keeps theirs.
    expect(
      await count(
        'SELECT count(*) AS n FROM opens o JOIN deliveries d ON d.id = o.delivery_id WHERE d.member_id = ?1',
        other,
      ),
    ).toBe(1);
    // Their unsubscribe link still works.
    expect(await unsubscribeDelivery(env.DB, theirs, now)).toMatchObject({ rosters: null });
  });

  it('leaves them out of engagement scores and the inactive-reader cleanup', async () => {
    const world = await seedChannel();
    await turnOnScores(world.channelId);
    await setSettings(world.channelId, { sunsetDays: 90 });
    const asked = await person(world.channelId);
    const silent = await person(world.channelId);
    await env.DB.prepare('UPDATE members SET created_at = ?1 WHERE id IN (?2, ?3)')
      .bind(now - 400 * DAY, asked, silent)
      .run();
    for (let i = 0; i < 6; i++) {
      const send = await post(world, now - (10 + i) * DAY);
      await deliver(world, send, asked, now - (10 + i) * DAY, false);
      await deliver(world, send, silent, now - (10 + i) * DAY, false);
    }
    await setMemberTracking(env.DB, asked, false, now);
    await runEngagementRollup(env.DB, now);
    const scores = await readMemberEngagement(env.DB, world.channelId, [asked, silent], now);
    expect(scores.has(asked)).toBe(false);
    expect(scores.get(silent)?.sentCount).toBe(6);

    // Positive control: the silent reader is told they will be unsubscribed, the one who asked
    // is left alone.
    expect(await sunsetInactiveMembers(sunsetDeps(), now)).toMatchObject({ noticed: 1 });
    const state = async (id: string) =>
      await one<{ status: string; sunset_notice_at: number | null }>(
        'SELECT status, sunset_notice_at FROM members WHERE id = ?1',
        id,
      );
    expect(await state(asked)).toEqual({ status: 'active', sunset_notice_at: null });
    expect(await state(silent)).toEqual({ status: 'active', sunset_notice_at: now });
  });

  it('starts tracking again from nothing when they change their mind', async () => {
    const world = await seedChannel();
    const asked = await person(world.channelId);
    await setMemberTracking(env.DB, asked, false, now);
    await setMemberTracking(env.DB, asked, true, now);
    expect(await one('SELECT tracking_opt_out_at FROM members WHERE id = ?1', asked)).toEqual({
      tracking_opt_out_at: null,
    });
  });
});

describe('publication tracking switches', () => {
  it('turns engagement scores off with reader profiling or open tracking', async () => {
    const world = await seedChannel();
    await turnOnScores(world.channelId);
    expect(await engagementEnabled(env.DB, world.channelId)).toBe(true);
    await setSettings(world.channelId, { profileReaders: false });
    expect(await engagementEnabled(env.DB, world.channelId)).toBe(false);
    await setSettings(world.channelId, { trackOpens: false });
    expect(await engagementEnabled(env.DB, world.channelId)).toBe(false);
  });

  it('never unsubscribes for "no opens" while open tracking is off', async () => {
    const world = await seedChannel();
    await turnOnScores(world.channelId);
    await setSettings(world.channelId, { sunsetDays: 90 });
    const silent = await person(world.channelId);
    await env.DB.prepare('UPDATE members SET created_at = ?1 WHERE id = ?2')
      .bind(now - 400 * DAY, silent)
      .run();
    for (let i = 0; i < 6; i++) {
      const send = await post(world, now - (10 + i) * DAY);
      await deliver(world, send, silent, now - (10 + i) * DAY, false);
    }
    await runEngagementRollup(env.DB, now);
    // Switched off after today's scores were worked out: the cleanup still leaves everyone.
    await setSettings(world.channelId, { sunsetDays: 90, trackOpens: false });
    await sunsetInactiveMembers(sunsetDeps(), now);
    expect(await one('SELECT status, sunset_notice_at FROM members WHERE id = ?1', silent)).toEqual(
      {
        status: 'active',
        sunset_notice_at: null,
      },
    );
  });
});

describe('engagement retention', () => {
  it('removes the person from old history and keeps every count', async () => {
    const world = await seedChannel();
    const reader = await person(world.channelId);
    const old = await post(world, now - 14 * MONTH_MS);
    const recent = await post(world, now - 2 * MONTH_MS);
    const flow = await post(world, now - 20 * MONTH_MS, 'flow');
    const oldDelivery = await deliver(world, old, reader, now - 14 * MONTH_MS, true);
    const recentDelivery = await deliver(world, recent, reader, now - 2 * MONTH_MS, true);
    await deliver(world, flow, reader, now - 15 * MONTH_MS, true);
    const email = (await one<{ email: string }>('SELECT email FROM members WHERE id = ?1', reader))!
      .email;
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO soft_bounces (workspace_id, email, created_at) VALUES (?1, ?2, ?3), (?1, ?2, ?4)',
      ).bind(world.workspaceId, email, now - 40 * DAY, now - 2 * DAY),
      env.DB.prepare(
        `INSERT INTO suppressions (id, workspace_id, email, reason, created_at)
         VALUES (?1, ?2, ?3, 'hard_bounce', ?4)`,
      ).bind(newId('suppression'), world.workspaceId, 'gone@example.com', now - 30 * MONTH_MS),
    ]);
    const before = await broadcastStats(env.DB, old.id);

    const result = await anonymiseExpiredEngagement(env.DB, now);
    expect(result.deliveries).toBe(2);
    // Run again: nothing left to do.
    expect((await anonymiseExpiredEngagement(env.DB, now)).deliveries).toBe(0);

    expect(await broadcastStats(env.DB, old.id)).toEqual(before);
    expect(
      await one(
        'SELECT member_id, email, provider_message_id FROM deliveries WHERE id = ?1',
        oldDelivery,
      ),
    ).toEqual({ member_id: null, email: 'erased', provider_message_id: null });
    expect(
      await one(
        'SELECT ip_prefix, asn, ua_family, classification FROM opens WHERE delivery_id = ?1',
        oldDelivery,
      ),
    ).toEqual({ ip_prefix: null, asn: null, ua_family: null, classification: 'human' });
    expect(await one('SELECT ip_prefix FROM clicks WHERE delivery_id = ?1', oldDelivery)).toEqual({
      ip_prefix: null,
    });
    // Recent history is untouched.
    expect(await one('SELECT member_id FROM deliveries WHERE id = ?1', recentDelivery)).toEqual({
      member_id: reader,
    });
    expect(await one('SELECT ip_prefix FROM opens WHERE delivery_id = ?1', recentDelivery)).toEqual(
      { ip_prefix: '203.0.113.0/24' },
    );
    // The old post's copies are gone; the automation email keeps its row without the address.
    expect(
      await count('SELECT count(*) AS n FROM broadcast_recipients WHERE broadcast_id = ?1', old.id),
    ).toBe(0);
    expect(
      await count(
        'SELECT count(*) AS n FROM broadcast_recipients WHERE broadcast_id = ?1',
        recent.id,
      ),
    ).toBe(1);
    expect(
      await one(
        'SELECT member_id, email, first_name FROM broadcast_recipients WHERE broadcast_id = ?1',
        flow.id,
      ),
    ).toEqual({ member_id: reader, email: 'erased', first_name: null });
    // Soft bounces past 30 days go; suppressions stay.
    expect(
      await count(
        'SELECT count(*) AS n FROM soft_bounces WHERE workspace_id = ?1',
        world.workspaceId,
      ),
    ).toBe(1);
    expect(
      await count(
        'SELECT count(*) AS n FROM suppressions WHERE workspace_id = ?1',
        world.workspaceId,
      ),
    ).toBe(1);
    // An old email's unsubscribe link still works, through a reference that holds only the
    // delivery and the Member, nothing about what they did.
    expect(await one('SELECT * FROM unsubscribe_refs WHERE delivery_id = ?1', oldDelivery)).toEqual(
      {
        delivery_id: oldDelivery,
        member_id: reader,
        expires_at: now + UNSUBSCRIBE_REF_MONTHS * MONTH_MS,
      },
    );
    expect(await unsubscribeDelivery(env.DB, oldDelivery, now)).toMatchObject({
      alreadyUnsubscribed: false,
    });
    expect(await one('SELECT status FROM members WHERE id = ?1', reader)).toEqual({
      status: 'unsubscribed',
    });
    // Nothing about the person came back onto the delivery.
    expect(await one('SELECT member_id, email FROM deliveries WHERE id = ?1', oldDelivery)).toEqual(
      { member_id: null, email: 'erased' },
    );
  });

  it('keeps an old unsubscribe link working only for its own limit, and never past erasure', async () => {
    const world = await seedChannel();
    const reader = await person(world.channelId);
    const gone = await person(world.channelId, 'unsubscribed');
    const old = await post(world, now - 14 * MONTH_MS);
    const readerDelivery = await deliver(world, old, reader, now - 14 * MONTH_MS, false);
    const goneDelivery = await deliver(world, old, gone, now - 14 * MONTH_MS, false);
    await anonymiseExpiredEngagement(env.DB, now);
    // Someone who already left needs no reference.
    expect(
      await count('SELECT count(*) AS n FROM unsubscribe_refs WHERE member_id = ?1', gone),
    ).toBe(0);
    expect(await unsubscribeDelivery(env.DB, goneDelivery, now)).toBeNull();
    // Past the reference's own limit the link no longer finds anyone, and the job deletes it.
    const past = now + UNSUBSCRIBE_REF_MONTHS * MONTH_MS + DAY;
    expect(await unsubscribeDelivery(env.DB, readerDelivery, past)).toBeNull();
    expect((await anonymiseExpiredEngagement(env.DB, past)).unsubscribeRefs).toBeGreaterThan(0);
    expect(
      await count(
        'SELECT count(*) AS n FROM unsubscribe_refs WHERE delivery_id = ?1',
        readerDelivery,
      ),
    ).toBe(0);
    expect(await one('SELECT status FROM members WHERE id = ?1', reader)).toEqual({
      status: 'active',
    });
  });

  it("follows the workspace's choice", async () => {
    const world = await seedChannel();
    const reader = await person(world.channelId);
    const send = await post(world, now - 8 * MONTH_MS);
    const delivery = await deliver(world, send, reader, now - 8 * MONTH_MS, false);
    await anonymiseExpiredEngagement(env.DB, now);
    expect(await one('SELECT member_id FROM deliveries WHERE id = ?1', delivery)).toEqual({
      member_id: reader,
    });
    await env.DB.prepare('UPDATE workspaces SET engagement_retention_months = 6 WHERE id = ?1')
      .bind(world.workspaceId)
      .run();
    await anonymiseExpiredEngagement(env.DB, now);
    expect(await one('SELECT member_id FROM deliveries WHERE id = ?1', delivery)).toEqual({
      member_id: null,
    });
  });

  it('asks once for automation emails, not once per email, when nothing is left to clear', async () => {
    const world = await seedChannel();
    const reader = await person(world.channelId);
    for (let i = 0; i < 25; i++) {
      const flow = await post(world, now - 20 * MONTH_MS, 'flow');
      await deliver(world, flow, reader, now - 15 * MONTH_MS, false);
    }
    // Clear everything due first, other tests' rows included.
    for (let i = 0; i < 20; i++) {
      const done = await anonymiseExpiredEngagement(env.DB, now);
      if (!done.deliveries && !done.copiesDeleted && !done.copiesCleared) break;
    }
    expect(
      await count(
        `SELECT count(*) AS n FROM broadcast_recipients r JOIN broadcasts b ON b.id = r.broadcast_id
          WHERE b.channel_id = ?1 AND r.email <> 'erased'`,
        world.channelId,
      ),
    ).toBe(0);
    const prepared: string[] = [];
    const counting = new Proxy(env.DB, {
      get(target, key) {
        if (key === 'prepare') {
          return (sql: string) => {
            prepared.push(sql);
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await anonymiseExpiredEngagement(counting, now);
    expect(result).toMatchObject({ copiesDeleted: 0, copiesCleared: 0 });
    // The finished posts' copies and the automation emails' copies: one query each.
    expect(prepared.filter((sql) => sql.includes('broadcast_recipients'))).toHaveLength(2);
  });

  it('stops within its budget and picks up where it left off', async () => {
    const world = await seedChannel();
    const send = await post(world, now - 14 * MONTH_MS);
    const readers = await Promise.all(Array.from({ length: 3 }, () => person(world.channelId)));
    for (const reader of readers) await deliver(world, send, reader, now - 14 * MONTH_MS, false);
    const first = await anonymiseExpiredEngagement(env.DB, now, 0);
    expect(first.deliveries).toBe(0);
    const second = await anonymiseExpiredEngagement(env.DB, now, 1);
    expect(second.deliveries).toBe(3);
  });
});
