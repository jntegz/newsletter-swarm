/**
 * Service secrets: provider keys, webhook signing secrets, TOTP and SSO client secrets. They are
 * sealed here, for their row, and opened only here, to sign or to attach to an outbound request;
 * the plaintext never leaves the vault, except a new secret shown once to the operator who made
 * it (a webhook secret, the TOTP enrolment).
 */
import { first, run } from '@swarm/db';
import type { ExportDestinationConfig } from '@swarm/domain';
import {
  base32Decode,
  matchTotp,
  newTotpSecret,
  newWebhookSecret,
  objectUrl,
  otpauthUri,
  outboundUrlProblem,
  signWebhook,
  verifyStripeSignature,
  webhookSignature,
} from '@swarm/engine';
import { signRequest } from '@swarm/mail';
import type {
  DestinationRequest,
  Sealed,
  SealableCredential,
  SignedDestinationRequest,
} from '../api';
import { invalid, notFound, refuse, type VaultContext } from './context';
import { openValue, sealValue } from './sealing';

const MAX_SECRET = 4096;

function plaintextArg(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_SECRET) return invalid('secret');
  return value;
}

// ---- Provider credentials ----------------------------------------------------------------------

/** The workspace a credential to seal belongs to, read from D1 where its row already exists. */
export async function credentialWorkspace(
  ctx: VaultContext,
  ref: SealableCredential,
): Promise<string> {
  switch (ref.kind) {
    case 'stripe-own':
    case 'stripe-webhook':
    case 'paypal': {
      const row = await first<{ workspace_id: string }>(
        ctx.db,
        'SELECT workspace_id FROM channels WHERE id = ?1 AND deleted_at IS NULL',
        ref.channelId,
      );
      if (!row) return notFound('channel');
      return row.workspace_id;
    }
    case 'shorthop':
    case 'copilot':
    case 'export-destination':
      if (typeof ref.workspaceId !== 'string' || !ref.workspaceId) return invalid('workspace');
      return ref.workspaceId;
    default:
      return invalid('credential kind');
  }
}

/**
 * Seals a provider credential for its row. Rows that exist already (a destination, a
 * connection) must be in the workspace the caller names; a new row's id is the one the caller
 * will insert.
 */
export async function sealCredential(
  ctx: VaultContext,
  ref: SealableCredential,
  workspaceId: string,
  plaintext: unknown,
): Promise<Sealed> {
  const secret = plaintextArg(plaintext);
  const id = (value: unknown) => {
    if (typeof value !== 'string' || !value || value.length > 120) invalid('id');
    return value as string;
  };
  switch (ref.kind) {
    case 'stripe-own':
    case 'stripe-webhook':
    case 'paypal':
      return sealValue(
        ctx,
        'app-key',
        { w: workspaceId, c: id(ref.channelId), kind: ref.kind === 'paypal' ? 'paypal' : ref.kind },
        secret,
      );
    case 'shorthop': {
      await sameWorkspaceIfExists(ctx, 'app_connections', id(ref.connectionId), workspaceId);
      return sealValue(
        ctx,
        'app-key',
        { w: workspaceId, app: ref.connectionId, kind: 'shorthop' },
        secret,
      );
    }
    case 'copilot': {
      await sameWorkspaceIfExists(ctx, 'copilot_keys', id(ref.keyId), workspaceId);
      return sealValue(ctx, 'copilot-key', { w: workspaceId, copilot: ref.keyId }, secret);
    }
    case 'export-destination': {
      await sameWorkspaceIfExists(ctx, 'export_destinations', id(ref.destinationId), workspaceId);
      let creds: { accessKeyId?: unknown; secretAccessKey?: unknown };
      try {
        creds = JSON.parse(secret) as typeof creds;
      } catch {
        return invalid('credentials');
      }
      if (typeof creds.accessKeyId !== 'string' || typeof creds.secretAccessKey !== 'string') {
        invalid('credentials');
      }
      return sealValue(
        ctx,
        'export-credentials',
        { w: workspaceId, d: ref.destinationId },
        JSON.stringify({ accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey }),
      );
    }
    default:
      return invalid('credential kind');
  }
}

async function sameWorkspaceIfExists(
  ctx: VaultContext,
  table: 'app_connections' | 'copilot_keys' | 'export_destinations',
  id: string,
  workspaceId: string,
): Promise<void> {
  const row = await first<{ workspace_id: string }>(
    ctx.db,
    `SELECT workspace_id FROM ${table} WHERE id = ?1`,
    id,
  );
  if (row && row.workspace_id !== workspaceId) notFound(table);
}

