/**
 * The payments side of the jobs worker's 5-minute cron:
 * - entitlements whose grant ran out (grace expired, comp or gift ended, a Stripe period that
 *   passed without a renewal webhook) are recomputed, which drops or replaces the access;
 * - comp and gift rows past current_period_end become 'ended' (reason 'expired');
 * - unclaimed Gift Passes past claim_by expire;
 * - Gift Pass reminders, once each (when mail is given): the holder of a claimed pass a week before
 *   its access ends, unless they keep access another way; an unclaimed pass's recipient (or buyer)
 *   a fortnight before claim_by, with a second claim link. A row is marked before its mail goes
 *   out, and unmarked when sending throws, so a reminder is never sent twice and a failed one is
 *   retried by the next run;
 * - scheduled level prices whose effective_at passed become active, retiring the previous active
 *   price of the same level and interval. With existing = 'migrate', subscriptions on the old
 *   price move to the new one on Stripe with proration_behavior 'none', so the new amount applies
 *   from the next renewal. With 'grandfather' they stay where they are.
 * Every step works in bounded batches; what doesn't fit is picked up by the next run.
 */
import { recomputeEntitlement } from './entitlements';
import { all, first, run } from './db';
import type { PaymentsMail } from './payments';
import {
  GIFT_CLAIM_REMINDER_DAYS,
  GIFT_EXPIRY_REMINDER_DAYS,
  hashGiftClaimToken,
  newGiftClaimToken,
  sendGiftClaimReminder,
  sendGiftExpiryReminder,
} from './payments-mail';
import { DAY_MS, isSubscription } from './payments-sync';
import type { StripeApi } from './stripe';

const BATCH = 200;

export interface PaymentsLifecycleResult {
  recomputed: number;
  ended: number;
  giftsExpired: number;
  giftExpiryReminders: number;
  giftClaimReminders: number;
  reminderFailures: number;
  pricesPromoted: number;
  migrated: number;
  migrationFailures: number;
}

/**
 * `stripe` is null when payments are off: price migrations on Stripe are then skipped. Without
 * `mail` no Gift Pass reminders go out (and none are marked sent).
 */
