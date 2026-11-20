/**
 * Links and tokens the vault signs for callers that no longer hold the key: Member Center links
 * (MEMBER_SIGNING_KEYS) for api and capture, goods links (GOODS_SIGNING_KEYS) for site and api,
 * and the join and journey tokens (SIGNUP_KEYS) whose claims carry a sealed address and Member id.
 *
 * A link is minted from evidence the vault checks in D1 (a confirmed request, an address that has
 * Members, a valid link, a paid order), never from claims a caller makes. Each mint is
 * rate-limited and recorded in vault_mints. Until the link cutover (LINK_SIGNING_MODE v1) Member
 * Center and goods links are still v1 under MEMBER_KEYS, which every verifier accepts.
 */
import { all, first, run } from '@swarm/db';
import {
  createLinkKeys,
  decrypt,
  memberToken,
  openV3,
  sealedBinding,
  sealV3,
  signLibraryToken,
  signOrderToken,
} from '@swarm/engine';
import { signLink, verifyLink } from '@swarm/tokens';
import type { GoodsLinkEvidence, MemberLinkEvidence, VaultCaller } from '../api';
import { invalid, notFound, plainRecord, refuse, VaultRefusal, type VaultContext } from './context';
import { subjectHash } from './audit';
import { verifyMemberLink } from './principals';
import { take, type LimitScope } from './ratelimit';

const MEMBER_ID = /^mb_[0-9a-f]{32}$/;
const ORDER_ID = /^go_[0-9a-f]{32}$/;
const MEMBER_LINK_SECONDS = 30 * 86_400;
const GOODS_SECONDS = 90 * 86_400;
/** The link shown after confirming is minted only this soon after the confirmation. */
const CONFIRMED_WITHIN_MS = 10 * 60_000;
/** The thank-you page of an order: paid at most this long ago. */
const ORDER_PAID_WITHIN_MS = 24 * 3_600_000;
/** Statuses a Member's links still open the Member Center for (engine sendMemberCenterLinks). */
const LINKABLE = "('pending', 'active', 'paused', 'unsubscribed')";
/** Channels a link request covers at most (engine sendMemberCenterLinks). */
const LINK_REQUEST_CHANNELS = 5;

async function limit(ctx: VaultContext, scope: LimitScope, subject: string, units = 1) {
  if (!(await take(ctx, scope, subject, units))) throw new VaultRefusal('rate_limited', scope);
}

