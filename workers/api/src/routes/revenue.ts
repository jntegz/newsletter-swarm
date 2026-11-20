// Revenue analytics, and the admin views of Gift Passes and pledges (Phase 5). The numbers come
// from member_subscriptions (entitlements) and payments (money that moved); Stripe stays the
// ledger of record.
import { createRoute } from '@hono/zod-openapi';
import { all, first, toIso } from '@swarm/db';
import {
  GiftPassSchema,
  MoneyListQuerySchema,
  PledgeNotifyResultSchema,
  PledgeSchema,
  RevenueQuerySchema,
  RevenueSchema,
  idPattern,
  page,
  type GiftPass,
  type Pledge,
  type Revenue,
} from '@swarm/domain';
import { composeMessage } from '@swarm/engine';
import { escapeHtml } from '@swarm/mail';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { createRouter, env } from '../lib/context';
import { mailer } from '../lib/mail';
import { errors, idParam, ok } from '../lib/openapi';
import { audit, requireFlag, siteOrigin } from '../lib/site';

export const revenue = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const DAY = 86_400_000;
const MAX_RANGE_DAYS = 366;
/** Pledges emailed per notify call; call again for the rest. */
const NOTIFY_BATCH = 200;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Statuses of subscriptions that never started.
const STARTED = `status NOT IN ('incomplete', 'incomplete_expired')`;

/**
 * One month of what a Stripe subscription row bills at time `at` (an SQL expression): the price
 * after recurring discounts that are still running then, yearly plans as a twelfth. Rows written
 * before discounts were captured (discounted_amount NULL) count at their price.
 */
const monthly = (at: string) =>
  `(CASE WHEN discounted_amount IS NOT NULL AND (discount_end IS NULL OR discount_end > ${at})
          THEN discounted_amount ELSE amount END)
   * (CASE interval WHEN 'year' THEN 1 / 12.0 ELSE 1 END)`;

/**
 * When a subscription row started paying (an SQL expression), or NULL while it hasn't: lifetime
 * purchases and subscriptions without a trial when they were created; trials when the trial
 * ended, once the subscription is active or an invoice for it was paid. ?2 is now.
 */
const PAID_FROM = `CASE
    WHEN s.source = 'lifetime' THEN s.created_at
    WHEN s.trial_end IS NULL THEN s.created_at
    WHEN s.trial_end <= ?2 AND (s.status = 'active' OR EXISTS (
           SELECT 1 FROM payments p WHERE p.subscription_id = s.id AND p.kind = 'invoice'
              AND p.amount > 0)) THEN s.trial_end
  END`;

