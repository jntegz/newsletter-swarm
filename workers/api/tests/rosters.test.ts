// Rosters (Phase 8, flag rosters): CRUD, roles and tenancy, memberships, audiences with the
// conflict policy and dedupe, unsubscribe links, Capture Form configs, imports, exports and /v2.
import { env } from 'cloudflare:test';
import type {
  CaptureForm,
  Dispatch,
  MemberRosters,
  Preflight,
  Roster,
  RosterMember,
  RosterOverlap,
} from '@swarm/domain';
import { defaultCaptureFormConfig } from '@swarm/domain';
import { unsubscribeDelivery } from '@swarm/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedDelivery } from './audience-helpers';
import { call, createChannel, seatAs, signIn, type Session } from './helpers';
import { addMember, data, enableFlag, errorCode } from './money-helpers';
import { createKey, v2, v2Data } from './v2-helpers';

const base = (channelId: string) => `/api/v1/channels/${channelId}`;

async function createRoster(s: Session, channelId: string, name: string, extra = {}) {
  return data<Roster>(
    await call('POST', `${base(channelId)}/rosters`, {
      cookie: s.cookie,
      body: { name, ...extra },
    }),
    201,
  );
}

const setMembership = (
  s: Session,
  channelId: string,
  memberId: string,
  rosterId: string,
  status: string,
) =>
  call('PUT', `${base(channelId)}/members/${memberId}/rosters/${rosterId}`, {
    cookie: s.cookie,
    body: { status },
  });

async function subscribe(s: Session, channelId: string, memberId: string, rosterId: string) {
  return data<MemberRosters>(await setMembership(s, channelId, memberId, rosterId, 'subscribed'));
}

async function events(memberId: string) {
  const { results } = await env.DB.prepare(
    "SELECT type, payload_json FROM member_events WHERE member_id = ?1 AND type LIKE 'roster_%' ORDER BY seq",
  )
    .bind(memberId)
    .all<{ type: string; payload_json: string }>();
  return results.map((r) => ({ type: r.type, ...(JSON.parse(r.payload_json) as object) }));
}

