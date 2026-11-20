// Settings → Sending: sending and link domains, sender identities, the Reputation Ramp, and the
// Channel's custom email CSS.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, isUniqueViolation, run } from '@swarm/db';
import {
  CreateSenderIdentitySchema,
  CheckedSendingDomainSchema,
  CreateSendingDomainSchema,
  EmailCssSchema,
  RAMP_PACES,
  RampSchema,
  RestartRampSchema,
  SHARED_RAMP_MAX_CAP,
  SenderIdentitySchema,
  SendingDomainSchema,
  SkipRampSchema,
  UpdateRampSchema,
  UpdateEmailCssSchema,
  UpdateSenderIdentitySchema,
  idPattern,
  newId,
  projectWarmup,
  rampPaceOf,
  rampPaceProblem,
  type EmailCss,
  type Ramp,
} from '@swarm/domain';
import {
  dmarcReportAddress,
  domainIdentities,
  checkDnsRecords,
  dnsLookup,
  emailDomainRecords,
  ensureRamp,
  linkDomainRecords,
  linkHostnames,
  mailFromDomain,
  RAMP_DEFAULTS,
  rampDays,
  rampKind,
  refreshDomain,
  restartRamp,
  skipRamp,
  txtResolver,
  updateRamp,
  utcDay,
  DevHostnames,
  type DomainRow,
  type RampRow,
} from '@swarm/engine';
import { IdentityExistsError, lintEmailCss } from '@swarm/mail';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { releaseSendingDomain, removeDomainCopy, requireClaimsGiveWay } from '../lib/claims';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { isInstanceAdmin } from '../lib/instance';
import { requireFlag } from '../lib/site';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import {
  engine,
  isPlatformDomain,
  requireOwned,
  toSenderIdentity,
  toSendingDomain,
  type SenderIdentityRow,
} from '../lib/send';

export const sending = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const domainParam = idParam('domainId', idPattern('sendingDomain'));
const identityParam = idParam('identityId', idPattern('senderIdentity'));
const rampParam = idParam('rampId', idPattern('reputationRamp'));

/** Sender identities per Channel, by plan (the matrix: 3 on free, unlimited on paid). */
const IDENTITY_LIMIT: Record<string, number> = { free: 3 };

const audit = async (
  c: AppContext,
  access: { workspaceId: string; auth: { operatorId: string } },
  action: string,
  targetType: string,
  targetId: string,
  metadata?: Record<string, unknown>,
) =>
  appendAudit(env(c).DB, {
    workspaceId: access.workspaceId,
    actorId: access.auth.operatorId,
    action,
    targetType,
    targetId,
    ...(metadata ? { metadata } : {}),
    ipPrefix: ipPrefix(clientIp(c)),
  });

function verifyDeps(c: AppContext) {
  const e = env(c);
  return {
    identities: domainIdentities(e),
    service: e.MAIL_ADAPTER,
    // Link domains can't exist without a hostname provider (creation refuses), so the
    // fallback is never used to verify one.
    hostnames: linkHostnames(e) ?? new DevHostnames(),
    resolver: txtResolver(e),
  };
}

// ---- Domains -----------------------------------------------------------------------------

sending.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/sending-domains',
    tags: ['Sending'],
    summary: 'Sending and link domains',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(SendingDomainSchema), 'Domains'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const rows = await all<DomainRow>(
      env(c).DB,
      'SELECT * FROM sending_domains WHERE channel_id = ?1 ORDER BY created_at',
      channelId,
    );
    const dmarcDomain = env(c).DMARC_MAIL_DOMAIN;
    return c.json({ data: rows.map((row) => toSendingDomain(row, dmarcDomain)) }, 200);
  },
);

