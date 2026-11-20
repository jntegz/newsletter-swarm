-- Copilot budgets (security review P4): a workspace that pays with its own model key can set a
-- monthly ceiling. Units are what docs/copilot.md "Quotas" counts: one per editor request, and
-- one per started 25,000 tokens for an action run. NULL = no ceiling (as before).
ALTER TABLE copilot_keys ADD COLUMN monthly_unit_cap INTEGER
  CHECK (monthly_unit_cap IS NULL OR monthly_unit_cap > 0);
