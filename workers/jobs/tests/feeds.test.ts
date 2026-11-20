// Feed Sync (Phase 8) against real D1: the minute cron's checks with conditional GET, the
// first-fetch baseline, dedupe by GUID, drafts and scheduled sends, digests with a Template,
// frequency caps, quiet windows, backoff and turning off after failures, the flag, and pruning.
import { env } from 'cloudflare:test';
import { FEED_SYNC_LIMITS, newId } from '@swarm/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJobsEnv } from '../src/env';
import { pruneFeeds, useFeedFetchForTests } from '../src/handlers/feeds';
import { DAILY_CRON, MINUTE_CRON } from '../src/crons';
import { runScheduled } from '../src/index';
import { count, one, seedChannel } from './helpers';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const FEED_URL = 'https://blog.example.com/feed.xml';

afterEach(async () => {
  useFeedFetchForTests(undefined);
  // The cron is global: sources of earlier tests must not take this test's check slots.
  await env.DB.prepare("UPDATE feed_sources SET status = 'paused'").run();
});

async function enableFeedSync(workspaceId: string, channelId: string) {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, 'feed_sync', 'channel', ?2, 1, 0)`,
  )
    .bind(newId('featureFlag'), channelId)
    .run();
  await env.CACHE.delete(`flags:v1:${workspaceId}:${channelId}`);
}

interface SourceOptions {
  mode?: 'draft' | 'send';
  grouping?: 'each' | 'digest';
  minGap?: number;
  maxPerDay?: number;
  quiet?: [number, number];
  templateId?: string;
  subject?: string;
  audience?: { include: string[]; exclude: string[] };
}

async function seedSource(options: SourceOptions = {}, flag = true) {
  const seed = await seedChannel();
  if (flag) await enableFeedSync(seed.workspaceId, seed.channelId);
  const id = newId('feedSource');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO feed_sources (id, channel_id, url, mode, grouping, min_gap_minutes, max_per_day, quiet_start, quiet_end,
       template_id, subject_template, audience_json, next_check_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?13)`,
  )
    .bind(
      id,
      seed.channelId,
      FEED_URL,
      options.mode ?? 'draft',
      options.grouping ?? 'each',
      options.minGap ?? 0,
      options.maxPerDay ?? 10,
      options.quiet?.[0] ?? null,
      options.quiet?.[1] ?? null,
      options.templateId ?? null,
      options.subject ?? null,
      JSON.stringify(options.audience ?? { include: [], exclude: [] }),
      now - MINUTE,
    )
    .run();
  return { ...seed, sourceId: id };
}

const item = (n: number) =>
  `<item><title>Post ${n}</title><link>https://blog.example.com/${n}</link><guid>post-${n}</guid>
     <pubDate>${new Date(Date.UTC(2026, 9, n)).toUTCString()}</pubDate>
     <description><![CDATA[<p>Body of post ${n}</p>]]></description></item>`;

