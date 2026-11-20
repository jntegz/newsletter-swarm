// Gates (Phase 5): who reads a gated Dispatch past its divider, and the panel everyone else sees.
// Pure functions, so tests can check every case without a request.
//
// Admission (gateAdmits; paid Dispatches use @swarm/engine's gateAdmits, the rule email uses):
// - 'members' Dispatches: any signed-in Member (Phase 4 rule).
// - 'paid' Dispatches: a paid reader whose Membership level is in gates.level_ids_json; an empty
//   list admits any paid level. A paid entitlement that names no level (granted before levels
//   existed) only passes an empty list.
//
// Panel design: gates.design_json over gate_settings.design_json over the defaults, field by
// field. The CTA goes to the plans page (/subscribe); the paywall coupon (flag paywall_coupon)
// is shown with its code and carried to the plans page.
import type { ReaderClass, WebVisibility } from '@swarm/domain';
import { gateAdmits as levelAdmits } from '@swarm/engine';
import { escapeHtml as h } from '@swarm/mail';
import { formatMoney } from './amounts';
import type { GateCoupon } from './data';

interface GateReader {
  class: ReaderClass;
  levelId: string | null;
}

/** Whether a reader reads past the gate of a Dispatch with this visibility and Gate. */
export function gateAdmits(
  visibility: Exclude<WebVisibility, 'hidden'>,
  reader: GateReader,
  levelIds: readonly string[],
): boolean {
  switch (visibility) {
    case 'public':
      return true;
    case 'members':
      return reader.class !== 'anonymous';
    case 'paid':
      return levelAdmits(levelIds, reader.class === 'paid' ? reader.levelId : undefined);
  }
}

interface GateDesign {
  headline: string | null;
  body: string | null;
  ctaLabel: string | null;
  benefits: string[];
}

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

/** The fields of a stored design_json that are usable; anything else is ignored. */
function parseDesign(json: string | null | undefined): Partial<GateDesign> {
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    value = parsed as Record<string, unknown>;
  } catch {
    return {};
  }
  const out: Partial<GateDesign> = {};
  const headline = text(value.headline, 120);
  const body = text(value.body, 600);
  const ctaLabel = text(value.ctaLabel, 40);
  if (headline) out.headline = headline;
  if (body) out.body = body;
  if (ctaLabel) out.ctaLabel = ctaLabel;
  if (Array.isArray(value.benefits)) {
    const benefits = value.benefits
      .map((b) => text(b, 160))
      .filter((b): b is string => b !== null)
      .slice(0, 8);
    if (benefits.length) out.benefits = benefits;
  }
  return out;
}

/** The Dispatch's design over the Channel's, field by field. */
export function mergeDesign(dispatchJson: string, channelJson: string): GateDesign {
  const channel = parseDesign(channelJson);
  const dispatch = parseDesign(dispatchJson);
  return {
    headline: dispatch.headline ?? channel.headline ?? null,
    body: dispatch.body ?? channel.body ?? null,
    ctaLabel: dispatch.ctaLabel ?? channel.ctaLabel ?? null,
    benefits: dispatch.benefits ?? channel.benefits ?? [],
  };
}

const NO_DESIGN: GateDesign = { headline: null, body: null, ctaLabel: null, benefits: [] };

/** "20% off for 3 months", "$5 off the first payment". */
export function couponOffer(coupon: GateCoupon): string {
  const off =
    coupon.percentOff !== null
      ? `${coupon.percentOff}% off`
      : `${formatMoney(coupon.amountOff ?? 0, coupon.currency ?? 'usd')} off`;
  switch (coupon.duration) {
    case 'once':
      return `${off} the first payment`;
    case 'forever':
      return off;
    case 'repeating':
      return `${off} for ${coupon.durationMonths ?? 1} month${coupon.durationMonths === 1 ? '' : 's'}`;
  }
}

interface GatePanelInput {
  channelName: string;
  visibility: 'members' | 'paid';
  reader: ReaderClass;
  /** The Dispatch path, for the sign-in return. */
  path: string;
  /** The free subscribe form (Members-only Dispatches, anonymous readers). */
  subscribeForm: string;
  design?: GateDesign;
  coupon?: GateCoupon | null;
  /** The free reads are used up (metered Gates). */
  meterSpent?: boolean;
  meterPeriod?: 'week' | 'month';
  /** Soft Gates: a link that shows this Dispatch in full once. */
  continueHref?: string | null;
}

export function gatePanel(input: GatePanelInput): string {
  const design = input.design ?? NO_DESIGN;
  const paid = input.visibility === 'paid';
  const anonymous = input.reader === 'anonymous';
  const signin = `/_swarm/reader/signin?return=${encodeURIComponent(input.path)}`;

  let headline: string;
  let body: string;
  if (!paid) {
    headline = 'Keep reading as a subscriber';
    body = `Subscribe to ${input.channelName} to read the rest, free.`;
  } else if (anonymous) {
    headline = 'This post is for paid subscribers';
    body = 'Become a paid subscriber to read the rest, or sign in if you already are.';
  } else if (input.reader === 'paid') {
    headline = 'This post is for paid subscribers';
    body = 'Your plan does not include this post.';
  } else {
    headline = 'This post is for paid subscribers';
    body = 'You are signed in, but your subscription does not include paid posts.';
  }
  headline = design.headline ?? headline;
  body = design.body ?? body;

  const parts = [
    `<section class="sw-gate" id="subscribe" aria-labelledby="sw-gate-title">`,
    `<h2 id="sw-gate-title">${h(headline)}</h2>`,
  ];
  if (input.meterSpent) {
    parts.push(
      `<p class="sw-gate-meter">You have read your free posts for this ${input.meterPeriod === 'week' ? 'week' : 'month'}.</p>`,
    );
  }
  parts.push(`<p>${h(body)}</p>`);
  if (design.benefits.length) {
    parts.push(
      `<ul class="sw-gate-benefits">${design.benefits.map((b) => `<li>${h(b)}</li>`).join('')}</ul>`,
    );
  }
  if (paid) {
    const plans = input.coupon
      ? `/subscribe?coupon=${encodeURIComponent(input.coupon.code)}`
      : '/subscribe';
    if (input.coupon) {
      parts.push(
        `<p class="sw-gate-coupon">Use code <strong>${h(input.coupon.code)}</strong> for ${h(couponOffer(input.coupon))}.</p>`,
      );
    }
    parts.push(
      `<p><a class="sw-button" href="${h(plans)}">${h(design.ctaLabel ?? 'See plans')}</a></p>`,
    );
  } else if (anonymous) {
    parts.push(`<div class="sw-subscribe">${input.subscribeForm}</div>`);
  }
  if (input.continueHref) {
    parts.push(
      `<p class="sw-gate-continue"><a href="${h(input.continueHref)}" rel="nofollow">Not now, continue reading</a></p>`,
    );
  }
  if (anonymous) {
    parts.push(`<p class="sw-muted">Already a subscriber? <a href="${h(signin)}">Sign in</a></p>`);
  }
  parts.push('</section>');
  return parts.join('\n');
}
