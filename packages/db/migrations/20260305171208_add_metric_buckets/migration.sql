-- CreateEnum
CREATE TYPE "BucketEntityType" AS ENUM ('STATION', 'WORKCENTER', 'SITE');

-- CreateEnum
CREATE TYPE "BucketGranularity" AS ENUM ('MINUTE', 'HOUR', 'SHIFT', 'DAY');

-- CreateTable
CREATE TABLE "MetricBucket" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "entityType" "BucketEntityType" NOT NULL,
    "entityId" UUID NOT NULL,
    "granularity" "BucketGranularity" NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "totalCycles" INTEGER NOT NULL DEFAULT 0,
    "expectedCycles" INTEGER NOT NULL DEFAULT 0,
    "goodCycles" INTEGER NOT NULL DEFAULT 0,
    "badCycles" INTEGER NOT NULL DEFAULT 0,
    "totalParts" INTEGER NOT NULL DEFAULT 0,
    "goodParts" INTEGER NOT NULL DEFAULT 0,
    "badParts" INTEGER NOT NULL DEFAULT 0,
    "runSeconds" INTEGER NOT NULL DEFAULT 0,
    "downSeconds" INTEGER NOT NULL DEFAULT 0,
    "plannedDownSeconds" INTEGER NOT NULL DEFAULT 0,
    "unplannedDownSeconds" INTEGER NOT NULL DEFAULT 0,
    "plannedProductionSeconds" INTEGER NOT NULL DEFAULT 0,
    "idealCycleSeconds" INTEGER NOT NULL DEFAULT 0,
    "totalCycleSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetricBucket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetricBucket_siteId_granularity_startTime_idx" ON "MetricBucket"("siteId", "granularity", "startTime");

-- CreateIndex
CREATE INDEX "MetricBucket_entityId_granularity_startTime_idx" ON "MetricBucket"("entityId", "granularity", "startTime");

-- CreateIndex
CREATE UNIQUE INDEX "MetricBucket_entityType_entityId_granularity_startTime_key" ON "MetricBucket"("entityType", "entityId", "granularity", "startTime");

-- AddForeignKey
ALTER TABLE "MetricBucket" ADD CONSTRAINT "MetricBucket_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
