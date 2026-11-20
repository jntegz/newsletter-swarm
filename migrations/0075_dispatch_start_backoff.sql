-- A scheduled Dispatch that fails to start for a reason other than its checks (an outage, a
-- platform limit) is retried with a growing wait instead of every minute, so it can't stay at the
-- head of the send cron's due window. After a few tries it goes back to draft. Scheduling it again
-- resets both.
ALTER TABLE dispatches ADD COLUMN start_attempts INTEGER NOT NULL DEFAULT 0;
-- The cron leaves the Dispatch alone until then; NULL = no wait.
ALTER TABLE dispatches ADD COLUMN start_retry_at INTEGER;
