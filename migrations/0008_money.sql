-- Phase 5: Membership levels and payments through each Channel's own Stripe account (Connect
-- Standard, 0% platform take). Levels and prices, connected accounts, webhook events, Member
-- subscriptions as the entitlement source of truth, Gates and meters, coupons, comp grants,
-- Gift Passes, gift articles, pledges and the payment ledger.
-- Conventions as in 0001_foundation.sql. Money is in minor units (cents) with an ISO 4217
-- currency in lowercase, as Stripe uses.

-- One connected Stripe account per Channel. The platform never sets an application fee.
CREATE TABLE stripe_accounts (
  channel_id          TEXT PRIMARY KEY REFERENCES channels (id) ON DELETE CASCADE,
  workspace_id        TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  stripe_account_id   TEXT NOT NULL UNIQUE CHECK (stripe_account_id GLOB 'acct_*'),
  status              TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected')),
  charges_enabled     INTEGER NOT NULL DEFAULT 0 CHECK (charges_enabled IN (0, 1)),
  payouts_enabled     INTEGER NOT NULL DEFAULT 0 CHECK (payouts_enabled IN (0, 1)),
  details_submitted   INTEGER NOT NULL DEFAULT 0 CHECK (details_submitted IN (0, 1)),
  livemode            INTEGER NOT NULL DEFAULT 0 CHECK (livemode IN (0, 1)),
  default_currency    TEXT CHECK (default_currency IS NULL OR length(default_currency) = 3),
  -- Stripe Tax on Checkout (automatic_tax), per account.
  tax_enabled         INTEGER NOT NULL DEFAULT 0 CHECK (tax_enabled IN (0, 1)),
  -- Days a past_due subscription keeps access before it is downgraded.
  grace_days          INTEGER NOT NULL DEFAULT 7 CHECK (grace_days BETWEEN 0 AND 30),
  connected_by        TEXT REFERENCES operators (id) ON DELETE SET NULL,
  connected_at        INTEGER NOT NULL,
  disconnected_at     INTEGER,
  updated_at          INTEGER NOT NULL
);

-- Every webhook event once. A duplicate delivery finds its row and is skipped.
CREATE TABLE stripe_events (
  event_id            TEXT PRIMARY KEY CHECK (event_id GLOB 'evt_*'),
  stripe_account_id   TEXT,
  channel_id          TEXT REFERENCES channels (id) ON DELETE SET NULL,
  type                TEXT NOT NULL CHECK (length(type) <= 120),
  livemode            INTEGER NOT NULL DEFAULT 0 CHECK (livemode IN (0, 1)),
  status              TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  error               TEXT CHECK (error IS NULL OR length(error) <= 1000),
  created_at          INTEGER NOT NULL,
  received_at         INTEGER NOT NULL,
  processed_at        INTEGER
);
CREATE INDEX stripe_events_by_channel ON stripe_events (channel_id, received_at);

-- A free level always exists implicitly; these are the paid ones.
CREATE TABLE membership_levels (
  id                  TEXT PRIMARY KEY,
  channel_id          TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  description         TEXT CHECK (description IS NULL OR length(description) <= 500),
  -- ["Every Dispatch in full", "The archive"]
  benefits_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(benefits_json)),
  -- A Founding Level (flag founding_level): shown above the others, with a minimum price.
  founding            INTEGER NOT NULL DEFAULT 0 CHECK (founding IN (0, 1)),
  visibility          TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'hidden')),
  -- Card-required trial length; 0 for none.
  trial_days          INTEGER NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  position            INTEGER NOT NULL DEFAULT 0,
  stripe_product_id   TEXT,
  created_by          TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX membership_levels_by_channel ON membership_levels (channel_id, status, position);

