/**
 * The token families and the keyrings that sign them. Each family has its own keyring, so a
 * worker's secrets sign only what that worker itself must sign (docs/security.md "Keys").
 *
 * - A family whose verifier is a public worker and whose signer is another worker signs with
 *   Ed25519: the verifier holds only a public key (`<NAME>_VERIFY_KEYS`), so it can't forge one.
 * - The rest sign with HMAC-SHA256: the signer is also the verifier, or the code has to fit an
 *   email local part (unsubscribe and bounce codes, which are not tokens and are not listed here).
 *
 * Purposes are unchanged from the v1 tokens, so a link keeps its meaning across the move. Until
 * the cutover every family below was signed with MEMBER_KEYS, except those on AUTH_KEYS,
 * READER_KEYS and TRACK_KEYS, which keep their keyrings and their v1 format; they are listed for
 * their lifetimes, which `pnpm swarm rotate-keys` reads.
 */

export type KeyringName =
  | 'AUTH_KEYS'
  | 'TRACK_KEYS'
  | 'UNSUBSCRIBE_KEYS'
  | 'BOUNCE_KEYS'
  | 'READER_KEYS'
  | 'CONFIRM_KEYS'
  | 'CAPTURE_KEYS'
  | 'FORM_STAMP_KEYS'
  | 'SIGNUP_KEYS'
  | 'FIELD_KEYS'
  | 'MEMBER_SIGNING_KEYS'
  | 'ASK_SIGNING_KEYS'
  | 'ASK_PAGE_SIGNING_KEYS'
  | 'DSR_EXPORT_SIGNING_KEYS'
  | 'GOODS_SIGNING_KEYS'
  | 'CHECKOUT_SIGNING_KEYS'
  | 'SITE_LINK_SIGNING_KEYS'
  | 'SPONSOR_REPORT_SIGNING_KEYS'
  /** Legacy: verifies v1 links issued before the cutover, for their lifetime; nothing signs with it after. */
  | 'MEMBER_KEYS';

export type LinkAlg = 'hmac-sha256' | 'ed25519';

/** FIELD_KEYS seals values (AES-GCM, keys derived with HKDF); every other keyring signs. */
export const KEYRING_ALGS: Readonly<Record<KeyringName, LinkAlg | 'aes-256-gcm'>> = {
  AUTH_KEYS: 'hmac-sha256',
  TRACK_KEYS: 'hmac-sha256',
  UNSUBSCRIBE_KEYS: 'hmac-sha256',
  BOUNCE_KEYS: 'hmac-sha256',
  READER_KEYS: 'hmac-sha256',
  CONFIRM_KEYS: 'hmac-sha256',
  CAPTURE_KEYS: 'hmac-sha256',
  FORM_STAMP_KEYS: 'hmac-sha256',
  SIGNUP_KEYS: 'hmac-sha256',
  FIELD_KEYS: 'aes-256-gcm',
  MEMBER_SIGNING_KEYS: 'ed25519',
  ASK_SIGNING_KEYS: 'ed25519',
  ASK_PAGE_SIGNING_KEYS: 'ed25519',
  DSR_EXPORT_SIGNING_KEYS: 'ed25519',
  GOODS_SIGNING_KEYS: 'ed25519',
  CHECKOUT_SIGNING_KEYS: 'ed25519',
  SITE_LINK_SIGNING_KEYS: 'ed25519',
  SPONSOR_REPORT_SIGNING_KEYS: 'ed25519',
  MEMBER_KEYS: 'hmac-sha256',
};

/**
 * The secret an Ed25519 keyring's public keys go under, for the workers that only verify:
 * MEMBER_SIGNING_KEYS → MEMBER_VERIFY_KEYS. Format `kid:<base64url raw 32-byte key>[,…]`.
 */
export function verifyKeysName(name: KeyringName): string {
  if (KEYRING_ALGS[name] !== 'ed25519') throw new Error(`${name} is not an Ed25519 keyring`);
  return name.replace(/_SIGNING_KEYS$/, '_VERIFY_KEYS');
}

export interface FamilySpec {
  /** The token purpose, signed into every token. */
  purpose: string;
  keyring: KeyringName;
  alg: LinkAlg;
  /** The longest a token may live; null for tokens that never expire (they are checked against a row). */
  maxLifetimeSeconds: number | null;
  /** The claim naming the tenant (Channel `c` or workspace `w`) the verifier checks against its row. */
  tenantClaim: 'c' | 'w' | null;
  /**
   * v1 tokens signed with MEMBER_KEYS before the cutover that still verify: those that lived at most
   * `lifetimeSeconds` when issued, for at most `acceptForSeconds` after the cutover. Null: none.
   */
  legacy: { lifetimeSeconds: number; acceptForSeconds: number } | null;
  /**
   * The keyring this family was signed with before it got its own: v2 links signed with it still
   * verify, within their own lifetime, at a verifier that holds that ring's (public) keys.
   */
  formerKeyring: KeyringName | null;
}

const MINUTE = 60;
const DAY = 86_400;

/** No v1 link is accepted for longer than this after the cutover, whatever it was issued for. */
export const LEGACY_ACCEPT_MAX_SECONDS = 90 * DAY;

