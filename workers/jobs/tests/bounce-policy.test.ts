// Bounce rules (docs/deliverability.md "Bounces"): hard, soft and blocked bounces against the
// workspace's policy, the paid-plan hold and its notice, the preview and "apply to past bounces",
// and what removing a bounce suppression gives back.
import { env } from 'cloudflare:test';
import { newId, type BouncePolicy } from '@swarm/domain';
import {
  anonymiseExpiredEngagement,
  applyBouncePolicy,
  applySesEvent,
  checkRampHealth,
  decideBounceHold,
  isSuppressedFor,
  listBounceHolds,
  memberBounces,
  previewBouncePolicy,
  providerBreakdown,
  removeSuppression,
  saveBouncePolicy,
  type SesEvent,
  type SuppressionRow,
} from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { MINUTE_CRON } from '../src/crons';
import { runScheduled } from '../src/index';
import { makeAdmin } from './flows-helpers';
import { addMember, jobsEnv, one, seedChannel } from './helpers';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const email = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}@example.com`;

async function seedBroadcast(channelId: string, workspaceId: string, rampId: string | null = null) {
  const now = Date.now();
  const dispatch = newId('dispatch', now);
  const broadcast = newId('broadcast', now);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at) VALUES (?1, ?2, 'S', '{"type":"doc","content":[]}', 'sent', ?3, ?3)`,
    ).bind(dispatch, channelId, now),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text, from_name, from_address, track_opens, ramp_id, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'S', '', '', '', 'F', 'f@mail.swarm.test', 1, ?5, ?6, ?6)`,
    ).bind(broadcast, dispatch, channelId, workspaceId, rampId, now),
  ]);
  return broadcast;
}

/** One reader, in one publication, getting one email after another. */
async function reader(options: { status?: 'active' | 'pending' | 'unsubscribed' } = {}) {
  const seed = await seedChannel();
  const to = email('reader');
  const memberId = await addMember(seed.channelId, to, options);
  const broadcast = await seedBroadcast(seed.channelId, seed.workspaceId);
  const send = async (sentAt: number) => {
    const id = newId('delivery');
    await env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, provider_message_id, status, sent_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'sent', ?7)`,
    )
      .bind(
        id,
        await seedBroadcast(seed.channelId, seed.workspaceId),
        seed.channelId,
        memberId,
        to,
        `ses-${id}`,
        sentAt,
      )
      .run();
    return id;
  };
  return { ...seed, to, memberId, broadcast, send };
}

const bounce = (
  deliveryId: string,
  bounceType: 'Permanent' | 'Transient',
  diagnostic: string,
  subType = 'General',
): SesEvent => ({
  eventType: 'Bounce',
  mail: { tags: { delivery: [deliveryId] } },
  bounce: {
    bounceType,
    bounceSubType: subType,
    bouncedRecipients: [{ diagnosticCode: diagnostic }],
  },
});
const HARD = 'smtp; 550 5.1.1 <reader@example.com>: user unknown';
const FULL = 'smtp; 452 4.2.2 The email account that you tried to reach is over quota.';
const BLOCK =
  'smtp; 554 5.7.1 Service unavailable; Client host [203.0.113.7] blocked using zen.spamhaus.org';
const delivered = (deliveryId: string): SesEvent => ({
  eventType: 'Delivery',
  mail: { tags: { delivery: [deliveryId] } },
  delivery: {},
});

const status = async (memberId: string) =>
  (await one<{ status: string }>('SELECT status FROM members WHERE id = ?1', memberId))?.status;
const suppression = (workspaceId: string, to: string) =>
  one<SuppressionRow>(
    'SELECT * FROM suppressions WHERE workspace_id = ?1 AND email = ?2 AND channel_id IS NULL',
    workspaceId,
    to,
  );
const policy = (changes: Partial<BouncePolicy>): BouncePolicy => ({
  hardBounces: 1,
  softStreak: 3,
  softWindow: null,
  askForPaid: true,
  ...changes,
});

