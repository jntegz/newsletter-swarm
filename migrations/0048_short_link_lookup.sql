-- Recognising a link Swarm already shortened, and showing where it goes in post stats.
CREATE INDEX app_short_links_short_url ON app_short_links (short_url);