/** A Channel's Stripe route: its own key, or the platform key on its connected account. */
export async function stripeRoute(
  ctx: VaultContext,
  channelId: string,
): Promise<{ key: string; account: string | null; workspaceId: string }> {
  const row = await first<{
    workspace_id: string;
    stripe_account_id: string;
    own_key_enc: string | null;
  }>(
    ctx.db,
    `SELECT workspace_id, stripe_account_id, own_key_enc FROM stripe_accounts
      WHERE channel_id = ?1 AND disconnected_at IS NULL`,
    channelId,
  );
  if (!row) return notFound('stripe account');
  if (row.own_key_enc) {
    const key = await openValue(
      ctx,
      'app-key',
      { w: row.workspace_id, c: channelId, kind: 'stripe-own' },
      row.own_key_enc,
    );
    if (!key) return refuse('stripe key unreadable');
    return { key, account: null, workspaceId: row.workspace_id };
  }
  if (!ctx.secrets.stripeSecretKey) return notFound('platform stripe key');
  return {
    key: ctx.secrets.stripeSecretKey,
    account: row.stripe_account_id,
    workspaceId: row.workspace_id,
  };
}

/** PayPal client id, secret and mode of a Channel. */
export async function paypalAccount(ctx: VaultContext, channelId: string) {
  const row = await first<{
    workspace_id: string;
    mode: string;
    client_id: string;
    secret_enc: string;
  }>(
    ctx.db,
    'SELECT workspace_id, mode, client_id, secret_enc FROM paypal_accounts WHERE channel_id = ?1',
    channelId,
  );
  if (!row) return notFound('paypal account');
  const secret = await openValue(
    ctx,
    'app-key',
    { w: row.workspace_id, c: channelId, kind: 'paypal' },
    row.secret_enc,
  );
  if (!secret) return refuse('paypal secret unreadable');
  return {
    workspaceId: row.workspace_id,
    mode: row.mode === 'live' ? ('live' as const) : ('sandbox' as const),
    clientId: row.client_id,
    secret,
  };
}

export async function shorthopConnection(ctx: VaultContext, connectionId: string) {
  const row = await first<{ workspace_id: string; base_url: string; key_enc: string }>(
    ctx.db,
    "SELECT workspace_id, base_url, key_enc FROM app_connections WHERE id = ?1 AND app = 'shorthop'",
    connectionId,
  );
  if (!row) return notFound('connection');
  const key = await openValue(
    ctx,
    'app-key',
    { w: row.workspace_id, app: connectionId, kind: 'shorthop' },
    row.key_enc,
  );
  if (!key) return refuse('connection key unreadable');
  return { workspaceId: row.workspace_id, baseUrl: row.base_url, key };
}

export async function copilotKey(ctx: VaultContext, workspaceId: string) {
  const row = await first<{ id: string; key_enc: string }>(
    ctx.db,
    `SELECT id, key_enc FROM copilot_keys WHERE workspace_id = ?1 AND provider = 'anthropic'
      ORDER BY updated_at DESC LIMIT 1`,
    workspaceId,
  );
  if (!row) return notFound('copilot key');
  const key = await openValue(ctx, 'copilot-key', { w: workspaceId, copilot: row.id }, row.key_enc);
  if (!key) return refuse('copilot key unreadable');
  return key;
}

/** Checks a Stripe webhook to a Channel's own endpoint against its stored signing secret. */
export async function verifyStripeWebhook(
  ctx: VaultContext,
  channelId: unknown,
  payload: unknown,
  signature: unknown,
): Promise<void> {
  if (
    typeof channelId !== 'string' ||
    typeof payload !== 'string' ||
    typeof signature !== 'string'
  ) {
    return invalid('webhook');
  }
  const row = await first<{ workspace_id: string; webhook_secret_enc: string | null }>(
    ctx.db,
    'SELECT workspace_id, webhook_secret_enc FROM stripe_accounts WHERE channel_id = ?1',
    channelId,
  );
  if (!row?.webhook_secret_enc) return notFound('stripe webhook');
  const secret = await openValue(
    ctx,
    'app-key',
    { w: row.workspace_id, c: channelId, kind: 'stripe-webhook' },
    row.webhook_secret_enc,
  );
  if (!secret) return refuse('webhook secret unreadable');
  const result = await verifyStripeSignature(payload, signature, [secret], ctx.now());
  if (!result.ok) refuse(`stripe signature ${result.reason}`);
}

// ---- Webhook signing secrets -------------------------------------------------------------------

