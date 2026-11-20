// The site worker's vault (workers/vault, SiteVault). The site holds no FIELD_KEYS, no goods or
// signup signing key and no Stripe key: join tokens are opened there, goods links minted there
// from the evidence the site has (an address asked at the library form, a paid order on the
// thank-you page), and every Stripe and PayPal call goes out through it. Failures fail closed: a
// link that can't be minted isn't shown or sent, a payment call answers as unavailable.
import {
  stripeThroughVault,
  type GoodsLinkMinter,
  type JoinClaims,
  type PayPalVault,
  type PrivacyVault,
} from '@swarm/engine';
import { markerPort, vaultClient, vaultFetch, type GoodsLinkEvidence } from '@swarm/vault';
import type { SiteEnv } from './env';

const siteVault = (env: SiteEnv) => vaultClient('site', env.VAULT);

/** Erasure markers through the vault. */
export const siteMarkers = (env: SiteEnv): PrivacyVault => markerPort(siteVault(env));

/** A join token's claims for this Channel, opened by the vault; null when it doesn't open. */
export async function openJoin(
  env: SiteEnv,
  token: string,
  channelId: string,
): Promise<JoinClaims | null> {
  if (!token || token.length > 4096) return null;
  const opened = await siteVault(env).openJoinToken({ token, channelId });
  if (!opened.ok) return null;
  const { formId, email, memberId, journeyPath, issuedAt } = opened.value;
  return { formId, email, memberId, journey: journeyPath, issuedAt };
}

/**
 * Goods links minted by the vault from `evidence`, one call per minter. Null when it made none
 * (no paid order, over its limit, or down): then no link is shown or sent.
 */
export function evidenceGoodsLinks(env: SiteEnv, evidence: GoodsLinkEvidence): GoodsLinkMinter {
  let minted: Promise<{ library: string; order: string } | null> | null = null;
  const mint = () => {
    minted ??= (async () => {
      const result = await siteVault(env).mintGoodsLink(evidence);
      return result.ok ? result.value : null;
    })();
    return minted;
  };
  const pick = async (kind: 'library' | 'order') => {
    const links = await mint();
    if (!links) throw new Error('No goods link could be made.');
    return links[kind];
  };
  return {
    libraryToken: () => pick('library'),
    orderToken: () => pick('order'),
  };
}

/** Goods links for orders of a Channel paid a moment ago (the dev payments fake's events). */
export const orderGoodsLinks = (env: SiteEnv): GoodsLinkMinter => ({
  libraryToken: (input) =>
    evidenceGoodsLinks(env, {
      kind: 'order',
      channelId: input.channelId,
      orderId: input.orderId,
    }).libraryToken(input),
  orderToken: (input) =>
    evidenceGoodsLinks(env, {
      kind: 'order',
      channelId: input.channelId,
      orderId: input.orderId,
    }).orderToken(input),
});

/** Stripe for anyone on the Channel's site: Checkout sessions only, through the vault. */
export const publicStripe = (env: SiteEnv, channelId: string) =>
  stripeThroughVault(
    env,
    vaultFetch(
      siteVault(env),
      { kind: 'public-channel', channelId },
      { kind: 'stripe', channelId },
    ),
  );

/** Stripe for a signed-in reader: the Billing Portal of their own customer, through the vault. */
export const readerStripe = (env: SiteEnv, channelId: string, readerToken: string) =>
  stripeThroughVault(
    env,
    vaultFetch(
      siteVault(env),
      { kind: 'reader-session', token: readerToken, channelId },
      { kind: 'stripe', channelId },
    ),
  );

/** PayPal plans and subscriptions for anyone on the Channel's site, through the vault. */
export const publicPayPal = (env: SiteEnv): Pick<PayPalVault, 'fetchFor'> => ({
  fetchFor: (channelId) =>
    vaultFetch(
      siteVault(env),
      { kind: 'public-channel', channelId },
      { kind: 'paypal', channelId },
    ),
});
