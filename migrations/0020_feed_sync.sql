-- Phase 8 Feed Sync (flag feed_sync): feeds a Channel follows and the items seen in them.
-- Contract: docs/feed-sync.md. Conventions as in 0001_foundation.sql.

CREATE TABLE feed_sources (
  id                  TEXT PRIMARY KEY,
  channel_id          TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  url                 TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  name                TEXT CHECK (name IS NULL OR length(name) <= 120),
  -- From the last successful fetch.
  title               TEXT,
  format              TEXT CHECK (format IS NULL OR format IN ('rss', 'atom', 'json')),
  mode                TEXT NOT NULL DEFAULT 'draft' CHECK (mode IN ('draft', 'send')),
  grouping            TEXT NOT NULL DEFAULT 'each' CHECK (grouping IN ('each', 'digest')),
  content_mode        TEXT NOT NULL DEFAULT 'full' CHECK (content_mode IN ('full', 'summary')),
  template_id         TEXT REFERENCES templates (id) ON DELETE SET NULL,
  sender_identity_id  TEXT REFERENCES sender_identities (id) ON DELETE SET NULL,
  -- {"include": [circle ids], "exclude": [circle ids]}, as on dispatches. Rosters will add a key.
  audience_json       TEXT NOT NULL DEFAULT '{"include":[],"exclude":[]}' CHECK (json_valid(audience_json)),
  subject_template    TEXT CHECK (subject_template IS NULL OR length(subject_template) <= 200),
  interval_minutes    INTEGER NOT NULL DEFAULT 60 CHECK (interval_minutes BETWEEN 15 AND 1440),
  min_gap_minutes     INTEGER NOT NULL DEFAULT 0 CHECK (min_gap_minutes BETWEEN 0 AND 10080),
  max_per_day         INTEGER NOT NULL DEFAULT 3 CHECK (max_per_day BETWEEN 1 AND 48),
  digest_limit        INTEGER NOT NULL DEFAULT 10 CHECK (digest_limit BETWEEN 1 AND 30),
  -- Minutes after local midnight in `timezone`; both set or both null.
  quiet_start         INTEGER CHECK (quiet_start IS NULL OR quiet_start BETWEEN 0 AND 1439),
  quiet_end           INTEGER CHECK (quiet_end IS NULL OR quiet_end BETWEEN 0 AND 1439),
  timezone            TEXT NOT NULL DEFAULT 'UTC',
  -- 'disabled': turned off after FEED_SYNC_LIMITS.failuresBeforeOff failed checks in a row.
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  -- Conditional GET validators from the last 200 answer.
  etag                TEXT,
  last_modified       TEXT,
  next_check_at       INTEGER,
  last_checked_at     INTEGER,
  last_success_at     INTEGER,
  failure_count       INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  -- A check holds the source until then (one check at a time).
  lock_until          INTEGER,
  created_by          TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK ((quiet_start IS NULL) = (quiet_end IS NULL))
);
CREATE INDEX feed_sources_by_channel ON feed_sources (channel_id, created_at);
-- The minute cron: active sources by due time.
CREATE INDEX feed_sources_due ON feed_sources (next_check_at) WHERE status = 'active';

CREATE TABLE feed_items (
  id              TEXT PRIMARY KEY,
  feed_source_id  TEXT NOT NULL REFERENCES feed_sources (id) ON DELETE CASCADE,
  -- sha256 hex of 'guid:<guid>', else of 'link:<link>' and the title: the dedupe key.
  key_hash        TEXT NOT NULL,
  guid            TEXT,
  link            TEXT,
  title           TEXT NOT NULL DEFAULT '',
  published_at    INTEGER,
  -- The sanitised editor blocks, image and summary; cleared some days after the item is used.
  content_json    TEXT CHECK (content_json IS NULL OR json_valid(content_json)),
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'dispatched', 'skipped')),
  dispatch_id     TEXT REFERENCES dispatches (id) ON DELETE SET NULL,
  dispatched_at   INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (feed_source_id, key_hash)
);
CREATE INDEX feed_items_by_source ON feed_items (feed_source_id, status, created_at);
-- The frequency caps count Dispatches made in the last 24 hours.
CREATE INDEX feed_items_dispatched ON feed_items (feed_source_id, dispatched_at)
  WHERE dispatched_at IS NOT NULL;
-- The minute release sweep: sources with items waiting.
CREATE INDEX feed_items_waiting ON feed_items (feed_source_id) WHERE status = 'new';
