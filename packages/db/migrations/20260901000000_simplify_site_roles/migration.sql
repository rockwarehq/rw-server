-- Simplify the seeded site roles down to two:
--   Factory Administrator                -> Plant Admin   (renamed in place)
--   Office User + Read-only User         -> Plant Member  (merged, read-only
--                                           base membership)
-- Company Administrator (workspace scope) and custom roles are untouched.

-- 0. A workspace may already have a CUSTOM site role using one of the new
--    names (unique [workspaceId, name, scope]). Move it out of the way.
UPDATE "Role"
SET "name" = "name" || ' (custom)'
WHERE "isSystem" = false
  AND "scope" = 'SITE'
  AND "name" IN ('Plant Admin', 'Plant Member');

-- 1. Rename Factory Administrator -> Plant Admin in place; assignments follow
--    the roleId. Permissions are refreshed by seedSystemRoles on next boot.
UPDATE "Role"
SET "name" = 'Plant Admin',
    "description" = 'Plant administrator with full access to all plant data, settings, and user management.'
WHERE "isSystem" = true
  AND "scope" = 'SITE'
  AND "name" = 'Factory Administrator';

-- 2. Make sure every workspace has a Plant Member system role (the base
--    membership tier: read access; workcenter grants layer on top).
INSERT INTO "Role" ("id", "workspaceId", "name", "description", "scope", "permissions", "isSystem", "createdAt", "updatedAt")
SELECT gen_random_uuid(),
       w."id",
       'Plant Member',
       'Base plant membership with read access to plant data. Workcenter access can be granted per workcenter.',
       'SITE',
       ARRAY['facility:read','schedule:read','job:read','status:read','calls:read','modes:read',
             'notifications:read','tool:read','product:read','dashboard:read','entity:read',
             'graph:read','employee:read'],
       true,
       now(),
       now()
FROM "Workspace" w
WHERE NOT EXISTS (
  SELECT 1
  FROM "Role" r
  WHERE r."workspaceId" = w."id"
    AND r."name" = 'Plant Member'
    AND r."scope" = 'SITE'
    AND r."isSystem" = true
);

-- 3. Repoint exactly one Office User / Read-only User assignment per
--    (membership, site) to Plant Member. DISTINCT ON matters: a membership
--    holding BOTH old roles at one site must end with a single Plant Member
--    row. Memberships already holding Plant Member at that site are skipped.
WITH old_roles AS (
  SELECT "id", "workspaceId"
  FROM "Role"
  WHERE "isSystem" = true
    AND "scope" = 'SITE'
    AND "name" IN ('Office User', 'Read-only User')
),
targets AS (
  SELECT DISTINCT ON (ra."membershipId", ra."siteId")
         ra."id",
         pu."id" AS plant_user_id
  FROM "RoleAssignment" ra
  JOIN old_roles o ON o."id" = ra."roleId"
  JOIN "Role" pu ON pu."workspaceId" = o."workspaceId"
              AND pu."name" = 'Plant Member'
              AND pu."scope" = 'SITE'
              AND pu."isSystem" = true
  WHERE NOT EXISTS (
    SELECT 1
    FROM "RoleAssignment" existing
    WHERE existing."membershipId" = ra."membershipId"
      AND existing."siteId" IS NOT DISTINCT FROM ra."siteId"
      AND existing."roleId" = pu."id"
  )
  ORDER BY ra."membershipId", ra."siteId", ra."createdAt"
)
UPDATE "RoleAssignment" ra
SET "roleId" = t.plant_user_id
FROM targets t
WHERE ra."id" = t."id";

-- 4. Drop leftover assignments still pointing at the old roles (duplicates
--    within a (membership, site) pair), then the old roles themselves.
DELETE FROM "RoleAssignment" ra
USING "Role" o
WHERE ra."roleId" = o."id"
  AND o."isSystem" = true
  AND o."scope" = 'SITE'
  AND o."name" IN ('Office User', 'Read-only User');

DELETE FROM "Role"
WHERE "isSystem" = true
  AND "scope" = 'SITE'
  AND "name" IN ('Office User', 'Read-only User');
