-- Plant MANAGE becomes the "member" level; ADMIN takes shop-floor setup.
--
-- Before: plant MANAGE wrote everything at the plant, set up the shop
-- floor, and reached every workcenter.
-- After:  plant MANAGE ("member") writes the plant's shared things (jobs,
--         orders, products, tools…). Setup moves to ADMIN, and only ADMIN
--         reaches every workcenter.
--
-- So nobody loses access at cutover:
--   1. MANAGE that came from a setup role (configuration:write, or the
--      legacy facility bundle the bucket migration used for the same
--      MANAGE rule — Plant Engineers and custom roles like them)
--      becomes ADMIN. The archived Role/RoleAssignment rows say where each
--      access came from.
--   2. Everyone else keeps plant MANAGE and gets MANAGE on every workcenter
--      at that plant, since MANAGE used to reach them all. Admins can trim
--      these later.
-- The engineer set is fixed in step 1, before step 2 reads it.

-- ── 1. Setup roles → ADMIN ────────────────────────────────────────────────

WITH setup_roles AS (
  SELECT r."id"
  FROM "Role" r
  WHERE r."permissions" && ARRAY['configuration:write']
     OR ARRAY(SELECT jsonb_array_elements_text(COALESCE(r."legacyPermissions", '[]'::jsonb)))
        @> ARRAY[
             'facility:read', 'facility:write', 'facility:admin',
             'job:read', 'job:write', 'job:admin',
             'status:read', 'status:write', 'status:admin',
             'calls:read', 'calls:write', 'calls:admin',
             'modes:read', 'modes:write', 'modes:admin',
             'notifications:read', 'notifications:write', 'notifications:admin',
             'dashboard:read', 'dashboard:write', 'dashboard:admin',
             'entity:read', 'entity:write', 'entity:admin',
             'graph:read', 'graph:write', 'graph:admin',
             'settings:read', 'settings:write', 'settings:admin']
),
setup_sites AS (
  SELECT ra."membershipId", ra."siteId"
  FROM "RoleAssignment" ra JOIN setup_roles sr ON sr."id" = ra."roleId"
  WHERE ra."siteId" IS NOT NULL
  UNION
  SELECT ra."membershipId", s."id"
  FROM "RoleAssignment" ra
  JOIN setup_roles sr ON sr."id" = ra."roleId"
  JOIN "WorkspaceMember" m ON m."id" = ra."membershipId"
  JOIN "Site" s ON s."workspaceId" = m."workspaceId"
  WHERE ra."siteId" IS NULL
)
UPDATE "BucketAccess" ba
SET "tier" = 'ADMIN', "updatedAt" = now()
FROM "Bucket" b, setup_sites ss
WHERE ba."bucketId" = b."id"
  AND b."kind" = 'PLANT'
  AND ba."tier" = 'MANAGE'
  AND ss."membershipId" = ba."membershipId"
  AND ss."siteId" = b."siteId";

-- ── 2. Remaining plant MANAGE keeps its workcenters ──────────────────────

INSERT INTO "BucketAccess" ("id", "bucketId", "membershipId", "tier", "updatedAt")
SELECT gen_random_uuid(), wb."id", ba."membershipId", 'MANAGE', now()
FROM "BucketAccess" ba
JOIN "Bucket" pb ON pb."id" = ba."bucketId" AND pb."kind" = 'PLANT'
JOIN "Bucket" wb ON wb."siteId" = pb."siteId" AND wb."kind" = 'WORKCENTER'
WHERE ba."tier" = 'MANAGE'
ON CONFLICT ("bucketId", "membershipId") DO UPDATE
  SET "tier" = 'MANAGE', "updatedAt" = now()
  WHERE "BucketAccess"."tier" = 'VIEW';