revenue.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/revenue',
    tags: ['Revenue'],
    summary: 'Revenue analytics',
    description:
      'MRR (paying subscriptions only, after recurring discounts, yearly plans as a twelfth), the MRR trials would add, paid and trialing Members and complimentary access now; churn of paying subscriptions, new paid Members, conversion by source and revenue by day for the range (UTC days, inclusive; at most 366 days; default the last 30). Amounts are in minor units per currency. Conversion by source: Members who joined in the range, grouped by utm_source (else the signup kind, else form, import or direct), and how many of them have paid.',
    request: { params: channelParam, query: RevenueQuerySchema },
    responses: {
      200: ok(RevenueSchema, 'Revenue'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const query = c.req.valid('query');
    await requireChannel(c, channelId, 'viewer');
    const db = env(c).DB;
    const now = Date.now();
    const toDay = query.to ?? day(now);
    const fromDay = query.from ?? day(Date.parse(`${toDay}T00:00:00Z`) - 29 * DAY);
    const from = Date.parse(`${fromDay}T00:00:00Z`);
    const to = Date.parse(`${toDay}T00:00:00Z`) + DAY;
    if (from > to - DAY) {
      const message = 'The start day comes before the end day.';
      throw new ApiError('invalid_input', message, [{ path: 'from', message }]);
    }
    if ((to - from) / DAY > MAX_RANGE_DAYS) {
      const message = `Pick at most ${MAX_RANGE_DAYS} days.`;
      throw new ApiError('invalid_input', message, [{ path: 'from', message }]);
    }

    // Paying subscriptions only: active, or past due within grace. Trials are reported apart.
    const mrr = await all<{ currency: string; amount: number }>(
      db,
      `SELECT currency, sum(${monthly('?2')}) AS amount
         FROM member_subscriptions
        WHERE channel_id = ?1 AND source = 'stripe' AND revoked_at IS NULL
          AND interval IN ('month', 'year') AND amount IS NOT NULL AND currency IS NOT NULL
          AND (status = 'active' OR (status = 'past_due' AND grace_until > ?2))
        GROUP BY currency ORDER BY currency`,
      channelId,
      now,
    );
    // What trials would add once they convert, with the discounts that still run at trial end.
    const trialMrr = await all<{ currency: string; amount: number }>(
      db,
      `SELECT currency, sum(${monthly('coalesce(trial_end, ?2)')}) AS amount
         FROM member_subscriptions
        WHERE channel_id = ?1 AND source = 'stripe' AND revoked_at IS NULL AND status = 'trialing'
          AND cancel_at_period_end = 0
          AND interval IN ('month', 'year') AND amount IS NOT NULL AND currency IS NOT NULL
        GROUP BY currency ORDER BY currency`,
      channelId,
      now,
    );
    const counts = await first<{ paid: number; trialing: number; comp: number }>(
      db,
      `SELECT
         count(DISTINCT CASE WHEN (source = 'stripe' AND (status = 'active'
                  OR (status = 'past_due' AND grace_until > ?2)))
                OR (source = 'lifetime' AND status = 'lifetime') THEN member_id END) AS paid,
         count(DISTINCT CASE WHEN source = 'stripe' AND status = 'trialing' THEN member_id END) AS trialing,
         count(DISTINCT CASE WHEN source IN ('comp', 'gift') AND status = 'active'
                AND (current_period_end IS NULL OR current_period_end > ?2) THEN member_id END) AS comp
         FROM member_subscriptions WHERE channel_id = ?1 AND revoked_at IS NULL`,
      channelId,
      now,
    );
    // Churn among subscriptions that were paying when the range began; a trial that ends
    // without paying is not churn.
    const churn = await first<{ at_start: number; canceled: number }>(
      db,
      `SELECT count(*) AS at_start,
              coalesce(sum((canceled_at >= ?3 AND canceled_at < ?4) OR (revoked_at >= ?3 AND revoked_at < ?4)), 0) AS canceled
         FROM (SELECT s.canceled_at, s.revoked_at, ${PAID_FROM} AS paid_from
                 FROM member_subscriptions s
                WHERE s.channel_id = ?1 AND s.source = 'stripe' AND s.${STARTED})
        WHERE paid_from < ?3
          AND (canceled_at IS NULL OR canceled_at >= ?3) AND (revoked_at IS NULL OR revoked_at >= ?3)`,
      channelId,
      now,
      from,
      to,
    );
    // Members whose first paid subscription started paying in the range.
    const newPaid = await first<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM (
         SELECT s.member_id, min(${PAID_FROM}) AS started FROM member_subscriptions s
          WHERE s.channel_id = ?1 AND s.source IN ('stripe', 'lifetime') AND s.${STARTED}
          GROUP BY s.member_id)
        WHERE started >= ?3 AND started < ?4`,
      channelId,
      now,
      from,
      to,
    );
    const bySource = await all<{ source: string; members: number; paid: number }>(
      db,
      `SELECT coalesce(nullif(json_extract(m.source_json, '$.utm_source'), ''),
                       nullif(json_extract(m.source_json, '$.kind'), ''),
                       CASE WHEN m.form_id IS NOT NULL THEN 'form'
                            WHEN m.import_id IS NOT NULL THEN 'import' ELSE 'direct' END) AS source,
              count(*) AS members,
              sum(EXISTS (SELECT 1 FROM member_subscriptions s
                           WHERE s.member_id = m.id AND s.source IN ('stripe', 'lifetime')
                             AND s.${STARTED} AND (${PAID_FROM}) < ?4)) AS paid
         FROM members m
        WHERE m.channel_id = ?1 AND m.created_at >= ?3 AND m.created_at < ?4
        GROUP BY 1 ORDER BY members DESC, source LIMIT 50`,
      channelId,
      now,
      from,
      to,
    );
    const byDay = await all<{ day: string; currency: string; amount: number }>(
      db,
      `SELECT date(occurred_at / 1000, 'unixepoch') AS day, currency, sum(amount) AS amount
         FROM payments WHERE channel_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3
        GROUP BY 1, 2 ORDER BY 1, 2`,
      channelId,
      from,
      to,
    );
    const lifetime = await all<{ currency: string; amount: number }>(
      db,
      `SELECT currency, sum(amount) AS amount FROM payments WHERE channel_id = ?1
        GROUP BY currency ORDER BY currency`,
      channelId,
    );
    const atStart = churn?.at_start ?? 0;
    const canceled = churn?.canceled ?? 0;
    const data: Revenue = {
      from: fromDay,
      to: toDay,
      mrr: mrr.map((r) => ({ currency: r.currency, amount: Math.round(r.amount) })),
      trialMrr: trialMrr.map((r) => ({ currency: r.currency, amount: Math.round(r.amount) })),
      activePaid: counts?.paid ?? 0,
      trialing: counts?.trialing ?? 0,
      complimentary: counts?.comp ?? 0,
      churn: {
        activeAtStart: atStart,
        canceled,
        rate: atStart ? Math.round((canceled / atStart) * 10_000) / 10_000 : null,
      },
      newPaid: newPaid?.n ?? 0,
      conversionBySource: bySource.map((r) => ({
        source: r.source,
        members: r.members,
        paid: r.paid,
        rate: r.members ? Math.round((r.paid / r.members) * 10_000) / 10_000 : 0,
      })),
      revenueByDay: byDay,
      lifetimeRevenue: lifetime,
    };
    return c.json({ data }, 200);
  },
);

// ---- Gift Passes -----------------------------------------------------------------------------

interface GiftPassRow {
  id: string;
  level_id: string | null;
  months: number;
  purchaser_email: string;
  recipient_email: string | null;
  status: GiftPass['status'];
  claimed_member_id: string | null;
  claimed_at: number | null;
  claim_by: number | null;
  created_at: number;
}

const iso = (value: number | null) => (value === null ? null : toIso(value));

function checkCursor(cursor: string | undefined, kind: 'giftPass' | 'pledge'): void {
  if (cursor && !idPattern(kind).test(cursor)) {
    throw new ApiError('invalid_input', 'That page cursor is not valid.');
  }
}

revenue.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/gift-passes',
    tags: ['Gift Passes'],
    summary: 'Gift Passes bought for this Channel, newest first',
    description: 'Needs the gift_passes flag. Filter with status.',
    request: { params: channelParam, query: MoneyListQuerySchema },
    responses: {
      200: ok(page(GiftPassSchema), 'Gift Passes'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { cursor, limit, status } = c.req.valid('query');
    const access = await requireChannel(c, channelId, 'viewer');
    await requireFlag(c, access, 'gift_passes', 'Gift subscriptions are not available.');
    checkCursor(cursor, 'giftPass');
    const rows = await all<GiftPassRow>(
      env(c).DB,
      `SELECT * FROM gift_passes WHERE channel_id = ?1 AND (?2 IS NULL OR id < ?2)
         AND (?3 IS NULL OR status = ?3) ORDER BY id DESC LIMIT ?4`,
      channelId,
      cursor ?? null,
      status ?? null,
      limit + 1,
    );
    const items = rows.slice(0, limit).map((row): GiftPass => ({
      id: row.id,
      levelId: row.level_id,
      months: row.months,
      purchaserEmail: row.purchaser_email,
      recipientEmail: row.recipient_email,
      status: row.status,
      claimedMemberId: row.claimed_member_id,
      claimedAt: iso(row.claimed_at),
      claimBy: iso(row.claim_by),
      createdAt: toIso(row.created_at),
    }));
    const nextCursor = rows.length > limit ? (items.at(-1)?.id ?? null) : null;
    return c.json({ data: { items, nextCursor } }, 200);
  },
);

// ---- Pledges ---------------------------------------------------------------------------------

interface PledgeRow {
  id: string;
  member_id: string;
  member_email: string | null;
  level_id: string | null;
  interval: Pledge['interval'];
  currency: string;
  amount: number;
  status: Pledge['status'];
  created_at: number;
  notified_at: number | null;
  converted_at: number | null;
}

revenue.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/pledges',
    tags: ['Pledges'],
    summary: 'Pledges to pay once paid levels launch, newest first',
    description: 'Needs the pledges flag. Filter with status.',
    request: { params: channelParam, query: MoneyListQuerySchema },
    responses: {
      200: ok(page(PledgeSchema), 'Pledges'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { cursor, limit, status } = c.req.valid('query');
    const access = await requireChannel(c, channelId, 'viewer');
    await requireFlag(c, access, 'pledges', 'Pledges are not available.');
    checkCursor(cursor, 'pledge');
    const rows = await all<PledgeRow>(
      env(c).DB,
      `SELECT p.*, m.email AS member_email FROM pledges p LEFT JOIN members m ON m.id = p.member_id
        WHERE p.channel_id = ?1 AND (?2 IS NULL OR p.id < ?2) AND (?3 IS NULL OR p.status = ?3)
        ORDER BY p.id DESC LIMIT ?4`,
      channelId,
      cursor ?? null,
      status ?? null,
      limit + 1,
    );
    const items = rows.slice(0, limit).map((row): Pledge => ({
      id: row.id,
      memberId: row.member_id,
      memberEmail: row.member_email,
      levelId: row.level_id,
      interval: row.interval,
      currency: row.currency,
      amount: row.amount,
      status: row.status,
      createdAt: toIso(row.created_at),
      notifiedAt: iso(row.notified_at),
      convertedAt: iso(row.converted_at),
    }));
    const nextCursor = rows.length > limit ? (items.at(-1)?.id ?? null) : null;
    return c.json({ data: { items, nextCursor } }, 200);
  },
);

revenue.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/pledges/notify',
    tags: ['Pledges'],
    summary: 'Tell pledgers that paid levels are open',
    description: `Admin role; needs the pledges flag and an active public Membership level (409 otherwise). Emails up to ${NOTIFY_BATCH} open pledgers a link to the site's /subscribe page and marks their pledges notified; Members who unsubscribed, bounced or complained are marked without an email. Call again while remaining > 0.`,
    request: { params: channelParam },
    responses: {
      200: ok(PledgeNotifyResultSchema, 'Notified'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'admin');
    await requireFlag(c, access, 'pledges', 'Pledges are not available.');
    const e = env(c);
    const db = e.DB;
    const launched = await first(
      db,
      `SELECT 1 FROM membership_levels l WHERE l.channel_id = ?1 AND l.status = 'active'
          AND l.visibility = 'public'
          AND EXISTS (SELECT 1 FROM level_prices p WHERE p.level_id = l.id AND p.status = 'active')`,
      channelId,
    );
    if (!launched) {
      throw new ApiError('conflict', 'Open a public paid plan before notifying pledgers.');
    }
    const channel = await first<{ name: string }>(
      db,
      'SELECT name FROM channels WHERE id = ?1',
      channelId,
    );
    const name = channel?.name ?? 'This publication';
    const { origin } = await siteOrigin(c, channelId);
    const link = new URL('/subscribe', origin).toString();
    const rows = await all<{ id: string; email: string; status: string }>(
      db,
      `SELECT p.id, m.email, m.status FROM pledges p JOIN members m ON m.id = p.member_id
        WHERE p.channel_id = ?1 AND p.status = 'open' ORDER BY p.id LIMIT ?2`,
      channelId,
      NOTIFY_BATCH,
    );
    const mail = mailer(e);
    let emailed = 0;
    const now = Date.now();
    for (const row of rows) {
      if (row.status === 'active' || row.status === 'paused') {
        const message = await composeMessage(db, {
          key: 'pledge',
          channelId,
          channelName: name,
          accent: '#6c4cf1',
          variables: { channel_name: name, plans_url: link },
          fallback: {
            subject: `${name}: paid subscriptions are open`,
            text: `You pledged to support ${name}. Paid subscriptions are open now:\n\n${link}\n\nNothing is charged until you subscribe.`,
            html: `<p>You pledged to support ${escapeHtml(name)}. Paid subscriptions are open now.</p><p><a href="${escapeHtml(link)}">See plans</a></p><p>Nothing is charged until you subscribe.</p>`,
          },
        });
        await mail.send({
          category: 'pledge',
          from: { name, address: e.MAIL_FROM },
          to: row.email,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
        emailed += 1;
      }
      await db
        .prepare(
          `UPDATE pledges SET status = 'notified', notified_at = ?1 WHERE id = ?2 AND status = 'open'`,
        )
        .bind(now, row.id)
        .run();
    }
    const left = await first<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM pledges WHERE channel_id = ?1 AND status = 'open'`,
      channelId,
    );
    await audit(c, access, 'pledges.notified', 'channel', channelId, {
      notified: rows.length,
      emailed,
    });
    return c.json({ data: { notified: rows.length, emailed, remaining: left?.n ?? 0 } }, 200);
  },
);
