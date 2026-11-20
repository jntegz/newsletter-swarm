-- Phase 7 (OAuth apps and the Direct Send API): what 0012_platform.sql does not cover yet.
-- Contracts: docs/oauth.md and docs/direct-send.md.

-- Who sent a Direct Send: an API key (api_key_id, 0012) or an OAuth grant. Never both.
ALTER TABLE direct_sends ADD COLUMN oauth_grant_id TEXT;
-- The body came from a Template (template_id, 0012) or from an existing Dispatch.
ALTER TABLE direct_sends ADD COLUMN dispatch_id TEXT REFERENCES dispatches (id) ON DELETE SET NULL;
-- The per-workspace daily limit (PLAN_LIMITS.directSendsPerDay) counts rows since UTC midnight.
CREATE INDEX direct_sends_by_workspace ON direct_sends (workspace_id, created_at);

-- Every token issued from a grant, for revoking a grant and listing authorised apps.
CREATE INDEX oauth_tokens_by_grant ON oauth_tokens (grant_id);
