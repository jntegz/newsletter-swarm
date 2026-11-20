import { env } from 'cloudflare:test';
import type {
  Circle,
  CircleListItem,
  CirclePreview,
  CircleRule,
  Dispatch,
  Member,
  Preflight,
  SeatRole,
} from '@swarm/domain';
import { newId } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, json, seatAs, signIn, type Session } from './helpers';

async function data<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await json<{ data: T }>(res)).data;
}

/** Members m0…m(n-1); every third is tagged VIP, every second is named Ada, one is paused. */
async function seedMembers(channelId: string, count: number) {
  const now = Date.now();
  const tagId = newId('tag');
  const ids: string[] = [];
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      'INSERT INTO tags (id, channel_id, name, created_at) VALUES (?1, ?2, ?3, ?4)',
    ).bind(tagId, channelId, 'VIP', now),
  ];
  for (let i = 0; i < count; i++) {
    const id = newId('member', now + i);
    ids.push(id);
    statements.push(
      env.DB.prepare(
        `INSERT INTO members (id, channel_id, email, first_name, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
      ).bind(
        id,
        channelId,
        `m${i}-${crypto.randomUUID().slice(0, 6)}@example.org`,
        i % 2 === 0 ? 'Ada' : null,
        i === 3 ? 'paused' : 'active',
        now + i,
      ),
    );
    if (i % 3 === 0) {
      statements.push(
        env.DB.prepare(
          'INSERT INTO member_tags (member_id, tag_id, created_at) VALUES (?1, ?2, ?3)',
        ).bind(id, tagId, now),
      );
    }
  }
  await env.DB.batch(statements);
  return ids;
}

const VIP: CircleRule = { field: 'tag', cmp: 'eq', value: 'vip' };

async function createCircle(s: Session, channelId: string, rule: CircleRule = VIP, name = 'VIPs') {
  return data<Circle>(
    await call('POST', `/api/v1/channels/${channelId}/circles`, {
      cookie: s.cookie,
      body: { name, rule },
    }),
    201,
  );
}

describe('circles', () => {
  let owner: Session;
  let channelId: string;
  let ids: string[];

  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
    ids = await seedMembers(channelId, 30);
  });

  it('previews a rule live with an exact count and a sample', async () => {
    const preview = await data<CirclePreview>(
      await call('POST', `/api/v1/channels/${channelId}/circles/preview`, {
        cookie: owner.cookie,
        body: {
          rule: {
            op: 'or',
            children: [VIP, { field: 'first_name', cmp: 'eq', value: 'ADA' }],
          },
        },
      }),
    );
    // i % 3 == 0 or i % 2 == 0, for i < 30: 20 Members; i = 3 is paused.
    expect(preview.count).toBe(20);
    expect(preview.activeCount).toBe(19);
    expect(preview.sample).toHaveLength(20);
    expect(preview.sample[0]!.id).toBe(ids[28]);
  });

  it('refuses a paid plan from another Channel, and takes one from this Channel', async () => {
    const levelIn = async (channelId: string) => {
      const id = newId('membershipLevel');
      await env.DB.prepare(
        `INSERT INTO membership_levels (id, channel_id, name, created_at, updated_at)
         VALUES (?1, ?2, 'Gold', 0, 0)`,
      )
        .bind(id, channelId)
        .run();
      return id;
    };
    const rule = (value: string): CircleRule => ({ field: 'level', cmp: 'eq', value });
    const mine = await levelIn(channelId);
    const other = await createChannel(owner);
    const theirs = await levelIn(other.id);
    const preview = (value: string) =>
      call('POST', `/api/v1/channels/${channelId}/circles/preview`, {
        cookie: owner.cookie,
        body: { rule: rule(value) },
      });
    expect((await preview(mine)).status).toBe(200);
    const refused = await preview(theirs);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('Choose paid plans from this publication.');
    const create = await call('POST', `/api/v1/channels/${channelId}/circles`, {
      cookie: owner.cookie,
      body: { name: 'Elsewhere', rule: rule(theirs) },
    });
    expect(create.status).toBe(400);
  });

  it('answers 400 with the path for a rule that does not fit', async () => {
    for (const [rule, path] of [
      [{ field: 'password', cmp: 'eq', value: 'x' }, 'rule.field'],
      [{ op: 'and', children: [{ field: 'email', cmp: 'gt', value: 'x' }] }, 'rule.children.0.cmp'],
      [{ field: 'field:missing', cmp: 'is_set' }, 'rule.field'],
    ] as const) {
      const res = await call('POST', `/api/v1/channels/${channelId}/circles/preview`, {
        cookie: owner.cookie,
        body: { rule },
      });
      expect(res.status).toBe(400);
      const body = await json<{ error: { code: string; details: { path: string }[] } }>(res);
      expect(body.error.code).toBe('invalid_input');
      expect(body.error.details[0]!.path).toBe(path);
    }
    let deep: CircleRule = { field: 'email', cmp: 'is_set' };
    for (let i = 0; i < 21; i++) deep = { op: 'not', children: [deep] };
    const res = await call('POST', `/api/v1/channels/${channelId}/circles`, {
      cookie: owner.cookie,
      body: { name: 'Deep', rule: deep },
    });
    expect(res.status).toBe(400);
  });

  it('lists each Circle with its active Members next to the count of every status', async () => {
    const circle = await createCircle(owner, channelId, VIP, 'Active count');
    // Members 0, 3, 6 and 9 (3 is paused); 6 is then unsubscribed.
    const chosen = [ids[0]!, ids[3]!, ids[6]!, ids[9]!];
    await env.DB.batch([
      ...chosen.map((id) =>
        env.DB.prepare(
          'INSERT INTO circle_members (circle_id, member_id, generation) VALUES (?1, ?2, 1)',
        ).bind(circle.id, id),
      ),
      env.DB.prepare(`UPDATE circles SET member_count = 4, status = 'ready' WHERE id = ?1`).bind(
        circle.id,
      ),
      env.DB.prepare(`UPDATE members SET status = 'unsubscribed' WHERE id = ?1`).bind(ids[6]!),
    ]);
    const list = await data<{ items: CircleListItem[] }>(
      await call('GET', `/api/v1/channels/${channelId}/circles?limit=100`, {
        cookie: owner.cookie,
      }),
    );
    expect(list.items.find((c) => c.id === circle.id)).toMatchObject({
      memberCount: 4,
      activeCount: 2,
    });
    await env.DB.prepare(`UPDATE members SET status = 'active' WHERE id = ?1`).bind(ids[6]!).run();
    await call('DELETE', `/api/v1/circles/${circle.id}`, { cookie: owner.cookie });
  });

  it('creates, lists, renames, re-rules, refreshes and deletes, with an audit trail', async () => {
    const circle = await createCircle(owner, channelId);
    expect(circle).toMatchObject({ name: 'VIPs', status: 'pending', memberCount: 0, rule: VIP });
    const stored = await env.DB.prepare('SELECT generation FROM circles WHERE id = ?1')
      .bind(circle.id)
      .first<{ generation: number }>();
    expect(stored?.generation).toBe(1);

    const list = await data<{ items: Circle[]; nextCursor: string | null }>(
      await call('GET', `/api/v1/channels/${channelId}/circles?limit=100`, {
        cookie: owner.cookie,
      }),
    );
    expect(list.items.map((c) => c.id)).toContain(circle.id);

    // Renaming keeps the generation; a new rule bumps it and sets the Circle pending again.
    await env.DB.prepare(`UPDATE circles SET status = 'ready' WHERE id = ?1`).bind(circle.id).run();
    const renamed = await data<Circle>(
      await call('PATCH', `/api/v1/circles/${circle.id}`, {
        cookie: owner.cookie,
        body: { name: 'Best readers', description: 'Tagged VIP' },
      }),
    );
    expect(renamed).toMatchObject({ name: 'Best readers', status: 'ready' });
    const rerule = await data<Circle>(
      await call('PATCH', `/api/v1/circles/${circle.id}`, {
        cookie: owner.cookie,
        body: { rule: { field: 'first_name', cmp: 'is_set' } },
      }),
    );
    expect(rerule.status).toBe('pending');
    expect(
      (
        await env.DB.prepare('SELECT generation FROM circles WHERE id = ?1')
          .bind(circle.id)
          .first<{ generation: number }>()
      )?.generation,
    ).toBe(2);

    expect(
      (await call('POST', `/api/v1/circles/${circle.id}/refresh`, { cookie: owner.cookie })).status,
    ).toBe(202);

    expect(
      (await call('DELETE', `/api/v1/circles/${circle.id}`, { cookie: owner.cookie })).status,
    ).toBe(204);
    expect(
      (await call('GET', `/api/v1/circles/${circle.id}`, { cookie: owner.cookie })).status,
    ).toBe(404);

    const { results } = await env.DB.prepare(
      `SELECT action FROM audit_events WHERE target_id = ?1 ORDER BY seq`,
    )
      .bind(circle.id)
      .all<{ action: string }>();
    expect(results.map((r) => r.action)).toEqual([
      'circle.created',
      'circle.updated',
      'circle.updated',
      'circle.deleted',
    ]);
  });

  it('re-queues a Circle stuck pending on a manual refresh, and clears its lost-refresh backoff', async () => {
    const circle = await createCircle(owner, channelId, VIP, 'Stuck');
    const state = () =>
      env.DB.prepare('SELECT status, updated_at, refresh_failures FROM circles WHERE id = ?1')
        .bind(circle.id)
        .first<{ status: string; updated_at: number; refresh_failures: number }>();
    const refresh = () =>
      call('POST', `/api/v1/circles/${circle.id}/refresh`, { cookie: owner.cookie });
    // Five refreshes lost in a row: the cron waits up to 8 hours before the next.
    const stuckSince = Date.now() - 20 * 60 * 1000;
    await env.DB.prepare(
      "UPDATE circles SET status = 'pending', updated_at = ?2, refresh_failures = 5 WHERE id = ?1",
    )
      .bind(circle.id, stuckSince)
      .run();
    expect((await refresh()).status).toBe(202);
    const requeued = await state();
    expect(requeued).toMatchObject({ status: 'pending', refresh_failures: 0 });
    expect(requeued!.updated_at).toBeGreaterThan(stuckSince);
    // Pending only a moment: its refresh is queued, so another would only repeat it.
    const recent = Date.now() - 60 * 1000;
    await env.DB.prepare('UPDATE circles SET updated_at = ?2, refresh_failures = 1 WHERE id = ?1')
      .bind(circle.id, recent)
      .run();
    expect((await refresh()).status).toBe(202);
    expect(await state()).toMatchObject({ updated_at: recent, refresh_failures: 1 });
    await call('DELETE', `/api/v1/circles/${circle.id}`, { cookie: owner.cookie });
  });

  it('pages through materialised members', async () => {
    const circle = await createCircle(owner, channelId);
    await env.DB.batch(
      ids
        .slice(0, 5)
        .map((id) =>
          env.DB.prepare(
            'INSERT INTO circle_members (circle_id, member_id, generation) VALUES (?1, ?2, 1)',
          ).bind(circle.id, id),
        ),
    );
    const page1 = await data<{ items: Member[]; nextCursor: string | null }>(
      await call('GET', `/api/v1/circles/${circle.id}/members?limit=3`, { cookie: owner.cookie }),
    );
    expect(page1.items.map((m) => m.id)).toEqual([ids[4], ids[3], ids[2]]);
    const page2 = await data<{ items: Member[]; nextCursor: string | null }>(
      await call('GET', `/api/v1/circles/${circle.id}/members?limit=3&cursor=${page1.nextCursor}`, {
        cookie: owner.cookie,
      }),
    );
    expect(page2.items.map((m) => m.id)).toEqual([ids[1], ids[0]]);
    expect(page2.nextCursor).toBeNull();
  });
});

describe('dispatch audiences', () => {
  let owner: Session;
  let channelId: string;

  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
    await seedMembers(channelId, 12);
  });

  async function newDispatch() {
    return data<Dispatch>(
      await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
        cookie: owner.cookie,
        body: {
          subject: 'Issue 1',
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
          },
        },
      }),
      201,
    );
  }

  it('addresses a Dispatch to Circles and counts the exact deduplicated audience', async () => {
    const dispatch = await newDispatch();
    expect(dispatch.audience).toEqual({ include: [], exclude: [] });
    const vips = await createCircle(owner, channelId);
    const adas = await createCircle(
      owner,
      channelId,
      { field: 'first_name', cmp: 'eq', value: 'Ada' },
      'Adas',
    );
    const saved = await data<Dispatch>(
      await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
        cookie: owner.cookie,
        body: { audience: { include: [vips.id], exclude: [adas.id] } },
      }),
    );
    expect(saved.audience).toEqual({ include: [vips.id], exclude: [adas.id] });
    // A later save without an audience keeps it.
    const kept = await data<Dispatch>(
      await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
        cookie: owner.cookie,
        body: { subject: 'Issue 1, again' },
      }),
    );
    expect(kept.audience).toEqual(saved.audience);

    // VIP: i = 0, 3, 6, 9; minus Adas (even i): 3 and 9; 3 is paused. One recipient.
    const check = await data<Preflight>(
      await call('GET', `/api/v1/dispatches/${dispatch.id}/preflight`, { cookie: owner.cookie }),
    );
    expect(check.recipientCount).toBe(1);
    expect(check.audience).toEqual(saved.audience);

    // Both Circles included overlap on i = 0 and 6: counted once each.
    await data<Dispatch>(
      await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
        cookie: owner.cookie,
        body: { audience: { include: [vips.id, adas.id], exclude: [] } },
      }),
    );
    const both = await data<Preflight>(
      await call('GET', `/api/v1/dispatches/${dispatch.id}/preflight`, { cookie: owner.cookie }),
    );
    // VIP ∪ Ada = {0,2,3,4,6,8,9,10} minus paused 3.
    expect(both.recipientCount).toBe(7);
  });

  it('refuses Circles from another Channel or workspace, and the same Circle twice', async () => {
    const dispatch = await newDispatch();
    const otherChannel = (await createChannel(owner)).id;
    const foreign = await createCircle(owner, otherChannel);
    const stranger = await signIn();
    const theirs = await createCircle(stranger, (await createChannel(stranger)).id);
    const mine = await createCircle(owner, channelId);
    for (const audience of [
      { include: [foreign.id], exclude: [] },
      { include: [], exclude: [theirs.id] },
      { include: [mine.id], exclude: [mine.id] },
      { include: ['cl_not-an-id'], exclude: [] },
    ]) {
      const res = await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
        cookie: owner.cookie,
        body: { audience },
      });
      expect(res.status, JSON.stringify(audience)).toBe(400);
    }
  });

  it('keeps a Circle while a scheduled Dispatch is addressed to it', async () => {
    const dispatch = await newDispatch();
    const circle = await createCircle(owner, channelId);
    await data(
      await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
        cookie: owner.cookie,
        body: { audience: { include: [], exclude: [circle.id] } },
      }),
    );
    await env.DB.prepare(
      `UPDATE dispatches SET status = 'scheduled', publish_at = ?1 WHERE id = ?2`,
    )
      .bind(Date.now() + 3_600_000, dispatch.id)
      .run();
    const res = await call('DELETE', `/api/v1/circles/${circle.id}`, { cookie: owner.cookie });
    expect(res.status).toBe(409);
  });
});

describe('roles and tenancy for Circles', () => {
  const ROLES: SeatRole[] = ['viewer', 'author', 'editor', 'admin', 'owner'];
  let owner: Session;
  let outsider: Session;
  const seats = {} as Record<SeatRole, Session>;
  let channelId: string;
  let circleId: string;

  beforeAll(async () => {
    owner = await signIn();
    seats.owner = owner;
    for (const role of ['viewer', 'author', 'editor', 'admin'] as const)
      seats[role] = await seatAs(owner.workspaceId, role);
    outsider = await signIn();
    channelId = (await createChannel(owner)).id;
    await seedMembers(channelId, 3);
    circleId = (await createCircle(owner, channelId)).id;
  });

  const ROUTES: { name: string; minimum: SeatRole; request: (s: Session) => Promise<Response> }[] =
    [
      {
        name: 'list circles',
        minimum: 'viewer',
        request: (s) => call('GET', `/api/v1/channels/${channelId}/circles`, { cookie: s.cookie }),
      },
      {
        name: 'get circle',
        minimum: 'viewer',
        request: (s) => call('GET', `/api/v1/circles/${circleId}`, { cookie: s.cookie }),
      },
      {
        name: 'circle members',
        minimum: 'viewer',
        request: (s) => call('GET', `/api/v1/circles/${circleId}/members`, { cookie: s.cookie }),
      },
      {
        name: 'preview',
        minimum: 'viewer',
        request: (s) =>
          call('POST', `/api/v1/channels/${channelId}/circles/preview`, {
            cookie: s.cookie,
            body: { rule: VIP },
          }),
      },
      {
        name: 'create circle',
        minimum: 'author',
        request: (s) =>
          call('POST', `/api/v1/channels/${channelId}/circles`, {
            cookie: s.cookie,
            body: { name: 'Made by role', rule: VIP },
          }),
      },
      {
        name: 'update circle',
        minimum: 'author',
        request: (s) =>
          call('PATCH', `/api/v1/circles/${circleId}`, {
            cookie: s.cookie,
            body: { description: 'Edited' },
          }),
      },
      {
        name: 'refresh circle',
        minimum: 'author',
        request: (s) => call('POST', `/api/v1/circles/${circleId}/refresh`, { cookie: s.cookie }),
      },
    ];

  for (const route of ROUTES) {
    for (const role of ROLES) {
      const allowed = ROLES.indexOf(role) >= ROLES.indexOf(route.minimum);
      it(`${route.name}: ${role} is ${allowed ? 'allowed' : 'refused'}`, async () => {
        const res = await route.request(seats[role]);
        if (allowed) expect(res.status, await res.clone().text()).toBeLessThan(300);
        else expect(res.status).toBe(403);
      });
    }
    it(`${route.name}: another workspace's operator gets 404`, async () => {
      expect((await route.request(outsider)).status).toBe(404);
    });
  }

  it('deletes with author and above only, and hides the Circle from other workspaces', async () => {
    const victim = (await createCircle(owner, channelId)).id;
    expect(
      (await call('DELETE', `/api/v1/circles/${victim}`, { cookie: outsider.cookie })).status,
    ).toBe(404);
    expect(
      (await call('DELETE', `/api/v1/circles/${victim}`, { cookie: seats.viewer.cookie })).status,
    ).toBe(403);
    expect(
      (await call('DELETE', `/api/v1/circles/${victim}`, { cookie: seats.author.cookie })).status,
    ).toBe(204);
  });
});

describe('event-driven refresh', () => {
  it('marks the Channel’s Circles for re-evaluation when a Member changes', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const circle = await data<{ id: string }>(
      await call('POST', `/api/v1/channels/${channelId}/circles`, {
        cookie: owner.cookie,
        body: { name: 'Everyone active', rule: { field: 'status', cmp: 'eq', value: 'active' } },
      }),
      201,
    );
    const status = async () =>
      (
        await env.DB.prepare('SELECT status FROM circles WHERE id = ?1')
          .bind(circle.id)
          .first<{ status: string }>()
      )?.status;

    await env.DB.prepare("UPDATE circles SET status = 'ready' WHERE id = ?1").bind(circle.id).run();
    const added = await call('POST', `/api/v1/channels/${channelId}/members`, {
      cookie: owner.cookie,
      body: { email: `refresh-${crypto.randomUUID()}@example.org`, consent: true },
    });
    expect(added.status).toBe(201);
    await expect.poll(status).toBe('pending');
  });
});
