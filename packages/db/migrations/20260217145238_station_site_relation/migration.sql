-- Add siteId column to Station (initially nullable for data migration)
ALTER TABLE "Station" ADD COLUMN "siteId" UUID;

-- Populate siteId from workcenter relationship for existing stations
UPDATE "Station" 
SET "siteId" = (
  SELECT "siteId" FROM "Workcenter" WHERE "Workcenter"."id" = "Station"."workcenterId"
);

-- Make siteId non-nullable after data migration
ALTER TABLE "Station" ALTER COLUMN "siteId" SET NOT NULL;

-- Make workcenterId nullable
ALTER TABLE "Station" ALTER COLUMN "workcenterId" DROP NOT NULL;

-- Drop old unique index (Prisma creates unique constraints as indexes)
DROP INDEX "Station_workcenterId_name_key";

-- Add new unique constraint (station names unique within a site)
CREATE UNIQUE INDEX "Station_siteId_name_key" ON "Station"("siteId", "name");

-- Add foreign key for siteId
ALTER TABLE "Station" ADD CONSTRAINT "Station_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add index on siteId
CREATE INDEX "Station_siteId_idx" ON "Station"("siteId");
