-- The free-read meter keeps only what the current period needs (workers/site/src/money/meter.ts).
-- An anonymous visitor's reads now live in their own signed cookie, so the rows keyed by a hashed
-- meter cookie ('a:' + SHA-256) are a reading log nothing uses: they are deleted. A signed-in
-- Member's rows are kept for the current and last period by the daily site housekeeping, and go
-- with the Member when the Member row is deleted (reader_key has no foreign key, so a trigger).
DELETE FROM gate_meter_reads WHERE reader_key LIKE 'a:%';

CREATE INDEX gate_meter_reads_by_time ON gate_meter_reads (read_at);

CREATE TRIGGER members_deleted_meter_reads
AFTER DELETE ON members
BEGIN
  -- By the primary key's prefix, so deleting many Members never scans the table.
  DELETE FROM gate_meter_reads WHERE channel_id = OLD.channel_id AND reader_key = OLD.id;
END;
