-- "This wasn't me" for an account's first second factor (docs/security.md "Second factor").
-- When an account adds its first factor, the mail about it carries a single-use link, valid
-- FIRST_FACTOR_UNDO_DAYS (7). Only a hash of the link's token is stored. Using it removes every
-- factor added since window_start (and the recovery codes once no factor is left), signs out
-- every session, and sets operators.email_signin_required_at, so the next sign-in must be an
-- email link (Google and SSO are refused until then; a QuickPass sign-in clears it). Used or
-- expired rows are deleted OPERATOR_RECORD_DAYS later (packages/engine/src/lifetimes.ts).
CREATE TABLE factor_undo_tokens (
  token_hash    TEXT PRIMARY KEY,
  operator_id   TEXT NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  window_start  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER
);
CREATE INDEX factor_undo_tokens_by_operator ON factor_undo_tokens (operator_id);
ALTER TABLE operators ADD COLUMN email_signin_required_at INTEGER;