async function givePaidPlan(memberId: string, channelId: string) {
  await env.DB.prepare(
    `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at) VALUES (?1, ?2, 'paid', 'stripe', 0)`,
  )
    .bind(memberId, channelId)
    .run();
}

describe('hard bounces', () => {
  it('stop mailing at the first one by default, with the rule, the cause and what the server said', async () => {
    const r = await reader();
    const now = Date.now();
    const result = await applySesEvent(
      env.DB,
      bounce(await r.send(now - 1000), 'Permanent', HARD),
      now,
    );
    expect(result).toMatchObject({ kind: 'hard_bounce', stopped: true, held: false });
    expect(await status(r.memberId)).toBe('bounced');
    expect(await suppression(r.workspaceId, r.to)).toMatchObject({
      reason: 'hard_bounce',
      detail: HARD,
      bounce_rule: 'hard',
      bounce_cause: 'no_mailbox',
      bounce_counted: 1,
    });
    // The SES account-level list, as before.
    expect(
      await one('SELECT action FROM provider_suppression_sync WHERE email = ?1', r.to),
    ).toEqual({ action: 'put' });
    const page = await memberBounces(env.DB, r.workspaceId, r.to, now);
    expect(page.stopped).toMatchObject({ reason: 'hard_bounce', bounce: { rule: 'hard' } });
    expect(page.events).toEqual([
      expect.objectContaining({ kind: 'hard', cause: 'no_mailbox', code: '5.1.1', detail: HARD }),
    ]);
  });

  it('with "2 within 30 days", stop at the second hard bounce only', async () => {
    const r = await reader();
    await saveBouncePolicy(env.DB, r.workspaceId, policy({ hardBounces: 2 }), null, Date.now());
    const now = Date.now();
    const first = await applySesEvent(
      env.DB,
      bounce(await r.send(now - 20 * DAY), 'Permanent', HARD),
      now - 20 * DAY,
    );
    expect(first).toMatchObject({ kind: 'hard_bounce', stopped: false });
    expect(await status(r.memberId)).toBe('active');
    // Not stopped, so nothing goes to the SES list yet.
    expect(
      await one('SELECT 1 AS x FROM provider_suppression_sync WHERE email = ?1', r.to),
    ).toBeNull();
    // The email still counts as bounced for the reports and the warm-up.
    const second = await applySesEvent(
      env.DB,
      bounce(
        await r.send(now),
        'Permanent',
        'Amazon SES did not send the message to this address because it is on the suppression list for your account.',
        'OnAccountSuppressionList',
      ),
      now,
    );
    expect(second).toMatchObject({ stopped: true });
    expect(await suppression(r.workspaceId, r.to)).toMatchObject({
      bounce_rule: 'hard_repeat',
      bounce_counted: 2,
      bounce_days: 30,
    });
  });
});

