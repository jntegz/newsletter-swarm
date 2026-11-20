-- Phase 7, Open API workstream: the audit log retention anchor. Contracts: docs/architecture.md
-- "Platform (Phase 7)" ("Audit log retention") and packages/db/src/audit.ts. Conventions as in
-- 0001_foundation.sql. The API key and idempotency tables are in 0012_platform.sql.

-- When retention prunes the oldest audit events of a workspace, the chain must still verify.
-- Before deleting, the pruner verifies the whole chain, then records here the last pruned event
-- (its seq and hash): verification starts from this anchor instead of the genesis hash. The prune
-- itself is appended to the chain first ('audit.pruned', with the anchor in its metadata), so the
-- anchor row cannot be moved without breaking a hash that is still kept. One row per workspace,
-- moved forward by each prune.
CREATE TABLE audit_anchors (
  workspace_id   TEXT PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  -- The seq and hash of the newest pruned event; the first kept event has seq + 1.
  seq            INTEGER NOT NULL CHECK (seq > 0),
  hash           TEXT NOT NULL,
  -- created_at of the newest pruned event (everything older is gone).
  pruned_before  INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) WITHOUT ROWID;
