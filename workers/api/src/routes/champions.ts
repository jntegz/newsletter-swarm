// Champions (Phase 6): settings, rewards, milestones, the operator leaderboard, referral review,
// awards and a Member's share link. The counting rules and fulfilment live in
// packages/engine/src/champions.ts; the jobs worker counts every minute.
//
// Roles: viewer reads; editor reviews held referrals; admin changes settings, rewards and
// milestones and completes awards (rewards grant paid access, as comp grants do). Approvals,
// rejections and award completions are audited.
import { createRoute } from '@hono/zod-openapi';
import { all, first, isUniqueViolation, toIso } from '@swarm/db';
import {
  ChampionAwardListQuerySchema,
  ChampionAwardListSchema,
  ChampionAwardSchema,
  ChampionLeaderboardSchema,
  ChampionMilestoneSchema,
  ChampionRewardSchema,
  ChampionSettingsSchema,
  CreateChampionMilestoneSchema,
  CreateChampionRewardSchema,
  CursorQuerySchema,
  FulfilChampionAwardSchema,
  MemberChampionSchema,
  ReferralListQuerySchema,
  ReferralListSchema,
  ReferralSchema,
  UpdateChampionMilestoneSchema,
  UpdateChampionRewardSchema,
  UpdateChampionSettingsSchema,
  idPattern,
  newId,
  type ChampionAward,
  type ChampionMilestone,
  type ChampionReward,
  type ChampionRewardKind,
  type ChampionSettings,
  type Referral,
  type ReferralReviewReason,
  type ReferralStatus,
} from '@swarm/domain';
import {
  bumpCacheStatement,
  championLinks,
  championProgress,
  championSettings,
  checkMilestones,
  completeAward,
  ensureChampionCode,
  mailAdapter,
  reviewReferral,
  type ChampionDeps,
  type ChampionSettingsRow,
} from '@swarm/engine';
import { createLogger, ApiError } from '@swarm/runtime';
import { z } from '@hono/zod-openapi';
import { requireChannel } from '../lib/access';
import { createRouter, env, type AppContext } from '../lib/context';
import { requestMemberLinks } from '../lib/vault';
import { requireChannelMember } from '../lib/levels';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { audit, siteOrigin } from '../lib/site';

export const champions = createRouter();

const log = createLogger({ service: 'api' });

const channelParam = idParam('channelId', idPattern('channel'));
const rewardParams = channelParam.extend(idParam('rewardId', idPattern('championReward')).shape);
const milestoneParams = channelParam.extend(
  idParam('milestoneId', idPattern('championMilestone')).shape,
);
const referralParams = channelParam.extend(idParam('referralId', idPattern('referral')).shape);
const awardParams = channelParam.extend(idParam('awardId', idPattern('championAward')).shape);
const memberParams = channelParam.extend(idParam('memberId', idPattern('member')).shape);

const TAG = ['Champions'];
const base = '/api/v1/channels/{channelId}/champions';

function championDeps(c: AppContext): ChampionDeps {
  const e = env(c);
  return {
    db: e.DB,
    mail: {
      adapter: mailAdapter(e, e.PLATFORM_MAIL_DOMAIN),
      platformMailDomain: e.PLATFORM_MAIL_DOMAIN,
      // Minted by the vault under this request's credential.
      memberLinks: requestMemberLinks(c),
      captureOrigin: e.CAPTURE_ORIGIN.replace(/\/$/, ''),
    },
    log: (message, fields) => log.warn(message, fields),
  };
}

const invalid = (path: string, message: string) =>
  new ApiError('invalid_input', message, [{ path, message }]);

// ---- Mappers ---------------------------------------------------------------------------------

const toSettings = (row: ChampionSettingsRow): ChampionSettings => ({
  enabled: row.enabled === 1,
  engagementDays: row.engagement_days,
  clusterLimit: row.cluster_limit,
  clusterWindowHours: row.cluster_window_hours,
  blockDisposable: row.block_disposable === 1,
  publicLeaderboard: row.public_leaderboard === 1,
  shareText: row.share_text,
  updatedAt: row.updated_at === null ? null : toIso(row.updated_at),
});

