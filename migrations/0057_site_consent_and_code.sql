-- The cookie popup an owner can add to their website, and code they add to it such as analytics.
-- Code is stored inert and runs in the reader's browser only after that reader agrees, unless the
-- owner marks it as strictly necessary.
ALTER TABLE site_settings ADD COLUMN consent_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE site_settings ADD COLUMN code_json TEXT NOT NULL DEFAULT '[]';