describe('soft bounces', () => {
  it('stop after 3 emails in a row, at any rhythm: weekly sends that only soft-bounce are caught', async () => {
    const r = await reader();
    const start = Date.now() - 3 * WEEK;
    for (let week = 0; week < 2; week++) {
      const at = start + week * WEEK;
      await applySesEvent(env.DB, bounce(await r.send(at), 'Transient', FULL), at + 1000);
    }
    expect(await status(r.memberId)).toBe('active');
    expect((await memberBounces(env.DB, r.workspaceId, r.to, Date.now())).softStreak).toBe(2);
    const at = start + 2 * WEEK;
    const third = await applySesEvent(
      env.DB,
      bounce(await r.send(at), 'Transient', FULL),
      at + 1000,
    );
    expect(third).toMatchObject({ kind: 'soft_bounce', stopped: true });
    expect(await status(r.memberId)).toBe('bounced');
    expect(await suppression(r.workspaceId, r.to)).toMatchObject({
      reason: 'soft_bounce',
      bounce_rule: 'soft_streak',
      bounce_cause: 'mailbox_full',
      bounce_counted: 3,
    });
    // Soft bounces never go to the SES list.
    expect(
      await one('SELECT 1 AS x FROM provider_suppression_sync WHERE email = ?1', r.to),
    ).toBeNull();
  });

  it('count one email once, however often the provider reports it', async () => {
    const r = await reader();
    const now = Date.now();
    const id = await r.send(now - 1000);
    for (let i = 0; i < 5; i++) await applySesEvent(env.DB, bounce(id, 'Transient', FULL), now + i);
    expect((await memberBounces(env.DB, r.workspaceId, r.to, now)).softStreak).toBe(1);
    expect(await status(r.memberId)).toBe('active');
  });

  it('start again when an email in between is delivered, reported or only seen opened', async () => {
    const r = await reader();
    const now = Date.now() - 10 * DAY;
    await applySesEvent(env.DB, bounce(await r.send(now), 'Transient', FULL), now + 1);
    await applySesEvent(env.DB, bounce(await r.send(now + DAY), 'Transient', FULL), now + DAY + 1);
    // A delivery report resets the count at once.
    await applySesEvent(env.DB, delivered(await r.send(now + 2 * DAY)), now + 2 * DAY + 1);
    expect((await memberBounces(env.DB, r.workspaceId, r.to, now)).softStreak).toBe(0);
    await applySesEvent(
      env.DB,
      bounce(await r.send(now + 3 * DAY), 'Transient', FULL),
      now + 3 * DAY + 1,
    );
    await applySesEvent(
      env.DB,
      bounce(await r.send(now + 4 * DAY), 'Transient', FULL),
      now + 4 * DAY + 1,
    );
    // A mail server that reports no deliveries: an open in between proves the mailbox worked.
    const opened = await r.send(now + 5 * DAY);
    await env.DB.prepare('UPDATE deliveries SET opened_at = ?1 WHERE id = ?2')
      .bind(now + 5 * DAY + 10, opened)
      .run();
    const next = await applySesEvent(
      env.DB,
      bounce(await r.send(now + 6 * DAY), 'Transient', FULL),
      now + 6 * DAY + 1,
    );
    expect(next).toMatchObject({ stopped: false });
    expect((await memberBounces(env.DB, r.workspaceId, r.to, now)).softStreak).toBe(1);
    expect(await status(r.memberId)).toBe('active');
  });

  it('"N within D days" stops even with deliveries in between, and "never" never stops', async () => {
    const windowed = await reader();
    await saveBouncePolicy(
      env.DB,
      windowed.workspaceId,
      policy({ softStreak: null, softWindow: { count: 3, days: 7 } }),
      null,
      Date.now(),
    );
    const now = Date.now() - 5 * DAY;
    for (let i = 0; i < 3; i++) {
      const at = now + i * DAY;
      await applySesEvent(env.DB, bounce(await windowed.send(at), 'Transient', FULL), at + 1);
      await applySesEvent(env.DB, delivered(await windowed.send(at + 1000)), at + 2000);
    }
    expect(await suppression(windowed.workspaceId, windowed.to)).toMatchObject({
      bounce_rule: 'soft_window',
      bounce_counted: 3,
      bounce_days: 7,
    });

    const never = await reader();
    await saveBouncePolicy(
      env.DB,
      never.workspaceId,
      policy({ softStreak: null }),
      null,
      Date.now(),
    );
    for (let i = 0; i < 10; i++) {
      const at = now + i * 1000;
      await applySesEvent(env.DB, bounce(await never.send(at), 'Transient', FULL), at + 1);
    }
    expect(await status(never.memberId)).toBe('active');
    expect(await suppression(never.workspaceId, never.to)).toBeNull();
  });
});

