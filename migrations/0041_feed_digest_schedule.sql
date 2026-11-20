-- A digest on set days at a set time, in the source's timezone. NULL weekdays: whenever the caps
-- allow, as before. digest_since is when the schedule was set, so a slot from before that can't
-- release anything.
ALTER TABLE feed_sources ADD COLUMN digest_weekdays_json TEXT
  CHECK (digest_weekdays_json IS NULL OR json_valid(digest_weekdays_json));
ALTER TABLE feed_sources ADD COLUMN digest_time TEXT;
ALTER TABLE feed_sources ADD COLUMN digest_since INTEGER;
