-- The payments ledger is keyed per Channel. stripe_object_id was unique across every Channel, so a
-- row one publication's webhook wrote for an object id blocked another publication's row for the
-- same id (first writer wins). Existing rows are unique by id alone, so they are unique per
-- Channel too. SQLite can't drop a column's UNIQUE, so the table is rebuilt; nothing references it.
CREATE TABLE payments_next (
  id                  TEXT PRIMARY KEY,
  channel_id          TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  member_id           TEXT REFERENCES members (id) ON DELETE SET NULL,
  subscription_id     TEXT REFERENCES member_subscriptions (id) ON DELETE SET NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('invoice', 'one_time', 'refund')),
  stripe_object_id    TEXT NOT NULL,
  currency            TEXT NOT NULL CHECK (length(currency) = 3),
  -- Negative for refunds.
  amount              INTEGER NOT NULL,
  occurred_at         INTEGER NOT NULL,
  UNIQUE (channel_id, stripe_object_id)
);
INSERT INTO payments_next
  SELECT id, channel_id, member_id, subscription_id, kind, stripe_object_id, currency, amount,
         occurred_at
    FROM payments;
DROP TABLE payments;
ALTER TABLE payments_next RENAME TO payments;
CREATE INDEX payments_by_channel ON payments (channel_id, occurred_at);
