// Tracking choices and engagement retention through the API (docs/privacy-controls.md): the
// publication's switches on PATCH /channels/:id and the workspace's retention, with roles and
// tenancy.
import { env } from 'cloudflare:test';
import type { Channel, EngagementRetention, SeatRole } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { call, createChannel, json, seatAs, signIn } from './helpers';

const ROLES: SeatRole[] = ['viewer', 'author', 'editor', 'admin', 'owner'];

const settingsOf = async (channelId: string) =>
  JSON.parse(
    (await env.DB.prepare('SELECT settings_json FROM channels WHERE id = ?1')
      .bind(channelId)
      .first<{ settings_json: string }>())!.settings_json,
  ) as Record<string, unknown>;

describe('publication tracking switches', () => {
  it('are off for a new publication, and an admin turns each on', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    const read = await call('GET', `/api/v1/channels/${id}`, { cookie: owner.cookie });
    expect((await json<{ data: Channel }>(read)).data).toMatchObject({
      trackOpens: false,
      trackClicks: false,
      profileReaders: false,
    });
    expect(await settingsOf(id)).toMatchObject({
      trackOpens: false,
      trackClicks: false,
      profileReaders: false,
    });
    const on = await call('PATCH', `/api/v1/channels/${id}`, {
      cookie: owner.cookie,
      body: { trackOpens: true, trackClicks: true, profileReaders: true },
    });
    expect((await json<{ data: Channel }>(on)).data).toMatchObject({
      trackOpens: true,
      trackClicks: true,
      profileReaders: true,
    });
    expect(await settingsOf(id)).not.toHaveProperty('trackOpens');
  });

  it('stay on for a publication that never chose (made before the default changed)', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    await env.DB.prepare("UPDATE channels SET settings_json = '{}' WHERE id = ?1").bind(id).run();
    const read = await call('GET', `/api/v1/channels/${id}`, { cookie: owner.cookie });
    expect((await json<{ data: Channel }>(read)).data).toMatchObject({
      trackOpens: true,
      trackClicks: true,
      profileReaders: true,
    });
  });

  it('can each be turned off and on again by an admin', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    await call('PATCH', `/api/v1/channels/${id}`, {
      cookie: owner.cookie,
      body: { trackOpens: true, trackClicks: true, profileReaders: true },
    });

    const off = await call('PATCH', `/api/v1/channels/${id}`, {
      cookie: owner.cookie,
      body: { trackClicks: false, profileReaders: false },
    });
    expect(off.status).toBe(200);
    expect((await json<{ data: Channel }>(off)).data).toMatchObject({
      trackOpens: true,
      trackClicks: false,
      profileReaders: false,
    });
    expect(await settingsOf(id)).toMatchObject({ trackClicks: false, profileReaders: false });

    const on = await call('PATCH', `/api/v1/channels/${id}`, {
      cookie: owner.cookie,
      body: { trackClicks: true },
    });
    expect((await json<{ data: Channel }>(on)).data.trackClicks).toBe(true);
    expect(await settingsOf(id)).not.toHaveProperty('trackClicks');
  });

  it('turns reader profiling off with open tracking, and refuses it without', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    const off = await call('PATCH', `/api/v1/channels/${id}`, {
      cookie: owner.cookie,
      body: { trackOpens: false },
    });
    expect((await json<{ data: Channel }>(off)).data).toMatchObject({
      trackOpens: false,
      profileReaders: false,
    });
    const refused = await call('PATCH', `/api/v1/channels/${id}`, {
      cookie: owner.cookie,
      body: { profileReaders: true },
    });
    expect(refused.status).toBe(400);
    const both = await call('PATCH', `/api/v1/channels/${id}`, {
      cookie: owner.cookie,
      body: { trackOpens: true, profileReaders: true },
    });
    expect((await json<{ data: Channel }>(both)).data.profileReaders).toBe(true);
  });

  it('need the admin role to change', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    for (const role of ROLES) {
      const session = role === 'owner' ? owner : await seatAs(owner.workspaceId, role);
      const res = await call('PATCH', `/api/v1/channels/${id}`, {
        cookie: session.cookie,
        body: { trackOpens: false },
      });
      const allowed = role === 'admin' || role === 'owner';
      expect(res.status, role).toBe(allowed ? 200 : 403);
    }
  });

  it("can't be changed on another workspace's publication", async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    const stranger = await signIn();
    const res = await call('PATCH', `/api/v1/channels/${id}`, {
      cookie: stranger.cookie,
      body: { trackOpens: true },
    });
    expect(res.status).toBe(404);
    expect(await settingsOf(id)).toMatchObject({ trackOpens: false });
  });
});

