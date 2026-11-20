// Deliverability Center: DMARC reports, provider breakdown, complaints, dedicated sending (Phase 7).
// Reads are viewer and up; dedicated sending changes are admin and up. Contract:
// docs/deliverability.md.
import { createRoute } from '@hono/zod-openapi';
import { toIso } from '@swarm/db';
import {
  DedicatedSendingSchema,
  DeliverabilityCheckupSchema,
  DeliverabilityOverviewSchema,
  DeliverabilityRangeQuerySchema,
  DmarcDomainReportSchema,
  DomainHealthSchema,
  idPattern,
  type DedicatedSending,
  type DeliverabilityCheckup,
  type DeliverabilityOverview,
  type DmarcDomainReport,
} from '@swarm/domain';
import {
  DedicatedPlanError,
  channelDmarcTotals,
  channelSending,
  complaintSummary,
  configurationSetAvailable,
  dedicatedIpAvailable,
  dedicatedSending,
  deliverabilityCheckup,
  deliverabilityRange,
  dmarcReportAddress,
  domainDmarcDetail,
  ensureConfigurationSet,
  providerBreakdown,
  rampHistory,
  checkDnsRecords,
  dnsLookup,
  domainSendingTotals,
  recommendedDmarcRecord,
  recordReportsTo,
  refreshDedicatedIp,
  requestDedicatedIp,
  txtResolver,
  type ChannelSendingRow,
  type DayRange,
  type DomainRow,
} from '@swarm/engine';
import {
  checkDomainBlocklists,
  dohLookup,
  type DnsLookup,
  type DomainBlocklistCheck,
} from '@swarm/mail';
import { ApiError, createLogger } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, ok } from '../lib/openapi';
import { engine, requireOwned, toSendingDomain } from '../lib/send';

export const deliverability = createRouter();

const log = createLogger({ service: 'api' });

const channelParam = idParam('channelId', idPattern('channel'));
const domainParam = idParam('domainId', idPattern('sendingDomain'));

const iso = (ms: number | null) => (ms === null ? null : toIso(ms));
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);

function range(query: { from?: string | undefined; to?: string | undefined }): DayRange {
  const result = deliverabilityRange(query);
  if (typeof result === 'string') throw new ApiError('invalid_input', result);
  return result;
}

// ---- Overview and DMARC ------------------------------------------------------------------

deliverability.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/deliverability',
    tags: ['Deliverability'],
    summary: 'Deliverability overview',
    description:
      'For a range of whole UTC days (the last 30 by default, up to 366): DMARC alignment per sending domain from aggregate reports, deliveries by recipient mailbox provider, the complaint rate against Gmail’s 0.1% target and 0.3% ceiling, and Reputation Ramp history.',
    request: { params: channelParam, query: DeliverabilityRangeQuerySchema },
    responses: {
      200: ok(DeliverabilityOverviewSchema, 'Overview'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const days = range(c.req.valid('query'));
    await requireChannel(c, channelId, 'viewer');
    const e = env(c);
    const [domains, providers, ramps] = await Promise.all([
      channelDmarcTotals(e.DB, channelId, days),
      providerBreakdown(e.DB, channelId, days),
      rampHistory(e.DB, channelId, days, engine(c).platformMailDomain),
    ]);
    const data: DeliverabilityOverview = {
      from: days.from,
      to: days.to,
      domains: domains.map((d) => {
        const reportAddress = dmarcReportAddress(d.id, e.DMARC_MAIL_DOMAIN);
        return {
          sendingDomainId: d.id,
          domain: d.domain,
          status: d.status,
          dmarcPolicy: d.dmarc_policy,
          reportAddress,
          recommendedRecord: recommendedDmarcRecord(d.domain, reportAddress),
          lastReportAt: iso(d.last_report_at),
          messages: d.messages,
          aligned: d.aligned,
          alignmentRate: ratio(d.aligned, d.messages),
        };
      }),
      providers,
      complaints: complaintSummary(providers),
      ramps,
    };
    return c.json({ data }, 200);
  },
);

// ---- Check-up ----------------------------------------------------------------------------

/** One DNS question to a blocklist may take this long before it counts as no answer. */
const BLOCKLIST_TIMEOUT_MS = 3000;
/** Blocklist answers are kept this long, so pressing "Run again" does not hammer the lists. */
const BLOCKLIST_CACHE_SECONDS = 15 * 60;

