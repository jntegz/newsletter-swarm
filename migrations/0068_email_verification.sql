-- Email checks (flag email_verification; docs/email-verification.md): addresses checked with
-- DeBounce. The install owner's key is the worker secret DEBOUNCE_API_KEY, never a row here.
-- Code: packages/engine/src/email-checks.ts (rules, results, runs), packages/engine/src/debounce.ts
-- (the only code that talks to DeBounce).

-- Who may spend the install's credits, the same shape as site_code_rules (0065): workspaces an
-- instance admin owns always may; others when allowed one by one, or all of them by this switch.
CREATE TABLE email_check_rules (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  every_workspace  INTEGER NOT NULL DEFAULT 0 CHECK (every_workspace IN (0, 1)),
  updated_by       TEXT REFERENCES operators (id) ON DELETE SET NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE email_check_workspaces (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  allowed_by    TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);

-- A workspace's choices: what each colour does per origin, and how long a result counts.
CREATE TABLE email_check_settings (
  workspace_id   TEXT PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  settings_json  TEXT NOT NULL CHECK (json_valid(settings_json)),
  updated_by     TEXT REFERENCES operators (id) ON DELETE SET NULL,
  updated_at     INTEGER NOT NULL
);

-- One result per address per workspace: the same address in two publications is checked once.
-- No row means "not checked". Erasure (privacy.ts) deletes the row.
CREATE TABLE email_checks (
  workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email         TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  state         TEXT NOT NULL CHECK (state IN ('green', 'orange', 'red')),
  code          INTEGER NOT NULL CHECK (code BETWEEN 1 AND 8),
  -- DeBounce's own words for the result, as it sent them.
  reason        TEXT CHECK (reason IS NULL OR length(reason) <= 80),
  did_you_mean  TEXT CHECK (did_you_mean IS NULL OR length(did_you_mean) <= 254),
  source        TEXT NOT NULL CHECK (source IN ('swarm', 'debounce')),
  checked_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, email)
);
CREATE INDEX email_checks_by_state ON email_checks (workspace_id, state, code);

-- A check of many addresses: planned first (counts and credits), then sent to DeBounce in parts,
-- one part at a time. An import's check (scope 'import') starts by itself.
CREATE TABLE email_check_runs (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  scope               TEXT NOT NULL CHECK (scope IN ('workspace', 'channel', 'segment', 'import')),
  channel_id          TEXT REFERENCES channels (id) ON DELETE CASCADE,
  circle_id           TEXT REFERENCES circles (id) ON DELETE SET NULL,
  import_id           TEXT REFERENCES import_jobs (id) ON DELETE CASCADE,
  only_never_checked  INTEGER NOT NULL DEFAULT 0 CHECK (only_never_checked IN (0, 1)),
  status              TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'planned',
                        'running', 'stopping', 'paused', 'completed', 'stopped', 'canceled', 'failed')),
  paused_reason       TEXT CHECK (paused_reason IS NULL OR paused_reason IN ('credits', 'key')),
  error               TEXT CHECK (error IS NULL OR length(error) <= 500),
  method              TEXT NOT NULL DEFAULT 'bulk' CHECK (method IN ('bulk', 'single')),
  -- Planning walks members (or the import file) from this cursor.
  plan_cursor         TEXT,
  addresses           INTEGER NOT NULL DEFAULT 0,
  fresh               INTEGER NOT NULL DEFAULT 0,
  local_results       INTEGER NOT NULL DEFAULT 0,
  to_check            INTEGER NOT NULL DEFAULT 0,
  parts               INTEGER NOT NULL DEFAULT 0,
  balance             INTEGER,
  current_part        INTEGER NOT NULL DEFAULT 0,
  checked             INTEGER NOT NULL DEFAULT 0,
  credits_used        INTEGER NOT NULL DEFAULT 0,
  green               INTEGER NOT NULL DEFAULT 0,
  orange              INTEGER NOT NULL DEFAULT 0,
  red                 INTEGER NOT NULL DEFAULT 0,
  created_by          TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL,
  started_at          INTEGER,
  updated_at          INTEGER NOT NULL,
  completed_at        INTEGER
);
CREATE INDEX email_check_runs_by_workspace ON email_check_runs (workspace_id, created_at);
CREATE INDEX email_check_runs_active ON email_check_runs (status)
  WHERE status IN ('planning', 'running', 'stopping');

-- The addresses of a run, once each (deduplicated across publications). part 0: settled by
-- Swarm's own checks (local_code), never sent. Deleted with the run's other rows when it ends.
CREATE TABLE email_check_items (
  run_id      TEXT NOT NULL REFERENCES email_check_runs (id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  part        INTEGER NOT NULL,
  local_code  INTEGER CHECK (local_code IS NULL OR local_code BETWEEN 1 AND 8),
  done        INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  PRIMARY KEY (run_id, email)
);
CREATE INDEX email_check_items_by_part ON email_check_items (run_id, part, done);

-- One part at DeBounce's bulk API. Its file (addresses only) is in the IMPORTS bucket at file_key
-- and served at a URL that carries a random token; only the token's hash is kept. The file and
-- the token go when DeBounce has finished, or after EMAIL_CHECK_FILE_HOURS.
CREATE TABLE email_check_parts (
  run_id           TEXT NOT NULL REFERENCES email_check_runs (id) ON DELETE CASCADE,
  part             INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'submitted', 'done', 'failed')),
  list_id          TEXT,
  file_key         TEXT,
  token_hash       TEXT UNIQUE,
  file_expires_at  INTEGER,
  percent          INTEGER NOT NULL DEFAULT 0,
  submitted_at     INTEGER,
  completed_at     INTEGER,
  error            TEXT CHECK (error IS NULL OR length(error) <= 500),
  PRIMARY KEY (run_id, part)
);

-- DeBounce takes at most five calls at once per account. A call holds a lease while it runs;
-- background calls leave the last place to signup forms. Leases end on their own.
CREATE TABLE email_check_leases (
  id          TEXT PRIMARY KEY,
  priority    TEXT NOT NULL CHECK (priority IN ('signup', 'background')),
  expires_at  INTEGER NOT NULL
);

-- "Check addresses during import".
ALTER TABLE import_jobs ADD COLUMN check_addresses INTEGER NOT NULL DEFAULT 0
  CHECK (check_addresses IN (0, 1));
ALTER TABLE import_jobs ADD COLUMN email_check_run_id TEXT;
