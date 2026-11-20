-- Several start events per Flow, and why a start event didn't let a Member in.
--
-- The trigger node's config in graph_json holds the start events; a graph with one has no
-- `alsoStartOn` and reads as before, so no existing Flow or version needs rewriting. trigger_type
-- stays the first start event. extra_trigger_types lists the other event types (a JSON array) so
-- enrolment can find the Flow; NULL means there are none.
ALTER TABLE flows ADD COLUMN extra_trigger_types TEXT
  CHECK (extra_trigger_types IS NULL OR json_valid(extra_trigger_types));
ALTER TABLE flow_versions ADD COLUMN extra_trigger_types TEXT
  CHECK (extra_trigger_types IS NULL OR json_valid(extra_trigger_types));

-- The latest start event that matched a Member but did not start a run, per Member and Flow
-- (FLOW_ENROL_DECISIONS in @swarm/domain). One row at most, and only for a start event that really
-- fired for that Member: an entry is a flow_runs row and clears this one. Goes with the Member;
-- the daily job removes the rows of archived and deleted Flows.
CREATE TABLE flow_enrol_decisions (
  member_id      TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  flow_id        TEXT NOT NULL REFERENCES flows (id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  reason         TEXT NOT NULL CHECK (length(reason) <= 30),
  trigger_event  TEXT NOT NULL CHECK (length(trigger_event) <= 40),
  decided_at     INTEGER NOT NULL,
  PRIMARY KEY (member_id, flow_id)
) WITHOUT ROWID;
-- For the Flow's cascade and the daily prune.
CREATE INDEX flow_enrol_decisions_by_flow ON flow_enrol_decisions (flow_id);
