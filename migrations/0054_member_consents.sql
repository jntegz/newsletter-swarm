-- What a person agreed to when they joined: the wording shown, the form version it came from and
-- whether the box was ticked. `members.consent_at` and `confirmed_at` say when; this says what.
-- Rows go with the Member (ON DELETE CASCADE), so erasure removes them.
CREATE TABLE member_consents (
  id            INTEGER PRIMARY KEY,
  member_id     TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK (source IN ('form', 'operator', 'api')),
  form_id       TEXT,
  form_version  INTEGER,
  wording       TEXT,
  ticked        INTEGER CHECK (ticked IS NULL OR ticked IN (0, 1)),
  must_confirm  INTEGER NOT NULL CHECK (must_confirm IN (0, 1)),
  created_at    INTEGER NOT NULL
);
CREATE INDEX member_consents_by_member ON member_consents (member_id, created_at);
