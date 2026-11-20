-- Test runs stop using up a Member's real run. A test run sends from its own copy of a Flow email
-- (broadcasts.test_run_id), so the real Flow Broadcast keeps its one-recipient-per-Member rule and
-- its numbers to itself. And a test run no longer holds the Member's one open run of the Flow: a
-- real run and a test run can be open side by side, with at most one of each.
ALTER TABLE broadcasts ADD COLUMN test_run_id TEXT REFERENCES flow_runs (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX broadcasts_test_copy ON broadcasts (test_run_id, dispatch_id)
  WHERE test_run_id IS NOT NULL;

DROP INDEX flow_runs_one_open;
CREATE UNIQUE INDEX flow_runs_one_open ON flow_runs (flow_id, member_id)
  WHERE status IN ('running', 'waiting', 'paused') AND test = 0;
CREATE UNIQUE INDEX flow_runs_one_open_test ON flow_runs (flow_id, member_id)
  WHERE status IN ('running', 'waiting', 'paused') AND test = 1;

-- Adding people to a live Flow from the dashboard runs as a bulk job, which needs a new action in
-- the CHECK, so the table is rebuilt. `entered` counts the Members the job started a run for; the rest
-- of `processed` were skipped by the enrolment rules. Rehearse needs nothing here: it writes nothing.
CREATE TABLE bulk_jobs_next (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id      TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  action          TEXT NOT NULL CHECK (action IN ('tag', 'untag', 'set_field', 'unsubscribe', 'delete', 'flow_enrol')),
  params_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params_json)),
  -- {"memberIds": [...]} or {"circleId": "..."}
  selection_json  TEXT NOT NULL CHECK (json_valid(selection_json)),
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  total           INTEGER NOT NULL DEFAULT 0,
  processed       INTEGER NOT NULL DEFAULT 0,
  entered         INTEGER NOT NULL DEFAULT 0,
  cursor          TEXT,
  error           TEXT,
  created_by      TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
INSERT INTO bulk_jobs_next (id, workspace_id, channel_id, action, params_json, selection_json, status,
    total, processed, cursor, error, created_by, created_at, completed_at)
  SELECT id, workspace_id, channel_id, action, params_json, selection_json, status,
         total, processed, cursor, error, created_by, created_at, completed_at
    FROM bulk_jobs;
DROP TABLE bulk_jobs;
ALTER TABLE bulk_jobs_next RENAME TO bulk_jobs;
CREATE INDEX bulk_jobs_by_channel ON bulk_jobs (channel_id, created_at);
