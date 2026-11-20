// Saved views of the Member list: shared per Channel, used by viewers, saved by editors and up,
// never visible or changeable from another Channel or workspace. Also the list's Circle filter.
import { env } from 'cloudflare:test';
import { MAX_MEMBER_VIEWS, type MemberListItem, type MemberView } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, json, seatAs, signIn, uniqueEmail, type Session } from './helpers';

let owner: Session;
let viewer: Session;
let author: Session;
let editor: Session;
let outsider: Session;
let channelId: string;

const base = (id = channelId) => `/api/v1/channels/${id}/members/views`;
const hex32 = () => crypto.randomUUID().replace(/-/g, '');

async function save(session: Session, body: unknown, id = channelId) {
  return call('POST', base(id), { cookie: session.cookie, body });
}
async function saved(session: Session, body: unknown): Promise<MemberView> {
  const res = await save(session, body);
  expect(res.status, await res.clone().text()).toBe(201);
  return (await json<{ data: MemberView }>(res)).data;
}
async function list(session: Session, id = channelId) {
  const res = await call('GET', base(id), { cookie: session.cookie });
  return {
    status: res.status,
    views: res.ok ? (await json<{ data: MemberView[] }>(res)).data : [],
  };
}

beforeAll(async () => {
  owner = await signIn();
  viewer = await seatAs(owner.workspaceId, 'viewer');
  author = await seatAs(owner.workspaceId, 'author');
  editor = await seatAs(owner.workspaceId, 'editor');
  outsider = await signIn();
  channelId = (await createChannel(owner)).id;
});