describe('blocks', () => {
  it('never stop a subscriber, but count as bounced for the check-up and the warm-up pause', async () => {
    const r = await reader();
    const rampId = newId('reputationRamp');
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO reputation_ramps (id, channel_id, status, day, cap_today, start_cap, growth, max_cap, bounce_threshold, complaint_threshold, created_at, updated_at)
       VALUES (?1, ?2, 'warming', ?3, 1000, 100, 1.5, 10000, 0.02, 0.0008, ?4, ?4)`,
    )
      .bind(rampId, r.channelId, new Date(now).toISOString().slice(0, 10), now)
      .run();
    const rampSend = await seedBroadcast(r.channelId, r.workspaceId, rampId);
    // 96 delivered emails to other readers in the warm-up's day.
    await env.DB.batch(
      Array.from({ length: 96 }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at) VALUES (?1, ?2, ?3, NULL, ?4, 'delivered', ?5)`,
        ).bind(newId('delivery'), rampSend, r.channelId, `ok${i}@example.net`, now - 2000),
      ),
    );
    let paused: string | null | undefined = null;
    for (let i = 0; i < 4; i++) {
      const id = await r.send(now - 1000 + i);
      await env.DB.prepare(
        'UPDATE broadcasts SET ramp_id = ?1 WHERE id = (SELECT broadcast_id FROM deliveries WHERE id = ?2)',
      )
        .bind(rampId, id)
        .run();
      const result = await applySesEvent(env.DB, bounce(id, 'Permanent', BLOCK), now + i);
      expect(result).toMatchObject({ kind: 'blocked', stopped: false });
      paused ??= result.rampPaused;
    }
    expect(await status(r.memberId)).toBe('active');
    expect(await suppression(r.workspaceId, r.to)).toBeNull();
    const row = await one<{ status: string; bounce_type: string }>(
      'SELECT status, bounce_type FROM deliveries WHERE member_id = ?1 LIMIT 1',
      r.memberId,
    );
    expect(row).toEqual({ status: 'bounced', bounce_type: 'blocked:blocklist' });
    const providers = await providerBreakdown(env.DB, r.channelId, {
      from: '',
      to: '',
      startMs: now - DAY,
      endMs: now + DAY,
    });
    expect(providers.find((p) => p.provider === 'other')).toMatchObject({ bounced: 4, blocked: 4 });
    // 4 refused of 100 in the day is over the 2% limit: the warm-up paused.
    expect(paused).toMatch(/Bounce rate 4\.0%/);
    const ramp = await one<{ status: string; paused_by: string | null }>(
      'SELECT status, paused_by FROM reputation_ramps WHERE id = ?1',
      rampId,
    );
    // The ramp paused itself: only an instance admin may resume it on the shared domain.
    expect(ramp).toEqual({ status: 'paused', paused_by: 'system' });
    expect(await checkRampHealth(env.DB, rampId, now)).toBeNull();
  });

  it('an auto-reply is not a bounce at all', async () => {
    const r = await reader();
    const result = await applySesEvent(
      env.DB,
      bounce(await r.send(Date.now()), 'Transient', 'Out of office until Monday', 'AutoResponder'),
    );
    expect(result).toMatchObject({ kind: 'ignored' });
    expect((await memberBounces(env.DB, r.workspaceId, r.to, Date.now())).events).toEqual([]);
  });
});

