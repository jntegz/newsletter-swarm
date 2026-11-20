-- A post's cover image: a media library item and its alt text, kept outside the editor document
-- because it renders above the body and is never behind the Gate. Revisions and templates carry
-- it too. Media is soft-deleted, so a reference can outlive its item: renderers leave the image
-- out and warn. Workspaces are the tenancy boundary, checked by the API on every new reference.
ALTER TABLE dispatches ADD COLUMN cover_media_id TEXT REFERENCES media (id) ON DELETE SET NULL;
ALTER TABLE dispatches ADD COLUMN cover_alt TEXT NOT NULL DEFAULT '' CHECK (length(cover_alt) <= 300);

ALTER TABLE dispatch_revisions ADD COLUMN cover_media_id TEXT REFERENCES media (id) ON DELETE SET NULL;
ALTER TABLE dispatch_revisions ADD COLUMN cover_alt TEXT NOT NULL DEFAULT '' CHECK (length(cover_alt) <= 300);

ALTER TABLE templates ADD COLUMN cover_media_id TEXT REFERENCES media (id) ON DELETE SET NULL;
ALTER TABLE templates ADD COLUMN cover_alt TEXT NOT NULL DEFAULT '' CHECK (length(cover_alt) <= 300);
