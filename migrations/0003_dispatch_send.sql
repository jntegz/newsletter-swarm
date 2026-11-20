-- Phase 2: Dispatches, sending domains, the Broadcast pipeline, tracking, suppression and the Reputation Ramp.
-- Conventions as in 0001_foundation.sql.

-- Minimal Members: enough to send to. Phase 3 adds profile fields, tags, sources and Circles.
CREATE TABLE members (
  id               TEXT PRIMARY KEY,
  channel_id       TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  email            TEXT NOT NULL COLLATE NOCASE CHECK (length(email) BETWEEN 3 AND 254),
  first_name       TEXT CHECK (first_name IS NULL OR length(first_name) <= 80),
  last_name        TEXT CHECK (last_name IS NULL OR length(last_name) <= 80),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unsubscribed', 'bounced')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  unsubscribed_at  INTEGER,
  UNIQUE (channel_id, email)
);
-- The snapshot walks active Members in id order.
CREATE INDEX members_active_by_channel ON members (channel_id, id) WHERE status = 'active';

-- Addresses that must never be mailed again from this workspace (hard bounces, complaints, manual).
CREATE TABLE suppressions (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email         TEXT NOT NULL COLLATE NOCASE,
  reason        TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'soft_bounce', 'complaint', 'manual')),
  detail        TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, email)
);

-- Domains a Channel sends from (kind = email, verified through SES) or links through (kind = link).
CREATE TABLE sending_domains (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id        TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  domain            TEXT NOT NULL COLLATE NOCASE,
  kind              TEXT NOT NULL CHECK (kind IN ('email', 'link')),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed')),
  dkim_status       TEXT NOT NULL DEFAULT 'pending' CHECK (dkim_status IN ('pending', 'success', 'failed', 'not_started')),
  mail_from_domain  TEXT COLLATE NOCASE,
  mail_from_status  TEXT NOT NULL DEFAULT 'pending' CHECK (mail_from_status IN ('pending', 'success', 'failed', 'not_started')),
  -- The published DMARC policy as last seen over DNS. Sending needs quarantine or reject.
  dmarc_policy      TEXT CHECK (dmarc_policy IS NULL OR dmarc_policy IN ('none', 'quarantine', 'reject')),
  records_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(records_json)),
  provider_ref      TEXT,
  last_checked_at   INTEGER,
  verified_at       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (domain, kind)
);
CREATE INDEX sending_domains_by_channel ON sending_domains (channel_id, created_at);
CREATE INDEX sending_domains_unverified ON sending_domains (last_checked_at) WHERE status <> 'verified';

-- Who a Dispatch is from. A null sending_domain_id sends from the platform's shared mail domain.
CREATE TABLE sender_identities (
  id                 TEXT PRIMARY KEY,
  channel_id         TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  sending_domain_id  TEXT REFERENCES sending_domains (id) ON DELETE CASCADE,
  from_name          TEXT NOT NULL CHECK (length(from_name) BETWEEN 1 AND 80),
  from_local         TEXT NOT NULL CHECK (length(from_local) BETWEEN 1 AND 64),
  reply_to           TEXT COLLATE NOCASE,
  is_default         INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (channel_id, sending_domain_id, from_local)
);
CREATE UNIQUE INDEX sender_identities_one_default ON sender_identities (channel_id) WHERE is_default = 1;

CREATE TABLE dispatches (
  id                  TEXT PRIMARY KEY,
  channel_id          TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  subject             TEXT NOT NULL DEFAULT '' CHECK (length(subject) <= 200),
  preheader           TEXT NOT NULL DEFAULT '' CHECK (length(preheader) <= 200),
  -- The editor document (TipTap JSON). html and text are always rendered from it on the server.
  content_json        TEXT NOT NULL CHECK (json_valid(content_json)),
  html                TEXT NOT NULL DEFAULT '',
  text                TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'canceled')),
  sender_identity_id  TEXT REFERENCES sender_identities (id) ON DELETE SET NULL,
  publish_at          INTEGER,
  sent_at             INTEGER,
  created_by          TEXT REFERENCES operators (id) ON DELETE SET NULL,
  updated_by          TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (status <> 'scheduled' OR publish_at IS NOT NULL)
);
CREATE INDEX dispatches_by_channel ON dispatches (channel_id, updated_at);
CREATE INDEX dispatches_due ON dispatches (publish_at) WHERE status = 'scheduled';

