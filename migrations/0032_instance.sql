-- Self-hosting: instance-wide settings and the people who may change them. Contract: the
-- installer (packages/installer) writes these rows when it bootstraps the owner, and
-- workers/api/src/lib/instance.ts reads them. Conventions as in 0001_foundation.sql.

-- One row per setting. No 'signup' row means sign-up is open, so dev, tests and installs that
-- predate this migration keep working unchanged. 'invite_only' admits existing operators and
-- addresses with a pending invite; SSO just-in-time provisioning is a separate admission path.
CREATE TABLE instance_settings (
  key         TEXT PRIMARY KEY CHECK (key IN ('signup')),
  value       TEXT NOT NULL,
  updated_by  TEXT REFERENCES operators (id) ON DELETE SET NULL,
  updated_at  INTEGER NOT NULL,
  CHECK (key <> 'signup' OR value IN ('open', 'invite_only'))
);

-- Operators who can change instance settings. The installer adds the owner it creates.
CREATE TABLE instance_admins (
  operator_id  TEXT PRIMARY KEY REFERENCES operators (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL
);
