-- How many mails of one kind one address has had in the current window, for mails anyone can ask
-- for by typing an address (the goods library link). key_hash is SHA-256 of the scope's own key
-- (Channel and lowercase address), so no address is stored. One row per scope and key: the window
-- restarts when it has passed. The daily site housekeeping deletes rows whose window ended.
CREATE TABLE mail_allowances (
  scope         TEXT NOT NULL CHECK (length(scope) <= 40),
  key_hash      TEXT NOT NULL CHECK (length(key_hash) = 64),
  window_start  INTEGER NOT NULL,
  used          INTEGER NOT NULL CHECK (used >= 0),
  PRIMARY KEY (scope, key_hash)
) WITHOUT ROWID;
CREATE INDEX mail_allowances_by_window ON mail_allowances (window_start);
