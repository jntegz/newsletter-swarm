-- When the sponsor was last emailed a report link: by the jobs worker after the link cutover
-- (sponsor report links now live 90 days, not 365), or by an admin from the booking
-- (packages/engine/src/sponsor-report-links.ts).
ALTER TABLE sponsor_bookings ADD COLUMN report_link_sent_at INTEGER;
