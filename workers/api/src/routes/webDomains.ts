// Settings → Domains: web hostnames for the Channel website (Cloudflare for SaaS custom
// hostnames), shown with the email and link roles of the same domain.
import { createRoute } from '@hono/zod-openapi';
import { all, first, toIso } from '@swarm/db';
import {
  AddWebDomainSchema,
  MAX_HOSTNAMES,
  WebDomainListSchema,
  idPattern,
  newId,
  type CustomHostname,
  type DomainRoles,
  type HostnameRecord,
  type WebDomainList,
} from '@swarm/domain';
import {
  bumpCacheStatement,
  refreshHostname,
  webHostnames,
  type CustomHostnameRow,
  type DomainRow,
  type WebHostnames,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { getDomain } from 'tldts';
import type { ApiEnv } from '../env';
import { requireChannel } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { releaseSendingDomain, requireClaimsGiveWay } from '../lib/claims';
import { createRouter, env, type AppContext } from '../lib/context';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { engine } from '../lib/send';
import { audit } from '../lib/site';

export const webDomains = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const hostnameParams = channelParam.extend(
  idParam('hostnameId', idPattern('customHostname')).shape,
);

function provider(c: AppContext): WebHostnames {
  const hostnames = webHostnames(env(c));
  if (!hostnames) {
    throw new ApiError('unavailable', 'Custom web domains are not available here yet.');
  }
  return hostnames;
}

/**
 * The registrable domain (one label under an ICANN public suffix), so example.co.uk is a bare
 * domain and blog.example.co.uk is not. Null for a public suffix itself (co.uk). Private suffixes
 * (github.io, pages.dev) count as subdomains: their owners can't set records at the apex.
 */
export const registrableDomain = (hostname: string): string | null =>
  getDomain(hostname, { allowPrivateDomains: false, validateHostname: false });

/** Whether a hostname is a bare domain: the registrable domain itself. */
export const isBareDomain = (hostname: string) => registrableDomain(hostname) === hostname;

const baseDomain = (hostname: string) => registrableDomain(hostname) ?? hostname;

const roleStatus = (status: string | undefined) =>
  status === 'active' || status === 'verified'
    ? ('active' as const)
    : status === 'failed'
      ? ('failed' as const)
      : status === undefined
        ? ('not_set_up' as const)
        : ('pending' as const);

const toHostname = (row: CustomHostnameRow): CustomHostname => ({
  id: row.id,
  channelId: row.channel_id,
  hostname: row.hostname,
  role: row.role,
  status: row.status,
  isPrimary: row.is_primary === 1,
  records: JSON.parse(row.records_json) as HostnameRecord[],
  detail: row.detail,
  lastCheckedAt: row.last_checked_at === null ? null : toIso(row.last_checked_at),
  createdAt: toIso(row.created_at),
});

async function listDomains(c: AppContext, channelId: string): Promise<WebDomainList> {
  const e = env(c);
  const rows = await all<CustomHostnameRow>(
    e.DB,
    'SELECT * FROM custom_hostnames WHERE channel_id = ?1 ORDER BY created_at',
    channelId,
  );
  const sending = await all<{ id: string; domain: string; kind: 'email' | 'link'; status: string }>(
    e.DB,
    'SELECT id, domain, kind, status FROM sending_domains WHERE channel_id = ?1 ORDER BY created_at',
    channelId,
  );
  const groups = new Map<string, DomainRoles>();
  const group = (domain: string): DomainRoles => {
    let found = groups.get(domain);
    if (!found) {
      found = {
        domain,
        web: { hostname: `www.${domain}`, status: 'not_set_up', id: null },
        apexRedirect: { hostname: domain, status: 'not_set_up', id: null },
        email: { hostname: null, status: 'not_set_up', id: null },
        link: { hostname: null, status: 'not_set_up', id: null },
      };
      groups.set(domain, found);
    }
    return found;
  };
  // Primary web hostnames first, so a domain with several shows the one the site uses.
  const ordered = [...rows].sort((a, b) => b.is_primary - a.is_primary);
  for (const row of ordered) {
    const roles = group(baseDomain(row.hostname));
    const slot = row.role === 'web' ? roles.web : roles.apexRedirect;
    if (slot.id) continue;
    slot.hostname = row.hostname;
    slot.status = roleStatus(row.status);
    slot.id = row.id;
  }
  for (const domain of sending) {
    const base =
      [...groups.keys()].find(
        (key) => domain.domain === key || domain.domain.endsWith(`.${key}`),
      ) ?? baseDomain(domain.domain);
    const slot = domain.kind === 'email' ? group(base).email : group(base).link;
    if (slot.id) continue;
    slot.hostname = domain.domain;
    slot.status = roleStatus(domain.status);
    slot.id = domain.id;
  }
  return {
    hostnames: rows.map(toHostname),
    domains: [...groups.values()],
    cnameTarget: e.SITE_FALLBACK_ORIGIN,
    available: e.WEB_HOSTNAMES !== 'off',
  };
}

async function readHostname(
  db: D1Database,
  channelId: string,
  id: string,
): Promise<CustomHostnameRow> {
  const row = await first<CustomHostnameRow>(
    db,
    'SELECT * FROM custom_hostnames WHERE id = ?1 AND channel_id = ?2',
    id,
    channelId,
  );
  if (!row) throw new ApiError('not_found', 'Domain not found.');
  return row;
}

/** Makes the Channel's next web hostname (active ones first) the primary one. */
const nextPrimaryStatement = (db: D1Database, channelId: string, now: number) =>
  db
    .prepare(
      `UPDATE custom_hostnames SET is_primary = 1, updated_at = ?2
        WHERE id = (SELECT id FROM custom_hostnames WHERE channel_id = ?1 AND role = 'web'
                     ORDER BY status = 'active' DESC, created_at LIMIT 1)`,
    )
    .bind(channelId, now);

/**
 * Removes hostnames of other Channels whose claims gave way, while still unproven, and notes it in
 * each one's workspace. They were never active, so no site was served at them.
 */
async function releaseHostnames(
  e: ApiEnv,
  hostnames: WebHostnames,
  rows: CustomHostnameRow[],
  now: number,
): Promise<void> {
  const results = await e.DB.batch(
    rows.map((row) =>
      e.DB.prepare('DELETE FROM custom_hostnames WHERE id = ?1 AND proven_at IS NULL').bind(row.id),
    ),
  );
  const gone = rows.filter((_, i) => results[i]?.meta.changes);
  for (const row of gone) if (row.provider_id) await hostnames.remove(row.provider_id);
  // One that went active a moment ago keeps its hostname.
  const kept = rows.find((row) => !gone.includes(row));
  if (kept) throw new ApiError('conflict', `${kept.hostname} is already set up.`);
  const channels = [...new Set(rows.map((row) => row.channel_id))];
  await e.DB.batch(
    channels.flatMap((id) => [
      ...(rows.some((row) => row.channel_id === id && row.is_primary === 1)
        ? [nextPrimaryStatement(e.DB, id, now)]
        : []),
      bumpCacheStatement(e.DB, id, now),
    ]),
  );
  for (const row of rows) {
    await appendAudit(e.DB, {
      workspaceId: row.workspace_id,
      actorId: null,
      action: 'web_domain.released',
      targetType: 'custom_hostname',
      targetId: row.id,
      metadata: { hostnames: [row.hostname] },
    });
  }
}

/** Hostnames that belong to the platform and can't be added as a Channel's web domain. */
function platformHosts(c: AppContext): string[] {
  const e = env(c);
  const config = engine(c);
  return [
    e.PLATFORM_SITE_DOMAIN,
    e.SITE_FALLBACK_ORIGIN,
    config.platformMailDomain,
    config.unsubscribeMailDomain,
    new URL(config.trackOrigin).hostname,
    new URL(e.APP_ORIGIN).hostname,
    new URL(e.MEDIA_ORIGIN).hostname,
    new URL(e.CAPTURE_ORIGIN).hostname,
  ].map((host) => host.toLowerCase());
}

webDomains.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/domains/web',
    tags: ['Domains'],
    summary: 'Web domains, with every role of each domain',
    description:
      'The web hostnames of the Channel website and, per domain, its four roles: web, the bare-domain redirect, email sending and links (the last two from Settings → Sending).',
    request: { params: channelParam },
    responses: { 200: ok(WebDomainListSchema, 'Domains'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    return c.json({ data: await listDomains(c, channelId) }, 200);
  },
);

webDomains.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/domains/web',
    tags: ['Domains'],
    summary: 'Add a web domain',
    description:
      'Admin role. A bare domain (example.com) is set up as www.example.com with example.com redirecting to it; www.example.com with redirectApex does the same. Each hostname gets a certificate once its CNAME points at the target in the response; it is served only once active. The first web hostname becomes the primary one, used in canonical addresses. A hostname another Channel added but never got active is taken over by publishing the TXT record named in the 409, and so is one whose DNS already points at Swarm (this target or the link host, through any CNAME hop).',
    request: { params: channelParam, body: jsonBody(AddWebDomainSchema) },
    responses: {
      201: ok(WebDomainListSchema, 'Added'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const e = env(c);
    const hostnames = provider(c);

    if (registrableDomain(input.hostname) === null) {
      throw new ApiError('invalid_input', 'That is a public suffix, not a domain you can own.', [
        { path: 'hostname', message: 'Use a domain registered under it, like example.co.uk.' },
      ]);
    }
    const bare = isBareDomain(input.hostname);
    if (input.redirectApex && !input.hostname.startsWith('www.')) {
      throw new ApiError('invalid_input', 'Only a www hostname can take over its bare domain.', [
        { path: 'redirectApex', message: 'Only a www hostname can take over its bare domain.' },
      ]);
    }
    const web = bare ? `www.${input.hostname}` : input.hostname;
    const apex = bare ? input.hostname : input.redirectApex ? input.hostname.slice(4) : null;
    const wanted = apex ? [web, apex] : [web];

    const reserved = platformHosts(c);
    if (wanted.some((host) => reserved.some((r) => host === r || host.endsWith(`.${r}`)))) {
      throw new ApiError('invalid_input', 'That domain belongs to the platform.');
    }
    const count = await first<{ n: number }>(
      e.DB,
      'SELECT count(*) AS n FROM custom_hostnames WHERE channel_id = ?1',
      channelId,
    );
    if ((count?.n ?? 0) + wanted.length > MAX_HOSTNAMES) {
      throw new ApiError(
        'conflict',
        `A publication can have up to ${MAX_HOSTNAMES} web hostnames.`,
      );
    }
    // A hostname is kept by a claim that has been active (or verified, as a link domain). One that
    // never was gives way only to a Channel that publishes the TXT proof.
    const now = Date.now();
    const siteClaims = await all<CustomHostnameRow>(
      e.DB,
      'SELECT * FROM custom_hostnames WHERE hostname IN (?1, ?2)',
      web,
      apex ?? web,
    );
    const linkClaims = await all<DomainRow>(
      e.DB,
      `SELECT * FROM sending_domains WHERE kind = 'link' AND domain IN (?1, ?2)`,
      web,
      apex ?? web,
    );
    await requireClaimsGiveWay(
      e,
      channelId,
      [
        ...siteClaims.map((row) => ({
          name: row.hostname,
          channelId: row.channel_id,
          provenAt: row.proven_at,
        })),
        ...linkClaims.map((row) => ({
          name: row.domain,
          channelId: row.channel_id,
          provenAt: row.proven_at,
        })),
      ],
      (hostname) => `${hostname} is already set up.`,
      // A hostname whose DNS an earlier owner left pointing here would go active at once.
      { field: 'hostname', shared: wanted },
    );
    for (const row of linkClaims) await releaseSendingDomain(e, row);
    if (siteClaims.length) await releaseHostnames(e, hostnames, siteClaims, now);

    const target = e.SITE_FALLBACK_ORIGIN;
    const created: { hostname: string; role: 'web' | 'apex_redirect'; providerId: string }[] = [];
    const states = new Map<string, { status: string; detail: string | null }>();
    try {
      for (const hostname of wanted) {
        const result = await hostnames.create(hostname);
        created.push({
          hostname,
          role: hostname === web ? 'web' : 'apex_redirect',
          providerId: result.id,
        });
        states.set(hostname, { status: result.status, detail: result.detail });
      }
    } catch (error) {
      // Don't leave half a domain behind with the provider.
      await Promise.allSettled(created.map((item) => hostnames.remove(item.providerId)));
      throw new ApiError(
        'invalid_input',
        `The domain couldn’t be registered: ${(error as Error).message}`,
      );
    }

    const hasPrimary = await first(
      e.DB,
      'SELECT 1 FROM custom_hostnames WHERE channel_id = ?1 AND is_primary = 1',
      channelId,
    );
    const records = (item: (typeof created)[number]): HostnameRecord[] =>
      item.role === 'web'
        ? [{ type: 'CNAME', name: item.hostname, value: target }]
        : [
            {
              type: 'ALIAS',
              name: item.hostname,
              value: target,
              note: 'At the root of a domain, use your DNS provider’s ALIAS, ANAME or CNAME flattening.',
            },
          ];
    const ids: string[] = [];
    try {
      await e.DB.batch([
        ...created.map((item) => {
          const id = newId('customHostname', now);
          ids.push(id);
          const state = states.get(item.hostname);
          return e.DB.prepare(
            `INSERT INTO custom_hostnames (id, workspace_id, channel_id, hostname, role, status, provider_id, records_json,
               detail, is_primary, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`,
          ).bind(
            id,
            access.workspaceId,
            channelId,
            item.hostname,
            item.role,
            state?.status ?? 'pending',
            item.providerId,
            JSON.stringify(records(item)),
            state?.detail ?? null,
            item.role === 'web' && !hasPrimary ? 1 : 0,
            access.auth.operatorId,
            now,
          );
        }),
        bumpCacheStatement(e.DB, channelId, now),
      ]);
    } catch (error) {
      await Promise.allSettled(created.map((item) => hostnames.remove(item.providerId)));
      throw error;
    }
    await audit(c, access, 'web_domain.added', 'custom_hostname', ids[0] as string, {
      hostnames: wanted,
    });
    return c.json({ data: await listDomains(c, channelId) }, 201);
  },
);

webDomains.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/domains/web/{hostnameId}/refresh',
    tags: ['Domains'],
    summary: 'Check a web hostname now',
    description: 'Pending hostnames are also checked every few minutes for two weeks.',
    request: { params: hostnameParams },
    responses: {
      200: ok(WebDomainListSchema, 'Checked'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, hostnameId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'admin');
    const e = env(c);
    const before = await readHostname(e.DB, channelId, hostnameId);
    const after = await refreshHostname(e.DB, provider(c), hostnameId);
    if (after && before.status !== after.status) {
      await audit(c, access, 'web_domain.status_changed', 'custom_hostname', hostnameId, {
        hostname: before.hostname,
        status: after.status,
      });
    }
    return c.json({ data: await listDomains(c, channelId) }, 200);
  },
);

