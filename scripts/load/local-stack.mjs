// Shared by the local load runs (import-50k.mjs, circle-counts.mjs): a private copy of the api,
// jobs and realtime workers in one `wrangler dev`, so uploads, the queue and D1 are the real code
// paths, with a database of its own in a temp folder. Nothing here touches Cloudflare or the
// `.wrangler/state` the end-to-end tests use.
//
// Numbers from these runs are local D1 (workerd's SQLite on this disk): no network, no replicas,
// no Cloudflare limits. They show the query plans and the order of magnitude, not production.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const API_DIR = join(ROOT, 'workers/api');
const WRANGLER = join(API_DIR, 'node_modules/.bin/wrangler');
const APP_ORIGIN = 'http://localhost:5273';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function stack({ port = 18787, inspector = 19240 } = {}) {
  const state = mkdtempSync(join(tmpdir(), 'swarm-load-'));
  const persist = join(state, 'd1-state');
  const env = { ...process.env, WRANGLER_REGISTRY_PATH: join(state, 'registry') };
  const base = `http://localhost:${port}`;
  let child = null;
  let cookie = '';

  execFileSync(WRANGLER, ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist], {
    cwd: API_DIR,
    env,
    stdio: 'ignore',
  });

  const sqliteFile = () => {
    const dir = join(persist, 'v3/d1/miniflare-D1DatabaseObject');
    const file = readdirSync(dir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
    if (!file) throw new Error(`no D1 database under ${dir}`);
    return join(dir, file);
  };

  // Stopped from outside: don't leave wrangler running with no one to stop it.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      if (child) process.kill(-child.pid, 'SIGTERM');
      rmSync(state, { recursive: true, force: true });
      process.exit(1);
    });
  }

  return {
    base,
    /** The worker's database file, for seeding while stopped and for reading results. */
    openDb: (options = {}) => new DatabaseSync(sqliteFile(), options),

    async start() {
      child = spawn(
        WRANGLER,
        [
          'dev',
          '-c',
          'wrangler.jsonc',
          '-c',
          '../jobs/wrangler.jsonc',
          '-c',
          '../realtime/wrangler.jsonc',
          '--port',
          String(port),
          '--inspector-port',
          String(inspector),
          '--persist-to',
          persist,
        ],
        { cwd: API_DIR, env, stdio: 'ignore', detached: true },
      );
      for (let i = 0; i < 240; i++) {
        const up = await fetch(`${base}/healthz`).catch(() => null);
        if (up?.ok) return;
        await sleep(500);
      }
      throw new Error('the local workers did not start within 2 minutes');
    },

    async stop() {
      if (!child) return;
      const exited = new Promise((r) => child.once('exit', r));
      // The whole process group: wrangler starts workerd as a child.
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
      await Promise.race([exited, sleep(10_000)]);
      child = null;
    },

    remove() {
      rmSync(state, { recursive: true, force: true });
    },

    /** Dashboard API call with the session. Throws on anything but a 2xx. */
    async call(method, path, body, headers = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          origin: APP_ORIGIN,
          ...(cookie ? { cookie } : {}),
          ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 400)}`);
      const setCookie = res.headers.getSetCookie();
      if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
      return text ? JSON.parse(text).data : null;
    },

    /** Signs in through the QuickPass route and the dev mailbox. Cloudflare's test key passes. */
    async signIn(email) {
      await this.call('POST', '/api/v1/auth/quickpass', {
        email,
        turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX',
      });
      let token = null;
      for (let i = 0; i < 60 && !token; i++) {
        const res = await fetch(
          `${base}/__dev/mail/latest.json?to=${encodeURIComponent(email)}`,
        ).catch(() => null);
        if (res?.status === 200) {
          const { data } = await res.json();
          token = /#token=([^\s&]+)/.exec(data.text)?.[1] ?? null;
        }
        if (!token) await sleep(500);
      }
      if (!token) throw new Error('no sign-in mail arrived');
      return this.call('POST', '/api/v1/auth/quickpass/consume', {
        token: decodeURIComponent(token),
      });
    },

    /** A new Channel for the signed-in operator. */
    async channel(me, stamp) {
      const workspaceId = me.workspaces[0].id;
      const channel = await this.call('POST', `/api/v1/workspaces/${workspaceId}/channels`, {
        name: 'Load test',
        slug: `load-${stamp}`,
      });
      return { workspaceId, channelId: channel.id };
    },
  };
}

/** Median of a list of numbers. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
