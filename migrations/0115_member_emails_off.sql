-- A subscriber's own mail choice, apart from their status and what they paid for (security review
-- S03-P5-G-paid-mail-choice): "Stop emails, keep my membership" in subscriber settings. While set,
-- posts and automation emails skip them; mail that belongs to the service (receipts, sign-in
-- links, billing notices, confirmations) still goes, and their status, website access and paid
-- access don't change. NULL means they receive emails as usual.
ALTER TABLE members ADD COLUMN emails_off_at INTEGER;
