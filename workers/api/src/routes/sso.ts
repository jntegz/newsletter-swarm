// SSO connections (OIDC; SAML is deferred, see docs/security.md) and SSO sign-in (Phase 7).
// A connection captures email domains its workspace proved with a DNS TXT record; people with
// those addresses sign in through the workspace's identity provider, get a seat just in time when
// jit_role is set, and with `enforced` can't enter the workspace any other way (owners excepted).
// Every route answers feature_disabled (404) while the sso flag is off at platform scope. Plan
// gating still applies when it is on. To turn it on: docs/self-hosting.md "Single sign-on".
import { createRoute, z } from '@hono/zod-openapi';
import { all, batch, first, isUniqueViolation, run, toIso } from '@swarm/db';
import {
  AddSsoDomainSchema,
  CreateSsoConnectionSchema,
  PLAN_LIMITS,
  SSO_DOMAIN_LAPSE_DAYS,
  SSO_DOMAIN_RECHECK_HOURS,
  SSO_MAX_DOMAINS,
  SSO_RELEASED_DOMAIN_DAYS,
  SSO_TXT_PREFIX,
  SSO_TXT_VALUE_PREFIX,
  SsoConnectionSchema,
  SsoDomainSchema,
  UpdateSsoConnectionSchema,
  idPattern,
  newId,
  type Plan,
  type SeatRole,
  type SsoConnection,
  type SsoDomain,
} from '@swarm/domain';
import {
  outboundUrlProblem,
  reproveSsoDomain,
  ssoDomainFailingNotice,
  ssoTxtResolver,
  syncSsoDomains,
  type TxtResolver,
} from '@swarm/engine';
import { escapeHtml } from '@swarm/mail';
import { ApiError } from '@swarm/runtime';
import { vaultValue } from '@swarm/vault';
import { signToken, verifyToken } from '@swarm/tokens';
import type { MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { isLocal, type ApiEnv } from '../env';
import { requireWorkspace, ssoEnabled } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env, type AppContext, type AppEnv } from '../lib/context';
import { ipPrefix, randomToken, sha256Hex } from '../lib/crypto';
import {
  discover,
  emailVerified,
  forgetDiscovery,
  idpAssertsMfa,
  jwksLookup,
  s256,
  verifyIdToken,
} from '../lib/oidc';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { mailer } from '../lib/mail';
import { apiVault, credentialOf } from '../lib/vault';
import { ssoRefusedMail } from '../lib/security-mail';
import {
  createSession,
  emailSignInRequired,
  forgetCapturedSessions,
  revokeConnectionSessions,
} from '../lib/session';
import { noticeTeam } from '../lib/team-notice';
import { recordAccountEvent } from '../lib/account-events';

export const sso = createRouter();

const FLAG = 'Needs the sso flag at platform scope (feature_disabled otherwise).';

const requireSsoFlag: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await ssoEnabled(c))) {
    throw new ApiError('feature_disabled', 'Single sign-on is not turned on for this Swarm.');
  }
  await next();
};

// After routePolicy (signed out 401, other workspace 404, low role 403), before input validation,
// so a request with bad input is refused the same way. Paths, because a sub-router's `use('*')`
// would reach every route mounted after it; tests/sso-flag.test.ts covers each one in the document.
sso.use('/api/v1/workspaces/:workspaceId/sso-connections', requireSsoFlag);
sso.use('/api/v1/sso-connections/*', requireSsoFlag);
sso.use('/api/v1/auth/sso/*', requireSsoFlag);

const STATE_COOKIE = '__Host-swarm_sso';
const STATE_PURPOSE = 'sso-state';
const MAX_CONNECTIONS = 5;

const workspaceParam = idParam('workspaceId', idPattern('workspace'));
const connectionParam = idParam('connectionId', idPattern('ssoConnection'));
const domainParams = connectionParam.extend(idParam('domainId', idPattern('ssoDomain')).shape);

interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecretEnc: string;
}

interface ConnectionRow {
  id: string;
  workspace_id: string;
  protocol: 'oidc' | 'saml';
  domains_json: string;
  config_json: string;
  jit_role: Exclude<SeatRole, 'owner'> | null;
  enforced: number;
  status: 'draft' | 'active' | 'disabled';
  created_at: number;
  updated_at: number;
}

