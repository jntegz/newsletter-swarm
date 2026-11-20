// Seeds for the vault's tests: tenants, operators with sessions, API keys and OAuth tokens,
// Members and fields, and a vault for one caller on this worker's own env (the same operations
// the entrypoints run; tests/bindings.test.ts goes through the real service bindings).
import { env } from 'cloudflare:workers';
import { sha256Hex } from '@swarm/db';
import { newId, type SeatRole } from '@swarm/domain';
import { createLinkKeys, memberToken } from '@swarm/engine';
import { parseKeyring, parseSigningKeyring, signLink } from '@swarm/tokens';
import { createFakeVault, type VaultCaller, type VaultFor } from '@swarm/vault';

interface VaultOptions {
  vars?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
}

/** `caller`'s entrypoint on the test env, with vars changed and fetch or the clock stubbed. */
export function vault<C extends VaultCaller>(caller: C, options: VaultOptions = {}): VaultFor[C] {
  const vars = Object.fromEntries(
    Object.entries(options.vars ?? {}).filter(([, value]) => value !== undefined),
  );
  const removed = Object.entries(options.vars ?? {})
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  const testEnv: Record<string, unknown> = { ...env, ...vars };
  for (const name of removed) delete testEnv[name];
  return createFakeVault(caller, testEnv, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

const run = (sql: string, ...params: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...params)
    .run();

export async function seedChannel(): Promise<{ workspaceId: string; channelId: string }> {
  const now = Date.now();
  const workspaceId = newId('workspace', now);
  const channelId = newId('channel', now);
  await run(
    "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, 'Field Notes', ?2, ?2)",
    workspaceId,
    now,
  );
  await run(
    "INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, 'Field Notes', ?4, ?4)",
    channelId,
    workspaceId,
    `ch-${crypto.randomUUID().slice(0, 12)}`,
    now,
  );
  return { workspaceId, channelId };
}

export async function addChannel(workspaceId: string): Promise<string> {
  const now = Date.now();
  const channelId = newId('channel', now);
  await run(
    "INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, 'Second', ?4, ?4)",
    channelId,
    workspaceId,
    `ch-${crypto.randomUUID().slice(0, 12)}`,
    now,
  );
  return channelId;
}

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** An operator with a seat and a live session; returns the session cookie's value. */
export async function addOperator(
  workspaceId: string,
  role: SeatRole,
  options: {
    channelRole?: { channelId: string; role: SeatRole };
    mfaPending?: boolean;
    expired?: boolean;
    revoked?: boolean;
  } = {},
): Promise<{ operatorId: string; sessionToken: string }> {
  const now = Date.now();
  const operatorId = newId('operator', now);
  await run(
    'INSERT INTO operators (id, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
    operatorId,
    `${operatorId}@example.test`,
    now,
  );
  await run(
    'INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)',
    newId('seat', now),
    workspaceId,
    operatorId,
    role,
    now,
  );
  if (options.channelRole) {
    await run(
      'INSERT INTO channel_roles (id, channel_id, operator_id, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
      newId('channelRole', now),
      options.channelRole.channelId,
      operatorId,
      options.channelRole.role,
      now,
    );
  }
  const sessionToken = randomToken();
  await run(
    `INSERT INTO sessions (id, token_hash, operator_id, created_at, last_seen_at, expires_at, mfa_pending, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7)`,
    newId('session', now),
    await sha256Hex(sessionToken),
    operatorId,
    now,
    options.expired ? now - 1 : now + 86_400_000,
    options.mfaPending ? 1 : 0,
    options.revoked ? now : null,
  );
  return { operatorId, sessionToken };
}

export const session = (sessionToken: string) =>
  ({ kind: 'operator-session', sessionToken }) as const;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** An API key of the workspace; returns its secret. */
export async function addApiKey(
  workspaceId: string,
  scopes: string[],
  options: {
    channelIds?: string[];
    createdBy?: string | null;
    revoked?: boolean;
    expired?: boolean;
    ipAllowlist?: string[];
    surface?: 'both' | 'mcp';
  } = {},
): Promise<string> {
  const now = Date.now();
  let body = '';
  for (const byte of crypto.getRandomValues(new Uint8Array(40))) body += BASE62[byte % 62];
  const secret = `sk_live_${body}`;
  await run(
    `INSERT INTO api_keys (id, workspace_id, name, prefix, secret_hash, scopes_json, channel_ids_json,
                           created_by, revoked_at, expires_at, ip_allowlist_json, surface, created_at)
     VALUES (?1, ?2, 'test', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    newId('apiKey', now),
    workspaceId,
    body.slice(0, 8),
    await sha256Hex(secret),
    JSON.stringify(scopes),
    options.channelIds ? JSON.stringify(options.channelIds) : null,
    options.createdBy ?? null,
    options.revoked ? now : null,
    options.expired ? now - 1 : null,
    options.ipAllowlist ? JSON.stringify(options.ipAllowlist) : null,
    options.surface ?? 'both',
    now,
  );
  return secret;
}

/** A live OAuth access token for `resource`, granted by `operatorId`; returns the token. */
export async function addOAuthToken(
  workspaceId: string,
  operatorId: string,
  scopes: string[],
  resource: 'v2' | 'mcp' = 'v2',
): Promise<string> {
  const now = Date.now();
  const appId = newId('oauthApp', now);
  const grantId = newId('oauthGrant', now);
  await run(
    `INSERT INTO oauth_apps (id, workspace_id, name, client_id, redirect_uris_json, scopes_json, created_at, updated_at)
     VALUES (?1, ?2, 'App', ?3, '[]', ?4, ?5, ?5)`,
    appId,
    workspaceId,
    `client-${randomToken()}`,
    JSON.stringify(scopes),
    now,
  );
  await run(
    `INSERT INTO oauth_grants (id, app_id, workspace_id, operator_id, scopes_json, resource, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    grantId,
    appId,
    workspaceId,
    operatorId,
    JSON.stringify(scopes),
    resource,
    now,
  );
  const token = `oat_${randomToken()}`;
  await run(
    `INSERT INTO oauth_tokens (id, grant_id, family_id, kind, token_hash, expires_at, created_at)
     VALUES (?1, ?2, ?3, 'access', ?4, ?5, ?6)`,
    newId('oauthToken', now),
    grantId,
    randomToken(),
    await sha256Hex(token),
    now + 3_600_000,
    now,
  );
  return token;
}

export async function addMember(
  channelId: string,
  email = `${crypto.randomUUID().slice(0, 8)}@example.test`,
  status = 'active',
): Promise<string> {
  const now = Date.now();
  const id = newId('member', now);
  await run(
    `INSERT INTO members (id, channel_id, email, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    id,
    channelId,
    email,
    status,
    now,
  );
  return id;
}

export async function addField(
  channelId: string,
  key: string,
  options: { encrypted?: boolean; type?: string } = {},
): Promise<string> {
  const now = Date.now();
  const id = newId('memberField', now);
  await run(
    `INSERT INTO member_fields (id, channel_id, key, label, type, encrypted, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?6)`,
    id,
    channelId,
    key,
    options.type ?? 'text',
    options.encrypted === false ? 0 : 1,
    now,
  );
  return id;
}

export async function storeValue(memberId: string, fieldId: string, sealed: string) {
  await run(
    `INSERT INTO member_field_values (member_id, field_id, value_enc, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (member_id, field_id) DO UPDATE SET value_enc = excluded.value_enc`,
    memberId,
    fieldId,
    sealed,
    Date.now(),
  );
}

/** A Member Center link as send and jobs mint it: v1 under MEMBER_KEYS before the cutover. */
export const memberLinkV1 = (memberId: string, options: { emailed?: boolean; now?: number } = {}) =>
  memberToken(
    legacyLinks(env.MEMBER_KEYS),
    // A v1 link carries no Channel claim; the vault checks the Member's row instead.
    { memberId, channelId: '' },
    options.now ?? Date.now(),
    options.emailed ? { emailed: true } : {},
  );

/** Signs and checks links the v1 way under a MEMBER_KEYS text, as workers did before the cutover. */
export const legacyLinks = (memberKeys: string) =>
  createLinkKeys({
    mode: { signing: 'v1', legacyCutoffMs: null },
    memberKeys: parseKeyring(memberKeys),
    rings: {},
  });

/** The same link after the cutover: v2 under MEMBER_SIGNING_KEYS, naming the Member's Channel. */
export async function memberLinkV2(
  memberId: string,
  channelId: string,
  options: { emailed?: boolean; now?: number } = {},
) {
  const ring = await parseSigningKeyring('MEMBER_SIGNING_KEYS', env.MEMBER_SIGNING_KEYS);
  return signLink(
    'member',
    ring,
    { m: memberId, c: channelId, ...(options.emailed ? { e: 1 } : {}) },
    { now: options.now ?? Date.now() },
  );
}

export const sql = run;

export async function rows<T>(query: string, ...params: unknown[]): Promise<T[]> {
  return (
    await env.DB.prepare(query)
      .bind(...params)
      .all<T>()
  ).results;
}
