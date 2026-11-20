-- Phase 8 Link Hub (flag link_hub): the link-in-bio page at /links on the Channel website and its
-- click counts. Contract: docs/link-hub.md. Conventions as in 0001_foundation.sql.

-- One page per Channel. Without a row (or with enabled = 0) /links answers 404.
CREATE TABLE hub_settings (
  channel_id         TEXT PRIMARY KEY REFERENCES channels (id) ON DELETE CASCADE,
  enabled            INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  -- The Channel name when null.
  title              TEXT CHECK (title IS NULL OR length(title) BETWEEN 1 AND 80),
  bio                TEXT CHECK (bio IS NULL OR length(bio) <= 280),
  -- [{ "network": "mastodon", "url": "https://…" }], at most 12.
  socials_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(socials_json)),
  latest_dispatches  INTEGER NOT NULL DEFAULT 3 CHECK (latest_dispatches BETWEEN 0 AND 10),
  show_form          INTEGER NOT NULL DEFAULT 1 CHECK (show_form IN (0, 1)),
  -- Null: the Channel's site form.
  capture_form_id    TEXT REFERENCES capture_forms (id) ON DELETE SET NULL,
  updated_by         TEXT REFERENCES operators (id) ON DELETE SET NULL,
  updated_at         INTEGER NOT NULL
);

-- The links, in `position` order. Targets are absolute http(s) URLs; the site never redirects
-- anywhere else (docs/link-hub.md "Clicks").
CREATE TABLE hub_links (
  id                  TEXT PRIMARY KEY,
  channel_id          TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  title               TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  url                 TEXT NOT NULL CHECK (
                        length(url) <= 2048 AND (url LIKE 'https://%' OR url LIKE 'http://%')
                      ),
  thumbnail_media_id  TEXT REFERENCES media (id) ON DELETE SET NULL,
  starts_at           INTEGER,
  ends_at             INTEGER,
  position            INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at)
);
CREATE INDEX hub_links_by_channel ON hub_links (channel_id, position);

-- Cookieless daily click counts. No visitor identifiers of any kind; link_id has no foreign key
-- so a deleted link's history stays (reported as "Deleted link").
CREATE TABLE hub_link_clicks_daily (
  channel_id  TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  day         TEXT NOT NULL CHECK (length(day) = 10),
  link_id     TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (length(source) <= 120),
  country     TEXT NOT NULL CHECK (length(country) <= 2),
  clicks      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, day, link_id, source, country)
) WITHOUT ROWID;
