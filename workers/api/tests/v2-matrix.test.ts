// The generated scope matrix: every /v2 operation in the public OpenAPI document, checked for
// credentials, scopes, Channel restriction, revoked/expired/IP-blocked keys and rate limits.
// A new /v2 route is covered as soon as it is in the document.
import { env } from 'cloudflare:test';
import { API_SCOPES, scopeAllows, type ApiScope } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { v2OpenApiDocument } from '../src/v2/docs';
import { SCOPE_EXTENSION } from '../src/v2/route';
import { createChannel, signIn, type Session } from './helpers';
import { createKey, setPlan, v2 } from './v2-helpers';

interface Operation {
  method: string;
  path: string;
  scope: ApiScope;
  params: { name: string; in: string; schema?: { pattern?: string } }[];
  hasBody: boolean;
}

const doc = v2OpenApiDocument();
const OPERATIONS: Operation[] = Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
  Object.entries(item as Record<string, Record<string, unknown>>)
    .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
    .map(([method, op]) => ({
      method: method.toUpperCase(),
      path,
      scope: op[SCOPE_EXTENSION] as ApiScope,
      params: (op.parameters as Operation['params'] | undefined) ?? [],
      hasBody: !!op.requestBody,
    })),
);

let owner: Session;
let channelA: string;
let channelB: string;
const byScope = new Map<ApiScope, string>();
let allScopes: string;
let otherChannel: string;

/** A value matching an id pattern like ^mb_[0-9a-f]{32}$ (a row that does not exist). */
function sampleFor(param: Operation['params'][number]): string {
  if (param.name === 'channelId') return channelA;
  const prefix = /^\^([a-z]+)_/.exec(param.schema?.pattern ?? '')?.[1];
  return prefix ? `${prefix}_${'0'.repeat(32)}` : 'sample';
}

const urlOf = (op: Operation) =>
  op.path.replace(/\{([^}]+)\}/g, (_, name: string) =>
    encodeURIComponent(sampleFor(op.params.find((p) => p.name === name) ?? { name, in: 'path' })),
  );

const call = (op: Operation, token: string | null, ip?: string) =>
  v2(op.method, urlOf(op), token, {
    ...(op.hasBody ? { body: {} } : {}),
    ...(ip ? { ip } : {}),
  });

beforeAll(async () => {
  owner = await signIn();
  await setPlan(owner.workspaceId, 'enterprise');
  channelA = (await createChannel(owner)).id;
  channelB = (await createChannel(owner)).id;
  for (const scope of API_SCOPES) {
    byScope.set(scope, (await createKey(owner, { scopes: [scope], name: scope })).secret);
  }
  allScopes = (await createKey(owner, { scopes: [...API_SCOPES] })).secret;
  otherChannel = (await createKey(owner, { scopes: [...API_SCOPES], channelIds: [channelB] }))
    .secret;
});

describe('the /v2 document', () => {
  it('lists every operation with exactly one known scope and an operationId', () => {
    expect(OPERATIONS.length).toBeGreaterThan(30);
    for (const op of OPERATIONS) {
      expect(API_SCOPES, `${op.method} ${op.path}`).toContain(op.scope);
    }
    const ids = Object.values(doc.paths ?? {}).flatMap((item) =>
      Object.values(item as Record<string, { operationId?: string }>).map((o) => o.operationId),
    );
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe.each(OPERATIONS.map((op) => [`${op.method} ${op.path}`, op] as const))('%s', (_, op) => {
  it('needs a credential', async () => {
    const res = await call(op, null);
    expect(res.status).toBe(401);
    expect(res.headers.get('ratelimit-limit')).toBeNull();
  });

  it(`answers 403 insufficient_scope without ${op.scope}`, async () => {
    const others = API_SCOPES.filter((s) => !scopeAllows([s], op.scope));
    const without = (await createKey(owner, { scopes: others, name: 'without' })).secret;
    const res = await call(op, without);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'insufficient_scope',
    );
  });

  it(`passes the scope check with ${op.scope} alone, with rate-limit headers`, async () => {
    const res = await call(op, byScope.get(op.scope) as string);
    expect([401, 403], await res.clone().text()).not.toContain(res.status);
    expect(Number(res.headers.get('ratelimit-limit'))).toBeGreaterThan(0);
    expect(res.headers.get('ratelimit-remaining')).toMatch(/^\d+$/);
    expect(res.headers.get('ratelimit-reset')).toMatch(/^\d+$/);
  });

  if (op.path.includes('{channelId}')) {
    it('answers 404 to a key limited to another Channel', async () => {
      const res = await call(op, otherChannel);
      expect(res.status).toBe(404);
    });
  }

  it('refuses revoked, expired and IP-blocked keys with 401', async () => {
    const revoked = await createKey(owner, { scopes: [op.scope], name: 'revoked' });
    await env.DB.prepare('UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2')
      .bind(Date.now(), revoked.key.id)
      .run();
    expect((await call(op, revoked.secret)).status).toBe(401);

    const expired = await createKey(owner, { scopes: [op.scope], name: 'expired' });
    await env.DB.prepare('UPDATE api_keys SET expires_at = ?1 WHERE id = ?2')
      .bind(Date.now() - 1000, expired.key.id)
      .run();
    expect((await call(op, expired.secret)).status).toBe(401);

    const fenced = await createKey(owner, {
      scopes: [op.scope],
      name: 'fenced',
      ipAllowlist: ['203.0.113.0/24'],
    });
    expect((await call(op, fenced.secret, '198.51.100.1')).status).toBe(401);
    expect([401, 403]).not.toContain((await call(op, fenced.secret, '203.0.113.9')).status);
  });

  it('answers 429 with Retry-After once the bucket is empty', async () => {
    // A cap of 2 a minute on enterprise (burst 50%) is a bucket of 3.
    const capped = (await createKey(owner, { scopes: [op.scope], name: 'capped', rateCap: 2 }))
      .secret;
    const statuses = [];
    let refused: Response | undefined;
    for (let i = 0; i < 4; i++) {
      const res = await call(op, capped);
      statuses.push(res.status);
      if (res.status === 429) refused = res;
    }
    expect(statuses[3]).toBe(429);
    expect(refused?.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
    expect(refused?.headers.get('ratelimit-remaining')).toBe('0');
    expect(refused?.headers.get('ratelimit-limit')).toBe('3');
    expect(((await refused?.json()) as { error: { code: string } }).error.code).toBe(
      'rate_limited',
    );
  });
});

describe('full access', () => {
  it('a key with every scope reaches every operation', async () => {
    for (const op of OPERATIONS) {
      const res = await call(op, allScopes);
      expect([401, 403], `${op.method} ${op.path}`).not.toContain(res.status);
    }
  });
});
