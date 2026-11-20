-- Phase 1: team invites. Only a hash of the invite token is stored.
CREATE TABLE invites (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email         TEXT NOT NULL COLLATE NOCASE,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'author', 'viewer')),
  token_hash    TEXT NOT NULL UNIQUE,
  invited_by    TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  accepted_at   INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX invites_by_workspace ON invites (workspace_id, created_at);

-- Sessions are looked up by token hash on every request and listed per operator.
CREATE INDEX sessions_active_by_operator ON sessions (operator_id, expires_at) WHERE revoked_at IS NULL;

-- Rate checks count recent QuickPass requests per email.
CREATE INDEX quickpass_tokens_recent ON quickpass_tokens (created_at);
