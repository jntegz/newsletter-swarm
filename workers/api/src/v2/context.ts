// The public API (/v2): who is calling and what they may do. A request carries either a scoped
// key (`Authorization: Bearer sk_live_…`, resolved in keys.ts) or an OAuth access token
// (`Bearer oat_…`, resolved in oauth.ts). Both resolve to an ApiPrincipal; routes then ask for
// exactly one scope and, for Channel resources, check the Channel belongs to the principal.
// Contract: docs/architecture.md "Platform (Phase 7)".
import { first } from '@swarm/db';
import { scopeAllows, type ApiScope, type Plan, type SeatRole } from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import { env, type AppContext } from '../lib/context';

export interface ApiPrincipal {
  /**
   * `copilot`: an operator acting through Copilot actions. It only ever comes from an in-process
   * request (v2/internal.ts), never from a Bearer credential.
   */
  kind: 'key' | 'oauth' | 'copilot';
  /** The api_keys id, the oauth_tokens id or (copilot) the operator's id. */
  id: string;
  workspaceId: string;
  /** null = every Channel in the workspace. */
  channelIds: string[] | null;
  scopes: ApiScope[];
  plan: Plan;
  /** Requests per minute for this principal; null = the plan's limit. */
  rateCap: number | null;
  /** copilot only: the operator's role on the Channel, which shared write helpers check. */
  role?: SeatRole;
}

function requirePrincipal(c: AppContext): ApiPrincipal {
  const principal = c.get('principal');
  if (!principal) throw new ApiError('unauthorized', 'Send an API key or access token.');
  return principal;
}

/** The principal, if it holds `scope` (a write scope also grants its read scope). */
export function requireScope(c: AppContext, scope: ApiScope): ApiPrincipal {
  const principal = requirePrincipal(c);
  if (!scopeAllows(principal.scopes, scope)) {
    throw new ApiError('insufficient_scope', `This needs the ${scope} scope.`);
  }
  return principal;
}

/**
 * The principal with `scope`, for a Channel it may reach. A Channel in another workspace, outside
 * the key's Channel list, or deleted answers 404, the same as one that does not exist.
 */
export async function requireApiChannel(
  c: AppContext,
  channelId: string,
  scope: ApiScope,
): Promise<ApiPrincipal> {
  const principal = requireScope(c, scope);
  if (principal.channelIds && !principal.channelIds.includes(channelId)) {
    throw new ApiError('not_found', 'Publication not found.');
  }
  const row = await first<{ workspace_id: string }>(
    env(c).DB,
    'SELECT workspace_id FROM channels WHERE id = ?1 AND deleted_at IS NULL',
    channelId,
  );
  if (!row || row.workspace_id !== principal.workspaceId) {
    throw new ApiError('not_found', 'Publication not found.');
  }
  return principal;
}
