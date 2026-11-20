/**
 * The vault's RPC contract: what each caller's service binding can ask of it.
 *
 * The vault (workers/vault) is the only Worker that holds FIELD_KEYS. It has no route; api,
 * capture, site and jobs reach it through a service binding pinned to one named entrypoint each
 * (wrangler `services[].entrypoint`), so a caller can call only its own entrypoint's methods. That
 * pinning is the caller's identity: there is no shared secret to steal.
 *
 * Three rules hold for every method (docs/security.md "The vault"):
 * 1. The vault reads ciphertext from D1 itself. It never opens a value a caller hands it, except
 *    tokens it verifies with its own keys.
 * 2. It decides who may open what from D1, or from a credential or token it verifies itself. A
 *    caller's claim ("operator X in workspace W") is never trusted.
 * 3. Service secrets (provider keys, webhook signing secrets, TOTP, SSO client secrets) never leave
 *    it: it signs with them, or attaches them to an outbound request on a fixed allowlist. The one
 *    exception is a secret shown once to the operator who creates it (a webhook secret, the TOTP
 *    enrolment URI).
 *
 * Every result is a VaultResult. A caller treats anything but `ok: true` as "no value": encrypted
 * fields are not shown, and a save that needs a seal fails with 503 (fail closed, never a weaker
 * fallback). client.ts turns a timeout or a transport error into `unavailable`.
 */
import type { FieldValue } from '@swarm/domain';

/** The Workers that bind to the vault, one entrypoint each. */
export type VaultCaller = 'api' | 'capture' | 'site' | 'jobs';

/** The entrypoint class each caller's binding names (wrangler `services[].entrypoint`). */
export const VAULT_ENTRYPOINTS: Readonly<Record<VaultCaller, string>> = {
  api: 'ApiVault',
  capture: 'CaptureVault',
  site: 'SiteVault',
  jobs: 'JobsVault',
};

/** Profile field values by field key (member_fields.key). */
export type FieldMap = Record<string, FieldValue>;

/** A value the vault sealed, to store as is (fields.ts: legacy formats, or `fv3.…`). */
export type Sealed = string;

// ---- Principals --------------------------------------------------------------------------------

/**
 * A credential the api passes through from the request it is serving. The vault resolves it
 * against D1 itself (@swarm/db credentials.ts, the same lookups the api uses) and checks the
 * coarse rule "this credential is live and reaches this Channel with at least this role or scope".
 * Route policy (holds, approvals, step-up) stays in the api: the vault is a second boundary.
 */
export type CredentialPrincipal =
  /** The dashboard session cookie's value. A session still waiting for its second factor is refused. */
  | { kind: 'operator-session'; sessionToken: string }
  /** A scoped API key (`sk_live_…`); `ip` is checked against the key's allowlist when it has one. */
  | { kind: 'api-key'; secret: string; resource?: 'v2' | 'mcp'; ip?: string | null }
  /** An OAuth access token, for the resource it was issued for. */
  | { kind: 'oauth'; accessToken: string; resource: 'v2' | 'mcp' };

/** Authority the vault reads from a stored row: the row's state is the permission. */
export type StoredPrincipal =
  /** export_jobs: queued or running, and its creator is still an admin of the Channel. */
  | { kind: 'export-job'; jobId: string }
  /** import_jobs: analyzing or importing. */
  | { kind: 'import-job'; jobId: string }
  /** bulk_jobs: queued or running. */
  | { kind: 'bulk-job'; jobId: string }
  /** flow_runs: running or waiting, at `nodeId` of its Flow's live version. */
  | { kind: 'flow-run'; runId: string; nodeId: string }
  /** dsr_requests: processing (or completed, for its outcome notice). */
  | { kind: 'dsr-request'; requestId: string }
  /** export_destinations: active or failing, confirmed, and its feed authority stands. */
  | { kind: 'export-destination'; destinationId: string }
  /** webhook_deliveries: pending or retrying, on an active endpoint (any endpoint for a test). */
  | { kind: 'webhook-delivery'; deliveryId: string }
  /** A provider event the api has recorded (stripe_events, paypal_events) in the last hour. */
  | { kind: 'payment-event'; provider: 'stripe' | 'paypal'; channelId: string; eventId: string };