function family(
  purpose: string,
  keyring: KeyringName,
  maxLifetimeSeconds: number | null,
  tenantClaim: FamilySpec['tenantClaim'],
  /** The v1 lifetime, when v1 tokens of this family were signed with MEMBER_KEYS. */
  v1LifetimeSeconds?: number,
  formerKeyring: KeyringName | null = null,
): FamilySpec {
  const alg = KEYRING_ALGS[keyring];
  if (alg === 'aes-256-gcm') throw new Error(`${keyring} does not sign`);
  return {
    purpose,
    keyring,
    alg,
    maxLifetimeSeconds,
    tenantClaim,
    legacy:
      v1LifetimeSeconds === undefined
        ? null
        : {
            lifetimeSeconds: v1LifetimeSeconds,
            acceptForSeconds: Math.min(v1LifetimeSeconds, LEGACY_ACCEPT_MAX_SECONDS),
          },
    formerKeyring,
  };
}

const LIST: readonly FamilySpec[] = [
  // Confirming a signup and leaving from the confirm mail: api, capture and site sign, capture verifies.
  family('confirm', 'CONFIRM_KEYS', 30 * DAY, 'c', 30 * DAY),
  family('leave', 'CONFIRM_KEYS', 30 * DAY, 'c', 30 * DAY),
  // Subscriber settings links: send and jobs sign (the vault for api and capture), capture verifies.
  family('member', 'MEMBER_SIGNING_KEYS', 30 * DAY, 'c', 30 * DAY),
  // Capture's own: the reference a form passes to the publisher's page (nothing in Swarm reads it
  // back), the bot challenge, the erasure confirmations. CAPTURE_KEYS also keys the challenge's
  // answer and the signup journey variant seed, which are not tokens.
  family('member-ref', 'CAPTURE_KEYS', DAY, 'c'),
  family('challenge', 'CAPTURE_KEYS', 15 * MINUTE, null, 15 * MINUTE),
  family('dsr-confirm', 'CAPTURE_KEYS', DAY, null, DAY),
  family('dsr-address-confirm', 'CAPTURE_KEYS', DAY, 'w', DAY),
  // The stamp a rendered form carries: capture and site sign, capture verifies.
  family('form-stamp', 'FORM_STAMP_KEYS', 90 * DAY, null, 90 * DAY),
  // Sealed signup claims: signed and verified by the vault, for capture and site.
  family('join', 'SIGNUP_KEYS', DAY, 'c', DAY),
  family('journey', 'SIGNUP_KEYS', DAY, null, DAY),
  // One-tap answers in a send (send signs, capture verifies) and the ask page (capture → site).
  family('ask', 'ASK_SIGNING_KEYS', 90 * DAY, 'c', 90 * DAY),
  family('ask-page', 'ASK_PAGE_SIGNING_KEYS', 7 * DAY, 'c', 7 * DAY),
  // A subscriber's data download: jobs signs, capture verifies.
  family('dsr-export', 'DSR_EXPORT_SIGNING_KEYS', 7 * DAY, 'w', 7 * DAY),
  // Bought goods: the vault signs for site and api, site verifies.
  family('goods-library', 'GOODS_SIGNING_KEYS', 90 * DAY, 'c', 90 * DAY),
  family('goods-order', 'GOODS_SIGNING_KEYS', 90 * DAY, 'c', 90 * DAY),
  // The Checkout reference: site signs, the api's payment webhook verifies (against its row).
  family('checkout-ref', 'CHECKOUT_SIGNING_KEYS', 30 * DAY, null, 30 * DAY),
  // Links for the site: sponsor reports, signed by the api and jobs (365 days as v1, 90 from the
  // cutover; jobs mails new ones), on their own keyring since the vault release, so jobs holds no
  // key for design previews. Reports signed with SITE_LINK_SIGNING_KEYS before keep working for
  // their 90 days. Design previews: the api alone.
  family(
    'sponsor-report',
    'SPONSOR_REPORT_SIGNING_KEYS',
    90 * DAY,
    'c',
    365 * DAY,
    'SITE_LINK_SIGNING_KEYS',
  ),
  family('site-preview', 'SITE_LINK_SIGNING_KEYS', 30 * MINUTE, 'c', 30 * MINUTE),
  // Unchanged keyrings, still v1.
  family('oauth-state', 'AUTH_KEYS', DAY, null),
  family('sso-state', 'AUTH_KEYS', DAY, null),
  family('stripe-connect', 'AUTH_KEYS', DAY, null),
  family('export', 'AUTH_KEYS', DAY, null),
  family('chain-verify', 'AUTH_KEYS', DAY, 'w'),
  family('meter', 'READER_KEYS', 31 * DAY, 'c'),
  family('reader-signin', 'READER_KEYS', 20 * MINUTE, null),
  family('reader-session', 'READER_KEYS', null, null),
  family('track', 'TRACK_KEYS', 400 * DAY, null),
];

/** Every token family, by purpose. */
export const FAMILIES: Readonly<Record<string, FamilySpec>> = Object.freeze(
  Object.fromEntries(LIST.map((spec) => [spec.purpose, Object.freeze(spec)])),
);

/** The family of a purpose; throws for one that isn't registered, which is a bug, not input. */
export function familyOf(purpose: string): FamilySpec {
  if (!Object.hasOwn(FAMILIES, purpose)) throw new Error(`no token family "${purpose}"`);
  return FAMILIES[purpose] as FamilySpec;
}
