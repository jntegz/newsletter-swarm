// Copilot (Phase 8): the streaming endpoint with the dev adapter (COPILOT_ADAPTER=dev, no
// network), flags, roles and tenancy, plan limits, the workspace's own key (checked, sealed,
// shown as last four only) and the metadata-only request log.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import {
  COPILOT_PLAN_LIMITS,
  newId,
  type CopilotDoneEvent,
  type CopilotErrorEvent,
  type CopilotRequestLog,
  type CopilotSettings,
  type Dispatch,
  type SeatRole,
} from '@swarm/domain';
import type { FlagKey } from '@swarm/flags';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDownVault, useVaultForTests, vaultClient } from '@swarm/vault';
import { createApp } from '../src/app';
import { ORIGIN, call, createChannel, json, seatAs, signIn, type Session } from './helpers';
import { installFakeVault, useVaultProviderFetch } from './vault-fetch';

const TEXT = 'Spring is here. The garden wakes up and the bees return to the old apple tree.';
const KEY = 'sk-ant-api03-workspace-secret-value-WXYZ';

async function data<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await json<{ data: T }>(res)).data;
}

async function enable(workspaceId: string, key: FlagKey, channelIds: string[] = []) {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
     VALUES (?1, ?2, 'workspace', ?3, 1, 0)`,
  )
    .bind(newId('featureFlag'), key, workspaceId)
    .run();
  await env.CACHE.delete(`flags:v1:${workspaceId}:-`);
  for (const id of channelIds) await env.CACHE.delete(`flags:v1:${workspaceId}:${id}`);
}

async function newDispatch(s: Session, channelId: string) {
  return data<Dispatch>(
    await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
      cookie: s.cookie,
      body: { subject: 'Issue 1', content: { type: 'doc', content: [] } },
    }),
    201,
  );
}

interface Parsed {
  deltas: string[];
  done: CopilotDoneEvent | null;
  error: CopilotErrorEvent | null;
}

async function events(res: Response): Promise<Parsed> {
  expect(res.status, res.status === 200 ? '' : await res.clone().text()).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const parsed: Parsed = { deltas: [], done: null, error: null };
  for (const block of (await res.text()).split('\n\n')) {
    const name = /^event: (\w+)$/m.exec(block)?.[1];
    const payload = /^data: (.*)$/m.exec(block)?.[1];
    if (!name || !payload) continue;
    const value = JSON.parse(payload) as unknown;
    if (name === 'delta') parsed.deltas.push((value as { text: string }).text);
    if (name === 'done') parsed.done = value as CopilotDoneEvent;
    if (name === 'error') parsed.error = value as CopilotErrorEvent;
  }
  return parsed;
}

const ask = (s: Session, dispatchId: string, body: Record<string, unknown>) =>
  call('POST', `/api/v1/dispatches/${dispatchId}/copilot`, { cookie: s.cookie, body });

async function addRequests(
  workspaceId: string,
  operatorId: string,
  count: number,
  keySource: 'platform' | 'workspace',
  at: number,
) {
  await env.DB.batch(
    Array.from({ length: count }, () =>
      env.DB.prepare(
        `INSERT INTO copilot_requests (id, workspace_id, operator_id, feature, key_source, provider,
           model, status, output_tokens, created_at)
         VALUES (?1, ?2, ?3, 'teaser', ?4, 'dev', 'claude-opus-5-5', 'succeeded', 10, ?5)`,
      ).bind(newId('copilotRequest'), workspaceId, operatorId, keySource, at),
    ),
  );
}

describe('copilot', () => {
  let owner: Session;
  let channelId: string;
  let dispatch: Dispatch;

  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
    dispatch = await newDispatch(owner, channelId);
  });

  it('is off until the flag is on', async () => {
    const res = await ask(owner, dispatch.id, { feature: 'teaser', text: TEXT });
    expect(res.status).toBe(404);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('feature_disabled');
    const settings = await call('GET', `/api/v1/workspaces/${owner.workspaceId}/copilot`, {
      cookie: owner.cookie,
    });
    expect(settings.status).toBe(404);
  });

  describe('with the flag on', () => {
    beforeAll(async () => {
      await enable(owner.workspaceId, 'copilot', [channelId]);
    });

    it('streams subject lines and logs metadata only', async () => {
      const result = await events(
        await ask(owner, dispatch.id, { feature: 'subject_lines', text: TEXT, subject: 'Hi' }),
      );
      expect(result.error).toBeNull();
      expect(result.deltas.length).toBeGreaterThan(1);
      expect(result.done?.suggestions).toHaveLength(5);
      expect(result.done?.suggestions[0]).toBe('Subject idea 1: Spring is here. The garden wakes');
      expect(result.done?.text).toBe(result.deltas.join('').trim());
      expect(result.done?.remaining).toBe(COPILOT_PLAN_LIMITS.free.requestsPerMonth - 1);

      const row = await env.DB.prepare('SELECT * FROM copilot_requests WHERE id = ?1')
        .bind(result.done?.requestId)
        .first<Record<string, unknown>>();
      expect(row).toMatchObject({
        workspace_id: owner.workspaceId,
        channel_id: channelId,
        dispatch_id: dispatch.id,
        operator_id: owner.me.operator.id,
        feature: 'subject_lines',
        key_source: 'platform',
        provider: 'dev',
        model: 'claude-opus-5-5',
        status: 'succeeded',
      });
      expect(row?.input_tokens).toBeGreaterThan(0);
      expect(row?.output_tokens).toBeGreaterThan(0);
      expect(row?.latency_ms).toBeGreaterThanOrEqual(0);
      // Neither the text sent nor the result is stored anywhere in the row.
      const stored = JSON.stringify(row);
      expect(stored).not.toContain('garden');
      expect(stored).not.toContain('Subject idea');
    });

    it('rewrites, fixes, translates and writes teasers', async () => {
      const rewrite = await events(
        await ask(owner, dispatch.id, { feature: 'rewrite', style: 'shorter', text: TEXT }),
      );
      expect(rewrite.done?.text).toBe('Spring is here. The garden wakes up and');
      expect(rewrite.done?.suggestions).toEqual([]);
      const translated = await events(
        await ask(owner, dispatch.id, { feature: 'translate', language: 'German', text: 'hello' }),
      );
      expect(translated.done?.text).toBe('[German] hello');
      const fixed = await events(
        await ask(owner, dispatch.id, { feature: 'fix_grammar', text: 'hello there' }),
      );
      expect(fixed.done?.text).toBe('Hello there');
      const teaser = await events(await ask(owner, dispatch.id, { feature: 'teaser', text: TEXT }));
      expect(teaser.done?.text).toBe('Teaser: Spring is here. The garden wakes.');
    });

    it('drafts Share Kit social posts with the Dispatch’s web link, logged like the rest', async () => {
      // Another editor, so the per-minute limit of the requests above doesn't apply.
      const editor = await seatAs(owner.workspaceId, 'editor');
      const result = await events(
        await ask(editor, dispatch.id, { feature: 'social_posts', text: TEXT, subject: 'Issue 1' }),
      );
      expect(result.error).toBeNull();
      const social = result.done?.social;
      expect(social).toBeTruthy();
      expect(social!.link).toMatch(/^https?:\/\/.+\/p\/issue-1$/);
      expect(social!.short).toBe(`Short: Spring is here. The garden wakes ${social!.link}`);
      expect(social!.long).toContain(`Read it here: ${social!.link}`);
      expect(social!.thread).toEqual([
        '1/ Spring is here. The garden wakes',
        `2/ More in the post: ${social!.link}`,
      ]);
      expect(JSON.stringify(social)).not.toContain('[LINK]');
      expect(result.done?.suggestions).toEqual([]);
      const row = await env.DB.prepare(
        'SELECT feature, status, input_tokens FROM copilot_requests WHERE id = ?1',
      )
        .bind(result.done?.requestId)
        .first<Record<string, unknown>>();
      expect(row).toMatchObject({ feature: 'social_posts', status: 'succeeded' });
      // Asking for posts changes nothing: the Dispatch keeps its state and has no slug yet.
      const slugs = await env.DB.prepare(
        'SELECT count(*) AS n FROM dispatch_slugs WHERE dispatch_id = ?1',
      )
        .bind(dispatch.id)
        .first<{ n: number }>();
      expect(slugs?.n).toBe(0);
    });

    it('validates the request', async () => {
      const res = await ask(owner, dispatch.id, { feature: 'rewrite', text: TEXT });
      expect(res.status).toBe(400);
      const tooLong = await ask(owner, dispatch.id, {
        feature: 'teaser',
        text: 'x'.repeat(24_001),
      });
      expect(tooLong.status).toBe(400);
    });

    it('needs the editor role and hides other workspaces’ Dispatches', async () => {
      const matrix: [SeatRole, number][] = [
        ['viewer', 403],
        ['editor', 200],
        ['admin', 200],
      ];
      for (const [role, status] of matrix) {
        const seat = await seatAs(owner.workspaceId, role);
        const res = await ask(seat, dispatch.id, { feature: 'fix_grammar', text: 'hi there' });
        expect(res.status, role).toBe(status);
        await res.body?.cancel();
      }
      const stranger = await signIn();
      await enable(stranger.workspaceId, 'copilot');
      const res = await ask(stranger, dispatch.id, { feature: 'fix_grammar', text: 'hi there' });
      expect(res.status).toBe(404);
      const missing = await ask(owner, newId('dispatch'), { feature: 'teaser', text: TEXT });
      expect(missing.status).toBe(404);
    });

    it('enforces the per-minute and monthly limits on the platform key', async () => {
      const editor = await seatAs(owner.workspaceId, 'editor');
      const perMinute = COPILOT_PLAN_LIMITS.free.requestsPerMinute;
      await addRequests(
        owner.workspaceId,
        editor.me.operator.id,
        perMinute,
        'platform',
        Date.now(),
      );
      const minute = await ask(editor, dispatch.id, { feature: 'teaser', text: TEXT });
      expect(minute.status).toBe(429);
      expect(
        (await json<{ error: { details: { path: string; message: string }[] } }>(minute)).error
          .details,
      ).toEqual([{ path: 'quota', message: 'minute' }]);

      const solo = await signIn();
      const soloChannel = (await createChannel(solo)).id;
      const soloDispatch = await newDispatch(solo, soloChannel);
      await enable(solo.workspaceId, 'copilot', [soloChannel]);
      const monthStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
      await addRequests(
        solo.workspaceId,
        solo.me.operator.id,
        COPILOT_PLAN_LIMITS.free.requestsPerMonth,
        'platform',
        monthStart,
      );
      const month = await ask(solo, soloDispatch.id, { feature: 'teaser', text: TEXT });
      expect(month.status).toBe(429);
      expect(
        (await json<{ error: { details: { path: string; message: string }[] } }>(month)).error
          .details,
      ).toEqual([{ path: 'quota', message: 'month' }]);

      // A paid plan has a larger allowance.
      await env.DB.prepare("UPDATE workspaces SET plan = 'pro' WHERE id = ?1")
        .bind(solo.workspaceId)
        .run();
      const pro = await events(await ask(solo, soloDispatch.id, { feature: 'teaser', text: TEXT }));
      expect(pro.done?.remaining).toBe(
        COPILOT_PLAN_LIMITS.pro.requestsPerMonth - COPILOT_PLAN_LIMITS.free.requestsPerMonth - 1,
      );
    });

    it('admits no more than the limits when many requests arrive at once', async () => {
      const burst = async (s: Session, dispatchId: string, n = 8) => {
        const results = await Promise.all(
          Array.from({ length: n }, () => ask(s, dispatchId, { feature: 'teaser', text: TEXT })),
        );
        await Promise.all(results.map((res) => res.text()));
        const rows = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM copilot_requests WHERE workspace_id = ?1',
        )
          .bind(s.workspaceId)
          .first<{ n: number }>();
        return {
          admitted: results.filter((res) => res.status === 200).length,
          refused: results.filter((res) => res.status === 429).length,
          rows: rows?.n,
        };
      };
      const { requestsPerMinute, requestsPerMonth } = COPILOT_PLAN_LIMITS.free;

      const fresh = await signIn();
      const freshChannel = (await createChannel(fresh)).id;
      const freshDispatch = await newDispatch(fresh, freshChannel);
      await enable(fresh.workspaceId, 'copilot', [freshChannel]);
      expect(await burst(fresh, freshDispatch.id)).toEqual({
        admitted: requestsPerMinute,
        refused: 8 - requestsPerMinute,
        rows: requestsPerMinute,
      });

      // One slot left this month, outside the minute window.
      const last = await signIn();
      const lastChannel = (await createChannel(last)).id;
      const lastDispatch = await newDispatch(last, lastChannel);
      await enable(last.workspaceId, 'copilot', [lastChannel]);
      const monthStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
      await addRequests(
        last.workspaceId,
        last.me.operator.id,
        requestsPerMonth - 1,
        'platform',
        monthStart,
      );
      expect(await burst(last, lastDispatch.id)).toEqual({
        admitted: 1,
        refused: 7,
        rows: requestsPerMonth,
      });
    });

    it('settings and the request log are for admins and owners', async () => {
      const editor = await seatAs(owner.workspaceId, 'editor');
      for (const path of ['', '/requests']) {
        const res = await call('GET', `/api/v1/workspaces/${owner.workspaceId}/copilot${path}`, {
          cookie: editor.cookie,
        });
        expect(res.status).toBe(403);
      }
      const stranger = await signIn();
      const hidden = await call('GET', `/api/v1/workspaces/${owner.workspaceId}/copilot`, {
        cookie: stranger.cookie,
      });
      expect(hidden.status).toBe(404);

      const settings = await data<CopilotSettings>(
        await call('GET', `/api/v1/workspaces/${owner.workspaceId}/copilot`, {
          cookie: owner.cookie,
        }),
      );
      // The platform adapter in tests is the dev fake (Workers AI in staging and production).
      expect(settings).toMatchObject({
        provider: 'dev',
        model: 'claude-opus-5-5',
        actionsAvailable: false,
        byokAvailable: false,
        platformKey: true,
        key: null,
        keySource: 'platform',
      });
      expect(settings.usage.used).toBeGreaterThan(0);

      const log = await data<CopilotRequestLog[]>(
        await call('GET', `/api/v1/workspaces/${owner.workspaceId}/copilot/requests?limit=5`, {
          cookie: owner.cookie,
        }),
      );
      expect(log.length).toBeGreaterThan(0);
      expect(log.length).toBeLessThanOrEqual(5);
      expect(Object.keys(log[0]!).sort()).toEqual(
        [
          'channelId',
          'createdAt',
          'dispatchId',
          'errorCode',
          'feature',
          'id',
          'inputTokens',
          'keySource',
          'latencyMs',
          'model',
          'operator',
          'outputTokens',
          'status',
        ].sort(),
      );
    });
  });

  describe('bring your own key', () => {
    let ws: Session;
    let wsChannel: string;
    let wsDispatch: Dispatch;
    const keyPath = () => `/api/v1/workspaces/${ws.workspaceId}/copilot/key`;

    beforeAll(async () => {
      ws = await signIn();
      wsChannel = (await createChannel(ws)).id;
      wsDispatch = await newDispatch(ws, wsChannel);
      await enable(ws.workspaceId, 'copilot', [wsChannel]);
    });

    it('needs the copilot_byok flag', async () => {
      const res = await call('PUT', keyPath(), {
        cookie: ws.cookie,
        body: { provider: 'anthropic', apiKey: KEY },
      });
      expect(res.status).toBe(404);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('feature_disabled');
    });

    it('checks, seals and never returns the key', async () => {
      await enable(ws.workspaceId, 'copilot_byok', [wsChannel]);
      const editor = await seatAs(ws.workspaceId, 'editor');
      const forbidden = await call('PUT', keyPath(), {
        cookie: editor.cookie,
        body: { provider: 'anthropic', apiKey: KEY },
      });
      expect(forbidden.status).toBe(403);

      const rejected = await call('PUT', keyPath(), {
        cookie: ws.cookie,
        body: { provider: 'anthropic', apiKey: 'sk-ant-invalid-key-000000000' },
      });
      expect(rejected.status).toBe(400);
      expect(
        (await json<{ error: { details: { path: string }[] } }>(rejected)).error.details[0]?.path,
      ).toBe('apiKey');

      const res = await call('PUT', keyPath(), {
        cookie: ws.cookie,
        body: { provider: 'anthropic', apiKey: KEY },
      });
      const raw = await res.clone().text();
      const settings = await data<CopilotSettings>(res);
      expect(raw).not.toContain('secret-value');
      expect(settings.key).toMatchObject({ provider: 'anthropic', last4: 'WXYZ' });
      expect(settings.keySource).toBe('workspace');

      const stored = await env.DB.prepare('SELECT * FROM copilot_keys WHERE workspace_id = ?1')
        .bind(ws.workspaceId)
        .first<Record<string, unknown>>();
      expect(JSON.stringify(stored)).not.toContain('secret-value');
      expect(stored?.id).toMatch(/^mk_[0-9a-f]{32}$/);
      const audit = await env.DB.prepare(
        "SELECT metadata_json FROM audit_events WHERE workspace_id = ?1 AND action = 'copilot_key.saved'",
      )
        .bind(ws.workspaceId)
        .first<{ metadata_json: string }>();
      expect(JSON.parse(audit?.metadata_json ?? '{}')).toEqual({
        provider: 'anthropic',
        last4: 'WXYZ',
      });

      const fetched = await call('GET', `/api/v1/workspaces/${ws.workspaceId}/copilot`, {
        cookie: ws.cookie,
      });
      expect(await fetched.text()).not.toContain('secret-value');
    });

    it('uses the workspace key without the monthly allowance', async () => {
      await addRequests(
        ws.workspaceId,
        ws.me.operator.id,
        COPILOT_PLAN_LIMITS.free.requestsPerMonth,
        'platform',
        Date.now() - 120_000,
      );
      const result = await events(await ask(ws, wsDispatch.id, { feature: 'teaser', text: TEXT }));
      expect(result.done?.remaining).toBeNull();
      const row = await env.DB.prepare('SELECT key_source FROM copilot_requests WHERE id = ?1')
        .bind(result.done?.requestId)
        .first<{ key_source: string }>();
      expect(row?.key_source).toBe('workspace');
    });

    // The workspace key's requests with the real Anthropic adapter (COPILOT_ADAPTER=anthropic for
    // these requests only): they go out through the vault's streaming proxy, answered by a fake.
    const askAnthropic = async (body: Record<string, unknown>) => {
      const ctx = createExecutionContext();
      const res = await createApp().request(
        `/api/v1/dispatches/${wsDispatch.id}/copilot`,
        {
          method: 'POST',
          headers: { origin: ORIGIN, cookie: ws.cookie, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        { ...env, COPILOT_ADAPTER: 'anthropic' },
        ctx,
      );
      return { res, settled: () => waitOnExecutionContext(ctx) };
    };
    const sseEvent = (type: string, data: Record<string, unknown>) =>
      new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const START = sseEvent('message_start', {
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    });
    const delta = (text: string) =>
      sseEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
    const END = [
      sseEvent('content_block_stop', { index: 0 }),
      sseEvent('message_delta', {
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 7 },
      }),
      sseEvent('message_stop', {}),
    ];

    it('streams the reply through the vault as the provider sends it', async () => {
      let upstream!: ReadableStreamDefaultController<Uint8Array>;
      const sent: { url: string; key: string | null }[] = [];
      useVaultProviderFetch(async (input, init) => {
        const request = new Request(input, init);
        sent.push({ url: request.url, key: request.headers.get('x-api-key') });
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            upstream = controller;
            controller.enqueue(START);
            controller.enqueue(
              sseEvent('content_block_start', {
                index: 0,
                content_block: { type: 'text', text: '' },
              }),
            );
            controller.enqueue(delta('Bees are back. '));
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      });
      try {
        const { res, settled } = await askAnthropic({ feature: 'teaser', text: TEXT });
        expect(res.status, res.status === 200 ? '' : await res.clone().text()).toBe(200);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let seen = '';
        // The first words arrive while the provider is still writing: nothing waits for the end.
        const first = await Promise.race([
          (async () => {
            while (!seen.includes('event: delta')) {
              const chunk = await reader.read();
              if (chunk.done) break;
              seen += decoder.decode(chunk.value, { stream: true });
            }
            return seen;
          })(),
          new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 5_000)),
        ]);
        expect(first).toContain('"text":"Bees are back. "');
        expect(seen).not.toContain('event: done');
        upstream.enqueue(delta('The orchard hums.'));
        for (const event of END) upstream.enqueue(event);
        upstream.close();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          seen += decoder.decode(chunk.value, { stream: true });
        }
        await settled();
        expect(seen).toContain('event: done');
        expect(seen).toContain('Bees are back. The orchard hums.');
        // The vault attached the saved key; the api never had it.
        expect(sent).toEqual([{ url: 'https://api.anthropic.com/v1/messages', key: KEY }]);
      } finally {
        useVaultProviderFetch(null);
      }
    });

    it('reports a key the provider stops accepting inside the stream', async () => {
      useVaultProviderFetch(
        async () =>
          new Response(
            JSON.stringify({
              type: 'error',
              error: { type: 'authentication_error', message: 'invalid x-api-key' },
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
      );
      try {
        const { res, settled } = await askAnthropic({ feature: 'teaser', text: TEXT });
        const result = await events(res);
        await settled();
        expect(result.error?.code).toBe('key_rejected');
        expect(result.done).toBeNull();
        const row = await env.DB.prepare(
          `SELECT status, error_code FROM copilot_requests WHERE workspace_id = ?1
            ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
          .bind(ws.workspaceId)
          .first();
        expect(row).toEqual({ status: 'failed', error_code: 'key_rejected' });
      } finally {
        useVaultProviderFetch(null);
      }
    });

    it('streams only the Copilot calls, and only for the workspace the session reaches', async () => {
      const vault = vaultClient('api', null);
      const session = (s: Session) =>
        ({
          kind: 'operator-session',
          sessionToken: s.cookie.slice(s.cookie.indexOf('=') + 1),
        }) as const;
      const outbound: string[] = [];
      useVaultProviderFetch(async (input) => {
        outbound.push(String(input));
        return new Response('{}');
      });
      try {
        const messages = {
          method: 'POST',
          url: 'https://api.anthropic.com/v1/messages',
          body: '{}',
        } as const;
        const stranger = await signIn();
        expect(
          await vault.providerStream(
            session(stranger),
            { kind: 'copilot', workspaceId: ws.workspaceId },
            messages,
          ),
        ).toMatchObject({ ok: false });
        expect(
          await vault.checkCredential(session(stranger), {
            kind: 'copilot',
            workspaceId: ws.workspaceId,
          }),
        ).toMatchObject({ ok: false });
        // Another host, or a credential whose calls don't stream: refused before anything is sent.
        expect(
          await vault.providerStream(
            session(ws),
            { kind: 'copilot', workspaceId: ws.workspaceId },
            { ...messages, url: 'https://evil.example/v1/messages' },
          ),
        ).toMatchObject({ ok: false });
        expect(
          await vault.providerStream(
            session(ws),
            { kind: 'stripe', channelId: wsChannel },
            { method: 'GET', url: 'https://api.stripe.com/v1/customers' },
          ),
        ).toEqual({ ok: false, reason: 'refused' });
        expect(outbound).toEqual([]);
        expect(
          await vault.checkCredential(session(ws), {
            kind: 'copilot',
            workspaceId: ws.workspaceId,
          }),
        ).toEqual({ ok: true, value: true });
      } finally {
        useVaultProviderFetch(null);
      }
    });

    it('uses the saved key only through the vault, which refuses one it cannot open', async () => {
      // The api never opens the key: the provider's requests go out through the vault's proxy,
      // which attaches it. A value that no longer opens is refused there, before anything is
      // sent, and nothing falls back to the platform key.
      await env.DB.prepare(
        "UPDATE copilot_keys SET key_enc = 'f1.broken.value' WHERE workspace_id = ?1",
      )
        .bind(ws.workspaceId)
        .run();
      const outbound: string[] = [];
      useVaultProviderFetch(async (input) => {
        outbound.push(String(input));
        return new Response('{}');
      });
      try {
        const proxied = await vaultClient('api', null).providerFetch(
          { kind: 'operator-session', sessionToken: ws.cookie.slice(ws.cookie.indexOf('=') + 1) },
          { kind: 'copilot', workspaceId: ws.workspaceId },
          { method: 'GET', url: 'https://api.anthropic.com/v1/models' },
        );
        expect(proxied.ok).toBe(false);
        expect(outbound).toEqual([]);
      } finally {
        useVaultProviderFetch(null);
      }
    });

    it('refuses before the stream, never falling back, when the saved key cannot be opened', async () => {
      // The key was broken above: the answer is a JSON 503, not a stream that fails part way.
      const res = await ask(ws, wsDispatch.id, { feature: 'teaser', text: TEXT });
      expect(res.status).toBe(503);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = await json<{ error: { code: string; message: string } }>(res);
      expect(body.error.code).toBe('unavailable');
      expect(body.error.message).toMatch(/can’t be opened/);
    });

    it('answers 503 before the stream while the vault is down', async () => {
      useVaultForTests('api', createDownVault<'api'>());
      try {
        const res = await ask(ws, wsDispatch.id, { feature: 'teaser', text: TEXT });
        expect(res.status).toBe(503);
        expect((await json<{ error: { message: string } }>(res)).error.message).toMatch(
          /right now/,
        );
      } finally {
        await installFakeVault();
      }
    });

    it('deletes the key, then goes back to the platform key', async () => {
      const stranger = await signIn();
      const hidden = await call('DELETE', `/api/v1/workspaces/${ws.workspaceId}/copilot/key`, {
        cookie: stranger.cookie,
      });
      expect(hidden.status).toBe(404);
      const removed = await call('DELETE', keyPath(), { cookie: ws.cookie });
      expect(removed.status).toBe(204);
      expect((await call('DELETE', keyPath(), { cookie: ws.cookie })).status).toBe(404);
      const settings = await data<CopilotSettings>(
        await call('GET', `/api/v1/workspaces/${ws.workspaceId}/copilot`, { cookie: ws.cookie }),
      );
      expect(settings.key).toBeNull();
      expect(settings.keySource).toBe('platform');
    });
  });
});
