-- The form stamp (packages/engine/src/consents.ts): when a sign-up carried a valid stamp the
-- server signed into the form it rendered, the time it was rendered. Set: the form version was
-- shown by Swarm (version_claimed is then 0, also for an older version from a cached page).
-- NULL: no stamp (an embed copied earlier, an API call), and version_claimed says as before.
ALTER TABLE member_consents ADD COLUMN stamped_at INTEGER;
