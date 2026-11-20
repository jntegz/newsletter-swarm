-- Phase 3: Members in full (statuses, sources, profile fields, tags), Capture Forms, confirm opt-in,
-- Circles, imports, exports, bulk jobs, referrals and targeted sends.
-- Conventions as in 0001_foundation.sql.

PRAGMA defer_foreign_keys = true;

-- Capture Forms come first: Members point at the form they joined through.
CREATE TABLE capture_forms (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id             TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  name                   TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  status                 TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  draft_config_json      TEXT NOT NULL CHECK (json_valid(draft_config_json)),
  -- What the embed serves. NULL until the first publish.
  published_config_json  TEXT CHECK (published_config_json IS NULL OR json_valid(published_config_json)),
  version                INTEGER NOT NULL DEFAULT 0,
  published_at           INTEGER,
  created_by             TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  deleted_at             INTEGER
);
CREATE INDEX capture_forms_by_channel ON capture_forms (channel_id, created_at) WHERE deleted_at IS NULL;

-- Every publish, for version history and rollback.
CREATE TABLE capture_form_versions (
  form_id       TEXT NOT NULL REFERENCES capture_forms (id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  config_json   TEXT NOT NULL CHECK (json_valid(config_json)),
  published_by  TEXT REFERENCES operators (id) ON DELETE SET NULL,
  published_at  INTEGER NOT NULL,
  PRIMARY KEY (form_id, version)
);

-- Views, submissions and confirmations per form per UTC day.
CREATE TABLE capture_form_daily (
  form_id      TEXT NOT NULL REFERENCES capture_forms (id) ON DELETE CASCADE,
  day          TEXT NOT NULL CHECK (length(day) = 10),
  views        INTEGER NOT NULL DEFAULT 0,
  submissions  INTEGER NOT NULL DEFAULT 0,
  confirmed    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (form_id, day)
);

CREATE TABLE import_jobs (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id         TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'uploaded'
                       CHECK (status IN ('uploaded', 'analyzing', 'analyzed', 'importing', 'done', 'failed', 'canceled')),
  file_name          TEXT NOT NULL CHECK (length(file_name) <= 200),
  r2_key             TEXT NOT NULL,
  bytes              INTEGER NOT NULL,
  -- {"<csv column>": "email" | "first_name" | "last_name" | "field:<key>" | "tags" | null}
  mapping_json       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(mapping_json)),
  -- The operator attests these people agreed to hear from the Channel; otherwise they start pending.
  consent_attested   INTEGER NOT NULL DEFAULT 0 CHECK (consent_attested IN (0, 1)),
  update_existing    INTEGER NOT NULL DEFAULT 0 CHECK (update_existing IN (0, 1)),
  -- The dry-run diff: counts per class plus samples.
  report_json        TEXT CHECK (report_json IS NULL OR json_valid(report_json)),
  total_rows         INTEGER NOT NULL DEFAULT 0,
  processed_rows     INTEGER NOT NULL DEFAULT 0,
  -- Byte offset into the file where the next chunk starts, so a retried chunk resumes.
  cursor             INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  created_by         TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  completed_at       INTEGER
);
CREATE INDEX import_jobs_by_channel ON import_jobs (channel_id, created_at);

-- Members, rebuilt: SQLite can't widen a CHECK in place. The rows that reference Members are
-- backed up first, because dropping the table runs their ON DELETE actions.
CREATE TABLE _phase3_recipients AS SELECT * FROM broadcast_recipients;
CREATE TABLE _phase3_deliveries AS SELECT id, member_id FROM deliveries WHERE member_id IS NOT NULL;

