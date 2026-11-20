-- A worker sending a part to DeBounce (a bulk upload, or one step of a small run) holds the part
-- until claimed_until, so a duplicated or replayed email_check_run message, or the minute cron
-- arriving at the same time, finds it taken and sends nothing. The claim is let go when the work
-- ends; one left by a worker that died runs out on its own.
ALTER TABLE email_check_parts ADD COLUMN claimed_until INTEGER;
