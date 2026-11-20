-- Where code an owner adds to their website (scripts, not CSS; flag site_custom_code) may run.
-- Contract: packages/engine/src/site-code-rules.ts reads these rows, workers/api/src/routes/
-- instance.ts writes them (Settings > Instance), and the site worker applies them when it renders.
--
-- Code always runs on a publication's own custom domain, and in a workspace an instance admin owns.
-- On this install's own domain (<slug>.PLATFORM_SITE_DOMAIN) it runs only when an instance admin
-- allowed it: for every workspace (site_code_rules) or for one (site_code_workspaces). With no rows
-- it is not allowed, so an install with several workspaces starts safe.

-- At most one row: the instance-wide switch.
CREATE TABLE site_code_rules (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  every_workspace  INTEGER NOT NULL DEFAULT 0 CHECK (every_workspace IN (0, 1)),
  updated_by       TEXT REFERENCES operators (id) ON DELETE SET NULL,
  updated_at       INTEGER NOT NULL
);

-- Workspaces an instance admin allowed one by one.
CREATE TABLE site_code_workspaces (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  allowed_by    TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);