CREATE TABLE members_next (
  id                  TEXT PRIMARY KEY,
  channel_id          TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  email               TEXT NOT NULL COLLATE NOCASE CHECK (length(email) BETWEEN 3 AND 254),
  first_name          TEXT CHECK (first_name IS NULL OR length(first_name) <= 80),
  last_name           TEXT CHECK (last_name IS NULL OR length(last_name) <= 80),
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('pending', 'active', 'paused', 'unsubscribed', 'bounced', 'complained')),
  -- First-touch and latest attribution: utm_*, referrer, first_url, current_url, form_id, ref.
  source_json         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(source_json)),
  form_id             TEXT REFERENCES capture_forms (id) ON DELETE SET NULL,
  import_id           TEXT REFERENCES import_jobs (id) ON DELETE SET NULL,
  referred_by         TEXT REFERENCES members_next (id) ON DELETE SET NULL,
  digest              TEXT NOT NULL DEFAULT 'every' CHECK (digest IN ('every', 'weekly', 'monthly')),
  consent_at          INTEGER,
  confirmed_at        INTEGER,
  paused_until        INTEGER,
  unsubscribe_reason  TEXT CHECK (unsubscribe_reason IS NULL OR length(unsubscribe_reason) <= 500),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  unsubscribed_at     INTEGER,
  UNIQUE (channel_id, email)
);
INSERT INTO members_next (id, channel_id, email, first_name, last_name, status, created_at, updated_at, unsubscribed_at, confirmed_at)
  SELECT id, channel_id, email, first_name, last_name, status, created_at, updated_at, unsubscribed_at,
         CASE WHEN status = 'active' THEN created_at END
    FROM members;
DROP TABLE members;
ALTER TABLE members_next RENAME TO members;

INSERT INTO broadcast_recipients SELECT * FROM _phase3_recipients;
UPDATE deliveries SET member_id = (SELECT b.member_id FROM _phase3_deliveries b WHERE b.id = deliveries.id)
 WHERE id IN (SELECT id FROM _phase3_deliveries);
DROP TABLE _phase3_recipients;
DROP TABLE _phase3_deliveries;

-- The snapshot walks active Members in id order.
CREATE INDEX members_active_by_channel ON members (channel_id, id) WHERE status = 'active';
CREATE INDEX members_by_channel_status ON members (channel_id, status, id);
CREATE INDEX members_by_channel_created ON members (channel_id, created_at);
CREATE INDEX members_by_form ON members (form_id) WHERE form_id IS NOT NULL;
CREATE INDEX members_by_referrer ON members (referred_by) WHERE referred_by IS NOT NULL;
CREATE INDEX members_paused_until ON members (paused_until) WHERE status = 'paused';

-- Typed profile fields per Channel.
CREATE TABLE member_fields (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  key           TEXT NOT NULL CHECK (key GLOB '[a-z]*' AND length(key) BETWEEN 1 AND 40),
  label         TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  type          TEXT NOT NULL CHECK (type IN ('text', 'number', 'date', 'boolean', 'select', 'multi_select')),
  -- Choices for select and multi_select: ["Weekly", "Monthly"].
  options_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options_json)),
  -- Encrypted values (AES-256-GCM) can only be tested for presence in Circle rules.
  encrypted     INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0, 1)),
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE UNIQUE INDEX member_fields_key ON member_fields (channel_id, key) WHERE deleted_at IS NULL;

-- One value per Member per field. Exactly one value column is used, by field type:
--   text, select, date (YYYY-MM-DD) → value_text; number, boolean (0/1) → value_num;
--   multi_select → value_text as a JSON array; encrypted fields → value_enc only.
CREATE TABLE member_field_values (
  member_id   TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  field_id    TEXT NOT NULL REFERENCES member_fields (id) ON DELETE CASCADE,
  value_text  TEXT CHECK (value_text IS NULL OR length(value_text) <= 2000),
  value_num   REAL,
  value_enc   TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (member_id, field_id)
);
CREATE INDEX member_field_values_text ON member_field_values (field_id, value_text);
CREATE INDEX member_field_values_num ON member_field_values (field_id, value_num);

CREATE TABLE tags (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  name        TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 60),
  created_at  INTEGER NOT NULL,
  UNIQUE (channel_id, name)
);

