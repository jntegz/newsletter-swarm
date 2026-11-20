-- Website themes (docs/site-themes.md): each Channel's site design as a draft the dashboard saves
-- as it changes, and the published copy the site renders. A design is JSON: { theme, files,
-- settings, sections }, files null for a built-in theme's. The site reads published_json and
-- published_version in one row; the version goes up on every publish, so parsed themes can be
-- cached per version. A Channel without a row keeps its old template settings until the first save.
CREATE TABLE site_designs (
  channel_id        TEXT PRIMARY KEY REFERENCES channels (id) ON DELETE CASCADE,
  draft_json        TEXT NOT NULL CHECK (json_valid(draft_json)),
  draft_updated_by  TEXT REFERENCES operators (id) ON DELETE SET NULL,
  draft_updated_at  INTEGER NOT NULL,
  published_json    TEXT CHECK (published_json IS NULL OR json_valid(published_json)),
  published_version INTEGER NOT NULL DEFAULT 0,
  published_by      TEXT REFERENCES operators (id) ON DELETE SET NULL,
  published_at      INTEGER
);

-- Every published design, the last 20 per Channel (older ones are deleted on publish). Restore
-- copies one back into the draft.
CREATE TABLE site_design_versions (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  design_json  TEXT NOT NULL CHECK (json_valid(design_json)),
  theme        TEXT NOT NULL,
  published_by TEXT REFERENCES operators (id) ON DELETE SET NULL,
  published_at INTEGER NOT NULL
);
CREATE INDEX site_design_versions_channel ON site_design_versions (channel_id, published_at DESC);