interface DomainRow {
  id: string;
  connection_id: string;
  workspace_id: string;
  domain: string;
  verification_token: string;
  verified_at: number | null;
  created_at: number;
  checked_at: number | null;
  failing_since: number | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const redirectUri = (e: ApiEnv) => `${e.APP_ORIGIN}/api/v1/auth/sso/callback`;
const config = (row: ConnectionRow) => JSON.parse(row.config_json) as OidcConfig;

const toDomain = (row: DomainRow): SsoDomain => ({
  id: row.id,
  domain: row.domain,
  verified: row.verified_at !== null,
  verifiedAt: row.verified_at === null ? null : toIso(row.verified_at),
  txtName: `${SSO_TXT_PREFIX}.${row.domain}`,
  txtValue: `${SSO_TXT_VALUE_PREFIX}${row.verification_token}`,
});

function toConnection(e: ApiEnv, row: ConnectionRow, domains: DomainRow[]): SsoConnection {
  const cfg = config(row);
  return {
    id: row.id,
    protocol: row.protocol,
    issuer: cfg.issuer,
    clientId: cfg.clientId,
    clientSecretSet: !!cfg.clientSecretEnc,
    domains: domains.filter((d) => d.connection_id === row.id).map(toDomain),
    jitRole: row.jit_role,
    enforced: row.enforced === 1,
    status: row.status,
    redirectUri: redirectUri(e),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** TXT lookups. Locally (DNS_RESOLVER=dev) records come from KV `dev:txt:<name>`, a JSON array. */
const ssoResolver = (e: ApiEnv): TxtResolver => ssoTxtResolver(e);

async function workspacePlan(e: ApiEnv, workspaceId: string): Promise<Plan> {
  const row = await first<{ plan: Plan }>(
    e.DB,
    'SELECT plan FROM workspaces WHERE id = ?1',
    workspaceId,
  );
  return row?.plan ?? 'free';
}

async function requireSsoPlan(e: ApiEnv, workspaceId: string): Promise<void> {
  if (!PLAN_LIMITS[await workspacePlan(e, workspaceId)].sso) {
    throw new ApiError('plan_required', 'Single sign-on is part of the Pro plan and up.');
  }
}

/** The worker fetches the issuer, so it passes the same check as any outbound URL. */
function checkIssuer(e: ApiEnv, issuer: string): void {
  if (outboundUrlProblem(issuer, { allowHttp: isLocal(e) })) {
    const message = 'The issuer must be an https URL on a public host name.';
    throw new ApiError('invalid_input', message, [{ path: 'issuer', message }]);
  }
}

/** Only owners hand out admin seats, as with invites. */
function checkJitRole(role: SeatRole, jitRole: string | null | undefined): void {
  if (jitRole === 'admin' && role !== 'owner') {
    throw new ApiError('forbidden', 'Only owners can give new teammates the admin role.');
  }
}

/** The connection and the caller's seat, or 404 for anyone without an admin-visible seat. */
async function connectionAccess(c: AppContext, connectionId: string) {
  const e = env(c);
  const row = await first<ConnectionRow>(
    e.DB,
    'SELECT * FROM sso_connections WHERE id = ?1',
    connectionId,
  );
  if (!row) throw new ApiError('not_found', 'Connection not found.');
  const access = await requireWorkspace(c, row.workspace_id, 'admin');
  return { row, access };
}

async function domainsOf(e: ApiEnv, connectionIds: string[]): Promise<DomainRow[]> {
  if (!connectionIds.length) return [];
  return all<DomainRow>(
    e.DB,
    `SELECT * FROM sso_domains WHERE connection_id IN (SELECT value FROM json_each(?1))
      ORDER BY created_at`,
    JSON.stringify(connectionIds),
  );
}

async function respond(e: ApiEnv, connectionId: string) {
  const row = await first<ConnectionRow>(
    e.DB,
    'SELECT * FROM sso_connections WHERE id = ?1',
    connectionId,
  );
  if (!row) throw new ApiError('not_found', 'Connection not found.');
  return toConnection(e, row, await domainsOf(e, [row.id]));
}

/** Keeps sso_connections.domains_json equal to the verified domain names. */
const syncDomains = (e: ApiEnv, connectionId: string) => syncSsoDomains(e.DB, connectionId);

async function audit(
  c: AppContext,
  workspaceId: string,
  operatorId: string,
  action: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
) {
  await appendAudit(env(c).DB, {
    workspaceId,
    actorId: operatorId,
    action,
    targetType: 'sso_connection',
    targetId,
    metadata,
    ipPrefix: ipPrefix(clientIp(c)),
  });
}

/**
 * Records the proven domains a workspace gives up (deleting a connection or removing a domain from
 * it) with the provider they vouched for, and tells the other owners: re-proving one of them for
 * a different provider soon after needs an owner (checkReleasedDomain).
 */
async function releaseDomains(
  c: AppContext,
  row: ConnectionRow,
  domains: string[],
  operatorId: string,
  what: string,
): Promise<void> {
  if (!domains.length) return;
  const e = env(c);
  const cfg = config(row);
  const now = Date.now();
  await batch(
    e.DB,
    domains.map((domain) =>
      e.DB.prepare(
        `INSERT INTO sso_released_domains (workspace_id, domain, issuer, client_id, released_at, released_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(row.workspace_id, domain, cfg.issuer, cfg.clientId, now, operatorId),
    ),
  );
  await noticeTeam(
    e,
    c.get('log'),
    row.workspace_id,
    ['owner'],
    {
      category: 'sso_provider_changed',
      subject: 'Single sign-on was changed in your workspace',
      heading: 'Single sign-on changed',
      lines: [
        `A teammate ${what}. These domains no longer sign anyone in through ${cfg.issuer}: ${domains.join(', ')}.`,
        `For the next ${SSO_RELEASED_DOMAIN_DAYS} days only an owner can prove them again for a different identity provider. If you did not expect this, review the workspace's single sign-on and its audit log.`,
      ],
      path: '/settings/security',
      label: 'Review single sign-on',
    },
    operatorId,
  );
}

/**
 * Proving a domain this workspace released recently, for a provider other than the one it was
 * proven for, is a change of provider, which only owners may make (the PATCH repoint rule).
 * Returns true when that applies, so the caller can tell the owners once it succeeds.
 */
async function checkReleasedDomain(
  e: ApiEnv,
  row: ConnectionRow,
  domain: string,
  role: SeatRole,
): Promise<boolean> {
  const cfg = config(row);
  const released = await first(
    e.DB,
    `SELECT 1 FROM sso_released_domains
      WHERE workspace_id = ?1 AND domain = ?2 AND released_at > ?3
        AND (issuer <> ?4 OR client_id <> ?5)
      LIMIT 1`,
    row.workspace_id,
    domain,
    Date.now() - SSO_RELEASED_DOMAIN_DAYS * DAY_MS,
    cfg.issuer,
    cfg.clientId,
  );
  if (!released) return false;
  if (role !== 'owner') {
    throw new ApiError(
      'forbidden',
      'This workspace proved this domain for another identity provider recently. Only owners can prove it for a new one.',
    );
  }
  return true;
}

const failing = async (e: ApiEnv, domainId: string) =>
  !!(await first(
    e.DB,
    'SELECT 1 FROM sso_domains WHERE id = ?1 AND failing_since IS NOT NULL',
    domainId,
  ));

/**
 * Looks up a verified domain's TXT record again (engine sso-domains.ts, which the jobs worker
 * also runs every day). Returns whether the proof still stands.
 */
async function reproveDomain(c: AppContext, domain: DomainRow, now = Date.now()): Promise<boolean> {
  const e = env(c);
  return reproveSsoDomain(
    {
      db: e.DB,
      resolver: ssoResolver(e),
      log: c.get('log'),
      warn: async (failing) => {
        const notice = ssoDomainFailingNotice(failing.domain);
        await noticeTeam(e, c.get('log'), failing.workspace_id, ['owner', 'admin'], {
          category: 'sso_domain_failing',
          subject: notice.subject,
          heading: 'Domain proof missing',
          lines: notice.lines,
          path: '/settings/security',
          label: 'Open single sign-on',
        });
      },
    },
    domain,
    now,
  );
}

// ---------------------------------------------------------------------------------------------
// Connections

sso.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/sso-connections',
    tags: ['SSO'],
    summary: 'SSO connections of a workspace',
    description: FLAG,
    request: { params: workspaceParam },
    responses: {
      200: ok(z.array(SsoConnectionSchema), 'Connections'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = await requireWorkspace(c, c.req.valid('param').workspaceId, 'admin');
    const e = env(c);
    const rows = await all<ConnectionRow>(
      e.DB,
      'SELECT * FROM sso_connections WHERE workspace_id = ?1 ORDER BY created_at',
      workspaceId,
    );
    const domains = await domainsOf(
      e,
      rows.map((row) => row.id),
    );
    return c.json({ data: rows.map((row) => toConnection(e, row, domains)) }, 200);
  },
);

sso.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/sso-connections',
    tags: ['SSO'],
    summary: 'Add an SSO connection',
    description: `${FLAG} Pro and up (plan_required otherwise). OpenID Connect only: 'saml' is refused with not_implemented (docs/security.md). The client secret is sealed by the vault and never returned. A connection starts as a draft; verify a domain, then activate it.`,
    request: { params: workspaceParam, body: jsonBody(CreateSsoConnectionSchema) },
    responses: {
      201: ok(SsoConnectionSchema, 'Connection added'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId, role, auth } = await requireWorkspace(
      c,
      c.req.valid('param').workspaceId,
      'admin',
    );
    const e = env(c);
    const input = c.req.valid('json');
    await requireSsoPlan(e, workspaceId);
    if (input.protocol === 'saml') {
      throw new ApiError(
        'not_implemented',
        'SAML connections are not available yet. Use OpenID Connect, which most identity providers support.',
      );
    }
    checkIssuer(e, input.issuer);
    checkJitRole(role, input.jitRole);
    const count = await first<{ n: number }>(
      e.DB,
      'SELECT COUNT(*) AS n FROM sso_connections WHERE workspace_id = ?1',
      workspaceId,
    );
    if ((count?.n ?? 0) >= MAX_CONNECTIONS) {
      throw new ApiError('conflict', `A workspace can have up to ${MAX_CONNECTIONS} connections.`);
    }
    const id = newId('ssoConnection');
    const now = Date.now();
    const cfg: OidcConfig = {
      issuer: input.issuer,
      clientId: input.clientId,
      clientSecretEnc: await sealClientSecret(c, workspaceId, id, input.clientSecret),
    };
    await run(
      e.DB,
      `INSERT INTO sso_connections (id, workspace_id, protocol, domains_json, config_json, jit_role,
                                    enforced, status, created_at, updated_at)
       VALUES (?1, ?2, 'oidc', '[]', ?3, ?4, 0, 'draft', ?5, ?5)`,
      id,
      workspaceId,
      JSON.stringify(cfg),
      input.jitRole,
      now,
    );
    await audit(c, workspaceId, auth.operatorId, 'sso.connection_created', id, {
      issuer: input.issuer,
    });
    return c.json({ data: await respond(e, id) }, 201);
  },
);

sso.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/sso-connections/{connectionId}',
    tags: ['SSO'],
    summary: 'Change or activate an SSO connection',
    description: `${FLAG} Activating needs the plan, at least one verified domain and a discovery document whose issuer matches. Changing \`issuer\` or \`clientId\` needs the owner once a domain is verified or anyone has signed in through the connection (forbidden otherwise). It makes every domain prove itself again with a new TXT token, puts the connection back in draft, and unlinks everyone who signed in through the old provider. \`enforced\` keeps people of the captured domains from entering this workspace with QuickPass or Google (owners can always).`,
    request: { params: connectionParam, body: jsonBody(UpdateSsoConnectionSchema) },
    responses: {
      200: ok(SsoConnectionSchema, 'Connection changed'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { row, access } = await connectionAccess(c, c.req.valid('param').connectionId);
    const e = env(c);
    const input = c.req.valid('json');
    checkJitRole(access.role, input.jitRole);
    const cfg = config(row);
    const repointed =
      (input.issuer !== undefined && input.issuer !== cfg.issuer) ||
      (input.clientId !== undefined && input.clientId !== cfg.clientId);
    if (repointed) {
      const proven = await first(
        e.DB,
        'SELECT 1 FROM sso_domains WHERE connection_id = ?1 AND verified_at IS NOT NULL',
        row.id,
      );
      // Also once anyone signed in through it: releasing every domain first must not hand an
      // admin the choice of provider for the people it already signed in.
      const linked = await first(
        e.DB,
        "SELECT 1 FROM oauth_identities WHERE provider = 'sso' AND sso_connection_id = ?1",
        row.id,
      );
      // The provider signs in every captured address, owners included, so an admin can't pick it.
      if ((proven || linked) && access.role !== 'owner') {
        throw new ApiError(
          'forbidden',
          'Only owners can change the identity provider of a connection people sign in with.',
        );
      }
      if (input.status === 'active') {
        throw new ApiError(
          'conflict',
          'Verify the domains again for the new identity provider, then activate.',
        );
      }
    }
    if (input.issuer !== undefined) {
      checkIssuer(e, input.issuer);
      await forgetDiscovery(e, cfg.issuer);
      cfg.issuer = input.issuer;
    }
    if (input.clientId !== undefined) cfg.clientId = input.clientId;
    if (input.clientSecret !== undefined) {
      cfg.clientSecretEnc = await sealClientSecret(c, row.workspace_id, row.id, input.clientSecret);
    }
    let status = input.status ?? row.status;
    // A new provider goes back to draft: the domain proofs vouched for the old one.
    if (repointed && status === 'active') status = 'draft';
    if (status === 'active') {
      await requireSsoPlan(e, row.workspace_id);
      const verified = await first(
        e.DB,
        'SELECT 1 FROM sso_domains WHERE connection_id = ?1 AND verified_at IS NOT NULL',
        row.id,
      );
      if (!verified) throw new ApiError('conflict', 'Verify at least one domain first.');
      if (!(await discover(e, cfg.issuer))) {
        throw new ApiError(
          'invalid_input',
          'The issuer did not answer with a valid OpenID configuration.',
          [{ path: 'issuer', message: 'No valid OpenID configuration at this issuer.' }],
        );
      }
    }
    const statements = [
      e.DB.prepare(
        `UPDATE sso_connections SET config_json = ?1, jit_role = ?2, enforced = ?3, status = ?4,
                updated_at = ?5 WHERE id = ?6`,
      ).bind(
        JSON.stringify(cfg),
        input.jitRole === undefined ? row.jit_role : input.jitRole,
        input.enforced === undefined ? row.enforced : input.enforced ? 1 : 0,
        status,
        Date.now(),
        row.id,
      ),
    ];
    if (repointed) {
      // Fresh tokens, so a TXT record still published for the old provider can't prove the
      // domains for the new one: someone who controls DNS has to publish the new value. In the
      // same batch, so the new provider is never stored next to the old proofs.
      const domains = await all<{ id: string }>(
        e.DB,
        'SELECT id FROM sso_domains WHERE connection_id = ?1',
        row.id,
      );
      for (const d of domains) {
        statements.push(
          e.DB.prepare(
            'UPDATE sso_domains SET verified_at = NULL, verification_token = ?1 WHERE id = ?2',
          ).bind(randomToken(18), d.id),
        );
      }
      statements.push(
        e.DB.prepare("UPDATE sso_connections SET domains_json = '[]' WHERE id = ?1").bind(row.id),
        // A subject is only unique at the provider that issued it: the new one's `sub` for
        // someone else must never resolve to an operator the old one signed in.
        e.DB.prepare(
          "DELETE FROM oauth_identities WHERE provider = 'sso' AND sso_connection_id = ?1",
        ).bind(row.id),
      );
    }
    await batch(e.DB, statements);
    // Trust in the provider is withdrawn: sessions it signed in end, and sign in again.
    const sessionsEnded =
      repointed || (row.status === 'active' && status !== 'active')
        ? await revokeConnectionSessions(e, row.id)
        : 0;
    // Enforcement is part of the cached session facts: a change applies on the next request.
    if (
      status !== row.status ||
      (input.enforced !== undefined && input.enforced !== !!row.enforced)
    ) {
      await forgetCapturedSessions(e, row.id);
    }
    await audit(c, row.workspace_id, access.auth.operatorId, 'sso.connection_updated', row.id, {
      // Field names only: values (and certainly the secret) stay out of the log.
      changed: Object.keys(input),
      ...(input.status ? { status: input.status } : {}),
      ...(input.enforced !== undefined ? { enforced: input.enforced } : {}),
      ...(sessionsEnded ? { sessionsEnded } : {}),
    });
    return c.json({ data: await respond(e, row.id) }, 200);
  },
);

sso.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/sso-connections/{connectionId}',
    tags: ['SSO'],
    summary: 'Remove an SSO connection',
    description: `${FLAG} Releases its domains and ends every session signed in through it. Teammates keep their seats and can sign in another way. Owners are emailed; for ${SSO_RELEASED_DOMAIN_DAYS} days only an owner can prove its domains again for a different provider.`,
    request: { params: connectionParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { row, access } = await connectionAccess(c, c.req.valid('param').connectionId);
    const e = env(c);
    const proven = await all<{ domain: string }>(
      e.DB,
      'SELECT domain FROM sso_domains WHERE connection_id = ?1 AND verified_at IS NOT NULL',
      row.id,
    );
    // Before the row goes: sessions reference it, and the reference is cleared on delete.
    const sessionsEnded = await revokeConnectionSessions(e, row.id);
    await run(e.DB, 'DELETE FROM sso_connections WHERE id = ?1', row.id);
    await audit(c, row.workspace_id, access.auth.operatorId, 'sso.connection_deleted', row.id, {
      domains: proven.map((d) => d.domain),
      sessionsEnded,
    });
    await releaseDomains(
      c,
      row,
      proven.map((d) => d.domain),
      access.auth.operatorId,
      'removed a single sign-on connection',
    );
    return c.body(null, 204);
  },
);

// ---------------------------------------------------------------------------------------------
// Domains

sso.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/sso-connections/{connectionId}/domains',
    tags: ['SSO'],
    summary: 'Claim an email domain',
    description: `${FLAG} Returns the TXT record to publish. The claim captures nothing until it is verified.`,
    request: { params: connectionParam, body: jsonBody(AddSsoDomainSchema) },
    responses: {
      201: ok(SsoDomainSchema, 'Domain claimed'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { row } = await connectionAccess(c, c.req.valid('param').connectionId);
    const e = env(c);
    const { domain } = c.req.valid('json');
    const count = await first<{ n: number }>(
      e.DB,
      'SELECT COUNT(*) AS n FROM sso_domains WHERE connection_id = ?1',
      row.id,
    );
    if ((count?.n ?? 0) >= SSO_MAX_DOMAINS) {
      throw new ApiError('conflict', `A connection can claim up to ${SSO_MAX_DOMAINS} domains.`);
    }
    const id = newId('ssoDomain');
    try {
      await run(
        e.DB,
        `INSERT INTO sso_domains (id, connection_id, workspace_id, domain, verification_token, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        id,
        row.id,
        row.workspace_id,
        domain,
        randomToken(18),
        Date.now(),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError('conflict', 'This connection already claims that domain.');
      }
      throw error;
    }
    const created = await first<DomainRow>(e.DB, 'SELECT * FROM sso_domains WHERE id = ?1', id);
    return c.json({ data: toDomain(created as DomainRow) }, 201);
  },
);

sso.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/sso-connections/{connectionId}/domains/{domainId}/verify',
    tags: ['SSO'],
    summary: 'Check the TXT record of a claimed domain',
    description: `${FLAG} Answers with \`verified: false\` while the record is not visible yet. A domain can be verified for one connection on the whole platform (conflict otherwise).`,
    request: { params: domainParams },
    responses: {
      200: ok(SsoDomainSchema, 'Domain checked'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const params = c.req.valid('param');
    const { row, access } = await connectionAccess(c, params.connectionId);
    const e = env(c);
    const domain = await first<DomainRow>(
      e.DB,
      'SELECT * FROM sso_domains WHERE id = ?1 AND connection_id = ?2',
      params.domainId,
      row.id,
    );
    if (!domain) throw new ApiError('not_found', 'Domain not found.');
    if (domain.verified_at !== null) return c.json({ data: toDomain(domain) }, 200);
    const newProvider = await checkReleasedDomain(e, row, domain.domain, access.role);

    const expected = `${SSO_TXT_VALUE_PREFIX}${domain.verification_token}`;
    let records: string[] = [];
    try {
      records = await ssoResolver(e).txt(`${SSO_TXT_PREFIX}.${domain.domain}`);
    } catch (error) {
      c.get('log').warn('sso txt lookup failed', { error: (error as Error).message });
    }
    if (!records.some((record) => record.trim() === expected)) {
      return c.json({ data: toDomain(domain) }, 200);
    }
    const now = Date.now();
    const markVerified = () =>
      run(
        e.DB,
        'UPDATE sso_domains SET verified_at = ?1, checked_at = ?1, failing_since = NULL WHERE id = ?2',
        now,
        domain.id,
      );
    try {
      await markVerified();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Someone holds the proof. It stands only while their record does: look again, and once
      // it has been missing for SSO_DOMAIN_LAPSE_DAYS it lapses and this proof takes its place.
      const holder = await first<DomainRow>(
        e.DB,
        'SELECT * FROM sso_domains WHERE domain = ?1 AND verified_at IS NOT NULL',
        domain.domain,
      );
      if (holder && !(await reproveDomain(c, holder, now))) {
        await markVerified();
      } else {
        throw new ApiError(
          'conflict',
          holder && (await failing(e, holder.id))
            ? `Another workspace verified this domain, but its record is missing. If it stays missing for ${SSO_DOMAIN_LAPSE_DAYS} days, verify again to take it over.`
            : 'Another workspace already verified this domain for its single sign-on.',
        );
      }
    }
    await syncDomains(e, row.id);
    await audit(c, row.workspace_id, access.auth.operatorId, 'sso.domain_verified', row.id, {
      domain: domain.domain,
      ...(newProvider ? { newProvider: config(row).issuer } : {}),
    });
    if (newProvider) {
      await noticeTeam(
        e,
        c.get('log'),
        row.workspace_id,
        ['owner'],
        {
          category: 'sso_provider_changed',
          subject: 'Single sign-on now uses a different identity provider',
          heading: 'New identity provider',
          lines: [
            `An owner proved ${domain.domain} for the identity provider ${config(row).issuer}. Once the connection is active, it signs in everyone with an address on ${domain.domain} who has a seat in the workspace.`,
          ],
          path: '/settings/security',
          label: 'Review single sign-on',
        },
        access.auth.operatorId,
      );
    }
    return c.json({ data: toDomain({ ...domain, verified_at: now, checked_at: now }) }, 200);
  },
);

sso.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/sso-connections/{connectionId}/domains/{domainId}',
    tags: ['SSO'],
    summary: 'Release a domain',
    description: FLAG,
    request: { params: domainParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const params = c.req.valid('param');
    const { row, access } = await connectionAccess(c, params.connectionId);
    const e = env(c);
    const removed = await first<{ domain: string; verified_at: number | null }>(
      e.DB,
      'DELETE FROM sso_domains WHERE id = ?1 AND connection_id = ?2 RETURNING domain, verified_at',
      params.domainId,
      row.id,
    );
    if (!removed) throw new ApiError('not_found', 'Domain not found.');
    await syncDomains(e, row.id);
    await audit(c, row.workspace_id, access.auth.operatorId, 'sso.domain_removed', row.id, {
      domain: removed.domain,
    });
    if (removed.verified_at !== null) {
      await releaseDomains(
        c,
        row,
        [removed.domain],
        access.auth.operatorId,
        'removed a proven domain from single sign-on',
      );
    }
    return c.body(null, 204);
  },
);

// ---------------------------------------------------------------------------------------------
// Sign-in

interface SsoState {
  state: string;
  nonce: string;
  verifier: string;
  connectionId: string;
  returnTo: string;
}

const returnPath = z
  .string()
  .regex(/^\/(?!\/)[^\s]*$/)
  .max(512)
  .optional();

/** The active OIDC connection that captures an email's domain, if its plan still allows SSO. */
async function connectionForEmail(e: ApiEnv, email: string): Promise<ConnectionRow | null> {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;
  const row = await first<ConnectionRow>(
    e.DB,
    `SELECT c.* FROM sso_domains d JOIN sso_connections c ON c.id = d.connection_id
      WHERE d.domain = ?1 AND d.verified_at IS NOT NULL AND c.status = 'active'`,
    domain,
  );
  if (!row || row.protocol !== 'oidc') return null;
  return PLAN_LIMITS[await workspacePlan(e, row.workspace_id)].sso ? row : null;
}

const StartSchema = z.object({ email: z.email().max(254), return: returnPath });

const signInError = (c: AppContext, reason: string) =>
  c.redirect(`${env(c).APP_ORIGIN}/sign-in?error=${reason}`, 302);

/**
 * Sets the state cookie and returns the identity provider's authorization URL, or the sign-in
 * error to go back with. The caller has already checked that the dashboard asked for it.
 */
async function beginSignIn(
  c: AppContext,
  input: z.infer<typeof StartSchema>,
): Promise<{ url: string } | { error: string }> {
  const e = env(c);
  const connection = await connectionForEmail(e, input.email);
  if (!connection) return { error: 'sso_unknown' };
  const cfg = config(connection);
  const discovery = await discover(e, cfg.issuer);
  if (!discovery) return { error: 'sso_unavailable' };

  const state: SsoState = {
    state: randomToken(24),
    nonce: randomToken(24),
    verifier: randomToken(48),
    connectionId: connection.id,
    returnTo: input.return ?? '/',
  };
  setCookie(
    c,
    STATE_COOKIE,
    await signToken(e.AUTH_KEYS, STATE_PURPOSE, { ...state }, { expiresInSeconds: 600 }),
    { path: '/', secure: true, httpOnly: true, sameSite: 'Lax', maxAge: 600 },
  );
  const url = new URL(discovery.authorization_endpoint);
  for (const [key, value] of Object.entries({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(e),
    response_type: 'code',
    scope: 'openid email profile',
    state: state.state,
    nonce: state.nonce,
    code_challenge: await s256(state.verifier),
    code_challenge_method: 'S256',
    login_hint: input.email,
  })) {
    url.searchParams.set(key, value);
  }
  return { url: url.toString() };
}

/**
 * A page that sends the browser on to the identity provider. The form post's own answer can't be
 * a redirect there: browsers apply the dashboard's `form-action 'self'` to redirects after a post.
 */
function handoffPage(url: string): string {
  const href = escapeHtml(url);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="refresh" content="0;url=${href}"><title>Signing you in</title></head>
<body style="margin:0;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;color:#0f0f12;background:#fbfbfd">
<main style="max-width:480px;margin:64px auto;padding:0 16px">
<p style="font-size:15px;line-height:1.55">Taking you to your company's sign-in page. <a href="${href}">Continue</a></p>
</main></body></html>`;
}

sso.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/auth/sso/start',
    tags: ['Auth'],
    summary: 'Start SSO sign-in',
    description: `${FLAG} Finds the active connection that captures the address's domain and redirects to its identity provider (authorization code with PKCE, state and nonce). Sets only a signed, short-lived state cookie; nothing is stored. Only the dashboard can start it: the request needs \`Origin\` equal to the dashboard's, or no Origin and \`Sec-Fetch-Site: same-origin\` (otherwise back to sign-in with \`sso_start\`). The dashboard itself uses the POST, which works in browsers that send no Sec-Fetch-Site.`,
    request: { query: StartSchema },
    responses: {
      302: { description: 'Redirect to the identity provider' },
      ...errors('feature_disabled'),
    },
  }),
  async (c) => {
    // Only the dashboard starts a sign-in. The state cookie is the callback's only tie to the
    // browser, so a start any site could trigger would let it sign a visitor into a connection
    // of its choosing (login CSRF). A GET navigation carries no Origin, hence Sec-Fetch-Site.
    const origin = c.req.header('origin');
    const fromApp = origin
      ? origin === env(c).APP_ORIGIN
      : c.req.header('sec-fetch-site') === 'same-origin';
    if (!fromApp) return signInError(c, 'sso_start');
    const started = await beginSignIn(c, c.req.valid('query'));
    if ('error' in started) return signInError(c, started.error);
    return c.redirect(started.url, 302);
  },
);

sso.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/auth/sso/start',
    tags: ['Auth'],
    summary: 'Start SSO sign-in from the dashboard',
    description: `${FLAG} The GET start as a form post, which is how the dashboard starts it. Needs \`Origin\` equal to the dashboard's, which browsers send on every form post (otherwise back to sign-in with \`sso_start\`). Sets the state cookie and answers with a page that goes on to the identity provider at once.`,
    request: {
      body: {
        required: true,
        content: { 'application/x-www-form-urlencoded': { schema: StartSchema } },
      },
    },
    responses: {
      200: {
        description: 'A page that goes on to the identity provider',
        content: { 'text/html': { schema: z.string() } },
      },
      302: { description: 'Back to sign-in with an error' },
      ...errors('feature_disabled', 'invalid_input'),
    },
  }),
  async (c) => {
    // The same login CSRF guard as the GET. Unlike a GET navigation, a form post always carries
    // Origin, even in browsers without Sec-Fetch-Site, so nothing else stands in for it here.
    if (c.req.header('origin') !== env(c).APP_ORIGIN) return signInError(c, 'sso_start');
    const started = await beginSignIn(c, c.req.valid('form'));
    if ('error' in started) return signInError(c, started.error);
    return c.html(handoffPage(started.url), 200, {
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
  },
);

/** A connection's client secret, sealed by the vault for that connection (admin, checked there). */
async function sealClientSecret(
  c: AppContext,
  workspaceId: string,
  connectionId: string,
  clientSecret: string,
): Promise<string> {
  return vaultValue(
    await apiVault(c).sealSsoSecret(credentialOf(c), { workspaceId, connectionId, clientSecret }),
  );
}

/**
 * The operator a verified address of a captured domain signs in as, or why nobody signs in.
 *
 * A provider speaks only for its connection's workspace: it signs in an operator who holds a seat
 * there, or someone new to this Swarm (or with no seat anywhere) when the connection gives seats
 * just in time. An operator seated only in other workspaces is refused, even with a matching
 * address: the provider can't take over an account it has no relationship with. Their admin
 * invites them first; accepting needs a sign-in of the operator's own.
 */
async function provision(
  e: ApiEnv,
  connection: ConnectionRow,
  subject: string,
  email: string,
  ip: string | null,
): Promise<{ operatorId: string } | { refused: 'no_seat' | 'not_member' }> {
  const now = Date.now();
  const link = await first<{ id: string; operator_id: string; email: string }>(
    e.DB,
    `SELECT id, operator_id, email FROM oauth_identities
      WHERE provider = 'sso' AND sso_connection_id = ?1 AND subject = ?2`,
    connection.id,
    subject,
  );
  let operatorId: string | null = null;
  if (link) {
    // A link vouches only while the domain it was made on is still proven for this connection;
    // otherwise drop it and match by the address, which the callback checked is captured.
    const linkProven = await first(
      e.DB,
      'SELECT 1 FROM sso_domains WHERE connection_id = ?1 AND domain = ?2 AND verified_at IS NOT NULL',
      connection.id,
      link.email.split('@')[1]?.toLowerCase() ?? '',
    );
    if (linkProven) operatorId = link.operator_id;
    else await run(e.DB, 'DELETE FROM oauth_identities WHERE id = ?1', link.id);
  }

  const linked = operatorId !== null;
  if (!operatorId) {
    operatorId =
      (await first<{ id: string }>(e.DB, 'SELECT id FROM operators WHERE email = ?1', email))?.id ??
      null;
    if (!operatorId) {
      if (!connection.jit_role) return { refused: 'no_seat' };
      operatorId = newId('operator');
      try {
        await run(
          e.DB,
          'INSERT INTO operators (id, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
          operatorId,
          email,
          now,
        );
      } catch (error) {
        // A concurrent sign-in for the same address won the race; use theirs.
        const raced = await first<{ id: string }>(
          e.DB,
          'SELECT id FROM operators WHERE email = ?1',
          email,
        );
        if (!raced) throw error;
        operatorId = raced.id;
      }
    }
  }

  const seats = await first<{ here: number; anywhere: number }>(
    e.DB,
    `SELECT EXISTS (SELECT 1 FROM seats WHERE workspace_id = ?1 AND operator_id = ?2) AS here,
            EXISTS (SELECT 1 FROM seats WHERE operator_id = ?2) AS anywhere`,
    connection.workspace_id,
    operatorId,
  );
  if (!seats?.here) {
    // Seated elsewhere and not here: this provider has no say over that account.
    if (seats?.anywhere) return { refused: 'not_member' };
    if (!connection.jit_role) return { refused: 'no_seat' };
    try {
      await run(
        e.DB,
        `INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
        newId('seat'),
        connection.workspace_id,
        operatorId,
        connection.jit_role,
        now,
      );
      await appendAudit(e.DB, {
        workspaceId: connection.workspace_id,
        actorId: operatorId,
        action: 'seat.provisioned',
        targetType: 'operator',
        targetId: operatorId,
        metadata: { via: 'sso', connectionId: connection.id, role: connection.jit_role },
        ipPrefix: ip,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  if (!linked) {
    try {
      await run(
        e.DB,
        `INSERT INTO oauth_identities (id, provider, subject, operator_id, email, email_verified,
                                       sso_connection_id, created_at)
         VALUES (?1, 'sso', ?2, ?3, ?4, 1, ?5, ?6)`,
        newId('oauthIdentity'),
        subject,
        operatorId,
        email,
        connection.id,
        now,
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return { operatorId };
}

/**
 * A sign-in the connection's provider asked for but this Swarm refused, because the address
 * belongs to an operator seated only in other workspaces: audited to the connection's workspace
 * and mailed to the operator, so neither side misses an attempt to use the provider that way.
 */
async function refusedSignIn(
  c: AppContext,
  connection: ConnectionRow,
  email: string,
  ip: string | null,
): Promise<void> {
  const e = env(c);
  await appendAudit(e.DB, {
    workspaceId: connection.workspace_id,
    actorId: null,
    action: 'sso.sign_in_refused',
    targetType: 'sso_connection',
    targetId: connection.id,
    metadata: { email, reason: 'not_a_member' },
    ipPrefix: ip,
  });
  const workspace = await first<{ name: string }>(
    e.DB,
    'SELECT name FROM workspaces WHERE id = ?1',
    connection.workspace_id,
  );
  try {
    await mailer(e).send(
      ssoRefusedMail(e, email, { workspaceName: workspace?.name ?? 'A workspace', at: Date.now() }),
    );
  } catch (error) {
    c.get('log').warn('sso refused mail failed', { error: (error as Error).message });
  }
}

sso.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/auth/sso/callback',
    tags: ['Auth'],
    summary: 'Finish SSO sign-in',
    description: `${FLAG} Checks the browser-bound state, exchanges the code with the PKCE verifier, verifies the ID token against the issuer's JWKS (issuer, audience, expiry, nonce), and requires email_verified for an address of a domain the connection captured. The sign-in counts as the second factor only when the identity provider asserts MFA (amr "mfa" or the PAPE multi-factor acr).`,
    request: {
      query: z.object({
        code: z.string().max(4096).optional(),
        state: z.string().max(200).optional(),
        error: z.string().max(200).optional(),
      }),
    },
    responses: {
      302: { description: 'Redirect into the dashboard' },
      ...errors('feature_disabled'),
    },
  }),
  async (c) => {
    const e = env(c);
    const fail = (reason: string) => c.redirect(`${e.APP_ORIGIN}/sign-in?error=${reason}`, 302);
    const query = c.req.valid('query');
    const cookie = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
    if (!cookie || query.error || !query.code || !query.state) return fail('sso_cancelled');
    const verified = await verifyToken<SsoState>(e.AUTH_KEYS, STATE_PURPOSE, cookie);
    if (!verified.ok || verified.payload.state !== query.state) return fail('sso_state');
    const state = verified.payload;

    const connection = await first<ConnectionRow>(
      e.DB,
      "SELECT * FROM sso_connections WHERE id = ?1 AND status = 'active' AND protocol = 'oidc'",
      state.connectionId,
    );
    if (!connection || !PLAN_LIMITS[await workspacePlan(e, connection.workspace_id)].sso) {
      return fail('sso_unavailable');
    }
    const cfg = config(connection);
    const discovery = await discover(e, cfg.issuer);
    if (!discovery) return fail('sso_unavailable');

    // The code is exchanged by the vault, which alone opens the connection's client secret.
    const exchanged = await apiVault(c).ssoTokenExchange({
      connectionId: connection.id,
      code: query.code,
      codeVerifier: state.verifier,
      redirectUri: redirectUri(e),
    });
    if (!exchanged.ok) {
      return fail(exchanged.reason === 'refused' ? 'sso_exchange' : 'sso_unavailable');
    }
    const answer = exchanged.value;
    const token =
      answer.status >= 200 && answer.status < 300
        ? (answer.json as { id_token?: unknown } | null)?.id_token
        : undefined;
    const idToken = typeof token === 'string' ? token : null;
    if (!idToken) return fail('sso_exchange');
    const claims = await verifyIdToken(idToken, {
      // Keyed by issuer and JWKS URL as well, so after the issuer changes the keys cached for
      // the old one are never used to verify a token.
      keys: jwksLookup(
        e,
        `oidc:jwks:${connection.id}:${await sha256Hex(`${cfg.issuer}\n${discovery.jwks_uri}`)}`,
        discovery.jwks_uri,
      ),
      issuers: new Set([cfg.issuer]),
      audience: cfg.clientId,
    });
    if (!claims || claims.nonce !== state.nonce) return fail('sso_token');
    if (!claims.email || !emailVerified(claims)) return fail('sso_unverified');

    const email = claims.email.trim().toLowerCase();
    const captured = await first<DomainRow>(
      e.DB,
      'SELECT * FROM sso_domains WHERE connection_id = ?1 AND domain = ?2 AND verified_at IS NOT NULL',
      connection.id,
      email.split('@')[1] ?? '',
    );
    // An identity provider only speaks for the domains its workspace proved it controls, and
    // only while the proof still stands: an old check is repeated before it is relied on.
    if (!captured) return fail('sso_domain');
    if (
      (captured.checked_at ?? 0) < Date.now() - SSO_DOMAIN_RECHECK_HOURS * HOUR_MS &&
      !(await reproveDomain(c, captured))
    ) {
      return fail('sso_domain');
    }

    const ip = ipPrefix(clientIp(c));
    const provisioned = await provision(e, connection, claims.sub, email, ip);
    if ('refused' in provisioned) {
      if (provisioned.refused === 'not_member') await refusedSignIn(c, connection, email, ip);
      return fail('sso_no_seat');
    }
    const { operatorId } = provisioned;
    if (await emailSignInRequired(e, operatorId)) return fail('email_signin_required');
    await createSession(c, operatorId, {
      method: 'sso',
      ssoConnectionId: connection.id,
      idpMfa: idpAssertsMfa(claims),
    });
    await recordAccountEvent(c, operatorId, 'operator.signed_in', { method: 'sso' });
    return c.redirect(`${e.APP_ORIGIN}${state.returnTo}`, 302);
  },
);
