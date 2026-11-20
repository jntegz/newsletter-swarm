import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { defaultCaptureFormConfig, newId, type CaptureFormConfig } from '@swarm/domain';
import { DevMailbox, type StoredMail } from '@swarm/mail';
import worker from '../src/index';

export const ORIGIN = 'https://forms.swarm.test';
export const HOST = 'https://news.example.com';

let ipCounter = 0;
/** A fresh client IP per test, so per-IP limits don't leak between tests. */
export const nextIp = () => `203.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

let emailCounter = 0;
export const uniqueEmail = (label = 'reader') =>
  `${label}-${++emailCounter}-${crypto.randomUUID().slice(0, 8)}@example.org`;

let bindings: object = env;

/**
 * Runs `work` with the public queue replaced by a list, and returns what capture queued on it
 * meanwhile. Capture has no other queue binding.
 */
export async function recordPublicQueue(work: () => Promise<unknown>): Promise<unknown[]> {
  const queued: unknown[] = [];
  bindings = {
    ...env,
    PUBLIC_QUEUE: { send: async (message: unknown) => void queued.push(message) },
  };
  try {
    await work();
  } finally {
    bindings = env;
  }
  return queued;
}

/** Calls the worker and waits for its background work (waitUntil) to finish. */
export async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { redirect: 'manual', ...init }),
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

export async function seedChannel(settings: Record<string, unknown> = {}) {
  const now = Date.now();
  const workspaceId = newId('workspace');
  const channelId = newId('channel');
  const slug = `ch-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
    ).bind(workspaceId, 'Test workspace', now),
    env.DB.prepare(
      `INSERT INTO channels (id, workspace_id, slug, name, branding_json, settings_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Field Notes', '{"accentColor":"#2b7a78"}', ?4, ?5, ?5)`,
    ).bind(channelId, workspaceId, slug, JSON.stringify(settings), now),
  ]);
  return { workspaceId, channelId, slug };
}

/** A published form (version 1) with the default config plus `overrides`. */
export async function seedForm(
  channel: { workspaceId: string; channelId: string },
  overrides: Partial<CaptureFormConfig> = {},
) {
  const now = Date.now();
  const id = newId('captureForm');
  const config = { ...defaultCaptureFormConfig(), ...overrides };
  const json = JSON.stringify(config);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO capture_forms (id, workspace_id, channel_id, name, status, draft_config_json, published_config_json,
         version, published_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Footer form', 'published', ?4, ?4, 1, ?5, ?5, ?5)`,
    ).bind(id, channel.workspaceId, channel.channelId, json, now),
    env.DB.prepare(
      'INSERT INTO capture_form_versions (form_id, version, config_json, published_at) VALUES (?1, 1, ?2, ?3)',
    ).bind(id, json, now),
  ]);
  return { id, config };
}

/** Publishes `config` as the next version, the way the api does. */
export async function republish(formId: string, config: CaptureFormConfig) {
  const now = Date.now();
  const json = JSON.stringify(config);
  const row = await env.DB.prepare(
    `UPDATE capture_forms SET version = version + 1, published_config_json = ?1, draft_config_json = ?1, published_at = ?2
      WHERE id = ?3 RETURNING version`,
  )
    .bind(json, now, formId)
    .first<{ version: number }>();
  await env.DB.prepare(
    'INSERT INTO capture_form_versions (form_id, version, config_json, published_at) VALUES (?1, ?2, ?3, ?4)',
  )
    .bind(formId, row!.version, json, now)
    .run();
  return row!.version;
}

interface JsonOptions {
  ip?: string;
  origin?: string | null;
}

/** A submission as the form frame sends it. */
export function submitJson(
  formId: string,
  body: Record<string, unknown>,
  options: JsonOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'cf-connecting-ip': options.ip ?? nextIp(),
  };
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  return call(`/v1/${formId}/subscribe`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ turnstileToken: 'token', parentOrigin: HOST, website: '', ...body }),
  });
}

/** The no-JS form post from a host page. */
export function submitForm(
  formId: string,
  fields: Record<string, string | string[]>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) body.append(name, v);
  }
  return call(`/v1/${formId}/subscribe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cf-connecting-ip': nextIp(),
      origin: HOST,
      referer: `${HOST}/essays/one?utm_source=footer`,
      ...headers,
    },
    body: body.toString(),
  });
}

/** Turns a flag on for one Channel. */
export async function enableFlag(channelId: string, key: string) {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, ?2, 'channel', ?3, 1, 0)`,
  )
    .bind(newId('featureFlag'), key, channelId)
    .run();
}

export async function mailTo(email: string): Promise<StoredMail[]> {
  return new DevMailbox(env.DEV_MAILBOX).list({ to: email });
}

export async function member(channelId: string, email: string) {
  return env.DB.prepare('SELECT * FROM members WHERE channel_id = ?1 AND email = ?2')
    .bind(channelId, email)
    .first<{
      id: string;
      status: string;
      source_json: string;
      form_id: string | null;
      referred_by: string | null;
      confirmed_at: number | null;
      paused_until: number | null;
      digest: string;
      first_name: string | null;
      unsubscribe_reason: string | null;
    }>();
}

export async function addMember(channelId: string, email: string, status: string) {
  const id = newId('member');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO members (id, channel_id, email, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
  )
    .bind(id, channelId, email, status, now)
    .run();
  return id;
}

export async function daily(formId: string) {
  const row = await env.DB.prepare(
    'SELECT sum(views) AS views, sum(submissions) AS submissions, sum(confirmed) AS confirmed FROM capture_form_daily WHERE form_id = ?1',
  )
    .bind(formId)
    .first<{ views: number | null; submissions: number | null; confirmed: number | null }>();
  return {
    views: row?.views ?? 0,
    submissions: row?.submissions ?? 0,
    confirmed: row?.confirmed ?? 0,
  };
}

/** The confirm link in the newest mail to `email`. */
export async function confirmLink(email: string): Promise<string> {
  const [mail] = await mailTo(email);
  const match = /https:\/\/forms\.swarm\.test(\/v1\/confirm\/[A-Za-z0-9._-]+)/.exec(
    mail?.text ?? '',
  );
  if (!match?.[1]) throw new Error(`no confirm link for ${email}`);
  return match[1];
}
