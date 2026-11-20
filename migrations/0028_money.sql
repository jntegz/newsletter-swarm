-- Money fixes after the Phase 5 audit: MRR that reflects coupons, and Gift Pass reminders.
-- Conventions as in 0001_foundation.sql.

-- What a Stripe subscription actually bills per interval while its recurring discounts last
-- (coupons with duration 'repeating' or 'forever'; a 'once' coupon never changes MRR). NULL when
-- no such discount applies; then `amount` is the price. discount_end is when the discount stops
-- (ms); NULL with a discounted_amount means it never does. Written by the webhook from the
-- subscription's discounts.
ALTER TABLE member_subscriptions ADD COLUMN discounted_amount INTEGER
  CHECK (discounted_amount IS NULL OR discounted_amount >= 0);
ALTER TABLE member_subscriptions ADD COLUMN discount_end INTEGER;

-- Gift Pass reminders (flag gift_passes), sent once each by the jobs cron:
-- - a claimed Gift Pass (member_subscriptions source 'gift') a week before its access ends;
-- - an unclaimed one a fortnight before claim_by. The claim link in that reminder is a second
--   token, so the first link keeps working; only its hash is stored.
ALTER TABLE member_subscriptions ADD COLUMN expiry_reminded_at INTEGER;
ALTER TABLE gift_passes ADD COLUMN claim_reminded_at INTEGER;
ALTER TABLE gift_passes ADD COLUMN reminder_token_hash TEXT;
CREATE UNIQUE INDEX gift_passes_reminder_token ON gift_passes (reminder_token_hash)
  WHERE reminder_token_hash IS NOT NULL;
CREATE INDEX gift_passes_claim_due ON gift_passes (claim_by) WHERE status = 'paid';
CREATE INDEX member_subscriptions_gift_end ON member_subscriptions (current_period_end)
  WHERE source = 'gift' AND status = 'active';
