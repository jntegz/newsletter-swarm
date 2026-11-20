-- Changing the email service. A sending domain keeps the records and reference of the service it's
-- on, and the pending_* columns hold those of the service it's moving to, so publication admins can
-- publish new records while the old service still sends. Cutting over swaps the two, and so does
-- rolling back. provider is NULL on rows from before this, meaning the service in use at the time.
ALTER TABLE sending_domains ADD COLUMN provider TEXT;
ALTER TABLE sending_domains ADD COLUMN provider_changed_at INTEGER;
ALTER TABLE sending_domains ADD COLUMN pending_provider TEXT;
ALTER TABLE sending_domains ADD COLUMN pending_records_json TEXT
  CHECK (pending_records_json IS NULL OR json_valid(pending_records_json));
ALTER TABLE sending_domains ADD COLUMN pending_provider_ref TEXT;

-- Only the installer writes this, and the API reads it to tell people what's happening.
CREATE TABLE mail_service_changes (
  id            TEXT PRIMARY KEY,
  from_provider TEXT NOT NULL,
  to_provider   TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('prepared', 'cut_over', 'finished', 'rolled_back')),
  started_at    INTEGER NOT NULL,
  cut_over_at   INTEGER,
  drain_until   INTEGER,
  finished_at   INTEGER
);
-- One change at a time: the installer can't start a second while one is open.
CREATE UNIQUE INDEX mail_service_changes_one_open ON mail_service_changes ((1))
  WHERE state IN ('prepared', 'cut_over');
