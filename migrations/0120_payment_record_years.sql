-- How long payment references outlive the person they were about (packages/engine/src/lifetimes.ts,
-- docs/gdpr.md). An erasure keeps a payment's Stripe id and a checkout's Stripe session id for the
-- publisher's books, detached from the person (privacy.ts RETAINED_PROVIDER_REFERENCES). They are
-- kept only for that legal obligation: payment_record_years after the payment (or the checkout),
-- the jobs worker removes them, and the amounts and dates stay. Tax record periods differ by
-- country, so the workspace picks its own; 10 years covers the longest common ones.
ALTER TABLE workspaces ADD COLUMN payment_record_years INTEGER NOT NULL DEFAULT 10
  CHECK (payment_record_years IN (6, 7, 8, 10));

-- When the row was detached from its person by an erasure or a deleted publication's purge. NULL:
-- still someone's, or detached before this migration (backfilled below where nobody is named).
ALTER TABLE payments ADD COLUMN detached_at INTEGER;
ALTER TABLE checkout_sessions ADD COLUMN detached_at INTEGER;

-- Rows already without a person: an erasure or a delete before this migration. They follow the
-- same period from now on.
UPDATE payments SET detached_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE member_id IS NULL;
UPDATE checkout_sessions SET detached_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE member_id IS NULL AND email IS NULL AND stripe_session_id IS NOT NULL;

-- Detached rows whose Stripe reference is still there, for the expiry job.
CREATE INDEX payments_detached ON payments (occurred_at)
  WHERE detached_at IS NOT NULL AND stripe_object_id NOT LIKE 'expired:%';
CREATE INDEX checkout_sessions_detached ON checkout_sessions (created_at)
  WHERE detached_at IS NOT NULL AND stripe_session_id IS NOT NULL;