describe('subscribers on a paid plan', () => {
  it('are held for an admin and still mailed; the owners and admins get one email', async () => {
    const r = await reader();
    await givePaidPlan(r.memberId, r.channelId);
    const admin = email('admin');
    await makeAdmin(r.workspaceId, admin);
    const now = Date.now();
    const result = await applySesEvent(
      env.DB,
      bounce(await r.send(now - 1000), 'Permanent', HARD),
      now,
    );
    expect(result).toMatchObject({ kind: 'hard_bounce', stopped: false, held: true });
    expect(await status(r.memberId)).toBe('active');
    expect(await isSuppressedFor(env.DB, r.workspaceId, r.channelId, r.to)).toBe(false);
    // Held, so not on the SES list either.
    expect(
      await one('SELECT 1 AS x FROM provider_suppression_sync WHERE email = ?1', r.to),
    ).toBeNull();
    const [hold] = await listBounceHolds(env.DB, r.workspaceId, r.channelId);
    expect(hold).toMatchObject({
      email: r.to,
      memberId: r.memberId,
      rule: 'hard',
      last: { cause: 'no_mailbox' },
    });

    const { env: jobs } = jobsEnv();
    await runScheduled(jobs, MINUTE_CRON, Date.now());
    await runScheduled(jobs, MINUTE_CRON, Date.now());
    const listing = await env.DEV_MAILBOX.list({ prefix: 'mail/', include: ['customMetadata'] });
    const keys = listing.objects.filter((o) => o.customMetadata?.to === admin).map((o) => o.key);
    expect(keys).toHaveLength(1);
    const mail = await (await env.DEV_MAILBOX.get(keys[0]!))!.json<{
      category: string;
      subject: string;
      text: string;
    }>();
    expect(mail.category).toBe('bounce_hold');
    expect(mail.subject).toBe('Emails to a subscriber on a paid plan are bouncing');
    expect(mail.text).toContain(r.to);
    expect(mail.text).toContain('The address doesn’t exist');
    expect(mail.text).toContain(HARD);
    expect(mail.text).toContain(`${jobs.APP_ORIGIN}/channels/${r.channelId}/sending#bounces`);
    // No dash anywhere, the sign-off of the shared notice frame (flows-notify.ts) included.
    expect(mail.text).not.toContain('\u2014');
    expect(mail.text.endsWith('\n\nSwarm')).toBe(true);

    // A second bounce while held: still held, no second email.
    await applySesEvent(env.DB, bounce(await r.send(now + 1000), 'Permanent', HARD), now + 2000);
    await runScheduled(jobs, MINUTE_CRON, Date.now());
    const again = await env.DEV_MAILBOX.list({ prefix: 'mail/', include: ['customMetadata'] });
    expect(again.objects.filter((o) => o.customMetadata?.to === admin)).toHaveLength(1);

    // "Keep mailing": the counts start again and the SES list lets go of the address.
    await decideBounceHold(env.DB, r.workspaceId, hold!.id, 'keep', Date.now());
    expect(await listBounceHolds(env.DB, r.workspaceId, r.channelId)).toEqual([]);
    expect(
      await one('SELECT action FROM provider_suppression_sync WHERE email = ?1', r.to),
    ).toEqual({
      action: 'delete',
    });
    // The next hard bounce holds again; "Stop mailing" then stops as the rule would have.
    await applySesEvent(
      env.DB,
      bounce(await r.send(Date.now()), 'Permanent', HARD),
      Date.now() + 10,
    );
    const [next] = await listBounceHolds(env.DB, r.workspaceId, r.channelId);
    await decideBounceHold(env.DB, r.workspaceId, next!.id, 'stop', Date.now());
    expect(await status(r.memberId)).toBe('bounced');
    expect(await suppression(r.workspaceId, r.to)).toMatchObject({ bounce_rule: 'hard' });
  });

  it('a delivered email lets go of a hold that only soft bounces made; without "ask me first" they are stopped', async () => {
    const r = await reader();
    await givePaidPlan(r.memberId, r.channelId);
    const now = Date.now() - DAY;
    for (let i = 0; i < 3; i++) {
      await applySesEvent(
        env.DB,
        bounce(await r.send(now + i * 1000), 'Transient', FULL),
        now + i * 1000 + 1,
      );
    }
    expect(await listBounceHolds(env.DB, r.workspaceId, r.channelId)).toHaveLength(1);
    await applySesEvent(env.DB, delivered(await r.send(now + 5000)), now + 6000);
    expect(await listBounceHolds(env.DB, r.workspaceId, r.channelId)).toEqual([]);

    const plain = await reader();
    await givePaidPlan(plain.memberId, plain.channelId);
    await saveBouncePolicy(
      env.DB,
      plain.workspaceId,
      policy({ askForPaid: false }),
      null,
      Date.now(),
    );
    await applySesEvent(env.DB, bounce(await plain.send(Date.now()), 'Permanent', HARD));
    expect(await status(plain.memberId)).toBe('bounced');
  });
});

