-- Inactive-reader cleanup (membercenter.ts sunsetInactiveMembers) now tells a reader before it
-- unsubscribes them and lets them stay with one click from their subscriber settings.
-- sunset_notice_at: when the "you will be unsubscribed" email went out; the cleanup acts only
-- after a grace period and only on a recent notice. sunset_kept_at: when they chose to stay,
-- which counts like an open, so the inactive period starts again from then.
ALTER TABLE members ADD COLUMN sunset_notice_at INTEGER;
ALTER TABLE members ADD COLUMN sunset_kept_at INTEGER;