-- Every save is a revision; autosaves by the same operator within 30 seconds coalesce into one.
CREATE TABLE dispatch_revisions (
  id            TEXT PRIMARY KEY,
  dispatch_id   TEXT NOT NULL REFERENCES dispatches (id) ON DELETE CASCADE,
  subject       TEXT NOT NULL,
  preheader     TEXT NOT NULL,
  content_json  TEXT NOT NULL CHECK (json_valid(content_json)),
  name          TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 80),
  created_by    TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX dispatch_revisions_by_dispatch ON dispatch_revisions (dispatch_id, created_at);

-- Per sending domain (or per Channel on the shared platform domain): how much may be sent today.
CREATE TABLE reputation_ramps (
  id                   TEXT PRIMARY KEY,
  channel_id           TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  sending_domain_id    TEXT REFERENCES sending_domains (id) ON DELETE CASCADE,
  status               TEXT NOT NULL DEFAULT 'warming' CHECK (status IN ('warming', 'paused', 'complete')),
  day                  TEXT NOT NULL,
  cap_today            INTEGER NOT NULL CHECK (cap_today >= 0),
  sent_today           INTEGER NOT NULL DEFAULT 0 CHECK (sent_today >= 0),
  -- Written and read in the same UPDATE ... RETURNING, so a reservation is atomic.
  last_reserved        INTEGER NOT NULL DEFAULT 0,
  start_cap            INTEGER NOT NULL CHECK (start_cap > 0),
  growth               REAL NOT NULL CHECK (growth >= 1 AND growth <= 3),
  max_cap              INTEGER NOT NULL CHECK (max_cap > 0),
  bounce_threshold     REAL NOT NULL CHECK (bounce_threshold > 0 AND bounce_threshold < 1),
  complaint_threshold  REAL NOT NULL CHECK (complaint_threshold > 0 AND complaint_threshold < 1),
  paused_reason        TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE UNIQUE INDEX reputation_ramps_scope ON reputation_ramps (channel_id, ifnull(sending_domain_id, ''));

-- One row per ramp per UTC day, for the chart.
CREATE TABLE reputation_ramp_days (
  ramp_id     TEXT NOT NULL REFERENCES reputation_ramps (id) ON DELETE CASCADE,
  day         TEXT NOT NULL,
  cap         INTEGER NOT NULL,
  sent        INTEGER NOT NULL,
  bounces     INTEGER NOT NULL,
  complaints  INTEGER NOT NULL,
  PRIMARY KEY (ramp_id, day)
);

-- A send of a Dispatch. The render is frozen here, so editing the Dispatch never changes a live send.
CREATE TABLE broadcasts (
  id                 TEXT PRIMARY KEY,
  dispatch_id        TEXT NOT NULL REFERENCES dispatches (id) ON DELETE CASCADE,
  channel_id         TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  workspace_id       TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'partially_failed', 'canceled', 'failed')),
  subject            TEXT NOT NULL,
  preheader          TEXT NOT NULL,
  html               TEXT NOT NULL,
  text               TEXT NOT NULL,
  from_name          TEXT NOT NULL,
  from_address       TEXT NOT NULL COLLATE NOCASE,
  reply_to           TEXT COLLATE NOCASE,
  sending_domain_id  TEXT REFERENCES sending_domains (id) ON DELETE SET NULL,
  ramp_id            TEXT REFERENCES reputation_ramps (id) ON DELETE SET NULL,
  track_opens        INTEGER NOT NULL CHECK (track_opens IN (0, 1)),
  recipient_count    INTEGER NOT NULL DEFAULT 0,
  sent_count         INTEGER NOT NULL DEFAULT 0,
  failed_count       INTEGER NOT NULL DEFAULT 0,
  -- Last member id copied into the snapshot / handed to batches; both walks resume from here.
  snapshot_cursor    TEXT,
  fanout_cursor      TEXT,
  snapshot_done      INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_done IN (0, 1)),
  fanout_done        INTEGER NOT NULL DEFAULT 0 CHECK (fanout_done IN (0, 1)),
  failure_reason     TEXT,
  created_by         TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL,
  last_progress_at   INTEGER NOT NULL,
  -- Set while the Broadcast waits for the Reputation Ramp; the reaper leaves it alone until then.
  resume_at          INTEGER,
  completed_at       INTEGER,
  canceled_at        INTEGER
);
CREATE INDEX broadcasts_by_channel ON broadcasts (channel_id, created_at);
CREATE INDEX broadcasts_active ON broadcasts (last_progress_at) WHERE status IN ('queued', 'sending');
-- At most one live Broadcast per Dispatch, enforced by the database rather than a racy check.
CREATE UNIQUE INDEX broadcasts_one_active_per_dispatch ON broadcasts (dispatch_id) WHERE status IN ('queued', 'sending');

