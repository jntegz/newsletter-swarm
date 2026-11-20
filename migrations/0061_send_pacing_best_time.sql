-- Send at each reader's best time: an opt-in per send (flag best_time_send).

-- The choice on a scheduled Dispatch, read when its time comes.
ALTER TABLE dispatches ADD COLUMN best_time INTEGER NOT NULL DEFAULT 0 CHECK (best_time IN (0, 1));

-- 0 not asked for; 1 readers get personal times; 2 asked for, but today's warm-up limit can't reach
-- the whole audience, so everyone went at the chosen time in warm-up order.
ALTER TABLE broadcasts ADD COLUMN best_time INTEGER NOT NULL DEFAULT 0 CHECK (best_time IN (0, 1, 2));
-- Frozen when the snapshot ends, for the send report.
ALTER TABLE broadcasts ADD COLUMN personal_time_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE broadcasts ADD COLUMN default_time_count INTEGER NOT NULL DEFAULT 0;
-- The minute cron looks only at sends that hold readers back, so other installs pay nothing.
CREATE INDEX broadcasts_best_time_open ON broadcasts (last_progress_at)
  WHERE best_time = 1 AND status = 'sending';

-- A reader's slot. Set means a personal time; held stays 1 until it comes round. NULL for everyone
-- else, including every recipient of a send that didn't ask for this.
ALTER TABLE broadcast_recipients ADD COLUMN send_after INTEGER;
CREATE INDEX broadcast_recipients_slots ON broadcast_recipients (broadcast_id, send_after)
  WHERE held = 1 AND send_after IS NOT NULL;

-- A Member's best hour in UTC, from when a person opened or clicked before. Member data: exported
-- and erased with the Member, and dropped 90 days after a send last worked it out.
CREATE TABLE member_send_hours (
  member_id     TEXT PRIMARY KEY REFERENCES members (id) ON DELETE CASCADE,
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  best_hour_utc INTEGER NOT NULL CHECK (best_hour_utc BETWEEN 0 AND 23),
  samples       INTEGER NOT NULL,
  computed_at   INTEGER NOT NULL
);
CREATE INDEX member_send_hours_by_age ON member_send_hours (computed_at);
