// Bounce rules API: the workspace policy (read, preview, save, apply to past bounces), holds for
// subscribers on a paid plan and their decision, one subscriber's bounces, roles and tenancy.
import { env } from 'cloudflare:test';
import {
  newId,
  type BounceHold,
  type BouncePolicySaved,
  type BouncePolicySettings,
  type BouncePreview,
  type MemberBounces,
  type Suppression,
} from '@swarm/domain';
import { applySesEvent } from '@swarm/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, json, seatAs, signIn, uniqueEmail, type Session } from './helpers';

async function data<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await json<{ data: T }>(res)).data;
}

const policyPath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/bounce-policy`;
const holdsPath = (channelId: string) => `/api/v1/channels/${channelId}/bounce-holds`;
const FULL = 'smtp; 452 4.2.2 The email account that you tried to reach is over quota.';
const RULES = { hardBounces: 1, softStreak: 3, softWindow: null, askForPaid: true };

async function addMember(channelId: string, to: string, paid = false) {
  const id = newId('member');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO members (id, channel_id, email, status, consent_at, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', ?4, ?4, ?4)`,
  )
    .bind(id, channelId, to, now)
    .run();
  if (paid) {
    await env.DB.prepare(
      `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at) VALUES (?1, ?2, 'paid', 'stripe', 0)`,
    )
      .bind(id, channelId)
      .run();
  }
  return id;
}

