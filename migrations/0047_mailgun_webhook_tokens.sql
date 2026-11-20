-- Tokens of Mailgun webhooks already accepted. Mailgun's signature covers the timestamp and token
-- but not the event, so each token may be used once. Old rows are cleared as new ones arrive.
CREATE TABLE mailgun_webhook_tokens (
  token       TEXT PRIMARY KEY,
  expires_at  INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX mailgun_webhook_tokens_expires ON mailgun_webhook_tokens (expires_at);
