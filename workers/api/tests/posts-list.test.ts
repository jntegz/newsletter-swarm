// The dashboard's posts list: search by subject, the status chips and their counts, Started by, the
// author, and the latest send's human open and click rates, read in one query.
import { env } from 'cloudflare:test';
import {
  newId,
  type Dispatch,
  type DispatchCounts,
  type DispatchListItem,
  type SeatRole,
} from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, seatAs, signIn, uniqueEmail, type Session } from './helpers';
import { data, enableFlag, errorCode } from './money-helpers';

let owner: Session;

const doc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello there' }] }],
};

async function newPost(s: Session, channelId: string, subject: string): Promise<string> {
  const post = await data<Dispatch>(
    await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
      cookie: s.cookie,
      body: { subject, content: doc },
    }),
    201,
  );
  return post.id;
}

const setRow = (id: string, sets: string, ...values: unknown[]) =>
  env.DB.prepare(`UPDATE dispatches SET ${sets} WHERE id = ?1`)
    .bind(id, ...values)
    .run();

async function listOf(channelId: string, query = '', s = owner): Promise<DispatchListItem[]> {
  return data<DispatchListItem[]>(
    await call('GET', `/api/v1/channels/${channelId}/dispatches${query}`, { cookie: s.cookie }),
  );
}

const subjects = async (channelId: string, query = '') =>
  (await listOf(channelId, query)).map((post) => post.subject).sort();

async function counts(channelId: string, query = '', s = owner): Promise<DispatchCounts> {
  return data<DispatchCounts>(
    await call('GET', `/api/v1/channels/${channelId}/dispatches/counts${query}`, {
      cookie: s.cookie,
    }),
  );
}

/**
 * A finished send of `dispatchId` with four deliveries: one person opened and clicked, one open came
 * from a privacy proxy only, one bounced, one was delivered and left unread.
 */
