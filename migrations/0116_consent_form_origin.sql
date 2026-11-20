-- Where a form signup came from, as two separate facts (security review
-- S04-P2-TR-form-origin-honest-binding).
--   verified_host   the host the server itself checked: the hostname Cloudflare Turnstile reported
--                   for a pass solved for this form (its cdata), or the forms address's host when
--                   the person answered Swarm's own question there instead. Widgets only render on
--                   the forms address, so this shows the check ran on Swarm's own page for this
--                   form; the site that page was embedded in can't be verified by the server.
--   claimed_origin  the site the submission said it was on (the frame's parentOrigin, or a plain
--                   post's Origin or Referer). A scripted client can set it to anything: it is
--                   recorded, never treated as proof.
-- Records written before this have neither.
ALTER TABLE member_consents ADD COLUMN verified_host TEXT
  CHECK (verified_host IS NULL OR length(verified_host) <= 255);
ALTER TABLE member_consents ADD COLUMN claimed_origin TEXT
  CHECK (claimed_origin IS NULL OR length(claimed_origin) <= 255);