/** A new Event Webhook secret for an endpoint of the workspace (the endpoint may be new). */
export async function createWebhookSecret(
  ctx: VaultContext,
  workspaceId: string,
  endpointId: unknown,
): Promise<{ secretOnce: string; sealed: Sealed }> {
  if (typeof endpointId !== 'string' || !endpointId || endpointId.length > 120) invalid('endpoint');
  const row = await first<{ workspace_id: string }>(
    ctx.db,
    'SELECT workspace_id FROM webhook_endpoints WHERE id = ?1',
    endpointId,
  );
  if (row && row.workspace_id !== workspaceId) notFound('endpoint');
  const secret = newWebhookSecret();
  const sealed = await sealValue(
    ctx,
    'webhook-secret',
    { w: workspaceId, e: endpointId as string },
    secret,
  );
  return { secretOnce: secret, sealed };
}

/** A new Flow webhook secret; returns the Flow's workspace and Channel for the authorization. */
export async function flowForSecret(ctx: VaultContext, flowId: unknown) {
  if (typeof flowId !== 'string' || !flowId) return invalid('flow');
  const row = await first<{ workspace_id: string; channel_id: string }>(
    ctx.db,
    'SELECT workspace_id, channel_id FROM flows WHERE id = ?1 AND deleted_at IS NULL',
    flowId,
  );
  if (!row) return notFound('flow');
  return { workspaceId: row.workspace_id, channelId: row.channel_id, flowId };
}

export async function createFlowWebhookSecret(
  ctx: VaultContext,
  workspaceId: string,
  flowId: string,
): Promise<{ secretOnce: string; sealed: Sealed }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = `whsec_${btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')}`;
  const sealed = await sealValue(
    ctx,
    'flow-webhook-secret',
    { w: workspaceId, fl: flowId },
    secret,
  );
  return { secretOnce: secret, sealed };
}

/** The Swarm-Signature of a pending delivery: the current secret, and the previous in its overlap. */
export async function signWebhookDelivery(
  ctx: VaultContext,
  deliveryId: string,
  timestamp: unknown,
  body: unknown,
): Promise<string> {
  if (!Number.isInteger(timestamp) || typeof body !== 'string') return invalid('delivery');
  const row = await first<{
    endpoint_id: string;
    workspace_id: string;
    secret_enc: string;
    previous_secret_enc: string | null;
    previous_expires_at: number | null;
  }>(
    ctx.db,
    `SELECT e.id AS endpoint_id, e.workspace_id, e.secret_enc, e.previous_secret_enc,
            e.previous_expires_at
       FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
      WHERE d.id = ?1`,
    deliveryId,
  );
  if (!row) return notFound('delivery');
  const parts = { w: row.workspace_id, e: row.endpoint_id };
  const current = await openValue(ctx, 'webhook-secret', parts, row.secret_enc);
  if (!current) return refuse('webhook secret unreadable');
  const secrets = [current];
  if (row.previous_secret_enc && (row.previous_expires_at ?? 0) > ctx.now()) {
    const previous = await openValue(ctx, 'webhook-secret', parts, row.previous_secret_enc);
    if (previous) secrets.push(previous);
  }
  return signWebhook(secrets, timestamp as number, body);
}

/** The Swarm-Signature of a Flow webhook step, for a run at that step. */
export async function signFlowWebhook(
  ctx: VaultContext,
  runId: string,
  timestamp: unknown,
  body: unknown,
): Promise<string> {
  if (!Number.isInteger(timestamp) || typeof body !== 'string') return invalid('flow webhook');
  const row = await first<{ id: string; workspace_id: string; webhook_secret_enc: string | null }>(
    ctx.db,
    `SELECT f.id, f.workspace_id, f.webhook_secret_enc FROM flow_runs r
       JOIN flows f ON f.id = r.flow_id WHERE r.id = ?1`,
    runId,
  );
  if (!row?.webhook_secret_enc) return notFound('flow webhook secret');
  const secret = await openValue(
    ctx,
    'flow-webhook-secret',
    { w: row.workspace_id, fl: row.id },
    row.webhook_secret_enc,
  );
  if (!secret) return refuse('flow webhook secret unreadable');
  return webhookSignature(secret, timestamp as number, body);
}

// ---- TOTP --------------------------------------------------------------------------------------

/** Whether the operator has no second factor yet (a session may then enrol before it is complete). */
export async function hasNoFactor(ctx: VaultContext, operatorId: string): Promise<boolean> {
  const row = await first<{ n: number }>(
    ctx.db,
    `SELECT (SELECT COUNT(*) FROM passkeys WHERE operator_id = ?1)
          + (SELECT COUNT(*) FROM totp_secrets WHERE operator_id = ?1 AND confirmed_at IS NOT NULL) AS n`,
    operatorId,
  );
  return (row?.n ?? 0) === 0;
}

