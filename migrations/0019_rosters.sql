-- Phase 8 (part 1): Rosters, several opt-in lists per Channel (flag rosters). Contract:
-- docs/rosters.md. Conventions as in 0001_foundation.sql.

CREATE TABLE rosters (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description   TEXT CHECK (description IS NULL OR length(description) <= 500),
  -- Shown in the Member Center, where Members join and leave it themselves.
  member_center INTEGER NOT NULL DEFAULT 1 CHECK (member_center IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  -- Deleted Rosters keep their memberships, so a Broadcast already sending to one finishes.
  deleted_at    INTEGER
);
CREATE UNIQUE INDEX rosters_name ON rosters (channel_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE INDEX rosters_by_channel ON rosters (channel_id, created_at) WHERE deleted_at IS NULL;

-- One row per Member and Roster once they have joined. `source` is who made the last change;
-- a Member who left themselves ('member', 'unsubscribe') is only put back by themselves.
CREATE TABLE roster_members (
  roster_id       TEXT NOT NULL REFERENCES rosters (id) ON DELETE CASCADE,
  member_id       TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('subscribed', 'unsubscribed')),
  source          TEXT NOT NULL
                  CHECK (source IN ('operator', 'form', 'member', 'import', 'api', 'unsubscribe')),
  subscribed_at   INTEGER,
  unsubscribed_at INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (roster_id, member_id)
);
-- The audience predicate looks up one Member's subscribed Rosters; the Member Center and the
-- member detail read all of a Member's rows.
CREATE INDEX roster_members_by_member ON roster_members (member_id, status);
-- Counts and the membership list of one Roster.
CREATE INDEX roster_members_by_roster ON roster_members (roster_id, status, updated_at);
