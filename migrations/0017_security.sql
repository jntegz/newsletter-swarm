-- Phase 7 account security, on top of 0012_platform.sql: the second-factor grace period, step-up
-- checks, attempt limits, how a session was signed in (for enforced SSO) and SSO domain proofs.
-- Contract: docs/security.md "Account security"; constants in packages/domain/src/p7-security.ts.

-- When a second factor first became required for this operator (an owner or admin seat, or any
-- seat in a workspace with require_2fa = 'all') while they had none. MFA_GRACE_DAYS after it,
-- their sessions must enrol. Cleared when nothing requires it any more.
ALTER TABLE operators ADD COLUMN mfa_required_since INTEGER;

-- When this session last proved a second factor: removing or adding a factor, or regenerating
-- recovery codes, needs one within MFA_STEP_UP_MINUTES.
ALTER TABLE sessions ADD COLUMN mfa_verified_at INTEGER;
-- The first factor: 'quickpass', 'google' or 'sso'. NULL for sessions created before Phase 7.
ALTER TABLE sessions ADD COLUMN auth_method TEXT
  CHECK (auth_method IS NULL OR auth_method IN ('quickpass', 'google', 'sso'));
-- For auth_method 'sso': the connection, so an enforced connection admits only its own sessions.
ALTER TABLE sessions ADD COLUMN sso_connection_id TEXT REFERENCES sso_connections (id) ON DELETE SET NULL;
CREATE INDEX sessions_by_operator_seen ON sessions (operator_id, last_seen_at);

-- Failed second-factor attempts, counted per session and per operator inside their windows
-- (MFA_ATTEMPTS_* in p7-security.ts). Rows older than a day are deleted on the next failure.
CREATE TABLE mfa_attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_id   TEXT NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('passkey', 'totp', 'recovery')),
  created_at    INTEGER NOT NULL
);
CREATE INDEX mfa_attempts_by_operator ON mfa_attempts (operator_id, created_at);
CREATE INDEX mfa_attempts_by_session ON mfa_attempts (session_id, created_at);

-- Domains an SSO connection claims. A claim captures sign-in only once its TXT record is verified,
-- and one domain can be verified for one connection on the whole platform. Unverified claims
-- never block anyone, so nobody can squat a domain they cannot prove.
-- sso_connections.domains_json mirrors the verified domain names.
CREATE TABLE sso_domains (
  id                  TEXT PRIMARY KEY,
  connection_id       TEXT NOT NULL REFERENCES sso_connections (id) ON DELETE CASCADE,
  workspace_id        TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  domain              TEXT NOT NULL COLLATE NOCASE,
  verification_token  TEXT NOT NULL,
  verified_at         INTEGER,
  created_at          INTEGER NOT NULL,
  UNIQUE (connection_id, domain)
);
CREATE UNIQUE INDEX sso_domains_verified ON sso_domains (domain) WHERE verified_at IS NOT NULL;
CREATE INDEX sso_domains_by_workspace ON sso_domains (workspace_id);
