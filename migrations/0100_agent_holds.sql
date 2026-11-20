-- Agent holds (security review P4): what an approval is about, who may decide it, and how a
-- workspace bounds agents. Contract: docs/open-operator.md, docs/copilot.md.
--
-- agent_settings
-- - separate_approver: 1 = the person who caused a held call (the Copilot operator, the key's
--   creator, the OAuth grant's consenting admin) can't approve it; another admin must.
-- - exposed_hold_minutes: after a credential reads text from outside the workspace (Member names,
--   fields and leaving reasons, feed items), its write calls are held for this long; 0 = off.
-- - copilot_member_detail: 'masked' (default) gives the Copilot model Member results without
--   addresses, names, field values or free text; 'full' sends them as the API returns them.
ALTER TABLE agent_settings ADD COLUMN separate_approver INTEGER NOT NULL DEFAULT 0
  CHECK (separate_approver IN (0, 1));
ALTER TABLE agent_settings ADD COLUMN exposed_hold_minutes INTEGER NOT NULL DEFAULT 0
  CHECK (exposed_hold_minutes BETWEEN 0 AND 1440);
ALTER TABLE agent_settings ADD COLUMN copilot_member_detail TEXT NOT NULL DEFAULT 'masked'
  CHECK (copilot_member_detail IN ('masked', 'full'));

-- agent_approvals
-- - target_json: what the call acts on, as it was when it was held (a Dispatch's subject, sender,
--   audience and a digest of its send fields); approval runs only while the target still matches.
-- - hold_reason: why it was held when its tool is not destructive by itself (an effect of its
--   body or of the target's state).
-- - copilot_request_id: the Copilot request (copilot_requests.id) that proposed it.
ALTER TABLE agent_approvals ADD COLUMN target_json TEXT;
ALTER TABLE agent_approvals ADD COLUMN hold_reason TEXT;
ALTER TABLE agent_approvals ADD COLUMN copilot_request_id TEXT;

-- agent_actions.copilot_request_id: the Copilot request a call was part of (hashed into the row
-- when set).
ALTER TABLE agent_actions ADD COLUMN copilot_request_id TEXT;
