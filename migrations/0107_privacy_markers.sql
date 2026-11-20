-- Erasure and departure markers (suppressions.email_hash, dsr_requests.email_hash,
-- left_addresses.email_hash) become keyed per workspace: 'k1:' || sha256(marker_salt || ':' ||
-- sha256(address)) (privacy.ts addressMarker). The salt is random per workspace and never leaves
-- the database, so a marker can't be recomputed from a candidate address through the API and two
-- workspaces' markers for the same address differ. Markers written before this keep working:
-- lookups accept both forms, and the jobs worker rewrites old ones in place
-- (upgradeAddressMarkers), which needs only the stored value, never the address.
ALTER TABLE workspaces ADD COLUMN marker_salt TEXT;
UPDATE workspaces SET marker_salt = lower(hex(randomblob(32))) WHERE marker_salt IS NULL;

-- Request outcomes (privacy.ts sendRequestOutcomeNotices): when the person was told that their
-- request was declined or could not be completed, and when the workspace's admins were last
-- reminded of a request that failed.
ALTER TABLE dsr_requests ADD COLUMN outcome_noticed_at INTEGER;
ALTER TABLE dsr_requests ADD COLUMN admin_reminded_at INTEGER;
