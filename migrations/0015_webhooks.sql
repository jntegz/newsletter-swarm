-- Phase 7 Event Webhooks: what 0012_platform.sql leaves out. Contract: docs/webhooks.md and
-- docs/architecture.md "Event Webhooks". Conventions as in 0001_foundation.sql.

-- The Member an event is about, so erasure can remove the stored payloads with the Member.
ALTER TABLE webhook_deliveries ADD COLUMN member_id TEXT;
-- A test event sent from the dashboard or API: delivered to any endpoint status and never counted
-- towards auto-disable.
ALTER TABLE webhook_deliveries ADD COLUMN test INTEGER NOT NULL DEFAULT 0 CHECK (test IN (0, 1));
-- Retries are counted from here: a redrive sets it to `attempts`, so the redriven delivery gets
-- the full WEBHOOK_MAX_ATTEMPTS again on the same row.
ALTER TABLE webhook_deliveries ADD COLUMN attempts_base INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webhook_deliveries ADD COLUMN last_attempt_at INTEGER;

CREATE INDEX webhook_deliveries_by_member ON webhook_deliveries (member_id) WHERE member_id IS NOT NULL;
-- Pending and retrying rows by due time: the queue consumer's claim and the minute sweep.
CREATE INDEX webhook_deliveries_open ON webhook_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'retrying');
CREATE INDEX webhook_deliveries_by_endpoint_status ON webhook_deliveries (endpoint_id, status, created_at);
-- Finished rows are pruned after 30 days.
CREATE INDEX webhook_deliveries_finished ON webhook_deliveries (updated_at)
  WHERE status IN ('succeeded', 'failed', 'canceled');

-- One row per attempt of a delivery, for the delivery log. Deleted with the delivery.
CREATE TABLE webhook_attempts (
  delivery_id      TEXT NOT NULL REFERENCES webhook_deliveries (id) ON DELETE CASCADE,
  attempt          INTEGER NOT NULL,
  started_at       INTEGER NOT NULL,
  response_status  INTEGER,
  latency_ms       INTEGER,
  error            TEXT,
  -- At most WEBHOOK_RESPONSE_EXCERPT_BYTES of the response body.
  response_excerpt TEXT,
  PRIMARY KEY (delivery_id, attempt)
) WITHOUT ROWID;

-- The outbox is pruned by age (30 days), behind the webhooks cursor.
CREATE INDEX platform_events_by_time ON platform_events (created_at);
