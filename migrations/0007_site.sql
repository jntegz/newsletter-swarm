-- Phase 4: Channel websites. Site settings, pages, sections, redirects, web hostnames, bot rules,
-- Dispatch slugs and web visibility, reader sign-in and sessions, entitlements, site search and
-- page-view rollups.
-- Conventions as in 0001_foundation.sql.

-- One row per Channel, created on first save; absent means defaults.
CREATE TABLE site_settings (
  channel_id             TEXT PRIMARY KEY REFERENCES channels (id) ON DELETE CASCADE,
  layout                 TEXT NOT NULL DEFAULT 'magazine' CHECK (layout IN ('magazine', 'newspaper')),
  -- Up to 3 Dispatch ids shown first on the home page.
  pinned_json            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pinned_json)),
  -- About page: an editor document, rendered on the server like a Dispatch.
  about_json             TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}' CHECK (json_valid(about_json)),
  -- Navigation links: [{ "label", "href" }] where href is a site path or an https URL.
  nav_json               TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(nav_json)),
  -- { "ogMediaId"?, "verification": { "google"?, "bing"? }, "sameAs": [] }
  seo_json               TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(seo_json)),
  -- { "font": "geist" | "inter", "colorScheme": "light" | "dark" | "auto", "dropCaps": bool }
  theme_json             TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(theme_json)),
  -- AI crawler policy. 'unset' until the operator answers the question on setup.
  ai_bots                TEXT NOT NULL DEFAULT 'unset' CHECK (ai_bots IN ('unset', 'allow', 'block', 'custom')),
  -- Serve gated content to verified search crawlers (flag gated_seo_exposure).
  expose_gated           INTEGER NOT NULL DEFAULT 0 CHECK (expose_gated IN (0, 1)),
  prev_next_nav          INTEGER NOT NULL DEFAULT 1 CHECK (prev_next_nav IN (0, 1)),
  -- Bumped on every change that affects rendered pages; part of the edge cache key.
  cache_version          INTEGER NOT NULL DEFAULT 1,
  updated_by             TEXT REFERENCES operators (id) ON DELETE SET NULL,
  updated_at             INTEGER NOT NULL
);

CREATE TABLE site_sections (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  slug         TEXT NOT NULL CHECK (slug GLOB '[a-z0-9]*' AND length(slug) BETWEEN 1 AND 60),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  description  TEXT CHECK (description IS NULL OR length(description) <= 280),
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (channel_id, slug)
);

-- Custom pages beyond Home and About, at /<slug>.
CREATE TABLE site_pages (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  slug          TEXT NOT NULL CHECK (slug GLOB '[a-z0-9]*' AND length(slug) BETWEEN 1 AND 60),
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  content_json  TEXT NOT NULL CHECK (json_valid(content_json)),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  in_nav        INTEGER NOT NULL DEFAULT 0 CHECK (in_nav IN (0, 1)),
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (channel_id, slug)
);

-- Evaluated before rendering. from_path is an exact path ("/old-post"); to is a path or https URL.
CREATE TABLE site_redirects (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  from_path    TEXT NOT NULL CHECK (from_path GLOB '/*' AND length(from_path) <= 512),
  to_location  TEXT NOT NULL CHECK (length(to_location) <= 2048),
  status_code  INTEGER NOT NULL DEFAULT 301 CHECK (status_code IN (301, 302, 307, 308)),
  created_at   INTEGER NOT NULL,
  UNIQUE (channel_id, from_path)
);

-- Web hostnames (Cloudflare for SaaS custom hostnames). Email and link domains stay in
-- sending_domains; Settings shows all four roles of a domain together.
CREATE TABLE custom_hostnames (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id        TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  hostname          TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(hostname) BETWEEN 4 AND 253),
  -- 'web' serves the site; 'apex_redirect' sends the bare domain to the web hostname.
  role              TEXT NOT NULL DEFAULT 'web' CHECK (role IN ('web', 'apex_redirect')),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed', 'removed')),
  provider_id       TEXT,
  -- Records the operator must publish and the provider's last verification detail.
  records_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(records_json)),
  detail            TEXT,
  is_primary        INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  last_checked_at   INTEGER,
  created_by        TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX custom_hostnames_by_channel ON custom_hostnames (channel_id);
-- At most one primary web hostname per Channel: canonical URLs use it.
CREATE UNIQUE INDEX custom_hostnames_primary ON custom_hostnames (channel_id) WHERE is_primary = 1;

