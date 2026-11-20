import { env } from 'cloudflare:test';
import { sha256Hex } from '@swarm/db';
import { newId } from '@swarm/domain';
import { entitledLevel, recomputeEntitlement, runPaymentsLifecycle } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { runScheduled } from '../src/index';
import { addMember, jobsEnv, seedChannel } from './helpers';

const DAY = 86_400_000;

describe('payments lifecycle (5-minute cron)', () => {
  it('downgrades an expired grace period and ends a comp grant', async () => {
    const { channelId } = await seedChannel();
    const now = Date.now();
    const levelId = newId('membershipLevel', now);
    await env.DB.prepare(
      `INSERT INTO membership_levels (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, 'Supporter', ?3, ?3)`,
    )
      .bind(levelId, channelId, now)
      .run();
    const graced = await addMember(channelId, `graced-${crypto.randomUUID()}@example.com`);
    const comped = await addMember(channelId, `comped-${crypto.randomUUID()}@example.com`);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO member_subscriptions (id, channel_id, member_id, level_id, source, status, stripe_subscription_id,
                current_period_end, grace_until, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'stripe', 'past_due', ?5, ?6, ?7, ?8, ?8)`,
      ).bind(
        newId('memberSubscription', now),
        channelId,
        graced,
        levelId,
        `sub_${crypto.randomUUID().slice(0, 8)}`,
        now + 20 * DAY,
        now + DAY,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO member_subscriptions (id, channel_id, member_id, level_id, source, status, current_period_end, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'comp', 'active', ?5, ?6, ?6)`,
      ).bind(newId('memberSubscription', now), channelId, comped, levelId, now + DAY, now),
    ]);
    for (const member of [graced, comped]) {
      await recomputeEntitlement(env.DB, channelId, member, now);
      expect(await entitledLevel(env.DB, channelId, member, now)).toBe(levelId);
    }

    const later = now + 2 * DAY;
    await runScheduled(jobsEnv().env, '*/5 * * * *', later);
    for (const member of [graced, comped]) {
      expect(await entitledLevel(env.DB, channelId, member, later)).toBeUndefined();
    }
    const comp = await env.DB.prepare(
      'SELECT status, revoke_reason FROM member_subscriptions WHERE member_id = ?1',
    )
      .bind(comped)
      .first();
    expect(comp).toEqual({ status: 'ended', revoke_reason: 'expired' });
  });
});

/** Mail the dev mailbox holds for an address. */
async function mailTo(to: string): Promise<{ category: string; subject: string; text: string }[]> {
  const listing = await env.DEV_MAILBOX.list({ prefix: 'mail/', include: ['customMetadata'] });
  const keys = listing.objects.filter((o) => o.customMetadata?.to === to).map((o) => o.key);
  return Promise.all(
    keys.map(async (key) =>
      (await env.DEV_MAILBOX.get(key))!.json<{ category: string; subject: string; text: string }>(),
    ),
  );
}

