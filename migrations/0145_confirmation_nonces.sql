-- Link families on their own keys (docs/security.md "Keys").
--
-- An erasure or address-request confirmation link carries a nonce: 128 random bits that only the
-- emailed link holds. The row keeps its sha256, so neither the signing key nor a read of these
-- tables is enough to confirm someone else's request. Rows from before have none, and only a link
-- without one (from before) confirms them; they expire within a day.
ALTER TABLE dsr_confirmations ADD COLUMN nonce_hash TEXT;
ALTER TABLE address_confirmations ADD COLUMN nonce_hash TEXT;
