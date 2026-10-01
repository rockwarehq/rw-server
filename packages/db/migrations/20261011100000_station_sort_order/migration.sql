-- Stations get a display order within their workcenter. Lists stay alphabetical
-- unless the caller asks for sortOrder (then sortOrder, then name).
-- AlterTable
ALTER TABLE "Station" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