describe('Rosters: the flag, roles and tenancy', () => {
  let owner: Session;
  let channelId: string;

  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
  });

  it('is off by default: every route answers feature_disabled', async () => {
    const list = await call('GET', `${base(channelId)}/rosters`, { cookie: owner.cookie });
    expect(list.status).toBe(404);
    expect(await errorCode(list)).toBe('feature_disabled');
    const create = await call('POST', `${base(channelId)}/rosters`, {
      cookie: owner.cookie,
      body: { name: 'Deals' },
    });
    expect(await errorCode(create)).toBe('feature_disabled');
    const overlap = await call('POST', `${base(channelId)}/rosters/overlap`, {
      cookie: owner.cookie,
      body: { include: [], exclude: [] },
    });
    expect(await errorCode(overlap)).toBe('feature_disabled');
  });

  it('creates, renames, hides and deletes Rosters; names are unique ignoring case', async () => {
    await enableFlag('rosters', owner.workspaceId, channelId);
    const deals = await createRoster(owner, channelId, 'Deals', { description: 'Weekly' });
    expect(deals).toMatchObject({
      name: 'Deals',
      description: 'Weekly',
      memberCenter: true,
      subscribedCount: 0,
      activeCount: 0,
    });
    const dupe = await call('POST', `${base(channelId)}/rosters`, {
      cookie: owner.cookie,
      body: { name: 'deals' },
    });
    expect(dupe.status).toBe(409);
    const saved = await data<Roster>(
      await call('PATCH', `${base(channelId)}/rosters/${deals.id}`, {
        cookie: owner.cookie,
        body: { name: 'Deals and offers', memberCenter: false },
      }),
    );
    expect(saved).toMatchObject({ name: 'Deals and offers', memberCenter: false });
    const list = await data<{ items: Roster[] }>(
      await call('GET', `${base(channelId)}/rosters`, { cookie: owner.cookie }),
    );
    expect(list.items.map((r) => r.id)).toContain(deals.id);
    const gone = await call('DELETE', `${base(channelId)}/rosters/${deals.id}`, {
      cookie: owner.cookie,
    });
    expect(gone.status).toBe(204);
    const after = await call('GET', `${base(channelId)}/rosters/${deals.id}`, {
      cookie: owner.cookie,
    });
    expect(after.status).toBe(404);
    // The name is free again once the Roster is deleted.
    await createRoster(owner, channelId, 'Deals');
  });

  it('lets viewers read and only editors and up change', async () => {
    const roster = await createRoster(owner, channelId, 'Roles');
    const member = await addMember(owner, channelId);
    for (const role of ['viewer', 'author'] as const) {
      const s = await seatAs(owner.workspaceId, role);
      const read = await call('GET', `${base(channelId)}/rosters/${roster.id}`, {
        cookie: s.cookie,
      });
      expect(read.status).toBe(200);
      const members = await call('GET', `${base(channelId)}/rosters/${roster.id}/members`, {
        cookie: s.cookie,
      });
      expect(members.status).toBe(200);
      for (const res of [
        await call('POST', `${base(channelId)}/rosters`, {
          cookie: s.cookie,
          body: { name: `By ${role}` },
        }),
        await call('PATCH', `${base(channelId)}/rosters/${roster.id}`, {
          cookie: s.cookie,
          body: { name: 'Renamed' },
        }),
        await call('DELETE', `${base(channelId)}/rosters/${roster.id}`, { cookie: s.cookie }),
        await setMembership(s, channelId, member.id, roster.id, 'subscribed'),
      ]) {
        expect(res.status).toBe(403);
      }
    }
    const editor = await seatAs(owner.workspaceId, 'editor');
    expect(
      (await setMembership(editor, channelId, member.id, roster.id, 'subscribed')).status,
    ).toBe(200);
  });

  it('never reveals or changes another workspace’s or Channel’s Rosters', async () => {
    const roster = await createRoster(owner, channelId, 'Private');
    const member = await addMember(owner, channelId);
    const stranger = await signIn();
    const theirChannel = (await createChannel(stranger)).id;
    await enableFlag('rosters', stranger.workspaceId, theirChannel);
    for (const res of [
      await call('GET', `${base(channelId)}/rosters`, { cookie: stranger.cookie }),
      await call('GET', `${base(channelId)}/rosters/${roster.id}`, { cookie: stranger.cookie }),
      await call('DELETE', `${base(channelId)}/rosters/${roster.id}`, { cookie: stranger.cookie }),
      await call('GET', `${base(theirChannel)}/rosters/${roster.id}`, { cookie: stranger.cookie }),
      await call('PATCH', `${base(theirChannel)}/rosters/${roster.id}`, {
        cookie: stranger.cookie,
        body: { name: 'Mine now' },
      }),
      await setMembership(stranger, theirChannel, member.id, roster.id, 'subscribed'),
      await setMembership(stranger, channelId, member.id, roster.id, 'subscribed'),
    ]) {
      expect(res.status).toBe(404);
    }
    // A Roster of another Channel in the same workspace isn't reachable through this one.
    const other = (await createChannel(owner)).id;
    await enableFlag('rosters', owner.workspaceId, other);
    const elsewhere = await createRoster(owner, other, 'Elsewhere');
    expect(
      (await setMembership(owner, channelId, member.id, elsewhere.id, 'subscribed')).status,
    ).toBe(404);
    const theirMember = await addMember(owner, other);
    expect(
      (await setMembership(owner, channelId, theirMember.id, roster.id, 'subscribed')).status,
    ).toBe(404);
  });
});

