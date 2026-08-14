-- Production context stamping (dimension-ready facts).
-- Adds the conformed context block to Cycle, event-time/business-date to
-- ItemDispositionLog, and the itemsPerCycle snapshot to StationJobLog.
-- All columns nullable: facts are never dropped on context-resolution
-- failure; NULLs are repaired by restampWindow / the batched backfill.
-- NOTE: authored by hand; review before deploy. Backfill ships separately
-- (scripts/backfill-cycle-context.sql) and is NOT part of this migration.

-- AlterTable
ALTER TABLE "Cycle" ADD COLUMN     "workcenterId" UUID,
ADD COLUMN     "shiftInstanceId" UUID,
ADD COLUMN     "businessDate" DATE,
ADD COLUMN     "jobId" UUID,
ADD COLUMN     "logonSessionId" UUID,
ADD COLUMN     "toolId" UUID,
ADD COLUMN     "toolVersionId" UUID;

-- AlterTable
ALTER TABLE "ItemDispositionLog" ADD COLUMN     "occurredAt" TIMESTAMPTZ(3),
ADD COLUMN     "businessDate" DATE;

-- AlterTable
ALTER TABLE "StationJobLog" ADD COLUMN     "itemsPerCycle" INTEGER;

-- CreateIndex
CREATE INDEX "Cycle_siteId_businessDate_idx" ON "Cycle"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "Cycle_shiftInstanceId_idx" ON "Cycle"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "Cycle_jobId_start_idx" ON "Cycle"("jobId", "start");

-- CreateIndex
CREATE INDEX "ItemDispositionLog_stationId_occurredAt_idx" ON "ItemDispositionLog"("stationId", "occurredAt");

-- CreateIndex
CREATE INDEX "ItemDispositionLog_siteId_businessDate_idx" ON "ItemDispositionLog"("siteId", "businessDate");

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_logonSessionId_fkey" FOREIGN KEY ("logonSessionId") REFERENCES "StationLogonSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_toolVersionId_fkey" FOREIGN KEY ("toolVersionId") REFERENCES "ToolVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
