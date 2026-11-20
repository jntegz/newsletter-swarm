-- A publication's own restricted Stripe key, as an alternative to Connect. The key and the webhook
-- signing secret are sealed with FIELD_KEYS together with the workspace; both are cleared when the
-- account is disconnected. docs/deployment.md.
ALTER TABLE stripe_accounts ADD COLUMN own_key_enc TEXT;
ALTER TABLE stripe_accounts ADD COLUMN own_key_last4 TEXT;
ALTER TABLE stripe_accounts ADD COLUMN webhook_endpoint_id TEXT;
ALTER TABLE stripe_accounts ADD COLUMN webhook_secret_enc TEXT;
