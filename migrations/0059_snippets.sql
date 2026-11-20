-- Blocks an owner saves to reuse in later posts, and a custom email design is held in the Channel's
-- settings. A snippet is copied into a post when inserted, so editing it later can't change an email
-- that has already gone out.
CREATE TABLE snippets (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  content_json TEXT NOT NULL,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX snippets_by_channel ON snippets (channel_id, name);
