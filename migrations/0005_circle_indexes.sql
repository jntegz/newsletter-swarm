-- Phase 3: indexes for Circle conditions on engagement ("opened / clicked in the last N days").
-- Conventions as in 0001_foundation.sql.
--
-- The compiled condition is `m.id IN (SELECT d.member_id FROM deliveries d WHERE d.channel_id = ?
-- AND d.human_opened_at >= ? AND d.member_id IS NOT NULL)`. Without these, SQLite walks every
-- Delivery the Channel ever sent (deliveries_recent_by_channel is ordered by sent_at, not by the
-- open time). Partial, because most Deliveries are never opened or clicked; covering, so the
-- subquery never touches the table.
CREATE INDEX deliveries_human_opened_by_channel
  ON deliveries (channel_id, human_opened_at, member_id) WHERE human_opened_at IS NOT NULL;
CREATE INDEX deliveries_human_clicked_by_channel
  ON deliveries (channel_id, human_clicked_at, member_id) WHERE human_clicked_at IS NOT NULL;
