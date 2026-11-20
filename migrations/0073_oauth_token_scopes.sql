-- OAuth refresh may narrow the scope (RFC 6749 section 6). An access token issued that way keeps
-- the subset here, as a JSON array; NULL (every other token) means the grant's scopes.
ALTER TABLE oauth_tokens ADD COLUMN scopes_json TEXT CHECK (scopes_json IS NULL OR json_valid(scopes_json));
