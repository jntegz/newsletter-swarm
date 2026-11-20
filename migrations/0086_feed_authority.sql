-- Standing feeds follow the authority behind them (docs/security.md "Standing feeds",
-- packages/engine/src/feed-authority.ts). confirmed_by is the operator who created, repointed or
-- adopted the feed through a fresh second-factor check, and confirmed_at when; the feed runs
-- only while that operator holds an owner or admin seat in the workspace, its Channel is not
-- deleted and the plan includes it. A webhook endpoint proposed through /v2 by an API key or an
-- OAuth grant records that credential in proposed_via and proposed_by_id: it stays unconfirmed
-- (and receives nothing) until an admin confirms it, and stops if the credential is revoked.
--
-- Existing feeds created from the dashboard are confirmed by their creator as of their creation.
-- Those with no recorded creator (made through /v2, or whose creator's account is gone) wait for
-- an admin to confirm them.
ALTER TABLE webhook_endpoints ADD COLUMN proposed_via TEXT
  CHECK (proposed_via IS NULL OR proposed_via IN ('key', 'oauth'));
ALTER TABLE webhook_endpoints ADD COLUMN proposed_by_id TEXT;
ALTER TABLE webhook_endpoints ADD COLUMN confirmed_by TEXT REFERENCES operators (id) ON DELETE SET NULL;
ALTER TABLE webhook_endpoints ADD COLUMN confirmed_at INTEGER;
UPDATE webhook_endpoints SET confirmed_by = created_by, confirmed_at = created_at
 WHERE created_by IS NOT NULL;

ALTER TABLE export_destinations ADD COLUMN confirmed_by TEXT REFERENCES operators (id) ON DELETE SET NULL;
ALTER TABLE export_destinations ADD COLUMN confirmed_at INTEGER;
UPDATE export_destinations SET confirmed_by = created_by, confirmed_at = created_at
 WHERE created_by IS NOT NULL;
