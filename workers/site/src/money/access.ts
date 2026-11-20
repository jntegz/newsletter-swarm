// Who reads a gated Dispatch in full on this request, and how the answer may be cached.
//
// In order:
// 1. Public Dispatches: everyone, cached publicly.
// 2. Readers the Gate admits (money/gate.ts gateAdmits) and verified crawlers: in full. Signed-in
//    readers' pages are cached per class and, for paid readers, per Membership level.
// 3. A valid gift article link (?gift=, flag gift_articles): in full, never cached, not indexed,
//    and the meter is not touched. Valid means unexpired, not stopped, under GIFT_ARTICLE_MAX_READS
//    opens, and minted by a Member who can still read the Dispatch themselves: a cancellation or
//    refund ends the links they shared.
// 4. A metered Gate (gate_settings.meter_limit > 0 and gates.metered): the reader's meter decides
//    (money/meter.ts). Known bots and prefetches never use a meter. Once the meter is spent:
//    - hard mode: the Gate, with no way through;
//    - soft mode: the Gate with a "continue reading" link to ?continue=1, which shows the
//      Dispatch in full for that one request without counting a read. This is deliberate: a soft
//      Gate is a reminder, not a lock, and it works without JavaScript.
//    Every answer for a metered Gate depends on the individual reader, so none is ever cached
//    (private, no-store), not even the Gate itself: a cached Gate would be served to anonymous
//    readers who still have free reads.
// 5. Otherwise the Gate, cached publicly for anonymous readers and per class (and level) else.
import type { FlagValues } from '@swarm/flags';
import {
  GIFT_ARTICLE_MAX_READS,
  entitledLevel,
  giftTokenHash,
  readerClassFor,
} from '@swarm/engine';
import type { Reader, SiteContext } from '../context';
import { isBotRequest } from '../edge/analytics';
import type { SiteDispatch } from '../render/data';
import { dispatchPath, h, type Cacheability } from '../render/html';
import { couponBy, gateConfig } from './data';
import { gateAdmits, gatePanel, mergeDesign } from './gate';
import { useMeter } from './meter';

/** A Member as the Gate sees them now, as if they were reading (for gift links they minted). */
async function readerOf(
  db: D1Database,
  channelId: string,
  memberId: string,
  now: number,
): Promise<Reader | null> {
  const cls = await readerClassFor(db, channelId, memberId, now);
  if (cls === 'anonymous') return null;
  const levelId =
    cls === 'paid' ? ((await entitledLevel(db, channelId, memberId, now)) ?? null) : null;
  return { class: cls, memberId, levelId };
}

interface DispatchAccess {
  entitled: boolean;
  cache: Cacheability;
  /** The gate panel, when not entitled. */
  gate?: string;
  notice?: string;
  after?: string;
  /** Pages shown through a gift link or a soft Gate stay out of search indexes. */
  noindex: boolean;
}

const giftForm = (dispatchId: string) =>
  `<form class="sw-gift" method="post" action="/_swarm/gift-article"><input type="hidden" name="dispatchId" value="${h(dispatchId)}"><button type="submit" class="sw-ghost">Gift this post</button><span class="sw-muted">Share it with someone who isn't a subscriber.</span></form>`;