/** Makes and stores an unconfirmed secret; refused when one is already confirmed. */
export async function beginTotp(
  ctx: VaultContext,
  operatorId: string,
): Promise<{ otpauthUri: string; secretOnce: string }> {
  const operator = await first<{ email: string }>(
    ctx.db,
    'SELECT email FROM operators WHERE id = ?1',
    operatorId,
  );
  if (!operator) return notFound('operator');
  const secret = newTotpSecret();
  const written = await run(
    ctx.db,
    `INSERT INTO totp_secrets (operator_id, secret_enc, created_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (operator_id) DO UPDATE SET secret_enc = excluded.secret_enc,
       created_at = excluded.created_at, last_step = NULL
     WHERE totp_secrets.confirmed_at IS NULL`,
    operatorId,
    await sealValue(ctx, 'totp', { o: operatorId }, secret),
    ctx.now(),
  );
  if ((written.meta.changes ?? 0) === 0) refuse('totp already confirmed');
  return { otpauthUri: otpauthUri(secret, operator.email), secretOnce: secret };
}

const CODE = /^\d{6}$/;

/** Turns enrolment on when the code matches the unconfirmed secret. */
export async function confirmTotp(
  ctx: VaultContext,
  operatorId: string,
  code: unknown,
): Promise<number> {
  if (typeof code !== 'string' || !CODE.test(code)) return refuse('totp code');
  const row = await first<{ secret_enc: string }>(
    ctx.db,
    'SELECT secret_enc FROM totp_secrets WHERE operator_id = ?1 AND confirmed_at IS NULL',
    operatorId,
  );
  if (!row) return notFound('totp enrolment');
  const secret = await openValue(ctx, 'totp', { o: operatorId }, row.secret_enc);
  if (!secret) return refuse('totp unreadable');
  const step = await matchTotp(base32Decode(secret), code, null, ctx.now());
  if (step === null) return refuse('totp code');
  const done = await run(
    ctx.db,
    `UPDATE totp_secrets SET confirmed_at = ?1, last_step = ?2
      WHERE operator_id = ?3 AND confirmed_at IS NULL`,
    ctx.now(),
    step,
    operatorId,
  );
  if ((done.meta.changes ?? 0) === 0) refuse('totp enrolment changed');
  return step;
}

/** Accepts a code of a confirmed secret once: last_step only moves forward. */
export async function verifyTotp(
  ctx: VaultContext,
  operatorId: string,
  code: unknown,
): Promise<number> {
  if (typeof code !== 'string' || !CODE.test(code)) return refuse('totp code');
  const row = await first<{ secret_enc: string; last_step: number | null }>(
    ctx.db,
    'SELECT secret_enc, last_step FROM totp_secrets WHERE operator_id = ?1 AND confirmed_at IS NOT NULL',
    operatorId,
  );
  if (!row) return notFound('totp');
  const secret = await openValue(ctx, 'totp', { o: operatorId }, row.secret_enc);
  if (!secret) return refuse('totp unreadable');
  const step = await matchTotp(base32Decode(secret), code, row.last_step, ctx.now());
  if (step === null) return refuse('totp code');
  const claimed = await first(
    ctx.db,
    `UPDATE totp_secrets SET last_step = ?1
      WHERE operator_id = ?2 AND (last_step IS NULL OR last_step < ?1) RETURNING operator_id`,
    step,
    operatorId,
  );
  if (!claimed) refuse('totp replay');
  return step;
}

// ---- SSO ---------------------------------------------------------------------------------------

interface Discovery {
  issuer?: unknown;
  token_endpoint?: unknown;
  token_endpoint_auth_methods_supported?: unknown;
}

const IDP_TIMEOUT_MS = 10_000;

