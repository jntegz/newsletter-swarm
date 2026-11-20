-- A post's own title and description for search results and social shares. Empty uses the subject
-- and the preheader or excerpt.
ALTER TABLE dispatches ADD COLUMN seo_title TEXT NOT NULL DEFAULT '';
ALTER TABLE dispatches ADD COLUMN seo_description TEXT NOT NULL DEFAULT '';
