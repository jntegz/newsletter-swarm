-- A daily verification pass over a long hash chain spans several five-minute runs. This is where
-- an unfinished pass resumes: the last event it verified (seq and hash) and how many it has
-- checked. The row goes when the pass finishes and its result is written to audit_verifications.
-- updated_at orders the queue, so a long chain in progress waits behind the workspaces no run
-- has looked at since, instead of holding the head of it.
CREATE TABLE audit_verification_passes (
  workspace_id   TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- Which chain: 'audit_events' or 'agent_actions', as in audit_verifications.
  chain          TEXT NOT NULL,
  through_seq    INTEGER NOT NULL,
  through_hash   TEXT NOT NULL,
  checked        INTEGER NOT NULL,
  started_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, chain)
);
