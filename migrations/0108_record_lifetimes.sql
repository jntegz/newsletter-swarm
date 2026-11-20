-- Lifetimes for records kept after the relationship ended (packages/engine/src/lifetimes.ts).
-- left_member_retention_months: how long after someone left (unsubscribed, bounced, complained)
-- their profile is kept in full; after that it is reduced to what keeps honouring the departure
-- (address, status, dates, consent records) and names, fields, tags, source and activity events
-- go. reduced_at marks a reduced Member. purged_at marks a deleted Channel whose subscribers'
-- personal data was disposed of after the restore window.
ALTER TABLE workspaces ADD COLUMN left_member_retention_months INTEGER NOT NULL DEFAULT 24
  CHECK (left_member_retention_months IN (12, 24, 36, 60));
ALTER TABLE members ADD COLUMN reduced_at INTEGER;
ALTER TABLE channels ADD COLUMN purged_at INTEGER;
CREATE INDEX members_departed ON members (status, unsubscribed_at)
  WHERE status IN ('unsubscribed', 'bounced', 'complained') AND reduced_at IS NULL;