/**
 * The resolver for blocklist questions. Production asks over DNS over HTTPS with a short timeout.
 * Development and test have no network: answers come from KV (`dev:dns:A:<name>`, a JSON list),
 * and with nothing there every list is "couldn't check", which is the honest default.
 */
function blocklistDns(c: AppContext): DnsLookup {
  const e = env(c);
  if (e.DNS_RESOLVER === 'dev') {
    return {
      lookup: async (name, type) =>
        (await e.CACHE.get<string[]>(`dev:dns:${type}:${name}`, 'json')) ?? [],
    };
  }
  return dohLookup((url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(BLOCKLIST_TIMEOUT_MS) }),
  );
}

async function cachedBlocklists(c: AppContext, domain: string): Promise<DomainBlocklistCheck> {
  const e = env(c);
  const key = `checkup:blocklists:v1:${domain}`;
  try {
    const hit = await e.CACHE.get<DomainBlocklistCheck>(key, 'json');
    if (hit?.domain === domain && Array.isArray(hit.results)) return hit;
  } catch {
    // A cache that cannot be read is only a slower check.
  }
  const fresh = await checkDomainBlocklists(domain, blocklistDns(c), {
    timeoutMs: BLOCKLIST_TIMEOUT_MS,
  });
  try {
    await e.CACHE.put(key, JSON.stringify(fresh), { expirationTtl: BLOCKLIST_CACHE_SECONDS });
  } catch {
    // Nor is one that cannot be written.
  }
  return fresh;
}

deliverability.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/deliverability/checkup',
    tags: ['Deliverability'],
    summary: 'Deliverability check-up',
    description:
      'Runs every deliverability check for the Channel and answers with a verdict, a score and findings, most harmful first: sender, sending domain and its DNS records, DMARC policy, reports and alignment, bounce and complaint rates over the last 30 days against Gmail’s 0.1% and 0.3%, mailbox providers that open far less than the rest, warm-up, list hygiene, the footer address and domain blocklists. Each finding says what it means, how to fix it and where. A check that fails is reported as "unknown", never as an error. The score is 100 minus 20 for each problem and 5 for each warning. Each call reads DNS; blocklist answers are cached for 15 minutes.',
    request: { params: channelParam },
    responses: {
      200: ok(DeliverabilityCheckupSchema, 'Check-up'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    const e = env(c);
    const data: DeliverabilityCheckup = await deliverabilityCheckup(
      {
        db: e.DB,
        config: engine(c),
        dns: dnsLookup(e),
        dmarcMailDomain: e.DMARC_MAIL_DOMAIN,
        blocklists: (domain) => cachedBlocklists(c, domain),
        emailCheckEnv: e,
      },
      channelId,
    );
    return c.json({ data }, 200);
  },
);

/** The published _dmarc record, or undefined when DNS could not be read. */
async function publishedDmarc(c: AppContext, domain: string): Promise<string | null | undefined> {
  try {
    const records = await txtResolver(env(c)).txt(`_dmarc.${domain}`);
    return records.find((r) => /^v=DMARC1\s*(;|$)/i.test(r.trim())) ?? null;
  } catch {
    return undefined;
  }
}

deliverability.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/sending-domains/{domainId}/dmarc',
    tags: ['Deliverability'],
    summary: 'DMARC aggregate reports for a sending domain',
    description:
      'Alignment by day, the sources where SPF or DKIM did not align (those failing DMARC first), and who reported. Also reads the published _dmarc record to say whether reports are sent here.',
    request: { params: domainParam, query: DeliverabilityRangeQuerySchema },
    responses: {
      200: ok(DmarcDomainReportSchema, 'Report'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { domainId } = c.req.valid('param');
    const days = range(c.req.valid('query'));
    await requireOwned(c, 'sendingDomain', domainId, 'viewer');
    const e = env(c);
    const row = await e.DB.prepare(
      `SELECT domain FROM sending_domains WHERE id = ?1 AND kind = 'email'`,
    )
      .bind(domainId)
      .first<{ domain: string }>();
    if (!row) throw new ApiError('not_found', 'Sending domain not found.');
    const reportAddress = dmarcReportAddress(domainId, e.DMARC_MAIL_DOMAIN);
    const [detail, published] = await Promise.all([
      domainDmarcDetail(e.DB, domainId, days),
      publishedDmarc(c, row.domain),
    ]);
    const data: DmarcDomainReport = {
      sendingDomainId: domainId,
      domain: row.domain,
      from: days.from,
      to: days.to,
      reportAddress,
      recommendedRecord: recommendedDmarcRecord(row.domain, reportAddress),
      publishedRecord: published ?? null,
      reportsConfigured:
        published === undefined ? null : !!published && recordReportsTo(published, reportAddress),
      lastReportAt: iso(detail.lastReportAt),
      totals: {
        messages: detail.totals.messages,
        aligned: detail.totals.aligned,
        failed: detail.totals.messages - detail.totals.aligned,
        alignmentRate: ratio(detail.totals.aligned, detail.totals.messages),
      },
      byDay: detail.byDay,
      failingSources: detail.failingSources,
      reporters: detail.reporters.map((r) => ({ ...r, lastReportAt: toIso(r.lastReportAt) })),
    };
    return c.json({ data }, 200);
  },
);

