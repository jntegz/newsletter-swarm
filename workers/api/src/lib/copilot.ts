// Copilot plumbing shared by the editor assistant (routes/copilot.ts) and Copilot actions
// (routes/copilotActions.ts): flags, the workspace key, which provider serves a request, and the
// plan limits. Contract: docs/copilot.md.
import { first } from '@swarm/db';
import type { CopilotKeySource, Plan } from '@swarm/domain';
import {
  CopilotLimitError,
  aiGatewayOf,
  createCopilotProvider,
  platformCopilotProvider,
  reserveCopilotRequest,
  type CopilotProvider,
  type CopilotRequestStart,
  VAULT_HELD_KEY,
} from '@swarm/engine';
import { D1FlagStore, FlagService, type FlagContext, type FlagKey } from '@swarm/flags';
import { ApiError } from '@swarm/runtime';
import { vaultFetch } from '@swarm/vault';
import { env, type AppContext } from './context';
import { apiVault, credentialOf } from './vault';

interface KeyRow {
  id: string;
  provider: 'anthropic';
  key_enc: string;
  last4: string;
  validated_at: number;
  created_at: number;
  monthly_unit_cap: number | null;
}

export async function flagOn(c: AppContext, key: FlagKey, context: FlagContext): Promise<boolean> {
  const e = env(c);
  return new FlagService(new D1FlagStore(e.DB, e.CACHE)).enabled(key, context);
}

export const loadKey = (db: D1Database, workspaceId: string) =>
  first<KeyRow>(
    db,
    `SELECT id, provider, key_enc, last4, validated_at, created_at, monthly_unit_cap FROM copilot_keys
      WHERE workspace_id = ?1`,
    workspaceId,
  );

export async function planOf(db: D1Database, workspaceId: string): Promise<Plan> {
  const row = await first<{ plan: Plan }>(
    db,
    'SELECT plan FROM workspaces WHERE id = ?1',
    workspaceId,
  );
  return row?.plan ?? 'free';
}

/**
 * The provider for a request: the workspace's own key when BYOK is on and one is saved (always
 * Anthropic), else the platform adapter (Workers AI by default). A saved key that can't be
 * opened is an error, never a silent switch to the platform; see docs/copilot.md.
 */
export async function providerFor(
  c: AppContext,
  scope: { workspaceId: string; channelId: string },
): Promise<{ provider: CopilotProvider; model: string; keySource: CopilotKeySource }> {
  const e = env(c);
  const saved = (await flagOn(c, 'copilot_byok', scope))
    ? await loadKey(e.DB, scope.workspaceId)
    : null;
  if (saved) {
    // The key never leaves the vault: the provider's requests go out through it, which attaches
    // the key and streams the reply back. Asked first whether the key opens, so one that can't
    // be is a clear error before any stream starts, never a platform switch.
    const credential = { kind: 'copilot', workspaceId: scope.workspaceId } as const;
    const check = await apiVault(c).checkCredential(credentialOf(c), credential);
    if (!check.ok) {
      throw new ApiError(
        'unavailable',
        check.reason === 'unavailable'
          ? 'Copilot can’t reach your workspace’s model key right now. Try again in a moment.'
          : 'Your workspace’s model key can’t be opened. Add it again in Settings → Copilot.',
      );
    }
    return {
      provider: createCopilotProvider(e, VAULT_HELD_KEY, {
        gateway: aiGatewayOf(e),
        fetch: vaultFetch(apiVault(c), credentialOf(c), credential, { stream: true }),
      }),
      model: e.COPILOT_MODEL,
      keySource: 'workspace',
    };
  }
  const platform = platformCopilotProvider(e);
  if (!platform) throw new ApiError('unavailable', 'Copilot is not set up on this server.');
  return { ...platform, keySource: 'platform' };
}

/**
 * Checks the per-minute and monthly limits and logs the request as pending in one step;
 * answers rate_limited with the limit hit.
 */
export async function reserveRequest(
  c: AppContext,
  input: Omit<CopilotRequestStart, 'plan'>,
): Promise<{ id: string; remaining: number | null }> {
  const e = env(c);
  try {
    return await reserveCopilotRequest(e.DB, {
      ...input,
      plan: await planOf(e.DB, input.workspaceId),
    });
  } catch (error) {
    if (error instanceof CopilotLimitError) {
      throw new ApiError('rate_limited', error.message, [{ path: 'quota', message: error.limit }]);
    }
    throw error;
  }
}
