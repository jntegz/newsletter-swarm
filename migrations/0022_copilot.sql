-- Phase 8 Copilot: the workspace's own model key and the request log. Contract: docs/copilot.md;
-- constants in packages/domain/src/p8-copilot.ts. Conventions as in 0001_foundation.sql.

-- A workspace's own provider key (flag copilot_byok). One per workspace.
-- key_enc is JSON {workspaceId, apiKey} sealed with FIELD_KEYS ("<kid>.<iv>.<ciphertext>"); only
-- the last four characters are kept in clear, for display. No API response returns the key.
CREATE TABLE copilot_keys (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL UNIQUE REFERENCES workspaces (id) ON DELETE CASCADE,
  provider      TEXT NOT NULL CHECK (provider IN ('anthropic')),
  key_enc       TEXT NOT NULL,
  last4         TEXT NOT NULL CHECK (length(last4) = 4),
  created_by    TEXT REFERENCES operators (id) ON DELETE SET NULL,
  -- When the provider last accepted the key (on save).
  validated_at  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- One row per Copilot request: metadata only. The prompt, the selection and the output are never
-- stored. Written as 'pending' before the model is called, so the per-minute and monthly limits
-- count requests in flight; finished with tokens, latency and status.
CREATE TABLE copilot_requests (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id     TEXT REFERENCES channels (id) ON DELETE SET NULL,
  dispatch_id    TEXT REFERENCES dispatches (id) ON DELETE SET NULL,
  operator_id    TEXT REFERENCES operators (id) ON DELETE SET NULL,
  feature        TEXT NOT NULL CHECK (feature IN ('subject_lines', 'preview_text', 'rewrite', 'fix_grammar', 'translate', 'teaser')),
  key_source     TEXT NOT NULL CHECK (key_source IN ('platform', 'workspace')),
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled', 'refused')),
  error_code     TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  latency_ms     INTEGER,
  created_at     INTEGER NOT NULL,
  finished_at    INTEGER
);
-- The monthly allowance (platform key, per workspace) and the request log.
CREATE INDEX copilot_requests_by_workspace ON copilot_requests (workspace_id, key_source, created_at);
-- The per-minute limit (per operator).
CREATE INDEX copilot_requests_by_operator ON copilot_requests (operator_id, created_at);
