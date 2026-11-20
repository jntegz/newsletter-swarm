-- Phase 8 Copilot follow-ups: Share Kit social posts and Copilot actions (flag copilot_actions).
-- Contract: docs/copilot.md "Ask Copilot to do it" and docs/open-operator.md. SQLite can't change
-- a CHECK constraint in place, so the three tables are rebuilt with the wider value lists and
-- every row is copied unchanged (the agent log's hashes cover the values, not the table).
--
-- - copilot_requests.feature gains 'social_posts' (Share Kit) and 'actions'.
-- - agent_actions and agent_approvals gain principal_kind 'copilot' (an operator acting through
--   Copilot; principal_id is the operator's id) and agent_actions.source gains 'copilot'.
-- No table references these three, so dropping and renaming them touches no foreign key.

CREATE TABLE copilot_requests_new (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id     TEXT REFERENCES channels (id) ON DELETE SET NULL,
  dispatch_id    TEXT REFERENCES dispatches (id) ON DELETE SET NULL,
  operator_id    TEXT REFERENCES operators (id) ON DELETE SET NULL,
  feature        TEXT NOT NULL CHECK (feature IN ('subject_lines', 'preview_text', 'rewrite', 'fix_grammar', 'translate', 'teaser', 'social_posts', 'actions')),
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
INSERT INTO copilot_requests_new SELECT id, workspace_id, channel_id, dispatch_id, operator_id,
  feature, key_source, provider, model, status, error_code, input_tokens, output_tokens,
  latency_ms, created_at, finished_at FROM copilot_requests;
DROP TABLE copilot_requests;
ALTER TABLE copilot_requests_new RENAME TO copilot_requests;
CREATE INDEX copilot_requests_by_workspace ON copilot_requests (workspace_id, key_source, created_at);
CREATE INDEX copilot_requests_by_operator ON copilot_requests (operator_id, created_at);

CREATE TABLE agent_actions_new (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('mcp', 'approval', 'copilot')),
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('key', 'oauth', 'copilot')),
  principal_id   TEXT NOT NULL,
  client_name    TEXT,
  client_version TEXT,
  tool           TEXT NOT NULL,
  channel_id     TEXT,
  risk           TEXT CHECK (risk IN ('read', 'write', 'destructive')),
  arguments_json TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'denied', 'pending_approval')),
  status_code    INTEGER,
  error_code     TEXT,
  latency_ms     INTEGER NOT NULL,
  approval_id    TEXT,
  created_at     INTEGER NOT NULL,
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL,
  UNIQUE (workspace_id, seq)
);
INSERT INTO agent_actions_new SELECT id, workspace_id, seq, source, principal_kind, principal_id,
  client_name, client_version, tool, channel_id, risk, arguments_json, outcome, status_code,
  error_code, latency_ms, approval_id, created_at, prev_hash, hash FROM agent_actions;
DROP TABLE agent_actions;
ALTER TABLE agent_actions_new RENAME TO agent_actions;
CREATE INDEX agent_actions_by_workspace_time ON agent_actions (workspace_id, created_at);
CREATE INDEX agent_actions_by_principal ON agent_actions (principal_id, seq);

CREATE TABLE agent_approvals_new (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  action_id          TEXT NOT NULL,
  principal_kind     TEXT NOT NULL CHECK (principal_kind IN ('key', 'oauth', 'copilot')),
  principal_id       TEXT NOT NULL,
  client_name        TEXT,
  client_version     TEXT,
  tool               TEXT NOT NULL,
  scope              TEXT NOT NULL,
  risk               TEXT NOT NULL CHECK (risk IN ('read', 'write', 'destructive')),
  channel_id         TEXT,
  method             TEXT NOT NULL,
  path               TEXT NOT NULL,
  body_json          TEXT,
  arguments_json     TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'executed', 'failed', 'rejected', 'canceled')),
  expires_at         INTEGER NOT NULL,
  decided_by         TEXT REFERENCES operators (id) ON DELETE SET NULL,
  decided_at         INTEGER,
  reason             TEXT,
  result_status      INTEGER,
  result_json        TEXT,
  executed_action_id TEXT,
  created_at         INTEGER NOT NULL
);
INSERT INTO agent_approvals_new SELECT id, workspace_id, action_id, principal_kind, principal_id,
  client_name, client_version, tool, scope, risk, channel_id, method, path, body_json,
  arguments_json, status, expires_at, decided_by, decided_at, reason, result_status, result_json,
  executed_action_id, created_at FROM agent_approvals;
DROP TABLE agent_approvals;
ALTER TABLE agent_approvals_new RENAME TO agent_approvals;
CREATE INDEX agent_approvals_by_workspace ON agent_approvals (workspace_id, status, created_at);
CREATE INDEX agent_approvals_by_principal ON agent_approvals (principal_id, status);
CREATE INDEX agent_approvals_pending_expiry ON agent_approvals (expires_at) WHERE status = 'pending';