webDomains.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/domains/web/{hostnameId}/primary',
    tags: ['Domains'],
    summary: 'Make a web hostname the primary one',
    description:
      'Canonical addresses, feeds and email links use the primary hostname once it is active.',
    request: { params: hostnameParams },
    responses: {
      200: ok(WebDomainListSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId, hostnameId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'admin');
    const e = env(c);
    const row = await readHostname(e.DB, channelId, hostnameId);
    if (row.role !== 'web') {
      throw new ApiError('invalid_input', 'Only a web hostname can be the primary one.');
    }
    if (row.is_primary !== 1) {
      const now = Date.now();
      await e.DB.batch([
        e.DB.prepare(
          'UPDATE custom_hostnames SET is_primary = 0, updated_at = ?2 WHERE channel_id = ?1 AND is_primary = 1',
        ).bind(channelId, now),
        e.DB.prepare(
          'UPDATE custom_hostnames SET is_primary = 1, updated_at = ?2 WHERE id = ?1',
        ).bind(hostnameId, now),
        bumpCacheStatement(e.DB, channelId, now),
      ]);
      await audit(c, access, 'web_domain.primary_set', 'custom_hostname', hostnameId, {
        hostname: row.hostname,
      });
    }
    return c.json({ data: await listDomains(c, channelId) }, 200);
  },
);

