// Applications: connecting Shorthop, roles, the sealed key, and making links. docs/applications.md.
import { env } from 'cloudflare:test';
import type { ShortLink, ShorthopConnection, ShorthopStatus } from '@swarm/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useApplicationsFetchForTests } from '../src/routes/applications';
import { useVaultProviderFetch } from './vault-fetch';
import { call, createChannel, seatAs, signIn, type Session } from './helpers';
import { data, errorCode } from './money-helpers';

const KEY = 'shp_secret_key_abcd';
const ADDRESS = 'https://go.example.com';

/** Answers like Shorthop's src/worker/mcp.ts. */
const shorthop = {
  key: KEY,
  calls: [] as { name: string; args: unknown; url: string }[],
  taken: [] as string[],
};

let owner: Session;
let viewer: Session;
let author: Session;
let channelId: string;
const path = () => `/api/v1/workspaces/${owner.workspaceId}/applications/shorthop`;
const links = (channel = channelId) => `/api/v1/channels/${channel}/applications/shorthop/links`;
const connect = (session = owner, body: Record<string, unknown> = {}) =>
  call('PUT', path(), {
    cookie: session.cookie,
    body: { baseUrl: ADDRESS, apiKey: KEY, slugFormat: '{post}-{random}', ...body },
  });

const shorthopFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const { method, params } = JSON.parse(String(init?.body)) as {
    method: string;
    params: { name: string; arguments: { slug?: string } };
  };
  const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result });
  if (method === 'tools/list') return reply({ tools: [{ name: 'create_link' }] });
  if (new Headers(init?.headers).get('authorization') !== `Bearer ${shorthop.key}`) {
    return reply({ content: [{ type: 'text', text: 'Invalid API key' }], isError: true });
  }
  shorthop.calls.push({ name: params.name, args: params.arguments, url: String(input) });
  if (params.name === 'list_links') return reply({ structuredContent: { links: [] } });
  return reply({
    structuredContent: { link: { shortUrl: `${ADDRESS}/${params.arguments.slug}` } },
  });
}) as typeof fetch;

beforeAll(async () => {
  // A key just typed is checked from the api; a saved one is used through the vault.
  useApplicationsFetchForTests(shorthopFake);
  useVaultProviderFetch(shorthopFake);
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  viewer = await seatAs(owner.workspaceId, 'viewer');
  author = await seatAs(owner.workspaceId, 'author');
});

afterAll(() => {
  useApplicationsFetchForTests(undefined);
  useVaultProviderFetch(null);
});
beforeEach(() => {
  shorthop.calls.length = 0;
});

describe('connecting Shorthop', () => {
  it('is behind its flag', async () => {
    const res = await connect();
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('feature_disabled');
    const status = await data<ShorthopStatus>(
      await call('GET', `/api/v1/channels/${channelId}/applications/shorthop`, {
        cookie: viewer.cookie,
      }),
    );
    expect(status.connected).toBe(false);
    await env.DB.prepare(
      `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
       VALUES (?1, 'applications', 'workspace', ?2, 1, 0)`,
    )
      .bind(`ff_apps_${owner.workspaceId}`, owner.workspaceId)
      .run();
    await env.CACHE.delete(`flags:v1:${owner.workspaceId}:-`);
    await env.CACHE.delete(`flags:v1:${owner.workspaceId}:${channelId}`);
  });

  it('is for admins, and refuses a wrong key without saving', async () => {
    expect((await connect(author)).status).toBe(403);
    const wrong = await connect(owner, { apiKey: 'shp_wrong_key_0000' });
    expect(wrong.status).toBe(400);
    const row = await env.DB.prepare('SELECT 1 FROM app_connections WHERE workspace_id = ?1')
      .bind(owner.workspaceId)
      .first();
    expect(row).toBeNull();
  });

  it('refuses an address inside the network', async () => {
    for (const baseUrl of [
      'https://169.254.169.254',
      'https://localhost',
      'http://go.example.com',
    ]) {
      const res = await connect(owner, { baseUrl });
      expect(res.status, baseUrl).toBe(400);
    }
  });

  it('stores the key sealed, and never gives it back', async () => {
    const res = await connect();
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(KEY);
    expect(JSON.parse(body).data).toMatchObject({
      connected: true,
      baseUrl: ADDRESS,
      last4: 'abcd',
    });
    const row = await env.DB.prepare('SELECT key_enc FROM app_connections WHERE workspace_id = ?1')
      .bind(owner.workspaceId)
      .first<{ key_enc: string }>();
    expect(row?.key_enc).not.toContain(KEY);
    expect((await call('GET', path(), { cookie: author.cookie })).status).toBe(403);
    // The editor's check says only whether it's connected.
    const status = await call('GET', `/api/v1/channels/${channelId}/applications/shorthop`, {
      cookie: viewer.cookie,
    });
    const text = await status.text();
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain('abcd');
  });
});

