// Resend to people who didn't open, and the note for the team. docs/api.md.
import { env } from 'cloudflare:test';
import type { Dispatch } from '@swarm/domain';
import { newId } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, data, seedDelivery } from './audience-helpers';
import { call, createChannel, signIn, type Session } from './helpers';

let owner: Session;

beforeAll(async () => {
  owner = await signIn();
});

describe('resending to people who didn’t open', () => {
  let channel: string;
  let opened: { id: string; email: string };
  let unopened: { id: string; email: string };
  let broadcastId: string;
  let sourceDispatch: string;
  const resend = (id = broadcastId, s = owner) =>
    call('POST', `/api/v1/broadcasts/${id}/resend-unopened`, { cookie: s.cookie });

  beforeAll(async () => {
    channel = (await createChannel(owner)).id;
    await env.DB.prepare(
      `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
       VALUES (?1, 'resend_unopens', 'channel', ?2, 1, 1)`,
    )
      .bind(`ff_resend_${channel}`, channel)
      .run();
    opened = await addMember(owner, channel);
    unopened = await addMember(owner, channel);
    // Sent to both; seedDelivery records a human open.
    const seeded = await seedDelivery(owner.workspaceId, channel, opened.id, opened.email, 1000);
    broadcastId = seeded.broadcastId;
    await env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, sent_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 1000)`,
    )
      .bind(newId('delivery'), broadcastId, channel, unopened.id, unopened.email)
      .run();
    sourceDispatch = (await env.DB.prepare('SELECT dispatch_id FROM broadcasts WHERE id = ?1')
      .bind(broadcastId)
      .first<{ dispatch_id: string }>())!.dispatch_id;
    await env.DB.prepare(`UPDATE dispatches SET content_json = ?1 WHERE id = ?2`)
      .bind(JSON.stringify({ type: 'doc', content: [] }), sourceDispatch)
      .run();
  });

  const preflightCount = async (id: string) =>
    (
      await data<{ recipientCount: number }>(
        await call('GET', `/api/v1/dispatches/${id}/preflight`, { cookie: owner.cookie }),
      )
    ).recipientCount;

  it('starts one draft for only those who didn’t open, off the website', async () => {
    const res = await resend();
    expect(res.status, await res.clone().text()).toBe(200);
    const { dispatchId } = await data<{ dispatchId: string }>(res);
    const again = await data<{ dispatchId: string }>(await resend());
    expect(again.dispatchId).toBe(dispatchId);

    const draft = await data<Dispatch>(
      await call('GET', `/api/v1/dispatches/${dispatchId}`, { cookie: owner.cookie }),
    );
    expect(draft).toMatchObject({
      status: 'draft',
      unopenedOf: broadcastId,
      webVisibility: 'hidden',
    });
    expect(await preflightCount(dispatchId)).toBe(1);
  });

  it('stays a resend when the editor saves the audience, and never becomes everyone', async () => {
    const { dispatchId } = await data<{ dispatchId: string }>(await resend());
    const saved = await call('PATCH', `/api/v1/dispatches/${dispatchId}`, {
      cookie: owner.cookie,
      body: { audience: { include: [], exclude: [] } },
    });
    expect(saved.status).toBe(200);
    expect((await data<Dispatch>(saved)).unopenedOf).toBe(broadcastId);
    expect(await preflightCount(dispatchId)).toBe(1);
  });

  it('skips someone who unsubscribed since', async () => {
    const { dispatchId } = await data<{ dispatchId: string }>(await resend());
    await env.DB.prepare(`UPDATE members SET status = 'unsubscribed' WHERE id = ?1`)
      .bind(unopened.id)
      .run();
    expect(await preflightCount(dispatchId)).toBe(0);
    await env.DB.prepare(`UPDATE members SET status = 'active' WHERE id = ?1`)
      .bind(unopened.id)
      .run();
  });

  it('refuses a post with a paywall, whose free readers would otherwise get all of it', async () => {
    const member = await addMember(owner, channel);
    const seeded = await seedDelivery(owner.workspaceId, channel, member.id, member.email, 2000);
    await env.DB.prepare(
      `UPDATE dispatches SET web_visibility = 'paid', content_json = ?1
        WHERE id = (SELECT dispatch_id FROM broadcasts WHERE id = ?2)`,
    )
      .bind(JSON.stringify({ type: 'doc', content: [{ type: 'gate' }] }), seeded.broadcastId)
      .run();
    expect((await resend(seeded.broadcastId)).status).toBe(409);
  });

  it('is off without the flag', async () => {
    const other = await createChannel(owner);
    const member = await addMember(owner, other.id);
    const seeded = await seedDelivery(owner.workspaceId, other.id, member.id, member.email, 3000);
    expect((await resend(seeded.broadcastId)).status).toBe(404);
  });
});

describe('a note for the team', () => {
  it('saves after sending too, and stays out of what goes out', async () => {
    const channel = (await createChannel(owner)).id;
    const member = await addMember(owner, channel);
    const { broadcastId } = await seedDelivery(
      owner.workspaceId,
      channel,
      member.id,
      member.email,
      1000,
    );
    const { dispatch_id: id } = (await env.DB.prepare(
      'SELECT dispatch_id FROM broadcasts WHERE id = ?1',
    )
      .bind(broadcastId)
      .first<{ dispatch_id: string }>())!;
    await env.DB.prepare('UPDATE dispatches SET content_json = ?1 WHERE id = ?2')
      .bind(JSON.stringify({ type: 'doc', content: [] }), id)
      .run();
    const saved = await call('PATCH', `/api/v1/dispatches/${id}`, {
      cookie: owner.cookie,
      body: { internalNote: 'Check the numbers with Sam.' },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const dispatch = await data<Dispatch>(saved);
    expect(dispatch.internalNote).toBe('Check the numbers with Sam.');
    expect(dispatch.html).not.toContain('Sam');
    const listed = await data<Record<string, unknown>[]>(
      await call('GET', `/api/v1/channels/${channel}/dispatches`, { cookie: owner.cookie }),
    );
    expect(listed[0]).not.toHaveProperty('internalNote');
  });
});
