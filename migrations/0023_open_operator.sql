-- Phase 8 Open Operator: MCP settings, the agent audit log and approvals. Contract:
-- docs/open-operator.md. Conventions as in 0001_foundation.sql (ms timestamps, prefixed ids).

-- One row per workspace, written on first save; without it the defaults apply.
CREATE TABLE agent_settings (
  workspace_id       TEXT PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  mcp_enabled        INTEGER NOT NULL DEFAULT 1 CHECK (mcp_enabled IN (0, 1)),
  approval_mode      TEXT NOT NULL DEFAULT 'destructive'
                     CHECK (approval_mode IN ('never', 'destructive', 'writes')),
  approval_ttl_hours INTEGER NOT NULL DEFAULT 24 CHECK (approval_ttl_hours BETWEEN 1 AND 72),
  updated_by         TEXT REFERENCES operators (id) ON DELETE SET NULL,
  updated_at         INTEGER NOT NULL
);

-- Every tool call, written once after it finishes and never updated. Tamper-evident like
-- audit_events: hash = sha256(prev_hash || "\n" || canonical row), sequenced per workspace.
-- principal_id is an api_keys id or an oauth_grants id (no foreign key: the log outlives both).
CREATE TABLE agent_actions (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('mcp', 'approval')),
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('key', 'oauth')),
  principal_id   TEXT NOT NULL,
  client_name    TEXT,
  client_version TEXT,
  tool           TEXT NOT NULL,
  channel_id     TEXT,
  risk           TEXT CHECK (risk IN ('read', 'write', 'destructive')),
  -- The masked argument summary (docs/open-operator.md "Masking").
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
CREATE INDEX agent_actions_by_workspace_time ON agent_actions (workspace_id, created_at);
CREATE INDEX agent_actions_by_principal ON agent_actions (principal_id, seq);

-- Where verification of a workspace's agent log starts after retention pruned its oldest rows.
CREATE TABLE agent_action_anchors (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  hash          TEXT NOT NULL,
  pruned_before INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- A held tool call. `expired` is computed (pending and past expires_at). body_json holds the exact
-- JSON body that runs on approval and is cleared once the approval is decided, expires or is
-- touched by an erasure.
CREATE TABLE agent_approvals (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  action_id          TEXT NOT NULL,
  principal_kind     TEXT NOT NULL CHECK (principal_kind IN ('key', 'oauth')),
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
CREATE INDEX agent_approvals_by_workspace ON agent_approvals (workspace_id, status, created_at);
CREATE INDEX agent_approvals_by_principal ON agent_approvals (principal_id, status);
CREATE INDEX agent_approvals_pending_expiry ON agent_approvals (expires_at) WHERE status = 'pending';