-- The audience, resolved once when the Broadcast starts.
CREATE TABLE broadcast_recipients (
  broadcast_id  TEXT NOT NULL REFERENCES broadcasts (id) ON DELETE CASCADE,
  member_id     TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  email         TEXT NOT NULL COLLATE NOCASE,
  first_name    TEXT,
  last_name     TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  claimed_at    INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (broadcast_id, member_id)
) WITHOUT ROWID;
CREATE INDEX broadcast_recipients_by_status ON broadcast_recipients (broadcast_id, status);

-- One per message handed to the mail provider.
CREATE TABLE deliveries (
  id                TEXT PRIMARY KEY,
  broadcast_id      TEXT NOT NULL REFERENCES broadcasts (id) ON DELETE CASCADE,
  channel_id        TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  member_id         TEXT REFERENCES members (id) ON DELETE SET NULL,
  email             TEXT NOT NULL COLLATE NOCASE,
  provider_message_id  TEXT,
  status            TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'bounced', 'complained', 'failed')),
  bounce_type       TEXT,
  error             TEXT,
  sent_at           INTEGER NOT NULL,
  delivered_at      INTEGER,
  bounced_at        INTEGER,
  complained_at     INTEGER,
  opened_at         INTEGER,
  human_opened_at   INTEGER,
  clicked_at        INTEGER,
  human_clicked_at  INTEGER,
  unsubscribed_at   INTEGER,
  UNIQUE (broadcast_id, member_id)
);
CREATE INDEX deliveries_by_message ON deliveries (provider_message_id);
CREATE INDEX deliveries_by_broadcast_status ON deliveries (broadcast_id, status);
CREATE INDEX deliveries_recent_by_channel ON deliveries (channel_id, sent_at);

-- Link targets live on the server, so a click token carries an id and can never become an open redirect.
CREATE TABLE link_targets (
  id            TEXT PRIMARY KEY,
  broadcast_id  TEXT NOT NULL REFERENCES broadcasts (id) ON DELETE CASCADE,
  url           TEXT NOT NULL CHECK (url LIKE 'http://%' OR url LIKE 'https://%'),
  position      INTEGER NOT NULL,
  UNIQUE (broadcast_id, position)
);

-- Raw engagement events. Bot classification is stored, never used to drop an event.
CREATE TABLE clicks (
  id              TEXT PRIMARY KEY,
  delivery_id     TEXT NOT NULL REFERENCES deliveries (id) ON DELETE CASCADE,
  broadcast_id    TEXT NOT NULL REFERENCES broadcasts (id) ON DELETE CASCADE,
  link_target_id  TEXT NOT NULL REFERENCES link_targets (id) ON DELETE CASCADE,
  classification  TEXT NOT NULL CHECK (classification IN ('human', 'scanner', 'bot')),
  ua_family       TEXT,
  ip_prefix       TEXT,
  asn             INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX clicks_by_broadcast ON clicks (broadcast_id, link_target_id);
CREATE INDEX clicks_by_delivery ON clicks (delivery_id, created_at);

CREATE TABLE opens (
  id              TEXT PRIMARY KEY,
  delivery_id     TEXT NOT NULL REFERENCES deliveries (id) ON DELETE CASCADE,
  broadcast_id    TEXT NOT NULL REFERENCES broadcasts (id) ON DELETE CASCADE,
  classification  TEXT NOT NULL CHECK (classification IN ('human', 'machine_open', 'bot')),
  ua_family       TEXT,
  ip_prefix       TEXT,
  asn             INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX opens_by_broadcast ON opens (broadcast_id);

-- Soft bounces count toward suppression (three in seven days).
CREATE TABLE soft_bounces (
  workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email         TEXT NOT NULL COLLATE NOCASE,
  created_at    INTEGER NOT NULL
);
CREATE INDEX soft_bounces_by_email ON soft_bounces (workspace_id, email, created_at);