describe('Rosters: memberships', () => {
  let owner: Session;
  let channelId: string;

  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
    await enableFlag('rosters', owner.workspaceId, channelId);
  });

  it('subscribes and unsubscribes idempotently, with one event per change', async () => {
    const roster = await createRoster(owner, channelId, 'News');
    const member = await addMember(owner, channelId);
    const first = await subscribe(owner, channelId, member.id, roster.id);
    expect(first.items).toMatchObject([
      { rosterId: roster.id, rosterName: 'News', status: 'subscribed', source: 'operator' },
    ]);
    await subscribe(owner, channelId, member.id, roster.id);
    const left = await data<MemberRosters>(
      await setMembership(owner, channelId, member.id, roster.id, 'unsubscribed'),
    );
    expect(left.items[0]).toMatchObject({ status: 'unsubscribed', source: 'operator' });
    await setMembership(owner, channelId, member.id, roster.id, 'unsubscribed');
    // An operator may put back someone they removed.
    await subscribe(owner, channelId, member.id, roster.id);
    expect(await events(member.id)).toEqual([
      { type: 'roster_joined', rosterId: roster.id, source: 'operator' },
      { type: 'roster_left', rosterId: roster.id, source: 'operator' },
      { type: 'roster_joined', rosterId: roster.id, source: 'operator' },
    ]);
    const counted = await data<Roster>(
      await call('GET', `${base(channelId)}/rosters/${roster.id}`, { cookie: owner.cookie }),
    );
    expect(counted).toMatchObject({ subscribedCount: 1, activeCount: 1 });
    const page = await data<{ items: RosterMember[]; nextCursor: string | null }>(
      await call('GET', `${base(channelId)}/rosters/${roster.id}/members?status=subscribed`, {
        cookie: owner.cookie,
      }),
    );
    expect(page.items.map((m) => m.memberId)).toEqual([member.id]);
  });

  it('refuses to re-subscribe a Member who left the Roster themselves', async () => {
    const roster = await createRoster(owner, channelId, 'Left');
    const member = await addMember(owner, channelId);
    await subscribe(owner, channelId, member.id, roster.id);
    await env.DB.prepare(
      "UPDATE roster_members SET status = 'unsubscribed', source = 'member' WHERE roster_id = ?1 AND member_id = ?2",
    )
      .bind(roster.id, member.id)
      .run();
    const res = await setMembership(owner, channelId, member.id, roster.id, 'subscribed');
    expect(res.status).toBe(409);
  });

  it('pages a Roster’s memberships with a cursor', async () => {
    const roster = await createRoster(owner, channelId, 'Paged');
    for (let i = 0; i < 3; i++) {
      await subscribe(owner, channelId, (await addMember(owner, channelId)).id, roster.id);
    }
    const one = await data<{ items: RosterMember[]; nextCursor: string | null }>(
      await call('GET', `${base(channelId)}/rosters/${roster.id}/members?limit=2`, {
        cookie: owner.cookie,
      }),
    );
    expect(one.items).toHaveLength(2);
    const two = await data<{ items: RosterMember[]; nextCursor: string | null }>(
      await call(
        'GET',
        `${base(channelId)}/rosters/${roster.id}/members?limit=2&cursor=${encodeURIComponent(one.nextCursor!)}`,
        { cookie: owner.cookie },
      ),
    );
    expect(two.items).toHaveLength(1);
    expect(two.nextCursor).toBeNull();
    const bad = await call('GET', `${base(channelId)}/rosters/${roster.id}/members?cursor=nope`, {
      cookie: owner.cookie,
    });
    expect(bad.status).toBe(400);
  });
});

