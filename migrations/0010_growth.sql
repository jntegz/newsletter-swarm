-- Phase 6: Growth and Flows. Flows (versioned graphs, runs, steps), the member event bus, Flow
-- emails, Templates, Split Tests, Cohort Sampling, Smart Block recipient data, Champions,
-- Ask, Signup Journeys, Smart Prompts, Series and the Funnel Explorer rollup.
-- Conventions as in 0001_foundation.sql. The contracts are described in docs/architecture.md,
-- "Growth and Flows (Phase 6)", and typed in packages/domain/src/p6-flows.ts and p6-growth.ts.

PRAGMA defer_foreign_keys = true;

-- ---------------------------------------------------------------------------------------------
-- Flows

CREATE TABLE flows (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id          TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description         TEXT CHECK (description IS NULL OR length(description) <= 280),
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'paused', 'archived')),
  -- The recipe it was created from ('welcome', 'reengagement', ...); NULL for a blank Flow.
  recipe              TEXT CHECK (recipe IS NULL OR length(recipe) <= 40),
  -- The editable graph (FlowGraph in @swarm/domain). Publishing copies it into flow_versions.
  draft_graph_json    TEXT NOT NULL CHECK (json_valid(draft_graph_json)),
  -- The version new runs enrol on; NULL until the first publish.
  live_version        INTEGER,
  -- The live version's trigger type, denormalised so enrolment finds candidate Flows by index.
  trigger_type        TEXT CHECK (trigger_type IS NULL OR length(trigger_type) <= 40),
  -- 'never': a Member is enrolled at most once per Flow; 'after_exit': again once the previous
  -- run has ended. A Member never has two open runs of one Flow (flow_runs_one_open).
  reentry             TEXT NOT NULL DEFAULT 'never' CHECK (reentry IN ('never', 'after_exit')),
  -- HMAC secret for webhook_call nodes, sealed with FIELD_KEYS (AES-256-GCM); NULL until needed.
  webhook_secret_enc  TEXT,
  created_by          TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  deleted_at          INTEGER
);
CREATE INDEX flows_by_channel ON flows (channel_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX flows_live_by_trigger ON flows (channel_id, trigger_type) WHERE status = 'live' AND deleted_at IS NULL;

-- Every publish. Versions are immutable; runs stay on the version they enrolled on.
CREATE TABLE flow_versions (
  flow_id       TEXT NOT NULL REFERENCES flows (id) ON DELETE CASCADE,
  version       INTEGER NOT NULL CHECK (version >= 1),
  graph_json    TEXT NOT NULL CHECK (json_valid(graph_json)),
  trigger_type  TEXT NOT NULL CHECK (length(trigger_type) <= 40),
  published_by  TEXT REFERENCES operators (id) ON DELETE SET NULL,
  published_at  INTEGER NOT NULL,
  -- Set when a newer version is published; runs still on it carry on unless migrated.
  retired_at    INTEGER,
  PRIMARY KEY (flow_id, version)
);

-- One enrolment of one Member in one Flow version.
CREATE TABLE flow_runs (
  id                 TEXT PRIMARY KEY,
  flow_id            TEXT NOT NULL REFERENCES flows (id) ON DELETE CASCADE,
  version            INTEGER NOT NULL,
  channel_id         TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  member_id          TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running', 'waiting', 'paused', 'completed', 'exited', 'failed')),
  -- FLOW_EXIT_REASONS in @swarm/domain; set with status exited (or failed).
  exit_reason        TEXT CHECK (exit_reason IS NULL OR length(exit_reason) <= 40),
  current_node_id    TEXT CHECK (current_node_id IS NULL OR length(current_node_id) <= 40),
  -- When the run should next be looked at (a delay ending, a wait timing out). The every-minute
  -- sweep picks up rows that are due; short delays are also queued with delaySeconds.
  next_at            INTEGER,
  -- A wait_for_event node's subscription: {"node","event","until","broadcastId"?}.
  wait_json          TEXT CHECK (wait_json IS NULL OR json_valid(wait_json)),
  -- Run variables: the trigger payload, A/B arm choices, the Flow email deliveries sent.
  context_json       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context_json)),
  -- member_events.seq of the event that enrolled the Member (NULL for a manual or test run).
  trigger_event_seq  INTEGER,
  test               INTEGER NOT NULL DEFAULT 0 CHECK (test IN (0, 1)),
  started_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  ended_at           INTEGER
);
CREATE UNIQUE INDEX flow_runs_one_open ON flow_runs (flow_id, member_id)
  WHERE status IN ('running', 'waiting', 'paused');
