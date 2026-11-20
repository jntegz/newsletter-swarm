-- A domain is held by proof, not by who added it first. Until a sending or link domain verifies (or
-- a web hostname goes active), its claim holds the name only for the re-check window, and another
-- Channel can take it over sooner with a TXT proof. proven_at records the first verification and
-- is never cleared: a service change resets verified_at, and a certificate renewal sets an active
-- hostname back to pending, but neither makes the claim unproven.
--
-- The UNIQUE constraints stay. sending_domains can't be rebuilt without its ON DELETE CASCADE
-- children (senders, ramps, DMARC reports) going with it, and the mail and hostname services hold
-- one copy of a name anyway, so a takeover deletes the old claim instead.
--
-- Existing rows: a domain counts as proven if it was ever verified, or went through a service
-- change (verified_at was cleared then, so it may have been). A hostname counts as proven unless it
-- is pending: an active one is only checked again by hand, so hardly any have gone back.
ALTER TABLE sending_domains ADD COLUMN proven_at INTEGER;
UPDATE sending_domains SET proven_at = coalesce(verified_at, provider_changed_at);
ALTER TABLE custom_hostnames ADD COLUMN proven_at INTEGER;
UPDATE custom_hostnames SET proven_at = coalesce(last_checked_at, updated_at) WHERE status <> 'pending';
