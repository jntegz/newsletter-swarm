// Scoped API keys (sk_live_…): minting and resolving a presented key to a principal. Owned by the
// Open API workstream (Phase 7): hash lookup, revoked and expired keys, the IP allowlist,
// last_used_at. The dashboard routes are in routes/apiKeys.ts.
import { apiKeyLive, apiKeyRow, run } from '@swarm/db';
import {
  API_KEY_LAST_USED_INTERVAL_MS,
  API_KEY_PATTERN,
  API_KEY_PREFIX,
  ipInCidr,
  type ApiScope,
  type OAuthResource,
} from '@swarm/domain';
import { clientIp, env, type AppContext } from '../lib/context';
import { ipPrefix, sha256Hex } from '../lib/crypto';
import type { ApiPrincipal } from './context';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SECRET_LENGTH = 40;

/** A new key: the full secret (shown once), its sha256 and the 8-character display prefix. */
export async function mintApiKey(): Promise<{ secret: string; hash: string; prefix: string }> {
  let body = '';
  // Rejection sampling keeps every character uniform (256 is not a multiple of 62).
  while (body.length < SECRET_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    for (const byte of bytes) {
      if (byte < 248 && body.length < SECRET_LENGTH) body += BASE62[byte % 62];
    }
  }
  const secret = `${API_KEY_PREFIX}${body}`;
  return { secret, hash: await sha256Hex(secret), prefix: body.slice(0, 8) };
}

/**
 * The principal for a presented key, or null when it is not a valid, usable key for `resource`:
 * a key limited to the MCP server (surface `mcp`, for agents) is not valid on /v2, so its value
 * can't be used to skip the approval holds.
 */
export async function resolveApiKey(
  c: AppContext,
  secret: string,
  resource: OAuthResource = 'v2',
): Promise<ApiPrincipal | null> {
  if (!API_KEY_PATTERN.test(secret)) return null;
  const e = env(c);
  const row = await apiKeyRow(e.DB, await sha256Hex(secret));
  const now = Date.now();
  if (!row || !apiKeyLive(row, now)) return null;
  if (row.surface === 'mcp' && resource !== 'mcp') return null;
  const ip = clientIp(c);
  if (row.ip_allowlist_json) {
    const ranges = JSON.parse(row.ip_allowlist_json) as string[];
    if (!ip || !ranges.some((range) => ipInCidr(ip, range))) return null;
  }
  // At most one write a minute per key, guarded so concurrent requests don't all write.
  if (row.last_used_at === null || now - row.last_used_at >= API_KEY_LAST_USED_INTERVAL_MS) {
    await run(
      e.DB,
      `UPDATE api_keys SET last_used_at = ?1, last_used_ip_prefix = ?2
        WHERE id = ?3 AND (last_used_at IS NULL OR last_used_at <= ?4)`,
      now,
      ipPrefix(ip),
      row.id,
      now - API_KEY_LAST_USED_INTERVAL_MS,
    );
  }
  return {
    kind: 'key',
    id: row.id,
    workspaceId: row.workspace_id,
    channelIds: row.channel_ids_json ? (JSON.parse(row.channel_ids_json) as string[]) : null,
    scopes: JSON.parse(row.scopes_json) as ApiScope[],
    plan: row.plan,
    rateCap: row.rate_cap,
  };
}
