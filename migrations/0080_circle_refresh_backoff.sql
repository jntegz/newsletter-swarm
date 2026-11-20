-- A Circle whose refresh keeps failing with an error other than a rule that no longer compiles
-- (which marks it failed) never moved evaluated_at, so the five-minute cron queued it again at the
-- head of its due list every 15 minutes. The cron counts those lost refreshes here and waits
-- longer after each one; a refresh that finishes resets it.
ALTER TABLE circles ADD COLUMN refresh_failures INTEGER NOT NULL DEFAULT 0;
