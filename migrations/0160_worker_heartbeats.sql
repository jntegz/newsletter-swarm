-- worker_heartbeats: the last time a Worker without a public host checked it can reach the vault
-- through its binding. The jobs worker's minute cron pings the vault and records the answer here;
-- `pnpm swarm update` waits for a successful one since its deploy before it removes keys the
-- workers no longer need, and `pnpm swarm doctor` reports how recent it is. No value, no secret.
CREATE TABLE worker_heartbeats (
  worker      TEXT PRIMARY KEY CHECK (worker IN ('jobs')),
  -- When it last checked, and whether the vault answered then.
  checked_at  INTEGER NOT NULL,
  ok          INTEGER NOT NULL CHECK (ok IN (0, 1)),
  -- The last check the vault answered (kept through failed ones), or null if none has.
  ok_at       INTEGER
);
