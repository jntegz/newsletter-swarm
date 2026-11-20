-- Partner Exchange and Sponsor Match, as direct deals between a publication and its partners or
-- sponsors. No shared network, no matching, and no money passes through Swarm.
-- Contracts: docs/partner-exchange.md, docs/sponsor-match.md.

CREATE TABLE partner_picks (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 280),
  url         TEXT NOT NULL CHECK (length(url) <= 2048 AND (url LIKE 'https://%' OR url LIKE 'http://%')),
  on_site     INTEGER NOT NULL DEFAULT 1 CHECK (on_site IN (0, 1)),
  on_signup   INTEGER NOT NULL DEFAULT 1 CHECK (on_signup IN (0, 1)),
  position    INTEGER NOT NULL DEFAULT 0,
  -- Counted without visitor identifiers of any kind.
  site_clicks   INTEGER NOT NULL DEFAULT 0,
  signup_clicks INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX partner_picks_by_channel ON partner_picks (channel_id, position);

CREATE TABLE sponsor_settings (
  channel_id  TEXT PRIMARY KEY REFERENCES channels (id) ON DELETE CASCADE,
  -- Without a row, or with accepting = 0, /sponsor answers 404.
  accepting   INTEGER NOT NULL DEFAULT 0 CHECK (accepting IN (0, 1)),
  headline    TEXT NOT NULL DEFAULT '' CHECK (length(headline) <= 120),
  pitch       TEXT NOT NULL DEFAULT '' CHECK (length(pitch) <= 2000),
  updated_at  INTEGER NOT NULL
);

-- What a publication sells: "Top of the post, 1 issue".
CREATE TABLE sponsor_slots (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 280),
  -- Shown to sponsors as the asking price. The publisher bills them directly.
  amount      INTEGER NOT NULL CHECK (amount >= 0),
  currency    TEXT NOT NULL CHECK (length(currency) = 3 AND currency = lower(currency)),
  position    INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER
);
CREATE INDEX sponsor_slots_by_channel ON sponsor_slots (channel_id, position);

CREATE TABLE sponsor_bookings (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  slot_id       TEXT NOT NULL REFERENCES sponsor_slots (id) ON DELETE RESTRICT,
  run_on        TEXT NOT NULL CHECK (run_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  sponsor_name  TEXT NOT NULL CHECK (length(sponsor_name) BETWEEN 1 AND 120),
  sponsor_email TEXT NOT NULL COLLATE NOCASE,
  ad_title      TEXT NOT NULL CHECK (length(ad_title) BETWEEN 1 AND 120),
  ad_body       TEXT NOT NULL DEFAULT '' CHECK (length(ad_body) <= 280),
  ad_url        TEXT NOT NULL CHECK (length(ad_url) <= 2048 AND ad_url LIKE 'https://%'),
  status        TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'declined', 'canceled')),
  -- The publisher's own note that the sponsor has paid them.
  paid          INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1)),
  clicks        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX sponsor_bookings_by_channel ON sponsor_bookings (channel_id, id);
-- One accepted sponsor per slot and day.
CREATE UNIQUE INDEX sponsor_bookings_one_per_slot_day
  ON sponsor_bookings (slot_id, run_on) WHERE status = 'accepted';
