// Link keyrings for the test suites: the same values in every worker's vitest config, so a link
// one worker's tests sign verifies in another's. Ed25519 keys come from fixed seeds (their PKCS#8
// form is a fixed prefix and the 32-byte seed), so they are real key pairs and never change.
// Test only: the kid is t1, which the installer never makes (it makes k<yyyymmdd>).
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const seed = (name) => createHash('sha256').update(`swarm-test-link-key:${name}`).digest();

/** `t1:<base64url PKCS#8>` for an Ed25519 keyring. */
function signingRing(name) {
  return `t1:${Buffer.concat([PKCS8_ED25519_PREFIX, seed(name)]).toString('base64url')}`;
}

/** `t1:<base64url raw public key>` for the same keyring. */
function verifyRing(name) {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed(name)]),
    format: 'der',
    type: 'pkcs8',
  });
  return `t1:${createPublicKey(key).export({ format: 'jwk' }).x}`;
}

/** The value of one link secret: `NAME_SIGNING_KEYS`, `NAME_VERIFY_KEYS` or an HMAC `NAME_KEYS`. */
export function testLinkKey(secret) {
  if (secret.endsWith('_SIGNING_KEYS')) return signingRing(secret);
  if (secret.endsWith('_VERIFY_KEYS')) {
    return verifyRing(secret.replace(/_VERIFY_KEYS$/, '_SIGNING_KEYS'));
  }
  return `t1:${seed(secret).toString('base64url')}`;
}

const ED25519 = [
  'MEMBER',
  'ASK',
  'ASK_PAGE',
  'DSR_EXPORT',
  'GOODS',
  'CHECKOUT',
  'SITE_LINK',
  'SPONSOR_REPORT',
];
const HMAC = ['CONFIRM_KEYS', 'CAPTURE_KEYS', 'FORM_STAMP_KEYS', 'SIGNUP_KEYS'];

/** Every per-family link secret (engine links.ts LINK_SECRET_NAMES), signing and public. */
const ALL_LINK_SECRETS = [
  ...HMAC,
  ...ED25519.flatMap((name) => [`${name}_SIGNING_KEYS`, `${name}_VERIFY_KEYS`]),
];

/** The test MEMBER_KEYS: what signed every link before the cutover. */
export const TEST_MEMBER_KEYS = `m1:${'m'.repeat(64)}`;

/**
 * Bindings for a worker's tests: each named secret, the link mode (v2, cut over when the test run
 * started, so a v1 link signed "earlier" still verifies within its window), MEMBER_KEYS for those
 * v1 links, and TEST_LINK_KEYS, every link keyring as JSON, for a test that signs or checks a link
 * as another worker would.
 */
export function testLinkBindings(secrets, { memberKeys = true } = {}) {
  return {
    LINK_SIGNING_MODE: 'v2',
    LINK_LEGACY_CUTOFF: String(Date.now()),
    ...(memberKeys ? { MEMBER_KEYS: TEST_MEMBER_KEYS } : {}),
    ...Object.fromEntries(secrets.map((secret) => [secret, testLinkKey(secret)])),
    TEST_LINK_KEYS: JSON.stringify(
      Object.fromEntries(ALL_LINK_SECRETS.map((secret) => [secret, testLinkKey(secret)])),
    ),
  };
}
