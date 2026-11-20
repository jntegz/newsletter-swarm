-- Bounce rules (docs/deliverability.md "Bounces"): how a workspace reacts when its email turns out
-- undeliverable. A policy per workspace, the counters the rules read for each address that is
-- still being mailed, and 90 days of classified bounces. Code: @swarm/engine bounce-classifier.ts
-- (hard, soft or blocked) and bounces.ts (the rules); defaults in @swarm/domain bounces.ts.

-- One row per workspace that changed the rules. Without one the workspace has the defaults: stop
-- at the first hard bounce, after 3 emails in a row bounced softly, and ask before stopping a
-- subscriber on a paid plan.
CREATE TABLE bounce_policies (
  workspace_id        TEXT PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  hard_bounces        INTEGER NOT NULL DEFAULT 1 CHECK (hard_bounces IN (1, 2)),
  -- Emails in a row that bounced softly before mailing stops; NULL: the rule is off.
  soft_streak         INTEGER CHECK (soft_streak IS NULL OR soft_streak BETWEEN 2 AND 10),
  -- Soft bounces within a number of days before mailing stops; NULL: the rule is off.
  soft_window_count   INTEGER CHECK (soft_window_count IS NULL OR soft_window_count BETWEEN 2 AND 10),
  soft_window_days    INTEGER CHECK (soft_window_days IS NULL OR soft_window_days IN (7, 14, 30, 60, 90)),
  ask_for_paid        INTEGER NOT NULL DEFAULT 1 CHECK (ask_for_paid IN (0, 1)),
  updated_by          TEXT REFERENCES operators (id) ON DELETE SET NULL,
  updated_at          INTEGER NOT NULL,
  CHECK ((soft_window_count IS NULL) = (soft_window_days IS NULL))
);

-- Bounces of the last 90 days, as the classifier read them. One row per email and kind: a
-- provider that reports one email twice (Mailgun on every retry, SNS delivering twice) counts it
-- once. send_id is the delivery (dl_) or Direct Send (dn_); NULL for rows copied from
-- soft_bounces below. detail is what the receiving server said.
CREATE TABLE bounce_events (
  workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email         TEXT NOT NULL COLLATE NOCASE,
  send_id       TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('hard', 'soft', 'blocked')),
  cause         TEXT NOT NULL CHECK (cause IN (
                  'no_mailbox', 'no_domain', 'provider_list', 'rejected',
                  'mailbox_full', 'mailbox_unavailable', 'too_large', 'greylisted', 'temporary', 'unknown',
                  'reputation', 'blocklist', 'content', 'authentication', 'rate_limited', 'policy')),
  code          TEXT CHECK (code IS NULL OR length(code) <= 12),
  detail        TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  created_at    INTEGER NOT NULL
);
CREATE INDEX bounce_events_by_email ON bounce_events (workspace_id, email, created_at);
CREATE UNIQUE INDEX bounce_events_once ON bounce_events (workspace_id, email, send_id, kind)
  WHERE send_id IS NOT NULL;
CREATE INDEX bounce_events_by_age ON bounce_events (created_at);

-- One row per address that has bounced and is still being mailed. Deleted when the rules stop
-- mailing the address (the suppression then says why) and when an admin removes that
-- suppression, so the counts start again from zero.
CREATE TABLE bounce_states (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email            TEXT NOT NULL COLLATE NOCASE,
  -- Emails in a row that bounced softly; a delivered email sets it back to 0.
  soft_streak      INTEGER NOT NULL DEFAULT 0 CHECK (soft_streak >= 0),
  -- When the newest email counted in the streak was sent.
  streak_sent_at   INTEGER,
  -- Bounces before this time no longer count: an admin chose "Keep mailing".
  counts_from      INTEGER NOT NULL DEFAULT 0,
  last_kind        TEXT NOT NULL CHECK (last_kind IN ('hard', 'soft', 'blocked')),
  last_cause       TEXT NOT NULL CHECK (last_cause IN (
                     'no_mailbox', 'no_domain', 'provider_list', 'rejected',
                     'mailbox_full', 'mailbox_unavailable', 'too_large', 'greylisted', 'temporary', 'unknown',
                     'reputation', 'blocklist', 'content', 'authentication', 'rate_limited', 'policy')),
  last_code        TEXT CHECK (last_code IS NULL OR length(last_code) <= 12),
  last_detail      TEXT CHECK (last_detail IS NULL OR length(last_detail) <= 500),
  last_bounced_at  INTEGER NOT NULL,
  -- A subscriber on a paid plan the rules would stop, waiting for an admin (ask_for_paid). The
  -- address is still mailed meanwhile.
  held_at          INTEGER,
  held_rule        TEXT CHECK (held_rule IS NULL OR held_rule IN ('hard', 'hard_repeat', 'soft_streak', 'soft_window')),
  held_counted     INTEGER,
  held_days        INTEGER,
  -- 'due' until the jobs worker has emailed the owners and admins about the hold, then 'sent'.
  hold_notice      TEXT CHECK (hold_notice IS NULL OR hold_notice IN ('due', 'sent')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (workspace_id, email),
  CHECK ((held_at IS NULL) = (held_rule IS NULL))
);
CREATE INDEX bounce_states_held ON bounce_states (workspace_id, held_at) WHERE held_at IS NOT NULL;
CREATE INDEX bounce_states_notice ON bounce_states (hold_notice) WHERE hold_notice = 'due';
CREATE INDEX bounce_states_by_age ON bounce_states (updated_at);

-- Which rule stopped mailing an address, and what it counted, on suppressions the rules make.
ALTER TABLE suppressions ADD COLUMN bounce_rule TEXT
  CHECK (bounce_rule IS NULL OR bounce_rule IN ('hard', 'hard_repeat', 'soft_streak', 'soft_window'));
ALTER TABLE suppressions ADD COLUMN bounce_cause TEXT
  CHECK (bounce_cause IS NULL OR bounce_cause IN (
    'no_mailbox', 'no_domain', 'provider_list', 'rejected',
    'mailbox_full', 'mailbox_unavailable', 'too_large', 'greylisted', 'temporary', 'unknown'));
ALTER TABLE suppressions ADD COLUMN bounce_counted INTEGER;
ALTER TABLE suppressions ADD COLUMN bounce_days INTEGER;

-- The status a Member had when a bounce moved them to 'bounced', so removing the bounce
-- suppression can give it back. NULL for Members bounced before this migration.
ALTER TABLE members ADD COLUMN bounced_from TEXT
  CHECK (bounced_from IS NULL OR bounced_from IN ('pending', 'active', 'paused', 'unsubscribed'));

-- soft_bounces is no longer written. Its rows (at most 30 days old) become history here, so a
-- "soft bounces within days" rule sees them; they age out of soft_bounces as before.
INSERT INTO bounce_events (workspace_id, email, send_id, kind, cause, code, detail, created_at)
  SELECT workspace_id, lower(email), NULL, 'soft', 'unknown', NULL, NULL, created_at FROM soft_bounces;
INSERT INTO bounce_states (id, workspace_id, email, soft_streak, last_kind, last_cause,
                           last_bounced_at, created_at, updated_at)
  SELECT 'bn_' || lower(hex(randomblob(16))), b.workspace_id, lower(b.email), 0, 'soft', 'unknown',
         max(b.created_at), min(b.created_at), max(b.created_at)
    FROM soft_bounces b
   WHERE NOT EXISTS (SELECT 1 FROM suppressions s
                      WHERE s.workspace_id = b.workspace_id AND s.email = b.email AND s.channel_id IS NULL)
   GROUP BY b.workspace_id, lower(b.email);