export async function runPaymentsLifecycle(
  db: D1Database,
  stripe: StripeApi | null,
  now: number,
  mail: PaymentsMail | null = null,
): Promise<PaymentsLifecycleResult> {
  const result: PaymentsLifecycleResult = {
    recomputed: 0,
    ended: 0,
    giftsExpired: 0,
    giftExpiryReminders: 0,
    giftClaimReminders: 0,
    reminderFailures: 0,
    pricesPromoted: 0,
    migrated: 0,
    migrationFailures: 0,
  };
  const touched = new Map<string, string>();

  // Comp and gift grants that reached their end.
  const ended = await all<{ channel_id: string; member_id: string }>(
    db,
    `UPDATE member_subscriptions SET status = 'ended', revoked_at = ?1, revoke_reason = 'expired', updated_at = ?1
      WHERE id IN (SELECT id FROM member_subscriptions
                    WHERE source IN ('comp', 'gift') AND status = 'active' AND revoked_at IS NULL
                      AND current_period_end IS NOT NULL AND current_period_end <= ?1
                    LIMIT ?2)
     RETURNING channel_id, member_id`,
    now,
    BATCH,
  );
  result.ended = ended.length;
  for (const row of ended) touched.set(row.member_id, row.channel_id);

  // PayPal stops billing the moment a subscription is canceled and sends nothing when the paid
  // period runs out, so access ends here.
  const paypalEnded = await all<{ channel_id: string; member_id: string }>(
    db,
    `UPDATE member_subscriptions SET status = 'canceled', revoked_at = ?1, revoke_reason = 'canceled', updated_at = ?1
      WHERE id IN (SELECT id FROM member_subscriptions
                    WHERE paypal_subscription_id IS NOT NULL AND cancel_at IS NOT NULL AND cancel_at <= ?1
                      AND status <> 'canceled' AND revoked_at IS NULL
                    LIMIT ?2)
     RETURNING channel_id, member_id`,
    now,
    BATCH,
  );
  result.ended += paypalEnded.length;
  for (const row of paypalEnded) touched.set(row.member_id, row.channel_id);

  // Cached entitlements that have run out: grace that expired, a period with no renewal. Only
  // Members with subscription rows: Phase 4 entitlements without one are left alone.
  const expired = await all<{ channel_id: string; member_id: string }>(
    db,
    `SELECT e.channel_id, e.member_id FROM member_entitlements e
      WHERE e.kind = 'paid' AND e.expires_at IS NOT NULL AND e.expires_at <= ?1
        AND EXISTS (SELECT 1 FROM member_subscriptions s WHERE s.member_id = e.member_id)
      LIMIT ?2`,
    now,
    BATCH,
  );
  for (const row of expired) touched.set(row.member_id, row.channel_id);

  if (mail) {
    const reminders = await remindGiftPasses(db, mail, now);
    result.giftExpiryReminders = reminders.expiry;
    result.giftClaimReminders = reminders.claim;
    result.reminderFailures = reminders.failed;
  }

  // Unclaimed Gift Passes past their claim window.
  const gifts = await run(
    db,
    `UPDATE gift_passes SET status = 'expired'
      WHERE id IN (SELECT id FROM gift_passes WHERE status = 'paid' AND claim_by IS NOT NULL
                     AND claim_by <= ?1 LIMIT ?2)`,
    now,
    BATCH,
  );
  result.giftsExpired = gifts.meta.changes ?? 0;

  // Scheduled prices that are due.
  const due = await all<{
    id: string;
    level_id: string;
    channel_id: string;
    interval: string;
    amount: number;
    currency: string;
    existing: 'grandfather' | 'migrate';
    stripe_price_id: string | null;
  }>(
    db,
    `SELECT id, level_id, channel_id, interval, amount, currency, existing, stripe_price_id
       FROM level_prices WHERE status = 'scheduled' AND effective_at <= ?1
      ORDER BY effective_at LIMIT 50`,
    now,
  );
  for (const price of due) {
    const previous = await first<{ id: string }>(
      db,
      `SELECT id FROM level_prices WHERE level_id = ?1 AND interval = ?2 AND status = 'active'`,
      price.level_id,
      price.interval,
    );
    // Retire first: one active price per level and interval is a unique index.
    await db.batch([
      db
        .prepare(
          `UPDATE level_prices SET status = 'retired', retired_at = ?1
            WHERE level_id = ?2 AND interval = ?3 AND status = 'active' AND id <> ?4`,
        )
        .bind(now, price.level_id, price.interval, price.id),
      db
        .prepare(`UPDATE level_prices SET status = 'active' WHERE id = ?1 AND status = 'scheduled'`)
        .bind(price.id),
    ]);
    result.pricesPromoted += 1;
    if (price.existing !== 'migrate' || !previous || !stripe || !price.stripe_price_id) continue;
    const migration = await migrateSubscriptions(db, stripe, now, {
      fromPriceId: previous.id,
      toPriceId: price.id,
      toStripePriceId: price.stripe_price_id,
      channelId: price.channel_id,
      amount: price.amount,
      currency: price.currency,
    });
    result.migrated += migration.migrated;
    result.migrationFailures += migration.failed;
    for (const memberId of migration.members) touched.set(memberId, price.channel_id);
  }

  for (const [memberId, channelId] of touched) {
    await recomputeEntitlement(db, channelId, memberId, now);
    // A grant whose end has passed can still be the best one (a Stripe period with no renewal
    // webhook): it grants nothing, so the cache row goes and isn't picked up again.
    await run(
      db,
      `DELETE FROM member_entitlements
        WHERE member_id = ?1 AND kind = 'paid' AND expires_at IS NOT NULL AND expires_at <= ?2`,
      memberId,
      now,
    );
    result.recomputed += 1;
  }
  return result;
}

