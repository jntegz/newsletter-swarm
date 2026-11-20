-- Mailgun's webhook signature covers only a timestamp and a token, not the event (security
-- review S02-P3-T-mailgun-body-substitution). A token is now bound to the event it first came
-- with: released after a failed apply, it is accepted again only with that same event, never a
-- substituted one. Tokens claimed before this have no hash and can't be released into a new event.
ALTER TABLE mailgun_webhook_tokens ADD COLUMN event_hash TEXT;
ALTER TABLE mailgun_webhook_tokens ADD COLUMN released INTEGER NOT NULL DEFAULT 0
  CHECK (released IN (0, 1));
