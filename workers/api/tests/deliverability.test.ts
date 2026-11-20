import { env } from 'cloudflare:test';
import {
  newId,
  type DedicatedSending,
  type DeliverabilityOverview,
  type DmarcDomainReport,
  type SeatRole,
  type SendingDomain,
} from '@swarm/domain';
import { classifyMailbox, configurationSetName, dedicatedPoolName } from '@swarm/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ORIGIN, call, createChannel, json, seatAs, signIn, type Session } from './helpers';

const DMARC_DOMAIN = 'dmarc.swarm.localhost';
const DAY = 86_400_000;
const today = new Date().toISOString().slice(0, 10);
const dayStart = (offset: number) => Date.parse(`${today}T00:00:00Z`) - offset * DAY;

async function data<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await json<{ data: T }>(res)).data;
}

async function addDomain(session: Session, channelId: string) {
  const name = `news-${crypto.randomUUID().slice(0, 8)}.example.com`;
  return data<SendingDomain>(
    await call('POST', `/api/v1/channels/${channelId}/sending-domains`, {
      cookie: session.cookie,
      body: { domain: name, kind: 'email' },
    }),
    201,
  );
}

interface SeedRecord {
  ip: string;
  count: number;
  dkim: boolean;
  spf: boolean;
  disposition?: 'none' | 'quarantine' | 'reject';
}

async function seedReport(
  workspaceId: string,
  domainId: string,
  domain: string,
  org: string,
  beginAt: number,
  rows: SeedRecord[],
) {
  const reportId = newId('dmarcReport');
  const messages = rows.reduce((s, r) => s + r.count, 0);
  const passed = rows.filter((r) => r.dkim || r.spf).reduce((s, r) => s + r.count, 0);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dmarc_reports (id, workspace_id, sending_domain_id, org_name, report_id, begin_at, end_at, policy_json, raw_key, message_count, pass_count, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '{}', 'dmarc/x', ?8, ?9, ?10)`,
    ).bind(
      reportId,
      workspaceId,
      domainId,
      org,
      crypto.randomUUID(),
      beginAt,
      beginAt + DAY - 1,
      messages,
      passed,
      beginAt + DAY,
    ),
    ...rows.map((r) =>
      env.DB.prepare(
        `INSERT INTO dmarc_records (id, report_id, source_ip, count, disposition, dkim_aligned, spf_aligned, header_from)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(
        newId('dmarcRecord'),
        reportId,
        r.ip,
        r.count,
        r.disposition ?? 'none',
        r.dkim ? 1 : 0,
        r.spf ? 1 : 0,
        domain,
      ),
    ),
  ]);
}

