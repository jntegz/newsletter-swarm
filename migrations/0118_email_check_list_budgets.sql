-- A workspace's monthly allowance for checks of a list (bulk runs, and imports that check their
-- addresses), set by an instance admin (security review S04-P3-TR-list-check-tenant-budget).
-- Without a row a workspace gets EMAIL_CHECK_MONTHLY_LIST_CHECKS per calendar month (UTC). Use is
-- counted in usage_windows (scope email_check_list:<workspace>) when a run starts, for every
-- address it will send to DeBounce; what a stopped run never sent is given back.
CREATE TABLE email_check_list_budgets (
  workspace_id    TEXT PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  monthly_checks  INTEGER NOT NULL CHECK (monthly_checks >= 0 AND monthly_checks <= 100000000),
  updated_by      TEXT,
  updated_at      INTEGER NOT NULL
);

-- What a run took from that allowance when it started, and the month it took it from, so a stop
-- gives back only what it took and only to that month.
ALTER TABLE email_check_runs ADD COLUMN budget_taken INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_check_runs ADD COLUMN budget_month INTEGER;
