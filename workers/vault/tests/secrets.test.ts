// Service secrets through the vault: sealed for their row by an admin, used only inside it (TOTP,
// webhook signatures, the SSO exchange, Stripe webhook checks, S3 signing), and never returned.
import { env } from 'cloudflare:workers';
import { sha256Hex } from '@swarm/db';
import {
  base32Decode,
  encrypt,
  hotp,
  sealAppKey,
  signStripePayload,
  totpStep,
  webhookSignature,
} from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { beforeEach, describe, expect, it } from 'vitest';
import { addApiKey, addOperator, rows, seedChannel, session, sql, vault } from './helpers';

const fieldKeys = parseKeyring(env.FIELD_KEYS);

describe('credentials', () => {
  let workspaceId: string;
  let channelId: string;

  beforeEach(async () => {
    ({ workspaceId, channelId } = await seedChannel());
  });

  it('seals a provider key for admins only, bound to its Channel and kind', async () => {
    const admin = await addOperator(workspaceId, 'admin');
    const editor = await addOperator(workspaceId, 'editor');
    const api = vault('api', { vars: { VAULT_WRITE_FORMAT: 'v3' } });
    const ref = { kind: 'stripe-own', channelId } as const;
    expect(
      await api.sealCredential(session(editor.sessionToken), {
        ref,
        plaintext: 'rk_test_1234567890',
      }),
    ).toEqual({ ok: false, reason: 'refused' });
    const key = await addApiKey(workspaceId, ['members:write', 'webhooks:write']);
    expect(
      await api.sealCredential(
        { kind: 'api-key', secret: key },
        { ref, plaintext: 'rk_test_1234567890' },
      ),
    ).toEqual({ ok: false, reason: 'refused' });
    const sealed = await api.sealCredential(session(admin.sessionToken), {
      ref,
      plaintext: 'rk_test_1234567890',
    });
    expect(sealed.ok && sealed.value.startsWith('fv3.app-key.')).toBe(true);
  });

  it('keeps the legacy {w, k} format callers read while writes are legacy', async () => {
    const admin = await addOperator(workspaceId, 'admin');
    const sealed = await vault('api').sealCredential(session(admin.sessionToken), {
      ref: { kind: 'paypal', channelId },
      plaintext: 'paypal-secret-0123',
    });
    if (!sealed.ok) throw new Error(sealed.reason);
    const { openAppKey } = await import('@swarm/engine');
    expect(await openAppKey(fieldKeys, workspaceId, sealed.value)).toBe('paypal-secret-0123');
  });

  it('verifies a Stripe webhook against the Channel’s sealed secret, and only that one', async () => {
    const now = Date.now();
    await sql(
      `INSERT INTO stripe_accounts (channel_id, workspace_id, stripe_account_id, connected_at, updated_at, webhook_secret_enc)
       VALUES (?1, ?2, 'acct_1', ?3, ?3, ?4)`,
      channelId,
      workspaceId,
      now,
      await sealAppKey(fieldKeys, workspaceId, 'whsec_channel'),
    );
    const payload = '{"id":"evt_1"}';
    const api = vault('api');
    expect(
      await api.verifyStripeWebhook({
        channelId,
        payload,
        signature: await signStripePayload(payload, 'whsec_channel', now),
      }),
    ).toEqual({ ok: true, value: true });
    expect(
      await api.verifyStripeWebhook({
        channelId,
        payload,
        signature: await signStripePayload(payload, 'whsec_other', now),
      }),
    ).toEqual({ ok: false, reason: 'refused' });
    // A secret copied from another workspace's row does not open here.
    const other = await seedChannel();
    await sql(
      'UPDATE stripe_accounts SET webhook_secret_enc = ?1 WHERE channel_id = ?2',
      await sealAppKey(fieldKeys, other.workspaceId, 'whsec_channel'),
      channelId,
    );
    expect(
      await api.verifyStripeWebhook({
        channelId,
        payload,
        signature: await signStripePayload(payload, 'whsec_channel', now),
      }),
    ).toEqual({ ok: false, reason: 'refused' });
  });
});

