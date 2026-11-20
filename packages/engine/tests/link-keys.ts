// Link keys as each worker holds them (packages/installer/src/keys.ts KEY_REGISTRY), from the
// shared test keyrings. Member Center, goods and signup links are the vault's.
import { parseKeyring, type LinkMode } from '@swarm/tokens';
import { createLinkKeys, type LinkKeys } from '../src/links';
import { TEST_MEMBER_KEYS, testLinkKey } from '../../../scripts/lib/test-link-keys.mjs';

export const HOLDS = {
  api: [
    'CONFIRM_KEYS',
    'CHECKOUT_VERIFY_KEYS',
    'SITE_LINK_SIGNING_KEYS',
    'SPONSOR_REPORT_SIGNING_KEYS',
  ],
  capture: [
    'CONFIRM_KEYS',
    'CAPTURE_KEYS',
    'FORM_STAMP_KEYS',
    'MEMBER_VERIFY_KEYS',
    'ASK_VERIFY_KEYS',
    'ASK_PAGE_SIGNING_KEYS',
    'DSR_EXPORT_VERIFY_KEYS',
  ],
  site: [
    'CONFIRM_KEYS',
    'FORM_STAMP_KEYS',
    'ASK_PAGE_VERIFY_KEYS',
    'GOODS_VERIFY_KEYS',
    'CHECKOUT_SIGNING_KEYS',
    'SITE_LINK_VERIFY_KEYS',
    'SPONSOR_REPORT_VERIFY_KEYS',
  ],
  jobs: ['MEMBER_SIGNING_KEYS', 'DSR_EXPORT_SIGNING_KEYS', 'SPONSOR_REPORT_SIGNING_KEYS'],
  send: ['MEMBER_SIGNING_KEYS', 'ASK_SIGNING_KEYS'],
  vault: ['SIGNUP_KEYS', 'MEMBER_SIGNING_KEYS', 'MEMBER_VERIFY_KEYS', 'GOODS_SIGNING_KEYS'],
} as const;

export type Holder = keyof typeof HOLDS;

/** The MEMBER_KEYS every test worker has, which signed links before the cutover. */
export const memberKeys = parseKeyring(TEST_MEMBER_KEYS);

/** A worker's link keys. By default: v2 since `cutoffMs` (a day ago), MEMBER_KEYS still held. */
export function workerLinks(
  holder: Holder | readonly string[],
  options: { mode?: Partial<LinkMode>; memberKeys?: boolean } = {},
): LinkKeys {
  const secrets = typeof holder === 'string' ? HOLDS[holder] : holder;
  return createLinkKeys({
    mode: { signing: 'v2', legacyCutoffMs: Date.now() - 86_400_000, ...options.mode },
    memberKeys: options.memberKeys === false ? undefined : memberKeys,
    rings: Object.fromEntries(secrets.map((secret) => [secret, testLinkKey(secret)])),
  });
}

/** Every link keyring: signs and verifies every family, as no deployed worker can. */
export const everyLink = (options: Parameters<typeof workerLinks>[1] = {}) =>
  workerLinks(
    [...new Set(Object.values(HOLDS).flat())].flatMap((secret) =>
      secret.endsWith('_SIGNING_KEYS')
        ? [secret, secret.replace(/_SIGNING_KEYS$/, '_VERIFY_KEYS')]
        : [secret],
    ),
    options,
  );
