-- An erasure from a Member Center link that proves nothing about who holds it (a footer link of a
-- bounced or complained address, which may have been forwarded) gets its own source,
-- 'member_center_unverified', so the admin approving it knows to confirm with the person another
-- way. That needs a new value in the CHECK, so the table is rebuilt; nothing references it. The
-- only pending Member Center requests are such erasures (verified ones start processing).
CREATE TABLE dsr_requests_next (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id      TEXT REFERENCES channels (id) ON DELETE SET NULL,
  member_id       TEXT REFERENCES members (id) ON DELETE SET NULL,
  email_hash      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('export', 'erase')),
  source          TEXT NOT NULL
                  CHECK (source IN ('member_center', 'member_center_unverified', 'operator', 'api')),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'completed', 'rejected', 'failed')),
  due_at          INTEGER NOT NULL,
  export_key      TEXT,
  export_expires_at INTEGER,
  note            TEXT,
  handled_by      TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  email_enc       TEXT,
  claimed_until   INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  error           TEXT CHECK (error IS NULL OR length(error) <= 500)
);
INSERT INTO dsr_requests_next (id, workspace_id, channel_id, member_id, email_hash, kind, source,
    status, due_at, export_key, export_expires_at, note, handled_by, created_at, updated_at,
    completed_at, email_enc, claimed_until, attempts, error)
  SELECT id, workspace_id, channel_id, member_id, email_hash, kind,
         CASE WHEN source = 'member_center' AND status = 'pending'
              THEN 'member_center_unverified' ELSE source END,
         status, due_at, export_key, export_expires_at, note, handled_by, created_at, updated_at,
         completed_at, email_enc, claimed_until, attempts, error
    FROM dsr_requests;
DROP TABLE dsr_requests;
ALTER TABLE dsr_requests_next RENAME TO dsr_requests;
CREATE INDEX dsr_requests_by_workspace ON dsr_requests (workspace_id, status, due_at);
CREATE INDEX dsr_requests_runnable ON dsr_requests (status, created_at) WHERE status = 'processing';
CREATE INDEX dsr_requests_exports ON dsr_requests (export_expires_at) WHERE export_key IS NOT NULL;
CREATE INDEX dsr_requests_by_hash ON dsr_requests (workspace_id, email_hash);
