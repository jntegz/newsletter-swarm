-- When the minute cron last looked at a source for a release. The release pass takes the sources
-- it looked at longest ago first, so sources whose items are held back (quiet window, caps, digest
-- day) can't fill its window every minute and keep other sources' items waiting. NULL = never.
ALTER TABLE feed_sources ADD COLUMN release_checked_at INTEGER;
