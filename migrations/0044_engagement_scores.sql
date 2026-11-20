-- Engagement score: one row per Member, recomputed daily from human opens and clicks.
-- A row older than a week counts as missing, so a stopped rollup can't steer sends for long.
CREATE TABLE member_engagement (
  member_id       TEXT PRIMARY KEY REFERENCES members (id) ON DELETE CASCADE,
  channel_id      TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  -- NULL when there is too little to go on: see band.
  score           INTEGER CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  band            TEXT NOT NULL CHECK (band IN ('very_engaged', 'engaged', 'slipping', 'cold', 'too_few_posts', 'opens_hidden')),
  sent_count      INTEGER NOT NULL,
  opened_count    INTEGER NOT NULL,
  clicked_count   INTEGER NOT NULL,
  last_engaged_at INTEGER,
  computed_at     INTEGER NOT NULL
);
CREATE INDEX member_engagement_by_score ON member_engagement (channel_id, score);
CREATE INDEX member_engagement_by_band ON member_engagement (channel_id, band);

-- How far today's pass over each Channel has got.
CREATE TABLE engagement_rollups (
  channel_id  TEXT PRIMARY KEY REFERENCES channels (id) ON DELETE CASCADE,
  day         TEXT NOT NULL,
  cursor      TEXT,
  finished    INTEGER NOT NULL DEFAULT 0
);
