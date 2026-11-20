-- Tracking choices and how long engagement history is kept (docs/privacy-controls.md).
--
-- Per publication, channels.settings_json gains trackClicks and profileReaders next to the
-- existing trackOpens (all on unless set to false); nothing to migrate for those.

-- A subscriber asked, in subscriber settings, not to have their opens and clicks tracked. NULL
-- means they did not. Set: no open pixel, links go straight to their address, no engagement score
-- and no best sending hour for them.
ALTER TABLE members ADD COLUMN tracking_opt_out_at INTEGER;

-- 0 when the delivery went to someone who had asked not to be tracked: it had no pixel and plain
-- links, so the send report leaves it out of its open and click rates.
ALTER TABLE deliveries ADD COLUMN tracked INTEGER NOT NULL DEFAULT 1 CHECK (tracked IN (0, 1));

-- Click tracking per person, frozen at the start of a send like track_opens. 0: plain links.
ALTER TABLE broadcasts ADD COLUMN track_clicks INTEGER NOT NULL DEFAULT 1 CHECK (track_clicks IN (0, 1));

-- When someone asks not to be tracked, their past opens and clicks are deleted. These keep the
-- send report's totals as they were: the number of their deliveries that had been opened or
-- clicked, per send, and their clicks per link.
ALTER TABLE broadcasts ADD COLUMN carried_opened INTEGER NOT NULL DEFAULT 0;
ALTER TABLE broadcasts ADD COLUMN carried_human_opened INTEGER NOT NULL DEFAULT 0;
ALTER TABLE broadcasts ADD COLUMN carried_clicked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE broadcasts ADD COLUMN carried_human_clicked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE link_targets ADD COLUMN carried_clicks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE link_targets ADD COLUMN carried_human_clicks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE link_targets ADD COLUMN carried_human_people INTEGER NOT NULL DEFAULT 0;

-- How long deliveries, opens, clicks and per-send copies of addresses stay tied to a person.
-- After that the jobs worker removes the person from them and keeps the counts.
ALTER TABLE workspaces ADD COLUMN engagement_retention_months INTEGER NOT NULL DEFAULT 13
  CHECK (engagement_retention_months IN (6, 13, 24, 36));

-- Deliveries still tied to a person ('erased' is what erasure and the retention job write).
CREATE INDEX deliveries_identified ON deliveries (channel_id, sent_at) WHERE email <> 'erased';
-- Opens of a delivery, for the retention job, erasure and the tracking choice.
CREATE INDEX opens_by_delivery ON opens (delivery_id);
-- Automation emails' per-send copies of addresses that the retention job has not cleared yet.
CREATE INDEX broadcast_recipients_identified ON broadcast_recipients (broadcast_id, claimed_at)
  WHERE email <> 'erased';
