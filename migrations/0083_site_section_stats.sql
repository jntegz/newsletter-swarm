-- Section analytics and A/B tests on website themes (docs/site-themes.md). Counted without cookies
-- like the site's page views, and with nothing about the reader: per Channel, UTC day, section id
-- and variant, how many home page views reached the section (its lazy beacon loaded) and how many
-- signups came through the signup form inside it. Kept as long as the Channel, like
-- site_page_views_daily.
CREATE TABLE site_section_daily (
  channel_id  TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  day         TEXT NOT NULL CHECK (length(day) = 10),
  section_id  TEXT NOT NULL CHECK (length(section_id) BETWEEN 1 AND 40),
  variant     TEXT NOT NULL CHECK (variant IN ('a', 'b')),
  reached     INTEGER NOT NULL DEFAULT 0,
  signups     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, day, section_id, variant)
) WITHOUT ROWID;

-- The section ids of the published design's running A/B tests, as a JSON list, written on
-- publish. The site reads it with the Channel on every request, so a home page view gets its
-- variants before the edge cache is looked up, without reading the design itself.
ALTER TABLE site_designs ADD COLUMN published_tests TEXT
  CHECK (published_tests IS NULL OR json_valid(published_tests));
