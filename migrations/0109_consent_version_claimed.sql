-- A consent record says whether the form version it names is one the server knows it presented
-- (the version it serves now: 0) or only one the submission named (an older version a cached
-- page or a pinned embed may show, or a hand-made request may claim: 1). Records written before
-- this did not tell the two apart; they keep 0.
ALTER TABLE member_consents ADD COLUMN version_claimed INTEGER NOT NULL DEFAULT 0
  CHECK (version_claimed IN (0, 1));