describe('Rosters: audiences', () => {
  let owner: Session;
  let channelId: string;
  let deals: Roster;
  let events_: Roster;
  let press: Roster;
  /** m[0] Deals; m[1] Deals + Events; m[2] Deals + Press; m[3] Events; m[4] none; m[5] paused on Deals. */
  const m: string[] = [];

  async function newDispatch() {
    return data<Dispatch>(
      await call('POST', `${base(channelId)}/dispatches`, {
        cookie: owner.cookie,
        body: { subject: 'Issue 1' },
      }),
      201,
    );
  }

  const audience = (dispatchId: string, body: unknown) =>
    call('PATCH', `/api/v1/dispatches/${dispatchId}`, {
      cookie: owner.cookie,
      body: { audience: body },
    });

  const preflight = async (dispatchId: string) =>
    data<Preflight>(
      await call('GET', `/api/v1/dispatches/${dispatchId}/preflight`, { cookie: owner.cookie }),
    );

  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
    await enableFlag('rosters', owner.workspaceId, channelId);
    deals = await createRoster(owner, channelId, 'Deals');
    events_ = await createRoster(owner, channelId, 'Events');
    press = await createRoster(owner, channelId, 'Press');
    for (let i = 0; i < 6; i++) m.push((await addMember(owner, channelId)).id);
    const join = [
      [0, deals],
      [1, deals],
      [1, events_],
      [2, deals],
      [2, press],
      [3, events_],
      [5, deals],
    ] as const;
    for (const [i, roster] of join) await subscribe(owner, channelId, m[i]!, roster.id);
    await env.DB.prepare("UPDATE members SET status = 'paused' WHERE id = ?1").bind(m[5]).run();
  });

  it('sends to the included Rosters once per Member, and applies the conflict policy', async () => {
    const dispatch = await newDispatch();
    const everyone = await preflight(dispatch.id);
    expect(everyone.recipientCount).toBe(5);

    const saved = await data<Dispatch>(
      await audience(dispatch.id, {
        include: [],
        exclude: [],
        rosters: { include: [deals.id, events_.id], exclude: [] },
      }),
    );
    expect(saved.audience.rosters).toEqual({
      include: [deals.id, events_.id],
      exclude: [],
      conflict: 'exclude_wins',
    });
    // m0, m1 (on both: counted once), m2, m3. m5 is paused.
    expect((await preflight(dispatch.id)).recipientCount).toBe(4);

    await audience(dispatch.id, {
      include: [],
      exclude: [],
      rosters: { include: [deals.id], exclude: [press.id], conflict: 'exclude_wins' },
    });
    // m2 is on Deals and Press: left out.
    expect((await preflight(dispatch.id)).recipientCount).toBe(2);
    await audience(dispatch.id, {
      include: [],
      exclude: [],
      rosters: { include: [deals.id], exclude: [press.id], conflict: 'include_wins' },
    });
    expect((await preflight(dispatch.id)).recipientCount).toBe(3);

    // Only an excluded Roster: everyone else.
    await audience(dispatch.id, {
      include: [],
      exclude: [],
      rosters: { include: [], exclude: [events_.id] },
    });
    expect((await preflight(dispatch.id)).recipientCount).toBe(3);

    const overlap = await data<RosterOverlap>(
      await call('POST', `${base(channelId)}/rosters/overlap`, {
        cookie: owner.cookie,
        body: { include: [deals.id], exclude: [press.id, events_.id] },
      }),
    );
    expect(overlap).toEqual({ included: 3, excluded: 3, conflicts: 2, recipients: 1 });

    // An empty Roster part is dropped, which is today's audience.
    const cleared = await data<Dispatch>(
      await audience(dispatch.id, {
        include: [],
        exclude: [],
        rosters: { include: [], exclude: [] },
      }),
    );
    expect(cleared.audience).toEqual({ include: [], exclude: [] });
  });

  it('combines Rosters with Circles by AND', async () => {
    const dispatch = await newDispatch();
    await env.DB.prepare("UPDATE members SET first_name = 'Ada' WHERE id IN (?1, ?2)")
      .bind(m[1], m[4])
      .run();
    const circle = await data<{ id: string }>(
      await call('POST', `${base(channelId)}/circles`, {
        cookie: owner.cookie,
        body: { name: 'Adas', rule: { field: 'first_name', cmp: 'eq', value: 'Ada' } },
      }),
      201,
    );
    await audience(dispatch.id, {
      include: [circle.id],
      exclude: [],
      rosters: { include: [deals.id], exclude: [] },
    });
    // Adas: m1, m4. On Deals: m0, m1, m2. Both: m1.
    expect((await preflight(dispatch.id)).recipientCount).toBe(1);
  });

  it('refuses Rosters of another Channel, and fails preflight once a Roster is deleted', async () => {
    const dispatch = await newDispatch();
    const other = (await createChannel(owner)).id;
    await enableFlag('rosters', owner.workspaceId, other);
    const foreign = await createRoster(owner, other, 'Foreign');
    const refused = await audience(dispatch.id, {
      include: [],
      exclude: [],
      rosters: { include: [foreign.id], exclude: [] },
    });
    expect(refused.status).toBe(400);
    const both = await audience(dispatch.id, {
      include: [],
      exclude: [],
      rosters: { include: [deals.id], exclude: [deals.id] },
    });
    expect(both.status).toBe(400);

    const doomed = await createRoster(owner, channelId, 'Doomed');
    await subscribe(owner, channelId, m[0]!, doomed.id);
    await audience(dispatch.id, {
      include: [],
      exclude: [],
      rosters: { include: [doomed.id], exclude: [] },
    });
    expect((await preflight(dispatch.id)).recipientCount).toBe(1);
    await call('DELETE', `${base(channelId)}/rosters/${doomed.id}`, { cookie: owner.cookie });
    const check = await preflight(dispatch.id);
    expect(check.ready).toBe(false);
    expect(check.checks.find((c) => c.key === 'audience')).toMatchObject({ ok: false });
  });

  it('with the flag off, refuses Roster audiences and fails a stored one', async () => {
    const dispatch = await newDispatch();
    await audience(dispatch.id, {
      include: [],
      exclude: [],
      rosters: { include: [deals.id], exclude: [] },
    });
    await env.DB.prepare(
      "UPDATE feature_flags SET enabled = 0 WHERE key = 'rosters' AND scope_id = ?1",
    )
      .bind(channelId)
      .run();
    await env.CACHE.delete(`flags:v1:${owner.workspaceId}:${channelId}`);
    try {
      const refused = await audience(dispatch.id, {
        include: [],
        exclude: [],
        rosters: { include: [deals.id], exclude: [] },
      });
      expect(await errorCode(refused)).toBe('feature_disabled');
      // Saving an audience without Rosters still works as before.
      expect((await audience(dispatch.id, { include: [], exclude: [] })).status).toBe(200);
      await env.DB.prepare('UPDATE dispatches SET audience_json = ?1 WHERE id = ?2')
        .bind(
          JSON.stringify({
            include: [],
            exclude: [],
            rosters: { include: [deals.id], exclude: [] },
          }),
          dispatch.id,
        )
        .run();
      const check = await preflight(dispatch.id);
      expect(check.checks.find((c) => c.key === 'audience')).toMatchObject({ ok: false });
    } finally {
      await env.DB.prepare(
        "UPDATE feature_flags SET enabled = 1 WHERE key = 'rosters' AND scope_id = ?1",
      )
        .bind(channelId)
        .run();
      await env.CACHE.delete(`flags:v1:${owner.workspaceId}:${channelId}`);
    }
  });
});

