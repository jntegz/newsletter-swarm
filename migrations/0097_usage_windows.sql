-- Fixed-window usage counters (security review S02-P3-T-paypal-verify-amplify and
-- S02-P3-T-debounce-shared-capacity): one row per scope, such as the PayPal signature checks a
-- Channel's webhook may ask for in a minute, or the DeBounce checks a workspace may spend in a
-- day. Scopes hold ids only, never an address.
CREATE TABLE usage_windows (
  scope         TEXT PRIMARY KEY CHECK (length(scope) <= 120),
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL CHECK (count >= 0)
);
