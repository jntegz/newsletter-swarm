-- Review fixes: who paused a warm-up, explicit grants for an instance admin's own workspaces, the
-- cause a bounce hold keeps, and a bound on the attempts of a small email check.

-- 1. Who paused a warm-up (docs/warm-up.md "When sending pauses"). 'system': the ramp paused itself
-- over bounces or complaints (checkRampHealth, rollover); 'person': someone pressed Pause sending.
-- NULL while the ramp is not paused. On the shared domain only an instance admin may resume a
-- 'system' pause; the reason is free text and no longer decides that. Code: packages/engine/src/
-- ramp.ts and workers/api/src/routes/sending.ts.
ALTER TABLE reputation_ramps ADD COLUMN paused_by TEXT
  CHECK (paused_by IS NULL OR paused_by IN ('system', 'person'));
-- Paused ramps whose reason a person's pause wrote ("Paused by a teammate.", older "Paused by an
-- operator.") become 'person'; every other paused ramp paused itself.
UPDATE reputation_ramps
   SET paused_by = CASE WHEN paused_reason GLOB 'Paused by a *' OR paused_reason GLOB 'Paused by an *'
                        THEN 'person' ELSE 'system' END
 WHERE status = 'paused';

-- 2. Install-level grants come only from rows an instance admin wrote (docs/security.md "Where
-- owner code runs", docs/email-verification.md "Who can use the credits"). An owner seat no longer
-- grants anything by itself: any owner can make any teammate an owner, so a tenant could promote an
-- instance admin they invited and unlock the install's domain and DeBounce credits.
--
-- A workspace an instance admin made is allowed: the workspace.created entry of its audit log
-- names them, and they still hold an owner seat there. Rows for the workspaces that qualify now:
INSERT INTO site_code_workspaces (workspace_id, allowed_by, created_at)
  SELECT s.workspace_id, s.operator_id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM seats s JOIN instance_admins i ON i.operator_id = s.operator_id
   WHERE s.role = 'owner'
     AND EXISTS (SELECT 1 FROM audit_events a
                  WHERE a.workspace_id = s.workspace_id AND a.action = 'workspace.created'
                    AND a.actor_operator_id = s.operator_id)
  ON CONFLICT (workspace_id) DO NOTHING;
INSERT INTO email_check_workspaces (workspace_id, allowed_by, created_at)
  SELECT s.workspace_id, s.operator_id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM seats s JOIN instance_admins i ON i.operator_id = s.operator_id
   WHERE s.role = 'owner'
     AND EXISTS (SELECT 1 FROM audit_events a
                  WHERE a.workspace_id = s.workspace_id AND a.action = 'workspace.created'
                    AND a.actor_operator_id = s.operator_id)
  ON CONFLICT (workspace_id) DO NOTHING;

-- And from now on: an operator made an instance admin (by the installer, or in SQL as
-- docs/deployment.md shows, after their first sign-in made their workspace) gets the same rows for
-- the workspaces they made. The installer also writes them when it makes the owner's workspace.
CREATE TRIGGER instance_admins_allow_own_workspaces AFTER INSERT ON instance_admins
BEGIN
  INSERT INTO site_code_workspaces (workspace_id, allowed_by, created_at)
    SELECT s.workspace_id, NEW.operator_id, NEW.created_at FROM seats s
     WHERE s.operator_id = NEW.operator_id AND s.role = 'owner'
       AND EXISTS (SELECT 1 FROM audit_events a
                    WHERE a.workspace_id = s.workspace_id AND a.action = 'workspace.created'
                      AND a.actor_operator_id = NEW.operator_id)
    ON CONFLICT (workspace_id) DO NOTHING;
  INSERT INTO email_check_workspaces (workspace_id, allowed_by, created_at)
    SELECT s.workspace_id, NEW.operator_id, NEW.created_at FROM seats s
     WHERE s.operator_id = NEW.operator_id AND s.role = 'owner'
       AND EXISTS (SELECT 1 FROM audit_events a
                    WHERE a.workspace_id = s.workspace_id AND a.action = 'workspace.created'
                      AND a.actor_operator_id = NEW.operator_id)
    ON CONFLICT (workspace_id) DO NOTHING;
END;

-- 3. A block is about the sender, not the address (docs/deliverability.md "Bounces"), so it no
-- longer replaces an address's last bounce in bounce_states. Rows a block already overwrote get
-- back their newest hard or soft bounce, so a hold's "Stop mailing" records why it stopped.
UPDATE bounce_states
   SET (last_kind, last_cause, last_code, last_detail, last_bounced_at) = (
         SELECT e.kind, e.cause, e.code, e.detail, e.created_at FROM bounce_events e
          WHERE e.workspace_id = bounce_states.workspace_id AND e.email = bounce_states.email
            AND e.kind <> 'blocked'
          ORDER BY e.created_at DESC LIMIT 1)
 WHERE last_kind = 'blocked'
   AND EXISTS (SELECT 1 FROM bounce_events e
                WHERE e.workspace_id = bounce_states.workspace_id AND e.email = bounce_states.email
                  AND e.kind <> 'blocked');

-- 4. A small email check (method 'single') asks DeBounce once per address and step. An address
-- that keeps failing (DeBounce busy, down or making no sense, or no free place to ask) is given up
-- after SINGLE_ATTEMPTS (3, packages/engine/src/email-checks.ts) tries and stays "not checked", so
-- the run can finish.
ALTER TABLE email_check_items ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
