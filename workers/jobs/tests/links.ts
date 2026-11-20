// Links as the other workers would sign them, from the test install's keyrings (vitest.config.ts
// testLinkBindings): every family's key, so a test can make what send, jobs or the vault would.
import { env } from 'cloudflare:test';
import { createLinkKeys } from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';

/** Every link keyring of the test install, v2 since the test run started. */
export const testLinks = () =>
  createLinkKeys({
    mode: { signing: 'v2', legacyCutoffMs: Number(env.LINK_LEGACY_CUTOFF) },
    memberKeys: parseKeyring(env.MEMBER_KEYS),
    rings: JSON.parse(env.TEST_LINK_KEYS) as Record<string, string>,
  });
