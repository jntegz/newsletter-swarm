// Feed Sync (Phase 8) routes: the flag, the role matrix, tenancy, the URL guard and reference
// checks, "Check now" (baseline, new items, a Dispatch, errors), items, preview, pause and
// resume, delete, the audit trail, and the same operations on /v2.
import { SELF, env } from 'cloudflare:test';
import {
  FEED_SYNC_LIMITS,
  newId,
  type Dispatch,
  type FeedCheckResult,
  type FeedItem,
  type FeedPreview,
  type FeedSource,
  type SeatRole,
} from '@swarm/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useFeedFetchForTests } from '../src/lib/feeds';
import { call, createChannel, seatAs, signIn, type Session } from './helpers';
import { data, enableFlag, errorCode } from './money-helpers';
import { createKey, v2, v2Data } from './v2-helpers';

const FEED_URL = 'https://blog.example.com/feed.xml';

/** The feed the worker fetches: its items are set by the test. */
const feed = { items: [1, 2], status: 200, fetched: [] as string[] };

const rss = (numbers: number[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Fox Blog</title>${[...numbers]
    .reverse()
    .map(
      (n) =>
        `<item><title>Post ${n}</title><link>https://blog.example.com/${n}</link><guid>p${n}</guid><description>&lt;p&gt;Body ${n}&lt;/p&gt;</description></item>`,
    )
    .join('')}</channel></rss>`;

let owner: Session;
let editor: Session;
let viewer: Session;
let author: Session;
let outsider: Session;
let channelId: string;
let otherChannelId: string;

const base = (channel = channelId) => `/api/v1/channels/${channel}/feed-sources`;

beforeAll(async () => {
  useFeedFetchForTests((async (input: RequestInfo | URL) => {
    feed.fetched.push(String(input));
    if (feed.status !== 200) return new Response('no', { status: feed.status });
    return new Response(rss(feed.items), { headers: { 'content-type': 'application/rss+xml' } });
  }) as typeof fetch);
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  editor = await seatAs(owner.workspaceId, 'editor');
  viewer = await seatAs(owner.workspaceId, 'viewer');
  author = await seatAs(owner.workspaceId, 'author');
  outsider = await signIn();
  otherChannelId = (await createChannel(outsider)).id;
});

afterAll(() => useFeedFetchForTests(undefined));

async function addCircle(workspaceId: string, channel: string): Promise<string> {
  const id = newId('circle');
  await env.DB.prepare(
    `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Readers', '{"all":[]}', 0, 0)`,
  )
    .bind(id, workspaceId, channel)
    .run();
  return id;
}

