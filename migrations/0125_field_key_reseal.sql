-- Progress of sealing FIELD_KEYS values again with the current key after `pnpm swarm rotate-keys
-- FIELD_KEYS` (workers/jobs/src/handlers/field-keys.ts). One row per key values are moved to.
-- place is the table.column being walked (packages/domain/src/sealed-columns.ts) and after_key the
-- JSON array of the primary key it has reached, so each run continues where the last one stopped.
-- finished_at is set once every place has been walked; resealed and unreadable count the values
-- sealed again and the ones no key in the ring could open.
CREATE TABLE field_key_reseal (
  kid          TEXT PRIMARY KEY,
  place        TEXT,
  after_key    TEXT CHECK (after_key IS NULL OR json_valid(after_key)),
  resealed     INTEGER NOT NULL DEFAULT 0,
  unreadable   INTEGER NOT NULL DEFAULT 0,
  started_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
