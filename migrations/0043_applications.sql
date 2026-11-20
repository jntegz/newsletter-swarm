-- Other products a workspace connects (docs/applications.md). The key is sealed with FIELD_KEYS.
CREATE TABLE app_connections (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  app           TEXT NOT NULL CHECK (app IN ('shorthop')),
  base_url      TEXT NOT NULL,
  key_enc       TEXT NOT NULL,
  last4         TEXT NOT NULL,
  slug_format   TEXT NOT NULL,
  domain        TEXT,
  created_by    TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, app)
);

-- Short links already made, so the same address in the same post gets the same link. Post '' is a
-- link made outside a post (a website page).
CREATE TABLE app_short_links (
  connection_id TEXT NOT NULL REFERENCES app_connections (id) ON DELETE CASCADE,
  post_id       TEXT NOT NULL,
  url           TEXT NOT NULL,
  short_url     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (connection_id, post_id, url)
);