describe('engagement retention', () => {
  const path = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/retention`;

  it('is 13 months until an admin picks another choice', async () => {
    const owner = await signIn();
    const read = await call('GET', path(owner.workspaceId), { cookie: owner.cookie });
    expect((await json<{ data: EngagementRetention }>(read)).data).toEqual({
      months: 13,
      leftMemberMonths: 24,
      paymentRecordYears: 10,
      auditLogMonths: 24,
    });
    const set = await call('PUT', path(owner.workspaceId), {
      cookie: owner.cookie,
      body: { months: 6 },
    });
    expect(set.status).toBe(200);
    expect((await json<{ data: EngagementRetention }>(set)).data).toEqual({
      months: 6,
      leftMemberMonths: 24,
      paymentRecordYears: 10,
      auditLogMonths: 24,
    });
    const audit = await env.DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE workspace_id = ?1 AND action = 'workspace.retention_changed'",
    )
      .bind(owner.workspaceId)
      .first<{ metadata_json: string }>();
    expect(JSON.parse(audit!.metadata_json)).toEqual({
      from: 13,
      to: 6,
      leftMemberFrom: 24,
      leftMemberTo: 24,
      paymentRecordFrom: 10,
      paymentRecordTo: 10,
      auditLogFrom: 24,
      auditLogTo: 24,
    });
  });

  it('sets how long the profile of someone who left is kept, within the listed choices', async () => {
    const owner = await signIn();
    const set = await call('PUT', path(owner.workspaceId), {
      cookie: owner.cookie,
      body: { leftMemberMonths: 12 },
    });
    expect((await json<{ data: EngagementRetention }>(set)).data).toEqual({
      months: 13,
      leftMemberMonths: 12,
      paymentRecordYears: 10,
      auditLogMonths: 24,
    });
    for (const leftMemberMonths of [0, 6, 'forever', null]) {
      const res = await call('PUT', path(owner.workspaceId), {
        cookie: owner.cookie,
        body: { leftMemberMonths },
      });
      expect(res.status, String(leftMemberMonths)).toBe(400);
    }
    expect(
      (await call('PUT', path(owner.workspaceId), { cookie: owner.cookie, body: {} })).status,
    ).toBe(400);
  });

  it('sets how long payment references are kept after an erasure, within the listed choices', async () => {
    const owner = await signIn();
    const set = await call('PUT', path(owner.workspaceId), {
      cookie: owner.cookie,
      body: { paymentRecordYears: 7 },
    });
    expect((await json<{ data: EngagementRetention }>(set)).data).toMatchObject({
      paymentRecordYears: 7,
    });
    const read = await call('GET', path(owner.workspaceId), { cookie: owner.cookie });
    expect((await json<{ data: EngagementRetention }>(read)).data.paymentRecordYears).toBe(7);
    for (const paymentRecordYears of [0, 5, 9, 'forever', null]) {
      const res = await call('PUT', path(owner.workspaceId), {
        cookie: owner.cookie,
        body: { paymentRecordYears },
      });
      expect(res.status, String(paymentRecordYears)).toBe(400);
    }
  });

  it('sets how long the audit log is kept, within the listed choices', async () => {
    const owner = await signIn();
    const set = await call('PUT', path(owner.workspaceId), {
      cookie: owner.cookie,
      body: { auditLogMonths: 12 },
    });
    expect((await json<{ data: EngagementRetention }>(set)).data.auditLogMonths).toBe(12);
    for (const auditLogMonths of [0, 6, 120, 'forever', null]) {
      const res = await call('PUT', path(owner.workspaceId), {
        cookie: owner.cookie,
        body: { auditLogMonths },
      });
      expect(res.status, String(auditLogMonths)).toBe(400);
    }
  });

  it('only takes the listed choices', async () => {
    const owner = await signIn();
    for (const months of [0, 12, 'forever', null]) {
      const res = await call('PUT', path(owner.workspaceId), {
        cookie: owner.cookie,
        body: { months },
      });
      expect(res.status, String(months)).toBe(400);
    }
  });

  it('is for admins and owners', async () => {
    const owner = await signIn();
    for (const role of ROLES) {
      const session = role === 'owner' ? owner : await seatAs(owner.workspaceId, role);
      const allowed = role === 'admin' || role === 'owner';
      const read = await call('GET', path(owner.workspaceId), { cookie: session.cookie });
      expect(read.status, role).toBe(allowed ? 200 : 403);
      const set = await call('PUT', path(owner.workspaceId), {
        cookie: session.cookie,
        body: { months: 24 },
      });
      expect(set.status, role).toBe(allowed ? 200 : 403);
    }
  });

  it("can't be read or set for another workspace", async () => {
    const owner = await signIn();
    const stranger = await signIn();
    const read = await call('GET', path(owner.workspaceId), { cookie: stranger.cookie });
    expect(read.status).toBe(404);
    const set = await call('PUT', path(owner.workspaceId), {
      cookie: stranger.cookie,
      body: { months: 6 },
    });
    expect(set.status).toBe(404);
    const row = await env.DB.prepare(
      'SELECT engagement_retention_months AS months FROM workspaces WHERE id = ?1',
    )
      .bind(owner.workspaceId)
      .first<{ months: number }>();
    expect(row?.months).toBe(13);
  });
});
