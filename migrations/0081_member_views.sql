-- Saved views of the Member list: a name and the filters (status, search, tag, Circle, columns) as
-- JSON, kept per Channel so everyone on its team sees the same views. A view holds no Members and
-- changes nothing. Names are unique per Channel, ignoring case, as tags are.
CREATE TABLE member_views (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  name         TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 60),
  filters_json TEXT NOT NULL CHECK (json_valid(filters_json)),
  created_by   TEXT REFERENCES operators (id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (channel_id, name)
);