-- Prices are never edited: a change is a new row (and a new Stripe Price). A scheduled change
-- has status 'scheduled' and effective_at; when it takes effect the previous price is retired,
-- and existing subscribers are migrated at renewal unless they are grandfathered.
CREATE TABLE level_prices (
  id                  TEXT PRIMARY KEY,
  level_id            TEXT NOT NULL REFERENCES membership_levels (id) ON DELETE CASCADE,
  channel_id          TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  interval            TEXT NOT NULL CHECK (interval IN ('month', 'year', 'lifetime')),
  currency            TEXT NOT NULL CHECK (length(currency) = 3),
  amount              INTEGER NOT NULL CHECK (amount >= 0),
  -- Pay what you want (flag pay_what_you_want): amount is the suggestion, min_amount the floor.
  custom_amount       INTEGER NOT NULL DEFAULT 0 CHECK (custom_amount IN (0, 1)),
  min_amount          INTEGER CHECK (min_amount IS NULL OR min_amount >= 0),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'scheduled', 'retired')),
  effective_at        INTEGER,
  -- For a scheduled change: 'migrate' moves existing subscribers at renewal, 'grandfather' keeps them.
  existing            TEXT NOT NULL DEFAULT 'grandfather' CHECK (existing IN ('grandfather', 'migrate')),
  stripe_price_id     TEXT,
  created_at          INTEGER NOT NULL,
  retired_at          INTEGER,
  CHECK (status <> 'scheduled' OR effective_at IS NOT NULL)
);
CREATE INDEX level_prices_by_level ON level_prices (level_id, interval, status);
CREATE UNIQUE INDEX level_prices_active ON level_prices (level_id, interval) WHERE status = 'active';
CREATE INDEX level_prices_due ON level_prices (effective_at) WHERE status = 'scheduled';

-- A Member's customer object on the Channel's connected account.
CREATE TABLE stripe_customers (
  member_id           TEXT PRIMARY KEY REFERENCES members (id) ON DELETE CASCADE,
  channel_id          TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  stripe_customer_id  TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  UNIQUE (channel_id, stripe_customer_id)
);

-- Checkout Sessions we created. The row is written before the session, keyed by a random
-- reference; client_reference_id is that reference signed (purpose 'checkout-ref'), and the
-- webhook trusts only what this row says, never the session's metadata.
CREATE TABLE checkout_sessions (
  reference           TEXT PRIMARY KEY CHECK (length(reference) BETWEEN 16 AND 64),
  stripe_session_id   TEXT UNIQUE CHECK (stripe_session_id IS NULL OR stripe_session_id GLOB 'cs_*'),
  channel_id          TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  -- A Gift Pass or pledge this checkout pays for, when the intent is one of those.
  subject_id          TEXT,
  coupon_id           TEXT,
  -- Pay what you want: the amount the reader chose, in minor units.
  custom_amount       INTEGER CHECK (custom_amount IS NULL OR custom_amount > 0),
  level_id            TEXT REFERENCES membership_levels (id) ON DELETE SET NULL,
  price_id            TEXT REFERENCES level_prices (id) ON DELETE SET NULL,
  member_id           TEXT REFERENCES members (id) ON DELETE SET NULL,
  email               TEXT COLLATE NOCASE,
  intent              TEXT NOT NULL CHECK (intent IN ('subscribe', 'lifetime', 'gift', 'pledge', 'tip')),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'complete', 'expired')),
  created_at          INTEGER NOT NULL,
  completed_at        INTEGER
);
CREATE INDEX checkout_sessions_by_channel ON checkout_sessions (channel_id, created_at);

-- The entitlement source of truth. One row per Stripe subscription, lifetime purchase, Gift Pass
-- or comp grant; member_entitlements is recomputed from these (see @swarm/engine entitlements).
CREATE TABLE member_subscriptions (
  id                       TEXT PRIMARY KEY,
  channel_id               TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  member_id                TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  level_id                 TEXT REFERENCES membership_levels (id) ON DELETE SET NULL,
  price_id                 TEXT REFERENCES level_prices (id) ON DELETE SET NULL,
  source                   TEXT NOT NULL CHECK (source IN ('stripe', 'lifetime', 'gift', 'comp')),
  -- Stripe's statuses, plus 'lifetime' and 'ended' for rows that don't come from a subscription.
  status                   TEXT NOT NULL CHECK (status IN (
                             'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due',
                             'unpaid', 'canceled', 'paused', 'lifetime', 'ended')),
  stripe_subscription_id   TEXT UNIQUE,
  stripe_customer_id       TEXT,
  interval                 TEXT CHECK (interval IS NULL OR interval IN ('month', 'year', 'lifetime')),
  currency                 TEXT CHECK (currency IS NULL OR length(currency) = 3),
  amount                   INTEGER CHECK (amount IS NULL OR amount >= 0),
  current_period_end       INTEGER,
  trial_end                INTEGER,
  cancel_at                INTEGER,
  cancel_at_period_end     INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  canceled_at              INTEGER,
  -- Set when a payment fails: access lasts until then, then the jobs cron downgrades.
  grace_until              INTEGER,
  -- Ends access regardless of status (refund, dispute, comp revoked).
  revoked_at               INTEGER,
  revoke_reason            TEXT CHECK (revoke_reason IS NULL OR revoke_reason IN (
                             'refund', 'dispute', 'grace_expired', 'canceled', 'operator', 'expired')),
  -- Stripe's event time of the last applied update; older events never overwrite newer state.
  stripe_updated_at        INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
CREATE INDEX member_subscriptions_by_member ON member_subscriptions (member_id, status);
CREATE INDEX member_subscriptions_by_channel ON member_subscriptions (channel_id, status, created_at);
CREATE INDEX member_subscriptions_grace ON member_subscriptions (grace_until) WHERE grace_until IS NOT NULL;

-- Phase 4 created member_entitlements (one 'paid' row per Member). It now also names the level,
-- so a Gate can admit some levels and not others.
ALTER TABLE member_entitlements ADD COLUMN level_id TEXT REFERENCES membership_levels (id) ON DELETE SET NULL;

-- Money that moved: invoices paid, one-time payments, refunds. For revenue analytics only;
-- Stripe stays the ledger of record.
CREATE TABLE payments (
  id                  TEXT PRIMARY KEY,
  channel_id          TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  member_id           TEXT REFERENCES members (id) ON DELETE SET NULL,
  subscription_id     TEXT REFERENCES member_subscriptions (id) ON DELETE SET NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('invoice', 'one_time', 'refund')),
  stripe_object_id    TEXT NOT NULL UNIQUE,
  currency            TEXT NOT NULL CHECK (length(currency) = 3),
  -- Negative for refunds.
  amount              INTEGER NOT NULL,
  occurred_at         INTEGER NOT NULL
);
CREATE INDEX payments_by_channel ON payments (channel_id, occurred_at);

