-- Downtime shift context (dimension-ready facts). Adds the conformed
-- context block to StationStateLog: rows are split at shift boundaries at
-- write time so every row lies within one shift and carries that shift's
-- stamps. All columns nullable: state transitions are never failed on
-- context-resolution failure — NULLs are repaired by the batched backfill.
-- NOTE: authored by hand; review before deploy. Backfill ships separately
-- (scripts/backfill-cycle-context.sql) and is NOT part of this migration.

-- AlterTable
ALTER TABLE "StationStateLog" ADD COLUMN     "workcenterId" UUID,
ADD COLUMN     "shiftInstanceId" UUID,
ADD COLUMN     "businessDate" DATE;

-- CreateIndex
CREATE INDEX "StationStateLog_shiftInstanceId_idx" ON "StationStateLog"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "StationStateLog_stationId_businessDate_idx" ON "StationStateLog"("stationId", "businessDate");

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
