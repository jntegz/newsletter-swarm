-- Member Center links (purpose "member") are stateless signed tokens that last 30 days and travel
-- in every Broadcast footer. member_links_after lets one Member turn off every link issued before
-- a moment (ms since the epoch): /m/<token> refuses a token whose issue time is earlier. NULL
-- means no link has been turned off. Set from the Member Center with a freshly emailed link
-- (workers/capture/src/routes/member.ts, "Turn off older links").
ALTER TABLE members ADD COLUMN member_links_after INTEGER;
