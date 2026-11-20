-- Gift article links get an enforced reach (workers/site/src/money/access.ts): reads counts the
-- times a link opened its Dispatch, and a link stops at GIFT_ARTICLE_MAX_READS; revoked_at is set
-- when the minting Member or the publisher stops it. A link also stops when the minting Member can
-- no longer read the Dispatch themselves (a cancellation or refund), which needs no column.
ALTER TABLE gift_article_links ADD COLUMN reads INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gift_article_links ADD COLUMN revoked_at INTEGER;
