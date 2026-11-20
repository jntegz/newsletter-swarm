-- "Check again" on a subscriber's address (POST /api/v1/members/{memberId}/email-check) is a
-- stored request, not a flag on a queue message. Queue messages are not signed and the public
-- capture and events workers can put any message on the jobs queue, so a forged email_check
-- could otherwise set `force` and spend a workspace's DeBounce budget past its own settings.
-- The api writes a row here and queues its id; the jobs worker takes the workspace, Channel and
-- Member from the row, deletes it (single use) and checks with force. Rows the queue never
-- delivered are deleted after a day (workers/jobs/src/handlers/email-checks.ts). A Member's
-- erasure deletes their rows through the cascade.
CREATE TABLE email_check_requests (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel_id    TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  member_id     TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  requested_by  TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX email_check_requests_by_age ON email_check_requests (created_at);
CREATE INDEX email_check_requests_by_member ON email_check_requests (member_id);
