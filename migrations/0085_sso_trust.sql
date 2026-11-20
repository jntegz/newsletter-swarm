-- SSO trust that keeps being earned (docs/security.md "SSO").
--
-- Domain proof is a continuing fact. checked_at is the last time the TXT record was seen;
-- failing_since is set when a re-check first misses it and cleared when it is seen again. A proof
-- re-checked at sign-in after SSO_DOMAIN_RECHECK_HOURS, or when another workspace tries to verify
-- the same domain, lapses (verified_at goes back to NULL) once it has failed for
-- SSO_DOMAIN_LAPSE_DAYS, which frees the domain for whoever proves it now. Existing proofs count
-- as checked when they were verified.
ALTER TABLE sso_domains ADD COLUMN checked_at INTEGER;
ALTER TABLE sso_domains ADD COLUMN failing_since INTEGER;
UPDATE sso_domains SET checked_at = verified_at WHERE verified_at IS NOT NULL;

-- Domains a workspace proved and then released (the connection was deleted, or the domain
-- removed from it), with the provider they were proven for. Proving one of them again within
-- SSO_RELEASED_DOMAIN_DAYS for a different provider needs an owner: deleting a connection and
-- creating a new one must not let an admin pick the provider that the owner-only repoint rule
-- reserves. Rows past that period are only history and may be deleted.
CREATE TABLE sso_released_domains (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  domain        TEXT NOT NULL COLLATE NOCASE,
  issuer        TEXT NOT NULL,
  client_id     TEXT NOT NULL,
  released_at   INTEGER NOT NULL,
  released_by   TEXT REFERENCES operators (id) ON DELETE SET NULL
);
CREATE INDEX sso_released_domains_by_workspace ON sso_released_domains (workspace_id, domain, released_at);
