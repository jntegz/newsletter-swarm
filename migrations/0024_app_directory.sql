-- Phase 8 App Directory: listings of OAuth apps, community Flow Recipes and platform staff.
-- Contract: docs/app-directory.md. Conventions as in 0001_foundation.sql.

-- Operators who review listings and recipes. No route writes this table: rows are added and
-- removed with `wrangler d1 execute` (docs/deployment.md, "Platform staff").
CREATE TABLE platform_staff (
  operator_id  TEXT PRIMARY KEY REFERENCES operators (id) ON DELETE CASCADE,
  note         TEXT CHECK (note IS NULL OR length(note) <= 200),
  created_at   INTEGER NOT NULL
);

-- One listing per OAuth app, owned by the app's workspace. Every edit returns it to 'draft';
-- the directory shows 'approved' listings of unrevoked apps only.
CREATE TABLE app_listings (
  id                      TEXT PRIMARY KEY,
  app_id                  TEXT NOT NULL UNIQUE REFERENCES oauth_apps (id) ON DELETE CASCADE,
  workspace_id            TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  status                  TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'delisted')),
  name                    TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  slug                    TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 2 AND 50),
  tagline                 TEXT NOT NULL DEFAULT '' CHECK (length(tagline) <= 120),
  description             TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  icon_media_id           TEXT REFERENCES media (id) ON DELETE SET NULL,
  screenshots_json        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(screenshots_json)),
  categories_json         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(categories_json)),
  scopes_json             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes_json)),
  webhook_events_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(webhook_events_json)),
  website_url             TEXT,
  support_url             TEXT,
  privacy_url             TEXT,
  install_url             TEXT,
  review_note             TEXT CHECK (review_note IS NULL OR length(review_note) <= 1000),
  submitted_at            INTEGER,
  reviewed_at             INTEGER,
  reviewed_by             TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_by              TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);
CREATE INDEX app_listings_by_workspace ON app_listings (workspace_id, created_at);
-- The directory (approved, newest approval first) and the review queue (submitted, oldest first).
CREATE INDEX app_listings_by_status ON app_listings (status, reviewed_at);

-- A Flow shared as a community recipe: a sanitised copy (no ids, addresses, URLs or secrets of
-- the Channel; packages/engine/src/app-directory.ts). The source Flow and Channel are kept for
-- the submitter only and are nulled when they are deleted.
CREATE TABLE recipe_submissions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id      TEXT REFERENCES channels (id) ON DELETE SET NULL,
  flow_id         TEXT REFERENCES flows (id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'delisted')),
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description     TEXT NOT NULL CHECK (length(description) <= 500),
  trigger_type    TEXT NOT NULL,
  email_count     INTEGER NOT NULL,
  setup_steps     INTEGER NOT NULL,
  recipe_json     TEXT NOT NULL CHECK (json_valid(recipe_json)),
  removed_json    TEXT NOT NULL CHECK (json_valid(removed_json)),
  review_note     TEXT CHECK (review_note IS NULL OR length(review_note) <= 1000),
  submitted_at    INTEGER,
  reviewed_at     INTEGER,
  reviewed_by     TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_by      TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX recipe_submissions_by_channel ON recipe_submissions (channel_id, created_at);
CREATE INDEX recipe_submissions_by_status ON recipe_submissions (status, reviewed_at);
