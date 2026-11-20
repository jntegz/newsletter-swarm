-- Unsubscribe links in old emails keep working after engagement retention (retention.ts) has
-- removed the Member from the delivery. Just before it does, the retention job writes one row
-- per delivery to someone who can still be mailed: which Member that delivery's unsubscribe link
-- stops, and nothing else. Only the unsubscribe page reads it (feedback.ts unsubscribeTarget).
-- Rows go with the Member (erasure, delete), and after UNSUBSCRIBE_REF_MONTHS.
CREATE TABLE unsubscribe_refs (
  delivery_id TEXT PRIMARY KEY REFERENCES deliveries (id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX unsubscribe_refs_by_member ON unsubscribe_refs (member_id);
CREATE INDEX unsubscribe_refs_by_expiry ON unsubscribe_refs (expires_at);
