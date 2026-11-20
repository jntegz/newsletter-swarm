-- During warm-up a Broadcast reaches engaged readers first, because early engagement builds a new
-- domain's reputation. send_tier is frozen at snapshot: 1 engaged, 2 unknown, 0 cold, sent in that
-- order. broadcasts.fanout_tier is the tier being walked, and NULL means no ordering, as for any
-- Broadcast outside warm-up: the fan-out then ignores send_tier.
ALTER TABLE broadcast_recipients ADD COLUMN send_tier INTEGER NOT NULL DEFAULT 0 CHECK (send_tier IN (0, 1, 2));
ALTER TABLE broadcasts ADD COLUMN fanout_tier INTEGER CHECK (fanout_tier IS NULL OR fanout_tier IN (0, 1, 2));
CREATE INDEX broadcast_recipients_by_tier ON broadcast_recipients (broadcast_id, send_tier, member_id)
  WHERE send_tier > 0;
