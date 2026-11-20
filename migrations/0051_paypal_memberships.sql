-- PayPal for paid memberships (flag paypal_memberships). docs/deployment.md.
-- The client secret is sealed with FIELD_KEYS together with the workspace.
CREATE TABLE paypal_accounts (
  channel_id      TEXT PRIMARY KEY REFERENCES channels (id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  mode            TEXT NOT NULL CHECK (mode IN ('live', 'sandbox')),
  client_id       TEXT NOT NULL,
  secret_enc      TEXT NOT NULL,
  secret_last4    TEXT NOT NULL,
  webhook_id      TEXT NOT NULL,
  connected_by    TEXT REFERENCES operators (id) ON DELETE SET NULL,
  connected_at    INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Every webhook event once. A failed one can be delivered and processed again.
CREATE TABLE paypal_events (
  event_id      TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  error         TEXT,
  received_at   INTEGER NOT NULL,
  processed_at  INTEGER
);

-- A PayPal subscription is a row with source 'stripe', which means "a recurring subscription" to
-- the entitlement rules. Widening the CHECK would rebuild a table other tables point at, and this
-- column is what tells them apart: its stripe_subscription_id stays NULL.
ALTER TABLE member_subscriptions ADD COLUMN paypal_subscription_id TEXT;
CREATE UNIQUE INDEX member_subscriptions_paypal ON member_subscriptions (paypal_subscription_id)
  WHERE paypal_subscription_id IS NOT NULL;

-- Made the first time a reader chooses PayPal for this price.
ALTER TABLE level_prices ADD COLUMN paypal_plan_id TEXT;
