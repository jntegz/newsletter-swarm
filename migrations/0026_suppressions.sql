-- Suppressions, part two: an optional Channel scope, the SES account-level suppression list kept in
-- step with ours, and Reputation Ramp pause notices. Contract: docs/deliverability.md
-- "Suppressions" and "Reputation Ramp pauses". Conventions as in 0001_foundation.sql.

-- A suppression is workspace-wide (channel_id NULL: hard bounces, complaints, erasures, manual)
-- or limited to one Channel (manual only). The table is rebuilt because UNIQUE (workspace_id,
-- email) from 0003 becomes one unique address per scope.
CREATE TABLE suppressions_next (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id    TEXT REFERENCES channels (id) ON DELETE CASCADE,
  email         TEXT NOT NULL COLLATE NOCASE,
  email_hash    TEXT,
  reason        TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'soft_bounce', 'complaint', 'manual')),
  detail        TEXT,
  created_at    INTEGER NOT NULL,
  -- Only manual suppressions are Channel-scoped; what the provider reports is about the address.
  CHECK (channel_id IS NULL OR reason = 'manual')
);
INSERT INTO suppressions_next (id, workspace_id, channel_id, email, email_hash, reason, detail, created_at)
  SELECT id, workspace_id, NULL, email, email_hash, reason, detail, created_at FROM suppressions;
DROP TABLE suppressions;
ALTER TABLE suppressions_next RENAME TO suppressions;
CREATE UNIQUE INDEX suppressions_workspace_wide ON suppressions (workspace_id, email) WHERE channel_id IS NULL;
CREATE UNIQUE INDEX suppressions_channel_scoped ON suppressions (channel_id, email) WHERE channel_id IS NOT NULL;
-- Every send-time check reads (workspace_id, email), then filters on the scope.
CREATE INDEX suppressions_by_address ON suppressions (workspace_id, email);
CREATE UNIQUE INDEX suppressions_by_hash ON suppressions (workspace_id, email_hash) WHERE email_hash IS NOT NULL;
-- The address search across workspaces: the "still suppressed elsewhere" check before an SES
-- removal, and the SES reconcile, which finds the workspaces where a listed address is a Member.
CREATE INDEX suppressions_by_email ON suppressions (email);
CREATE INDEX members_by_email ON members (email);

-- Changes to push to the SES account-level suppression list: one row per address, the latest
-- intent wins. The jobs worker's minute cron applies due rows and retries provider errors with
-- backoff; rows that keep failing stay as 'failed' for an operator to see in the logs.
CREATE TABLE provider_suppression_sync (
  email            TEXT PRIMARY KEY COLLATE NOCASE,
  action           TEXT NOT NULL CHECK (action IN ('put', 'delete')),
  -- For 'put': the SES reason.
  reason           TEXT CHECK (reason IS NULL OR reason IN ('BOUNCE', 'COMPLAINT')),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX provider_suppression_sync_due ON provider_suppression_sync (next_attempt_at) WHERE status = 'pending';

-- A ramp paused by a bounce or complaint anomaly owes its owners and admins one email:
-- 'due' when it pauses, 'sent' once the jobs worker has claimed it, NULL when nothing is owed
-- (operator pauses and resumes clear it). Ramps already paused before this migration are not
-- announced after the fact.
ALTER TABLE reputation_ramps ADD COLUMN pause_notice TEXT
  CHECK (pause_notice IS NULL OR pause_notice IN ('due', 'sent'));
CREATE INDEX reputation_ramps_pause_notice_due ON reputation_ramps (id) WHERE pause_notice = 'due';
