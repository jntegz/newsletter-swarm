// Links as the other workers would sign them, from the test install's keyrings (vitest.config.ts
// testLinkBindings): every family's key, so a test can make what send, jobs or the vault would.
import { env } from 'cloudflare:test';
import { askToken, createLinkKeys, memberToken } from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';

/** Every link keyring of the test install, v2 since the test run started. */
export const testLinks = () =>
  createLinkKeys({
    mode: { signing: 'v2', legacyCutoffMs: Number(env.LINK_LEGACY_CUTOFF) },
    memberKeys: parseKeyring(env.MEMBER_KEYS),
    rings: JSON.parse(env.TEST_LINK_KEYS) as Record<string, string>,
  });

/** MEMBER_KEYS, which signed v1 links before the cutover. */
export const legacyKeys = () => parseKeyring(env.MEMBER_KEYS);

/** When the test install cut over to per-family links. */
export const cutoff = () => Number(env.LINK_LEGACY_CUTOFF);

const channelOf = async (memberId: string) =>
  (await env.DB.prepare('SELECT channel_id FROM members WHERE id = ?1')
    .bind(memberId)
    .first<string>('channel_id')) ?? `ch_${'0'.repeat(32)}`;

/** A Member Center token for a Member, naming its own Channel, as send or jobs sign one. */
export async function memberTokenFor(
  memberId: string,
  now?: number,
  options: { emailed?: true } = {},
): Promise<string> {
  return memberToken(testLinks(), { memberId, channelId: await channelOf(memberId) }, now, options);
}

/** A one-tap Ask token, as the send worker signs one. */
export async function askTokenFor(memberId: string, optionId: string): Promise<string> {
  return askToken(testLinks(), { memberId, channelId: await channelOf(memberId) }, optionId);
}
