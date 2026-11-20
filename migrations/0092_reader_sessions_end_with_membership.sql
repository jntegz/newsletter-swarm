-- A reader session ends for good when its Member stops being a reader. The site already reads a
-- session as anonymous while the Member is not active or paused; deleting the rows as the status
-- changes means a Member who unsubscribes (or bounces, or complains) and later comes back never
-- finds an old browser signed in again. Every path that changes a status goes through this
-- trigger, whichever worker runs it.
CREATE TRIGGER members_left_end_reader_sessions
AFTER UPDATE OF status ON members
WHEN NEW.status NOT IN ('active', 'paused') AND OLD.status IN ('active', 'paused')
BEGIN
  DELETE FROM reader_sessions WHERE member_id = NEW.id;
END;

-- Sessions already held by Members who are no longer readers.
DELETE FROM reader_sessions
 WHERE member_id IN (SELECT id FROM members WHERE status NOT IN ('active', 'paused'));
