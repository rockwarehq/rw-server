-- AlterTable
ALTER TABLE "Cycle" ADD COLUMN     "businessDate" DATE,
ADD COLUMN     "jobId" UUID,
ADD COLUMN     "shiftInstanceId" UUID,
ADD COLUMN     "workcenterId" UUID;

-- AlterTable
ALTER TABLE "StationLogonSession" ADD COLUMN     "businessDate" DATE,
ADD COLUMN     "siteId" UUID,
ADD COLUMN     "workcenterId" UUID;

-- AlterTable
ALTER TABLE "ProductStockAdjustment" ADD COLUMN     "businessDate" DATE,
ADD COLUMN     "shiftInstanceId" UUID;

-- AlterTable
ALTER TABLE "OrderConsumption" ADD COLUMN     "businessDate" DATE,
ADD COLUMN     "shiftInstanceId" UUID;

-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN     "businessDate" DATE,
ADD COLUMN     "jobId" UUID,
ADD COLUMN     "productId" UUID,
ADD COLUMN     "shiftInstanceId" UUID,
ADD COLUMN     "siteId" UUID,
ADD COLUMN     "stationId" UUID,
ADD COLUMN     "toolId" UUID,
ADD COLUMN     "workcenterId" UUID;

-- AlterTable
ALTER TABLE "ItemDispositionLog" ADD COLUMN     "businessDate" DATE,
ADD COLUMN     "jobId" UUID,
ADD COLUMN     "productId" UUID,
ADD COLUMN     "toolId" UUID;

-- AlterTable
ALTER TABLE "MaterialLedgerEntry" ADD COLUMN     "businessDate" DATE,
ADD COLUMN     "shiftInstanceId" UUID;

-- AlterTable
ALTER TABLE "MaterialShiftUsage" ADD COLUMN     "businessDate" DATE,
ADD COLUMN     "workcenterId" UUID;

-- AlterTable
ALTER TABLE "StationStateLog" ADD COLUMN     "businessDate" DATE,
ADD COLUMN     "jobId" UUID,
ADD COLUMN     "shiftInstanceId" UUID,
ADD COLUMN     "siteId" UUID,
ADD COLUMN     "workcenterId" UUID;

-- AlterTable
ALTER TABLE "StationJobLog" ADD COLUMN     "businessDate" DATE,
ADD COLUMN     "shiftInstanceId" UUID,
ADD COLUMN     "siteId" UUID,
ADD COLUMN     "workcenterId" UUID;

-- CreateIndex
CREATE INDEX "Cycle_siteId_businessDate_idx" ON "Cycle"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "Cycle_shiftInstanceId_idx" ON "Cycle"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "Cycle_workcenterId_idx" ON "Cycle"("workcenterId");

-- CreateIndex
CREATE INDEX "StationLogonSession_siteId_businessDate_idx" ON "StationLogonSession"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "ProductStockAdjustment_siteId_businessDate_idx" ON "ProductStockAdjustment"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "ProductStockAdjustment_shiftInstanceId_idx" ON "ProductStockAdjustment"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "OrderConsumption_siteId_businessDate_idx" ON "OrderConsumption"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "OrderConsumption_shiftInstanceId_idx" ON "OrderConsumption"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "InventoryItem_siteId_businessDate_idx" ON "InventoryItem"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "InventoryItem_shiftInstanceId_idx" ON "InventoryItem"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "InventoryItem_workcenterId_idx" ON "InventoryItem"("workcenterId");

-- CreateIndex
CREATE INDEX "ItemDispositionLog_siteId_businessDate_idx" ON "ItemDispositionLog"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "MaterialLedgerEntry_siteId_businessDate_idx" ON "MaterialLedgerEntry"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "MaterialLedgerEntry_shiftInstanceId_idx" ON "MaterialLedgerEntry"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "MaterialShiftUsage_siteId_businessDate_idx" ON "MaterialShiftUsage"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "StationStateLog_siteId_businessDate_idx" ON "StationStateLog"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "StationStateLog_shiftInstanceId_idx" ON "StationStateLog"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "StationStateLog_workcenterId_idx" ON "StationStateLog"("workcenterId");

-- CreateIndex
CREATE INDEX "StationJobLog_siteId_businessDate_idx" ON "StationJobLog"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "StationJobLog_shiftInstanceId_idx" ON "StationJobLog"("shiftInstanceId");

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationLogonSession" ADD CONSTRAINT "StationLogonSession_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationLogonSession" ADD CONSTRAINT "StationLogonSession_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStockAdjustment" ADD CONSTRAINT "ProductStockAdjustment_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderConsumption" ADD CONSTRAINT "OrderConsumption_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialLedgerEntry" ADD CONSTRAINT "MaterialLedgerEntry_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialShiftUsage" ADD CONSTRAINT "MaterialShiftUsage_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationJobLog" ADD CONSTRAINT "StationJobLog_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationJobLog" ADD CONSTRAINT "StationJobLog_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationJobLog" ADD CONSTRAINT "StationJobLog_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