-- Per-Dispatch Gate: which levels read past the gate divider (empty = any paid level), whether
-- the meter applies, and an optional custom design.
CREATE TABLE gates (
  dispatch_id      TEXT PRIMARY KEY REFERENCES dispatches (id) ON DELETE CASCADE,
  channel_id       TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  level_ids_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(level_ids_json)),
  metered          INTEGER NOT NULL DEFAULT 1 CHECK (metered IN (0, 1)),
  -- { "headline", "body", "ctaLabel", "benefits": [] }
  design_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(design_json)),
  updated_by       TEXT REFERENCES operators (id) ON DELETE SET NULL,
  updated_at       INTEGER NOT NULL
);

-- Channel-wide Gate defaults and the meter.
CREATE TABLE gate_settings (
  channel_id       TEXT PRIMARY KEY REFERENCES channels (id) ON DELETE CASCADE,
  -- Free gated Dispatches per period per reader; 0 turns the meter off.
  meter_limit      INTEGER NOT NULL DEFAULT 0 CHECK (meter_limit BETWEEN 0 AND 100),
  meter_period     TEXT NOT NULL DEFAULT 'month' CHECK (meter_period IN ('week', 'month')),
  -- 'soft' Gates can be dismissed once the meter is spent; 'hard' ones can't.
  meter_mode       TEXT NOT NULL DEFAULT 'hard' CHECK (meter_mode IN ('soft', 'hard')),
  design_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(design_json)),
  -- Coupon shown inside the Gate (flag paywall_coupon).
  gate_coupon_id   TEXT,
  updated_at       INTEGER NOT NULL
);

-- One row per gated Dispatch a reader read on the meter in a period. reader_key is the Member id,
-- or 'a:' + a hash of the anonymous meter cookie.
CREATE TABLE gate_meter_reads (
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  reader_key    TEXT NOT NULL CHECK (length(reader_key) <= 80),
  period        TEXT NOT NULL CHECK (length(period) <= 10),
  dispatch_id   TEXT NOT NULL REFERENCES dispatches (id) ON DELETE CASCADE,
  read_at       INTEGER NOT NULL,
  PRIMARY KEY (channel_id, reader_key, period, dispatch_id)
) WITHOUT ROWID;