/** Evidence a public worker holds for a person, which the vault verifies itself. */
export type PersonPrincipal =
  /** A Member Center link (`member` family), verified with the vault's own key and member_links_after. */
  | { kind: 'member-link'; token: string }
  /** A site reader session cookie, looked up by hash in reader_sessions. */
  | { kind: 'reader-session'; token: string; channelId: string };

/** Anonymous public traffic for one Channel: only proxy calls on its allowlist, rate-limited. */
export interface PublicPrincipal {
  kind: 'public-channel';
  channelId: string;
}

/** The scheduled work of the caller itself (jobs' crons): only proxy calls on its allowlist. */
export interface CronPrincipal {
  kind: 'cron';
  task: 'payments-lifecycle' | 'paypal-reconcile';
}

export type Principal =
  CredentialPrincipal | StoredPrincipal | PersonPrincipal | PublicPrincipal | CronPrincipal;

export type PrincipalKind = Principal['kind'];

// ---- Results -----------------------------------------------------------------------------------

export type VaultFailure =
  /** The principal is not allowed this (or does not resolve): never says which. */
  | 'refused'
  /** What the call names does not exist, or not where the principal can reach it. */
  | 'not_found'
  /** A stored value no key opens, or one bound to another row. */
  | 'unreadable'
  | 'rate_limited'
  /** The arguments are malformed (a bug in the caller, not a person's input). */
  | 'invalid'
  /** The vault could not be reached or did not answer in time (client.ts). */
  | 'unavailable';

export type VaultResult<T> = { ok: true; value: T } | { ok: false; reason: VaultFailure };

// ---- Provider proxy ----------------------------------------------------------------------------

/** An outbound request, as plain data so it crosses RPC the same in the fake and the worker. */
export interface VaultRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  /** Lowercase names. `authorization` and any credential header are refused, never forwarded. */
  headers?: [string, string][];
  body?: string;
}

export interface VaultResponse {
  status: number;
  headers: [string, string][];
  body: string;
}

/** A provider answer whose body streams through as the provider sends it (providerStream). */
export interface VaultStreamResponse {
  status: number;
  headers: [string, string][];
  body: ReadableStream<Uint8Array> | null;
}

/** The stored credential to attach. The vault reads it from the row these name. */
export type CredentialRef =
  /**
   * Stripe for a Channel, routed as RoutingStripe does: the Channel's own restricted key
   * (stripe_accounts.own_key_enc) when it has one, else the platform STRIPE_SECRET_KEY with the
   * Channel's connected account in `stripe-account`. Callers never name the account themselves.
   */
  | { kind: 'stripe'; channelId: string }
  /** paypal_accounts.secret_enc of the Channel: the vault gets the access token itself. */
  | { kind: 'paypal'; channelId: string }
  /** app_connections.key_enc (Shorthop), to the connection's own base_url. */
  | { kind: 'shorthop'; connectionId: string }
  /** copilot_keys.key_enc of the workspace (the Anthropic API). */
  | { kind: 'copilot'; workspaceId: string }
  /** The install's DEBOUNCE_API_KEY, for a signup check (`api=` in the query string). */
  | { kind: 'debounce'; channelId: string };

/** What sealCredential can seal: a CredentialRef's secret, or the Stripe webhook signing secret. */
export type SealableCredential =
  | { kind: 'stripe-own'; channelId: string }
  | { kind: 'stripe-webhook'; channelId: string }
  | { kind: 'paypal'; channelId: string }
  | { kind: 'shorthop'; workspaceId: string; connectionId: string }
  | { kind: 'copilot'; workspaceId: string; keyId: string }
  | {
      kind: 'export-destination';
      workspaceId: string;
      destinationId: string;
    };

