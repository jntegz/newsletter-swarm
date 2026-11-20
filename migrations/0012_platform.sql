-- Phase 7: the public API (scoped keys, OAuth apps), Event Webhooks, the Direct Send API, the
-- Privacy Center, account security (passkeys, TOTP, SSO), the Deliverability Center (DMARC
-- aggregate reports) and export destinations. Contracts: docs/architecture.md "Platform (Phase 7)"
-- and packages/domain/src/p7-platform.ts. Conventions as in 0001_foundation.sql.
-- workspaces.region already exists (0001); Phase 7 does not add a second database.

-- ---------------------------------------------------------------------------------------------
-- Open API v2: scoped keys

-- The secret is `sk_live_<prefix><secret>`; only sha256(secret) is stored. `prefix` is the first
-- 8 characters after sk_live_, shown in the dashboard so a key can be recognised.
CREATE TABLE api_keys (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- NULL = every Channel in the workspace; otherwise a JSON array of Channel ids.
  channel_ids_json TEXT CHECK (channel_ids_json IS NULL OR json_valid(channel_ids_json)),
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  prefix         TEXT NOT NULL,
  secret_hash    TEXT NOT NULL UNIQUE,
  scopes_json    TEXT NOT NULL CHECK (json_valid(scopes_json)),
  -- JSON array of CIDR strings (IPv4 or IPv6); NULL = any address.
  ip_allowlist_json TEXT CHECK (ip_allowlist_json IS NULL OR json_valid(ip_allowlist_json)),
  -- Requests per minute for this key; NULL = the plan's limit. Never above the plan's limit.
  rate_cap       INTEGER CHECK (rate_cap IS NULL OR rate_cap > 0),
  expires_at     INTEGER,
  last_used_at   INTEGER,
  last_used_ip_prefix TEXT,
  created_by     TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  revoked_at     INTEGER
);
CREATE INDEX api_keys_by_workspace ON api_keys (workspace_id, created_at);

-- Idempotency-Key replay store for /v2 writes (24 hours). Scoped to the principal (key or token).
CREATE TABLE api_idempotency (
  principal      TEXT NOT NULL,
  key            TEXT NOT NULL,
  method         TEXT NOT NULL,
  path           TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  status         INTEGER NOT NULL,
  response_json  TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (principal, key)
) WITHOUT ROWID;
CREATE INDEX api_idempotency_by_time ON api_idempotency (created_at);

-- ---------------------------------------------------------------------------------------------
-- OAuth2 (authorization code + PKCE S256 only) for third-party apps

-- An app registered by a workspace. Public clients have no secret (PKCE only); confidential
-- clients also authenticate with a secret (hash stored).
CREATE TABLE oauth_apps (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  client_id           TEXT NOT NULL UNIQUE,
  client_secret_hash  TEXT,
  redirect_uris_json  TEXT NOT NULL CHECK (json_valid(redirect_uris_json)),
  scopes_json         TEXT NOT NULL CHECK (json_valid(scopes_json)),
  homepage_url        TEXT,
  created_by          TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  revoked_at          INTEGER
);
CREATE INDEX oauth_apps_by_workspace ON oauth_apps (workspace_id);

-- A consent: an operator granted an app scopes on a workspace (optionally limited to Channels).
-- Authorization codes are single-use (code_hash consumed atomically), 60 seconds.
CREATE TABLE oauth_grants (
  id                    TEXT PRIMARY KEY,
  app_id                TEXT NOT NULL REFERENCES oauth_apps (id) ON DELETE CASCADE,
  workspace_id          TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  operator_id           TEXT REFERENCES operators (id) ON DELETE SET NULL,
  channel_ids_json      TEXT CHECK (channel_ids_json IS NULL OR json_valid(channel_ids_json)),
  scopes_json           TEXT NOT NULL CHECK (json_valid(scopes_json)),
  code_hash             TEXT UNIQUE,
  code_challenge        TEXT,
  redirect_uri          TEXT,
  code_expires_at       INTEGER,
  code_consumed_at      INTEGER,
  created_at            INTEGER NOT NULL,
  revoked_at            INTEGER
);
CREATE INDEX oauth_grants_by_app ON oauth_grants (app_id);
CREATE INDEX oauth_grants_by_workspace ON oauth_grants (workspace_id);