describe('Feed Sync routes', () => {
  it('is behind the feed_sync flag', async () => {
    const res = await call('GET', base(), { cookie: owner.cookie });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('feature_disabled');
    await enableFlag('feed_sync', owner.workspaceId, channelId);
    expect((await call('GET', base(), { cookie: owner.cookie })).status).toBe(200);
  });

  it('checks the URL, the Template, the sender and the Circles', async () => {
    for (const url of [
      'http://blog.example.com/feed',
      'https://127.0.0.1/feed',
      'https://localhost/feed',
      'https://intranet/feed',
      'https://user:pw@blog.example.com/feed',
      'not a url',
    ]) {
      const res = await call('POST', base(), { cookie: editor.cookie, body: { url } });
      expect(res.status, url).toBe(400);
    }
    const foreignTemplate = newId('template');
    await env.DB.prepare(
      `INSERT INTO templates (id, workspace_id, name, content_json, created_at, updated_at)
       VALUES (?1, ?2, 'Theirs', '{"type":"doc","content":[]}', 0, 0)`,
    )
      .bind(foreignTemplate, outsider.workspaceId)
      .run();
    const template = await call('POST', base(), {
      cookie: editor.cookie,
      body: { url: FEED_URL, templateId: foreignTemplate },
    });
    expect(template.status).toBe(400);
    const sender = await call('POST', base(), {
      cookie: editor.cookie,
      body: { url: FEED_URL, senderIdentityId: newId('senderIdentity') },
    });
    expect(sender.status).toBe(400);
    const theirCircle = await addCircle(outsider.workspaceId, otherChannelId);
    const circles = await call('POST', base(), {
      cookie: editor.cookie,
      body: { url: FEED_URL, audience: { include: [theirCircle], exclude: [] } },
    });
    expect(circles.status).toBe(400);
    const quiet = await call('POST', base(), {
      cookie: editor.cookie,
      body: { url: FEED_URL, quietStart: '22:00' },
    });
    expect(quiet.status).toBe(400);
  });

  it('lets viewers read and editors change; checks, previews and audits', async () => {
    const circle = await addCircle(owner.workspaceId, channelId);
    for (const [session, status] of [
      [viewer, 403],
      [author, 403],
    ] as [Session, number][]) {
      expect(
        (await call('POST', base(), { cookie: session.cookie, body: { url: FEED_URL } })).status,
      ).toBe(status);
    }
    const created = await data<FeedSource>(
      await call('POST', base(), {
        cookie: editor.cookie,
        body: {
          url: FEED_URL,
          name: 'Fox Blog',
          audience: { include: [circle], exclude: [] },
          quietStart: '22:00',
          quietEnd: '07:00',
          timezone: 'Europe/Prague',
        },
      }),
      201,
    );
    expect(created).toMatchObject({
      mode: 'draft',
      grouping: 'each',
      status: 'active',
      quietStart: '22:00',
      quietEnd: '07:00',
      pendingItems: 0,
      audience: { include: [circle], exclude: [] },
    });
    const dup = await call('POST', base(), { cookie: editor.cookie, body: { url: FEED_URL } });
    expect(dup.status).toBe(409);

    const list = await data<FeedSource[]>(await call('GET', base(), { cookie: viewer.cookie }));
    expect(list.map((s) => s.id)).toContain(created.id);
    const one = `${base()}/${created.id}`;

    // Nothing fetched yet: no preview.
    expect((await call('GET', `${one}/preview`, { cookie: viewer.cookie })).status).toBe(409);
    expect((await call('POST', `${one}/check`, { cookie: viewer.cookie })).status).toBe(403);

    // The first check is the baseline: both items are skipped.
    feed.items = [1, 2];
    const first = await data<FeedCheckResult>(
      await call('POST', `${one}/check`, { cookie: editor.cookie }),
    );
    expect(first).toMatchObject({ error: null, newItems: 0, dispatchIds: [] });
    expect(first.source).toMatchObject({ title: 'Fox Blog', format: 'rss', failureCount: 0 });

    const sample = await data<FeedPreview>(
      await call('GET', `${one}/preview`, { cookie: viewer.cookie }),
    );
    expect(sample).toMatchObject({ sample: true, subject: 'Post 2' });
    expect(sample.html).toContain('Body 2');

    feed.items = [1, 2, 3];
    const second = await data<FeedCheckResult>(
      await call('POST', `${one}/check`, { cookie: editor.cookie }),
    );
    expect(second.newItems).toBe(1);
    expect(second.dispatchIds).toHaveLength(1);
    const dispatch = await data<Dispatch>(
      await call('GET', `/api/v1/dispatches/${second.dispatchIds[0]}`, { cookie: viewer.cookie }),
    );
    expect(dispatch).toMatchObject({
      subject: 'Post 3',
      status: 'draft',
      audience: { include: [circle], exclude: [] },
      createdVia: 'feed',
    });

    const items = await data<FeedItem[]>(
      await call('GET', `${one}/items`, { cookie: viewer.cookie }),
    );
    expect(items.map((i) => [i.title, i.status])).toEqual([
      ['Post 3', 'dispatched'],
      ['Post 2', 'skipped'],
      ['Post 1', 'skipped'],
    ]);
    const skipped = await data<FeedItem[]>(
      await call('GET', `${one}/items?status=skipped`, { cookie: viewer.cookie }),
    );
    expect(skipped).toHaveLength(2);

    // A failing fetch answers 200 with the error, kept on the source.
    feed.status = 503;
    const failed = await data<FeedCheckResult>(
      await call('POST', `${one}/check`, { cookie: editor.cookie }),
    );
    expect(failed.error).toBe('The feed answered 503.');
    expect(failed.source).toMatchObject({ failureCount: 1, lastError: 'The feed answered 503.' });
    feed.status = 200;

    // Pause, resume (clears failures), and a new URL starts a new baseline.
    const paused = await data<FeedSource>(
      await call('PATCH', one, { cookie: editor.cookie, body: { status: 'paused' } }),
    );
    expect(paused).toMatchObject({ status: 'paused', nextCheckAt: null });
    const resumed = await data<FeedSource>(
      await call('PATCH', one, { cookie: editor.cookie, body: { status: 'active', mode: 'send' } }),
    );
    expect(resumed).toMatchObject({
      status: 'active',
      mode: 'send',
      failureCount: 0,
      lastError: null,
    });
    const moved = await data<FeedSource>(
      await call('PATCH', one, {
        cookie: editor.cookie,
        body: { url: 'https://blog.example.com/atom.xml', quietStart: null, quietEnd: null },
      }),
    );
    expect(moved).toMatchObject({ title: null, lastSuccessAt: null, quietStart: null });
    expect((await call('PATCH', one, { cookie: viewer.cookie, body: { name: 'x' } })).status).toBe(
      403,
    );

    const actions = await env.DB.prepare(
      'SELECT action FROM audit_events WHERE workspace_id = ?1 AND target_id = ?2 ORDER BY seq',
    )
      .bind(owner.workspaceId, created.id)
      .all<{ action: string }>();
    expect(actions.results.map((a) => a.action)).toEqual([
      'feed_source.created',
      'feed_source.paused',
      'feed_source.resumed',
      'feed_source.changed',
    ]);

    expect((await call('DELETE', one, { cookie: viewer.cookie })).status).toBe(403);
    expect((await call('DELETE', one, { cookie: editor.cookie })).status).toBe(204);
    expect((await call('GET', one, { cookie: viewer.cookie })).status).toBe(404);
    // The Dispatch it made stays.
    expect(
      (await call('GET', `/api/v1/dispatches/${dispatch.id}`, { cookie: viewer.cookie })).status,
    ).toBe(200);
  });

  it('caps the feeds a workspace follows across its publications', async () => {
    const team = await signIn();
    const channels: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = (await createChannel(team)).id;
      await enableFlag('feed_sync', team.workspaceId, id);
      channels.push(id);
    }
    const rows = Array.from({ length: FEED_SYNC_LIMITS.sourcesPerWorkspace }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO feed_sources (id, channel_id, url, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0)`,
      ).bind(newId('feedSource'), channels[i % 5], `https://cap-${i}.example.com/feed.xml`),
    );
    for (let i = 0; i < rows.length; i += 50) await env.DB.batch(rows.slice(i, i + 50));
    // The sixth publication has none of its own, but the workspace is at its limit.
    const res = await call('POST', base(channels[5]), {
      cookie: team.cookie,
      body: { url: 'https://blog.example.com/feed.xml' },
    });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('conflict');
  });

  it('answers 404 across tenants', async () => {
    await enableFlag('feed_sync', outsider.workspaceId, otherChannelId);
    const mine = await data<FeedSource>(
      await call('POST', base(), {
        cookie: editor.cookie,
        body: { url: 'https://cross.example.com/feed' },
      }),
      201,
    );
    const theirs = await data<FeedSource>(
      await call('POST', base(otherChannelId), {
        cookie: outsider.cookie,
        body: { url: 'https://cross.example.com/feed' },
      }),
      201,
    );
    // The outsider can't reach this Channel at all, nor this source through their own Channel.
    expect((await call('GET', base(), { cookie: outsider.cookie })).status).toBe(404);
    for (const [method, suffix] of [
      ['GET', ''],
      ['PATCH', ''],
      ['DELETE', ''],
      ['POST', '/check'],
      ['GET', '/items'],
      ['GET', '/preview'],
    ] as const) {
      const path = `${base(otherChannelId)}/${mine.id}${suffix}`;
      const res = await call(method, path, {
        cookie: outsider.cookie,
        ...(method === 'PATCH' ? { body: { name: 'x' } } : {}),
      });
      expect(res.status, `${method} ${suffix}`).toBe(404);
      const direct = await call(method, `${base()}/${theirs.id}${suffix}`, {
        cookie: owner.cookie,
        ...(method === 'PATCH' ? { body: { name: 'x' } } : {}),
      });
      expect(direct.status, `${method} ${suffix} (theirs)`).toBe(404);
    }
  });

  it('targets Rosters only with the rosters flag, and carries them into its Dispatches', async () => {
    const ch = (await createChannel(owner)).id;
    await enableFlag('feed_sync', owner.workspaceId, ch);
    const rosterIn = async (channel: string, name: string) => {
      const id = newId('roster');
      await env.DB.prepare(
        'INSERT INTO rosters (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0)',
      )
        .bind(id, channel, name)
        .run();
      return id;
    };
    const deals = await rosterIn(ch, 'Deals');
    const quiet = await rosterIn(ch, 'Quiet');
    const theirs = await rosterIn(otherChannelId, 'Theirs');
    const rosters = { include: [deals], exclude: [quiet], conflict: 'include_wins' };
    const post = (audience: unknown) =>
      call('POST', base(ch), { cookie: editor.cookie, body: { url: FEED_URL, audience } });

    // The flag is off: a Roster part is refused like any Roster route.
    const off = await post({ include: [], exclude: [], rosters });
    expect(off.status).toBe(404);
    expect(await errorCode(off)).toBe('feature_disabled');

    await enableFlag('rosters', owner.workspaceId, ch);
    const foreign = await post({
      include: [],
      exclude: [],
      rosters: { include: [theirs], exclude: [], conflict: 'exclude_wins' },
    });
    expect(foreign.status).toBe(400);
    const created = await data<FeedSource>(await post({ include: [], exclude: [], rosters }), 201);
    expect(created.audience).toEqual({ include: [], exclude: [], rosters });

    // An empty Roster part is dropped, as for a Dispatch.
    const one = `${base(ch)}/${created.id}`;
    const cleared = await data<FeedSource>(
      await call('PATCH', one, {
        cookie: editor.cookie,
        body: {
          audience: {
            include: [],
            exclude: [],
            rosters: { include: [], exclude: [], conflict: 'exclude_wins' },
          },
        },
      }),
    );
    expect(cleared.audience).toEqual({ include: [], exclude: [] });
    // /v2 takes the same audience.
    const { key, secret } = await createKey(owner, { scopes: ['dispatches:write'] });
    const patched = await v2Data<FeedSource>(
      await v2('PATCH', `/v2/channels/${ch}/feed-sources/${created.id}`, secret, {
        body: { audience: { include: [], exclude: [], rosters } },
      }),
    );
    expect(patched.audience.rosters).toEqual(rosters);
    // The free plan's key limit: leave room for the /v2 test below.
    expect(
      (
        await call('DELETE', `/api/v1/workspaces/${owner.workspaceId}/api-keys/${key.id}`, {
          cookie: owner.cookie,
        })
      ).status,
    ).toBeLessThan(300);

    feed.items = [1, 2];
    await data<FeedCheckResult>(await call('POST', `${one}/check`, { cookie: editor.cookie }));
    feed.items = [1, 2, 3];
    const checked = await data<FeedCheckResult>(
      await call('POST', `${one}/check`, { cookie: editor.cookie }),
    );
    expect(checked.dispatchIds).toHaveLength(1);
    const dispatch = await data<Dispatch>(
      await call('GET', `/api/v1/dispatches/${checked.dispatchIds[0]}`, { cookie: viewer.cookie }),
    );
    expect(dispatch.audience).toEqual({ include: [], exclude: [], rosters });
  });

  it('works on /v2 with the Dispatch scopes', async () => {
    const reader = (await createKey(owner, { scopes: ['dispatches:read'] })).secret;
    const writer = (await createKey(owner, { scopes: ['dispatches:write'] })).secret;
    const path = `/v2/channels/${channelId}/feed-sources`;
    expect(
      (await v2('POST', path, reader, { body: { url: 'https://v2.example.com/feed' } })).status,
    ).toBe(403);
    const created = await v2Data<FeedSource>(
      await v2('POST', path, writer, {
        body: { url: 'https://v2.example.com/feed', grouping: 'digest' },
      }),
      201,
    );
    expect(created.grouping).toBe('digest');
    const listed = await v2Data<FeedSource[]>(await v2('GET', path, reader));
    expect(listed.map((s) => s.id)).toContain(created.id);
    const checked = await v2Data<FeedCheckResult>(
      await v2('POST', `${path}/${created.id}/check`, writer),
    );
    expect(checked.error).toBeNull();
    const items = await v2Data<FeedItem[]>(await v2('GET', `${path}/${created.id}/items`, reader));
    expect(items.length).toBeGreaterThan(0);
    const audit = await env.DB.prepare(
      "SELECT actor_operator_id, metadata_json FROM audit_events WHERE target_id = ?1 AND action = 'feed_source.created'",
    )
      .bind(created.id)
      .first<{ actor_operator_id: string | null; metadata_json: string }>();
    expect(audit?.actor_operator_id).toBeNull();
    expect(JSON.parse(audit!.metadata_json).via).toMatchObject({ kind: 'key' });
    expect((await v2('DELETE', `${path}/${created.id}`, writer)).status).toBe(204);
  });

  it('roles: every role may read, only editors and above may write', async () => {
    const roles: [SeatRole, boolean][] = [
      ['viewer', false],
      ['author', false],
      ['editor', true],
      ['admin', true],
    ];
    for (const [role, canWrite] of roles) {
      const session = await seatAs(owner.workspaceId, role);
      expect((await call('GET', base(), { cookie: session.cookie })).status).toBe(200);
      const res = await call('POST', base(), {
        cookie: session.cookie,
        body: { url: `https://${role}.example.com/feed` },
      });
      expect(res.status, role).toBe(canWrite ? 201 : 403);
    }
  });
});

