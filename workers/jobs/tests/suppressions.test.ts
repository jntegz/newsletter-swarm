import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import {
  addManualSuppression,
  applySesEvent,
  checkRampHealth,
  isSuppressedFor,
  removeSuppression,
  suppressionList,
  syncProviderSuppressions,
  type SesEvent,
  type SuppressionRow,
} from '@swarm/engine';
import {
  DevSuppressionList,
  SesError,
  devSuppressedDestinations,
  devSuppressionCalls,
  devSuppressionFailures,
  type SuppressionList,
} from '@swarm/mail';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MINUTE_CRON } from '../src/crons';
import { runScheduled } from '../src/index';
import { makeAdmin } from './flows-helpers';
import { addMember, jobsEnv, seedChannel } from './helpers';

const email = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}@example.com`;

const queued = (address: string) =>
  env.DB.prepare('SELECT * FROM provider_suppression_sync WHERE email = ?1')
    .bind(address)
    .first<{ action: string; reason: string | null; status: string; attempts: number }>();

const memberStatus = async (id: string) =>
  (
    await env.DB.prepare('SELECT status FROM members WHERE id = ?1')
      .bind(id)
      .first<{ status: string }>()
  )?.status;

async function seedBroadcast(channelId: string, workspaceId: string, rampId: string | null) {
  const now = Date.now();
  const dispatch = newId('dispatch', now);
  const broadcast = newId('broadcast', now);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at) VALUES (?1, ?2, 'S', '{"type":"doc","content":[]}', 'sent', ?3, ?3)`,
    ).bind(dispatch, channelId, now),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text, from_name, from_address, track_opens, ramp_id, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'S', '', '', '', 'F', 'f@mail.swarm.test', 1, ?5, ?6, ?6)`,
    ).bind(broadcast, dispatch, channelId, workspaceId, rampId, now),
  ]);
  return broadcast;
}

async function seedDelivery(channelId: string, broadcast: string, memberId: string, to: string) {
  const id = newId('delivery');
  await env.DB.prepare(
    `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, provider_message_id, status, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'sent', ?7)`,
  )
    .bind(id, broadcast, channelId, memberId, to, `ses-${id}`, Date.now())
    .run();
  return id;
}

const bounce = (deliveryId: string, to: string, subType = 'General'): SesEvent => ({
  eventType: 'Bounce',
  mail: { tags: { delivery: [deliveryId] } },
  bounce: {
    bounceType: 'Permanent',
    bounceSubType: subType,
    bouncedRecipients: [{ emailAddress: to }],
  },
});

beforeEach(() => {
  devSuppressionCalls.length = 0;
  devSuppressedDestinations.clear();
  devSuppressionFailures.clear();
});

describe('SES suppression list sync', () => {
  it('queues hard bounces, not complaints, and pushes them to SES on the minute cron', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const bounced = email('bounced');
    const complained = email('complained');
    const fromSes = email('listed');
    const broadcast = await seedBroadcast(channelId, workspaceId, null);
    for (const [to, event] of [
      [bounced, (d: string) => bounce(d, bounced)],
      [fromSes, (d: string) => bounce(d, fromSes, 'OnAccountSuppressionList')],
      [
        complained,
        (d: string): SesEvent => ({
          eventType: 'Complaint',
          mail: { tags: { delivery: [d] } },
          complaint: { complainedRecipients: [{ emailAddress: complained }] },
        }),
      ],
    ] as [string, (d: string) => SesEvent][]) {
      const member = await addMember(channelId, to);
      await applySesEvent(env.DB, event(await seedDelivery(channelId, broadcast, member, to)));
    }
    expect(await queued(bounced)).toMatchObject({ action: 'put', reason: 'BOUNCE' });
    // A complaint is this workspace's matter: suppressed here, never put on the shared list.
    expect(await queued(complained)).toBeNull();
    expect(await isSuppressedFor(env.DB, workspaceId, channelId, complained)).toBe(true);
    // SES told us about it; nothing to push back.
    expect(await queued(fromSes)).toBeNull();

    const { env: jobs } = jobsEnv();
    await runScheduled(jobs, MINUTE_CRON, Date.now());
    expect(devSuppressedDestinations.get(bounced)?.reason).toBe('BOUNCE');
    expect(devSuppressedDestinations.has(complained)).toBe(false);
    expect(await queued(bounced)).toBeNull();
    // Idempotent: a second run has nothing to do.
    const calls = devSuppressionCalls.length;
    await syncProviderSuppressions(env.DB, suppressionList(jobs), Date.now());
    expect(devSuppressionCalls.length).toBe(calls);
  });

  it('retries provider errors with backoff and gives up on rejections', async () => {
    const now = Date.now();
    const flaky = email('flaky');
    const rejected = email('rejected');
    for (const address of [flaky, rejected]) {
      await env.DB.prepare(
        `INSERT INTO provider_suppression_sync (email, action, reason, next_attempt_at, created_at, updated_at)
         VALUES (?1, 'put', 'BOUNCE', ?2, ?2, ?2)`,
      )
        .bind(address, now - 1)
        .run();
    }
    devSuppressionFailures.add(flaky);
    const dev = new DevSuppressionList();
    const provider: SuppressionList = {
      putSuppressed: (address, reason) => {
        if (address === rejected) throw new SesError(400, 'BadRequestException', 'no');
        return dev.putSuppressed(address, reason);
      },
      deleteSuppressed: (address) => dev.deleteSuppressed(address),
      listSuppressed: (input) => dev.listSuppressed(input),
    };
    const first = await syncProviderSuppressions(env.DB, provider, now);
    expect(first).toMatchObject({ retrying: 1, failed: 1 });
    expect(await queued(flaky)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await queued(rejected)).toMatchObject({ status: 'failed', attempts: 1 });
    // Not due yet; then due after the backoff.
    expect((await syncProviderSuppressions(env.DB, provider, now + 1)).applied).toBe(0);
    expect((await syncProviderSuppressions(env.DB, provider, now + 60_000)).applied).toBe(1);
    expect(devSuppressedDestinations.has(flaky)).toBe(true);
    expect(await queued(flaky)).toBeNull();
  });

  it('removes a manually removed hard bounce from SES, whatever another workspace holds', async () => {
    const a = await seedChannel();
    const b = await seedChannel();
    const shared = email('shared');
    const broadcastA = await seedBroadcast(a.channelId, a.workspaceId, null);
    const broadcastB = await seedBroadcast(b.channelId, b.workspaceId, null);
    const ma = await addMember(a.channelId, shared);
    await applySesEvent(
      env.DB,
      bounce(await seedDelivery(a.channelId, broadcastA, ma, shared), shared),
    );
    const mb = await addMember(b.channelId, shared);
    await applySesEvent(
      env.DB,
      bounce(await seedDelivery(b.channelId, broadcastB, mb, shared), shared),
    );
    const { env: jobs } = jobsEnv();
    await syncProviderSuppressions(env.DB, suppressionList(jobs), Date.now());
    expect(devSuppressedDestinations.has(shared)).toBe(true);

    const row = await env.DB.prepare(
      'SELECT * FROM suppressions WHERE workspace_id = ?1 AND email = ?2',
    )
      .bind(a.workspaceId, shared)
      .first<SuppressionRow>();
    await removeSuppression(env.DB, row!);
    expect(await queued(shared)).toMatchObject({ action: 'delete' });
    const result = await syncProviderSuppressions(env.DB, suppressionList(jobs), Date.now());
    // Applied, not skipped: a skip would tell workspace A that workspace B holds the address.
    expect(result).toMatchObject({ applied: 1, skipped: 0 });
    expect(devSuppressedDestinations.has(shared)).toBe(false);
    // Workspace B's own suppression still stops B's sends.
    expect(await isSuppressedFor(env.DB, b.workspaceId, b.channelId, shared)).toBe(true);
    expect(await isSuppressedFor(env.DB, a.workspaceId, a.channelId, shared)).toBe(false);
  });

  it('drops complaint rows queued before complaints stopped going to SES', async () => {
    const now = Date.now();
    const old = email('old-complaint');
    await env.DB.prepare(
      `INSERT INTO provider_suppression_sync (email, action, reason, next_attempt_at, created_at, updated_at)
       VALUES (?1, 'put', 'COMPLAINT', ?2, ?2, ?2)`,
    )
      .bind(old, now - 1)
      .run();
    const { env: jobs } = jobsEnv();
    const result = await syncProviderSuppressions(env.DB, suppressionList(jobs), now);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(await queued(old)).toBeNull();
    expect(devSuppressedDestinations.has(old)).toBe(false);
    expect(devSuppressionCalls.some((call) => JSON.stringify(call).includes(old))).toBe(false);
  });

  it('one workspace’s bounce or complaint never changes another workspace’s subscribers', async () => {
    const a = await seedChannel();
    const b = await seedChannel();
    const bounced = email('cross-bounced');
    const complained = email('cross-complained');
    const broadcastA = await seedBroadcast(a.channelId, a.workspaceId, null);
    const inB = new Map<string, string>();
    for (const to of [bounced, complained]) inB.set(to, await addMember(b.channelId, to));
    const mBounced = await addMember(a.channelId, bounced);
    await applySesEvent(
      env.DB,
      bounce(await seedDelivery(a.channelId, broadcastA, mBounced, bounced), bounced),
    );
    const mComplained = await addMember(a.channelId, complained);
    const d = await seedDelivery(a.channelId, broadcastA, mComplained, complained);
    await applySesEvent(env.DB, {
      eventType: 'Complaint',
      mail: { tags: { delivery: [d] } },
      complaint: { complainedRecipients: [{ emailAddress: complained }] },
    });
    // Every cron, including the five-minute one that used to read the SES list back.
    const { env: jobs } = jobsEnv();
    await runScheduled(jobs, MINUTE_CRON, Date.now());
    await runScheduled(jobs, '*/5 * * * *', Date.now());
    for (const to of [bounced, complained]) {
      expect(await memberStatus(inB.get(to)!)).toBe('active');
      expect(await isSuppressedFor(env.DB, b.workspaceId, b.channelId, to)).toBe(false);
    }
    // No member.unsubscribed for workspace B either.
    const events = await env.DB.prepare(
      "SELECT count(*) AS n FROM platform_events WHERE workspace_id = ?1 AND type = 'member.unsubscribed'",
    )
      .bind(b.workspaceId)
      .first<{ n: number }>();
    expect(events?.n).toBe(0);
  });

  it('a send SES refuses from its list suppresses the address in the sending workspace only', async () => {
    const a = await seedChannel();
    const b = await seedChannel();
    const listed = email('on-list');
    devSuppressedDestinations.set(listed, { reason: 'BOUNCE', updatedAt: Date.now() });
    const ma = await addMember(a.channelId, listed);
    const mb = await addMember(b.channelId, listed);
    const broadcastB = await seedBroadcast(b.channelId, b.workspaceId, null);
    await applySesEvent(
      env.DB,
      bounce(
        await seedDelivery(b.channelId, broadcastB, mb, listed),
        listed,
        'OnAccountSuppressionList',
      ),
    );
    expect(await memberStatus(mb)).toBe('bounced');
    expect(await isSuppressedFor(env.DB, b.workspaceId, b.channelId, listed)).toBe(true);
    expect(await memberStatus(ma)).toBe('active');
    expect(await isSuppressedFor(env.DB, a.workspaceId, a.channelId, listed)).toBe(false);
    // SES told us; nothing goes back.
    expect(await queued(listed)).toBeNull();
  });

  it("keeps another workspace's queued put when one workspace removes the address", async () => {
    const a = await seedChannel();
    const b = await seedChannel();
    const shared = email('shared');
    const broadcastA = await seedBroadcast(a.channelId, a.workspaceId, null);
    const broadcastB = await seedBroadcast(b.channelId, b.workspaceId, null);
    // Both bounce before the minute cron runs, so the put to SES is still queued.
    const ma = await addMember(a.channelId, shared);
    await applySesEvent(
      env.DB,
      bounce(await seedDelivery(a.channelId, broadcastA, ma, shared), shared),
    );
    const mb = await addMember(b.channelId, shared);
    await applySesEvent(
      env.DB,
      bounce(await seedDelivery(b.channelId, broadcastB, mb, shared), shared),
    );
    const row = await env.DB.prepare(
      'SELECT * FROM suppressions WHERE workspace_id = ?1 AND email = ?2',
    )
      .bind(a.workspaceId, shared)
      .first<SuppressionRow>();
    await removeSuppression(env.DB, row!);
    expect(await queued(shared)).toMatchObject({ action: 'put', reason: 'BOUNCE' });

    const { env: jobs } = jobsEnv();
    await syncProviderSuppressions(env.DB, suppressionList(jobs), Date.now());
    // Workspace B still suppresses the address, so SES must list it.
    expect(devSuppressedDestinations.get(shared)?.reason).toBe('BOUNCE');

    // Once B removes it too, the removal is queued and applied.
    const rowB = await env.DB.prepare(
      'SELECT * FROM suppressions WHERE workspace_id = ?1 AND email = ?2',
    )
      .bind(b.workspaceId, shared)
      .first<SuppressionRow>();
    await removeSuppression(env.DB, rowB!);
    expect(await queued(shared)).toMatchObject({ action: 'delete' });
    await syncProviderSuppressions(env.DB, suppressionList(jobs), Date.now());
    expect(devSuppressedDestinations.has(shared)).toBe(false);
  });

  it('refuses to remove complaints', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const to = email('complaint');
    const broadcast = await seedBroadcast(channelId, workspaceId, null);
    const m = await addMember(channelId, to);
    const d = await seedDelivery(channelId, broadcast, m, to);
    await applySesEvent(env.DB, {
      eventType: 'Complaint',
      mail: { tags: { delivery: [d] } },
      complaint: { complainedRecipients: [{ emailAddress: to }] },
    });
    const row = await env.DB.prepare('SELECT * FROM suppressions WHERE email = ?1')
      .bind(to)
      .first<SuppressionRow>();
    await expect(removeSuppression(env.DB, row!)).rejects.toThrow(/spam/);
  });
});

describe('suppressions on Resend, which has no list to sync', () => {
  const resendJobs = () => ({
    ...jobsEnv().env,
    MAIL_ADAPTER: 'resend' as const,
    RESEND_API_KEY: 're_test_key',
  });
  const sentToAws = (fetchSpy: { mock: { calls: unknown[][] } }) =>
    fetchSpy.mock.calls.filter(([input]) => String(input).includes('amazonaws.com'));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a bounce and a removal clear the queue on the minute cron, with nothing sent to AWS', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { workspaceId, channelId } = await seedChannel();
    const bounced = email('resend-bounced');
    const removed = email('resend-removed');
    const stuck = email('resend-stuck');
    const broadcast = await seedBroadcast(channelId, workspaceId, null);
    for (const to of [bounced, removed]) {
      const member = await addMember(channelId, to);
      await applySesEvent(env.DB, bounce(await seedDelivery(channelId, broadcast, member, to), to));
    }
    const row = await env.DB.prepare('SELECT * FROM suppressions WHERE email = ?1')
      .bind(removed)
      .first<SuppressionRow>();
    await removeSuppression(env.DB, row!);
    expect(await queued(removed)).toMatchObject({ action: 'delete' });
    // Left behind by a run from before this was fixed.
    await env.DB.prepare(
      `INSERT INTO provider_suppression_sync (email, action, reason, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?1, 'put', 'BOUNCE', 'failed', 8, 0, 0, 0)`,
    )
      .bind(stuck)
      .run();

    await runScheduled(resendJobs(), MINUTE_CRON, Date.now());

    for (const address of [bounced, removed, stuck]) expect(await queued(address)).toBeNull();
    expect(sentToAws(fetchSpy)).toEqual([]);
    // Swarm's own suppression still stands.
    expect(await isSuppressedFor(env.DB, workspaceId, channelId, bounced)).toBe(true);
  });

  it('the five-minute cron does not read a list', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await runScheduled(resendJobs(), '*/5 * * * *', Date.now());
    expect(sentToAws(fetchSpy)).toEqual([]);
  });
});

describe('Channel-scoped suppressions', () => {
  it('stop one Channel only', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const other = newId('channel');
    await env.DB.prepare(
      "INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, 'Other', 0, 0)",
    )
      .bind(other, workspaceId, `ch-${crypto.randomUUID().slice(0, 12)}`)
      .run();
    const to = email('scoped');
    const first = await addManualSuppression(env.DB, { workspaceId, channelId, email: to });
    expect(first.created).toBe(true);
    expect(
      (await addManualSuppression(env.DB, { workspaceId, channelId, email: to })).created,
    ).toBe(false);
    expect(await isSuppressedFor(env.DB, workspaceId, channelId, to)).toBe(true);
    expect(await isSuppressedFor(env.DB, workspaceId, other, to)).toBe(false);
    // A workspace-wide row for the same address can sit next to it.
    await addManualSuppression(env.DB, { workspaceId, channelId: null, email: to });
    expect(await isSuppressedFor(env.DB, workspaceId, other, to)).toBe(true);
    // Manual rows never reach SES.
    expect(await queued(to)).toBeNull();
  });
});

describe('Reputation Ramp pause notices', () => {
  it('emails the owners and admins once per anomaly pause', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const admin = email('admin');
    await makeAdmin(workspaceId, admin);
    const now = Date.now();
    const rampId = newId('reputationRamp', now);
    await env.DB.prepare(
      `INSERT INTO reputation_ramps (id, channel_id, sending_domain_id, status, day, cap_today, start_cap, growth, max_cap,
         bounce_threshold, complaint_threshold, created_at, updated_at)
       VALUES (?1, ?2, NULL, 'warming', ?3, 1000, 100, 1.3, 5000, 0.02, 0.0008, ?4, ?4)`,
    )
      .bind(rampId, channelId, new Date(now).toISOString().slice(0, 10), now)
      .run();
    const broadcast = await seedBroadcast(channelId, workspaceId, rampId);
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < 120; i++) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6)`,
        ).bind(
          newId('delivery'),
          broadcast,
          channelId,
          `r${i}@example.com`,
          i < 6 ? 'bounced' : 'sent',
          now - 1000,
        ),
      );
    }
    await env.DB.batch(statements);
    const reason = await checkRampHealth(env.DB, rampId, now);
    expect(reason).toMatch(/Bounce rate 5\.0% is over the 2\.0% limit/);

    const { env: jobs } = jobsEnv();
    const mailTo = async () => {
      const listing = await env.DEV_MAILBOX.list({ prefix: 'mail/', include: ['customMetadata'] });
      const keys = listing.objects.filter((o) => o.customMetadata?.to === admin).map((o) => o.key);
      return Promise.all(
        keys.map(async (key) =>
          (await env.DEV_MAILBOX.get(key))!.json<{
            category: string;
            subject: string;
            text: string;
          }>(),
        ),
      );
    };
    await runScheduled(jobs, MINUTE_CRON, Date.now());
    await runScheduled(jobs, MINUTE_CRON, Date.now());
    const mail = await mailTo();
    expect(mail).toHaveLength(1);
    expect(mail[0]!.category).toBe('ramp_paused');
    expect(mail[0]!.subject).toContain(jobs.PLATFORM_MAIL_DOMAIN);
    expect(mail[0]!.text).toContain(reason!);
    expect(mail[0]!.text).toContain(`${jobs.APP_ORIGIN}/channels/${channelId}/deliverability`);
    const ramp = await env.DB.prepare('SELECT pause_notice FROM reputation_ramps WHERE id = ?1')
      .bind(rampId)
      .first<{ pause_notice: string }>();
    expect(ramp?.pause_notice).toBe('sent');
  });
});