async function seedSend(s: Session, channelId: string, dispatchId: string, at: number) {
  const broadcastId = newId('broadcast');
  const row = (
    status: string,
    opened: number | null,
    human: number | null,
    clicked: number | null,
  ) =>
    env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at,
         opened_at, human_opened_at, clicked_at, human_clicked_at)
       VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
    ).bind(
      newId('delivery'),
      broadcastId,
      channelId,
      uniqueEmail('reader'),
      status,
      at,
      opened,
      human,
      clicked,
    );
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
         from_name, from_address, track_opens, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'Sent', '', '', '', 'Field Notes', 'notes@example.com', 1, ?5, ?5)`,
    ).bind(broadcastId, dispatchId, channelId, s.workspaceId, at),
    row('delivered', at + 1, at + 1, at + 2),
    row('delivered', at + 1, null, null),
    row('bounced', null, null, null),
    row('delivered', null, null, null),
  ]);
  await setRow(dispatchId, `status = 'sent', sent_at = ?2`, at);
  return broadcastId;
}

beforeAll(async () => {
  owner = await signIn();
});

describe('the posts list', () => {
  it('searches subjects, ignoring case and treating wildcards as text', async () => {
    const { id } = await createChannel(owner);
    await newPost(owner, id, 'The slow web, revisited');
    await newPost(owner, id, 'Reading on the train');
    await newPost(owner, id, '100% of readers');
    expect(await subjects(id, '?q=SLOW')).toEqual(['The slow web, revisited']);
    expect(await subjects(id, `?q=${encodeURIComponent('%')}`)).toEqual(['100% of readers']);
    expect(await subjects(id, `?q=${encodeURIComponent('_')}`)).toEqual([]);
    expect(await subjects(id, '?q=nothing+like+it')).toEqual([]);
    expect((await counts(id, '?q=on')).all).toBe(1);
    const tooLong = await call('GET', `/api/v1/channels/${id}/dispatches?q=${'a'.repeat(101)}`, {
      cookie: owner.cookie,
    });
    expect(await errorCode(tooLong)).toBe('invalid_input');
  });

  it('filters by status, counts a past issue as sent, and counts each chip', async () => {
    const { id } = await createChannel(owner);
    await newPost(owner, id, 'Draft');
    const scheduled = await newPost(owner, id, 'Scheduled');
    const sent = await newPost(owner, id, 'Sent');
    const stopped = await newPost(owner, id, 'Stopped');
    const past = await newPost(owner, id, 'Past issue');
    const archived = await newPost(owner, id, 'Archived');
    await setRow(scheduled, `status = 'scheduled', publish_at = ?2`, Date.now() + 86_400_000);
    await setRow(sent, `status = 'sent', sent_at = ?2`, Date.now());
    await setRow(stopped, `status = 'canceled'`);
    await setRow(past, 'imported_at = ?2, web_published_at = ?2', Date.now());
    await setRow(archived, `status = 'sent', archived_at = ?2`, Date.now());

    // With the archive off, an archived post is an ordinary sent one.
    expect(await subjects(id, '?status=draft')).toEqual(['Draft']);
    expect(await subjects(id, '?status=scheduled')).toEqual(['Scheduled']);
    expect(await subjects(id, '?status=sent')).toEqual([
      'Archived',
      'Past issue',
      'Sent',
      'Stopped',
    ]);
    expect(await counts(id)).toEqual({ all: 6, draft: 1, scheduled: 1, sent: 4, archived: null });

    await enableFlag('post_archive', owner.workspaceId, id);
    expect(await subjects(id, '?archived=exclude&status=sent')).toEqual([
      'Past issue',
      'Sent',
      'Stopped',
    ]);
    expect(await subjects(id, '?archived=only')).toEqual(['Archived']);
    expect(await counts(id)).toEqual({ all: 5, draft: 1, scheduled: 1, sent: 3, archived: 1 });
    const bad = await call('GET', `/api/v1/channels/${id}/dispatches?status=canceled`, {
      cookie: owner.cookie,
    });
    expect(await errorCode(bad)).toBe('invalid_input');
  });

  it('filters by who started a post, and names the teammate who did', async () => {
    const { id } = await createChannel(owner);
    const editor = await seatAs(owner.workspaceId, 'editor');
    await env.DB.prepare('UPDATE operators SET name = ?1 WHERE id = ?2')
      .bind('Mara Lind', editor.me.operator.id)
      .run();
    const mine = await newPost(owner, id, 'Mine');
    const theirs = await newPost(editor, id, 'Theirs');
    const agent = await newPost(owner, id, 'By an agent');
    const feed = await newPost(owner, id, 'From a feed');
    await setRow(agent, `created_via = 'agent'`);
    await setRow(feed, 'from_feed = 1');

    expect(await subjects(id, '?startedBy=people')).toEqual(['Mine', 'Theirs']);
    expect(await subjects(id, '?startedBy=agents')).toEqual(['By an agent']);
    expect(await counts(id, '?startedBy=people')).toMatchObject({ all: 2, draft: 2 });

    const rows = await listOf(id);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(theirs)?.author).toEqual({
      id: editor.me.operator.id,
      name: 'Mara Lind',
      email: editor.email,
    });
    expect(byId.get(mine)?.author).toMatchObject({ id: owner.me.operator.id, email: owner.email });
    // Without stats=latest the list stays as cheap as before.
    expect(rows.every((row) => !('latestSend' in row))).toBe(true);

    await env.DB.prepare('UPDATE dispatches SET created_by = NULL WHERE id = ?1').bind(mine).run();
    expect((await listOf(id)).find((row) => row.id === mine)?.author).toBeNull();
  });

  it('gives each post its latest send’s rates, counting people and not privacy proxies', async () => {
    const { id } = await createChannel(owner);
    const draft = await newPost(owner, id, 'Draft');
    const post = await newPost(owner, id, 'Sent twice');
    const now = Date.now();
    const older = await seedSend(owner, id, post, now - 86_400_000);
    const latest = await seedSend(owner, id, post, now);
    // On the older send a second person opened it for real: that send is not the one shown.
    await env.DB.prepare(
      `UPDATE deliveries SET human_opened_at = opened_at
        WHERE broadcast_id = ?1 AND opened_at IS NOT NULL AND human_opened_at IS NULL`,
    )
      .bind(older)
      .run();

    const rows = await listOf(id, '?stats=latest');
    expect(rows.find((row) => row.id === draft)?.latestSend).toBeNull();
    // Two opens on the latest send, one of them a privacy proxy's: one person opened it.
    expect(rows.find((row) => row.id === post)?.latestSend).toEqual({
      broadcastId: latest,
      delivered: 3,
      humanOpens: 1,
      humanClicks: 1,
      openRate: 0.3333,
      clickRate: 0.3333,
    });

    // The send report reads the same human opens.
    const report = await data<{ uniqueOpens: number; humanOpens: number; openRate: number }>(
      await call('GET', `/api/v1/broadcasts/${latest}/stats`, { cookie: owner.cookie }),
    );
    expect(report).toMatchObject({ uniqueOpens: 2, humanOpens: 1, openRate: 0.3333 });
  });

  it('is readable by every role and hidden from other workspaces', async () => {
    const { id } = await createChannel(owner);
    await newPost(owner, id, 'Hello');
    for (const role of ['viewer', 'author', 'editor', 'admin'] as SeatRole[]) {
      const seat = await seatAs(owner.workspaceId, role);
      expect((await listOf(id, '?q=hel&stats=latest', seat)).length).toBe(1);
      expect((await counts(id, '', seat)).all).toBe(1);
    }
    const outsider = await signIn();
    for (const path of ['dispatches?q=hel', 'dispatches/counts']) {
      const res = await call('GET', `/api/v1/channels/${id}/${path}`, { cookie: outsider.cookie });
      expect(res.status).toBe(404);
    }
    expect((await call('GET', `/api/v1/channels/${id}/dispatches/counts`)).status).toBe(401);
  });
});
