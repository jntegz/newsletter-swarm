-- A landing page: a custom page with a Capture Form of its own, shown without the site's navigation.
-- NULL is an ordinary page. A page keeps working as an ordinary one if the flag is turned off.
ALTER TABLE site_pages ADD COLUMN landing_form_id TEXT REFERENCES capture_forms (id) ON DELETE SET NULL;
