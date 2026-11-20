-- svix-id of Svix-signed webhooks already accepted (Resend, and reports from a person's own mail
-- server). A signature stays valid for five minutes, so each id may be used once. Old rows are
-- cleared as new ones arrive.
CREATE TABLE svix_webhook_ids (
  id          TEXT PRIMARY KEY,
  expires_at  INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX svix_webhook_ids_expires ON svix_webhook_ids (expires_at);