describe('saved Member views', () => {
  it('saves a view that the whole team then sees, sorted by name', async () => {
    const paid = await saved(editor, {
      name: 'Paid readers',
      filters: { status: 'active', tag: 'paid', columns: ['name', 'status', 'field:plan'] },
    });
    expect(paid.id).toMatch(/^mv_[0-9a-f]{32}$/);
    expect(paid.filters).toEqual({
      status: 'active',
      tag: 'paid',
      columns: ['name', 'status', 'field:plan'],
    });
    expect(paid.createdBy).toBe(editor.me.operator.id);
    await saved(owner, { name: 'awaiting confirmation', filters: { status: 'pending' } });

    for (const session of [viewer, author, editor, owner]) {
      const { status, views } = await list(session);
      expect(status).toBe(200);
      expect(views.map((v) => v.name)).toEqual(['awaiting confirmation', 'Paid readers']);
    }
  });

  it('refuses a second view with the same name, ignoring case', async () => {
    const res = await save(editor, { name: 'PAID READERS', filters: {} });
    expect(res.status).toBe(409);
    const body = await json<{ error: { details: { path: string }[] } }>(res);
    expect(body.error.details[0]?.path).toBe('name');
  });

  it('checks the filters it stores', async () => {
    for (const filters of [
      { status: 'everyone' },
      { columns: ['not_a_column'] },
      { circleId: 'nope' },
      { unknown: true },
    ]) {
      expect((await save(editor, { name: `Bad ${hex32()}`, filters })).status).toBe(400);
    }
    expect((await save(editor, { name: '   ', filters: {} })).status).toBe(400);
    expect((await save(editor, { name: 'x'.repeat(61), filters: {} })).status).toBe(400);
  });

  it('only stores a Circle of the same Channel', async () => {
    const other = await createChannel(owner);
    const foreign = await insertCircle(other.id);
    const res = await save(editor, { name: 'Foreign', filters: { circleId: foreign } });
    expect(res.status).toBe(400);
    const own = await insertCircle(channelId);
    const view = await saved(editor, { name: 'Segment', filters: { circleId: own } });
    expect(view.filters.circleId).toBe(own);
  });

  it('lets viewers and authors use views but not save, rename or delete them', async () => {
    const view = await saved(editor, { name: `Team ${hex32()}`, filters: { q: 'ada' } });
    for (const session of [viewer, author]) {
      expect((await save(session, { name: `Mine ${hex32()}`, filters: {} })).status).toBe(403);
      const patch = await call('PATCH', `${base()}/${view.id}`, {
        cookie: session.cookie,
        body: { name: 'Renamed' },
      });
      expect(patch.status).toBe(403);
      const del = await call('DELETE', `${base()}/${view.id}`, { cookie: session.cookie });
      expect(del.status).toBe(403);
    }
    expect((await list(viewer)).views.some((v) => v.id === view.id)).toBe(true);
  });

  it('renames a view and changes its filters', async () => {
    const view = await saved(editor, { name: `Old ${hex32()}`, filters: { status: 'paused' } });
    const renamed = await call('PATCH', `${base()}/${view.id}`, {
      cookie: editor.cookie,
      body: { name: 'Paused for now' },
    });
    expect(renamed.status).toBe(200);
    const after = (await json<{ data: MemberView }>(renamed)).data;
    expect(after.name).toBe('Paused for now');
    expect(after.filters).toEqual({ status: 'paused' });

    const changed = await call('PATCH', `${base()}/${view.id}`, {
      cookie: owner.cookie,
      body: { filters: { status: 'active', tag: 'spring' } },
    });
    expect(changed.status).toBe(200);
    expect((await json<{ data: MemberView }>(changed)).data).toMatchObject({
      name: 'Paused for now',
      filters: { status: 'active', tag: 'spring' },
    });

    const clash = await call('PATCH', `${base()}/${view.id}`, {
      cookie: editor.cookie,
      body: { name: 'paid readers' },
    });
    expect(clash.status).toBe(409);
    const empty = await call('PATCH', `${base()}/${view.id}`, { cookie: editor.cookie, body: {} });
    expect(empty.status).toBe(400);
  });

  it('deletes a view for everyone', async () => {
    const view = await saved(editor, { name: `Gone ${hex32()}`, filters: {} });
    const res = await call('DELETE', `${base()}/${view.id}`, { cookie: editor.cookie });
    expect(res.status).toBe(204);
    expect((await list(viewer)).views.some((v) => v.id === view.id)).toBe(false);
    const again = await call('DELETE', `${base()}/${view.id}`, { cookie: editor.cookie });
    expect(again.status).toBe(404);
    const audit = await env.DB.prepare(
      "SELECT action FROM audit_events WHERE target_id = ?1 AND action LIKE 'member_view.%' ORDER BY rowid",
    )
      .bind(view.id)
      .all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toEqual([
      'member_view.saved',
      'member_view.deleted',
    ]);
  });

  it('keeps views to their Channel', async () => {
    const view = await saved(editor, { name: `Here ${hex32()}`, filters: {} });
    const other = (await createChannel(owner)).id;
    // Same workspace, other Channel: the view isn't listed there and can't be reached through it.
    expect((await list(owner, other)).views).toEqual([]);
    const patch = await call('PATCH', `${base(other)}/${view.id}`, {
      cookie: owner.cookie,
      body: { name: 'Moved' },
    });
    expect(patch.status).toBe(404);
    const del = await call('DELETE', `${base(other)}/${view.id}`, { cookie: owner.cookie });
    expect(del.status).toBe(404);
    expect((await list(owner)).views.find((v) => v.id === view.id)?.name).toBe(view.name);
  });

  it("answers 404 to another workspace's operator, for every route", async () => {
    const view = await saved(editor, { name: `Private ${hex32()}`, filters: {} });
    expect((await list(outsider)).status).toBe(404);
    expect((await save(outsider, { name: 'Theirs', filters: {} })).status).toBe(404);
    const patch = await call('PATCH', `${base()}/${view.id}`, {
      cookie: outsider.cookie,
      body: { name: 'Theirs' },
    });
    expect(patch.status).toBe(404);
    const del = await call('DELETE', `${base()}/${view.id}`, { cookie: outsider.cookie });
    expect(del.status).toBe(404);
    // Their own Channel can't reach it either.
    const theirs = (await createChannel(outsider)).id;
    const viaTheirs = await call('DELETE', `${base(theirs)}/${view.id}`, {
      cookie: outsider.cookie,
    });
    expect(viaTheirs.status).toBe(404);
    expect((await list(owner)).views.some((v) => v.id === view.id)).toBe(true);
  });

  it(`keeps up to ${MAX_MEMBER_VIEWS} views per Channel`, async () => {
    const full = (await createChannel(owner)).id;
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: MAX_MEMBER_VIEWS }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO member_views (id, channel_id, name, filters_json, created_at, updated_at)
           VALUES (?1, ?2, ?3, '{}', ?4, ?4)`,
        ).bind(`mv_${hex32()}`, full, `View ${i}`, now),
      ),
    );
    const res = await save(owner, { name: 'One more', filters: {} }, full);
    expect(res.status).toBe(409);
    expect((await list(owner, full)).views).toHaveLength(MAX_MEMBER_VIEWS);
  });
});

describe('the Member list Circle filter', () => {
  it('lists only Members of the Circle, and nothing for a Circle of another Channel', async () => {
    const add = async (email: string) => {
      const res = await call('POST', `/api/v1/channels/${channelId}/members`, {
        cookie: owner.cookie,
        body: { email, consent: true },
      });
      expect(res.status).toBe(201);
      return (await json<{ data: { id: string } }>(res)).data.id;
    };
    const inside = await add(uniqueEmail('inside'));
    await add(uniqueEmail('outside'));
    const circle = await insertCircle(channelId, [inside]);
    const page = async (circleId: string, id = channelId) => {
      const res = await call('GET', `/api/v1/channels/${id}/members?circle=${circleId}`, {
        cookie: owner.cookie,
      });
      expect(res.status).toBe(200);
      return (await json<{ data: { items: MemberListItem[] } }>(res)).data.items;
    };
    expect((await page(circle)).map((m) => m.id)).toEqual([inside]);

    const other = (await createChannel(owner)).id;
    expect(await page(circle, other)).toEqual([]);

    const bad = await call('GET', `/api/v1/channels/${channelId}/members?circle=nope`, {
      cookie: owner.cookie,
    });
    expect(bad.status).toBe(400);
  });
});

/** A Circle row with the given members, as the jobs worker leaves it after a refresh. */
async function insertCircle(channel: string, memberIds: string[] = []): Promise<string> {
  const id = `cl_${hex32()}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Readers', '{}', 'ready', ?4, ?4)`,
  )
    .bind(id, owner.workspaceId, channel, now)
    .run();
  for (const member of memberIds) {
    await env.DB.prepare(
      'INSERT INTO circle_members (circle_id, member_id, generation) VALUES (?1, ?2, 0)',
    )
      .bind(id, member)
      .run();
  }
  return id;
}
