-- A note for the team on a Dispatch. It goes in no email, page, feed or webhook.
ALTER TABLE dispatches ADD COLUMN internal_note TEXT NOT NULL DEFAULT '' CHECK (length(internal_note) <= 2000);
