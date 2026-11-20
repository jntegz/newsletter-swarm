// Guided warm-up: paces, the plan, skip and restart on the Reputation Ramp routes.
import { env } from 'cloudflare:test';
import {
  WARMUP_CADENCES,
  newId,
  projectWarmup,
  type Ramp,
  type SeatRole,
  type SendingDomain,
} from '@swarm/domain';
import { release, reserve, rollover, updateRamp, utcDay, type RampRow } from '@swarm/engine';
import { REWARM_SQL } from '@swarm/mail/service-change';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  createChannel,
  freshFactor,
  json,
  seatAs,
  signIn,
  uniqueEmail,
  type Session,
} from './helpers';

async function data<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await json<{ data: T }>(res)).data;
}

/** A Channel with a verified sending domain: its shared ramp and its custom one. */
async function channelWithDomain(owner: Session) {
  const { id: channelId } = await createChannel(owner);
  const name = `warm-${crypto.randomUUID().slice(0, 8)}.example.com`;
  const domain = await data<SendingDomain>(
    await call('POST', `/api/v1/channels/${channelId}/sending-domains`, {
      cookie: owner.cookie,
      body: { domain: name, kind: 'email' },
    }),
    201,
  );
  await data(
    await call('POST', `/api/v1/sending-domains/${domain.id}/verify`, { cookie: owner.cookie }),
  );
  const [shared, custom] = await listRamps(owner, channelId);
  return { channelId, name, shared: shared!, custom: custom! };
}

const listRamps = async (s: Session, channelId: string) =>
  data<Ramp[]>(await call('GET', `/api/v1/channels/${channelId}/ramps`, { cookie: s.cookie }));

const patch = (s: Session, rampId: string, body: Record<string, unknown>) =>
  call('PATCH', `/api/v1/ramps/${rampId}`, { cookie: s.cookie, body });
const skip = (s: Session, rampId: string, body: Record<string, unknown> = { confirm: true }) =>
  call('POST', `/api/v1/ramps/${rampId}/skip`, { cookie: s.cookie, body });
const restart = (s: Session, rampId: string, body: Record<string, unknown> = { confirm: true }) =>
  call('POST', `/api/v1/ramps/${rampId}/restart`, { cookie: s.cookie, body });

const setRamp = (rampId: string, sql: string, ...values: unknown[]) =>
  env.DB.prepare(`UPDATE reputation_ramps SET ${sql} WHERE id = ?1`)
    .bind(rampId, ...values)
    .run();

const audits = async (workspaceId: string, action: string, rampId: string) =>
  (
    await env.DB.prepare(
      'SELECT actor_operator_id, metadata_json FROM audit_events WHERE workspace_id = ?1 AND action = ?2 AND target_id = ?3 ORDER BY seq',
    )
      .bind(workspaceId, action, rampId)
      .all<{ actor_operator_id: string | null; metadata_json: string }>()
  ).results.map((row) => ({
    actor: row.actor_operator_id,
    ...(JSON.parse(row.metadata_json) as Record<string, unknown>),
  }));

async function addMembers(s: Session, channelId: string, count: number) {
  for (let i = 0; i < count; i++) {
    await data(
      await call('POST', `/api/v1/channels/${channelId}/members`, {
        cookie: s.cookie,
        body: { email: uniqueEmail('reader'), consent: true },
      }),
      201,
    );
  }
}

describe('the warm-up plan on GET ramps', () => {
  it('returns the pace, the kind and a day-by-day plan for the active Members', async () => {
    const owner = await signIn();
    const { channelId, shared, custom, name } = await channelWithDomain(owner);
    const today = utcDay(Date.now());
    expect(shared).toMatchObject({
      kind: 'shared',
      pace: 'standard',
      startCap: 100,
      growth: 1.3,
      skipped: false,
      skippedAt: null,
      startedDay: today,
    });
    expect(custom).toMatchObject({
      kind: 'custom',
      domain: name,
      pace: 'standard',
      startCap: 200,
      growth: 1.5,
      status: 'warming',
      startedDay: today,
    });
    expect(custom.plan).toMatchObject({
      audience: 0,
      today,
      fullListDay: today,
      assumesResume: false,
    });
    expect(custom.plan.days[0]).toEqual({ day: today, cap: 200, reach: 0 });
    expect(custom.plan.days[1]?.cap).toBe(300);
    expect(custom.plan.days.length).toBeLessThanOrEqual(60);

    // The audience is the Channel's active Members, and nobody else's.
    await addMembers(owner, channelId, 3);
    await env.DB.prepare(
      "UPDATE members SET status = 'unsubscribed' WHERE id = (SELECT id FROM members WHERE channel_id = ?1 LIMIT 1)",
    )
      .bind(channelId)
      .run();
    const [, again] = await listRamps(owner, channelId);
    expect(again!.plan.audience).toBe(2);
    expect(again!.plan.days[0]).toEqual({ day: today, cap: 200, reach: 2 });

    // A list larger than today's cap: the plan says when it fits in a day.
    await setRamp(custom.id, 'cap_today = 2, start_cap = 2, growth = 1.5, max_cap = 1000');
    await addMembers(owner, channelId, 3);
    const [, small] = await listRamps(owner, channelId);
    expect(small!.pace).toBe('custom');
    expect(small!.plan.days.slice(0, 3)).toEqual([
      { day: today, cap: 2, reach: 2 },
      expect.objectContaining({ cap: 3, reach: 5 }),
      expect.objectContaining({ cap: 5, reach: 5 }),
    ]);
    expect(small!.plan.fullListDay).toBe(small!.plan.days[2]!.day);
    expect(small!.plan.sendDoneDay).toBe(small!.plan.days[1]!.day);
  });
});