describe('a block after a hold', () => {
  it('keeps the cause that held the subscriber, so Stop mailing records it', async () => {
    const r = await reader();
    await givePaidPlan(r.memberId, r.channelId);
    const now = Date.now() - DAY;
    for (let i = 0; i < 3; i++) {
      await applySesEvent(
        env.DB,
        bounce(await r.send(now + i * 1000), 'Transient', FULL),
        now + i * 1000 + 1,
      );
    }
    const [hold] = await listBounceHolds(env.DB, r.workspaceId, r.channelId);
    expect(hold).toMatchObject({
      rule: 'soft_streak',
      last: { kind: 'soft', cause: 'mailbox_full' },
    });
    // A later send is refused because of the sender (a blocklist): about the sender, not them.
    const blocked = await applySesEvent(
      env.DB,
      bounce(await r.send(now + 5000), 'Permanent', BLOCK),
      now + 5001,
    );
    expect(blocked).toMatchObject({ kind: 'blocked', stopped: false });
    expect((await listBounceHolds(env.DB, r.workspaceId, r.channelId))[0]).toMatchObject({
      id: hold!.id,
      last: { kind: 'soft', cause: 'mailbox_full', detail: FULL },
    });
    // "Stop mailing" works, and says why: the soft bounces, not the block.
    await decideBounceHold(env.DB, r.workspaceId, hold!.id, 'stop', Date.now());
    expect(await status(r.memberId)).toBe('bounced');
    expect(await suppression(r.workspaceId, r.to)).toMatchObject({
      reason: 'soft_bounce',
      bounce_rule: 'soft_streak',
      bounce_cause: 'mailbox_full',
      detail: FULL,
    });
  });

  it('never records a block as why mailing stopped, for rows a block overwrote before', async () => {
    // As a block left them before it stopped overwriting the last bounce.
    const overwrite = (workspaceId: string, to: string) =>
      env.DB.prepare(
        `UPDATE bounce_states SET last_kind = 'blocked', last_cause = 'blocklist', last_detail = ?3
          WHERE workspace_id = ?1 AND email = ?2`,
      )
        .bind(workspaceId, to, BLOCK)
        .run();
    const held = await reader();
    await givePaidPlan(held.memberId, held.channelId);
    const now = Date.now() - DAY;
    for (let i = 0; i < 3; i++) {
      await applySesEvent(
        env.DB,
        bounce(await held.send(now + i * 1000), 'Transient', FULL),
        now + i * 1000 + 1,
      );
    }
    await overwrite(held.workspaceId, held.to);
    const [hold] = await listBounceHolds(env.DB, held.workspaceId, held.channelId);
    await decideBounceHold(env.DB, held.workspaceId, hold!.id, 'stop', Date.now());
    expect(await suppression(held.workspaceId, held.to)).toMatchObject({
      bounce_rule: 'soft_streak',
      bounce_cause: null,
    });

    // "Apply to past bounces too" on such a row.
    const plain = await reader();
    for (let i = 0; i < 2; i++) {
      await applySesEvent(
        env.DB,
        bounce(await plain.send(now + i * 1000), 'Transient', FULL),
        now + i * 1000 + 1,
      );
    }
    await overwrite(plain.workspaceId, plain.to);
    expect(
      await applyBouncePolicy(env.DB, plain.workspaceId, policy({ softStreak: 2 }), Date.now()),
    ).toEqual({ stopped: 1, held: 0, remaining: 0 });
    expect(await status(plain.memberId)).toBe('bounced');
    expect(await suppression(plain.workspaceId, plain.to)).toMatchObject({
      bounce_rule: 'soft_streak',
      bounce_cause: null,
    });
  });
});