/** One Broadcast's deliveries: [address, status, humanOpened]. */
async function seedDeliveries(
  workspaceId: string,
  channelId: string,
  rows: [string, 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed', boolean][],
  sentAt = Date.now(),
) {
  const dispatch = newId('dispatch');
  const broadcast = newId('broadcast');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at) VALUES (?1, ?2, 'S', '{"type":"doc","content":[]}', 'sent', ?3, ?3)`,
    ).bind(dispatch, channelId, sentAt),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text, from_name, from_address, track_opens, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'S', '', '', '', 'F', 'f@mail.swarm.test', 1, ?5, ?5)`,
    ).bind(broadcast, dispatch, channelId, workspaceId, sentAt),
    ...rows.map(([email, status, opened], i) =>
      env.DB.prepare(
        `INSERT INTO deliveries (id, broadcast_id, channel_id, email, status, sent_at, delivered_at, human_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(
        newId('delivery'),
        broadcast,
        channelId,
        email.replace('@', `+${i}@`),
        status,
        sentAt,
        status === 'delivered' || status === 'complained' ? sentAt : null,
        opened ? sentAt : null,
      ),
    ),
  ]);
}

const setPlan = (workspaceId: string, plan: string) =>
  env.DB.prepare('UPDATE workspaces SET plan = ?1 WHERE id = ?2').bind(plan, workspaceId).run();

describe('recommended DMARC record', () => {
  it('sends aggregate reports to the domain’s own address, for new and existing domains', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const domain = await addDomain(owner, channelId);
    const address = `dmarc+${domain.id}@${DMARC_DOMAIN}`;
    const expected = `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:${address}`;
    expect(domain.records.find((r) => r.purpose === 'dmarc')?.value).toBe(expected);

    // A domain added before Phase 7 stored the old shared address; it is shown the new one.
    await env.DB.prepare(
      `UPDATE sending_domains SET records_json = json_set(records_json, '$[#-1].value', 'v=DMARC1; p=quarantine; rua=mailto:dmarc@unsubscribe.swarm.localhost') WHERE id = ?1`,
    )
      .bind(domain.id)
      .run();
    const listed = await data<SendingDomain[]>(
      await call('GET', `/api/v1/channels/${channelId}/sending-domains`, { cookie: owner.cookie }),
    );
    expect(listed[0]!.records.find((r) => r.purpose === 'dmarc')?.value).toBe(expected);
  });
});

describe('Deliverability Center', () => {
  let owner: Session;
  let channelId: string;
  let domain: SendingDomain;

  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
    domain = await addDomain(owner, channelId);
    const ws = owner.workspaceId;
    await seedReport(ws, domain.id, domain.domain, 'google.com', dayStart(2), [
      { ip: '54.240.27.16', count: 900, dkim: true, spf: true },
      { ip: '203.0.113.7', count: 12, dkim: false, spf: false, disposition: 'quarantine' },
      { ip: '2a01:111:f400:fe0c::300', count: 3, dkim: true, spf: false },
    ]);
    await seedReport(ws, domain.id, domain.domain, 'Enterprise Outlook', dayStart(1), [
      { ip: '54.240.27.17', count: 85, dkim: true, spf: true },
      { ip: '203.0.113.7', count: 8, dkim: false, spf: false, disposition: 'quarantine' },
    ]);
    // Outside the default 30 days.
    await seedReport(ws, domain.id, domain.domain, 'Yahoo', dayStart(60), [
      { ip: '198.51.100.1', count: 1000, dkim: false, spf: false },
    ]);

    const rows: [string, 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed', boolean][] =
      [];
    // Gmail: 1000 delivered (incl. 4 complaints), 10 bounced, 300 opened.
    for (let i = 0; i < 996; i++) rows.push(['a@gmail.com', 'delivered', i < 300]);
    for (let i = 0; i < 4; i++) rows.push(['a@googlemail.com', 'complained', false]);
    for (let i = 0; i < 10; i++) rows.push(['a@gmail.com', 'bounced', false]);
    // Outlook: 500 delivered, 1 complaint (0.2%).
    for (let i = 0; i < 499; i++) rows.push(['a@hotmail.co.uk', 'delivered', i < 20]);
    rows.push(['a@live.com', 'complained', false]);
    // Yahoo and Apple, a failed send, and an unknown domain.
    for (let i = 0; i < 50; i++) rows.push([i % 2 ? 'a@yahoo.com' : 'a@aol.com', 'sent', false]);
    for (let i = 0; i < 40; i++)
      rows.push([['a@icloud.com', 'a@me.com', 'a@mac.com'][i % 3]!, 'delivered', true]);
    rows.push(['a@gmail.com', 'failed', false]);
    rows.push(['a@example.org', 'delivered', false]);
    await seedDeliveries(ws, channelId, rows);
    // Old mail does not count in the default range.
    await seedDeliveries(ws, channelId, [['a@gmail.com', 'complained', false]], dayStart(100));
  });

  it('summarises DMARC alignment per domain', async () => {
    const overview = await data<DeliverabilityOverview>(
      await call('GET', `/api/v1/channels/${channelId}/deliverability`, { cookie: owner.cookie }),
    );
    expect(overview.to).toBe(today);
    expect(overview.domains).toEqual([
      expect.objectContaining({
        sendingDomainId: domain.id,
        reportAddress: `dmarc+${domain.id}@${DMARC_DOMAIN}`,
        messages: 1008,
        aligned: 988,
        alignmentRate: 988 / 1008,
        lastReportAt: expect.any(String),
        recommendedRecord: expect.objectContaining({ name: `_dmarc.${domain.domain}` }),
      }),
    ]);
  });

  it('breaks deliveries down by mailbox provider with complaint rates', async () => {
    const { providers, complaints } = await data<DeliverabilityOverview>(
      await call('GET', `/api/v1/channels/${channelId}/deliverability`, { cookie: owner.cookie }),
    );
    const by = Object.fromEntries(providers.map((p) => [p.provider, p]));
    expect(providers.map((p) => p.provider)).toEqual([
      'gmail',
      'outlook',
      'yahoo',
      'apple',
      'other',
    ]);
    expect(by.gmail).toMatchObject({
      sent: 1010,
      delivered: 1000,
      bounced: 10,
      complained: 4,
      opened: 300,
      complaintRate: 0.004,
      complaintStanding: 'over',
    });
    expect(by.outlook).toMatchObject({
      sent: 500,
      delivered: 500,
      complained: 1,
      opened: 20,
      complaintStanding: 'watch',
    });
    expect(by.yahoo).toMatchObject({
      sent: 50,
      delivered: 0,
      complaintRate: null,
      complaintStanding: 'good',
    });
    expect(by.apple).toMatchObject({ sent: 40, delivered: 40, opened: 40, openRate: 1 });
    expect(by.other).toMatchObject({ sent: 1, delivered: 1 });
    expect(complaints).toMatchObject({
      delivered: 1541,
      complained: 5,
      target: 0.001,
      threshold: 0.003,
      standing: 'over',
    });
    expect(complaints.rate).toBeCloseTo(5 / 1541);
  });

  it('classifies providers in SQL exactly like classifyMailbox', async () => {
    const domains = [
      'gmail.com',
      'googlemail.com',
      'GMAIL.COM',
      'outlook.com',
      'hotmail.com',
      'hotmail.co.uk',
      'live.com.au',
      'outlook.fr',
      'msn.com',
      'yahoo.com',
      'yahoo.co.jp',
      'ymail.com',
      'aol.com',
      'aol.de',
      'rocketmail.com',
      'icloud.com',
      'me.com',
      'mac.com',
      'live.example.com',
      'gmail.com.evil.example',
      'example.org',
      'mail.yahoo.com',
    ];
    const { id: other } = await createChannel(owner);
    await seedDeliveries(
      owner.workspaceId,
      other,
      domains.map((d) => [`x@${d}`, 'delivered', false]),
    );
    const { providers } = await data<DeliverabilityOverview>(
      await call('GET', `/api/v1/channels/${other}/deliverability`, { cookie: owner.cookie }),
    );
    const expected: Record<string, number> = {};
    for (const d of domains)
      expected[classifyMailbox(`x@${d}`)] = (expected[classifyMailbox(`x@${d}`)] ?? 0) + 1;
    expect(
      Object.fromEntries(providers.filter((p) => p.sent).map((p) => [p.provider, p.sent])),
    ).toEqual(expected);
    expect(expected).toEqual({ gmail: 3, outlook: 6, yahoo: 6, apple: 3, other: 4 });
  });

  it('reports a domain’s failing sources, days and reporters', async () => {
    const report = await data<DmarcDomainReport>(
      await call('GET', `/api/v1/sending-domains/${domain.id}/dmarc`, { cookie: owner.cookie }),
    );
    expect(report.totals).toEqual({
      messages: 1008,
      aligned: 988,
      failed: 20,
      alignmentRate: 988 / 1008,
    });
    expect(report.byDay).toHaveLength(2);
    expect(report.byDay[0]).toEqual({
      day: new Date(dayStart(2)).toISOString().slice(0, 10),
      aligned: 903,
      failed: 12,
    });
    // DMARC failures first (merged across reports), then partial alignment.
    expect(report.failingSources).toEqual([
      {
        sourceIp: '203.0.113.7',
        count: 20,
        disposition: 'quarantine',
        dmarcPass: false,
        spfAligned: false,
        dkimAligned: false,
        headerFrom: domain.domain,
        reporters: ['Enterprise Outlook', 'google.com'],
      },
      expect.objectContaining({
        sourceIp: '2a01:111:f400:fe0c::300',
        dmarcPass: true,
        dkimAligned: true,
        spfAligned: false,
      }),
    ]);
    expect(report.reporters.map((r) => r.orgName)).toEqual(['google.com', 'Enterprise Outlook']);
    // The dev resolver publishes p=quarantine without a rua: reports are not set up there.
    expect(report.publishedRecord).toBe('v=DMARC1; p=quarantine');
    expect(report.reportsConfigured).toBe(false);

    const wide = await data<DmarcDomainReport>(
      await call(
        'GET',
        `/api/v1/sending-domains/${domain.id}/dmarc?from=${new Date(dayStart(90)).toISOString().slice(0, 10)}&to=${today}`,
        { cookie: owner.cookie },
      ),
    );
    expect(wide.totals.messages).toBe(2008);
  });

  it('shows Reputation Ramp history without creating ramps', async () => {
    const { id: fresh } = await createChannel(owner);
    const empty = await data<DeliverabilityOverview>(
      await call('GET', `/api/v1/channels/${fresh}/deliverability`, { cookie: owner.cookie }),
    );
    expect(empty.ramps).toEqual([]);
    const count = await env.DB.prepare(
      'SELECT count(*) AS n FROM reputation_ramps WHERE channel_id = ?1',
    )
      .bind(fresh)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);

    const rampId = newId('reputationRamp');
    const yesterday = new Date(dayStart(1)).toISOString().slice(0, 10);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO reputation_ramps (id, channel_id, status, day, cap_today, sent_today, start_cap, growth, max_cap, bounce_threshold, complaint_threshold, created_at, updated_at)
         VALUES (?1, ?2, 'warming', ?3, 150, 40, 100, 1.5, 5000, 0.02, 0.0008, 0, 0)`,
      ).bind(rampId, fresh, today),
      env.DB.prepare(
        `INSERT INTO reputation_ramp_days (ramp_id, day, cap, sent, bounces, complaints) VALUES (?1, ?2, 100, 100, 3, 1)`,
      ).bind(rampId, yesterday),
    ]);
    const { ramps } = await data<DeliverabilityOverview>(
      await call('GET', `/api/v1/channels/${fresh}/deliverability`, { cookie: owner.cookie }),
    );
    expect(ramps).toEqual([
      {
        rampId,
        sendingDomainId: null,
        domain: expect.any(String),
        status: 'warming',
        pausedReason: null,
        days: [
          {
            day: yesterday,
            cap: 100,
            sent: 100,
            bounces: 3,
            complaints: 1,
            bounceRate: 0.03,
            complaintRate: 0.01,
          },
          {
            day: today,
            cap: 150,
            sent: 40,
            bounces: 0,
            complaints: 0,
            bounceRate: null,
            complaintRate: null,
          },
        ],
      },
    ]);
  });

  it('refuses ranges over 366 days and impossible dates', async () => {
    for (const query of [
      'from=2024-01-01&to=2026-01-01',
      'from=2026-10-10&to=2026-10-01',
      'from=2026-02-30',
    ]) {
      const res = await call('GET', `/api/v1/channels/${channelId}/deliverability?${query}`, {
        cookie: owner.cookie,
      });
      expect(res.status, query).toBe(400);
    }
  });
});

