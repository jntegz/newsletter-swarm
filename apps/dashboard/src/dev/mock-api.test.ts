// The dev mock API (?mock=1) answers the settings rounds 1 and 2 added in the shapes the real API
// has: each answer is read with the API's own schema, so a page built on it renders with mocks.
import {
  EngagementRetentionSchema,
  ExportDestinationSchema,
  FormerTeammateSchema,
  InstanceAuditSchema,
  InstanceEmailChecksSchema,
  PausedFeedsSchema,
  SecurityOverviewSchema,
} from '@swarm/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const hex = (n: number) => String(n).padStart(32, '0');
const WS = `ws_${hex(1)}`;
const CH = `ch_${hex(2)}`;

beforeAll(async () => {
  const store = new Map<string, string>();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('location', { search: '?mock=1&debounce=connected', pathname: '/' });
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  const { installMockApi } = await import('./mockApi');
  installMockApi();
});
afterAll(() => vi.unstubAllGlobals());

/** A schema of @swarm/domain (zod), without the dashboard depending on zod itself. */
interface Schema {
  safeParse(value: unknown): { error?: { issues: unknown[] } };
  parse(value: unknown): unknown;
}

async function call<S extends Schema>(
  schema: S,
  method: string,
  path: string,
  body?: unknown,
): Promise<ReturnType<S['parse']>> {
  const res = await fetch(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(res.status, `${method} ${path}`).toBeLessThan(300);
  const { data } = (await res.json()) as { data: unknown };
  expect(schema.safeParse(data).error?.issues ?? [], `${method} ${path}`).toEqual([]);
  return schema.parse(data) as ReturnType<S['parse']>;
}

describe('the dev mock API', () => {
  it('has every retention setting, and keeps a change', async () => {
    const path = `/api/v1/workspaces/${WS}/retention`;
    const before = await call(EngagementRetentionSchema, 'GET', path);
    const saved = await call(EngagementRetentionSchema, 'PUT', path, { leftMemberMonths: 36 });
    expect(saved).toEqual({ ...before, leftMemberMonths: 36 });
    expect(await call(EngagementRetentionSchema, 'GET', path)).toEqual(saved);
  });

  it('lists former teammates and redacts one', async () => {
    const path = `/api/v1/workspaces/${WS}/former-teammates`;
    const list = await call(FormerTeammateSchema.array(), 'GET', path);
    const person = list.find((p) => !p.redacted)!;
    expect(person).toBeDefined();
    const done = await call(FormerTeammateSchema, 'POST', `${path}/${person.id}/redact`, {});
    expect(done).toMatchObject({ id: person.id, redacted: true, name: null });
    expect(done.email).toMatch(/^former-teammate-[0-9a-f]{12}@redacted\.invalid$/);
    const after = await call(FormerTeammateSchema.array(), 'GET', path);
    expect(after.find((p) => p.id === person.id)).toEqual(done);
  });

  it('shows account activity and pauses every feed', async () => {
    const overview = await call(SecurityOverviewSchema, 'GET', '/api/v1/security');
    expect(overview.activity.length).toBeGreaterThan(0);
    const paused = await call(
      PausedFeedsSchema,
      'POST',
      `/api/v1/workspaces/${WS}/security/pause-feeds`,
      { revokeApiKeys: true, revokeApps: false },
    );
    expect(paused.paused.length).toBeGreaterThan(0);
    expect(paused.apiKeysRevoked).toBeGreaterThan(0);
    expect(paused.appsRevoked).toBe(0);
  });

  it('has export destinations with a scope, and keeps a narrowed one', async () => {
    const list = await call(
      ExportDestinationSchema.array(),
      'GET',
      `/api/v1/channels/${CH}/export-destinations`,
    );
    expect(list.some((d) => d.legacyScope)).toBe(true);
    const legacy = list.find((d) => d.legacyScope)!;
    const scope = { members: 'active', fields: [] };
    const saved = await call(
      ExportDestinationSchema,
      'PATCH',
      `/api/v1/export-destinations/${legacy.id}`,
      { scope },
    );
    expect(saved).toMatchObject({ id: legacy.id, scope, legacyScope: false });
  });

  it('gives every workspace its DeBounce credits, and keeps a workspace’s own numbers', async () => {
    const instance = await call(InstanceEmailChecksSchema, 'GET', '/api/v1/instance/email-checks');
    const other = instance.workspaces.find((w) => w.id !== WS)!;
    const saved = await call(
      InstanceEmailChecksSchema,
      'PUT',
      `/api/v1/instance/email-checks/workspaces/${other.id}`,
      { allowed: true, dailyChecks: 50, listChecks: null },
    );
    expect(saved.workspaces.find((w) => w.id === other.id)).toMatchObject({
      allowed: true,
      dailyChecks: 50,
      customDailyChecks: true,
      listChecks: instance.defaults.listChecks,
      customListChecks: false,
    });
  });

  it('has an instance audit log, a page at a time', async () => {
    const first = await call(InstanceAuditSchema, 'GET', '/api/v1/instance/audit?limit=25');
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.verification.ok).toBe(true);
  });
});
