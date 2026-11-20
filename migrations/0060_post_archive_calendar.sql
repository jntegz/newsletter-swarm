-- Dashboard housekeeping and planning for posts. None of these columns is read by a send path except
-- imported_at, which refuses a send, and none is read by the website.
--
-- archived_at: hidden from the dashboard's default posts list. It changes nothing already sent, keeps
-- the stats, and leaves the post on the website.
ALTER TABLE dispatches ADD COLUMN archived_at INTEGER;
-- planned_date: the day (YYYY-MM-DD, no time zone) a writer aims to send a draft. It has no effect on
-- sending; publish_at is what schedules.
ALTER TABLE dispatches ADD COLUMN planned_date TEXT;
-- imported_at: an issue brought over from another platform. Readers already had it, so it is a past
-- issue rather than a draft waiting to go out, and Swarm won't email it.
ALTER TABLE dispatches ADD COLUMN imported_at INTEGER;

-- Earlier imports left no mark, but only an import dates a post's web publication before the post
-- existed: publishing on the website otherwise uses the current time.
UPDATE dispatches SET imported_at = created_at
 WHERE kind = 'broadcast' AND status IN ('draft', 'scheduled')
   AND web_published_at IS NOT NULL AND web_published_at < created_at;