deliverability.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/sending-domains/{domainId}/health',
    tags: ['Deliverability'],
    summary: 'A sending domain’s health in one place',
    description:
      'Its verification, what DNS has for each record, its warm-up state, bounce and complaint rates from finished warm-up days, and DMARC alignment. Rates are null when nothing was sent. Each call checks DNS.',
    request: { params: domainParam, query: DeliverabilityRangeQuerySchema },
    responses: {
      200: ok(DomainHealthSchema, 'Health'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { domainId } = c.req.valid('param');
    const days = range(c.req.valid('query'));
    await requireOwned(c, 'sendingDomain', domainId, 'viewer');
    const e = env(c);
    const row = await e.DB.prepare(`SELECT * FROM sending_domains WHERE id = ?1 AND kind = 'email'`)
      .bind(domainId)
      .first<DomainRow>();
    if (!row) throw new ApiError('not_found', 'Sending domain not found.');
    const domain = toSendingDomain(row, e.DMARC_MAIL_DOMAIN);
    const [records, ramp, sending, detail] = await Promise.all([
      checkDnsRecords(domain.records, dnsLookup(e)),
      e.DB.prepare(
        `SELECT status, paused_reason, cap_today FROM reputation_ramps WHERE sending_domain_id = ?1
          ORDER BY created_at DESC LIMIT 1`,
      )
        .bind(domainId)
        .first<{
          status: 'warming' | 'complete' | 'paused';
          paused_reason: string | null;
          cap_today: number;
        }>(),
      domainSendingTotals(e.DB, domainId, days),
      domainDmarcDetail(e.DB, domainId, days),
    ]);
    return c.json(
      {
        data: {
          sendingDomainId: domainId,
          domain: row.domain,
          from: days.from,
          to: days.to,
          status: row.status,
          dmarcPolicy: row.dmarc_policy,
          records,
          ramp: ramp
            ? { status: ramp.status, pausedReason: ramp.paused_reason, capToday: ramp.cap_today }
            : null,
          sending: {
            ...sending,
            bounceRate: ratio(sending.bounces, sending.sent),
            complaintRate: ratio(sending.complaints, sending.sent),
          },
          dmarc: {
            messages: detail.totals.messages,
            aligned: detail.totals.aligned,
            alignmentRate: ratio(detail.totals.aligned, detail.totals.messages),
            lastReportAt: iso(detail.lastReportAt),
          },
        },
      },
      200,
    );
  },
);

// ---- Dedicated sending -------------------------------------------------------------------

function toDedicated(row: ChannelSendingRow, supported: boolean): DedicatedSending {
  return {
    plan: row.plan,
    supported,
    configurationSet: {
      available: configurationSetAvailable(row.plan),
      name: row.ses_configuration_set,
    },
    dedicatedIp: {
      available: dedicatedIpAvailable(row.plan),
      status: row.dedicated_ip_status,
      pool: row.dedicated_ip_pool,
      warmupPercent: row.dedicated_ip_warmup_percent,
      requestedAt: iso(row.dedicated_ip_requested_at),
      checkedAt: iso(row.dedicated_ip_checked_at),
    },
  };
}

async function sendingRow(c: AppContext, channelId: string): Promise<ChannelSendingRow> {
  const row = await channelSending(env(c).DB, channelId);
  if (!row) throw new ApiError('not_found', 'Publication not found.');
  return row;
}