export async function dispatchAccess(
  c: SiteContext,
  dispatch: SiteDispatch,
  options: { subscribeForm: string; flags: FlagValues; now?: number },
): Promise<DispatchAccess> {
  const reader = c.get('reader');
  const crawler = c.get('crawlerFullAccess');
  if (dispatch.visibility === 'public') return { entitled: true, cache: 'public', noindex: false };

  const env = c.get('env');
  const channel = c.get('channel');
  const now = options.now ?? Date.now();
  const { flags } = options;
  const { gate, settings } = await gateConfig(env, channel.id, dispatch.id);

  if (crawler || gateAdmits(dispatch.visibility, reader, gate.levelIds)) {
    const after = flags.gift_articles && reader.memberId && !crawler ? giftForm(dispatch.id) : '';
    return {
      entitled: true,
      // Gated text for a crawler must never land in a shared cache; a Member's page only in the
      // edge's per-class (and per-level) cache.
      cache: reader.class === 'anonymous' ? 'private' : 'reader',
      after,
      noindex: false,
    };
  }

  const giftToken = c.req.query('gift');
  if (flags.gift_articles && giftToken) {
    const hash = await giftTokenHash(giftToken);
    const link = hash
      ? await env.DB.prepare(
          `SELECT member_id FROM gift_article_links
            WHERE token_hash = ?1 AND channel_id = ?2 AND dispatch_id = ?3 AND expires_at > ?4
              AND revoked_at IS NULL AND reads < ?5`,
        )
          .bind(hash, channel.id, dispatch.id, now, GIFT_ARTICLE_MAX_READS)
          .first<{ member_id: string }>()
      : null;
    const minter = link ? await readerOf(env.DB, channel.id, link.member_id, now) : null;
    // Counted in the same statement as the cap, so concurrent opens can't pass it together.
    const valid =
      link &&
      minter &&
      gateAdmits(dispatch.visibility, minter, gate.levelIds) &&
      ((
        await env.DB.prepare(
          `UPDATE gift_article_links SET reads = reads + 1
            WHERE token_hash = ?1 AND revoked_at IS NULL AND reads < ?2`,
        )
          .bind(hash, GIFT_ARTICLE_MAX_READS)
          .run()
      ).meta.changes ?? 0) > 0;
    if (valid) {
      return {
        entitled: true,
        cache: 'private',
        notice: `<p class="sw-notice">A subscriber shared this post with you. <a href="/subscribe">Become a subscriber</a> to read every one.</p>`,
        noindex: true,
      };
    }
  }

  const coupon =
    dispatch.visibility === 'paid' && flags.paywall_coupon && settings.couponId
      ? await couponBy(env, channel.id, { id: settings.couponId }, now)
      : null;
  const path = dispatchPath(dispatch.slug);
  const panel = (extra: { meterSpent?: boolean; continueHref?: string | null } = {}) =>
    gatePanel({
      channelName: channel.name,
      visibility: dispatch.visibility === 'paid' ? 'paid' : 'members',
      reader: reader.class,
      path,
      subscribeForm: options.subscribeForm,
      design: mergeDesign(gate.designJson, settings.designJson),
      coupon,
      meterPeriod: settings.meterPeriod,
      ...extra,
    });

  if (settings.meterLimit > 0 && gate.metered) {
    const purpose = c.req.header('sec-purpose') ?? c.req.header('purpose') ?? '';
    const userAgent = c.req.header('user-agent');
    const automated =
      !userAgent ||
      isBotRequest(userAgent, c.req.raw.cf as Parameters<typeof isBotRequest>[1]) ||
      /prefetch|prerender/i.test(purpose);
    const result = automated
      ? ({ outcome: 'spent' } as const)
      : await useMeter(c, {
          dispatchId: dispatch.id,
          limit: settings.meterLimit,
          period: settings.meterPeriod,
          now,
        });
    if (result.outcome === 'read') {
      const unit = settings.meterPeriod === 'week' ? 'week' : 'month';
      const left =
        result.remaining === 0
          ? `This is your last free post this ${unit}.`
          : `${result.remaining} free post${result.remaining === 1 ? '' : 's'} left this ${unit}.`;
      return {
        entitled: true,
        cache: 'private',
        notice: `<p class="sw-notice">You are reading this on a free read. ${h(left)} <a href="/subscribe">Become a subscriber</a></p>`,
        noindex: false,
      };
    }
    const soft = settings.meterMode === 'soft' && !automated;
    if (soft && c.req.query('continue') === '1') {
      return {
        entitled: true,
        cache: 'private',
        notice: `<p class="sw-notice">You have used your free posts. <a href="/subscribe">Become a subscriber</a> to keep reading.</p>`,
        noindex: true,
      };
    }
    return {
      entitled: false,
      cache: 'private',
      gate: panel({ meterSpent: !automated, continueHref: soft ? `${path}?continue=1` : null }),
      noindex: false,
    };
  }

  return {
    entitled: false,
    cache: reader.class === 'anonymous' ? 'public' : 'reader',
    gate: panel(),
    noindex: false,
  };
}