describe('dedicated sending', () => {
  it('is plan_required on free and creates a configuration set on paid plans', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const free = await data<DedicatedSending>(
      await call('GET', `/api/v1/channels/${channelId}/dedicated-sending`, {
        cookie: owner.cookie,
      }),
    );
    expect(free).toMatchObject({
      plan: 'free',
      configurationSet: { available: false, name: null },
      dedicatedIp: { available: false, status: 'none' },
    });
    for (const path of ['configuration-set', 'dedicated-ip']) {
      const res = await call('POST', `/api/v1/channels/${channelId}/dedicated-sending/${path}`, {
        cookie: owner.cookie,
      });
      expect(res.status, path).toBe(403);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('plan_required');
    }

    await setPlan(owner.workspaceId, 'pro');
    const created = await data<DedicatedSending>(
      await call('POST', `/api/v1/channels/${channelId}/dedicated-sending/configuration-set`, {
        cookie: owner.cookie,
      }),
    );
    expect(created.configurationSet).toEqual({
      available: true,
      name: configurationSetName(channelId),
    });
    // Idempotent.
    const again = await data<DedicatedSending>(
      await call('POST', `/api/v1/channels/${channelId}/dedicated-sending/configuration-set`, {
        cookie: owner.cookie,
      }),
    );
    expect(again.configurationSet.name).toBe(configurationSetName(channelId));
    const audit = await env.DB.prepare(
      `SELECT count(*) AS n FROM audit_events WHERE workspace_id = ?1 AND action = 'channel.configuration_set_created'`,
    )
      .bind(owner.workspaceId)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it('requests a dedicated IP pool on Pro and follows it to active', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    await setPlan(owner.workspaceId, 'pro');
    const requested = await data<DedicatedSending>(
      await call('POST', `/api/v1/channels/${channelId}/dedicated-sending/dedicated-ip`, {
        cookie: owner.cookie,
      }),
    );
    expect(requested.configurationSet.name).toBe(configurationSetName(channelId));
    expect(requested.dedicatedIp).toMatchObject({
      available: true,
      status: 'warming',
      pool: dedicatedPoolName(channelId),
      warmupPercent: 0,
      requestedAt: expect.any(String),
    });
    const checked = await data<DedicatedSending>(
      await call('POST', `/api/v1/channels/${channelId}/dedicated-sending/dedicated-ip/check`, {
        cookie: owner.cookie,
      }),
    );
    // The dev provider reports every pool as warmed up.
    expect(checked.dedicatedIp).toMatchObject({ status: 'active', warmupPercent: 100 });
    // Asking again changes nothing.
    const again = await data<DedicatedSending>(
      await call('POST', `/api/v1/channels/${channelId}/dedicated-sending/dedicated-ip`, {
        cookie: owner.cookie,
      }),
    );
    expect(again.dedicatedIp.status).toBe('active');
  });

  it('is unsupported with Resend: reads say so, changes answer unavailable', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    await setPlan(owner.workspaceId, 'pro');
    const resend = { ...env, MAIL_ADAPTER: 'resend', RESEND_API_KEY: 're_test_key_123456' };
    const request = (method: string, path: string) =>
      createApp().request(
        `/api/v1/channels/${channelId}/dedicated-sending${path}`,
        { method, headers: { cookie: owner.cookie, origin: ORIGIN } },
        resend,
      );
    const read = await data<DedicatedSending>(await request('GET', ''));
    expect(read).toMatchObject({ plan: 'pro', supported: false });
    for (const path of ['/configuration-set', '/dedicated-ip', '/dedicated-ip/check']) {
      const res = await request('POST', path);
      expect(res.status, path).toBe(503);
      expect(await json<{ error: { code: string; message: string } }>(res)).toMatchObject({
        error: { code: 'unavailable', message: 'Dedicated sending needs Amazon SES.' },
      });
    }
    // With SES (dev here) it is supported.
    const ses = await data<DedicatedSending>(
      await call('GET', `/api/v1/channels/${channelId}/dedicated-sending`, {
        cookie: owner.cookie,
      }),
    );
    expect(ses.supported).toBe(true);
  });
});