-- Per-crawler overrides when ai_bots = 'custom'. agent is a key from the known list (gptbot, …).
CREATE TABLE bot_rules (
  channel_id  TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  agent       TEXT NOT NULL CHECK (agent GLOB '[a-z0-9-]*' AND length(agent) BETWEEN 2 AND 40),
  action      TEXT NOT NULL CHECK (action IN ('allow', 'block')),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, agent)
);

-- Web publication of Dispatches.
--   web_visibility: who can read the full Dispatch on the site. 'hidden' keeps it off the site.
--   web_published_at: when it appeared on the site (set when sent, or published to the web only).
ALTER TABLE dispatches ADD COLUMN web_visibility TEXT NOT NULL DEFAULT 'public'
  CHECK (web_visibility IN ('public', 'members', 'paid', 'hidden'));
ALTER TABLE dispatches ADD COLUMN web_published_at INTEGER;
ALTER TABLE dispatches ADD COLUMN section_id TEXT REFERENCES site_sections (id) ON DELETE SET NULL;
CREATE INDEX dispatches_on_web ON dispatches (channel_id, web_published_at)
  WHERE web_published_at IS NOT NULL AND web_visibility <> 'hidden';

-- Every slug a Dispatch has had; old ones redirect to the current one.
CREATE TABLE dispatch_slugs (
  channel_id   TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  slug         TEXT NOT NULL CHECK (slug GLOB '[a-z0-9]*' AND length(slug) BETWEEN 1 AND 120),
  dispatch_id  TEXT NOT NULL REFERENCES dispatches (id) ON DELETE CASCADE,
  is_current   INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (channel_id, slug)
);
CREATE UNIQUE INDEX dispatch_slugs_current ON dispatch_slugs (dispatch_id) WHERE is_current = 1;

-- Site search. Maintained by the application, not triggers: only the part of a Dispatch anyone
-- may read is indexed, so search can't reveal gated text.
CREATE VIRTUAL TABLE dispatch_search USING fts5(
  dispatch_id UNINDEXED,
  channel_id UNINDEXED,
  title,
  subtitle,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Reader sign-in (magic link to a Member's email). Separate from operator QuickPass and sessions.
CREATE TABLE reader_tokens (
  token_hash   TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  member_id    TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  -- Where to return after sign-in: a path on the same site.
  return_path  TEXT NOT NULL DEFAULT '/' CHECK (return_path GLOB '/*' AND length(return_path) <= 512),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER
);
CREATE INDEX reader_tokens_by_member ON reader_tokens (member_id, created_at);

CREATE TABLE reader_sessions (
  id_hash       TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  member_id     TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX reader_sessions_by_member ON reader_sessions (member_id);

-- Paid access. Phase 5 (Membership Levels and Stripe) writes these; Phase 4 only reads them.
CREATE TABLE member_entitlements (
  member_id   TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  channel_id  TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('paid')),
  source      TEXT NOT NULL CHECK (length(source) <= 60),
  starts_at   INTEGER NOT NULL,
  expires_at  INTEGER,
  PRIMARY KEY (member_id, kind)
);

-- First-party, cookieless page views, rolled up per day. IP addresses and user agents are never
-- stored. Unique visitors are counted with a hash of IP and user agent salted with a key that
-- changes daily; the hashes are kept only for their day (site_visitors) and then deleted, after
-- which they can't be linked to anyone or to other days.
CREATE TABLE site_page_views_daily (
  channel_id  TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  day         TEXT NOT NULL CHECK (length(day) = 10),
  path        TEXT NOT NULL CHECK (length(path) <= 512),
  source      TEXT NOT NULL CHECK (length(source) <= 120),
  device      TEXT NOT NULL CHECK (device IN ('desktop', 'mobile', 'tablet', 'bot', 'other')),
  country     TEXT NOT NULL CHECK (length(country) <= 2),
  views       INTEGER NOT NULL DEFAULT 0,
  visitors    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, day, path, source, device, country)
);

CREATE TABLE site_visitors (
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  day           TEXT NOT NULL CHECK (length(day) = 10),
  visitor_hash  TEXT NOT NULL CHECK (length(visitor_hash) = 32),
  PRIMARY KEY (channel_id, day, visitor_hash)
) WITHOUT ROWID;
