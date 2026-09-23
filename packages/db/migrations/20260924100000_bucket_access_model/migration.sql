-- The bucket access model.
--
-- Access control becomes containers + membership:
--   PLANT bucket (one per site)     — VIEW = member, MANAGE = write the
--                                     plant and everything in it (cascades
--                                     to every workcenter), ADMIN = people,
--                                     access, dangerous settings.
--   WORKCENTER bucket (one per WC)  — VIEW = watch, MANAGE = operate and
--                                     configure the cell.
--   WorkspaceMembership.workspaceRole OWNER — the reserved account owner.
--
-- The previous role/permission model is compiled into bucket accesses:
--   Plant Member (planning:read)                    -> PLANT VIEW
--   Planner / Plant Engineer (any write key)        -> PLANT MANAGE
--   Plant Admin (plant:admin)                       -> PLANT ADMIN
--   WorkcenterGrant READ / WRITE                    -> WC VIEW / MANAGE
--   Company Administrator (owner:all)               -> workspaceRole OWNER
-- Custom roles compile by the same key mapping. Role, RoleAssignment and
-- WorkcenterGrant tables are KEPT as a frozen audit/rollback archive; all
-- code paths to them are deleted in this release.

-- ── 1. DDL ────────────────────────────────────────────────────────────────

CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'MEMBER');
ALTER TABLE "WorkspaceMember" ADD COLUMN "workspaceRole" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER';

CREATE TYPE "BucketKind" AS ENUM ('PLANT', 'WORKCENTER');
CREATE TYPE "BucketTier" AS ENUM ('VIEW', 'MANAGE', 'ADMIN');

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
  CONSTRAINT "Bucket_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Bucket_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Bucket_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE
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
  CONSTRAINT "BucketAccess_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "Bucket"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BucketAccess_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "WorkspaceMember"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BucketAccess_bucketId_membershipId_key" ON "BucketAccess"("bucketId", "membershipId");
CREATE INDEX "BucketAccess_membershipId_idx" ON "BucketAccess"("membershipId");

-- ── 2. Containers from the existing hierarchy ─────────────────────────────

INSERT INTO "Bucket" ("id", "workspaceId", "siteId", "kind", "workcenterId", "name", "updatedAt")
SELECT gen_random_uuid(), s."workspaceId", s."id", 'PLANT', NULL, s."name", now()
FROM "Site" s;

INSERT INTO "Bucket" ("id", "workspaceId", "siteId", "kind", "workcenterId", "name", "updatedAt")
SELECT gen_random_uuid(), s."workspaceId", wc."siteId", 'WORKCENTER', wc."id", wc."name", now()
FROM "Workcenter" wc JOIN "Site" s ON s."id" = wc."siteId";

-- ── 3. Owners ─────────────────────────────────────────────────────────────

UPDATE "WorkspaceMember" m
SET "workspaceRole" = 'OWNER'
WHERE EXISTS (
  SELECT 1 FROM "RoleAssignment" ra
  JOIN "Role" r ON r."id" = ra."roleId"
  WHERE ra."membershipId" = m."id" AND r."permissions" @> ARRAY['owner:all']
);

-- ── 4. Compile role assignments and grants into bucket accesses ──────────

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
         CASE WHEN g."access" = 'WRITE' THEN 'MANAGE' ELSE 'VIEW' END
  FROM "WorkcenterGrant" g JOIN "Bucket" b ON b."workcenterId" = g."workcenterId"
),
best AS (
  SELECT "membershipId", bucket_id,
         (array_agg(tier ORDER BY CASE tier WHEN 'ADMIN' THEN 3 WHEN 'MANAGE' THEN 2 ELSE 1 END DESC))[1] AS tier
  FROM wanted GROUP BY "membershipId", bucket_id
)
INSERT INTO "BucketAccess" ("id", "bucketId", "membershipId", "tier", "updatedAt")
SELECT gen_random_uuid(), bucket_id, "membershipId", tier::"BucketTier", now() FROM best
ON CONFLICT ("bucketId", "membershipId") DO NOTHING;
