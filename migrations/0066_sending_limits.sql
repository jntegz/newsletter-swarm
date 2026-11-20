-- Sending limits (Settings > Instance): how much the email service lets this install send, and
-- sends that wait for a limit. Contract: packages/domain/src/sending-limits.ts. Every email takes
-- its share from the realtime worker's SendPacer (packages/engine/src/sending-limits.ts asks it),
-- and the send pipeline (packages/engine/src/pipeline.ts) records a wait on the Broadcast.

-- At most one row, written by instance admins (workers/api/src/routes/instance.ts). No row, or a
-- NULL column, means no limit of that kind. Hours, days and months are UTC and fixed: the clock
-- hour, the calendar day and the calendar month. MAIL_MAX_PER_SECOND on the send worker, where it
-- is set, still caps per_second: the lower of the two applies.
CREATE TABLE sending_limits (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  per_second  REAL CHECK (per_second IS NULL OR (per_second >= 0.1 AND per_second <= 1000)),
  per_hour    INTEGER CHECK (per_hour IS NULL OR per_hour BETWEEN 10 AND 100000000),
  per_day     INTEGER CHECK (per_day IS NULL OR per_day BETWEEN 10 AND 100000000),
  per_month   INTEGER CHECK (per_month IS NULL OR per_month BETWEEN 10 AND 100000000),
  updated_by  TEXT REFERENCES operators (id) ON DELETE SET NULL,
  updated_at  INTEGER NOT NULL
);

-- A Broadcast waiting for a limit keeps status 'sending', and its unsent recipients stay
-- 'pending'. With resume_at it continues by itself then; without, a person resumes it
-- (POST /api/v1/broadcasts/{broadcastId}/resume).
--   hour, day, month            this install's own limits (sending_limits)
--   service_day, service_month  the email service said its own quota is used up
--   service_stopped             the email service stopped accepting mail: a suspended account,
--                               refused credentials, an unverified domain. Such a send used to
--                               end as 'failed' with the rest of its audience never mailed.
ALTER TABLE broadcasts ADD COLUMN waiting_for TEXT
  CHECK (waiting_for IS NULL OR waiting_for IN ('hour', 'day', 'month', 'service_day', 'service_month', 'service_stopped'));
ALTER TABLE broadcasts ADD COLUMN waiting_since INTEGER;
-- What the email service said, for the service_ waits.
ALTER TABLE broadcasts ADD COLUMN wait_detail TEXT;
-- The reaper's resume pass and the count on Settings > Instance.
CREATE INDEX broadcasts_waiting ON broadcasts (resume_at)
  WHERE waiting_for IS NOT NULL AND status IN ('queued', 'sending');
