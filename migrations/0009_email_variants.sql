-- Phase 5: a gated paid Dispatch is sent as two emails. Members its Gate admits get the full
-- email (broadcasts.html/text, as before); everyone else gets the teaser that stops at the gate.
-- The split is decided per recipient during the snapshot and kept on the recipient row, so a
-- retried batch sends each Member the email they were assigned.

-- The teaser template (same placeholders and link positions as html/text); NULL when the
-- Broadcast is one email for everyone.
ALTER TABLE broadcasts ADD COLUMN teaser_html TEXT;
ALTER TABLE broadcasts ADD COLUMN teaser_text TEXT;
-- The Gate's levels as counted at start (empty array = any paid level); NULL with no teaser.
ALTER TABLE broadcasts ADD COLUMN gate_level_ids_json TEXT
  CHECK (gate_level_ids_json IS NULL OR json_valid(gate_level_ids_json));

ALTER TABLE broadcast_recipients ADD COLUMN variant TEXT NOT NULL DEFAULT 'full'
  CHECK (variant IN ('full', 'teaser'));
