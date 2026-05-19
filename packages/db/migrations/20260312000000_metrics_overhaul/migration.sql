-- Combined migration: metrics overhaul
--
-- 1. Item-level quality + generated plannedProductionSeconds on MetricBucket
-- 2. MetricBucketLog table (archived buckets)
-- 3. businessDate / businessShift on both tables
-- 4. Clean indexes (drop redundant, add businessDate index)

-- ══════════════════════════════════════════════════════════════════
-- 1. MetricBucket: item-level quality + generated plannedProductionSeconds
-- ══════════════════════════════════════════════════════════════════

-- Drop existing computed columns that are being redefined
ALTER TABLE "MetricBucket" DROP COLUMN "quality";
ALTER TABLE "MetricBucket" DROP COLUMN "oee";

-- Drop plannedProductionSeconds (was a regular column, becomes generated)
ALTER TABLE "MetricBucket" DROP COLUMN "plannedProductionSeconds";

-- Re-create quality as item-level: goodItems / totalItems
ALTER TABLE "MetricBucket" ADD COLUMN "quality" DECIMAL(10,6)
  GENERATED ALWAYS AS (
    CASE WHEN "totalItems" > 0
         THEN "goodItems"::numeric / "totalItems"::numeric
         ELSE NULL
    END
  ) STORED;

-- Re-create OEE with item-level quality
-- OEE = (idealCycleSeconds * goodItems) / (elapsedPlannedProductionSeconds * totalItems)
ALTER TABLE "MetricBucket" ADD COLUMN "oee" DECIMAL(10,6)
  GENERATED ALWAYS AS (
    CASE WHEN "elapsedPlannedProductionSeconds" > 0
              AND "totalItems" > 0
         THEN ("idealCycleSeconds"::numeric * "goodItems"::numeric)
              / ("elapsedPlannedProductionSeconds"::numeric * "totalItems"::numeric)
         ELSE NULL
    END
  ) STORED;

-- Add plannedProductionSeconds as generated column
ALTER TABLE "MetricBucket" ADD COLUMN "plannedProductionSeconds" INT
  GENERATED ALWAYS AS ("durationSeconds" - "plannedDownSeconds") STORED;

-- ══════════════════════════════════════════════════════════════════
-- 2. MetricBucket: add businessDate and businessShift
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE "MetricBucket" ADD COLUMN "businessDate" DATE;
ALTER TABLE "MetricBucket" ADD COLUMN "businessShift" TEXT;

-- ══════════════════════════════════════════════════════════════════
-- 3. MetricBucket: drop redundant indexes, add businessDate index
-- ══════════════════════════════════════════════════════════════════

-- entityId index is covered by the unique (entityType, entityId, granularity, startTime)
DROP INDEX IF EXISTS "MetricBucket_entityId_granularity_startTime_idx";
-- shiftInstanceId index is never used in application queries
DROP INDEX IF EXISTS "MetricBucket_shiftInstanceId_idx";

CREATE INDEX "MetricBucket_siteId_businessDate_idx" ON "MetricBucket"("siteId", "businessDate");

-- ══════════════════════════════════════════════════════════════════
-- 4. Create MetricBucketLog table
--    Includes businessDate/businessShift from the start.
--    Omits redundant indexes (entityId, shiftInstanceId).
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE "MetricBucketLog" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "entityType" "BucketEntityType" NOT NULL,
    "entityId" UUID NOT NULL,
    "entityName" TEXT NOT NULL DEFAULT '',
    "path" TEXT NOT NULL DEFAULT '',
    "granularity" "BucketGranularity" NOT NULL,
    "granularityName" TEXT NOT NULL DEFAULT '',
    "startTime" TIMESTAMP(3) NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "shiftInstanceId" UUID,
    "businessDate" DATE,
    "businessShift" TEXT,
    "totalCycles" INTEGER NOT NULL DEFAULT 0,
    "expectedCycles" INTEGER NOT NULL DEFAULT 0,
    "goodCycles" INTEGER NOT NULL DEFAULT 0,
    "badCycles" INTEGER NOT NULL DEFAULT 0,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "goodItems" INTEGER NOT NULL DEFAULT 0,
    "badItems" INTEGER NOT NULL DEFAULT 0,
    "expectedItems" INTEGER NOT NULL DEFAULT 0,
    "runSeconds" INTEGER NOT NULL DEFAULT 0,
    "downSeconds" INTEGER NOT NULL DEFAULT 0,
    "plannedDownSeconds" INTEGER NOT NULL DEFAULT 0,
    "unplannedDownSeconds" INTEGER NOT NULL DEFAULT 0,
    "idealCycleSeconds" INTEGER NOT NULL DEFAULT 0,
    "totalCycleSeconds" INTEGER NOT NULL DEFAULT 0,
    "elapsedExpectedCycles" INTEGER NOT NULL DEFAULT 0,
    "elapsedExpectedItems" INTEGER NOT NULL DEFAULT 0,
    "elapsedPlannedProductionSeconds" INTEGER NOT NULL DEFAULT 0,
    "currentStandardCycle" DECIMAL(10,2),
    "plannedProductionSeconds" INTEGER,
    "availability" DECIMAL(10,6),
    "performance" DECIMAL(10,6),
    "quality" DECIMAL(10,6),
    "oee" DECIMAL(10,6),
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetricBucketLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MetricBucketLog_siteId_granularity_startTime_idx" ON "MetricBucketLog"("siteId", "granularity", "startTime");
CREATE UNIQUE INDEX "MetricBucketLog_entityType_entityId_granularity_startTime_key" ON "MetricBucketLog"("entityType", "entityId", "granularity", "startTime");
CREATE INDEX "MetricBucketLog_siteId_businessDate_idx" ON "MetricBucketLog"("siteId", "businessDate");

ALTER TABLE "MetricBucketLog" ADD CONSTRAINT "MetricBucketLog_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
