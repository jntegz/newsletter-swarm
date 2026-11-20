// The vault as callers reach it: through a service binding pinned to one named entrypoint (a
// caller Worker, tests/fixtures/capture-caller.js, bound to CaptureVault as capture's wrangler
// config binds it), over real RPC. A caller can't reach another entrypoint's methods, the vault
// answers no fetch, and a vault without its keys refuses everything rather than run without them.
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { encrypt, memberToken } from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { createFakeVault, fakeVaultEnv, vaultClient } from '@swarm/vault';
import { opsFor, contextFromEnv } from '@swarm/vault/core';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import {
  addField,
  addMember,
  addOperator,
  legacyLinks,
  memberLinkV1,
  seedChannel,
  session,
  sql,
  storeValue,
} from './helpers';

interface Entrypoints {
  ApiVault: { ping(): Promise<unknown>; fetch(request: Request): Promise<Response> };
  CaptureVault: { ping(): Promise<unknown> };
  SiteVault: { ping(): Promise<unknown> };
  JobsVault: { ping(): Promise<unknown> };
  default: { fetch(request: Request): Promise<Response> };
}
const self = exports as unknown as Entrypoints;

async function viaCapture(method: string, ...args: unknown[]) {
  const response = await env.CAPTURE_CALLER.fetch('https://caller.test/', {
    method: 'POST',
    body: JSON.stringify({ method, args }),
  });
  return (await response.json()) as { ok: boolean; value?: unknown; error?: string };
}

describe('entrypoints', () => {
  it('answers ping on each entrypoint, naming its caller', async () => {
    expect(await self.ApiVault.ping()).toEqual({ ok: true, entrypoint: 'api' });
    expect(await self.CaptureVault.ping()).toEqual({ ok: true, entrypoint: 'capture' });
    expect(await self.SiteVault.ping()).toEqual({ ok: true, entrypoint: 'site' });
    expect(await self.JobsVault.ping()).toEqual({ ok: true, entrypoint: 'jobs' });
  });

  it('has no route: every fetch is 404', async () => {
    expect((await self.default.fetch(new Request('https://vault.test/healthz'))).status).toBe(404);
    expect((await self.ApiVault.fetch(new Request('https://vault.test/'))).status).toBe(404);
  });

  it('lets a caller bound to CaptureVault call its own methods over RPC', async () => {
    expect(await viaCapture('ping')).toEqual({
      ok: true,
      value: { ok: true, entrypoint: 'capture' },
    });
    const { channelId } = await seedChannel();
    const memberId = await addMember(channelId);
    const opened = await viaCapture('openMemberCenter', { token: await memberLinkV1(memberId) });
    expect(opened).toMatchObject({
      ok: true,
      value: { ok: true, value: { memberId, channelId, emailed: false, fields: {} } },
    });
    // Results cross as plain data, and a refusal is a result, not an exception.
    expect(await viaCapture('openMemberCenter', { token: 'forged' })).toEqual({
      ok: true,
      value: { ok: false, reason: 'refused' },
    });
  });

  it('refuses every other entrypoint’s methods to that caller', async () => {
    for (const method of [
      'openDsrAddress',
      'buildDsrExport',
      'sealMemberFields',
      'openMemberFields',
      'verifyTotp',
      'signWebhookDelivery',
      'openJoinToken',
      'mintGoodsLink',
    ]) {
      const result = await viaCapture(method, { kind: 'dsr-request', requestId: 'pr_x' });
      expect(result.ok, method).toBe(false);
      expect(result.error, method).toMatch(/does not implement/);
    }
  });

  it('runs the cron: a re-seal share and pruning of its own records', async () => {
    const old = Date.now() - 100 * 86_400_000;
    await sql(
      `INSERT INTO vault_audit (created_at, caller, op, principal_kind, decision) VALUES (?1, 'api', 'x', 'none', 'refused')`,
      old,
    );
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '*/5 * * * *' }), env as never, ctx);
    await waitOnExecutionContext(ctx);
    const { results } = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM vault_audit WHERE created_at = ?1',
    )
      .bind(old)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(0);
  });
});

