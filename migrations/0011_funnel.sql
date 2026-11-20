-- Phase 6: Funnel Explorer rollup state. funnel_daily itself is in 0010_growth.sql.
-- Conventions as in 0001_foundation.sql.

-- Where each rollup pass has got to: 'member_events' holds the last member_events.seq read
-- (separate from processed_at, which the Flows engine owns); 'opens' holds the
-- deliveries.human_opened_at (ms) the first-open pass has scanned up to.
CREATE TABLE funnel_cursors (
  name        TEXT PRIMARY KEY CHECK (name IN ('member_events', 'opens')),
  value       INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) WITHOUT ROWID;

-- One row per Member the funnel follows: written when their member_joined event is rolled up
-- (sign-ups, checkout and gift joins; imports and operator-created Members are not funnel
-- traffic). The flags make every per-Member stage count at most once, so re-running a pass
-- never double counts. Only stage flags are kept: no attribution, no timestamps of activity.
CREATE TABLE funnel_members (
  member_id     TEXT PRIMARY KEY REFERENCES members (id) ON DELETE CASCADE,
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  joined_at     INTEGER NOT NULL,
  confirmed     INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  first_opened  INTEGER NOT NULL DEFAULT 0 CHECK (first_opened IN (0, 1)),
  paid          INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1))
) WITHOUT ROWID;
CREATE INDEX funnel_members_by_channel ON funnel_members (channel_id);
