/**
 * The lookups that turn a presented credential's hash into its row: API keys and OAuth access
 * tokens. The api (workers/api/src/v2/keys.ts, v2/oauth.ts) and the vault (workers/vault) both
 * use these, so what counts as a live key or token cannot drift between the two. Each caller
 * adds its own checks on top (the api: surface, IP allowlist, last-used bookkeeping, plan; the
 * vault: the Channel and scope an operation needs).
 */
import { API_SCOPES, type ApiScope, type OAuthResource, type Plan } from '@swarm/domain';
import { first } from './index';

export interface ApiKeyRow {
  id: string;
  workspace_id: string;
  channel_ids_json: string | null;
  scopes_json: string;
  ip_allowlist_json: string | null;
  rate_cap: number | null;
  surface: 'both' | 'mcp';
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  plan: Plan;
}

/**
 * The key with this secret hash, while the admin who stands behind it still has the admin role in
 * its workspace. Revocation and expiry are left to the caller to check (it reports them).
 */
export function apiKeyRow(db: D1Database, secretHash: string): Promise<ApiKeyRow | null> {
  return first<ApiKeyRow>(
    db,
    `SELECT k.id, k.workspace_id, k.channel_ids_json, k.scopes_json, k.ip_allowlist_json, k.rate_cap,
            k.surface, k.expires_at, k.last_used_at, k.revoked_at, w.plan
       FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id
      WHERE k.secret_hash = ?1
        -- Only while the admin who stands behind it still has the admin role here.
        AND (k.created_by IS NULL OR EXISTS (
          SELECT 1 FROM seats ks WHERE ks.workspace_id = k.workspace_id
             AND ks.operator_id = k.created_by AND ks.role IN ('owner', 'admin')))`,
    secretHash,
  );
}

/** Whether an API key row is usable now: not revoked, not expired. */
export const apiKeyLive = (row: ApiKeyRow, now: number) =>
  row.revoked_at === null && (row.expires_at === null || row.expires_at > now);

/**
 * Live = the token, its grant and its app are not revoked, the token has not expired, and the
 * operator who consented still holds admin or owner in the workspace.
 */
export const LIVE_GRANT_SQL = `g.revoked_at IS NULL AND a.revoked_at IS NULL
  AND EXISTS (SELECT 1 FROM seats s WHERE s.workspace_id = g.workspace_id AND s.operator_id = g.operator_id
              AND s.role IN ('owner', 'admin'))`;

export interface OAuthAccessRow {
  id: string;
  grant_id: string;
  last_used_at: number | null;
  workspace_id: string;
  channel_ids_json: string | null;
  grant_scopes: string;
  app_scopes: string;
  /** Set when a refresh narrowed this access token's scope. */
  token_scopes: string | null;
  plan: Plan;
}

/** The live access token with this hash, for `resource` (RFC 8707), or null. */
export function oauthAccessRow(
  db: D1Database,
  tokenHash: string,
  resource: OAuthResource,
  now: number,
): Promise<OAuthAccessRow | null> {
  return first<OAuthAccessRow>(
    db,
    `SELECT t.id, t.grant_id, t.last_used_at, g.workspace_id, g.channel_ids_json,
            g.scopes_json AS grant_scopes, a.scopes_json AS app_scopes, t.scopes_json AS token_scopes,
            w.plan
       FROM oauth_tokens t
       JOIN oauth_grants g ON g.id = t.grant_id
       JOIN oauth_apps a ON a.id = g.app_id
       JOIN workspaces w ON w.id = g.workspace_id
      WHERE t.token_hash = ?1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > ?2
        AND g.resource = ?3 AND ${LIVE_GRANT_SQL}`,
    tokenHash,
    now,
    resource,
  );
}

/** The scopes a grant may use now: what was consented, still allowed by the app. */
export function effectiveScopes(grantJson: string, appJson: string): ApiScope[] {
  const app = new Set(JSON.parse(appJson) as string[]);
  return (JSON.parse(grantJson) as string[]).filter(
    (scope): scope is ApiScope =>
      app.has(scope) && (API_SCOPES as readonly string[]).includes(scope),
  );
}

/** An access token's scopes: the grant's, narrowed to what the token was issued for. */
export function oauthAccessScopes(row: OAuthAccessRow): ApiScope[] {
  const narrowed = row.token_scopes ? (JSON.parse(row.token_scopes) as string[]) : null;
  return effectiveScopes(row.grant_scopes, row.app_scopes).filter(
    (scope) => !narrowed || narrowed.includes(scope),
  );
}
