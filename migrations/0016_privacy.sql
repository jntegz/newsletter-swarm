-- Phase 7 (part 5): Privacy Center processing and incremental export runs. The tables are in
-- 0012_platform.sql (dsr_requests, suppressions.email_hash, export_destinations); this adds what
-- the jobs worker needs to run them. Contract: docs/architecture.md "Privacy Center".
-- Conventions as in 0001_foundation.sql.

-- The address a request is about, sealed with FIELD_KEYS while the request is open: an erasure
-- or export finds every Member with it across the workspace, and the export link is mailed to
-- it. Cleared when the request completes or is rejected; only email_hash stays.
ALTER TABLE dsr_requests ADD COLUMN email_enc TEXT;
-- The jobs worker's lease on a request it is running, so overlapping cron runs never run one
-- twice; attempts and the last error decide when a request is marked failed.
ALTER TABLE dsr_requests ADD COLUMN claimed_until INTEGER;
ALTER TABLE dsr_requests ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dsr_requests ADD COLUMN error TEXT CHECK (error IS NULL OR length(error) <= 500);
-- Requests the jobs worker should run ('processing'), oldest first; expired export files.
CREATE INDEX dsr_requests_runnable ON dsr_requests (status, created_at) WHERE status = 'processing';
CREATE INDEX dsr_requests_exports ON dsr_requests (export_expires_at) WHERE export_key IS NOT NULL;
CREATE INDEX dsr_requests_by_hash ON dsr_requests (workspace_id, email_hash);

-- Consecutive failed runs of an export destination (reset on success). Admins are emailed once
-- when it reaches EXPORT_DESTINATION_NOTIFY_AFTER.
ALTER TABLE export_destinations ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE export_destinations ADD COLUMN created_by TEXT REFERENCES operators (id) ON DELETE SET NULL;

-- Incremental export of changed Members walks one Channel by (updated_at, id).
CREATE INDEX members_by_channel_updated ON members (channel_id, updated_at, id);
-- Webhook outbox rows of one type per Channel (member.deleted for export destinations).
CREATE INDEX platform_events_by_channel ON platform_events (channel_id, type, seq);
