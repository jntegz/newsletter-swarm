import { env } from 'cloudflare:test';
import type { ArchiveResult, Dispatch, DispatchSummary } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, json, signIn, uniqueEmail, type Session } from './helpers';
import { data, enableFlag, errorCode } from './money-helpers';

const doc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello there' }] }],
};

let owner: Session;

async function newPost(channelId: string, subject = 'A post'): Promise<string> {
  const post = await data<Dispatch>(
    await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
      cookie: owner.cookie,
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

const list = async (channelId: string, query = '') =>
  (
    await data<DispatchSummary[]>(
      await call('GET', `/api/v1/channels/${channelId}/dispatches${query}`, {
        cookie: owner.cookie,
      }),
    )
  ).map((post) => post.id);

const fileAway = (channelId: string, action: 'archive' | 'restore', ids: string[]) =>
  call('POST', `/api/v1/channels/${channelId}/dispatches/${action}`, {
    cookie: owner.cookie,
    body: { dispatchIds: ids },
  });

beforeAll(async () => {
  owner = await signIn(uniqueEmail());
});

describe('the post archive', () => {
  it('is refused with its flag off, and archived posts then show again', async () => {
    const { id } = await createChannel(owner);
    const post = await newPost(id);
    await setRow(post, `status = 'sent', sent_at = ?2`, Date.now());
    expect(await errorCode(await fileAway(id, 'archive', [post]))).toBe('feature_disabled');
    expect(await errorCode(await fileAway(id, 'restore', [post]))).toBe('feature_disabled');
    const only = await call('GET', `/api/v1/channels/${id}/dispatches?archived=only`, {
      cookie: owner.cookie,
    });
    expect(await errorCode(only)).toBe('feature_disabled');
    await setRow(post, 'archived_at = ?2', Date.now());
    expect(await list(id, '?archived=exclude')).toEqual([post]);
  });

  it('hides an archived post from the default list and restores it, changing nothing else', async () => {
    const { id } = await createChannel(owner);
    await enableFlag('post_archive', owner.workspaceId, id);
    const sent = await newPost(id, 'Sent one');
    const other = await newPost(id, 'Canceled one');
    await setRow(
      sent,
      `status = 'sent', sent_at = 1000, web_published_at = 1000, updated_at = 2000`,
    );
    await setRow(other, `status = 'canceled'`);
    const before = await env.DB.prepare('SELECT * FROM dispatches WHERE id = ?1')
      .bind(sent)
      .first();

    const result = await data<ArchiveResult>(await fileAway(id, 'archive', [sent, other]));
    expect(result.changed.sort()).toEqual([sent, other].sort());
    expect(result.refused).toEqual([]);
    expect(await list(id, '?archived=exclude')).toEqual([]);
    expect((await list(id, '?archived=only')).sort()).toEqual([sent, other].sort());
    // Everything else that reads the list still finds it.
    expect((await list(id)).sort()).toEqual([sent, other].sort());

    const after = await env.DB.prepare('SELECT * FROM dispatches WHERE id = ?1')
      .bind(sent)
      .first<{ archived_at: number | null }>();
    expect(after?.archived_at).toBeGreaterThan(0);
    expect({ ...after, archived_at: null }).toEqual(before);

    // Repeating is harmless.
    const again = await data<ArchiveResult>(await fileAway(id, 'archive', [sent]));
    expect(again).toEqual({ changed: [], refused: [] });

    const restored = await data<ArchiveResult>(await fileAway(id, 'restore', [sent]));
    expect(restored.changed).toEqual([sent]);
    expect(
      await env.DB.prepare('SELECT * FROM dispatches WHERE id = ?1').bind(sent).first(),
    ).toEqual(before);
    expect(await list(id, '?archived=exclude')).toEqual([sent]);
  });

  it('refuses a post that is scheduled, being sent, still a draft, or has a live send', async () => {
    const { id } = await createChannel(owner);
    await enableFlag('post_archive', owner.workspaceId, id);
    const scheduled = await newPost(id);
    const sending = await newPost(id);
    const draft = await newPost(id);
    const live = await newPost(id);
    await setRow(scheduled, `status = 'scheduled', publish_at = ?2`, Date.now() + 3_600_000);
    await setRow(sending, `status = 'sending'`);
    await setRow(live, `status = 'sent'`);
    await env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
         from_name, from_address, track_opens, created_at, last_progress_at)
       VALUES ('brd_live', ?1, ?2, ?3, 'sending', 'A post', '', '', '', 'A', 'a@example.com', 0, ?4, ?4)`,
    )
      .bind(live, id, owner.workspaceId, Date.now())
      .run();

    const result = await data<ArchiveResult>(
      await fileAway(id, 'archive', [scheduled, sending, draft, live]),
    );
    expect(result.changed).toEqual([]);
    expect(result.refused.map((r) => r.id).sort()).toEqual(
      [scheduled, sending, draft, live].sort(),
    );
    expect(result.refused.find((r) => r.id === scheduled)?.message).toMatch(/scheduled/);
  });

  it('leaves another publication’s posts alone', async () => {
    const { id } = await createChannel(owner);
    const { id: elsewhere } = await createChannel(owner);
    await enableFlag('post_archive', owner.workspaceId, id);
    await enableFlag('post_archive', owner.workspaceId, elsewhere);
    const post = await newPost(elsewhere);
    await setRow(post, `status = 'sent'`);
    const result = await data<ArchiveResult>(await fileAway(id, 'archive', [post]));
    expect(result).toEqual({ changed: [], refused: [{ id: post, message: 'Post not found.' }] });
  });
});

describe('planned dates and the calendar', () => {
  const plan = (post: string, plannedDate: string | null) =>
    call('PUT', `/api/v1/dispatches/${post}/planned-date`, {
      cookie: owner.cookie,
      body: { plannedDate },
    });
  const calendar = (id: string, from: string, to: string) =>
    call('GET', `/api/v1/channels/${id}/dispatches/calendar?from=${from}&to=${to}`, {
      cookie: owner.cookie,
    });

  it('is refused with its flag off', async () => {
    const { id } = await createChannel(owner);
    const post = await newPost(id);
    expect(await errorCode(await plan(post, '2026-12-01'))).toBe('feature_disabled');
    expect(await errorCode(await calendar(id, '2026-12-01', '2026-12-31'))).toBe(
      'feature_disabled',
    );
  });

  it('saves a planned date on a draft only, with no effect on sending', async () => {
    const { id } = await createChannel(owner);
    await enableFlag('content_calendar', owner.workspaceId, id);
    const post = await newPost(id);
    const saved = await data<DispatchSummary>(await plan(post, '2026-12-01'));
    expect(saved).toMatchObject({ plannedDate: '2026-12-01', status: 'draft', publishAt: null });
    expect((await plan(post, '2026-02-30')).status).toBe(400);
    const cleared = await data<DispatchSummary>(await plan(post, null));
    expect(cleared.plannedDate).toBeNull();

    await setRow(post, `status = 'sent'`);
    expect((await plan(post, '2026-12-01')).status).toBe(409);
  });

  it('shows scheduled, sent, planned and past posts on their days, and nothing else', async () => {
    const { id } = await createChannel(owner);
    await enableFlag('content_calendar', owner.workspaceId, id);
    await enableFlag('post_archive', owner.workspaceId, id);
    const at = (iso: string) => Date.parse(iso);
    const planned = await newPost(id, 'Planned');
    const scheduled = await newPost(id, 'Scheduled');
    const sent = await newPost(id, 'Sent');
    const past = await newPost(id, 'Past');
    const unplanned = await newPost(id, 'Unplanned');
    const outside = await newPost(id, 'Outside');
    const archived = await newPost(id, 'Archived');
    const canceled = await newPost(id, 'Canceled');
    await plan(planned, '2026-12-10');
    await plan(outside, '2027-01-20');
    await setRow(scheduled, `status = 'scheduled', publish_at = ?2`, at('2026-12-11T06:00:00Z'));
    await setRow(sent, `status = 'sent', sent_at = ?2`, at('2026-12-12T06:00:00Z'));
    await setRow(
      past,
      `imported_at = ?2, web_published_at = ?3`,
      Date.now(),
      at('2026-12-13T06:00:00Z'),
    );
    await setRow(
      archived,
      `status = 'sent', sent_at = ?2, archived_at = ?2`,
      at('2026-12-14T06:00:00Z'),
    );
    await setRow(canceled, `status = 'canceled', sent_at = ?2`, at('2026-12-15T06:00:00Z'));

    const posts = await data<DispatchSummary[]>(await calendar(id, '2026-12-01', '2026-12-31'));
    expect(posts.map((p) => p.id).sort()).toEqual([planned, scheduled, sent, past].sort());
    expect(posts.map((p) => p.id)).not.toContain(unplanned);

    expect((await calendar(id, '2026-01-01', '2026-12-31')).status).toBe(400);
    expect((await calendar(id, '2026-12-31', '2026-12-01')).status).toBe(400);
  });
});

describe('past issues', () => {
  const issue = (slug: string) => ({
    subject: `Issue ${slug}`,
    preheader: '',
    slug,
    publishedAt: '2021-03-04T10:00:00.000Z',
    visibility: 'public',
    content: doc,
  });

  it('are marked when imported, and can never be sent or scheduled', async () => {
    const { id } = await createChannel(owner);
    await enableFlag('archive_import', owner.workspaceId, id);
    await enableFlag('post_archive', owner.workspaceId, id);
    await enableFlag('content_calendar', owner.workspaceId, id);
    await call('POST', `/api/v1/channels/${id}/archive-import`, {
      cookie: owner.cookie,
      body: { dryRun: false, items: [issue('old-one')] },
    });
    const [summary] = await data<DispatchSummary[]>(
      await call('GET', `/api/v1/channels/${id}/dispatches`, { cookie: owner.cookie }),
    );
    expect(summary).toMatchObject({ status: 'draft' });
    expect(summary?.importedAt).not.toBeNull();
    expect(summary?.webPublishedAt).toBe('2021-03-04T10:00:00.000Z');

    const send = await call('POST', `/api/v1/dispatches/${summary!.id}/send`, {
      cookie: owner.cookie,
    });
    expect(send.status).toBe(409);
    expect((await json<{ error: { message: string } }>(send)).error.message).toMatch(/past issue/);
    const schedule = await call('POST', `/api/v1/dispatches/${summary!.id}/schedule`, {
      cookie: owner.cookie,
      body: { publishAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(schedule.status).toBe(409);
    expect(
      (
        await env.DB.prepare('SELECT count(*) AS n FROM broadcasts WHERE dispatch_id = ?1')
          .bind(summary!.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);

    const planned = await call('PUT', `/api/v1/dispatches/${summary!.id}/planned-date`, {
      cookie: owner.cookie,
      body: { plannedDate: '2026-12-01' },
    });
    expect(planned.status).toBe(409);

    // It can be archived, and stays on the website when it is.
    const archived = await data<ArchiveResult>(await fileAway(id, 'archive', [summary!.id]));
    expect(archived.changed).toEqual([summary!.id]);
    const row = await env.DB.prepare('SELECT web_published_at FROM dispatches WHERE id = ?1')
      .bind(summary!.id)
      .first<{ web_published_at: number }>();
    expect(row?.web_published_at).toBe(Date.parse('2021-03-04T10:00:00.000Z'));
  });
});
