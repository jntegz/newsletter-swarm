-- Flows that watch one link find its short link by the original address.
CREATE INDEX app_short_links_url ON app_short_links (url);
