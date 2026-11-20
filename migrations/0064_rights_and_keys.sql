-- Data rights and access that ends with the person. Contracts: docs/architecture.md "Privacy
-- Center", docs/security.md "Teammates leaving". Conventions as in 0001_foundation.sql.

-- An erasure asked for from subscriber settings waits for the subscriber to confirm it from their
-- inbox: the settings link is in every email footer, so whoever holds a forwarded email could
-- otherwise erase the address. The emailed link carries a token naming this row; the row is used
-- once (used_at set atomically) and expires (DSR_CONFIRM_LINK_HOURS). Rows go with the Member.
CREATE TABLE dsr_confirmations (
  id          INTEGER PRIMARY KEY,
  member_id   TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('erase')),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX dsr_confirmations_by_member ON dsr_confirmations (member_id, created_at);

-- Consent records gain the source 'import' (an operator attested the people on the list agreed)
-- and who attested it: an operator id, or 'key:<id>' or 'oauth:<id>' for an import through /v2.
-- Rebuilt because the CHECK on source changes. Nothing references this table.
CREATE TABLE member_consents_next (
  id            INTEGER PRIMARY KEY,
  member_id     TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK (source IN ('form', 'operator', 'api', 'import')),
  form_id       TEXT,
  form_version  INTEGER,
  wording       TEXT,
  ticked        INTEGER CHECK (ticked IS NULL OR ticked IN (0, 1)),
  must_confirm  INTEGER NOT NULL CHECK (must_confirm IN (0, 1)),
  attested_by   TEXT CHECK (attested_by IS NULL OR length(attested_by) <= 80),
  created_at    INTEGER NOT NULL
);
INSERT INTO member_consents_next (id, member_id, source, form_id, form_version, wording, ticked,
    must_confirm, attested_by, created_at)
  SELECT id, member_id, source, form_id, form_version, wording, ticked, must_confirm, NULL, created_at
    FROM member_consents;
DROP TABLE member_consents;
ALTER TABLE member_consents_next RENAME TO member_consents;
CREATE INDEX member_consents_by_member ON member_consents (member_id, created_at);

-- Who ticked "Everyone on this list agreed" on an import, in the form attested_by takes above.
ALTER TABLE import_jobs ADD COLUMN consent_attested_by TEXT;

-- Imported people who never confirm are deleted after IMPORT_PENDING_DAYS (jobs worker, daily).
CREATE INDEX members_pending_imports ON members (created_at)
  WHERE status = 'pending' AND import_id IS NOT NULL;

-- Removing a seat revokes the API keys that person created in the workspace and the app installs
-- they authorised for it (workers/api seat removal, with audit entries).
CREATE INDEX api_keys_by_creator ON api_keys (created_by, workspace_id) WHERE revoked_at IS NULL;
CREATE INDEX oauth_grants_by_operator ON oauth_grants (operator_id, workspace_id)
  WHERE revoked_at IS NULL;

-- Deleting an operator row (there is no route for it; an install admin may do it in SQL) would
-- null created_by and operator_id and leave the keys and grants working. Revoke them first.
CREATE TRIGGER operators_delete_revokes_access BEFORE DELETE ON operators
BEGIN
  UPDATE api_keys SET revoked_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
   WHERE created_by = OLD.id AND revoked_at IS NULL;
  UPDATE oauth_tokens SET revoked_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
   WHERE revoked_at IS NULL
     AND grant_id IN (SELECT id FROM oauth_grants WHERE operator_id = OLD.id);
  UPDATE oauth_grants SET revoked_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
   WHERE operator_id = OLD.id AND revoked_at IS NULL;
END;
