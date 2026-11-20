// The provider proxy: the vault attaches a stored credential only to requests on its allowlist
// for that entrypoint, credential and principal, to the credential's own host, and never takes
// a credential header from the caller.
import { env, exports } from 'cloudflare:workers';
import { sealAppKey } from '@swarm/engine';
import type { VaultFor } from '@swarm/vault';
import { parseKeyring } from '@swarm/tokens';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addMember, addOperator, memberLinkV1, seedChannel, session, sql, vault } from './helpers';

const fieldKeys = parseKeyring(env.FIELD_KEYS);

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

function recorder() {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    if (url.includes('/v1/oauth2/token')) {
      return Response.json({ access_token: 'paypal-access', expires_in: 3600 });
    }
    return Response.json(
      { id: 'obj_1' },
      { headers: { 'request-id': 'req_1', 'set-cookie': 'x' } },
    );
  }) as typeof fetch;
  return { calls, fetcher };
}

describe('providerFetch', () => {
  let workspaceId: string;
  let channelId: string;
  let memberId: string;
  let account: string;
  let sub: string;
  let cus: string;

  beforeEach(async () => {
    sub = `sub_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    cus = `cus_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    account = `acct_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    ({ workspaceId, channelId } = await seedChannel());
    memberId = await addMember(channelId);
    const now = Date.now();
    await sql(
      `INSERT INTO stripe_accounts (channel_id, workspace_id, stripe_account_id, connected_at, updated_at)
       VALUES (?1, ?2, ?4, ?3, ?3)`,
      channelId,
      workspaceId,
      now,
      account,
    );
    await sql(
      `INSERT INTO member_subscriptions (id, channel_id, member_id, source, status, stripe_subscription_id,
                                         stripe_customer_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'stripe', 'active', ?5, ?6, ?4, ?4)`,
      `ms_${crypto.randomUUID().replaceAll('-', '')}`,
      channelId,
      memberId,
      now,
      sub,
      cus,
    );
  });

  it('sends site Checkout with the platform key on the Channel’s account', async () => {
    const { calls, fetcher } = recorder();
    const result = await vault('site', { fetch: fetcher }).providerFetch(
      { kind: 'public-channel', channelId },
      { kind: 'stripe', channelId },
      {
        method: 'POST',
        url: 'https://api.stripe.com/v1/checkout/sessions',
        headers: [
          ['content-type', 'application/x-www-form-urlencoded'],
          ['idempotency-key', 'ref-1'],
          ['x-forwarded-for', 'dropped'],
        ],
        body: 'mode=subscription',
      },
    );
    expect(result).toEqual({
      ok: true,
      value: {
        status: 200,
        headers: [
          ['content-type', 'application/json'],
          ['request-id', 'req_1'],
        ],
        body: '{"id":"obj_1"}',
      },
    });
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.headers.get('authorization')).toBe(`Bearer ${env.STRIPE_SECRET_KEY}`);
    expect(call.headers.get('stripe-account')).toBe(account);
    expect(call.headers.get('idempotency-key')).toBe('ref-1');
    expect(call.headers.get('x-forwarded-for')).toBeNull();
  });

  it('uses the Channel’s own key without an account header, and rewrites the account path', async () => {
    await sql(
      'UPDATE stripe_accounts SET own_key_enc = ?1 WHERE channel_id = ?2',
      await sealAppKey(fieldKeys, workspaceId, 'rk_test_own0123456789'),
      channelId,
    );
    const { sessionToken } = await addOperator(workspaceId, 'editor');
    const { calls, fetcher } = recorder();
    const result = await vault('api', { fetch: fetcher }).providerFetch(
      session(sessionToken),
      { kind: 'stripe', channelId },
      { method: 'GET', url: `https://api.stripe.com/v1/accounts/${account}` },
    );
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/account');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer rk_test_own0123456789');
    expect(calls[0]?.headers.get('stripe-account')).toBeNull();
  });

  it('refuses paths, methods and hosts off the allowlist, and credential headers', async () => {
    const { calls, fetcher } = recorder();
    const site = vault('site', { fetch: fetcher });
    const principal = { kind: 'public-channel', channelId } as const;
    const ref = { kind: 'stripe', channelId } as const;
    for (const request of [
      { method: 'POST', url: 'https://api.stripe.com/v1/refunds' },
      { method: 'GET', url: 'https://api.stripe.com/v1/checkout/sessions' },
      { method: 'POST', url: 'https://evil.example.com/v1/checkout/sessions' },
      { method: 'POST', url: 'https://user:pw@api.stripe.com/v1/checkout/sessions' },
    ] as const) {
      const result = await site.providerFetch(principal, ref, request);
      expect(result.ok, request.url).toBe(false);
    }
    expect(
      await site.providerFetch(principal, ref, {
        method: 'POST',
        url: 'https://api.stripe.com/v1/checkout/sessions',
        headers: [['Authorization', 'Bearer sk_live_stolen']],
      }),
    ).toEqual({ ok: false, reason: 'refused' });
    // A public principal for another Channel, and a kind site may not use.
    const other = await seedChannel();
    expect(
      await site.providerFetch({ kind: 'public-channel', channelId: other.channelId }, ref, {
        method: 'POST',
        url: 'https://api.stripe.com/v1/checkout/sessions',
      }),
    ).toEqual({ ok: false, reason: 'refused' });
    expect(
      await site.providerFetch({ kind: 'cron', task: 'payments-lifecycle' } as never, ref, {
        method: 'POST',
        url: 'https://api.stripe.com/v1/checkout/sessions',
      }),
    ).toEqual({ ok: false, reason: 'refused' });
    expect(calls).toHaveLength(0);
  });

  it('lets the Member Center reach only the link Member’s own subscription and customer', async () => {
    const { calls, fetcher } = recorder();
    const capture = vault('capture', { fetch: fetcher });
    const principal = { kind: 'member-link', token: await memberLinkV1(memberId) } as const;
    const ref = { kind: 'stripe', channelId } as const;
    expect(
      (
        await capture.providerFetch(principal, ref, {
          method: 'GET',
          url: `https://api.stripe.com/v1/subscriptions/${sub}`,
        })
      ).ok,
    ).toBe(true);
    expect(
      await capture.providerFetch(principal, ref, {
        method: 'GET',
        url: 'https://api.stripe.com/v1/subscriptions/sub_someone_else',
      }),
    ).toEqual({ ok: false, reason: 'refused' });
    expect(
      (
        await capture.providerFetch(principal, ref, {
          method: 'POST',
          url: 'https://api.stripe.com/v1/billing_portal/sessions',
          body: `customer=${cus}&return_url=https%3A%2F%2Fforms.example.test`,
        })
      ).ok,
    ).toBe(true);
    expect(
      await capture.providerFetch(principal, ref, {
        method: 'POST',
        url: 'https://api.stripe.com/v1/billing_portal/sessions',
        body: 'customer=cus_other',
      }),
    ).toEqual({ ok: false, reason: 'refused' });
    expect(
      await capture.providerFetch({ kind: 'member-link', token: 'forged' }, ref, {
        method: 'GET',
        url: `https://api.stripe.com/v1/subscriptions/${sub}`,
      }),
    ).toEqual({ ok: false, reason: 'refused' });
    expect(calls).toHaveLength(2);
  });

  it('gets PayPal’s access token itself and sends it to the account’s own host', async () => {
    const now = Date.now();
    await sql(
      `INSERT INTO paypal_accounts (channel_id, workspace_id, mode, client_id, secret_enc, secret_last4, webhook_id, connected_at, updated_at)
       VALUES (?1, ?2, 'sandbox', 'client-1', ?3, '0123', 'wh_1', ?4, ?4)`,
      channelId,
      workspaceId,
      await sealAppKey(fieldKeys, workspaceId, 'paypal-secret'),
      now,
    );
    const { calls, fetcher } = recorder();
    const result = await vault('jobs', { fetch: fetcher }).providerFetch(
      { kind: 'cron', task: 'paypal-reconcile' },
      { kind: 'paypal', channelId },
      { method: 'GET', url: 'https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-123' },
    );
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api-m.sandbox.paypal.com/v1/oauth2/token',
      'https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-123',
    ]);
    expect(calls[0]?.headers.get('authorization')).toBe(`Basic ${btoa('client-1:paypal-secret')}`);
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer paypal-access');
    // The live host is not this account's.
    expect(
      await vault('jobs', { fetch: fetcher }).providerFetch(
        { kind: 'cron', task: 'paypal-reconcile' },
        { kind: 'paypal', channelId },
        { method: 'GET', url: 'https://api-m.paypal.com/v1/billing/subscriptions/I-123' },
      ),
    ).toEqual({ ok: false, reason: 'refused' });
  });

  it('adds the DeBounce key to capture’s signup check, and rate-limits anonymous calls', async () => {
    const { calls, fetcher } = recorder();
    const capture = vault('capture', { fetch: fetcher });
    const call = () =>
      capture.providerFetch(
        { kind: 'public-channel', channelId },
        { kind: 'debounce', channelId },
        { method: 'GET', url: 'https://api.debounce.io/v1/?email=a%40example.test&api=mine' },
      );
    expect((await call()).ok).toBe(true);
    const sent = new URL(calls[0]?.url as string);
    expect(sent.searchParams.get('api')).toBe(env.DEBOUNCE_API_KEY);
    expect(sent.searchParams.get('email')).toBe('a@example.test');
    const { sha256Hex } = await import('@swarm/db');
    await sql(
      'UPDATE vault_rate SET used = 1000 WHERE subject_hash = ?1',
      await sha256Hex(`proxy:public\ncapture:${channelId}`),
    );
    expect(await call()).toEqual({ ok: false, reason: 'rate_limited' });
  });

  it('sends to a Shorthop at any address in development, as the api lets one connect', async () => {
    const connect = async (baseUrl: string) => {
      const id = `ac_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
      const now = Date.now();
      await sql(
        `INSERT INTO app_connections (id, workspace_id, app, base_url, key_enc, last4, slug_format, created_at, updated_at)
         VALUES (?1, ?2, 'shorthop', ?3, ?4, 'abcd', 'random', ?5, ?5)`,
        id,
        workspaceId,
        baseUrl,
        await sealAppKey(fieldKeys, workspaceId, 'shp_test_key'),
        now,
      );
      return { kind: 'shorthop', connectionId: id } as const;
    };
    const owner = await addOperator(workspaceId, 'owner');
    const send = (
      environment: string,
      ref: { kind: 'shorthop'; connectionId: string },
      url: string,
    ) => {
      const { calls, fetcher } = recorder();
      const api = vault('api', { fetch: fetcher, vars: { ENVIRONMENT: environment } });
      return api
        .providerFetch(session(owner.sessionToken), ref, { method: 'POST', url, body: '{}' })
        .then((result) => ({ result, calls }));
    };
    // The e2e stand-in, and a Shorthop running on the developer's machine.
    const local = await connect('http://127.0.0.1:4321');
    const dev = await send('development', local, 'http://127.0.0.1:4321/api/mcp');
    expect(dev.result.ok).toBe(true);
    expect(dev.calls[0]?.headers.get('authorization')).toBe('Bearer shp_test_key');
    // Elsewhere only a public https host, as the api asks when one connects.
    expect((await send('production', local, 'http://127.0.0.1:4321/api/mcp')).result).toEqual({
      ok: false,
      reason: 'refused',
    });
    await sql(
      "UPDATE app_connections SET base_url = 'https://s.example.com' WHERE id = ?1",
      local.connectionId,
    );
    expect((await send('production', local, 'https://s.example.com/api/mcp')).result.ok).toBe(true);
  });

  it('keeps the Copilot key on Anthropic’s hosts for an operator of the workspace', async () => {
    const now = Date.now();
    await sql(
      `INSERT INTO copilot_keys (id, workspace_id, provider, key_enc, last4, validated_at, created_at, updated_at)
       VALUES ('mk_1', ?1, 'anthropic', ?2, 'abcd', ?3, ?3, ?3)`,
      workspaceId,
      await sealAppKey(fieldKeys, workspaceId, 'sk-ant-test'),
      now,
    );
    const viewer = await addOperator(workspaceId, 'viewer');
    const { calls, fetcher } = recorder();
    const api = vault('api', { fetch: fetcher });
    const ref = { kind: 'copilot', workspaceId } as const;
    expect(
      (
        await api.providerFetch(session(viewer.sessionToken), ref, {
          method: 'POST',
          url: 'https://api.anthropic.com/v1/messages',
          headers: [['anthropic-version', '2023-06-01']],
          body: '{}',
        })
      ).ok,
    ).toBe(true);
    expect(calls[0]?.headers.get('x-api-key')).toBe('sk-ant-test');
    expect(
      await api.providerFetch(session(viewer.sessionToken), ref, {
        method: 'POST',
        url: 'https://api.example.com/v1/messages',
      }),
    ).toEqual({ ok: false, reason: 'refused' });
    const stranger = await addOperator((await seedChannel()).workspaceId, 'owner');
    expect(
      await api.providerFetch(session(stranger.sessionToken), ref, {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
      }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('providerStream', () => {
  it('streams a Copilot reply back over real RPC, on the same rules as providerFetch', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const now = Date.now();
    await sql(
      `INSERT INTO copilot_keys (id, workspace_id, provider, key_enc, last4, validated_at, created_at, updated_at)
       VALUES ('mk_s', ?1, 'anthropic', ?2, 'abcd', ?3, ?3, ?3)`,
      workspaceId,
      await sealAppKey(fieldKeys, workspaceId, 'sk-ant-stream'),
      now,
    );
    const editor = await addOperator(workspaceId, 'editor');
    const seen: { url: string; key: string | null }[] = [];
    // The entrypoint runs in this isolate: its outbound fetch is the global one. The provider
    // writes its second part a while after the first (made in the vault's own context).
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), key: new Headers(init?.headers).get('x-api-key') });
      const parts = ['event: one\n\n', 'event: two\n\n'];
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent) await new Promise((resolve) => setTimeout(resolve, 200));
          const part = parts[sent++];
          if (part) controller.enqueue(new TextEncoder().encode(part));
          else controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    try {
      const api = (exports as unknown as { ApiVault: VaultFor['api'] }).ApiVault;
      const ref = { kind: 'copilot', workspaceId } as const;
      const result = await api.providerStream(session(editor.sessionToken), ref, {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        body: '{}',
      });
      if (!result.ok) throw new Error(result.reason);
      expect(result.value.status).toBe(200);
      expect(result.value.headers).toEqual([['content-type', 'text/event-stream']]);
      const reader = result.value.body!.getReader();
      const decoder = new TextDecoder();
      // The first part comes on its own, while the provider is still writing.
      expect(decoder.decode((await reader.read()).value)).toBe('event: one\n\n');
      let rest = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        rest += decoder.decode(chunk.value);
      }
      expect(rest).toBe('event: two\n\n');
      expect(seen).toEqual([
        { url: 'https://api.anthropic.com/v1/messages', key: 'sk-ant-stream' },
      ]);

      // The key opens for an operator of the workspace; nothing is sent to check it.
      expect(await api.checkCredential(session(editor.sessionToken), ref)).toEqual({
        ok: true,
        value: true,
      });
      expect(seen).toHaveLength(1);
      // Only calls marked to stream: Stripe through providerStream is refused, nothing sent.
      expect(
        await api.providerStream(
          session(editor.sessionToken),
          { kind: 'stripe', channelId },
          { method: 'GET', url: 'https://api.stripe.com/v1/customers' },
        ),
      ).toEqual({ ok: false, reason: 'refused' });
      expect(
        await api.providerStream(session(editor.sessionToken), ref, {
          method: 'POST',
          url: 'https://api.example.com/v1/messages',
        }),
      ).toEqual({ ok: false, reason: 'refused' });
      expect(seen).toHaveLength(1);

      // A key that no longer opens: refused by the check, before any stream.
      await sql("UPDATE copilot_keys SET key_enc = 'f1.broken.value' WHERE id = 'mk_s'");
      expect(await api.checkCredential(session(editor.sessionToken), ref)).toEqual({
        ok: false,
        reason: 'refused',
      });
      const stranger = await addOperator((await seedChannel()).workspaceId, 'owner');
      expect(await api.checkCredential(session(stranger.sessionToken), ref)).toMatchObject({
        ok: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
