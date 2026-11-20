-- Data requests from people who are not subscribers (packages/engine/src/privacy.ts
-- startAddressRequest, docs/gdpr.md): a buyer, a gift purchaser or recipient, a sponsor contact,
-- or someone whose subscriber row was deleted asks for a copy or deletion of their data from a
-- public page of the publication. The page only mails the address a single-use link; the request
-- is filed (source 'address_form') when that link's page is used, so only the inbox can ask.
--
-- dsr_requests gains the source 'address_form'. The CHECK changes, so the table is rebuilt as in
-- 0079; nothing references it.
CREATE TABLE dsr_requests_next (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id      TEXT REFERENCES channels (id) ON DELETE SET NULL,
  member_id       TEXT REFERENCES members (id) ON DELETE SET NULL,
  email_hash      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('export', 'erase')),
  source          TEXT NOT NULL
                  CHECK (source IN ('member_center', 'member_center_unverified', 'operator', 'api',
                                    'address_form')),
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
  error           TEXT CHECK (error IS NULL OR length(error) <= 500),
  outcome_noticed_at INTEGER,
  admin_reminded_at INTEGER
);
INSERT INTO dsr_requests_next (id, workspace_id, channel_id, member_id, email_hash, kind, source,
    status, due_at, export_key, export_expires_at, note, handled_by, created_at, updated_at,
    completed_at, email_enc, claimed_until, attempts, error, outcome_noticed_at, admin_reminded_at)
  SELECT id, workspace_id, channel_id, member_id, email_hash, kind, source, status, due_at,
         export_key, export_expires_at, note, handled_by, created_at, updated_at, completed_at,
         email_enc, claimed_until, attempts, error, outcome_noticed_at, admin_reminded_at
    FROM dsr_requests;
DROP TABLE dsr_requests;
ALTER TABLE dsr_requests_next RENAME TO dsr_requests;
CREATE INDEX dsr_requests_by_workspace ON dsr_requests (workspace_id, status, due_at);
CREATE INDEX dsr_requests_runnable ON dsr_requests (status, created_at) WHERE status = 'processing';
CREATE INDEX dsr_requests_exports ON dsr_requests (export_expires_at) WHERE export_key IS NOT NULL;
CREATE INDEX dsr_requests_by_hash ON dsr_requests (workspace_id, email_hash);

-- A request from the public page waiting for its link to be used. The id is 52 random bits that
-- only the emailed link carries; the address is sealed (FIELD_KEYS, purpose dsr-address) and the
-- marker is the workspace's erasure marker, used to send one email per address at a time. Rows
-- are deleted a day after they expire or are used, and by an erasure of the address.
CREATE TABLE address_confirmations (
  id            INTEGER PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('export', 'erase')),
  email_enc     TEXT NOT NULL,
  email_hash    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER
);
CREATE INDEX address_confirmations_by_hash ON address_confirmations (workspace_id, email_hash, created_at);
CREATE INDEX address_confirmations_by_expiry ON address_confirmations (expires_at);