describe('making links', () => {
  const post = async (subject: string) => {
    const res = await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
      cookie: owner.cookie,
      body: { subject },
    });
    return (await data<{ id: string }>(res, 201)).id;
  };

  it('names a link with the format, and gives the same link for the same address in a post', async () => {
    const dispatchId = await post('The Slow Web');
    const make = async () =>
      data<ShortLink>(
        await call('POST', links(), {
          cookie: author.cookie,
          body: { url: 'https://example.org/read', dispatchId },
        }),
      );
    const first = await make();
    expect(first.shortUrl).toMatch(/^https:\/\/go\.example\.com\/the-slow-web-[a-z0-9]+$/);
    expect(shorthop.calls[0]).toMatchObject({
      name: 'create_link',
      url: `${ADDRESS}/api/mcp`,
      args: { url: 'https://example.org/read', title: 'The Slow Web' },
    });
    expect((await make()).shortUrl).toBe(first.shortUrl);
    expect(shorthop.calls).toHaveLength(1);
  });

  it('leaves a link that is already short alone', async () => {
    const res = await data<ShortLink>(
      await call('POST', links(), {
        cookie: author.cookie,
        body: { url: `${ADDRESS}/existing` },
      }),
    );
    expect(res.shortUrl).toBe(`${ADDRESS}/existing`);
    expect(shorthop.calls).toHaveLength(0);
  });

  it('leaves a link it made alone, even on a short domain it wasn’t told about', async () => {
    const made = await data<ShortLink>(
      await call('POST', links(), {
        cookie: author.cookie,
        body: { url: 'https://example.org/twice' },
      }),
    );
    const onPrimary = 'https://sho.rt/abc123';
    await env.DB.prepare('UPDATE app_short_links SET short_url = ?1 WHERE short_url = ?2')
      .bind(onPrimary, made.shortUrl)
      .run();
    shorthop.calls.length = 0;
    const again = await data<ShortLink>(
      await call('POST', links(), { cookie: author.cookie, body: { url: onPrimary } }),
    );
    expect(again.shortUrl).toBe(onPrimary);
    expect(shorthop.calls).toHaveLength(0);
  });

  it('is for writers, in their own workspace only', async () => {
    const body = { url: 'https://example.org/x' };
    expect((await call('POST', links(), { cookie: viewer.cookie, body })).status).toBe(403);
    const outsider = await signIn();
    expect((await call('POST', links(), { cookie: outsider.cookie, body })).status).toBe(404);
    // A post from another publication can't be named here.
    const other = await createChannel(owner);
    const foreign = await data<{ id: string }>(
      await call('POST', `/api/v1/channels/${other.id}/dispatches`, {
        cookie: owner.cookie,
        body: { subject: 'Elsewhere' },
      }),
      201,
    );
    const res = await call('POST', links(), {
      cookie: owner.cookie,
      body: { ...body, dispatchId: foreign.id },
    });
    expect(res.status).toBe(404);
  });

  it('refuses what isn’t a web address', async () => {
    const res = await call('POST', links(), {
      cookie: author.cookie,
      body: { url: 'mailto:someone@example.org' },
    });
    expect(res.status).toBe(400);
  });

  it('uses the new format after a change, and stops after disconnecting', async () => {
    const saved = await data<ShorthopConnection>(
      await call('PATCH', path(), { cookie: owner.cookie, body: { slugFormat: 'news-{random}' } }),
    );
    expect(saved.slugFormat).toBe('news-{random}');
    const made = await data<ShortLink>(
      await call('POST', links(), {
        cookie: author.cookie,
        body: { url: 'https://example.org/new-format' },
      }),
    );
    expect(made.shortUrl).toMatch(/\/news-[a-z0-9]+$/);

    const gone = await call('DELETE', path(), { cookie: owner.cookie });
    expect(gone.status).toBe(204);
    const remains = await env.DB.prepare(
      `SELECT (SELECT count(*) FROM app_connections WHERE workspace_id = ?1) AS n`,
    )
      .bind(owner.workspaceId)
      .first<{ n: number }>();
    expect(remains?.n).toBe(0);
    const after = await call('POST', links(), {
      cookie: author.cookie,
      body: { url: 'https://example.org/after' },
    });
    expect(after.status).toBe(404);
  });
});
