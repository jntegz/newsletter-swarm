import { parse } from 'jsonc-parser';
import { renderInput, renderWorkerConfig, assertNoPlaceholders } from '../config/render';
import { accountId, database, oauthApi, save, zoneId, type Ctx } from '../context';
import { CloudflareError } from '../cloudflare';
import { secretValues } from '../keys';
import { scriptName, type Worker } from '../paths';
import { InstallError } from '../ui';
import type { Release } from './release';

type Json = Record<string, unknown>;
const BASE = 'https://api.cloudflare.com/client/v4';

/** A multipart body from text parts, which is all a deploy needs. */
function multipart(parts: { name: string; filename?: string; type?: string; body: string }[]) {
  const boundary = `swarm-${crypto.randomUUID()}`;
  const body = parts
    .map(
      (part) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"` +
        (part.filename ? `; filename="${part.filename}"` : '') +
        (part.type ? `\r\nContent-Type: ${part.type}` : '') +
        `\r\n\r\n${part.body}\r\n`,
    )
    .join('');
  return { body: `${body}--${boundary}--\r\n`, type: `multipart/form-data; boundary=${boundary}` };
}

async function send<T>(
  ctx: Ctx,
  method: 'POST' | 'PUT',
  path: string,
  form: ReturnType<typeof multipart>,
  token = ctx.session.oauthToken ?? '',
): Promise<T> {
  const response = await ctx.t.http({
    method,
    url: `${BASE}${path}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': form.type },
    body: form.body,
  });
  let parsed: { success?: boolean; result?: T; errors?: { message?: string }[] } = {};
  try {
    parsed = JSON.parse(response.text) as typeof parsed;
  } catch {
    parsed = {};
  }
  if (response.status >= 400 || parsed.success === false) {
    const detail = parsed.errors?.map((e) => e.message).join('; ') || response.text.slice(0, 200);
    throw new InstallError(`Cloudflare refused ${method} ${path} (${response.status}): ${detail}`);
  }
  return parsed.result as T;
}

/** The bindings a Worker's rendered config asks for, in the form the upload API takes. */
export function bindingsFrom(block: Json, secrets: Record<string, string>): Json[] {
  const list = (key: string) => (block[key] ?? []) as Json[];
  const out: Json[] = [];
  for (const [name, value] of Object.entries((block.vars ?? {}) as Json)) {
    out.push(
      typeof value === 'string'
        ? { type: 'plain_text', name, text: value }
        : { type: 'json', name, json: value },
    );
  }
  for (const [name, text] of Object.entries(secrets)) out.push({ type: 'secret_text', name, text });
  for (const d of list('d1_databases'))
    out.push({ type: 'd1', name: d.binding, id: d.database_id });
  for (const k of list('kv_namespaces')) {
    out.push({ type: 'kv_namespace', name: k.binding, namespace_id: k.id });
  }
  for (const b of list('r2_buckets')) {
    out.push({ type: 'r2_bucket', name: b.binding, bucket_name: b.bucket_name });
  }
  const queues = (block.queues ?? {}) as { producers?: Json[] };
  for (const q of queues.producers ?? []) {
    out.push({ type: 'queue', name: q.binding, queue_name: q.queue });
  }
  const objects = (block.durable_objects ?? {}) as { bindings?: Json[] };
  for (const d of objects.bindings ?? []) {
    out.push({
      type: 'durable_object_namespace',
      name: d.name,
      class_name: d.class_name,
      ...(d.script_name ? { script_name: d.script_name } : {}),
    });
  }
  // A named entrypoint (the vault's ApiVault, CaptureVault, …) goes as `entrypoint`, as wrangler
  // sends it: the binding then reaches that class's methods and no other.
  for (const s of list('services')) {
    out.push({
      type: 'service',
      name: s.binding,
      service: s.service,
      ...(s.entrypoint ? { entrypoint: s.entrypoint } : {}),
    });
  }
  for (const r of list('ratelimits')) {
    out.push({ type: 'ratelimit', name: r.name, namespace_id: r.namespace_id, simple: r.simple });
  }
  const ai = block.ai as Json | undefined;
  if (ai) out.push({ type: 'ai', name: ai.binding });
  const images = block.images as Json | undefined;
  if (images) out.push({ type: 'images', name: images.binding });
  const assets = block.assets as Json | undefined;
  if (assets?.binding) out.push({ type: 'assets', name: assets.binding });
  return out;
}

/** The Durable Object migrations still to run, after the tag the script is already on. */
export function pendingObjectMigrations(migrations: Json[], current: string | null): Json | null {
  if (migrations.length === 0) return null;
  const from = current === null ? 0 : migrations.findIndex((m) => m.tag === current) + 1;
  const steps = migrations.slice(from).map(({ tag: _tag, ...step }) => step);
  if (steps.length === 0) return null;
  return {
    ...(current === null ? {} : { old_tag: current }),
    new_tag: migrations[migrations.length - 1]?.tag,
    steps,
  };
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
};
const contentType = (path: string) =>
  CONTENT_TYPES[path.split('.').pop() ?? ''] ?? 'application/octet-stream';

const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 32_768));
  }
  return btoa(binary);
};

/** Rules, not files to serve. wrangler sends them as config, and so does this. */
const ASSET_CONFIG_FILES = ['dashboard/_headers', 'dashboard/_redirects'];

/**
 * The dashboard's CSP frames only Turnstile and loads fonts only from itself. Website → Design
 * shows a live preview from this install's own websites (<slug>.<zone>, or the zone itself for a
 * publication at the root), and draws uploaded fonts from its media origin (media.<zone>), so at
 * deploy time frame-src and font-src also name exactly those, and nothing else on the web. A zone
 * that isn't a plain host name leaves the headers as they are.
 */
export function withOwnSiteSources(headers: string, zone: string | undefined): string {
  if (!zone || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(zone)) {
    return headers;
  }
  const own = `https://${zone} https://*.${zone}`;
  const add = (directive: string) => (directive.includes(own) ? directive : `${directive} ${own}`);
  return headers.replace(/(frame-src [^;\n]*)/, add).replace(/(font-src [^;\n]*)/, add);
}

/** The dashboard's _headers and _redirects, which hold its security headers. */
async function assetRules(release: Release, zone: string | undefined): Promise<Json> {
  const rules: Json = {};
  for (const path of ASSET_CONFIG_FILES) {
    if (release.files.some((f) => f.path === path)) {
      const text = await release.text(path);
      rules[path.slice('dashboard/'.length)] =
        path === 'dashboard/_headers' ? withOwnSiteSources(text, zone) : text;
    }
  }
  return rules;
}

/** Uploads the dashboard's files. Returns the token the Worker upload then uses. */
async function uploadAssets(ctx: Ctx, release: Release, script: string): Promise<string> {
  const account = `/accounts/${accountId(ctx)}`;
  const files = release.files.filter(
    (f) => f.path.startsWith('dashboard/') && !ASSET_CONFIG_FILES.includes(f.path),
  );
  const byHash = new Map(files.map((f) => [f.sha256.slice(0, 32), f]));
  const manifest = Object.fromEntries(
    files.map((f) => [
      f.path.slice('dashboard'.length),
      { hash: f.sha256.slice(0, 32), size: f.size },
    ]),
  );
  const session = await oauthApi(ctx).post<{ jwt: string; buckets?: string[][] }>(
    `${account}/workers/scripts/${script}/assets-upload-session`,
    { manifest },
  );
  let jwt = session.jwt;
  for (const bucket of session.buckets ?? []) {
    const parts = [];
    for (const hash of bucket) {
      const file = byHash.get(hash);
      if (!file) throw new InstallError(`Cloudflare asked for an unknown file (${hash}).`);
      parts.push({
        name: hash,
        filename: hash,
        type: contentType(file.path),
        body: toBase64(await release.bytes(file.path)),
      });
    }
    const uploaded = await send<{ jwt?: string }>(
      ctx,
      'POST',
      `${account}/workers/assets/upload?base64=true`,
      multipart(parts),
      session.jwt,
    );
    if (uploaded?.jwt) jwt = uploaded.jwt;
  }
  return jwt;
}

async function connectQueues(ctx: Ctx, script: string, consumers: Json[]) {
  if (consumers.length === 0) return;
  const cf = oauthApi(ctx);
  const account = `/accounts/${accountId(ctx)}`;
  const queues = await cf.list<{ queue_id: string; queue_name: string }>(`${account}/queues`);
  for (const consumer of consumers) {
    const queue = queues.find((q) => q.queue_name === consumer.queue);
    if (!queue) throw new InstallError(`The queue ${String(consumer.queue)} does not exist.`);
    const path = `${account}/queues/${queue.queue_id}/consumers`;
    const existing = await cf.get<{ script?: string; script_name?: string }[]>(path);
    if (existing?.some((c) => (c.script ?? c.script_name) === script)) continue;
    await cf.post(path, {
      type: 'worker',
      script_name: script,
      ...(consumer.dead_letter_queue ? { dead_letter_queue: consumer.dead_letter_queue } : {}),
      settings: {
        ...(consumer.max_batch_size ? { batch_size: consumer.max_batch_size } : {}),
        ...(typeof consumer.max_batch_timeout === 'number'
          ? { max_wait_time_ms: consumer.max_batch_timeout * 1000 }
          : {}),
        ...(typeof consumer.max_retries === 'number' ? { max_retries: consumer.max_retries } : {}),
        ...(consumer.max_concurrency ? { max_concurrency: consumer.max_concurrency } : {}),
      },
    });
  }
}

async function connectRoutes(ctx: Ctx, script: string, routes: { pattern: string }[]) {
  if (routes.length === 0) return;
  const cf = oauthApi(ctx);
  const path = `/zones/${zoneId(ctx)}/workers/routes`;
  const existing = await cf.get<{ id: string; pattern: string; script?: string }[]>(path);
  for (const { pattern } of routes) {
    const found = existing.find((r) => r.pattern === pattern);
    if (!found) await cf.post(path, { pattern, script });
    else if (found.script !== script) await cf.put(`${path}/${found.id}`, { pattern, script });
  }
}

/** Deploys one Worker from a release, doing what `wrangler deploy` does with the same config. */
export async function deployWorkerFromRelease(ctx: Ctx, release: Release, worker: Worker) {
  const script = scriptName(worker, ctx.env);
  const template = await release.text(`workers/${worker}/wrangler.jsonc`);
  const rendered = renderWorkerConfig(worker, template, renderInput(ctx.state));
  assertNoPlaceholders(worker, rendered, ctx.env);
  const config = parse(rendered) as Json & { env: Record<string, Json> };
  const block = config.env[ctx.env] as Json;
  const account = `/accounts/${accountId(ctx)}`;
  const cf = oauthApi(ctx);

  const scripts = await cf.get<{ id: string; migration_tag?: string }[]>(
    `${account}/workers/scripts`,
  );
  const current = scripts.find((s) => s.id === script)?.migration_tag ?? null;
  const migrations = pendingObjectMigrations(
    (block.migrations ?? config.migrations ?? []) as Json[],
    current,
  );
  const assets = block.assets as Json | undefined;
  const jwt = assets ? await uploadAssets(ctx, release, script) : null;

  const code = release.files.filter(
    (f) => f.path.startsWith(`workers/${worker}/`) && !f.path.endsWith('wrangler.jsonc'),
  );
  const metadata = {
    main_module: 'index.js',
    compatibility_date: config.compatibility_date,
    ...(config.compatibility_flags ? { compatibility_flags: config.compatibility_flags } : {}),
    bindings: bindingsFrom(block, await secretValues(worker, ctx.state, ctx.secrets)),
    ...(config.observability ? { observability: config.observability } : {}),
    ...(migrations ? { migrations } : {}),
    ...(assets && jwt
      ? {
          assets: {
            jwt,
            config: {
              ...(await assetRules(release, ctx.state.zone?.name)),
              ...(assets.not_found_handling
                ? { not_found_handling: assets.not_found_handling }
                : {}),
              ...(assets.run_worker_first ? { run_worker_first: assets.run_worker_first } : {}),
            },
          },
        }
      : {}),
  };
  const parts = [
    { name: 'metadata', type: 'application/json', body: JSON.stringify(metadata) },
    ...(await Promise.all(
      code.map(async (file) => {
        const name = file.path.split('/').pop() as string;
        return {
          name,
          filename: name,
          type: 'application/javascript+module',
          body: await release.text(file.path),
        };
      }),
    )),
  ];
  await send(ctx, 'PUT', `${account}/workers/scripts/${script}`, multipart(parts));
  // What `wrangler deploy` does with workers_dev and preview_urls: stated per Worker in its config
  // (false for every Swarm Worker), so the default hostname is off whatever the account's default.
  await cf.post(`${account}/workers/scripts/${script}/subdomain`, {
    enabled: (block.workers_dev ?? config.workers_dev ?? false) === true,
    previews_enabled: (block.preview_urls ?? config.preview_urls ?? false) === true,
  });

  const triggers = (block.triggers ?? config.triggers ?? {}) as { crons?: string[] };
  if (triggers.crons?.length) {
    await cf.put(
      `${account}/workers/scripts/${script}/schedules`,
      triggers.crons.map((cron) => ({ cron })),
    );
  }
  const queues = (block.queues ?? {}) as { consumers?: Json[] };
  await connectQueues(ctx, script, queues.consumers ?? []);
  await connectRoutes(ctx, script, (block.routes ?? []) as { pattern: string }[]);

  ctx.state.deployedAt = { ...ctx.state.deployedAt, [worker]: Date.now() };
  if (worker === 'vault' && ctx.state.vault?.since === undefined) {
    ctx.state.vault = {
      writeFormat: ctx.state.vault?.writeFormat ?? 'legacy',
      legacyOpen: ctx.state.vault?.legacyOpen ?? true,
      since: Date.now(),
    };
  }
  await save(ctx);
}

/**
 * Applies the migrations the database hasn't had, and records them in d1_migrations, the table
 * wrangler keeps, so `pnpm swarm update` agrees on what has run.
 */
export async function applyMigrationsFromRelease(ctx: Ctx, release: Release) {
  const db = database(ctx);
  const d1 = ctx.state.resources.d1;
  if (!d1) throw new InstallError('The database does not exist yet.');
  const cf = oauthApi(ctx);
  const query = `/accounts/${accountId(ctx)}/d1/database/${d1.id}/query`;
  await db.run([
    {
      sql: 'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
      params: [],
    },
  ]);
  const [done] = await db.run([{ sql: 'SELECT name FROM d1_migrations', params: [] }]);
  const applied = new Set((done?.results ?? []).map((row) => String(row.name)));
  const files = release.files
    .filter((f) => /^migrations\/\d{4}_[\w-]+\.sql$/.test(f.path))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const file of files) {
    const name = file.path.slice('migrations/'.length);
    if (applied.has(name)) continue;
    try {
      await cf.post(query, { sql: await release.text(file.path) });
    } catch (error) {
      if (error instanceof CloudflareError) {
        throw new InstallError(`The migration ${name} failed: ${error.message}`);
      }
      throw error;
    }
    await db.run([{ sql: 'INSERT INTO d1_migrations (name) VALUES (?1)', params: [name] }]);
  }
}
