-- An unsubscribed Member who is then deleted, kept only as a hash of the address. Leaving
-- "unsubscribed" takes the person's own confirmation, so deleting the row and adding the address
-- back, by hand or by import, must not make them active again.
CREATE TABLE left_addresses (
  channel_id  TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  email_hash  TEXT NOT NULL,
  left_at     INTEGER NOT NULL,
  PRIMARY KEY (channel_id, email_hash)
) WITHOUT ROWID;
