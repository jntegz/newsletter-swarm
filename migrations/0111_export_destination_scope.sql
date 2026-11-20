-- What an export destination sends (packages/domain/src/p7-privacy.ts ExportScope,
-- packages/engine/src/export-sync.ts). scope_json is {members: 'active' | 'all',
-- fields: 'all' | [field keys]}. A new destination defaults to subscribed (active) Members only,
-- with no profile field values, unless the admin picks fields. Destinations that exist now keep
-- exactly what they send today (everyone, every field), so no copy breaks; scope_legacy marks
-- them so the dashboard can say so and offer to narrow them. Saving a scope clears the mark.
ALTER TABLE export_destinations ADD COLUMN scope_json TEXT NOT NULL
  DEFAULT '{"members":"active","fields":[]}' CHECK (json_valid(scope_json));
ALTER TABLE export_destinations ADD COLUMN scope_legacy INTEGER NOT NULL DEFAULT 0
  CHECK (scope_legacy IN (0, 1));
UPDATE export_destinations SET scope_json = '{"members":"all","fields":"all"}', scope_legacy = 1;
