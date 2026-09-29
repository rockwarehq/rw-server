-- Site week start: the first day of the site's week, used to decide which week a
-- business date falls in. Replaces the per-schedule "week starts on" choice.
-- CreateEnum
CREATE TYPE "WeekStart" AS ENUM ('SUNDAY', 'MONDAY');

-- AlterTable
ALTER TABLE "Site" ADD COLUMN "weekStart" "WeekStart" NOT NULL DEFAULT 'MONDAY';

-- A site whose weekly schedules were all set up Sunday-first keeps its Sunday week.
UPDATE "Site" s SET "weekStart" = 'SUNDAY'
WHERE EXISTS (
  SELECT 1 FROM "ShiftPattern" p
  WHERE p."siteId" = s."id" AND upper(p."startOnDayOfWeek") = 'SUNDAY'
) AND NOT EXISTS (
  SELECT 1 FROM "ShiftPattern" p
  WHERE p."siteId" = s."id" AND p."startOnDayOfWeek" IS NOT NULL AND upper(p."startOnDayOfWeek") <> 'SUNDAY'
);
