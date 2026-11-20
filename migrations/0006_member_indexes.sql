-- Phase 3: Deliveries by Member. The Member activity timeline reads a Member's deliveries, and
-- deleting a Member erases their address from delivery history and runs the ON DELETE SET NULL
-- on deliveries.member_id; without this index each of those scans every delivery.
CREATE INDEX deliveries_by_member ON deliveries (member_id, sent_at);
