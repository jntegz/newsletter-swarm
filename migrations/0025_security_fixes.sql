-- Security fixes after the plan-vs-code audit.

-- The last verification of each workspace's hash chains (jobs worker, five-minute cron, every
-- chain at least once a day). A broken chain stays recorded here until it verifies again; the
-- break is also logged as an error.
CREATE TABLE audit_verifications (
  workspace_id   TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- Which chain: 'audit_events' or 'agent_actions' (the Open Operator agent log).
  chain          TEXT NOT NULL,
  verified_at    INTEGER NOT NULL,
  ok             INTEGER NOT NULL CHECK (ok IN (0, 1)),
  checked        INTEGER NOT NULL,
  broken_at_seq  INTEGER,
  -- When the chain was first seen broken; cleared once it verifies again.
  broken_since   INTEGER,
  PRIMARY KEY (workspace_id, chain)
);

CREATE INDEX audit_verifications_due ON audit_verifications (chain, verified_at);
