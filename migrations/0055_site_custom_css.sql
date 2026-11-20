-- An owner's own CSS for their website, added to the end of the site stylesheet. Checked when saved:
-- it can't load anything from elsewhere, so a site still makes no third-party requests from it.
ALTER TABLE site_settings ADD COLUMN custom_css TEXT NOT NULL DEFAULT '';