sending.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/sending-domains',
    tags: ['Sending'],
    summary: 'Add a sending or link domain',
    description:
      'An email domain is registered with the mail provider (Easy DKIM, RSA 2048, with a bounce. MAIL FROM subdomain); the response lists the DNS records to publish. Sending from it needs DMARC set to quarantine or reject. A link domain becomes a branded link host for clicks, opens and unsubscribe pages. Until it first verifies, a domain stays open to another Channel that publishes the TXT record named in its 409. A link domain whose DNS already points at Swarm (its link host or its web hostname target, through any CNAME hop) needs that TXT record too.',
    request: { params: channelParam, body: jsonBody(CreateSendingDomainSchema) },
    responses: {
      201: ok(SendingDomainSchema, 'Added'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { domain, kind } = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const e = env(c);
    const config = engine(c);
    if (isPlatformDomain(domain, config)) {
      throw new ApiError('invalid_input', 'That domain belongs to the platform.');
    }
    const now = Date.now();
    // Before the provider: its copy belongs to the row that has the domain. That row keeps it once
    // verified; until then it gives way only to the TXT proof. A link domain no row has needs the
    // proof too if its DNS already points at the platform: the hostname service would activate it
    // at once, on DNS an earlier owner left behind.
    const holder = await first<DomainRow>(
      e.DB,
      'SELECT * FROM sending_domains WHERE domain = ?1 AND kind = ?2',
      domain,
      kind,
    );
    await requireClaimsGiveWay(
      e,
      channelId,
      holder
        ? [
            {
              name: domain,
              channelId: holder.channel_id,
              provenAt: holder.proven_at,
              held: holder.pending_records_json !== null,
            },
          ]
        : [],
      () => 'That domain is already set up.',
      kind === 'link' ? { shared: [domain] } : {},
    );
    if (holder) await releaseSendingDomain(e, holder);

    const id = newId('sendingDomain', now);
    let records;
    let providerRef: string | null = null;
    let mailFrom: string | null = null;
    if (kind === 'email') {
      mailFrom = mailFromDomain(domain);
      let created;
      try {
        created = await domainIdentities(e).create(domain, mailFrom);
      } catch (error) {
        if (!(error instanceof IdentityExistsError)) throw error;
        throw new ApiError(
          'conflict',
          `The mail service already has ${domain}, and Swarm didn't add it there for this publication. Whoever runs this Swarm can remove it from the mail service; then add it here again.`,
        );
      }
      // The provider's id for the domain (Resend); SES identities are keyed by name (null).
      providerRef = created.providerRef;
      // Aggregate reports come back to this domain's own address (the Deliverability Center).
      records = emailDomainRecords(
        domain,
        created.records,
        dmarcReportAddress(id, e.DMARC_MAIL_DOMAIN),
      );
    } else {
      const hostnames = linkHostnames(e);
      if (!hostnames)
        throw new ApiError('unavailable', 'Branded link domains are not available here yet.');
      providerRef = (await hostnames.create(domain)).id;
      records = linkDomainRecords(domain, new URL(config.trackOrigin).hostname);
    }

    try {
      await run(
        e.DB,
        `INSERT INTO sending_domains (id, workspace_id, channel_id, domain, kind, mail_from_domain, records_json, provider_ref, provider, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
        id,
        access.workspaceId,
        channelId,
        domain,
        kind,
        mailFrom,
        JSON.stringify(records),
        providerRef,
        kind === 'email' ? e.MAIL_ADAPTER : null,
        now,
      );
    } catch (error) {
      // What was just created is this request's own; left behind, it would block every later add.
      if (kind === 'email') await domainIdentities(e).remove(domain, providerRef);
      else if (providerRef) await linkHostnames(e)?.remove(providerRef);
      if (isUniqueViolation(error))
        throw new ApiError('conflict', 'That domain is already set up.');
      throw error;
    }
    await audit(c, access, 'sending_domain.added', 'sending_domain', id, { domain, kind });
    const row = await first<DomainRow>(e.DB, 'SELECT * FROM sending_domains WHERE id = ?1', id);
    return c.json({ data: toSendingDomain(row as DomainRow, e.DMARC_MAIL_DOMAIN) }, 201);
  },
);

sending.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/sending-domains/{domainId}/verify',
    tags: ['Sending'],
    summary: 'Check DNS and verification now',
    description: 'Domains are also re-checked every few minutes for a week after they are added.',
    request: { params: domainParam },
    responses: {
      200: ok(CheckedSendingDomainSchema, 'Checked'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { domainId } = c.req.valid('param');
    const access = await requireOwned(c, 'sendingDomain', domainId, 'admin');
    const before = await first<{ status: string }>(
      env(c).DB,
      'SELECT status FROM sending_domains WHERE id = ?1',
      domainId,
    );
    const row = await refreshDomain(env(c).DB, verifyDeps(c), domainId);
    if (before?.status !== 'verified' && row.status === 'verified') {
      await audit(c, access, 'sending_domain.verified', 'sending_domain', domainId, {
        domain: row.domain,
      });
    }
    const domain = toSendingDomain(row, env(c).DMARC_MAIL_DOMAIN);
    const checked =
      row.kind === 'email' ? await checkDnsRecords(domain.records, dnsLookup(env(c))) : [];
    const summary = (rows: typeof checked) =>
      rows.map(({ type, name, state, found }) => ({ type, name, state, found }));
    const pending = domain.pendingChange
      ? await checkDnsRecords(domain.pendingChange.records, dnsLookup(env(c)))
      : [];
    return c.json(
      { data: { ...domain, recordChecks: summary(checked), pendingChecks: summary(pending) } },
      200,
    );
  },
);

sending.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/sending-domains/{domainId}',
    tags: ['Sending'],
    summary: 'Remove a domain',
    description:
      'Senders on this domain are removed too; their Dispatches fall back to the default sender.',
    request: { params: domainParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found', 'conflict') },
  }),
  async (c) => {
    const { domainId } = c.req.valid('param');
    const access = await requireOwned(c, 'sendingDomain', domainId, 'admin');
    const e = env(c);
    const row = (await first<DomainRow>(
      e.DB,
      'SELECT * FROM sending_domains WHERE id = ?1',
      domainId,
    )) as DomainRow;
    const live = await first(
      e.DB,
      `SELECT 1 FROM broadcasts WHERE sending_domain_id = ?1 AND status IN ('queued', 'sending') LIMIT 1`,
      domainId,
    );
    if (live)
      throw new ApiError(
        'conflict',
        'A send is going out from this domain. Wait for it to finish.',
      );
    // A service change registered it at another service, which this Worker can't reach: removed
    // now, that copy would be left behind for anyone to claim once the change cuts over.
    if (row.kind === 'email' && row.pending_records_json !== null) {
      throw new ApiError(
        'conflict',
        `The email service is changing, and ${row.pending_provider ?? 'the other service'} has this domain too. Remove it once the change is finished or dropped.`,
      );
    }
    await removeDomainCopy(e, row);
    await run(e.DB, 'DELETE FROM sending_domains WHERE id = ?1', domainId);
    await audit(c, access, 'sending_domain.removed', 'sending_domain', domainId, {
      domain: row.domain,
    });
    return c.body(null, 204);
  },
);

// ---- Sender identities -------------------------------------------------------------------

const IDENTITY_SELECT = `SELECT si.*, sd.domain FROM sender_identities si
  LEFT JOIN sending_domains sd ON sd.id = si.sending_domain_id`;

sending.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/sender-identities',
    tags: ['Sending'],
    summary: 'Senders a Dispatch can be from',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(SenderIdentitySchema), 'Senders'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const rows = await all<SenderIdentityRow>(
      env(c).DB,
      `${IDENTITY_SELECT} WHERE si.channel_id = ?1 ORDER BY si.is_default DESC, si.created_at`,
      channelId,
    );
    const config = engine(c);
    return c.json({ data: rows.map((row) => toSenderIdentity(row, config)) }, 200);
  },
);

sending.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/sender-identities',
    tags: ['Sending'],
    summary: 'Add a sender',
    description:
      'With a sending domain the address is <fromLocal>@<domain>. Without one it is always <channel address>@ the shared platform domain, whatever fromLocal says.',
    request: { params: channelParam, body: jsonBody(CreateSenderIdentitySchema) },
    responses: {
      201: ok(SenderIdentitySchema, 'Added'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    const e = env(c);
    const channel = (await first<{ slug: string; plan: string }>(
      e.DB,
      'SELECT c.slug, w.plan FROM channels c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ?1',
      channelId,
    )) as { slug: string; plan: string };
    const limit = IDENTITY_LIMIT[channel.plan];
    if (limit !== undefined) {
      const existing = await first<{ n: number }>(
        e.DB,
        'SELECT count(*) AS n FROM sender_identities WHERE channel_id = ?1',
        channelId,
      );
      if ((existing?.n ?? 0) >= limit) {
        throw new ApiError('conflict', `The free plan includes ${limit} senders per publication.`);
      }
    }
    if (input.sendingDomainId) {
      const domain = await first(
        e.DB,
        `SELECT 1 FROM sending_domains WHERE id = ?1 AND channel_id = ?2 AND kind = 'email'`,
        input.sendingDomainId,
        channelId,
      );
      if (!domain)
        throw new ApiError(
          'invalid_input',
          'That sending domain is not set up for this publication.',
        );
    }
    const now = Date.now();
    const id = newId('senderIdentity', now);
    const first_ = !(await first(
      e.DB,
      'SELECT 1 FROM sender_identities WHERE channel_id = ?1',
      channelId,
    ));
    const makeDefault = input.isDefault === true || first_;
    // The limit is checked again inside the batch (one transaction), so senders added at once
    // can't pass it together; the count above only answers early.
    const room = (channel: string, max: string) =>
      `(${max} IS NULL OR (SELECT count(*) FROM sender_identities WHERE channel_id = ${channel}) < ${max})`;
    const statements = [];
    if (makeDefault) {
      statements.push(
        e.DB.prepare(
          `UPDATE sender_identities SET is_default = 0 WHERE channel_id = ?1 AND ${room('?1', '?2')}`,
        ).bind(channelId, limit ?? null),
      );
    }
    statements.push(
      e.DB.prepare(
        `INSERT INTO sender_identities (id, channel_id, sending_domain_id, from_name, from_local, reply_to, is_default, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8 WHERE ${room('?2', '?9')}
         RETURNING id`,
      ).bind(
        id,
        channelId,
        input.sendingDomainId,
        input.fromName,
        input.sendingDomainId ? input.fromLocal : channel.slug,
        input.replyTo ?? null,
        makeDefault ? 1 : 0,
        now,
        limit ?? null,
      ),
    );
    let added;
    try {
      added = (await e.DB.batch(statements)).at(-1)?.results.length ?? 0;
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError('conflict', 'That sender already exists.');
      throw error;
    }
    if (!added) {
      throw new ApiError('conflict', `The free plan includes ${limit} senders per publication.`);
    }
    await audit(c, access, 'sender_identity.added', 'sender_identity', id);
    const row = await first<SenderIdentityRow>(e.DB, `${IDENTITY_SELECT} WHERE si.id = ?1`, id);
    return c.json({ data: toSenderIdentity(row as SenderIdentityRow, engine(c)) }, 201);
  },
);

sending.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/sender-identities/{identityId}',
    tags: ['Sending'],
    summary: 'Change a sender, or make it the default',
    request: { params: identityParam, body: jsonBody(UpdateSenderIdentitySchema) },
    responses: {
      200: ok(SenderIdentitySchema, 'Updated'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { identityId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireOwned(c, 'senderIdentity', identityId, 'admin');
    const e = env(c);
    const statements = [];
    if (input.isDefault) {
      statements.push(
        e.DB.prepare('UPDATE sender_identities SET is_default = 0 WHERE channel_id = ?1').bind(
          access.channelId,
        ),
      );
    }
    statements.push(
      e.DB.prepare(
        `UPDATE sender_identities SET from_name = coalesce(?1, from_name),
                reply_to = CASE WHEN ?2 THEN ?3 ELSE reply_to END,
                is_default = CASE WHEN ?4 THEN 1 ELSE is_default END, updated_at = ?5
          WHERE id = ?6`,
      ).bind(
        input.fromName ?? null,
        input.replyTo === undefined ? 0 : 1,
        input.replyTo ?? null,
        input.isDefault ? 1 : 0,
        Date.now(),
        identityId,
      ),
    );
    await e.DB.batch(statements);
    await audit(c, access, 'sender_identity.updated', 'sender_identity', identityId, {
      fields: Object.keys(input),
    });
    const row = await first<SenderIdentityRow>(
      e.DB,
      `${IDENTITY_SELECT} WHERE si.id = ?1`,
      identityId,
    );
    return c.json({ data: toSenderIdentity(row as SenderIdentityRow, engine(c)) }, 200);
  },
);

sending.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/sender-identities/{identityId}',
    tags: ['Sending'],
    summary: 'Remove a sender',
    request: { params: identityParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { identityId } = c.req.valid('param');
    const access = await requireOwned(c, 'senderIdentity', identityId, 'admin');
    await run(env(c).DB, 'DELETE FROM sender_identities WHERE id = ?1', identityId);
    await audit(c, access, 'sender_identity.removed', 'sender_identity', identityId);
    return c.body(null, 204);
  },
);

// ---- Reputation Ramp ---------------------------------------------------------------------

/** The audience a warm-up plan is made for: the Channel's active Members. */
async function activeMembers(db: D1Database, channelId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    "SELECT count(*) AS n FROM members WHERE channel_id = ?1 AND status = 'active'",
    channelId,
  );
  return row?.n ?? 0;
}

async function toRamp(
  db: D1Database,
  row: RampRow,
  domain: string,
  audience: number,
  instanceAdmin: boolean,
  now = Date.now(),
): Promise<Ramp> {
  const kind = rampKind(row);
  return {
    id: row.id,
    sendingDomainId: row.sending_domain_id,
    domain,
    kind,
    status: row.status,
    sharedOverride: kind === 'shared' && instanceAdmin,
    skipped: row.status === 'complete' && row.skipped_at !== null,
    skippedAt: row.skipped_at === null ? null : new Date(row.skipped_at).toISOString(),
    startedDay: row.started_day ?? utcDay(row.created_at),
    day: row.day,
    capToday: row.cap_today,
    sentToday: row.sent_today,
    pace: rampPaceOf(kind, row.start_cap, row.growth),
    startCap: row.start_cap,
    growth: row.growth,
    maxCap: row.max_cap,
    bounceThreshold: row.bounce_threshold,
    complaintThreshold: row.complaint_threshold,
    pausedReason: row.paused_reason,
    // A paused row without a recorded pauser predates 0069's backfill only in a test: it counts as
    // the system's, as the resume check below does.
    pausedBy: row.status === 'paused' ? (row.paused_by ?? 'system') : null,
    days: (await rampDays(db, row.id)).reverse(),
    plan: projectWarmup(
      {
        status: row.status,
        day: row.day,
        capToday: row.cap_today,
        sentToday: row.sent_today,
        growth: row.growth,
        maxCap: row.max_cap,
      },
      audience,
      utcDay(now),
    ),
  };
}

/** The ramp as the API returns it, with its domain's name and the plan for today's audience. */
async function rampResponse(c: AppContext, row: RampRow, instanceAdmin: boolean): Promise<Ramp> {
  const db = env(c).DB;
  const domain = row.sending_domain_id
    ? ((
        await first<{ domain: string }>(
          db,
          'SELECT domain FROM sending_domains WHERE id = ?1',
          row.sending_domain_id,
        )
      )?.domain ?? '')
    : engine(c).platformMailDomain;
  return toRamp(db, row, domain, await activeMembers(db, row.channel_id), instanceAdmin);
}

const loadRamp = async (db: D1Database, rampId: string) => {
  const row = await first<RampRow>(db, 'SELECT * FROM reputation_ramps WHERE id = ?1', rampId);
  if (!row) throw new ApiError('not_found', 'Warm-up not found.');
  return row;
};

sending.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/ramps',
    tags: ['Sending'],
    summary: 'Reputation Ramp for the shared domain and each verified sending domain',
    description:
      'Each ramp carries its pace, its history and `plan`: the day-by-day caps from today on for the Channel’s active Members, assuming healthy days, with the day the cap first covers the whole audience and the day the ramp completes.',
    request: { params: channelParam },
    responses: { 200: ok(z.array(RampSchema), 'Ramps'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'viewer');
    const db = env(c).DB;
    const instanceAdmin = await isInstanceAdmin(env(c), access.auth.operatorId);
    const domains = await all<{ id: string; domain: string }>(
      db,
      `SELECT id, domain FROM sending_domains WHERE channel_id = ?1 AND kind = 'email' AND status = 'verified'`,
      channelId,
    );
    const audience = await activeMembers(db, channelId);
    const ramps: Ramp[] = [
      await toRamp(
        db,
        await ensureRamp(db, channelId, null),
        engine(c).platformMailDomain,
        audience,
        instanceAdmin,
      ),
    ];
    for (const domain of domains) {
      ramps.push(
        await toRamp(
          db,
          await ensureRamp(db, channelId, domain.id),
          domain.domain,
          audience,
          instanceAdmin,
        ),
      );
    }
    return c.json({ data: ramps }, 200);
  },
);

sending.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/ramps/{rampId}',
    tags: ['Sending'],
    summary: 'Change the pace of a Reputation Ramp, tune it, pause or resume it',
    description:
      '`pace` sets startCap and growth to a named pace (careful, standard, fast); or set startCap and growth yourself. A change of pace never lowers the cap of a ramp that has already grown: today’s cap is kept or raised, and only the growth from here changes. A ramp still on its first cap takes the new start cap, but never less than what was already sent today. The shared domain allows a start cap up to 500, growth up to 1.5 and a maxCap up to 5,000; an instance admin (`sharedOverride` on the ramp) gets the bounds of a custom domain there and may raise maxCap, audited with instanceAdminOverride. `status` "paused" pauses a warming ramp by hand (`pausedBy` "person") and changes nothing on a ramp that is already paused, so it keeps its reason and who paused it. On the shared domain only an instance admin may resume a ramp that paused itself (`pausedBy` "system"); anyone else gets 403.',
    request: { params: rampParam, body: jsonBody(UpdateRampSchema) },
    responses: {
      200: ok(RampSchema, 'Updated'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { rampId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireOwned(c, 'reputationRamp', rampId, 'admin');
    const db = env(c).DB;
    const before = await loadRamp(db, rampId);
    const kind = rampKind(before);
    const pace = input.pace ? RAMP_PACES[kind][input.pace] : null;
    const startCap = pace?.startCap ?? input.startCap;
    const growth = pace?.growth ?? input.growth;
    // The bounds are for new numbers. Tuning an older ramp's other fields leaves its pace alone.
    // On the shared domain an instance admin gets the bounds of a domain of their own, and is the
    // only one who may raise the ceiling: on their install its reputation is theirs alone.
    const instanceAdmin = await isInstanceAdmin(env(c), access.auth.operatorId);
    let override = false;
    if (!pace) {
      for (const field of ['startCap', 'growth'] as const) {
        const problem = rampPaceProblem(kind, { [field]: input[field] });
        if (!problem) continue;
        if (
          kind === 'shared' &&
          instanceAdmin &&
          !rampPaceProblem('custom', { [field]: input[field] })
        ) {
          override = true;
          continue;
        }
        throw new ApiError('invalid_input', problem, [{ path: field, message: problem }]);
      }
    }
    if (kind === 'shared' && input.maxCap !== undefined && input.maxCap > SHARED_RAMP_MAX_CAP) {
      if (!instanceAdmin) {
        throw new ApiError(
          'forbidden',
          `Only an instance admin can raise the shared domain’s ceiling above ${SHARED_RAMP_MAX_CAP}.`,
        );
      }
      override = true;
    }
    // The shared domain's safety net protects every publication on the install, so loosening it
    // is the instance's call: higher pause thresholds, and resuming after a pause the ramp made
    // itself (paused_by 'system'; the reason is free text and never decides it). A publication
    // admin can still tighten them, and resume a pause a person made.
    const mayResumeSystemPause = kind !== 'shared' || instanceAdmin;
    const systemResumeRefused = new ApiError(
      'forbidden',
      'Sending from the shared domain paused itself over bounces or spam complaints. Only an instance admin can resume it, because every publication on this install sends from it.',
    );
    if (kind === 'shared') {
      const looser =
        (input.bounceThreshold !== undefined &&
          input.bounceThreshold >
            Math.max(before.bounce_threshold, RAMP_DEFAULTS.bounceThreshold)) ||
        (input.complaintThreshold !== undefined &&
          input.complaintThreshold >
            Math.max(before.complaint_threshold, RAMP_DEFAULTS.complaintThreshold));
      const autoResume =
        input.status === 'warming' && before.status === 'paused' && before.paused_by !== 'person';
      if (looser || autoResume) {
        if (!instanceAdmin) {
          if (!looser) throw systemResumeRefused;
          throw new ApiError(
            'forbidden',
            'Only an instance admin can raise the shared domain’s pause thresholds, because every publication on this install sends from it.',
          );
        }
        override = true;
      }
    }
    // The resume check is also in the UPDATE itself, so a pause the ramp makes after the read
    // above is never lifted by someone who may not lift it.
    const row = await updateRamp(
      db,
      rampId,
      {
        startCap,
        growth,
        maxCap: input.maxCap,
        bounceThreshold: input.bounceThreshold,
        complaintThreshold: input.complaintThreshold,
        status: input.status,
      },
      Date.now(),
      { resumeSystemPause: mayResumeSystemPause },
    );
    if (!row) {
      if (
        !mayResumeSystemPause &&
        (await first(db, 'SELECT 1 FROM reputation_ramps WHERE id = ?1', rampId))
      ) {
        throw systemResumeRefused;
      }
      throw new ApiError('not_found', 'Warm-up not found.');
    }
    await audit(c, access, 'ramp.updated', 'reputation_ramp', rampId, {
      ...input,
      ...(override ? { instanceAdminOverride: true } : {}),
      ...(input.maxCap !== undefined ? { maxCapBefore: before.max_cap } : {}),
      ...(startCap !== undefined || growth !== undefined
        ? {
            from: { startCap: before.start_cap, growth: before.growth, capToday: before.cap_today },
            to: { startCap: row.start_cap, growth: row.growth, capToday: row.cap_today },
          }
        : {}),
    });
    return c.json({ data: await rampResponse(c, row, instanceAdmin) }, 200);
  },
);

sending.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/ramps/{rampId}/skip',
    tags: ['Sending'],
    summary: 'Skip warm-up for a domain that already sends this much mail',
    description:
      'Marks the ramp complete at once, so it no longer limits sending. Meant for a domain that already has a sending history with mailbox providers. Needs `confirm: true`; `dailyVolume` is what the admin says the domain already sends and is kept in the audit log (ramp.skipped). On the shared platform domain, whose reputation belongs to every Channel on the instance, only an instance admin may skip (403 otherwise; audited with instanceAdminOverride). 409 on a ramp that is already complete. Restart undoes it.',
    request: { params: rampParam, body: jsonBody(SkipRampSchema) },
    responses: {
      200: ok(RampSchema, 'Skipped'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { rampId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireOwned(c, 'reputationRamp', rampId, 'admin');
    const db = env(c).DB;
    const before = await loadRamp(db, rampId);
    const shared = rampKind(before) === 'shared';
    const instanceAdmin = await isInstanceAdmin(env(c), access.auth.operatorId);
    if (shared && !instanceAdmin) {
      throw new ApiError(
        'forbidden',
        'Only an instance admin can skip warm-up on the shared domain. Add your own sending domain to skip it there.',
      );
    }
    const row = await skipRamp(db, rampId);
    if (!row) throw new ApiError('conflict', 'This warm-up is already finished.');
    await audit(c, access, 'ramp.skipped', 'reputation_ramp', rampId, {
      dailyVolume: input.dailyVolume ?? null,
      ...(shared ? { instanceAdminOverride: true } : {}),
      statusBefore: before.status,
      capBefore: before.cap_today,
      audience: await activeMembers(db, before.channel_id),
    });
    return c.json({ data: await rampResponse(c, row, instanceAdmin) }, 200);
  },
);

sending.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/ramps/{rampId}/restart',
    tags: ['Sending'],
    summary: 'Start warm-up again on a complete or skipped ramp',
    description:
      'The ramp goes back to warming from its start cap (or from the start cap of `pace`), and its ceiling is raised to cover the active Members. What was already sent today counts against today’s cap. Needs `confirm: true`. 409 when the ramp is warming or paused already. Audited as ramp.restarted.',
    request: { params: rampParam, body: jsonBody(RestartRampSchema) },
    responses: {
      200: ok(RampSchema, 'Restarted'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { rampId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireOwned(c, 'reputationRamp', rampId, 'admin');
    const db = env(c).DB;
    const before = await loadRamp(db, rampId);
    const pace = input.pace ? RAMP_PACES[rampKind(before)][input.pace] : null;
    const row = await restartRamp(db, rampId, pace);
    if (!row) throw new ApiError('conflict', 'This warm-up is already running.');
    await audit(c, access, 'ramp.restarted', 'reputation_ramp', rampId, {
      pace: input.pace ?? null,
      startCap: row.start_cap,
      growth: row.growth,
      wasSkipped: before.skipped_at !== null,
    });
    return c.json(
      {
        data: await rampResponse(c, row, await isInstanceAdmin(env(c), access.auth.operatorId)),
      },
      200,
    );
  },
);

// ---- Custom email CSS (the custom_email_css flag) ------------------------------------------

const EMAIL_CSS_OFF = 'Custom email CSS is off for this publication.';

function toEmailCss(row: { css: string; updated_at: number } | null): EmailCss {
  return {
    css: row?.css ?? '',
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
    warnings: row ? lintEmailCss(row.css).warnings : [],
  };
}

sending.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/email-css',
    tags: ['Sending'],
    summary: 'The Channel’s custom email CSS',
    description:
      'The stylesheet every email of the Channel carries (previews and test sends too), with what major mail clients will ignore. 404 feature_disabled when custom_email_css is off.',
    request: { params: channelParam },
    responses: { 200: ok(EmailCssSchema, 'Email CSS'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'viewer');
    await requireFlag(c, access, 'custom_email_css', EMAIL_CSS_OFF);
    const row = await first<{ css: string; updated_at: number }>(
      env(c).DB,
      'SELECT css, updated_at FROM channel_email_css WHERE channel_id = ?1',
      channelId,
    );
    return c.json({ data: toEmailCss(row) }, 200);
  },
);

sending.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/channels/{channelId}/email-css',
    tags: ['Sending'],
    summary: 'Replace the Channel’s custom email CSS',
    description:
      'Lints the stylesheet first: an error refuses it (invalid_input, one detail per problem with its line); warnings are returned and the stylesheet is saved. Simple rules are inlined into each email, the rest goes into a style element.',
    request: { params: channelParam, body: jsonBody(UpdateEmailCssSchema) },
    responses: {
      200: ok(EmailCssSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const { css } = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'admin');
    await requireFlag(c, access, 'custom_email_css', EMAIL_CSS_OFF);
    const db = env(c).DB;
    if (!css.trim()) {
      await run(db, 'DELETE FROM channel_email_css WHERE channel_id = ?1', channelId);
      await audit(c, access, 'channel.email_css_removed', 'channel', channelId);
      return c.json({ data: toEmailCss(null) }, 200);
    }
    const lint = lintEmailCss(css);
    if (!lint.ok) {
      const [only] = lint.errors;
      throw new ApiError(
        'invalid_input',
        lint.errors.length === 1 && only
          ? `Line ${only.line}: ${only.message}`
          : `The stylesheet has ${lint.errors.length} problems.`,
        lint.errors.map((e) => ({ path: 'css', message: `Line ${e.line}: ${e.message}` })),
      );
    }
    const now = Date.now();
    await run(
      db,
      `INSERT INTO channel_email_css (channel_id, css, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (channel_id) DO UPDATE SET css = ?2, updated_by = ?3, updated_at = ?4`,
      channelId,
      css,
      access.auth.operatorId,
      now,
    );
    await audit(c, access, 'channel.email_css_updated', 'channel', channelId, {
      bytes: new TextEncoder().encode(css).length,
    });
    return c.json({ data: toEmailCss({ css, updated_at: now }) }, 200);
  },
);