CREATE TABLE member_tags (
  member_id   TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (member_id, tag_id)
);
CREATE INDEX member_tags_by_tag ON member_tags (tag_id, member_id);

-- A pending confirmation. The emailed token (purpose "confirm") carries this id.
CREATE TABLE confirm_requests (
  id            TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  form_id       TEXT REFERENCES capture_forms (id) ON DELETE SET NULL,
  -- "subscribe" for a new Member; "return" for an unsubscribed Member asking back in.
  kind          TEXT NOT NULL DEFAULT 'subscribe' CHECK (kind IN ('subscribe', 'return')),
  sent_count    INTEGER NOT NULL DEFAULT 1,
  last_sent_at  INTEGER NOT NULL,
  reminded_at   INTEGER,
  confirmed_at  INTEGER,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX confirm_requests_by_member ON confirm_requests (member_id, created_at);
-- Gentle Reminders: open requests whose reminder is due.
CREATE INDEX confirm_requests_open ON confirm_requests (last_sent_at)
  WHERE confirmed_at IS NULL AND reminded_at IS NULL;

CREATE TABLE referrals (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  referrer_id  TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  referred_id  TEXT NOT NULL UNIQUE REFERENCES members (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  CHECK (referrer_id <> referred_id)
);
CREATE INDEX referrals_by_referrer ON referrals (referrer_id);

-- Circles: a rule tree compiled to parameterised SQL, materialised into circle_members.
CREATE TABLE circles (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id     TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description    TEXT CHECK (description IS NULL OR length(description) <= 280),
  rule_json      TEXT NOT NULL CHECK (json_valid(rule_json)),
  member_count   INTEGER NOT NULL DEFAULT 0,
  -- Bumped on every rule change; a refresh only swaps in rows for the generation it computed.
  generation     INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'refreshing', 'ready', 'failed')),
  evaluated_at   INTEGER,
  error          TEXT,
  created_by     TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX circles_by_channel ON circles (channel_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE circle_members (
  circle_id   TEXT NOT NULL REFERENCES circles (id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  generation  INTEGER NOT NULL,
  PRIMARY KEY (circle_id, member_id)
);
CREATE INDEX circle_members_by_member ON circle_members (member_id);

CREATE TABLE export_jobs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  format        TEXT NOT NULL CHECK (format IN ('csv', 'jsonl')),
  -- {"circleId"?, "status"?}
  filter_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(filter_json)),
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  r2_key        TEXT,
  row_count     INTEGER NOT NULL DEFAULT 0,
  cursor        TEXT,
  error         TEXT,
  created_by    TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  expires_at    INTEGER
);
CREATE INDEX export_jobs_by_channel ON export_jobs (channel_id, created_at);

-- Bulk actions over a selection of Members, run by the jobs worker with progress.
CREATE TABLE bulk_jobs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id      TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  action          TEXT NOT NULL CHECK (action IN ('tag', 'untag', 'set_field', 'unsubscribe', 'delete')),
  params_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params_json)),
  -- {"memberIds": [...]} or {"circleId": "..."}
  selection_json  TEXT NOT NULL CHECK (json_valid(selection_json)),
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  total           INTEGER NOT NULL DEFAULT 0,
  processed       INTEGER NOT NULL DEFAULT 0,
  cursor          TEXT,
  error           TEXT,
  created_by      TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
CREATE INDEX bulk_jobs_by_channel ON bulk_jobs (channel_id, created_at);

-- Targeted sends: active Members in any of `include` (everyone when empty), minus any in `exclude`.
ALTER TABLE dispatches ADD COLUMN audience_json TEXT NOT NULL DEFAULT '{"include":[],"exclude":[]}' CHECK (json_valid(audience_json));
ALTER TABLE broadcasts ADD COLUMN audience_json TEXT NOT NULL DEFAULT '{"include":[],"exclude":[]}' CHECK (json_valid(audience_json));
