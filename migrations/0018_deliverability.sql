-- Phase 7: Deliverability Center additions to 0012_platform.sql. Contract: docs/deliverability.md
-- and docs/architecture.md "Deliverability Center". Conventions as in 0001_foundation.sql.

-- Dedicated IP warm-up as last read from the provider (0–100), and when the pool was asked for
-- and last checked. channels.dedicated_ip_status (0012) moves requested → warming → active.
ALTER TABLE channels ADD COLUMN dedicated_ip_warmup_percent INTEGER
  CHECK (dedicated_ip_warmup_percent IS NULL OR dedicated_ip_warmup_percent BETWEEN 0 AND 100);
ALTER TABLE channels ADD COLUMN dedicated_ip_requested_at INTEGER;
ALTER TABLE channels ADD COLUMN dedicated_ip_checked_at INTEGER;

-- The send worker's cron provisions requested pools and follows warm-up; only those rows.
CREATE INDEX channels_dedicated_ip_pending ON channels (dedicated_ip_status)
  WHERE dedicated_ip_status IN ('requested', 'warming');

-- Reads use existing indexes: dmarc_reports_by_domain (sending_domain_id, begin_at) bounds a
-- date range, dmarc_records_by_report joins its records, and deliveries_recent_by_channel
-- (channel_id, sent_at) bounds the per-mailbox-provider breakdown.