describe('Deliverability roles and tenancy', () => {
  const ROLES: SeatRole[] = ['viewer', 'author', 'editor', 'admin', 'owner'];
  let owner: Session;
  let outsider: Session;
  let channelId: string;
  let domainId: string;
  const seats = {} as Record<SeatRole, Session>;

  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
    domainId = (await addDomain(owner, channelId)).id;
    await setPlan(owner.workspaceId, 'scale');
    seats.owner = owner;
    for (const role of ['viewer', 'author', 'editor', 'admin'] as const) {
      seats[role] = await seatAs(owner.workspaceId, role);
    }
    outsider = await signIn();
    await setPlan(outsider.workspaceId, 'scale');
  });

  const ROUTES: { name: string; method: string; path: () => string; minimum: SeatRole }[] = [
    {
      name: 'overview',
      method: 'GET',
      path: () => `/api/v1/channels/${channelId}/deliverability`,
      minimum: 'viewer',
    },
    {
      name: 'domain DMARC',
      method: 'GET',
      path: () => `/api/v1/sending-domains/${domainId}/dmarc`,
      minimum: 'viewer',
    },
    {
      name: 'dedicated sending',
      method: 'GET',
      path: () => `/api/v1/channels/${channelId}/dedicated-sending`,
      minimum: 'viewer',
    },
    {
      name: 'configuration set',
      method: 'POST',
      path: () => `/api/v1/channels/${channelId}/dedicated-sending/configuration-set`,
      minimum: 'admin',
    },
    {
      name: 'dedicated IP',
      method: 'POST',
      path: () => `/api/v1/channels/${channelId}/dedicated-sending/dedicated-ip`,
      minimum: 'admin',
    },
    {
      name: 'warm-up check',
      method: 'POST',
      path: () => `/api/v1/channels/${channelId}/dedicated-sending/dedicated-ip/check`,
      minimum: 'admin',
    },
  ];

  it('enforces the minimum role on every route', async () => {
    for (const route of ROUTES) {
      for (const role of ROLES) {
        const res = await call(route.method, route.path(), { cookie: seats[role].cookie });
        const allowed = ROLES.indexOf(role) >= ROLES.indexOf(route.minimum);
        expect(res.status, `${route.name} as ${role}`).toBe(allowed ? 200 : 403);
      }
    }
  });

  it('answers 404 to another workspace and 401 without a session', async () => {
    for (const route of ROUTES) {
      const res = await call(route.method, route.path(), { cookie: outsider.cookie });
      expect(res.status, route.name).toBe(404);
      const anonymous = await call(route.method, route.path());
      expect(anonymous.status, route.name).toBe(401);
    }
    const untouched = await env.DB.prepare('SELECT dedicated_ip_status FROM channels WHERE id = ?1')
      .bind(channelId)
      .first<{ dedicated_ip_status: string }>();
    // Only this workspace's admins changed it (in the role test); the outsider never could.
    expect(['none', 'warming', 'active']).toContain(untouched?.dedicated_ip_status);
  });
});
