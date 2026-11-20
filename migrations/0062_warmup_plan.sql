-- Guided warm-up: an admin can skip a Reputation Ramp for a domain that already has a sending
-- history, and start it again later. The pace (start_cap, growth) already lives on the ramp.

-- When an admin skipped the ramp (status 'complete' without warming up). Cleared on a restart.
ALTER TABLE reputation_ramps ADD COLUMN skipped_at INTEGER;
-- The UTC day (YYYY-MM-DD) this warm-up started or started again. NULL on ramps from before this
-- migration, which count from the day they were created.
ALTER TABLE reputation_ramps ADD COLUMN started_day TEXT;
