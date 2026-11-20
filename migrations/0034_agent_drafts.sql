-- Who started a Dispatch, beyond the audit log: a draft made by an agent is marked where the
-- dashboard lists it, so nothing an agent wrote is mistaken for a teammate's work. NULL = a
-- teammate in the dashboard. 'api' = a direct /v2 call (an integration). 'agent' = an in-process
-- agent tool call through Open Operator (an MCP client or an approved call). 'copilot' = a
-- Copilot action. The agent audit log keeps the full story; this column is the list badge.
ALTER TABLE dispatches ADD COLUMN created_via TEXT
  CHECK (created_via IS NULL OR created_via IN ('agent', 'copilot', 'api'));
