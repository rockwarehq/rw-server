-- AlterTable
ALTER TABLE "StationModeLog" ADD COLUMN     "businessDate" DATE,
ADD COLUMN     "endedByEmployeeVersionId" UUID,
ADD COLUMN     "jobId" UUID,
ADD COLUMN     "jobVersionId" UUID,
ADD COLUMN     "productId" UUID,
ADD COLUMN     "productVersionId" UUID,
ADD COLUMN     "shiftInstanceId" UUID,
ADD COLUMN     "startedByEmployeeVersionId" UUID,
ADD COLUMN     "stationVersionId" UUID,
ADD COLUMN     "toolId" UUID,
ADD COLUMN     "toolVersionId" UUID,
ADD COLUMN     "workcenterId" UUID;

-- CreateIndex
CREATE INDEX "StationModeLog_siteId_businessDate_idx" ON "StationModeLog"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "StationModeLog_shiftInstanceId_idx" ON "StationModeLog"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "StationModeLog_workcenterId_idx" ON "StationModeLog"("workcenterId");

-- CreateIndex
CREATE INDEX "StationModeLog_jobId_idx" ON "StationModeLog"("jobId");

-- CreateIndex
CREATE INDEX "StationModeLog_toolId_idx" ON "StationModeLog"("toolId");

-- CreateIndex
CREATE INDEX "StationModeLog_productId_idx" ON "StationModeLog"("productId");

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_jobVersionId_fkey" FOREIGN KEY ("jobVersionId") REFERENCES "JobVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_stationVersionId_fkey" FOREIGN KEY ("stationVersionId") REFERENCES "StationVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

