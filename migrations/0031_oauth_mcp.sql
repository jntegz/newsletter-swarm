-- Phase 8 follow-up: OAuth for MCP clients. RFC 8707 audience binding of grants and OAuth Client
-- ID Metadata Documents. Contract: docs/oauth.md ("Resource indicators", "Client ID Metadata
-- Documents"). Conventions as in 0001_foundation.sql.

-- The resource a grant (and every token issued from it) is bound to: 'v2' (the public API) or
-- 'mcp' (the Open Operator MCP server). Grants made before this migration are /v2 grants.
ALTER TABLE oauth_grants ADD COLUMN resource TEXT NOT NULL DEFAULT 'v2' CHECK (resource IN ('v2', 'mcp'));

-- An OAuth app row made for a Client ID Metadata Document client when an operator allows it on a
-- workspace: one per (workspace, document URL). Its client_id is a synthetic `swm_…` value that
-- is never shown; the client identifies itself with metadata_url. NULL for registered apps.
ALTER TABLE oauth_apps ADD COLUMN metadata_url TEXT;
CREATE UNIQUE INDEX oauth_apps_by_metadata_url ON oauth_apps (workspace_id, metadata_url)
  WHERE metadata_url IS NOT NULL;

-- Fetched Client ID Metadata Documents (and failed fetches, so a bad URL is not fetched again
-- at once). Shared by every workspace; fetched only for a signed-in operator on the consent
-- step. The daily cron drops rows long past expires_at.
CREATE TABLE oauth_client_documents (
  url                 TEXT PRIMARY KEY CHECK (length(url) <= 2000),
  status              TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  -- For 'ok': client_name, client_uri, redirect_uris from the document. For 'error': why.
  name                TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 80),
  client_uri          TEXT,
  redirect_uris_json  TEXT CHECK (redirect_uris_json IS NULL OR json_valid(redirect_uris_json)),
  error               TEXT,
  fetched_by          TEXT REFERENCES operators (id) ON DELETE SET NULL,
  fetched_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL
);
-- The per-operator fetch limit counts recent fetches.
CREATE INDEX oauth_client_documents_by_operator ON oauth_client_documents (fetched_by, fetched_at);
CREATE INDEX oauth_client_documents_by_expiry ON oauth_client_documents (expires_at);