describe('webhook secrets and signatures', () => {
  let workspaceId: string;
  let channelId: string;

  beforeEach(async () => {
    ({ workspaceId, channelId } = await seedChannel());
  });

  it('creates an endpoint secret once, and signs a pending delivery with it', async () => {
    const key = await addApiKey(workspaceId, ['webhooks:write']);
    const endpointId = `wh_${crypto.randomUUID().replaceAll('-', '')}`;
    const created = await vault('api').createWebhookSecret(
      { kind: 'api-key', secret: key },
      { workspaceId, endpointId },
    );
    if (!created.ok) throw new Error(created.reason);
    const now = Date.now();
    await sql(
      `INSERT INTO webhook_endpoints (id, workspace_id, url, events_json, secret_enc, created_at, updated_at)
       VALUES (?1, ?2, 'https://hooks.example.test/', '[]', ?3, ?4, ?4)`,
      endpointId,
      workspaceId,
      created.value.sealed,
      now,
    );
    const deliveryId = `wd_${crypto.randomUUID().replaceAll('-', '')}`;
    await sql(
      `INSERT INTO webhook_deliveries (id, endpoint_id, workspace_id, event_id, event_type, payload_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'ev_1', 'member.created', '{}', ?4, ?4)`,
      deliveryId,
      endpointId,
      workspaceId,
      now,
    );
    const signed = await vault('jobs').signWebhookDelivery(
      { kind: 'webhook-delivery', deliveryId },
      { timestamp: 1_800_000_000, body: '{}' },
    );
    expect(signed).toEqual({
      ok: true,
      value: { signature: await webhookSignature(created.value.secretOnce, 1_800_000_000, '{}') },
    });
    await sql("UPDATE webhook_deliveries SET status = 'succeeded' WHERE id = ?1", deliveryId);
    expect(
      await vault('jobs').signWebhookDelivery(
        { kind: 'webhook-delivery', deliveryId },
        { timestamp: 1, body: '{}' },
      ),
    ).toEqual({ ok: false, reason: 'refused' });
  });

  it('refuses a webhook secret for an endpoint of another workspace, and without the scope', async () => {
    const other = await seedChannel();
    const admin = await addOperator(workspaceId, 'admin');
    const now = Date.now();
    const endpointId = `wh_${crypto.randomUUID().replaceAll('-', '')}`;
    await sql(
      `INSERT INTO webhook_endpoints (id, workspace_id, url, events_json, secret_enc, created_at, updated_at)
       VALUES (?1, ?2, 'https://hooks.example.test/', '[]', 'x', ?3, ?3)`,
      endpointId,
      other.workspaceId,
      now,
    );
    expect(
      await vault('api').createWebhookSecret(session(admin.sessionToken), {
        workspaceId,
        endpointId,
      }),
    ).toEqual({ ok: false, reason: 'not_found' });
    const key = await addApiKey(workspaceId, ['webhooks:read']);
    expect(
      await vault('api').createWebhookSecret(
        { kind: 'api-key', secret: key },
        { workspaceId, endpointId: 'wh_new' },
      ),
    ).toEqual({ ok: false, reason: 'refused' });
  });

  it('creates a Flow webhook secret for an editor of its Channel and signs its step', async () => {
    const editor = await addOperator(workspaceId, 'editor');
    const now = Date.now();
    const flowId = `fl_${crypto.randomUUID().replaceAll('-', '')}`;
    await sql(
      `INSERT INTO flows (id, workspace_id, channel_id, name, draft_graph_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'F', '{}', ?4, ?4)`,
      flowId,
      workspaceId,
      channelId,
      now,
    );
    const created = await vault('api').createFlowWebhookSecret(session(editor.sessionToken), {
      flowId,
    });
    if (!created.ok) throw new Error(created.reason);
    await sql(
      'UPDATE flows SET webhook_secret_enc = ?1 WHERE id = ?2',
      created.value.sealed,
      flowId,
    );
    const memberId = `mb_${'c'.repeat(32)}`;
    await sql(
      `INSERT INTO members (id, channel_id, email, created_at, updated_at) VALUES (?1, ?2, 'f@example.test', ?3, ?3)`,
      memberId,
      channelId,
      now,
    );
    const runId = `fr_${crypto.randomUUID().replaceAll('-', '')}`;
    await sql(
      `INSERT INTO flow_runs (id, flow_id, version, channel_id, member_id, status, current_node_id, started_at, updated_at)
       VALUES (?1, ?2, 1, ?3, ?4, 'running', 'hook', ?5, ?5)`,
      runId,
      flowId,
      channelId,
      memberId,
      now,
    );
    const signed = await vault('jobs').signFlowWebhook(
      { kind: 'flow-run', runId, nodeId: 'hook' },
      { timestamp: 1_800_000_000, body: '{"a":1}' },
    );
    expect(signed).toEqual({
      ok: true,
      value: {
        signature: await webhookSignature(created.value.secretOnce, 1_800_000_000, '{"a":1}'),
      },
    });
  });
});

