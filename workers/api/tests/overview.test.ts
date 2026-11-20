// The Overview read: Member growth and the latest Broadcasts with human opens and clicks, scoped to
// the Channel and readable by every role.
import { env } from 'cloudflare:test';
import type { ChannelOverview, SeatRole } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, data, seedDelivery } from './audience-helpers';
import { call, createChannel, seatAs, signIn, type Session } from './helpers';

let owner: Session;
let channelId: string;

const overview = (s: Session, id = channelId) =>
  call('GET', `/api/v1/channels/${id}/overview`, { cookie: s.cookie });

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
});

describe('Channel overview', () => {
  it('is empty for a new Channel', async () => {
    const fresh = (await createChannel(owner)).id;
    expect(await data<ChannelOverview>(await overview(owner, fresh))).toEqual({
      members: { active: 0, joinedLast30Days: 0, leftLast30Days: 0 },
      broadcasts: [],
    });
  });

  it('counts Members and reports the latest Broadcasts with human rates', async () => {
    const a = await addMember(owner, channelId);
    const b = await addMember(owner, channelId);
    // One older Member who unsubscribed this month.
    await env.DB.prepare(
      `UPDATE members SET created_at = ?1, status = 'unsubscribed', unsubscribed_at = ?2 WHERE id = ?3`,
    )
      .bind(Date.now() - 90 * 86_400_000, Date.now() - 86_400_000, b.id)
      .run();
    const now = Date.now();
    const older = await seedDelivery(owner.workspaceId, channelId, a.id, a.email, now - 7_200_000);
    const newer = await seedDelivery(owner.workspaceId, channelId, a.id, a.email, now - 3_600_000);
    // A machine open on the newer one does not count as a human open.
    await env.DB.prepare('UPDATE deliveries SET human_opened_at = NULL WHERE id = ?1')
      .bind(newer.deliveryId)
      .run();

    const result = await data<ChannelOverview>(await overview(owner));
    expect(result.members).toEqual({ active: 1, joinedLast30Days: 1, leftLast30Days: 1 });
    expect(result.broadcasts.map((x) => x.id)).toEqual([newer.broadcastId, older.broadcastId]);
    expect(result.broadcasts[0]).toMatchObject({ delivered: 1, humanOpens: 0, openRate: 0 });
    expect(result.broadcasts[1]).toMatchObject({
      subject: 'Issue 7',
      status: 'sent',
      delivered: 1,
      humanOpens: 1,
      openRate: 1,
    });
  });

  it('leaves out Flow sends', async () => {
    const member = await addMember(owner, channelId);
    const flowSend = await seedDelivery(owner.workspaceId, channelId, member.id, member.email, 1);
    await env.DB.prepare(`UPDATE broadcasts SET kind = 'flow' WHERE id = ?1`)
      .bind(flowSend.broadcastId)
      .run();
    const result = await data<ChannelOverview>(await overview(owner));
    expect(result.broadcasts.some((x) => x.id === flowSend.broadcastId)).toBe(false);
  });

  it('is readable by every role and hidden from other workspaces', async () => {
    for (const role of ['viewer', 'author', 'editor', 'admin'] as SeatRole[]) {
      const seat = await seatAs(owner.workspaceId, role);
      expect((await overview(seat)).status).toBe(200);
    }
    const outsider = await signIn();
    expect((await overview(outsider)).status).toBe(404);
    const anonymous = await call('GET', `/api/v1/channels/${channelId}/overview`);
    expect(anonymous.status).toBe(401);
  });
});