webDomains.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}/domains/web/{hostnameId}',
    tags: ['Domains'],
    summary: 'Remove a web hostname',
    description:
      'Removing a www hostname removes the bare-domain redirect to it as well. When the primary hostname goes, the next web hostname (active ones first) becomes primary; with none left the site is served at its platform address.',
    request: { params: hostnameParams },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { channelId, hostnameId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'admin');
    const e = env(c);
    const row = await readHostname(e.DB, channelId, hostnameId);
    const siblings =
      row.role === 'web' && row.hostname.startsWith('www.')
        ? await all<CustomHostnameRow>(
            e.DB,
            `SELECT * FROM custom_hostnames WHERE channel_id = ?1 AND role = 'apex_redirect' AND hostname = ?2`,
            channelId,
            row.hostname.slice(4),
          )
        : [];
    const removing = [row, ...siblings];
    // With custom domains switched off nothing was registered that could be removed.
    const hostnames = webHostnames(e);
    if (hostnames) {
      for (const item of removing) if (item.provider_id) await hostnames.remove(item.provider_id);
    }
    const now = Date.now();
    await e.DB.batch([
      ...removing.map((item) =>
        e.DB.prepare('DELETE FROM custom_hostnames WHERE id = ?1').bind(item.id),
      ),
      ...(row.is_primary === 1 ? [nextPrimaryStatement(e.DB, channelId, now)] : []),
      bumpCacheStatement(e.DB, channelId, now),
    ]);
    await audit(c, access, 'web_domain.removed', 'custom_hostname', hostnameId, {
      hostnames: removing.map((item) => item.hostname),
    });
    return c.body(null, 204);
  },
);
