-- A Dispatch Feed Sync started, so the Posts list doesn't show it as a teammate's. Its own column:
-- created_via's CHECK (0034) has no value for it and SQLite can't widen a CHECK without rebuilding
-- the table. The API reports it as createdVia 'feed'.
ALTER TABLE dispatches ADD COLUMN from_feed INTEGER NOT NULL DEFAULT 0 CHECK (from_feed IN (0, 1));

UPDATE dispatches SET from_feed = 1
 WHERE id IN (SELECT dispatch_id FROM feed_items WHERE dispatch_id IS NOT NULL);
