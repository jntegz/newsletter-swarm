import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, json, signIn, type Session } from './helpers';
import { enableFlag } from './money-helpers';

let owner: Session;
let channelId: string;

const doc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
};
const item = (slug: string, extra: Record<string, unknown> = {}) => ({
  subject: `Issue ${slug}`,
  preheader: 'Sub',
  slug,
  publishedAt: '2024-05-06T10:00:00.000Z',
  visibility: 'public',
  content: doc,
  ...extra,
});
const post = (items: unknown[], dryRun = false) =>
  call('POST', `/api/v1/channels/${channelId}/archive-import`, {
    cookie: owner.cookie,
    body: { dryRun, items },
  });

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
});

describe('importing past issues', () => {
  it('is off without its flag', async () => {
    expect((await post([item('off')])).status).toBe(404);
    await enableFlag('archive_import', owner.workspaceId, channelId);
  });

  it('checks without changing anything on a dry run', async () => {
    const res = await post([item('dry')], true);
    expect((await json<{ data: { results: unknown[] } }>(res)).data.results).toEqual([
      { slug: 'dry', outcome: 'ready', message: null },
    ]);
    const row = await env.DB.prepare('SELECT 1 FROM dispatches WHERE channel_id = ?1')
      .bind(channelId)
      .first();
    expect(row).toBeNull();
  });

  it('puts posts on the site with their dates and addresses, and sends nothing', async () => {
    const res = await post([item('first-issue'), item('paid-issue', { visibility: 'paid' })]);
    expect(res.status).toBe(200);
    const { results } = (await json<{ data: { results: { outcome: string }[] } }>(res)).data;
    expect(results.map((r) => r.outcome)).toEqual(['imported', 'imported']);
    const rows = await env.DB.prepare(
      `SELECT d.status, d.web_published_at, d.web_visibility, s.slug
         FROM dispatches d JOIN dispatch_slugs s ON s.dispatch_id = d.id AND s.is_current = 1
        WHERE d.channel_id = ?1 ORDER BY s.slug`,
    )
      .bind(channelId)
      .all<{ status: string; web_published_at: number; web_visibility: string; slug: string }>();
    expect(rows.results).toMatchObject([
      { slug: 'first-issue', status: 'draft', web_visibility: 'public' },
      { slug: 'paid-issue', status: 'draft', web_visibility: 'paid' },
    ]);
    expect(rows.results[0]?.web_published_at).toBe(Date.parse('2024-05-06T10:00:00.000Z'));
    const sent = await env.DB.prepare(
      `SELECT count(*) AS n FROM broadcasts b JOIN dispatches d ON d.id = b.dispatch_id WHERE d.channel_id = ?1`,
    )
      .bind(channelId)
      .first<{ n: number }>();
    expect(sent?.n).toBe(0);
  });

  it('leaves an address already in use alone, so importing again is safe', async () => {
    const { results } = (
      await json<{ data: { results: { outcome: string }[] } }>(await post([item('first-issue')]))
    ).data;
    expect(results[0]?.outcome).toBe('exists');
  });

  it('refuses bad addresses and too many at once', async () => {
    expect((await post([item('Bad Slug!')])).status).toBe(400);
    const many = Array.from({ length: 26 }, (_, i) => item(`n${i}`));
    expect((await post(many)).status).toBe(400);
  });
});