describe('results keyed by id or address, over real RPC', () => {
  type Call = (...args: unknown[]) => Promise<{ ok: boolean; value?: Record<string, unknown> }>;
  const api = self.ApiVault as unknown as Record<string, Call>;
  const jobs = self.JobsVault as unknown as Record<string, Call>;

  it('cross the binding: markers in bulk, opened and sealed fields, minted links', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const fieldId = await addField(channelId, 'tax_id');
    const memberId = await addMember(channelId);
    await storeValue(
      memberId,
      fieldId,
      await encrypt(parseKeyring(env.FIELD_KEYS), JSON.stringify('DE-123')),
    );
    const { sessionToken } = await addOperator(workspaceId, 'owner');

    const markers = await jobs.addressMarkersBulk!({ workspaceId, emails: ['a@example.test'] });
    expect(markers.ok).toBe(true);
    expect(Object.keys(markers.value!)).toEqual(['a@example.test']);

    const opened = await api.openMemberFields!(session(sessionToken), {
      channelId,
      memberIds: [memberId],
    });
    expect(opened).toEqual({ ok: true, value: { [memberId]: { tax_id: 'DE-123' } } });

    const sealed = await api.sealMemberFields!(session(sessionToken), {
      channelId,
      memberId,
      values: { tax_id: 'DE-456' },
    });
    expect(sealed.ok && Object.keys(sealed.value!)).toEqual(['tax_id']);

    const links = await api.mintMemberLinks!(session(sessionToken), {
      channelId,
      memberIds: [memberId],
    });
    expect(links.ok && Object.keys(links.value!)).toEqual([memberId]);
  });
});

describe('the client callers wrap their binding in', () => {
  it('reaches the vault over a real binding, and pings it', async () => {
    const client = vaultClient('capture', self.CaptureVault as never);
    expect(await client.ping()).toBe(true);
    expect(await client.openJourneyToken({ token: 'nonsense' })).toMatchObject({
      ok: false,
      reason: 'refused',
    });
  });
});

describe('failing closed', () => {
  it('refuses every call when a key or var is missing, never runs without it', async () => {
    const broken: Record<string, unknown> = { ...env };
    delete broken.FIELD_KEYS;
    const jobs = opsFor('jobs', () => contextFromEnv(broken, 'jobs'));
    expect(await jobs.openDsrAddress({ kind: 'dsr-request', requestId: 'pr_x' })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    const api = opsFor('api', () =>
      contextFromEnv({ ...env, LINK_SIGNING_MODE: 'v2', LINK_LEGACY_CUTOFF: undefined }, 'api'),
    );
    expect(await api.verifyTotp({ sessionToken: 'x', code: '123456' })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('turns an internal failure into unavailable, and logs it', async () => {
    const failing = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error('D1 is down');
        },
      },
    };
    const site = opsFor('site', () => contextFromEnv(failing, 'site'));
    expect(
      await site.mintGoodsLink({
        kind: 'order',
        channelId: 'ch_x',
        orderId: `go_${'a'.repeat(32)}`,
      }),
    ).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('refuses development placeholders when deployed', async () => {
    const deployed = {
      ...env,
      ENVIRONMENT: 'production',
      FIELD_KEYS: 'k1:development-only-field-key-replace-before-using-this-file',
    };
    const capture = opsFor('capture', () => contextFromEnv(deployed, 'capture'));
    expect(await capture.openJourneyToken({ token: 'x' })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });
});

describe('the in-process fake callers test against', () => {
  it('runs the same operations on its own test keys, and copies results as RPC would', async () => {
    const fakeEnv = await fakeVaultEnv(env.DB);
    const capture = createFakeVault('capture', fakeEnv);
    expect(await capture.ping()).toEqual({ ok: true, entrypoint: 'capture' });
    const { channelId } = await seedChannel();
    const memberId = await addMember(channelId);
    // Its MEMBER_KEYS is the one the callers' test configs use, so their v1 links open.
    const token = await memberToken(legacyLinks(fakeEnv.MEMBER_KEYS as string), {
      memberId,
      channelId,
    });
    expect(await capture.openMemberCenter({ token })).toMatchObject({
      ok: true,
      value: { memberId },
    });
  });
});