describe('a new policy', () => {
  it('previews from stored history, applies to the future only, and to the past when asked', async () => {
    const r = await reader();
    const paid = await addMember(r.channelId, email('paid'));
    const paidTo = (await one<{ email: string }>('SELECT email FROM members WHERE id = ?1', paid))!
      .email;
    await givePaidPlan(paid, r.channelId);
    const now = Date.now() - DAY;
    // Two soft bounces each: under the default (3 in a row) nobody is stopped.
    for (const [to, memberId] of [
      [r.to, r.memberId],
      [paidTo, paid],
    ] as const) {
      for (let i = 0; i < 2; i++) {
        const id = newId('delivery');
        await env.DB.prepare(
          `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, 'sent', ?6)`,
        )
          .bind(
            id,
            await seedBroadcast(r.channelId, r.workspaceId),
            r.channelId,
            memberId,
            to,
            now + i,
          )
          .run();
        await applySesEvent(env.DB, bounce(id, 'Transient', FULL), now + i + 1);
      }
    }
    const stricter = policy({ softStreak: 2 });
    expect(await previewBouncePolicy(env.DB, r.workspaceId, stricter, Date.now())).toEqual({
      stopped: 1,
      held: 1,
      byRule: { hard: 0, hard_repeat: 0, soft_streak: 2, soft_window: 0 },
    });
    // Saving alone changes nothing yet.
    await saveBouncePolicy(env.DB, r.workspaceId, stricter, null, Date.now());
    expect(await status(r.memberId)).toBe('active');
    expect(await applyBouncePolicy(env.DB, r.workspaceId, stricter, Date.now())).toEqual({
      stopped: 1,
      held: 1,
      remaining: 0,
    });
    expect(await status(r.memberId)).toBe('bounced');
    expect(await status(paid)).toBe('active');
    expect(await listBounceHolds(env.DB, r.workspaceId, r.channelId)).toHaveLength(1);
    // The held one is already listed: saving again has nothing left to do.
    expect(await previewBouncePolicy(env.DB, r.workspaceId, stricter, Date.now())).toMatchObject({
      stopped: 0,
      held: 0,
    });
    // Without "ask me first" it would be stopped now, so it counts again.
    expect(
      await previewBouncePolicy(
        env.DB,
        r.workspaceId,
        { ...stricter, askForPaid: false },
        Date.now(),
      ),
    ).toMatchObject({ stopped: 1, held: 0 });
  });

  it('reaches the rest past the first batch, however many are held already', async () => {
    const r = await reader();
    const held = 501;
    const tag = crypto.randomUUID().slice(0, 8);
    const now = Date.now();
    // 501 subscribers on a paid plan, already held after 3 soft bounces in a row, and one more
    // address (last by id) the default rules would stop.
    await env.DB.batch([
      env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
         INSERT INTO members (id, channel_id, email, status, created_at, updated_at)
         SELECT 'mb_' || ?2 || printf('%04d', i), ?1, 'held' || i || '-' || ?2 || '@example.com',
                'active', ?4, ?4 FROM n`,
      ).bind(r.channelId, tag, held, now),
      env.DB.prepare(
        `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at)
         SELECT id, channel_id, 'paid', 'stripe', 0 FROM members WHERE id LIKE 'mb_' || ?1 || '%'`,
      ).bind(tag),
      env.DB.prepare(
        `INSERT INTO bounce_states (id, workspace_id, email, soft_streak, last_kind, last_cause,
           last_bounced_at, held_at, held_rule, held_counted, hold_notice, created_at, updated_at)
         SELECT 'bn_a' || substr(id, 4), ?1, email, 3, 'soft', 'mailbox_full', ?2, ?2, 'soft_streak', 3,
                'sent', ?2, ?2
           FROM members WHERE id LIKE 'mb_' || ?3 || '%'`,
      ).bind(r.workspaceId, now, tag),
      env.DB.prepare(
        `INSERT INTO bounce_states (id, workspace_id, email, soft_streak, last_kind, last_cause,
           last_bounced_at, created_at, updated_at)
         VALUES ('bn_z' || ?3, ?1, ?2, 3, 'soft', 'mailbox_full', ?4, ?4, ?4)`,
      ).bind(r.workspaceId, r.to, tag, now),
    ]);
    const rules = policy({});
    expect(await previewBouncePolicy(env.DB, r.workspaceId, rules, now)).toMatchObject({
      stopped: 1,
      held: 0,
    });
    expect(await applyBouncePolicy(env.DB, r.workspaceId, rules, now)).toEqual({
      stopped: 1,
      held: 0,
      remaining: 0,
    });
    expect(await status(r.memberId)).toBe('bounced');
    expect(
      await one<{ n: number }>(
        'SELECT count(*) AS n FROM bounce_states WHERE workspace_id = ?1 AND held_at IS NOT NULL',
        r.workspaceId,
      ),
    ).toEqual({ n: held });
  });
});

describe('removing a bounce suppression', () => {
  it('gives subscribers back the status they had, and the counts start from zero', async () => {
    const seed = await seedChannel();
    const second = newId('channel');
    await env.DB.prepare(
      `INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, 'Second', ?4, ?4)`,
    )
      .bind(second, seed.workspaceId, `ch-${crypto.randomUUID().slice(0, 12)}`, Date.now())
      .run();
    const to = email('fixed');
    const active = await addMember(seed.channelId, to);
    const left = await addMember(second, to, { status: 'unsubscribed' });
    const broadcast = await seedBroadcast(seed.channelId, seed.workspaceId);
    const id = newId('delivery');
    await env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, 'sent', ?6)`,
    )
      .bind(id, broadcast, seed.channelId, active, to, Date.now())
      .run();
    await applySesEvent(env.DB, bounce(id, 'Permanent', HARD));
    expect([await status(active), await status(left)]).toEqual(['bounced', 'bounced']);

    const row = await suppression(seed.workspaceId, to);
    expect(await removeSuppression(env.DB, row!)).toEqual({ restored: 2 });
    expect([await status(active), await status(left)]).toEqual(['active', 'unsubscribed']);
    expect(await memberBounces(env.DB, seed.workspaceId, to, Date.now())).toMatchObject({
      softStreak: 0,
      stopped: null,
      events: [],
    });
  });

  it('a subscriber bounced before bounce rules existed comes back by what is known of them', async () => {
    const seed = await seedChannel();
    const agreed = email('agreed');
    const unknown = email('unknown');
    const ids: string[] = [];
    for (const [to, consent] of [
      [agreed, Date.now()],
      [unknown, null],
    ] as const) {
      const memberId = await addMember(seed.channelId, to);
      ids.push(memberId);
      await env.DB.batch([
        env.DB.prepare("UPDATE members SET status = 'bounced', consent_at = ?1 WHERE id = ?2").bind(
          consent,
          memberId,
        ),
        env.DB.prepare(
          `INSERT INTO suppressions (id, workspace_id, email, reason, detail, created_at) VALUES (?1, ?2, ?3, 'hard_bounce', 'Permanent / General', 0)`,
        ).bind(newId('suppression'), seed.workspaceId, to),
      ]);
      await removeSuppression(env.DB, (await suppression(seed.workspaceId, to))!);
    }
    // Agreed before: active. Nothing known: pending, so nobody is mailed without agreeing.
    expect([await status(ids[0]!), await status(ids[1]!)]).toEqual(['active', 'pending']);
  });
});

describe('retention', () => {
  it('keeps bounce history for 90 days', async () => {
    const r = await reader();
    const old = Date.now() - 100 * DAY;
    await applySesEvent(env.DB, bounce(await r.send(old), 'Transient', FULL), old);
    await anonymiseExpiredEngagement(env.DB, Date.now());
    expect(
      await one<{ n: number }>('SELECT count(*) AS n FROM bounce_events WHERE email = ?1', r.to),
    ).toEqual({ n: 0 });
    expect(await one('SELECT 1 AS x FROM bounce_states WHERE email = ?1', r.to)).toBeNull();
  });
});