describe('Rosters: unsubscribe links', () => {
  let owner: Session;
  let channelId: string;

  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
    await enableFlag('rosters', owner.workspaceId, channelId);
  });

  async function rosterDelivery(rosterIds: string[]) {
    const member = await addMember(owner, channelId);
    const { broadcastId, deliveryId } = await seedDelivery(
      owner.workspaceId,
      channelId,
      member.id,
      member.email,
      Date.now(),
    );
    await env.DB.prepare('UPDATE broadcasts SET audience_json = ?1 WHERE id = ?2')
      .bind(
        JSON.stringify({ include: [], exclude: [], rosters: { include: rosterIds, exclude: [] } }),
        broadcastId,
      )
      .run();
    return { member, deliveryId };
  }

  const status = async (memberId: string) =>
    (await env.DB.prepare('SELECT status FROM members WHERE id = ?1')
      .bind(memberId)
      .first<{ status: string }>())!.status;

  it('leaves the Broadcast’s Rosters, not the Channel', async () => {
    const a = await createRoster(owner, channelId, 'A');
    const b = await createRoster(owner, channelId, 'B');
    const c = await createRoster(owner, channelId, 'C');
    const { member, deliveryId } = await rosterDelivery([a.id, b.id]);
    for (const roster of [a, b, c]) await subscribe(owner, channelId, member.id, roster.id);
    const result = await unsubscribeDelivery(env.DB, deliveryId);
    expect(result).toMatchObject({ rosters: ['A', 'B'] });
    expect(await status(member.id)).toBe('active');
    const rosters = await data<MemberRosters>(
      await call('GET', `${base(channelId)}/members/${member.id}/rosters`, {
        cookie: owner.cookie,
      }),
    );
    expect(
      Object.fromEntries(rosters.items.map((r) => [r.rosterName, [r.status, r.source]])),
    ).toEqual({
      A: ['unsubscribed', 'unsubscribe'],
      B: ['unsubscribed', 'unsubscribe'],
      C: ['subscribed', 'operator'],
    });
    const delivery = await env.DB.prepare('SELECT unsubscribed_at FROM deliveries WHERE id = ?1')
      .bind(deliveryId)
      .first<{ unsubscribed_at: number | null }>();
    expect(delivery?.unsubscribed_at).not.toBeNull();
    // They left themselves, so a teammate can't put them back.
    expect((await setMembership(owner, channelId, member.id, a.id, 'subscribed')).status).toBe(409);
  });

  it('leaves everything with scope all, or when the flag is off', async () => {
    const roster = await createRoster(owner, channelId, 'Everything');
    const one = await rosterDelivery([roster.id]);
    await subscribe(owner, channelId, one.member.id, roster.id);
    const all = await unsubscribeDelivery(env.DB, one.deliveryId, Date.now(), { scope: 'all' });
    expect(all).toMatchObject({ rosters: null });
    expect(await status(one.member.id)).toBe('unsubscribed');

    const two = await rosterDelivery([roster.id]);
    await subscribe(owner, channelId, two.member.id, roster.id);
    await env.DB.prepare(
      "UPDATE feature_flags SET enabled = 0 WHERE key = 'rosters' AND scope_id = ?1",
    )
      .bind(channelId)
      .run();
    try {
      expect(await unsubscribeDelivery(env.DB, two.deliveryId)).toMatchObject({ rosters: null });
      expect(await status(two.member.id)).toBe('unsubscribed');
    } finally {
      await env.DB.prepare(
        "UPDATE feature_flags SET enabled = 1 WHERE key = 'rosters' AND scope_id = ?1",
      )
        .bind(channelId)
        .run();
    }
  });
});

