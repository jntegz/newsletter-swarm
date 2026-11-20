-- Goods (flag goods): digital products sold one at a time through the publisher's own Stripe.
-- Contract: docs/goods.md.

CREATE TABLE goods (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  slug          TEXT NOT NULL COLLATE NOCASE CHECK (length(slug) BETWEEN 1 AND 80),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description   TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  license_keys  INTEGER NOT NULL DEFAULT 0 CHECK (license_keys IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (channel_id, slug)
);

-- The ways to buy a good. A price with orders is archived, never deleted.
CREATE TABLE good_prices (
  id          TEXT PRIMARY KEY,
  good_id     TEXT NOT NULL REFERENCES goods (id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  amount      INTEGER NOT NULL CHECK (amount > 0),
  currency    TEXT NOT NULL CHECK (length(currency) = 3 AND currency = lower(currency)),
  position    INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER
);
CREATE INDEX good_prices_by_good ON good_prices (good_id, position);

-- PDFs from the media library. Buyers fetch them through the order check, not the media URL.
CREATE TABLE good_files (
  id        TEXT PRIMARY KEY,
  good_id   TEXT NOT NULL REFERENCES goods (id) ON DELETE CASCADE,
  media_id  TEXT NOT NULL REFERENCES media (id) ON DELETE RESTRICT,
  name      TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  position  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (good_id, media_id)
);
CREATE INDEX good_files_by_media ON good_files (media_id);

CREATE TABLE good_orders (
  id                 TEXT PRIMARY KEY,
  channel_id         TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  good_id            TEXT NOT NULL REFERENCES goods (id) ON DELETE RESTRICT,
  price_id           TEXT REFERENCES good_prices (id) ON DELETE SET NULL,
  -- Set only when the buyer is already a Member: buying doesn't sign anyone up.
  member_id          TEXT REFERENCES members (id) ON DELETE SET NULL,
  email              TEXT NOT NULL COLLATE NOCASE,
  amount             INTEGER NOT NULL,
  currency           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'refunded', 'disputed')),
  stripe_session_id  TEXT,
  payment_intent_id  TEXT,
  created_at         INTEGER NOT NULL,
  paid_at            INTEGER,
  ended_at           INTEGER
);
CREATE INDEX good_orders_by_channel ON good_orders (channel_id, id);
CREATE INDEX good_orders_by_email ON good_orders (channel_id, email, status);
CREATE INDEX good_orders_by_payment ON good_orders (channel_id, payment_intent_id);

CREATE TABLE good_license_keys (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  order_id    TEXT NOT NULL UNIQUE REFERENCES good_orders (id) ON DELETE CASCADE,
  good_id     TEXT NOT NULL REFERENCES goods (id) ON DELETE CASCADE,
  license_key TEXT NOT NULL,
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE (channel_id, license_key)
);

-- A checkout can now pay for a good. SQLite can't change a CHECK, so the table is rebuilt.
CREATE TABLE checkout_sessions_new (
  reference           TEXT PRIMARY KEY CHECK (length(reference) BETWEEN 16 AND 64),
  stripe_session_id   TEXT UNIQUE CHECK (stripe_session_id IS NULL OR stripe_session_id GLOB 'cs_*'),
  channel_id          TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  -- A Gift Pass, pledge or good order this checkout pays for, when the intent is one of those.
  subject_id          TEXT,
  coupon_id           TEXT,
  -- Pay what you want: the amount the reader chose, in minor units.
  custom_amount       INTEGER CHECK (custom_amount IS NULL OR custom_amount > 0),
  level_id            TEXT REFERENCES membership_levels (id) ON DELETE SET NULL,
  price_id            TEXT REFERENCES level_prices (id) ON DELETE SET NULL,
  member_id           TEXT REFERENCES members (id) ON DELETE SET NULL,
  email               TEXT COLLATE NOCASE,
  intent              TEXT NOT NULL CHECK (intent IN ('subscribe', 'lifetime', 'gift', 'pledge', 'tip', 'good')),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'complete', 'expired')),
  created_at          INTEGER NOT NULL,
  completed_at        INTEGER
);
INSERT INTO checkout_sessions_new
  SELECT reference, stripe_session_id, channel_id, subject_id, coupon_id, custom_amount, level_id,
         price_id, member_id, email, intent, status, created_at, completed_at
    FROM checkout_sessions;
DROP TABLE checkout_sessions;
ALTER TABLE checkout_sessions_new RENAME TO checkout_sessions;
CREATE INDEX checkout_sessions_by_channel ON checkout_sessions (channel_id, created_at);