CREATE INDEX flow_runs_due ON flow_runs (next_at) WHERE status IN ('running', 'waiting');
CREATE INDEX flow_runs_by_flow ON flow_runs (flow_id, version, status);
CREATE INDEX flow_runs_by_member ON flow_runs (member_id, started_at);

-- One attempt at one node of one run. Idempotency key: (run_id, node_id, attempt). The graph is
-- a DAG, so a run visits each node at most once; retries are new attempts of the same node.
CREATE TABLE flow_run_steps (
  run_id       TEXT NOT NULL REFERENCES flow_runs (id) ON DELETE CASCADE,
  node_id      TEXT NOT NULL CHECK (length(node_id) <= 40),
  attempt      INTEGER NOT NULL CHECK (attempt >= 1),
  flow_id      TEXT NOT NULL REFERENCES flows (id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'skipped')),
  -- The edge label taken out of this node (FLOW_EDGE_LABELS), once done.
  outcome      TEXT CHECK (outcome IS NULL OR length(outcome) <= 20),
  result_json  TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error        TEXT CHECK (error IS NULL OR length(error) <= 1000),
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  PRIMARY KEY (run_id, node_id, attempt)
);
-- Per-node stats (entered, completed, exited) for one Flow version.
CREATE INDEX flow_run_steps_by_node ON flow_run_steps (flow_id, version, node_id, status);

-- The member event bus: an append-only log every trigger reads. `seq` is the cursor, so it is an
-- integer key rather than a prefixed id. Writers: recordMemberEvent and the statement helpers in
-- @swarm/engine (events.ts). The Flows engine drains unprocessed rows in seq order and stamps
-- processed_at; processed rows are pruned after 90 days by the daily job.
CREATE TABLE member_events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  member_id     TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (length(type) <= 40),
  payload_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at    INTEGER NOT NULL,
  processed_at  INTEGER
);
CREATE INDEX member_events_unprocessed ON member_events (seq) WHERE processed_at IS NULL;
CREATE INDEX member_events_by_member ON member_events (member_id, created_at);
CREATE INDEX member_events_processed ON member_events (processed_at) WHERE processed_at IS NOT NULL;