describe('Rosters: Capture Forms and exports', () => {
  let owner: Session;
  let channelId: string;

  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
  });

  it('needs the flag and Rosters of the Channel for a form’s rosterIds', async () => {
    const config = { ...defaultCaptureFormConfig(), rosterIds: ['rs_' + '0'.repeat(32)] };
    const off = await call('POST', `${base(channelId)}/capture-forms`, {
      cookie: owner.cookie,
      body: { name: 'Footer', config },
    });
    expect(await errorCode(off)).toBe('feature_disabled');
    await enableFlag('rosters', owner.workspaceId, channelId);
    const unknown = await call('POST', `${base(channelId)}/capture-forms`, {
      cookie: owner.cookie,
      body: { name: 'Footer', config },
    });
    expect(unknown.status).toBe(400);
    const roster = await createRoster(owner, channelId, 'From the footer');
    const form = await data<CaptureForm>(
      await call('POST', `${base(channelId)}/capture-forms`, {
        cookie: owner.cookie,
        body: { name: 'Footer', config: { ...config, rosterIds: [roster.id] } },
      }),
      201,
    );
    expect(form.draft.rosterIds).toEqual([roster.id]);
  });

  it('limits an export to a Roster and remembers to add the rosters column', async () => {
    const roster = await createRoster(owner, channelId, 'Exported');
    const res = await call('POST', `${base(channelId)}/exports`, {
      cookie: owner.cookie,
      body: { format: 'csv', rosterId: roster.id },
    });
    expect(res.status).toBe(202);
    const job = (await res.json()) as { data: { id: string; filter: Record<string, unknown> } };
    expect(job.data.filter).toEqual({ rosterId: roster.id });
    const row = await env.DB.prepare('SELECT filter_json FROM export_jobs WHERE id = ?1')
      .bind(job.data.id)
      .first<{ filter_json: string }>();
    expect(JSON.parse(row!.filter_json)).toEqual({ rosterId: roster.id, rosters: true });
  });
});