const rss = (numbers: number[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Fox Blog</title>${[...numbers]
    .reverse()
    .map(item)
    .join('')}</channel></rss>`;

/** A feed server: the test sets the items; ETags follow the body; records requests. */
function feedServer() {
  const state = { items: [1, 2], status: 200, requests: [] as Headers[] };
  useFeedFetchForTests((async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    state.requests.push(headers);
    if (state.status !== 200) return new Response('down', { status: state.status });
    const body = rss(state.items);
    const etag = `"${state.items.join('-')}"`;
    if (headers.get('if-none-match') === etag) return new Response(null, { status: 304 });
    return new Response(body, { headers: { etag, 'content-type': 'application/rss+xml' } });
  }) as typeof fetch);
  return state;
}

const jobs = () => parseJobsEnv(env);
const source = (id: string) =>
  one<{
    status: string;
    failure_count: number;
    last_error: string | null;
    next_check_at: number;
    etag: string | null;
    title: string | null;
    lock_until: number | null;
  }>('SELECT * FROM feed_sources WHERE id = ?1', id);
const dispatchesOf = (channelId: string) =>
  env.DB.prepare(
    'SELECT id, subject, status, publish_at, content_json, audience_json, html FROM dispatches WHERE channel_id = ?1 ORDER BY created_at, id',
  )
    .bind(channelId)
    .all<{
      id: string;
      subject: string;
      status: string;
      publish_at: number | null;
      content_json: string;
      audience_json: string;
      html: string;
    }>()
    .then((r) => r.results);
/** Makes the source due again. */
const due = (id: string) =>
  env.DB.prepare('UPDATE feed_sources SET next_check_at = 0 WHERE id = ?1').bind(id).run();
const minute = (now: number) => runScheduled(jobs(), MINUTE_CRON, now);

describe('Feed Sync polling', () => {
  it('skips the backlog, then drafts one Dispatch per new item, deduped by GUID', async () => {
    const server = feedServer();
    const { channelId, sourceId, workspaceId } = await seedSource();
    let now = Date.now();
    await minute(now);
    expect(
      await count(
        "SELECT count(*) AS n FROM feed_items WHERE feed_source_id = ?1 AND status = 'skipped'",
        sourceId,
      ),
    ).toBe(2);
    expect(await dispatchesOf(channelId)).toHaveLength(0);
    expect(await source(sourceId)).toMatchObject({
      title: 'Fox Blog',
      etag: '"1-2"',
      failure_count: 0,
      lock_until: null,
    });

    // Not due yet: nothing is fetched.
    await minute(now + MINUTE);
    expect(server.requests).toHaveLength(1);

    // Unchanged: a conditional GET answered 304.
    await due(sourceId);
    await minute((now += MINUTE));
    expect(server.requests[1]?.get('if-none-match')).toBe('"1-2"');

    server.items = [1, 2, 3, 4];
    await due(sourceId);
    await minute((now += 2 * MINUTE));
    const drafts = await dispatchesOf(channelId);
    // One per release; the oldest new item first.
    expect(drafts.map((d) => [d.subject, d.status])).toEqual([['Post 3', 'draft']]);
    expect(JSON.parse(drafts[0]!.content_json).content.at(-1)).toMatchObject({
      type: 'button',
      attrs: { href: 'https://blog.example.com/3', label: 'Read the original' },
    });
    expect(drafts[0]!.html).toContain('Body of post 3');
    expect(
      await count(
        'SELECT count(*) AS n FROM dispatch_revisions WHERE dispatch_id = ?1',
        drafts[0]!.id,
      ),
    ).toBe(1);
    const audit = await one<{ metadata_json: string; actor_operator_id: string | null }>(
      "SELECT metadata_json, actor_operator_id FROM audit_events WHERE workspace_id = ?1 AND action = 'dispatch.created'",
      workspaceId,
    );
    expect(audit?.actor_operator_id).toBeNull();
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({ feedSourceId: sourceId, items: 1 });

    // The next minute releases the next item without fetching; the same items again add nothing.
    await minute((now += MINUTE));
    await due(sourceId);
    await minute((now += MINUTE));
    expect((await dispatchesOf(channelId)).map((d) => d.subject)).toEqual(['Post 3', 'Post 4']);
    expect(
      await count('SELECT count(*) AS n FROM feed_items WHERE feed_source_id = ?1', sourceId),
    ).toBe(4);
  });

  it('schedules sends for now, with the audience, and emits dispatch.scheduled', async () => {
    const server = feedServer();
    const circle = newId('circle');
    const { channelId, sourceId, workspaceId } = await seedSource({
      mode: 'send',
      audience: { include: [circle], exclude: [] },
    });
    let now = Date.now();
    await minute(now);
    server.items = [1, 2, 3];
    await due(sourceId);
    await minute((now += MINUTE));
    const [sent] = await dispatchesOf(channelId);
    expect(sent).toMatchObject({ status: 'scheduled', publish_at: now, subject: 'Post 3' });
    expect(JSON.parse(sent!.audience_json)).toEqual({ include: [circle], exclude: [] });
    expect(
      await count(
        "SELECT count(*) AS n FROM platform_events WHERE workspace_id = ?1 AND type = 'dispatch.scheduled'",
        workspaceId,
      ),
    ).toBe(1);
  });

  it('honours the daily cap, the gap and the quiet window', async () => {
    const server = feedServer();
    const capped = await seedSource({ maxPerDay: 2 });
    let now = Date.now();
    await minute(now);
    server.items = [1, 2, 3, 4, 5, 6];
    await due(capped.sourceId);
    for (let i = 0; i < 5; i++) await minute((now += MINUTE));
    expect(await dispatchesOf(capped.channelId)).toHaveLength(2);
    // A day later the cap has room again.
    await minute(now + 24 * HOUR + MINUTE);
    expect(await dispatchesOf(capped.channelId)).toHaveLength(3);

    const gapped = await seedSource({ minGap: 60 });
    now = Date.now();
    server.items = [1, 2];
    await minute(now);
    server.items = [1, 2, 3, 4];
    await due(gapped.sourceId);
    await minute((now += MINUTE));
    await minute((now += 30 * MINUTE));
    expect(await dispatchesOf(gapped.channelId)).toHaveLength(1);
    await minute((now += 31 * MINUTE));
    expect(await dispatchesOf(gapped.channelId)).toHaveLength(2);

    // A window around the current UTC time: sends wait, the check still stores items.
    now = Date.now();
    const current = Math.floor((now % (24 * HOUR)) / MINUTE);
    const quiet = await seedSource({
      mode: 'send',
      quiet: [(current + 1440 - 60) % 1440, (current + 60) % 1440],
    });
    server.items = [1];
    await minute(now);
    server.items = [1, 2];
    await due(quiet.sourceId);
    await minute((now += MINUTE));
    expect(await dispatchesOf(quiet.channelId)).toHaveLength(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM feed_items WHERE feed_source_id = ?1 AND status = 'new'",
        quiet.sourceId,
      ),
    ).toBe(1);
  });

  it('makes a digest inside the Template at {{feed.items}}', async () => {
    const server = feedServer();
    const seed = await seedChannel();
    const templateId = newId('template');
    await env.DB.prepare(
      `INSERT INTO templates (id, workspace_id, channel_id, name, content_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Weekly', ?4, 0, 0)`,
    )
      .bind(
        templateId,
        seed.workspaceId,
        seed.channelId,
        JSON.stringify({
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'This week' }] },
            { type: 'paragraph', content: [{ type: 'text', text: '{{feed.items}}' }] },
          ],
        }),
      )
      .run();
    const { channelId, sourceId } = await seedSource({ grouping: 'digest', templateId });
    // The template belongs to another Channel of another workspace: it is not used.
    let now = Date.now();
    await minute(now);
    server.items = [1, 2, 3, 4];
    await due(sourceId);
    await minute((now += MINUTE));
    const [digest] = await dispatchesOf(channelId);
    expect(digest?.subject).toBe('Fox Blog: 2 new');
    const blocks = JSON.parse(digest!.content_json).content as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'horizontalRule',
      'heading',
      'paragraph',
    ]);

    const own = await seedSource({ grouping: 'digest' });
    await env.DB.prepare(
      'UPDATE templates SET channel_id = ?1, workspace_id = (SELECT workspace_id FROM channels WHERE id = ?1) WHERE id = ?2',
    )
      .bind(own.channelId, templateId)
      .run();
    await env.DB.prepare('UPDATE feed_sources SET template_id = ?1 WHERE id = ?2')
      .bind(templateId, own.sourceId)
      .run();
    server.items = [1];
    await minute((now += MINUTE));
    server.items = [1, 2, 3];
    await due(own.sourceId);
    await minute((now += MINUTE));
    const [framed] = await dispatchesOf(own.channelId);
    const texts = (
      JSON.parse(framed!.content_json).content as { content?: { text?: string }[] }[]
    ).map((b) => b.content?.[0]?.text);
    expect(texts[0]).toBe('This week');
    expect(texts).toContain('Post 2');
    expect(texts).not.toContain('{{feed.items}}');
  });

  it('backs off on errors and turns the source off after repeated failures', async () => {
    const server = feedServer();
    server.status = 500;
    const { sourceId, workspaceId } = await seedSource();
    let now = Date.now();
    await minute(now);
    let row = await source(sourceId);
    expect(row).toMatchObject({
      status: 'active',
      failure_count: 1,
      last_error: 'The feed answered 500.',
    });
    expect(row?.next_check_at).toBe(now + 60 * MINUTE);
    for (let i = 2; i <= FEED_SYNC_LIMITS.failuresBeforeOff; i++) {
      await due(sourceId);
      await minute((now += MINUTE));
    }
    row = await source(sourceId);
    expect(row).toMatchObject({
      status: 'disabled',
      failure_count: FEED_SYNC_LIMITS.failuresBeforeOff,
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_events WHERE workspace_id = ?1 AND action = 'feed_source.paused'",
        workspaceId,
      ),
    ).toBe(1);
    // Turned off: no more fetches.
    const before = server.requests.length;
    await due(sourceId);
    await minute((now += MINUTE));
    expect(server.requests).toHaveLength(before);
  });

  it('refuses private redirect targets and malformed feeds as failures', async () => {
    useFeedFetchForTests(
      (async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://169.254.169.254/latest' },
        })) as typeof fetch,
    );
    const { sourceId } = await seedSource();
    await minute(Date.now());
    expect((await source(sourceId))?.last_error).toMatch(
      /redirected to an address that is not allowed/,
    );

    useFeedFetchForTests(
      (async () => new Response('<!DOCTYPE x [<!ENTITY a "b">]><rss/>')) as typeof fetch,
    );
    await due(sourceId);
    await minute(Date.now() + MINUTE);
    expect((await source(sourceId))?.last_error).toMatch(/not valid XML/);
  });

  it('backs off feeds whose body breaks off, so they cannot hold every check slot', async () => {
    // One tenant's feeds answer 200 and then reset the stream mid-body.
    const broken = await seedChannel();
    await enableFeedSync(broken.workspaceId, broken.channelId);
    const brokenIds = Array.from({ length: FEED_SYNC_LIMITS.checksPerRun }, () =>
      newId('feedSource'),
    );
    await env.DB.batch(
      brokenIds.map((id, i) =>
        env.DB.prepare(
          `INSERT INTO feed_sources (id, channel_id, url, next_check_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, 0, 0, 0)`,
        ).bind(id, broken.channelId, `https://broken.example.com/${i}.xml`),
      ),
    );
    const healthy = await seedSource();
    const requests: string[] = [];
    useFeedFetchForTests((async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === FEED_URL) return new Response(rss([1, 2]));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('<?xml version="1.0"?><rss>'));
            controller.error(new TypeError('Network connection lost.'));
          },
        }),
      );
    }) as typeof fetch);

    // One workspace takes at most checksPerWorkspacePerRun of a minute's checks.
    const minutesForAll = Math.ceil(brokenIds.length / FEED_SYNC_LIMITS.checksPerWorkspacePerRun);
    let now = Date.now();
    await minute(now);
    // The other workspace's feed is checked in the first minute, alongside the broken ones.
    expect(requests).toContain(FEED_URL);
    for (let m = 1; m < minutesForAll; m++) await minute((now += MINUTE));
    expect(await source(healthy.sourceId)).toMatchObject({ title: 'Fox Blog', failure_count: 0 });
    for (const id of brokenIds) {
      const row = await source(id);
      expect(row).toMatchObject({ status: 'active', failure_count: 1, lock_until: null });
      expect(row?.last_error).toMatch(/stopped sending/);
      expect(row?.next_check_at).toBeGreaterThan(now);
    }

    // They count like any other failure and are turned off after enough of them.
    for (let i = 2; i <= FEED_SYNC_LIMITS.failuresBeforeOff; i++) {
      await env.DB.prepare('UPDATE feed_sources SET next_check_at = 0 WHERE channel_id = ?1')
        .bind(broken.channelId)
        .run();
      for (let m = 0; m < minutesForAll; m++) await minute((now += MINUTE));
    }
    for (const id of brokenIds) {
      expect(await source(id)).toMatchObject({
        status: 'disabled',
        failure_count: FEED_SYNC_LIMITS.failuresBeforeOff,
      });
    }
  });

  it("shares each minute's checks across workspaces, whatever one workspace has due", async () => {
    const busy = await seedChannel();
    await enableFeedSync(busy.workspaceId, busy.channelId);
    const channels = [busy.channelId];
    for (let i = 0; i < 7; i++) {
      const id = newId('channel');
      await env.DB.prepare(
        `INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, 'More', 0, 0)`,
      )
        .bind(id, busy.workspaceId, `more-${crypto.randomUUID().slice(0, 8)}`)
        .run();
      await enableFeedSync(busy.workspaceId, id);
      channels.push(id);
    }
    // 160 of the busy workspace's sources, all due long ago.
    const statements = Array.from({ length: 160 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO feed_sources (id, channel_id, url, next_check_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 0, 0)`,
      ).bind(
        newId('feedSource'),
        channels[i % channels.length],
        `https://busy.example.com/${i}.xml`,
        i,
      ),
    );
    for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
    // The other workspace's one source became due just now, after all of them.
    const quiet = await seedSource();
    const now = Date.now();
    await env.DB.prepare('UPDATE feed_sources SET next_check_at = ?2 WHERE id = ?1')
      .bind(quiet.sourceId, now - 1000)
      .run();
    const requests: string[] = [];
    useFeedFetchForTests((async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(rss([1, 2]));
    }) as typeof fetch);
    await minute(now);
    expect(requests).toContain(FEED_URL);
    const busyChecks = requests.filter((u) => u.startsWith('https://busy.example.com/'));
    expect(busyChecks.length).toBeLessThanOrEqual(FEED_SYNC_LIMITS.checksPerWorkspacePerRun);
    // The busy workspace still gets its turns, oldest first.
    expect(busyChecks[0]).toBe('https://busy.example.com/0.xml');
  });

  it('releases a waiting item even when many other sources are held back', async () => {
    // One workspace's send-mode sources each have an item waiting inside their quiet window.
    const now = Date.now();
    const current = Math.floor((now % (24 * HOUR)) / MINUTE);
    const held = await seedChannel();
    await enableFeedSync(held.workspaceId, held.channelId);
    const later = now + 24 * HOUR;
    const heldIds = Array.from({ length: 30 }, () => newId('feedSource'));
    await env.DB.batch(
      heldIds.flatMap((id, i) => [
        env.DB.prepare(
          `INSERT INTO feed_sources (id, channel_id, url, mode, quiet_start, quiet_end, next_check_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, 'send', ?4, ?5, ?6, 0, 0)`,
        ).bind(
          id,
          held.channelId,
          `https://held.example.com/${i}.xml`,
          (current + 1440 - 60) % 1440,
          (current + 60) % 1440,
          later,
        ),
        env.DB.prepare(
          `INSERT INTO feed_items (id, feed_source_id, key_hash, title, status, created_at, updated_at)
           VALUES (?1, ?2, 'k', 'Held', 'new', 0, 0)`,
        ).bind(newId('feedItem'), id),
      ]),
    );
    // Another workspace's draft-mode source with one item waiting, not due for a check.
    const free = await seedSource();
    await env.DB.batch([
      env.DB.prepare('UPDATE feed_sources SET next_check_at = ?2 WHERE id = ?1').bind(
        free.sourceId,
        later,
      ),
      env.DB.prepare(
        `INSERT INTO feed_items (id, feed_source_id, key_hash, title, status, created_at, updated_at)
         VALUES (?1, ?2, 'k', 'Waiting post', 'new', 0, 0)`,
      ).bind(newId('feedItem'), free.sourceId),
    ]);

    for (let i = 0; i < 3; i++) await minute(now + i * MINUTE);
    expect((await dispatchesOf(free.channelId)).map((d) => d.subject)).toEqual(['Waiting post']);
    expect(await dispatchesOf(held.channelId)).toHaveLength(0);
  });

  it('backs off an error of ours without counting it against the feed or turning it off', async () => {
    const { sourceId } = await seedSource();
    // A plain Error while reading the answer, as a parser regression would throw: not the
    // feed's fault, so it must not count towards turning the source off.
    useFeedFetchForTests((async () => {
      const response = new Response(rss([1]));
      Object.defineProperty(response, 'headers', {
        value: {
          get() {
            throw new Error('parser regression');
          },
        },
      });
      return response;
    }) as typeof fetch);
    let now = Date.now();
    let gap = 0;
    for (let i = 0; i < 10; i++) {
      await minute(now);
      const row = await source(sourceId);
      expect(row?.status).toBe('active');
      const next = row!.next_check_at;
      // Each check waits at least as long as the one before, up to the longest backoff.
      expect(next - now).toBeGreaterThanOrEqual(Math.max(gap, HOUR));
      gap = next - now;
      now = next;
    }
    expect(gap).toBe(FEED_SYNC_LIMITS.maxBackoffMs);
    expect(await source(sourceId)).toMatchObject({
      status: 'active',
      failure_count: 0,
      lock_until: null,
    });
  });

  it('leaves Channels without the flag alone', async () => {
    const server = feedServer();
    const { sourceId } = await seedSource({}, false);
    const now = Date.now();
    await minute(now);
    expect(server.requests).toHaveLength(0);
    expect((await source(sourceId))?.next_check_at).toBe(now + 60 * MINUTE);
  });

  it('prunes old items and the content of used ones daily', async () => {
    feedServer();
    const { sourceId } = await seedSource();
    await minute(Date.now());
    const old = Date.now() - 30 * 24 * HOUR;
    await env.DB.prepare('UPDATE feed_items SET updated_at = ?1 WHERE feed_source_id = ?2')
      .bind(old, sourceId)
      .run();
    await runScheduled(jobs(), DAILY_CRON, Date.now());
    expect(
      await count(
        'SELECT count(*) AS n FROM feed_items WHERE feed_source_id = ?1 AND content_json IS NOT NULL',
        sourceId,
      ),
    ).toBe(0);

    // Only the newest 500 items of a feed are kept; waiting ones never go.
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: FEED_SYNC_LIMITS.itemsKept + 5 }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO feed_items (id, feed_source_id, key_hash, title, status, created_at, updated_at)
           VALUES (?1, ?2, ?3, 'x', ?4, ?5, ?5)`,
        ).bind(newId('feedItem', now + i), sourceId, `k${i}`, i === 0 ? 'new' : 'skipped', now),
      ),
    );
    await pruneFeeds(jobs(), now);
    expect(
      await count('SELECT count(*) AS n FROM feed_items WHERE feed_source_id = ?1', sourceId),
    ).toBe(FEED_SYNC_LIMITS.itemsKept + 1);
    expect(
      await count(
        "SELECT count(*) AS n FROM feed_items WHERE feed_source_id = ?1 AND status = 'new'",
        sourceId,
      ),
    ).toBe(1);
  });
});