describe('TOTP', () => {
  it('enrols, confirms, verifies once per step, and allows a pending session to verify', async () => {
    const { workspaceId } = await seedChannel();
    const { operatorId, sessionToken } = await addOperator(workspaceId, 'owner');
    const api = vault('api');
    const begun = await api.beginTotp(session(sessionToken));
    if (!begun.ok) throw new Error(begun.reason);
    expect(begun.value.otpauthUri).toContain('otpauth://totp/');
    const secret = base32Decode(begun.value.secretOnce);
    const code = await hotp(secret, totpStep());
    expect(
      await api.confirmTotp(session(sessionToken), {
        code: '000000' === code ? '111111' : '000000',
      }),
    ).toEqual({
      ok: false,
      reason: 'refused',
    });
    expect((await api.confirmTotp(session(sessionToken), { code })).ok).toBe(true);
    // Starting again is refused once a secret is confirmed.
    expect(await api.beginTotp(session(sessionToken))).toEqual({ ok: false, reason: 'refused' });
    // A session waiting for its second factor verifies the next step's code, once.
    const pending = await addOperator(workspaceId, 'viewer', { mfaPending: true });
    await sql(
      'UPDATE sessions SET operator_id = ?1 WHERE operator_id = ?2',
      operatorId,
      pending.operatorId,
    );
    const next = await hotp(secret, totpStep() + 1);
    expect((await api.verifyTotp({ sessionToken: pending.sessionToken, code: next })).ok).toBe(
      true,
    );
    expect(await api.verifyTotp({ sessionToken: pending.sessionToken, code: next })).toEqual({
      ok: false,
      reason: 'refused',
    });
    // The stored secret is bound to its operator: moved to another, it does not open.
    const stored = await rows<{ secret_enc: string }>(
      'SELECT secret_enc FROM totp_secrets WHERE operator_id = ?1',
      operatorId,
    );
    expect(stored[0]?.secret_enc).not.toContain(begun.value.secretOnce);
  });

  it('lets a pending session enrol only a first factor', async () => {
    const { workspaceId } = await seedChannel();
    const first = await addOperator(workspaceId, 'owner', { mfaPending: true });
    expect((await vault('api').beginTotp(session(first.sessionToken))).ok).toBe(true);
    await sql(
      `INSERT INTO passkeys (id, operator_id, credential_id, public_key, name, created_at)
       VALUES (?1, ?2, ?3, 'key', 'Laptop', ?4)`,
      `pk_${crypto.randomUUID().replaceAll('-', '')}`,
      first.operatorId,
      crypto.randomUUID(),
      Date.now(),
    );
    expect(await vault('api').beginTotp(session(first.sessionToken))).toEqual({
      ok: false,
      reason: 'refused',
    });
  });
});