-- Flow emails. Each send_email node points at a Dispatch of kind 'flow'. Publishing a version
-- freezes one Broadcast (kind 'flow') per send node, through the same renderer as a Broadcast;
-- a run's send adds one broadcast_recipients row and queues a 'batch' send message, so every
-- Flow email goes through the batch sender's suppression, tracking, unsubscribe and MIME path.
-- A Member gets a given node's email at most once per version (deliveries are unique per
-- Broadcast and Member).
CREATE TABLE flow_emails (
  flow_id       TEXT NOT NULL REFERENCES flows (id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  node_id       TEXT NOT NULL CHECK (length(node_id) <= 40),
  dispatch_id   TEXT NOT NULL REFERENCES dispatches (id) ON DELETE CASCADE,
  broadcast_id  TEXT NOT NULL UNIQUE REFERENCES broadcasts (id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (flow_id, version, node_id)
);

-- Dispatch kinds: 'broadcast' (the editor's Dispatches: sent to an audience, published to the
-- web) or 'flow' (an email owned by a Flow: never listed with Dispatches, never published,
-- never sent as an audience Broadcast).
ALTER TABLE dispatches ADD COLUMN kind TEXT NOT NULL DEFAULT 'broadcast' CHECK (kind IN ('broadcast', 'flow'));
ALTER TABLE dispatches ADD COLUMN flow_id TEXT REFERENCES flows (id) ON DELETE CASCADE;
CREATE INDEX dispatches_by_flow ON dispatches (flow_id) WHERE flow_id IS NOT NULL;

-- A Flow Broadcast stays 'sending' while its version can still send, and is skipped by the
-- stuck-Broadcast reaper and by completion (the Flows sweep owns it).
ALTER TABLE broadcasts ADD COLUMN kind TEXT NOT NULL DEFAULT 'broadcast' CHECK (kind IN ('broadcast', 'flow'));
ALTER TABLE broadcasts ADD COLUMN flow_id TEXT REFERENCES flows (id) ON DELETE SET NULL;
DROP INDEX broadcasts_one_active_per_dispatch;
CREATE UNIQUE INDEX broadcasts_one_active_per_dispatch ON broadcasts (dispatch_id)
  WHERE status IN ('queued', 'sending') AND kind = 'broadcast';

-- ---------------------------------------------------------------------------------------------
-- Templates (Template Library): workspace-wide when channel_id is NULL, else one Channel's.

CREATE TABLE templates (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id        TEXT REFERENCES channels (id) ON DELETE CASCADE,
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description       TEXT CHECK (description IS NULL OR length(description) <= 280),
  -- 'dispatch': editor content; 'design' (flag design_templates): a look without content.
  kind              TEXT NOT NULL DEFAULT 'dispatch' CHECK (kind IN ('dispatch', 'design')),
  subject           TEXT NOT NULL DEFAULT '' CHECK (length(subject) <= 200),
  preheader         TEXT NOT NULL DEFAULT '' CHECK (length(preheader) <= 200),
  content_json      TEXT NOT NULL CHECK (json_valid(content_json)),
  thumbnail_media_id TEXT REFERENCES media (id) ON DELETE SET NULL,
  created_by        TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER
);
CREATE INDEX templates_by_workspace ON templates (workspace_id, channel_id, updated_at) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Split Tests and Cohort Sampling. Both work on one Broadcast by holding recipients back: the
-- snapshot writes everyone, marks the remainder held = 1, and fan-out skips held rows until
-- the winner is chosen (split test) or the sample passes its health checks (sampling).

CREATE TABLE split_tests (
  id                 TEXT PRIMARY KEY,
  channel_id         TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  dispatch_id        TEXT NOT NULL UNIQUE REFERENCES dispatches (id) ON DELETE CASCADE,
  broadcast_id       TEXT REFERENCES broadcasts (id) ON DELETE SET NULL,
  variable           TEXT NOT NULL CHECK (variable IN ('subject', 'content')),
  -- Share of the audience in the test, split evenly across the variants.
  test_percent       INTEGER NOT NULL CHECK (test_percent BETWEEN 5 AND 100),
  metric             TEXT NOT NULL CHECK (metric IN ('opens', 'clicks', 'goal')),
  -- For metric 'goal': {"event": "<member event type>", "levelId"?: "...", ...}.
  goal_json          TEXT CHECK (goal_json IS NULL OR json_valid(goal_json)),
  window_minutes     INTEGER NOT NULL CHECK (window_minutes BETWEEN 30 AND 10080),
  status             TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'testing', 'promoted', 'canceled')),
  winner_variant_id  TEXT,
  -- How the winner was chosen: metric values per variant at decide time.
  decision_json      TEXT CHECK (decision_json IS NULL OR json_valid(decision_json)),
  started_at         INTEGER,
  decide_at          INTEGER,
  decided_at         INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX split_tests_due ON split_tests (decide_at) WHERE status = 'testing';

CREATE TABLE split_test_variants (
  id             TEXT PRIMARY KEY,
  split_test_id  TEXT NOT NULL REFERENCES split_tests (id) ON DELETE CASCADE,
  -- 'A'..'D'; 'A' is the Dispatch as written.
  label          TEXT NOT NULL CHECK (label IN ('A', 'B', 'C', 'D')),
  subject        TEXT CHECK (subject IS NULL OR length(subject) <= 200),
  preheader      TEXT CHECK (preheader IS NULL OR length(preheader) <= 200),
  -- For variable 'content'. html/text are frozen at start with the same placeholders and link
  -- positions scheme as broadcasts.html (each variant has its own link targets offset).
  content_json   TEXT CHECK (content_json IS NULL OR json_valid(content_json)),
  html           TEXT,
  text           TEXT,
  created_at     INTEGER NOT NULL,
  UNIQUE (split_test_id, label)
);

CREATE TABLE cohort_samples (
  id                    TEXT PRIMARY KEY,
  channel_id            TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  dispatch_id           TEXT NOT NULL UNIQUE REFERENCES dispatches (id) ON DELETE CASCADE,
  broadcast_id          TEXT REFERENCES broadcasts (id) ON DELETE SET NULL,
  sample_percent        INTEGER NOT NULL CHECK (sample_percent BETWEEN 1 AND 99),
  window_minutes        INTEGER NOT NULL CHECK (window_minutes BETWEEN 30 AND 2880),
  -- Health thresholds as fractions of delivered messages.
  min_open_rate         REAL CHECK (min_open_rate IS NULL OR (min_open_rate >= 0 AND min_open_rate <= 1)),
  max_bounce_rate       REAL NOT NULL CHECK (max_bounce_rate > 0 AND max_bounce_rate < 1),
  max_complaint_rate    REAL NOT NULL CHECK (max_complaint_rate > 0 AND max_complaint_rate < 1),
  max_unsubscribe_rate  REAL NOT NULL CHECK (max_unsubscribe_rate > 0 AND max_unsubscribe_rate < 1),
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'sampling', 'extended', 'halted', 'canceled')),
  metrics_json          TEXT CHECK (metrics_json IS NULL OR json_valid(metrics_json)),
  decide_at             INTEGER,
  decided_at            INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX cohort_samples_due ON cohort_samples (decide_at) WHERE status = 'sampling';

