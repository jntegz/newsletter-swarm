-- Audience, capture and Channel website fixes (flag author_pages). Conventions as in
-- 0001_foundation.sql.

-- Author pages: a teammate's public profile on one Channel's website, at /authors/<slug>. A
-- Dispatch's byline is its creator (dispatches.created_by) when that teammate has a profile here.
-- The avatar is public media of the Channel's workspace.
CREATE TABLE author_profiles (
  channel_id       TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  operator_id      TEXT NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  slug             TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 60),
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  bio              TEXT CHECK (bio IS NULL OR length(bio) <= 1000),
  avatar_media_id  TEXT REFERENCES media (id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (channel_id, operator_id),
  UNIQUE (channel_id, slug)
);

-- An author page lists the Dispatches its teammate created.
CREATE INDEX dispatches_by_creator ON dispatches (channel_id, created_by) WHERE created_by IS NOT NULL;