describe('SSO', () => {
  it('exchanges a code with the sealed client secret at the discovered token endpoint', async () => {
    const { workspaceId } = await seedChannel();
    const connectionId = `so_${crypto.randomUUID().replaceAll('-', '')}`;
    const now = Date.now();
    await sql(
      `INSERT INTO sso_connections (id, workspace_id, protocol, domains_json, config_json, status, created_at, updated_at)
       VALUES (?1, ?2, 'oidc', '[]', ?3, 'active', ?4, ?4)`,
      connectionId,
      workspaceId,
      JSON.stringify({
        issuer: 'https://idp.example.com',
        clientId: 'client-1',
        clientSecretEnc: await encrypt(fieldKeys, 'client-secret'),
      }),
      now,
    );
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({
          issuer: 'https://idp.example.com',
          token_endpoint: 'https://idp.example.com/token',
        });
      }
      return Response.json({ id_token: 'header.payload.sig' });
    }) as typeof fetch;
    const result = await vault('api', { fetch: fetcher }).ssoTokenExchange({
      connectionId,
      code: 'code-1',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example.com/callback',
    });
    expect(result).toEqual({
      ok: true,
      value: { status: 200, json: { id_token: 'header.payload.sig' } },
    });
    const token = calls[1];
    expect(token?.url).toBe('https://idp.example.com/token');
    expect(new Headers(token?.init?.headers).get('authorization')).toBe(
      `Basic ${btoa('client-1:client-secret')}`,
    );
    await sql("UPDATE sso_connections SET status = 'draft' WHERE id = ?1", connectionId);
    expect(
      await vault('api', { fetch: fetcher }).ssoTokenExchange({
        connectionId,
        code: 'c',
        codeVerifier: 'v',
        redirectUri: 'https://app.example.com/callback',
      }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('export destinations', () => {
  it('signs an object request under the prefix, never outside it or for another tenant', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const admin = await addOperator(workspaceId, 'admin');
    const destinationId = `xd_${crypto.randomUUID().replaceAll('-', '')}`;
    const now = Date.now();
    const api = vault('api');
    const sealed = await api.sealCredential(session(admin.sessionToken), {
      ref: { kind: 'export-destination', workspaceId, destinationId },
      plaintext: JSON.stringify({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }),
    });
    if (!sealed.ok) throw new Error(sealed.reason);
    await sql(
      `INSERT INTO export_destinations (id, workspace_id, channel_id, kind, config_json, credentials_enc, status,
                                        created_at, updated_at, confirmed_at, confirmed_by)
       VALUES (?1, ?2, ?3, 's3', ?4, ?5, 'active', ?6, ?6, ?6, ?7)`,
      destinationId,
      workspaceId,
      channelId,
      JSON.stringify({
        endpoint: null,
        region: 'eu-west-1',
        bucket: 'swarm-export',
        prefix: 'feeds/',
      }),
      sealed.value,
      now,
      admin.operatorId,
    );
    // The destination's authority (feed-authority.ts): a plan with destinations, its admin.
    await sql("UPDATE workspaces SET plan = 'pro' WHERE id = ?1", workspaceId);
    const request = {
      method: 'PUT',
      key: 'feeds/members/1.jsonl',
      contentSha256: await sha256Hex('{}'),
      contentType: 'application/x-ndjson',
    } as const;
    const signed = await vault('jobs').signDestinationRequest(
      { kind: 'export-destination', destinationId },
      { request },
    );
    if (!signed.ok) throw new Error(signed.reason);
    expect(signed.value.url).toBe(
      'https://swarm-export.s3.eu-west-1.amazonaws.com/feeds/members/1.jsonl',
    );
    const headers = Object.fromEntries(signed.value.headers);
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    expect(JSON.stringify(signed.value)).not.toContain('secret');
    expect(
      await vault('jobs').signDestinationRequest(
        { kind: 'export-destination', destinationId },
        { request: { ...request, key: 'other/x' } },
      ),
    ).toEqual({ ok: false, reason: 'refused' });
    const stranger = await addOperator((await seedChannel()).workspaceId, 'owner');
    expect(
      await api.signDestinationRequest(session(stranger.sessionToken), { destinationId, request }),
    ).toEqual({ ok: false, reason: 'not_found' });
    expect(
      (await api.signDestinationRequest(session(admin.sessionToken), { destinationId, request }))
        .ok,
    ).toBe(true);
  });
});