ALTER TABLE broadcasts ADD COLUMN split_test_id TEXT REFERENCES split_tests (id) ON DELETE SET NULL;
ALTER TABLE broadcasts ADD COLUMN cohort_sample_id TEXT REFERENCES cohort_samples (id) ON DELETE SET NULL;
-- Held back until a split test or a sample is decided; fan-out skips held rows.
ALTER TABLE broadcast_recipients ADD COLUMN held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1));
-- The split-test variant this recipient gets (NULL: the Broadcast's own subject and html).
ALTER TABLE broadcast_recipients ADD COLUMN split_variant_id TEXT;
-- Smart Blocks this recipient sees: a JSON array of block indexes, decided once at snapshot
-- (or at Flow enqueue) time; NULL when the email has no Smart Blocks.
ALTER TABLE broadcast_recipients ADD COLUMN smart_blocks_json TEXT
  CHECK (smart_blocks_json IS NULL OR json_valid(smart_blocks_json));
CREATE INDEX broadcast_recipients_held ON broadcast_recipients (broadcast_id, member_id) WHERE held = 1;

-- ---------------------------------------------------------------------------------------------
-- Champions (referrals): settings, milestones, rewards and awards.

CREATE TABLE champion_settings (
  channel_id           TEXT PRIMARY KEY REFERENCES channels (id) ON DELETE CASCADE,
  enabled              INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  -- A referral counts once the referred Member is confirmed and opened within this many days.
  engagement_days      INTEGER NOT NULL DEFAULT 14 CHECK (engagement_days BETWEEN 1 AND 90),
  -- More than this many referrals for one Champion from one /24 (IPv4) or /48 (IPv6) within
  -- cluster_window_hours are held for review.
  cluster_limit        INTEGER NOT NULL DEFAULT 3 CHECK (cluster_limit BETWEEN 1 AND 100),
  cluster_window_hours INTEGER NOT NULL DEFAULT 24 CHECK (cluster_window_hours BETWEEN 1 AND 720),
  block_disposable     INTEGER NOT NULL DEFAULT 1 CHECK (block_disposable IN (0, 1)),
  -- The optional public "top Champions" widget (flag referral_awards).
  public_leaderboard   INTEGER NOT NULL DEFAULT 0 CHECK (public_leaderboard IN (0, 1)),
  share_text           TEXT CHECK (share_text IS NULL OR length(share_text) <= 280),
  updated_at           INTEGER NOT NULL
);

CREATE TABLE champion_rewards (
  id               TEXT PRIMARY KEY,
  channel_id       TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('comp_level', 'coupon', 'goods', 'manual')),
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description      TEXT CHECK (description IS NULL OR length(description) <= 500),
  -- comp_level: the level and how long; coupon: the coupon; goods: Phase 8 item reference.
  level_id         TEXT REFERENCES membership_levels (id) ON DELETE SET NULL,
  comp_days        INTEGER CHECK (comp_days IS NULL OR comp_days BETWEEN 1 AND 3650),
  coupon_id        TEXT REFERENCES coupons (id) ON DELETE SET NULL,
  goods_ref        TEXT CHECK (goods_ref IS NULL OR length(goods_ref) <= 80),
  -- The Flow that sends the fulfilment email (trigger api_event "champion_reward" or similar).
  fulfil_flow_id   TEXT REFERENCES flows (id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX champion_rewards_by_channel ON champion_rewards (channel_id, status);

CREATE TABLE champion_milestones (
  id                  TEXT PRIMARY KEY,
  channel_id          TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  referrals_required  INTEGER NOT NULL CHECK (referrals_required BETWEEN 1 AND 100000),
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  reward_id           TEXT REFERENCES champion_rewards (id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX champion_milestones_threshold ON champion_milestones (channel_id, referrals_required)
  WHERE status = 'active';

-- A milestone reached by a Member: awarded exactly once.
CREATE TABLE champion_awards (
  id             TEXT PRIMARY KEY,
  channel_id     TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  member_id      TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  milestone_id   TEXT NOT NULL REFERENCES champion_milestones (id) ON DELETE CASCADE,
  reward_id      TEXT REFERENCES champion_rewards (id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fulfilled', 'failed', 'revoked')),
  comp_grant_id  TEXT REFERENCES comp_grants (id) ON DELETE SET NULL,
  detail         TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  created_at     INTEGER NOT NULL,
  fulfilled_at   INTEGER,
  UNIQUE (member_id, milestone_id)
);
CREATE INDEX champion_awards_by_channel ON champion_awards (channel_id, created_at);

-- A Member's share code for /r/<code> (and ?ref=<code> on the site); assigned on first use.
ALTER TABLE members ADD COLUMN champion_code TEXT CHECK (champion_code IS NULL OR length(champion_code) BETWEEN 6 AND 16);
CREATE UNIQUE INDEX members_champion_code ON members (channel_id, champion_code) WHERE champion_code IS NOT NULL;

-- Referral review. 'pending': waiting to be confirmed and engaged; 'counted': counts toward
-- milestones; 'held': fraud check tripped, waiting for an operator; 'rejected': never counts.
ALTER TABLE referrals ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'counted', 'held', 'rejected'));
ALTER TABLE referrals ADD COLUMN review_reason TEXT
  CHECK (review_reason IS NULL OR review_reason IN ('disposable_domain', 'ip_cluster', 'not_engaged', 'operator', 'unsubscribed'));
-- The referred sign-up's truncated address (/24 or /48), for clustering. Never the full IP.
ALTER TABLE referrals ADD COLUMN ip_prefix TEXT CHECK (ip_prefix IS NULL OR length(ip_prefix) <= 64);
ALTER TABLE referrals ADD COLUMN counted_at INTEGER;
ALTER TABLE referrals ADD COLUMN reviewed_by TEXT REFERENCES operators (id) ON DELETE SET NULL;
ALTER TABLE referrals ADD COLUMN reviewed_at INTEGER;
CREATE INDEX referrals_by_status ON referrals (channel_id, status, created_at);
CREATE INDEX referrals_cluster ON referrals (referrer_id, ip_prefix, created_at) WHERE ip_prefix IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Ask: polls (one question) and surveys (several).

CREATE TABLE asks (
  id             TEXT PRIMARY KEY,
  channel_id     TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('poll', 'survey')),
  title          TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  -- Shown under the title (Substack's "descriptions on polls").
  description    TEXT CHECK (description IS NULL OR length(description) <= 1000),
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  results_public INTEGER NOT NULL DEFAULT 1 CHECK (results_public IN (0, 1)),
  closes_at      INTEGER,
  created_by     TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX asks_by_channel ON asks (channel_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE ask_questions (
  id           TEXT PRIMARY KEY,
  ask_id       TEXT NOT NULL REFERENCES asks (id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  prompt       TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 300),
  description  TEXT CHECK (description IS NULL OR length(description) <= 1000),
  kind         TEXT NOT NULL CHECK (kind IN ('choice', 'text')),
  -- Answers are copied into this profile field (select for choice, text for text), so they can
  -- be used in Circles; NULL to keep them only in ask_responses.
  field_id     TEXT REFERENCES member_fields (id) ON DELETE SET NULL,
  required     INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  UNIQUE (ask_id, position)
);

CREATE TABLE ask_options (
  id           TEXT PRIMARY KEY,
  ask_id       TEXT NOT NULL REFERENCES asks (id) ON DELETE CASCADE,
  question_id  TEXT NOT NULL REFERENCES ask_questions (id) ON DELETE CASCADE,
  label        TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  position     INTEGER NOT NULL,
  UNIQUE (question_id, position)
);

-- One answer per Member per question (a poll has one question, so one per Member per Ask).
CREATE TABLE ask_responses (
  id           TEXT PRIMARY KEY,
  ask_id       TEXT NOT NULL REFERENCES asks (id) ON DELETE CASCADE,
  question_id  TEXT NOT NULL REFERENCES ask_questions (id) ON DELETE CASCADE,
  channel_id   TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  member_id    TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  option_id    TEXT REFERENCES ask_options (id) ON DELETE SET NULL,
  text         TEXT CHECK (text IS NULL OR length(text) <= 2000),
  -- Where it was answered: 'email' (one-tap link), 'page' (/_swarm/ask/:id), 'journey'.
  surface      TEXT NOT NULL CHECK (surface IN ('email', 'page', 'journey')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  CHECK (option_id IS NOT NULL OR text IS NOT NULL),
  UNIQUE (question_id, member_id)
);
CREATE INDEX ask_responses_by_option ON ask_responses (question_id, option_id);
CREATE INDEX ask_responses_by_member ON ask_responses (member_id);

-- ---------------------------------------------------------------------------------------------
-- Signup Journeys (flag signup_journeys): up to 3 steps shown after subscribing.

CREATE TABLE signup_journeys (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'paused', 'archived')),
  -- NULL: every form of the Channel without a journey of its own.
  form_id       TEXT REFERENCES capture_forms (id) ON DELETE CASCADE,
  -- SignupJourneyVariant[] (p6-growth.ts): [{"key":"a","weight":50,"steps":[...]}]; one
  -- variant means no A/B test.
  variants_json TEXT NOT NULL CHECK (json_valid(variants_json)),
  winner_key    TEXT CHECK (winner_key IS NULL OR length(winner_key) <= 8),
  created_by    TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX signup_journeys_live_form ON signup_journeys (channel_id, ifnull(form_id, ''))
  WHERE status = 'live';

CREATE TABLE signup_journey_daily (
  journey_id   TEXT NOT NULL REFERENCES signup_journeys (id) ON DELETE CASCADE,
  variant_key  TEXT NOT NULL,
  step         INTEGER NOT NULL CHECK (step BETWEEN 0 AND 2),
  day          TEXT NOT NULL CHECK (length(day) = 10),
  views        INTEGER NOT NULL DEFAULT 0,
  completions  INTEGER NOT NULL DEFAULT 0,
  skips        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (journey_id, variant_key, step, day)
);

-- Smart Prompts (flag smart_prompts) are Capture Forms with kind 'prompt' and page-context
-- placement rules (SmartPromptPlacement in p6-growth.ts); they share versions and daily stats.
ALTER TABLE capture_forms ADD COLUMN kind TEXT NOT NULL DEFAULT 'form' CHECK (kind IN ('form', 'prompt'));
ALTER TABLE capture_forms ADD COLUMN placement_json TEXT CHECK (placement_json IS NULL OR json_valid(placement_json));

-- ---------------------------------------------------------------------------------------------
-- Series (flag post_series): ordered groups of Dispatches.

CREATE TABLE series (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  slug         TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 80),
  description  TEXT CHECK (description IS NULL OR length(description) <= 500),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE UNIQUE INDEX series_slug ON series (channel_id, slug) WHERE deleted_at IS NULL;

-- A Dispatch belongs to at most one Series.
CREATE TABLE series_dispatches (
  series_id    TEXT NOT NULL REFERENCES series (id) ON DELETE CASCADE,
  dispatch_id  TEXT NOT NULL UNIQUE REFERENCES dispatches (id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  PRIMARY KEY (series_id, dispatch_id),
  UNIQUE (series_id, position)
);

-- ---------------------------------------------------------------------------------------------
-- Funnel Explorer: first-party stage counts per day and cut. '' means "none" in every cut
-- column, so the primary key works. Lookback: 30 days on the free plan, unlimited on paid
-- plans (FUNNEL_FREE_LOOKBACK_DAYS in p6-growth.ts, read from workspaces.plan).

CREATE TABLE funnel_daily (
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  day           TEXT NOT NULL CHECK (length(day) = 10),
  source        TEXT NOT NULL DEFAULT '' CHECK (length(source) <= 120),
  utm_source    TEXT NOT NULL DEFAULT '' CHECK (length(utm_source) <= 120),
  utm_medium    TEXT NOT NULL DEFAULT '' CHECK (length(utm_medium) <= 120),
  utm_campaign  TEXT NOT NULL DEFAULT '' CHECK (length(utm_campaign) <= 120),
  form_id       TEXT NOT NULL DEFAULT '',
  champion_id   TEXT NOT NULL DEFAULT '',
  visits        INTEGER NOT NULL DEFAULT 0,
  form_views    INTEGER NOT NULL DEFAULT 0,
  subscribes    INTEGER NOT NULL DEFAULT 0,
  confirms      INTEGER NOT NULL DEFAULT 0,
  first_opens   INTEGER NOT NULL DEFAULT 0,
  paid          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, day, source, utm_source, utm_medium, utm_campaign, form_id, champion_id)
);