/** An S3 (or R2) object request to sign with an export destination's stored keys. */
export interface DestinationRequest {
  method: 'PUT' | 'DELETE' | 'HEAD';
  /** The full object key. It must be under the destination's prefix, or the vault refuses it. */
  key: string;
  /** Hex sha256 of the body ('' for none). */
  contentSha256: string;
  contentType?: string;
}

export interface SignedDestinationRequest {
  url: string;
  headers: [string, string][];
}

// ---- Erasure markers ---------------------------------------------------------------------------

/** @swarm/engine AddressMarkers: what a stored erasure or departure marker of an address can be. */
export interface AddressMarkerSet {
  keyed: string;
  legacy: string;
  forms: string[];
}

// ---- Shared method groups ----------------------------------------------------------------------

interface Ping {
  /** No-op round trip: callers' /healthz and the installer's health step use it. */
  ping(): Promise<{ ok: true; entrypoint: string }>;
}

interface FieldOps<P> {
  /**
   * Opens the encrypted profile fields of Members of one Channel. Every Member must be in that
   * Channel; unencrypted fields are not returned (the caller reads them from D1). At most 1000
   * Members per call. Values that no key opens, or that are bound to another row, come back null.
   */
  openMemberFields(
    principal: P,
    args: { channelId: string; memberIds: string[]; fieldKeys?: string[] },
  ): Promise<VaultResult<Record<string, FieldMap>>>;
}

interface ProxyOps<P> {
  /**
   * Sends `request` with the credential attached, if (entrypoint, credential kind, principal kind,
   * method, host, path) is on the allowlist (core/proxy.ts). Redirects are not followed.
   */
  providerFetch(
    principal: P,
    credential: CredentialRef,
    request: VaultRequest,
  ): Promise<VaultResult<VaultResponse>>;
}

interface MarkerOps {
  /** The erasure-marker forms of an address in a workspace (FIELD_KEYS-keyed HMAC). Rate-limited. */
  addressMarkers(args: {
    workspaceId: string;
    email: string;
  }): Promise<VaultResult<AddressMarkerSet>>;
}

// ---- Entrypoints -------------------------------------------------------------------------------

