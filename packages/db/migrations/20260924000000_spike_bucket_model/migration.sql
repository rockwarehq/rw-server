-- SPIKE (throwaway): Basecamp-bucket access model, v3 — two containers.
--
-- The whole model: a PLANT bucket everyone at the site is in (member = read
-- the common things; MANAGE = write the plant and everything in it; ADMIN =
-- the reserved shelf), and one WORKCENTER bucket per cell for the crew
-- (VIEW = watch, WORK = operate). Workspace owners bypass, like the
-- Basecamp account owner. No permission vocabulary.
--
-- This migration creates the containers and compiles the CURRENT access
-- model (roles + workcenter grants) into bucket accesses so the spike runs
-- against realistic data.

CREATE TYPE "BucketKind" AS ENUM ('PLANT', 'WORKCENTER');
CREATE TYPE "BucketTier" AS ENUM ('VIEW', 'WORK', 'MANAGE', 'ADMIN');

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

-- One PLANT bucket per site.
INSERT INTO "Bucket" ("id", "workspaceId", "siteId", "kind", "workcenterId", "name", "updatedAt")
SELECT gen_random_uuid(), s."workspaceId", s."id", 'PLANT', NULL, s."name", now()
FROM "Site" s;

-- One WORKCENTER bucket per workcenter.
INSERT INTO "Bucket" ("id", "workspaceId", "siteId", "kind", "workcenterId", "name", "updatedAt")
SELECT gen_random_uuid(), s."workspaceId", wc."siteId", 'WORKCENTER', wc."id", wc."name", now()
FROM "Workcenter" wc JOIN "Site" s ON s."id" = wc."siteId";

-- ── Compile today's access model into bucket accesses ────────────────────
--   Plant Member (planning:read)            -> PLANT VIEW  (member)
--   Planner / Plant Engineer (writes)       -> PLANT MANAGE
--   Plant Admin (plant:admin)               -> PLANT ADMIN
--   WorkcenterGrant READ / WRITE            -> that WC bucket VIEW / WORK
--   Company Administrator (owner:all)       -> workspace bypass, no rows.

WITH site_roles AS (
  SELECT ra."membershipId", ra."siteId", r."permissions"
  FROM "RoleAssignment" ra JOIN "Role" r ON r."id" = ra."roleId"
  WHERE ra."siteId" IS NOT NULL AND NOT r."permissions" @> ARRAY['owner:all']
),
wanted AS (
  SELECT sr."membershipId", b."id" AS bucket_id,
         CASE WHEN sr."permissions" && ARRAY['plant:admin'] THEN 'ADMIN'
              WHEN sr."permissions" && ARRAY['planning:write','production:write','production:admin','configuration:write'] THEN 'MANAGE'
              ELSE 'VIEW' END AS tier
  FROM site_roles sr JOIN "Bucket" b ON b."siteId" = sr."siteId" AND b."kind" = 'PLANT'
  UNION ALL
  SELECT g."membershipId", b."id",
         CASE WHEN g."access" = 'WRITE' THEN 'WORK' ELSE 'VIEW' END
  FROM "WorkcenterGrant" g JOIN "Bucket" b ON b."workcenterId" = g."workcenterId"
),
best AS (
  SELECT "membershipId", bucket_id,
         (array_agg(tier ORDER BY CASE tier WHEN 'ADMIN' THEN 4 WHEN 'MANAGE' THEN 3 WHEN 'WORK' THEN 2 ELSE 1 END DESC))[1] AS tier
  FROM wanted GROUP BY "membershipId", bucket_id
)
INSERT INTO "BucketAccess" ("id", "bucketId", "membershipId", "tier", "updatedAt")
SELECT gen_random_uuid(), bucket_id, "membershipId", tier::"BucketTier", now() FROM best
ON CONFLICT ("bucketId", "membershipId") DO NOTHING;
