/**
 * Website theme previews (docs/site-themes.md): the API mints one for the draft design, the site
 * worker verifies it at /_swarm/preview. SITE_LINK_SIGNING_KEYS (Ed25519, the api alone signs): the
 * site holds only the public keys. Purposes allow no underscore, so it is "site-preview".
 */
import type { LinkSigner, LinkVerifier } from './links';

export const SITE_PREVIEW_PURPOSE = 'site-preview';
/** Previews work for 30 minutes. */
export const SITE_PREVIEW_SECONDS = 30 * 60;
const PREVIEW_AUDIENCES = ['visitor', 'subscriber', 'paid'] as const;

interface SitePreviewClaims {
  /** The Channel whose draft it shows. */
  channelId: string;
  /** Who the page is drawn for. */
  as: (typeof PREVIEW_AUDIENCES)[number];
}

export async function signSitePreview(
  links: LinkSigner,
  claims: SitePreviewClaims,
  options: { now?: number } = {},
): Promise<{ token: string; expiresAt: number }> {
  const now = options.now ?? Date.now();
  const token = await links.sign(
    SITE_PREVIEW_PURPOSE,
    { c: claims.channelId, as: claims.as },
    { expiresInSeconds: SITE_PREVIEW_SECONDS, now },
  );
  return { token, expiresAt: (Math.floor(now / 1000) + SITE_PREVIEW_SECONDS) * 1000 };
}

/** The claims of a valid, unexpired preview token, or null. */
export async function verifySitePreview(
  links: LinkVerifier,
  token: string,
  options: { now?: number } = {},
): Promise<SitePreviewClaims | null> {
  const result = await links.verify<{ c?: unknown; as?: unknown }>(
    SITE_PREVIEW_PURPOSE,
    token,
    options,
  );
  if (!result.ok || result.payload.exp === undefined) return null;
  const { c, as } = result.payload;
  if (typeof c !== 'string' || !(PREVIEW_AUDIENCES as readonly unknown[]).includes(as)) return null;
  return { channelId: c, as: as as SitePreviewClaims['as'] };
}
