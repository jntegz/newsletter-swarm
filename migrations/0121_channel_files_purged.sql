-- A deleted publication's stored files (packages/engine/src/lifetimes.ts purgeDeletedChannelFiles):
-- once its personal data was purged (purged_at, 0108), the jobs worker deletes its objects in the
-- media, imports and exports buckets in bounded batches, then sets files_purged_at.
ALTER TABLE channels ADD COLUMN files_purged_at INTEGER;
CREATE INDEX channels_files_unpurged ON channels (purged_at)
  WHERE purged_at IS NOT NULL AND files_purged_at IS NULL;