-- Access (1 hour) and refresh (30 days, rotated on every use) tokens. `family_id` links every
-- refresh token issued from one grant; presenting a used refresh token revokes the family.
CREATE TABLE oauth_tokens (
  id            TEXT PRIMARY KEY,
  grant_id      TEXT NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
  family_id     TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER,
  last_used_at  INTEGER,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE INDEX oauth_tokens_by_family ON oauth_tokens (family_id);

-- ---------------------------------------------------------------------------------------------
-- Event Webhooks

CREATE TABLE webhook_endpoints (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- NULL = events from every Channel in the workspace.
  channel_id          TEXT REFERENCES channels (id) ON DELETE CASCADE,
  url                 TEXT NOT NULL,
  description         TEXT,
  events_json         TEXT NOT NULL CHECK (json_valid(events_json)),
  -- Sealed with FIELD_KEYS. During rotation the previous secret signs too, until it expires.
  secret_enc          TEXT NOT NULL,
  previous_secret_enc TEXT,
  previous_expires_at INTEGER,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  disabled_reason     TEXT,
  -- Consecutive failed deliveries (reset on success); auto-disable reads it with first_failure_at.
  failure_count       INTEGER NOT NULL DEFAULT 0,
  first_failure_at    INTEGER,
  created_by          TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX webhook_endpoints_by_workspace ON webhook_endpoints (workspace_id, status);

-- One row per (event, endpoint). Attempts update the row; redrive creates a new attempt on the
-- same row (idempotent on event_id: receivers see the same Swarm-Event-Id).
CREATE TABLE webhook_deliveries (
  id                TEXT PRIMARY KEY,
  endpoint_id       TEXT NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  workspace_id      TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  event_id          TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  payload_json      TEXT NOT NULL CHECK (json_valid(payload_json)),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'succeeded', 'failed', 'retrying', 'canceled')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER,
  response_status   INTEGER,
  response_excerpt  TEXT,
  latency_ms        INTEGER,
  error             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX webhook_deliveries_by_endpoint ON webhook_deliveries (endpoint_id, created_at);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE status = 'retrying';

-- Outbox for webhook events that are not member events (dispatch.*, broadcast.completed,
-- flow.completed, member.deleted, …). Member events are read from member_events with their own
-- cursor. Pruned after 30 days; erasure removes a Member's rows.
CREATE TABLE platform_events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  TEXT NOT NULL,
  channel_id    TEXT,
  member_id     TEXT,
  type          TEXT NOT NULL,
  payload_json  TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at    INTEGER NOT NULL
);
CREATE INDEX platform_events_by_member ON platform_events (member_id) WHERE member_id IS NOT NULL;

-- Read positions of consumers that follow member_events or platform_events by seq
-- ('webhooks:member_events', 'webhooks:platform_events', 'exports:<destination id>', …).
CREATE TABLE event_cursors (
  name        TEXT PRIMARY KEY,
  value       INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------------------------
-- Direct Send API: one message to one Member from a template, outside Broadcasts.

CREATE TABLE direct_sends (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id       TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  member_id        TEXT REFERENCES members (id) ON DELETE SET NULL,
  template_id      TEXT REFERENCES templates (id) ON DELETE SET NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('transactional', 'one_off')),
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'sent', 'delivered', 'bounced', 'complained', 'suppressed', 'failed')),
  provider_message_id TEXT,
  error            TEXT,
  api_key_id       TEXT,
  created_at       INTEGER NOT NULL,
  sent_at          INTEGER,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX direct_sends_by_channel ON direct_sends (channel_id, created_at);
CREATE INDEX direct_sends_by_message ON direct_sends (provider_message_id);

-- ---------------------------------------------------------------------------------------------
-- Privacy Center: data-subject requests (export or erase)

CREATE TABLE dsr_requests (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id      TEXT REFERENCES channels (id) ON DELETE SET NULL,
  -- Kept after erasure as NULL; the request keeps only the address hash.
  member_id       TEXT REFERENCES members (id) ON DELETE SET NULL,
  email_hash      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('export', 'erase')),
  source          TEXT NOT NULL CHECK (source IN ('member_center', 'operator', 'api')),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'completed', 'rejected', 'failed')),
  -- SLA: export 24 hours, erase 30 days (GDPR art. 12(3) is one month).
  due_at          INTEGER NOT NULL,
  export_key      TEXT,
  export_expires_at INTEGER,
  note            TEXT,
  handled_by      TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
