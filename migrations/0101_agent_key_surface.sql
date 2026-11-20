-- Agent keys (security review P4): an API key can be limited to the MCP server, where the
-- workspace's approval mode holds calls, so whoever holds its value can't skip the holds by
-- calling /v2 directly. Contract: docs/open-operator.md "Keys for agents".
-- 'both': /mcp and /v2 (every key before this; integrations that call /v2 on purpose).
-- 'mcp': /mcp only; /v2 answers 401 for it.
ALTER TABLE api_keys ADD COLUMN surface TEXT NOT NULL DEFAULT 'both'
  CHECK (surface IN ('both', 'mcp'));
