-- Editor options: a Channel's custom email CSS (the custom_email_css flag). Contract:
-- docs/architecture.md "Code embeds and custom email CSS". Conventions as in 0001_foundation.sql.

-- One stylesheet per Channel, as the operator typed it; it passed lintEmailCss (@swarm/mail) when
-- it was saved and is linted again at every render. Bounded by EMAIL_CSS_MAX_BYTES (20 KB).
CREATE TABLE channel_email_css (
  channel_id TEXT PRIMARY KEY REFERENCES channels (id) ON DELETE CASCADE,
  css TEXT NOT NULL CHECK (length(css) <= 20000),
  updated_by TEXT REFERENCES operators (id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL
);
