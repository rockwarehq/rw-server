-- AlterTable
ALTER TABLE "Display" ADD COLUMN     "stationId" UUID,
ADD COLUMN     "workcenterId" UUID;

-- CreateIndex
CREATE INDEX "Display_workcenterId_idx" ON "Display"("workcenterId");

-- CreateIndex
CREATE INDEX "Display_stationId_idx" ON "Display"("stationId");

-- AddForeignKey
ALTER TABLE "Display" ADD CONSTRAINT "Display_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Display" ADD CONSTRAINT "Display_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE SET NULL ON UPDATE CASCADE;
