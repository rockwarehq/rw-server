-- Item facts: parent+version pairs and conformed context.
-- InventoryItem gains the full context block (copied from its cycle's
-- stamped context at write time) plus dimension parents; ItemDispositionLog
-- gains the parents its version snapshots were missing, plus job/operator.
-- All columns nullable: legacy rows are repaired by the batched backfill
-- (scripts/backfill-item-fact-context.sql), which requires the cycle
-- context backfill to have run first.
-- NOTE: authored by hand; review before deploy. Do NOT run backfills here.

-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN     "siteId" UUID,
ADD COLUMN     "stationId" UUID,
ADD COLUMN     "workcenterId" UUID,
ADD COLUMN     "shiftInstanceId" UUID,
ADD COLUMN     "businessDate" DATE,
ADD COLUMN     "jobId" UUID,
ADD COLUMN     "jobVersionId" UUID,
ADD COLUMN     "logonSessionId" UUID,
ADD COLUMN     "producedAt" TIMESTAMPTZ(3),
ADD COLUMN     "productId" UUID,
ADD COLUMN     "toolId" UUID,
ADD COLUMN     "toolCavityId" UUID,
ADD COLUMN     "jobProductId" UUID;

-- AlterTable
ALTER TABLE "ItemDispositionLog" ADD COLUMN     "jobId" UUID,
ADD COLUMN     "logonSessionId" UUID,
ADD COLUMN     "productId" UUID,
ADD COLUMN     "toolId" UUID,
ADD COLUMN     "toolCavityId" UUID,
ADD COLUMN     "jobProductId" UUID;

-- CreateIndex
CREATE INDEX "InventoryItem_siteId_businessDate_idx" ON "InventoryItem"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "InventoryItem_productId_idx" ON "InventoryItem"("productId");

-- CreateIndex
CREATE INDEX "InventoryItem_stationId_producedAt_idx" ON "InventoryItem"("stationId", "producedAt");

-- CreateIndex
CREATE INDEX "InventoryItem_jobId_idx" ON "InventoryItem"("jobId");

-- CreateIndex
CREATE INDEX "ItemDispositionLog_productId_idx" ON "ItemDispositionLog"("productId");

-- CreateIndex
CREATE INDEX "ItemDispositionLog_jobId_idx" ON "ItemDispositionLog"("jobId");

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_jobVersionId_fkey" FOREIGN KEY ("jobVersionId") REFERENCES "JobVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_logonSessionId_fkey" FOREIGN KEY ("logonSessionId") REFERENCES "StationLogonSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_toolCavityId_fkey" FOREIGN KEY ("toolCavityId") REFERENCES "ToolCavity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_jobProductId_fkey" FOREIGN KEY ("jobProductId") REFERENCES "JobProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_logonSessionId_fkey" FOREIGN KEY ("logonSessionId") REFERENCES "StationLogonSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_toolCavityId_fkey" FOREIGN KEY ("toolCavityId") REFERENCES "ToolCavity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_jobProductId_fkey" FOREIGN KEY ("jobProductId") REFERENCES "JobProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
