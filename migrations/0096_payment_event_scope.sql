-- Payment event claims belong to the scope that verified them (security review
-- S02-P3-T-stripe-eventid-reclaim, S02-P3-T-paypal-stuck-claim). An event id was one global key,
-- so a delivery verified for one account or Channel could take over, overwrite or suppress
-- another's claim. Each table is rebuilt with the scope in its key: the Stripe account the event
-- resolved through ('' for a platform event without one), and the PayPal Channel whose webhook
-- verified it. Nothing references these tables.
CREATE TABLE stripe_events_next (
  event_id            TEXT NOT NULL CHECK (event_id GLOB 'evt_*'),
  stripe_account_id   TEXT NOT NULL DEFAULT '',
  channel_id          TEXT REFERENCES channels (id) ON DELETE SET NULL,
  type                TEXT NOT NULL CHECK (length(type) <= 120),
  livemode            INTEGER NOT NULL DEFAULT 0 CHECK (livemode IN (0, 1)),
  status              TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  error               TEXT CHECK (error IS NULL OR length(error) <= 1000),
  created_at          INTEGER NOT NULL,
  received_at         INTEGER NOT NULL,
  processed_at        INTEGER,
  PRIMARY KEY (stripe_account_id, event_id)
);
INSERT INTO stripe_events_next (event_id, stripe_account_id, channel_id, type, livemode, status, error,
    created_at, received_at, processed_at)
  SELECT event_id, coalesce(stripe_account_id, ''), channel_id, type, livemode, status, error,
         created_at, received_at, processed_at
    FROM stripe_events;
DROP TABLE stripe_events;
ALTER TABLE stripe_events_next RENAME TO stripe_events;
CREATE INDEX stripe_events_by_channel ON stripe_events (channel_id, received_at);
-- Unfinished claims, for operators and for recovery.
CREATE INDEX stripe_events_unfinished ON stripe_events (status, received_at)
  WHERE status IN ('received', 'failed');

CREATE TABLE paypal_events_next (
  event_id      TEXT NOT NULL,
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  error         TEXT,
  received_at   INTEGER NOT NULL,
  processed_at  INTEGER,
  PRIMARY KEY (channel_id, event_id)
);
INSERT INTO paypal_events_next (event_id, channel_id, type, status, error, received_at, processed_at)
  SELECT event_id, channel_id, type, status, error, received_at, processed_at FROM paypal_events;
DROP TABLE paypal_events;
ALTER TABLE paypal_events_next RENAME TO paypal_events;
CREATE INDEX paypal_events_unfinished ON paypal_events (channel_id, status, received_at)
  WHERE status IN ('received', 'failed');
