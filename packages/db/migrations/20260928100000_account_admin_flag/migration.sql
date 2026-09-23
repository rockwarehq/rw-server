-- One account per deployment: memberships go, User carries the account flag.
--
-- Each deployment serves exactly one workspace (the account), so the
-- WorkspaceMember join table only repeated what User already says. Its
-- data moves:
--   workspaceRole = OWNER  -> User.isAccountAdmin
--   employeeId             -> User.employeeId
--   BucketAccess.membershipId -> BucketAccess.userId
-- WorkspaceMember stays as a frozen archive (RoleAssignment and
-- WorkcenterGrant still point at it); no code reads it.
--
-- Workspace gets a singleton guard like Basecamp's Campfire accounts table:
-- singletonGuard is always 0 and unique, so a second row cannot exist.

-- ── 1. Guard: exactly one workspace ───────────────────────────────────────

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "Workspace";
  IF n > 1 THEN
    RAISE EXCEPTION 'This deployment has % workspaces; it must have one. On a dev/test database run apps/api/scripts/collapse-workspaces.ts first.', n;
  END IF;
END $$;

-- ── 2. New columns ────────────────────────────────────────────────────────

ALTER TABLE "User"
  ADD COLUMN "employeeId" UUID,
  ADD COLUMN "isAccountAdmin" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Workspace" ADD COLUMN "singletonGuard" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "BucketAccess" ADD COLUMN "userId" UUID;

-- ── 3. Move the membership data onto users ───────────────────────────────

UPDATE "User" u
SET "isAccountAdmin" = true
FROM "WorkspaceMember" m
WHERE m."userId" = u."id" AND m."workspaceRole" = 'OWNER';

UPDATE "User" u
SET "employeeId" = m."employeeId"
FROM "WorkspaceMember" m
WHERE m."userId" = u."id" AND m."employeeId" IS NOT NULL;

UPDATE "BucketAccess" ba
SET "userId" = m."userId"
FROM "WorkspaceMember" m
WHERE m."id" = ba."membershipId";

-- People with no membership could not log in. Keep it that way.
UPDATE "User" u
SET "status" = 'DISABLED'
WHERE u."systemRole" IS NULL
  AND u."status" <> 'DISABLED'
  AND NOT EXISTS (SELECT 1 FROM "WorkspaceMember" m WHERE m."userId" = u."id");

-- ── 4. Swap keys ──────────────────────────────────────────────────────────

ALTER TABLE "BucketAccess" DROP CONSTRAINT "BucketAccess_membershipId_fkey";
DROP INDEX "BucketAccess_bucketId_membershipId_key";
DROP INDEX "BucketAccess_membershipId_idx";
ALTER TABLE "BucketAccess" DROP COLUMN "membershipId";
ALTER TABLE "BucketAccess" ALTER COLUMN "userId" SET NOT NULL;

CREATE INDEX "BucketAccess_userId_idx" ON "BucketAccess"("userId");
CREATE UNIQUE INDEX "BucketAccess_bucketId_userId_key" ON "BucketAccess"("bucketId", "userId");
ALTER TABLE "BucketAccess" ADD CONSTRAINT "BucketAccess_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceMember" DROP CONSTRAINT "WorkspaceMember_employeeId_fkey";

CREATE UNIQUE INDEX "User_employeeId_key" ON "User"("employeeId");
ALTER TABLE "User" ADD CONSTRAINT "User_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Workspace_singletonGuard_key" ON "Workspace"("singletonGuard");
