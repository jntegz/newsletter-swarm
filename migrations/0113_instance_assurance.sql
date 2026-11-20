-- Platform admin assurance (docs/security.md "Instance admins").
--
-- instance_audit_events: every change to an install-wide setting (a PUT under /api/v1/instance
-- that the instance-admin guard allowed and that succeeded), hash-chained like audit_events but in
-- one chain for the whole install: each row's hash covers the previous row's hash, so editing or
-- deleting a past row breaks verification from that point (packages/db/src/instance-audit.ts).
-- Values of fields named like secrets are never stored. Instance admins read and verify it at
-- GET /api/v1/instance/audit.
CREATE TABLE instance_audit_events (
  seq                INTEGER PRIMARY KEY,
  id                 TEXT NOT NULL UNIQUE,
  actor_operator_id  TEXT,
  action             TEXT NOT NULL,
  metadata_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  ip_prefix          TEXT,
  created_at         INTEGER NOT NULL,
  prev_hash          TEXT NOT NULL,
  hash               TEXT NOT NULL
);

-- Workspaces whose website code was withheld on this install's own domain when an instance admin
-- turned on "every workspace" (site_code_rules.every_workspace). Their code stays off there until
-- an instance admin allows that workspace by itself (site_code_workspaces), so relaxing the rule
-- never releases code nobody reviewed (packages/engine/src/site-code-rules.ts). Turning the rule
-- off clears the list; turning it on again records it afresh.
CREATE TABLE site_code_held (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  held_at       INTEGER NOT NULL
);
