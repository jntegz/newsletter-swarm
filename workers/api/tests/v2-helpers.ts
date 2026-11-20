import { SELF, env } from 'cloudflare:test';
import type { ApiKey, ApiScope, CreateApiKey, CreatedApiKey } from '@swarm/domain';
import { expect } from 'vitest';
import { data } from './audience-helpers';
import { call, freshFactor, type Session } from './helpers';

/** Creates a key through the dashboard route and returns it with its secret. */
export async function createKey(
  s: Session,
  body: Partial<CreateApiKey> & { scopes: ApiScope[] },
): Promise<{ key: ApiKey; secret: string }> {
  // Creating a key needs a fresh factor of the operator's own.
  await freshFactor(s);
  const created = await data<CreatedApiKey>(
    await call('POST', `/api/v1/workspaces/${s.workspaceId}/api-keys`, {
      cookie: s.cookie,
      body: { name: 'Test key', ...body },
    }),
    201,
  );
  return { key: created.key, secret: created.secret };
}

interface V2Options {
  body?: unknown;
  headers?: Record<string, string>;
  ip?: string;
}

/** A /v2 request with a Bearer credential (or none, when `token` is null). */
export function v2(
  method: string,
  path: string,
  token: string | null,
  options: V2Options = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (options.ip) headers['cf-connecting-ip'] = options.ip;
  let body: string | null = null;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  return SELF.fetch(`http://localhost${path}`, { method, headers, body, redirect: 'manual' });
}

export async function v2Data<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return ((await res.json()) as { data: T }).data;
}

export async function setPlan(workspaceId: string, plan: string): Promise<void> {
  await env.DB.prepare('UPDATE workspaces SET plan = ?1 WHERE id = ?2')
    .bind(plan, workspaceId)
    .run();
}
