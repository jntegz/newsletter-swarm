-- Inbox rules: a publication's limits on automated email (the settings live in
-- channels.settings_json under inboxRules, off until a person sets them). Contracts:
-- packages/domain/src/flow-inbox-rules.ts and packages/engine/src/flows-holds.ts.

-- Every automated email a Member was given, kept for the longest limit window (the daily job
-- prunes it). The limit counts these rows. A conditional INSERT takes the slot, so two runs
-- deciding at the same moment can't both use the last one. send_regardless marks an email that
-- no rule holds; it still counts.
CREATE TABLE flow_email_ledger (
  member_id        TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  broadcast_id     TEXT NOT NULL REFERENCES broadcasts (id) ON DELETE CASCADE,
  channel_id       TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  send_regardless  INTEGER NOT NULL DEFAULT 0 CHECK (send_regardless IN (0, 1)),
  sent_at          INTEGER NOT NULL,
  PRIMARY KEY (member_id, broadcast_id)
) WITHOUT ROWID;
CREATE INDEX flow_email_ledger_by_member ON flow_email_ledger (member_id, sent_at);
CREATE INDEX flow_email_ledger_by_age ON flow_email_ledger (sent_at);

-- The last seven days of automated email, so the limits count from the first day they are set.
INSERT INTO flow_email_ledger (member_id, broadcast_id, channel_id, send_regardless, sent_at)
SELECT d.member_id, d.broadcast_id, d.channel_id, 0, d.sent_at
  FROM broadcasts b JOIN deliveries d ON d.broadcast_id = b.id
 WHERE b.kind = 'flow' AND d.member_id IS NOT NULL
   AND d.sent_at > (unixepoch() - 604800) * 1000
ON CONFLICT DO NOTHING;

-- A run's send step held back by an inbox rule. One row per (run, step): it keeps the time the
-- wait began (the wait's limit and the Member's order in line both count from it) and the latest
-- reason. released_at and outcome are set when the step ends; a row with neither belongs to a
-- run still waiting, or to one that ended some other way (see flow_runs.status).
CREATE TABLE flow_holds (
  run_id       TEXT NOT NULL REFERENCES flow_runs (id) ON DELETE CASCADE,
  node_id      TEXT NOT NULL CHECK (length(node_id) <= 40),
  flow_id      TEXT NOT NULL REFERENCES flows (id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  channel_id   TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  member_id    TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  -- INBOX_HOLD_REASONS in @swarm/domain.
  reason       TEXT NOT NULL CHECK (length(reason) <= 40),
  until        INTEGER NOT NULL,
  -- The IANA zone the rule was read in, so the run history can say the time the Member sees.
  zone         TEXT NOT NULL CHECK (length(zone) <= 64),
  held_at      INTEGER NOT NULL,
  released_at  INTEGER,
  outcome      TEXT CHECK (outcome IS NULL OR outcome IN ('sent', 'skipped', 'expired', 'left')),
  PRIMARY KEY (run_id, node_id)
);
CREATE INDEX flow_holds_line ON flow_holds (member_id, held_at) WHERE released_at IS NULL;
CREATE INDEX flow_holds_open_by_channel ON flow_holds (channel_id) WHERE released_at IS NULL;
CREATE INDEX flow_holds_by_step ON flow_holds (flow_id, version, node_id);

-- Set on a version's email when the writer asked, at publish, that people who already got it can
-- get it again. Sends before that version no longer stop this email.
ALTER TABLE flow_emails ADD COLUMN resend INTEGER NOT NULL DEFAULT 0 CHECK (resend IN (0, 1));