const audit = (
  c: AppContext,
  access: { workspaceId: string; auth: { operatorId: string } },
  action: string,
  channelId: string,
  metadata: Record<string, unknown>,
) =>
  appendAudit(env(c).DB, {
    workspaceId: access.workspaceId,
    actorId: access.auth.operatorId,
    action,
    targetType: 'channel',
    targetId: channelId,
    metadata,
    ipPrefix: ipPrefix(clientIp(c)),
  });

/** Whether the mail provider has configuration sets and dedicated IPs (SES and dev only). */
const dedicatedSupported = (c: AppContext) => dedicatedSending(env(c)) !== null;

/** The provider's dedicated sending, or `unavailable` when it has none. */
function dedicatedProvider(c: AppContext) {
  const dedicated = dedicatedSending(env(c));
  if (!dedicated) throw new ApiError('unavailable', 'Dedicated sending needs Amazon SES.');
  return dedicated;
}

/** Provider failures become `unavailable` (retryable); plan problems are `plan_required`. */
async function provider<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DedicatedPlanError) throw new ApiError('plan_required', error.message);
    if (error instanceof ApiError) throw error;
    log.warn('dedicated sending provider error', { error: (error as Error).message });
    throw new ApiError('unavailable', 'The mail provider did not answer. Try again in a minute.');
  }
}

deliverability.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/dedicated-sending',
    tags: ['Deliverability'],
    summary: 'Dedicated sending: configuration set and dedicated IP',
    request: { params: channelParam },
    responses: {
      200: ok(DedicatedSendingSchema, 'Dedicated sending'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    return c.json(
      { data: toDedicated(await sendingRow(c, channelId), dedicatedSupported(c)) },
      200,
    );
  },
);

deliverability.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/dedicated-sending/configuration-set',
    tags: ['Deliverability'],
    summary: 'Give the Channel its own configuration set',
    description:
      'Paid plans. The Channel’s Broadcasts then go through their own SES configuration set, so its reputation metrics are its own. Also happens on the first send on a paid plan. Idempotent.',
    request: { params: channelParam },
    responses: {
      200: ok(DedicatedSendingSchema, 'Created, or already there'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'admin');
    const dedicated = dedicatedProvider(c);
    const before = await sendingRow(c, channelId);
    const name = await provider(() => ensureConfigurationSet(env(c).DB, dedicated, channelId));
    if (!before.ses_configuration_set) {
      await audit(c, access, 'channel.configuration_set_created', channelId, { name });
    }
    return c.json({ data: toDedicated(await sendingRow(c, channelId), true) }, 200);
  },
);

deliverability.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/dedicated-sending/dedicated-ip',
    tags: ['Deliverability'],
    summary: 'Request a dedicated IP pool',
    description:
      'Pro and up. Creates a managed dedicated IP pool and attaches it to the Channel’s configuration set; the provider warms the IPs up over several weeks (status warming, then active). Costs are passed through at the provider’s price. Idempotent; if the provider is unavailable the request stays requested and is retried.',
    request: { params: channelParam },
    responses: {
      200: ok(DedicatedSendingSchema, 'Requested'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'admin');
    const dedicated = dedicatedProvider(c);
    const before = await sendingRow(c, channelId);
    const { row, error } = await provider(() =>
      requestDedicatedIp(env(c).DB, dedicated, channelId),
    );
    if (error) log.warn('dedicated IP provisioning will be retried', { channelId, error });
    if (before.dedicated_ip_status === 'none') {
      await audit(c, access, 'channel.dedicated_ip_requested', channelId, {
        status: row.dedicated_ip_status,
      });
    }
    return c.json({ data: toDedicated(row, true) }, 200);
  },
);

deliverability.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/dedicated-sending/dedicated-ip/check',
    tags: ['Deliverability'],
    summary: 'Check dedicated IP warm-up now',
    description: 'The send worker also checks every hour.',
    request: { params: channelParam },
    responses: {
      200: ok(DedicatedSendingSchema, 'Checked'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'admin');
    const dedicated = dedicatedProvider(c);
    const row = await provider(() => refreshDedicatedIp(env(c).DB, dedicated, channelId));
    if (!row) throw new ApiError('not_found', 'Publication not found.');
    return c.json({ data: toDedicated(row, true) }, 200);
  },
);
