-- A workspace's daily allowance of single DeBounce checks (signups, additions by hand, "Check
-- again"), set by an instance admin (security review S02-P3-T-debounce-shared-capacity). Without
-- a row a workspace gets EMAIL_CHECK_DAILY_CHECKS. Use is counted in usage_windows.
CREATE TABLE email_check_budgets (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  daily_checks  INTEGER NOT NULL CHECK (daily_checks >= 0 AND daily_checks <= 1000000),
  updated_by    TEXT,
  updated_at    INTEGER NOT NULL
);