describe('a digest on set days', () => {
  it('makes nothing until its day, and then makes one', async () => {
    const channel = (await createChannel(owner)).id;
    await enableFlag('feed_sync', owner.workspaceId, channel);
    feed.items = [1, 2];
    feed.status = 200;
    const source = await data<FeedSource>(
      await call('POST', base(channel), {
        cookie: owner.cookie,
        body: {
          url: FEED_URL,
          grouping: 'digest',
          timezone: 'UTC',
          digestSchedule: { weekdays: [0, 1, 2, 3, 4, 5, 6], time: '00:00' },
        },
      }),
      201,
    );
    expect(source.digestSchedule).toEqual({ weekdays: [0, 1, 2, 3, 4, 5, 6], time: '00:00' });
    const check = () =>
      call('POST', `${base(channel)}/${source.id}/check`, { cookie: owner.cookie }).then((res) =>
        data<FeedCheckResult>(res),
      );
    await check();

    // Today's slot passed before the schedule was set, so a new post waits.
    feed.items = [1, 2, 3];
    expect((await check()).dispatchIds).toEqual([]);

    // The schedule was set earlier: today's slot counts. A second post in the same slot waits.
    await env.DB.prepare('UPDATE feed_sources SET digest_since = 0 WHERE id = ?1')
      .bind(source.id)
      .run();
    expect((await check()).dispatchIds).toHaveLength(1);
    feed.items = [1, 2, 3, 4];
    expect((await check()).dispatchIds).toEqual([]);
  });

  it('keeps the schedule when other settings change, and clears it on request', async () => {
    const channel = (await createChannel(owner)).id;
    await enableFlag('feed_sync', owner.workspaceId, channel);
    const schedule = { weekdays: [5], time: '09:00' };
    const source = await data<FeedSource>(
      await call('POST', base(channel), {
        cookie: owner.cookie,
        body: { url: FEED_URL, grouping: 'digest', digestSchedule: schedule },
      }),
      201,
    );
    const one = `${base(channel)}/${source.id}`;
    const patched = await data<FeedSource>(
      await call('PATCH', one, { cookie: owner.cookie, body: { name: 'Fox' } }),
    );
    expect(patched.digestSchedule).toEqual(schedule);
    const cleared = await data<FeedSource>(
      await call('PATCH', one, { cookie: owner.cookie, body: { digestSchedule: null } }),
    );
    expect(cleared.digestSchedule).toBeNull();
    const refused = await call('PATCH', one, {
      cookie: owner.cookie,
      body: { digestSchedule: { weekdays: [], time: '09:00' } },
    });
    expect(refused.status).toBe(400);
  });
});