/** `times` soft bounces for the Member, each on its own email. */
async function softBounces(
  channelId: string,
  workspaceId: string,
  memberId: string,
  to: string,
  times: number,
) {
  const now = Date.now();
  for (let i = 0; i < times; i++) {
    const dispatch = newId('dispatch');
    const broadcast = newId('broadcast');
    const delivery = newId('delivery');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at) VALUES (?1, ?2, 'S', '{"type":"doc","content":[]}', 'sent', ?3, ?3)`,
      ).bind(dispatch, channelId, now),
      env.DB.prepare(
        `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text, from_name, from_address, track_opens, created_at, last_progress_at)
         VALUES (?1, ?2, ?3, ?4, 'sent', 'S', '', '', '', 'F', 'f@mail.swarm.test', 1, ?5, ?5)`,
      ).bind(broadcast, dispatch, channelId, workspaceId, now),
      env.DB.prepare(
        `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, 'sent', ?6)`,
      ).bind(delivery, broadcast, channelId, memberId, to, now - 1000 + i),
    ]);
    await applySesEvent(
      env.DB,
      {
        eventType: 'Bounce',
        mail: { tags: { delivery: [delivery] } },
        bounce: { bounceType: 'Transient', bouncedRecipients: [{ diagnosticCode: FULL }] },
      },
      now + i,
    );
  }
}

describe('bounce rules', () => {
  let owner: Session;

  beforeAll(async () => {
    owner = await signIn();
  });

  it('starts with the recommended rules, and a viewer can read them', async () => {
    const viewer = await seatAs(owner.workspaceId, 'viewer');
    expect(
      await data<BouncePolicySettings>(
        await call('GET', policyPath(owner.workspaceId), { cookie: viewer.cookie }),
      ),
    ).toEqual({ ...RULES, updatedAt: null });
  });

  it('only workspace admins preview and change them; other workspaces get 404', async () => {
    const editor = await seatAs(owner.workspaceId, 'editor');
    const outsider = await signIn();
    for (const [method, path, body] of [
      ['PUT', policyPath(owner.workspaceId), RULES],
      ['POST', `${policyPath(owner.workspaceId)}/preview`, RULES],
    ] as const) {
      expect((await call(method, path, { cookie: editor.cookie, body })).status).toBe(403);
      expect((await call(method, path, { cookie: outsider.cookie, body })).status).toBe(404);
    }
    expect(
      (await call('GET', policyPath(owner.workspaceId), { cookie: outsider.cookie })).status,
    ).toBe(404);
  });

  it('refuses rules outside the choices', async () => {
    for (const body of [
      { ...RULES, hardBounces: 3 },
      { ...RULES, softStreak: 1 },
      { ...RULES, softStreak: 11 },
      { ...RULES, softWindow: { count: 3, days: 10 } },
    ]) {
      const res = await call('PUT', policyPath(owner.workspaceId), { cookie: owner.cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('previews, saves for the future only, then applies to past bounces when asked', async () => {
    const team = await signIn();
    const ch = (await createChannel(team)).id;
    const to = uniqueEmail('soft');
    const memberId = await addMember(ch, to);
    await softBounces(ch, team.workspaceId, memberId, to, 2);
    const stricter = { ...RULES, softStreak: 2 };
    expect(
      await data<BouncePreview>(
        await call('POST', `${policyPath(team.workspaceId)}/preview`, {
          cookie: team.cookie,
          body: stricter,
        }),
      ),
    ).toEqual({
      stopped: 1,
      held: 0,
      byRule: { hard: 0, hard_repeat: 0, soft_streak: 1, soft_window: 0 },
    });

    const saved = await data<BouncePolicySaved>(
      await call('PUT', policyPath(team.workspaceId), { cookie: team.cookie, body: stricter }),
    );
    expect(saved).toMatchObject({ ...stricter, applied: null });
    expect(saved.updatedAt).not.toBeNull();
    const member = await env.DB.prepare('SELECT status FROM members WHERE id = ?1')
      .bind(memberId)
      .first<{ status: string }>();
    expect(member?.status).toBe('active');

    const applied = await data<BouncePolicySaved>(
      await call('PUT', policyPath(team.workspaceId), {
        cookie: team.cookie,
        body: { ...stricter, applyToPast: true },
      }),
    );
    expect(applied.applied).toEqual({ stopped: 1, held: 0, remaining: 0 });
    const after = await env.DB.prepare('SELECT status FROM members WHERE id = ?1')
      .bind(memberId)
      .first<{ status: string }>();
    expect(after?.status).toBe('bounced');

    // Blocked addresses show the rule; the subscriber's page shows it with the server's words.
    const [row] = await data<Suppression[]>(
      await call('GET', `/api/v1/channels/${ch}/suppressions?email=${encodeURIComponent(to)}`, {
        cookie: team.cookie,
      }),
    );
    expect(row).toMatchObject({
      reason: 'soft_bounce',
      detail: FULL,
      bounce: { rule: 'soft_streak', cause: 'mailbox_full', counted: 2, days: null },
      removable: true,
    });
    const page = await data<MemberBounces>(
      await call('GET', `/api/v1/members/${memberId}/bounces`, { cookie: team.cookie }),
    );
    expect(page.stopped).toMatchObject({ reason: 'soft_bounce', bounce: { rule: 'soft_streak' } });
    expect(page.events).toHaveLength(2);
    expect(page.events[0]).toMatchObject({ kind: 'soft', cause: 'mailbox_full', code: '4.2.2' });

    // Removing the suppression brings the subscriber back and starts the counts again.
    const removed = await call('DELETE', `/api/v1/channels/${ch}/suppressions/${row!.id}`, {
      cookie: team.cookie,
    });
    expect(removed.status).toBe(204);
    const back = await env.DB.prepare('SELECT status FROM members WHERE id = ?1')
      .bind(memberId)
      .first<{ status: string }>();
    expect(back?.status).toBe('active');
    expect(
      await data<MemberBounces>(
        await call('GET', `/api/v1/members/${memberId}/bounces`, { cookie: team.cookie }),
      ),
    ).toEqual({ softStreak: 0, held: null, stopped: null, events: [] });
    const audit = await env.DB.prepare(
      `SELECT action FROM audit_events WHERE workspace_id = ?1 AND action IN ('bounce_policy.changed', 'suppression.removed') ORDER BY seq`,
    )
      .bind(team.workspaceId)
      .all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toEqual([
      'bounce_policy.changed',
      'bounce_policy.changed',
      'suppression.removed',
    ]);
  });
});

describe('subscribers on a paid plan held for an admin', () => {
  let owner: Session;
  let channelId: string;
  let memberId: string;
  let to: string;
  let hold: BounceHold;

  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
    to = uniqueEmail('paid');
    memberId = await addMember(channelId, to, true);
    await softBounces(channelId, owner.workspaceId, memberId, to, 3);
    const holds = await data<BounceHold[]>(
      await call('GET', holdsPath(channelId), { cookie: owner.cookie }),
    );
    hold = holds[0]!;
  });

  it('lists the held subscriber, still mailed, with the last bounce', () => {
    expect(hold).toMatchObject({
      email: to,
      memberId,
      rule: 'soft_streak',
      counted: 3,
      last: { kind: 'soft', cause: 'mailbox_full', detail: FULL },
    });
  });

  it('needs a workspace admin to decide, and is not found through another publication', async () => {
    const viewer = await seatAs(owner.workspaceId, 'viewer');
    const body = { decision: 'keep' };
    const path = `${holdsPath(channelId)}/${hold.id}`;
    expect((await call('GET', holdsPath(channelId), { cookie: viewer.cookie })).status).toBe(200);
    expect((await call('POST', path, { cookie: viewer.cookie, body })).status).toBe(403);
    // A Channel admin role on an author seat raises nothing, so it cannot decide here.
    const channelAdmin = await seatAs(owner.workspaceId, 'author');
    await env.DB.prepare(
      `INSERT INTO channel_roles (id, channel_id, operator_id, role, created_at) VALUES (?1, ?2, ?3, 'admin', 0)`,
    )
      .bind(newId('channelRole'), channelId, channelAdmin.me.operator.id)
      .run();
    expect((await call('POST', path, { cookie: channelAdmin.cookie, body })).status).toBe(403);
    // Another publication of the same workspace, where the address has no subscriber.
    const other = (await createChannel(owner)).id;
    expect(
      (await call('POST', `${holdsPath(other)}/${hold.id}`, { cookie: owner.cookie, body })).status,
    ).toBe(404);
    // Another workspace.
    const outsider = await signIn();
    const theirs = (await createChannel(outsider)).id;
    expect((await call('GET', holdsPath(channelId), { cookie: outsider.cookie })).status).toBe(404);
    expect(
      (await call('POST', `${holdsPath(theirs)}/${hold.id}`, { cookie: outsider.cookie, body }))
        .status,
    ).toBe(404);
    expect(
      (await call('GET', `/api/v1/members/${memberId}/bounces`, { cookie: outsider.cookie }))
        .status,
    ).toBe(404);
  });

  it('"stop" stops mailing the address; the hold is gone', async () => {
    const res = await call('POST', `${holdsPath(channelId)}/${hold.id}`, {
      cookie: owner.cookie,
      body: { decision: 'stop' },
    });
    expect(res.status).toBe(204);
    const member = await env.DB.prepare('SELECT status FROM members WHERE id = ?1')
      .bind(memberId)
      .first<{ status: string }>();
    expect(member?.status).toBe('bounced');
    expect(
      await data<BounceHold[]>(await call('GET', holdsPath(channelId), { cookie: owner.cookie })),
    ).toEqual([]);
    expect(
      (
        await call('POST', `${holdsPath(channelId)}/${hold.id}`, {
          cookie: owner.cookie,
          body: { decision: 'keep' },
        })
      ).status,
    ).toBe(404);
  });
});