interface RewardRow {
  id: string;
  channel_id: string;
  kind: ChampionRewardKind;
  name: string;
  description: string | null;
  level_id: string | null;
  comp_days: number | null;
  coupon_id: string | null;
  goods_ref: string | null;
  fulfil_flow_id: string | null;
  status: 'active' | 'archived';
  created_at: number;
  updated_at: number;
}

const toReward = (row: RewardRow): ChampionReward => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  description: row.description,
  levelId: row.level_id,
  compDays: row.comp_days,
  couponId: row.coupon_id,
  goodsRef: row.goods_ref,
  fulfilFlowId: row.fulfil_flow_id,
  status: row.status,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

interface MilestoneRow {
  id: string;
  channel_id: string;
  referrals_required: number;
  name: string;
  reward_id: string | null;
  status: 'active' | 'archived';
  created_at: number;
  updated_at: number;
}

const toMilestone = (row: MilestoneRow): ChampionMilestone => ({
  id: row.id,
  referralsRequired: row.referrals_required,
  name: row.name,
  rewardId: row.reward_id,
  status: row.status,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

interface ReferralRow {
  id: string;
  referrer_id: string;
  referrer_email: string | null;
  referred_id: string;
  referred_email: string | null;
  status: ReferralStatus;
  review_reason: ReferralReviewReason | null;
  ip_prefix: string | null;
  created_at: number;
  counted_at: number | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
}

const SELECT_REFERRALS = `SELECT r.id, r.referrer_id, a.email AS referrer_email, r.referred_id,
    b.email AS referred_email, r.status, r.review_reason, r.ip_prefix, r.created_at, r.counted_at,
    r.reviewed_by, r.reviewed_at
  FROM referrals r LEFT JOIN members a ON a.id = r.referrer_id LEFT JOIN members b ON b.id = r.referred_id`;

const toReferral = (row: ReferralRow): Referral => ({
  id: row.id,
  referrerId: row.referrer_id,
  referrerEmail: row.referrer_email,
  referredId: row.referred_id,
  referredEmail: row.referred_email,
  status: row.status,
  reviewReason: row.review_reason,
  ipPrefix: row.ip_prefix,
  createdAt: toIso(row.created_at),
  countedAt: row.counted_at === null ? null : toIso(row.counted_at),
  reviewedBy: row.reviewed_by,
  reviewedAt: row.reviewed_at === null ? null : toIso(row.reviewed_at),
});

interface AwardRow {
  id: string;
  member_id: string;
  member_email: string | null;
  milestone_id: string;
  milestone_name: string | null;
  reward_id: string | null;
  reward_name: string | null;
  reward_kind: ChampionRewardKind | null;
  status: ChampionAward['status'];
  comp_grant_id: string | null;
  detail: string | null;
  created_at: number;
  fulfilled_at: number | null;
}

const SELECT_AWARDS = `SELECT a.id, a.member_id, m.email AS member_email, a.milestone_id,
    ms.name AS milestone_name, a.reward_id, w.name AS reward_name, w.kind AS reward_kind, a.status,
    a.comp_grant_id, a.detail, a.created_at, a.fulfilled_at
  FROM champion_awards a LEFT JOIN members m ON m.id = a.member_id
  LEFT JOIN champion_milestones ms ON ms.id = a.milestone_id
  LEFT JOIN champion_rewards w ON w.id = a.reward_id`;

const toAward = (row: AwardRow): ChampionAward => ({
  id: row.id,
  memberId: row.member_id,
  memberEmail: row.member_email,
  milestoneId: row.milestone_id,
  milestoneName: row.milestone_name,
  rewardId: row.reward_id,
  rewardName: row.reward_name,
  rewardKind: row.reward_kind,
  status: row.status,
  compGrantId: row.comp_grant_id,
  detail: row.detail,
  createdAt: toIso(row.created_at),
  fulfilledAt: row.fulfilled_at === null ? null : toIso(row.fulfilled_at),
});

// ---- Reference checks ------------------------------------------------------------------------

async function checkRewardRefs(
  db: D1Database,
  channelId: string,
  value: { levelId?: string | null; couponId?: string | null; fulfilFlowId?: string | null },
): Promise<void> {
  if (value.levelId) {
    const level = await first<{ status: string }>(
      db,
      'SELECT status FROM membership_levels WHERE id = ?1 AND channel_id = ?2',
      value.levelId,
      channelId,
    );
    if (!level) throw invalid('levelId', 'Choose a paid plan of this publication.');
    if (level.status !== 'active')
      throw invalid('levelId', 'Choose a paid plan that is not archived.');
  }
  if (value.couponId) {
    const coupon = await first(
      db,
      `SELECT 1 FROM coupons WHERE id = ?1 AND channel_id = ?2 AND status = 'active'`,
      value.couponId,
      channelId,
    );
    if (!coupon) throw invalid('couponId', 'Choose an active coupon of this publication.');
  }
  if (value.fulfilFlowId) {
    const flow = await first(
      db,
      'SELECT 1 FROM flows WHERE id = ?1 AND channel_id = ?2 AND deleted_at IS NULL',
      value.fulfilFlowId,
      channelId,
    );
    if (!flow) throw invalid('fulfilFlowId', 'Choose an automation of this publication.');
  }
}

async function requireReward(db: D1Database, channelId: string, rewardId: string) {
  const row = await first<RewardRow>(
    db,
    'SELECT * FROM champion_rewards WHERE id = ?1 AND channel_id = ?2',
    rewardId,
    channelId,
  );
  if (!row) throw new ApiError('not_found', 'Reward not found.');
  return row;
}

async function requireMilestone(db: D1Database, channelId: string, milestoneId: string) {
  const row = await first<MilestoneRow>(
    db,
    'SELECT * FROM champion_milestones WHERE id = ?1 AND channel_id = ?2',
    milestoneId,
    channelId,
  );
  if (!row) throw new ApiError('not_found', 'Milestone not found.');
  return row;
}

async function checkMilestoneReward(db: D1Database, channelId: string, rewardId: string) {
  const reward = await first<{ status: string }>(
    db,
    'SELECT status FROM champion_rewards WHERE id = ?1 AND channel_id = ?2',
    rewardId,
    channelId,
  );
  if (!reward || reward.status !== 'active') {
    throw invalid('rewardId', 'Choose an active reward of this publication.');
  }
}

const duplicateMilestone = () =>
  new ApiError('conflict', 'Another milestone already needs this many referrals.');

/**
 * Awards a milestone to every Champion who already has enough counted referrals (a milestone added
 * or lowered, or Champions switched on). After the response; at most 500 Champions per call.
 */
function backfillAwards(c: AppContext, channelId: string, minimum: number): void {
  const deps = championDeps(c);
  const work = (async () => {
    const rows = await all<{ referrer_id: string }>(
      deps.db,
      `SELECT referrer_id FROM referrals WHERE channel_id = ?1 AND status = 'counted'
        GROUP BY referrer_id HAVING COUNT(*) >= ?2 LIMIT 500`,
      channelId,
      minimum,
    );
    for (const row of rows) await checkMilestones(deps, channelId, row.referrer_id);
  })().catch((error: Error) => log.error('champion backfill failed', { error: error.message }));
  c.executionCtx.waitUntil(work);
}

// ---- Settings --------------------------------------------------------------------------------

champions.openapi(
  createRoute({
    method: 'get',
    path: `${base}/settings`,
    tags: TAG,
    summary: 'Champions settings of a Channel (defaults when never saved)',
    request: { params: channelParam },
    responses: {
      200: ok(ChampionSettingsSchema, 'Settings'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    return c.json({ data: toSettings(await championSettings(env(c).DB, channelId)) }, 200);
  },
);

champions.openapi(
  createRoute({
    method: 'patch',
    path: `${base}/settings`,
    tags: TAG,
    summary: 'Change Champions settings',
    description:
      'Admin role. Fraud thresholds apply to referrals still pending. Turning Champions on awards milestones already reached. Bumps the site cache (the public /champions page).',
    request: { params: channelParam, body: jsonBody(UpdateChampionSettingsSchema) },
    responses: {
      200: ok(ChampionSettingsSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const db = env(c).DB;
    const current = await championSettings(db, channelId);
    const bool = (value: boolean | undefined, fallback: number) =>
      value === undefined ? fallback : value ? 1 : 0;
    const next = {
      enabled: bool(input.enabled, current.enabled),
      engagement_days: input.engagementDays ?? current.engagement_days,
      cluster_limit: input.clusterLimit ?? current.cluster_limit,
      cluster_window_hours: input.clusterWindowHours ?? current.cluster_window_hours,
      block_disposable: bool(input.blockDisposable, current.block_disposable),
      public_leaderboard: bool(input.publicLeaderboard, current.public_leaderboard),
      share_text: input.shareText === undefined ? current.share_text : input.shareText || null,
    };
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          `INSERT INTO champion_settings (channel_id, enabled, engagement_days, cluster_limit,
             cluster_window_hours, block_disposable, public_leaderboard, share_text, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
           ON CONFLICT (channel_id) DO UPDATE SET enabled = ?2, engagement_days = ?3,
             cluster_limit = ?4, cluster_window_hours = ?5, block_disposable = ?6,
             public_leaderboard = ?7, share_text = ?8, updated_at = ?9`,
        )
        .bind(
          channelId,
          next.enabled,
          next.engagement_days,
          next.cluster_limit,
          next.cluster_window_hours,
          next.block_disposable,
          next.public_leaderboard,
          next.share_text,
          now,
        ),
      bumpCacheStatement(db, channelId, now),
    ]);
    await audit(c, access, 'champions.settings_changed', 'channel', channelId, { ...input });
    if (current.enabled !== 1 && next.enabled === 1) backfillAwards(c, channelId, 1);
    return c.json({ data: toSettings(await championSettings(db, channelId)) }, 200);
  },
);

// ---- Rewards ---------------------------------------------------------------------------------

champions.openapi(
  createRoute({
    method: 'get',
    path: `${base}/rewards`,
    tags: TAG,
    summary: 'Rewards, archived ones included',
    request: { params: channelParam },
    responses: {
      200: ok(z.object({ items: z.array(ChampionRewardSchema) }), 'Rewards'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const rows = await all<RewardRow>(
      env(c).DB,
      `SELECT * FROM champion_rewards WHERE channel_id = ?1 ORDER BY status, created_at LIMIT 200`,
      channelId,
    );
    return c.json({ data: { items: rows.map(toReward) } }, 200);
  },
);

champions.openapi(
  createRoute({
    method: 'post',
    path: `${base}/rewards`,
    tags: TAG,
    summary: 'Create a reward',
    description:
      'Admin role. comp_level needs levelId and compDays; coupon needs couponId (its code is emailed); goods (Phase 8) and manual awards wait for the operator.',
    request: { params: channelParam, body: jsonBody(CreateChampionRewardSchema) },
    responses: {
      201: ok(ChampionRewardSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const db = env(c).DB;
    const value = {
      levelId: input.kind === 'comp_level' ? (input.levelId ?? null) : null,
      compDays: input.kind === 'comp_level' ? (input.compDays ?? null) : null,
      couponId: input.kind === 'coupon' ? (input.couponId ?? null) : null,
      goodsRef: input.kind === 'goods' ? (input.goodsRef ?? null) : null,
      fulfilFlowId: input.fulfilFlowId ?? null,
    };
    await checkRewardRefs(db, channelId, value);
    const id = newId('championReward');
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO champion_rewards (id, channel_id, kind, name, description, level_id, comp_days,
           coupon_id, goods_ref, fulfil_flow_id, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'active', ?11, ?11)`,
      )
      .bind(
        id,
        channelId,
        input.kind,
        input.name,
        input.description ?? null,
        value.levelId,
        value.compDays,
        value.couponId,
        value.goodsRef,
        value.fulfilFlowId,
        now,
      )
      .run();
    await audit(c, access, 'champions.reward_created', 'champion_reward', id, {
      kind: input.kind,
      name: input.name,
    });
    return c.json({ data: toReward(await requireReward(db, channelId, id)) }, 201);
  },
);

champions.openapi(
  createRoute({
    method: 'patch',
    path: `${base}/rewards/{rewardId}`,
    tags: TAG,
    summary: 'Change or archive a reward',
    description: 'Admin role. The kind cannot change. Awards already made keep what they granted.',
    request: { params: rewardParams, body: jsonBody(UpdateChampionRewardSchema) },
    responses: {
      200: ok(ChampionRewardSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, rewardId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const db = env(c).DB;
    const row = await requireReward(db, channelId, rewardId);
    const pick = <T>(value: T | undefined, current: T) => (value === undefined ? current : value);
    const next = {
      name: pick(input.name, row.name),
      description: pick(input.description, row.description),
      levelId: row.kind === 'comp_level' ? pick(input.levelId, row.level_id) : null,
      compDays: row.kind === 'comp_level' ? pick(input.compDays, row.comp_days) : null,
      couponId: row.kind === 'coupon' ? pick(input.couponId, row.coupon_id) : null,
      goodsRef: row.kind === 'goods' ? pick(input.goodsRef, row.goods_ref) : null,
      fulfilFlowId: pick(input.fulfilFlowId, row.fulfil_flow_id),
      status: pick(input.status, row.status),
    };
    if (row.kind === 'comp_level' && (!next.levelId || !next.compDays)) {
      throw invalid(next.levelId ? 'compDays' : 'levelId', 'Required.');
    }
    if (row.kind === 'coupon' && !next.couponId) throw invalid('couponId', 'Required.');
    await checkRewardRefs(db, channelId, {
      ...(input.levelId ? { levelId: next.levelId } : {}),
      ...(input.couponId ? { couponId: next.couponId } : {}),
      ...(input.fulfilFlowId ? { fulfilFlowId: next.fulfilFlowId } : {}),
    });
    await db
      .prepare(
        `UPDATE champion_rewards SET name = ?1, description = ?2, level_id = ?3, comp_days = ?4,
           coupon_id = ?5, goods_ref = ?6, fulfil_flow_id = ?7, status = ?8, updated_at = ?9
         WHERE id = ?10`,
      )
      .bind(
        next.name,
        next.description,
        next.levelId,
        next.compDays,
        next.couponId,
        next.goodsRef,
        next.fulfilFlowId,
        next.status,
        Date.now(),
        rewardId,
      )
      .run();
    await audit(c, access, 'champions.reward_changed', 'champion_reward', rewardId, { ...input });
    return c.json({ data: toReward(await requireReward(db, channelId, rewardId)) }, 200);
  },
);

// ---- Milestones ------------------------------------------------------------------------------

champions.openapi(
  createRoute({
    method: 'get',
    path: `${base}/milestones`,
    tags: TAG,
    summary: 'Milestones, by referrals needed',
    request: { params: channelParam },
    responses: {
      200: ok(z.object({ items: z.array(ChampionMilestoneSchema) }), 'Milestones'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const rows = await all<MilestoneRow>(
      env(c).DB,
      `SELECT * FROM champion_milestones WHERE channel_id = ?1
        ORDER BY status, referrals_required LIMIT 200`,
      channelId,
    );
    return c.json({ data: { items: rows.map(toMilestone) } }, 200);
  },
);

champions.openapi(
  createRoute({
    method: 'post',
    path: `${base}/milestones`,
    tags: TAG,
    summary: 'Create a milestone',
    description:
      'Admin role. Active milestones need distinct referral counts. Champions who already have enough counted referrals are awarded it.',
    request: { params: channelParam, body: jsonBody(CreateChampionMilestoneSchema) },
    responses: {
      201: ok(ChampionMilestoneSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const db = env(c).DB;
    if (input.rewardId) await checkMilestoneReward(db, channelId, input.rewardId);
    const id = newId('championMilestone');
    const now = Date.now();
    try {
      await db
        .prepare(
          `INSERT INTO champion_milestones (id, channel_id, referrals_required, name, reward_id,
             status, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6)`,
        )
        .bind(id, channelId, input.referralsRequired, input.name, input.rewardId ?? null, now)
        .run();
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateMilestone();
      throw error;
    }
    await audit(c, access, 'champions.milestone_created', 'champion_milestone', id, {
      referralsRequired: input.referralsRequired,
      rewardId: input.rewardId ?? null,
    });
    backfillAwards(c, channelId, input.referralsRequired);
    return c.json({ data: toMilestone(await requireMilestone(db, channelId, id)) }, 201);
  },
);

champions.openapi(
  createRoute({
    method: 'patch',
    path: `${base}/milestones/{milestoneId}`,
    tags: TAG,
    summary: 'Change or archive a milestone',
    description: 'Admin role. Awards already made stay. Champions who now qualify are awarded it.',
    request: { params: milestoneParams, body: jsonBody(UpdateChampionMilestoneSchema) },
    responses: {
      200: ok(ChampionMilestoneSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, milestoneId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const db = env(c).DB;
    const row = await requireMilestone(db, channelId, milestoneId);
    if (input.rewardId) await checkMilestoneReward(db, channelId, input.rewardId);
    const next = {
      referralsRequired: input.referralsRequired ?? row.referrals_required,
      name: input.name ?? row.name,
      rewardId: input.rewardId === undefined ? row.reward_id : input.rewardId,
      status: input.status ?? row.status,
    };
    try {
      await db
        .prepare(
          `UPDATE champion_milestones SET referrals_required = ?1, name = ?2, reward_id = ?3,
             status = ?4, updated_at = ?5 WHERE id = ?6`,
        )
        .bind(
          next.referralsRequired,
          next.name,
          next.rewardId,
          next.status,
          Date.now(),
          milestoneId,
        )
        .run();
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateMilestone();
      throw error;
    }
    await audit(c, access, 'champions.milestone_changed', 'champion_milestone', milestoneId, {
      ...input,
    });
    if (next.status === 'active') backfillAwards(c, channelId, next.referralsRequired);
    return c.json({ data: toMilestone(await requireMilestone(db, channelId, milestoneId)) }, 200);
  },
);

champions.openapi(
  createRoute({
    method: 'delete',
    path: `${base}/milestones/{milestoneId}`,
    tags: TAG,
    summary: 'Archive a milestone',
    description: 'Admin role. Awards already made stay.',
    request: { params: milestoneParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { channelId, milestoneId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'admin');
    const db = env(c).DB;
    await requireMilestone(db, channelId, milestoneId);
    await db
      .prepare(`UPDATE champion_milestones SET status = 'archived', updated_at = ?1 WHERE id = ?2`)
      .bind(Date.now(), milestoneId)
      .run();
    await audit(c, access, 'champions.milestone_archived', 'champion_milestone', milestoneId);
    return c.body(null, 204);
  },
);

// ---- Leaderboard -----------------------------------------------------------------------------

function readCursor(cursor: string | undefined): { n: number; id: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))) as unknown;
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as { n?: unknown }).n === 'number' &&
      typeof (value as { id?: unknown }).id === 'string'
    ) {
      return value as { n: number; id: string };
    }
  } catch {
    // fall through
  }
  throw invalid('cursor', 'This cursor is not valid.');
}

const writeCursor = (n: number, id: string) =>
  btoa(JSON.stringify({ n, id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

champions.openapi(
  createRoute({
    method: 'get',
    path: `${base}/leaderboard`,
    tags: TAG,
    summary: 'Champions by counted referrals, most first',
    description: 'Every Member who referred someone, with counted, pending and held referrals.',
    request: { params: channelParam, query: CursorQuerySchema },
    responses: {
      200: ok(ChampionLeaderboardSchema, 'Leaderboard'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { cursor, limit } = c.req.valid('query');
    await requireChannel(c, channelId, 'viewer');
    const after = readCursor(cursor);
    const rows = await all<{
      id: string;
      email: string;
      first_name: string | null;
      last_name: string | null;
      champion_code: string | null;
      counted: number;
      pending: number;
      held: number;
    }>(
      env(c).DB,
      `SELECT m.id, m.email, m.first_name, m.last_name, m.champion_code,
              SUM(r.status = 'counted') AS counted, SUM(r.status = 'pending') AS pending,
              SUM(r.status = 'held') AS held
         FROM referrals r JOIN members m ON m.id = r.referrer_id
        WHERE r.channel_id = ?1
        GROUP BY m.id
       HAVING ?2 IS NULL OR counted < ?2 OR (counted = ?2 AND m.id > ?3)
        ORDER BY counted DESC, m.id ASC LIMIT ?4`,
      channelId,
      after?.n ?? null,
      after?.id ?? '',
      limit + 1,
    );
    const items = rows.slice(0, limit).map((row) => ({
      memberId: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      championCode: row.champion_code,
      counted: row.counted,
      pending: row.pending,
      held: row.held,
    }));
    const last = items.at(-1);
    const nextCursor =
      rows.length > limit && last ? writeCursor(last.counted, last.memberId) : null;
    return c.json({ data: { items, nextCursor } }, 200);
  },
);

// ---- Referrals -------------------------------------------------------------------------------

champions.openapi(
  createRoute({
    method: 'get',
    path: `${base}/referrals`,
    tags: TAG,
    summary: 'Referrals, newest first',
    description: 'Filter by status (held ones wait for review) or by Champion (referrerId).',
    request: { params: channelParam, query: ReferralListQuerySchema },
    responses: {
      200: ok(ReferralListSchema, 'Referrals'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { status, referrerId, cursor, limit } = c.req.valid('query');
    await requireChannel(c, channelId, 'viewer');
    const rows = await all<ReferralRow>(
      env(c).DB,
      `${SELECT_REFERRALS}
        WHERE r.channel_id = ?1 AND (?2 IS NULL OR r.status = ?2) AND (?3 IS NULL OR r.referrer_id = ?3)
          AND (?4 IS NULL OR r.id < ?4)
        ORDER BY r.id DESC LIMIT ?5`,
      channelId,
      status ?? null,
      referrerId ?? null,
      cursor ?? null,
      limit + 1,
    );
    const items = rows.slice(0, limit).map(toReferral);
    const nextCursor = rows.length > limit ? (items.at(-1)?.id ?? null) : null;
    return c.json({ data: { items, nextCursor } }, 200);
  },
);

for (const decision of ['approve', 'reject'] as const) {
  champions.openapi(
    createRoute({
      method: 'post',
      path: `${base}/referrals/{referralId}/${decision}`,
      tags: TAG,
      summary:
        decision === 'approve'
          ? 'Count a held referral'
          : 'Reject a held referral (it never counts)',
      description:
        decision === 'approve'
          ? 'Editor role. Only held referrals. Counting it may award milestones (and their rewards). Audited.'
          : 'Editor role. Only held referrals. Audited.',
      request: { params: referralParams },
      responses: {
        200: ok(ReferralSchema, decision === 'approve' ? 'Counted' : 'Rejected'),
        ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
      },
    }),
    async (c) => {
      const { channelId, referralId } = c.req.valid('param');
      const access = await requireChannel(c, channelId, 'editor');
      const db = env(c).DB;
      const exists = await first(
        db,
        'SELECT 1 FROM referrals WHERE id = ?1 AND channel_id = ?2',
        referralId,
        channelId,
      );
      if (!exists) throw new ApiError('not_found', 'Referral not found.');
      const result = await reviewReferral(championDeps(c), {
        channelId,
        referralId,
        operatorId: access.auth.operatorId,
        approve: decision === 'approve',
      });
      if (!result) throw new ApiError('conflict', 'Only held referrals can be reviewed.');
      const action = decision === 'approve' ? 'approved' : 'rejected';
      await audit(c, access, `champions.referral_${action}`, 'referral', referralId, {
        referrerId: result.referrerId,
        ...(result.awards.length ? { awards: result.awards } : {}),
      });
      for (const awardId of result.awards) {
        await audit(c, access, 'champions.award_granted', 'champion_award', awardId, {
          memberId: result.referrerId,
        });
      }
      const row = await first<ReferralRow>(db, `${SELECT_REFERRALS} WHERE r.id = ?1`, referralId);
      return c.json({ data: toReferral(row as ReferralRow) }, 200);
    },
  );
}

// ---- Awards ----------------------------------------------------------------------------------

champions.openapi(
  createRoute({
    method: 'get',
    path: `${base}/awards`,
    tags: TAG,
    summary: 'Awards, newest first',
    description: 'Filter by status (pending manual and goods rewards wait for the operator).',
    request: { params: channelParam, query: ChampionAwardListQuerySchema },
    responses: {
      200: ok(ChampionAwardListSchema, 'Awards'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { status, memberId, cursor, limit } = c.req.valid('query');
    await requireChannel(c, channelId, 'viewer');
    const rows = await all<AwardRow>(
      env(c).DB,
      `${SELECT_AWARDS}
        WHERE a.channel_id = ?1 AND (?2 IS NULL OR a.status = ?2) AND (?3 IS NULL OR a.member_id = ?3)
          AND (?4 IS NULL OR a.id < ?4)
        ORDER BY a.id DESC LIMIT ?5`,
      channelId,
      status ?? null,
      memberId ?? null,
      cursor ?? null,
      limit + 1,
    );
    const items = rows.slice(0, limit).map(toAward);
    const nextCursor = rows.length > limit ? (items.at(-1)?.id ?? null) : null;
    return c.json({ data: { items, nextCursor } }, 200);
  },
);

champions.openapi(
  createRoute({
    method: 'post',
    path: `${base}/awards/{awardId}/fulfil`,
    tags: TAG,
    summary: 'Complete an award',
    description:
      'Admin role. Marks a pending manual or goods award fulfilled (with an optional note); tries a failed comp_level or coupon award again. Audited.',
    request: { params: awardParams, body: jsonBody(FulfilChampionAwardSchema) },
    responses: {
      200: ok(ChampionAwardSchema, 'The award after the attempt'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId, awardId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const outcome = await completeAward(championDeps(c), {
      channelId,
      awardId,
      detail: input.detail ?? null,
    });
    if (outcome === null) throw new ApiError('not_found', 'Award not found.');
    if (outcome === 'skipped') throw new ApiError('conflict', 'This award is already complete.');
    await audit(c, access, 'champions.award_fulfilled', 'champion_award', awardId, { outcome });
    const row = await first<AwardRow>(env(c).DB, `${SELECT_AWARDS} WHERE a.id = ?1`, awardId);
    return c.json({ data: toAward(row as AwardRow) }, 200);
  },
);

// ---- A Member's Champion view ----------------------------------------------------------------

champions.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/members/{memberId}/champion',
    tags: TAG,
    summary: 'A Member’s share links and referral progress',
    description: 'Assigns the Member’s champion_code on first use.',
    request: { params: memberParams },
    responses: {
      200: ok(MemberChampionSchema, 'Champion'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, memberId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const db = env(c).DB;
    await requireChannelMember(db, channelId, memberId);
    const code = await ensureChampionCode(db, channelId, memberId);
    if (!code) throw new ApiError('not_found', 'Subscriber not found.');
    const [site, progress] = await Promise.all([
      siteOrigin(c, channelId),
      championProgress(db, channelId, memberId),
    ]);
    return c.json(
      {
        data: {
          memberId,
          code,
          ...championLinks(site.origin, code),
          counted: progress.counted,
          pending: progress.pending,
          held: progress.held,
          rejected: progress.rejected,
          nextMilestone: progress.nextMilestone,
          awards: progress.awards,
        },
      },
      200,
    );
  },
);