CREATE INDEX dsr_requests_by_workspace ON dsr_requests (workspace_id, status, due_at);

-- An erased address stays suppressed by hash: sha256(lower(email)) per workspace. `email` of an
-- erased row is rewritten to 'erased+<id>@invalid' so the UNIQUE(workspace_id, email) still holds.
ALTER TABLE suppressions ADD COLUMN email_hash TEXT;
CREATE UNIQUE INDEX suppressions_by_hash ON suppressions (workspace_id, email_hash) WHERE email_hash IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Account security

CREATE TABLE passkeys (
  id              TEXT PRIMARY KEY,
  operator_id     TEXT NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  credential_id   TEXT NOT NULL UNIQUE,
  public_key      TEXT NOT NULL,
  counter         INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT CHECK (transports_json IS NULL OR json_valid(transports_json)),
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  backed_up       INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0, 1)),
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER
);
CREATE INDEX passkeys_by_operator ON passkeys (operator_id);

-- Single-use WebAuthn challenges (5 minutes), consumed atomically.
CREATE TABLE webauthn_challenges (
  id            TEXT PRIMARY KEY,
  operator_id   TEXT REFERENCES operators (id) ON DELETE CASCADE,
  purpose       TEXT NOT NULL CHECK (purpose IN ('register', 'authenticate')),
  challenge     TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed_at   INTEGER
);

