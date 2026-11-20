-- An owner's own wording for the emails Swarm sends for them: confirmations, sign-in links, payment
-- notices. No row means the built-in wording. message_send_log stops a replayed payment event from
-- mailing twice; its keys hold ids from the payment service, never an address.
CREATE TABLE channel_messages (
  channel_id   TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  subject      TEXT NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('text', 'html')),
  heading      TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL,
  button_label TEXT NOT NULL DEFAULT '',
  updated_by   TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (channel_id, key)
);
CREATE TABLE message_send_log (
  dedupe_key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