describe('Gift Pass reminders (5-minute cron)', () => {
  const email = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}@example.com`;

  async function giftRow(channelId: string, memberId: string, endsAt: number, now: number) {
    const id = newId('memberSubscription', now);
    await env.DB.prepare(
      `INSERT INTO member_subscriptions (id, channel_id, member_id, source, status, current_period_end, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'gift', 'active', ?4, ?5, ?5)`,
    )
      .bind(id, channelId, memberId, endsAt, now)
      .run();
    return id;
  }

  it('reminds a claimed pass a week before it ends, once, with a link to the plans page', async () => {
    const { channelId } = await seedChannel();
    const now = Date.now();
    const holder = email('holder');
    const memberId = await addMember(channelId, holder);
    await giftRow(channelId, memberId, now + 10 * DAY, now);
    // A pass whose holder also pays gets no reminder.
    const payer = email('payer');
    const payerId = await addMember(channelId, payer);
    await giftRow(channelId, payerId, now + 10 * DAY, now);
    await env.DB.prepare(
      `INSERT INTO member_subscriptions (id, channel_id, member_id, source, status, stripe_subscription_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'stripe', 'active', ?4, ?5, ?5)`,
    )
      .bind(
        newId('memberSubscription', now),
        channelId,
        payerId,
        `sub_${crypto.randomUUID().slice(0, 8)}`,
        now,
      )
      .run();

    // Ten days out: too early.
    await runScheduled(jobsEnv().env, '*/5 * * * *', now);
    expect(await mailTo(holder)).toHaveLength(0);

    const later = now + 4 * DAY;
    await runScheduled(jobsEnv().env, '*/5 * * * *', later);
    await runScheduled(jobsEnv().env, '*/5 * * * *', later + 5 * 60_000);
    const sent = await mailTo(holder);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.category).toBe('gift_pass_reminder');
    expect(sent[0]?.subject).toContain('gift subscription ends soon');
    expect(sent[0]?.text).toMatch(/http:\/\/ch-[a-z0-9-]+\.site\.localhost\/subscribe/);
    expect(await mailTo(payer)).toHaveLength(0);
  });

  it('reminds an unclaimed pass a fortnight before claim_by with a second link', async () => {
    const { channelId } = await seedChannel();
    const now = Date.now();
    const recipient = email('friend');
    const giftId = newId('giftPass', now);
    const claimBy = now + 20 * DAY;
    await env.DB.prepare(
      `INSERT INTO gift_passes (id, channel_id, months, purchaser_email, recipient_email, claim_token_hash, status, claim_by, created_at)
       VALUES (?1, ?2, 3, 'giver@example.com', ?3, ?4, 'paid', ?5, ?6)`,
    )
      .bind(giftId, channelId, recipient, 'f'.repeat(64), claimBy, now)
      .run();
    // A buyer who left no recipient is reminded instead.
    const buyer = email('buyer');
    await env.DB.prepare(
      `INSERT INTO gift_passes (id, channel_id, months, purchaser_email, status, claim_by, created_at)
       VALUES (?1, ?2, 1, ?3, 'paid', ?4, ?5)`,
    )
      .bind(newId('giftPass', now), channelId, buyer, claimBy, now)
      .run();

    await runScheduled(jobsEnv().env, '*/5 * * * *', now);
    expect(await mailTo(recipient)).toHaveLength(0);

    const later = now + 7 * DAY;
    await runScheduled(jobsEnv().env, '*/5 * * * *', later);
    await runScheduled(jobsEnv().env, '*/5 * * * *', later + 5 * 60_000);
    const sent = await mailTo(recipient);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain('is waiting');
    const token = /\/_swarm\/gift\/([A-Za-z0-9_-]+)/.exec(sent[0]?.text ?? '')?.[1];
    expect(token).toBeTruthy();
    const row = await env.DB.prepare(
      'SELECT claim_token_hash, reminder_token_hash, claim_reminded_at FROM gift_passes WHERE id = ?1',
    )
      .bind(giftId)
      .first<{
        claim_token_hash: string;
        reminder_token_hash: string;
        claim_reminded_at: number;
      }>();
    // The first link's hash is kept; the reminder's is added.
    expect(row?.claim_token_hash).toBe('f'.repeat(64));
    expect(row?.reminder_token_hash).toBe(await sha256Hex(token!));
    expect(row?.claim_reminded_at).toBe(later);

    const toBuyer = await mailTo(buyer);
    expect(toBuyer).toHaveLength(1);
    expect(toBuyer[0]?.text).toContain("hasn't been claimed yet");
  });

  it('sends nothing, and marks nothing, without mail', async () => {
    const { channelId } = await seedChannel();
    const now = Date.now();
    const memberId = await addMember(channelId, email('quiet'));
    const id = await giftRow(channelId, memberId, now + 3 * DAY, now);
    await runPaymentsLifecycle(env.DB, null, now);
    const row = await env.DB.prepare(
      'SELECT expiry_reminded_at FROM member_subscriptions WHERE id = ?1',
    )
      .bind(id)
      .first<{ expiry_reminded_at: number | null }>();
    expect(row?.expiry_reminded_at).toBeNull();
  });
});
