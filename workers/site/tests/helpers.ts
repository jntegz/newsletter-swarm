import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { sha256Hex } from '@swarm/db';
import { newId } from '@swarm/domain';
import { DevMailbox, type StoredMail } from '@swarm/mail';
import { signToken } from '@swarm/tokens';
import type { Hono } from 'hono';
import type { SiteBindings } from '../src/context';
import type { DnsFetch } from '../src/edge/crawler';
import { parseSiteEnv } from '../src/env';
import { createSite } from '../src/index';
import type { EdgeDeps } from '../src/middleware/edge';
import { reader } from '../src/routes/reader';

const DOMAIN = 'swarm.test';
export const READER_COOKIE = 'swarm_reader';

let counter = 0;
const unique = () => `${++counter}${crypto.randomUUID().slice(0, 6)}`;

/** A fresh client IP per call site, so per-IP limits don't leak between tests. */
export const nextIp = () => `198.51.${Math.floor(++counter / 250) % 250}.${counter % 250}`;
export const uniqueEmail = (label = 'reader') => `${label}-${unique()}@example.org`;

export interface SeededChannel {
  workspaceId: string;
  channelId: string;
  slug: string;
  host: string;
  origin: string;
}

interface SiteSettings {
  aiBots?: 'unset' | 'allow' | 'block' | 'custom';
  exposeGated?: boolean;
  cacheVersion?: number;
}

export async function seedChannel(settings?: SiteSettings): Promise<SeededChannel> {
  const now = Date.now();
  const workspaceId = newId('workspace', now);
  const channelId = newId('channel', now);
  const slug = `site-${unique()}`;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
    ).bind(workspaceId, 'W', now),
    env.DB.prepare(
      `INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Field Notes', ?4, ?4)`,
    ).bind(channelId, workspaceId, slug, now),
  ]);
  if (settings) await setSettings(channelId, settings);
  const host = `${slug}.${DOMAIN}`;
  return { workspaceId, channelId, slug, host, origin: `http://${host}` };
}

export async function setSettings(channelId: string, settings: SiteSettings): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO site_settings (channel_id, ai_bots, expose_gated, cache_version, updated_at)
     VALUES (?1, ?2, ?3, ?4, 0)
     ON CONFLICT (channel_id) DO UPDATE SET ai_bots = excluded.ai_bots,
       expose_gated = excluded.expose_gated, cache_version = excluded.cache_version`,
  )
    .bind(
      channelId,
      settings.aiBots ?? 'unset',
      settings.exposeGated ? 1 : 0,
      settings.cacheVersion ?? 1,
    )
    .run();
}

export async function addMember(
  channelId: string,
  email: string,
  status = 'active',
): Promise<string> {
  const now = Date.now();
  const id = newId('member', now);
  await env.DB.prepare(
    `INSERT INTO members (id, channel_id, email, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
  )
    .bind(id, channelId, email, status, now)
    .run();
  return id;
}

export async function addEntitlement(
  channelId: string,
  memberId: string,
  startsAt: number,
  expiresAt: number | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at, expires_at)
     VALUES (?1, ?2, 'paid', 'test', ?3, ?4)`,
  )
    .bind(memberId, channelId, startsAt, expiresAt)
    .run();
}

/** A valid reader session for a Member, as the cookie header value the browser would send. */
export async function sessionCookie(channelId: string, memberId: string): Promise<string> {
  const value = await signToken(
    parseSiteEnv(env).READER_KEYS,
    'reader-session',
    { n: unique() },
    { noExpiry: true },
  );
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO reader_sessions (id_hash, channel_id, member_id, created_at, last_seen_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?4, ?5)`,
  )
    .bind(await sha256Hex(value), channelId, memberId, now, now + 86_400_000)
    .run();
  return `${READER_COOKIE}=${value}`;
}

export async function mailTo(email: string): Promise<StoredMail[]> {
  return new DevMailbox(env.DEV_MAILBOX).list({ to: email });
}

export const PUBLIC_PAGE_CACHE = 'public, s-maxage=300, stale-while-revalidate=86400';

/** Counts renders of the stub page, to tell cache hits from misses. */
export const renders = { count: 0 };

