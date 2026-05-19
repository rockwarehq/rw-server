-- AlterTable
ALTER TABLE "EmployeeRole" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "StationJobLog_stationId_startTime_idx" ON "StationJobLog"("stationId", "startTime");

-- CreateIndex
CREATE INDEX "StationStateLog_stationId_startTime_idx" ON "StationStateLog"("stationId", "startTime");
