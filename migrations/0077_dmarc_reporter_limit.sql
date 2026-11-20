-- The DMARC report address is public, so the daily report limit per sending domain is also held
-- per reporter: reporter_domain is the organisational domain of the envelope sender, so one sender
-- can't use up the whole day's limit and crowd out Google's or Microsoft's real reports.
-- Existing rows keep NULL: who sent them wasn't recorded.
ALTER TABLE dmarc_reports ADD COLUMN reporter_domain TEXT;
CREATE INDEX dmarc_reports_by_reporter ON dmarc_reports (sending_domain_id, reporter_domain, created_at);
