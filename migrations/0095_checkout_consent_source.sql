-- Checkout buyers (security review S02-P3-T-paid-activation). Paying no longer counts as
-- confirming an address: a Member created by a checkout starts pending, and its consent record
-- names the checkout as the source. Rebuilt because the CHECK on source changes; nothing
-- references this table.
CREATE TABLE member_consents_next (
  id            INTEGER PRIMARY KEY,
  member_id     TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK (source IN ('form', 'operator', 'api', 'import', 'checkout')),
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
  SELECT id, member_id, source, form_id, form_version, wording, ticked, must_confirm, attested_by,
         created_at
    FROM member_consents;
DROP TABLE member_consents;
ALTER TABLE member_consents_next RENAME TO member_consents;
CREATE INDEX member_consents_by_member ON member_consents (member_id, created_at);
