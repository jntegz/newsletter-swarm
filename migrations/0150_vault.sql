-- The vault Worker's own tables (workers/vault, docs/security.md "The vault"). It alone holds
-- FIELD_KEYS and the keys for Member Center and goods links, and records here what it did.
--
-- vault_audit: one row per refusal, rate-limit hit and bulk open (exports, data requests,
-- destination runs), install-wide. Never a value or a credential: the caller (the entrypoint the
-- request came through), the operation, the kind and id of the principal (a Member only as a
-- hash, packages/vault/src/core/audit.ts subjectHash), the tenant, the decision and a count.
-- Pruned after 90 days by the vault's cron.
CREATE TABLE vault_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      INTEGER NOT NULL,
  caller          TEXT NOT NULL CHECK (caller IN ('api', 'capture', 'site', 'jobs', 'vault')),
  op              TEXT NOT NULL CHECK (length(op) BETWEEN 1 AND 60),
  principal_kind  TEXT NOT NULL CHECK (length(principal_kind) BETWEEN 1 AND 40),
  principal_id    TEXT CHECK (principal_id IS NULL OR length(principal_id) <= 120),
  workspace_id    TEXT,
  channel_id      TEXT,
  decision        TEXT NOT NULL CHECK (decision IN ('allowed', 'refused', 'rate_limited', 'failed')),
  reason          TEXT CHECK (reason IS NULL OR length(reason) <= 120),
  count           INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0)
);
CREATE INDEX vault_audit_by_time ON vault_audit (created_at);
CREATE INDEX vault_audit_by_workspace ON vault_audit (workspace_id, created_at);

-- vault_mints: every link the vault signed for a caller (Member Center and goods links), by
-- subject, always hashed (subjectHash): the Member, the order, or a Channel and address for a
-- goods library request, so neither table holds Member data. Pruned after 90 days.
CREATE TABLE vault_mints (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    INTEGER NOT NULL,
  caller        TEXT NOT NULL CHECK (caller IN ('api', 'capture', 'site', 'jobs')),
  kind          TEXT NOT NULL CHECK (kind IN ('member', 'goods-library', 'goods-order')),
  evidence      TEXT NOT NULL CHECK (length(evidence) BETWEEN 1 AND 40),
  subject       TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 120),
  channel_id    TEXT NOT NULL
);
CREATE INDEX vault_mints_by_subject ON vault_mints (subject, kind, created_at);
CREATE INDEX vault_mints_by_channel ON vault_mints (channel_id, kind, created_at);
CREATE INDEX vault_mints_by_time ON vault_mints (created_at);

-- vault_rate: fixed-window counters for the vault's other limits (address-marker lookups,
-- public proxy calls), by scope and the sha256 of the subject. Race-safe as one upsert; pruned
-- after two days.
CREATE TABLE vault_rate (
  scope         TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 60),
  subject_hash  TEXT NOT NULL CHECK (length(subject_hash) = 64),
  window_start  INTEGER NOT NULL,
  used          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, subject_hash)
);
CREATE INDEX vault_rate_by_window ON vault_rate (window_start);