describe('/v2 Rosters', () => {
  let owner: Session;
  let channelId: string;
  let token: string;
  let readOnly: string;

  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
    token = (await createKey(owner, { scopes: ['rosters:write'] })).secret;
    readOnly = (await createKey(owner, { scopes: ['rosters:read'] })).secret;
  });

  it('answers feature_disabled while the flag is off', async () => {
    const res = await v2('GET', `/v2/channels/${channelId}/rosters`, token);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('feature_disabled');
  });

  it('manages Rosters and memberships', async () => {
    await enableFlag('rosters', owner.workspaceId, channelId);
    const roster = await v2Data<Roster>(
      await v2('POST', `/v2/channels/${channelId}/rosters`, token, { body: { name: 'API list' } }),
      201,
    );
    const member = await addMember(owner, channelId);
    const joined = await v2Data<MemberRosters>(
      await v2('PUT', `/v2/channels/${channelId}/rosters/${roster.id}/members/${member.id}`, token),
    );
    expect(joined.items[0]).toMatchObject({
      rosterId: roster.id,
      status: 'subscribed',
      source: 'api',
    });
    const listed = await v2Data<{ items: RosterMember[]; nextCursor: string | null }>(
      await v2('GET', `/v2/channels/${channelId}/rosters/${roster.id}/members`, readOnly),
    );
    expect(listed.items.map((r) => r.memberId)).toEqual([member.id]);
    const left = await v2Data<MemberRosters>(
      await v2(
        'DELETE',
        `/v2/channels/${channelId}/rosters/${roster.id}/members/${member.id}`,
        token,
      ),
    );
    expect(left.items[0]?.status).toBe('unsubscribed');
    // The events the roster.subscribed and roster.unsubscribed webhooks are made from.
    expect(await events(member.id)).toEqual([
      { type: 'roster_joined', rosterId: roster.id, source: 'api' },
      { type: 'roster_left', rosterId: roster.id, source: 'api' },
    ]);
    const mine = await v2Data<MemberRosters>(
      await v2('GET', `/v2/channels/${channelId}/members/${member.id}/rosters`, readOnly),
    );
    expect(mine.items).toHaveLength(1);
    expect(
      (
        await v2('PATCH', `/v2/channels/${channelId}/rosters/${roster.id}`, readOnly, {
          body: { name: 'x' },
        })
      ).status,
    ).toBe(403);
    const renamed = await v2Data<Roster>(
      await v2('PATCH', `/v2/channels/${channelId}/rosters/${roster.id}`, token, {
        body: { name: 'Renamed' },
      }),
    );
    expect(renamed.name).toBe('Renamed');
    expect(
      (await v2('DELETE', `/v2/channels/${channelId}/rosters/${roster.id}`, token)).status,
    ).toBe(204);
  });

  it('keeps another workspace’s Members out', async () => {
    const roster = await v2Data<Roster>(
      await v2('POST', `/v2/channels/${channelId}/rosters`, token, { body: { name: 'Fenced' } }),
      201,
    );
    const stranger = await signIn();
    const theirChannel = (await createChannel(stranger)).id;
    const theirs = await addMember(stranger, theirChannel);
    const res = await v2(
      'PUT',
      `/v2/channels/${channelId}/rosters/${roster.id}/members/${theirs.id}`,
      token,
    );
    expect(res.status).toBe(404);
  });
});
