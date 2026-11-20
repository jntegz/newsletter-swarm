-- An operator's own record of account security events: sign-ins with the network prefix and
-- browser, factor changes, recovery codes and signing out everywhere. Only the operator reads it
-- (Settings > Security > Account activity, GET /api/v1/security). Each workspace's audit log gets
-- a reduced copy of the same event: its action, method and time, with no network prefix or
-- browser (workers/api/src/lib/account-events.ts). Audit entries written before this migration
-- keep what they recorded; the hash chain is not rewritten. Rows are deleted ACCOUNT_EVENT_DAYS
-- after they were made (packages/engine/src/lifetimes.ts).
CREATE TABLE account_events (
  id            TEXT PRIMARY KEY,
  operator_id   TEXT NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  action        TEXT NOT NULL,
  method        TEXT,
  ip_prefix     TEXT,
  user_agent    TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX account_events_by_operator ON account_events (operator_id, created_at);
CREATE INDEX account_events_by_age ON account_events (created_at);
