-- Permission vocabulary contraction (transition step 2 of 2).
--
-- Every call site now checks the eight-key vocabulary, so the legacy
-- resource:action keys stop doing anything. This strips them from every
-- role's array, leaving only the final catalog. The pre-transition arrays
-- stay archived in Role.legacyPermissions (written by the expand step) for
-- review and manual rollback.
--
-- Rollback (restores the pre-EXPANSION arrays — legacy vocabulary only):
--   UPDATE "Role"
--   SET "permissions" = ARRAY(SELECT jsonb_array_elements_text("legacyPermissions"))
--   WHERE "legacyPermissions" IS NOT NULL;

UPDATE "Role"
SET "permissions" = ARRAY(
  SELECT p
  FROM unnest("permissions") AS p
  WHERE p = ANY(ARRAY[
    'production:read',
    'production:write',
    'production:admin',
    'planning:read',
    'planning:write',
    'configuration:read',
    'configuration:write',
    'plant:admin',
    'owner:all'
  ])
)
WHERE NOT "permissions" <@ ARRAY[
  'production:read',
  'production:write',
  'production:admin',
  'planning:read',
  'planning:write',
  'configuration:read',
  'configuration:write',
  'plant:admin',
  'owner:all'
];