/** The api's entrypoint: the dashboard, /v2, MCP and Copilot tools, payment webhooks. */
export interface ApiVault
  extends Ping, FieldOps<CredentialPrincipal>, ProxyOps<Principal>, MarkerOps {
  /**
   * Seals encrypted field values for one Member of a Channel (to store in value_enc). The Member
   * is in that Channel, or does not exist yet (`memberId` is the id the caller will insert).
   * Needs editor on the Channel, or `members:write`.
   */
  sealMemberFields(
    principal: CredentialPrincipal,
    args: { channelId: string; memberId: string; values: FieldMap },
  ): Promise<VaultResult<Record<string, Sealed>>>;
  /** Seals a credential for its row. Needs admin (owner for SSO re-pointing is the api's rule). */
  sealCredential(
    principal: CredentialPrincipal,
    args: { ref: SealableCredential; plaintext: string },
  ): Promise<VaultResult<Sealed>>;
  /** Seals a data request's address (dsr_requests.email_enc). Needs admin on the workspace. */
  sealDsrAddress(
    principal: CredentialPrincipal,
    args: { workspaceId: string; requestId: string; email: string },
  ): Promise<VaultResult<Sealed>>;
  /**
   * A new Event Webhook signing secret for an endpoint of the workspace: the plaintext once, for
   * the operator, and the sealed value for secret_enc. Needs admin, or `webhooks:write`.
   */
  createWebhookSecret(
    principal: CredentialPrincipal,
    args: { workspaceId: string; endpointId: string },
  ): Promise<VaultResult<{ secretOnce: string; sealed: Sealed }>>;
  /** The same for a Flow's webhook step (flows.webhook_secret_enc). Needs editor on its Channel. */
  createFlowWebhookSecret(
    principal: CredentialPrincipal,
    args: { flowId: string },
  ): Promise<VaultResult<{ secretOnce: string; sealed: Sealed }>>;
  /**
   * Starts TOTP enrolment for the session's operator: the vault makes the secret and stores it
   * unconfirmed (totp_secrets). The URI (with the secret) is shown once, as a QR code.
   */
  beginTotp(principal: {
    kind: 'operator-session';
    sessionToken: string;
  }): Promise<VaultResult<{ otpauthUri: string; secretOnce: string }>>;
  /** Confirms enrolment with a first code. */
  confirmTotp(
    principal: { kind: 'operator-session'; sessionToken: string },
    args: { code: string },
  ): Promise<VaultResult<{ step: number }>>;
  /**
   * Checks a TOTP code for the session's operator, including a session still waiting for its
   * second factor. A step is accepted once (totp_secrets.last_step).
   */
  verifyTotp(args: { sessionToken: string; code: string }): Promise<VaultResult<{ step: number }>>;
  /** Seals an SSO connection's client secret. Needs admin on the workspace. */
  sealSsoSecret(
    principal: CredentialPrincipal,
    args: { workspaceId: string; connectionId: string; clientSecret: string },
  ): Promise<VaultResult<Sealed>>;
  /**
   * The OIDC authorization-code exchange with the connection's own client secret, to the token
   * endpoint the vault discovers from the connection's issuer (outbound URL guard). Returns the
   * IdP's JSON. Anonymous (the sign-in callback): the connection must be active.
   */
  ssoTokenExchange(args: {
    connectionId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<VaultResult<{ status: number; json: unknown }>>;
  /** Verifies a Stripe webhook to a Channel's own endpoint against its stored signing secret. */
  verifyStripeWebhook(args: {
    channelId: string;
    payload: string;
    signature: string;
  }): Promise<VaultResult<true>>;
  /**
   * Member Center links (footer and page links, never the emailed step-up kind) for Members of
   * one Channel. Needs editor on it or `sends:write`, or a payment-event of that Channel.
   * Rate-limited and recorded (vault_mints).
   */
  mintMemberLinks(
    principal: CredentialPrincipal | Extract<StoredPrincipal, { kind: 'payment-event' }>,
    args: { channelId: string; memberIds: string[] },
  ): Promise<VaultResult<Record<string, string>>>;
  /** Goods links for a paid order of a payment event. */
  mintGoodsLinks(
    principal: Extract<StoredPrincipal, { kind: 'payment-event' }>,
    args: { channelId: string; orderId: string },
  ): Promise<VaultResult<{ library: string; order: string }>>;
  /** Signs an S3 request with a destination's keys (the connection test). Needs admin. */
  signDestinationRequest(
    principal: CredentialPrincipal,
    args: { destinationId: string; request: DestinationRequest },
  ): Promise<VaultResult<SignedDestinationRequest>>;
  /**
   * providerFetch, with the answer's body streamed back as it arrives (Copilot's replies), not
   * read whole first. The same allowlist, principal and credential rules, for the calls marked to
   * stream there (core/proxy.ts); anything else is refused.
   */
  providerStream(
    principal: CredentialPrincipal,
    credential: CredentialRef,
    request: VaultRequest,
  ): Promise<VaultResult<VaultStreamResponse>>;
  /**
   * Whether the stored credential opens for this principal, sending nothing: the api asks before
   * it starts a Copilot stream, so a key that can't be opened is a clear error, not one mid-stream.
   * Copilot keys only. `refused` when it doesn't open (or the principal may not use it), `not_found`
   * when none is saved.
   */
  checkCredential(
    principal: CredentialPrincipal,
    credential: Extract<CredentialRef, { kind: 'copilot' }>,
  ): Promise<VaultResult<true>>;
}

/** Evidence capture holds when it asks for a Member Center link. */
export type MemberLinkEvidence =
  /** A confirm request confirmed in the last 10 minutes: the link shown after confirming. */
  | { kind: 'confirmed-request'; requestId: string }
  /**
   * A person asked for their links by address (the /m form): mailed only, rate-limited. Without
   * a Channel, every Channel the address belongs to (at most five).
   */
  | { kind: 'link-request'; channelId: string | null; email: string }
  /** A valid link, for a fresh emailed (step-up) one of the same Member. */
  | { kind: 'step-up'; token: string };

/** Capture's entrypoint: sign-up, confirm, the Member Center and the privacy pages. */
export interface CaptureVault extends Ping, ProxyOps<PersonPrincipal | PublicPrincipal>, MarkerOps {
  /** Verifies a Member Center link and opens that Member's encrypted fields. */
  openMemberCenter(args: { token: string }): Promise<
    VaultResult<{
      memberId: string;
      channelId: string;
      emailed: boolean;
      issuedAt: number;
      fields: FieldMap;
    }>
  >;
  /** Seals profile edits from the Member Center for the link's Member. */
  sealMemberCenterFields(args: {
    token: string;
    values: FieldMap;
  }): Promise<VaultResult<Record<string, Sealed>>>;
  /** Seals a signup's encrypted fields: the form is live, the Member new or in its Channel. */
  sealSignupFields(args: {
    formId: string;
    memberId: string;
    values: FieldMap;
  }): Promise<VaultResult<Record<string, Sealed>>>;
  /** The join token handed to the publisher's site after a signup (SIGNUP_KEYS, held by the vault). */
  mintJoinToken(args: {
    formId: string;
    memberId: string;
    email: string;
    journeyPath?: string;
  }): Promise<VaultResult<string>>;
  mintJourneyToken(args: {
    formId: string;
    journeyId: string;
    variant: string;
    memberId: string;
    email: string;
  }): Promise<VaultResult<string>>;
  openJourneyToken(args: { token: string }): Promise<
    VaultResult<{
      journeyId: string;
      variant: string;
      formId: string;
      memberId: string;
      email: string;
    }>
  >;
  /** Seals the link's Member's own address (read from D1) for a data request about to be filed. */
  sealMemberDsrAddress(args: { token: string; requestId: string }): Promise<VaultResult<Sealed>>;
  /**
   * The same for an erasure confirmed from the inbox: the confirmation (dsr_confirmations, its
   * nonce's hash, unused or used in the last ten minutes) names the Member, whose address is read
   * from D1. Capture has verified the confirmation link itself.
   */
  sealErasureAddress(args: {
    confirmationId: number;
    memberId: string;
    nonce: string | null;
    requestId: string;
  }): Promise<VaultResult<Sealed>>;
  /**
   * Seals an address typed into the public rights form, for an address confirmation: the sealed
   * value and the address's keyed marker (address_confirmations.email_hash), which it is bound to.
   * Sealing reveals nothing; opening it again needs the confirmation (openAddressConfirmation).
   */
  sealAddressConfirmation(args: {
    channelId: string;
    email: string;
  }): Promise<VaultResult<{ sealed: Sealed; emailHash: string }>>;
  /**
   * Opens the address of an address confirmation (address_confirmations, unused and unexpired),
   * to file the request it confirms. Capture has verified the confirmation link itself.
   */
  openAddressConfirmation(args: {
    confirmationId: number;
    workspaceId: string;
  }): Promise<VaultResult<string>>;
  /**
   * Seals the address of an unused, unexpired address confirmation for the data request it is
   * about to file (dsr_requests.email_enc of `requestId`), from the confirmation's own row.
   */
  sealConfirmedAddress(args: {
    confirmationId: number;
    workspaceId: string;
    requestId: string;
  }): Promise<VaultResult<Sealed>>;
  /** A Member Center link minted from evidence, never from claims (rate-limited, recorded). */
  mintMemberLink(
    evidence: MemberLinkEvidence,
  ): Promise<VaultResult<{ memberId: string; token: string }[]>>;
}

/** Evidence site holds when it asks for goods links. */
export type GoodsLinkEvidence =
  /** A person asked for their library by address: the link goes by mail; rate-limited. */
  | { kind: 'library-request'; channelId: string; email: string }
  /** A goods order of the Channel paid in the last 24 hours (the thank-you page). */
  | { kind: 'order'; channelId: string; orderId: string };

/** Site's entrypoint: public pages, reader sign-in and checkout. */
export interface SiteVault extends Ping, ProxyOps<PersonPrincipal | PublicPrincipal>, MarkerOps {
  /** Verifies a join token for this Channel and opens its claims. */
  openJoinToken(args: { token: string; channelId: string }): Promise<
    VaultResult<{
      formId: string;
      memberId: string;
      email: string;
      journeyPath: string | null;
      issuedAt: number;
    }>
  >;
  mintGoodsLink(
    evidence: GoodsLinkEvidence,
  ): Promise<VaultResult<{ library: string; order: string; email: string } | null>>;
}

/** The principals jobs works under. */
export type JobsPrincipal = StoredPrincipal | CronPrincipal;

/** Jobs' entrypoint: exports, imports, bulk edits, Flows, data requests, webhooks, crons. */
export interface JobsVault
  extends Ping, FieldOps<JobsPrincipal>, ProxyOps<JobsPrincipal>, MarkerOps {
  /**
   * The marker forms of up to 500 addresses of one workspace (imports, bulk deletes), by
   * lowercased address. Counted per address against a larger limit than single lookups.
   */
  addressMarkersBulk(args: {
    workspaceId: string;
    emails: string[];
  }): Promise<VaultResult<Record<string, AddressMarkerSet>>>;
  /** Seals values for many Members of a Channel, each for its own row. */
  sealMemberFieldsBulk(
    principal: Extract<StoredPrincipal, { kind: 'import-job' | 'bulk-job' | 'flow-run' }>,
    args: { channelId: string; rows: { memberId: string; values: FieldMap }[] },
  ): Promise<VaultResult<Record<string, Record<string, Sealed>>>>;
  /** Opens a data request's address. Recorded in the workspace's audit log. */
  openDsrAddress(
    principal: Extract<StoredPrincipal, { kind: 'dsr-request' }>,
  ): Promise<VaultResult<string>>;
  /**
   * The data of every Member with the request's address in its workspace, with their fields
   * opened (engine buildMemberExport). Recorded in the workspace's audit log with a count.
   */
  buildDsrExport(
    principal: Extract<StoredPrincipal, { kind: 'dsr-request' }>,
  ): Promise<VaultResult<unknown>>;
  /** The `Swarm-Signature` header value for a delivery: current and, in its overlap, previous. */
  signWebhookDelivery(
    principal: Extract<StoredPrincipal, { kind: 'webhook-delivery' }>,
    args: { timestamp: number; body: string },
  ): Promise<VaultResult<{ signature: string }>>;
  /** The `Swarm-Signature` header value for a Flow webhook step. */
  signFlowWebhook(
    principal: Extract<StoredPrincipal, { kind: 'flow-run' }>,
    args: { timestamp: number; body: string },
  ): Promise<VaultResult<{ signature: string }>>;
  signDestinationRequest(
    principal: Extract<StoredPrincipal, { kind: 'export-destination' }>,
    args: { request: DestinationRequest },
  ): Promise<VaultResult<SignedDestinationRequest>>;
}

/** The interface a caller's VAULT binding has, by caller. */
export interface VaultFor {
  api: ApiVault;
  capture: CaptureVault;
  site: SiteVault;
  jobs: JobsVault;
}