async function recordMint(
  ctx: VaultContext,
  kind: 'member' | 'goods-library' | 'goods-order',
  evidence: string,
  subject: string,
  channelId: string,
) {
  await run(
    ctx.db,
    `INSERT INTO vault_mints (created_at, caller, kind, evidence, subject, channel_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ctx.now(),
    ctx.caller as VaultCaller,
    kind,
    evidence,
    await subjectHash(subject),
    channelId,
  );
}

/** One Member Center link, v2 after the cutover, v1 under MEMBER_KEYS before it. */
async function memberLink(
  ctx: VaultContext,
  memberId: string,
  channelId: string,
  emailed: boolean,
): Promise<string> {
  const now = ctx.now();
  if (ctx.config.links.signing === 'v2') {
    return signLink(
      'member',
      ctx.keys.memberSigning,
      { m: memberId, c: channelId, ...(emailed ? { e: 1 } : {}) },
      { now, expiresInSeconds: MEMBER_LINK_SECONDS },
    );
  }
  return memberToken(
    legacySigner(ctx),
    { memberId, channelId },
    now,
    emailed ? { emailed: true } : {},
  );
}

/** Before the cutover: signs links the v1 way, with MEMBER_KEYS, as every worker did. */
function legacySigner(ctx: VaultContext) {
  const legacy = ctx.keys.memberLegacy;
  if (!legacy) throw new VaultRefusal('unavailable', 'MEMBER_KEYS missing before the cutover');
  return createLinkKeys({
    mode: { signing: 'v1', legacyCutoffMs: null },
    memberKeys: legacy,
    rings: {},
  });
}

/** Member Center links capture asks for, from evidence. */
export async function mintMemberLinkFromEvidence(
  ctx: VaultContext,
  evidence: MemberLinkEvidence,
): Promise<{ memberId: string; token: string }[]> {
  if (!evidence || typeof evidence !== 'object') return invalid('evidence');
  switch (evidence.kind) {
    case 'confirmed-request': {
      if (typeof evidence.requestId !== 'string' || !evidence.requestId) invalid('request');
      const row = await first<{
        member_id: string;
        channel_id: string;
        confirmed_at: number | null;
      }>(
        ctx.db,
        `SELECT q.member_id, q.channel_id, q.confirmed_at FROM confirm_requests q
           JOIN members m ON m.id = q.member_id AND m.channel_id = q.channel_id
          WHERE q.id = ?1`,
        evidence.requestId,
      );
      const now = ctx.now();
      if (
        !row?.confirmed_at ||
        row.confirmed_at > now ||
        now - row.confirmed_at > CONFIRMED_WITHIN_MS
      ) {
        return refuse('no recent confirmation');
      }
      await limit(ctx, 'mint:confirmed:request', evidence.requestId);
      await recordMint(ctx, 'member', 'confirmed-request', row.member_id, row.channel_id);
      return [
        {
          memberId: row.member_id,
          token: await memberLink(ctx, row.member_id, row.channel_id, false),
        },
      ];
    }
    case 'link-request': {
      const email = typeof evidence.email === 'string' ? evidence.email.trim().toLowerCase() : '';
      if (!email || email.length > 254 || !email.includes('@')) return invalid('email');
      const channelId = evidence.channelId ?? null;
      if (channelId !== null && (typeof channelId !== 'string' || !channelId)) invalid('channel');
      await limit(ctx, 'mint:link-request:address', email);
      if (channelId) await limit(ctx, 'mint:link-request:channel', channelId);
      const members = await all<{ id: string; channel_id: string }>(
        ctx.db,
        `SELECT m.id, m.channel_id FROM members m JOIN channels c ON c.id = m.channel_id
          WHERE m.email = ?1 AND m.status IN ${LINKABLE} AND c.deleted_at IS NULL
            AND (?2 IS NULL OR m.channel_id = ?2)
          ORDER BY m.created_at LIMIT ${LINK_REQUEST_CHANNELS}`,
        email,
        channelId,
      );
      const out = [];
      for (const member of members) {
        await recordMint(ctx, 'member', 'link-request', member.id, member.channel_id);
        out.push({
          memberId: member.id,
          token: await memberLink(ctx, member.id, member.channel_id, true),
        });
      }
      return out;
    }
    case 'step-up': {
      const link = await verifyMemberLink(ctx, evidence.token);
      if (link.status === 'bounced' || link.status === 'complained') refuse('unreachable member');
      await limit(ctx, 'mint:step-up:member', link.memberId);
      await recordMint(ctx, 'member', 'step-up', link.memberId, link.channelId);
      return [
        {
          memberId: link.memberId,
          token: await memberLink(ctx, link.memberId, link.channelId, true),
        },
      ];
    }
    default:
      return invalid('evidence');
  }
}

/** Member Center links for Members of one Channel (the api's sends and payment mails). */
export async function mintChannelMemberLinks(
  ctx: VaultContext,
  channelId: string,
  memberIds: unknown,
  evidence: string,
): Promise<Record<string, string>> {
  if (!Array.isArray(memberIds) || memberIds.length === 0 || memberIds.length > 1000) {
    return invalid('member ids');
  }
  const ids = [...new Set(memberIds as unknown[])];
  for (const id of ids) if (typeof id !== 'string' || !MEMBER_ID.test(id)) invalid('member id');
  for (let i = 0; i < ids.length; i += 90) {
    const group = ids.slice(i, i + 90) as string[];
    const found = await all<{ id: string }>(
      ctx.db,
      `SELECT id FROM members WHERE channel_id = ?1 AND id IN (${group.map((_, j) => `?${j + 2}`).join(', ')})`,
      channelId,
      ...group,
    );
    if (found.length !== group.length) notFound('member');
  }
  await limit(ctx, 'mint:api:channel', channelId, ids.length);
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const id of ids as string[]) {
    await recordMint(ctx, 'member', evidence, id, channelId);
    out[id] = await memberLink(ctx, id, channelId, false);
  }
  return plainRecord(out);
}

// ---- Goods -------------------------------------------------------------------------------------

async function goodsLinks(
  ctx: VaultContext,
  channelId: string,
  orderId: string,
): Promise<{ library: string; order: string }> {
  const now = ctx.now();
  if (ctx.config.links.signing === 'v2') {
    const ring = ctx.keys.goodsSigning;
    return {
      library: await signLink(
        'goods-library',
        ring,
        { c: channelId, a: orderId },
        { now, expiresInSeconds: GOODS_SECONDS },
      ),
      order: await signLink(
        'goods-order',
        ring,
        { c: channelId, o: orderId },
        { now, expiresInSeconds: GOODS_SECONDS },
      ),
    };
  }
  const legacy = legacySigner(ctx);
  return {
    library: await signLibraryToken(legacy, channelId, orderId, now),
    order: await signOrderToken(legacy, channelId, orderId, now),
  };
}

/** A paid order of the Channel (paid within `withinMs` when given): its address. */
async function paidOrder(
  ctx: VaultContext,
  channelId: string,
  orderId: unknown,
  withinMs?: number,
): Promise<string> {
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) return invalid('order');
  const row = await first<{ email: string; paid_at: number | null }>(
    ctx.db,
    "SELECT email, paid_at FROM good_orders WHERE id = ?1 AND channel_id = ?2 AND status = 'paid'",
    orderId,
    channelId,
  );
  if (!row?.paid_at) return notFound('order');
  if (withinMs !== undefined && ctx.now() - row.paid_at > withinMs) refuse('order too old');
  return row.email;
}

/** Goods links site asks for, from evidence; null when the address has bought nothing there. */
export async function mintGoodsLinkFromEvidence(
  ctx: VaultContext,
  evidence: GoodsLinkEvidence,
): Promise<{ library: string; order: string; email: string } | null> {
  if (!evidence || typeof evidence !== 'object' || typeof evidence.channelId !== 'string') {
    return invalid('evidence');
  }
  const channelId = evidence.channelId;
  switch (evidence.kind) {
    case 'library-request': {
      const email = typeof evidence.email === 'string' ? evidence.email.trim().toLowerCase() : '';
      if (!email || email.length > 254 || !email.includes('@')) return invalid('email');
      await limit(ctx, 'mint:goods-library:address', `${channelId}\n${email}`);
      await limit(ctx, 'mint:goods-library:channel', channelId);
      const order = await first<{ id: string }>(
        ctx.db,
        `SELECT id FROM good_orders WHERE channel_id = ?1 AND email = ?2 AND status = 'paid'
          ORDER BY paid_at DESC LIMIT 1`,
        channelId,
        email,
      );
      if (!order) return null;
      await recordMint(
        ctx,
        'goods-library',
        'library-request',
        `${channelId}\n${email}`,
        channelId,
      );
      return { ...(await goodsLinks(ctx, channelId, order.id)), email };
    }
    case 'order': {
      const email = await paidOrder(ctx, channelId, evidence.orderId, ORDER_PAID_WITHIN_MS);
      await limit(ctx, 'mint:goods-order:order', evidence.orderId);
      await recordMint(ctx, 'goods-order', 'order', evidence.orderId, channelId);
      return { ...(await goodsLinks(ctx, channelId, evidence.orderId)), email };
    }
    default:
      return invalid('evidence');
  }
}

/** Goods links for a paid order, after a payment event (the api's checkout webhook). */
export async function mintOrderGoodsLinks(
  ctx: VaultContext,
  channelId: string,
  orderId: unknown,
): Promise<{ library: string; order: string }> {
  await paidOrder(ctx, channelId, orderId);
  await limit(ctx, 'mint:goods-order:order', orderId as string);
  await recordMint(ctx, 'goods-order', 'payment-event', orderId as string, channelId);
  return goodsLinks(ctx, channelId, orderId as string);
}

// ---- Join and journey tokens -------------------------------------------------------------------

const CLAIM_PURPOSE = 'signup-claim';
const SIGNUP_SECONDS = 86_400;

async function liveForm(ctx: VaultContext, formId: unknown) {
  if (typeof formId !== 'string' || !formId || formId.length > 120) return invalid('form');
  const form = await first<{ channel_id: string; workspace_id: string }>(
    ctx.db,
    `SELECT f.channel_id, f.workspace_id FROM capture_forms f JOIN channels c ON c.id = f.channel_id
      WHERE f.id = ?1 AND f.status = 'published' AND f.deleted_at IS NULL AND c.deleted_at IS NULL`,
    formId,
  );
  if (!form) return notFound('form');
  return { channelId: form.channel_id, workspaceId: form.workspace_id, formId };
}

function signupArgs(memberId: unknown, email: unknown) {
  if (typeof memberId !== 'string' || !MEMBER_ID.test(memberId)) invalid('member id');
  const address = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!address || address.length > 254 || !address.includes('@')) invalid('email');
  return { memberId: memberId as string, email: address };
}

/** A Member with that id exists only in the form's Channel, if at all. */
async function memberAbsentOrIn(ctx: VaultContext, memberId: string, channelId: string) {
  const row = await first<{ channel_id: string }>(
    ctx.db,
    'SELECT channel_id FROM members WHERE id = ?1',
    memberId,
  );
  if (row && row.channel_id !== channelId) notFound('member');
}

/** The join token after a signup on a live form: sealed claims, verified only by the vault. */
export async function mintJoinToken(
  ctx: VaultContext,
  args: { formId: unknown; memberId: unknown; email: unknown; journeyPath?: unknown },
): Promise<string> {
  const form = await liveForm(ctx, args.formId);
  const { memberId, email } = signupArgs(args.memberId, args.email);
  await memberAbsentOrIn(ctx, memberId, form.channelId);
  const journey = args.journeyPath;
  if (
    journey !== undefined &&
    (typeof journey !== 'string' || !journey.startsWith('/v1/j/') || journey.length > 512)
  ) {
    invalid('journey');
  }
  const binding = sealedBinding({ c: form.channelId, f: form.formId });
  return signLink(
    'join',
    ctx.keys.signup,
    {
      c: form.channelId,
      f: form.formId,
      x: await sealV3(ctx.keys.field, CLAIM_PURPOSE, binding, email),
      m: await sealV3(ctx.keys.field, CLAIM_PURPOSE, binding, memberId),
      ...(journey ? { j: journey } : {}),
    },
    { now: ctx.now(), expiresInSeconds: SIGNUP_SECONDS },
  );
}

/** Opens a sealed claim: v3 for tokens the vault signed, the legacy form for v1 tokens. */
async function openClaim(ctx: VaultContext, value: unknown, binding: string, legacy: boolean) {
  if (typeof value !== 'string') return null;
  if (!legacy) return openV3(ctx.keys.field, CLAIM_PURPOSE, binding, value);
  return ctx.config.legacyOpen ? decrypt(ctx.keys.field, value) : null;
}

const legacyLinks = (ctx: VaultContext) =>
  ctx.keys.memberLegacy
    ? { legacy: { keyring: ctx.keys.memberLegacy, cutoffMs: ctx.config.links.legacyCutoffMs } }
    : {};

/** A join token for this Channel, verified with SIGNUP_KEYS (or, until its window ends, v1). */
export async function openJoinToken(
  ctx: VaultContext,
  token: unknown,
  channelId: unknown,
): Promise<{
  formId: string;
  memberId: string;
  email: string;
  journeyPath: string | null;
  issuedAt: number;
}> {
  if (typeof token !== 'string' || token.length > 4096 || typeof channelId !== 'string') {
    return invalid('join token');
  }
  const read = await verifyLink<{
    c?: unknown;
    f?: unknown;
    x?: unknown;
    m?: unknown;
    j?: unknown;
  }>('join', ctx.keys.signup, token, { now: ctx.now(), ...legacyLinks(ctx) });
  if (!read.ok) return refuse('join token');
  const { c, f, x, m, j, iat } = read.payload;
  if (c !== channelId || typeof f !== 'string') return refuse('join token channel');
  const binding = sealedBinding({ c: channelId, f });
  const email = await openClaim(ctx, x, binding, read.legacy);
  const memberId = await openClaim(ctx, m, binding, read.legacy);
  if (!email || !memberId || !MEMBER_ID.test(memberId)) return refuse('join claims');
  return {
    formId: f,
    memberId,
    email,
    journeyPath: typeof j === 'string' && j.startsWith('/v1/j/') ? j : null,
    issuedAt: iat * 1000,
  };
}

async function liveJourney(ctx: VaultContext, journeyId: unknown, channelId: string) {
  if (typeof journeyId !== 'string' || !journeyId) return invalid('journey');
  const row = await first(
    ctx.db,
    "SELECT 1 FROM signup_journeys WHERE id = ?1 AND channel_id = ?2 AND status = 'live'",
    journeyId,
    channelId,
  );
  if (!row) notFound('journey');
}

export async function mintJourneyToken(
  ctx: VaultContext,
  args: {
    formId: unknown;
    journeyId: unknown;
    variant: unknown;
    memberId: unknown;
    email: unknown;
  },
): Promise<string> {
  const form = await liveForm(ctx, args.formId);
  await liveJourney(ctx, args.journeyId, form.channelId);
  if (typeof args.variant !== 'string' || !/^[A-Za-z0-9_-]{1,8}$/.test(args.variant))
    invalid('variant');
  const { memberId, email } = signupArgs(args.memberId, args.email);
  await memberAbsentOrIn(ctx, memberId, form.channelId);
  const binding = sealedBinding({ c: form.channelId, f: form.formId });
  return signLink(
    'journey',
    ctx.keys.signup,
    {
      j: args.journeyId,
      v: args.variant,
      f: form.formId,
      x: await sealV3(ctx.keys.field, CLAIM_PURPOSE, binding, email),
      m: await sealV3(ctx.keys.field, CLAIM_PURPOSE, binding, memberId),
    },
    { now: ctx.now(), expiresInSeconds: SIGNUP_SECONDS },
  );
}

export async function openJourneyToken(
  ctx: VaultContext,
  token: unknown,
): Promise<{
  journeyId: string;
  variant: string;
  formId: string;
  memberId: string;
  email: string;
}> {
  if (typeof token !== 'string' || token.length > 2048) return invalid('journey token');
  const read = await verifyLink<{
    j?: unknown;
    v?: unknown;
    f?: unknown;
    x?: unknown;
    m?: unknown;
  }>('journey', ctx.keys.signup, token, { now: ctx.now(), ...legacyLinks(ctx) });
  if (!read.ok) return refuse('journey token');
  const { j, v, f, x, m } = read.payload;
  if (typeof j !== 'string' || typeof v !== 'string' || typeof f !== 'string') {
    return refuse('journey token');
  }
  const form = await first<{ channel_id: string }>(
    ctx.db,
    'SELECT channel_id FROM capture_forms WHERE id = ?1 AND deleted_at IS NULL',
    f,
  );
  if (!form) return refuse('journey form');
  await liveJourney(ctx, j, form.channel_id);
  const binding = sealedBinding({ c: form.channel_id, f });
  const email = await openClaim(ctx, x, binding, read.legacy);
  const memberId = await openClaim(ctx, m, binding, read.legacy);
  if (!email || !memberId || !MEMBER_ID.test(memberId)) return refuse('journey claims');
  return { journeyId: j, variant: v, formId: f, memberId, email };
}
