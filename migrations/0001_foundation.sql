-- Swarm schema v1: workspaces, operators, seats, channels, sessions, QuickPass, OAuth, audit, flags, media.
--
-- Conventions (docs/architecture.md, "Database"):
--   * ids are prefixed UUIDv7 text (ws_, op_, ch_, ...)
--   * timestamps are integer milliseconds since the epoch
--   * every email column is COLLATE NOCASE
--   * channel- and workspace-scoped rows cascade with their owner

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  plan        TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'scale', 'enterprise')),
  region      TEXT NOT NULL DEFAULT 'global' CHECK (region IN ('global', 'eu')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- People who sign in to the dashboard.
CREATE TABLE operators (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name        TEXT CHECK (name IS NULL OR length(name) <= 80),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- An operator's role in a workspace.
CREATE TABLE seats (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  operator_id   TEXT NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'author', 'viewer')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, operator_id)
);
CREATE INDEX seats_by_operator ON seats (operator_id);

CREATE TABLE channels (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  slug           TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 3 AND 48),
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description    TEXT CHECK (description IS NULL OR length(description) <= 280),
  branding_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(branding_json)),
  settings_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX channels_by_workspace ON channels (workspace_id, created_at) WHERE deleted_at IS NULL;

-- Per-channel override of an operator's workspace seat role.
CREATE TABLE channel_roles (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  operator_id  TEXT NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'author', 'viewer')),
  created_at   INTEGER NOT NULL,
  UNIQUE (channel_id, operator_id)
);
CREATE INDEX channel_roles_by_operator ON channel_roles (operator_id);

-- Dashboard sessions. Only a hash of the cookie secret is stored.
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  operator_id   TEXT NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  user_agent    TEXT,
  ip_prefix     TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE INDEX sessions_by_operator ON sessions (operator_id, created_at);

-- QuickPass sign-in links. Consumed atomically:
--   UPDATE quickpass_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING ...
CREATE TABLE quickpass_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  email        TEXT NOT NULL COLLATE NOCASE,
  ip_prefix    TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER
);
CREATE INDEX quickpass_tokens_by_email ON quickpass_tokens (email, created_at);

CREATE TABLE oauth_identities (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL CHECK (provider IN ('google')),
  subject         TEXT NOT NULL,
  operator_id     TEXT NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  email           TEXT NOT NULL COLLATE NOCASE,
  email_verified  INTEGER NOT NULL CHECK (email_verified IN (0, 1)),
  created_at      INTEGER NOT NULL,
  UNIQUE (provider, subject)
);
CREATE INDEX oauth_identities_by_operator ON oauth_identities (operator_id);

-- Tamper-evident audit trail: hash = sha256(prev_hash || canonical event), sequenced per workspace.
CREATE TABLE audit_events (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  actor_operator_id  TEXT REFERENCES operators (id) ON DELETE SET NULL,
  action             TEXT NOT NULL,
  target_type        TEXT,
  target_id          TEXT,
  metadata_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  ip_prefix          TEXT,
  created_at         INTEGER NOT NULL,
  prev_hash          TEXT NOT NULL,
  hash               TEXT NOT NULL,
  UNIQUE (workspace_id, seq)
);
CREATE INDEX audit_events_by_workspace_time ON audit_events (workspace_id, created_at);

-- Feature flag overrides. Absent rows mean "off" (the registry default).
CREATE TABLE feature_flags (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('platform', 'workspace', 'channel')),
  scope_id    TEXT,
  enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_by  TEXT REFERENCES operators (id) ON DELETE SET NULL,
  updated_at  INTEGER NOT NULL,
  CHECK ((scope = 'platform' AND scope_id IS NULL) OR (scope <> 'platform' AND scope_id IS NOT NULL))
);
CREATE UNIQUE INDEX feature_flags_unique_scope ON feature_flags (key, scope, ifnull(scope_id, ''));
CREATE INDEX feature_flags_by_scope ON feature_flags (scope, scope_id);

-- Uploaded files in R2. content_type is sniffed server-side, never taken from the client.
CREATE TABLE media (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id    TEXT REFERENCES channels (id) ON DELETE SET NULL,
  r2_key        TEXT NOT NULL UNIQUE,
  content_type  TEXT NOT NULL,
  bytes         INTEGER NOT NULL CHECK (bytes > 0),
  width         INTEGER,
  height        INTEGER,
  focal_x       REAL CHECK (focal_x IS NULL OR focal_x BETWEEN 0 AND 1),
  focal_y       REAL CHECK (focal_y IS NULL OR focal_y BETWEEN 0 AND 1),
  alt_text      TEXT,
  visibility    TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  created_by    TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX media_by_channel ON media (channel_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX media_by_workspace ON media (workspace_id, created_at) WHERE deleted_at IS NULL;