/**
 * The site pipeline (headers, tenant, edge) with stub routes in place of the pages and feeds the
 * rendering workstream owns, plus the real reader sign-in routes.
 */
export function testSite(deps: EdgeDeps = {}): Hono<SiteBindings> {
  return createSite((site) => {
    site.route('/_swarm/reader', reader);
    site.get('/robots.txt', (c) => c.text('User-agent: *\nAllow: /\n'));
    site.get('/whoami', (c) =>
      c.json({ reader: c.get('reader'), crawler: c.get('crawlerFullAccess') }),
    );
    // A cacheable page with an inline script, like the real pages.
    site.get('/page', (c) => {
      renders.count++;
      const n = c.get('nonce');
      return c.html(
        `<!doctype html><html><head><style nonce="${n}">p{}</style></head><body><p>${c.get('reader').class} render ${renders.count}</p><script nonce="${n}">1</script></body></html>`,
        200,
        {
          'x-swarm-cacheable': '1',
          'cache-control':
            c.get('reader').class === 'anonymous' ? PUBLIC_PAGE_CACHE : 'private, no-cache',
          'cache-tag': c.get('channel').id,
        },
      );
    });
    // Like the real stylesheet, feeds and old-slug redirects: cacheable, outside the HTML rules.
    site.get('/_swarm/site.css', (c) => {
      renders.count++;
      return c.body(`p{color:red} /* ${renders.count} */`, 200, {
        'content-type': 'text/css; charset=utf-8',
        'x-swarm-cacheable': '1',
        'cache-control': PUBLIC_PAGE_CACHE,
      });
    });
    site.get('/feed', (c) =>
      c.body(`<rss><channel><title nonce="x">${++renders.count}</title></channel></rss>`, 200, {
        'content-type': 'application/rss+xml; charset=utf-8',
        'x-swarm-cacheable': '1',
        'cache-control': PUBLIC_PAGE_CACHE,
      }),
    );
    site.get('/p/old-slug', (c) => {
      renders.count++;
      c.header('x-swarm-cacheable', '1');
      c.header('cache-control', PUBLIC_PAGE_CACHE);
      return c.redirect('/p/new-slug', 301);
    });
    site.get('/uncached', (c) => c.html('<!doctype html><p>fresh</p>'));
    site.get('/with-cookie', (c) =>
      c.html('<!doctype html><p>cookie</p>', 200, {
        'x-swarm-cacheable': '1',
        'set-cookie': 'pref=1; Path=/',
      }),
    );
    site.get('/missing', (c) =>
      c.html('<!doctype html><p>gone</p>', 404, { 'x-swarm-cacheable': '1' }),
    );
    site.get('/archive', (c) => c.html('<!doctype html><p>archive</p>'));
    site.get('/new', (c) => c.html('<!doctype html><p>new</p>'));
  }, deps);
}

interface CallInit extends RequestInit {
  cf?: Record<string, unknown>;
}

/** Calls an app and waits for its background work (waitUntil) to finish. */
export async function call(
  site: Hono<SiteBindings>,
  url: string,
  init: CallInit = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const request = new Request(url, { redirect: 'manual', ...init } as RequestInit);
  const res = await site.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** A fake DNS-over-HTTPS resolver over a fixed table, counting lookups. */
export function fakeDoh(records: Record<string, { type: number; data: string }[]>): {
  fetch: DnsFetch;
  lookups: string[];
} {
  const lookups: string[] = [];
  return {
    lookups,
    fetch: async (input) => {
      const url = new URL(input);
      const key = `${url.searchParams.get('type')} ${url.searchParams.get('name')}`;
      lookups.push(key);
      const answer = records[key];
      return Response.json(answer ? { Status: 0, Answer: answer } : { Status: 3 });
    },
  };
}

/** Lets a workspace's code run on the platform address (migrations/0065_site_code_rules.sql). */
export async function allowSiteCode(workspaceId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO site_code_workspaces (workspace_id, created_at) VALUES (?1, 0)
     ON CONFLICT (workspace_id) DO NOTHING`,
  )
    .bind(workspaceId)
    .run();
}