-- Extra free reads an operator gives a Member (gift-meter grants).
CREATE TABLE gate_meter_grants (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  member_id    TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  period       TEXT NOT NULL CHECK (length(period) <= 10),
  extra        INTEGER NOT NULL CHECK (extra BETWEEN 1 AND 100),
  granted_by   TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX gate_meter_grants_by_member ON gate_meter_grants (member_id, period);

-- Stripe coupons with a promotion code, on the connected account.
CREATE TABLE coupons (
  id                         TEXT PRIMARY KEY,
  channel_id                 TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  code                       TEXT NOT NULL COLLATE NOCASE CHECK (code GLOB '[A-Za-z0-9]*' AND length(code) BETWEEN 3 AND 40),
  name                       TEXT CHECK (name IS NULL OR length(name) <= 60),
  percent_off                INTEGER CHECK (percent_off IS NULL OR percent_off BETWEEN 1 AND 100),
  amount_off                 INTEGER CHECK (amount_off IS NULL OR amount_off > 0),
  currency                   TEXT CHECK (currency IS NULL OR length(currency) = 3),
  duration                   TEXT NOT NULL CHECK (duration IN ('once', 'repeating', 'forever')),
  duration_months            INTEGER CHECK (duration_months IS NULL OR duration_months BETWEEN 1 AND 36),
  max_redemptions            INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  expires_at                 INTEGER,
  -- Empty = every level.
  level_ids_json             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(level_ids_json)),
  status                     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  stripe_coupon_id           TEXT,
  stripe_promotion_code_id   TEXT,
  created_by                 TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at                 INTEGER NOT NULL,
  CHECK ((percent_off IS NULL) <> (amount_off IS NULL)),
  CHECK (amount_off IS NULL OR currency IS NOT NULL),
  CHECK (duration <> 'repeating' OR duration_months IS NOT NULL)
);
CREATE UNIQUE INDEX coupons_code ON coupons (channel_id, code) WHERE status = 'active';

-- Operators granting a level for free. Each grant also has a member_subscriptions row
-- (source 'comp'); this table keeps who, why and when for the audit trail.
CREATE TABLE comp_grants (
  id                TEXT PRIMARY KEY,
  channel_id        TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  member_id         TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  level_id          TEXT REFERENCES membership_levels (id) ON DELETE SET NULL,
  subscription_id   TEXT REFERENCES member_subscriptions (id) ON DELETE SET NULL,
  expires_at        INTEGER,
  note              TEXT CHECK (note IS NULL OR length(note) <= 280),
  granted_by        TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  revoked_at        INTEGER,
  revoked_by        TEXT REFERENCES operators (id) ON DELETE SET NULL
);
CREATE INDEX comp_grants_by_member ON comp_grants (member_id);

-- Gift Passes (flag gift_passes): bought by anyone, claimed by the recipient with a link.
CREATE TABLE gift_passes (
  id                     TEXT PRIMARY KEY,
  channel_id             TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  level_id               TEXT REFERENCES membership_levels (id) ON DELETE SET NULL,
  months                 INTEGER NOT NULL CHECK (months BETWEEN 1 AND 24),
  purchaser_email        TEXT NOT NULL COLLATE NOCASE,
  purchaser_member_id    TEXT REFERENCES members (id) ON DELETE SET NULL,
  recipient_email        TEXT COLLATE NOCASE,
  message                TEXT CHECK (message IS NULL OR length(message) <= 500),
  claim_token_hash       TEXT UNIQUE,
  status                 TEXT NOT NULL DEFAULT 'pending_payment'
                           CHECK (status IN ('pending_payment', 'paid', 'claimed', 'expired', 'refunded')),
  checkout_session_id    TEXT,
  claimed_member_id      TEXT REFERENCES members (id) ON DELETE SET NULL,
  claimed_at             INTEGER,
  -- Unclaimed passes expire; a claimed pass's access ends with its subscription row.
  claim_by               INTEGER,
  created_at             INTEGER NOT NULL
);
CREATE INDEX gift_passes_by_channel ON gift_passes (channel_id, status);

-- Gift articles (flag gift_articles): a Member shares one gated Dispatch by a signed link.
CREATE TABLE gift_article_links (
  token_hash    TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  member_id     TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  dispatch_id   TEXT NOT NULL REFERENCES dispatches (id) ON DELETE CASCADE,
  period        TEXT NOT NULL CHECK (length(period) <= 10),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX gift_article_links_by_member ON gift_article_links (member_id, period);

-- Pledges (flag pledges): intent to pay before paid levels launch; no card is taken.
CREATE TABLE pledges (
  id             TEXT PRIMARY KEY,
  channel_id     TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  member_id      TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  level_id       TEXT REFERENCES membership_levels (id) ON DELETE SET NULL,
  interval       TEXT NOT NULL CHECK (interval IN ('month', 'year')),
  currency       TEXT NOT NULL CHECK (length(currency) = 3),
  amount         INTEGER NOT NULL CHECK (amount > 0),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'notified', 'converted', 'withdrawn')),
  created_at     INTEGER NOT NULL,
  notified_at    INTEGER,
  converted_at   INTEGER,
  UNIQUE (channel_id, member_id)
);

-- One trial per email per Channel.
CREATE TABLE trial_claims (
  channel_id   TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  email        TEXT NOT NULL COLLATE NOCASE,
  level_id     TEXT REFERENCES membership_levels (id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (channel_id, email)
);