async function remindGiftPasses(
  db: D1Database,
  mail: PaymentsMail,
  now: number,
): Promise<{ expiry: number; claim: number; failed: number }> {
  const out = { expiry: 0, claim: 0, failed: 0 };
  const deps = { db, mail };

  // Claimed passes whose access ends within the week. Marking is the claim on the row.
  const ending = await all<{
    id: string;
    channel_id: string;
    member_id: string;
    level_id: string | null;
    current_period_end: number;
  }>(
    db,
    `UPDATE member_subscriptions SET expiry_reminded_at = ?1
      WHERE id IN (SELECT id FROM member_subscriptions
                    WHERE source = 'gift' AND status = 'active' AND revoked_at IS NULL
                      AND expiry_reminded_at IS NULL
                      AND current_period_end > ?1 AND current_period_end <= ?2
                    LIMIT ?3)
     RETURNING id, channel_id, member_id, level_id, current_period_end`,
    now,
    now + GIFT_EXPIRY_REMINDER_DAYS * DAY_MS,
    BATCH,
  );
  for (const row of ending) {
    // A Member who pays, or holds a grant that outlasts this one, keeps reading: no reminder.
    const covered = await first(
      db,
      `SELECT 1 FROM member_subscriptions
        WHERE member_id = ?1 AND channel_id = ?2 AND id <> ?3 AND revoked_at IS NULL
          AND ((source = 'stripe' AND status IN ('trialing', 'active', 'past_due'))
            OR (source = 'lifetime' AND status = 'lifetime')
            OR (source IN ('comp', 'gift') AND status = 'active'
                AND (current_period_end IS NULL OR current_period_end > ?4)))`,
      row.member_id,
      row.channel_id,
      row.id,
      row.current_period_end,
    );
    if (covered) continue;
    try {
      const sent = await sendGiftExpiryReminder(deps, {
        channelId: row.channel_id,
        memberId: row.member_id,
        levelId: row.level_id,
        endsAt: row.current_period_end,
      });
      if (sent) out.expiry += 1;
    } catch {
      out.failed += 1;
      await run(
        db,
        'UPDATE member_subscriptions SET expiry_reminded_at = NULL WHERE id = ?1',
        row.id,
      );
    }
  }

  // Unclaimed passes whose claim window closes within the fortnight.
  const waiting = await all<{
    id: string;
    channel_id: string;
    level_id: string | null;
    months: number;
    purchaser_email: string;
    recipient_email: string | null;
    claim_by: number;
  }>(
    db,
    `SELECT id, channel_id, level_id, months, purchaser_email, recipient_email, claim_by
       FROM gift_passes
      WHERE status = 'paid' AND claim_reminded_at IS NULL AND claim_by > ?1 AND claim_by <= ?2
      ORDER BY claim_by LIMIT ?3`,
    now,
    now + GIFT_CLAIM_REMINDER_DAYS * DAY_MS,
    BATCH,
  );
  for (const pass of waiting) {
    const token = newGiftClaimToken();
    const marked = await first(
      db,
      `UPDATE gift_passes SET claim_reminded_at = ?1, reminder_token_hash = ?2
        WHERE id = ?3 AND status = 'paid' AND claim_reminded_at IS NULL RETURNING id`,
      now,
      await hashGiftClaimToken(token),
      pass.id,
    );
    if (!marked) continue;
    const to = pass.recipient_email ?? pass.purchaser_email;
    // An erased buyer's address is scrubbed: there is nobody to remind.
    if (!to.includes('@')) continue;
    try {
      const sent = await sendGiftClaimReminder(deps, {
        channelId: pass.channel_id,
        to,
        toRecipient: pass.recipient_email !== null,
        purchaserEmail: pass.purchaser_email,
        months: pass.months,
        levelId: pass.level_id,
        token,
        claimBy: pass.claim_by,
      });
      if (sent) out.claim += 1;
    } catch {
      out.failed += 1;
      await run(
        db,
        `UPDATE gift_passes SET claim_reminded_at = NULL, reminder_token_hash = NULL
          WHERE id = ?1 AND status = 'paid'`,
        pass.id,
      );
    }
  }
  return out;
}

async function migrateSubscriptions(
  db: D1Database,
  stripe: StripeApi,
  now: number,
  input: {
    fromPriceId: string;
    toPriceId: string;
    toStripePriceId: string;
    channelId: string;
    amount: number;
    currency: string;
  },
): Promise<{ migrated: number; failed: number; members: string[] }> {
  const account = await first<{ stripe_account_id: string }>(
    db,
    `SELECT stripe_account_id FROM stripe_accounts WHERE channel_id = ?1 AND status = 'connected'`,
    input.channelId,
  );
  if (!account) return { migrated: 0, failed: 0, members: [] };
  const rows = await all<{ id: string; member_id: string; stripe_subscription_id: string }>(
    db,
    `SELECT id, member_id, stripe_subscription_id FROM member_subscriptions
      WHERE channel_id = ?1 AND price_id = ?2 AND source = 'stripe' AND revoked_at IS NULL
        AND stripe_subscription_id IS NOT NULL
        AND status IN ('active', 'trialing', 'past_due')`,
    input.channelId,
    input.fromPriceId,
  );
  const out = { migrated: 0, failed: 0, members: [] as string[] };
  for (const row of rows) {
    try {
      const path = `/v1/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`;
      const options = { account: account.stripe_account_id };
      const sub = await stripe.request<Record<string, unknown>>('GET', path, {}, options);
      const itemId = isSubscription(sub)
        ? ((sub.items as { data: { id?: unknown }[] }).data[0]?.id ?? null)
        : null;
      if (typeof itemId !== 'string') {
        out.failed += 1;
        continue;
      }
      await stripe.request(
        'POST',
        path,
        { items: [{ id: itemId, price: input.toStripePriceId }], proration_behavior: 'none' },
        { ...options, idempotencyKey: `migrate:${row.stripe_subscription_id}:${input.toPriceId}` },
      );
      await run(
        db,
        `UPDATE member_subscriptions SET price_id = ?1, amount = ?2, currency = ?3, updated_at = ?4
          WHERE id = ?5 AND channel_id = ?6`,
        input.toPriceId,
        input.amount,
        input.currency,
        now,
        row.id,
        input.channelId,
      );
      out.migrated += 1;
      out.members.push(row.member_id);
    } catch {
      out.failed += 1;
    }
  }
  return out;
}
