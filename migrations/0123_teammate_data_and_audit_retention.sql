-- Former teammates' data and audit log retention (packages/engine/src/lifetimes.ts,
-- docs/privacy-controls.md "How long other records are kept").
--
-- audit_retention_months: every plan's audit log, the top plan's included, is kept at most this
-- long (and less where the plan keeps it for a shorter time). Pruning keeps the remaining chain
-- verifiable through the anchor and an audit.pruned entry (pruneAuditEvents in @swarm/db).
ALTER TABLE workspaces ADD COLUMN audit_retention_months INTEGER NOT NULL DEFAULT 24
  CHECK (audit_retention_months IN (12, 24, 36, 60));

-- An owner removed a former teammate's details from this workspace: wherever the workspace shows
-- who did something (the audit log, posts, keys, app grants, requests, approvals), it shows the
-- placeholder instead of their name and address, and their accepted invitations no longer hold
-- the address. Audit entries are hash-chained, so they are not rewritten: an entry
-- teammate.redacted records the redaction, and the log is read through this table.
CREATE TABLE teammate_redactions (
  workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  operator_id   TEXT NOT NULL,
  -- "former-teammate-<12 hex>@redacted.invalid": stable for the person in this workspace.
  placeholder   TEXT NOT NULL,
  redacted_by   TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, operator_id)
);
