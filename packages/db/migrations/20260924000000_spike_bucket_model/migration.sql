-- SPIKE (throwaway): Basecamp-bucket access model.
-- Every row belongs to one bucket; access = membership in the bucket with a
-- small tier. This migration creates the containers and compiles the
-- CURRENT access model (roles + workcenter grants) into bucket accesses so
-- the spike can be exercised against realistic data.

CREATE TYPE "BucketKind" AS ENUM ('WORKCENTER', 'PLANT_OFFICE', 'PLANT_LIBRARY', 'PLANT_CONFIG');
CREATE TYPE "BucketTier" AS ENUM ('VIEW', 'WORK', 'MANAGE');

CREATE TABLE "Bucket" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "siteId" UUID,
  "kind" "BucketKind" NOT NULL,
  "workcenterId" UUID,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Bucket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Bucket_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE,
  CONSTRAINT "Bucket_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE,
  CONSTRAINT "Bucket_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "Bucket_workcenterId_key" ON "Bucket"("workcenterId");
CREATE INDEX "Bucket_siteId_kind_idx" ON "Bucket"("siteId", "kind");
CREATE INDEX "Bucket_workspaceId_idx" ON "Bucket"("workspaceId");

CREATE TABLE "BucketAccess" (
  "id" UUID NOT NULL,
  "bucketId" UUID NOT NULL,
  "membershipId" UUID NOT NULL,
  "tier" "BucketTier" NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "BucketAccess_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BucketAccess_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "Bucket"("id") ON DELETE CASCADE,
  CONSTRAINT "BucketAccess_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "WorkspaceMember"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "BucketAccess_bucketId_membershipId_key" ON "BucketAccess"("bucketId", "membershipId");
CREATE INDEX "BucketAccess_membershipId_idx" ON "BucketAccess"("membershipId");

-- ── Bootstrap the containers ─────────────────────────────────────────────

-- One bucket per workcenter (the floor "project").
INSERT INTO "Bucket" ("id", "workspaceId", "siteId", "kind", "workcenterId", "name", "updatedAt")
SELECT gen_random_uuid(), s."workspaceId", wc."siteId", 'WORKCENTER', wc."id", wc."name", now()
FROM "Workcenter" wc JOIN "Site" s ON s."id" = wc."siteId";

-- Three structural buckets per site.
INSERT INTO "Bucket" ("id", "workspaceId", "siteId", "kind", "workcenterId", "name", "updatedAt")
SELECT gen_random_uuid(), s."workspaceId", s."id", k.kind::"BucketKind", NULL, s."name" || ' — ' || k.label, now()
FROM "Site" s
CROSS JOIN (VALUES ('PLANT_OFFICE', 'Office'), ('PLANT_LIBRARY', 'Library'), ('PLANT_CONFIG', 'Config')) AS k(kind, label);

-- ── Compile today's access model into bucket accesses ────────────────────
-- Tier mapping from the eight-key model:
--   planning:read  -> VIEW on Office        planning:write -> WORK on Office
--   production:*   -> (site-wide holders)   VIEW/WORK/MANAGE on every WC bucket
--   configuration:write -> MANAGE on Config plant:admin -> MANAGE everywhere
--   WorkcenterGrant READ/WRITE -> VIEW/WORK on that workcenter's bucket.
-- Company Administrator (owner:all) is a workspace-level bypass: no rows.

WITH site_roles AS (
  SELECT ra."membershipId", ra."siteId", r."permissions"
  FROM "RoleAssignment" ra JOIN "Role" r ON r."id" = ra."roleId"
  WHERE ra."siteId" IS NOT NULL AND NOT r."permissions" @> ARRAY['owner:all']
),
wanted AS (
  -- Office
  SELECT sr."membershipId", b."id" AS bucket_id,
         CASE WHEN sr."permissions" && ARRAY['plant:admin'] THEN 'MANAGE'
              WHEN sr."permissions" && ARRAY['planning:write','production:admin'] THEN 'WORK'
              ELSE 'VIEW' END AS tier
  FROM site_roles sr JOIN "Bucket" b ON b."siteId" = sr."siteId" AND b."kind" = 'PLANT_OFFICE'
  WHERE sr."permissions" && ARRAY['planning:read','planning:write','production:admin','plant:admin']
  UNION ALL
  -- Config
  SELECT sr."membershipId", b."id",
         CASE WHEN sr."permissions" && ARRAY['plant:admin','configuration:write'] THEN 'MANAGE' ELSE 'VIEW' END
  FROM site_roles sr JOIN "Bucket" b ON b."siteId" = sr."siteId" AND b."kind" = 'PLANT_CONFIG'
  WHERE sr."permissions" && ARRAY['configuration:read','configuration:write','plant:admin','production:admin']
  UNION ALL
  -- Every workcenter bucket at the site, for site-wide production holders
  SELECT sr."membershipId", b."id",
         CASE WHEN sr."permissions" && ARRAY['production:admin','plant:admin'] THEN 'MANAGE'
              WHEN sr."permissions" && ARRAY['production:write'] THEN 'WORK'
              ELSE 'VIEW' END
  FROM site_roles sr JOIN "Bucket" b ON b."siteId" = sr."siteId" AND b."kind" = 'WORKCENTER'
  WHERE sr."permissions" && ARRAY['production:read','production:write','production:admin','plant:admin']
  UNION ALL
  -- Workcenter grants -> that one workcenter's bucket
  SELECT g."membershipId", b."id",
         CASE WHEN g."access" = 'WRITE' THEN 'WORK' ELSE 'VIEW' END
  FROM "WorkcenterGrant" g JOIN "Bucket" b ON b."workcenterId" = g."workcenterId"
),
best AS (
  -- Highest tier wins when several sources grant the same bucket.
  SELECT "membershipId", bucket_id,
         (array_agg(tier ORDER BY CASE tier WHEN 'MANAGE' THEN 3 WHEN 'WORK' THEN 2 ELSE 1 END DESC))[1] AS tier
  FROM wanted GROUP BY "membershipId", bucket_id
)
INSERT INTO "BucketAccess" ("id", "bucketId", "membershipId", "tier", "updatedAt")
SELECT gen_random_uuid(), bucket_id, "membershipId", tier::"BucketTier", now() FROM best
ON CONFLICT ("bucketId", "membershipId") DO NOTHING;