async function idpFetch(
  ctx: VaultContext,
  url: string,
  init: RequestInit,
): Promise<Response | null> {
  if (outboundUrlProblem(url, { allowHttp: ctx.config.development })) return null;
  try {
    return await ctx.fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(IDP_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

/**
 * The authorization-code exchange of an active OIDC connection, with its sealed client secret, to
 * the token endpoint discovered from its own issuer (never one a caller names).
 */
export async function ssoTokenExchange(
  ctx: VaultContext,
  args: { connectionId: unknown; code: unknown; codeVerifier: unknown; redirectUri: unknown },
): Promise<{ status: number; json: unknown; workspaceId: string }> {
  const { connectionId, code, codeVerifier, redirectUri } = args;
  for (const value of [connectionId, code, codeVerifier, redirectUri]) {
    if (typeof value !== 'string' || !value || value.length > 2048) invalid('sso exchange');
  }
  const row = await first<{ workspace_id: string; config_json: string }>(
    ctx.db,
    "SELECT workspace_id, config_json FROM sso_connections WHERE id = ?1 AND status = 'active' AND protocol = 'oidc'",
    connectionId,
  );
  if (!row) return notFound('sso connection');
  const config = JSON.parse(row.config_json) as {
    issuer?: unknown;
    clientId?: unknown;
    clientSecretEnc?: unknown;
  };
  if (
    typeof config.issuer !== 'string' ||
    typeof config.clientId !== 'string' ||
    typeof config.clientSecretEnc !== 'string'
  ) {
    return notFound('sso config');
  }
  const secret = await openValue(
    ctx,
    'sso-client-secret',
    { w: row.workspace_id, sso: connectionId as string },
    config.clientSecretEnc,
  );
  if (!secret) return refuse('sso secret unreadable');
  const discoveryResponse = await idpFetch(
    ctx,
    `${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
    { headers: { accept: 'application/json' } },
  );
  const discovery = discoveryResponse?.ok
    ? ((await discoveryResponse.json().catch(() => null)) as Discovery | null)
    : null;
  if (
    !discovery ||
    discovery.issuer !== config.issuer ||
    typeof discovery.token_endpoint !== 'string' ||
    outboundUrlProblem(discovery.token_endpoint, { allowHttp: ctx.config.development })
  ) {
    return refuse('sso discovery');
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code as string,
    redirect_uri: redirectUri as string,
    code_verifier: codeVerifier as string,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  const methods = Array.isArray(discovery.token_endpoint_auth_methods_supported)
    ? (discovery.token_endpoint_auth_methods_supported as unknown[])
    : null;
  // client_secret_basic is the OIDC default; post only when basic is not offered.
  if (
    methods &&
    !methods.includes('client_secret_basic') &&
    methods.includes('client_secret_post')
  ) {
    body.set('client_id', config.clientId);
    body.set('client_secret', secret);
  } else {
    const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, '+');
    headers.authorization = `Basic ${btoa(`${encode(config.clientId)}:${encode(secret)}`)}`;
  }
  const response = await idpFetch(ctx, discovery.token_endpoint, { method: 'POST', headers, body });
  if (!response) return refuse('sso token endpoint');
  const json = (await response.json().catch(() => null)) as unknown;
  return { status: response.status, json, workspaceId: row.workspace_id };
}

// ---- Export destinations -----------------------------------------------------------------------

/**
 * Signs one S3 object request with a destination's stored keys. The key must be under the
 * destination's prefix, and the URL must pass the outbound guard; the vault never sees the body.
 */
export async function signDestinationRequest(
  ctx: VaultContext,
  destinationId: string,
  request: unknown,
): Promise<SignedDestinationRequest & { workspaceId: string }> {
  const req = request as Partial<DestinationRequest> | null;
  if (
    !req ||
    (req.method !== 'PUT' && req.method !== 'DELETE' && req.method !== 'HEAD') ||
    typeof req.key !== 'string' ||
    !req.key ||
    req.key.length > 1024 ||
    req.key.split('/').some((segment) => segment === '..' || segment === '.') ||
    typeof req.contentSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(req.contentSha256)
  ) {
    return invalid('destination request');
  }
  const row = await first<{ workspace_id: string; config_json: string; credentials_enc: string }>(
    ctx.db,
    'SELECT workspace_id, config_json, credentials_enc FROM export_destinations WHERE id = ?1',
    destinationId,
  );
  if (!row) return notFound('destination');
  const config = JSON.parse(row.config_json) as ExportDestinationConfig;
  if (!req.key.startsWith(config.prefix ?? '')) refuse('key outside prefix');
  const opened = await openValue(
    ctx,
    'export-credentials',
    { w: row.workspace_id, d: destinationId },
    row.credentials_enc,
  );
  if (!opened) return refuse('destination credentials unreadable');
  const credentials = JSON.parse(opened) as { accessKeyId: string; secretAccessKey: string };
  const url = objectUrl(config, req.key);
  if (outboundUrlProblem(url, { allowHttp: ctx.config.development })) refuse('destination url');
  const headers: Record<string, string> = { 'x-amz-content-sha256': req.contentSha256 };
  if (req.contentType) headers['content-type'] = req.contentType;
  const signed = await signRequest({
    method: req.method,
    url,
    headers,
    payloadHash: req.contentSha256,
    service: 's3',
    region: config.region,
    credentials,
    now: new Date(ctx.now()),
  });
  return { url, headers: Object.entries(signed), workspaceId: row.workspace_id };
}