describe('changing the pace', () => {
  it('sets a named pace on a ramp that has not grown, and audits it', async () => {
    const owner = await signIn();
    const { custom } = await channelWithDomain(owner);
    const fast = await data<Ramp>(await patch(owner, custom.id, { pace: 'fast' }));
    expect(fast).toMatchObject({ pace: 'fast', startCap: 500, growth: 2, capToday: 500 });
    expect(fast.plan.days[1]?.cap).toBe(1000);
    const careful = await data<Ramp>(await patch(owner, custom.id, { pace: 'careful' }));
    expect(careful).toMatchObject({ pace: 'careful', startCap: 50, growth: 1.25, capToday: 50 });

    const log = await audits(owner.workspaceId, 'ramp.updated', custom.id);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({
      actor: owner.me.operator.id,
      pace: 'fast',
      from: { startCap: 200, growth: 1.5, capToday: 200 },
      to: { startCap: 500, growth: 2, capToday: 500 },
    });
  });

  it('uses the shared domain’s own, slower paces', async () => {
    const owner = await signIn();
    const { shared } = await channelWithDomain(owner);
    const fast = await data<Ramp>(await patch(owner, shared.id, { pace: 'fast' }));
    expect(fast).toMatchObject({ pace: 'fast', startCap: 200, growth: 1.5, capToday: 200 });
    expect((await patch(owner, shared.id, { startCap: 501 })).status).toBe(400);
    expect((await patch(owner, shared.id, { growth: 2 })).status).toBe(400);
    expect((await patch(owner, shared.id, { startCap: 500, growth: 1.5 })).status).toBe(200);
  });

  it('takes a custom start cap and growth within bounds', async () => {
    const owner = await signIn();
    const { custom } = await channelWithDomain(owner);
    const tuned = await data<Ramp>(await patch(owner, custom.id, { startCap: 2000, growth: 1.4 }));
    expect(tuned).toMatchObject({ pace: 'custom', startCap: 2000, growth: 1.4, capToday: 2000 });
    for (const body of [
      { startCap: 9 },
      { startCap: 100_001 },
      { startCap: 12.5 },
      { growth: 1 },
      { growth: 3.1 },
      { pace: 'fast', growth: 1.2 },
      { pace: 'custom' },
    ]) {
      expect((await patch(owner, custom.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    const unchanged = (await listRamps(owner, await channelOf(custom.id)))[1];
    expect(unchanged).toMatchObject({ startCap: 2000, growth: 1.4 });
  });

  it('never lowers the cap of a ramp that has grown, and never below what today used', async () => {
    const owner = await signIn();
    const { custom } = await channelWithDomain(owner);
    // Day 6 of a Standard ramp: 1,520 a day, 900 of them reserved by a send that is going out.
    await setRamp(custom.id, 'cap_today = 1520');
    expect((await reserve(env.DB, custom.id, 900)).granted).toBe(900);

    const careful = await data<Ramp>(await patch(owner, custom.id, { pace: 'careful' }));
    expect(careful).toMatchObject({ pace: 'careful', capToday: 1520, sentToday: 900 });
    // The rest of today's allowance is still there, and tomorrow grows at the new pace.
    expect((await reserve(env.DB, custom.id, 1000)).granted).toBe(620);
    expect((await reserve(env.DB, custom.id, 10)).granted).toBe(0);
    expect(careful.plan.days[1]?.cap).toBe(1900);

    // A faster pace with a start under today's cap leaves today alone too.
    const fast = await data<Ramp>(await patch(owner, custom.id, { pace: 'fast' }));
    expect(fast).toMatchObject({ capToday: 1520, sentToday: 1520, growth: 2 });
    // A start cap over today's cap raises it at once.
    const raised = await data<Ramp>(await patch(owner, custom.id, { startCap: 5000 }));
    expect(raised).toMatchObject({ capToday: 5000, sentToday: 1520 });
    expect((await reserve(env.DB, custom.id, 9999)).granted).toBe(3480);
    // Returning a reservation still works after the changes.
    await release(env.DB, custom.id, 480);
    expect((await reserve(env.DB, custom.id, 9999)).granted).toBe(480);
  });

  it('keeps a first-day ramp at what it already sent when the new start is lower', async () => {
    const owner = await signIn();
    const { custom } = await channelWithDomain(owner);
    expect((await reserve(env.DB, custom.id, 120)).granted).toBe(120);
    const careful = await data<Ramp>(await patch(owner, custom.id, { pace: 'careful' }));
    // Careful starts at 50, but 120 are already out: the cap can't go under them.
    expect(careful).toMatchObject({ startCap: 50, capToday: 120, sentToday: 120 });
    expect((await reserve(env.DB, custom.id, 10)).granted).toBe(0);
    const row = await env.DB.prepare(
      'SELECT cap_today, sent_today FROM reputation_ramps WHERE id = ?1',
    )
      .bind(custom.id)
      .first<{ cap_today: number; sent_today: number }>();
    expect(row!.cap_today).toBeGreaterThanOrEqual(row!.sent_today);
  });

  it('does not let a start cap pass the ceiling, and only stores the pace on a complete ramp', async () => {
    const owner = await signIn();
    const { custom } = await channelWithDomain(owner);
    await setRamp(custom.id, 'max_cap = 300');
    const fast = await data<Ramp>(await patch(owner, custom.id, { pace: 'fast' }));
    expect(fast).toMatchObject({ startCap: 500, capToday: 300, maxCap: 300 });

    await setRamp(custom.id, "status = 'complete', cap_today = 300");
    const stored = await data<Ramp>(await patch(owner, custom.id, { pace: 'careful' }));
    expect(stored).toMatchObject({ status: 'complete', pace: 'careful', capToday: 300 });
    // Pausing a complete ramp is still ignored, and leaves no reason behind.
    const still = await data<Ramp>(await patch(owner, custom.id, { status: 'paused' }));
    expect(still).toMatchObject({ status: 'complete', pausedReason: null });
  });

  it('keeps pause and resume working, with the plan of a paused ramp assuming a resume', async () => {
    const owner = await signIn();
    const { custom } = await channelWithDomain(owner);
    const paused = await data<Ramp>(await patch(owner, custom.id, { status: 'paused' }));
    expect(paused).toMatchObject({ status: 'paused', pausedReason: 'Paused by a teammate.' });
    expect(paused.plan.assumesResume).toBe(true);
    expect(paused.plan.days[0]?.cap).toBe(200);
    const resumed = await data<Ramp>(await patch(owner, custom.id, { status: 'warming' }));
    expect(resumed).toMatchObject({ status: 'warming', pausedReason: null });
    expect(resumed.plan.assumesResume).toBe(false);
  });
});

const channelOf = async (rampId: string) =>
  (await env.DB.prepare('SELECT channel_id FROM reputation_ramps WHERE id = ?1')
    .bind(rampId)
    .first<{ channel_id: string }>())!.channel_id;

describe('skipping warm-up', () => {
  it('needs an explicit confirmation', async () => {
    const owner = await signIn();
    const { custom } = await channelWithDomain(owner);
    for (const body of [{}, { confirm: false }, { confirm: 'yes' }, { dailyVolume: 5000 }]) {
      expect((await skip(owner, custom.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await listRamps(owner, await channelOf(custom.id)))[1]!.status).toBe('warming');
  });

  it('marks the ramp complete, stops limiting sends and writes an audit entry', async () => {
    const owner = await signIn();
    const { channelId, custom } = await channelWithDomain(owner);
    await addMembers(owner, channelId, 2);
    const skipped = await data<Ramp>(
      await skip(owner, custom.id, { confirm: true, dailyVolume: 40_000 }),
    );
    expect(skipped).toMatchObject({ status: 'complete', skipped: true, pausedReason: null });
    expect(skipped.skippedAt).not.toBeNull();
    expect(skipped.plan).toMatchObject({ days: [], fullListDay: skipped.plan.today });
    expect((await reserve(env.DB, custom.id, 50_000)).granted).toBe(50_000);

    expect(await audits(owner.workspaceId, 'ramp.skipped', custom.id)).toEqual([
      {
        actor: owner.me.operator.id,
        dailyVolume: 40_000,
        statusBefore: 'warming',
        capBefore: 200,
        audience: 2,
      },
    ]);
    // Skipping twice is a conflict, not a second audit entry.
    expect((await skip(owner, custom.id)).status).toBe(409);
    expect(await audits(owner.workspaceId, 'ramp.skipped', custom.id)).toHaveLength(1);
  });

  it('skips a paused ramp too, clearing the pause', async () => {
    const owner = await signIn();
    const { custom } = await channelWithDomain(owner);
    await setRamp(
      custom.id,
      "status = 'paused', paused_reason = 'Bounce rate 3.0% is over the 2.0% limit.', pause_notice = 'due'",
    );
    const skipped = await data<Ramp>(await skip(owner, custom.id));
    expect(skipped).toMatchObject({ status: 'complete', skipped: true, pausedReason: null });
    const row = await env.DB.prepare('SELECT pause_notice FROM reputation_ramps WHERE id = ?1')
      .bind(custom.id)
      .first<{ pause_notice: string | null }>();
    expect(row!.pause_notice).toBeNull();
  });

  it('refuses a publication admin on the shared domain', async () => {
    const owner = await signIn();
    const { shared } = await channelWithDomain(owner);
    expect(shared.sharedOverride).toBe(false);
    const res = await skip(owner, shared.id);
    expect(res.status).toBe(403);
    expect((await json<{ error: { message: string } }>(res)).error.message).toMatch(
      /instance admin/,
    );
    expect(await audits(owner.workspaceId, 'ramp.skipped', shared.id)).toEqual([]);
  });
});

describe('the shared domain on your own install', () => {
  const makeInstanceAdmin = async (s: Session) => {
    await env.DB.prepare('INSERT INTO instance_admins (operator_id, created_at) VALUES (?1, ?2)')
      .bind(s.me.operator.id, Date.now())
      .run();
    // Instance settings need a factor of the admin's own, freshly proved for a change.
    await freshFactor(s);
  };

  it('tells the dashboard who may override, on the shared ramp only', async () => {
    const owner = await signIn();
    const { channelId } = await channelWithDomain(owner);
    expect((await listRamps(owner, channelId)).map((r) => r.sharedOverride)).toEqual([
      false,
      false,
    ]);
    await makeInstanceAdmin(owner);
    expect((await listRamps(owner, channelId)).map((r) => r.sharedOverride)).toEqual([true, false]);
  });

  it('keeps a publication admin at the 5,000 ceiling and the tighter bounds', async () => {
    const owner = await signIn();
    const { shared } = await channelWithDomain(owner);
    expect(shared.maxCap).toBe(5000);
    expect((await patch(owner, shared.id, { maxCap: 5001 })).status).toBe(403);
    expect((await patch(owner, shared.id, { startCap: 501 })).status).toBe(400);
    expect((await patch(owner, shared.id, { growth: 1.6 })).status).toBe(400);
    // Lowering the ceiling, or setting it to the default, is still theirs to do.
    const lowered = await data<Ramp>(await patch(owner, shared.id, { maxCap: 3000 }));
    expect(lowered.maxCap).toBe(3000);
    expect((await patch(owner, shared.id, { maxCap: 5000 })).status).toBe(200);
    const log = await audits(owner.workspaceId, 'ramp.updated', shared.id);
    expect(log.every((entry) => !('instanceAdminOverride' in entry))).toBe(true);
  });

  it('keeps the shared domain’s safety net with the instance: thresholds and resuming a spike', async () => {
    const owner = await signIn();
    const { shared, custom } = await channelWithDomain(owner);
    // Looser pause thresholds on the shared domain are the instance's call.
    expect((await patch(owner, shared.id, { bounceThreshold: 0.1 })).status).toBe(403);
    expect((await patch(owner, shared.id, { complaintThreshold: 0.01 })).status).toBe(403);
    // Tighter ones, and any on a domain of the publication's own, are not.
    expect((await patch(owner, shared.id, { bounceThreshold: 0.01 })).status).toBe(200);
    expect((await patch(owner, custom.id, { bounceThreshold: 0.1 })).status).toBe(200);

    // A pause the ramp made over a spike: only an instance admin lifts it on the shared domain.
    await setRamp(
      shared.id,
      "status = 'paused', paused_reason = 'Complaint rate 0.5% is over the 0.08% limit.', paused_by = 'system'",
    );
    const refused = await patch(owner, shared.id, { status: 'warming' });
    expect(refused.status).toBe(403);
    expect((await json<{ error: { message: string } }>(refused)).error.message).toMatch(
      /instance admin/,
    );
    // A pause a person made is theirs to lift.
    await setRamp(shared.id, "status = 'warming', paused_reason = NULL, paused_by = NULL");
    expect(await data<Ramp>(await patch(owner, shared.id, { status: 'paused' }))).toMatchObject({
      status: 'paused',
      pausedReason: 'Paused by a teammate.',
      pausedBy: 'person',
    });
    expect(await data<Ramp>(await patch(owner, shared.id, { status: 'warming' }))).toMatchObject({
      status: 'warming',
      pausedReason: null,
      pausedBy: null,
    });

    await setRamp(
      shared.id,
      "status = 'paused', paused_reason = 'Complaint rate 0.5% is over the 0.08% limit.', paused_by = 'system'",
    );
    await makeInstanceAdmin(owner);
    const resumed = await data<Ramp>(await patch(owner, shared.id, { status: 'warming' }));
    expect(resumed.status).toBe('warming');
    const log = await audits(owner.workspaceId, 'ramp.updated', shared.id);
    expect(log.at(-1)).toMatchObject({ status: 'warming', instanceAdminOverride: true });
  });

  it('never lets a publication admin make a pause the shared domain made their own', async () => {
    const owner = await signIn();
    const { shared } = await channelWithDomain(owner);
    const reason = 'Bounce rate 3.0% is over the 2.0% limit.';
    await setRamp(
      shared.id,
      "status = 'paused', paused_reason = ?2, paused_by = 'system', pause_notice = 'due'",
      reason,
    );
    const stored = () =>
      env.DB.prepare(
        'SELECT status, paused_reason, paused_by, pause_notice FROM reputation_ramps WHERE id = ?1',
      )
        .bind(shared.id)
        .first();
    // Pausing a paused ramp changes nothing: the reason, who paused it and the notice still owed.
    const again = await data<Ramp>(await patch(owner, shared.id, { status: 'paused' }));
    expect(again).toMatchObject({ status: 'paused', pausedReason: reason, pausedBy: 'system' });
    const resume = await patch(owner, shared.id, { status: 'warming' });
    expect(resume.status).toBe(403);
    expect(await stored()).toEqual({
      status: 'paused',
      paused_reason: reason,
      paused_by: 'system',
      pause_notice: 'due',
    });
    // The words of the reason never decide: one that reads like a person's is still the system's.
    await setRamp(shared.id, "paused_reason = 'Paused by a teammate.'");
    expect((await patch(owner, shared.id, { status: 'warming' })).status).toBe(403);
    // Another admin of the publication is refused the same way.
    const admin = await seatAs(owner.workspaceId, 'admin');
    expect((await patch(admin, shared.id, { status: 'warming' })).status).toBe(403);
    expect(await stored()).toMatchObject({ status: 'paused', paused_by: 'system' });
  });

  it('checks the resume in the update itself, so a pause made after the read stands', async () => {
    const owner = await signIn();
    const { shared } = await channelWithDomain(owner);
    // The route read the ramp while it was warming; it paused itself before the update ran.
    await setRamp(
      shared.id,
      "status = 'paused', paused_reason = 'Bounce rate 3.0% is over the 2.0% limit.', paused_by = 'system', pause_notice = 'due'",
    );
    const refused = await updateRamp(
      env.DB,
      shared.id,
      { status: 'warming', growth: 1.2 },
      Date.now(),
      {
        resumeSystemPause: false,
      },
    );
    expect(refused).toBeNull();
    expect(
      await env.DB.prepare(
        'SELECT status, growth, pause_notice FROM reputation_ramps WHERE id = ?1',
      )
        .bind(shared.id)
        .first(),
    ).toEqual({ status: 'paused', growth: 1.3, pause_notice: 'due' });
    // Tuning without resuming still works for them.
    expect(
      await updateRamp(env.DB, shared.id, { growth: 1.2 }, Date.now(), {
        resumeSystemPause: false,
      }),
    ).toMatchObject({ status: 'paused', growth: 1.2, paused_by: 'system' });
    // The instance's own call goes through, and clears the notice.
    expect(
      await updateRamp(env.DB, shared.id, { status: 'warming' }, Date.now(), {
        resumeSystemPause: true,
      }),
    ).toMatchObject({
      status: 'warming',
      paused_reason: null,
      paused_by: null,
      pause_notice: null,
    });
  });

  it('marks a pause the day rollover makes as the system’s, and never undoes a newer pause', async () => {
    const owner = await signIn();
    const { channelId, shared } = await channelWithDomain(owner);
    const now = Date.now();
    const yesterday = utcDay(now - 86_400_000);
    const sentAt = Date.parse(`${yesterday}T12:00:00Z`);
    // Yesterday: 100 sent from the shared domain, 5 bounced (5% is over the 2% limit).
    const dispatch = newId('dispatch');
    const broadcast = newId('broadcast');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
         VALUES (?1, ?2, 'S', '{"type":"doc","content":[]}', 'sent', ?3, ?3)`,
      ).bind(dispatch, channelId, sentAt),
      env.DB.prepare(
        `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
           from_name, from_address, track_opens, ramp_id, created_at, last_progress_at)
         VALUES (?1, ?2, ?3, ?4, 'sent', 'S', '', '', '', 'F', 'f@mail.swarm.test', 1, ?5, ?6, ?6)`,
      ).bind(broadcast, dispatch, channelId, owner.workspaceId, shared.id, sentAt),
      ...Array.from({ length: 100 }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at)
           VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6)`,
        ).bind(
          newId('delivery'),
          broadcast,
          channelId,
          `r${i}@example.net`,
          i < 5 ? 'bounced' : 'delivered',
          sentAt,
        ),
      ),
    ]);
    await setRamp(shared.id, 'day = ?2, sent_today = 100', yesterday);
    const { granted, ramp } = await reserve(env.DB, shared.id, 10, now);
    expect(granted).toBe(0);
    expect(ramp).toMatchObject({ status: 'paused', paused_by: 'system', pause_notice: 'due' });
    expect((await patch(owner, shared.id, { status: 'warming' })).status).toBe(403);

    // A rollover that read the ramp before a person paused it keeps the person's pause.
    await setRamp(
      shared.id,
      "status = 'warming', paused_reason = NULL, paused_by = NULL, pause_notice = NULL, day = ?2",
      yesterday,
    );
    await env.DB.prepare("UPDATE deliveries SET status = 'delivered' WHERE broadcast_id = ?1")
      .bind(broadcast)
      .run();
    const stale = (await env.DB.prepare('SELECT * FROM reputation_ramps WHERE id = ?1')
      .bind(shared.id)
      .first<RampRow>())!;
    await data(await patch(owner, shared.id, { status: 'paused' }));
    const after = await rollover(env.DB, stale, now);
    expect(after).toMatchObject({
      day: utcDay(now),
      status: 'paused',
      paused_by: 'person',
      paused_reason: 'Paused by a teammate.',
    });
  });

  it('lets an instance admin raise the ceiling, with the override in the audit log', async () => {
    const owner = await signIn();
    const { channelId, shared } = await channelWithDomain(owner);
    await makeInstanceAdmin(owner);
    const raised = await data<Ramp>(await patch(owner, shared.id, { maxCap: 20_000 }));
    expect(raised).toMatchObject({ maxCap: 20_000, sharedOverride: true, status: 'warming' });
    expect(await audits(owner.workspaceId, 'ramp.updated', shared.id)).toEqual([
      {
        actor: owner.me.operator.id,
        maxCap: 20_000,
        instanceAdminOverride: true,
        maxCapBefore: 5000,
      },
    ]);
    // Within the ordinary limits nothing is marked as an override.
    await data(await patch(owner, shared.id, { pace: 'fast' }));
    expect((await audits(owner.workspaceId, 'ramp.updated', shared.id))[1]).not.toHaveProperty(
      'instanceAdminOverride',
    );
    // Another admin of the same workspace is not an instance admin.
    const admin = await seatAs(owner.workspaceId, 'admin');
    expect((await patch(admin, shared.id, { maxCap: 30_000 })).status).toBe(403);
    expect((await listRamps(admin, channelId))[0]).toMatchObject({
      maxCap: 20_000,
      sharedOverride: false,
    });
  });

  it('gives an instance admin the wider pace bounds, but not more than a custom domain gets', async () => {
    const owner = await signIn();
    const { shared } = await channelWithDomain(owner);
    await makeInstanceAdmin(owner);
    const tuned = await data<Ramp>(await patch(owner, shared.id, { startCap: 2000, growth: 2 }));
    expect(tuned).toMatchObject({ startCap: 2000, growth: 2, capToday: 2000, pace: 'custom' });
    expect((await audits(owner.workspaceId, 'ramp.updated', shared.id))[0]).toMatchObject({
      instanceAdminOverride: true,
    });
    expect((await patch(owner, shared.id, { startCap: 100_001 })).status).toBe(400);
    expect((await patch(owner, shared.id, { growth: 3.5 })).status).toBe(400);
  });

  it('lets an instance admin skip and restart warm-up on the shared domain', async () => {
    const owner = await signIn();
    const { shared } = await channelWithDomain(owner);
    await makeInstanceAdmin(owner);
    const skipped = await data<Ramp>(
      await skip(owner, shared.id, { confirm: true, dailyVolume: 25_000 }),
    );
    expect(skipped).toMatchObject({ status: 'complete', skipped: true, kind: 'shared' });
    expect(await audits(owner.workspaceId, 'ramp.skipped', shared.id)).toEqual([
      {
        actor: owner.me.operator.id,
        dailyVolume: 25_000,
        instanceAdminOverride: true,
        statusBefore: 'warming',
        capBefore: 100,
        audience: 0,
      },
    ]);
    expect((await restart(owner, shared.id)).status).toBe(200);
  });

  it('still needs the admin role in the publication: an instance admin elsewhere gets 404', async () => {
    const owner = await signIn();
    const { shared } = await channelWithDomain(owner);
    const outsider = await signIn();
    await makeInstanceAdmin(outsider);
    expect((await skip(outsider, shared.id)).status).toBe(404);
    expect((await patch(outsider, shared.id, { maxCap: 20_000 })).status).toBe(404);
    const viewer = await seatAs(owner.workspaceId, 'viewer');
    await makeInstanceAdmin(viewer);
    expect((await skip(viewer, shared.id)).status).toBe(403);
    expect((await patch(viewer, shared.id, { maxCap: 20_000 })).status).toBe(403);
  });
});

describe('a change of email service', () => {
  it('forgets a skip and starts the day count over', async () => {
    const owner = await signIn();
    const { custom } = await channelWithDomain(owner);
    await data(await skip(owner, custom.id));
    await setRamp(custom.id, "started_day = '2026-01-01'");
    const NOW = Date.UTC(2041, 5, 15, 12);
    await env.DB.prepare(REWARM_SQL).bind(NOW).run();
    const row = await env.DB.prepare(
      'SELECT status, skipped_at, started_day, day, cap_today FROM reputation_ramps WHERE id = ?1',
    )
      .bind(custom.id)
      .first();
    expect(row).toEqual({
      status: 'warming',
      skipped_at: null,
      started_day: '2041-06-15',
      day: '2041-06-15',
      cap_today: 200,
    });
    // Put the ramps this statement touched back on today, for the tests that follow.
    await env.DB.prepare('UPDATE reputation_ramps SET day = ?1, started_day = ?1 WHERE day = ?2')
      .bind(utcDay(Date.now()), '2041-06-15')
      .run();
  });
});

describe('starting warm-up again', () => {
  it('restarts a skipped ramp from its start cap, with an audit entry', async () => {
    const owner = await signIn();
    const { channelId, custom } = await channelWithDomain(owner);
    expect((await restart(owner, custom.id)).status).toBe(409);
    await data(await skip(owner, custom.id));
    expect((await restart(owner, custom.id, {})).status).toBe(400);

    const again = await data<Ramp>(await restart(owner, custom.id));
    expect(again).toMatchObject({
      status: 'warming',
      skipped: false,
      skippedAt: null,
      capToday: 200,
      sentToday: 0,
      pace: 'standard',
      startedDay: utcDay(Date.now()),
    });
    expect(again.plan.days[0]?.cap).toBe(200);
    expect(await audits(owner.workspaceId, 'ramp.restarted', custom.id)).toEqual([
      { actor: owner.me.operator.id, pace: null, startCap: 200, growth: 1.5, wasSkipped: true },
    ]);
    expect((await listRamps(owner, channelId))[1]).toMatchObject({ status: 'warming' });
  });

  it('can restart at another pace, and counts what today already sent', async () => {
    const owner = await signIn();
    const { custom } = await channelWithDomain(owner);
    await data(await skip(owner, custom.id));
    // A send went out today while nothing limited it.
    expect((await reserve(env.DB, custom.id, 30_000)).granted).toBe(30_000);
    const again = await data<Ramp>(
      await restart(owner, custom.id, { confirm: true, pace: 'careful' }),
    );
    expect(again).toMatchObject({
      status: 'warming',
      pace: 'careful',
      capToday: 50,
      sentToday: 30_000,
    });
    // Nothing more today, and reserve and release still behave.
    expect((await reserve(env.DB, custom.id, 10)).granted).toBe(0);
    await release(env.DB, custom.id, 100);
    expect((await reserve(env.DB, custom.id, 10)).granted).toBe(0);
  });

  it('raises the ceiling to the active Members, so the ramp cannot end before it covers them', async () => {
    const owner = await signIn();
    const { channelId, custom } = await channelWithDomain(owner);
    await addMembers(owner, channelId, 2);
    await setRamp(custom.id, "status = 'complete', max_cap = 150, cap_today = 150");
    const again = await data<Ramp>(await restart(owner, custom.id));
    expect(again).toMatchObject({ status: 'warming', capToday: 200, maxCap: 201 });
  });
});

describe('the plan for a publication’s own rhythm', () => {
  // The dashboard works this plan out itself (projectWarmup with a rhythm). It must name the caps
  // the engine really hands out: reserve() and its rollover, with a post waiting for the next day.
  for (const [name, every, audience] of [
    ['a weekly newsletter with 5,000 subscribers', WARMUP_CADENCES.weekly, 5_000],
    ['a weekly newsletter with 1,000 subscribers', WARMUP_CADENCES.weekly, 1_000],
    ['a few posts a week to 20,000 subscribers', WARMUP_CADENCES.few, 20_000],
  ] as const) {
    it(`matches the engine day by day for ${name}`, async () => {
      const owner = await signIn();
      const { custom } = await channelWithDomain(owner);
      const start = Date.parse(`${utcDay(Date.now())}T12:00:00Z`);
      const today = utcDay(start);
      const plan = projectWarmup(
        {
          status: 'warming',
          day: today,
          capToday: custom.capToday,
          sentToday: 0,
          growth: custom.growth,
          maxCap: custom.maxCap,
        },
        audience,
        today,
        undefined,
        every,
      );
      expect(plan.days.length).toBeGreaterThan(8);
      let waiting = 0;
      let sent = 0;
      let firstPostDone: string | null = null;
      let fits: string | null = null;
      for (const [i, planned] of plan.days.entries()) {
        const now = start + i * 86_400_000;
        if (i % every === 0) waiting += audience;
        // The pipeline only asks when something is waiting; a quiet day touches nothing.
        if (waiting === 0) continue;
        const { granted, ramp } = await reserve(env.DB, custom.id, waiting, now);
        expect(ramp.cap_today, `cap on day ${i + 1}`).toBe(planned.cap);
        waiting -= granted;
        sent += granted;
        expect(Math.min(audience, sent), `reach on day ${i + 1}`).toBe(planned.reach);
        if (!firstPostDone && sent >= audience) firstPostDone = utcDay(now);
        if (!fits && ramp.cap_today >= audience) fits = utcDay(now);
      }
      expect(firstPostDone).toBe(plan.sendDoneDay);
      // The engine only shows a cap on a day it sends, so it can see the list fit a little later.
      expect(fits! >= plan.fullListDay!).toBe(true);
    });
  }
});

describe('roles and tenancy for skip and restart', () => {
  const ROLES: SeatRole[] = ['viewer', 'author', 'editor', 'admin', 'owner'];
  let owner: Session;
  let outsider: Session;
  let rampId: string;
  let channelId: string;
  const seats = {} as Record<SeatRole, Session>;

  beforeAll(async () => {
    owner = await signIn();
    seats.owner = owner;
    for (const role of ['viewer', 'author', 'editor', 'admin'] as const)
      seats[role] = await seatAs(owner.workspaceId, role);
    outsider = await signIn();
    const made = await channelWithDomain(owner);
    rampId = made.custom.id;
    channelId = made.channelId;
  });

  it('lets every role read the plan', async () => {
    for (const role of ROLES) {
      const ramps = await listRamps(seats[role], channelId);
      expect(ramps[1]?.plan.days.length, role).toBeGreaterThan(0);
    }
  });

  for (const role of ['viewer', 'author', 'editor'] as const) {
    it(`refuses a ${role} who changes the pace, skips or restarts`, async () => {
      expect((await patch(seats[role], rampId, { pace: 'fast' })).status).toBe(403);
      expect((await skip(seats[role], rampId)).status).toBe(403);
      expect((await restart(seats[role], rampId)).status).toBe(403);
    });
  }

  it('answers 404 to another workspace, for reads and writes, and changes nothing', async () => {
    expect(
      (await call('GET', `/api/v1/channels/${channelId}/ramps`, { cookie: outsider.cookie }))
        .status,
    ).toBe(404);
    expect((await patch(outsider, rampId, { pace: 'fast' })).status).toBe(404);
    expect((await skip(outsider, rampId)).status).toBe(404);
    expect((await restart(outsider, rampId)).status).toBe(404);
    expect(
      (await call('POST', `/api/v1/ramps/${rampId}/skip`, { body: { confirm: true } })).status,
    ).toBe(401);
    const [, ramp] = await listRamps(owner, channelId);
    expect(ramp).toMatchObject({ status: 'warming', pace: 'standard', skipped: false });
  });

  it('lets an admin skip and restart', async () => {
    expect((await skip(seats.admin, rampId)).status).toBe(200);
    expect((await restart(seats.admin, rampId)).status).toBe(200);
    expect((await patch(seats.admin, rampId, { pace: 'fast' })).status).toBe(200);
  });
});
