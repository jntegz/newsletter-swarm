-- Scheduled publishing of website designs (docs/site-themes.md, "Draft, preview, publish"): at
-- most one per Channel. design_json is a snapshot of the draft when it was scheduled, so later
-- edits don't change what goes live. The jobs worker's five-minute cron claims a due row by
-- setting claim_token and claimed_until (a lease) in one conditional UPDATE, publishes it in a
-- batch whose every write checks the claim still holds, and deletes the row in that same batch.
-- A snapshot that fails its check at the time stays as status 'failed' with the problems until
-- someone cancels or schedules again. Cancelling marks the row 'cancelled' (the API reads it as
-- no schedule) so the dashboard's Undo can put the same snapshot back for a while; scheduling
-- again replaces it.
CREATE TABLE site_design_schedules (
  channel_id    TEXT PRIMARY KEY REFERENCES channels (id) ON DELETE CASCADE,
  design_json   TEXT NOT NULL CHECK (json_valid(design_json)),
  publish_at    INTEGER NOT NULL,
  scheduled_by  TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled', 'failed', 'cancelled')),
  problems_json TEXT CHECK (problems_json IS NULL OR json_valid(problems_json)),
  failed_at     INTEGER,
  cancelled_at  INTEGER,
  claim_token   TEXT,
  claimed_until INTEGER
);
CREATE INDEX site_design_schedules_due ON site_design_schedules (publish_at)
  WHERE status = 'scheduled';