describe('a turned-off send source', () => {
  let ws: Session;
  beforeAll(async () => {
    ws = await signIn();
  });

  /** A workspace-level flag, as the operator tests set it. */
  async function enableWorkspaceFlag(key: string, workspaceId: string) {
    await env.DB.prepare(
      `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, ?2, 'workspace', ?3, 1, 0)`,
    )
      .bind(newId('featureFlag'), key, workspaceId)
      .run();
    await env.CACHE.delete(`flags:v1:${workspaceId}:-`);
  }

  /** A legacy (handshake-era) MCP tool call, which needs no per-request metadata. */
  async function mcpTool(token: string, name: string, args: Record<string, unknown>) {
    const res = await SELF.fetch('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    expect(res.status).toBe(200);
    return (
      (await res.json()) as {
        result: { isError: boolean; structuredContent: Record<string, unknown> };
      }
    ).result;
  }

  const scheduledFromFeed = async (channel: string) =>
    (
      await env.DB.prepare(
        "SELECT count(*) AS n FROM dispatches WHERE channel_id = ?1 AND from_feed = 1 AND status = 'scheduled'",
      )
        .bind(channel)
        .first<{ n: number }>()
    )?.n ?? 0;

  /** A source that fetched once (its baseline), then was turned off by real failed checks. */
  async function turnedOffSource(channel: string, mode: 'send' | 'draft'): Promise<string> {
    feed.status = 200;
    feed.items = [1, 2];
    const source = await data<FeedSource>(
      await call('POST', base(channel), { cookie: ws.cookie, body: { url: FEED_URL, mode } }),
      201,
    );
    const check = () =>
      call('POST', `${base(channel)}/${source.id}/check`, { cookie: ws.cookie }).then((res) =>
        data<FeedCheckResult>(res),
      );
    expect((await check()).error).toBeNull();
    feed.status = 503;
    let last: FeedCheckResult | undefined;
    for (let i = 0; i < FEED_SYNC_LIMITS.failuresBeforeOff; i++) last = await check();
    expect(last?.source.status).toBe('disabled');
    feed.status = 200;
    return source.id;
  }

  it('reports that the feed works again through the tool, but stays off and schedules nothing', async () => {
    const channel = (await createChannel(ws)).id;
    await enableFlag('feed_sync', ws.workspaceId, channel);
    await enableWorkspaceFlag('open_operator_mcp', ws.workspaceId);
    const sourceId = await turnedOffSource(channel, 'send');
    const writer = (await createKey(ws, { scopes: ['dispatches:write'] })).secret;

    // A new post appears and the feed answers again; the agent checks in the default mode.
    feed.items = [1, 2, 3];
    const result = await mcpTool(writer, 'check_feed_source', {
      channelId: channel,
      feedSourceId: sourceId,
    });
    expect(result.isError).toBe(false);
    const checked = (result.structuredContent as { data: FeedCheckResult }).data;
    expect(checked).toMatchObject({
      error: null,
      newItems: 1,
      dispatchIds: [],
      resumeRequired: true,
    });
    expect(checked.source).toMatchObject({ status: 'disabled', failureCount: 0, lastError: null });
    expect(await scheduledFromFeed(channel)).toBe(0);
    // Not reactivated, so nothing is audited as resumed and no scheduled check picks it up.
    const resumed = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_events WHERE target_id = ?1 AND action = 'feed_source.resumed'",
    )
      .bind(sourceId)
      .first<{ n: number }>();
    expect(resumed?.n).toBe(0);
    // A second check (the dashboard's) still sends nothing.
    const again = await data<FeedCheckResult>(
      await call('POST', `${base(channel)}/${sourceId}/check`, { cookie: ws.cookie }),
    );
    expect(again).toMatchObject({ dispatchIds: [], resumeRequired: true });
    expect(await scheduledFromFeed(channel)).toBe(0);

    // Resuming is the agent's held decision...
    const held = await mcpTool(writer, 'update_feed_source', {
      channelId: channel,
      feedSourceId: sourceId,
      body: { status: 'active' },
    });
    expect(held.structuredContent).toMatchObject({ status: 'pending_approval' });
    const row = await env.DB.prepare('SELECT status FROM feed_sources WHERE id = ?1')
      .bind(sourceId)
      .first<{ status: string }>();
    expect(row?.status).toBe('disabled');

    // ...or a person's: once resumed (audited with its actor), the waiting post is released.
    const back = await data<FeedSource>(
      await call('PATCH', `${base(channel)}/${sourceId}`, {
        cookie: ws.cookie,
        body: { status: 'active' },
      }),
    );
    expect(back.status).toBe('active');
    const audit = await env.DB.prepare(
      "SELECT actor_operator_id FROM audit_events WHERE target_id = ?1 AND action = 'feed_source.resumed'",
    )
      .bind(sourceId)
      .first<{ actor_operator_id: string | null }>();
    expect(audit?.actor_operator_id).toBe(ws.me.operator.id);
    const released = await data<FeedCheckResult>(
      await call('POST', `${base(channel)}/${sourceId}/check`, { cookie: ws.cookie }),
    );
    expect(released).toMatchObject({ resumeRequired: false });
    expect(released.dispatchIds).toHaveLength(1);
    expect(await scheduledFromFeed(channel)).toBe(1);
  });

  it('turns a draft source back on, and audits who did', async () => {
    const channel = (await createChannel(ws)).id;
    await enableFlag('feed_sync', ws.workspaceId, channel);
    const sourceId = await turnedOffSource(channel, 'draft');
    feed.items = [1, 2, 3];
    const writer = (await createKey(ws, { scopes: ['dispatches:write'] })).secret;
    const checked = await v2Data<FeedCheckResult>(
      await v2('POST', `/v2/channels/${channel}/feed-sources/${sourceId}/check`, writer),
    );
    expect(checked).toMatchObject({ error: null, resumeRequired: false });
    expect(checked.source.status).toBe('active');
    expect(checked.dispatchIds).toHaveLength(1);
    expect(await scheduledFromFeed(channel)).toBe(0);
    const audit = await env.DB.prepare(
      "SELECT actor_operator_id, metadata_json FROM audit_events WHERE target_id = ?1 AND action = 'feed_source.resumed'",
    )
      .bind(sourceId)
      .first<{ actor_operator_id: string | null; metadata_json: string }>();
    expect(audit?.actor_operator_id).toBeNull();
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({ by: 'check', via: { kind: 'key' } });
  });
});