-- One TOTP secret per operator, sealed with FIELD_KEYS; confirmed once a code is verified.
CREATE TABLE totp_secrets (
  operator_id   TEXT PRIMARY KEY REFERENCES operators (id) ON DELETE CASCADE,
  secret_enc    TEXT NOT NULL,
  confirmed_at  INTEGER,
  -- The last accepted time step: a code is never accepted twice.
  last_step     INTEGER,
  created_at    INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE recovery_codes (
  id            TEXT PRIMARY KEY,
  operator_id   TEXT NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  code_hash     TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  used_at       INTEGER
);
CREATE INDEX recovery_codes_by_operator ON recovery_codes (operator_id);

-- A session created by a first factor waits here for the second one (mfa_pending = 1) and can
-- only call the second-factor endpoints until it is verified.
ALTER TABLE sessions ADD COLUMN mfa_pending INTEGER NOT NULL DEFAULT 0 CHECK (mfa_pending IN (0, 1));
ALTER TABLE sessions ADD COLUMN mfa_method TEXT CHECK (mfa_method IS NULL OR mfa_method IN ('passkey', 'totp', 'recovery', 'sso'));
-- 'all' = every seat must use a second factor; owners and admins always must.
ALTER TABLE workspaces ADD COLUMN require_2fa TEXT NOT NULL DEFAULT 'admins' CHECK (require_2fa IN ('admins', 'all'));

-- SSO (Pro and up): OIDC or SAML per workspace, with domain capture and just-in-time seats.
CREATE TABLE sso_connections (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  protocol          TEXT NOT NULL CHECK (protocol IN ('oidc', 'saml')),
  -- Email domains captured: sign-in for these addresses goes to this connection.
  domains_json      TEXT NOT NULL CHECK (json_valid(domains_json)),
  -- oidc: {issuer, clientId, clientSecretEnc}; saml: {entityId, ssoUrl, certificatePem}
  config_json       TEXT NOT NULL CHECK (json_valid(config_json)),
  jit_role          TEXT CHECK (jit_role IS NULL OR jit_role IN ('admin', 'editor', 'author', 'viewer')),
  enforced          INTEGER NOT NULL DEFAULT 0 CHECK (enforced IN (0, 1)),
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'disabled')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX sso_connections_by_workspace ON sso_connections (workspace_id);

ALTER TABLE oauth_identities RENAME TO oauth_identities_old;
CREATE TABLE oauth_identities (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL CHECK (provider IN ('google', 'sso')),
  subject         TEXT NOT NULL,
  operator_id     TEXT NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  email           TEXT NOT NULL COLLATE NOCASE,
  email_verified  INTEGER NOT NULL CHECK (email_verified IN (0, 1)),
  -- For provider 'sso': the connection; subject is the IdP's subject (NameID or sub).
  sso_connection_id TEXT REFERENCES sso_connections (id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL
);
INSERT INTO oauth_identities (id, provider, subject, operator_id, email, email_verified, created_at)
  SELECT id, provider, subject, operator_id, email, email_verified, created_at FROM oauth_identities_old;
DROP TABLE oauth_identities_old;
-- ifnull: NULL connection ids (Google) would otherwise never collide.
CREATE UNIQUE INDEX oauth_identities_unique_subject
  ON oauth_identities (provider, ifnull(sso_connection_id, ''), subject);
CREATE INDEX oauth_identities_by_operator ON oauth_identities (operator_id);

-- ---------------------------------------------------------------------------------------------
-- Deliverability Center: DMARC aggregate reports (rua=mailto:dmarc+<domainId>@<platform>)

CREATE TABLE dmarc_reports (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  sending_domain_id TEXT NOT NULL REFERENCES sending_domains (id) ON DELETE CASCADE,
  org_name         TEXT NOT NULL,
  report_id        TEXT NOT NULL,
  begin_at         INTEGER NOT NULL,
  end_at           INTEGER NOT NULL,
  policy_json      TEXT NOT NULL CHECK (json_valid(policy_json)),
  -- The raw file in R2 REPORTS.
  raw_key          TEXT NOT NULL,
  message_count    INTEGER NOT NULL,
  pass_count       INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  UNIQUE (sending_domain_id, org_name, report_id)
);
CREATE INDEX dmarc_reports_by_domain ON dmarc_reports (sending_domain_id, begin_at);

CREATE TABLE dmarc_records (
  id               TEXT PRIMARY KEY,
  report_id        TEXT NOT NULL REFERENCES dmarc_reports (id) ON DELETE CASCADE,
  source_ip        TEXT NOT NULL,
  count            INTEGER NOT NULL,
  disposition      TEXT NOT NULL CHECK (disposition IN ('none', 'quarantine', 'reject')),
  dkim_aligned     INTEGER NOT NULL CHECK (dkim_aligned IN (0, 1)),
  spf_aligned      INTEGER NOT NULL CHECK (spf_aligned IN (0, 1)),
  header_from      TEXT NOT NULL,
  dkim_domain      TEXT,
  spf_domain       TEXT
);
CREATE INDEX dmarc_records_by_report ON dmarc_records (report_id);

-- Dedicated sending (paid plans: own configuration set; Pro and up: a dedicated IP pool).
ALTER TABLE channels ADD COLUMN ses_configuration_set TEXT;
ALTER TABLE channels ADD COLUMN dedicated_ip_pool TEXT;
ALTER TABLE channels ADD COLUMN dedicated_ip_status TEXT NOT NULL DEFAULT 'none'
  CHECK (dedicated_ip_status IN ('none', 'requested', 'warming', 'active'));

-- ---------------------------------------------------------------------------------------------
-- Incremental exports to the operator's own R2 or S3 bucket

CREATE TABLE export_destinations (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id       TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('s3', 'r2')),
  -- {endpoint?, region, bucket, prefix}; credentials sealed with FIELD_KEYS in credentials_enc.
  config_json      TEXT NOT NULL CHECK (json_valid(config_json)),
  credentials_enc  TEXT NOT NULL,
  schedule         TEXT NOT NULL DEFAULT 'daily' CHECK (schedule IN ('hourly', 'daily')),
  -- What has been exported so far: {members: <updated_at ms>, events: <member_events.seq>}.
  cursor_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'failing')),
  last_run_at      INTEGER,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX export_destinations_by_channel ON export_destinations (channel_id);

-- ---------------------------------------------------------------------------------------------
-- Phase 6 gap: Flow builder steps that are not set up yet are saved with the draft (outside the
-- validated graph) so leaving the page doesn't lose them. Publishing refuses while any remain.
ALTER TABLE flows ADD COLUMN draft_pending_json TEXT CHECK (draft_pending_json IS NULL OR json_valid(draft_pending_json));
