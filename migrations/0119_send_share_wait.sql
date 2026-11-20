-- A send held back for its workspace's share of the install's sending capacity (security review
-- S04-P3-TR-send-workspace-share): other workspaces are sending at the same time, or a very large
-- send is admitted in parts. Unlike waiting_for, nothing about the install's limits is wrong and no
-- person needs to act; the send report says it is waiting for capacity and when it asks again.
-- Cleared once a batch of it goes out again.
ALTER TABLE broadcasts ADD COLUMN share_wait_since INTEGER;
ALTER TABLE broadcasts ADD COLUMN share_wait_until INTEGER;
