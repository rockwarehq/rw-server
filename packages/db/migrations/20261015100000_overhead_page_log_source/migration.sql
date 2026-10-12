-- Overhead page log records what sent each page: a person (MANUAL, sourceType "user")
-- or an automation's announce action (SYSTEM, sourceType "automation").
-- AlterTable
ALTER TABLE "OverheadPageLog" ADD COLUMN     "source" "ActionSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "sourceRef" TEXT,
ADD COLUMN     "sourceType" TEXT;

-- Every existing row was sent by a person from the paging page.
UPDATE "OverheadPageLog" SET "sourceType" = 'user', "sourceRef" = "sentByUserId"::text WHERE "sentByUserId" IS NOT NULL;
